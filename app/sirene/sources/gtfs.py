"""Dienstregeling van al het openbaar vervoer in Nederland (GTFS van OVapi).

Bron: https://gtfs.ovapi.nl/nl/gtfs-nl.zip, dagelijks nieuw, gemaakt uit de open data van het
NDOV Loket (alle vervoerders: NS, GVB, RET, HTM, Arriva, Connexxion, Qbuzz, ...).

Het bestand is groot (~250 MB ingepakt, 1,2 GB aan stoptijden). We zetten het één keer per dag
om naar een eigen SQLite-bestand (ov.db), met alleen de ritten van de komende dagen. Dat
bestand wordt eerst naast het oude opgebouwd en pas aan het eind omgewisseld, zodat de app
tijdens het inlezen gewoon de oude dienstregeling blijft gebruiken.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import json
import logging
import math
import os
import sqlite3
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable, Iterator

import httpx

log = logging.getLogger(__name__)

DEFAULT_URL = "https://gtfs.ovapi.nl/nl/gtfs-nl.zip"
# Verhoog bij een andere opbouw van ov.db: dan wordt de dienstregeling meteen opnieuw ingelezen.
SCHEMA_VERSION = 1

# route_type -> soort vervoer. Basistypen van GTFS plus de uitgebreide (Europese) typen.
MODES = {0: "tram", 1: "metro", 2: "trein", 3: "bus", 4: "veer", 5: "tram", 6: "bus", 7: "trein",
         11: "bus", 12: "trein"}
MODE_ORDER = ["trein", "metro", "tram", "bus", "veer"]

HALTE_MERGE_M = 250     # haltes met dezelfde naam binnen deze afstand vormen één halte
STATION_MAX_M = 800     # perron hoort alleen bij zijn station (parent) als het zo dichtbij ligt
SHAPE_FINE_M = 4        # vereenvoudiging van lijnen voor dichtbij ...
SHAPE_COARSE_M = 25     # ... en voor uitgezoomd
ROUTE_MAX_SHAPES = 6    # zoveel varianten per lijn op de kaart
SHAPE_NEW_SHARE = 0.15  # een variant komt erbij als minstens zo'n deel van het tracé nieuw is

FLAG_NO_PICKUP = 1      # hier kun je niet instappen (bijv. eindhalte)
FLAG_NO_DROPOFF = 2     # hier kun je niet uitstappen

SCHEMA = """
CREATE TABLE info (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE agencies (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE routes (
    k INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, agency TEXT, short TEXT, long TEXT,
    mode TEXT NOT NULL, color TEXT, text_color TEXT
);
CREATE TABLE haltes (
    k INTEGER PRIMARY KEY, name TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
    modes TEXT NOT NULL, lines TEXT NOT NULL
);
CREATE INDEX haltes_lat_lon ON haltes (lat, lon);
CREATE TABLE stops (
    k INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, lat REAL NOT NULL,
    lon REAL NOT NULL, platform TEXT, parent TEXT, halte INTEGER
);
CREATE INDEX stops_halte ON stops (halte);
CREATE TABLE service_dates (
    date INTEGER NOT NULL, service INTEGER NOT NULL, PRIMARY KEY (date, service)
) WITHOUT ROWID;
CREATE TABLE trips (
    k INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, route INTEGER NOT NULL, service INTEGER NOT NULL,
    headsign TEXT, short TEXT, long TEXT, direction INTEGER, shape INTEGER
);
CREATE TABLE stop_times (
    trip INTEGER NOT NULL, seq INTEGER NOT NULL, stop INTEGER NOT NULL, arr INTEGER, dep INTEGER,
    flags INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (trip, seq)
) WITHOUT ROWID;
CREATE TABLE shapes (k INTEGER PRIMARY KEY, fine TEXT NOT NULL, coarse TEXT NOT NULL);
CREATE TABLE route_shapes (
    route INTEGER NOT NULL, shape INTEGER NOT NULL,
    south REAL NOT NULL, west REAL NOT NULL, north REAL NOT NULL, east REAL NOT NULL,
    PRIMARY KEY (route, shape)
) WITHOUT ROWID;
"""
# Na het vullen (sneller dan bij elke insert bijhouden).
INDEXES = "CREATE INDEX stop_times_stop ON stop_times (stop, dep);"


def mode_of(route_type: str | int) -> str:
    try:
        t = int(route_type)
    except (TypeError, ValueError):
        return "bus"
    if t in MODES:
        return MODES[t]
    return {1: "trein", 4: "metro", 7: "bus", 8: "bus", 9: "tram", 10: "veer", 12: "veer"}.get(t // 100, "bus")


def parse_time(value: str) -> int | None:
    """"25:10:00" -> seconden na het begin van de dienstdag (kan voorbij middernacht gaan)."""
    if not value:
        return None
    h, m, s = value.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def short_name(name: str) -> str:
    """"Amsterdam, Bos en Lommerplein" en "Bos en Lommerplein" zijn dezelfde halte."""
    return name.split(",", 1)[-1].strip().lower()


def _metres(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    x = (lon2 - lon1) * 111_320 * math.cos(math.radians((lat1 + lat2) / 2))
    y = (lat2 - lat1) * 110_540
    return math.hypot(x, y)


def simplify(points: list[tuple[float, float]], tolerance_m: float) -> list[tuple[float, float]]:
    """Douglas-Peucker: laat punten weg die minder dan `tolerance_m` van de lijn afwijken."""
    if len(points) < 3:
        return list(points)
    lat0 = points[0][0]
    kx = 111_320 * math.cos(math.radians(lat0))
    xy = [(lon * kx, lat * 110_540) for lat, lon in points]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = xy[a]
        bx, by = xy[b]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        best, best_i = -1.0, -1
        for i in range(a + 1, b):
            px, py = xy[i]
            if length == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dy * px - dx * py + bx * ay - by * ax) / length
            if d > best:
                best, best_i = d, i
        if best > tolerance_m:
            keep[best_i] = True
            stack.append((a, best_i))
            stack.append((best_i, b))
    return [p for p, k in zip(points, keep) if k]


def _cells(points: Iterable[tuple[float, float]]) -> set[tuple[int, int]]:
    """Vakjes van ~50 m waar een lijn doorheen gaat (om varianten te vergelijken)."""
    cells = set()
    prev = None
    for lat, lon in points:
        if prev is not None:
            # Tussenpunten, zodat lange rechte stukken ook vakjes vullen.
            steps = max(1, int(_metres(prev[0], prev[1], lat, lon) / 40))
            for s in range(1, steps):
                f = s / steps
                cells.add((int((prev[0] + (lat - prev[0]) * f) * 2200),
                           int((prev[1] + (lon - prev[1]) * f) * 1350)))
        cells.add((int(lat * 2200), int(lon * 1350)))
        prev = (lat, lon)
    return cells


def cluster_haltes(stops: list[dict[str, Any]],
                   stations: dict[str, dict[str, Any]] | None = None) -> dict[str, int]:
    """stop_id -> haltenummer. Perrons van hetzelfde station (parent) en haltes met dezelfde naam
    vlak bij elkaar (aan weerszijden van de straat, of trein en bus naast elkaar) horen bij elkaar.

    `stations`: parent_station -> {lat, lon}. Een perron ver van zijn station (een verzamel-
    station als "Onbekend") wordt er niet bij gevoegd."""
    stations = stations or {}
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for s in stops:
        find(s["id"])
        station = stations.get(s["parent"] or "")
        if s["parent"] and (station is None or _metres(s["lat"], s["lon"], station["lat"],
                                                        station["lon"]) <= STATION_MAX_M):
            union(s["parent"], s["id"])
    # Zelfde naam en dichtbij: via een raster van ~250 m, alleen de buurvakjes vergelijken.
    grid: dict[tuple[str, int, int], list[dict[str, Any]]] = defaultdict(list)
    for s in stops:
        grid[(short_name(s["name"]), int(s["lat"] * 440), int(s["lon"] * 270))].append(s)
    for (name, gy, gx), members in grid.items():
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for other in grid.get((name, gy + dy, gx + dx), ()):
                    for s in members:
                        if s is not other and find(s["id"]) != find(other["id"]) and \
                                _metres(s["lat"], s["lon"], other["lat"], other["lon"]) <= HALTE_MERGE_M:
                            union(s["id"], other["id"])
    roots: dict[str, int] = {}
    out = {}
    for s in stops:
        out[s["id"]] = roots.setdefault(find(s["id"]), len(roots) + 1)
    return out


def _rows(zf: zipfile.ZipFile, name: str) -> Iterator[dict[str, str]]:
    if name not in zf.namelist():
        return iter(())
    return csv.DictReader(io.TextIOWrapper(zf.open(name), "utf-8-sig", newline=""))


def _reader(zf: zipfile.ZipFile, name: str) -> tuple[dict[str, int], Iterator[list[str]]]:
    """Snelle lezer voor grote bestanden: kolomnamen -> index, en de rijen als lijsten."""
    reader = csv.reader(io.TextIOWrapper(zf.open(name), "utf-8-sig", newline=""))
    header = next(reader)
    return {h: i for i, h in enumerate(header)}, reader


def import_gtfs(zip_path: str | Path, db_path: str | Path, today: dt.date | None = None,
                days: int = 7) -> dict[str, int]:
    """Zet de GTFS-zip om naar een nieuw SQLite-bestand op `db_path` (wordt overschreven).

    Alleen ritten die van gisteren (nachtritten) tot en met `days` dagen vooruit rijden.
    Geeft tellingen terug voor het logboek.
    """
    today = today or dt.date.today()
    first = int((today - dt.timedelta(days=1)).strftime("%Y%m%d"))
    last = int((today + dt.timedelta(days=days)).strftime("%Y%m%d"))
    db_path = Path(db_path)
    if db_path.exists():
        db_path.unlink()
    conn = sqlite3.connect(db_path)
    conn.executescript("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-65536;")
    conn.executescript(SCHEMA)
    counts: dict[str, int] = {}
    with zipfile.ZipFile(zip_path) as zf, conn:
        conn.executemany("INSERT OR REPLACE INTO agencies VALUES (?, ?)",
                         [(r["agency_id"], r["agency_name"]) for r in _rows(zf, "agency.txt")])

        # Dienstregelingsdagen: welke service_id rijdt op welke datum.
        services: dict[str, int] = {}
        dates: set[tuple[int, int]] = set()
        for r in _rows(zf, "calendar.txt"):
            start, end = int(r["start_date"]), int(r["end_date"])
            day = dt.date(start // 10000, start // 100 % 100, start % 100)
            sid = services.setdefault(r["service_id"], len(services) + 1)
            names = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
            while int(day.strftime("%Y%m%d")) <= min(end, last):
                d = int(day.strftime("%Y%m%d"))
                if d >= first and r[names[day.weekday()]] == "1":
                    dates.add((d, sid))
                day += dt.timedelta(days=1)
        for r in _rows(zf, "calendar_dates.txt"):
            d = int(r["date"])
            if not first <= d <= last:
                continue
            sid = services.setdefault(r["service_id"], len(services) + 1)
            if r["exception_type"] == "1":
                dates.add((d, sid))
            else:
                dates.discard((d, sid))
        conn.executemany("INSERT INTO service_dates VALUES (?, ?)", sorted(dates))
        active = {sid for _, sid in dates}

        routes: dict[str, int] = {}
        route_mode: dict[int, str] = {}
        rows = []
        for r in _rows(zf, "routes.txt"):
            k = routes.setdefault(r["route_id"], len(routes) + 1)
            mode = mode_of(r.get("route_type"))
            route_mode[k] = mode
            rows.append((k, r["route_id"], r.get("agency_id"), r.get("route_short_name") or None,
                         r.get("route_long_name") or None, mode,
                         (r.get("route_color") or "").lower() or None,
                         (r.get("route_text_color") or "").lower() or None))
        conn.executemany("INSERT INTO routes VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)

        # Ritten: alleen die in de komende dagen rijden.
        trips: dict[str, int] = {}
        trip_route: dict[int, int] = {}
        shapes: dict[str, int] = {}
        shape_use: Counter[tuple[int, int]] = Counter()   # (route, shape) -> aantal ritten
        cols, reader = _reader(zf, "trips.txt")
        c = {name: cols.get(name) for name in ("route_id", "service_id", "trip_id", "trip_headsign",
                                               "trip_short_name", "trip_long_name", "direction_id",
                                               "shape_id")}

        def col(row: list[str], name: str) -> str:
            i = c[name]
            return row[i] if i is not None and i < len(row) else ""

        batch = []
        for row in reader:
            sid = services.get(col(row, "service_id"))
            route = routes.get(col(row, "route_id"))
            if sid not in active or route is None:
                continue
            k = len(trips) + 1
            trips[col(row, "trip_id")] = k
            trip_route[k] = route
            shape = None
            if col(row, "shape_id"):
                shape = shapes.setdefault(col(row, "shape_id"), len(shapes) + 1)
                shape_use[(route, shape)] += 1
            direction = col(row, "direction_id")
            batch.append((k, col(row, "trip_id"), route, sid, col(row, "trip_headsign") or None,
                          col(row, "trip_short_name") or None, col(row, "trip_long_name") or None,
                          int(direction) if direction.isdigit() else None, shape))
            if len(batch) >= 50_000:
                conn.executemany("INSERT INTO trips VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", batch)
                batch = []
        conn.executemany("INSERT INTO trips VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", batch)
        counts["trips"] = len(trips)

        stops_raw = []
        stations: dict[str, dict[str, Any]] = {}
        for r in _rows(zf, "stops.txt"):
            try:
                lat, lon = float(r["stop_lat"]), float(r["stop_lon"])
            except (KeyError, ValueError):
                continue
            if r.get("location_type") not in ("", "0", None):
                # Station (stoparea) zelf: de perrons eronder zijn de haltes; de naam gebruiken we.
                stations[r["stop_id"]] = {"name": r["stop_name"], "lat": lat, "lon": lon}
                continue
            stops_raw.append({"id": r["stop_id"], "name": r["stop_name"], "lat": lat, "lon": lon,
                              "platform": r.get("platform_code") or None,
                              "parent": r.get("parent_station") or None})
        stop_k = {s["id"]: i + 1 for i, s in enumerate(stops_raw)}

        # Stoptijden: het grote bestand (~20 miljoen regels). Alleen van de bewaarde ritten.
        cols, reader = _reader(zf, "stop_times.txt")
        i_trip, i_seq, i_stop = cols["trip_id"], cols["stop_sequence"], cols["stop_id"]
        i_arr, i_dep = cols["arrival_time"], cols["departure_time"]
        i_pick, i_drop = cols.get("pickup_type"), cols.get("drop_off_type")
        stop_routes: set[tuple[int, int]] = set()   # (halte, lijn) waar je kunt instappen
        used_stops: set[int] = set()
        batch = []
        n = 0
        for row in reader:
            trip = trips.get(row[i_trip])
            if trip is None:
                continue
            stop = stop_k.get(row[i_stop])
            if stop is None:
                continue
            flags = 0
            if i_pick is not None and row[i_pick] == "1":
                flags |= FLAG_NO_PICKUP
            if i_drop is not None and row[i_drop] == "1":
                flags |= FLAG_NO_DROPOFF
            arr = parse_time(row[i_arr])
            dep = parse_time(row[i_dep])
            batch.append((trip, int(row[i_seq]), stop, arr if arr is not None else dep,
                          dep if dep is not None else arr, flags))
            used_stops.add(stop)
            if not flags & FLAG_NO_PICKUP:
                stop_routes.add((stop, trip_route[trip]))
            if len(batch) >= 100_000:
                conn.executemany("INSERT OR REPLACE INTO stop_times VALUES (?, ?, ?, ?, ?, ?)", batch)
                n += len(batch)
                batch = []
        conn.executemany("INSERT OR REPLACE INTO stop_times VALUES (?, ?, ?, ?, ?, ?)", batch)
        counts["stop_times"] = n + len(batch)
        del trips

        # Haltes: alleen die in de komende dagen bediend worden (ook eindhaltes), plus de andere
        # perrons van zo'n station: een trein kan daar bij een spoorwijziging alsnog stoppen.
        used_parents = {s["parent"] for s in stops_raw if s["parent"] and stop_k[s["id"]] in used_stops}
        stops_raw = [s for s in stops_raw if stop_k[s["id"]] in used_stops or s["parent"] in used_parents]
        halte_of = cluster_haltes(stops_raw, stations)
        conn.executemany("INSERT INTO stops VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
            (stop_k[s["id"]], s["id"], s["name"], s["lat"], s["lon"], s["platform"], s["parent"],
             halte_of[s["id"]]) for s in stops_raw])
        _fill_haltes(conn, stops_raw, stop_k, halte_of, stop_routes, stations)
        counts["stops"] = len(stops_raw)
        counts["haltes"] = len(set(halte_of.values()))

        counts["shapes"] = _fill_shapes(conn, zf, shapes, shape_use)
        conn.executescript(INDEXES)
        feed = next(iter(_rows(zf, "feed_info.txt")), {})
        info = {"schema": SCHEMA_VERSION, "first_date": first, "last_date": last,
                "feed_version": feed.get("feed_version"), "feed_end_date": feed.get("feed_end_date"),
                "imported": dt.datetime.now().isoformat(timespec="seconds"), **counts}
        conn.executemany("INSERT INTO info VALUES (?, ?)", [(k, json.dumps(v)) for k, v in info.items()])
    conn.execute("ANALYZE")
    conn.close()
    return counts


def _fill_haltes(conn: sqlite3.Connection, stops: list[dict[str, Any]], stop_k: dict[str, int],
                 halte_of: dict[str, int], stop_routes: set[tuple[int, int]],
                 stations: dict[str, dict[str, Any]] | None = None) -> None:
    stations = stations or {}
    routes = {r[0]: r for r in conn.execute("SELECT k, short, mode, color, text_color, long FROM routes")}
    halte_routes: dict[int, set[int]] = defaultdict(set)
    k_to_halte = {stop_k[s["id"]]: halte_of[s["id"]] for s in stops}
    for stop, route in stop_routes:
        if stop in k_to_halte:
            halte_routes[k_to_halte[stop]].add(route)
    members: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for s in stops:
        members[halte_of[s["id"]]].append(s)
    rows = []
    for halte, group in members.items():
        # De naam van het station ("Leeuwarden, Busstation") is beter dan die van een perron
        # ("Leeuwarden, Busstation (Perron A)"); liefst een naam met plaats erin.
        names = Counter(stations[s["parent"]]["name"] for s in group
                        if s["parent"] in stations and stations[s["parent"]]["name"] != "Onbekend")
        if not names:
            names = Counter(s["name"] for s in group)
        name = max(names, key=lambda n: ("," in n, names[n], len(n)))
        lat = sum(s["lat"] for s in group) / len(group)
        lon = sum(s["lon"] for s in group) / len(group)
        lines = {}
        for route in halte_routes.get(halte, ()):
            _, short, mode, color, text_color, long = routes[route]
            label = short or (long or "")[:12]
            lines.setdefault((mode, label), [label, mode, color, text_color])
        ordered = sorted(lines.values(), key=lambda l: (MODE_ORDER.index(l[1]) if l[1] in MODE_ORDER else 9,
                                                       _line_sort(l[0])))
        modes = [m for m in MODE_ORDER if any(l[1] == m for l in ordered)]
        rows.append((halte, name, round(lat, 6), round(lon, 6), ",".join(modes),
                     json.dumps(ordered, ensure_ascii=False)))
    conn.executemany("INSERT INTO haltes VALUES (?, ?, ?, ?, ?, ?)", rows)


def _line_sort(label: str) -> tuple[int, str]:
    digits = "".join(ch for ch in label if ch.isdigit())
    return (int(digits) if digits and label[:1].isdigit() else 10_000, label)


def _fill_shapes(conn: sqlite3.Connection, zf: zipfile.ZipFile, shapes: dict[str, int],
                 shape_use: Counter[tuple[int, int]]) -> int:
    """Tracés van de gebruikte ritten, vereenvoudigd, plus per lijn de belangrijkste varianten."""
    if "shapes.txt" not in zf.namelist():
        return 0
    cols, reader = _reader(zf, "shapes.txt")
    i_id, i_seq = cols["shape_id"], cols["shape_pt_sequence"]
    i_lat, i_lon = cols["shape_pt_lat"], cols["shape_pt_lon"]
    stored: dict[int, list[tuple[float, float]]] = {}   # vereenvoudigd (grof), voor de keuze
    bbox: dict[int, tuple[float, float, float, float]] = {}
    current: str | None = None
    points: list[tuple[int, float, float]] = []
    pending: dict[str, list[tuple[int, float, float]]] = {}

    def flush(shape_id: str | None, pts: list[tuple[int, float, float]]) -> None:
        if shape_id is None or shape_id not in shapes or len(pts) < 2:
            return
        pts.sort()
        line = [(round(lat, 5), round(lon, 5)) for _, lat, lon in pts]
        fine = simplify(line, SHAPE_FINE_M)
        coarse = simplify(fine, SHAPE_COARSE_M)
        k = shapes[shape_id]
        conn.execute("INSERT OR REPLACE INTO shapes VALUES (?, ?, ?)",
                     (k, json.dumps(fine, separators=(",", ":")), json.dumps(coarse, separators=(",", ":"))))
        stored[k] = coarse
        lats = [p[0] for p in fine]
        lons = [p[1] for p in fine]
        bbox[k] = (min(lats), min(lons), max(lats), max(lons))

    for row in reader:
        sid = row[i_id]
        if sid != current:
            if current is not None:
                if current in pending:  # niet aaneengesloten: samenvoegen
                    pending[current].extend(points)
                else:
                    pending[current] = points
                flush(current, pending.pop(current))
            current = sid
            points = pending.pop(sid, []) if sid in pending else []
        if sid in shapes:
            points.append((int(row[i_seq]), float(row[i_lat]), float(row[i_lon])))
    flush(current, points)

    # Per lijn: de meest gereden varianten die samen het hele tracé dekken.
    per_route: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for (route, shape), n in shape_use.items():
        if shape in stored:
            per_route[route].append((n, shape))
    rows = []
    for route, options in per_route.items():
        covered: set[tuple[int, int]] = set()
        chosen = 0
        for _, shape in sorted(options, reverse=True):
            cells = _cells(stored[shape])
            if covered and len(cells - covered) < SHAPE_NEW_SHARE * len(cells):
                continue
            covered |= cells
            rows.append((route, shape, *bbox[shape]))
            chosen += 1
            if chosen >= ROUTE_MAX_SHAPES:
                break
    conn.executemany("INSERT INTO route_shapes VALUES (?, ?, ?, ?, ?, ?)", rows)
    return len(stored)


async def download_gtfs(client: httpx.AsyncClient, dest: str | Path, url: str = DEFAULT_URL,
                        etag: str | None = None) -> tuple[bool, str | None]:
    """Downloadt de zip naar `dest` (in stukjes, niet in het geheugen). (nieuw bestand?, etag)."""
    dest = Path(dest)
    part = dest.with_suffix(dest.suffix + ".part")
    headers = {"If-None-Match": etag} if etag and dest.exists() else {}
    async with client.stream("GET", url, headers=headers, timeout=httpx.Timeout(60, read=300)) as resp:
        if resp.status_code == 304:
            return False, etag
        resp.raise_for_status()
        with open(part, "wb") as fh:
            async for chunk in resp.aiter_bytes(1 << 20):
                fh.write(chunk)
        new_etag = resp.headers.get("ETag")
    if not zipfile.is_zipfile(part):
        part.unlink(missing_ok=True)
        raise ValueError("Download van de dienstregeling is geen geldig zip-bestand")
    os.replace(part, dest)
    return True, new_etag
