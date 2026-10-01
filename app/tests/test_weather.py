import httpx
import respx
from fastapi.testclient import TestClient

from buurtradar.main import create_app
from buurtradar.sources import weather as w

FEED = {"actual": {"sunrise": "2026-10-01T07:38:00", "sunset": "2026-10-01T19:16:00", "stationmeasurements": [
    {"stationid": 1, "stationname": "Meetstation Schiphol", "lat": 52.3, "lon": 4.77, "timestamp": "2026-10-01T01:40:00",
     "weatherdescription": "Zwaar bewolkt", "iconurl": "https://x/cc.png", "temperature": 19.5, "feeltemperature": 19.5,
     "windspeedBft": 3, "windspeed": 4.0, "winddirection": "OZO", "humidity": 91.0, "rainFallLastHour": 0.1},
    {"stationid": 2, "stationname": "Meetstation Boei", "lat": 52.4, "lon": 4.8, "windspeedBft": 5},   # geen temperatuur
]}, "forecast": {"weatherreport": {"title": "Nat", "summary": "Regen.", "published": "2026-10-01T05:00:00", "url": "u"},
                 "shortterm": {"forecast": "Buien."},
                 "fivedayforecast": [{"day": "2026-10-02T00:00:00", "mintemperature": "11", "maxtemperature": "20",
                                      "rainChance": 20, "sunChance": 50, "windDirection": "zw", "wind": 3,
                                      "mmRainMin": 0.0, "mmRainMax": 1.0, "weatherdescription": "Mix", "iconurl": "https://x/b.png"}]}}


def test_parse_feed_and_nearest():
    f = w.parse_feed(FEED)
    assert len(f["stations"]) == 2 and f["days"][0]["day"] == "2026-10-02" and f["days"][0]["wind_dir"] == "ZW"
    assert f["report"]["title"] == "Nat" and f["shortterm"] == "Buien."
    assert f["sunrise"] and f["stations"][0]["icon"] == "cc"
    near = w.nearest_station(f["stations"], 52.39, 4.81)  # de boei is dichterbij maar meet geen temperatuur
    assert near["name"] == "Schiphol" and near["distance_m"] > 1000


def test_raintext_and_summary():
    rain = w.parse_raintext("000|02:00\n077|02:05\n109|02:10\n000|02:15\n")
    assert [r["mm_h"] for r in rain] == [0.0, 0.1, 1.0, 0.0]
    assert w.rain_summary(rain) == "Regen vanaf 02:05"
    assert w.rain_summary([{"time": "10:00", "mm_h": 0}] * 3) == "Droog de komende 2 uur"
    assert w.rain_summary([{"time": "10:00", "mm_h": 3}, {"time": "10:05", "mm_h": 0}, {"time": "10:10", "mm_h": 0}]) == "Regen, droog vanaf 10:05"
    assert w.rain_summary([{"time": "10:00", "mm_h": 0}, {"time": "10:05", "mm_h": 6}]) == "Zware regen vanaf 10:05"
    assert w.lki_label(3) == "goed" and w.lki_label(7) == "onvoldoende" and w.lki_label(11) == "zeer slecht"


@respx.mock
async def test_service_and_api(service):
    respx.get(w.FEED_URL).mock(return_value=httpx.Response(200, json=FEED))
    respx.get(w.RAIN_URL).mock(return_value=httpx.Response(200, text="000|02:00\n100|02:05\n"))
    respx.get(w.LKI_URL).mock(return_value=httpx.Response(200, json={
        "pagination": {"last_page": 1},
        "data": [{"station_number": "NL49014", "formula": "LKI", "value": 3, "timestamp_measured": "2026-09-30T23:00:00+00:00"},
                 {"station_number": "NL49014", "formula": "LKI", "value": 9, "timestamp_measured": "2026-09-30T22:00:00+00:00"}]}))
    respx.get(w.STATION_URL.format(number="NL49014")).mock(return_value=httpx.Response(200, json={
        "data": {"location": "Amsterdam-Vondelpark", "municipality": "Amsterdam",
                 "geometry": {"type": "point", "coordinates": [4.866208, 52.359714]}}}))
    await service.refresh_weather_once()
    await service.refresh_air_once()
    assert service.status["weather"]["last_ok"] and service.status["air"]["count"] == 1
    assert service.db.meta_get("lki_stations")["NL49014"]["lat"] == 52.359714   # bewaard, niet elk uur opnieuw
    with TestClient(create_app(service, start_background=False)) as client:
        got = client.get("/api/weather?lat=52.378&lon=4.846").json()
        assert got["station"]["name"] == "Schiphol" and got["rain_summary"] == "Lichte regen vanaf 02:05"
        assert got["air"]["value"] == 3 and got["air"]["label"] == "goed" and got["air"]["name"] == "Amsterdam-Vondelpark"
        assert got["days"][0]["max"] == "20" and got["report"]["title"] == "Nat"
        assert respx.get(w.RAIN_URL).call_count == 1
        client.get("/api/weather?lat=52.379&lon=4.847")             # zelfde kilometer: uit de cache
        assert respx.get(w.RAIN_URL).call_count == 1
        assert client.get("/api/weather").json()["station"] is None   # geen locatie bekend
