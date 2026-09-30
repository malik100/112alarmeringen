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
    # Leeg = "Buurtradar/<versie> (self-hosted, persoonlijk gebruik)".
    "user_agent": "",
    "access": {
        # Wachtwoord voor de hele app (leeg = geen wachtwoord, prima op je thuisnetwerk).
        # Zet dit als je de server van buiten bereikbaar maakt. Ook via BUURTRADAR_PASSWORD in .env.
        "password": "",
    },
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
        "min_zoom": 13,
    },
    "news": {
        "enabled": True,
        "poll_interval_s": 300,
        # Hoe lang artikelen bewaard blijven (voor "nieuws uit de buurt").
        "keep_hours": 48,
        # Nieuws telt als "uit de buurt" als het een plaats binnen deze straal noemt.
        "local_radius_m": 5000,
        # Regionale omroepen, landelijke nieuwssites en 112-sites met een RSS-feed.
        "feeds": [
            {"name": "NOS", "url": "https://feeds.nos.nl/nosnieuwsbinnenland"},
            {"name": "NU.nl", "url": "https://www.nu.nl/rss/Binnenland"},
            {"name": "NH Nieuws", "url": "https://rss.nhnieuws.nl/rss"},
            {"name": "Rijnmond", "url": "https://www.rijnmond.nl/rss/index.xml"},
            {"name": "Omroep West", "url": "https://www.omroepwest.nl/rss/index.xml"},
            {"name": "RTV Utrecht", "url": "https://www.rtvutrecht.nl/rss/nieuws.xml"},
            {"name": "Omroep Brabant", "url": "https://www.omroepbrabant.nl/rss"},
            {"name": "Omroep Gelderland", "url": "https://www.gld.nl/rss"},
            {"name": "RTV Noord", "url": "https://www.rtvnoord.nl/rss"},
            {"name": "RTV Oost", "url": "https://www.rtvoost.nl/rss"},
            {"name": "RTV Drenthe", "url": "https://www.rtvdrenthe.nl/rss/index.xml"},
            {"name": "L1", "url": "https://www.l1.nl/rss/index.xml"},
            {"name": "Omroep Zeeland", "url": "https://www.omroepzeeland.nl/rss/index.xml"},
            {"name": "Omroep Flevoland", "url": "https://www.omroepflevoland.nl/RSS"},
            {"name": "112Brabant", "url": "https://www.112brabant.nl/feed/"},
            {"name": "112Groningen", "url": "https://www.112groningen.nl/feed/"},
            {"name": "112Ede", "url": "https://www.112ede.nl/feed/"},
        ],
    },
    "announcements": {
        # Officiële bekendmakingen van je gemeente (overheid.nl): vergunningen,
        # verkeersbesluiten, evenementen.
        "enabled": True,
        "refresh_minutes": 60,
        "days": 30,
        # Alleen bekendmakingen binnen deze straal van je locatie.
        "radius_m": 1500,
    },
    "roadworks": {
        # Wegwerkzaamheden, afsluitingen en evenementen op de weg (NDW/Melvin).
        "enabled": True,
        "url": "",  # leeg = openbare planningsfeed van NDW
        # ~17 MB per keer; ongewijzigd bestand wordt overgeslagen (ETag).
        "refresh_minutes": 120,
        "ahead_days": 14,       # ook geplande werken die binnen zoveel dagen beginnen
        "min_zoom": 12,
        "list_radius_m": 3000,
    },
    "shops": {
        "enabled": True,
        "refresh_hours": 24,
        # Pas vanaf dit zoomniveau winkels op de kaart tekenen (er zijn er ~8.000).
        "min_zoom": 13,
        # Straal voor de lijst "boodschappen in de buurt".
        "list_radius_m": 1500,
    },
    "fuel": {
        # Tankstations (OpenStreetMap), met of zonder winkel.
        "enabled": True,
        "refresh_hours": 24,
        # Pas vanaf dit zoomniveau tankstations op de kaart tekenen (er zijn er ~4.100).
        "min_zoom": 12,
        # Straal voor de lijst "tankstations in de buurt".
        "list_radius_m": 5000,
    },
    "charging": {
        "enabled": True,
        # Details (stekkers, tarieven, toegang) één keer per dag; beschikbaarheid vaker.
        "refresh_hours": 24,
        "status_interval_s": 900,
        # Pas vanaf dit zoomniveau laadpalen op de kaart tekenen (er zijn er ~79.000).
        "min_zoom": 13,
        # Straal voor de lijst "laden in de buurt".
        "list_radius_m": 3000,
    },
    "ov": {
        # Openbaar vervoer: haltes, vertrektijden, lijnen en voertuigen (OVapi, open data).
        "enabled": True,
        "gtfs_url": "",       # leeg = landelijke dienstregeling van OVapi (~250 MB, dagelijks)
        "realtime_url": "",   # leeg = actuele gegevens van OVapi
        # Eigen bestand voor de dienstregeling (~450 MB); leeg = ov.db naast de database.
        "database": "",
        "refresh_hours": 24,
        "days": 7,            # zoveel dagen vooruit inlezen
        # Actuele tijden en voertuigen: hooguit zo vaak, en alleen als iemand kijkt.
        "realtime_interval_s": 30,
        "stops_min_zoom": 15,
        "lines_min_zoom": 13,
        "vehicles_min_zoom": 13,
        "list_radius_m": 800,
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
        "ntfy": {"url": "http://ntfy", "topic": "buurtradar", "token": ""},
    },
}

# Omgevingsvariabele -> pad in de config. Handig voor geheimen via .env.
ENV_OVERRIDES: dict[str, tuple[str, ...]] = {
    "HA_URL": ("location", "homeassistant", "url"),
    "HA_TOKEN": ("location", "homeassistant", "token"),
    "HA_ENTITY_ID": ("location", "homeassistant", "entity_id"),
    "NTFY_TOKEN": ("notifications", "ntfy", "token"),
    "BUURTRADAR_PASSWORD": ("access", "password"),
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
