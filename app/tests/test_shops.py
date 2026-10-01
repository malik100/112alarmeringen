import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from buurtradar.main import create_app
from buurtradar.sources.shops import is_late, parse_opening_hours, parse_overpass, same_store

W = lambda *ranges: [[list(r) for r in ranges]] * 7  # noqa: E731


@pytest.mark.parametrize("raw, expected", [
    ("24/7", [[[0, 1440]]] * 7),
    ("Mo-Su 08:00-22:00", [[[480, 1320]]] * 7),
    ("08:00-20:00", [[[480, 1200]]] * 7),                          # zonder dagen = elke dag
    ("Mo-Sa 08:00-21:00; Su 10:00-18:00", [[[480, 1260]]] * 6 + [[[600, 1080]]]),
    ("Mo-Sa 08:00-21:00, Su 10:00-18:00", [[[480, 1260]]] * 6 + [[[600, 1080]]]),   # komma i.p.v. ;
    ("Mo-Th,Sa 08:00-20:00; Fr 08:00-21:00; Su 09:00-18:00",
     [[[480, 1200]]] * 4 + [[[480, 1260]], [[480, 1200]], [[540, 1080]]]),
    ("Mo,Tu,We,Th,Fr,Sa 08:00-22:00; Su 12:00-22:00", [[[480, 1320]]] * 6 + [[[720, 1320]]]),
    ("Mo-Fr 08:00-12:00,13:00-18:00; Sa 09:00-17:00; Su off",
     [[[480, 720], [780, 1080]]] * 5 + [[[540, 1020]], []]),
    ("Mo-Sa 08:00-20:00; Su,PH 12:00-18:00", [[[480, 1200]]] * 6 + [[[720, 1080]]]),
    ("Mo-Su 07:00-01:00", [[[420, 1500]]] * 7),                    # tot na middernacht
    ("Fr 09:00-13:00", [[], [], [], [], [[540, 780]], [], []]),    # weekmarkt
    ("Mo-Sa 08:00-20:00; Th,Fr 08:00-21:00", [[[480, 1200]]] * 3 + [[[480, 1260]]] * 2 + [[[480, 1200]], []]),
])
def test_parse_opening_hours(raw, expected):
    assert parse_opening_hours(raw) == expected


@pytest.mark.parametrize("raw", [
    None, "", "closed", '"Always open"', "Apr-Sep: Mo-Su 08:00-18:00",
    "Mo-Sa 08:00-22:00; Su 10:00-19:00; May 5 08:00-19:00", "Fr-Sa 10:00-17:30; Su[1] 12:00-17:00",
    "Mo-Fr sunrise-sunset",
])
def test_unknown_formats_are_unknown(raw):
    # liever "onbekend" dan een verkeerde "nu open"
    assert parse_opening_hours(raw) is None


def test_is_late():
    assert is_late(parse_opening_hours("Mo-Su 08:00-23:00"))
    assert is_late(parse_opening_hours("24/7"))
    assert not is_late(parse_opening_hours("Mo-Sa 08:00-22:00"))
    assert not is_late(None)


def test_parse_overpass_kinds():
    data = {"elements": [
        {"type": "node", "id": 1, "lat": 52.1, "lon": 5.1, "tags": {
            "shop": "supermarket", "brand": "Albert Heijn", "name": "Albert Heijn Neude",
            "addr:street": "Neude", "addr:housenumber": "1", "addr:city": "Utrecht",
            "opening_hours": "Mo-Su 08:00-23:00"}},
        {"type": "way", "id": 2, "center": {"lat": 52.2, "lon": 5.2}, "tags": {"shop": "convenience"}},
        {"type": "node", "id": 3, "lat": 52.3, "lon": 5.3, "tags": {"amenity": "marketplace", "name": "Weekmarkt",
                                                                   "opening_hours": "Sa 09:00-16:00"}},
        {"type": "node", "id": 4, "lat": 52.3, "lon": 5.3, "tags": {"shop": "bakery"}},
    ]}
    shops = {s["id"]: s for s in parse_overpass(data)}
    assert set(shops) == {"node/1", "way/2", "node/3"}
    ah = shops["node/1"]
    assert ah["kind"] == "supermarkt" and ah["late"] and ah["address"] == "Neude 1, Utrecht"
    assert ah["hours_source"] == "OpenStreetMap"
    assert shops["way/2"] == {**shops["way/2"], "kind": "buurtwinkel", "name": "Buurtwinkel", "hours": None,
                              "lat": 52.2}
    assert shops["node/3"]["kind"] == "markt"


