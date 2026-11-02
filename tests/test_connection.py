"""Connection lifecycle regressions without a printer or HA installation."""

import importlib
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch


class ConnectionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        package = ModuleType("connection_test_package")
        package.__path__ = [str(Path(__file__).parents[1] / "custom_components/creality")]
        modules = {package.__name__: package}
        for name in ("websockets", "websockets.asyncio", "websockets.asyncio.client"):
            modules[name] = ModuleType(name)
        modules["websockets.asyncio.client"].connect = None
        with patch.dict(sys.modules, modules):
            self.module = importlib.import_module("connection_test_package.ws_client")

    async def test_disconnect_and_reconnect_notify_immediately(self):
        states = []
        client = self.module.CrealityWsClient("printer", lambda _: None,
                                             lambda: states.append(client.connected))
        client._ws = SimpleNamespace(close=AsyncMock())
        client._set_connected(True)
        await client.stop()
        client._set_connected(False)
        client._ws = SimpleNamespace(close=AsyncMock())
        client._set_connected(True)
        self.assertEqual(states, [True, False, True])

    async def test_silent_socket_closes_instead_of_retaining_idle_state(self):
        client = self.module.CrealityWsClient("printer", lambda _: None)
        socket = SimpleNamespace(close=AsyncMock(), send=AsyncMock())
        client._ws = socket
        client._set_connected(True)
        client._last_rx = 1
        with patch.object(self.module.asyncio, "sleep", AsyncMock()), patch.object(
            self.module.asyncio, "get_running_loop", return_value=SimpleNamespace(time=lambda: 100)
        ):
            await client._poll_loop()
        self.assertFalse(client.connected)
        socket.close.assert_awaited_once()
        self.assertEqual(client.last_rx, 1)  # A sent probe is not a received frame.

    async def test_clean_closes_back_off_instead_of_reconnecting_immediately(self):
        client = self.module.CrealityWsClient("printer", lambda _: None)
        waits = []

        async def fake_wait_for(awaitable, timeout):
            awaitable.close()
            waits.append(timeout)
            raise self.module.asyncio.TimeoutError

        calls = 0

        async def session():
            nonlocal calls
            calls += 1
            if calls == 3:
                client._stop.set()

        client._session = session
        with patch.object(self.module.asyncio, "wait_for", fake_wait_for):
            await client._run()
        self.assertEqual(calls, 3)
        self.assertEqual(waits, [1.0, 1.8])

    async def test_send_retry_waits_for_reconnect_then_gives_up(self):
        client = self.module.CrealityWsClient("printer", lambda _: None)
        client.wait_connected = AsyncMock(return_value=False)
        with patch.object(self.module.asyncio, "sleep", AsyncMock()):
            with self.assertRaises(ConnectionError):
                await client.send_set_retry(pause=1)
        client.wait_connected.assert_awaited_once()

    async def test_heartbeat_and_ok_keep_connection_alive(self):
        messages = []
        client = self.module.CrealityWsClient("printer", messages.append)
        client._ws = SimpleNamespace(send=AsyncMock())
        with patch.object(self.module.asyncio, "get_running_loop", return_value=SimpleNamespace(time=lambda: 100)):
            await client._handle_raw('{"ModeCode":"heart_beat"}')
            self.assertEqual(client.last_rx, 100)
            client._ws.send.assert_awaited_once_with("ok")
            client._last_rx = 0
            await client._handle_raw("ok")
            self.assertEqual(client.last_rx, 100)
        self.assertEqual(messages, [])

    async def test_frame_handler_error_is_logged_and_connection_kept(self):
        def broken(_frame):
            raise AttributeError("'str' object has no attribute 'get'")

        client = self.module.CrealityWsClient("printer", broken)
        with self.assertLogs(self.module._LOGGER, "ERROR") as logs:
            await client._handle_raw('{"err":"oops"}')  # Must not raise into the session loop.
        self.assertIn("Error handling frame from printer", logs.output[0])
