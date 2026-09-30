"""Supermarkten, buurt-/avondwinkels en markten uit OpenStreetMap (Overpass API).

Data © OpenStreetMap-bijdragers, beschikbaar onder de ODbL.

Openingstijden staan in OSM in het `opening_hours`-formaat, bijv.
"Mo-Sa 08:00-22:00; Su 10:00-20:00". We vertalen de gangbare vormen naar hetzelfde
weekrooster als bij statiegeld: 7 dagen (maandag eerst), per dag None (onbekend),
[] (gesloten) of [[start, eind], ...] in minuten (eind > 1440 = tot na middernacht).
Alles wat we niet zeker begrijpen (maanden, schoolvakanties, "sunrise") wordt "onbekend".
"""

from __future__ import annotations

import logging
import re
from typing import Any

import httpx

log = logging.getLogger(__name__)

QUERY = """
[out:json][timeout:240];
area["ISO3166-1"="NL"][admin_level=2]->.nl;
(
  nwr["shop"~"^(supermarket|convenience)$"](area.nl);
  nwr["amenity"="marketplace"](area.nl);
);
out center tags;
"""

DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]
# Vaak gebruikte Nederlandse/Engelse varianten.
DAY_ALIASES = {"ma": "Mo", "di": "Tu", "wo": "We", "do": "Th", "vr": "Fr", "za": "Sa", "zo": "Su",
               "mon": "Mo", "tue": "Tu", "wed": "We", "thu": "Th", "fri": "Fr", "sat": "Sa", "sun": "Su"}
LATE_MIN = 22 * 60  # "avondwinkel": open tot na 22:00

_TIME_RE = re.compile(r"^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$")
_DAYSEL_RE = re.compile(r"^(?:[A-Za-z]{2,3}(?:\s*-\s*[A-Za-z]{2,3})?)(?:\s*,\s*[A-Za-z]{2,3}(?:\s*-\s*[A-Za-z]{2,3})?)*$")


def _day(token: str) -> str | None:
    t = token.strip()
    if t[:2].capitalize() in DAYS and len(t) == 2:
        return t[:2].capitalize()
    return DAY_ALIASES.get(t.lower())


def _parse_days(selector: str) -> set[int] | None:
    """"Mo-Fr,Su" -> {0,1,2,3,4,6}. PH/SH (feestdagen, schoolvakantie) worden genegeerd."""
    days: set[int] = set()
    for part in selector.split(","):
        part = part.strip()
        if part in ("PH", "SH"):
            continue
        if "-" in part:
            a, b = (_day(x) for x in part.split("-", 1))
            if not a or not b:
                return None
            i, j = DAYS.index(a), DAYS.index(b)
            days.update(DAYS.index(DAYS[k % 7]) for k in range(i, i + ((j - i) % 7) + 1))
        else:
            d = _day(part)
            if not d:
                return None
            days.add(DAYS.index(d))
    return days


def _parse_times(text: str) -> list[list[int]] | None:
    ranges = []
    for part in text.split(","):
        m = _TIME_RE.match(part.strip())
        if not m:
            return None
        h1, m1, h2, m2 = map(int, m.groups())
        start, end = h1 * 60 + m1, h2 * 60 + m2
        if start > 1440 or end > 48 * 60:
            return None
        if end <= start:
            end += 1440  # tot na middernacht
        ranges.append([start, end])
    return ranges


def parse_opening_hours(value: str | None) -> list[list[list[int]] | None] | None:
    """OSM opening_hours -> weekrooster, of None als we het niet (zeker) begrijpen."""
    text = (value or "").strip()
    if not text:
        return None
    if text == "24/7":
        return [[[0, 1440]] for _ in DAYS]
    # Veelgemaakte fout: regels gescheiden door ", " in plaats van "; ".
    text = re.sub(r"(?<=\d)\s*,\s*(?=(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)\b)", "; ", text)
    week: list[list[list[int]] | None] = [None] * 7
    for rule in (r.strip() for r in text.split(";")):
        if not rule:
            continue
        m = re.match(r"^([A-Za-z]{2,3}(?:\s*[-,]\s*[A-Za-z]{2,3})*)\s+(.+)$", rule)
        if m and _DAYSEL_RE.match(m.group(1)):
            days = _parse_days(m.group(1))
            rest = m.group(2).strip()
        elif re.match(r"^\d", rule):
            days, rest = set(range(7)), rule  # geen dagen = elke dag
        elif re.fullmatch(r"(PH|SH)(\s*,\s*(PH|SH))*\s+.+", rule):
            continue  # alleen feestdagen/schoolvakanties
        else:
            return None
        if days is None:
            return None
        if not days:
            continue  # regel alleen voor feestdagen
        if rest.lower() in ("off", "closed"):
            times: list[list[int]] = []
        else:
            parsed = _parse_times(rest)
            if parsed is None:
                return None
            times = parsed
        for d in days:
            week[d] = [list(t) for t in times]  # latere regel vervangt eerdere (OSM-regel)
    if all(d is None for d in week):
        return None
    # Dagen die niet genoemd worden terwijl andere dat wel zijn, zijn in OSM gesloten.
    return [d if d is not None else [] for d in week]


