"""Async WebSocket client for Creality LAN printers (port 9999)."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from websockets.asyncio.client import connect as ws_connect

from .const import (
    GET_PARA_SEC,
    HEARTBEAT_OK,
    PROBE_SILENCE_SEC,
    RETRY_MAX,
    RETRY_MIN,
    STABLE_SESSION_SEC,
    WS_URL,
)

_LOGGER = logging.getLogger(__name__)

MessageCallback = Callable[[dict[str, Any]], Awaitable[None] | None]


class CrealityWsClient:
    """Maintain a persistent WS connection and merge telemetry frames."""

    def __init__(
        self, host: str, on_message: MessageCallback,
        on_connection_change: Callable[[], None] | None = None,
    ) -> None:
        self._host = host
        self._on_message = on_message
        self._on_connection_change = on_connection_change
        self._url = WS_URL.format(host=host)
        self._stop = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._ws: Any = None
        self._connected = asyncio.Event()
        self._last_rx = 0.0

    @property
    def connected(self) -> bool:
        return self._connected.is_set() and self._ws is not None

    def _set_connected(self, connected: bool) -> None:
        changed = self._connected.is_set() != connected
        if connected:
            self._connected.set()
        else:
            self._connected.clear()
        if changed and self._on_connection_change:
            self._on_connection_change()

    @property
    def last_rx(self) -> float:
        return self._last_rx

    async def start(self) -> None:
        self._stop.clear()
        if self._task and not self._task.done():
            return
        self._task = asyncio.create_task(self._run(), name=f"creality-ws-{self._host}")

    async def stop(self) -> None:
        self._stop.set()
        self._set_connected(False)
        ws = self._ws
        self._ws = None
        if ws is not None:
            try:
                await ws.close()
            except Exception:  # noqa: BLE001
                pass
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def reconnect(self) -> None:
        await self.stop()
        await self.start()

    async def send_json(self, payload: dict[str, Any]) -> None:
        ws = self._ws
        if ws is None:
            raise ConnectionError("WebSocket not connected")
        await ws.send(json.dumps(payload, separators=(",", ":")))

    async def send_set(self, **params: Any) -> None:
        await self.send_json({"method": "set", "params": params})

    async def send_set_retry(self, *, wait_reconnect: float = 10.0, **params: Any) -> None:
        """Send once; on failure wait for the background reconnect and retry once."""
        try:
            await self.send_set(**params)
            return
        except Exception as exc:  # noqa: BLE001
            _LOGGER.debug("send_set failed (%s); waiting for reconnect", exc)
        # Let the failed session tear down before waiting for a fresh connection.
        await asyncio.sleep(0.5)
        if not await self.wait_connected(wait_reconnect):
            raise ConnectionError("Printer did not reconnect in time")
        await self.send_set(**params)

    async def wait_connected(self, timeout: float = 15.0) -> bool:
        try:
            await asyncio.wait_for(self._connected.wait(), timeout=timeout)
            return True
        except asyncio.TimeoutError:
            return False

    async def _run(self) -> None:
        backoff = RETRY_MIN
        loop = asyncio.get_running_loop()
        was_healthy = True
        while not self._stop.is_set():
            started = loop.time()
            try:
                await self._session()
                _LOGGER.debug("Creality WS %s closed", self._host)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                # Warn once per outage; repeated failures while the printer is off stay at debug.
                log = _LOGGER.warning if was_healthy else _LOGGER.debug
                log("Creality WS %s error: %s; retry in %.1fs", self._host, exc, backoff)
            self._set_connected(False)
            if self._stop.is_set():
                break
            # A session that stayed up for a while resets the backoff; a socket that
            # opens and closes immediately must not turn into a tight reconnect loop.
            was_healthy = loop.time() - started >= STABLE_SESSION_SEC
            if was_healthy:
                backoff = RETRY_MIN
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=backoff)
            except asyncio.TimeoutError:
                pass
            backoff = min(RETRY_MAX, backoff * 1.8)

    async def _session(self) -> None:
        # Printer firmware often ignores protocol pings; disable them.
        async with ws_connect(self._url, open_timeout=10, ping_interval=None) as ws:
            self._ws = ws
            self._last_rx = asyncio.get_running_loop().time()
            self._set_connected(True)
            _LOGGER.info("Creality WS connected to %s", self._host)

            poller = asyncio.create_task(self._poll_loop())
            try:
                async for raw in ws:
                    if self._stop.is_set():
                        break
                    await self._handle_raw(raw)
            finally:
                self._set_connected(False)
                self._ws = None
                poller.cancel()
                try:
                    await poller
                except asyncio.CancelledError:
                    pass

    async def _poll_loop(self) -> None:
        await asyncio.sleep(0.4)
        try:
            await self.send_json({"method": "get", "params": {"ReqPrinterPara": 1}})
            await asyncio.sleep(0.3)
            # Lifetime totals (totalJob/totalUsageTime/totalUsageMaterial) arrive
            # with the history list; the printer pushes them again after each job.
            await self.send_json({"method": "get", "params": {"reqHistory": 1}})
        except Exception:  # noqa: BLE001
            pass

        t_para = asyncio.get_running_loop().time()
        while not self._stop.is_set():
            await asyncio.sleep(0.5)
            now = asyncio.get_running_loop().time()
            try:
                if now - t_para >= GET_PARA_SEC:
                    await self.send_json({"method": "get", "params": {"ReqPrinterPara": 1}})
                    t_para = now
                if now - self._last_rx >= 3 * PROBE_SILENCE_SEC:
                    self._set_connected(False)
                    if self._ws is not None:
                        await self._ws.close()
                    return
                if self._last_rx and now - self._last_rx >= PROBE_SILENCE_SEC:
                    await self.send_json({"method": "get", "params": {"ReqPrinterPara": 1}})
            except Exception:  # noqa: BLE001
                self._set_connected(False)
                if self._ws is not None:
                    await self._ws.close()
                return

    async def _handle_raw(self, raw: Any) -> None:
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="replace")
        if not isinstance(raw, str):
            return
        text = raw.strip()
        if not text:
            return
        if text == "ok":
            self._last_rx = asyncio.get_running_loop().time()
            return

        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            _LOGGER.debug("Non-JSON frame: %s", text[:80])
            return

        if not isinstance(payload, dict):
            return

        self._last_rx = asyncio.get_running_loop().time()

        if payload.get("ModeCode") == "heart_beat":
            try:
                if self._ws is not None:
                    await self._ws.send(HEARTBEAT_OK)
            except Exception:  # noqa: BLE001
                pass
            return

        # A frame the handler cannot process must not drop the connection: the
        # printer would resend the same state after the reconnect, in a loop.
        try:
            result = self._on_message(payload)
            if asyncio.iscoroutine(result):
                await result
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Error handling frame from %s: %.200s", self._host, text)
