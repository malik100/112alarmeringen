from datetime import date

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from sirene.main import create_app
from sirene.sources import npr

TODAY = date(2026, 9, 28)
SQUARE = "POLYGON ((4.89 52.37, 4.90 52.37, 4.90 52.38, 4.89 52.38, 4.89 52.37))"


def dataset(**overrides):
    """Minimale NPR-gegevens: één betaalde zone in Amsterdam met dagkaart en een garage."""
    data = {
        "beheerder": [{"areamanagerid": "363", "areamanagerdesc": "Amsterdam",
                       "startdateareamanagerid": "20050101", "url": "www.amsterdam.nl"}],
        "gebied": [{"areamanagerid": "363", "areaid": "T11V", "areadesc": "Tariefzone 1",
                    "startdatearea": "20050101", "enddatearea": "29991231"}],
        "geometrie": [
            {"areamanagerid": "363", "areaid": "T11V", "startdatearea": "2005-01-01T00:00:00.000",
             "areageometryastext": SQUARE},
            {"areamanagerid": "363", "areaid": "OUD", "startdatearea": "2005-01-01T00:00:00.000",
             "enddatearea": "2020-01-01T00:00:00.000", "areageometryastext": SQUARE},
            {"areamanagerid": "363", "areaid": "GAR", "startdatearea": "2005-01-01T00:00:00.000",
             "areageometryastext": "POINT (4.895 52.375)"},
        ],
        "gebiedregeling": [
            {"areamanagerid": "363", "areaid": "T11V", "regulationid": "BP11V", "usageid": "BETAALDP",
             "startdatearearegulation": "20050101000000", "enddatearearegulation": "29991231235959"},
            {"areamanagerid": "363", "areaid": "T11V", "regulationid": "DAG", "usageid": "BETAALDP",
             "startdatearearegulation": "20050101000000"},
            {"areamanagerid": "363", "areaid": "OUD", "regulationid": "BP11V", "usageid": "BETAALDP",
             "startdatearearegulation": "20050101000000"},
            {"areamanagerid": "363", "areaid": "GAR", "regulationid": "GAR", "usageid": "GARAGEP",
             "startdatearearegulation": "20050101000000"},
        ],
        "regeling": [
            {"areamanagerid": "363", "regulationid": "BP11V", "regulationdesc": "Basis",
             "regulationtype": "B", "startdateregulation": "20050101"},
            {"areamanagerid": "363", "regulationid": "DAG", "regulationdesc": "Dagkaart 0919",
             "regulationtype": "A", "startdateregulation": "20050101"},
            {"areamanagerid": "363", "regulationid": "GAR", "regulationdesc": "Garage",
             "regulationtype": "B", "startdateregulation": "20050101"},
        ],
        "tijdvak": [
            *({"areamanagerid": "363", "regulationid": "BP11V", "daytimeframe": day,
               "starttimetimeframe": "900", "endtimetimeframe": "2400", "claimrightpossible": "J",
               "farecalculationcode": "TC1", "maxdurationright": "0",
               "startdatetimeframe": "20160705000000"} for day in npr.WEEKDAYS[:6]),
            {"areamanagerid": "363", "regulationid": "BP11V", "daytimeframe": "ZONDAG",
             "starttimetimeframe": "0", "endtimetimeframe": "2400", "claimrightpossible": "N",
             "startdatetimeframe": "20160705000000"},
            {"areamanagerid": "363", "regulationid": "BP11V", "daytimeframe": "KONINGSDAG",
             "starttimetimeframe": "0", "endtimetimeframe": "2400", "claimrightpossible": "J",
             "farecalculationcode": "TC0", "startdatetimeframe": "20160705000000"},
            {"areamanagerid": "363", "regulationid": "DAG", "daytimeframe": "MAANDAG",
             "starttimetimeframe": "900", "endtimetimeframe": "1900", "claimrightpossible": "J",
             "farecalculationcode": "D0919", "startdatetimeframe": "20050101000000"},
            {"areamanagerid": "363", "regulationid": "GAR", "daytimeframe": "MAANDAG",
             "starttimetimeframe": "0", "endtimetimeframe": "2400", "claimrightpossible": "J",
             "farecalculationcode": "G24", "startdatetimeframe": "20050101000000"},
        ],
        "tariefdeel": [
            # oud tarief (nog niet beëindigd) en het nieuwe: het nieuwste telt
            {"areamanagerid": "363", "farecalculationcode": "TC1", "startdatefarepart": "20250101",
             "startdurationfarepart": "0", "enddurationfarepart": "999999",
             "amountfarepart": "0.125", "stepsizefarepart": "1"},
            {"areamanagerid": "363", "farecalculationcode": "TC1", "startdatefarepart": "20260112",
             "startdurationfarepart": "0", "enddurationfarepart": "999999",
             "amountfarepart": "0.13416667", "stepsizefarepart": "1"},
            {"areamanagerid": "363", "farecalculationcode": "D0919", "startdatefarepart": "20260112",
             "startdurationfarepart": "0", "enddurationfarepart": "999999",
             "amountfarepart": "48.30", "stepsizefarepart": "600"},
            {"areamanagerid": "363", "farecalculationcode": "G24", "startdatefarepart": "20200722",
             "startdurationfarepart": "0", "enddurationfarepart": "999999",
             "amountfarepart": "1.00", "stepsizefarepart": "20"},
        ],
        "gebruiksdoel": [{"areamanagerid": "363", "usageid": "BETAALDP", "usageiddesc": "Betaald parkeren",
                          "startdateusageid": "20050101"}],
        "specificaties": [{"areamanagerid": "363", "areaid": "GAR", "capacity": "335",
                           "maximumvehicleheight": "200", "startdatespecifications": "20170613"}],
        "verkooppunt": [],
        "geo_verkooppunt": [],
    }
    data.update(overrides)
    return data


