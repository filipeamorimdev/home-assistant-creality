"""Download the current job's G-code once and keep its 2D silhouette."""

from __future__ import annotations

import asyncio
import logging
from pathlib import PurePosixPath
import time
from typing import Any
from urllib.parse import quote

import aiohttp
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .gcode_profile import GcodeProfiler

_LOGGER = logging.getLogger(__name__)

# Verified on stock K1-family firmware: files in printer_data/gcodes are served here.
GCODE_URL = "http://{host}/downloads/gcode/{name}"
MAX_GCODE_BYTES = 256 * 1024 * 1024
FEED_BYTES = 1024 * 1024
RETRY_SECONDS = 300
# The printer serves ~0.5 MB/s; only stalls are fatal, not slow large files.
_TIMEOUT = aiohttp.ClientTimeout(total=None, connect=10, sock_read=30)


def gcode_name(print_file: str | None) -> str | None:
    """Basename of a job served by the printer, None for USB or unknown paths."""
    path = PurePosixPath(str(print_file or "").strip())
    if not path.name.lower().endswith(".gcode"):
        return None
    if path.parent.parts[-2:] != ("printer_data", "gcodes"):
        return None
    return path.name


class ProfileMonitor:
    """Per-printer state behind the ``creality/print_profile`` command.

    ``status``: ``no_job`` | ``pending`` (file loaded, printer idle) |
    ``loading`` | ``ready`` | ``unavailable`` (file not served / no extrusion) |
    ``failed`` (retried later).
    """

    def __init__(self, coordinator) -> None:
        self.coordinator = coordinator
        self.hass = coordinator.hass
        self.job: tuple[str, str] | None = None
        self.status = "no_job"
        self.profile: dict[str, Any] | None = None
        self._task: asyncio.Task | None = None
        self._retry_at = 0.0

    @callback
    def observe(self, data: dict[str, Any], idle: bool = False) -> None:
        """Track the loaded job; download its G-code once it is not ``idle``.

        An idle printer keeps the last file loaded, and nothing shows its
        profile then; the download waits until that job (or another) is active
        or has just ended.
        """
        file = str(data.get("printFileName") or "").strip()
        job = (file, str(data.get("printStartTime") or "")) if file else None
        name = gcode_name(file)
        if job != self.job:
            self._cancel()
            self.job, self.profile, self._retry_at = job, None, 0.0
            if job is None or name is None:
                self.status = "no_job" if job is None else "unavailable"
                return
            self.status = "pending"
        if idle or self.status not in ("pending", "failed"):
            return
        if self.status == "failed" and time.monotonic() < self._retry_at:
            return
        self.status = "loading"
        self._task = self.coordinator.entry.async_create_background_task(
            self.hass, self._load(job, name), f"creality_profile_{self.coordinator.host}"
        )

    def _cancel(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = None

    async def _load(self, job: tuple[str, str], name: str) -> None:
        url = GCODE_URL.format(host=self.coordinator.host, name=quote(name))
        try:
            profile = await self._fetch(url)
        except asyncio.CancelledError:
            raise
        except FileNotFoundError:
            status, profile = "unavailable", None
        except (OSError, TimeoutError, ValueError, aiohttp.ClientError) as err:
            _LOGGER.debug("G-code profile for %s failed: %s", name, err)
            status, profile = "failed", None
            self._retry_at = time.monotonic() + RETRY_SECONDS
        else:
            status = "ready" if profile else "unavailable"
        if job == self.job:
            self.status, self.profile = status, profile

    async def _fetch(self, url: str) -> dict[str, Any] | None:
        profiler = GcodeProfiler()
        session = async_get_clientsession(self.hass)
        async with session.get(url, timeout=_TIMEOUT, allow_redirects=False) as response:
            if response.status == 404:
                raise FileNotFoundError(url)
            if response.status != 200:
                raise ValueError(f"G-code HTTP {response.status}")
            total = 0
            buf = bytearray()
            async for chunk in response.content.iter_chunked(64 * 1024):
                total += len(chunk)
                if total > MAX_GCODE_BYTES:
                    raise ValueError("G-code file too large")
                buf.extend(chunk)
                if len(buf) >= FEED_BYTES:
                    data, buf = bytes(buf), bytearray()
                    await self.hass.async_add_executor_job(profiler.feed, data)
            await self.hass.async_add_executor_job(profiler.feed, bytes(buf))
        return await self.hass.async_add_executor_job(profiler.result)

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "file": self.job[0] if self.job else None,
            "print_start_time": self.job[1] if self.job else None,
            "profile": self.profile,
        }

    async def async_stop(self) -> None:
        self._cancel()
