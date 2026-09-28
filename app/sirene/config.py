"""Configuratie: standaardwaarden, overschreven door config.yaml en omgevingsvariabelen."""

from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any

import yaml

DEFAULTS: dict[str, Any] = {
    "radius_m": 1000,
    "database": "/data/sirene.db",
    # Leeg = "SireneRadar/<versie> (self-hosted, persoonlijk gebruik)".
    "user_agent": "",
    "p2000": {
        "feeds": ["https://alarmeringen.nl/feeds/all.rss"],
        "poll_interval_s": 60,
        "keep_hours": 24,
        # Zelfde tekst binnen dit venster = hetzelfde incident (meerdere capcodes).
        "dedupe_window_s": 600,
    },
    "geocoder": {
        "pdok_enabled": True,
        "pdok_url": "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free",
    },
    "location": {
        "homeassistant": {
            "enabled": False,
            "url": "http://homeassistant:8123",
            "token": "",
            "entity_id": "device_tracker.telefoon",
            "poll_interval_s": 15,
        },
        # Sta toe dat de webkaart de locatie van het apparaat doorgeeft.
        "browser": True,
        # Vaste terugvallocatie (bijv. thuis) als er nog geen live locatie is.
        "fallback": {"lat": None, "lon": None},
        # Oudere locaties gelden niet meer voor meldingen.
        "max_age_min": 30,
    },
    "speedcams": {
        "enabled": True,
        "refresh_hours": 24,
        "overpass_urls": [
            "https://overpass-api.de/api/interpreter",
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
            "https://overpass.private.coffee/api/interpreter",
        ],
    },
    "statiegeld": {
        "enabled": True,
        "url": "",  # leeg = openbare kaartdienst van Statiegeld Nederland
        "refresh_hours": 24,
        # Pas vanaf dit zoomniveau punten op de kaart tekenen (er zijn er ~8700).
        "min_zoom": 12,
        # Straal voor de lijst "statiegeld in de buurt".
        "list_radius_m": 2000,
    },
    "parking": {
        "enabled": True,
        "refresh_hours": 24,
        # Pas vanaf dit zoomniveau zones op de kaart tekenen (vlakken zijn zwaar).
        "min_zoom": 14,
    },
    "map": {
        "tile_url": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        "attribution": "&copy; OpenStreetMap-bijdragers",
        "default_window_minutes": 120,
    },
    "notifications": {
        "enabled": False,
        "channel": "homeassistant",  # of "ntfy"
        "only_priority_1": True,
        # Minimale nauwkeurigheid van de geocoding: "postcode", "straat" of "plaats".
        "min_precision": "straat",
        "homeassistant_service": "notify.mobile_app_telefoon",
        "ntfy": {"url": "http://ntfy", "topic": "sirene", "token": ""},
    },
}

# Omgevingsvariabele -> pad in de config. Handig voor geheimen via .env.
ENV_OVERRIDES: dict[str, tuple[str, ...]] = {
    "HA_URL": ("location", "homeassistant", "url"),
    "HA_TOKEN": ("location", "homeassistant", "token"),
    "HA_ENTITY_ID": ("location", "homeassistant", "entity_id"),
    "NTFY_TOKEN": ("notifications", "ntfy", "token"),
    "SIRENE_DB": ("database",),
}


def _deep_merge(base: dict, override: dict) -> dict:
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
    return base


def load_config(path: str | os.PathLike | None = None) -> dict[str, Any]:
    cfg = copy.deepcopy(DEFAULTS)
    path = Path(path or os.environ.get("SIRENE_CONFIG", "/config/config.yaml"))
    if path.is_file():
        with path.open(encoding="utf-8") as fh:
            _deep_merge(cfg, yaml.safe_load(fh) or {})
    for env, keys in ENV_OVERRIDES.items():
        value = os.environ.get(env)
        if value:
            target = cfg
            for key in keys[:-1]:
                target = target[key]
            target[keys[-1]] = value
    return cfg