def is_late(hours: list | None) -> bool:
    """Open tot na 22:00 op minstens één dag (of 24/7)."""
    return bool(hours) and any(e > LATE_MIN for day in hours if day for _, e in day)


def _address(tags: dict[str, str]) -> str:
    street = " ".join(p for p in (tags.get("addr:street"), tags.get("addr:housenumber")) if p)
    return ", ".join(p for p in (street, tags.get("addr:city")) if p)


def parse_overpass(data: dict[str, Any]) -> list[dict[str, Any]]:
    shops = []
    for el in data.get("elements", []):
        tags = el.get("tags") or {}
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        if lat is None or lon is None:
            continue
        if tags.get("amenity") == "marketplace":
            kind = "markt"
        elif tags.get("shop") == "supermarket":
            kind = "supermarkt"
        elif tags.get("shop") == "convenience":
            kind = "buurtwinkel"
        else:
            continue
        hours = parse_opening_hours(tags.get("opening_hours"))
        shops.append({
            "id": f"{el['type']}/{el['id']}",
            "kind": kind,
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "name": tags.get("name") or tags.get("brand") or {"markt": "Markt", "supermarkt": "Supermarkt",
                                                             "buurtwinkel": "Buurtwinkel"}[kind],
            "brand": tags.get("brand"),
            "address": _address(tags),
            "hours": hours,
            "hours_raw": tags.get("opening_hours"),
            "hours_source": "OpenStreetMap" if hours else None,
            "late": is_late(hours),
        })
    return shops


async def fetch_shops(client: httpx.AsyncClient, urls: list[str]) -> list[dict[str, Any]]:
    """Probeert de Overpass-servers op volgorde; de eerste die antwoordt wint."""
    last_error: Exception | None = None
    for url in urls:
        try:
            resp = await client.post(url, data={"data": QUERY}, timeout=300)
            resp.raise_for_status()
            shops = parse_overpass(resp.json())
            if shops:
                log.info("%d winkels en markten opgehaald via %s", len(shops), url)
                return shops
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("Overpass %s faalde: %s", url, exc)
            last_error = exc
    raise RuntimeError(f"Geen Overpass-server bereikbaar: {last_error}")


# --- aanvullen met openingstijden uit de statiegelddata ------------------------

def _norm(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def same_store(shop: dict[str, Any], point: dict[str, Any]) -> bool:
    """Is dit statiegeldpunt dezelfde winkel? (naam/merk komt overeen)"""
    a = _norm(point.get("name"))
    for candidate in (shop.get("brand"), shop.get("name")):
        c = _norm(candidate)
        if len(c) >= 3 and (c in a or (len(a) >= 3 and a in c)):
            return True
    return False


def link_statiegeld(shops: list[dict[str, Any]], points: list[dict[str, Any]],
                    radius_m: float = 75) -> int:
    """Koppelt winkels aan hun eigen statiegeld-inleverpunt: shop["statiegeld"] = punt-id.

    Zelfde winkel = naam/merk komt overeen en binnen `radius_m`. Elk punt hoort bij hooguit
    één winkel (de dichtstbijzijnde), zodat de kaart per winkel één icoon kan tonen.
    """
    from ..geo import haversine_m

    cell = 0.002  # ~140-220 m: buurcellen dekken ruim 75 m
    grid: dict[tuple[int, int], list[dict[str, Any]]] = {}
    for p in points:
        grid.setdefault((int(p["lat"] // cell), int(p["lon"] // cell)), []).append(p)
    candidates = []
    for shop in shops:
        shop.pop("statiegeld", None)
        if shop["kind"] == "markt":
            continue
        ci, cj = int(shop["lat"] // cell), int(shop["lon"] // cell)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for p in grid.get((ci + di, cj + dj), ()):
                    d = haversine_m(shop["lat"], shop["lon"], p["lat"], p["lon"])
                    if d <= radius_m and same_store(shop, p):
                        candidates.append((d, shop, p))
    linked_points: set = set()
    linked = 0
    for d, shop, p in sorted(candidates, key=lambda c: c[0]):
        if "statiegeld" in shop or p["id"] in linked_points:
            continue
        shop["statiegeld"] = p["id"]
        linked_points.add(p["id"])
        linked += 1
    return linked
