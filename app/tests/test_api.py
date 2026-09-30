import time

import pytest
from fastapi.testclient import TestClient

from sirene.main import create_app


@pytest.fixture
def client(service):
    with TestClient(create_app(service, start_background=False)) as c:
        yield c


def test_config_and_index(client):
    cfg = client.get("/api/config").json()
    assert cfg["radius_m"] == 1000 and cfg["notifications_enabled"] is False
    assert "Buurtradar" in client.get("/").text
    assert client.get("/static/vendor/leaflet/leaflet.js").status_code == 200


def test_post_location_and_incident_distance(client, service):
    service.db.insert_incident({
        "guid": "g", "ts": time.time(), "title": "a1 x", "description": "Ambulance met spoed naar X in Y",
        "discipline": "ambulance", "priority": 1, "lat": 52.3278, "lon": 4.9362, "precision": "straat",
    })
    assert client.get("/api/location").json() is None
    r = client.post("/api/location", json={"lat": 52.3276, "lon": 4.9340, "accuracy": 12})
    assert r.status_code == 200 and r.json()["source"] == "browser"
    [inc] = client.get("/api/incidents?minutes=30").json()
    assert inc["sirene"] is True and 100 < inc["distance_m"] < 200


def test_browser_location_can_be_disabled(client, service):
    service.cfg["location"]["browser"] = False
    assert client.post("/api/location", json={"lat": 52, "lon": 5}).status_code == 403


def test_invalid_location_rejected(client):
    assert client.post("/api/location", json={"lat": 123, "lon": 5}).status_code == 422


def test_frontend_is_revalidated_after_updates(client):
    """Na een update mag de browser geen oude style.css/app.js bij een nieuwe pagina gebruiken."""
    for path in ("/", "/static/style.css", "/static/app.js", "/static/icons.svg"):
        r = client.get(path)
        assert r.status_code == 200 and r.headers["cache-control"] == "no-cache", path
    # Ongewijzigd bestand: alleen een korte controle, geen nieuwe download.
    etag = client.get("/static/style.css").headers["etag"]
    assert client.get("/static/style.css", headers={"If-None-Match": etag}).status_code == 304
    assert "cache-control" not in client.get("/static/vendor/leaflet/leaflet.js").headers


def test_proef_page(client):
    """Proefversie met MapLibre: pagina, lokaal meegeleverde bibliotheek en de kaartstijlen."""
    r = client.get("/proef")
    assert r.status_code == 200 and "maplibre-gl.js" in r.text and r.headers["cache-control"] == "no-cache"
    assert client.get("/static/vendor/maplibre/maplibre-gl.js").status_code == 200
    m = client.get("/api/config").json()["map"]
    assert m["vector_style_light"].startswith("https://") and m["vector_style_dark"].startswith("https://")
