import gzip
import io
import time

import httpx
import respx
from fastapi.testclient import TestClient

from buurtradar.main import create_app
from buurtradar.sources.roadworks import (
    DEFAULT_URL, REVERSE_URL, is_active, parse_feed, relevance,
)

NOW = 1790700000.0  # 2026-09-30


def iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def situation(sid, *, start=NOW - 86400, end=NOW + 5 * 86400, note="Honingerdijk Rotterdam Overig (622987)",
              warning="Weg dicht in beide richtingen", other=("Afsluiting Lage Filterweg (vanaf 29-09)",),
              closure=True, detour=False, speed=None, event=False, point=(51.908722, 4.5243144),
              line=((51.908682, 4.524481), (51.908742, 4.524242)), cause="Kabels / Leidingen, ,",
              source="Gemeente Rotterdam", url=None):
    comments = ""
    if note:
        comments += (f"<sit:generalPublicComment><sit:comment><com:values><com:value lang=\"nl\">{note}"
                     "</com:value></com:values></sit:comment><sit:commentType>internalNote</sit:commentType>"
                     "</sit:generalPublicComment>")
    if warning:
        comments += (f"<sit:generalPublicComment><sit:comment><com:values><com:value lang=\"nl\">{warning}"
                     "</com:value></com:values></sit:comment><sit:commentType>warning</sit:commentType>"
                     "</sit:generalPublicComment>")
    for o in other:
        comments += (f"<sit:generalPublicComment><sit:comment><com:values><com:value lang=\"nl\">{o}"
                     "</com:value></com:values></sit:comment><sit:commentType>other</sit:commentType>"
                     "</sit:generalPublicComment>")
    validity = (f"<sit:validity><com:validityTimeSpecification><com:overallStartTime>{iso(start)}"
                f"</com:overallStartTime><com:overallEndTime>{iso(end)}</com:overallEndTime>"
                "</com:validityTimeSpecification></sit:validity>")
    src = (f"<sit:source><com:sourceName><com:values><com:value lang=\"nl\">{source}</com:value>"
           "</com:values></com:sourceName></sit:source>")
    loc_point = (f'<sit:locationReference xsi:type="loc:PointLocation"><loc:pointByCoordinates>'
                 f"<loc:pointCoordinates><loc:latitude>{point[0]}</loc:latitude><loc:longitude>{point[1]}"
                 "</loc:longitude></loc:pointCoordinates></loc:pointByCoordinates></sit:locationReference>"
                 ) if point else ""
    pos = " ".join(f"{a} {b}" for a, b in line or ())
    loc_line = ('<sit:locationReference xsi:type="loc:ItineraryByIndexedLocations">'
                '<loc:locationContainedInItinerary index="0"><loc:location xsi:type="loc:LinearLocation">'
                f"<loc:gmlLineString><loc:posList>{pos}</loc:posList></loc:gmlLineString></loc:location>"
                "</loc:locationContainedInItinerary></sit:locationReference>") if line else ""
    kind = "sit:PublicEvent" if event else "sit:MaintenanceWorks"
    recs = (f'<sit:situationRecord xsi:type="{kind}" id="{sid}_M">{src}{validity}'
            f"<sit:cause><sit:causeDescription><com:values><com:value>{cause}</com:value></com:values>"
            f"</sit:causeDescription></sit:cause>{comments}{loc_point}"
            + (f"<sit:urlLink><com:urlLinkAddress>{url}</com:urlLinkAddress></sit:urlLink>" if url else "")
            + "</sit:situationRecord>")
    if closure:
        recs += (f'<sit:situationRecord xsi:type="sit:RoadOrCarriagewayOrLaneManagement" id="{sid}_C">{src}'
                 f"{validity}{loc_line}<sit:roadOrCarriagewayOrLaneManagementType>carriagewayClosures"
                 "</sit:roadOrCarriagewayOrLaneManagementType></sit:situationRecord>")
    if detour:
        recs += f'<sit:situationRecord xsi:type="sit:ReroutingManagement" id="{sid}_R">{src}{validity}</sit:situationRecord>'
    if speed:
        recs += (f'<sit:situationRecord xsi:type="sit:SpeedManagement" id="{sid}_S">{src}{validity}'
                 f"<sit:temporarySpeedLimit>{speed}</sit:temporarySpeedLimit></sit:situationRecord>")
    return f'<sit:situation id="{sid}"><sit:overallSeverity>medium</sit:overallSeverity>{recs}</sit:situation>'


def feed(*situations):
    return (
        '<?xml version="1.0" encoding="UTF-8"?><mc:messageContainer '
        'xmlns:sit="http://datex2.eu/schema/3/situation" xmlns:mc="http://datex2.eu/schema/3/messageContainer" '
        'xmlns:loc="http://datex2.eu/schema/3/locationReferencing" xmlns:com="http://datex2.eu/schema/3/common">'
        '<mc:payload xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="sit:SituationPublication">'
        + "".join(situations) + "</mc:payload></mc:messageContainer>").encode()


