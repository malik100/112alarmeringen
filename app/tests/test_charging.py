"""Laadpalen: bronverwerking en scenario's voor verschillende soorten gebruikers."""

import gzip
import io
import json

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from sirene.main import create_app
from sirene.sources import charging as ch


def connector(standard="IEC_62196_T2", kw=11, dc=False, tariff="t-ac"):
    return {"standard": standard, "max_electric_power": kw * 1000 if kw else None,
            "power_type": "DC" if dc else "AC_3_PHASE", "tariff_ids": [tariff]}


def evse(*connectors, status="AVAILABLE", caps=("RFID_READER",), restrictions=None):
    return {"status": status, "capabilities": list(caps), "parking_restrictions": restrictions,
            "connectors": list(connectors)}


def location(loc_id, *evses, lat=52.37, lon=4.89, twentyfourseven=True, **extra):
    base = {"id": loc_id, "country_code": "NL", "party_id": "TST", "name": f"Station {loc_id}",
            "address": "Damstraat 1", "postal_code": "1012JL", "city": "Amsterdam",
            "coordinates": {"latitude": str(lat), "longitude": str(lon)},
            "operator": {"name": "TestLaad"}, "opening_times": {"twentyfourseven": twentyfourseven},
            "evses": list(evses)}
    base.update(extra)
    return base


TARIFFS = [
    {"id": "t-ac", "elements": [{"price_components": [
        {"type": "ENERGY", "price": 0.41}, {"type": "PARKING_TIME", "price": 1.2}]}]},
    {"id": "t-dc", "elements": [{"price_components": [
        {"type": "ENERGY", "price": 0.59}, {"type": "FLAT", "price": 0.35}]}]},
    {"id": "t-leeg", "elements": [{"price_components": [{"type": "FLAT", "price": 0.0}]}]},
    {"id": "t-fout", "elements": [{"price_components": [{"type": "ENERGY", "price": 54974.0}]}]},
]

LOCATIONS = [
    # straatpaal, Type 2 11 kW, blokkeertarief
    location("straat", evse(connector()), evse(connector(), status="CHARGING"),
             parking_type="ON_STREET"),
    # snellader met CCS 150 kW en CHAdeMO 50 kW, creditcard
    location("snel", evse(connector("IEC_62196_T2_COMBO", 150, True, "t-dc"),
                          connector("CHADEMO", 50, True, "t-dc"), caps=("CREDIT_CARD_PAYABLE",)),
             lat=52.38),
    # supermarkt: alleen klanten, niet 24/7, Type 2 22 kW
    location("super", evse(connector(kw=22, tariff="t-leeg"), restrictions=["CUSTOMERS"]),
             twentyfourseven=False, lat=52.36),
    # DC zonder opgegeven vermogen
    location("dc-onbekend", evse(connector("IEC_62196_T2_COMBO", None, True, "t-fout")), lat=52.365),
    # verwijderd, en niet gepubliceerd
    location("weg", evse(connector(), status="REMOVED")),
    location("verborgen", evse(connector()), publish=False),
]

AVAILABILITY = {"type": "FeatureCollection", "features": [
    {"id": "NL-TST-straat", "properties": {"availabilities": [
        {"total": 2, "available": 1, "connector_type": "IEC_62196_T2"}]}},
    {"id": "NL-TST-snel", "properties": {"availabilities": [
        {"total": 1, "available": 1, "connector_type": "IEC_62196_T2_COMBO"},
        {"total": 1, "available": 0, "connector_type": "CHADEMO"}]}},
    {"id": "NL-TST-super", "properties": {"availabilities": [
        {"total": 1, "available": 0, "connector_type": "IEC_62196_T2"}]}},
]}


def gz(obj) -> bytes:
    return gzip.compress(json.dumps(obj).encode())


@pytest.fixture
def stations():
    tariffs = ch.parse_tariffs(io.BytesIO(json.dumps(TARIFFS).encode()))
    return {s["id"].split("-", 2)[2]: s for s in ch.parse_locations(io.BytesIO(json.dumps(LOCATIONS).encode()), tariffs)}


@pytest.fixture
def status():
    return ch.parse_availability(io.BytesIO(json.dumps(AVAILABILITY).encode()))


def test_tariffs():
    assert ch.summarize_tariff(TARIFFS[0]) == {"kwh": 0.41, "start": None, "hour": None,
                                               "parking_hour": 1.2, "varies": False}
    assert ch.summarize_tariff(TARIFFS[2]) is None     # alleen nullen = niet ingevuld
    assert ch.summarize_tariff(TARIFFS[3]) is None     # €54.974/kWh = invoerfout


