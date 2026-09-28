"""Officiële bekendmakingen van gemeenten (vergunningen, verkeersbesluiten, evenementen).

Bron: de open SRU-zoekdienst van overheid.nl (https://repository.overheid.nl/sru), dezelfde
gegevens als op officielebekendmakingen.nl en de Berichten over je Buurt-app. De meeste
publicaties hebben een locatie (punt, lijn of vlak), zodat we op afstand kunnen filteren.

Daarnaast: welke woonplaatsen en gemeenten liggen rond een punt (PDOK Locatieserver), zodat
we weten welke gemeenten we moeten bevragen en welk nieuws "uit de buurt" is.
"""

from __future__ import annotations

import datetime as dt
import logging
import re
import xml.etree.ElementTree as ET
from typing import Any

import httpx

log = logging.getLogger(__name__)

SRU_URL = "https://repository.overheid.nl/sru"
REVERSE_URL = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/reverse"
PAGE_SIZE = 1000
MAX_PAGES = 3

NS = {
    "sru": "http://docs.oasis-open.org/ns/search-ws/sruResponse",
    "dcterms": "http://purl.org/dc/terms/",
    "ow": "http://standaarden.overheid.nl/wetgeving/",
    "gzd": "http://standaarden.overheid.nl/sru",
}

# Rubriek (dcterms:type) -> categorie in de app. Onbekende rubrieken vallen onder "overig".
CATEGORIES = {
    "omgevingsvergunning": "bouwen",
    "omgevingsmelding": "bouwen",
    "bestemmingsplan": "bouwen",
    "omgevingsplan": "bouwen",
    "ruimtelijk plan of omgevingsdocument": "bouwen",
    "verkeersbesluit of -mededeling": "verkeer",
    "evenementenvergunning": "evenementen",
    "andere vergunning": "vergunning",
    "drank- en horecavergunning": "vergunning",
    "exploitatievergunning": "vergunning",
    "kapvergunning": "bouwen",
}

_COORD_RE = re.compile(r"(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)")
_LATLON_RE = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$")
_ZAAK_RE = re.compile(r",?\s*\b[A-Z]{1,5}-?Z?\d{4}-\d{3,}\S*$")


def category_of(kind: str, title: str = "") -> str:
    kind = (kind or "").strip().lower()
    if kind in CATEGORIES:
        return CATEGORIES[kind]
    t = title.lower()
    if "verkeersbesluit" in t or "parkeerplaats" in t or "afsluiting" in t:
        return "verkeer"
    if "evenement" in t:
        return "evenementen"
    return "overig"


def point_of(locatiegebied: str | None) -> tuple[float, float] | None:
    """Middelpunt (lat, lon) van een WKT-geometrie in WGS84 of een "lat,lon"-punt.

    WKT staat in lon/lat-volgorde; het middelpunt is het gemiddelde van de hoekpunten.
    Voor een straat of klein bouwvlak is dat ruim nauwkeurig genoeg.
    """
    if not locatiegebied:
        return None
    m = _LATLON_RE.match(locatiegebied)
    if m:
        return float(m.group(1)), float(m.group(2))
    coords = [(float(x), float(y)) for x, y in _COORD_RE.findall(locatiegebied)]
    if not coords:
        return None
    lon = sum(c[0] for c in coords) / len(coords)
    lat = sum(c[1] for c in coords) / len(coords)
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None  # geen WGS84 (bijv. rijksdriehoek)
    return lat, lon


def short_title(title: str) -> str:
    """Titel zonder zaaknummer aan het eind ("…, 3512AH Utrecht, GU-Z2026-0068098")."""
    return _ZAAK_RE.sub("", title.strip()).rstrip(" ,")


def _text(el: ET.Element, path: str) -> str | None:
    found = el.find(path, NS)
    return found.text.strip() if found is not None and found.text else None


def _date_ts(value: str | None) -> float | None:
    if not value:
        return None
    try:
        day = dt.date.fromisoformat(value[:10])
    except ValueError:
        return None
    return dt.datetime(day.year, day.month, day.day, 12, tzinfo=dt.timezone.utc).timestamp()