def test_same_store():
    assert same_store({"brand": "ALDI", "name": "ALDI"}, {"name": "Aldi"})
    assert same_store({"brand": "Albert Heijn", "name": "AH Neude"}, {"name": "Albert Heijn"})
    assert not same_store({"brand": "Jumbo", "name": "Jumbo"}, {"name": "Albert Heijn"})
    assert not same_store({"brand": None, "name": "Supermarkt"}, {"name": "Albert Heijn"})


@respx.mock
async def test_refresh_fills_hours_from_statiegeld_and_api(service):
    service.db.replace_statiegeld([{
        "id": "sg1", "lat": 52.10001, "lon": 5.10001, "name": "Jumbo", "address": "", "hours": W((480, 1320)),
        "hours_raw": [], "materials": [], "payouts": [], "machine": True, "manual": False, "public": True,
        "bulk": False}])
    overpass = {"elements": [
        {"type": "node", "id": 10, "lat": 52.1, "lon": 5.1, "tags": {"shop": "supermarket", "brand": "Jumbo"}},
        {"type": "node", "id": 11, "lat": 52.1, "lon": 5.1003, "tags": {"shop": "supermarket", "brand": "Lidl"}},
    ]}
    for url in service.cfg["speedcams"]["overpass_urls"]:
        respx.post(url).mock(return_value=httpx.Response(200, json=overpass))
    assert await service.refresh_shops_once()
    with TestClient(create_app(service, start_background=False)) as client:
        assert client.get("/api/config").json()["shops"] == {"enabled": True, "min_zoom": 13, "list_radius_m": 1500}
        shops = {s["id"]: s for s in client.get("/api/shops?bbox=5.0,52.0,5.2,52.2").json()}
        assert client.get("/api/shops?bbox=3,50,7,54").status_code == 422
    assert shops["node/10"]["hours_source"] == "Statiegeld Nederland" and shops["node/10"]["hours"][0] == [[480, 1320]]
    assert shops["node/11"]["hours"] is None          # Lidl is geen Jumbo: niet overnemen


def test_link_statiegeld():
    from buurtradar.sources.shops import link_statiegeld
    ah = {"id": "n1", "kind": "supermarkt", "name": "Albert Heijn", "brand": "Albert Heijn", "lat": 52.37871, "lon": 4.84676}
    vomar = {"id": "n2", "kind": "supermarkt", "name": "Vomar", "brand": "Vomar", "lat": 52.37860, "lon": 4.84730}
    ah2 = {"id": "n3", "kind": "supermarkt", "name": "Albert Heijn", "brand": "Albert Heijn", "lat": 52.37880, "lon": 4.84690}
    markt = {"id": "n4", "kind": "markt", "name": "Albert Heijn markt", "lat": 52.37871, "lon": 4.84676}
    points = [
        {"id": "sg-ah", "name": "Albert Heijn", "lat": 52.37872, "lon": 4.84680},
        {"id": "sg-vomar", "name": "Vomar", "lat": 52.37861, "lon": 4.84733},
        {"id": "sg-droppie", "name": "Droppie Recyclewinkel", "lat": 52.37870, "lon": 4.84700},
        {"id": "sg-ver", "name": "Vomar", "lat": 52.3900, "lon": 4.8600},   # te ver weg
    ]
    shops = [ah, vomar, ah2, markt]
    assert link_statiegeld(shops, points) == 2
    assert ah["statiegeld"] == "sg-ah" and vomar["statiegeld"] == "sg-vomar"
    assert "statiegeld" not in ah2          # het AH-punt hoort al bij de dichtstbijzijnde AH
    assert "statiegeld" not in markt        # markten hebben geen inleverpunt
