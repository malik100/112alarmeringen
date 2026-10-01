import datetime as dt

import httpx
import respx
from fastapi.testclient import TestClient

from sirene.main import create_app
from sirene.sources.waste import classify, parse_ical

TODAY = dt.date(2026, 10, 1)
ICAL = """BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:GFT en etensresten
DTSTART;VALUE=DATE:20261002
END:VEVENT
BEGIN:VEVENT
SUMMARY:Papier en karton
DTSTART:20261003T230000Z
END:VEVENT
BEGIN:VEVENT
SUMMARY:Plastic\\, blik en drankpakken
 (PMD)
DTSTART;VALUE=DATE:20261005
END:VEVENT
BEGIN:VEVENT
SUMMARY:Restafval
DTSTART;VALUE=DATE:20261001
RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3
END:VEVENT
BEGIN:VEVENT
SUMMARY:Oud papier
DTSTART;VALUE=DATE:20260901
END:VEVENT
END:VCALENDAR
"""


def test_parse_ical():
    events = parse_ical(ICAL, TODAY)
    assert [(e["date"], e["kind"]) for e in events] == [
        ("2026-10-01", "rest"), ("2026-10-02", "gft"), ("2026-10-04", "papier"),   # 23:00Z = 4 okt 01:00 NL
        ("2026-10-05", "pmd"), ("2026-10-15", "rest"), ("2026-10-29", "rest")]
    assert events[3]["label"] == "PMD" and "(PMD)" in events[3]["summary"]
    assert classify("Kerstbomen ophalen") == ("kerstboom", "Kerstboom")
    assert classify("Iets anders") == ("overig", "Iets anders")


@respx.mock
def test_set_url_and_api(service, monkeypatch):
    monkeypatch.setattr("sirene.sources.waste.dt.date", type("D", (dt.date,), {"today": staticmethod(lambda: TODAY)}))
    monkeypatch.setattr("sirene.service.dt.date", type("D", (dt.date,), {"today": staticmethod(lambda: TODAY)}))
    respx.get("https://kalender.test/x.ics").mock(return_value=httpx.Response(200, text=ICAL))
    respx.get("https://kalender.test/leeg").mock(return_value=httpx.Response(200, text="<html>nee</html>"))
    with TestClient(create_app(service, start_background=False)) as client:
        assert client.get("/api/waste").json()["url"] == ""
        assert client.put("/api/waste", json={"url": "https://kalender.test/leeg"}).status_code == 422
        assert client.put("/api/waste", json={"url": "ftp://x"}).status_code == 422
        got = client.put("/api/waste", json={"url": "webcal://kalender.test/x.ics"}).json()
        assert got["count"] == 6 and got["url"] == "webcal://kalender.test/x.ics"
        upcoming = client.get("/api/waste").json()["events"]
        assert [e["date"] for e in upcoming] == ["2026-10-01", "2026-10-02", "2026-10-04", "2026-10-05", "2026-10-15"]
        assert client.put("/api/waste", json={"url": ""}).json()["url"] == ""
        assert client.get("/api/waste").json()["events"] == []
