"""Nieuwsartikelen koppelen aan P2000-meldingen.

Een artikel hoort (waarschijnlijk) bij een melding als het kort erna verschijnt en dezelfde
straat, weg of plaats noemt, liefst ook met hetzelfde soort incident. Elke overeenkomst
levert punten op; boven een drempel wordt het artikel bij de melding getoond.
"""

from __future__ import annotations

import html
import re
import unicodedata
from dataclasses import dataclass
from typing import Any

# Tijdvenster: artikel mag tot 30 min vóór en tot 6 uur na de melding verschijnen.
BEFORE_S = 30 * 60
AFTER_S = 6 * 3600
CLOSE_S = 2 * 3600

MIN_SCORE = 4          # "mogelijk gerelateerd"
LIKELY_SCORE = 5       # "waarschijnlijk gerelateerd"

# Soort incident: (herkenning in de melding, herkenning in het artikel).
CATEGORIES = {
    "brand": (r"brand(?!weer)|rook", r"brand(?!weer)|vlammen|rook|uitslaande|blus|afgebrand|in de fik"),
    "ongeval": (r"ongeval|aanrijding|wegvervoer|letsel",
                r"ongeval|ongeluk|aanrijding|botsing|gebotst|over de kop|aangereden|gewond"),
    "water": (r"water", r"te water|in het water|drenkeling|sloot|gracht|kanaal|gered"),
    "reanimatie": (r"reanimatie", r"reanim|onwel|hartstilstand"),
    "gas": (r"\bgas", r"\bgas(lek|lucht)?\b"),
    "explosie": (r"explosie|ontploffing", r"explosie|ontploffing|explosief"),
    "beknelling": (r"beknel|vast", r"bekneld|vast"),
    "dier": (r"dier", r"dier|kat|hond|paard|koe|vogel|papegaai"),
    "geweld": (r"steek|schiet|overval|vecht|mishandel",
               r"steek|schiet|overval|vechtpartij|mishandel|neergestoken"),
    "inbraak": (r"inbraak", r"inbraak|ingebroken|inbreker"),
}

# Plaatsnamen die in P2000 en nieuws verschillend geschreven worden.
CITY_ALIASES = {
    "den haag": ["den haag", "s-gravenhage", "'s-gravenhage", "haagse"],
    "s-gravenhage": ["den haag", "s-gravenhage", "haagse"],
    "den bosch": ["den bosch", "s-hertogenbosch", "bossche"],
    "s-hertogenbosch": ["den bosch", "s-hertogenbosch", "bossche"],
}

_ROAD_RE = re.compile(r"\b([an])\s?(\d{1,3})\b")
# In P2000 betekent "a1"/"a2" aan het begin de ambulanceprioriteit, niet de snelweg.
_PRIORITY_PREFIX_RE = re.compile(r"^\s*(prio\s?\d|[abp]\s?\d)\b")
# Een straat zonder plaatsnaam telt alleen als het herkenbaar een straatnaam is
# (niet "Delft", "Noord" of "Markt" dat ook iets anders kan betekenen).
_STREET_SUFFIX_RE = re.compile(
    r"(straat|weg|laan|plein|gracht|kade|dijk|singel|dreef|steeg|hof|baan|ring|pad|park|"
    r"burgwal|wal|veld|erf|zijde|kant)$")


def normalize(text: str) -> str:
    text = html.unescape(re.sub(r"<[^>]+>", " ", text or ""))
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = text.lower().replace("’", "'")
    return " ".join(text.split())


def _word(term: str) -> re.Pattern:
    return re.compile(r"(?<![a-z0-9])" + re.escape(term) + r"(?![a-z0-9])")


def roads(text: str) -> set[str]:
    return {f"{k}{n}" for k, n in _ROAD_RE.findall(normalize(text))}


def categories_of(incident_text: str) -> set[str]:
    t = normalize(incident_text)
    return {name for name, (pattern, _) in CATEGORIES.items() if re.search(pattern, t)}


@dataclass
class Match:
    score: int
    reasons: list[str]

    @property
    def label(self) -> str:
        return "waarschijnlijk" if self.score >= LIKELY_SCORE else "mogelijk"