def test_wkt_to_geojson():
    assert npr.wkt_to_geojson("POINT (4.1 52.2)") == {"type": "Point", "coordinates": [4.1, 52.2]}
    poly = npr.wkt_to_geojson(SQUARE)
    assert poly["type"] == "Polygon" and len(poly["coordinates"][0]) == 5
    multi = npr.wkt_to_geojson(
        "MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)), ((2 2, 3 2, 3 3, 2 2), (2.1 2.1, 2.2 2.1, 2.2 2.2, 2.1 2.1)))")
    assert multi["type"] == "MultiPolygon" and len(multi["coordinates"]) == 2
    assert len(multi["coordinates"][1]) == 2  # met gat
    assert npr.wkt_to_geojson("GEOMETRYCOLLECTION (POLYGON ((0 0, 1 0, 1 1, 0 0)))")["type"] == "Polygon"
    assert npr.wkt_to_geojson("") is None


def test_contains_respects_holes():
    geom = npr.wkt_to_geojson("POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0), (4 4, 6 4, 6 6, 4 6, 4 4))")
    assert npr.contains(geom, 1, 1)
    assert not npr.contains(geom, 5, 5)
    assert not npr.contains(geom, 11, 5)


@pytest.mark.parametrize("parts, text, rate", [
    ([{"amountfarepart": "0.13416667", "stepsizefarepart": "1"}], "€8,05 per uur", 8.05),
    ([{"amountfarepart": "1.00", "stepsizefarepart": "20"}], "€3,00 per uur", 3.0),
    ([{"amountfarepart": "48.30", "stepsizefarepart": "600"}], "€48,30 per 10 uur", 4.83),
    ([{"amountfarepart": "0", "stepsizefarepart": "1"}], "gratis", 0.0),
    ([{"startdurationfarepart": "0", "enddurationfarepart": "60", "amountfarepart": "1.00", "stepsizefarepart": "60"},
      {"startdurationfarepart": "60", "enddurationfarepart": "999999", "amountfarepart": "0.05", "stepsizefarepart": "1"}],
     "eerste 1 uur €1,00 per uur; daarna €3,00 per uur", 1.0),
    # Amsterdam-Noord "flatrate": vast bedrag voor de eerste 3 uur, daarna per uur.
    ([{"startdurationfarepart": "0", "enddurationfarepart": "180", "amountfarepart": "1.72", "stepsizefarepart": "180"},
      {"startdurationfarepart": "180", "enddurationfarepart": "999999", "amountfarepart": "0.02866667",
       "stepsizefarepart": "1"}],
     "eerste 3 uur samen €1,72; daarna €1,72 per uur", 1.72),
])
def test_describe_fare(parts, text, rate):
    assert npr.describe_fare(parts) == {"text": text, "rate_h": rate}