def test_parse_situation_fields():
    [w] = parse_feed(io.BytesIO(feed(situation("A", detour=True, speed=30,
                                                url="https://melvin.ndw.nu/attachment/x"))), now=NOW)
    assert w["id"] == "A" and w["kind"] == "werk" and w["source"] == "Gemeente Rotterdam"
    assert w["note"] == "Honingerdijk Rotterdam Overig"            # zonder "(622987)"
    assert w["cause"] == "Kabels / Leidingen"
    assert w["warnings"] == ["Weg dicht in beide richtingen"]
    assert w["details"] == ["Afsluiting Lage Filterweg (vanaf 29-09)"]
    assert w["closed"] and w["detour"] and w["speed"] == 30
    assert (w["lat"], w["lon"]) == (51.90872, 4.52431)
    assert w["lines"] == [[[51.90868, 4.52448], [51.90874, 4.52424]]]
    assert w["url"] == "https://melvin.ndw.nu/attachment/x"


def test_contact_details_and_noise_are_dropped():
    [w] = parse_feed(io.BytesIO(feed(situation("A", other=(
        "Contactinformatie: E. Jansen, Gemeente X, 14040, e.jansen@x.nl",
        "Beperking 1", "Omleiding 2", "Bel 010-1234567 bij vragen", "Werk in twee fasen")))), now=NOW)
    assert w["details"] == ["Werk in twee fasen"]


def test_filters_past_far_future_no_impact_and_no_location():
    items = parse_feed(io.BytesIO(feed(
        situation("past", start=NOW - 10 * 86400, end=NOW - 86400),
        situation("later", start=NOW + 60 * 86400, end=NOW + 70 * 86400),
        situation("soon", start=NOW + 3 * 86400, end=NOW + 5 * 86400),
        situation("noimpact", warning="Geen gevolgen voor verkeer", closure=False),
        situation("noloc", point=None, line=None),
        situation("rws", source="MN-Z", note=None, cause="Asfaltering"),
    )), now=NOW, ahead_days=14)
    assert sorted(w["id"] for w in items) == ["rws", "soon"]
    rws = next(w for w in items if w["id"] == "rws")
    assert rws["source"] == "Rijkswaterstaat" and rws["lat"] == 51.90872


def test_point_from_line_when_no_point():
    [w] = parse_feed(io.BytesIO(feed(situation("A", point=None))), now=NOW)
    assert (w["lat"], w["lon"]) == (51.90874, 4.52424)


def test_relevance_and_active():
    [closed, small, event, planned, long] = parse_feed(io.BytesIO(feed(
        situation("closed"),
        situation("small", warning="Beperking voor langzaam verkeer", closure=False),
        situation("event", event=True, closure=False, warning=None, note="Braderie"),
        situation("planned", start=NOW + 2 * 86400),
        situation("long", start=NOW - 200 * 86400, end=NOW + 200 * 86400),
    )), now=NOW)
    r = lambda w, d=200: relevance(w, d, 3000, NOW)  # noqa: E731
    assert is_active(closed, NOW) and not is_active(planned, NOW)
    assert r(closed) > r(small) and r(closed) > r(planned) > 0 and r(closed) > r(long)
    assert r(event) > r(small)
    assert r(closed, 100) > r(closed, 2900)


@respx.mock
async def test_refresh_uses_etag(service):
    body = gzip.compress(feed(situation("A", start=time.time() - 3600, end=time.time() + 86400)))
    route = respx.get(DEFAULT_URL).mock(return_value=httpx.Response(200, content=body, headers={"ETag": '"v1"'}))
    assert await service.refresh_roadworks_once()
    assert service.db.roadworks_count() == 1 and service.status["roadworks"]["count"] == 1
    route.mock(return_value=httpx.Response(304))
    assert await service.refresh_roadworks_once()
    assert route.calls.last.request.headers["If-None-Match"] == '"v1"'
    assert service.db.roadworks_count() == 1  # ongewijzigd: niets weggegooid
    route.mock(return_value=httpx.Response(500))
    assert not await service.refresh_roadworks_once()
    assert service.db.roadworks_count() == 1 and service.status["roadworks"]["last_error"]


@respx.mock
def test_api_roadworks_near_with_street(service):
    now = time.time()
    body = gzip.compress(feed(
        situation("now", start=now - 3600, end=now + 86400),
        situation("soon", start=now + 2 * 86400, end=now + 3 * 86400, point=(51.9100, 4.5250)),
    ))
    respx.get(DEFAULT_URL).mock(return_value=httpx.Response(200, content=body))
    street = respx.get(REVERSE_URL).mock(return_value=httpx.Response(
        200, json={"response": {"docs": [{"weergavenaam": "Honingerdijk, Rotterdam"}]}}))
    with TestClient(create_app(service, start_background=False)) as client:
        import asyncio
        asyncio.run(service.refresh_roadworks_once())
        bbox = "4.50,51.90,4.55,51.92"
        assert [w["id"] for w in client.get(f"/api/roadworks?bbox={bbox}").json()] == ["now"]
        works = client.get(f"/api/roadworks?bbox={bbox}&planned=true&near=51.9087,4.5243").json()
        assert [w["id"] for w in works] == ["now", "soon"]          # actief en dichtbij eerst
        assert works[0]["active"] and not works[1]["active"]
        assert works[0]["street"] == "Honingerdijk, Rotterdam" and works[0]["distance_m"] < 50
        calls = street.call_count
        client.get(f"/api/roadworks?bbox={bbox}&planned=true&near=51.9087,4.5243")
        assert street.call_count == calls                             # straatnamen gecachet
        assert client.get("/api/roadworks?bbox=3,50,6,53").status_code == 422
        assert client.get("/api/config").json()["roadworks"]["list_radius_m"] == 3000
