import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from sirene.main import create_app
from sirene.sources.statiegeld import DEFAULT_URL, parse_day, parse_features


def feature(fid, name="Albert Heijn", lat=52.3731, lon=4.8926, **props):
    base = {"id": fid, "bedrijf": name, "straat_huisnr": "Damstraat 1",
            "postcode_plaats": "1012 JL Amsterdam", "lat": lat, "lng": lon,
            "groot_pet": "Ja", "klein_pet": "Ja", "blik": "Ja", "glas": "Nee", "krat": "Nee",
            "bonnetje": "Ja", "contant": "Nee", "retourpinnen": "Nee", "tikkie": "Nee",
            "app": "Nee", "droppie": "Nee", "donatie": "Ja",
            "automaat_aanwezig": "Ja", "handmatig_inleverpunt": "Nee",
            "vrij_toegankelijk": "Ja", "bulk": "Nee",
            "ma": "08:00–20:00", "di": "08:00–12:00, 13:00–17:00", "woe": "24 uur geopend",
            "do": "Gesloten", "vrij": "10:00–01:00", "za": "NA", "zo": "raar formaat"}
    base.update(props)
    return {"type": "Feature", "id": f"inleverpunten.{fid}",
            "geometry": {"type": "Point", "coordinates": [round(lon, 4), round(lat, 4)]},
            "properties": base}


@pytest.mark.parametrize("raw, expected", [
    ("08:00–20:00", [[480, 1200]]),
    ("08:00–12:00, 13:00–17:00", [[480, 720], [780, 1020]]),
    ("24 uur geopend", [[0, 1440]]),
    ("Gesloten", []),
    ("NA", None),
    ("", None),
    ("10:00–01:00", [[600, 1500]]),   # over middernacht
    ("08:00–00:00", [[480, 1440]]),   # tot middernacht
    ("op afspraak", None),
])
def test_parse_day(raw, expected):
    assert parse_day(raw) == expected


def test_parse_features():
    data = {"features": [feature(1), feature(2), feature(3, name="- Politie Alkmaar", lat=52.6, lon=4.7)]}
    points = parse_features(data)
    assert len(points) == 2  # 1 en 2 zijn dubbel (zelfde naam en plek)
    ah, politie = points
    assert ah["lat"] == 52.3731 and ah["lon"] == 4.8926
    assert ah["address"] == "Damstraat 1, 1012 JL Amsterdam"
    assert ah["hours"][0] == [[480, 1200]] and ah["hours"][5] is None and ah["hours"][6] is None
    assert ah["hours_raw"][5] == "NA"
    assert ah["materials"] == ["Grote PET-fles", "Kleine PET-fles", "Blik"]
    assert ah["payouts"] == ["Bonnetje", "Doneren"]
    assert ah["machine"] and ah["public"] and not ah["manual"]
    assert politie["name"] == "Politie Alkmaar"


@respx.mock
async def test_refresh_and_bbox_api(service):
    respx.get(DEFAULT_URL).mock(return_value=httpx.Response(200, json={"features": [
        feature(1), feature(2, name="Jumbo", lat=51.92, lon=4.48)]}))
    assert await service.refresh_statiegeld_once()
    assert service.status["statiegeld"]["count"] == 2

    with TestClient(create_app(service, start_background=False)) as client:
        cfg = client.get("/api/config").json()["statiegeld"]
        assert cfg == {"enabled": True, "min_zoom": 12, "list_radius_m": 2000}
        points = client.get("/api/statiegeld?bbox=4.8,52.3,5.0,52.4").json()
        assert [p["name"] for p in points] == ["Albert Heijn"]
        assert client.get("/api/statiegeld?bbox=3,50,7,54").status_code == 422   # te groot
        assert client.get("/api/statiegeld?bbox=kapot").status_code == 422


@respx.mock
async def test_refresh_failure_keeps_old_data(service):
    respx.get(DEFAULT_URL).mock(return_value=httpx.Response(200, json={"features": [feature(1)]}))
    assert await service.refresh_statiegeld_once()
    respx.get(DEFAULT_URL).mock(return_value=httpx.Response(503))
    assert not await service.refresh_statiegeld_once()
    assert service.db.statiegeld_count() == 1
    assert service.status["statiegeld"]["last_error"]
