"""Voorzieningen onderweg uit OpenStreetMap: AED's, openbare toiletten en drinkwaterpunten.

Data © OpenStreetMap-bijdragers, beschikbaar onder de ODbL.

Een AED die binnen hangt (bijv. in een sporthal) is alleen bereikbaar als die open is; daarom
tonen we `indoor`, de toegang en de plek ("naast de ingang, in een kast met code").
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from .shops import _address, parse_opening_hours

log = logging.getLogger(__name__)

QUERY = """
[out:json][timeout:240];
area["ISO3166-1"="NL"][admin_level=2]->.nl;
(
  nwr["emergency"="defibrillator"](area.nl);
  nwr["amenity"="toilets"](area.nl);
  nwr["amenity"="drinking_water"](area.nl);
);
out center tags;
"""

KINDS = ("aed", "toilet", "water")
ACCESS = {"yes": "openbaar", "public": "openbaar", "permissive": "openbaar", "customers": "voor klanten",
          "private": "niet openbaar", "no": "niet openbaar"}


def kind_of(tags: dict[str, str]) -> str | None:
    if tags.get("emergency") == "defibrillator":
        return "aed"
    if tags.get("amenity") == "toilets":
        return "toilet"
    if tags.get("amenity") == "drinking_water":
        return "water"
    return None


def parse_overpass(data: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for el in data.get("elements", []):
        tags = el.get("tags") or {}
        kind = kind_of(tags)
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        if kind is None or lat is None or lon is None:
            continue
        if tags.get("access") in ("private", "no") and kind != "aed":
            continue  # een privétoilet helpt niemand; een AED tonen we wel, met de beperking erbij
        hours = parse_opening_hours(tags.get("opening_hours"))
        item: dict[str, Any] = {
            "id": f"{el['type']}/{el['id']}",
            "kind": kind,
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "name": tags.get("name") or None,
            "operator": tags.get("operator") or None,
            "address": _address(tags) or None,
            "access": ACCESS.get(tags.get("access", ""), None),
            "indoor": {"yes": True, "no": False}.get(tags.get("indoor", "")),
            "hours": hours,
            "hours_raw": tags.get("opening_hours"),
            "wheelchair": tags.get("wheelchair") == "yes",
            "description": (tags.get("description") or tags.get("note") or "")[:200] or None,
        }
        if kind == "aed":
            item["location"] = (tags.get("defibrillator:location") or "")[:200] or None
            item["phone"] = tags.get("emergency:phone") or None
        elif kind == "toilet":
            item["fee"] = {"yes": True, "no": False}.get(tags.get("fee", ""))
            item["changing_table"] = tags.get("changing_table") == "yes"
            item["unisex"] = tags.get("unisex") == "yes"
        elif kind == "water":
            item["bottle"] = tags.get("bottle") == "yes"
            item["fee"] = tags.get("fee") == "yes"
        out.append(item)
    return out


async def fetch_amenities(client: httpx.AsyncClient, urls: list[str]) -> list[dict[str, Any]]:
    """Probeert de Overpass-servers op volgorde; de eerste die antwoordt wint."""
    last_error: Exception | None = None
    for url in urls:
        try:
            resp = await client.post(url, data={"data": QUERY}, timeout=300)
            resp.raise_for_status()
            items = parse_overpass(resp.json())
            if items:
                log.info("%d voorzieningen (AED, toilet, water) opgehaald via %s", len(items), url)
                return items
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("Overpass %s faalde: %s", url, exc)
            last_error = exc
    raise RuntimeError(f"Geen Overpass-server bereikbaar: {last_error}")
