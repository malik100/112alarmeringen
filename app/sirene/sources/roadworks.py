"""Wegwerkzaamheden, afsluitingen en evenementen op de weg (NDW open data, DATEX II).

Bron: de planningsfeed van NDW (https://opendata.ndw.nu), gevuld vanuit Melvin, het
landelijke platform waarin gemeenten, provincies en Rijkswaterstaat hun werkzaamheden en
verkeersmaatregelen melden. Dus ook de afsluiting van een straat in je eigen wijk.

Het bestand is groot (~17 MB ingepakt, ~210 MB XML). We lezen het met iterparse en gooien elk
verwerkt onderdeel meteen weg, zodat het geheugengebruik laag blijft.
"""

from __future__ import annotations

import datetime as dt
import gzip
import io
import logging
import re
import time
import xml.etree.ElementTree as ET
from typing import Any, BinaryIO

import httpx

log = logging.getLogger(__name__)

DEFAULT_URL = "https://opendata.ndw.nu/planningsfeed_wegwerkzaamheden_en_evenementen.xml.gz"

SIT = "{http://datex2.eu/schema/3/situation}"
COM = "{http://datex2.eu/schema/3/common}"
LOC = "{http://datex2.eu/schema/3/locationReferencing}"
NLE = "{http://datex2.eu/schema/3/nlExtensions}"
XSI_TYPE = "{http://www.w3.org/2001/XMLSchema-instance}type"

CLOSURE_TYPES = {"carriagewayClosures", "roadClosed", "closedPermanentlyForTheWinter"}
MAX_LINES = 8           # zoveel wegdelen per werk bewaren (genoeg voor de kaart)
MAX_POINTS = 60         # en zoveel punten per wegdeel
MAX_DETAILS = 3

_ID_SUFFIX_RE = re.compile(r"\s*\(\d+\)\s*$")
_BEPERKING_RE = re.compile(r"^\s*(beperking|omleiding|fase)\s*\d*\s*$", re.I)
# Omschrijvingen bevatten soms naam, e-mail of telefoon van een uitvoerder: niet tonen.
_CONTACT_RE = re.compile(r"contact|@|\b0\d{1,3}[\s-]?\d{6,8}\b|\b140\d{2}\b|telefoon|tel\.", re.I)


def _text(el: ET.Element, path: str) -> str | None:
    found = el.find(path)
    return found.text.strip() if found is not None and found.text else None


