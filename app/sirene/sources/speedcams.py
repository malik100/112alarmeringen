"""Vaste flitsers, roodlichtcamera's en trajectcontroles uit OpenStreetMap (Overpass API).

Data © OpenStreetMap-bijdragers, beschikbaar onder de ODbL.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

log = logging.getLogger(__name__)

QUERY = """
[out:json][timeout:180];
area["ISO3166-1"="NL"][admin_level=2]->.nl;
node["highway"="speed_camera"](area.nl);
out body;
relation["enforcement"="average_speed"](area.nl);
out body geom;
"""


def parse_overpass(data: dict[str, Any]) -> list[dict[str, Any]]:
    cams: list[dict[str, Any]] = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        if el["type"] == "node":
            if "lat" not in el or "lon" not in el:
                continue
            enforcement = tags.get("enforcement", "")
            cams.append({
                "osm_id": f"node/{el['id']}",
                "kind": "roodlicht" if "traffic_signals" in enforcement else "flitser",
                "lat": el["lat"],
                "lon": el["lon"],
                "maxspeed": tags.get("maxspeed"),
                "name": tags.get("name") or tags.get("ref"),
                "geometry": None,
            })
        elif el["type"] == "relation":
            lines = [
                [[p["lat"], p["lon"]] for p in m["geometry"]]
                for m in el.get("members", [])
                if m["type"] == "way" and m.get("role") == "section" and m.get("geometry")
            ]
            start = next((m for m in el.get("members", [])
                          if m["type"] == "node" and m.get("role") == "from" and "lat" in m), None)
            if start:
                lat, lon = start["lat"], start["lon"]
            elif lines:
                lat, lon = lines[0][0]
            elif "center" in el:
                lat, lon = el["center"]["lat"], el["center"]["lon"]
            elif "bounds" in el:
                b = el["bounds"]
                lat, lon = (b["minlat"] + b["maxlat"]) / 2, (b["minlon"] + b["maxlon"]) / 2
            else:
                continue
            cams.append({
                "osm_id": f"relation/{el['id']}",
                "kind": "traject",
                "lat": lat,
                "lon": lon,
                "maxspeed": tags.get("maxspeed"),
                "name": tags.get("name") or tags.get("ref"),
                "geometry": lines or None,
            })
    return cams


async def fetch_speedcams(client: httpx.AsyncClient, urls: list[str]) -> list[dict[str, Any]]:
    """Probeert de Overpass-servers op volgorde; de eerste die antwoordt wint."""
    last_error: Exception | None = None
    for url in urls:
        try:
            resp = await client.post(url, data={"data": QUERY}, timeout=240)
            resp.raise_for_status()
            cams = parse_overpass(resp.json())
            if cams:
                log.info("%d flitsers/trajecten opgehaald via %s", len(cams), url)
                return cams
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("Overpass %s faalde: %s", url, exc)
            last_error = exc
    raise RuntimeError(f"Geen Overpass-server bereikbaar: {last_error}")
