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
        return cur.rowcount

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

    # --- meta -------------------------------------------------------------

    def meta_get(self, key: str) -> Any:
        row = self.conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return json.loads(row["value"]) if row else None

    def meta_set(self, key: str, value: Any) -> None:
        with self.conn:
            self.conn.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, json.dumps(value))
            )
