import datetime as dt
import time

import httpx
import respx

from buurtradar.location import Location
from buurtradar.notifier import Notifier
from buurtradar.sources.roadworks import REVERSE_URL

NTFY = "http://ntfy/"


def arm(service, **topics):
    service.cfg["notifications"].update(enabled=True, channel="ntfy", **topics)
    service.notifier = Notifier(service.client, service.cfg["notifications"], service.cfg["location"]["homeassistant"])
    service.locations.update(Location(52.3276, 4.9340, 10, "browser", time.time()))


@respx.mock
async def test_roadworks_notification(service):
    arm(service, roadworks=True)
    ntfy = respx.post(NTFY).mock(return_value=httpx.Response(200, json={}))
    respx.get(REVERSE_URL).mock(return_value=httpx.Response(200, json={"response": {"docs": [{"weergavenaam": "Parnassiaveld, Duivendrecht"}]}}))
    now = time.time()
    service.db.replace_roadworks([
        {"id": "dicht", "lat": 52.3278, "lon": 4.9362, "start": now - 3600, "end": now + 86400, "closed": True,
         "warnings": ["Weg dicht in beide richtingen"], "cause": "Asfalt", "url": None, "road": None, "note": None},
        {"id": "hinder", "lat": 52.3278, "lon": 4.9362, "start": now - 3600, "end": now + 86400, "closed": False,
         "warnings": [], "cause": None, "url": None, "road": None, "note": None},
        {"id": "ver", "lat": 52.40, "lon": 4.90, "start": now - 3600, "end": now + 86400, "closed": True,
         "warnings": [], "cause": None, "url": None, "road": None, "note": None},
    ])
    assert await service.notify_roadworks() == 1
    body = ntfy.calls[0].request.content.decode()
    assert "Afsluiting nu: Parnassiaveld" in body and "Weg dicht" in body
    assert await service.notify_roadworks() == 0          # niet nog een keer


@respx.mock
async def test_announcement_and_waste_notifications(service):
    arm(service, announcements=True, waste=True, waste_hour=19)
    ntfy = respx.post(NTFY).mock(return_value=httpx.Response(200, json={}))
    items = [
        {"id": "a1", "title": "Braderie Parnassiaveld", "abstract": "Feest", "category": "evenementen",
         "lat": 52.3278, "lon": 4.9362, "relevance": 3.5, "url": "u", "deadline": "2026-10-20"},
        {"id": "a2", "title": "Dakkapel", "abstract": "", "category": "bouwen", "lat": 52.3278, "lon": 4.9362,
         "relevance": 0.5, "url": "u", "deadline": None},      # niet belangrijk
        {"id": "a3", "title": "Ver weg", "abstract": "", "category": "evenementen", "lat": 52.5, "lon": 5.0,
         "relevance": 5, "url": "u", "deadline": None},
    ]
    assert await service.notify_announcements(items) == 1
    assert "Evenement op" in ntfy.calls[0].request.content.decode()

    tomorrow = (dt.date.today() + dt.timedelta(days=1)).isoformat()
    service.db.meta_set("waste_events", [{"date": tomorrow, "kind": "gft", "label": "GFT"},
                                         {"date": tomorrow, "kind": "papier", "label": "Papier"}])
    morning = dt.datetime.combine(dt.date.today(), dt.time(8)).timestamp()
    evening = dt.datetime.combine(dt.date.today(), dt.time(19, 5)).timestamp()
    assert not await service.notify_waste(morning)        # te vroeg
    assert await service.notify_waste(evening)
    assert "Morgen: GFT + Papier" in ntfy.calls[-1].request.content.decode()
    assert not await service.notify_waste(evening)        # één keer per dag


async def test_notifications_off_by_default(service):
    service.locations.update(Location(52.3276, 4.9340, 10, "browser", time.time()))
    assert await service.notify_roadworks() == 0
    assert await service.notify_announcements([]) == 0
    assert not await service.notify_waste()
