"""Openbare laadpalen uit de open data van de NDW (Nationale Databank Wegverkeersgegevens).

Twee bestanden, beide elke minuut ververst door de NDW:

    charging_point_locations_ocpi.json.gz  (~18 MB)  alle details: stekkers, vermogen,
                                                      betaalmogelijkheden, toegang, openingstijden
    charging_point_locations.geojson.gz    (~5 MB)   per locatie en stekkertype: aantal vrij/totaal

plus de tarieven (charging_point_tariffs_ocpi.json.gz, OCPI-formaat).

De details halen we één keer per dag op, de beschikbaarheid vaker. De bestanden worden
in stukjes verwerkt (ijson), zodat het geheugengebruik ook op een Raspberry Pi laag blijft.
"""

from __future__ import annotations

import gzip
import io
import logging
from typing import Any, BinaryIO

import httpx
import ijson

log = logging.getLogger(__name__)

BASE_URL = "https://opendata.ndw.nu"
LOCATIONS_URL = f"{BASE_URL}/charging_point_locations_ocpi.json.gz"
TARIFFS_URL = f"{BASE_URL}/charging_point_tariffs_ocpi.json.gz"
AVAILABILITY_URL = f"{BASE_URL}/charging_point_locations.geojson.gz"

PLUGS = {
    "IEC_62196_T2": "Type 2",
    "IEC_62196_T2_COMBO": "CCS",
    "CHADEMO": "CHAdeMO",
    "IEC_62196_T1": "Type 1",
    "IEC_62196_T1_COMBO": "CCS1",
}
# Prijzen buiten dit bereik zijn invoerfouten van exploitanten (bijv. €54.974 per kWh).
MAX_KWH_PRICE = 2.0
MAX_HOUR_PRICE = 50.0


def plug_name(standard: str | None) -> str:
    return PLUGS.get(standard or "", "Overig")


