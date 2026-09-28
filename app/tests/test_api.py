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
