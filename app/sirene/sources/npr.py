"""Parkeerzones, tarieven en tijden uit het Nationaal Parkeerregister (RDW Open Data Parkeren).

Het datamodel (https://opendata.rdw.nl, "Open Data Parkeren"):

    GEOMETRIE GEBIED  vlak of punt per (gebiedsbeheerder, gebied)
    GEBIED            naam van het gebied
    GEBIED REGELING   welke regelingen gelden in een gebied, met gebruiksdoel (betaald, vergunning, ...)
    REGELING          omschrijving; type B = basisregeling, type A = aanvullend (dag-/avondkaart)
    TIJDVAK           per regeling en dag: van-tot, tariefcode en maximale parkeerduur
    TARIEFDEEL        per tariefcode: bedrag per zoveel minuten, eventueel in delen (eerste uur, ...)
    GEBRUIKSDOEL      eigen gebruiksdoelen van een gemeente met hun "bovenliggende" standaarddoel

Hieruit bouwen we per gebied één record met geometrie, soort, weekrooster en tarieven.
"""

from __future__ import annotations

import json
import logging
import re
from collections import defaultdict
from datetime import date
from typing import Any

import httpx

log = logging.getLogger(__name__)

BASE_URL = "https://opendata.rdw.nl/resource"
DATASETS = {
    "geometrie": "nsk3-v9n7",
    "gebied": "adw6-9hsg",
    "gebiedregeling": "qtex-qwd8",
    "regeling": "yefi-qfiq",
    "tijdvak": "ixf8-gtwq",
    "tariefdeel": "534e-5vdg",
    "beheerder": "2uc2-nnv3",
    "gebruiksdoel": "qidm-7mkf",
    "specificaties": "b3us-f26s",
    # Parkeerautomaten en hun plek: voor gebieden waarvan de gemeente geen kaartvlak aanlevert.
    "verkooppunt": "fk68-nf2y",
    "geo_verkooppunt": "cgqw-pfbp",
}
MAX_METERS = 400  # grote zones hebben er ruim 200 (Maastricht Brusselsepoort: 236)
ROW_LIMIT = 500_000
# Verhoog dit als de verwerking verandert: bestaande installaties halen dan direct opnieuw op
# in plaats van tot een dag lang de oude (verkeerd opgebouwde) zones te tonen.
# 2: alle vlakken van een gebied samengevoegd (daarvoor bleef er per gebied maar één over).
# 3: bezoekersregelingen zonder tarief zijn vergunningzones (geen betaalzone met onbekend tarief).
# 4: gebieden zonder kaartvlak krijgen de plekken van hun parkeerautomaten (MultiPoint).
# 5: ook bezoekerszones mét (bezoekers)tarief zijn vergunningzones, geen betaalzone voor iedereen.
PARSER_VERSION = 5

WEEKDAYS = ["MAANDAG", "DINSDAG", "WOENSDAG", "DONDERDAG", "VRIJDAG", "ZATERDAG", "ZONDAG"]

# Soort zone, afgeleid van het (bovenliggende) gebruiksdoel. Volgorde = prioriteit.
KINDS = [
    ("betaald", ("BETAALD", "BEZOEK")),
    ("blauw", ("BLAUW", "BZONE", "BLZONE")),
    ("vergunning", ("VERGUN", "BEWONER", "BEDRIJF", "ONTHEF")),
    ("garage", ("GARAGE", "TERREIN", "PARKRIDE", "TEREIN")),
]
# Deze doelen zijn geen parkeerregime voor gewone bezoekers.
SKIP_USAGE = ("ZE_", "CARPOOL", "DEELAUT", "GPK", "MILIEUZONE", "EMISSIE", "AUTOLUW")


# --- hulpfuncties -----------------------------------------------------------

def _d8(value: str | None) -> str | None:
    digits = re.sub(r"\D", "", value or "")[:8]
    return digits or None


def is_active(start: str | None, end: str | None, today: str) -> bool:
    s, e = _d8(start), _d8(end)
    return (not s or s <= today) and (not e or e > today)


