"""Webserver: API, live updates en de kaart."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .auth import OPEN_PATHS, Access, login_page
from .config import load_config
from .events import format_sse
from .location import Location
from .service import Service
from .geo import haversine_m
from .geocoder import search_places
from .sources.charging import matches as charging_matches
from .sources.roadworks import is_active, relevance as roadwork_relevance
from .sources.npr import contains
from .sources.shops import link_statiegeld

log = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).parent / "static"
HEARTBEAT_S = 20
STATIEGELD_LIMIT = 2000
PARKING_LIMIT = 800
METER_NEAR_M = 200  # "waarschijnlijk hier": parkeerautomaat van een zone zonder kaartvlak
CHARGING_LIMIT = 1500
SHOPS_LIMIT = 2000
FUEL_LIMIT = 2000
AMENITIES_LIMIT = 3000
AMENITY_KINDS = ("aed", "toilet", "water")
ROADWORKS_LIMIT = 1500
ROADWORKS_STREETS = 25   # zoveel werken per lijst krijgen een straatnaam (PDOK, gecachet)
PARKING_KINDS = {"betaald", "blauw", "vergunning", "garage"}
OV_MODES = {"trein", "metro", "tram", "bus", "veer"}

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)


class LocationIn(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    accuracy: float | None = Field(default=None, ge=0)


class LoginIn(BaseModel):
    password: str = Field(max_length=200)


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
    access = Access(svc.db, svc.cfg["access"]["password"])
    app.state.access = access

    @app.middleware("http")
    async def require_login(request: Request, call_next):
        """Met een wachtwoord in de configuratie: alles achter het inlogscherm, behalve statische
        bestanden, de gezondheidscheck en het inloggen zelf."""
        path = request.url.path
        if access.enabled and not path.startswith(OPEN_PATHS) and not access.is_authenticated(request):
            if path.startswith("/api/"):
                return JSONResponse({"error": "Inloggen vereist"}, status_code=401)
            return RedirectResponse(f"/login?next={path}", status_code=303)
        return await call_next(request)

    @app.get("/login")
    def get_login(request: Request):
        if not access.enabled or access.is_authenticated(request):
            return RedirectResponse("/", status_code=303)
        return login_page()

    @app.post("/api/login")
    async def post_login(request: Request, body: LoginIn):
        if not access.enabled:
            return {"ok": True}
        return await access.login(request, body.password)

    @app.post("/api/logout")
    def post_logout():
        return access.logout()

    @app.middleware("http")
    async def no_stale_frontend(request: Request, call_next):
        """Laat de browser pagina, stijl en scripts altijd controleren op een nieuwe versie.

        Zonder deze kop bewaart een browser style.css en app.js soms dagenlang; na een update
        krijg je dan een nieuwe pagina met een oude opmaak. Ongewijzigde bestanden kosten alleen
        een korte controle (304 Not Modified), geen nieuwe download.
        """
        response = await call_next(request)
        path = request.url.path
        if path == "/" or (path.startswith("/static/") and "/vendor/" not in path):
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
            "password_protected": access.enabled,
            "speedcams_enabled": cfg["speedcams"]["enabled"],
            "statiegeld": {k: cfg["statiegeld"][k] for k in ("enabled", "min_zoom", "list_radius_m")},
            "parking": {k: cfg["parking"][k] for k in ("enabled", "min_zoom")},
            "charging": {k: cfg["charging"][k] for k in ("enabled", "min_zoom", "list_radius_m")},
            "shops": {k: cfg["shops"][k] for k in ("enabled", "min_zoom", "list_radius_m")},
            "fuel": {k: cfg["fuel"][k] for k in ("enabled", "min_zoom", "list_radius_m")},
            "amenities": {k: cfg["amenities"][k] for k in ("enabled", "min_zoom", "list_radius_m")},
            "roadworks": {k: cfg["roadworks"][k] for k in ("enabled", "min_zoom", "list_radius_m", "ahead_days")},
            "ov": {**{k: cfg["ov"][k] for k in ("enabled", "stops_min_zoom", "lines_min_zoom",
                                                 "vehicles_min_zoom", "list_radius_m")},
                   "ready": svc.ov.ready, "importing": svc.status["ov"]["importing"]},
            "local": {"news": cfg["news"]["enabled"],
                      "announcements": cfg["announcements"]["enabled"],
                      "radius_m": cfg["announcements"]["radius_m"],
                      "news_radius_m": cfg["news"]["local_radius_m"]},
        }

    @app.get("/api/status")
    def get_status():
        return svc.status

    @app.get("/api/status/overview")
    def get_status_overview():
        """Voor het paneel: per bron wanneer voor het laatst gelukt, fouten, en de schijfruimte."""
        import shutil
        names = {"p2000": "112-meldingen", "news": "Nieuws", "announcements": "Bekendmakingen",
                 "roadworks": "Wegwerk", "parking": "Parkeren", "statiegeld": "Statiegeld", "shops": "Winkels",
                 "fuel": "Tankstations", "amenities": "AED, toilet, water", "charging": "Laadpalen", "charging_status": "Laadpalen (beschikbaarheid)",
                 "speedcams": "Flitsers", "ov": "OV-dienstregeling", "ov_realtime": "OV actueel",
                 "homeassistant": "Home Assistant"}
        enabled = {"p2000": True, "news": svc.cfg["news"]["enabled"],
                   "announcements": svc.cfg["announcements"]["enabled"],
                   "roadworks": svc.cfg["roadworks"]["enabled"], "parking": svc.cfg["parking"]["enabled"],
                   "statiegeld": svc.cfg["statiegeld"]["enabled"], "shops": svc.cfg["shops"]["enabled"],
                   "fuel": svc.cfg["fuel"]["enabled"], "amenities": svc.cfg["amenities"]["enabled"],
                   "charging": svc.cfg["charging"]["enabled"],
                   "charging_status": svc.cfg["charging"]["enabled"],
                   "speedcams": svc.cfg["speedcams"]["enabled"], "ov": svc.cfg["ov"]["enabled"],
                   "ov_realtime": svc.cfg["ov"]["enabled"],
                   "homeassistant": svc.cfg["location"]["homeassistant"]["enabled"]}
        sources = []
        for key, label in names.items():
            if not enabled.get(key):
                continue
            st = svc.status.get(key, {})
            error = st.get("last_error")
            error_ts = None
            if error and ":" in error and error.split(":", 1)[0].isdigit():
                error_ts, error = int(error.split(":", 1)[0]), error.split(":", 1)[1].strip()
            sources.append({"key": key, "name": label, "last_ok": st.get("last_ok"), "count": st.get("count"),
                            "error": error if not st.get("last_ok") or (error_ts or 0) > st["last_ok"] else None,
                            "busy": bool(st.get("importing"))})
        files = {}
        db_path = svc.cfg["database"]
        if db_path != ":memory:":
            for name, path in (("database", Path(db_path)), ("ov", svc.ov_path())):
                try:
                    size = path.stat().st_size
                    for suffix in ("-wal", "-shm"):
                        extra = path.with_name(path.name + suffix)
                        size += extra.stat().st_size if extra.exists() else 0
                    files[name] = size
                except OSError:
                    pass
            try:
                usage = shutil.disk_usage(Path(db_path).parent)
                files["free"] = usage.free
                files["total"] = usage.total
            except OSError:
                pass
        return {"sources": sources, "disk": files, "started": svc.started}

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

    @app.get("/api/location/home")
    def get_home():
        return svc.locations.home

    @app.put("/api/location/home")
    async def put_home(body: LocationIn):
        """Vaste plek (bijv. thuis) instellen vanuit het paneel."""
        svc.locations.set_home(body.lat, body.lon)
        loc = svc.locations.current
        if loc and loc.source == "vast":
            svc.bus.publish("location", loc.to_dict())
        return svc.locations.home

    @app.delete("/api/location/home")
    async def delete_home():
        svc.locations.set_home(None, None)
        loc = svc.locations.current
        svc.bus.publish("location", loc.to_dict() if loc else None)
        return {"ok": True}

    @app.get("/api/search")
    async def search(q: str = Query(min_length=2, max_length=100)):
        """Zoeken naar een adres, straat, plaats, postcode of ov-halte."""
        places: list = []
        if svc.cfg["geocoder"]["pdok_enabled"]:
            try:
                places = await search_places(svc.client, svc.cfg["geocoder"]["pdok_url"], q)
            except (httpx.HTTPError, ValueError) as exc:
                log.warning("Zoeken via PDOK mislukt: %s", exc)
        haltes = [{"name": h["name"], "type": "halte", "lat": h["lat"], "lon": h["lon"], "halte": h["id"],
                   "modes": h["modes"]} for h in svc.ov.search_haltes(q, 4)] if svc.cfg["ov"]["enabled"] else []
        # Haltes bovenaan als de zoekterm precies een haltenaam is; anders adressen eerst.
        exact = [h for h in haltes if q.strip().lower() in h["name"].lower().split(",")[-1].strip().lower()]
        return (exact + places + [h for h in haltes if h not in exact])[:10]

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

    @app.get("/api/fuel")
    def get_fuel(bbox: str = Query(description="west,zuid,oost,noord in graden")):
        """Tankstations in een gebied, met of zonder winkel."""
        if not svc.cfg["fuel"]["enabled"]:
            return []
        try:
            west, south, east, north = (float(v) for v in bbox.split(","))
        except ValueError:
            raise HTTPException(422, "bbox moet 'west,zuid,oost,noord' zijn")
        if east - west > 1.5 or north - south > 1.5:
            raise HTTPException(422, "Gebied te groot: zoom verder in")
        return svc.db.fuel_in_bbox(south, west, north, east, FUEL_LIMIT)

    @app.get("/api/amenities")
    def get_amenities(bbox: str = Query(description="west,zuid,oost,noord in graden"),
                      kinds: str | None = Query(default=None, description="bijv. aed,toilet")):
        """AED's, openbare toiletten en drinkwaterpunten in een gebied."""
        if not svc.cfg["amenities"]["enabled"]:
            return []
        try:
            west, south, east, north = (float(v) for v in bbox.split(","))
        except ValueError:
            raise HTTPException(422, "bbox moet 'west,zuid,oost,noord' zijn")
        if east - west > 1 or north - south > 1:
            raise HTTPException(422, "Gebied te groot: zoom verder in")
        wanted = [k for k in (kinds or "").split(",") if k in AMENITY_KINDS] or None
        return svc.db.amenities_in_bbox(south, west, north, east, wanted, AMENITIES_LIMIT)

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
    async def get_charging(bbox: str = Query(description="west,zuid,oost,noord in graden"),
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
        svc.charging_status_wanted()
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

    # --- openbaar vervoer ---------------------------------------------------

    def ov_bbox(bbox: str, max_deg: float) -> tuple[float, float, float, float]:
        if not svc.cfg["ov"]["enabled"]:
            raise HTTPException(404, "Openbaar vervoer staat uit in de configuratie")
        try:
            west, south, east, north = (float(v) for v in bbox.split(","))
        except ValueError:
            raise HTTPException(422, "bbox moet 'west,zuid,oost,noord' zijn")
        if east - west > max_deg or north - south > max_deg:
            raise HTTPException(422, "Gebied te groot: zoom verder in")
        return south, west, north, east

    def ov_modes(modes: str | None) -> set[str] | None:
        wanted = {m for m in (modes or "").split(",") if m in OV_MODES}
        return wanted or None

    def ov_ready() -> None:
        if not svc.cfg["ov"]["enabled"]:
            raise HTTPException(404, "Openbaar vervoer staat uit in de configuratie")
        if not svc.ov.ready:
            raise HTTPException(503, "De dienstregeling wordt nog ingelezen, probeer het over een paar minuten")

    @app.get("/api/ov/haltes")
    def get_ov_haltes(bbox: str = Query(description="west,zuid,oost,noord in graden")):
        """Haltes en stations in een gebied, met de lijnen die er stoppen."""
        return svc.ov.haltes_in_bbox(*ov_bbox(bbox, 0.3))

    @app.get("/api/ov/near")
    async def get_ov_near(lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180),
                          limit: int = Query(default=6, ge=1, le=20),
                          departures: int = Query(default=4, ge=0, le=10)):
        """Dichtstbijzijnde haltes met hun eerstvolgende vertrekken."""
        ov_ready()
        realtime = await svc.ov_realtime()
        now = time.time()
        haltes = svc.ov.haltes_near(lat, lon, svc.cfg["ov"]["list_radius_m"], limit)
        for h in haltes:
            h["departures"] = svc.ov.departures(h["id"], now, realtime, departures)
        return {"haltes": haltes, "realtime_ts": realtime.ts}

    @app.get("/api/ov/departures")
    async def get_ov_departures(halte: int, limit: int = Query(default=30, ge=1, le=100)):
        """Vertrektijden bij een halte (alle perrons), met actuele tijden en storingen."""
        ov_ready()
        info = svc.ov.halte(halte)
        if info is None:
            raise HTTPException(404, "Onbekende halte")
        realtime = await svc.ov_realtime()
        now = time.time()
        deps = svc.ov.departures(halte, now, realtime, limit)
        alerts = svc.ov.alerts_for(realtime, halte, {d["route_id"] for d in deps}, now)
        return {"halte": info, "departures": deps, "alerts": alerts, "realtime_ts": realtime.ts}

    @app.get("/api/ov/trip")
    async def get_ov_trip(trip: str, date: str = Query(pattern=r"^\d{8}$")):
        """Eén rit: alle haltes met (verwachte) tijden en het tracé."""
        ov_ready()
        realtime = await svc.ov_realtime()
        result = svc.ov.trip(trip, date, realtime)
        if result is None:
            raise HTTPException(404, "Onbekende rit")
        return result

    @app.get("/api/ov/lines")
    def get_ov_lines(bbox: str = Query(description="west,zuid,oost,noord in graden"),
                     detailed: bool = False, modes: str | None = None):
        """Lijnen (tracés) in een gebied."""
        return svc.ov.lines_in_bbox(*ov_bbox(bbox, 1.0), detailed=detailed, modes=ov_modes(modes))

    @app.get("/api/ov/vehicles")
    async def get_ov_vehicles(bbox: str = Query(description="west,zuid,oost,noord in graden"),
                              modes: str | None = None):
        """Voertuigen die nu rijden (positie van hooguit een paar minuten oud)."""
        area = ov_bbox(bbox, 1.0)
        realtime = await svc.ov_realtime()
        return {"vehicles": svc.ov.vehicles_in_bbox(realtime, *area, time.time(), ov_modes(modes)),
                "realtime_ts": realtime.ts}

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

    @app.get("/manifest.webmanifest")
    def manifest():
        return FileResponse(STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json")

    @app.get("/")
    def index():
        return FileResponse(STATIC_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


def app() -> FastAPI:  # voor `uvicorn --factory sirene.main:app`
    return create_app()
