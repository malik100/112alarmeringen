import httpx
import respx

from sirene.db import Database
from sirene.geocoder import Geocoder

from .conftest import PDOK, pdok_doc, pdok_response


async def make_geocoder():
    return Geocoder(Database(":memory:"), httpx.AsyncClient(), PDOK)


@respx.mock
async def test_postcode6_wins():
    route = respx.get(PDOK).mock(return_value=pdok_response(
        pdok_doc("Wilhelminakade", "Rotterdam", 4.4885, 51.9066, "postcode")))
    geo = await make_geocoder()
    result = await geo.geocode("Wilhelminakade", "Rotterdam", "3072AP")
    assert result.precision == "postcode"
    assert (result.lat, result.lon) == (51.9066, 4.4885)
    assert route.call_count == 1


@respx.mock
async def test_rejects_fuzzy_street_match_and_falls_back_to_city():
    def handler(request):
        fq = request.url.params.get_list("fq")
        if "type:weg" in fq:
            return pdok_response(pdok_doc("Amsterdam Rijnkanaalkade", "Amsterdam", 4.95, 52.36))
        if "type:woonplaats" in fq:
            return pdok_response(pdok_doc("", "Amsterdam", 4.89, 52.37, "woonplaats"))
        return pdok_response()

    respx.get(PDOK).mock(side_effect=handler)
    geo = await make_geocoder()
    result = await geo.geocode("Nietbestaandestraat", "Amsterdam", None)
    assert result.precision == "plaats"


@respx.mock
async def test_results_and_misses_are_cached():
    route = respx.get(PDOK).mock(return_value=pdok_response())
    geo = await make_geocoder()
    assert await geo.geocode(None, "Nergenshuizen", None) is None
    assert await geo.geocode(None, "Nergenshuizen", None) is None
    assert route.call_count == 1


@respx.mock
async def test_network_error_is_not_cached():
    route = respx.get(PDOK).mock(side_effect=httpx.ConnectError("offline"))
    geo = await make_geocoder()
    assert await geo.geocode("Damrak", "Amsterdam", None) is None
    assert await geo.geocode("Damrak", "Amsterdam", None) is None
    assert route.call_count == 2
