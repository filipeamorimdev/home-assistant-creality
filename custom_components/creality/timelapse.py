"""Timelapse videos recorded by the printer: listed over WS, proxied through HA."""

from __future__ import annotations

import asyncio
import logging
from pathlib import PurePosixPath
import re
import time
from typing import Any
from urllib.parse import quote

import aiohttp
from aiohttp import web
from homeassistant.components.http import KEY_HASS, HomeAssistantView
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

# Verified on stock K1-family firmware: `elapseVideoList` entries carry
# `id` (== telemetry printStartTime) and `videoname` served at this path.
LIST_KEY = "elapseVideoList"
LIST_REQUEST = {"method": "get", "params": {"reqElapseVideoList": 1}}
VIDEO_URL = "http://{host}/downloads/video/{name}"
VIEW_URL = "/api/creality/timelapse/{entry_id}/{name}"
LIST_TIMEOUT = 8.0
LIST_MAX_AGE = 10.0
_VIDEO_NAME = re.compile(r"^\d{1,20}\.mp4$")
# The printer serves ~0.5 MB/s; only stalls are fatal.
_TIMEOUT = aiohttp.ClientTimeout(total=None, connect=10, sock_read=30)
_FORWARD_HEADERS = ("Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified")


def _start_id(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def find_video(entries: list[dict[str, Any]], start_time: Any) -> dict[str, Any] | None:
    """Video recorded for the job that started at ``start_time``."""
    start = _start_id(start_time)
    if start is None:
        return None
    for entry in entries:
        if _start_id(entry.get("id")) == start and _VIDEO_NAME.match(str(entry.get("videoname") or "")):
            return entry
    return None


def download_name(entry: dict[str, Any]) -> str:
    """``<gcode stem>-timelapse.mp4``, falling back to the printer's file name."""
    stem = PurePosixPath(str(entry.get("gcodename") or "")).stem.strip()
    return f"{stem}-timelapse.mp4" if stem else str(entry.get("videoname"))


class TimelapseIndex:
    """Per-printer cache of the printer's timelapse list."""

    def __init__(self, coordinator) -> None:
        self.coordinator = coordinator
        self.entries: list[dict[str, Any]] = []
        self._fetched_at: float | None = None
        self._waiter: asyncio.Future[None] | None = None

    @callback
    def observe(self, frame: dict[str, Any]) -> None:
        """Take the (large) list out of a telemetry frame instead of merging it."""
        if LIST_KEY not in frame:
            return
        entries = frame.pop(LIST_KEY)
        if not isinstance(entries, list):
            return
        self.entries = [entry for entry in entries if isinstance(entry, dict)]
        self._fetched_at = time.monotonic()
        if self._waiter and not self._waiter.done():
            self._waiter.set_result(None)

    async def async_list(self) -> list[dict[str, Any]]:
        """Fresh list from the printer; raises ConnectionError/TimeoutError."""
        if self._fetched_at is not None and time.monotonic() - self._fetched_at < LIST_MAX_AGE:
            return self.entries
        waiter = self._waiter
        if waiter is None or waiter.done():
            waiter = self._waiter = asyncio.get_running_loop().create_future()
            try:
                await self.coordinator.client.send_json(LIST_REQUEST)
            except Exception as err:  # noqa: BLE001 - websockets raises its own hierarchy
                self._waiter = None
                waiter.cancel()
                raise ConnectionError(f"Timelapse list request failed: {err}") from err
        try:
            await asyncio.wait_for(asyncio.shield(waiter), LIST_TIMEOUT)
        except TimeoutError:
            # Unanswered (dropped request, reconnect): the next call asks again.
            if self._waiter is waiter:
                self._waiter = None
                waiter.cancel()
            raise
        return self.entries

    async def async_find(self, start_time: Any) -> dict[str, Any] | None:
        return find_video(await self.async_list(), start_time)

    def video(self, name: str) -> dict[str, Any] | None:
        return next((entry for entry in self.entries if entry.get("videoname") == name), None)


class TimelapseView(HomeAssistantView):
    """Stream a listed timelapse from the printer (signed URLs from the card)."""

    url = VIEW_URL
    name = "api:creality:timelapse"
    requires_auth = True

    async def get(self, request: web.Request, entry_id: str, name: str) -> web.StreamResponse:
        hass = request.app[KEY_HASS]
        coordinator = hass.data.get(DOMAIN, {}).get(entry_id)
        if coordinator is None or not _VIDEO_NAME.match(name):
            raise web.HTTPNotFound
        # Only proxy files the printer itself listed.
        entry = coordinator.timelapse.video(name)
        if entry is None:
            try:
                await coordinator.timelapse.async_list()
            except (ConnectionError, TimeoutError) as err:
                raise web.HTTPBadGateway from err
            entry = coordinator.timelapse.video(name)
            if entry is None:
                raise web.HTTPNotFound

        headers = {"Range": request.headers["Range"]} if "Range" in request.headers else {}
        url = VIDEO_URL.format(host=coordinator.host, name=name)
        session = async_get_clientsession(hass)
        try:
            upstream = await session.get(url, headers=headers, timeout=_TIMEOUT, allow_redirects=False)
        except (aiohttp.ClientError, TimeoutError) as err:
            raise web.HTTPBadGateway from err
        async with upstream:
            if upstream.status == 404:
                raise web.HTTPNotFound
            if upstream.status not in (200, 206):
                raise web.HTTPBadGateway
            response = web.StreamResponse(status=upstream.status)
            for header in _FORWARD_HEADERS:
                if header in upstream.headers:
                    response.headers[header] = upstream.headers[header]
            response.content_type = "video/mp4"
            disposition = "attachment" if request.query.get("download") else "inline"
            filename = download_name(entry)
            fallback = filename.encode("ascii", "replace").decode().replace('"', "_").replace("?", "_")
            response.headers["Content-Disposition"] = (
                f"{disposition}; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename)}"
            )
            await response.prepare(request)
            try:
                async for chunk in upstream.content.iter_chunked(64 * 1024):
                    await response.write(chunk)
            except (aiohttp.ClientError, OSError, TimeoutError) as err:
                # Viewer closed the player or the printer stalled mid-stream.
                _LOGGER.debug("Timelapse %s stream ended early: %s", name, err)
                return response
            await response.write_eof()
            return response
