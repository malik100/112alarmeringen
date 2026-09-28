import time

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from sirene import news
from sirene.main import create_app
from sirene.sources.bekendmakingen import (
    REVERSE_URL, SRU_URL, build_query, category_of, parse_sru, point_of, short_title,
)
from sirene.sources.p2000_rss import FeedItem


def record(ident, title, kind="omgevingsvergunning", gemeente="Utrecht", date="2026-09-28",
           gebied="POLYGON((5.1235 52.0975,5.1233 52.0976,5.1234 52.0977,5.1235 52.0975))",
           label="Weerdsingel O.Z. 83, 3514AJ Utrecht", deadline="2026-11-18"):
    marking = ""
    if gebied:
        marking = (
            '<overheidwetgeving:gebiedsmarkering><overheidwetgeving:Vlak>'
            '<overheidwetgeving:geometrie>POLYGON ((136931 456617, 136920 456635))</overheidwetgeving:geometrie>'
            f'<overheidwetgeving:locatiegebied>{gebied}</overheidwetgeving:locatiegebied>'
            f'<overheidwetgeving:geometrielabel>{label}</overheidwetgeving:geometrielabel>'
            '</overheidwetgeving:Vlak></overheidwetgeving:gebiedsmarkering>')
    return f"""<sru:record><sru:recordData><gzd:gzd><gzd:originalData><overheidwetgeving:meta>
<overheidwetgeving:owmskern><dcterms:identifier>{ident}</dcterms:identifier>
<dcterms:title>{title}</dcterms:title><dcterms:type scheme="x">{kind}</dcterms:type>
<dcterms:creator scheme="OVERHEID.Gemeente">{gemeente}</dcterms:creator>
<dcterms:modified>{date}</dcterms:modified></overheidwetgeving:owmskern>
<overheidwetgeving:owmsmantel><dcterms:available>{date}</dcterms:available>
<dcterms:abstract>Toelichting: het bouwen van een dakkapel</dcterms:abstract></overheidwetgeving:owmsmantel>
<overheidwetgeving:tpmeta><overheidwetgeving:datumEindeReactietermijn>{deadline}</overheidwetgeving:datumEindeReactietermijn>
{marking}</overheidwetgeving:tpmeta></overheidwetgeving:meta></gzd:originalData>
<gzd:enrichedData><gzd:preferredUrl>https://zoek.officielebekendmakingen.nl/{ident}.html</gzd:preferredUrl>
</gzd:enrichedData></gzd:gzd></sru:recordData></sru:record>"""


def sru(*records, total=None):
    return (
        '<?xml version="1.0" encoding="UTF-8"?><sru:searchRetrieveResponse '
        'xmlns:overheidwetgeving="http://standaarden.overheid.nl/wetgeving/" '
        'xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:sru="http://docs.oasis-open.org/ns/search-ws/sruResponse" '
        'xmlns:gzd="http://standaarden.overheid.nl/sru">'
        f'<sru:numberOfRecords>{len(records) if total is None else total}</sru:numberOfRecords>'
        f'<sru:records>{"".join(records)}</sru:records></sru:searchRetrieveResponse>'
    )


def reverse(*places):
    docs = [{"woonplaatsnaam": n, "gemeentenaam": g, "afstand": d} for n, g, d in places]
    return httpx.Response(200, json={"response": {"docs": docs}})


# --- bron --------------------------------------------------------------------

def test_point_of_formats():
    assert point_of("52.077486,5.1117706") == (52.077486, 5.1117706)
    lat, lon = point_of("LINESTRING(5.0 52.0,5.2 52.2)")
    assert (round(lat, 3), round(lon, 3)) == (52.1, 5.1)
    assert point_of("POLYGON ((136931.2 456617.6, 136920.5 456635.6))") is None  # RD, geen WGS84
    assert point_of(None) is None and point_of("") is None


def test_category_and_short_title():
    assert category_of("omgevingsvergunning") == "bouwen"
    assert category_of("verkeersbesluit of -mededeling") == "verkeer"
    assert category_of("evenementenvergunning") == "evenementen"
    assert category_of("andere vergunning") == "vergunning"
    assert category_of("beleidsregel") == "overig"
    assert category_of("overige overheidsinformatie", "Verkeersbesluit gehandicaptenparkeerplaats") == "verkeer"
    assert short_title("Aanvraag omgevingsvergunning, dakkapel, Voorstraat 13B, 3512AH Utrecht, "
                       "GU-Z2026-0068098") == "Aanvraag omgevingsvergunning, dakkapel, Voorstraat 13B, 3512AH Utrecht"
    assert short_title("Verkeersbesluit Oudegracht") == "Verkeersbesluit Oudegracht"


def test_parse_sru():
    total, items = parse_sru(sru(
        record("gmb-1", "Aanvraag omgevingsvergunning, dakkapel, Weerdsingel O.Z. 83, GU-Z2026-0068086"),
        record("gmb-2", "Parkeerverordening 2027", kind="algemeen verbindend voorschrift (verordening)",
               gebied=None, deadline=""),
    ))
    assert total == 2
    a, b = items
    assert a["id"] == "gmb-1" and a["category"] == "bouwen" and a["gemeente"] == "Utrecht"
    assert a["title"].endswith("O.Z. 83") and a["abstract"] == "het bouwen van een dakkapel"
    assert a["label"].startswith("Weerdsingel") and a["deadline"] == "2026-11-18"
    assert round(a["lat"], 2) == 52.1 and round(a["lon"], 2) == 5.12
    assert a["url"] == "https://zoek.officielebekendmakingen.nl/gmb-1.html" and a["ts"]
    assert b["lat"] is None and b["deadline"] is None and b["category"] == "overig"


