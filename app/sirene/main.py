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

STATIC_DIR = Path(__file__).parent / "static"
HEARTBEAT_S = 20

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

    app = FastAPI(title="Sirene Radar", lifespan=lifespan)
    app.state.service = svc

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
        return [svc.enrich(i, loc) for i in svc.db.incidents_since(time.time() - minutes * 60)]

    @app.get("/api/speedcams")
    def get_speedcams():
        return svc.db.speedcams() if svc.cfg["speedcams"]["enabled"] else []

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

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


def app() -> FastAPI:  # voor `uvicorn --factory sirene.main:app`
    return create_app()
