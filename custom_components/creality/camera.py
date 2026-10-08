"""Camera platform for Creality printers."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import aiohttp
from aiohttp import web
from homeassistant.components.camera import Camera, CameraEntityFeature
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import (
    CAM_MODE_AUTO,
    CAM_MODE_CUSTOM,
    CAM_MODE_MJPEG,
    CAM_MODE_WEBRTC,
    CONF_CAMERA_MODE,
    CONF_CUSTOM_CAMERA_URL,
    DOMAIN,
    MJPEG_SNAPSHOT_URL,
    MJPEG_URL,
    WEBRTC_URL,
)
from .coordinator import CrealityCoordinator
from .entity import CrealityEntity

_LOGGER = logging.getLogger(__name__)

MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
JPEG_START = b"\xff\xd8"
JPEG_END = b"\xff\xd9"
# A stalled printer must not hold a proxied stream open forever.
STREAM_TIMEOUT = aiohttp.ClientTimeout(total=None, connect=8, sock_read=20)

# Home Assistant's bundled go2rtc (>= 1.9.10) speaks Creality's WebRTC
# signalling natively; HA's go2rtc provider then serves WebRTC and stills.
GO2RTC_DOMAIN = "go2rtc"
CREALITY_WEBRTC_SOURCE = "webrtc:{url}#format=creality"
SOURCE_MJPEG = "mjpeg"
SOURCE_WEBRTC = "webrtc"


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coord: CrealityCoordinator = hass.data[DOMAIN][entry.entry_id]
    # Soft-fail: always register; snapshots/stream return empty if unreachable.
    async_add_entities([CrealityPrinterCamera(coord, entry)])


class CrealityPrinterCamera(CrealityEntity, Camera):
    """MJPEG / custom URL camera; never breaks integration setup."""

    _attr_translation_key = "printer_camera"

    def __init__(self, coordinator: CrealityCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, "printer_camera")
        Camera.__init__(self)
        self._entry = entry

    def _source(self) -> tuple[str, str]:
        """Return (kind, url) for the configured camera: MJPEG or Creality WebRTC."""
        opts = self._entry.options
        mode = opts.get(CONF_CAMERA_MODE, CAM_MODE_AUTO)
        host = self.coordinator.host
        custom = (opts.get(CONF_CUSTOM_CAMERA_URL) or "").strip()

        if mode == CAM_MODE_CUSTOM and custom:
            kind = SOURCE_WEBRTC if custom.split("?")[0].rstrip("/").endswith("/call/webrtc_local") else SOURCE_MJPEG
            return kind, custom
        if mode == CAM_MODE_WEBRTC:
            return SOURCE_WEBRTC, WEBRTC_URL.format(host=host)
        if mode == CAM_MODE_MJPEG:
            return SOURCE_MJPEG, MJPEG_URL.format(host=host)

        try:
            webrtc = int((self.coordinator.data or {}).get("webrtcSupport") or 0) == 1
        except (TypeError, ValueError):
            webrtc = False
        if webrtc:
            return SOURCE_WEBRTC, WEBRTC_URL.format(host=host)
        return SOURCE_MJPEG, MJPEG_URL.format(host=host)

    def _resolve_url(self) -> str | None:
        return self._source()[1]

    def _is_webrtc(self) -> bool:
        return self._source()[0] == SOURCE_WEBRTC

    def _mjpeg_url(self) -> str | None:
        kind, url = self._source()
        return url if kind == SOURCE_MJPEG else None

    def _go2rtc_loaded(self) -> bool:
        return self.hass is not None and GO2RTC_DOMAIN in self.hass.config.components

    @property
    def supported_features(self) -> CameraEntityFeature:
        """Advertise streaming only for WebRTC printers when go2rtc can serve it.

        Without go2rtc, HA would fall back to its HLS stream worker, which cannot
        open a ``webrtc:`` source. HA re-evaluates providers when this changes.
        """
        if self._is_webrtc() and self._go2rtc_loaded():
            return CameraEntityFeature.STREAM
        return CameraEntityFeature(0)

    @property
    def use_stream_for_stills(self) -> bool:
        """WebRTC printers get snapshots from go2rtc; MJPEG printers from the printer."""
        return CameraEntityFeature.STREAM in self.supported_features

    async def stream_source(self) -> str | None:
        """go2rtc source for Creality WebRTC cameras (None for MJPEG)."""
        kind, url = self._source()
        if kind != SOURCE_WEBRTC:
            return None
        return CREALITY_WEBRTC_SOURCE.format(url=url)

    def _snapshot_url(self) -> str:
        """Single-frame URL; the built-in mjpg-streamer serves one on ?action=snapshot.

        Also used for WebRTC printers, whose stream HA cannot proxy here: stills
        still work when the printer additionally runs mjpg-streamer.
        """
        url = self._mjpeg_url()
        if url and url == MJPEG_URL.format(host=self.coordinator.host):
            return MJPEG_SNAPSHOT_URL.format(host=self.coordinator.host)
        if url:
            return url
        return MJPEG_SNAPSHOT_URL.format(host=self.coordinator.host)

    async def async_camera_image(
        self, width: int | None = None, height: int | None = None
    ) -> bytes | None:
        url = self._snapshot_url()
        session = async_get_clientsession(self.hass)
        try:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=8)) as resp:
                if resp.status != 200:
                    return None
                return await _read_first_jpeg(resp)
        except Exception as exc:  # noqa: BLE001
            _LOGGER.debug("Camera snapshot failed (%s): %s", url, exc)
            return None

    async def handle_async_mjpeg_stream(self, request: Any) -> Any:
        """Proxy printer MJPEG; 503 if unreachable (does not unload integration)."""
        url = self._mjpeg_url()
        if not url:
            return web.Response(status=404, text="Camera stream unavailable")

        session = async_get_clientsession(self.hass)
        try:
            upstream = await session.get(url, timeout=STREAM_TIMEOUT)
        except Exception as exc:  # noqa: BLE001
            _LOGGER.debug("Camera stream open failed (%s): %s", url, exc)
            return web.Response(status=503, text="Camera unreachable")

        if upstream.status != 200:
            await upstream.release()
            return web.Response(status=503, text="Camera unreachable")

        response = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": upstream.headers.get(
                    "Content-Type", "multipart/x-mixed-replace;boundary=boundary"
                )
            },
        )
        try:
            await response.prepare(request)
            async for chunk in upstream.content.iter_chunked(64 * 1024):
                await response.write(chunk)
        except (ConnectionResetError, ConnectionError, asyncio.TimeoutError,
                aiohttp.ClientError) as exc:
            _LOGGER.debug("Camera stream ended (%s): %s", url, exc)
        finally:
            # ClientResponse has no wait_closed(); close() drops the connection.
            upstream.close()
        return response

    @property
    def is_streaming(self) -> bool:
        return self._mjpeg_url() is not None or self.supported_features != CameraEntityFeature(0)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"stream_url": self._resolve_url()}


async def _read_first_jpeg(resp: aiohttp.ClientResponse) -> bytes | None:
    """Return the first complete JPEG from a single-image or multipart response.

    ``StreamReader.read(n)`` returns whatever is buffered, often a partial frame,
    so keep reading until an end-of-image marker follows a start marker.
    """
    data = bytearray()
    start = -1
    async for chunk in resp.content.iter_chunked(64 * 1024):
        data.extend(chunk)
        if start < 0:
            start = data.find(JPEG_START)
        if start >= 0:
            end = data.find(JPEG_END, start + 2)
            if end >= 0:
                return bytes(data[start : end + 2])
        if len(data) > MAX_SNAPSHOT_BYTES:
            return None
    if start >= 0 and data.endswith(JPEG_END):
        return bytes(data[start:])
    return None