def _ts(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _source_label(source: str) -> str:
    """"Gemeente Rotterdam" blijft; codes als "MN-Z" (districten) worden Rijkswaterstaat."""
    if source.split(" ")[0] in {"Gemeente", "Provincie", "Waterschap", "Rijkswaterstaat"}:
        return source
    return "Rijkswaterstaat" if re.match(r"^[A-Z]{1,3}(-[A-Z]{1,3})+$", source) else source


def _clean(text: str) -> str:
    return " ".join(_ID_SUFFIX_RE.sub("", text).split())


def parse_situation(el: ET.Element) -> dict[str, Any] | None:
    """Eén DATEX II-situatie -> werk voor de kaart, of None zonder bruikbare locatie."""
    records = el.findall(SIT + "situationRecord")
    if not records:
        return None
    types = {(r.get(XSI_TYPE) or "").split(":")[-1] for r in records}

    note = None
    warnings: list[str] = []
    details: list[str] = []
    for c in el.iter(SIT + "generalPublicComment"):
        kind = _text(c, SIT + "commentType")
        value = _text(c, f".//{COM}value")
        if not value or _CONTACT_RE.search(value) or _BEPERKING_RE.match(value):
            continue
        value = _clean(value)
        if kind == "internalNote":
            note = note or value  # meestal "<straat> <plaats> <soort werk>"
        elif kind == "warning":
            if value not in warnings:
                warnings.append(value)
        elif value not in details and len(details) < MAX_DETAILS:
            details.append(value[:300])
    if warnings and all(w.lower().startswith("geen gevolgen") for w in warnings):
        return None  # volgens de wegbeheerder geen hinder: niet interessant
    cause = (_text(el, f".//{SIT}causeDescription//{COM}value") or "").strip(" ,")
    cause = re.sub(r"\s*,\s*", " ", cause)                      # "onderhoud van, Weg"
    cause = re.sub(r"^overige?\b\s*", "", cause, flags=re.I).strip()  # "Overig herstellen kelders"
    cause = re.sub(r"\s+\d{4,}$", "", cause)                        # "Kabels / Leidingen 735484"
    cause = cause[:1].upper() + cause[1:] if cause else None
    event_type = _text(el, f".//{SIT}publicEventType")
    if not (note or warnings or details or cause):
        return None
    details = [d for d in details if d != note]
    closed = speed = None
    for r in records:
        mtype = _text(r, SIT + "roadOrCarriagewayOrLaneManagementType")
        if mtype in CLOSURE_TYPES:
            closed = True
        limit = _text(r, f".//{SIT}temporarySpeedLimit")
        if limit:
            try:
                speed = min(speed or 999, int(float(limit)))
            except ValueError:
                pass
    closed = bool(closed) or any("dicht" in w.lower() or "afgesloten" in w.lower() for w in warnings)

    lines: list[list[list[float]]] = []
    points: list[tuple[float, float]] = []
    for pos in el.iter(LOC + "posList"):
        nums = (pos.text or "").split()
        coords = [[round(float(nums[i]), 5), round(float(nums[i + 1]), 5)]
                  for i in range(0, len(nums) - 1, 2)]
        if len(coords) > MAX_POINTS:  # uitdunnen, begin- en eindpunt houden
            step = len(coords) / (MAX_POINTS - 1)
            coords = [coords[int(i * step)] for i in range(MAX_POINTS - 1)] + [coords[-1]]
        if len(coords) >= 2 and coords not in lines and coords[::-1] not in lines:
            lines.append(coords)
    for pc in el.iter(LOC + "pointCoordinates"):
        lat, lon = _text(pc, LOC + "latitude"), _text(pc, LOC + "longitude")
        if lat and lon:
            points.append((float(lat), float(lon)))
    lines = lines[:MAX_LINES]
    if points:
        lat, lon = points[0]
    elif lines:
        mid = lines[0][len(lines[0]) // 2]
        lat, lon = mid
    else:
        return None
    if not (50.5 <= lat <= 54 and 3 <= lon <= 7.5):
        return None

    source = _source_label(_text(el, f".//{COM}sourceName//{COM}value") or "")
    start = _ts(_text(el, f".//{COM}overallStartTime"))
    end = _ts(_text(el, f".//{COM}overallEndTime"))
    return {
        "id": el.get("id"),
        "kind": "evenement" if "PublicEvent" in types else "werk",
        "note": note[:200] if note else None,
        "cause": cause,
        "event_type": event_type,
        "road": _text(el, f".//{SIT}roadOrJunctionNumber"),
        "url": _text(el, f".//{SIT}urlLink/{COM}urlLinkAddress"),  # vaak een pdf met de omleiding
        "warnings": warnings[:3],
        "details": details,
        "closed": closed,
        "detour": "ReroutingManagement" in types,
        "speed": speed if speed and speed < 999 else None,
        "source": source,
        "start": start,
        "end": end,
        "severity": _text(el, SIT + "overallSeverity"),
        "hindrance": _text(el, f".//{NLE}roadworkHindranceClass"),
        "lat": round(lat, 5),
        "lon": round(lon, 5),
        "lines": lines,
    }


def parse_feed(stream: BinaryIO, now: float | None = None,
               ahead_days: float = 30) -> list[dict[str, Any]]:
    """Alle werken die nog niet voorbij zijn en binnen `ahead_days` beginnen."""
    now = now or time.time()
    horizon = now + ahead_days * 86400
    out = []
    stack: list[ET.Element] = []  # open elementen, om de ouder van een situatie te kennen
    for event, el in ET.iterparse(stream, events=("start", "end")):
        if event == "start":
            stack.append(el)
            continue
        stack.pop()
        if el.tag != SIT + "situation":
            continue
        parent = stack[-1] if stack else None
        try:
            item = parse_situation(el)
        except (ValueError, IndexError) as exc:
            log.debug("Situatie %s overgeslagen: %s", el.get("id"), exc)
            item = None
        if item and (item["end"] is None or item["end"] >= now) and (
                item["start"] is None or item["start"] <= horizon):
            out.append(item)
        el.clear()
        if parent is not None:
            parent.remove(el)  # verwerkt: weg ermee, anders groeit het geheugen tot honderden MB
    return out


async def fetch_roadworks(client: httpx.AsyncClient, url: str = DEFAULT_URL, ahead_days: float = 14,
                          etag: str | None = None) -> tuple[list[dict[str, Any]] | None, str | None]:
    """(werken, etag). Werken is None als het bestand sinds `etag` niet veranderd is."""
    import asyncio

    headers = {"If-None-Match": etag} if etag else {}
    resp = await client.get(url, headers=headers, timeout=300)
    if resp.status_code == 304:
        return None, etag
    resp.raise_for_status()
    # Parsen duurt ~10 s: in een aparte thread, zodat de app intussen gewoon blijft reageren.
    items = await asyncio.to_thread(parse_feed, gzip.GzipFile(fileobj=io.BytesIO(resp.content)),
                                    None, ahead_days)
    if not items:
        raise ValueError("Geen wegwerkzaamheden gevonden")
    log.info("%d wegwerkzaamheden/evenementen", len(items))
    return items, resp.headers.get("ETag")


# --- relevantie en straatnaam -------------------------------------------------

def is_active(work: dict[str, Any], now: float) -> bool:
    return (work["start"] is None or work["start"] <= now) and (work["end"] is None or work["end"] >= now)


def relevance(work: dict[str, Any], distance_m: float, radius_m: float, now: float) -> float:
    """Score: hoger = belangrijker voor wie hier woont of rijdt."""
    score = 0.0
    if work["closed"]:
        score += 3
    if work["detour"]:
        score += 1
    if work["speed"]:
        score += 0.5
    if any("langzaam" in w.lower() or "voetganger" in w.lower() for w in work["warnings"]):
        score += 0.5
    if work["kind"] == "evenement":
        score += 1
    if is_active(work, now):
        score += 2
    elif work["start"] and work["start"] - now < 3 * 86400:
        score += 1  # begint binnenkort
    if work["start"] and work["end"] and work["end"] - work["start"] > 90 * 86400:
        score -= 1  # loopt al lang: dat weet je meestal wel
    score += 2 * max(0.0, 1 - distance_m / radius_m)
    return round(score, 2)


REVERSE_URL = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/reverse"


async def fetch_street(client: httpx.AsyncClient, lat: float, lon: float,
                       url: str = REVERSE_URL) -> str | None:
    """Straatnaam bij een punt van een werk (PDOK), bijv. "Lange Nieuwstraat, Utrecht"."""
    resp = await client.get(url, params={
        "lat": f"{lat:.5f}", "lon": f"{lon:.5f}", "type": "weg", "rows": 1,
        "distance": 100, "fl": "weergavenaam",
    }, timeout=15)
    resp.raise_for_status()
    docs = resp.json().get("response", {}).get("docs", [])
    return docs[0].get("weergavenaam") if docs else None
