"""Afvalkalender via een agenda-link (iCal) van je eigen gemeente of inzamelaar.

Er is geen landelijke open bron voor ophaaldagen. Vrijwel elke gemeente of inzamelaar
(Afvalwijzer, ROVA, Cyclus, Meerlanden, Dar, HVC, de gemeente Amsterdam, …) biedt op zijn
afvalkalender-site wel een knop "Agenda" of "iCal" waarmee je je eigen ophaaldagen als
agenda-link krijgt. Die link plak je in Buurtradar; wij lezen hem één keer per dag.
"""

from __future__ import annotations

import datetime as dt
import logging
import re
from typing import Any

import httpx

log = logging.getLogger(__name__)

MAX_DAYS_AHEAD = 400

# Herkenning van de soort afval uit de titel van de agenda-afspraak.
KINDS = [
    ("gft", "GFT", r"\bgft\b|groente|tuin|etens|organisch|bio"),
    ("papier", "Papier", r"papier|karton|opk\b"),
    ("pmd", "PMD", r"\bpmd\b|plastic|pbd|verpakking|blik|drank"),
    ("rest", "Restafval", r"rest|huisvuil|grijs|grijze"),
    ("glas", "Glas", r"glas"),
    ("textiel", "Textiel", r"textiel|kleding"),
    ("kerstboom", "Kerstboom", r"kerst"),
    ("grof", "Grofvuil", r"grof|snoei|takken"),
    ("chemisch", "Chemisch afval", r"kca|chemisch|klein gevaarlijk"),
]


def classify(summary: str) -> tuple[str, str]:
    text = summary.lower()
    for key, label, pattern in KINDS:
        if re.search(pattern, text):
            return key, label
    return "overig", summary.strip()[:40] or "Afval"


def _unfold(text: str) -> list[str]:
    lines: list[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        else:
            lines.append(raw)
    return lines


def _parse_date(value: str, params: str) -> dt.date | None:
    value = value.strip()
    m = re.match(r"^(\d{4})(\d{2})(\d{2})", value)
    if not m:
        return None
    try:
        day = dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None
    if "T" in value and value.endswith("Z") and "VALUE=DATE" not in params:
        # UTC-tijd: naar Nederlandse tijd, zodat "23:00Z" niet de dag ervoor wordt.
        try:
            from zoneinfo import ZoneInfo
            stamp = dt.datetime.strptime(value[:15], "%Y%m%dT%H%M%S").replace(tzinfo=dt.timezone.utc)
            day = stamp.astimezone(ZoneInfo("Europe/Amsterdam")).date()
        except ValueError:
            pass
    return day


def _expand_rrule(rrule: str, start: dt.date, until_max: dt.date) -> list[dt.date]:
    """Eenvoudige herhalingen (dagelijks/wekelijks/maandelijks, INTERVAL, COUNT, UNTIL, BYDAY)."""
    parts = dict(p.split("=", 1) for p in rrule.split(";") if "=" in p)
    freq = parts.get("FREQ", "").upper()
    interval = max(1, int(parts.get("INTERVAL", "1") or 1))
    count = int(parts["COUNT"]) if parts.get("COUNT", "").isdigit() else None
    until = _parse_date(parts["UNTIL"], "") if parts.get("UNTIL") else None
    until = min(until, until_max) if until else until_max
    days = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
    bydays = [days.index(d[-2:]) for d in parts.get("BYDAY", "").split(",") if d[-2:] in days]
    out: list[dt.date] = []
    if freq == "WEEKLY":
        week_start = start - dt.timedelta(days=start.weekday())
        weekday_set = bydays or [start.weekday()]
        week = 0
        while True:
            base = week_start + dt.timedelta(weeks=week * interval)
            if base > until:
                break
            for wd in sorted(weekday_set):
                day = base + dt.timedelta(days=wd)
                if start <= day <= until:
                    out.append(day)
            week += 1
            if count and len(out) >= count:
                return out[:count]
    elif freq == "DAILY":
        day = start
        while day <= until and (not count or len(out) < count):
            out.append(day)
            day += dt.timedelta(days=interval)
    elif freq == "MONTHLY":
        day = start
        months = 0
        while day <= until and (not count or len(out) < count):
            out.append(day)
            months += interval
            year, month = start.year + (start.month - 1 + months) // 12, (start.month - 1 + months) % 12 + 1
            try:
                day = start.replace(year=year, month=month)
            except ValueError:
                break
    else:
        out.append(start)
    return out


def parse_ical(text: str, today: dt.date | None = None) -> list[dict[str, Any]]:
    """iCal -> [{date, kind, label, summary}], van vandaag tot ruim een jaar vooruit, gesorteerd."""
    today = today or dt.date.today()
    until_max = today + dt.timedelta(days=MAX_DAYS_AHEAD)
    events: list[dict[str, Any]] = []
    current: dict[str, str] | None = None
    for line in _unfold(text):
        if line.startswith("BEGIN:VEVENT"):
            current = {}
        elif line.startswith("END:VEVENT") and current is not None:
            summary = current.get("SUMMARY", "")
            start = current.get("DTSTART")
            if summary and start:
                day = _parse_date(start, current.get("DTSTART_PARAMS", ""))
                if day:
                    days = _expand_rrule(current["RRULE"], day, until_max) if current.get("RRULE") else [day]
                    kind, label = classify(summary)
                    for d in days:
                        if today <= d <= until_max:
                            events.append({"date": d.isoformat(), "kind": kind, "label": label,
                                           "summary": summary.strip()[:120]})
            current = None
        elif current is not None and ":" in line:
            name, value = line.split(":", 1)
            key, _, params = name.partition(";")
            key = key.upper()
            if key in ("SUMMARY", "DTSTART", "RRULE"):
                current[key] = value
                if key == "DTSTART":
                    current["DTSTART_PARAMS"] = params.upper()
    seen = set()
    out = []
    for e in sorted(events, key=lambda e: (e["date"], e["label"])):
        if (e["date"], e["kind"], e["label"]) in seen:
            continue
        seen.add((e["date"], e["kind"], e["label"]))
        out.append(e)
    return out


async def fetch_ical(client: httpx.AsyncClient, url: str) -> list[dict[str, Any]]:
    if not url.lower().startswith(("http://", "https://", "webcal://")):
        raise ValueError("De agenda-link moet met http(s):// of webcal:// beginnen")
    url = re.sub(r"^webcal://", "https://", url, flags=re.I)
    resp = await client.get(url, timeout=30)
    resp.raise_for_status()
    text = resp.text
    if "BEGIN:VCALENDAR" not in text[:2000]:
        raise ValueError("Dit is geen agenda-bestand (iCal). Zoek op de afvalkalender-site naar 'Agenda' of 'iCal'.")
    events = parse_ical(text)
    if not events:
        raise ValueError("De agenda bevat geen ophaaldagen in de komende periode")
    return events