def test_parse_locations(stations):
    assert set(stations) == {"straat", "snel", "super", "dc-onbekend"}
    snel = stations["snel"]
    assert snel["id"] == "NL-TST-snel" and snel["dc"] and snel["max_kw"] == 150
    assert [(c["plug"], c["kw"]) for c in snel["connectors"]] == [("CCS", 150), ("CHAdeMO", 50)]
    assert snel["payment"] == {"creditcard": True, "pinpas": False}
    assert stations["straat"]["points"] == 2 and stations["straat"]["connectors"][0]["count"] == 2
    assert stations["super"]["customers_only"] and stations["super"]["twentyfourseven"] is False


def test_availability(status):
    assert status["NL-TST-snel"] == {"available": 1, "total": 2, "plugs": {"CCS": [1, 1], "CHAdeMO": [0, 1]}}


def select(stations, status, **filters):
    return sorted(k for k, s in stations.items() if ch.matches(s, status.get(s["id"]), **filters))


# --- scenario's: verschillende gebruikers ---------------------------------------

def test_scenario_snelladen_onderweg(stations, status):
    # CCS ≥ 50 kW en nu vrij; DC zonder vermogen telt als snellader, maar status is onbekend
    assert select(stations, status, plugs={"CCS"}, min_kw=50, available=True, public=True) == ["snel"]
    assert select(stations, status, plugs={"CCS"}, min_kw=50) == ["dc-onbekend", "snel"]


def test_scenario_laden_in_de_straat(stations, status):
    assert select(stations, status, plugs={"Type 2"}, available=True, public=True) == ["straat"]


def test_scenario_bestemmingsladen(stations, status):
    # klanten-only telt mee (je bent daar toch), bezet mag ook (je blijft er langer)
    assert select(stations, status, plugs={"Type 2"}, min_kw=11) == ["straat", "super"]
    assert select(stations, status, plugs={"Type 2"}, min_kw=22) == ["super"]


def test_scenario_zonder_laadpas(stations, status):
    assert select(stations, status, card=True, available=True) == ["snel"]


def test_scenario_chademo_is_bezet(stations, status):
    # de CHAdeMO-aansluiting is bezet, ook al is de CCS ernaast vrij
    assert select(stations, status, plugs={"CHAdeMO"}, available=True) == []
    assert select(stations, status, plugs={"CHAdeMO"}) == ["snel"]


def test_plug_and_power_on_same_connector(stations, status):
    # Type 2 ≥ 50 kW bestaat nergens, ook niet bij de snellader (die heeft CCS 150 kW)
    assert select(stations, status, plugs={"Type 2"}, min_kw=50) == []


def test_always_open(stations, status):
    assert "super" not in select(stations, status, always_open=True)


@respx.mock
async def test_refresh_and_api(service):
    respx.get(ch.TARIFFS_URL).mock(return_value=httpx.Response(200, content=gz(TARIFFS)))
    respx.get(ch.LOCATIONS_URL).mock(return_value=httpx.Response(200, content=gz(LOCATIONS)))
    respx.get(ch.AVAILABILITY_URL).mock(return_value=httpx.Response(200, content=gz(AVAILABILITY)))
    assert await service.refresh_charging_once()
    await service.refresh_charging_status_once()          # niemand kijkt: overgeslagen (scheelt 5 MB)
    assert service.charging_status_ts is None
    await service.refresh_charging_status_once(force=True)
    assert service.status["charging"]["count"] == 4 and service.charging_status_ts

    with TestClient(create_app(service, start_background=False)) as client:
        cfg = client.get("/api/config").json()["charging"]
        assert cfg == {"enabled": True, "min_zoom": 13, "list_radius_m": 3000}
        res = client.get("/api/charging?bbox=4.8,52.3,5.0,52.4&plugs=CCS&min_kw=50&available=true").json()
        assert [s["id"] for s in res["stations"]] == ["NL-TST-snel"]
        assert res["stations"][0]["status"]["available"] == 1 and res["status_ts"]
        near = client.get("/api/charging?bbox=4.8,52.3,5.0,52.4&near=52.37,4.89&limit=2").json()
        assert [s["id"] for s in near["stations"]] == ["NL-TST-straat", "NL-TST-dc-onbekend"]
        assert near["truncated"] and near["stations"][0]["distance_m"] == 0
        assert client.get("/api/charging?bbox=3,50,7,54").status_code == 422


@respx.mock
async def test_status_failure_keeps_previous(service):
    service.charging_status = {"x": {"available": 1, "total": 1, "plugs": {}}}
    respx.get(ch.AVAILABILITY_URL).mock(return_value=httpx.Response(503))
    await service.refresh_charging_status_once(force=True)
    assert service.charging_status == {"x": {"available": 1, "total": 1, "plugs": {}}}
    assert service.status["charging_status"]["last_error"]
