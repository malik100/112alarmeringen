from buurtradar.geo import haversine_m
from buurtradar.sources.p2000_rss import parse_rss
from buurtradar.sources.speedcams import QUERY, parse_overpass

RSS = """<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Alarmeringen.nl feed</title>
<item><title>a1 13105 parnassiaveld 1115 duivendrecht 94056</title>
<link>https://alarmeringen.nl/x/55886936/p2000.html?utm_source=rss&amp;utm_medium=x</link>
<description>Ambulance met spoed naar Parnassiaveld in Duivendrecht</description>
<pubDate>Sun, 27 Sep 2026 23:47:50 +0000</pubDate>
<guid isPermaLink="false">c8b5a29607ce8713f332d14fe7a800f7</guid></item>
<item><title>zonder datum</title></item>
</channel></rss>"""


def test_haversine_known_distance():
    # Amsterdam Centraal -> Dam: ~ 850 m
    d = haversine_m(52.3791, 4.9003, 52.3731, 4.8926)
    assert 800 < d < 900


def test_parse_rss():
    items = parse_rss(RSS)
    assert len(items) == 1
    item = items[0]
    assert item.guid == "c8b5a29607ce8713f332d14fe7a800f7"
    assert item.link == "https://alarmeringen.nl/x/55886936/p2000.html"
    assert item.ts == 1790552870.0  # 2026-09-27T23:47:50Z


def test_parse_overpass():
    data = {"elements": [
        {"type": "node", "id": 1, "lat": 51.0, "lon": 5.8, "tags": {"highway": "speed_camera", "maxspeed": "80"}},
        {"type": "node", "id": 2, "lat": 51.1, "lon": 5.9,
         "tags": {"highway": "speed_camera", "enforcement": "traffic_signals;maxspeed"}},
        {"type": "relation", "id": 3, "tags": {"enforcement": "average_speed", "maxspeed": "100",
                                               "name": "Trajectcontrole A12"},
         "members": [
             {"type": "node", "role": "from", "lat": 52.06, "lon": 5.08},
             {"type": "way", "role": "section", "geometry": [{"lat": 52.06, "lon": 5.08},
                                                             {"lat": 52.05, "lon": 5.13}]},
         ]},
    ]}
    cams = {c["osm_id"]: c for c in parse_overpass(data)}
    assert cams["node/1"]["kind"] == "flitser" and cams["node/1"]["maxspeed"] == "80"
    assert cams["node/2"]["kind"] == "roodlicht"
    traject = cams["relation/3"]
    assert traject["kind"] == "traject"
    assert (traject["lat"], traject["lon"]) == (52.06, 5.08)
    assert traject["geometry"] == [[[52.06, 5.08], [52.05, 5.13]]]


def test_overpass_query_returns_coordinates():
    # "out tags" levert geen lat/lon op; nodes en relaties hebben "out body" nodig.
    assert "out tags" not in QUERY
    assert parse_overpass({"elements": [{"type": "node", "id": 9, "tags": {}}]}) == []
