import datetime as dt
import time

from fastapi.testclient import TestClient

from buurtradar.location import Location
from buurtradar.main import create_app

HOME = (52.3276, 4.9340)


def incident(ts, lat, lon, priority=1, discipline="ambulance", title="A1 Parnassiaveld"):
    return {"guid": f"g{ts}", "ts": ts, "title": title, "description": title, "link": None,
            "discipline": discipline, "priority": priority, "street": "Parnassiaveld", "city": "Duivendrecht",
            "postcode": None, "lat": lat, "lon": lon, "precision": "straat"}


async def test_digest_and_history(service):
    service.locations.update(Location(*HOME, 10, "browser", time.time()))
    today = dt.date.today()
    yesterday = today - dt.timedelta(days=1)
    y_noon = dt.datetime.combine(yesterday, dt.time(12)).timestamp()
    service.db.insert_incident(incident(y_noon, 52.3278, 4.9362))                 # gisteren, dichtbij, sirene
    service.db.insert_incident(incident(y_noon + 60, 52.3278, 4.9362, priority=2, discipline="politie"))
    service.db.insert_incident(incident(y_noon + 120, 52.5, 5.0))                  # ver weg
    service.db.insert_incident(incident(time.time() - 60, 52.3278, 4.9362))        # vandaag
    service.db.meta_set("waste_events", [{"date": yesterday.isoformat(), "kind": "gft", "label": "GFT"}])

    d = service.build_digest(yesterday)
    assert d["incidents"] == {"count": 2, "sirene": 1, "by": {"ambulance": 1, "politie": 1}, "top": d["incidents"]["top"]}
    assert d["incidents"]["top"][0]["distance_m"] < 200 and d["waste"] == ["GFT"]

    await service.digest_once()
    assert service.db.digests(yesterday.isoformat())[0]["date"] == yesterday.isoformat()
    with TestClient(create_app(service, start_background=False)) as client:
        hist = client.get("/api/history").json()
        assert hist[0]["today"] and hist[0]["incidents"]["count"] == 1
        assert hist[1]["date"] == yesterday.isoformat() and hist[1]["incidents"]["count"] == 2
        assert hist[2]["missing"] and len(hist) == 8
        assert client.get("/api/config").json()["history"] == {"enabled": True, "days": 7}


def test_digest_without_location(service):
    d = service.build_digest(dt.date.today())
    assert d["has_location"] is False and d["incidents"]["count"] == 0
