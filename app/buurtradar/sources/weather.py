"""Weer (Buienradar) en luchtkwaliteit (Luchtmeetnet/RIVM).

- Buienradar: actuele metingen van ~38 KNMI-stations, het weerbericht en de vijfdaagse
  verwachting, in één feed. Vrij te gebruiken met bronvermelding en link naar buienradar.nl.
  De buienverwachting (2 uur, per 5 minuten) komt van een apart adres, per plek.
- Luchtmeetnet: de Luchtkwaliteitsindex (LKI, 1 = goed … 11 = zeer slecht) per meetstation,
  elk uur. Open data van RIVM en de GGD's.

Er gaat nooit een precieze locatie naar buiten: het dichtstbijzijnde station kiezen we zelf en
de buienverwachting vragen we op voor een afgerond punt (~1 km).
"""

from __future__ import annotations

import datetime as dt
import logging
import math
from typing import Any

import httpx

from ..geo import haversine_m

log = logging.getLogger(__name__)

FEED_URL = "https://data.buienradar.nl/2.0/feed/json"
RAIN_URL = "https://gpsgadget.buienradar.nl/data/raintext"
LKI_URL = "https://api.luchtmeetnet.nl/open_api/lki"
STATIONS_URL = "https://api.luchtmeetnet.nl/open_api/stations"
STATION_URL = "https://api.luchtmeetnet.nl/open_api/stations/{number}"

LKI_LABELS = [(3, "goed"), (6, "matig"), (8, "onvoldoende"), (10, "slecht"), (99, "zeer slecht")]
WIND_DIRS = ["N", "NNO", "NO", "ONO", "O", "OZO", "ZO", "ZZO", "Z", "ZZW", "ZW", "WZW", "W", "WNW", "NW", "NNW"]


def lki_label(value: float | None) -> str | None:
    if value is None:
        return None
    for limit, label in LKI_LABELS:
        if value <= limit:
            return label
    return None


def _ts(value: str | None) -> float | None:
    """Buienradar geeft lokale tijd zonder zone ("2026-10-01T01:40:00")."""
    if not value:
        return None
    try:
        from zoneinfo import ZoneInfo
        naive = dt.datetime.fromisoformat(value.replace("Z", ""))
        return naive.replace(tzinfo=ZoneInfo("Europe/Amsterdam")).timestamp()
    except ValueError:
        return None


def parse_feed(data: dict[str, Any]) -> dict[str, Any]:
    """Buienradar-feed -> stations, weerbericht en verwachting (alleen wat we tonen)."""
    stations = []
    for s in data.get("actual", {}).get("stationmeasurements", []):
        if s.get("lat") is None or s.get("lon") is None:
            continue
        stations.append({
            "id": s.get("stationid"),
            "name": (s.get("stationname") or "").replace("Meetstation ", ""),
            "lat": s["lat"], "lon": s["lon"],
            "ts": _ts(s.get("timestamp")),
            "description": s.get("weatherdescription"),
            "icon": (s.get("iconurl") or "").rsplit("/", 1)[-1].split(".")[0].lower() or None,
            "temperature": s.get("temperature"),
            "feels_like": s.get("feeltemperature"),
            "wind_bft": s.get("windspeedBft"),
            "wind_ms": s.get("windspeed"),
            "wind_dir": s.get("winddirection"),
            "gusts": s.get("windgusts"),
            "humidity": s.get("humidity"),
            "rain_last_hour": s.get("rainFallLastHour"),
            "sun": s.get("sunpower"),
            "visibility": s.get("visibility"),
        })
    fc = data.get("forecast", {})
    report = fc.get("weatherreport") or {}
    days = []
    for d in fc.get("fivedayforecast", []):
        days.append({
            "day": (d.get("day") or "")[:10],
            "min": d.get("mintemperature"), "max": d.get("maxtemperature"),
            "rain_chance": d.get("rainChance"), "sun_chance": d.get("sunChance"),
            "rain_mm": [d.get("mmRainMin"), d.get("mmRainMax")],
            "wind_bft": d.get("wind"), "wind_dir": (d.get("windDirection") or "").upper() or None,
            "description": d.get("weatherdescription"),
            "icon": (d.get("iconurl") or "").rsplit("/", 1)[-1].split(".")[0].lower() or None,
        })
    return {
        "stations": stations,
        "sunrise": _ts(data.get("actual", {}).get("sunrise")),
        "sunset": _ts(data.get("actual", {}).get("sunset")),
        "report": {"title": report.get("title"), "summary": report.get("summary"),
                   "published": _ts(report.get("published")), "url": report.get("url")},
        "shortterm": (fc.get("shortterm") or {}).get("forecast"),
        "days": days,
    }


