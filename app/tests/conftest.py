import copy

import httpx
import pytest

from sirene.config import DEFAULTS
from sirene.service import Service

PDOK = DEFAULTS["geocoder"]["pdok_url"]


def pdok_doc(straat, woonplaats, lon, lat, type_="weg"):
    return {"type": type_, "straatnaam": straat, "woonplaatsnaam": woonplaats,
            "weergavenaam": f"{straat}, {woonplaats}", "centroide_ll": f"POINT({lon} {lat})"}


def pdok_response(*docs):
    return httpx.Response(200, json={"response": {"numFound": len(docs), "docs": list(docs)}})


@pytest.fixture
def cfg(tmp_path):
    c = copy.deepcopy(DEFAULTS)
    c["database"] = str(tmp_path / "test.db")
    return c


@pytest.fixture
async def service(cfg):
    svc = Service(cfg, client=httpx.AsyncClient())
    yield svc
    await svc.client.aclose()
