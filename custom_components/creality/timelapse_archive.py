"""Copy each finished job's timelapse from the printer into a folder (e.g. a NAS mount)."""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import PurePosixPath
import re
import time
from typing import Any

import aiohttp
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_call_later
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import CONF_TIMELAPSE_AUTO_SAVE, CONF_TIMELAPSE_FOLDER, DOMAIN, STATE_FINISHED, STATE_STOPPED
from .timelapse import VIDEO_URL, _start_id, find_video

_LOGGER = logging.getLogger(__name__)

# The printer renders the video after the job ends; tiny jobs never get one.
FIND_WINDOW = 30 * 60
POLL_SECONDS = 30
RETRY_SECONDS = 300
GIVE_UP_SECONDS = 24 * 3600
KEEP_SAVED = 200
WRITE_BYTES = 1024 * 1024
# The printer serves ~0.5 MB/s; only stalls are fatal.
_TIMEOUT = aiohttp.ClientTimeout(total=None, connect=10, sock_read=30)
# Characters SMB/NTFS shares reject, plus control characters.
_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')

# "off": no folder configured.
STATUSES = ["off", "idle", "waiting", "saving", "saved", "failed"]
MAX_SUGGESTIONS = 50


def archive_store_key(entry_id: str) -> str:
    return f"{DOMAIN}.{entry_id}.timelapse_archive"


def archive_name(entry: dict[str, Any]) -> str:
    """``<local start time>_<gcode stem>.mp4``: sortable and unique per job."""
    start = _start_id(entry.get("id")) or 0
    stamp = dt_util.as_local(dt_util.utc_from_timestamp(start)).strftime("%Y-%m-%d_%H%M%S")
    stem = _UNSAFE.sub("_", PurePosixPath(str(entry.get("gcodename") or "")).stem).strip(" .")[:150]
    return f"{stamp}_{stem}.mp4" if stem else f"{stamp}.mp4"


def find_saved(folder: str | None, recorded: str | None, start_time: Any) -> str | None:
    """Path of a job's copy in ``folder`` if it is (still) there. Run in the executor.

    Tries the name the archive recorded, then any ``<local start>[_<stem>].mp4``
    (manual saves, records dropped or lost).
    """
    start = _start_id(start_time)
    if not folder or start is None:
        return None
    names = [recorded] if recorded else []
    stamp = archive_name({"id": start})[:-4]
    if not (recorded and os.path.isfile(os.path.join(folder, recorded))):
        try:
            with os.scandir(folder) as entries:
                names.extend(sorted(
                    e.name for e in entries
                    if e.name == f"{stamp}.mp4" or (e.name.startswith(f"{stamp}_") and e.name.endswith(".mp4"))
                ))
        except OSError:
            return None
    for name in names:
        path = os.path.join(folder, name)
        if os.path.isfile(path):
            return path
    return None


def check_folder(hass: HomeAssistant, raw: str | None) -> tuple[str, str | None]:
    """Normalized folder and an error key; creates the folder. Run in the executor."""
    folder = (raw or "").strip()
    if not folder:
        return "", None
    if not os.path.isabs(folder):
        return folder, "folder_not_absolute"
    folder = os.path.normpath(folder)
    if not hass.config.is_allowed_path(folder):
        return folder, "folder_not_allowed"
    try:
        os.makedirs(folder, exist_ok=True)
    except OSError:
        return folder, "folder_not_writable"
    if not os.access(folder, os.W_OK | os.X_OK):
        return folder, "folder_not_writable"
    return folder, None


def folder_suggestions(hass: HomeAssistant) -> list[str]:
    """Media folders, the shares mounted directly in them and allowlisted folders.

    Network storage added with usage "Media" is mounted at ``/media/<name>``.
    Run in the executor.
    """
    found: list[str] = []
    for media in hass.config.media_dirs.values():
        found.append(media)
        try:
            with os.scandir(media) as entries:
                found.extend(sorted(e.path for e in entries if e.is_dir() and not e.name.startswith(".")))
        except OSError:
            pass
    found.extend(sorted(hass.config.allowlist_external_dirs))
    unique = list(dict.fromkeys(os.path.normpath(path) for path in found))
    return [path for path in unique if os.path.isdir(path)][:MAX_SUGGESTIONS]


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


