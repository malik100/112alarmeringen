"""De kern: P2000 ophalen, geocoderen, opslaan, live doorsturen en (optioneel) melden."""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import math
import time
from typing import Any

import httpx

from .db import Database
from .events import EventBus
from .geo import haversine_m
from .geocoder import PRECISION_RANK, Geocoder
from .location import Location, LocationStore, fetch_ha_location
from . import news as news_matcher
from .notifier import Notifier
from .parser import parse_message
from .sources.p2000_rss import FeedItem, fetch_feed
from .sources.bekendmakingen import fetch_announcements, fetch_area
from .sources.bekendmakingen import relevance as announcement_relevance
from .sources.roadworks import DEFAULT_URL as ROADWORKS_URL
from .sources.roadworks import fetch_roadworks, fetch_street
from .sources.charging import fetch_availability, fetch_stations
from .sources.npr import fetch_zones
from .sources.shops import fetch_shops, is_late, same_store
from .sources.speedcams import fetch_speedcams
from .sources.statiegeld import DEFAULT_URL as STATIEGELD_URL
from .sources.statiegeld import fetch_statiegeld

log = logging.getLogger(__name__)

USER_AGENT = "Buurtradar/0.1 (self-hosted, persoonlijk gebruik)"
# Alleen verse incidenten leiden tot een melding (niet de backlog na een herstart).
NOTIFY_MAX_INCIDENT_AGE_S = 15 * 60
FEED_MAX_BACKOFF_S = 15 * 60
# Na een mislukte dagelijkse verversing (flitsers, statiegeld) eerder opnieuw proberen.
REFRESH_RETRY_S = 30 * 60
# Omgeving (woonplaatsen/gemeenten) opnieuw bepalen na zoveel meter verplaatsing.
AREA_MOVE_M = 750
AREA_MAX_AGE_S = 7 * 24 * 3600
AREA_SEARCH_M = 6000
# Maximaal zoveel gemeenten tegelijk bevragen (je eigen + buren binnen de straal).
MAX_GEMEENTEN = 4
LOCAL_NEWS_LIMIT = 40
ANNOUNCEMENTS_LIMIT = 300


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
            "parking": {"last_ok": None, "last_error": None, "count": 0},
            "news": {"last_ok": None, "last_error": None},
            "charging": {"last_ok": None, "last_error": None, "count": 0},
            "shops": {"last_ok": None, "last_error": None, "count": 0},
            "roadworks": {"last_ok": None, "last_error": None, "count": 0},
            "announcements": {"last_ok": None, "last_error": None, "gemeenten": []},
            "charging_status": {"last_ok": None, "last_error": None},
            "homeassistant": {"last_ok": None, "last_error": None},
        }
        self._tasks: list[asyncio.Task] = []
        # Beschikbaarheid van laadpalen: alleen in het geheugen (vluchtig, elk kwartier nieuw).
        self.charging_status: dict[str, dict[str, Any]] = {}
        self.charging_status_ts: float | None = None
        # Per feed: (aantal fouten op rij, niet opnieuw proberen voor dit tijdstip).
        self._feed_backoff: dict[str, tuple[int, float]] = {}
        # Woonplaatsen rond de laatst bekeken plek (PDOK), bewaard over herstarts heen.
        self.area: dict[str, Any] | None = self.db.meta_get("area")
        self._area_lock = asyncio.Lock()
        self._announcements_lock = asyncio.Lock()

    # --- incidenten -------------------------------------------------------

    def enrich(self, incident: dict[str, Any], loc: Location | None = None,
               news: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        """Incident voor de kaart: met sirene-vlag, afstand en gekoppeld nieuws.

        `news` = al opgehaalde artikelen voor dit incident (scheelt een query per incident).
        """
        loc = loc or self.locations.current
        if news is None:
            news = self.db.news_for_incidents([incident["id"]]).get(incident["id"], [])
        out = dict(incident)
        out["news"] = [self._news_out(n) for n in news]
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
        # Soms verscheen het nieuws al (bijv. bij een late of herhaalde melding).
        for article in self.db.news_between(stored["ts"] - news_matcher.BEFORE_S,
                                            stored["ts"] + news_matcher.AFTER_S):
            m = news_matcher.match(stored, article)
            if m:
                self.db.link_news(stored["id"], article["guid"], m.score)
        self.bus.publish("incident", self.enrich(stored))
        await self.maybe_notify(stored)
        return stored

    async def _fetch_feed_with_backoff(self, url: str, interval: float,
                                       status_key: str) -> list[FeedItem] | None:
        """Haalt een RSS-feed op; None als die nog in backoff zit of faalde."""
        failures, retry_at = self._feed_backoff.get(url, (0, 0.0))
        if time.time() < retry_at:
            return None
        try:
            items = await fetch_feed(self.client, url)
        except (httpx.HTTPError, ValueError) as exc:
            failures += 1
            # Bij fouten steeds langer wachten (max. 15 min) om de bron niet te belasten.
            delay = min(FEED_MAX_BACKOFF_S, interval * 2 ** failures)
            self._feed_backoff[url] = (failures, time.time() + delay)
            log.warning("Feed %s faalde (%s), volgende poging over %d s", url, exc, delay)
            self.status[status_key]["last_error"] = f"{time.time():.0f}: {url}: {exc}"
            return None
        self._feed_backoff.pop(url, None)
        return items

    async def poll_p2000_once(self) -> int:
        new = 0
        interval = self.cfg["p2000"]["poll_interval_s"]
        for url in self.cfg["p2000"]["feeds"]:
            items = await self._fetch_feed_with_backoff(url, interval, "p2000")
            if items is None:
                continue
            for item in sorted(items, key=lambda i: i.ts):
                if await self.process_item(item):
                    new += 1
            self.status["p2000"]["last_ok"] = time.time()
        self.db.purge_incidents(time.time() - self.cfg["p2000"]["keep_hours"] * 3600)
        return new

    # --- nieuws -----------------------------------------------------------

    @staticmethod
    def _news_out(article: dict[str, Any]) -> dict[str, Any]:
        return {
            "title": article["title"], "link": article["link"], "source": article["source"],
            "ts": article["ts"], "score": article["score"],
            "label": "waarschijnlijk" if article["score"] >= news_matcher.LIKELY_SCORE else "mogelijk",
        }

    def process_article(self, source: str, item: FeedItem) -> list[int]:
        """Slaat een nieuw artikel op en koppelt het; geeft de ids van gekoppelde meldingen."""
        if self.db.has_news(item.guid):
            return []
        if item.ts < time.time() - self._news_keep_s():
            return []  # ouder dan we bewaren
        summary = news_matcher.normalize(item.description)
        # Sommige feeds geven een tijd in de toekomst (verkeerde tijdzone): niet later dan nu.
        ts = min(item.ts, time.time())
        article = {"guid": item.guid, "ts": ts, "source": source, "title": item.title.strip(),
                   "summary": summary[:500], "link": item.link}
        self.db.insert_news(article)
        linked = []
        for incident in self.db.incidents_between(ts - news_matcher.AFTER_S,
                                                  ts + news_matcher.BEFORE_S):
            m = news_matcher.match(incident, article)
            if m and self.db.link_news(incident["id"], item.guid, m.score):
                linked.append(incident["id"])
        return linked

    async def poll_news_once(self) -> int:
        linked_total = 0
        interval = self.cfg["news"]["poll_interval_s"]
        for feed in self.cfg["news"]["feeds"]:
            items = await self._fetch_feed_with_backoff(feed["url"], interval, "news")
            if items is None:
                continue
            for item in sorted(items, key=lambda i: i.ts):
                for incident_id in self.process_article(feed["name"], item):
                    linked_total += 1
                    incident = self.db.get_incident(incident_id)
                    if incident:
                        self.bus.publish("incident", self.enrich(incident))
        self.db.purge_news(time.time() - self._news_keep_s())
        self.status["news"]["last_ok"] = time.time()
        return linked_total

    def _news_keep_s(self) -> float:
        return max(self.cfg["news"]["keep_hours"], self.cfg["p2000"]["keep_hours"]) * 3600

    # --- jouw buurt: omgeving, lokaal nieuws, bekendmakingen ----------------

    async def area_for(self, lat: float, lon: float) -> list[dict[str, Any]]:
        """Woonplaatsen rond een punt (met gemeente en afstand); gecachet per ~750 m."""
        async with self._area_lock:
            a = self.area
            if (a and haversine_m(lat, lon, a["lat"], a["lon"]) < AREA_MOVE_M
                    and time.time() - a["ts"] < AREA_MAX_AGE_S):
                return a["places"]
            try:
                places = await fetch_area(self.client, lat, lon, AREA_SEARCH_M)
            except (httpx.HTTPError, ValueError) as exc:
                log.warning("Omgeving bepalen mislukt: %s", exc)
                return a["places"] if a else []
            if places:
                self.area = {"lat": lat, "lon": lon, "ts": time.time(), "places": places}
                self.db.meta_set("area", self.area)
            return places

    def gemeenten_near(self, places: list[dict[str, Any]]) -> list[str]:
        """Je eigen gemeente plus buurgemeenten die binnen de straal beginnen."""
        radius = self.cfg["announcements"]["radius_m"]
        out: list[str] = []
        for i, p in enumerate(places):
            if (i == 0 or p["distance_m"] <= radius) and p["gemeente"] not in out:
                out.append(p["gemeente"])
        return out[:MAX_GEMEENTEN]

    async def refresh_announcements(self, gemeenten: list[str], force: bool = False) -> int:
        """Haalt bekendmakingen op voor gemeenten waarvan de gegevens verouderd zijn."""
        acfg = self.cfg["announcements"]
        fetched = 0
        async with self._announcements_lock:
            for gemeente in gemeenten:
                key = f"announcements_{gemeente}"
                last = self.db.meta_get(key)
                if not force and last and time.time() - last < acfg["refresh_minutes"] * 60:
                    continue
                # Eerste keer: de hele periode; daarna alleen wat sinds gisteren gewijzigd is.
                since = dt.date.today() - (dt.timedelta(days=1) if last
                                           else dt.timedelta(days=acfg["days"]))
                try:
                    items = await fetch_announcements(self.client, gemeente, since)
                except (httpx.HTTPError, ValueError) as exc:  # ValueError: kapotte XML
                    self.status["announcements"]["last_error"] = f"{time.time():.0f}: {gemeente}: {exc}"
                    log.warning("Bekendmakingen voor %s ophalen mislukt: %s", gemeente, exc)
                    continue
                self.db.upsert_announcements(items)
                self.db.meta_set(key, time.time())
                fetched += len(items)
                self.status["announcements"]["last_ok"] = time.time()
            self.db.purge_announcements(time.time() - acfg["days"] * 86400)
        self.status["announcements"]["gemeenten"] = gemeenten
        return fetched

    async def refresh_announcements_once(self) -> None:
        loc = self.locations.current
        if loc is None:
            return
        places = await self.area_for(loc.lat, loc.lon)
        if await self.refresh_announcements(self.gemeenten_near(places)):
            self.bus.publish("local", {"ts": time.time()})

    async def local_overview(self, lat: float, lon: float) -> dict[str, Any]:
        """Nieuws dat een plaats in de buurt noemt en bekendmakingen rond dit punt."""
        places = await self.area_for(lat, lon)
        out: dict[str, Any] = {"place": places[0]["name"] if places else None,
                               "gemeente": places[0]["gemeente"] if places else None,
                               "news": [], "announcements": []}
        if self.cfg["news"]["enabled"]:
            near = [p for p in places if p["distance_m"] <= self.cfg["news"]["local_radius_m"]]
            now = time.time()
            for article in self.db.news_since(now - self.cfg["news"]["keep_hours"] * 3600):
                place = news_matcher.local_place(article, near)
                if place:
                    out["news"].append({
                        "title": article["title"], "link": article["link"],
                        "source": article["source"], "ts": article["ts"],
                        "place": place["name"], "distance_m": place["distance_m"],
                        "relevance": news_matcher.local_relevance(article, place, now),
                    })
            # Actueel en dichtbij eerst.
            out["news"].sort(key=lambda n: (n["relevance"], n["ts"]), reverse=True)
            del out["news"][LOCAL_NEWS_LIMIT:]
        acfg = self.cfg["announcements"]
        if acfg["enabled"] and places:
            gemeenten = self.gemeenten_near(places)
            await self.refresh_announcements(gemeenten)
            own = places[0]["gemeente"]
            for a in self.db.announcements_for(gemeenten, time.time() - acfg["days"] * 86400):
                if a["lat"] is None:
                    if a["gemeente"] != own:
                        continue  # regels zonder plek: alleen die van je eigen gemeente
                    a["distance_m"] = None
                else:
                    a["distance_m"] = round(haversine_m(lat, lon, a["lat"], a["lon"]))
                    if a["distance_m"] > acfg["radius_m"]:
                        continue
                a["relevance"] = announcement_relevance(a, acfg["radius_m"])
                out["announcements"].append(a)
            # Nuttigste eerst; de app kan ook op datum of afstand sorteren.
            out["announcements"].sort(key=lambda a: (a["relevance"], a["date"]), reverse=True)
            del out["announcements"][ANNOUNCEMENTS_LIMIT:]
        return out

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

    # --- parkeerzones -----------------------------------------------------

    async def refresh_parking_once(self) -> bool:
        try:
            zones = await fetch_zones(self.client)
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            log.warning("Parkeerzones ophalen mislukt: %s", exc)
            self.status["parking"]["last_error"] = f"{time.time():.0f}: {exc}"
            return False
        self.db.replace_parking(zones)
        self.db.meta_set("parking_updated", time.time())
        self.status["parking"].update(last_ok=time.time(), count=len(zones))
        self.bus.publish("parking", {"count": len(zones)})
        return True

    # --- winkels ------------------------------------------------------------

    def fill_shop_hours(self, shops: list[dict[str, Any]], radius_m: float = 75) -> int:
        """Vult ontbrekende openingstijden aan met die van hetzelfde statiegeldpunt."""
        filled = 0
        for shop in shops:
            if shop["hours"] or shop["kind"] == "markt":
                continue
            d_lat = radius_m / 111_320
            d_lon = radius_m / (111_320 * max(0.1, math.cos(math.radians(shop["lat"]))))
            for point in self.db.statiegeld_in_bbox(shop["lat"] - d_lat, shop["lon"] - d_lon,
                                                    shop["lat"] + d_lat, shop["lon"] + d_lon, 50):
                if (same_store(shop, point) and any(h is not None for h in point["hours"])
                        and haversine_m(shop["lat"], shop["lon"], point["lat"], point["lon"]) <= radius_m):
                    shop["hours"] = point["hours"]
                    shop["hours_source"] = "Statiegeld Nederland"
                    shop["late"] = is_late(point["hours"])
                    filled += 1
                    break
        return filled

    async def refresh_shops_once(self) -> bool:
        try:
            shops = await fetch_shops(self.client, self.cfg["speedcams"]["overpass_urls"])
        except RuntimeError as exc:
            self.status["shops"]["last_error"] = f"{time.time():.0f}: {exc}"
            return False
        filled = self.fill_shop_hours(shops)
        log.info("%d winkels, openingstijden van %d aangevuld via statiegelddata", len(shops), filled)
        self.db.replace_shops(shops)
        self.db.meta_set("shops_updated", time.time())
        self.status["shops"].update(last_ok=time.time(), count=len(shops))
        self.bus.publish("shops", {"count": len(shops)})
        return True

    # --- laadpalen ---------------------------------------------------------

    async def refresh_roadworks_once(self) -> bool:
        rcfg = self.cfg["roadworks"]
        etag = self.db.meta_get("roadworks_etag") if self.db.roadworks_count() else None
        try:
            works, etag = await fetch_roadworks(self.client, rcfg["url"] or ROADWORKS_URL,
                                                rcfg["ahead_days"], etag)
        except (httpx.HTTPError, ValueError, OSError, EOFError) as exc:
            log.warning("Wegwerkzaamheden ophalen mislukt: %s", exc)
            self.status["roadworks"]["last_error"] = f"{time.time():.0f}: {exc}"
            return False
        if works is not None:
            self.db.replace_roadworks(works)
            self.db.meta_set("roadworks_etag", etag)
            self.status["roadworks"]["count"] = len(works)
            self.bus.publish("roadworks", {"count": len(works)})
        self.db.meta_set("roadworks_updated", time.time())
        self.status["roadworks"]["last_ok"] = time.time()
        return True

    async def street_at(self, lat: float, lon: float) -> str | None:
        """Straatnaam bij een punt (gecachet); None als PDOK niets vindt of niet bereikbaar is."""
        key = f"straat:{lat:.4f},{lon:.4f}"
        row = self.db.geocache_get(key)
        if row is not None:
            return row["label"]
        try:
            label = await fetch_street(self.client, lat, lon)
        except (httpx.HTTPError, ValueError) as exc:
            log.debug("Straatnaam bij %s mislukt: %s", key, exc)
            return None
        self.db.geocache_put(key, lat, lon, "straat" if label else None, label)
        return label

    async def refresh_charging_once(self) -> bool:
        try:
            stations = await fetch_stations(self.client)
        except (httpx.HTTPError, ValueError, OSError) as exc:
            log.warning("Laadpalen ophalen mislukt: %s", exc)
            self.status["charging"]["last_error"] = f"{time.time():.0f}: {exc}"
            return False
        self.db.replace_charging(stations)
        self.db.meta_set("charging_updated", time.time())
        self.status["charging"].update(last_ok=time.time(), count=len(stations))
        self.bus.publish("charging", {"count": len(stations)})
        return True

    async def refresh_charging_status_once(self) -> None:
        try:
            status = await fetch_availability(self.client)
        except (httpx.HTTPError, ValueError, OSError) as exc:
            log.warning("Beschikbaarheid laadpalen ophalen mislukt: %s", exc)
            self.status["charging_status"]["last_error"] = f"{time.time():.0f}: {exc}"
            return
        self.charging_status = status
        self.charging_status_ts = time.time()
        self.status["charging_status"]["last_ok"] = self.charging_status_ts
        self.bus.publish("charging_status", {"ts": self.charging_status_ts})

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
        if self.cfg["news"]["enabled"]:
            self._tasks.append(asyncio.create_task(
                self._loop("nieuws", self.cfg["news"]["poll_interval_s"], self.poll_news_once)))
        if self.cfg["announcements"]["enabled"]:
            # Elk kwartier kijken of je in een andere gemeente bent; ophalen per gemeente
            # gebeurt hooguit elke `refresh_minutes`.
            self._tasks.append(asyncio.create_task(
                self._loop("bekendmakingen", 15 * 60, self.refresh_announcements_once)))
        if self.cfg["roadworks"]["enabled"]:
            self.status["roadworks"]["count"] = self.db.roadworks_count()
            self._tasks.append(asyncio.create_task(self._refresh_loop(
                "roadworks", self.cfg["roadworks"]["refresh_minutes"] * 60,
                self.refresh_roadworks_once)))
        if self.cfg["shops"]["enabled"]:
            self.status["shops"]["count"] = self.db.shops_count()
            self._tasks.append(asyncio.create_task(self._refresh_loop(
                "shops", self.cfg["shops"]["refresh_hours"] * 3600, self.refresh_shops_once)))
        if self.cfg["charging"]["enabled"]:
            self.status["charging"]["count"] = self.db.charging_count()
            self._tasks.append(asyncio.create_task(self._refresh_loop(
                "charging", self.cfg["charging"]["refresh_hours"] * 3600,
                self.refresh_charging_once)))
            self._tasks.append(asyncio.create_task(self._loop(
                "laadstatus", self.cfg["charging"]["status_interval_s"],
                self.refresh_charging_status_once)))
        if self.cfg["parking"]["enabled"]:
            self.status["parking"]["count"] = self.db.parking_count()
            self._tasks.append(asyncio.create_task(self._refresh_loop(
                "parking", self.cfg["parking"]["refresh_hours"] * 3600,
                self.refresh_parking_once)))
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