def test_build_zones():
    zones = {z["id"]: z for z in npr.build_zones(dataset(), TODAY)}
    assert set(zones) == {"363:T11V", "363:GAR"}           # verlopen geometrie valt af
    zone = zones["363:T11V"]
    assert zone["kind"] == "betaald" and zone["manager"] == "Amsterdam"
    assert zone["fares"]["TC1"] == {"text": "€8,05 per uur", "rate_h": 8.05}   # nieuwste tarief
    assert zone["schedule"][0] == [{"s": 540, "e": 1440, "fare": "TC1", "max": None}]
    assert zone["schedule"][6] == []                         # claimrightpossible N: vrij
    assert zone["special_days"] is True                      # Koningsdag
    assert [x["name"] for x in zone["extras"]] == ["Dagkaart 0919"]
    assert zone["bbox"] == [4.89, 52.37, 4.9, 52.38]
    garage = zones["363:GAR"]
    assert garage["kind"] == "garage" and garage["geometry"]["type"] == "Point"
    assert garage["capacity"] == 335 and garage["fares"]["G24"]["text"] == "€3,00 per uur"


def test_area_with_several_polygons_keeps_all_of_them():
    """Amsterdam registreert één tariefzone als veel losse vlakken met dezelfde gebiedscode.

    Vroeger overschreef elk vlak het vorige (zelfde id in de database), waardoor van een zone
    als T12B (Oost, De Pijp) maar één klein stukje overbleef.
    """
    data = dataset()
    east = "POLYGON ((4.92 52.36, 4.93 52.36, 4.93 52.37, 4.92 52.37, 4.92 52.36))"
    old = "POLYGON ((5.00 52.00, 5.01 52.00, 5.01 52.01, 5.00 52.01, 5.00 52.00))"
    data["geometrie"] += [
        dict(data["geometrie"][0], areageometryastext=east),
        dict(data["geometrie"][0], areageometryastext=SQUARE),  # exact dubbel: één keer bewaren
        dict(data["geometrie"][0], areageometryastext=old, enddatearea="2023-07-03T00:00:00.000"),
    ]
    zones = {z["id"]: z for z in npr.build_zones(data, TODAY)}
    assert sorted(zones) == ["363:GAR", "363:T11V"]
    geom = zones["363:T11V"]["geometry"]
    assert geom["type"] == "MultiPolygon" and len(geom["coordinates"]) == 2
    assert npr.contains(geom, 4.895, 52.375) and npr.contains(geom, 4.925, 52.365)
    assert not npr.contains(geom, 5.005, 52.005)                # opgeheven vlak telt niet
    assert zones["363:T11V"]["bbox"] == [4.89, 52.36, 4.93, 52.38]


def test_duplicate_registrations_are_merged():
    data = dataset()
    data["geometrie"].append(dict(data["geometrie"][0], areaid="K_T11V",
                                  areageometryastext=SQUARE.replace("4.89 52.37", "4.890001 52.37")))
    data["gebiedregeling"] += [dict(r, areaid="K_T11V") for r in data["gebiedregeling"] if r["areaid"] == "T11V"]
    data["gebied"].append(dict(data["gebied"][0], areaid="K_T11V"))
    zones = npr.build_zones(data, TODAY)
    assert sorted(z["id"] for z in zones) == ["363:GAR", "363:T11V"]


def test_visitor_registration_merged_into_paid_zone():
    data = dataset()
    data["geometrie"].append(dict(data["geometrie"][0], areaid="K_T11V"))
    data["gebied"].append(dict(data["gebied"][0], areaid="K_T11V"))
    data["gebiedregeling"].append({"areamanagerid": "363", "areaid": "K_T11V", "regulationid": "BP11V",
                                   "usageid": "BEZOEKP", "startdatearearegulation": "20050101000000"})
    data["gebruiksdoel"].append({"areamanagerid": "363", "usageid": "BEZOEKP",
                                 "usageiddesc": "Parkeren bezoeker", "startdateusageid": "20050101"})
    zones = {z["id"]: z for z in npr.build_zones(data, TODAY)}
    assert sorted(zones) == ["363:GAR", "363:T11V"]
    zone = zones["363:T11V"]
    assert zone["usages"] == ["Betaald parkeren", "Parkeren bezoeker"]
    assert [x["name"] for x in zone["extras"]] == ["Dagkaart 0919"]


