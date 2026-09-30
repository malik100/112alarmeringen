import csv as csvlib
import datetime as dt
import io
import time
import zipfile

import httpx
import pytest
import respx
from fastapi.testclient import TestClient
from google.transit import gtfs_realtime_pb2 as rt

from sirene.main import create_app
from sirene.ov import OvStore, Realtime, day_base, estimate
from sirene.sources.gtfs import DEFAULT_URL as GTFS_URL
from sirene.sources.gtfs import import_gtfs, mode_of, simplify
from sirene.sources.gtfs_rt import DEFAULT_URL as RT_URL
from sirene.sources.gtfs_rt import StopUpdate, TripUpdate, parse_alerts, parse_trip_updates, parse_vehicles

TODAY = dt.date(2026, 10, 1)
BASE = day_base(TODAY)
NOW = BASE + 8 * 3600          # 08:00 op 1 oktober
D = "20261001"


def csv(header, *rows):
    out = io.StringIO()
    writer = csvlib.writer(out, lineterminator="\n")
    writer.writerow(header.split(","))
    writer.writerows(rows)
    return out.getvalue()


def gtfs_zip(today=TODAY):
    d = today.strftime("%Y%m%d")
    yesterday = (today - dt.timedelta(days=1)).strftime("%Y%m%d")
    files = {
        "agency.txt": csv("agency_id,agency_name,agency_url,agency_timezone",
                          ("GVB", "GVB", "https://gvb.nl", "Europe/Amsterdam"),
                          ("IFF:NS", "NS", "https://ns.nl", "Europe/Amsterdam")),
        "routes.txt": csv("route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color",
                          ("R7", "GVB", "7", "Slotermeer - Flevopark", 0, "", ""),
                          ("R80", "GVB", "80", "Zandvoort - Elandsgracht", 3, "ffcc00", "000000"),
                          ("RIC", "IFF:NS", "Intercity", "", 2, "", "")),
        "calendar_dates.txt": csv("service_id,date,exception_type",
                                  ("S1", d, 1), ("S1", yesterday, 1), ("S2", "20261225", 1)),
        "stops.txt": csv("stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station,platform_code",
                         ("area1", "Amsterdam, Bos en Lommerplein", 52.3780, 4.8462, 1, "", ""),
                         ("A", "Amsterdam, Bos en Lommerplein", 52.3779, 4.8461, 0, "area1", ""),
                         ("B", "Amsterdam, Bos en Lommerplein", 52.3781, 4.8464, 0, "area1", ""),
                         ("C", "Bos en Lommerplein", 52.3783, 4.8466, 0, "", ""),     # zelfde halte, andere bron
                         ("E", "Amsterdam, Erasmusgracht", 52.3760, 4.8480, 0, "", ""),
                         ("F", "Amsterdam, Slotermeer", 52.3800, 4.8100, 0, "", ""),
                         ("onb", "Onbekend", 52.0, 5.0, 1, "", ""),
                         ("X", "Utrecht, Ergens", 52.09, 5.12, 0, "onb", ""),         # ver van "station"
                         ("ns", "Amsterdam Sloterdijk", 52.389, 4.838, 1, "", ""),
                         ("NS1", "Amsterdam Sloterdijk", 52.389, 4.838, 0, "ns", "1"),
                         ("NS2", "Amsterdam Sloterdijk", 52.389, 4.8381, 0, "ns", "2"),
                         ("NSU", "Utrecht Centraal", 52.089, 5.110, 0, "", "5"),
                         ("unused", "Nergens", 51.0, 4.0, 0, "", "")),
        "trips.txt": csv("route_id,service_id,trip_id,realtime_trip_id,trip_headsign,trip_short_name,trip_long_name,direction_id,shape_id",
                         ("R7", "S1", "t7a", "", "Slotermeer", "", "", 0, "sh7"),
                         ("R7", "S1", "t7b", "", "Slotermeer", "", "", 0, "sh7"),
                         ("R80", "S1", "t80", "", "Zandvoort", "", "", 0, ""),
                         ("R80", "S1", "tnight", "", "Nachtbus", "", "", 0, ""),
                         ("R7", "S2", "txmas", "", "Kerst", "", "", 0, "sh7"),
                         ("RIC", "S1", "tic", "", "Utrecht Centraal", "1234", "Intercity", 0, ""),
                         ("R80", "S1", "tX", "", "Utrecht", "", "", 0, "")),
        "stop_times.txt": csv("trip_id,stop_sequence,stop_id,arrival_time,departure_time,pickup_type,drop_off_type",
                              ("t7a", 1, "A", "08:10:00", "08:10:00", 0, 1),
                              ("t7a", 2, "E", "08:12:00", "08:12:00", 0, 0),
                              ("t7a", 3, "F", "08:20:00", "08:20:00", 1, 0),
                              ("t7b", 1, "A", "08:05:00", "08:05:00", 0, 1),
                              ("t7b", 2, "E", "08:07:00", "08:07:00", 0, 0),
                              ("t7b", 3, "F", "08:15:00", "08:15:00", 1, 0),
                              ("t80", 1, "E", "08:00:00", "08:00:00", 0, 1),
                              ("t80", 2, "C", "08:03:00", "08:03:00", 1, 0),   # eindhalte: geen vertrek
                              ("tnight", 1, "B", "31:30:00", "31:30:00", 0, 1),  # 07:30 volgende dag
                              ("tnight", 2, "E", "31:59:00", "31:59:00", 1, 0),
                              ("txmas", 1, "A", "08:30:00", "08:30:00", 0, 1),
                              ("txmas", 2, "F", "08:40:00", "08:40:00", 1, 0),
                              ("tic", 1, "NS1", "08:20:00", "08:22:00", 0, 1),
                              ("tic", 2, "NSU", "08:45:00", "08:45:00", 1, 0),
                              ("tX", 1, "X", "09:00:00", "09:00:00", 0, 1),
                              ("tX", 2, "E", "10:00:00", "10:00:00", 1, 0)),
        "shapes.txt": csv("shape_id,shape_pt_sequence,shape_pt_lat,shape_pt_lon",
                          ("sh7", 1, 52.3779, 4.8461), ("sh7", 2, 52.3770, 4.8470),
                          ("sh7", 3, 52.3760, 4.8480), ("sh7", 4, 52.3800, 4.8100)),
        "feed_info.txt": csv("feed_publisher_name,feed_version,feed_end_date", ("OVapi", "123", "20261212")),
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, text in files.items():
            zf.writestr(name, text)
    return buf.getvalue()


@pytest.fixture
def ov(tmp_path):
    zip_path = tmp_path / "gtfs.zip"
    zip_path.write_bytes(gtfs_zip())
    counts = import_gtfs(zip_path, tmp_path / "ov.db", TODAY, days=7)
    store = OvStore(tmp_path / "ov.db")
    store.counts = counts
    yield store
    store.close()


def halte_named(store, name):
    return next(h for h in store.haltes_in_bbox(50, 3, 54, 8) if h["name"] == name)


def test_import_counts_and_haltes(ov):
    assert ov.ready and ov.info["feed_version"] == "123"
    assert ov.counts["trips"] == 6                      # kerstrit valt buiten de 7 dagen
    names = sorted(h["name"] for h in ov.haltes_in_bbox(50, 3, 54, 8))
    # Perrons A en B (zelfde station) en C (zelfde naam, 40 m verderop) zijn één halte;
    # X hoort niet bij het verzamelstation "Onbekend" 150 km verderop; "Nergens" wordt niet bediend.
    assert names == ["Amsterdam Sloterdijk", "Amsterdam, Bos en Lommerplein", "Amsterdam, Erasmusgracht",
                     "Amsterdam, Slotermeer", "Utrecht Centraal", "Utrecht, Ergens"]
    h = halte_named(ov, "Amsterdam, Bos en Lommerplein")
    assert h["modes"] == ["tram", "bus"]
    assert [(l["line"], l["mode"], l["color"]) for l in h["lines"]] == [("7", "tram", None), ("80", "bus", "ffcc00")]


def test_departures_schedule(ov):
    h = halte_named(ov, "Amsterdam, Bos en Lommerplein")
    deps = ov.departures(h["id"], NOW)
    # 08:05 en 08:10 tram 7; bus 80 eindigt hier (geen vertrek); nachtbus van gisteren (31:30)
    # rijdt vanochtend om 07:30 al voorbij; die van vandaag morgen om 07:30.
    assert [(d["line"], d["time"] - BASE) for d in deps] == [
        ("7", 8 * 3600 + 300), ("7", 8 * 3600 + 600), ("80", 31 * 3600 + 1800)]
    assert deps[0]["headsign"] == "Slotermeer" and deps[0]["date"] == D and not deps[0]["realtime"]
    assert ov.departures(h["id"], NOW, limit=1)[0]["trip"] == "t7b"


def test_estimate_propagates_delay_and_skips():
    tu = TripUpdate("t", D, updates=[StopUpdate(1, "A", dep=BASE + 100 + 120, dep_delay=120),
                                     StopUpdate(3, "F", skipped=True)])
    resolved = [(u.seq, u) for u in tu.updates]
    at = estimate(tu, 1, BASE + 100, BASE + 100, resolved)
    assert at["realtime"] and at["delay"] == 120 and at["expected"] == BASE + 220
    later = estimate(tu, 2, BASE + 200, BASE + 200, resolved)   # geen eigen update: vertraging loopt door
    assert later["delay"] == 120 and later["expected"] == BASE + 320
    assert estimate(tu, 3, BASE + 300, BASE + 300, resolved)["canceled"]
    early = TripUpdate("t", D, updates=[StopUpdate(1, "A", dep_delay=-90)])
    assert estimate(early, 2, BASE, BASE, [(1, early.updates[0])])["delay"] == 0  # te vroeg loopt niet door
    assert estimate(TripUpdate("t", D, canceled=True), 1, BASE, BASE, [])["canceled"]
    assert not estimate(None, 1, BASE, BASE, None)["realtime"]


def test_departures_with_realtime_and_platform_change(ov):
    h = halte_named(ov, "Amsterdam, Bos en Lommerplein")
    live = Realtime(trips={
        ("t7b", D): TripUpdate("t7b", D, updates=[StopUpdate(1, "A", dep_delay=420)]),   # 7 min te laat
        ("t7a", D): TripUpdate("t7a", D, canceled=True),
    })
    deps = ov.departures(h["id"], NOW, live)
    assert [(d["trip"], d["expected"] - BASE, d["canceled"]) for d in deps[:2]] == [
        ("t7a", 8 * 3600 + 600, True), ("t7b", 8 * 3600 + 720, False)]
    assert deps[1]["delay"] == 420 and deps[1]["realtime"]

    # Trein: update zonder volgnummer, op een ander perron van hetzelfde station.
    ns = halte_named(ov, "Amsterdam Sloterdijk")
    live = Realtime(trips={("tic", D): TripUpdate("tic", D, updates=[
        StopUpdate(None, "NS2", arr=BASE + 8 * 3600 + 1260, dep=BASE + 8 * 3600 + 1380, dep_delay=60)])})
    [ic] = ov.departures(ns["id"], NOW, live)
    assert ic["line"] == "Intercity" and ic["platform"] == "1" and ic["new_platform"] == "2"
    assert ic["delay"] == 60 and ic["expected"] == BASE + 8 * 3600 + 1380


def test_trip_lines_and_vehicles(ov):
    live = Realtime(trips={("t7a", D): TripUpdate("t7a", D, updates=[StopUpdate(2, "E", arr_delay=60)])},
                    vehicles=[{"id": "v1", "trip_id": "t7a", "start_date": D, "route_id": "R7", "lat": 52.377,
                               "lon": 4.847, "bearing": None, "ts": NOW - 20, "stop_id": "E", "at_stop": False,
                               "label": "2083"},
                              {"id": "old", "trip_id": "t7b", "start_date": D, "route_id": "R7", "lat": 52.377,
                               "lon": 4.847, "bearing": None, "ts": NOW - 3600, "stop_id": None,
                               "at_stop": False, "label": None}])
    trip = ov.trip("t7a", D, live)
    assert [s["name"] for s in trip["stops"]] == ["Amsterdam, Bos en Lommerplein", "Amsterdam, Erasmusgracht",
                                                  "Amsterdam, Slotermeer"]
    assert [s["delay"] for s in trip["stops"]] == [None, 60, 60]
    assert len(trip["shape"]) >= 2 and trip["line"] == "7"
    assert ov.trip("t7a", "2026-10-01", live) is None and ov.trip("bestaat-niet", D) is None

    lines = ov.lines_in_bbox(52.37, 4.84, 52.38, 4.85)
    assert [(l["line"], l["mode"], len(l["paths"])) for l in lines] == [("7", "tram", 1)]
    assert ov.lines_in_bbox(52.37, 4.84, 52.38, 4.85, modes={"bus"}) == []

    [v] = ov.vehicles_in_bbox(live, 52.3, 4.8, 52.4, 4.9, NOW)   # "old" is te oud
    assert v["line"] == "7" and v["headsign"] == "Slotermeer" and v["delay"] == 60


def test_swap_and_missing_file(tmp_path):
    store = OvStore(tmp_path / "ov.db")
    assert not store.ready and store.departures(1, NOW) == [] and store.haltes_in_bbox(0, 0, 1, 1) == []
    (tmp_path / "gtfs.zip").write_bytes(gtfs_zip())
    import_gtfs(tmp_path / "gtfs.zip", tmp_path / "ov.db.new", TODAY)
    store.swap(tmp_path / "ov.db.new")
    assert store.ready and not (tmp_path / "ov.db.new").exists()
    assert store.covers(TODAY + dt.timedelta(days=7)) and not store.covers(TODAY + dt.timedelta(days=8))
    store.close()


def test_simplify_and_modes():
    line = [(52.0, 5.0 + i * 0.0001) for i in range(50)] + [(52.001, 5.005)]
    assert len(simplify(line, 4)) == 3        # rechte lijn: begin, knik, eind
    assert mode_of(0) == "tram" and mode_of("2") == "trein" and mode_of(700) == "bus" and mode_of(401) == "metro"
    assert mode_of(1000) == "veer" and mode_of("onzin") == "bus"


# --- actuele gegevens (protobuf) ------------------------------------------------

def trip_feed():
    feed = rt.FeedMessage()
    feed.header.gtfs_realtime_version = "2.0"
    e = feed.entity.add(id="1")
    e.trip_update.trip.trip_id = "t7b"
    e.trip_update.trip.start_date = D
    stu = e.trip_update.stop_time_update.add(stop_sequence=1, stop_id="A")
    stu.departure.delay = 180
    stu.departure.time = int(BASE + 8 * 3600 + 480)
    skip = e.trip_update.stop_time_update.add(stop_sequence=2, stop_id="E")
    skip.schedule_relationship = rt.TripUpdate.StopTimeUpdate.SKIPPED
    c = feed.entity.add(id="2")
    c.trip_update.trip.trip_id = "t7a"
    c.trip_update.trip.start_date = D
    c.trip_update.trip.schedule_relationship = rt.TripDescriptor.CANCELED
    return feed.SerializeToString()


def vehicle_feed(ts):
    feed = rt.FeedMessage()
    feed.header.gtfs_realtime_version = "2.0"
    e = feed.entity.add(id="v1")
    e.vehicle.trip.trip_id = "t7b"
    e.vehicle.trip.start_date = D
    e.vehicle.position.latitude = 52.3775
    e.vehicle.position.longitude = 4.847
    e.vehicle.timestamp = int(ts)
    e.vehicle.vehicle.label = "2083"
    feed.entity.add(id="zonder-positie").vehicle.trip.trip_id = "x"
    return feed.SerializeToString()


def alert_feed():
    feed = rt.FeedMessage()
    feed.header.gtfs_realtime_version = "2.0"
    a = feed.entity.add(id="a1").alert
    a.header_text.translation.add(text="Halte vervalt door werkzaamheden", language="nl")
    a.informed_entity.add(stop_id="C")
    a.cause = rt.Alert.MAINTENANCE
    a.effect = rt.Alert.DETOUR
    old = feed.entity.add(id="a2").alert
    old.header_text.translation.add(text="Oude storing", language="nl")
    old.active_period.add(start=1, end=2)
    old.informed_entity.add(stop_id="A")
    line = feed.entity.add(id="a3").alert
    line.header_text.translation.add(text="Lijn 80 rijdt om", language="nl")
    line.informed_entity.add(route_id="R80")
    return feed.SerializeToString()


def test_parse_realtime_feeds():
    trips = parse_trip_updates(trip_feed())
    tu = trips[("t7b", D)]
    assert tu.updates[0].dep_delay == 180 and tu.updates[0].seq == 1 and tu.updates[1].skipped
    assert trips[("t7a", D)].canceled
    [v] = parse_vehicles(vehicle_feed(NOW))
    assert (round(v["lat"], 4), round(v["lon"], 4), v["label"], v["trip_id"]) == (52.3775, 4.847, "2083", "t7b")
    alerts = parse_alerts(alert_feed())
    assert alerts[0]["header"] == "Halte vervalt door werkzaamheden" and alerts[0]["cause"] == "werkzaamheden"
    assert alerts[0]["effect"] == "omleiding" and alerts[0]["stops"] == ["C"]


# --- service en API ------------------------------------------------------------------

@respx.mock
def test_api_end_to_end(service, monkeypatch):
    # Doen alsof het nu 08:00 op 1 oktober is (ov.py en main.py gebruiken time.time()).
    monkeypatch.setattr(time, "time", lambda: NOW)
    monkeypatch.setattr("sirene.service.dt.date", type("D", (dt.date,), {"today": staticmethod(lambda: TODAY)}))
    respx.get(GTFS_URL).mock(return_value=httpx.Response(200, content=gtfs_zip()))
    rt_routes = {
        "tripUpdates.pb": respx.get(RT_URL + "tripUpdates.pb").mock(return_value=httpx.Response(200, content=trip_feed())),
        "trainUpdates.pb": respx.get(RT_URL + "trainUpdates.pb").mock(return_value=httpx.Response(500)),
        "vehiclePositions.pb": respx.get(RT_URL + "vehiclePositions.pb").mock(
            return_value=httpx.Response(200, content=vehicle_feed(NOW - 10))),
        "alerts.pb": respx.get(RT_URL + "alerts.pb").mock(return_value=httpx.Response(200, content=alert_feed())),
    }
    with TestClient(create_app(service, start_background=False)) as client:
        assert client.get("/api/config").json()["ov"]["ready"] is False
        assert client.get("/api/ov/departures?halte=1").status_code == 503
        assert client.get("/api/ov/haltes?bbox=4.8,52.3,4.9,52.4").json() == []

        import asyncio
        assert asyncio.run(service.refresh_ov_once())
        assert service.status["ov"]["count"] == 6 and client.get("/api/config").json()["ov"]["ready"]
        assert not service.ov_path().with_name("gtfs-nl.zip").exists()   # zip weer opgeruimd

        near = client.get("/api/ov/near?lat=52.3780&lon=4.8462").json()
        first = near["haltes"][0]
        assert first["name"] == "Amsterdam, Bos en Lommerplein" and first["distance_m"] < 20
        assert [(d["trip"], d["canceled"], d["delay"]) for d in first["departures"][:2]] == [
            ("t7b", False, 180), ("t7a", True, None)]
        assert near["realtime_ts"] == NOW

        board = client.get(f"/api/ov/departures?halte={first['id']}").json()
        assert [a["header"] for a in board["alerts"]] == ["Halte vervalt door werkzaamheden", "Lijn 80 rijdt om"]
        assert board["alerts"][0]["scope"] == "halte" and board["alerts"][1]["scope"] == "lijn"

        trip = client.get(f"/api/ov/trip?trip=t7b&date={D}").json()
        assert trip["stops"][1]["canceled"]                        # Erasmusgracht wordt overgeslagen
        assert client.get("/api/ov/trip?trip=t7b&date=gisteren").status_code == 422
        assert client.get(f"/api/ov/trip?trip=nee&date={D}").status_code == 404

        [v] = client.get("/api/ov/vehicles?bbox=4.8,52.3,4.9,52.4").json()["vehicles"]
        assert v["line"] == "7" and v["delay"] == 180
        assert client.get("/api/ov/lines?bbox=4.8,52.3,4.9,52.4&modes=tram").json()[0]["line"] == "7"
        assert client.get("/api/ov/lines?bbox=3,50,6,53").status_code == 422

        # Binnen 30 s niet opnieuw ophalen: de bron wordt niet vaker belast dan nodig.
        calls = rt_routes["tripUpdates.pb"].call_count
        client.get(f"/api/ov/departures?halte={first['id']}")
        assert rt_routes["tripUpdates.pb"].call_count == calls


def test_ov_disabled(cfg):
    cfg["ov"]["enabled"] = False
    from sirene.service import Service
    svc = Service(cfg, client=httpx.AsyncClient())
    with TestClient(create_app(svc, start_background=False)) as client:
        assert client.get("/api/config").json()["ov"]["enabled"] is False
        assert client.get("/api/ov/haltes?bbox=4.8,52.3,4.9,52.4").status_code == 404
        assert client.get("/api/ov/departures?halte=1").status_code == 404
