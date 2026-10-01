"""Actuele locatie: uit Home Assistant, uit de browser, of een vaste terugvallocatie."""

from __future__ import annotations

import logging
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any

import httpx

from .db import Database

log = logging.getLogger(__name__)


@dataclass
class Location:
    lat: float
    lon: float
    accuracy: float | None
    source: str  # "homeassistant", "browser" of "vast"
    ts: float

    def to_dict(self) -> dict[str, Any]:
        return {**asdict(self), "age_s": round(time.time() - self.ts)}


class LocationStore:
    def __init__(self, db: Database, fallback: dict[str, Any] | None = None) -> None:
        self.db = db
        self.fallback = fallback or {}
        saved = db.meta_get("location")
        self._current: Location | None = Location(**saved) if saved else None

    @property
    def home(self) -> dict[str, float] | None:
        """Vaste plek (bijv. thuis): ingesteld in het paneel, anders uit config.yaml."""
        saved = self.db.meta_get("home")
        if saved:
            return {"lat": float(saved["lat"]), "lon": float(saved["lon"])}
        if self.fallback.get("lat") is not None and self.fallback.get("lon") is not None:
            return {"lat": float(self.fallback["lat"]), "lon": float(self.fallback["lon"])}
        return None

    def set_home(self, lat: float | None, lon: float | None) -> None:
        """Vaste plek instellen (None = wissen; dan geldt weer config.yaml, als daar iets staat)."""
        if lat is None or lon is None:
            self.db.meta_set("home", None)
            if self._current and self._current.source == "vast":
                self._current = None
                self.db.meta_set("location", None)
            return
        self.db.meta_set("home", {"lat": lat, "lon": lon})
        # Een live locatie (telefoon, browser) van vandaag blijft voorgaan op de vaste plek.
        if self._current is None or self._current.source == "vast" or time.time() - self._current.ts > 6 * 3600:
            self.update(Location(lat, lon, None, "vast", time.time()))

    @property
    def current(self) -> Location | None:
        if self._current:
            return self._current
        home = self.home
        if home:
            return Location(home["lat"], home["lon"], None, "vast", time.time())
        return None

    def update(self, loc: Location) -> bool:
        """Slaat de locatie op; geeft True als die nieuwer is dan de huidige."""
        if self._current and loc.ts < self._current.ts:
            return False
        if self._current and (self._current.lat, self._current.lon, self._current.ts) == (
                loc.lat, loc.lon, loc.ts):
            return False
        self._current = loc
        self.db.meta_set("location", asdict(loc))
        return True


def parse_ha_state(state: dict[str, Any]) -> Location | None:
    attrs = state.get("attributes", {})
    lat, lon = attrs.get("latitude"), attrs.get("longitude")
    if lat is None or lon is None:
        return None
    try:
        ts = datetime.fromisoformat(state["last_updated"]).timestamp()
    except (KeyError, TypeError, ValueError):
        ts = time.time()
    return Location(float(lat), float(lon), attrs.get("gps_accuracy"), "homeassistant", ts)


async def fetch_ha_location(client: httpx.AsyncClient, url: str, token: str,
                            entity_id: str) -> Location | None:
    resp = await client.get(
        f"{url.rstrip('/')}/api/states/{entity_id}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=10,
    )
    resp.raise_for_status()
    return parse_ha_state(resp.json())