def parse_sru(xml: bytes | str) -> tuple[int, list[dict[str, Any]]]:
    """SRU-antwoord -> (totaal aantal resultaten, bekendmakingen op deze pagina)."""
    root = ET.fromstring(xml)
    total = int(_text(root, "sru:numberOfRecords") or 0)
    out = []
    for rec in root.iterfind(".//sru:record", NS):
        meta = rec.find(".//ow:meta", NS)
        if meta is None:
            continue
        ident = _text(meta, ".//dcterms:identifier")
        title = _text(meta, ".//dcterms:title")
        if not ident or not title:
            continue
        kind = _text(meta, ".//dcterms:type") or ""
        date = _text(meta, ".//dcterms:available") or _text(meta, ".//dcterms:modified")
        lat = lon = None
        label = None
        for mark in meta.iterfind(".//ow:gebiedsmarkering/*", NS):
            point = point_of(_text(mark, "ow:locatiegebied"))
            if point:
                lat, lon = point
                label = _text(mark, "ow:geometrielabel")
                break
        abstract = _text(meta, ".//dcterms:abstract") or ""
        abstract = re.sub(r"^Toelichting:\s*", "", abstract)
        url = (_text(rec, ".//gzd:preferredUrl")
               or f"https://zoek.officielebekendmakingen.nl/{ident}.html")
        out.append({
            "id": ident,
            "gemeente": _text(meta, ".//dcterms:creator") or "",
            "ts": _date_ts(date),
            "date": (date or "")[:10],
            "type": kind,
            "category": category_of(kind, title),
            "title": short_title(title),
            "abstract": abstract[:400],
            "label": label,
            "lat": lat,
            "lon": lon,
            "deadline": (_text(meta, ".//ow:datumEindeReactietermijn") or "")[:10] or None,
            "url": url,
        })
    return total, out


def build_query(gemeente: str, since: dt.date) -> str:
    name = gemeente.replace('"', "")
    return (f'c.product-area==officielepublicaties AND dt.creator="{name}" '
            f"AND dt.modified>={since.isoformat()} sortBy dt.modified/sort.descending")


async def fetch_announcements(client: httpx.AsyncClient, gemeente: str, since: dt.date,
                              url: str = SRU_URL) -> list[dict[str, Any]]:
    """Alle bekendmakingen van één gemeente sinds een datum (nieuwste eerst)."""
    items: list[dict[str, Any]] = []
    start = 1
    for _ in range(MAX_PAGES):
        resp = await client.get(url, params={
            "operation": "searchRetrieve", "version": "2.0",
            "query": build_query(gemeente, since),
            "startRecord": start, "maximumRecords": PAGE_SIZE,
        }, timeout=60)
        resp.raise_for_status()
        total, page = parse_sru(resp.content)
        # Alleen van deze gemeente: "Utrecht" matcht ook de provincie Utrecht als maker.
        items.extend(i for i in page if i["gemeente"].lower() == gemeente.lower())
        start += PAGE_SIZE
        if not page or start > total:
            break
    return items


async def fetch_area(client: httpx.AsyncClient, lat: float, lon: float,
                     distance_m: int = 6000, url: str = REVERSE_URL) -> list[dict[str, Any]]:
    """Woonplaatsen rond een punt met hun gemeente en afstand, dichtstbijzijnde eerst.

    Voor je privacy gaat alleen een afgerond punt naar PDOK (2 decimalen, ~1 km); voor
    "welke plaatsen liggen hier in de buurt" is dat nauwkeurig genoeg.
    """
    resp = await client.get(url, params={
        "lat": f"{lat:.2f}", "lon": f"{lon:.2f}", "type": "woonplaats", "rows": 12,
        "distance": distance_m, "fl": "woonplaatsnaam,gemeentenaam,afstand",
    }, timeout=20)
    resp.raise_for_status()
    places = []
    seen = set()
    for doc in resp.json().get("response", {}).get("docs", []):
        name = doc.get("woonplaatsnaam")
        if not name or name in seen:
            continue
        seen.add(name)
        places.append({"name": name, "gemeente": doc.get("gemeentenaam") or name,
                       "distance_m": round(float(doc.get("afstand") or 0))})
    places.sort(key=lambda p: p["distance_m"])
    return places
