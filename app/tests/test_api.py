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


def test_home_location(service):
    with TestClient(create_app(service, start_background=False)) as client:
        assert client.get("/api/location/home").json() is None
        assert client.get("/api/location").json() is None
        home = client.put("/api/location/home", json={"lat": 52.378, "lon": 4.846}).json()
        assert home == {"lat": 52.378, "lon": 4.846}
        loc = client.get("/api/location").json()
        assert loc["source"] == "vast" and loc["lat"] == 52.378
        # Een live locatie gaat voor op de vaste plek ...
        client.post("/api/location", json={"lat": 52.1, "lon": 5.1, "accuracy": 5})
        assert client.get("/api/location").json()["source"] == "browser"
        # ... en de vaste plek opnieuw kiezen verdringt een verse live locatie niet.
        client.put("/api/location/home", json={"lat": 52.0, "lon": 5.0})
        assert client.get("/api/location").json()["source"] == "browser"
        client.delete("/api/location/home")
        assert client.get("/api/location/home").json() is None
        assert client.put("/api/location/home", json={"lat": 99, "lon": 5}).status_code == 422


def test_search(service):
    import respx
    from sirene.config import DEFAULTS
    from tests.conftest import pdok_response, pdok_doc
    with respx.mock:
        respx.get(DEFAULTS["geocoder"]["pdok_url"]).mock(return_value=pdok_response(
            pdok_doc("Bos en Lommerplein", "Amsterdam", 4.8459, 52.3776),
            {"type": "woonplaats", "weergavenaam": "Amsterdam, Amsterdam"}))  # zonder punt: overslaan
        with TestClient(create_app(service, start_background=False)) as client:
            got = client.get("/api/search?q=bos en lommerplein").json()
            assert got == [{"name": "Bos en Lommerplein, Amsterdam", "type": "weg", "lat": 52.3776, "lon": 4.8459}]
            assert client.get("/api/search?q=b").status_code == 422


def test_password_protection(cfg):
    import httpx as _httpx
    from sirene.service import Service
    cfg["access"]["password"] = "geheim"
    svc = Service(cfg, client=_httpx.AsyncClient())
    with TestClient(create_app(svc, start_background=False)) as client:
        assert client.get("/healthz").json() == {"ok": True}
        assert client.get("/api/config").status_code == 401
        r = client.get("/", follow_redirects=False)
        assert r.status_code == 303 and r.headers["location"].startswith("/login")
        assert "Wachtwoord" in client.get("/login").text
        assert client.post("/api/login", json={"password": "fout"}).status_code == 401
        assert client.post("/api/login", json={"password": "geheim"}).status_code == 200
        assert client.get("/api/config").json()["password_protected"] is True
        assert "Buurtradar" in client.get("/").text
        assert client.post("/api/logout").status_code == 200
        assert client.get("/api/config").status_code == 401
        assert client.get("/api/config", headers={"Authorization": "Bearer geheim"}).status_code == 200
        assert client.get("/api/config", headers={"Authorization": "Bearer nee"}).status_code == 401


def test_no_password_means_open(client):
    assert client.get("/api/config").json()["password_protected"] is False
    assert client.get("/login", follow_redirects=False).status_code == 303