def test_skipped_usages():
    data = dataset()
    data["gebiedregeling"] = [dict(r, usageid="ZE_ONTHEF") for r in data["gebiedregeling"]]
    assert npr.build_zones(data, TODAY) == []


@respx.mock
async def test_refresh_and_api(service):
    data = dataset()
    for name, ds in npr.DATASETS.items():
        respx.get(f"{npr.BASE_URL}/{ds}.json").mock(return_value=httpx.Response(200, json=data[name]))
    assert await service.refresh_parking_once()
    assert service.status["parking"]["count"] == 2

    with TestClient(create_app(service, start_background=False)) as client:
        assert client.get("/api/config").json()["parking"] == {"enabled": True, "min_zoom": 13}
        zones = client.get("/api/parking?bbox=4.88,52.36,4.91,52.39").json()
        assert {z["id"] for z in zones} == {"363:T11V", "363:GAR"}
        only = client.get("/api/parking?bbox=4.88,52.36,4.91,52.39&kinds=garage").json()
        assert [z["id"] for z in only] == ["363:GAR"]
        assert client.get("/api/parking?bbox=3,50,7,54").status_code == 422
        here = client.get("/api/parking/at?lat=52.375&lon=4.895").json()
        assert [z["id"] for z in here] == ["363:T11V"]        # punten (garage) tellen niet
        assert client.get("/api/parking/at?lat=52.5&lon=4.895").json() == []


@respx.mock
async def test_refresh_failure_keeps_old_data(service):
    respx.get(url__startswith=npr.BASE_URL).mock(return_value=httpx.Response(503))
    assert not await service.refresh_parking_once()
    assert service.status["parking"]["last_error"]


async def test_new_parser_version_triggers_immediate_refresh(service):
    """Na een update met betere verwerking niet een dag wachten op de volgende verversing."""
    import time
    service.db.meta_set("parking_updated", time.time())       # net ververst met de oude versie
    service.db.meta_set("parking_version", npr.PARSER_VERSION - 1)
    service.cfg.update({k: dict(service.cfg[k], enabled=False) for k in
                        ("speedcams", "statiegeld", "news", "shops", "charging", "roadworks", "announcements")})
    service.cfg["p2000"]["feeds"] = []
    service.start()
    try:
        assert service.db.meta_get("parking_updated") == 0
    finally:
        await service.stop()


def test_visitor_permit_area_without_fare_is_permit_zone():
    """Rotterdam "Sector 12": bezoekersregeling zonder tarief = vergunningzone, geen betaalzone."""
    data = dataset()
    data["geometrie"].append(dict(data["geometrie"][0], areaid="SECTOR12",
                                  areageometryastext=SQUARE.replace("4.89", "4.91").replace("4.90", "4.92")))
    data["gebied"].append(dict(data["gebied"][0], areaid="SECTOR12", areadesc="Sector 12"))
    data["gebiedregeling"].append({"areamanagerid": "363", "areaid": "SECTOR12", "regulationid": "BZ",
                                   "usageid": "BEZOEKP", "startdatearearegulation": "20050101000000"})
    data["regeling"].append({"areamanagerid": "363", "regulationid": "BZ", "regulationdesc": "Bezoekersparkeren",
                             "regulationtype": "B", "startdateregulation": "20050101"})
    data["tijdvak"].append({"areamanagerid": "363", "regulationid": "BZ", "daytimeframe": "MAANDAG",
                            "starttimetimeframe": "900", "endtimetimeframe": "2300", "claimrightpossible": "J",
                            "startdatetimeframe": "20170523000000"})
    zones = {z["id"]: z for z in npr.build_zones(data, TODAY)}
    assert zones["363:SECTOR12"]["kind"] == "vergunning"
    assert zones["363:T11V"]["kind"] == "betaald"       # gewone betaalzone blijft betaald