class TimelapseArchiver:
    """Queue finished jobs and copy their videos once the printer lists them.

    ``pending`` (job start id -> wall time it ended) and the recently ``saved``
    ids are persisted, so restarts neither lose nor repeat a copy.
    """

    def __init__(self, coordinator) -> None:
        self.coordinator = coordinator
        self.hass = coordinator.hass
        self.folder: str | None = None
        self.auto_save = False
        self._read_options()
        self._lock = asyncio.Lock()
        self._store = Store(self.hass, 1, archive_store_key(coordinator.entry.entry_id))
        self.pending: dict[str, float] = {}
        self.saved: dict[str, str] = {}
        self.status = "idle" if self.folder else "off"
        self.last_file: str | None = None
        self.last_saved: float | None = None
        self.last_error: str | None = None
        self._last_state: int | None = None
        self._task: asyncio.Task | None = None
        self._again = False
        self._unsub_timer: Any = None

    def _read_options(self) -> None:
        options = self.coordinator.entry.options
        self.folder = options.get(CONF_TIMELAPSE_FOLDER) or None
        # Entries from before the switch existed: a folder meant auto-save.
        self.auto_save = bool(self.folder) and options.get(CONF_TIMELAPSE_AUTO_SAVE, True)

    async def async_start(self) -> None:
        saved = await self._store.async_load() or {}
        self.pending = {str(k): float(v) for k, v in (saved.get("pending") or {}).items()}
        self.saved = {str(k): str(v) for k, v in (saved.get("saved") or {}).items()}
        self.last_file = saved.get("last_file")
        self.last_saved = saved.get("last_saved")
        if self.folder and self.last_file:
            self.status = "saved"
        self._kick()

    @callback
    def async_configure(self) -> None:
        """Apply changed folder / auto-save options without reloading the printer."""
        self._read_options()
        if not self.auto_save:
            self.pending.clear()
            self._store.async_delay_save(self._data, 1)
        if not self.folder:
            self._set_status("off")
        elif self.status in ("off", "waiting", "failed") and not self.pending:
            self._set_status("idle")
        else:
            self.coordinator.async_update_listeners()
        self._kick()

    async def async_stop(self) -> None:
        if self._unsub_timer:
            self._unsub_timer()
            self._unsub_timer = None
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = None
        await self._store.async_save(self._data())

    def _data(self) -> dict[str, Any]:
        return {"pending": self.pending, "saved": self.saved,
                "last_file": self.last_file, "last_saved": self.last_saved}

    def as_attributes(self) -> dict[str, Any]:
        return {
            "folder": self.folder,
            "auto_save": self.auto_save,
            "pending": len(self.pending),
            "last_file": self.last_file,
            "last_saved": dt_util.utc_from_timestamp(self.last_saved).isoformat() if self.last_saved else None,
            "last_error": self.last_error,
        }

    @callback
    def observe(self, data: dict[str, Any]) -> None:
        """Queue the job when the printer reports it finished or stopped."""
        if not self.auto_save:
            return
        try:
            state = int(data["state"]) if data.get("state") is not None else None
        except (TypeError, ValueError):
            state = None
        prev, self._last_state = self._last_state, state
        if state not in (STATE_FINISHED, STATE_STOPPED) or state == prev:
            return
        start = _start_id(data.get("printStartTime"))
        if start is None:
            return
        key = str(start)
        if key in self.saved or key in self.pending:
            return
        self.pending[key] = time.time()
        self._store.async_delay_save(self._data, 1)
        self._set_status("waiting")
        self._kick()

    @callback
    def _set_status(self, status: str, error: str | None = None) -> None:
        self.status = status
        if status == "failed":
            self.last_error = error
        elif status == "saved":
            self.last_error = None
        self.coordinator.async_update_listeners()

    @callback
    def _kick(self, _now: Any = None) -> None:
        if self._unsub_timer:
            self._unsub_timer()
            self._unsub_timer = None
        if self._task and not self._task.done():
            self._again = True
            return
        self._task = self.coordinator.entry.async_create_background_task(
            self.hass, self._pass(), f"creality_timelapse_archive_{self.coordinator.host}"
        )

    @callback
    def _schedule(self, delay: float | None) -> None:
        if self._unsub_timer:
            self._unsub_timer()
            self._unsub_timer = None
        if self._again:
            self._again = False
            delay = 0
        if delay is not None:
            self._unsub_timer = async_call_later(self.hass, delay, self._kick)

    async def _pass(self) -> None:
        delay = None
        try:
            delay = await self._process()
        finally:
            self._store.async_delay_save(self._data, 1)
            self._schedule(delay)

    async def async_find_saved(self, start_time: Any) -> str | None:
        """Path of the job's folder copy, checked on disk."""
        recorded = self.saved.get(str(_start_id(start_time)))
        return await self.hass.async_add_executor_job(find_saved, self.folder, recorded, start_time)

    async def async_save_now(self, start_time: Any) -> str:
        """Copy one job's timelapse now (card button). Raises LookupError if not listed."""
        if not self.folder:
            raise LookupError("no_folder")
        video = await self.coordinator.timelapse.async_find(start_time)
        if video is None:
            raise LookupError("missing")
        key = str(_start_id(video.get("id")))
        async with self._lock:
            self._set_status("saving")
            try:
                path = await self._save(video)
            except asyncio.CancelledError:
                raise
            except (OSError, TimeoutError, ValueError, aiohttp.ClientError) as err:
                self._set_status("failed", str(err) or type(err).__name__)
                raise
            self._record(key, path)
        return path

    @callback
    def _record(self, key: str, path: str) -> None:
        self.pending.pop(key, None)
        self.saved[key] = os.path.basename(path)
        while len(self.saved) > KEEP_SAVED:
            self.saved.pop(next(iter(self.saved)))
        self.last_file, self.last_saved = path, time.time()
        self._store.async_delay_save(self._data, 1)
        _LOGGER.info("Saved timelapse %s", path)
        self._set_status("saved")

    async def _process(self) -> float | None:
        async with self._lock:
            return await self._process_locked()

    async def _process_locked(self) -> float | None:
        if not self.pending or not self.folder:
            return None
        if not self.coordinator.client.connected:
            return POLL_SECONDS
        try:
            entries = await self.coordinator.timelapse.async_list()
        except (ConnectionError, TimeoutError):
            return POLL_SECONDS
        delay: float | None = None
        for key, ended in list(self.pending.items()):
            if key not in self.pending:  # Saved from the card meanwhile.
                continue
            now = time.time()
            video = find_video(entries, key)
            if video is None:
                if now - ended > FIND_WINDOW:
                    _LOGGER.debug("No timelapse for job %s on %s; not archiving", key, self.coordinator.host)
                    del self.pending[key]
                else:
                    delay = POLL_SECONDS
                continue
            self._set_status("saving")
            try:
                path = await self._save(video)
            except asyncio.CancelledError:
                raise
            except (OSError, TimeoutError, ValueError, aiohttp.ClientError) as err:
                message = str(err) or type(err).__name__
                if now - ended > GIVE_UP_SECONDS:
                    _LOGGER.warning("Giving up saving timelapse %s: %s", video.get("videoname"), message)
                    del self.pending[key]
                else:
                    _LOGGER.warning("Saving timelapse %s to %s failed (retrying): %s",
                                    video.get("videoname"), self.folder, message)
                    delay = min(delay or RETRY_SECONDS, RETRY_SECONDS)
                self._set_status("failed", message)
                continue
            self._record(key, path)
        if self.pending and self.status not in ("failed", "saving"):
            self._set_status("waiting")
        elif not self.pending and self.status == "waiting":
            self._set_status("saved" if self.last_file else "idle")
        return delay

    async def _save(self, video: dict[str, Any]) -> str:
        """Stream the video into ``<name>.part``, then rename it into place."""
        assert self.folder
        final = os.path.join(self.folder, archive_name(video))
        part = f"{final}.part"
        url = VIDEO_URL.format(host=self.coordinator.host, name=video["videoname"])
        session = async_get_clientsession(self.hass)
        run = self.hass.async_add_executor_job
        async with session.get(url, timeout=_TIMEOUT, allow_redirects=False) as response:
            if response.status != 200:
                raise ValueError(f"printer answered HTTP {response.status}")
            await run(os.makedirs, self.folder, 0o777, True)
            handle = await run(open, part, "wb")
            total = 0
            try:
                try:
                    buf = bytearray()
                    async for chunk in response.content.iter_chunked(64 * 1024):
                        buf.extend(chunk)
                        if len(buf) >= WRITE_BYTES:
                            total += len(buf)
                            await run(handle.write, bytes(buf))
                            buf = bytearray()
                    total += len(buf)
                    await run(handle.write, bytes(buf))
                finally:
                    await run(handle.close)
                size = _start_id(video.get("size"))
                if size and total != size:
                    raise ValueError(f"incomplete download ({total} of {size} bytes)")
                await run(os.replace, part, final)
            except BaseException:
                await run(_remove, part)
                raise
        return final
