"""Adres -> coördinaten via cache en de PDOK Locatieserver (BAG, gratis, zonder sleutel).

Volgorde, van nauwkeurig naar grof:
  1. 6-cijferige postcode (bijv. 3072AP)             -> precisie "postcode"
  2. straat + plaats binnen 4-cijferige postcode     -> precisie "postcode"
  3. straat + plaats (midden van de straat)          -> precisie "straat"
  4. alleen plaats (midden van de woonplaats)        -> precisie "plaats"

Alleen het adres van het incident gaat naar PDOK, nooit jouw eigen locatie.
"""

from __future__ import annotations

import logging
import re
import time
import unicodedata
from dataclasses import dataclass

import httpx

from .db import Database

log = logging.getLogger(__name__)

PRECISION_RANK = {"plaats": 1, "straat": 2, "postcode": 3}
MISS_TTL_S = 24 * 3600


@dataclass
class GeoResult:
    lat: float
    lon: float
    precision: str
    label: str


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _point(wkt: str) -> tuple[float, float]:
    lon, lat = wkt.removeprefix("POINT(").removesuffix(")").split()
    return float(lat), float(lon)


class Geocoder:
    def __init__(self, db: Database, client: httpx.AsyncClient, pdok_url: str,
                 pdok_enabled: bool = True) -> None:
        self.db = db
        self.client = client
        self.pdok_url = pdok_url
        self.pdok_enabled = pdok_enabled

    async def geocode(self, street: str | None, city: str | None,
                      postcode: str | None) -> GeoResult | None:
        key = "|".join(_normalize(p or "") for p in (street, city, postcode))
        cached = self.db.geocache_get(key)
        if cached is not None:
            if cached["lat"] is not None:
                return GeoResult(cached["lat"], cached["lon"], cached["precision"], cached["label"])
            if time.time() - cached["created_at"] < MISS_TTL_S:
                return None

        if not self.pdok_enabled:
            return None
        try:
            result = await self._lookup(street, city, postcode)
        except httpx.HTTPError as exc:
            log.warning("PDOK-geocoding mislukt voor %s, %s: %s", street, city, exc)
            return None  # niet cachen: volgende keer opnieuw proberen

        if result:
            self.db.geocache_put(key, result.lat, result.lon, result.precision, result.label)
        else:
            self.db.geocache_put(key, None, None, None, None)
        return result

    async def _lookup(self, street, city, postcode) -> GeoResult | None:
        if postcode and len(postcode) == 6:
            doc = await self._search(postcode, "type:postcode")
            if doc:
                return self._result(doc, "postcode")

        if street and city:
            if postcode and len(postcode) == 4:
                doc = await self._search(f"{street} {city}", "type:adres",
                                         f"postcode:{postcode}*", street=street)
                if doc:
                    return self._result(doc, "postcode")
            doc = await self._search(f"{street} {city}", "type:weg", street=street)
            if doc:
                return self._result(doc, "straat")

        if city:
            doc = await self._search(city, "type:woonplaats")
            if doc:
                return self._result(doc, "plaats")
        return None

    async def _search(self, q: str, *fq: str, street: str | None = None) -> dict | None:
        params = [("q", q), ("rows", "5"),
                  ("fl", "weergavenaam,type,centroide_ll,straatnaam,woonplaatsnaam")]
        params += [("fq", f) for f in fq]
        resp = await self.client.get(self.pdok_url, params=params, timeout=10)
        resp.raise_for_status()
        docs = resp.json().get("response", {}).get("docs", [])
        if street:
            # Fuzzy zoeken kan een andere straat opleveren; eis dat de naam klopt.
            wanted = _normalize(street)
            docs = [d for d in docs if _normalize(d.get("straatnaam", "")) == wanted]
        return docs[0] if docs else None

    @staticmethod
    def _result(doc: dict, precision: str) -> GeoResult:
        lat, lon = _point(doc["centroide_ll"])
        return GeoResult(lat, lon, precision, doc.get("weergavenaam", ""))
