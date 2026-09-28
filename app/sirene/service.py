"""De kern: P2000 ophalen, geocoderen, opslaan, live doorsturen en (optioneel) melden."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

from .db import Database
from .events import EventBus
from .geo import haversine_m
from .geocoder import PRECISION_RANK, Geocoder
from .location import Location, LocationStore, fetch_ha_location
from .notifier import Notifier
from .parser import parse_message
from .sources.p2000_rss import FeedItem, fetch_feed
from .sources.speedcams import fetch_speedcams
from .sources.statiegeld import DEFAULT_URL as STATIEGELD_URL
from .sources.statiegeld import fetch_statiegeld

log = logging.getLogger(__name__)

USER_AGENT = "SireneRadar/0.1 (self-hosted, persoonlijk gebruik)"
# Alleen verse incidenten leiden tot een melding (niet de backlog na een herstart).
NOTIFY_MAX_INCIDENT_AGE_S = 15 * 60
FEED_MAX_BACKOFF_S = 15 * 60
# Na een mislukte dagelijkse verversing (flitsers, statiegeld) eerder opnieuw proberen.
REFRESH_RETRY_S = 30 * 60


class Service:
    def __init__(self, cfg: dict[str, Any], client: httpx.AsyncClient | None = None) -> None:
        self.cfg = cfg
        self.db = Database(cfg["database"])
        self.client = client or httpx.AsyncClient(
            headers={"User-Agent": cfg.get("user_agent") or USER_AGENT}, follow_redirects=True
        )
        self.geocoder = Geocoder(self.db, self.client, cfg["geocoder"]["pdok_url"],
                                 cfg["geocoder"]["pdok_enabled"])
        self.locations = LocationStore(self.db, cfg["location"]["fallback"])
        self.bus = EventBus()
        ncfg = cfg["notifications"]
        self.notifier = (Notifier(self.client, ncfg, cfg["location"]["homeassistant"])
                         if ncfg["enabled"] else None)
        self.status: dict[str, Any] = {
            "p2000": {"last_ok": None, "last_error": None},
            "speedcams": {"last_ok": None, "last_error": None, "count": 0},
            "statiegeld": {"last_ok": None, "last_error": None, "count": 0},
            "homeassistant": {"last_ok": None, "last_error": None},
        }
        self._tasks: list[asyncio.Task] = []
        # Per feed: (aantal fouten op rij, niet opnieuw proberen voor dit tijdstip).
        self._feed_backoff: dict[str, tuple[int, float]] = {}

    # --- incidenten -------------------------------------------------------

    def enrich(self, incident: dict[str, Any], loc: Location | None = None) -> dict[str, Any]:
        loc = loc or self.locations.current
        out = dict(incident)
        out["sirene"] = incident["priority"] is not None and incident["priority"] <= 1
        out["distance_m"] = (
            round(haversine_m(loc.lat, loc.lon, incident["lat"], incident["lon"]))
            if loc and incident["lat"] is not None else None
        )
        return out

    async def process_item(self, item: FeedItem) -> dict[str, Any] | None:
        """Verwerkt één feed-item; geeft het nieuwe incident terug, of None."""
        if self.db.has_guid(item.guid):
            return None
        parsed = parse_message(item.title, item.description)
        if parsed.is_test:
            return None
        dup = self.db.find_duplicate(item.title, item.ts, self.cfg["p2000"]["dedupe_window_s"])
        if dup:
            self.db.bump_duplicate(dup["id"])
            return None

        geo = await self.geocoder.geocode(parsed.street, parsed.city, parsed.postcode)
        incident = {
            "guid": item.guid, "ts": item.ts, "title": item.title,
            "description": item.description, "link": item.link,
            "discipline": parsed.discipline, "priority": parsed.priority,
            "street": parsed.street, "city": parsed.city, "postcode": parsed.postcode,
            "lat": geo.lat if geo else None, "lon": geo.lon if geo else None,
            "precision": geo.precision if geo else None,
        }
        incident_id = self.db.insert_incident(incident)
        stored = self.db.get_incident(incident_id)
        self.bus.publish("incident", self.enrich(stored))
        await self.maybe_notify(stored)
        return stored

    async def poll_p2000_once(self) -> int:
        new = 0
        interval = self.cfg["p2000"]["poll_interval_s"]
        for url in self.cfg["p2000"]["feeds"]:
            failures, retry_at = self._feed_backoff.get(url, (0, 0.0))
            if time.time() < retry_at:
                continue
            try:
                items = await fetch_feed(self.client, url)
            except (httpx.HTTPError, ValueError) as exc:
                failures += 1
                # Bij fouten steeds langer wachten (max. 15 min) om de bron niet te belasten.
                delay = min(FEED_MAX_BACKOFF_S, interval * 2 ** failures)
                self._feed_backoff[url] = (failures, time.time() + delay)
                log.warning("Feed %s faalde (%s), volgende poging over %d s", url, exc, delay)
                self.status["p2000"]["last_error"] = f"{time.time():.0f}: {exc}"
                continue
            self._feed_backoff.pop(url, None)
            for item in sorted(items, key=lambda i: i.ts):
                if await self.process_item(item):
                    new += 1
            self.status["p2000"]["last_ok"] = time.time()
        self.db.purge_incidents(time.time() - self.cfg["p2000"]["keep_hours"] * 3600)
        return new

    # --- meldingen --------------------------------------------------------

    def should_notify(self, incident: dict[str, Any], loc: Location | None,
                      now: float | None = None) -> float | None:
        """Geeft de afstand terug als er gemeld moet worden, anders None."""
        now = now or time.time()
        ncfg = self.cfg["notifications"]
        if not ncfg["enabled"] or incident["notified"] or incident["lat"] is None or not loc:
            return None
        if now - incident["ts"] > NOTIFY_MAX_INCIDENT_AGE_S:
            return None
        if now - loc.ts > self.cfg["location"]["max_age_min"] * 60:
            return None
        if ncfg["only_priority_1"] and not (
                incident["priority"] is not None and incident["priority"] <= 1):
            return None
        if PRECISION_RANK.get(incident["precision"], 0) < PRECISION_RANK[ncfg["min_precision"]]:
            return None
        distance = haversine_m(loc.lat, loc.lon, incident["lat"], incident["lon"])
        return distance if distance <= self.cfg["radius_m"] else None

    async def maybe_notify(self, incident: dict[str, Any]) -> bool:
        distance = self.should_notify(incident, self.locations.current)
        if distance is None or not self.notifier:
            return False
        try:
            await self.notifier.send(incident, distance)
        except httpx.HTTPError as exc:
            log.warning("Melding versturen mislukt: %s", exc)
            return False
        self.db.mark_notified(incident["id"])
        return True

    # --- locatie ----------------------------------------------------------

    async def set_location(self, loc: Location) -> None:
        if not self.locations.update(loc):
            return
        self.bus.publish("location", loc.to_dict())
        # Je kunt ook zelf in de buurt van een net gestart incident komen.
        for incident in self.db.incidents_since(time.time() - NOTIFY_MAX_INCIDENT_AGE_S):
            await self.maybe_notify(incident)

    async def poll_ha_once(self) -> None:
        ha = self.cfg["location"]["homeassistant"]
        try:
            loc = await fetch_ha_location(self.client, ha["url"], ha["token"], ha["entity_id"])
        except (httpx.HTTPError, ValueError) as exc:
            self.status["homeassistant"]["last_error"] = f"{time.time():.0f}: {exc}"
            return
        self.status["homeassistant"]["last_ok"] = time.time()
        if loc:
            await self.set_location(loc)

    # --- flitsers ---------------------------------------------------------

    async def refresh_speedcams_once(self) -> bool:
        try:
            cams = await fetch_speedcams(self.client, self.cfg["speedcams"]["overpass_urls"])
        except RuntimeError as exc:
            self.status["speedcams"]["last_error"] = f"{time.time():.0f}: {exc}"
            return False
        self.db.replace_speedcams(cams)
        self.db.meta_set("speedcams_updated", time.time())
        self.status["speedcams"].update(last_ok=time.time(), count=len(cams))
        self.bus.publish("speedcams", {"count": len(cams)})
        return True

    # --- statiegeld -------------------------------------------------------

    async def refresh_statiegeld_once(self) -> bool:
        url = self.cfg["statiegeld"]["url"] or STATIEGELD_URL
        try:
            points = await fetch_statiegeld(self.client, url)
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("Statiegeldpunten ophalen mislukt: %s", exc)
            self.status["statiegeld"]["last_error"] = f"{time.time():.0f}: {exc}"
            return False
        self.db.replace_statiegeld(points)
        self.db.meta_set("statiegeld_updated", time.time())
        self.status["statiegeld"].update(last_ok=time.time(), count=len(points))
        self.bus.publish("statiegeld", {"count": len(points)})
        return True

    # --- achtergrondtaken -------------------------------------------------

    async def _loop(self, name: str, interval_s: float, func) -> None:
        while True:
            try:
                await func()
            except Exception:  # een taak mag nooit de hele service stoppen
                log.exception("Taak %s faalde", name)
            await asyncio.sleep(interval_s)

    async def _refresh_loop(self, name: str, interval_s: float, func) -> None:
        """Ververst een dataset periodiek; na een fout eerder opnieuw proberen."""
        updated = self.db.meta_get(f"{name}_updated") or 0
        if updated:
            self.status[name]["last_ok"] = updated
        await asyncio.sleep(max(0, updated + interval_s - time.time()))
        while True:
            try:
                ok = await func()
            except Exception:  # een taak mag nooit de hele service stoppen
                log.exception("Verversen van %s faalde", name)
                ok = False
            await asyncio.sleep(interval_s if ok else min(interval_s, REFRESH_RETRY_S))

    def start(self) -> None:
        self._tasks.append(asyncio.create_task(
            self._loop("p2000", self.cfg["p2000"]["poll_interval_s"], self.poll_p2000_once)))
        if self.cfg["speedcams"]["enabled"]:
            self.status["speedcams"]["count"] = len(self.db.speedcams())
            self._tasks.append(asyncio.create_task(self._refresh_loop(
                "speedcams", self.cfg["speedcams"]["refresh_hours"] * 3600,
                self.refresh_speedcams_once)))
        if self.cfg["statiegeld"]["enabled"]:
            self.status["statiegeld"]["count"] = self.db.statiegeld_count()
            self._tasks.append(asyncio.create_task(self._refresh_loop(
                "statiegeld", self.cfg["statiegeld"]["refresh_hours"] * 3600,
                self.refresh_statiegeld_once)))
        ha = self.cfg["location"]["homeassistant"]
        if ha["enabled"]:
            if not ha["token"]:
                log.error("Home Assistant staat aan maar HA_TOKEN ontbreekt")
            else:
                self._tasks.append(asyncio.create_task(
                    self._loop("homeassistant", ha["poll_interval_s"], self.poll_ha_once)))

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        await self.client.aclose()