def test_build_query_quotes_gemeente():
    q = build_query("'s-Hertogenbosch", __import__("datetime").date(2026, 9, 1))
    assert 'dt.creator="\'s-Hertogenbosch"' in q and "dt.modified>=2026-09-01" in q


# --- lokaal nieuws -----------------------------------------------------------

PLACES = [{"name": "Utrecht", "gemeente": "Utrecht", "distance_m": 0},
          {"name": "De Bilt", "gemeente": "De Bilt", "distance_m": 2538},
          {"name": "Houten", "gemeente": "Houten", "distance_m": 3998},
          {"name": "'s-Gravenhage", "gemeente": "'s-Gravenhage", "distance_m": 4000}]


@pytest.mark.parametrize("title,expected", [
    ("Brand in woning in De Bilt", "De Bilt"),
    ("Utrecht krijgt nieuwe fietsenstalling", "Utrecht"),
    ("Wegwerkzaamheden in Houten", "Houten"),
    ("Kabinet in Den Haag valt", "'s-Gravenhage"),
    ("Houten vloer onder vuur door oplichters", None),   # "houten" als gewoon woord
    ("Brand in Amsterdam", None),
])
def test_local_place(title, expected):
    place = news.local_place({"title": title, "summary": ""}, PLACES)
    assert (place["name"] if place else None) == expected


# --- service & api -----------------------------------------------------------

@respx.mock
async def test_local_overview(service):
    respx.get(REVERSE_URL).mock(return_value=reverse(
        ("Utrecht", "Utrecht", 0), ("Bunnik", "Bunnik", 1200), ("Zeist", "Zeist", 4900)))
    sru_route = respx.get(SRU_URL).mock(side_effect=lambda req: httpx.Response(200, text=sru(
        record("gmb-1", "Dakkapel Weerdsingel"),
        record("gmb-far", "Ver weg", gebied="52.2,5.3"),
        record("gmb-rule", "Parkeerverordening", gebied=None),
    ) if "Utrecht" in req.url.params["query"] else sru()))
    now = time.time()
    service.db.insert_news({"guid": "n1", "ts": now - 600, "source": "RTV Utrecht",
                            "title": "Nieuwe brug in Utrecht open", "summary": "", "link": "https://x/1"})
    service.db.insert_news({"guid": "n2", "ts": now - 600, "source": "NOS",
                            "title": "Storm in Groningen", "summary": "", "link": "https://x/2"})

    out = await service.local_overview(52.0975, 5.1234)
    assert out["place"] == "Utrecht" and out["gemeente"] == "Utrecht"
    assert [n["title"] for n in out["news"]] == ["Nieuwe brug in Utrecht open"]
    ids = [a["id"] for a in out["announcements"]]
    assert "gmb-1" in ids and "gmb-rule" in ids and "gmb-far" not in ids
    assert next(a for a in out["announcements"] if a["id"] == "gmb-rule")["distance_m"] is None
    # Utrecht + Bunnik (binnen 1,5 km) bevraagd, Zeist niet.
    assert sru_route.call_count == 2
    assert service.status["announcements"]["gemeenten"] == ["Utrecht", "Bunnik"]

    # Tweede keer: omgeving en bekendmakingen komen uit de cache.
    await service.local_overview(52.0976, 5.1235)
    assert sru_route.call_count == 2 and respx.calls.call_count == 3


@respx.mock
async def test_announcements_failure_keeps_old_data(service):
    respx.get(REVERSE_URL).mock(return_value=reverse(("Utrecht", "Utrecht", 0)))
    respx.get(SRU_URL).mock(return_value=httpx.Response(200, text=sru(record("gmb-1", "Dakkapel"))))
    await service.refresh_announcements(["Utrecht"])
    respx.get(SRU_URL).mock(return_value=httpx.Response(503))
    await service.refresh_announcements(["Utrecht"], force=True)
    assert service.status["announcements"]["last_error"]
    out = await service.local_overview(52.0975, 5.1234)
    assert [a["id"] for a in out["announcements"]] == ["gmb-1"]


def test_news_kept_longer_than_incidents(service):
    service.cfg["p2000"]["keep_hours"] = 24
    service.cfg["news"]["keep_hours"] = 48
    old = FeedItem(guid="old", title="Brand in Utrecht", description="", link="https://x",
                   ts=time.time() - 30 * 3600)
    service.process_article("NOS", old)
    assert service.db.has_news("old")


@respx.mock
def test_api_local_uses_current_location(service):
    respx.get(REVERSE_URL).mock(return_value=reverse(("Utrecht", "Utrecht", 0)))
    respx.get(SRU_URL).mock(return_value=httpx.Response(200, text=sru(record("gmb-1", "Dakkapel"))))
    with TestClient(create_app(service, start_background=False)) as client:
        assert client.get("/api/local").json()["announcements"] == []  # nog geen locatie
        assert client.get("/api/config").json()["local"]["radius_m"] == 1500
        client.post("/api/location", json={"lat": 52.0975, "lon": 5.1234})
        out = client.get("/api/local").json()
        assert out["place"] == "Utrecht" and out["announcements"][0]["id"] == "gmb-1"


def test_future_news_time_is_clamped(service):
    item = FeedItem(guid="f", title="Brand in Utrecht", description="", link="https://x",
                    ts=time.time() + 4 * 3600)
    service.process_article("RTV Utrecht", item)
    [article] = service.db.news_since(0)
    assert article["ts"] <= time.time()


@respx.mock
async def test_area_lookup_sends_rounded_location(service):
    route = respx.get(REVERSE_URL).mock(return_value=reverse(("Utrecht", "Utrecht", 0)))
    await service.area_for(52.09753, 5.12341)
    assert route.calls.last.request.url.params["lat"] == "52.10"
    assert route.calls.last.request.url.params["lon"] == "5.12"
