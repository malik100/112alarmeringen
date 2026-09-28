"""P2000-berichten ophalen uit een RSS-feed (standaard alarmeringen.nl)."""

from __future__ import annotations

import logging
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from email.utils import parsedate_to_datetime

import httpx

log = logging.getLogger(__name__)


@dataclass
class FeedItem:
    guid: str
    title: str
    description: str
    link: str
    ts: float


def parse_rss(xml_text: str) -> list[FeedItem]:
    root = ET.fromstring(xml_text)
    items = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        guid = (item.findtext("guid") or link or title).strip()
        pub = item.findtext("pubDate")
        if not title or not pub:
            continue
        try:
            ts = parsedate_to_datetime(pub).timestamp()
        except (TypeError, ValueError):
            continue
        items.append(FeedItem(
            guid=guid,
            title=title,
            description=(item.findtext("description") or "").strip(),
            link=link.split("?utm_")[0],
            ts=ts,
        ))
    return items


async def fetch_feed(client: httpx.AsyncClient, url: str) -> list[FeedItem]:
    resp = await client.get(url, timeout=20)
    resp.raise_for_status()
    return parse_rss(resp.text)
