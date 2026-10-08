# Creality WS notes (for later integration)

Capture-first reference while building a clean-room MIT integration / card. Prefer live recorder captures over assumptions.

## Official error-code sources

Integration DB is scraped from Creality Wiki only:

1. [K1 Series Error Code Summary](https://wiki.creality.com/en/k1-flagship-series/k1-series-general-documents/error-code-summary) — primary table for numeric `err.key`
2. [Creality OS Error Code](https://wiki.creality.com/en/printers-general-documents) — letter+number detail pages (BS/BM/AC/FR/…)
3. [CFS Error Code Summary](https://wiki.creality.com/en/cfs/error-code-summary)

**Not ingested:** community forums, Reddit, Discord. Those threads are anecdotal (often restate the wiki) and are not a maintained catalog. Creality’s own forum “correspondence table” posts largely mirror the wiki.

Letter prefixes (BS/BM/AC/…) name the module; the printer reports the **numeric** key. Refresh: `python scripts/update_error_codes.py`.

## Error object shape

Printer telemetry includes:

```json
"err": {
  "errcode": 0,
  "key": 0,
  "value": ""
}
```

| Field | Meaning |
|-------|---------|
| `key` | Documented Creality fault/prompt id — **lookup this** |
| `errcode` | Opaque internal type; **no reliable public map** (e.g. `212` with key `508`) |
| `value` | Optional string for message placeholders (e.g. storage `%s`) |

Display codes in Creality docs often look like `BS0508` (= key `508`). Module letter prefixes are described in Creality’s correspondence tables; the numeric part is what matters for lookup.

## Observed: `{"errcode":212,"key":508}`

- **Severity: warning / advisory — not a fatal print fault**
- Live sample (Ender 3 V3 KE / model `F005`): sticky while `deviceState: 0` (idle); WebSocket and telemetry still work
- Meaning: storage nearly full — delete unused G-code / time-lapse files
- Do **not** flip printer UI state to hard `"error"` solely because `errcode ≠ 0`

### UX guidance

- Classify by **`key`**, not `errcode`
- Key `508` → warning banner (storage cleanup), keep idle/printing/paused from `state` / `deviceState`
- Reserve hard error for keys that pause/stop the job (heaters, leveling faults, runout-with-pause, etc.)
- `ha_creality_ws` currently maps any nonzero `errcode` → `"error"` — too aggressive for 508 and similar prompts

## Official docs (lookup by key / BS0xxx)

- Detail page for 508: https://wiki.creality.com/en/printers-general-documents/BS0508
- Full K1-series summary table: https://wiki.creality.com/en/k1-flagship-series/k1-series-general-documents/error-code-summary
- General FFF error index: https://wiki.creality.com/en/printers-general-documents
- K2 Plus correspondence table (module prefixes): https://forum.creality.com/t/k2-plus-error-code-correspondence-table/21167
- Mirror / dealer summary: https://support.dremc.com.au/support/solutions/articles/51000488100-k1-error-code-summary-table

Neighboring keys often marked “only prompt” / AI detection (e.g. 500–507) should also stay non-fatal unless the print actually pauses.

## Browser connect

Direct `ws://printer:9999` from browsers often fails (close 1006): printer ignores `wsslicer` subprotocol / Origin quirks. Use `recorder/serve.py` proxy (`ws://127.0.0.1:8765/proxy?host=…&port=9999`). Python clients can talk to the printer directly.

**Proxy must disable WebSocket protocol pings** (`ping_interval=None`). Creality firmware often ignores them; the default ~20s ping then drops the proxy after ~40s, leaving a frozen UI while the printer is still printing.

## Filament runout (from real capture 2026-09-18)

Job: `micro m_PETG_2h9m.gcode`. Runout was **detectable**:

| Time (local) | Signal | Meaning |
|--------------|--------|---------|
| 19:04:11 | `materialStatus` **0 → 1** | Filament runout |
| 19:04:11 | `state` **1 → 5** | Auto-paused (same second) |
| 19:17:22 | `materialStatus` **1 → 0** | Filament restored (nozzle had cooled ~140°C) |
| 19:19:53 | `state` **5 → 0** | Leaving pause |
| 19:19:57 | `state` **0 → 1** | Printing resumed |

- Pause held ~16 min at **69%** / layer 314; `printJobTime` froze during pause
- `materialDetect` stayed `0` in this capture — use **`materialStatus == 1`** as the runout flag (matches `ha_creality_ws` coordinator comments)
- `err` stayed `{errcode:0,key:0}` during runout — do **not** rely on `err` for filament empty

### Detection recipe

1. **Runout event:** rising edge `materialStatus` 0→1 (optionally require `state==5` soon after)
2. **Paused:** `state == 5`
3. **Filament OK again:** `materialStatus` 1→0
4. **Resumed:** `state` returns to `1` (may pass through `0`)

**Warn the user** with a dedicated filament-runout notice — not a generic fatal error.

## Other quirks (same capture)

| Quirk | Implication |
|-------|-------------|
| `dProgress` stayed `0` | Prefer `printProgress` |
| On `state=2`, `layer`/`TotalLayer` → `0/0` | Latch peak layers for job history |
| Progress flickers `100↔99` at end | Debounce / require `state=2` for “finished” |
| `printLeftTime` jumped `1→593`s at ~92% | ETA sensor is unreliable; don’t over-trust it |
| Runout pause sets `targetNozzleTemp` ≈ 140°C | Hold temp, not a heater fault |
| Resume: `state` 5→0→1 (~3s), `deviceState` still 1 | Don’t call that “idle” |
| `materialStatus` frames are rare pushes | Value persists; edge-detect + hold in coordinator |
| `historyList[].thumbnail` path uses `humbnail` (typo) | Use path as returned |

## Time remaining (ETA) — don’t trust `printLeftTime` alone

From the 2026-09-18 capture (`micro m_PETG_2h9m.gcode`, actual `printJobTime` 8244s / 137 min):

| Estimator | Mean abs error vs true remaining |
|-----------|----------------------------------|
| Printer `printLeftTime` | ~6.7 min (often ~8 min optimistic; can also jump) |
| Progress: `elapsed/(prog/100) - elapsed` | ~4.5 min |
| Layer: `elapsed/(layer/total) - elapsed` | ~5.3 min |
| Blend slicer hint + observed rate | ~2.2 min |

Slicer hint in filename `…_2h9m.gcode` → 129 min (close to 137). `printJobTime` freezes during pause — good for elapsed.

### Recommended card/integration ETA

1. **Elapsed** = `printJobTime` (not wall clock)
2. **Observed rate** from `printProgress` and/or `layer`/`TotalLayer` (ignore when prog/layer is 0)
3. **Prior** from G-code name (`(\d+)h(\d+)m`) or G-code header `; TIME:` / Creality time comments when available
4. **Blend:** early weight prior more; after ~20–30% weight observed more
5. Show printer `printLeftTime` only as secondary / debug — or discard if it disagrees wildly

Pause: keep ETA frozen or based on `printJobTime` (already paused).

### 2026-10-05 capture (`v6 keyb_PLA_2h40m.gcode`, 10848 s, 878 layers, F005 V1.1.0.17)

Full print from layer 1 to `state=2`, ~5 frames/s, no disconnects.

| Estimator | Mean abs error |
|-----------|----------------|
| Printer `printLeftTime` | 1064 s |
| Previous blend (hint + 0.6·progress + 0.4·layer) | 1155 s (32% high at mid-print) |
| Hint + progress rate (current) | 454 s |

- Layers are not uniform in time: at 46% progress the job was at layer 317/878 (36%) because the wide base and supports were slow. Layer rate is no longer used for the ETA.
- `printLeftTime` is a linear countdown of the slicer estimate; it sat at `1` for ~6 min once the estimate ran out, then switched to a progress-based value (`1 → 1192` at 89%).
- Completion frame carries `state: 2, layer: 0, TotalLayer: 0` together; `deviceState: 0` follows ~0.5 s later. `autohome` changes `X:1 Y:1 Z:1` → `X:0 Y:0 Z:0` at completion.
- At `state=2` the printer pushes `historyList` plus `totalJob`, `totalUsageTime` (s), `totalUsageMaterial` (mm) unsolicited (twice). `elapseVideoList` entries later change `printId`/`videoid` to cloud hashes after upload (`upload: 1`); `id`/`videoname` stay stable.
- `err {errcode: 212, key: 508}` (storage) was reported for the first 14 min of the print, without `err.value`.
- Value-change rates while printing (per hour): position X/Y ~11k each, `nozzleTemp` 8.4k, `usedMaterialLength` 4.5k, Z 3.6k, `printJobTime`/`printLeftTime` 2.8k, `bedTemp0` 2.2k, `realTimeSpeed` 1.6k, `realTimeFlow` 1.3k. The coordinator throttles these to one publish per second.
- Unused keys: `objects`/`current_object`/`excluded_objects` (exclude-object data, ~450 B per frame), `curZOffset`, `accelerationLimits`/`accelToDecelLimits`/`cornerVelocityLimits` (change with the G-code).


On `state=2`, live layers go `0/0`. Card already uses `preferLayers()` in `creality-card.js`. Keep latching when rewriting save/history or building the integration; regression against the 2026-09-18 capture.

## Controls & camera (from `ha_creality_ws` protocol map)

Clean-room reference — field names only; re-verify on hardware when implementing.

All controls are WebSocket `{"method":"set","params":{…}}` (no subprotocol required from Python).

| Action | `params` |
|--------|----------|
| Pause | `pause: 1` |
| Resume | `pause: 0` |
| Stop | `stop: 1` |
| Home XY then Z | `autohome: "X Y"` → wait until `deviceState != 7` → `autohome: "Z"` |
| Nozzle target °C | `nozzleTempControl: <int>` |
| Bed target °C | `bedTempControl: {"num": 0, "val": <int>}` (multi-zone uses num 1/2) |
| Chamber target | `boxTempControl: <int>` (if present) |
| Print speed/flow | `setFeedratePct` / `setFlowratePct` |
| Light on/off | `lightSw: 1` / `0` |
| Fans | `gcodeCmd: "M106 P<ch> S<0-255>"` — P0 model, P1 case, P2 side/aux |
| Start uploaded G-code | `opGcodeFile: "printprt:/usr/data/printer_data/gcodes/<file>"` |

### HTTP file endpoints (port 80, stock F005 fw V1.1.0.17, 2026-10-03)

| Request | Result |
|---------|--------|
| `GET /downloads/original/current_print_image.png` | Current job thumbnail (PNG) |
| `GET /downloads/gcode/<basename>` | Full G-code of a file in `printer_data/gcodes` (URL-encode spaces). `application/octet-stream`; ignores `Range`; `HEAD` reports `Content-Length: 0`. About 0.5 MB/s. MD5 matched `historyList[].filemd5`. |
| `GET /downloads/video/<videoname>` | Timelapse MP4 from `elapseVideoList` (`video/mp4`, real `Content-Length`, `ETag`; advertises `Accept-Ranges: bytes` but answers `Range` with the full 200 body). About 0.5 MB/s; long prints make 30–45 MB videos. |
| `GET /info` | `{"mac", "model"}` |

Other guesses (`/downloads/<file>`, `/downloads/gcodes/…`, `/server/files/gcodes/…`) return 404; Moonraker ports 7125/4408 are closed on stock firmware.

Read-only WS listings: `get {"reqGcodeFile": 1}` → `retGcodeFileInfo` (`totalNum`; `fileInfo` is `;`-separated `dir:name:size:layerHeight:ctime:?:thumbnailPath`), `get {"reqHistory": 1}` → `historyList[]` with `filename`, `size`, `filemd5`, `thumbnail` (the job-end push of the same list also carries `totalJob`, `totalUsageTime`, `totalUsageMaterial`; the integration requests it once per connection for those totals).

Timelapses: `get {"reqElapseVideoList": 1}` → `elapseVideoList[]` (newest first, ~50 kept), each with `id` (= telemetry `printStartTime` = `historyList[].id`), `gcodename`, `videoname` (`<id>.mp4`), `size`, `duration` (s), `cover` (on-device PNG path; no HTTP path found), `printtime`, `interval`, `render` (fps), `upload`, `printId`. 1-minute ~10-layer jobs got no entry while 2-minute jobs did. Telemetry `videoElapse`/`videoElapseInterval`/`videoElapseFrame` are the timelapse settings (on, 1 layer, 15 fps).

### Camera modes (same integration)

| Mode | URL / port |
|------|------------|
| MJPEG (K1 / many KE) | `http://{host}:8080/?action=stream` |
| WebRTC signaling (K2 / some newer) | `http://{host}:8000/call/webrtc_local` (also probe `/call`) |
| Custom | user-provided MJPEG/RTSP |

Detect: telemetry `webrtcSupport == 1` and/or HTTP probe of WebRTC paths; else MJPEG. Preview thumbs often come from print metadata / `historyList[].thumbnail`, not the live camera.

Source files in sibling clone: `button.py`, `coordinator.py` (pause/resume), `number.py`, `fan.py`, `light.py`, `const.py`, `camera.py`, `config_flow.py`.


Creality Print does **not** send STL to the printer. Flow is:

1. **Slice locally** (Creality Print / Orca / etc.) → produce `.gcode`
2. **HTTP upload** to the printer (port **80**): multipart `POST /upload/<filename.gcode>` with form field `file`
3. **WebSocket start** (port **9999**):  
   `{"method":"set","params":{"opGcodeFile":"printprt:/usr/data/printer_data/gcodes/<filename.gcode>"}}`  
   (K2 family may use `/mnt/UDISK/printer_data/gcodes/` — confirm per model)

Notes from community / Orca `CrealityPrint` host:
- Multipart is required (raw body can corrupt the saved file)
- Optional `Authorization: Bearer <api key>` on some firmware
- Sanitize spaces → underscores consistently for upload name + `opGcodeFile` path
- Your KE (`F005`) already stores jobs under `/usr/data/printer_data/gcodes/` (see capture `printFileName`)

Refs: [OrcaSlicer #2103](https://github.com/OrcaSlicer/OrcaSlicer/issues/2103), CrealityPrint host type in Orca.