def meter_zone(data):
    """Betaald gebied zonder kaartvlak (bijv. Maastricht), wel met twee parkeerautomaten."""
    data["gebied"].append(dict(data["gebied"][0], areaid="MAAS1", areadesc="Maastricht zone 1"))
    data["gebiedregeling"].append({"areamanagerid": "363", "areaid": "MAAS1", "regulationid": "BP11V",
                                   "usageid": "BETAALDP", "startdatearearegulation": "20050101000000"})
    data["verkooppunt"] = [
        {"areamanagerid": "363", "areaid": "MAAS1", "sellingpointid": "A1", "startdatesellingpoint": "20200101",
         "enddatesellingpoint": "29991231"},
        {"areamanagerid": "363", "areaid": "MAAS1", "sellingpointid": "A2", "startdatesellingpoint": "20200101"},
        {"areamanagerid": "363", "areaid": "MAAS1", "sellingpointid": "OUD", "startdatesellingpoint": "20100101",
         "enddatesellingpoint": "20150101"},
        {"areamanagerid": "363", "areaid": "T11V", "sellingpointid": "A3", "startdatesellingpoint": "20200101"},
    ]
    data["geo_verkooppunt"] = [
        {"areamanagerid": "363", "sellingpointid": sid, "location": {"type": "Point", "coordinates": xy}}
        for sid, xy in [("A1", [5.690, 50.850]), ("A2", [5.692, 50.851]), ("OUD", [5.70, 50.86]), ("A3", [4.895, 52.375])]
    ]
    return data


def test_area_without_polygon_gets_parking_meters():
    zones = {z["id"]: z for z in npr.build_zones(meter_zone(dataset()), TODAY)}
    zone = zones["363:MAAS1"]
    assert zone["kind"] == "betaald" and zone["approx"] == "automaten"
    assert zone["geometry"] == {"type": "MultiPoint", "coordinates": [[5.69, 50.85], [5.692, 50.851]]}  # zonder oude
    assert zone["bbox"] == [5.69, 50.85, 5.692, 50.851]
    assert zone["fares"]["TC1"]["text"] == "€8,05 per uur"
    # Een gebied mét kaartvlak houdt zijn vlak; automaten veranderen daar niets aan.
    assert zones["363:T11V"]["geometry"]["type"] == "Polygon" and zones["363:T11V"]["approx"] is None


@respx.mock
def test_parking_here_uses_nearby_meters(service):
    data = meter_zone(dataset())
    for name, ds in npr.DATASETS.items():
        respx.get(f"{npr.BASE_URL}/{ds}.json").mock(return_value=httpx.Response(200, json=data[name]))
    import asyncio
    asyncio.run(service.refresh_parking_once())
    with TestClient(create_app(service, start_background=False)) as client:
        here = client.get("/api/parking/at?lat=50.8505&lon=5.6905").json()   # ~65 m van automaat A1
        assert [z["id"] for z in here] == ["363:MAAS1"] and 40 < here[0]["approx_distance_m"] < 100
        assert client.get("/api/parking/at?lat=50.86&lon=5.72").json() == []   # te ver weg
        # In een getekende betaalzone: geen gok op basis van automaten.
        assert [z["id"] for z in client.get("/api/parking/at?lat=52.375&lon=4.895").json()] == ["363:T11V"]


def test_visitor_rate_area_is_permit_zone():
    """Maastricht "Centrum-West bezoek": bezoekerstarief €1,85 = geen betaalzone voor iedereen."""
    data = dataset()
    data["geometrie"].append(dict(data["geometrie"][0], areaid="CWB",
                                  areageometryastext=SQUARE.replace("4.89", "4.93").replace("4.90", "4.94")))
    data["gebied"].append(dict(data["gebied"][0], areaid="CWB", areadesc="Centrum-West bezoek"))
    data["gebiedregeling"].append({"areamanagerid": "363", "areaid": "CWB", "regulationid": "BP11V",
                                   "usageid": "BEZOEKP", "startdatearearegulation": "20050101000000"})
    zones = {z["id"]: z for z in npr.build_zones(data, TODAY)}
    assert zones["363:CWB"]["kind"] == "vergunning"
    assert "_visitor_only" not in zones["363:CWB"]
