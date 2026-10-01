"""Optionele pushmeldingen via Home Assistant of een eigen ntfy-server."""

from __future__ import annotations

import logging
from typing import Any

import httpx

log = logging.getLogger(__name__)

EMOJI = {"brandweer": "🚒", "ambulance": "🚑", "politie": "🚓"}


def format_message(incident: dict[str, Any], distance_m: float) -> tuple[str, str]:
    icon = EMOJI.get(incident["discipline"], "🚨")
    title = f"{icon} {incident['discipline'].capitalize()} op {round(distance_m)} m"
    body = incident.get("description") or incident["title"]
    return title, body


class Notifier:
    def __init__(self, client: httpx.AsyncClient, cfg: dict[str, Any], ha_cfg: dict[str, Any]) -> None:
        self.client = client
        self.cfg = cfg
        self.ha_cfg = ha_cfg

    async def send(self, incident: dict[str, Any], distance_m: float) -> None:
        title, body = format_message(incident, distance_m)
        await self.send_text(title, body, tag=f"buurtradar-{incident['id']}", url=incident.get("link"),
                             tags=[incident["discipline"]], priority=4)

    async def send_text(self, title: str, body: str, tag: str, url: str | None = None,
                        tags: list[str] | None = None, priority: int = 3) -> None:
        """Willekeurige melding (wegwerk, bekendmaking, afval) via het ingestelde kanaal."""
        if self.cfg["channel"] == "ntfy":
            await self._ntfy(title, body, tag, url, tags or [], priority)
        else:
            await self._homeassistant(title, body, tag, url)

    async def _homeassistant(self, title: str, body: str, tag: str, url: str | None) -> None:
        domain, _, service = self.cfg["homeassistant_service"].partition(".")
        resp = await self.client.post(
            f"{self.ha_cfg['url'].rstrip('/')}/api/services/{domain}/{service}",
            headers={"Authorization": f"Bearer {self.ha_cfg['token']}"},
            json={"title": title, "message": body, "data": {"tag": tag, "url": url or ""}},
            timeout=10,
        )
        resp.raise_for_status()

    async def _ntfy(self, title: str, body: str, tag: str, url: str | None, tags: list[str],
                    priority: int) -> None:
        ntfy = self.cfg["ntfy"]
        # JSON-publicatie ondersteunt UTF-8 (emoji) in de titel, headers niet.
        payload = {"topic": ntfy["topic"], "title": title, "message": body, "priority": priority, "tags": tags}
        if url:
            payload["click"] = url
        headers = {"Authorization": f"Bearer {ntfy['token']}"} if ntfy.get("token") else {}
        resp = await self.client.post(ntfy["url"].rstrip("/") + "/", json=payload,
                                      headers=headers, timeout=10)
        resp.raise_for_status()
