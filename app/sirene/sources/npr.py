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
# 6: gebieden zonder vlak én zonder automaten: het midden van de straat uit de gebiedsnaam (Point).
# 5: ook bezoekerszones mét (bezoekers)tarief zijn vergunningzones, geen betaalzone voor iedereen.
PARSER_VERSION = 6

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


# Woorden in een gebiedsnaam die geen straatnaam zijn ("Blauwe Zone Westerstraat" -> "Westerstraat").
_DESC_NOISE_RE = re.compile(
    r"^\s*(bz|blauwe\s*zone|parkeerschijfzone|straatparke?ren|parkeerterrein|parkeerplaats|parkeerdek|"
    r"parkeergarage|winkelgebied|centrum(gebied)?|betaald\s*parkeren|zone\s*\w+\s*-)\s*[:,-]?\s*", re.I)
_DESC_TAIL_RE = re.compile(
    r"\s*(\(.*?\)|\bte\b.*|\bin\b\s+[A-Z].*|\bbij\b.*|max\.?\s*\d+.*|\d+\s*(min|uur)\b.*|"
    r"\b(ma|di|wo|do|vr|za|zo)-.*|\b(noord|zuid|oost|west|[nzow]z)(zijde)?\b.*|\b\d+e\s+uur.*|"
    r"\bbezoekers\b.*|\bvergunninghouders\b.*|\bwc\b.*)$", re.I)


def street_from_desc(desc: str) -> str | None:
    """"BZ Westerstraat" -> "Westerstraat"; "Straatparkeren Geestweg te Naaldwijk" -> "Geestweg";
    "Gebied A" -> None (geen straatnaam in te herkennen)."""
    text = (desc or "").strip()
    # Amsterdam: "T13B_U03 10c Scheldestraat" (gebiedscode, tariefcode, straat).
    text = re.sub(r"^[A-Z]\d+[A-Z]?_U\d+\s+((10c|WS|PO|[IVX]+)\s+)*", "", text)
    for _ in range(3):
        text = _DESC_NOISE_RE.sub("", text)
    text = re.split(r"[;/,]", text)[0]
    text = _DESC_TAIL_RE.sub("", text).strip(" -:.")
    text = re.sub(r"\s+[a-zA-Z]$", "", text)   # "Dr. Nolensstraat a"
    text = re.sub(r"\s+", " ", text)
    if len(text) < 4 or not re.search(r"[a-z]", text, re.I):
        return None
    # Alleen iets wat op een straat, plein, laan, kade of dijk lijkt.
    if not re.search(r"(straat|weg|laan|plein|kade|dijk|gracht|singel|markt|hof|pad|steeg|dreef|baan|"
                     r"plaats|burg|wal|dam|haven|park|strand|poort|kamp|akker|erf|veld|werf|hoek|"
                     r"stationsplein|boulevard|promenade|allee|lei)\b", text, re.I):
        return None
    if re.fullmatch(r"(zone|gebied|sector)\s*\w+", text, re.I):
        return None
    return text


