"""Timelapse videos recorded by the printer: listed over WS, proxied through HA."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
import logging
import os
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
# Copy the archive saved into the timelapse folder, by job start id.
SAVED_VIEW_URL = "/api/creality/timelapse_saved/{entry_id}/{start}.mp4"
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


def _disposition(request: web.Request, filename: str) -> str:
    disposition = "attachment" if request.query.get("download") else "inline"
    fallback = filename.encode("ascii", "replace").decode().replace('"', "_").replace("?", "_")
    return f"{disposition}; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename)}"


def download_name(entry: dict[str, Any]) -> str:
    """``<gcode stem>-timelapse.mp4``, falling back to the printer's file name."""
    stem = PurePosixPath(str(entry.get("gcodename") or "")).stem.strip()
    return f"{stem}-timelapse.mp4" if stem else str(entry.get("videoname"))


class PrinterReply:
    """A WS request whose answer arrives later as a telemetry frame.

    Concurrent callers share one request and its answer. A caller that times
    out gives up alone: the shared future is never cancelled, so the others
    keep waiting for their own timeout. A request unanswered for ``timeout``
    seconds (dropped, reconnect) is sent again by the next caller.
    """

    def __init__(self, send: Callable[[], Awaitable[None]], timeout: float) -> None:
        self._send = send
        self._timeout = timeout
        self._future: asyncio.Future[None] | None = None
        self._asked_at: float | None = None

    @callback
    def answered(self) -> None:
        if self._future and not self._future.done():
            self._future.set_result(None)
        self._future = None

    async def async_wait(self, fresh: bool = False) -> None:
        """Ask (unless a recent request is pending) and wait for the answer.

        ``fresh`` always sends a new request, for an answer the printer can only
        give after a change (an upload). Raises ConnectionError/TimeoutError.
        """
        loop = asyncio.get_running_loop()
        future = self._future
        if future is None or future.done() or fresh:
            future = loop.create_future()
            if self._future is not None and not self._future.done():
                # Callers of the replaced request are answered by the new one.
                future.add_done_callback(lambda _f, old=self._future: old.done() or old.set_result(None))
            self._future, self._asked_at = future, None
        if self._asked_at is None or loop.time() - self._asked_at >= self._timeout:
            self._asked_at = loop.time()
            try:
                await self._send()
            except Exception as err:  # noqa: BLE001 - websockets raises its own hierarchy
                self._asked_at = None
                raise ConnectionError(f"Printer request failed: {err}") from err
        await asyncio.wait_for(asyncio.shield(future), self._timeout)


class TimelapseIndex:
    """Per-printer cache of the printer's timelapse list."""

    def __init__(self, coordinator) -> None:
        self.coordinator = coordinator
        self.entries: list[dict[str, Any]] = []
        self._fetched_at: float | None = None
        self._reply = PrinterReply(lambda: coordinator.client.send_json(LIST_REQUEST), LIST_TIMEOUT)

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
        self._reply.answered()

    async def async_list(self) -> list[dict[str, Any]]:
        """Fresh list from the printer; raises ConnectionError/TimeoutError."""
        if self._fetched_at is not None and time.monotonic() - self._fetched_at < LIST_MAX_AGE:
            return self.entries
        await self._reply.async_wait()
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
            response.headers["Content-Disposition"] = _disposition(request, download_name(entry))
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


class SavedTimelapseView(HomeAssistantView):
    """Serve a job's copy from the timelapse folder (works while the printer is off)."""

    url = SAVED_VIEW_URL
    name = "api:creality:timelapse_saved"
    requires_auth = True

    async def get(self, request: web.Request, entry_id: str, start: str) -> web.StreamResponse:
        hass = request.app[KEY_HASS]
        coordinator = hass.data.get(DOMAIN, {}).get(entry_id)
        if coordinator is None or not start.isdigit() or len(start) > 20:
            raise web.HTTPNotFound
        # Only files matching the job inside the configured folder are served.
        path = await coordinator.archive.async_find_saved(start)
        if path is None:
            raise web.HTTPNotFound
        # FileResponse answers Range requests, so the player can seek.
        return web.FileResponse(
            path,
            headers={
                "Content-Type": "video/mp4",
                "Content-Disposition": _disposition(request, os.path.basename(path)),
            },
        )
