import time

import httpx
import respx

from sirene.location import Location
from sirene.notifier import Notifier
from sirene.sources.p2000_rss import FeedItem

from .conftest import PDOK, pdok_doc, pdok_response

HOME = (52.3276, 4.9340)  # vlak bij Parnassiaveld, Duivendrecht


def item(guid="g1", title="a1 13105 parnassiaveld 1115 duivendrecht 94056",
         description="Ambulance met spoed naar Parnassiaveld in Duivendrecht", ts=None):
    return FeedItem(guid, title, description, "https://alarmeringen.nl/x", ts or time.time())


def mock_pdok():
    respx.get(PDOK).mock(return_value=pdok_response(
        pdok_doc("Parnassiaveld", "Duivendrecht", 4.9362, 52.3278, "adres")))


@respx.mock
async def test_process_item_stores_and_dedupes(service):
    mock_pdok()
    first = await service.process_item(item("g1"))
    assert first["discipline"] == "ambulance" and first["precision"] == "postcode"
    assert await service.process_item(item("g1")) is None           # zelfde guid
    assert await service.process_item(item("g2")) is None           # andere capcode, zelfde tekst
    assert service.db.get_incident(first["id"])["dup_count"] == 2


@respx.mock
async def test_notification_sent_within_radius(service):
    mock_pdok()
    service.cfg["notifications"]["enabled"] = True
    service.cfg["location"]["homeassistant"]["token"] = "t"
    ha = respx.post("http://homeassistant:8123/api/services/notify/mobile_app_telefoon").mock(
        return_value=httpx.Response(200, json=[]))
    service.notifier = Notifier(service.client, service.cfg["notifications"],
                                service.cfg["location"]["homeassistant"])
    await service.set_location(Location(*HOME, 10, "browser", time.time()))

    inc = await service.process_item(item())
    assert ha.call_count == 1
    body = ha.calls[0].request.content.decode()
    assert "Ambulance op" in body and "Parnassiaveld" in body
    assert service.db.get_incident(inc["id"])["notified"] == 1


async def test_should_notify_rules(service):
    service.cfg["notifications"]["enabled"] = True
    now = time.time()
    loc = Location(*HOME, 10, "browser", now)
    base = {"id": 1, "notified": 0, "lat": 52.3278, "lon": 4.9362, "ts": now,
            "priority": 1, "precision": "postcode"}
    assert service.should_notify(base, loc, now) is not None
    assert service.should_notify({**base, "priority": 2}, loc, now) is None
    assert service.should_notify({**base, "precision": "plaats"}, loc, now) is None
    assert service.should_notify({**base, "lat": 52.40}, loc, now) is None       # ~8 km verder
    assert service.should_notify({**base, "ts": now - 3600}, loc, now) is None   # te oud
    assert service.should_notify(base, Location(*HOME, 10, "browser", now - 7200), now) is None
    service.cfg["notifications"]["enabled"] = False
    assert service.should_notify(base, loc, now) is None


@respx.mock
async def test_location_update_triggers_notification_for_recent_incident(service):
    mock_pdok()
    service.cfg["notifications"]["enabled"] = True
    sent = []

    class FakeNotifier:
        async def send(self, incident, distance):
            sent.append((incident["id"], distance))

    service.notifier = FakeNotifier()
    inc = await service.process_item(item())       # nog geen locatie: geen melding
    assert sent == []
    await service.set_location(Location(*HOME, 10, "homeassistant", time.time()))
    assert [i for i, _ in sent] == [inc["id"]]
    await service.set_location(Location(HOME[0] + 0.0001, HOME[1], 10, "homeassistant", time.time() + 1))
    assert len(sent) == 1                          # niet dubbel melden


@respx.mock
async def test_feed_errors_back_off(service):
    url = service.cfg["p2000"]["feeds"][0]
    route = respx.get(url).mock(return_value=httpx.Response(403))
    await service.poll_p2000_once()
    await service.poll_p2000_once()               # nog in backoff: geen nieuw verzoek
    assert route.call_count == 1
    assert service.status["p2000"]["last_error"]
    service._feed_backoff[url] = (1, 0)           # backoff verlopen
    route.mock(return_value=httpx.Response(200, text="<rss><channel></channel></rss>"))
    await service.poll_p2000_once()
    assert route.call_count == 2 and url not in service._feed_backoff