def _num(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _hhmm_to_min(value: Any) -> int:
    v = int(_num(value))
    return min(1440, (v // 100) * 60 + v % 100)


def eur(amount: float) -> str:
    return f"€{amount:.2f}".replace(".", ",")


# --- geometrie ---------------------------------------------------------------

_NUMBER_PAIR = re.compile(r"(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)")


def _ring(text: str) -> list[list[float]]:
    return [[round(float(x), 6), round(float(y), 6)] for x, y in _NUMBER_PAIR.findall(text)]


def _polygons(text: str) -> list[list[list[list[float]]]]:
    """Alle polygonen in een WKT-tekst, elk als lijst ringen."""
    polygons = []
    # Een polygoon is "((ring), (ring))"; zoek groepen van ringen.
    for group in re.findall(r"\(\s*(\([^()]*\)(?:\s*,\s*\([^()]*\))*)\s*\)", text):
        rings = [_ring(r) for r in re.findall(r"\(([^()]*)\)", group)]
        rings = [r for r in rings if len(r) >= 4]
        if rings:
            polygons.append(rings)
    return polygons


def wkt_to_geojson(wkt: str) -> dict[str, Any] | None:
    wkt = (wkt or "").strip()
    kind = wkt.split("(", 1)[0].strip().upper()
    if kind == "POINT":
        pts = _ring(wkt)
        return {"type": "Point", "coordinates": pts[0]} if pts else None
    if kind in ("POLYGON", "MULTIPOLYGON", "GEOMETRYCOLLECTION"):
        polygons = _polygons(wkt)
        if not polygons:
            pts = _ring(wkt)
            return {"type": "Point", "coordinates": pts[0]} if pts else None
        if len(polygons) == 1:
            return {"type": "Polygon", "coordinates": polygons[0]}
        return {"type": "MultiPolygon", "coordinates": polygons}
    return None


def merge_geometries(geoms: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Meerdere vlakken van hetzelfde gebied -> één (Multi)Polygon, zonder dubbele vlakken.

    Sommige gemeenten (bijv. Amsterdam) registreren één tariefzone als tientallen losse
    vlakken onder dezelfde gebiedscode.
    """
    polygons: list = []
    points: list = []
    for g in geoms:
        if g["type"] == "Polygon":
            parts = [g["coordinates"]]
        elif g["type"] == "MultiPolygon":
            parts = g["coordinates"]
        elif g["type"] == "MultiPoint":
            return g if not polygons else {"type": "Polygon", "coordinates": polygons[0]}
        else:
            points.append(g)
            continue
        for poly in parts:
            if poly not in polygons:
                polygons.append(poly)
    if not polygons:
        return points[0] if points else None
    if len(polygons) == 1:
        return {"type": "Polygon", "coordinates": polygons[0]}
    return {"type": "MultiPolygon", "coordinates": polygons}


def geometry_bbox(geom: dict[str, Any]) -> tuple[float, float, float, float]:
    if geom["type"] == "Point":
        x, y = geom["coordinates"]
        return x, y, x, y
    if geom["type"] == "MultiPoint":
        xs = [p[0] for p in geom["coordinates"]]
        ys = [p[1] for p in geom["coordinates"]]
        return min(xs), min(ys), max(xs), max(ys)
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    xs = [p[0] for poly in polys for ring in poly for p in ring]
    ys = [p[1] for poly in polys for ring in poly for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


def _in_ring(x: float, y: float, ring: list[list[float]]) -> bool:
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def contains(geom: dict[str, Any], lon: float, lat: float) -> bool:
    if geom["type"] in ("Point", "MultiPoint"):
        return False
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    for rings in polys:
        if _in_ring(lon, lat, rings[0]) and not any(_in_ring(lon, lat, h) for h in rings[1:]):
            return True
    return False


# --- tarieven ----------------------------------------------------------------

def _price(amount: float, step: float) -> tuple[str, float]:
    """Tekst en uurprijs voor 'amount per step minuten'."""
    step = step or 1
    rate = amount / step * 60
    if amount == 0:
        return "gratis", 0.0
    if step <= 60:
        return f"{eur(rate)} per uur", rate
    hours = step / 60
    return f"{eur(amount)} per {hours:g} uur", rate


def _duration(minutes: float) -> str:
    return f"{minutes / 60:g} uur" if minutes % 60 == 0 else f"{minutes:g} min"


def describe_fare(parts: list[dict[str, Any]]) -> dict[str, Any]:
    """Tariefdelen van één tariefcode -> {text, rate_h}. rate_h = uurprijs van het eerste deel."""
    parts = sorted(parts, key=lambda p: _num(p.get("startdurationfarepart")))
    if not parts:
        return {"text": "tarief onbekend", "rate_h": None}
    first_amount = _num(parts[0].get("amountfarepart"))
    first_step = _num(parts[0].get("stepsizefarepart"), 1)
    first_text, first_rate = _price(first_amount, first_step)
    if len(parts) == 1:
        return {"text": first_text, "rate_h": round(first_rate, 2)}
    lines = []
    for i, p in enumerate(parts):
        start = _num(p.get("startdurationfarepart"))
        end = _num(p.get("enddurationfarepart"), 999999)
        amount, step = _num(p.get("amountfarepart")), _num(p.get("stepsizefarepart"), 1)
        if step == end - start and step > 60 and amount > 0:
            # Vast bedrag voor een blok (bijv. Amsterdam-Noord: €1,72 voor de eerste 3 uur).
            label = f"eerste {_duration(end)}" if start == 0 else f"{_duration(start)}–{_duration(end)}"
            lines.append(f"{label} samen {eur(amount)}")
            if i == 0:
                # Je betaalt het blokbedrag al voor een kwartier: dat is de eerlijkste "uurprijs".
                first_rate = amount
            continue
        text, _ = _price(amount, step)
        if i == len(parts) - 1 or end >= 999999:
            label = "daarna" if start > 0 else "altijd"
        elif start == 0:
            label = f"eerste {_duration(end)}"
        else:
            label = f"{_duration(start)}–{_duration(end)}"
        lines.append(f"{label} {text}")
    return {"text": "; ".join(lines), "rate_h": round(first_rate, 2)}


# --- opbouw ------------------------------------------------------------------

def _latest(rows: list[dict[str, Any]], start_field: str) -> list[dict[str, Any]]:
    """Alleen de rijen met de meest recente startdatum (nieuwste versie van een tarief)."""
    if not rows:
        return rows
    newest = max(_d8(r.get(start_field)) or "" for r in rows)
    return [r for r in rows if (_d8(r.get(start_field)) or "") == newest]


def classify(usages: list[str]) -> str | None:
    for kind, prefixes in KINDS:
        if any(u.startswith(prefixes) for u in usages):
            return kind
    return None


def build_zones(data: dict[str, list[dict[str, Any]]], today: date | None = None) -> list[dict[str, Any]]:
    t = (today or date.today()).strftime("%Y%m%d")

    managers = {r["areamanagerid"]: r for r in data["beheerder"]
                if is_active(r.get("startdateareamanagerid"), r.get("enddateareamanagerid"), t)}
    areas = {(r["areamanagerid"], r["areaid"]): r for r in data["gebied"]
             if is_active(r.get("startdatearea"), r.get("enddatearea"), t)}
    specs = {(r["areamanagerid"], r["areaid"]): r for r in data["specificaties"]
             if is_active(r.get("startdatespecifications"), r.get("enddatespecifications"), t)}
    usages = {(r["areamanagerid"], r["usageid"]): r for r in data["gebruiksdoel"]
              if is_active(r.get("startdateusageid"), r.get("enddateusageid"), t)}
    regulations = {(r["areamanagerid"], r["regulationid"]): r for r in data["regeling"]
                   if is_active(r.get("startdateregulation"), r.get("enddateregulation"), t)}

    def top_usage(manager: str, usage: str) -> str:
        for _ in range(6):
            row = usages.get((manager, usage))
            sup = row and row.get("superiorusageid")
            if not sup or sup == usage or sup == "PARKEREN":
                break
            manager, usage = row.get("superiorareamanagerid", manager), sup
        return usage

    def usage_desc(manager: str, usage: str) -> str:
        row = usages.get((manager, usage))
        return (row or {}).get("usageiddesc") or usage

    area_regs: dict[tuple, list[dict]] = defaultdict(list)
    for r in data["gebiedregeling"]:
        if is_active(r.get("startdatearearegulation"), r.get("enddatearearegulation"), t):
            area_regs[(r["areamanagerid"], r["areaid"])].append(r)

    frames: dict[tuple, list[dict]] = defaultdict(list)
    for r in data["tijdvak"]:
        if is_active(r.get("startdatetimeframe"), r.get("enddatetimeframe"), t):
            frames[(r["areamanagerid"], r["regulationid"])].append(r)

    fare_parts: dict[tuple, list[dict]] = defaultdict(list)
    for r in data["tariefdeel"]:
        if is_active(r.get("startdatefarepart"), r.get("enddatefarepart"), t):
            fare_parts[(r["areamanagerid"], r["farecalculationcode"])].append(r)
    fare_cache: dict[tuple, dict] = {}

    def fare(manager: str, code: str) -> dict[str, Any]:
        key = (manager, code)
        if key not in fare_cache:
            fare_cache[key] = describe_fare(_latest(fare_parts.get(key, []), "startdatefarepart"))
        return fare_cache[key]

    def schedule_for(manager: str, regulation_id: str, fares: dict) -> tuple[list, bool]:
        days: list[list[dict]] = [[] for _ in WEEKDAYS]
        special = False
        for f in frames.get((manager, regulation_id), []):
            day = f.get("daytimeframe", "")
            if day not in WEEKDAYS:
                special = True
                continue
            if f.get("claimrightpossible") == "N":
                continue  # in dit tijdvak geldt de regeling niet
            code = f.get("farecalculationcode")
            if code:
                fares[code] = fare(manager, code)
            period = {
                "s": _hhmm_to_min(f.get("starttimetimeframe")),
                "e": _hhmm_to_min(f.get("endtimetimeframe")) or 1440,
                "fare": code,
                "max": int(_num(f.get("maxdurationright"))) or None,
            }
            if period["e"] > period["s"] and period not in days[WEEKDAYS.index(day)]:
                days[WEEKDAYS.index(day)].append(period)
        for periods in days:
            periods.sort(key=lambda p: p["s"])
        return days, special

    # Alle geldende vlakken per gebied verzamelen (volgorde van eerste voorkomen behouden).
    area_geoms: dict[tuple, list[dict]] = {}
    for r in data["geometrie"]:
        if not r.get("areageometryastext") or not is_active(r.get("startdatearea"), r.get("enddatearea"), t):
            continue
        g = wkt_to_geojson(r["areageometryastext"])
        if g:
            area_geoms.setdefault((r["areamanagerid"], r["areaid"]), []).append(g)

    # Gebieden zonder kaartvlak: de parkeerautomaten laten zien waar de zone ligt.
    meter_at: dict[tuple, list[float]] = {}
    for r in data.get("geo_verkooppunt", []):
        loc = r.get("location") or {}
        coords = loc.get("coordinates") or []
        if loc.get("type") == "Point" and len(coords) == 2:
            lon, lat = float(coords[0]), float(coords[1])
            if 50.5 <= lat <= 54 and 3 <= lon <= 7.5:
                meter_at[(r["areamanagerid"], r["sellingpointid"])] = [round(lon, 6), round(lat, 6)]
    meters: dict[tuple, list[list[float]]] = defaultdict(list)
    for r in data.get("verkooppunt", []):
        key = (r["areamanagerid"], r.get("areaid"))
        point = meter_at.get((r["areamanagerid"], r.get("sellingpointid")))
        known = meters.get(key, [])
        if (point and key not in area_geoms and point not in known and len(known) < MAX_METERS
                and is_active(r.get("startdatesellingpoint"), r.get("enddatesellingpoint"), t)):
            meters[key].append(point)
    for key, points in meters.items():
        area_geoms[key] = [{"type": "MultiPoint", "coordinates": points}]

    zones = []
    seen: dict[str, dict[str, Any]] = {}
    for key, geoms in area_geoms.items():
        regs = area_regs.get(key)
        if not regs:
            continue
        manager = key[0]
        regs = [g for g in regs
                if not top_usage(manager, g["usageid"]).startswith(SKIP_USAGE)]
        tops = [top_usage(manager, g["usageid"]) for g in regs]
        kind = classify(tops)
        if not kind:
            continue
        geom = merge_geometries(geoms)
        if not geom:
            continue

        fares: dict[str, dict] = {}
        schedule: list[list[dict]] = [[] for _ in WEEKDAYS]
        extras = []
        special = False
        for g, top in zip(regs, tops):
            if classify([top]) != kind:
                continue  # bijv. een vergunningregeling binnen een betaalde zone
            reg = regulations.get((manager, g["regulationid"]), {})
            days, has_special = schedule_for(manager, g["regulationid"], fares)
            special = special or has_special
            if reg.get("regulationtype") == "A":
                if any(days):
                    extras.append({"name": reg.get("regulationdesc") or g["regulationid"],
                                   "schedule": days})
                continue
            for i, periods in enumerate(days):
                for p in periods:
                    if p not in schedule[i]:
                        schedule[i].append(p)
        for periods in schedule:
            periods.sort(key=lambda p: p["s"])

        west, south, east, north = geometry_bbox(geom)
        name = (areas.get(key) or {}).get("areadesc") or key[1]
        # Sommige gemeenten registreren dezelfde zone meerdere keren (bijv. een aparte
        # bezoekersregeling met dezelfde tijden en hetzelfde uurtarief). Voor een
        # bestuurder is dat één zone: samenvoegen, met alle omschrijvingen en extra's.
        used = {p["fare"] for day in schedule for p in day if p["fare"]}
        fingerprint = json.dumps([manager, kind, name, schedule, {c: fares[c] for c in sorted(used)},
                                  [round(v, 4) for v in (west, south, east, north)]], sort_keys=True)
        # Alleen bezoek van bewoners (bijv. Rotterdam "Sector 12", Maastricht "Centrum-West bezoek"):
        # parkeren met een bezoekersvergunning, soms tegen een lager tarief. Geen betaalzone voor
        # iedereen; zie de nabewerking hieronder.
        visitor_only = kind == "betaald" and all(
            t.startswith("BEZOEK") for t in tops if classify([t]) == "betaald")
        if fingerprint in seen:
            twin = seen[fingerprint]
            twin["_visitor_only"] = twin["_visitor_only"] and visitor_only
            twin["usages"] = sorted(set(twin["usages"]) | {usage_desc(manager, g["usageid"]) for g in regs})
            twin["fares"].update(fares)
            twin["extras"] += [x for x in extras if x not in twin["extras"]]
            twin["special_days"] = twin["special_days"] or special
            continue
        spec = specs.get(key, {})
        mgr = managers.get(manager, {})
        zones.append({
            "id": f"{manager}:{key[1]}",
            "kind": kind,
            "name": name,
            "manager": mgr.get("areamanagerdesc") or manager,
            "url": mgr.get("url"),
            "usages": sorted({usage_desc(manager, g["usageid"]) for g in regs}),
            "geometry": geom,
            "bbox": [west, south, east, north],
            "schedule": schedule,
            "fares": fares,
            "extras": extras,
            "special_days": special,
            "capacity": int(_num(spec.get("capacity"))) or None,
            "max_height_cm": int(_num(spec.get("maximumvehicleheight"))) or None,
            # Geen zonegrens bekend: de punten zijn de parkeerautomaten van deze zone.
            "approx": "automaten" if geom["type"] == "MultiPoint" else None,
            "_visitor_only": visitor_only,
        })
        seen[fingerprint] = zones[-1]
    for zone in zones:
        # Samengevoegd met een gewone betaalzone (zelfde tijden en tarief): gewoon betaald.
        if zone.pop("_visitor_only"):
            zone["kind"] = "vergunning"
    return zones


async def fetch_datasets(client: httpx.AsyncClient, today: date | None = None) -> dict[str, list]:
    t = (today or date.today()).strftime("%Y%m%d")
    data = {}
    for name, dataset in DATASETS.items():
        params = {"$limit": str(ROW_LIMIT)}
        if name == "tijdvak":  # verreweg de grootste; alleen wat nog geldt
            params["$where"] = f"enddatetimeframe > '{t}' or enddatetimeframe is null"
        resp = await client.get(f"{BASE_URL}/{dataset}.json", params=params, timeout=180)
        resp.raise_for_status()
        rows = resp.json()
        if len(rows) >= ROW_LIMIT:
            raise ValueError(f"{name}: meer dan {ROW_LIMIT} rijen, gegevens onvolledig")
        data[name] = rows
    return data


async def fetch_zones(client: httpx.AsyncClient) -> list[dict[str, Any]]:
    data = await fetch_datasets(client)
    zones = build_zones(data)
    if not zones:
        raise ValueError("Geen parkeerzones gevonden")
    log.info("%d parkeerzones opgebouwd", len(zones))
    return zones
