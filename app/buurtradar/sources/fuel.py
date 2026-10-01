"""Tankstations uit OpenStreetMap (Overpass API), met of zonder winkel.

Data © OpenStreetMap-bijdragers, beschikbaar onder de ODbL.

Of een tankstation een winkel heeft, staat maar zelden in OSM zelf (`shop=*` op het station).
Daarom kijken we ook naar een buurtwinkel of kiosk op het terrein (binnen 60 m, bijv. "SPAR
express", "AH to go", "Shell Select") en naar onbemande merken (TinQ, Tango, "... Express").
Wat we zo niet kunnen bepalen, blijft "onbekend": liever dat dan gokken.
"""

from __future__ import annotations

import logging
import math
import re
from collections import defaultdict
from typing import Any

import httpx

from .shops import _address, is_late, parse_opening_hours

log = logging.getLogger(__name__)

QUERY = """
[out:json][timeout:240];
area["ISO3166-1"="NL"][admin_level=2]->.nl;
(
  nwr["amenity"="fuel"](area.nl);
  nwr["shop"~"^(convenience|kiosk)$"](area.nl);
);
out center tags;
"""

SHOP_NEAR_M = 60
# Onbemande tankstations (alleen pinautomaat). "Express"/"XPress" gebruiken Esso, Shell, BP,
# TotalEnergies, AVIA, OK en Tamoil voor hun onbemande stations.
UNMANNED_RE = re.compile(r"express|xpress|\b(tinq|tango|sakko|tanqyou|supertank|firezone|truckeasy)\b|"
                         r"onbemand|unmanned", re.I)
NO_SHOP_VALUES = {"no", "none"}

# fuel:*-sleutels -> naam aan de pomp.
FUELS = [
    ("fuel:e10", "Euro 95 (E10)"),
    ("fuel:octane_95", "Euro 95"),
    ("fuel:octane_98", "Super 98"),
    ("fuel:diesel", "Diesel"),
    ("fuel:HGV_diesel", "Diesel (vrachtwagen)"),
    ("fuel:hvo", "HVO"),
    ("fuel:lpg", "LPG"),
    ("fuel:cng", "CNG (aardgas)"),
    ("fuel:lng", "LNG"),
    ("fuel:hydrogen", "Waterstof"),
    ("fuel:adblue", "AdBlue"),
]


def _latlon(el: dict[str, Any]) -> tuple[float, float] | None:
    lat = el.get("lat") or (el.get("center") or {}).get("lat")
    lon = el.get("lon") or (el.get("center") or {}).get("lon")
    return (lat, lon) if lat is not None and lon is not None else None


def _metres(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot((a[0] - b[0]) * 111_000, (a[1] - b[1]) * 111_000 * math.cos(math.radians(a[0])))


def classify(tags: dict[str, str], nearby_shop: str | None) -> tuple[str, str]:
    """("ja" | "nee" | "onbekend", waarom). `nearby_shop` = naam van een winkel op het terrein."""
    shop = tags.get("shop")
    if shop in NO_SHOP_VALUES:
        return "nee", "volgens OpenStreetMap"
    if shop:
        return "ja", "volgens OpenStreetMap"
    if tags.get("automated") == "yes" or tags.get("self_service") == "only":
        return "nee", "onbemand station"
    if UNMANNED_RE.search(f"{tags.get('brand', '')} {tags.get('name', '')}"):
        return "nee", "onbemand station"
    if nearby_shop is not None:
        return "ja", f"winkel op het terrein: {nearby_shop}" if nearby_shop else "winkel op het terrein"
    return "onbekend", "niet bekend in OpenStreetMap"


def parse_overpass(data: dict[str, Any]) -> list[dict[str, Any]]:
    stations = []
    shops = []
    for el in data.get("elements", []):
        tags = el.get("tags") or {}
        pos = _latlon(el)
        if pos is None:
            continue
        if tags.get("amenity") == "fuel":
            stations.append((el, tags, pos))
        elif tags.get("shop") in ("convenience", "kiosk"):
            shops.append((tags.get("name") or tags.get("brand") or "", pos))
    # Raster van ~100 m om winkels bij een station snel te vinden.
    grid: dict[tuple[int, int], list[tuple[str, tuple[float, float]]]] = defaultdict(list)
    for name, pos in shops:
        grid[(int(pos[0] * 1000), int(pos[1] * 600))].append((name, pos))

    out = []
    for el, tags, pos in stations:
        if tags.get("access") in ("private", "no") or tags.get("disused") == "yes":
            continue
        near = None
        best = SHOP_NEAR_M + 1
        gy, gx = int(pos[0] * 1000), int(pos[1] * 600)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for name, spos in grid.get((gy + dy, gx + dx), ()):
                    d = _metres(pos, spos)
                    if d < best:
                        best, near = d, name
        shop, reason = classify(tags, near)
        hours = parse_opening_hours(tags.get("opening_hours"))
        brand = tags.get("brand")
        name = tags.get("name") or brand or "Tankstation"
        out.append({
            "id": f"{el['type']}/{el['id']}",
            "lat": round(pos[0], 6),
            "lon": round(pos[1], 6),
            "name": name,
            "brand": brand,
            "address": _address(tags),
            "shop": shop,
            "shop_reason": reason,
            "fuels": [label for key, label in FUELS if tags.get(key) == "yes"],
            "truck": tags.get("hgv") == "yes" or tags.get("fuel:HGV_diesel") == "yes",
            "car_wash": tags.get("car_wash") == "yes",
            "compressed_air": tags.get("compressed_air") == "yes",
            "toilets": tags.get("toilets") == "yes",
            "hours": hours,
            "hours_raw": tags.get("opening_hours"),
            "late": is_late(hours),
            "website": tags.get("website") or tags.get("contact:website"),
        })
    return out


async def fetch_fuel(client: httpx.AsyncClient, urls: list[str]) -> list[dict[str, Any]]:
    """Probeert de Overpass-servers op volgorde; de eerste die antwoordt wint."""
    last_error: Exception | None = None
    for url in urls:
        try:
            resp = await client.post(url, data={"data": QUERY}, timeout=300)
            resp.raise_for_status()
            stations = parse_overpass(resp.json())
            if stations:
                log.info("%d tankstations opgehaald via %s", len(stations), url)
                return stations
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("Overpass %s faalde: %s", url, exc)
            last_error = exc
    raise RuntimeError(f"Geen Overpass-server bereikbaar: {last_error}")