def match(incident: dict[str, Any], article: dict[str, Any]) -> Match | None:
    """Beoordeelt of een artikel bij een melding hoort. None = geen koppeling."""
    delta = article["ts"] - incident["ts"]
    if delta < -BEFORE_S or delta > AFTER_S:
        return None

    text = normalize(f"{article['title']} {article.get('summary') or ''}")
    score = 0
    reasons = []

    city = normalize(incident.get("city") or "")
    if city and any(_word(c).search(text) for c in CITY_ALIASES.get(city, [city])):
        score += 2
        reasons.append("plaats")

    street = normalize(incident.get("street") or "")
    if len(street) >= 5 and _word(street).search(text) and (
            "plaats" in reasons or _STREET_SUFFIX_RE.search(street)):
        score += 3
        reasons.append("straat")

    title = _PRIORITY_PREFIX_RE.sub(" ", normalize(incident.get("title") or ""))
    incident_roads = roads(title) | roads(incident.get("description") or "")
    if incident_roads & roads(text):
        # Een weg is lang: zonder plaats of straat is dat alleen een zwakke aanwijzing.
        score += 3 if reasons else 2
        reasons.append("weg")

    if not reasons:
        return None  # zonder plek geen koppeling, ook niet bij hetzelfde soort incident

    incident_text = f"{incident.get('description') or ''} {incident.get('title') or ''}"
    if any(re.search(CATEGORIES[c][1], text) for c in categories_of(incident_text)):
        score += 1
        reasons.append("soort")

    if 0 <= delta <= CLOSE_S:
        score += 1
        reasons.append("tijd")

    return Match(score, reasons) if score >= MIN_SCORE else None


# --- nieuws uit de buurt ------------------------------------------------------

# Plaatsnamen die ook een gewoon woord zijn ("in Houten" wel, "houten vloer" niet): die
# tellen alleen met een voorzetsel ervoor.
AMBIGUOUS_PLACES = {
    "best", "mill", "son", "lent", "made", "echt", "beek", "dieren", "hoorn", "houten",
    "duiven", "doorn", "heel", "loon", "berg", "meer", "laren", "haren", "wijk", "kamp",
    "putten", "bergen", "born", "elst", "ens", "stad", "rijs", "boven", "oost", "west",
    "noord", "zuid", "horn", "wolde", "hall", "veen", "hoek", "buren", "kerk", "sluis",
}
_PREPOSITIONS = r"(?:in|uit|bij|naar|rond|te|nabij|omgeving|centrum|gemeente)"


def place_patterns(name: str) -> list[re.Pattern]:
    key = normalize(name)
    if len(key) < 3:
        return []
    variants = CITY_ALIASES.get(key.lstrip("'"), [key])
    if key in AMBIGUOUS_PLACES:
        return [re.compile(rf"\b{_PREPOSITIONS}\s+" + re.escape(v) + r"(?![a-z0-9])")
                for v in variants]
    return [_word(v) for v in variants]


def local_place(article: dict[str, Any], places: list[dict[str, Any]]) -> dict[str, Any] | None:
    """De dichtstbijzijnde plaats uit `places` die het artikel noemt, of None.

    `places`: [{"name", "gemeente", "distance_m"}], dichtstbijzijnde eerst.
    """
    text = normalize(f"{article['title']} {article.get('summary') or ''}")
    for place in places:
        if any(p.search(text) for p in place_patterns(place["name"])):
            return place
    return None


# Landelijke media noemen een stad vaak terloops; regionale omroepen gaan echt over de buurt.
NATIONAL_SOURCES = {"NOS", "NU.nl"}


def local_relevance(article: dict[str, Any], place: dict[str, Any], now: float) -> float:
    """Score voor lokaal nieuws: vooral versheid, daarna hoe dichtbij en hoe prominent."""
    hours = max(0.0, (now - article["ts"]) / 3600)
    score = 3.0 - hours / 8
    d = place.get("distance_m") or 0
    score += 1.5 if d == 0 else 1.0 if d <= 3000 else 0.5
    if any(p.search(normalize(article["title"])) for p in place_patterns(place["name"])):
        score += 1.0  # plaats in de kop
    if article.get("source") in NATIONAL_SOURCES:
        score -= 0.5
    return round(score, 2)
