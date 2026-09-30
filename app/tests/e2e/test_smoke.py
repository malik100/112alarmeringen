"""Rooktest in een echte browser: laadt de kaart, zet elke laag aan en let op fouten.

Draaien: pip install playwright && playwright install chromium && pytest tests/e2e
Zonder Playwright of browser wordt de test overgeslagen. Er gaat niets naar internet: kaarttegels
en externe bronnen worden geblokkeerd, de app draait met een lege database.
"""

from __future__ import annotations

import copy
import os
import socket
import threading
import time

import pytest

playwright = pytest.importorskip("playwright.sync_api")

from sirene.config import DEFAULTS  # noqa: E402
from sirene.main import create_app  # noqa: E402
from sirene.service import Service  # noqa: E402

LAYERS = ["parking", "statiegeld", "shops", "fuel", "roadworks", "ov", "cams", "charging", "news",
          "announcements", "incidents"]


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    import uvicorn

    cfg = copy.deepcopy(DEFAULTS)
    cfg["database"] = str(tmp_path_factory.mktemp("db") / "sirene.db")
    cfg["location"]["fallback"] = {"lat": 52.378, "lon": 4.846}
    svc = Service(cfg)
    app = create_app(svc, start_background=False)
    port = _free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    uv = uvicorn.Server(config)
    thread = threading.Thread(target=uv.run, daemon=True)
    thread.start()
    for _ in range(100):
        if uv.started:
            break
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    uv.should_exit = True
    thread.join(timeout=5)


@pytest.fixture(scope="module")
def browser():
    with playwright.sync_playwright() as p:
        try:
            # Eigen Chromium (bijv. /opt/pw-browsers/chromium/chrome) via PLAYWRIGHT_CHROMIUM.
            b = p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM") or None,
                                  args=["--use-gl=swiftshader"])
        except Exception as exc:  # geen browser geïnstalleerd
            pytest.skip(f"Geen Chromium voor Playwright: {exc}")
        yield b
        b.close()


@pytest.mark.parametrize("width,height", [(1280, 800), (390, 844)])
def test_all_layers_without_errors(server, browser, width, height):
    page = browser.new_page(viewport={"width": width, "height": height})
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    # Niets naar buiten: tegels en externe bronnen mislukken stil.
    page.route(lambda url: not url.startswith(server), lambda route: route.abort())
    page.goto(server)
    page.wait_for_function("typeof state !== 'undefined' && state.config")
    for layer in LAYERS:
        page.evaluate(f"setLayer('{layer}', true)")
    page.evaluate("map.setView([52.378, 4.846], 16); 0")
    page.wait_for_timeout(1500)
    for layer in LAYERS:
        page.evaluate(f"setLayer('{layer}', false)")
    page.evaluate("applyPreset('onderweg')")
    page.wait_for_timeout(500)
    page.fill("#search-q", "amsterdam")
    page.wait_for_timeout(600)
    page.evaluate("setPanel(true)")  # op de telefoon start het paneel ingeklapt
    page.click(".lsec[data-sec=status] .lsec-head")
    page.click(".lsec[data-sec=instellingen] .lsec-head")
    assert page.evaluate("document.querySelectorAll('.lsec:not([hidden])').length") >= 3
    assert "Vaste locatie" in page.text_content("#st-loc")
    # Tegels mislukken bewust; alle andere fouten tellen.
    real = [e for e in errors if "tile" not in e.lower() and "net::" not in e and "Failed to load resource" not in e]
    assert real == [], real
    page.close()
