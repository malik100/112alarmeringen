"""P2000-berichten ontleden: dienst, prioriteit en locatie.

Werkt op RSS-items van alarmeringen.nl: de titel is de ruwe P2000-tekst (kleine letters),
de beschrijving een leesbare Nederlandse zin, bijvoorbeeld:

    titel:        "a1 13105 parnassiaveld 1115 duivendrecht 94056"
    beschrijving: "Ambulance met spoed naar Parnassiaveld in Duivendrecht"
"""

from __future__ import annotations

import re
from dataclasses import dataclass

BRANDWEER = "brandweer"
AMBULANCE = "ambulance"
POLITIE = "politie"
ONBEKEND = "onbekend"

_TEST_RE = re.compile(r"\b(proefalarm|testoproep|test ?alarm|test)\b")
_PRIO_RE = re.compile(r"^(?:prio|a|p)\s?([0-3])\b")
_BESTELD_RE = re.compile(r"^b[12]?\b(?!\w)")
_AMBU_RE = re.compile(r"^a[0-2]\b")
_BRW_PRIO_RE = re.compile(r"^p\s?[1-3]\b")
_BRW_REGIO_RE = re.compile(r"\bb[a-z]{2}-\d{2}\b")  # bijv. "bnh-01", "brt-05"
_POSTCODE6_RE = re.compile(r"\b([1-9]\d{3})\s?([a-z]{2})\b", re.IGNORECASE)
_POSTCODE4_RE = re.compile(r"(?<![\d-])\b([1-9]\d{3})\b(?![\d-])")

# "... naar/op <straat> in <plaats> [voor ...]"
_STREET_CITY_RE = re.compile(
    r"^(?P<what>.*)\s(?:naar|op)\s(?P<street>.+?)\sin\s(?P<city>.+?)(?:\svoor\s.*)?$"
)
# "... naar/in <plaats> [voor ...]"
_CITY_RE = re.compile(r"^(?P<what>.*?)\s(?:naar|in)\s(?P<city>.+?)(?:\svoor\s.*)?$")


@dataclass
class ParsedMessage:
    discipline: str
    priority: int | None  # 0/1 = met spoed (sirene), 2 = gepast, 3 = besteld/geen spoed
    street: str | None
    city: str | None
    postcode: str | None  # "1115" of "3072AP"
    is_test: bool

    @property
    def sirene(self) -> bool:
        return self.priority is not None and self.priority <= 1


def classify_discipline(title: str, description: str) -> str:
    t = title.lower().strip()
    d = description.lower().strip()
    if d.startswith("politie") or t.startswith("prio"):
        return POLITIE
    if _AMBU_RE.match(t) or _BESTELD_RE.match(t) or d.startswith("ambulance") or "lifeliner" in t:
        return AMBULANCE
    if _BRW_PRIO_RE.match(t) or _BRW_REGIO_RE.search(t) or "brand" in d:
        return BRANDWEER
    return ONBEKEND


def parse_priority(title: str, description: str) -> int | None:
    t = title.lower().strip()
    m = _PRIO_RE.match(t)
    if m:
        return int(m.group(1))
    if _BESTELD_RE.match(t):
        return 3
    if "met spoed" in description.lower():
        return 1
    return None


def parse_postcode(title: str) -> str | None:
    m = _POSTCODE6_RE.search(title)
    if m:
        return f"{m.group(1)}{m.group(2).upper()}"
    m = _POSTCODE4_RE.search(title)
    return m.group(1) if m else None


def parse_location(description: str) -> tuple[str | None, str | None]:
    """Geeft (straat, plaats) uit de leesbare beschrijving."""
    d = " ".join(description.split())
    m = _STREET_CITY_RE.match(d)
    if m:
        return m.group("street").strip(), m.group("city").strip()
    m = _CITY_RE.match(d)
    if m:
        return None, m.group("city").strip()
    return None, None


def parse_message(title: str, description: str) -> ParsedMessage:
    street, city = parse_location(description)
    return ParsedMessage(
        discipline=classify_discipline(title, description),
        priority=parse_priority(title, description),
        street=street,
        city=city,
        postcode=parse_postcode(title),
        is_test=bool(_TEST_RE.search(title.lower())),
    )
