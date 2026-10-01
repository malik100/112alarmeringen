"""Statiegeld-inleverpunten uit de openbare kaartdienst (WFS) achter de locatiewijzer
van Statiegeld Nederland (https://www.statiegeldnederland.nl/locatiewijzer).
"""

from __future__ import annotations

import logging
import re
from typing import Any

import httpx

log = logging.getLogger(__name__)

DEFAULT_URL = (
    "https://geoserver-statiegeld.webgis.nl/Statiegeld/wfs?service=WFS&version=1.0.0"
    "&request=GetFeature&typeName=Statiegeld:inleverpunten&srsName=EPSG:4326"
    "&maxFeatures=50000&outputFormat=application/json"
)

# Velden in de bron, maandag t/m zondag.
DAY_FIELDS = ("ma", "di", "woe", "do", "vrij", "za", "zo")
MATERIALS = {"groot_pet": "Grote PET-fles", "klein_pet": "Kleine PET-fles", "blik": "Blik",
             "glas": "Glas", "krat": "Krat"}
PAYOUTS = {"bonnetje": "Bonnetje", "contant": "Contant", "retourpinnen": "Retourpinnen",
           "tikkie": "Tikkie", "app": "Via app", "droppie": "Droppie", "donatie": "Doneren"}

_RANGE_RE = re.compile(r"^(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})$")


def parse_day(raw: str | None) -> list[list[int]] | None:
    """Openingstijden van één dag -> lijst [start, eind] in minuten na middernacht.

    None = onbekend, [] = gesloten. Een eindtijd voorbij middernacht (bijv. 10:00–01:00)
    wordt 1500: groter dan 1440, zodat de nacht bij de dag erna meetelt.
    """
    value = (raw or "").strip()
    if not value or value.upper() == "NA":
        return None
    if value.lower() == "gesloten":
        return []
    if "24 uur" in value.lower():
        return [[0, 1440]]
    ranges = []
    for part in value.split(","):
        m = _RANGE_RE.match(part.strip())
        if not m:
            return None  # onbekend formaat: liever "onbekend" dan fout
        start = int(m.group(1)) * 60 + int(m.group(2))
        end = int(m.group(3)) * 60 + int(m.group(4))
        if end <= start:
            end += 1440
        ranges.append([start, end])
    return ranges


def _yes(props: dict[str, Any], key: str) -> bool:
    return str(props.get(key, "")).strip().lower() == "ja"


def parse_features(geojson: dict[str, Any]) -> list[dict[str, Any]]:
    points: dict[tuple, dict[str, Any]] = {}
    for feature in geojson.get("features", []):
        geom = feature.get("geometry") or {}
        props = feature.get("properties") or {}
        if geom.get("type") != "Point":
            continue
        lon, lat = geom["coordinates"][:2]
        # De bron heeft ook lat/lng-velden met meer decimalen.
        lat = props.get("lat") or lat
        lon = props.get("lng") or lon
        name = re.sub(r"^[-\s]+", "", props.get("bedrijf") or "").strip() or "Inleverpunt"
        key = (name.lower(), round(lat, 5), round(lon, 5))
        if key in points:
            continue  # dubbel in de bron
        points[key] = {
            "id": str(props.get("id") or feature.get("id")),
            "lat": float(lat),
            "lon": float(lon),
            "name": name,
            "address": ", ".join(p for p in (props.get("straat_huisnr"),
                                             props.get("postcode_plaats")) if p),
            "hours": [parse_day(props.get(d)) for d in DAY_FIELDS],
            "hours_raw": [props.get(d) or "NA" for d in DAY_FIELDS],
            "materials": [label for key_, label in MATERIALS.items() if _yes(props, key_)],
            "payouts": [label for key_, label in PAYOUTS.items() if _yes(props, key_)],
            "machine": _yes(props, "automaat_aanwezig"),
            "manual": _yes(props, "handmatig_inleverpunt"),
            "public": _yes(props, "vrij_toegankelijk"),
            "bulk": _yes(props, "bulk"),
        }
    return list(points.values())


async def fetch_statiegeld(client: httpx.AsyncClient, url: str) -> list[dict[str, Any]]:
    resp = await client.get(url, timeout=120)
    resp.raise_for_status()
    points = parse_features(resp.json())
    if not points:
        raise ValueError("Geen statiegeldpunten in het antwoord")
    log.info("%d statiegeldpunten opgehaald", len(points))
    return points
