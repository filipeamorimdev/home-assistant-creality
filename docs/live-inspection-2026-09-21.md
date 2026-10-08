# Read-only printer inspection — 2026-09-21

Device: LAN host `10.0.0.24`, model `F005`, reported firmware `V1.1.0.17`.
Read-only WebSocket requests: `get/ReqPrinterPara` and `get/reqPrintObjects`;
heartbeat acknowledgements only. No set/control commands were sent.
The printer reported `state=1`, progress 88%, layer 610/730 during the sample.

## Preview implementation

HTTP GET `/downloads/original/current_print_image.png` returned 200, image/png,
8669 bytes. The downloaded image was visually checked. Our integration now
exposes this endpoint through an HA image entity and the bundled card discovers
it by stable unique ID. This is an independent implementation, not copied from
the AGPL reference package.

## Additional live fields not exposed as dedicated entities

Values are a single observation, not guaranteed capabilities on other models.
Units/semantics below marked as candidates require verification before adding
entity device classes or controls.

| Field | Observed | Potential use / current limitation |
|---|---|---|
| `realTimeSpeed` | 118.88 | Actual motion speed candidate; our `print_speed` is instead the 100% feed-rate multiplier |
| `curFlowratePct` | 100 | Separate extrusion-flow multiplier sensor; current tuning control sends both feed and flow changes |
| `realTimeFlow` | 4.58 | Live extrusion-flow sensor candidate; verify units |
| `printStartTime` | 1789990474 | Job identity; now used to reset preview cache for repeat filenames |
| `curZOffset` | 2.421 | Z-offset diagnostic; do not expose adjustments without validation |
| `pressureAdvance` / `smoothTime` | 0.08 / 0.04 | Extrusion-tuning diagnostics |
| `velocityLimits` | 500 | Motion-limit diagnostic |
| `accelerationLimits` / `accelToDecelLimits` | 5000 / 1250 | Motion-limit diagnostics |
| `cornerVelocityLimits` | 12 | Corner-motion diagnostic |
| `current_object` | STL object identifier | Current object differs from G-code filename; ours currently prefers the filename |
| `objects` | JSON string with name, center, polygon | Bed/object visualization; no exclusion commands tested |
| `excluded_objects` | JSON string, empty array | Display already-excluded objects; read-only only |
| `video`, `video1`, `videoElapse` | 1, 0, 1 | Camera/timelapse status candidates; flags do not establish working stream support |
| `videoElapseFrame` / `videoElapseInterval` | 15 / 1 | Timelapse metadata; semantics need validation |
| `tfCard`, `powerLoss`, `repoPlrStatus` | 1, 0, 0 | Storage/power-loss diagnostics; meanings need verification |

The frame also contains AI flags, additional bed temperatures and `boxTemp=0`.
Presence or a zero value does not demonstrate that this KE has the hardware.
Avoid creating misleading sensors for unsupported features.

The best next additions are separate actual-speed and flow sensors, a job-start
timestamp, and object metadata. The existing combined speed/flow tuning command
deserves a separate change: a user changing print speed should not unexpectedly
change extrusion flow. No unrelated entities or controls were changed here.

This was a bounded live sample, not an exhaustive firmware/API audit. No
`historyList` thumbnail appeared in these responses; the working fixed image
endpoint removes the need to rely on print history for the preview.