def _num(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _gunzip_stream(data: bytes) -> BinaryIO:
    return gzip.GzipFile(fileobj=io.BytesIO(data))


# --- tarieven ----------------------------------------------------------------

def summarize_tariff(tariff: dict[str, Any]) -> dict[str, Any] | None:
    """OCPI-tarief -> {kwh, start, hour, parking_hour, varies}; prijzen in euro."""
    elements = tariff.get("elements") or []
    if not elements:
        return None
    # Het element zonder beperkingen is het "gewone" tarief; anders het eerste.
    main = next((e for e in elements if not e.get("restrictions")), elements[0])
    out: dict[str, Any] = {"kwh": None, "start": None, "hour": None, "parking_hour": None,
                           "varies": len(elements) > 1}
    for pc in main.get("price_components") or []:
        price = _num(pc.get("price"))
        if price is None or price < 0:
            continue
        kind = pc.get("type")
        if kind == "ENERGY" and 0 < price <= MAX_KWH_PRICE:
            out["kwh"] = round(price, 3)
        elif kind == "FLAT" and price > 0:
            out["start"] = round(price, 2)
        elif kind == "TIME" and 0 < price <= MAX_HOUR_PRICE:
            out["hour"] = round(price, 2)
        elif kind == "PARKING_TIME" and 0 < price <= MAX_HOUR_PRICE:
            out["parking_hour"] = round(price, 2)
    if not any(out[k] for k in ("kwh", "start", "hour", "parking_hour")):
        return None  # alleen nullen: vaak een lege invulling, geen echt gratis laden
    return out


def parse_tariffs(stream: BinaryIO) -> dict[str, dict[str, Any]]:
    tariffs = {}
    for tariff in ijson.items(stream, "item", use_float=True):
        summary = summarize_tariff(tariff)
        if summary and tariff.get("id"):
            tariffs[tariff["id"]] = summary
    return tariffs


# --- locaties ----------------------------------------------------------------

def station_key(location: dict[str, Any]) -> str:
    """Sleutel die ook in het beschikbaarheidsbestand (GeoJSON) wordt gebruikt."""
    return f"{location.get('country_code') or 'NL'}-{location.get('party_id')}-{location['id']}"


def parse_location(location: dict[str, Any], tariffs: dict[str, dict]) -> dict[str, Any] | None:
    if location.get("publish") is False:
        return None
    coords = location.get("coordinates") or {}
    lat, lon = _num(coords.get("latitude")), _num(coords.get("longitude"))
    if lat is None or lon is None:
        return None

    groups: dict[tuple, dict[str, Any]] = {}
    payment = {"creditcard": False, "pinpas": False}
    customers_only = ev_only = False
    evse_count = 0
    for evse in location.get("evses") or []:
        if evse.get("status") in ("REMOVED", "PLANNED"):
            continue
        evse_count += 1
        caps = set(evse.get("capabilities") or [])
        payment["creditcard"] |= "CREDIT_CARD_PAYABLE" in caps
        payment["pinpas"] |= "DEBIT_CARD_PAYABLE" in caps
        restrictions = set(evse.get("parking_restrictions") or [])
        customers_only |= "CUSTOMERS" in restrictions
        ev_only |= "EV_ONLY" in restrictions
        for c in evse.get("connectors") or []:
            plug = plug_name(c.get("standard"))
            kw = round((_num(c.get("max_electric_power")) or 0) / 1000)
            dc = c.get("power_type") == "DC"
            group = groups.setdefault((plug, kw, dc), {"plug": plug, "kw": kw or None, "dc": dc,
                                                       "count": 0, "tariff": None})
            group["count"] += 1
            if group["tariff"] is None:
                group["tariff"] = next((tariffs[t] for t in c.get("tariff_ids") or [] if t in tariffs), None)
    if not evse_count:
        return None

    opening = location.get("opening_times") or {}
    operator = (location.get("operator") or {}).get("name") or (location.get("owner") or {}).get("name")
    return {
        "id": station_key(location),
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "name": (location.get("name") or "").strip() or None,
        "address": " ".join(p for p in (location.get("address"), location.get("postal_code"),
                                        location.get("city")) if p),
        "operator": operator,
        "parking_type": location.get("parking_type"),
        "twentyfourseven": opening.get("twentyfourseven"),
        "regular_hours": opening.get("regular_hours") or None,
        "facilities": location.get("facilities") or [],
        "points": evse_count,
        "connectors": sorted(groups.values(), key=lambda g: (-(g["kw"] or 0), g["plug"])),
        "max_kw": max((g["kw"] or 0 for g in groups.values()), default=0) or None,
        "dc": any(g["dc"] for g in groups.values()),
        "payment": payment,
        "customers_only": customers_only,
        "ev_only": ev_only,
    }


def parse_locations(stream: BinaryIO, tariffs: dict[str, dict]) -> list[dict[str, Any]]:
    stations = []
    for location in ijson.items(stream, "item", use_float=True):
        station = parse_location(location, tariffs)
        if station:
            stations.append(station)
    return stations


# --- beschikbaarheid ---------------------------------------------------------

def parse_availability(stream: BinaryIO) -> dict[str, dict[str, Any]]:
    """GeoJSON -> {sleutel: {"available", "total", "plugs": {stekker: [vrij, totaal]}}}."""
    status = {}
    for feature in ijson.items(stream, "features.item", use_float=True):
        plugs: dict[str, list[int]] = {}
        for a in (feature.get("properties") or {}).get("availabilities") or []:
            counts = plugs.setdefault(plug_name(a.get("connector_type")), [0, 0])
            counts[0] += int(a.get("available") or 0)
            counts[1] += int(a.get("total") or 0)
        status[feature["id"]] = {
            "available": sum(c[0] for c in plugs.values()),
            "total": sum(c[1] for c in plugs.values()),
            "plugs": plugs,
        }
    return status


# --- ophalen -----------------------------------------------------------------

async def _download(client: httpx.AsyncClient, url: str) -> bytes:
    resp = await client.get(url, timeout=180)
    resp.raise_for_status()
    return resp.content


async def fetch_stations(client: httpx.AsyncClient) -> list[dict[str, Any]]:
    tariffs = parse_tariffs(_gunzip_stream(await _download(client, TARIFFS_URL)))
    stations = parse_locations(_gunzip_stream(await _download(client, LOCATIONS_URL)), tariffs)
    if not stations:
        raise ValueError("Geen laadlocaties gevonden")
    log.info("%d laadlocaties, %d tarieven", len(stations), len(tariffs))
    return stations


async def fetch_availability(client: httpx.AsyncClient) -> dict[str, dict[str, Any]]:
    status = parse_availability(_gunzip_stream(await _download(client, AVAILABILITY_URL)))
    if not status:
        raise ValueError("Geen beschikbaarheid gevonden")
    return status


# --- filteren (per gebruikersprofiel) ------------------------------------------

def matches(station: dict[str, Any], status: dict[str, Any] | None, *, plugs: set[str] | None = None,
            min_kw: float = 0, available: bool = False, card: bool = False,
            public: bool = False, always_open: bool = False) -> bool:
    """Past een laadlocatie bij de wensen van een gebruiker?

    Stekker en vermogen moeten op dezelfde aansluiting kloppen (een paal met Type 2 11 kW
    én CCS 150 kW telt voor "CCS ≥ 50 kW", maar niet voor "Type 2 ≥ 50 kW").
    """
    def power_ok(group: dict[str, Any]) -> bool:
        if not min_kw:
            return True
        if group["kw"] is not None:
            return group["kw"] >= min_kw
        return group["dc"] and min_kw <= 50  # DC zonder opgegeven vermogen: snellader

    suitable = [g for g in station["connectors"]
                if (not plugs or g["plug"] in plugs) and power_ok(g)]
    if not suitable:
        return False
    if card and not (station["payment"]["creditcard"] or station["payment"]["pinpas"]):
        return False
    if public and station["customers_only"]:
        return False
    if always_open and station["twentyfourseven"] is False:
        return False
    if available:
        if not status:
            return False
        wanted = {g["plug"] for g in suitable}
        if not any(status["plugs"].get(p, [0, 0])[0] > 0 for p in wanted):
            return False
    return True