def nearest_station(stations: list[dict[str, Any]], lat: float, lon: float) -> dict[str, Any] | None:
    """Dichtstbijzijnde station met een temperatuur (sommige kuststations meten alleen wind)."""
    best, best_d = None, math.inf
    for s in stations:
        if s.get("temperature") is None:
            continue
        d = haversine_m(lat, lon, s["lat"], s["lon"])
        if d < best_d:
            best, best_d = s, d
    return {**best, "distance_m": round(best_d)} if best else None


def parse_raintext(text: str) -> list[dict[str, Any]]:
    """"077|02:05" per regel -> [{time, mm_h}], 2 uur vooruit per 5 minuten.

    De waarde is 0–255: mm/uur = 10^((waarde − 109) / 32). 0 = droog, 77 ≈ 0,1 mm/u, 109 = 1 mm/u.
    """
    out = []
    for line in text.strip().splitlines():
        if "|" not in line:
            continue
        raw, clock = line.split("|", 1)
        try:
            value = int(raw)
        except ValueError:
            continue
        mm = 0.0 if value <= 0 else round(10 ** ((value - 109) / 32), 2)
        out.append({"time": clock.strip(), "mm_h": mm})
    return out


def rain_summary(rain: list[dict[str, Any]]) -> str:
    """"Droog de komende 2 uur", "Regen vanaf 14:25" of "Regen, droog vanaf 14:10"."""
    if not rain:
        return "Geen buienverwachting"
    wet = [r for r in rain if r["mm_h"] >= 0.1]
    if not wet:
        return "Droog de komende 2 uur"
    if rain[0]["mm_h"] >= 0.1:
        dry = next((r for r in rain if r["mm_h"] < 0.1), None)
        after = all(x["mm_h"] < 0.1 for x in rain[rain.index(dry):]) if dry else False
        if dry and after:
            return f"Regen, droog vanaf {dry['time']}"
        return "Regen de komende 2 uur" if not dry else f"Regen, even droog vanaf {dry['time']}"
    heavy = max(r["mm_h"] for r in wet)
    kind = "Zware regen" if heavy >= 5 else "Regen" if heavy >= 1 else "Lichte regen"
    return f"{kind} vanaf {wet[0]['time']}"


async def fetch_feed(client: httpx.AsyncClient, url: str = FEED_URL) -> dict[str, Any]:
    resp = await client.get(url, timeout=30)
    resp.raise_for_status()
    parsed = parse_feed(resp.json())
    if not parsed["stations"]:
        raise ValueError("Geen weerstations in de feed")
    return parsed


async def fetch_rain(client: httpx.AsyncClient, lat: float, lon: float,
                     url: str = RAIN_URL) -> list[dict[str, Any]]:
    resp = await client.get(url, params={"lat": f"{lat:.2f}", "lon": f"{lon:.2f}"}, timeout=20)
    resp.raise_for_status()
    return parse_raintext(resp.text)


async def fetch_lki(client: httpx.AsyncClient, url: str = LKI_URL) -> dict[str, dict[str, Any]]:
    """Laatste LKI per station: {nummer: {value, ts}}."""
    out: dict[str, dict[str, Any]] = {}
    for page in (1, 2):
        resp = await client.get(url, params={"page": page, "limit": 100, "order_by": "timestamp_measured",
                                             "order_direction": "desc"}, timeout=30)
        resp.raise_for_status()
        body = resp.json()
        for row in body.get("data", []):
            number = row.get("station_number")
            if number and number not in out and row.get("value") is not None:
                ts = row.get("timestamp_measured")
                try:
                    stamp = dt.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() if ts else None
                except ValueError:
                    stamp = None
                out[number] = {"value": row["value"], "ts": stamp}
        if page >= body.get("pagination", {}).get("last_page", 1):
            break
    return out


async def fetch_lki_stations(client: httpx.AsyncClient, numbers: list[str],
                             url: str = STATION_URL) -> dict[str, dict[str, Any]]:
    """Naam en coördinaten van meetstations (één keer, daarna bewaard)."""
    out = {}
    for number in numbers:
        try:
            resp = await client.get(url.format(number=number), timeout=20)
            resp.raise_for_status()
            data = resp.json().get("data", {})
            coords = (data.get("geometry") or {}).get("coordinates") or []
            if len(coords) == 2:
                out[number] = {"name": data.get("location") or number, "lat": coords[1], "lon": coords[0],
                               "municipality": data.get("municipality")}
        except (httpx.HTTPError, ValueError) as exc:
            log.debug("Meetstation %s: %s", number, exc)
    return out


def nearest_lki(stations: dict[str, dict[str, Any]], values: dict[str, dict[str, Any]],
                lat: float, lon: float, max_m: float = 25_000) -> dict[str, Any] | None:
    best, best_d = None, max_m
    for number, st in stations.items():
        v = values.get(number)
        if not v:
            continue
        d = haversine_m(lat, lon, st["lat"], st["lon"])
        if d < best_d:
            best, best_d = {**st, "number": number, **v, "label": lki_label(v["value"]), "distance_m": round(d)}, d
    return best
