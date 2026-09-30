"""Webserver: API, live updates en de kaart."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import load_config
from .events import format_sse
from .location import Location
from .service import Service
from .geo import haversine_m
from .sources.charging import matches as charging_matches
from .sources.roadworks import is_active, relevance as roadwork_relevance
from .sources.npr import contains
from .sources.shops import link_statiegeld

STATIC_DIR = Path(__file__).parent / "static"
HEARTBEAT_S = 20
STATIEGELD_LIMIT = 2000
PARKING_LIMIT = 800
METER_NEAR_M = 200  # "waarschijnlijk hier": parkeerautomaat van een zone zonder kaartvlak
CHARGING_LIMIT = 1500
SHOPS_LIMIT = 2000
ROADWORKS_LIMIT = 1500
ROADWORKS_STREETS = 25   # zoveel werken per lijst krijgen een straatnaam (PDOK, gecachet)
PARKING_KINDS = {"betaald", "blauw", "vergunning", "garage"}

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)


class LocationIn(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    accuracy: float | None = Field(default=None, ge=0)


def create_app(service: Service | None = None, start_background: bool = True) -> FastAPI:
    svc = service or Service(load_config())

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if start_background:
            svc.start()
        yield
        await svc.stop()

    app = FastAPI(title="Buurtradar", lifespan=lifespan)
    app.state.service = svc

    @app.middleware("http")
    async def no_stale_frontend(request: Request, call_next):
        """Laat de browser pagina, stijl en scripts altijd controleren op een nieuwe versie.

        Zonder deze kop bewaart een browser style.css en app.js soms dagenlang; na een update
        krijg je dan een nieuwe pagina met een oude opmaak. Ongewijzigde bestanden kosten alleen
        een korte controle (304 Not Modified), geen nieuwe download.
        """
        response = await call_next(request)
        path = request.url.path
        if path in ("/", "/proef") or (path.startswith("/static/") and "/vendor/" not in path):
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/api/config")
    def get_config():
        cfg = svc.cfg
        return {
            "radius_m": cfg["radius_m"],
            "map": cfg["map"],
            "browser_location": cfg["location"]["browser"],
            "homeassistant_location": cfg["location"]["homeassistant"]["enabled"],
            "notifications_enabled": cfg["notifications"]["enabled"],
            "speedcams_enabled": cfg["speedcams"]["enabled"],
            "statiegeld": {k: cfg["statiegeld"][k] for k in ("enabled", "min_zoom", "list_radius_m")},
            "parking": {k: cfg["parking"][k] for k in ("enabled", "min_zoom")},
            "charging": {k: cfg["charging"][k] for k in ("enabled", "min_zoom", "list_radius_m")},
            "shops": {k: cfg["shops"][k] for k in ("enabled", "min_zoom", "list_radius_m")},
            "roadworks": {k: cfg["roadworks"][k] for k in ("enabled", "min_zoom", "list_radius_m", "ahead_days")},
            "local": {"news": cfg["news"]["enabled"],
                      "announcements": cfg["announcements"]["enabled"],
                      "radius_m": cfg["announcements"]["radius_m"],
                      "news_radius_m": cfg["news"]["local_radius_m"]},
        }

    @app.get("/api/status")
    def get_status():
        return svc.status

    @app.get("/api/location")
    def get_location():
        loc = svc.locations.current
        return loc.to_dict() if loc else None

    @app.post("/api/location")
    async def post_location(body: LocationIn):
        if not svc.cfg["location"]["browser"]:
            raise HTTPException(403, "Locatie via de browser staat uit in de configuratie")
        await svc.set_location(Location(body.lat, body.lon, body.accuracy, "browser", time.time()))
        return svc.locations.current.to_dict()

    @app.get("/api/incidents")
    def get_incidents(minutes: int = Query(default=None, ge=1, le=24 * 60)):
        minutes = minutes or svc.cfg["map"]["default_window_minutes"]
        loc = svc.locations.current
        incidents = svc.db.incidents_since(time.time() - minutes * 60)
        news = svc.db.news_for_incidents([i["id"] for i in incidents])
        return [svc.enrich(i, loc, news.get(i["id"], [])) for i in incidents]

    @app.get("/api/speedcams")
    def get_speedcams():
        return svc.db.speedcams() if svc.cfg["speedcams"]["enabled"] else []

    @app.get("/api/statiegeld")
    def get_statiegeld(bbox: str = Query(description="west,zuid,oost,noord in graden")):
        if not svc.cfg["statiegeld"]["enabled"]:
            return []
        try:
            west, south, east, north = (float(v) for v in bbox.split(","))
        except ValueError:
            raise HTTPException(422, "bbox moet 'west,zuid,oost,noord' zijn")
        if east - west > 1.5 or north - south > 1.5:
            raise HTTPException(422, "Gebied te groot: zoom verder in")
        return svc.db.statiegeld_in_bbox(south, west, north, east, STATIEGELD_LIMIT)

    def parse_kinds(kinds: str | None) -> list[str] | None:
        if not kinds:
            return None
        wanted = [k for k in kinds.split(",") if k in PARKING_KINDS]
        return wanted or None

    @app.get("/api/parking")
    def get_parking(bbox: str = Query(description="west,zuid,oost,noord in graden"),
                    kinds: str | None = Query(default=None, description="bijv. betaald,garage")):
        if not svc.cfg["parking"]["enabled"]:
            return []
        try:
            west, south, east, north = (float(v) for v in bbox.split(","))
        except ValueError:
            raise HTTPException(422, "bbox moet 'west,zuid,oost,noord' zijn")
        if east - west > 0.5 or north - south > 0.5:
            raise HTTPException(422, "Gebied te groot: zoom verder in")
        return svc.db.parking_in_bbox(south, west, north, east, parse_kinds(kinds), PARKING_LIMIT)

    @app.get("/api/parking/at")
    def get_parking_at(lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180),
                       kinds: str | None = None):
        """Zones waarin dit punt ligt (bijv. jouw huidige locatie)."""
        if not svc.cfg["parking"]["enabled"]:
            return []
        candidates = svc.db.parking_in_bbox(lat, lon, lat, lon, parse_kinds(kinds), PARKING_LIMIT)
        here = [z for z in candidates if contains(z["geometry"], lon, lat)]
        if not any(z["kind"] in ("betaald", "blauw") for z in here):
            # Geen getekende zone: staat er een parkeerautomaat van een zone zonder kaartvlak vlakbij?
            pad = METER_NEAR_M / 111_000 * 2
            nearby = []
            for z in svc.db.parking_in_bbox(lat - pad, lon - pad, lat + pad, lon + pad,
                                            parse_kinds(kinds), PARKING_LIMIT):
                if z["geometry"]["type"] != "MultiPoint":
                    continue
                d = min(haversine_m(lat, lon, y, x) for x, y in z["geometry"]["coordinates"])
                if d <= METER_NEAR_M:
                    nearby.append({**z, "approx_distance_m": round(d)})
            here += sorted(nearby, key=lambda z: z["approx_distance_m"])[:2]
        # Wat voor iedereen geldt (betaald, blauwe zone) eerst, vergunningzones daarna.
        return sorted(here, key=lambda z: z["kind"] not in ("betaald", "blauw"))

    @app.get("/api/shops")
    def get_shops(bbox: str = Query(description="west,zuid,oost,noord in graden")):
        """Supermarkten, buurt-/avondwinkels en markten in een gebied."""
        if not svc.cfg["shops"]["enabled"]:
            return []
        try:
            west, south, east, north = (float(v) for v in bbox.split(","))
        except ValueError:
            raise HTTPException(422, "bbox moet 'west,zuid,oost,noord' zijn")
        if east - west > 1 or north - south > 1:
            raise HTTPException(422, "Gebied te groot: zoom verder in")
        shops = svc.db.shops_in_bbox(south, west, north, east, SHOPS_LIMIT)
        if svc.cfg["statiegeld"]["enabled"] and shops:
            # Winkel met eigen inleverpunt: op de kaart één icoon in plaats van twee.
            pad = 0.001
            points = svc.db.statiegeld_in_bbox(south - pad, west - pad, north + pad, east + pad,
                                               STATIEGELD_LIMIT * 2)
            link_statiegeld(shops, points)
        return shops

    @app.get("/api/roadworks")
    async def get_roadworks(bbox: str = Query(description="west,zuid,oost,noord in graden"),
                            planned: bool = Query(default=False, description="ook geplande werken"),
                            near: str | None = Query(default=None, description="lat,lon: afstand, "
                                                     "relevantie en straatnaam, belangrijkste eerst"),
                            limit: int = Query(default=ROADWORKS_LIMIT, ge=1, le=ROADWORKS_LIMIT)):
        """Wegwerkzaamheden, afsluitingen en evenementen op de weg in een gebied."""
        rcfg = svc.cfg["roadworks"]
        if not rcfg["enabled"]:
            return []
        try:
            west, south, east, north = (float(v) for v in bbox.split(","))
        except ValueError:
            raise HTTPException(422, "bbox moet 'west,zuid,oost,noord' zijn")
        if east - west > 1 or north - south > 1:
            raise HTTPException(422, "Gebied te groot: zoom verder in")
        now = time.time()
        until = now + rcfg["ahead_days"] * 86400 if planned else now
        works = svc.db.roadworks_in_bbox(south, west, north, east, until, now)
        for w in works:
            w["active"] = is_active(w, now)
        if near:
            try:
                lat, lon = (float(v) for v in near.split(","))
            except ValueError:
                raise HTTPException(422, "near moet 'lat,lon' zijn")
            for w in works:
                w["distance_m"] = round(haversine_m(lat, lon, w["lat"], w["lon"]))
                w["relevance"] = roadwork_relevance(w, w["distance_m"], rcfg["list_radius_m"], now)
            works.sort(key=lambda w: (-w["relevance"], w["distance_m"]))
            works = works[:limit]
            top = works[:ROADWORKS_STREETS]
            streets = await asyncio.gather(*(svc.street_at(w["lat"], w["lon"]) for w in top))
            for w, street in zip(top, streets):
                w["street"] = street
        return works[:limit]

    @app.get("/api/charging")
    def get_charging(bbox: str = Query(description="west,zuid,oost,noord in graden"),
                     plugs: str | None = Query(default=None, description="bijv. 'CCS,CHAdeMO'"),
                     min_kw: float = Query(default=0, ge=0, le=1000),
                     available: bool = False, card: bool = False, public: bool = False,
                     always_open: bool = False,
                     near: str | None = Query(default=None, description="lat,lon: sorteer op afstand"),
                     limit: int = Query(default=CHARGING_LIMIT, ge=1, le=CHARGING_LIMIT)):
        """Laadlocaties in een gebied, gefilterd op de wensen van de gebruiker (profiel)."""
        if not svc.cfg["charging"]["enabled"]:
            return {"stations": [], "status_ts": None}
        try:
            west, south, east, north = (float(v) for v in bbox.split(","))
        except ValueError:
            raise HTTPException(422, "bbox moet 'west,zuid,oost,noord' zijn")
        if east - west > 0.6 or north - south > 0.6:
            raise HTTPException(422, "Gebied te groot: zoom verder in")
        wanted = {p.strip() for p in plugs.split(",") if p.strip()} if plugs else None
        stations = []
        for s in svc.db.charging_in_bbox(south, west, north, east):
            status = svc.charging_status.get(s["id"])
            if charging_matches(s, status, plugs=wanted, min_kw=min_kw, available=available,
                                card=card, public=public, always_open=always_open):
                stations.append({**s, "status": status})
        if near:
            try:
                lat, lon = (float(v) for v in near.split(","))
            except ValueError:
                raise HTTPException(422, "near moet 'lat,lon' zijn")
            for s in stations:
                s["distance_m"] = round(haversine_m(lat, lon, s["lat"], s["lon"]))
            stations.sort(key=lambda s: s["distance_m"])
        return {"stations": stations[:limit], "status_ts": svc.charging_status_ts,
                "truncated": len(stations) > limit}

    @app.get("/api/local")
    async def get_local(lat: float | None = Query(default=None, ge=-90, le=90),
                        lon: float | None = Query(default=None, ge=-180, le=180)):
        """Nieuws en bekendmakingen rond een punt (standaard: jouw locatie)."""
        if lat is None or lon is None:
            loc = svc.locations.current
            if loc is None:
                return {"place": None, "gemeente": None, "news": [], "announcements": []}
            lat, lon = loc.lat, loc.lon
        return await svc.local_overview(lat, lon)

    @app.get("/api/events")
    async def events(request: Request):
        async def stream():
            async with svc.bus.subscribe() as queue:
                yield ": verbonden\n\n"
                while not await request.is_disconnected():
                    try:
                        event, data = await asyncio.wait_for(queue.get(), HEARTBEAT_S)
                    except asyncio.TimeoutError:
                        yield ": ping\n\n"
                        continue
                    yield format_sse(event, data)

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    @app.get("/")
    def index():
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/proef")
    def proef():
        """Proefversie van de kaart met MapLibre (vectorkaart, draaien, kantelen)."""
        return FileResponse(STATIC_DIR / "proef.html")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


def app() -> FastAPI:  # voor `uvicorn --factory sirene.main:app`
    return create_app()
