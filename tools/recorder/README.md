# Creality WS Recorder (standalone)

Isolated browser tool to connect to a Creality printer WebSocket and record a print session.

## Why direct Connect often fails

The printer accepts Python WebSockets fine, but **does not negotiate** `Sec-WebSocket-Protocol: wsslicer`. Browsers then abort the handshake (close **1006**). Origin headers can also cause trouble in some environments (e.g. Cursor’s embedded browser).

**Fix:** run `serve.py`, which serves the UI and proxies `ws://127.0.0.1:8765/proxy?…` → the printer (no browser subprotocol requirement).

## Run (recommended)

```bash
cd home-assistant-creality/tools/recorder
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python serve.py
```

Open [http://127.0.0.1:8765/](http://127.0.0.1:8765/)

1. Enter printer IP (e.g. `10.0.0.24`)
2. Leave **Via local proxy** checked
3. **Connect** → live keys should appear
4. **Start recording** → **Stop & download**

Hard-refresh (`Cmd+Shift+R`) if you still see the old page.

## Capture JSON

- `keys` — every top-level key + type/sample
- `timeline` — frames while recording
- `finalState` — last merged map

## Notes

- Keep `serve.py` running the whole time
- Same LAN as the printer
- Read-only (+ periodic `get` polls); no pause/stop commands
- Error-code / protocol notes for later app work: [`../../docs/creality-ws-notes.md`](../../docs/creality-ws-notes.md)
