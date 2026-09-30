"""Actuele gegevens van het openbaar vervoer (GTFS-realtime van OVapi, elke minuut nieuw).

- tripUpdates.pb: voorspelde tijden van bus, tram, metro en veer (vertraging, rijdt niet)
- trainUpdates.pb: hetzelfde voor treinen, inclusief ander spoor
- vehiclePositions.pb: waar voertuigen nu rijden
- alerts.pb: storingen en omleidingen ("halte vervalt", "rijdt niet tot ...")

We halen dit alleen op zolang iemand de OV-laag bekijkt.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

import httpx
from google.transit import gtfs_realtime_pb2 as rt

log = logging.getLogger(__name__)

DEFAULT_URL = "https://gtfs.ovapi.nl/nl/"
TRIP_FEEDS = ("tripUpdates.pb", "trainUpdates.pb")
VEHICLE_FEED = "vehiclePositions.pb"
ALERT_FEED = "alerts.pb"

CANCELED = rt.TripDescriptor.CANCELED
SKIPPED = rt.TripUpdate.StopTimeUpdate.SKIPPED
NO_DATA = rt.TripUpdate.StopTimeUpdate.NO_DATA

CAUSES = {"MAINTENANCE": "werkzaamheden", "CONSTRUCTION": "werkzaamheden", "ACCIDENT": "ongeval",
          "STRIKE": "staking", "DEMONSTRATION": "demonstratie", "WEATHER": "weer",
          "TECHNICAL_PROBLEM": "technische storing", "POLICE_ACTIVITY": "politie-inzet",
          "MEDICAL_EMERGENCY": "medische hulp", "HOLIDAY": "feestdag"}
EFFECTS = {"NO_SERVICE": "rijdt niet", "REDUCED_SERVICE": "minder ritten", "DETOUR": "omleiding",
           "SIGNIFICANT_DELAYS": "flinke vertraging", "MODIFIED_SERVICE": "aangepaste dienst",
           "STOP_MOVED": "halte verplaatst", "ADDITIONAL_SERVICE": "extra ritten"}


@dataclass
class StopUpdate:
    seq: int | None
    stop_id: str | None
    arr: int | None = None        # voorspelde tijd (unix)
    dep: int | None = None
    arr_delay: int | None = None  # seconden
    dep_delay: int | None = None
    skipped: bool = False
    no_data: bool = False

    @property
    def delay(self) -> int | None:
        return self.dep_delay if self.dep_delay is not None else self.arr_delay


@dataclass
class TripUpdate:
    trip_id: str
    start_date: str
    canceled: bool = False
    updates: list[StopUpdate] = field(default_factory=list)


def _event(ev) -> tuple[int | None, int | None]:
    return (ev.time if ev.HasField("time") and ev.time else None,
            ev.delay if ev.HasField("delay") else None)


def parse_trip_updates(data: bytes) -> dict[tuple[str, str], TripUpdate]:
    """(trip_id, start_date) -> TripUpdate."""
    feed = rt.FeedMessage()
    feed.ParseFromString(data)
    out: dict[tuple[str, str], TripUpdate] = {}
    for entity in feed.entity:
        if not entity.HasField("trip_update"):
            continue
        tu = entity.trip_update
        trip = tu.trip
        if not trip.trip_id:
            continue
        item = TripUpdate(trip.trip_id, trip.start_date,
                          canceled=trip.schedule_relationship == CANCELED)
        for stu in tu.stop_time_update:
            arr, arr_delay = _event(stu.arrival) if stu.HasField("arrival") else (None, None)
            dep, dep_delay = _event(stu.departure) if stu.HasField("departure") else (None, None)
            item.updates.append(StopUpdate(
                seq=stu.stop_sequence if stu.HasField("stop_sequence") else None,
                stop_id=stu.stop_id or None, arr=arr, dep=dep, arr_delay=arr_delay, dep_delay=dep_delay,
                skipped=stu.schedule_relationship == SKIPPED,
                no_data=stu.schedule_relationship == NO_DATA))
        out[(item.trip_id, item.start_date)] = item
    return out


def parse_vehicles(data: bytes) -> list[dict[str, Any]]:
    feed = rt.FeedMessage()
    feed.ParseFromString(data)
    out = []
    for entity in feed.entity:
        if not entity.HasField("vehicle"):
            continue
        v = entity.vehicle
        if not v.HasField("position"):
            continue
        pos = v.position
        out.append({
            "id": entity.id,
            "trip_id": v.trip.trip_id or None,
            "start_date": v.trip.start_date or None,
            "route_id": v.trip.route_id or None,
            "lat": round(pos.latitude, 6),
            "lon": round(pos.longitude, 6),
            "bearing": round(pos.bearing) if pos.HasField("bearing") else None,
            "ts": v.timestamp or None,
            "stop_id": v.stop_id or None,
            "at_stop": v.current_status == rt.VehiclePosition.STOPPED_AT,
            "label": v.vehicle.label or None,
        })
    return out


def _text(translated) -> str | None:
    texts = {t.language or "": t.text for t in translated.translation if t.text}
    return texts.get("nl") or texts.get("") or next(iter(texts.values()), None)


def parse_alerts(data: bytes) -> list[dict[str, Any]]:
    feed = rt.FeedMessage()
    feed.ParseFromString(data)
    out = []
    for entity in feed.entity:
        if not entity.HasField("alert"):
            continue
        a = entity.alert
        header = _text(a.header_text)
        description = _text(a.description_text)
        if not header and not description:
            continue
        cause = rt.Alert.Cause.Name(a.cause) if a.HasField("cause") else None
        effect = rt.Alert.Effect.Name(a.effect) if a.HasField("effect") else None
        out.append({
            "id": entity.id,
            "header": (header or description or "").strip(),
            "description": (description or "").strip() or None,
            "url": _text(a.url) if a.HasField("url") else None,
            "cause": CAUSES.get(cause or ""),
            "effect": EFFECTS.get(effect or ""),
            "periods": [(p.start or None, p.end or None) for p in a.active_period],
            "stops": sorted({e.stop_id for e in a.informed_entity if e.stop_id}),
            "routes": sorted({e.route_id for e in a.informed_entity if e.route_id}),
            "agencies": sorted({e.agency_id for e in a.informed_entity
                                if e.agency_id and not e.stop_id and not e.route_id}),
        })
    return out


def alert_active(alert: dict[str, Any], now: float) -> bool:
    if not alert["periods"]:
        return True
    return any((start is None or start <= now) and (end is None or end >= now)
               for start, end in alert["periods"])


async def _get(client: httpx.AsyncClient, url: str) -> bytes:
    resp = await client.get(url, timeout=30)
    resp.raise_for_status()
    return resp.content


async def fetch_trip_updates(client: httpx.AsyncClient,
                             base_url: str = DEFAULT_URL) -> dict[tuple[str, str], TripUpdate]:
    """Bus/tram/metro en treinen samen. Faalt één van beide, dan de ander toch gebruiken."""
    results = await asyncio.gather(*(_get(client, base_url + name) for name in TRIP_FEEDS),
                                   return_exceptions=True)
    out: dict[tuple[str, str], TripUpdate] = {}
    errors = []
    for name, result in zip(TRIP_FEEDS, results):
        if isinstance(result, BaseException):
            errors.append(f"{name}: {result}")
            continue
        out.update(await asyncio.to_thread(parse_trip_updates, result))
    if errors and not out:
        raise httpx.HTTPError("; ".join(errors))
    for error in errors:
        log.warning("OV realtime: %s", error)
    return out


async def fetch_vehicles(client: httpx.AsyncClient, base_url: str = DEFAULT_URL) -> list[dict[str, Any]]:
    return await asyncio.to_thread(parse_vehicles, await _get(client, base_url + VEHICLE_FEED))


async def fetch_alerts(client: httpx.AsyncClient, base_url: str = DEFAULT_URL) -> list[dict[str, Any]]:
    return await asyncio.to_thread(parse_alerts, await _get(client, base_url + ALERT_FEED))
