"""Keep each job's G-code in ``<folder>/gcode-files`` and print a saved job again.

The folder is the one chosen for timelapses. When a job finishes or is stopped,
its file is downloaded from the printer (``/downloads/gcode/<name>``, the same
endpoint as the G-code profile) and kept once per content (MD5). To print a job
again, the file still on the printer is started when it is the same size as the
saved copy; otherwise the saved copy is uploaded first (``POST /upload/<name>``,
the endpoint slicers use) and checked in the printer's file list.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from pathlib import PurePosixPath
import time
from typing import Any
from urllib.parse import quote

import aiohttp
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_call_later
from homeassistant.helpers.storage import Store

from .const import DOMAIN, STATE_FINISHED, STATE_STOPPED
from .profile_monitor import GCODE_URL, gcode_name
from .timelapse import _start_id
from .timelapse_archive import free_path, safe_stem

_LOGGER = logging.getLogger(__name__)

GCODE_DIR = "gcode-files"
UPLOAD_URL = "http://{host}/upload/{name}"
FILES_KEY = "retGcodeFileInfo"
FILES_REQUEST = {"method": "get", "params": {"reqGcodeFile": 1}}
# Where stock K1-family firmware keeps jobs when the file list does not say.
DEFAULT_GCODE_DIR = "/usr/data/printer_data/gcodes"
LIST_TIMEOUT = 8.0
LIST_MAX_AGE = 10.0
POLL_SECONDS = 30
RETRY_SECONDS = 300
GIVE_UP_SECONDS = 24 * 3600
KEEP_SAVED = 500
WRITE_BYTES = 1024 * 1024
MAX_GCODE_BYTES = 256 * 1024 * 1024
# The printer serves ~0.5 MB/s; only stalls are fatal.
_TIMEOUT = aiohttp.ClientTimeout(total=None, connect=10, sock_read=60)
# Statuses during which the printer cannot start another job.
BUSY_STATUSES = frozenset({"printing", "paused", "processing"})


def gcode_store_key(entry_id: str) -> str:
    return f"{DOMAIN}.{entry_id}.gcode_archive"


def parse_file_list(value: Any) -> list[dict[str, Any]]:
    """Files from ``retGcodeFileInfo``: ``;``-separated ``dir:name:size:layerHeight:ctime:?:thumbnail``."""
    info = value.get("fileInfo") if isinstance(value, dict) else value
    files = []
    for record in str(info or "").split(";"):
        parts = record.strip().split(":")
        if len(parts) < 3:
            continue
        # Names may contain ':'; the five fields after the name do not.
        name = ":".join(parts[1:-5]) if len(parts) >= 7 else parts[1]
        size = parts[-5] if len(parts) >= 7 else parts[2]
        if name:
            files.append({"dir": parts[0] or DEFAULT_GCODE_DIR, "name": name, "size": _start_id(size)})
    return files


def _md5_of(path: str) -> str | None:
    digest = hashlib.md5()
    try:
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(WRITE_BYTES), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


class PrintAgainError(Exception):
    """A job could not be started again; ``args[0]`` is the reason code."""


class PrinterFiles:
    """The printer's G-code file list, requested over WS on demand."""

    def __init__(self, coordinator) -> None:
        self.coordinator = coordinator
        self.files: list[dict[str, Any]] = []
        self._fetched_at: float | None = None
        self._waiter: asyncio.Future[None] | None = None

    @callback
    def observe(self, frame: dict[str, Any]) -> None:
        """Take the list out of a telemetry frame instead of merging it."""
        if FILES_KEY not in frame:
            return
        self.files = parse_file_list(frame.pop(FILES_KEY))
        self._fetched_at = time.monotonic()
        if self._waiter and not self._waiter.done():
            self._waiter.set_result(None)

    async def async_list(self, fresh: bool = False) -> list[dict[str, Any]]:
        """Files on the printer; raises ConnectionError/TimeoutError."""
        if not fresh and self._fetched_at is not None and time.monotonic() - self._fetched_at < LIST_MAX_AGE:
            return self.files
        waiter = self._waiter
        if fresh or waiter is None or waiter.done():
            waiter = self._waiter = asyncio.get_running_loop().create_future()
            try:
                await self.coordinator.client.send_json(FILES_REQUEST)
            except Exception as err:  # noqa: BLE001 - websockets raises its own hierarchy
                self._waiter = None
                waiter.cancel()
                raise ConnectionError(f"File list request failed: {err}") from err
        try:
            await asyncio.wait_for(asyncio.shield(waiter), LIST_TIMEOUT)
        except TimeoutError:
            if self._waiter is waiter:
                self._waiter = None
                waiter.cancel()
            raise
        return self.files


