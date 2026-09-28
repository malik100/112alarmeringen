"""SQLite-opslag voor incidenten, geocode-cache, flitsers en losse waarden."""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS incidents (
    id          INTEGER PRIMARY KEY,
    guid        TEXT UNIQUE NOT NULL,
    ts          REAL NOT NULL,
    title       TEXT NOT NULL,
    description TEXT,
    link        TEXT,
    discipline  TEXT,
    priority    INTEGER,
    street      TEXT,
    city        TEXT,
    postcode    TEXT,
    lat         REAL,
    lon         REAL,
    precision   TEXT,
    dup_count   INTEGER NOT NULL DEFAULT 1,
    notified    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS incidents_ts ON incidents (ts);

CREATE TABLE IF NOT EXISTS geocache (
    key        TEXT PRIMARY KEY,
    lat        REAL,
    lon        REAL,
    precision  TEXT,
    label      TEXT,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS speedcams (
    osm_id   TEXT PRIMARY KEY,
    kind     TEXT NOT NULL,
    lat      REAL NOT NULL,
    lon      REAL NOT NULL,
    maxspeed TEXT,
    name     TEXT,
    geometry TEXT
);

CREATE TABLE IF NOT EXISTS statiegeld (
    id   TEXT PRIMARY KEY,
    lat  REAL NOT NULL,
    lon  REAL NOT NULL,
    data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS statiegeld_lat_lon ON statiegeld (lat, lon);

CREATE TABLE IF NOT EXISTS parking (
    id    TEXT PRIMARY KEY,
    kind  TEXT NOT NULL,
    west  REAL NOT NULL,
    south REAL NOT NULL,
    east  REAL NOT NULL,
    north REAL NOT NULL,
    data  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS parking_bbox ON parking (south, north);

CREATE TABLE IF NOT EXISTS news (
    guid    TEXT PRIMARY KEY,
    ts      REAL NOT NULL,
    source  TEXT NOT NULL,
    title   TEXT NOT NULL,
    summary TEXT,
    link    TEXT
);
CREATE INDEX IF NOT EXISTS news_ts ON news (ts);

CREATE TABLE IF NOT EXISTS incident_news (
    incident_id INTEGER NOT NULL,
    news_guid   TEXT NOT NULL,
    score       INTEGER NOT NULL,
    PRIMARY KEY (incident_id, news_guid)
);

CREATE TABLE IF NOT EXISTS charging (
    id   TEXT PRIMARY KEY,
    lat  REAL NOT NULL,
    lon  REAL NOT NULL,
    data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS charging_lat_lon ON charging (lat, lon);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

INCIDENT_COLUMNS = (
    "guid", "ts", "title", "description", "link", "discipline", "priority",
    "street", "city", "postcode", "lat", "lon", "precision",
)


class Database:
    def __init__(self, path: str) -> None:
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(SCHEMA)

    # --- incidenten -------------------------------------------------------

    def has_guid(self, guid: str) -> bool:
        return self.conn.execute(
            "SELECT 1 FROM incidents WHERE guid = ?", (guid,)
        ).fetchone() is not None

    def find_duplicate(self, title: str, ts: float, window_s: float) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM incidents WHERE title = ? AND ABS(ts - ?) <= ? ORDER BY ts DESC LIMIT 1",
            (title, ts, window_s),
        ).fetchone()

    def bump_duplicate(self, incident_id: int) -> None:
        with self.conn:
            self.conn.execute(
                "UPDATE incidents SET dup_count = dup_count + 1 WHERE id = ?", (incident_id,)
            )

    def insert_incident(self, incident: dict[str, Any]) -> int:
        values = [incident.get(col) for col in INCIDENT_COLUMNS]
        with self.conn:
            cur = self.conn.execute(
                f"INSERT INTO incidents ({', '.join(INCIDENT_COLUMNS)}) "
                f"VALUES ({', '.join('?' * len(INCIDENT_COLUMNS))})",
                values,
            )
        return cur.lastrowid

    def mark_notified(self, incident_id: int) -> None:
        with self.conn:
            self.conn.execute("UPDATE incidents SET notified = 1 WHERE id = ?", (incident_id,))

    def incidents_since(self, since_ts: float) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM incidents WHERE ts >= ? ORDER BY ts DESC", (since_ts,)
        ).fetchall()
        return [dict(r) for r in rows]

    def get_incident(self, incident_id: int) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM incidents WHERE id = ?", (incident_id,)).fetchone()
        return dict(row) if row else None

    def purge_incidents(self, older_than_ts: float) -> int:
        with self.conn:
            cur = self.conn.execute("DELETE FROM incidents WHERE ts < ?", (older_than_ts,))
            self.conn.execute("DELETE FROM news WHERE ts < ?", (older_than_ts,))
            self.conn.execute(
                "DELETE FROM incident_news WHERE incident_id NOT IN (SELECT id FROM incidents) "
                "OR news_guid NOT IN (SELECT guid FROM news)"
            )
        return cur.rowcount

    def incidents_between(self, start_ts: float, end_ts: float) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM incidents WHERE ts BETWEEN ? AND ?", (start_ts, end_ts)
        ).fetchall()
        return [dict(r) for r in rows]

    # --- nieuws -----------------------------------------------------------

    def has_news(self, guid: str) -> bool:
        return self.conn.execute("SELECT 1 FROM news WHERE guid = ?", (guid,)).fetchone() is not None

    def insert_news(self, article: dict[str, Any]) -> None:
        with self.conn:
            self.conn.execute(
                "INSERT OR IGNORE INTO news (guid, ts, source, title, summary, link) "
                "VALUES (:guid, :ts, :source, :title, :summary, :link)", article,
            )

    def news_between(self, start_ts: float, end_ts: float) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM news WHERE ts BETWEEN ? AND ?", (start_ts, end_ts)
        ).fetchall()
        return [dict(r) for r in rows]

    def link_news(self, incident_id: int, guid: str, score: int) -> bool:
        """Koppelt een artikel aan een melding; True als de koppeling nieuw is."""
        with self.conn:
            cur = self.conn.execute(
                "INSERT OR IGNORE INTO incident_news (incident_id, news_guid, score) VALUES (?, ?, ?)",
                (incident_id, guid, score),
            )
        return cur.rowcount > 0

    def news_for_incidents(self, incident_ids: list[int]) -> dict[int, list[dict[str, Any]]]:
        result: dict[int, list[dict[str, Any]]] = {}
        for start in range(0, len(incident_ids), 500):  # SQLite-limiet op parameters
            chunk = incident_ids[start:start + 500]
            rows = self.conn.execute(
                "SELECT l.incident_id, l.score, n.* FROM incident_news l "
                "JOIN news n ON n.guid = l.news_guid "
                f"WHERE l.incident_id IN ({', '.join('?' * len(chunk))}) "
                "ORDER BY l.score DESC, n.ts",
                chunk,
            ).fetchall()
            for r in rows:
                item = dict(r)
                result.setdefault(item.pop("incident_id"), []).append(item)
        return result

    # --- geocode-cache ----------------------------------------------------

    def geocache_get(self, key: str) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM geocache WHERE key = ?", (key,)).fetchone()

    def geocache_put(self, key: str, lat: float | None, lon: float | None,
                     precision: str | None, label: str | None) -> None:
        with self.conn:
            self.conn.execute(
                "INSERT OR REPLACE INTO geocache (key, lat, lon, precision, label, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (key, lat, lon, precision, label, time.time()),
            )

    # --- flitsers ---------------------------------------------------------

    def replace_speedcams(self, cams: list[dict[str, Any]]) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM speedcams")
            self.conn.executemany(
                "INSERT OR REPLACE INTO speedcams (osm_id, kind, lat, lon, maxspeed, name, geometry) "
                "VALUES (:osm_id, :kind, :lat, :lon, :maxspeed, :name, :geometry)",
                [{**c, "geometry": json.dumps(c["geometry"]) if c.get("geometry") else None}
                 for c in cams],
            )

    def speedcams(self) -> list[dict[str, Any]]:
        rows = self.conn.execute("SELECT * FROM speedcams").fetchall()
        result = []
        for r in rows:
            item = dict(r)
            item["geometry"] = json.loads(item["geometry"]) if item["geometry"] else None
            result.append(item)
        return result

    # --- statiegeld -------------------------------------------------------

    def replace_statiegeld(self, points: list[dict[str, Any]]) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM statiegeld")
            self.conn.executemany(
                "INSERT OR REPLACE INTO statiegeld (id, lat, lon, data) VALUES (?, ?, ?, ?)",
                [(p["id"], p["lat"], p["lon"], json.dumps(p, ensure_ascii=False)) for p in points],
            )

    def statiegeld_in_bbox(self, south: float, west: float, north: float, east: float,
                           limit: int) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT data FROM statiegeld WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT ?",
            (south, north, west, east, limit),
        ).fetchall()
        return [json.loads(r["data"]) for r in rows]

    def statiegeld_count(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM statiegeld").fetchone()[0]

    # --- parkeerzones -----------------------------------------------------

    def replace_parking(self, zones: list[dict[str, Any]]) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM parking")
            self.conn.executemany(
                "INSERT OR REPLACE INTO parking (id, kind, west, south, east, north, data) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                [(z["id"], z["kind"], *z["bbox"], json.dumps(z, ensure_ascii=False)) for z in zones],
            )

    def parking_in_bbox(self, south: float, west: float, north: float, east: float,
                        kinds: list[str] | None, limit: int) -> list[dict[str, Any]]:
        """Zones waarvan de omhullende rechthoek het gevraagde gebied raakt."""
        sql = "SELECT data FROM parking WHERE north >= ? AND south <= ? AND east >= ? AND west <= ?"
        params: list[Any] = [south, north, west, east]
        if kinds:
            sql += f" AND kind IN ({', '.join('?' * len(kinds))})"
            params += kinds
        rows = self.conn.execute(sql + " LIMIT ?", (*params, limit)).fetchall()
        return [json.loads(r["data"]) for r in rows]

    def parking_count(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM parking").fetchone()[0]

    # --- laadpalen ---------------------------------------------------------

    def replace_charging(self, stations: list[dict[str, Any]]) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM charging")
            self.conn.executemany(
                "INSERT OR REPLACE INTO charging (id, lat, lon, data) VALUES (?, ?, ?, ?)",
                [(s["id"], s["lat"], s["lon"], json.dumps(s, ensure_ascii=False)) for s in stations],
            )

    def charging_in_bbox(self, south: float, west: float, north: float,
                         east: float) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT data FROM charging WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
            (south, north, west, east),
        ).fetchall()
        return [json.loads(r["data"]) for r in rows]

    def charging_count(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM charging").fetchone()[0]

    # --- meta -------------------------------------------------------------

    def meta_get(self, key: str) -> Any:
        row = self.conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return json.loads(row["value"]) if row else None

    def meta_set(self, key: str, value: Any) -> None:
        with self.conn:
            self.conn.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, json.dumps(value))
            )
