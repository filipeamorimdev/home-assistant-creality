"""DataUpdateCoordinator for Creality printer telemetry."""

from __future__ import annotations

import logging
import time
from datetime import timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .const import (
    DEVICE_HOMING,
    DOMAIN,
    STATE_FINISHED,
    STATE_PAUSED,
    STATE_PRINTING,
    STATE_STOPPED,
)
from .errors import is_fatal_error, lookup_error
from .gcode_archive import GcodeArchiver
from .ws_client import CrealityWsClient
from .profile_monitor import ProfileMonitor
from .timelapse import TimelapseIndex
from .timelapse_archive import TimelapseArchiver

_LOGGER = logging.getLogger(__name__)

# The printer streams ~5 frames/s. Values that change with nearly every frame
# are published at most once per PUBLISH_INTERVAL so HA does not record tens of
# thousands of state changes per printing hour; any other key (state, errors,
# targets, fans, light, layer, progress...) publishes immediately.
PUBLISH_INTERVAL = 1.0
_HIGH_RATE_KEYS = frozenset({
    "curPosition", "nozzleTemp", "bedTemp0", "bedTemp1", "bedTemp2", "boxTemp",
    "usedMaterialLength", "printJobTime", "printLeftTime", "realTimeSpeed",
    "realTimeFlow", "accelerationLimits", "accelToDecelLimits", "cornerVelocityLimits",
    "velocityLimits", "autohome", "curZOffset", "objects", "current_object",
    "excluded_objects",
})
# Pushed at job end / on reqHistory: the last ~50 jobs. Unused, so never merged.
_HISTORY_LIST_KEY = "historyList"


def job_key(data: dict[str, Any]) -> str | None:
    """Identify a print job; None when no file is loaded."""
    fname = str(data.get("printFileName") or "").strip()
    if not fname:
        return None
    return f"{fname}|{data.get('printStartTime') or ''}|{data.get('printId') or ''}"


def map_print_status(data: dict[str, Any], terminal_job: str | None = None) -> str:
    """Map telemetry to a human print status string for the card.

    ``terminal_job`` is the job key last seen in a finished/stopped state; a
    printer that drops back to state 0 afterwards (filename still loaded) is idle,
    not starting a new job.
    """
    err = data.get("err") or {}
    try:
        err_key = int(err.get("key") or 0)
    except (TypeError, ValueError):
        err_key = 0

    try:
        mat = int(data.get("materialStatus") or 0)
    except (TypeError, ValueError):
        mat = 0

    try:
        st = int(data.get("state")) if data.get("state") is not None else None
    except (TypeError, ValueError):
        st = None

    fname = data.get("printFileName") or ""

    if mat == 1 and st == STATE_PAUSED:
        return "paused"  # filament runout still paused; filament sensor separate

    if err_key and is_fatal_error(err_key):
        return "error"

    if st == STATE_PAUSED:
        return "paused"
    if st == STATE_STOPPED:
        return "stopped"
    # Only explicit printer state counts as finished: progress flickers 99<->100
    # near the end of a job while the printer is still printing.
    if st == STATE_FINISHED:
        return "completed"
    if st == STATE_PRINTING:
        return "printing"
    if fname and st == 0:
        # State 0 with a file loaded is a job starting or a resume (5 -> 0 -> 1),
        # unless the printer reports itself idle or this job already ended.
        if data.get("deviceState") == 0 or (terminal_job and job_key(data) == terminal_job):
            return "idle"
        return "processing"
    return "idle"


class CrealityCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Hold merged printer state and drive the WS client."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, host: str) -> None:
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name=f"{DOMAIN}_{host}",
            update_interval=timedelta(seconds=30),
        )
        self.entry = entry
        self.host = host
        self.data: dict[str, Any] = {}
        self._peak_layer = 0
        self._peak_total_layer = 0
        self._peak_job: str | None = None
        self._peak_file: str | None = None
        self._terminal_job: str | None = None
        self._paused = False
        self._last_publish = 0.0
        self._publish_handle: Any = None
        # Merged telemetry survives disconnects (latches), so after a
        # (re)connect it is stale until the printer reports its state again.
        # `live` turns True once that check ran; `_fresh` holds what this
        # connection has reported so far.
        self.live = False
        self._fresh: dict[str, Any] | None = None
        self.client = CrealityWsClient(host, self._on_message, self._on_connection_change)
        self.profile = ProfileMonitor(self)
        self.timelapse = TimelapseIndex(self)
        self.archive = TimelapseArchiver(self)
        self.gcode = GcodeArchiver(self)
        # Options that need a reload when changed (set by async_setup_entry).
        self.setup_options: dict[str, Any] = {}

    async def async_start(self) -> None:
        await self.archive.async_start()
        await self.gcode.async_start()
        await self.client.start()
        ok = await self.client.wait_connected(12.0)
        if not ok:
            _LOGGER.warning("Initial Creality connect to %s not confirmed; retrying in background", self.host)

    async def async_shutdown(self) -> None:
        self._cancel_pending_publish()
        await self.client.stop()
        await self.profile.async_stop()
        await self.archive.async_stop()
        await self.gcode.async_stop()

    async def ensure_connected(self) -> bool:
        if self.client.connected:
            return True
        await self.client.start()
        return await self.client.wait_connected(10.0)

    async def async_send_set(self, **params: Any) -> None:
        """Send a control command, surfacing failures to the HA UI."""
        if not await self.ensure_connected():
            raise HomeAssistantError(f"Printer {self.host} is not connected")
        try:
            await self.client.send_set_retry(**params)
        except Exception as err:  # noqa: BLE001 - websockets raises its own hierarchy
            raise HomeAssistantError(f"Command to printer {self.host} failed: {err}") from err

    @callback
    def _on_connection_change(self) -> None:
        self.live = False
        self._fresh = {} if self.client.connected else None
        self._publish()

    async def _async_update_data(self) -> dict[str, Any]:
        # Push-driven; polling just exposes current merge + derived fields.
        return self._enrich(dict(self.data))

    @callback
    def _on_message(self, frame: dict[str, Any]) -> None:
        self.timelapse.observe(frame)
        self.gcode.files.observe(frame)
        frame.pop(_HISTORY_LIST_KEY, None)
        if not frame:
            return
        self.data.update(frame)
        if self._fresh is not None:
            self._fresh.update(frame)
            if self._fresh.get("state") is not None:
                self._check_reconnect_job()
        self.profile.observe(self.data)
        self.archive.observe(self.data)
        self.gcode.observe(self.data)
        self._update_terminal_job()
        self._update_layer_peaks()
        self._paused = self._compute_paused()
        if not frame.keys() <= _HIGH_RATE_KEYS or time.monotonic() - self._last_publish >= PUBLISH_INTERVAL:
            self._publish()
        elif self._publish_handle is None:
            delay = PUBLISH_INTERVAL - (time.monotonic() - self._last_publish)
            self._publish_handle = self.hass.loop.call_later(max(0.0, delay), self._publish)

    @callback
    def _publish(self) -> None:
        """Push merged telemetry and derived fields to the entities now."""
        self._cancel_pending_publish()
        self._last_publish = time.monotonic()
        self.async_set_updated_data(self._enrich(dict(self.data)))

    def _cancel_pending_publish(self) -> None:
        if self._publish_handle is not None:
            self._publish_handle.cancel()
            self._publish_handle = None

    def _check_reconnect_job(self) -> None:
        """First state report after a (re)connect: keep job data only if resumable.

        A job that is printing, paused (waiting for resume) or pending power-loss
        recovery keeps its merged state and latches. Otherwise everything learned
        before the disconnect is dropped so no sensor reports stale values.
        """
        fresh, self._fresh = self._fresh or {}, None
        self.live = self.client.connected
        status = map_print_status(fresh)
        try:
            plr = int(fresh.get("repoPlrStatus") or 0)
        except (TypeError, ValueError):
            plr = 0
        if status in ("printing", "paused", "processing") or plr or fresh.get("pause") == 1:
            return
        _LOGGER.debug("No resumable job on %s after reconnect; clearing stale telemetry", self.host)
        self.data = dict(fresh)
        self._peak_layer = self._peak_total_layer = 0
        self._peak_job = self._peak_file = self._terminal_job = None
        self._paused = False

    def _state(self) -> int | None:
        st = self.data.get("state")
        try:
            return int(st) if st is not None else None
        except (TypeError, ValueError):
            return None

    def _update_terminal_job(self) -> None:
        st = self._state()
        if st in (STATE_FINISHED, STATE_STOPPED):
            self._terminal_job = job_key(self.data)
        elif st in (STATE_PRINTING, STATE_PAUSED):
            self._terminal_job = None

    def _update_layer_peaks(self) -> None:
        try:
            layer = int(float(self.data.get("layer") or 0))
            total = int(float(self.data.get("TotalLayer") or 0))
        except (TypeError, ValueError):
            return
        st_i = self._state()
        # A different job starting to print must not inherit the previous job's peaks.
        job = job_key(self.data)
        if st_i == STATE_PRINTING and job and job != self._peak_job:
            self._peak_job = job
            self._peak_file = str(self.data.get("printFileName") or "").strip()
            self._peak_layer = 0
            self._peak_total_layer = 0
        # Latch peaks while printing/paused; ignore post-job 0/0 reset
        if layer == 0 and total == 0 and st_i == STATE_FINISHED:
            return
        if total > self._peak_total_layer:
            self._peak_total_layer = total
        if layer > self._peak_layer:
            self._peak_layer = layer

    def _compute_paused(self) -> bool:
        try:
            st = int(self.data.get("state")) if self.data.get("state") is not None else None
        except (TypeError, ValueError):
            st = None
        return st == STATE_PAUSED or bool(
            self.data.get("pause") == 1 or self.data.get("paused") or self.data.get("isPaused")
        )

    def paused_flag(self) -> bool:
        return self._paused

    def is_homing(self) -> bool:
        try:
            return int(self.data.get("deviceState")) == DEVICE_HOMING
        except (TypeError, ValueError):
            return False

    def _enrich(self, d: dict[str, Any]) -> dict[str, Any]:
        out = dict(d)
        # Stays "offline" until the reconnect check has seen fresh state.
        status = map_print_status(d, self._terminal_job) if self.live else "offline"
        out["__print_status"] = status
        out["__peak_layer"] = self._peak_layer
        out["__peak_total_layer"] = self._peak_total_layer
        # Prefer live layers unless reset after finish
        try:
            layer = int(float(d.get("layer") or 0))
            total = int(float(d.get("TotalLayer") or 0))
        except (TypeError, ValueError):
            layer = total = 0
        fname = str(d.get("printFileName") or "").strip()
        same_job = not fname or fname == self._peak_file
        if layer == 0 and total == 0 and same_job and (self._peak_layer or self._peak_total_layer):
            out["__layer"] = self._peak_layer
            out["__total_layer"] = self._peak_total_layer
        else:
            out["__layer"] = layer
            out["__total_layer"] = total

        err = d.get("err") or {}
        try:
            key = int(err.get("key") or 0)
        except (TypeError, ValueError):
            key = 0
        info = lookup_error(key) if key else None
        out["__err_key"] = key
        out["__err_message"] = info.message if info else ("" if key == 0 else f"Error key {key}")
        out["__err_severity"] = info.severity if info else ("unknown" if key else "ok")
        out["__err_solution"] = info.solution if info else ""
        out["__err_value"] = str(err.get("value") or "") if key else ""
        out["__filament_runout"] = False
        try:
            out["__filament_runout"] = int(d.get("materialStatus") or 0) == 1
        except (TypeError, ValueError):
            pass
        return out

    async def request_pause(self) -> None:
        await self.async_send_set(pause=1)

    async def request_resume(self) -> None:
        await self.async_send_set(pause=0)

    async def request_stop(self) -> None:
        await self.async_send_set(stop=1)