class GcodeArchiver:
    """Queue finished jobs and copy their G-code into the folder.

    ``pending`` (job start id -> {file, ended}) and ``saved`` (job start id ->
    {path (relative to the folder), file (printer path), size, md5}) are persisted.
    """

    def __init__(self, coordinator) -> None:
        self.coordinator = coordinator
        self.hass = coordinator.hass
        self.files = PrinterFiles(coordinator)
        self._store = Store(self.hass, 1, gcode_store_key(coordinator.entry.entry_id))
        self.pending: dict[str, dict[str, Any]] = {}
        self.saved: dict[str, dict[str, Any]] = {}
        self.last_error: str | None = None
        # Jobs whose file the printer no longer serves; asked again only after a restart.
        self._gone: set[str] = set()
        self._last_state: int | None = None
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._again = False
        self._unsub_timer: Any = None

    @property
    def folder(self) -> str | None:
        return self.coordinator.archive.folder

    async def async_start(self) -> None:
        data = await self._store.async_load() or {}
        self.pending = {str(k): v for k, v in (data.get("pending") or {}).items() if isinstance(v, dict)}
        self.saved = {str(k): v for k, v in (data.get("saved") or {}).items() if isinstance(v, dict)}
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
        return {"pending": self.pending, "saved": self.saved}

    @callback
    def observe(self, data: dict[str, Any]) -> None:
        """Queue the job's G-code when the printer reports it finished or stopped."""
        try:
            state = int(data["state"]) if data.get("state") is not None else None
        except (TypeError, ValueError):
            state = None
        prev, self._last_state = self._last_state, state
        if not self.folder or state not in (STATE_FINISHED, STATE_STOPPED) or state == prev:
            return
        start = _start_id(data.get("printStartTime"))
        file = str(data.get("printFileName") or "").strip()
        # USB jobs are not served over HTTP.
        if start is None or gcode_name(file) is None:
            return
        key = str(start)
        if key in self.saved or key in self.pending or key in self._gone:
            return
        self.pending[key] = {"file": file, "ended": time.time()}
        self._store.async_delay_save(self._data, 1)
        self._kick()

    @callback
    def _kick(self, _now: Any = None) -> None:
        if self._unsub_timer:
            self._unsub_timer()
            self._unsub_timer = None
        if self._task and not self._task.done():
            self._again = True
            return
        self._task = self.coordinator.entry.async_create_background_task(
            self.hass, self._pass(), f"creality_gcode_archive_{self.coordinator.host}"
        )

    async def _pass(self) -> None:
        delay = None
        try:
            async with self._lock:
                delay = await self._process()
        finally:
            self._store.async_delay_save(self._data, 1)
            if self._again:
                self._again, delay = False, 0
            if delay is not None:
                self._unsub_timer = async_call_later(self.hass, delay, self._kick)

    async def _process(self) -> float | None:
        if not self.pending or not self.folder:
            return None
        if not self.coordinator.client.connected:
            return POLL_SECONDS
        delay: float | None = None
        for key, job in list(self.pending.items()):
            try:
                self.saved[key] = await self._save(job["file"])
            except asyncio.CancelledError:
                raise
            except FileNotFoundError:
                self._gone.add(key)
                _LOGGER.debug("G-code of job %s is no longer on %s", key, self.coordinator.host)
            except (OSError, TimeoutError, ValueError, aiohttp.ClientError) as err:
                self.last_error = str(err) or type(err).__name__
                if time.time() - float(job.get("ended") or 0) < GIVE_UP_SECONDS:
                    _LOGGER.warning("Saving G-code %s to %s failed (retrying): %s", job["file"], self.folder, self.last_error)
                    delay = RETRY_SECONDS
                    continue
                _LOGGER.warning("Giving up saving G-code %s: %s", job["file"], self.last_error)
            else:
                self.last_error = None
                while len(self.saved) > KEEP_SAVED:
                    self.saved.pop(next(iter(self.saved)))
            self.pending.pop(key, None)
        return delay

    async def _save(self, file: str) -> dict[str, Any]:
        """Download the printer's file; keep one copy per content in ``gcode-files``."""
        name = gcode_name(file)
        if name is None:
            raise FileNotFoundError(file)
        folder = self.folder
        assert folder
        run = self.hass.async_add_executor_job
        directory = os.path.join(folder, GCODE_DIR)
        target = os.path.join(directory, f"{safe_stem(name) or 'print'}.gcode")
        part = f"{target}.part"
        digest = hashlib.md5()
        total = 0
        session = async_get_clientsession(self.hass)
        url = GCODE_URL.format(host=self.coordinator.host, name=quote(name))
        async with session.get(url, timeout=_TIMEOUT, allow_redirects=False) as response:
            if response.status == 404:
                raise FileNotFoundError(url)
            if response.status != 200:
                raise ValueError(f"printer answered HTTP {response.status}")
            await run(os.makedirs, directory, 0o777, True)
            handle = await run(open, part, "wb")
            try:
                try:
                    buf = bytearray()
                    async for chunk in response.content.iter_chunked(64 * 1024):
                        total += len(chunk)
                        if total > MAX_GCODE_BYTES:
                            raise ValueError("G-code file too large")
                        buf.extend(chunk)
                        if len(buf) >= WRITE_BYTES:
                            digest.update(buf)
                            await run(handle.write, bytes(buf))
                            buf = bytearray()
                    digest.update(buf)
                    await run(handle.write, bytes(buf))
                finally:
                    await run(handle.close)
            except BaseException:
                await run(_remove, part)
                raise
        md5 = digest.hexdigest()
        # The same content saved for an earlier job (a repeat, or the file sliced once).
        for record in self.saved.values():
            path = os.path.join(folder, record.get("path") or "")
            if record.get("md5") == md5 and await run(os.path.isfile, path):
                await run(_remove, part)
                return {**record, "file": file}
        if await run(os.path.exists, target) and await run(_md5_of, target) != md5:
            target = await run(free_path, target)
        await run(os.replace, part, target)
        _LOGGER.info("Saved G-code %s", target)
        return {"path": os.path.relpath(target, folder), "file": file, "size": total, "md5": md5}

    async def async_find(self, start_time: Any) -> dict[str, Any] | None:
        """The job's saved copy with its absolute ``abs_path``, if still on disk."""
        record = self.saved.get(str(_start_id(start_time)))
        if not record or not self.folder:
            return None
        path = os.path.join(self.folder, record.get("path") or "")
        if not await self.hass.async_add_executor_job(os.path.isfile, path):
            return None
        return {**record, "abs_path": path}

    async def async_saved_jobs(self) -> list[int]:
        """Start ids of jobs whose G-code copy is on disk."""
        folder = self.folder
        if not folder:
            return []

        def present() -> list[int]:
            return [int(key) for key, record in self.saved.items()
                    if key.isdigit() and os.path.isfile(os.path.join(folder, record.get("path") or ""))]

        return await self.hass.async_add_executor_job(present)

    async def async_print_again(self, start_time: Any, file: str | None) -> dict[str, Any]:
        """Start a job again; raises PrintAgainError with a reason code."""
        coordinator = self.coordinator
        if not coordinator.client.connected or not coordinator.live:
            raise PrintAgainError("offline")
        if (coordinator.data or {}).get("__print_status") in BUSY_STATUSES:
            raise PrintAgainError("busy")
        saved = await self.async_find(start_time) if start_time is not None else None
        original = (saved or {}).get("file") or str(file or "")
        name = PurePosixPath(original).name
        if not name:
            raise PrintAgainError("no_gcode")
        try:
            on_printer = {entry["name"]: entry for entry in await self.files.async_list()}
        except (ConnectionError, TimeoutError) as err:
            raise PrintAgainError("offline") from err
        current = on_printer.get(name)
        uploaded = False
        if current and (saved is None or current["size"] in (None, saved.get("size"))):
            target = current
        elif saved:
            # Never replace a different printer file that has the same name.
            upload_name = f"{safe_stem(name) or 'print'}.gcode".replace(" ", "_")
            if upload_name in on_printer and on_printer[upload_name]["size"] != saved.get("size"):
                upload_name = f"{safe_stem(name) or 'print'}_{_start_id(start_time)}.gcode".replace(" ", "_")
            await self._upload(saved["abs_path"], upload_name)
            uploaded = True
            try:
                listed = {entry["name"]: entry for entry in await self.files.async_list(fresh=True)}
            except (ConnectionError, TimeoutError) as err:
                raise PrintAgainError("upload_failed") from err
            target = listed.get(upload_name)
            if not target or target["size"] not in (None, saved.get("size")):
                raise PrintAgainError("upload_failed")
        else:
            raise PrintAgainError("no_gcode")
        path = f"{str(target['dir']).rstrip('/')}/{target['name']}"
        await coordinator.async_send_set(opGcodeFile=f"printprt:{path}")
        _LOGGER.info("Printing %s again on %s%s", path, coordinator.host, " (uploaded)" if uploaded else "")
        return {"file": path, "uploaded": uploaded}

    async def _upload(self, path: str, name: str) -> None:
        """Multipart upload of a saved copy to the printer's G-code folder."""
        run = self.hass.async_add_executor_job
        handle = await run(open, path, "rb")
        try:
            form = aiohttp.FormData()
            form.add_field("file", handle, filename=name, content_type="application/octet-stream")
            session = async_get_clientsession(self.hass)
            url = UPLOAD_URL.format(host=self.coordinator.host, name=quote(name))
            try:
                async with session.post(url, data=form, timeout=_TIMEOUT, allow_redirects=False) as response:
                    if response.status >= 300:
                        raise PrintAgainError("upload_failed", f"printer answered HTTP {response.status}")
            except (aiohttp.ClientError, TimeoutError) as err:
                raise PrintAgainError("upload_failed", str(err) or type(err).__name__) from err
        finally:
            await run(handle.close)
