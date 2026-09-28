import time

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from sirene.main import create_app
from sirene.news import match, normalize, roads
from sirene.sources.p2000_rss import FeedItem

T0 = 1_790_000_000.0


def incident(**kw):
    base = {"id": 1, "ts": T0, "title": "p 1 bgd-02 br gebouw crematorium tiel 082131",
            "description": "Gebouwbrand op Stationsstraat in Tiel", "street": "Stationsstraat", "city": "Tiel"}
    base.update(kw)
    return base


def article(title, summary="", minutes=20):
    return {"title": title, "summary": summary, "ts": T0 + minutes * 60}


def test_city_and_type_shortly_after_is_possible():
    m = match(incident(), article("Brand bij crematorium: twee brandweerwagens en hoogwerker rukken uit",
                                  "Bij crematorium De Linge in Tiel is maandagavond brand gemeld."))
    assert m and m.label == "mogelijk" and set(m.reasons) == {"plaats", "soort", "tijd"}


def test_street_and_city_is_likely():
    m = match(incident(), article("Uitslaande brand aan de Stationsstraat in Tiel"))
    assert m and m.label == "waarschijnlijk"


def test_same_road_number():
    inc = incident(title="p 1 bzl-05 ongeval wegvervoer a50 re 142,3 oss", description="Ongeval op A50 in Oss",
                   street=None, city="Oss")
    m = match(inc, article("Flinke file door botsing tussen bakwagen en personenauto op A50",
                           "LEUR – Op de A50 richting Oss is een ongeval gebeurd."))
    assert m and "weg" in m.reasons and m.label == "waarschijnlijk"


@pytest.mark.parametrize("art", [
    article("Brand in Tiel", minutes=8 * 60),                       # te laat
    article("Brand in Tiel", minutes=-60),                          # te vroeg
    article("Brand bij crematorium in Culemborg"),                  # andere plaats
    article("Tielse ondernemer opent nieuwe zaak"),                 # 'Tielse' is niet 'Tiel'
    article("Brandweer haalt papegaai uit boom in Tiel", minutes=3 * 60),  # alleen plaats
])
def test_no_match(art):
    assert match(incident(), art) is None


def test_ambulance_priority_is_not_a_motorway():
    inc = incident(title="a1 ambu 12158 mommersweg belfeld 145844", description="Ambulance met spoed naar Mommersweg in Belfeld",
                   street="Mommersweg", city="Belfeld")
    assert match(inc, article("File op A1 na ongeluk bij Baarn")) is None


@pytest.mark.parametrize("street, city, title", [
    ("Delft", "Assen", "Schuim als wapen tegen pfas: TU Delft onderzoekt afvalwater"),
    ("Noord", "Schagen", "Doneer aan Stichting Wensambulance Noord-Nederland"),
])
def test_ambiguous_street_needs_city(street, city, title):
    inc = incident(street=street, city=city, description=f"Automatisch brandalarm op {street} in {city}")
    assert match(inc, article(title)) is None


def test_recognisable_street_without_city():
    inc = incident(street="Dierenriemstraat", city="Groningen", title="a1 ongeval dierenriemstraat groningen",
                   description="Ongeval met letsel op Dierenriemstraat in Groningen")
    assert match(inc, article("Auto contra fietser Dierenriemstraat, 1 ernstig gewonde", minutes=90))


def test_road_and_accident_without_city():
    inc = incident(title="p 2 ongeval wegvervoer a22 velsen-noord", description="Ongeval zonder gewonden op A22 in Velsen-Noord",
                   street="A22", city="Velsen-Noord")
    m = match(inc, article("Ruim uur vertraging vlak voor A22 bij Santpoort door ongeluk", minutes=59))
    assert m and m.label == "mogelijk"


def test_road_only_is_weak():
    inc = incident(title="a2 n307 venhuizen", description="Ambulance naar N307 in Venhuizen", street="N307", city="Venhuizen")
    assert match(inc, article("N50 tussen Ens en Kampen dicht vanwege spoedreparatie", "Het verkeer wordt omgeleid via de N307.")) is None


def test_brandweer_is_not_a_fire():
    # "brandweer" in een artikel betekent niet dat er brand was.
    m = match(incident(), article("Brandweer redt kat uit boom in Tiel", minutes=3 * 60))
    assert m is None


def test_city_aliases_and_normalization():
    inc = incident(city="Den Haag", street="Jaap Edenweg", description="Voertuigbrand op Jaap Edenweg in Den Haag")
    assert match(inc, article("Auto in brand in 's-Gravenhage"))
    assert normalize("<p>Caf&eacute; &amp; Co</p>") == "cafe & co"
    assert roads("Ongeval op de A2 en N33") == {"a2", "n33"}


def feed_item(guid, title, desc, ts):
    return FeedItem(guid, title, desc, f"https://nieuws.example/{guid}", ts)


def test_article_after_incident_is_linked(service):
    now = time.time()
    inc_id = service.db.insert_incident({
        "guid": "p1", "ts": now - 600, "title": "p 1 br woning damstraat amsterdam",
        "description": "Woningbrand op Damstraat in Amsterdam", "discipline": "brandweer", "priority": 1,
        "street": "Damstraat", "city": "Amsterdam", "lat": 52.37, "lon": 4.89, "precision": "straat"})
    linked = service.process_article("AT5", feed_item("n1", "Uitslaande woningbrand aan de Damstraat",
                                                     "<p>In Amsterdam woedt een brand.</p>", now))
    assert linked == [inc_id]
    assert service.process_article("AT5", feed_item("n1", "x", "", now)) == []   # al gezien
    [news] = service.enrich(service.db.get_incident(inc_id))["news"]
    assert news["source"] == "AT5" and news["label"] == "waarschijnlijk"


@respx.mock
async def test_incident_after_article_is_linked_and_api(service):
    now = time.time()
    service.process_article("NOS", feed_item("n2", "Brand in woning aan de Damstraat in Amsterdam", "", now - 60))
    respx.get(url__startswith="https://api.pdok.nl").mock(return_value=httpx.Response(200, json={"response": {"docs": []}}))
    inc = await service.process_item(FeedItem("p2", "p 1 br woning damstraat amsterdam",
                                              "Woningbrand op Damstraat in Amsterdam", "", now - 300))
    with TestClient(create_app(service, start_background=False)) as client:
        [data] = client.get("/api/incidents?minutes=30").json()
    assert data["id"] == inc["id"] and data["news"][0]["title"].startswith("Brand in woning")


@respx.mock
async def test_poll_news_uses_feeds(service):
    now = time.strftime("%a, %d %b %Y %H:%M:%S +0000", time.gmtime())
    service.cfg["news"]["feeds"] = [{"name": "Test", "url": "https://nieuws.example/rss"}]
    respx.get("https://nieuws.example/rss").mock(return_value=httpx.Response(200, text=f"""<rss><channel>
        <item><title>Iets</title><link>https://nieuws.example/1</link><guid>1</guid>
        <description>tekst</description><pubDate>{now}</pubDate></item></channel></rss>"""))
    assert await service.poll_news_once() == 0
    assert service.db.has_news("1") and service.status["news"]["last_ok"]