def missing_areas(data: dict[str, list[dict[str, Any]]], today: date | None = None) -> list[dict[str, Any]]:
    """Gebieden met een regeling maar zonder kaartvlak of automaten: kandidaten om via de straatnaam
    op de kaart te zetten. [{manager, areaid, desc, gemeente, street}]."""
    t = (today or date.today()).strftime("%Y%m%d")
    with_geom = {(r["areamanagerid"], r["areaid"]) for r in data["geometrie"]
                 if r.get("areageometryastext") and is_active(r.get("startdatearea"), r.get("enddatearea"), t)}
    with_meter = {(r["areamanagerid"], r.get("areaid")) for r in data.get("verkooppunt", [])}
    managers = {r["areamanagerid"]: r for r in data["beheerder"]}
    areas = {(r["areamanagerid"], r["areaid"]): r for r in data["gebied"]
             if is_active(r.get("startdatearea"), r.get("enddatearea"), t)}
    usages = {(r["areamanagerid"], r["usageid"]): r for r in data["gebruiksdoel"]
              if is_active(r.get("startdateusageid"), r.get("enddateusageid"), t)}

    def top_usage(manager: str, usage: str) -> str:
        for _ in range(6):
            row = usages.get((manager, usage))
            sup = row and row.get("superiorusageid")
            if not sup or sup == usage or sup == "PARKEREN":
                break
            manager, usage = row.get("superiorareamanagerid", manager), sup
        return usage

    regs_of: dict[tuple, list[str]] = defaultdict(list)
    for r in data["gebiedregeling"]:
        if is_active(r.get("startdatearearegulation"), r.get("enddatearearegulation"), t):
            regs_of[(r["areamanagerid"], r["areaid"])].append(top_usage(r["areamanagerid"], r["usageid"]))
    out = []
    for key, tops in regs_of.items():
        if key in with_geom or key in with_meter or key not in areas:
            continue
        # Alleen wat voor iedereen geldt (betaald, blauwe zone); vergunningzones en garages
        # zonder plek laten we liggen, anders staan er honderden vage P's op de kaart.
        if classify([u for u in tops if not u.startswith(SKIP_USAGE)]) not in ("betaald", "blauw"):
            continue
        desc = areas[key].get("areadesc") or ""
        gemeente = (managers.get(key[0]) or {}).get("areamanagerdesc") or ""
        out.append({"manager": key[0], "areaid": key[1], "desc": desc, "gemeente": gemeente,
                    "street": street_from_desc(desc)})
    return out


def build_zones(data: dict[str, list[dict[str, Any]]], today: date | None = None,
                street_points: dict[tuple[str, str], dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """`street_points`: (manager, areaid) -> {"lat", "lon", "street"} voor gebieden zonder kaartvlak,
    gevonden via de straatnaam in de gebiedsnaam (zie missing_areas)."""
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
    street_of: dict[tuple, str] = {}
    for key, sp in (street_points or {}).items():
        if key not in area_geoms:
            area_geoms[key] = [{"type": "Point", "coordinates": [round(sp["lon"], 6), round(sp["lat"], 6)]}]
            street_of[key] = sp["street"]

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
            "approx": "automaten" if geom["type"] == "MultiPoint" else "straat" if key in street_of else None,
            "street": street_of.get(key),
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


STREET_URL = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free"


def _norm_street(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower().replace("dr.", "dr").replace("st.", "sint"))


async def locate_street(client: httpx.AsyncClient, street: str, gemeente: str,
                        url: str = STREET_URL) -> dict[str, Any] | None:
    """Midden van een straat in een gemeente (PDOK). None als PDOK iets anders vindt dan gevraagd."""
    resp = await client.get(url, params={"q": street, "fq": [f"gemeentenaam:\"{gemeente}\"", "type:weg"],
                                         "rows": 3, "fl": "weergavenaam,straatnaam,centroide_ll"}, timeout=15)
    resp.raise_for_status()
    wanted = _norm_street(street)
    for doc in resp.json().get("response", {}).get("docs", []):
        found = _norm_street(doc.get("straatnaam") or "")
        # Gelijk, of de gebiedsnaam heeft nog iets achter de straat ("Pollartstraat Verzorgingstehuis").
        ok = found and (found == wanted or found.endswith(wanted) or (len(found) >= 6 and wanted.startswith(found)))
        if ok and doc.get("centroide_ll"):
            lon, lat = doc["centroide_ll"].removeprefix("POINT(").removesuffix(")").split()
            return {"lat": float(lat), "lon": float(lon), "street": doc.get("weergavenaam") or street}
    return None


async def fetch_zones(client: httpx.AsyncClient,
                      street_points: dict[tuple[str, str], dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    data = await fetch_datasets(client)
    zones = build_zones(data, street_points=street_points)
    if not zones:
        raise ValueError("Geen parkeerzones gevonden")
    log.info("%d parkeerzones opgebouwd", len(zones))
    return zones
