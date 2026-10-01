"""Openbaar vervoer: haltes, vertrektijden, ritten, lijnen en voertuigen.

Leest de dienstregeling uit ov.db (zie sources/gtfs.py) en legt de actuele gegevens
(sources/gtfs_rt.py) eroverheen: verwachte tijd, vertraging, "rijdt niet" en ander spoor.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import math
import os
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

from .geo import haversine_m
from .sources.gtfs import FLAG_NO_PICKUP, SCHEMA_VERSION
from .sources.gtfs_rt import StopUpdate, TripUpdate, alert_active

log = logging.getLogger(__name__)

TZ = ZoneInfo("Europe/Amsterdam")
LOOKBACK_S = 45 * 60      # geplande vertrekken van zo lang geleden kunnen nog (te laat) komen
GONE_S = 30               # wat al zo lang weg is, tonen we niet meer
VEHICLE_MAX_AGE_S = 300   # oudere posities zijn niet meer "live"
MAX_ALERTS = 6


@dataclass
class Realtime:
    """Actuele gegevens in het geheugen (vluchtig; alleen bijgewerkt als iemand kijkt)."""
    trips: dict[tuple[str, str], TripUpdate] = field(default_factory=dict)
    vehicles: list[dict[str, Any]] = field(default_factory=list)
    alerts: list[dict[str, Any]] = field(default_factory=list)
    ts: float | None = None          # laatste geslaagde update van ritten en voertuigen
    alerts_ts: float | None = None


def day_base(day: dt.date) -> int:
    """Begin van een dienstdag: GTFS-tijden tellen vanaf "12:00 min 12 uur" (klopt ook bij
    de overgang naar zomer- of wintertijd)."""
    return int(dt.datetime(day.year, day.month, day.day, 12, tzinfo=TZ).timestamp()) - 12 * 3600


def service_days(now: float) -> list[dt.date]:
    today = dt.datetime.fromtimestamp(now, TZ).date()
    return [today - dt.timedelta(days=1), today, today + dt.timedelta(days=1)]


def _resolve_seqs(updates: list[StopUpdate], trip_stops: list[tuple[int, str, str | None]],
                  parent_of: Callable[[str], str | None]) -> list[tuple[int, StopUpdate]]:
    """(seq, update): treinupdates hebben geen volgnummer, alleen een halte(perron)."""
    by_stop = {stop_id: seq for seq, stop_id, _ in trip_stops}
    by_parent = {parent: seq for seq, _, parent in trip_stops if parent}
    out = []
    for u in updates:
        seq = u.seq
        if seq is None and u.stop_id:
            seq = by_stop.get(u.stop_id)
            if seq is None:  # ander perron van hetzelfde station
                parent = parent_of(u.stop_id)
                seq = by_parent.get(parent) if parent else None
        if seq is not None:
            out.append((seq, u))
    out.sort(key=lambda x: x[0])
    return out


def estimate(tu: TripUpdate | None, seq: int, sched_arr: int, sched_dep: int,
             resolved: list[tuple[int, StopUpdate]] | None) -> dict[str, Any]:
    """Verwachte tijd bij één halte van een rit.

    Staat de halte zelf in de update, dan die tijd; anders geldt de vertraging van de laatste
    halte ervoor (zo werkt GTFS-realtime: een vertraging "loopt door" tot de volgende update).
    """
    out: dict[str, Any] = {"realtime": False, "canceled": False, "delay": None,
                           "expected": sched_dep, "expected_arr": sched_arr, "stop_id": None}
    if tu is None:
        return out
    if tu.canceled:
        return {**out, "realtime": True, "canceled": True}
    prev: StopUpdate | None = None
    for useq, u in resolved or ():
        if useq == seq:
            if u.skipped:
                return {**out, "realtime": True, "canceled": True}
            if u.no_data:
                return out
            delay = u.delay
            dep = u.dep or u.arr or (sched_dep + delay if delay is not None else None)
            arr = u.arr or u.dep or (sched_arr + delay if delay is not None else None)
            if dep is None:
                return out
            if delay is None:
                delay = dep - sched_dep
            return {**out, "realtime": True, "delay": delay, "expected": dep, "expected_arr": arr,
                    "stop_id": u.stop_id}
        if useq < seq and not u.skipped and not u.no_data:
            prev = u
        elif useq > seq:
            break
    if prev is not None and prev.delay is not None:
        # Te vroeg rijden loopt niet door: een bus wacht bij een halte op zijn vertrektijd.
        delay = prev.delay if prev.delay > 0 else 0
        return {**out, "realtime": True, "delay": delay, "expected": sched_dep + delay,
                "expected_arr": sched_arr + delay}
    return out


class OvStore:
    """Toegang tot ov.db. Wordt na het dagelijks inlezen omgewisseld (swap)."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.conn: sqlite3.Connection | None = None
        self.info: dict[str, Any] = {}
        self._parents: dict[str, str | None] = {}
        self.open()

    def open(self) -> None:
        self.close()
        if not self.path.exists():
            return
        try:
            conn = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            info = {r["key"]: json.loads(r["value"]) for r in conn.execute("SELECT key, value FROM info")}
        except sqlite3.DatabaseError as exc:
            log.warning("ov.db onleesbaar (%s): wordt opnieuw opgebouwd", exc)
            return
        if info.get("schema") != SCHEMA_VERSION:
            conn.close()
            return
        self.conn, self.info = conn, info
        self._parents = {}

    def close(self) -> None:
        if self.conn is not None:
            self.conn.close()
        self.conn = None
        self.info = {}

    def swap(self, new_path: str | Path) -> None:
        """Nieuw ingelezen bestand in gebruik nemen (eerst sluiten: Windows staat anders
        geen vervangen van een geopend bestand toe)."""
        self.close()
        os.replace(new_path, self.path)
        self.open()

    @property
    def ready(self) -> bool:
        return self.conn is not None

    def covers(self, day: dt.date) -> bool:
        """Staat deze dag (nog) in de ingelezen dienstregeling?"""
        return self.ready and self.info.get("last_date", 0) >= int(day.strftime("%Y%m%d"))

    # --- haltes --------------------------------------------------------------

    @staticmethod
    def _halte(row: sqlite3.Row) -> dict[str, Any]:
        return {"id": row["k"], "name": row["name"], "lat": row["lat"], "lon": row["lon"],
                "modes": row["modes"].split(",") if row["modes"] else [],
                "lines": [{"line": l[0], "mode": l[1], "color": l[2], "text_color": l[3]}
                          for l in json.loads(row["lines"])]}

    def haltes_in_bbox(self, south: float, west: float, north: float, east: float,
                       limit: int = 1500) -> list[dict[str, Any]]:
        if not self.ready:
            return []
        rows = self.conn.execute(
            "SELECT * FROM haltes WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT ?",
            (south, north, west, east, limit)).fetchall()
        return [self._halte(r) for r in rows]

    def haltes_near(self, lat: float, lon: float, radius_m: float, limit: int = 8) -> list[dict[str, Any]]:
        pad_lat = radius_m / 110_540
        pad_lon = radius_m / (111_320 * max(0.2, math.cos(math.radians(lat))))
        out = []
        for h in self.haltes_in_bbox(lat - pad_lat, lon - pad_lon, lat + pad_lat, lon + pad_lon, 5000):
            d = haversine_m(lat, lon, h["lat"], h["lon"])
            if d <= radius_m:
                out.append({**h, "distance_m": round(d)})
        out.sort(key=lambda h: h["distance_m"])
        return out[:limit]

    def search_haltes(self, text: str, limit: int = 5) -> list[dict[str, Any]]:
        """Haltes op naam, bijv. "bos en lommer"; stations en grote haltes eerst."""
        if not self.ready or len(text.strip()) < 2:
            return []
        pattern = f"%{text.strip().lower()}%"
        rows = self.conn.execute(
            "SELECT * FROM haltes WHERE lower(name) LIKE ? ORDER BY length(lines) DESC LIMIT ?",
            (pattern, limit)).fetchall()
        return [self._halte(r) for r in rows]

    def halte(self, halte_id: int) -> dict[str, Any] | None:
        if not self.ready:
            return None
        row = self.conn.execute("SELECT * FROM haltes WHERE k = ?", (halte_id,)).fetchone()
        return self._halte(row) if row else None

    def parent_of(self, stop_id: str) -> str | None:
        if stop_id not in self._parents:
            row = self.conn.execute("SELECT parent FROM stops WHERE id = ?", (stop_id,)).fetchone()
            self._parents[stop_id] = row["parent"] if row else None
        return self._parents[stop_id]

    def platform_of(self, stop_id: str) -> str | None:
        row = self.conn.execute("SELECT platform FROM stops WHERE id = ?", (stop_id,)).fetchone()
        return row["platform"] if row else None

    def _trip_stops(self, trip_k: int) -> list[tuple[int, str, str | None]]:
        return [(r["seq"], r["id"], r["parent"]) for r in self.conn.execute(
            "SELECT st.seq, s.id, s.parent FROM stop_times st JOIN stops s ON s.k = st.stop "
            "WHERE st.trip = ? ORDER BY st.seq", (trip_k,))]

    def _resolved(self, tu: TripUpdate | None, trip_k: int,
                  cache: dict[int, list[tuple[int, StopUpdate]]]) -> list[tuple[int, StopUpdate]] | None:
        if tu is None or tu.canceled:
            return None
        if trip_k not in cache:
            if all(u.seq is not None for u in tu.updates):
                cache[trip_k] = sorted(((u.seq, u) for u in tu.updates), key=lambda x: x[0])
            else:
                cache[trip_k] = _resolve_seqs(tu.updates, self._trip_stops(trip_k), self.parent_of)
        return cache[trip_k]

    # --- vertrektijden ----------------------------------------------------------

    def departures(self, halte_id: int, now: float, realtime: Realtime | None = None,
                   limit: int = 30, horizon_s: int = 24 * 3600) -> list[dict[str, Any]]:
        """Vertrekken bij een halte (alle perrons), op volgorde van verwachte tijd."""
        if not self.ready:
            return []
        stops = self.conn.execute("SELECT k FROM stops WHERE halte = ?", (halte_id,)).fetchall()
        if not stops:
            return []
        keys = [r["k"] for r in stops]
        marks = ",".join("?" * len(keys))
        trips = realtime.trips if realtime else {}
        cache: dict[int, list[tuple[int, StopUpdate]]] = {}
        out = []
        for day in service_days(now):
            base = day_base(day)
            lo, hi = int(now - LOOKBACK_S - base), int(now + horizon_s - base)
            if hi < 0 or lo > 48 * 3600:
                continue
            date = int(day.strftime("%Y%m%d"))
            rows = self.conn.execute(
                f"SELECT st.trip, st.seq, st.arr, st.dep, t.id AS trip_id, t.headsign, t.short AS trip_short, "
                f"t.long AS trip_long, r.id AS route_id, r.short, r.long, r.mode, r.color, r.text_color, "
                f"r.agency, s.id AS stop_id, s.platform "
                f"FROM stop_times st JOIN trips t ON t.k = st.trip "
                f"JOIN service_dates sd ON sd.date = ? AND sd.service = t.service "
                f"JOIN routes r ON r.k = t.route JOIN stops s ON s.k = st.stop "
                f"WHERE st.stop IN ({marks}) AND st.dep BETWEEN ? AND ? AND (st.flags & ?) = 0 "
                f"ORDER BY st.dep LIMIT ?",
                (date, *keys, max(lo, 0), hi, FLAG_NO_PICKUP, limit * 3)).fetchall()
            for r in rows:
                tu = trips.get((r["trip_id"], str(date)))
                est = estimate(tu, r["seq"], base + r["arr"], base + r["dep"],
                               self._resolved(tu, r["trip"], cache))
                if est["expected"] < now - GONE_S:
                    continue
                new_platform = None
                if est["stop_id"] and est["stop_id"] != r["stop_id"]:
                    p = self.platform_of(est["stop_id"])
                    new_platform = p if p and p != r["platform"] else None
                out.append({
                    "time": base + r["dep"], "expected": est["expected"], "delay": est["delay"],
                    "realtime": est["realtime"], "canceled": est["canceled"],
                    "line": r["short"] or r["trip_long"] or "", "mode": r["mode"],
                    "color": r["color"], "text_color": r["text_color"],
                    "headsign": r["headsign"] or r["long"] or "", "product": r["trip_long"],
                    "platform": r["platform"], "new_platform": new_platform,
                    "trip": r["trip_id"], "date": str(date), "route_id": r["route_id"],
                    "agency": r["agency"],
                })
        out.sort(key=lambda d: (d["expected"], d["time"]))
        return out[:limit]

    # --- één rit ---------------------------------------------------------------

    def trip(self, trip_id: str, date: str, realtime: Realtime | None = None,
             now: float | None = None) -> dict[str, Any] | None:
        """Alle haltes van een rit met (verwachte) tijden, plus het tracé."""
        if not self.ready:
            return None
        t = self.conn.execute(
            "SELECT t.k, t.id, t.headsign, t.long AS trip_long, t.shape, r.id AS route_id, r.short, "
            "r.long, r.mode, r.color, r.text_color, r.agency FROM trips t JOIN routes r ON r.k = t.route "
            "WHERE t.id = ?", (trip_id,)).fetchone()
        if t is None:
            return None
        try:
            day = dt.date(int(date[:4]), int(date[4:6]), int(date[6:8]))
        except (ValueError, IndexError):
            return None
        base = day_base(day)
        tu = (realtime.trips if realtime else {}).get((trip_id, date))
        resolved = self._resolved(tu, t["k"], {})
        stops = []
        for r in self.conn.execute(
                "SELECT st.seq, st.arr, st.dep, st.flags, s.id, s.name, s.lat, s.lon, s.platform, s.halte "
                "FROM stop_times st JOIN stops s ON s.k = st.stop WHERE st.trip = ? ORDER BY st.seq",
                (t["k"],)):
            est = estimate(tu, r["seq"], base + r["arr"], base + r["dep"], resolved)
            stops.append({"name": r["name"], "lat": r["lat"], "lon": r["lon"], "halte": r["halte"],
                          "platform": r["platform"], "time": base + r["dep"], "arr": base + r["arr"],
                          "expected": est["expected"], "expected_arr": est["expected_arr"],
                          "delay": est["delay"], "realtime": est["realtime"],
                          "canceled": est["canceled"]})
        shape = None
        if t["shape"]:
            row = self.conn.execute("SELECT fine FROM shapes WHERE k = ?", (t["shape"],)).fetchone()
            shape = json.loads(row["fine"]) if row else None
        return {"trip": trip_id, "date": date, "line": t["short"] or t["trip_long"] or "",
                "mode": t["mode"], "color": t["color"], "text_color": t["text_color"],
                "headsign": t["headsign"] or t["long"] or "", "product": t["trip_long"],
                "agency": t["agency"], "route_id": t["route_id"],
                "canceled": bool(tu and tu.canceled), "realtime": tu is not None,
                "stops": stops, "shape": shape or [[s["lat"], s["lon"]] for s in stops]}

    # --- lijnen op de kaart -------------------------------------------------------

    def lines_in_bbox(self, south: float, west: float, north: float, east: float,
                      detailed: bool = False, modes: set[str] | None = None,
                      limit: int = 400) -> list[dict[str, Any]]:
        if not self.ready:
            return []
        column = "fine" if detailed else "coarse"
        rows = self.conn.execute(
            f"SELECT rs.route, r.id, r.short, r.long, r.mode, r.color, r.text_color, r.agency, sh.{column} AS coords "
            f"FROM route_shapes rs JOIN routes r ON r.k = rs.route JOIN shapes sh ON sh.k = rs.shape "
            f"WHERE rs.north >= ? AND rs.south <= ? AND rs.east >= ? AND rs.west <= ?",
            (south, north, west, east)).fetchall()
        routes: dict[int, dict[str, Any]] = {}
        for r in rows:
            if modes and r["mode"] not in modes:
                continue
            route = routes.get(r["route"])
            if route is None:
                if len(routes) >= limit:
                    continue
                route = routes[r["route"]] = {
                    "id": r["id"], "line": r["short"] or "", "name": r["long"] or "", "mode": r["mode"],
                    "color": r["color"], "text_color": r["text_color"], "agency": r["agency"], "paths": []}
            route["paths"].append(json.loads(r["coords"]))
        return list(routes.values())

    # --- voertuigen -----------------------------------------------------------

    def vehicles_in_bbox(self, realtime: Realtime, south: float, west: float, north: float, east: float,
                         now: float, modes: set[str] | None = None, limit: int = 1500) -> list[dict[str, Any]]:
        if not self.ready:
            return []
        inside = [v for v in realtime.vehicles
                  if south <= v["lat"] <= north and west <= v["lon"] <= east
                  and (v["ts"] is None or now - v["ts"] <= VEHICLE_MAX_AGE_S)]
        trip_ids = list({v["trip_id"] for v in inside if v["trip_id"]})
        info: dict[str, sqlite3.Row] = {}
        for i in range(0, len(trip_ids), 500):
            chunk = trip_ids[i:i + 500]
            for r in self.conn.execute(
                    f"SELECT t.id, t.headsign, t.long AS trip_long, r.short, r.long, r.mode, r.color, "
                    f"r.text_color, r.agency FROM trips t JOIN routes r ON r.k = t.route "
                    f"WHERE t.id IN ({','.join('?' * len(chunk))})", chunk):
                info[r["id"]] = r
        out = []
        for v in inside:
            r = info.get(v["trip_id"] or "")
            if r is None:
                continue  # rit niet in de dienstregeling: onbekende lijn, niet tonen
            if modes and r["mode"] not in modes:
                continue
            delay = None
            tu = realtime.trips.get((v["trip_id"], v["start_date"] or ""))
            if tu is not None and not tu.canceled:
                # Vertraging bij de laatst gepasseerde halte; nog niet vertrokken: bij de eerste.
                known = [u for u in tu.updates if u.delay is not None]
                for u in known:
                    t = u.dep or u.arr
                    if t is None or t <= now + 60:
                        delay = u.delay
                if delay is None and known:
                    delay = known[0].delay
            out.append({"id": v["id"], "lat": v["lat"], "lon": v["lon"], "bearing": v["bearing"],
                        "ts": v["ts"], "trip": v["trip_id"], "date": v["start_date"],
                        "line": r["short"] or r["trip_long"] or "", "mode": r["mode"],
                        "color": r["color"], "text_color": r["text_color"],
                        "headsign": r["headsign"] or r["long"] or "", "agency": r["agency"],
                        "delay": delay, "label": v["label"]})
            if len(out) >= limit:
                break
        return out

    # --- storingen --------------------------------------------------------------

    def alerts_for(self, realtime: Realtime, halte_id: int, route_ids: set[str],
                   now: float) -> list[dict[str, Any]]:
        """Storingen voor deze halte, of voor een lijn die hier stopt (als ze de hele lijn betreffen)."""
        if not self.ready or not realtime.alerts:
            return []
        stop_ids = {r["id"] for r in self.conn.execute("SELECT id FROM stops WHERE halte = ?", (halte_id,))}
        out, seen = [], set()
        for a in realtime.alerts:
            if not alert_active(a, now):
                continue
            here = bool(stop_ids.intersection(a["stops"]))
            line = not a["stops"] and bool(route_ids.intersection(a["routes"]))
            if not (here or line) or a["header"] in seen:
                continue
            seen.add(a["header"])
            out.append({k: a[k] for k in ("header", "description", "url", "cause", "effect")}
                       | {"scope": "halte" if here else "lijn"})
            if len(out) >= MAX_ALERTS:
                break
        return out
