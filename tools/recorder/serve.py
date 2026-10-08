#!/usr/bin/env python3
"""Serve the recorder UI and optionally proxy WebSocket to the printer.

Browsers are picky about WS handshakes (subprotocol / Origin). Python can talk
to the printer fine, so this process:
  1. Serves recorder static files on http://127.0.0.1:8765/
  2. Proxies  ws://127.0.0.1:8765/proxy?host=IP&port=9999  →  ws://IP:port

Usage:
  cd tools/recorder
  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
  .venv/bin/python serve.py
"""
from __future__ import annotations

import argparse
import asyncio
import mimetypes
import urllib.parse
from pathlib import Path

from websockets.asyncio.client import connect as ws_connect
from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

ROOT = Path(__file__).resolve().parent


def static_response(path: Path) -> Response:
    data = path.read_bytes()
    ctype, _ = mimetypes.guess_type(str(path))
    headers = Headers(
        [
            ("Content-Type", ctype or "application/octet-stream"),
            ("Content-Length", str(len(data))),
            ("Cache-Control", "no-store"),
        ]
    )
    return Response(200, "OK", headers, data)


def process_request(connection, request):
    """Serve static files; leave /proxy for WebSocket upgrade."""
    path = urllib.parse.urlparse(request.path).path
    if path.startswith("/proxy"):
        return None  # WebSocket handshake continues

    if path in ("/", "/index.html"):
        return static_response(ROOT / "index.html")

    # prevent path escape
    rel = path.lstrip("/")
    target = (ROOT / rel).resolve()
    if not str(target).startswith(str(ROOT)) or not target.is_file():
        body = b"Not found"
        headers = Headers([("Content-Type", "text/plain"), ("Content-Length", str(len(body)))])
        return Response(404, "Not Found", headers, body)

    return static_response(target)


async def handler(websocket):
    raw_path = websocket.request.path if websocket.request else ""
    parsed = urllib.parse.urlparse(raw_path)
    if parsed.path != "/proxy":
        await websocket.close(1008, "use /proxy")
        return

    qs = urllib.parse.parse_qs(parsed.query)
    host = (qs.get("host") or [""])[0].strip()
    port = (qs.get("port") or ["9999"])[0].strip() or "9999"
    if not host:
        await websocket.close(1008, "missing host")
        return

    # Validate host/port roughly
    if "/" in host or "\\" in host or host.startswith("["):
        await websocket.close(1008, "bad host")
        return
    try:
        p = int(port)
        if not (1 <= p <= 65535):
            raise ValueError
    except ValueError:
        await websocket.close(1008, "bad port")
        return

    # Do NOT send a browser Origin. Do NOT require subprotocol — printer often
    # ignores Sec-WebSocket-Protocol, which makes browsers abort.
    url = f"ws://{host}:{p}"
    print(f"[proxy] {websocket.remote_address} → {url}")

    try:
        # Printer firmware often ignores WebSocket protocol pings; default
        # ping_interval (~20s) then drops the proxy after ~40s → frozen UI.
        async with ws_connect(url, open_timeout=8, ping_interval=None) as printer:
            async def client_to_printer():
                async for message in websocket:
                    await printer.send(message)

            async def printer_to_client():
                async for message in printer:
                    await websocket.send(message)

            done, pending = await asyncio.wait(
                [
                    asyncio.create_task(client_to_printer()),
                    asyncio.create_task(printer_to_client()),
                ],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
            for t in done:
                exc = t.exception()
                if exc:
                    print(f"[proxy] side ended: {type(exc).__name__}: {exc}")
    except Exception as exc:
        print(f"[proxy] connect failed: {exc}")
        try:
            await websocket.close(1011, "printer unreachable")
        except Exception:
            pass


async def main(host: str, port: int) -> None:
    async with serve(
        handler, host, port, process_request=process_request, ping_interval=None
    ):
        print(f"Recorder UI:  http://{host}:{port}/")
        print(f"WS proxy:     ws://{host}:{port}/proxy?host=PRINTER_IP&port=9999")
        print("Leave this running, then open the UI and Connect (proxy mode is default).")
        await asyncio.Future()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Creality WS recorder UI + proxy")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    asyncio.run(main(args.host, args.port))
