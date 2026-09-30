"""Optioneel wachtwoord voor de hele app.

Thuis, op je eigen netwerk, is een wachtwoord niet nodig. Maak je de server van buiten
bereikbaar (poort open, VPN met gasten, reverse proxy), zet dan `access.password` in
config.yaml of BUURTRADAR_PASSWORD in .env. Wie inlogt krijgt een cookie voor een jaar;
scripts en Home Assistant kunnen het wachtwoord als `Authorization: Bearer ...` meesturen.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import secrets
import time

from fastapi import Request
from fastapi.responses import HTMLResponse, JSONResponse, Response

from .db import Database

COOKIE = "buurtradar_session"
COOKIE_MAX_AGE = 365 * 24 * 3600
OPEN_PATHS = ("/healthz", "/login", "/api/login", "/static/", "/manifest.webmanifest")
FAIL_DELAY_S = 1.5    # na een fout wachten: raden van wachtwoorden wordt zo traag
MAX_FAILS = 20        # daarna per IP tien minuten dicht


class Access:
    def __init__(self, db: Database, password: str) -> None:
        self.password = password or ""
        secret = db.meta_get("session_secret")
        if not secret:
            secret = secrets.token_hex(32)
            db.meta_set("session_secret", secret)
        self._secret = secret.encode()
        self._fails: dict[str, list[float]] = {}

    @property
    def enabled(self) -> bool:
        return bool(self.password)

    def token(self) -> str:
        """Eén sessietoken voor alle apparaten; een nieuw wachtwoord maakt oude cookies ongeldig."""
        pw_hash = hashlib.sha256(self.password.encode()).hexdigest()
        return hmac.new(self._secret, f"session:v1:{pw_hash}".encode(), "sha256").hexdigest()

    def check_password(self, given: str) -> bool:
        return hmac.compare_digest(given.encode(), self.password.encode())

    def is_authenticated(self, request: Request) -> bool:
        cookie = request.cookies.get(COOKIE, "")
        if cookie and hmac.compare_digest(cookie, self.token()):
            return True
        auth = request.headers.get("Authorization", "")
        return auth.startswith("Bearer ") and self.check_password(auth[7:].strip())

    def blocked(self, ip: str, now: float | None = None) -> bool:
        now = now or time.time()
        recent = [t for t in self._fails.get(ip, []) if now - t < 600]
        self._fails[ip] = recent
        return len(recent) >= MAX_FAILS

    def note_failure(self, ip: str) -> None:
        self._fails.setdefault(ip, []).append(time.time())

    async def login(self, request: Request, password: str) -> Response:
        ip = request.client.host if request.client else "?"
        if self.blocked(ip):
            return JSONResponse({"error": "Te vaak geprobeerd. Wacht tien minuten."}, status_code=429)
        if not self.check_password(password):
            self.note_failure(ip)
            await asyncio.sleep(FAIL_DELAY_S)
            return JSONResponse({"error": "Wachtwoord klopt niet."}, status_code=401)
        resp = JSONResponse({"ok": True})
        resp.set_cookie(COOKIE, self.token(), max_age=COOKIE_MAX_AGE, httponly=True, samesite="lax",
                        secure=request.url.scheme == "https", path="/")
        return resp

    @staticmethod
    def logout() -> Response:
        resp = JSONResponse({"ok": True})
        resp.delete_cookie(COOKIE, path="/")
        return resp


LOGIN_HTML = """<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Buurtradar – inloggen</title><link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.4 system-ui, sans-serif;
         background: #f3f4f6; color: #111827; }
  form { background: #fff; padding: 24px 28px; border-radius: 14px; box-shadow: 0 6px 24px rgba(0,0,0,.12);
         width: min(340px, calc(100% - 32px)); }
  h1 { font-size: 18px; margin: 0 0 4px; } p { margin: 0 0 14px; color: #6b7280; font-size: 13px; }
  input { width: 100%; box-sizing: border-box; font: inherit; padding: 9px 10px; border: 1px solid #d1d5db;
          border-radius: 8px; margin-bottom: 10px; }
  button { width: 100%; font: inherit; font-weight: 600; padding: 9px; border: 0; border-radius: 8px;
           background: #0ea5e9; color: #fff; cursor: pointer; }
  .err { color: #dc2626; font-size: 13px; min-height: 18px; margin: 0 0 8px; }
  @media (prefers-color-scheme: dark) { body { background: #111827; color: #f9fafb; }
    form { background: #1f2937; } input { background: #111827; color: #f9fafb; border-color: #374151; } }
</style></head><body>
<form id="f"><h1>Buurtradar</h1><p>Deze kaart is beveiligd met een wachtwoord.</p>
<input type="password" id="pw" placeholder="Wachtwoord" autocomplete="current-password" autofocus required>
<div class="err" id="err"></div><button type="submit">Inloggen</button></form>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: document.getElementById("pw").value }) });
  if (r.ok) { location.href = new URLSearchParams(location.search).get("next") || "/"; return; }
  document.getElementById("err").textContent = (await r.json().catch(() => ({}))).error || "Inloggen mislukt.";
});
</script></body></html>"""


def login_page() -> HTMLResponse:
    return HTMLResponse(LOGIN_HTML)
