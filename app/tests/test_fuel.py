import httpx
import respx
from fastapi.testclient import TestClient

from sirene.main import create_app
from sirene.sources.fuel import classify, parse_overpass


def fuel(id_, lat, lon, **tags):
    return {"type": "node", "id": id_, "lat": lat, "lon": lon, "tags": {"amenity": "fuel", **tags}}


def shop(id_, lat, lon, name=None, kind="convenience"):
    tags = {"shop": kind}
    if name:
        tags["name"] = name
    return {"type": "node", "id": id_, "lat": lat, "lon": lon, "tags": tags}


DATA = {"elements": [
    fuel(1, 52.3800, 4.8400, brand="Shell", name="Shell Haarlemmerweg", opening_hours="24/7",
         **{"fuel:diesel": "yes", "fuel:lpg": "yes", "hgv": "yes", "car_wash": "yes"}),
    shop(2, 52.38030, 4.84010, name="Shell Select"),                  # ~35 m: winkel op het terrein
    fuel(3, 52.3900, 4.8500, brand="TinQ", name="TinQ Sloterdijk"),
    shop(4, 52.39005, 4.85005, name="Buurtsuper"),                    # onbemand merk wint
    fuel(5, 52.4000, 4.8600, brand="Esso"),                           # niets bekend
    fuel(6, 52.4100, 4.8700, brand="BP", shop="no"),
    fuel(7, 52.4200, 4.8800, name="Garage Jansen", shop="kiosk"),
    fuel(8, 52.4300, 4.8900, brand="Esso Express"),
    fuel(9, 52.4400, 4.9000, brand="Tamoil", access="private"),        # niet openbaar: weg
    fuel(10, 52.4500, 4.9100, brand="Argos", self_service="only"),
    shop(11, 52.4600, 4.9200),
    fuel(12, 52.4600, 4.9205, brand="OK"),                            # winkel zonder naam, ~35 m
    {"type": "way", "id": 13, "center": {"lat": 52.47, "lon": 4.93}, "tags": {"amenity": "fuel"}},
]}


def test_classify_rules():
    assert classify({"shop": "no"}, "Spar") == ("nee", "volgens OpenStreetMap")
    assert classify({"shop": "convenience"}, None)[0] == "ja"
    assert classify({"automated": "yes"}, None) == ("nee", "onbemand station")
    assert classify({"brand": "AVIA XPress"}, None)[0] == "nee"
    assert classify({"brand": "Tango"}, "Spar")[0] == "nee"
    assert classify({"brand": "Shell"}, "SPAR express") == ("ja", "winkel op het terrein: SPAR express")
    assert classify({"brand": "Shell"}, "") == ("ja", "winkel op het terrein")
    assert classify({"brand": "Shell"}, None) == ("onbekend", "niet bekend in OpenStreetMap")


def test_parse_overpass():
    stations = {s["id"]: s for s in parse_overpass(DATA)}
    assert "node/9" not in stations and len(stations) == 9
    shell = stations["node/1"]
    assert shell["shop"] == "ja" and shell["shop_reason"] == "winkel op het terrein: Shell Select"
    assert shell["fuels"] == ["Diesel", "LPG"] and shell["truck"] and shell["car_wash"]
    assert shell["hours"][0] == [[0, 1440]] and shell["late"]
    assert {k: stations[k]["shop"] for k in ("node/3", "node/5", "node/6", "node/7", "node/8", "node/10", "node/12")} == {
        "node/3": "nee", "node/5": "onbekend", "node/6": "nee", "node/7": "ja", "node/8": "nee",
        "node/10": "nee", "node/12": "ja"}
    assert stations["node/5"]["name"] == "Esso" and stations["way/13"]["name"] == "Tankstation"


@respx.mock
def test_refresh_and_api(service):
    urls = service.cfg["speedcams"]["overpass_urls"]
    respx.post(urls[0]).mock(return_value=httpx.Response(504))
    respx.post(urls[1]).mock(return_value=httpx.Response(200, json=DATA))
    with TestClient(create_app(service, start_background=False)) as client:
        import asyncio
        assert asyncio.run(service.refresh_fuel_once())
        assert service.db.fuel_count() == 9 and service.status["fuel"]["count"] == 9
        got = client.get("/api/fuel?bbox=4.83,52.37,4.86,52.395").json()
        assert sorted(s["id"] for s in got) == ["node/1", "node/3"]
        assert client.get("/api/fuel?bbox=3,50,6,53").status_code == 422
        assert client.get("/api/config").json()["fuel"]["list_radius_m"] == 5000

    respx.post(urls[1]).mock(return_value=httpx.Response(500))
    for url in urls[2:]:
        respx.post(url).mock(return_value=httpx.Response(500))
    import asyncio
    assert not asyncio.run(service.refresh_fuel_once())
    assert service.db.fuel_count() == 9 and service.status["fuel"]["last_error"]  # oude data blijft
