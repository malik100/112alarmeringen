import httpx
import respx
from fastapi.testclient import TestClient

from sirene.main import create_app
from sirene.sources.amenities import parse_overpass


def el(id_, lat, lon, **tags):
    return {"type": "node", "id": id_, "lat": lat, "lon": lon, "tags": tags}


DATA = {"elements": [
    el(1, 52.38, 4.84, emergency="defibrillator", indoor="yes", access="customers", opening_hours="Mo-Fr 09:00-17:00",
       **{"defibrillator:location": "Naast de receptie"}),
    el(2, 52.38, 4.85, emergency="defibrillator", indoor="no", access="private"),   # AED blijft, met beperking
    el(3, 52.39, 4.84, amenity="toilets", fee="no", wheelchair="yes", changing_table="yes", access="yes"),
    el(4, 52.39, 4.85, amenity="toilets", access="private"),                           # privé: weg
    el(5, 52.40, 4.84, amenity="drinking_water", bottle="yes", operator="Waternet"),
    {"type": "way", "id": 6, "center": {"lat": 52.40, "lon": 4.85}, "tags": {"amenity": "toilets"}},
    el(7, 52.41, 4.84, amenity="bench"),
]}


def test_parse():
    items = {a["id"]: a for a in parse_overpass(DATA)}
    assert sorted(items) == ["node/1", "node/2", "node/3", "node/5", "way/6"]
    aed = items["node/1"]
    assert aed["kind"] == "aed" and aed["indoor"] and aed["access"] == "voor klanten"
    assert aed["location"] == "Naast de receptie" and aed["hours"][0] == [[540, 1020]]
    assert items["node/2"]["access"] == "niet openbaar"
    t = items["node/3"]
    assert t["kind"] == "toilet" and t["fee"] is False and t["wheelchair"] and t["changing_table"]
    assert items["node/5"] == {**items["node/5"], "kind": "water", "bottle": True, "operator": "Waternet"}
    assert items["way/6"]["fee"] is None


@respx.mock
def test_refresh_and_api(service):
    urls = service.cfg["speedcams"]["overpass_urls"]
    respx.post(urls[0]).mock(return_value=httpx.Response(200, json=DATA))
    with TestClient(create_app(service, start_background=False)) as client:
        import asyncio
        assert asyncio.run(service.refresh_amenities_once())
        assert service.status["amenities"]["count"] == 5
        got = client.get("/api/amenities?bbox=4.83,52.37,4.86,52.41").json()
        assert len(got) == 5
        got = client.get("/api/amenities?bbox=4.83,52.37,4.86,52.41&kinds=aed,water").json()
        assert sorted(a["kind"] for a in got) == ["aed", "aed", "water"]
        assert client.get("/api/amenities?bbox=3,50,6,53").status_code == 422
        assert client.get("/api/config").json()["amenities"]["min_zoom"] == 14
