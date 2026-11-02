/**
 * custom:creality-card
 * HACS / Lovelace resource: creality-card.js (type: module)
 */

const CARD_TAG = "creality-card";

// Card key -> entity domain and stable CrealityEntity unique-ID suffix.
// Never derive entity IDs from display names: HA may rename or suffix them.
const ENTITY_ROLES = {
  preview: ["image", "current_print_preview"],
  camera: ["camera", "printer_camera"],
  status: ["sensor", "print_status"],
  progress: ["sensor", "print_progress"],
  object: ["sensor", "current_object"],
  layer: ["sensor", "working_layer"],
  total_layers: ["sensor", "total_layers"],
  job_time: ["sensor", "print_job_time"],
  time_left: ["sensor", "print_time_left"],
  used_material: ["sensor", "used_material_length"],
  filament: ["sensor", "filament_status"],
  position_x: ["sensor", "position_x"],
  position_y: ["sensor", "position_y"],
  position_z: ["sensor", "position_z"],
  home: ["button", "home_xy_then_z"],
  print_speed: ["sensor", "print_speed"],
  print_tuning: ["number", "print_tuning"],
  flow_tuning: ["number", "flow_tuning"],
  model_fan: ["fan", "model_fan"],
  case_fan: ["fan", "case_fan"],
  side_fan: ["fan", "side_fan"],
  pause: ["button", "pause_print"],
  resume: ["button", "resume_print"],
  stop: ["button", "stop_print"],
  nozzle: ["sensor", "nozzle_temperature"],
  nozzle_target: ["number", "nozzle_target"],
  bed: ["sensor", "bed_temperature"],
  bed_target: ["number", "bed_target"],
};

const CAMERA_ASPECTS = ["16:9", "4:3", "1:1", "21:9"];

/** Clock time following the user's Home Assistant language and 12/24-hour setting. */
function fmtClock(date, locale) {
  const options = { hour: "2-digit", minute: "2-digit" };
  if (locale?.time_format === "12") options.hour12 = true;
  else if (locale?.time_format === "24") options.hour12 = false;
  const language = locale?.time_format === "system" ? undefined : locale?.language;
  try {
    return date.toLocaleTimeString(language || [], options);
  } catch (_err) {
    return date.toLocaleTimeString([], options); // Unknown language tag.
  }
}

/** No job on the printer: nothing for the profile and thumbnail tiles to show. */
function isIdleStatus(status) {
  return ["idle", "standby", "unknown", "unavailable", ""].includes(String(status ?? "").toLowerCase());
}

const NO_JOB_TEXT = "No printing job running";
const ACTIVE_STATUSES = ["printing", "paused", "pausing", "resuming", "processing"];
const TERMINAL_STATUSES = ["completed", "stopped"];

/** Profile tile text while no G-code silhouette is available. */
function profileEmptyText(jobKey, status) {
  if (!jobKey) return NO_JOB_TEXT;
  if (status === "loading" || status === "pending" || status === undefined) return "Reading G-code…";
  if (status === "unavailable") return "No G-code profile for this print";
  if (status === "failed") return "G-code profile failed; retrying";
  return "No G-code profile";
}

async function integrationDefaults(hass, entities = [], entitiesFallback = []) {
  const config = { title: "Creality Printer", preview: "", printer_switch: "" };
  if (!hass?.callWS) return config;
  let registry;
  try {
    registry = await hass.callWS({ type: "config/entity_registry/list" });
  } catch (error) {
    console.warn("Creality card: unable to discover integration entities", error);
    return config;
  }
  const candidates = registry.filter((entry) =>
    entry.platform === "creality" && entry.config_entry_id && !entry.disabled_by &&
    hass.states?.[entry.entity_id] && Object.values(ENTITY_ROLES).some(([domain, suffix]) =>
      entry.entity_id.startsWith(`${domain}.`) &&
      entry.unique_id === `${entry.config_entry_id}_${suffix}`
    )
  ).sort((a, b) => a.entity_id.localeCompare(b.entity_id));
  // Respect HA's suggested entities when available; otherwise pick one printer
  // deterministically. Never fill a missing role with another printer's entity.
  const selected = [...entities, ...entitiesFallback]
    .map((id) => candidates.find((entry) => entry.entity_id === id))
    .find(Boolean) || candidates[0];
  if (!selected) return config;
  const own = candidates.filter((entry) => entry.config_entry_id === selected.config_entry_id);
  const device = hass.devices?.[selected.device_id];
  config.title = device?.name_by_user || device?.name || config.title;
  for (const [key, [domain, suffix]] of Object.entries(ENTITY_ROLES)) {
    const entry = own.find((item) => item.entity_id.startsWith(`${domain}.`) &&
      item.unique_id === `${selected.config_entry_id}_${suffix}`);
    if (entry) config[key] = entry.entity_id;
  }
  return config;
}

const LABELS = {
  print_energy: "Power or energy sensor",
  camera: "Camera",
  camera_aspect: "Camera height",
  hide_tiles: "Hide from the top row",
  preview: "Print preview",
  status: "Print status",
  progress: "Print progress",
  object: "Current object / file",
  layer: "Working layer",
  total_layers: "Total layers",
  job_time: "Print job time",
  time_left: "Time left (printer)",
  used_material: "Used material length",
  filament: "Filament status",
  printer_switch: "Printer power switch",
  position_x: "Position X",
  position_y: "Position Y",
  position_z: "Position Z",
  home: "Home (XY then Z)",
  print_speed: "Print speed sensor",
  print_tuning: "Print speed multiplier",
  flow_tuning: "Flow multiplier",
  model_fan: "Model fan",
  case_fan: "Case fan",
  side_fan: "Side fan",
  pause: "Pause print",
  resume: "Resume print",
  stop: "Stop print",
  nozzle: "Nozzle temperature",
  nozzle_target: "Nozzle target",
  filament_change_temp: "Replace filament temperature",
  bed: "Bed temperature",
  bed_target: "Bed target",
};

const HELPERS = {
  camera_aspect: "Height of the camera tile; Wide (16:9) when not set.",
  filament_change_temp: "Nozzle target set by Replace filament and the runout banner; 240 °C when not set.",
  hide_tiles: "Ticked tiles are not shown next to the camera. With no print job they merge into one 'No printing job running' tile.",
};

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function num(value, digits = 1) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function fmtDuration(value) {
  if (value == null || value === "" || value === "unknown" || value === "unavailable") {
    return "—";
  }
  if (typeof value === "string" && value.includes(":")) return value;
  const s = Math.floor(Number(value));
  if (!Number.isFinite(s) || s < 0) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  if (m > 0) return `${m}:${String(sec).padStart(2, "0")}`;
  return `${sec}s`;
}

function progressPct(value, state) {
  if (isMissingState(value)) return 0;
  const n = parseFloat(value);
  if (!Number.isFinite(n) || n < 0) return 0;

  const unit = normalizeUnit(state?.attributes?.unit_of_measurement);
  const max = parseFloat(state?.attributes?.max ?? state?.attributes?.native_max);
  const isPercentUnit = unit === "%" || unit === "percent" || unit === "perc";
  const isRatioScale = Number.isFinite(max) && max > 0 && max <= 1;

  // Explicit percent (Creality progress is usually 0–100).
  if (isPercentUnit) {
    return Math.min(100, Math.max(0, n));
  }
  // Entity declares a 0–1 scale.
  if (isRatioScale) {
    return Math.min(100, Math.max(0, n * 100));
  }
  // Only treat clear fractions (0 < n < 1). Never map bare `1` → 100%
  // (that made the bar look complete at 1% progress).
  if (n > 0 && n < 1) {
    return Math.min(100, n * 100);
  }
  return Math.min(100, Math.max(0, n));
}

function isMissingState(value) {
  return value == null || value === "" || value === "unknown" || value === "unavailable";
}

/** Format layer / total; treat numeric 0 as valid (unlike truthy checks). */
function formatLayers(layer, total) {
  const lOk = !isMissingState(layer);
  const tOk = !isMissingState(total);
  if (lOk && tOk) return `${layer} / ${total}`;
  if (lOk) return String(layer);
  if (tOk) return `— / ${total}`;
  return "";
}

/** Layer-count progress only: this is not a geometric slice of the thumbnail. */
function layerPreviewProgress(layer, total, status, rawState) {
  if (isMissingState(total) || isMissingState(layer)) return null;
  const count = Number(total);
  const current = Number(layer);
  if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(current) || current < 0) return null;
  const completed = rawState != null ? Number(rawState) === 2 : status === "completed";
  const fraction = completed ? 1 : Math.min(1, current / count);
  return { fraction, layer: Math.min(current, count), total: count, completed,
    paused: status === "paused", percent: Math.round(fraction * 100) };
}

function layerProgressText(progress) {
  return progress.completed ? `Complete · ${progress.total} layers`
    : `Layer ${progress.layer} / ${progress.total} · ${progress.percent}%${progress.paused ? " · Paused" : ""}`;
}

function parseLayerPair(layers) {
  const m = String(layers || "").match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return { layer: Number(m[1]), total: Number(m[2]) };
}

/** Keep peak layers when the printer resets sensors to 0/0 after a job. */
function preferLayers(live, previous) {
  const a = parseLayerPair(live);
  const b = parseLayerPair(previous);
  if (!a && !b) return live || previous || "";
  if (!a) return previous || "";
  if (!b) return live || "";
  if (a.layer === 0 && a.total === 0 && (b.layer > 0 || b.total > 0)) return previous;
  if (b.total > a.total) return previous;
  if (b.total === a.total && b.layer > a.layer) return previous;
  return live;
}

function prettyStatus(value) {
  const s = String(value || "unknown").replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function statusClass(value) {
  const s = String(value || "").toLowerCase();
  if (["printing", "resuming", "processing"].includes(s)) return "is-print";
  if (["paused", "pausing"].includes(s)) return "is-pause";
  if (["error", "stopped"].includes(s)) return "is-error";
  if (["idle", "completed"].includes(s)) return "is-idle";
  return "";
}

/** Banner text for the print status entity's `err_*` attributes, or null when there is none. */
function printerAlert(attrs) {
  const key = Number(attrs?.err_key) || 0;
  if (!key) return null;
  const severity = String(attrs.err_severity || "unknown").toLowerCase();
  const value = String(attrs.err_value || "").trim();
  // Wiki messages may carry a printf placeholder for the printer's `err.value`.
  let message = String(attrs.err_message || "").trim() || `Error key ${key}`;
  message = message.replace(/%s/g, value || "…");
  const label = severity === "error" ? "Printer error" : "Printer warning";
  return {
    severity,
    id: `${key}|${value}`,
    title: `${label} ${key}: ${message}`,
    detail: String(attrs.err_solution || "").trim(),
  };
}

/** Default nozzle target (°C) to unload/load filament; card option `filament_change_temp`. */
const FILAMENT_CHANGE_TEMP = 240;

/** True while the filament status entity reports a runout (`materialStatus == 1`). */
function isFilamentRunout(state) {
  return String(state?.state ?? "").toLowerCase() === "runout";
}

function isOn(state) {
  if (!state) return false;
  if (state.state === "on") return true;
  const pct = parseFloat(state.attributes?.percentage);
  return Number.isFinite(pct) && pct > 0;
}

const PRINT_STORE_KEY = "creality_print_log";
const PRINT_LIMIT = 200;
const PREVIEW_THUMB_SIZE = 96;
const PREVIEW_RETRY_MS = 60000;
// The printer renders the timelapse after the job ends; keep looking this long.
const TIMELAPSE_WAIT_MS = 5 * 60000;
const TIMELAPSE_POLL_MS = 15000;
const TIMELAPSE_RETRY_MS = 30000;
/** CameraEntityFeature.STREAM */
const CAMERA_SUPPORT_STREAM = 2;
const DELETED_LIMIT = 500;
const FILAMENT_CUSTOM = "__custom__";
/**
 * Panels collapsed when the card is built. Panels set to true always start
 * collapsed; only the others remember (in localStorage) that they were collapsed.
 */
const DEFAULT_COLLAPSED = {
  print: false,
  controls: true,
  log: false,
  temp: true,
};
const FILAMENT_TYPES = [
  "PLA",
  "PLA+",
  "PETG",
  "TPU",
  "ABS",
  "ASA",
  "PVA",
  "Nylon",
  "PC",
  "HIPS",
  "Silk PLA",
  "Wood PLA",
  "CF-PLA",
  "CF-PETG",
  "Recycled PLA",
];
const FILAMENT_DENSITY = {
  pla: 1.24,
  "pla+": 1.24,
  "silk pla": 1.24,
  "wood pla": 1.2,
  "cf-pla": 1.3,
  "recycled pla": 1.24,
  petg: 1.27,
  "cf-petg": 1.3,
  tpu: 1.21,
  abs: 1.04,
  asa: 1.07,
  pva: 1.23,
  nylon: 1.14,
  pa: 1.14,
  pc: 1.2,
  hips: 1.04,
};

// Slicer spellings of the types above (Creality Print writes e.g. "PLA-CF").
const FILAMENT_ALIASES = { "PLA-CF": "CF-PLA", "PETG-CF": "CF-PETG", "PA": "Nylon", "SILK": "Silk PLA" };

/**
 * Filament type named in a sliced file ("part_PETG_2h9m.gcode" → "PETG"), or
 * null. Creality Print puts the material right before the time, so the last
 * match wins; longer names win at the same place ("CF-PLA" over "PLA").
 */
function filamentFromFileName(file) {
  const name = ` ${String(file || "").replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "").replace(/[_\s.]+/g, " ")} `;
  const names = [...FILAMENT_TYPES.map((type) => [type, type]), ...Object.entries(FILAMENT_ALIASES)];
  let best = null;
  for (const [spelling, type] of names) {
    const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[ -]?");
    const re = new RegExp(`[ -](${escaped})(?=[ -])`, "gi");
    for (const m of name.matchAll(re)) {
      const at = m.index + m[0].length;
      if (!best || at > best.at || (at === best.at && m[1].length > best.length)) best = { at, length: m[1].length, type };
    }
  }
  return best?.type || null;
}

function filamentDensity(type) {
  const key = String(type || "").trim().toLowerCase();
  return FILAMENT_DENSITY[key] || 1.24;
}

function parseDurationSeconds(value) {
  if (value == null || value === "" || value === "unknown" || value === "unavailable") return null;
  if (typeof value === "string" && value.includes(":")) {
    const parts = value.split(":").map(Number);
    if (parts.some((p) => !Number.isFinite(p))) return null;
    if (parts.length === 3) return Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2]);
    if (parts.length === 2) return Math.round(parts[0] * 60 + parts[1]);
  }
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function toLocalDateTimeValue(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return toLocalDateTimeValue();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDateShort(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function estimateWeightG(used, unit, type, diameterMm) {
  const n = parseFloat(used);
  if (!Number.isFinite(n) || n < 0) return null;
  const u = String(unit || "mm").trim().toLowerCase();
  if (u === "kg") return n * 1000;
  if (u === "g") return n;
  let mm = n;
  if (u === "m" || u === "meter" || u === "meters") mm = n * 1000;
  else if (u === "cm") mm = n * 10;
  const dia = parseFloat(diameterMm);
  const d = Number.isFinite(dia) && dia > 0 ? dia : 1.75;
  const volumeMm3 = Math.PI * (d / 2) ** 2 * mm;
  return (volumeMm3 / 1000) * filamentDensity(type);
}

function estimateCost(weightG, costPerKg) {
  const w = parseFloat(weightG);
  const c = parseFloat(costPerKg);
  if (!Number.isFinite(w) || !Number.isFinite(c) || c < 0) return null;
  return (w / 1000) * c;
}

function estimateEnergyCost(energyKwh, costPerKwh) {
  const e = parseFloat(energyKwh);
  const c = parseFloat(costPerKwh);
  if (!Number.isFinite(e) || !Number.isFinite(c) || e < 0 || c < 0) return null;
  return e * c;
}

function fmtMoney(value, currency) {
  if (!Number.isFinite(value)) return "—";
  // Tiny test prints cost fractions of a cent; "€0.00" would read as "free".
  if (value > 0 && value < 0.005) return `< ${currency || "€"}0.01`;
  return `${currency || "€"}${value.toFixed(2)}`;
}

/** Saved "Time spent" with units ("1m 38s", "2h 40m"); free text is kept as typed. */
function fmtSpent(row) {
  const s = Number(row?.timeSeconds);
  if (row?.timeSeconds == null || row.timeSeconds === "" || !Number.isFinite(s) || s < 0) {
    return row?.timeLabel && row.timeLabel !== "—" ? row.timeLabel : null;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.round(s % 60);
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return sec ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}

/** Printer job id (printStartTime) of a saved row; older rows only carry it inside jobKey. */
function rowStartTime(row) {
  const raw = row?.startTime ?? String(row?.jobKey || "").split("|")[1];
  const n = Number(raw);
  return raw !== "" && raw != null && Number.isFinite(n) && n > 0 ? n : null;
}

function fmtWeight(grams) {
  if (!Number.isFinite(grams)) return "—";
  if (grams >= 1000) return `${(grams / 1000).toFixed(2)} kg`;
  return `${grams >= 10 ? grams.toFixed(0) : grams.toFixed(1)} g`;
}

function fmtEnergy(kwh) {
  if (!Number.isFinite(kwh) || kwh < 0) return "—";
  if (kwh < 0.01) return `${Math.round(kwh * 1000)} Wh`;
  return `${kwh.toFixed(kwh < 1 ? 3 : 2)} kWh`;
}

/** Load failure note; ``source: "folder"`` results come from the saved copy. */
function loadErrorText(result) {
  return result?.source === "folder"
    ? "Couldn't load the saved timelapse. Try again."
    : "Couldn't load the timelapse from the printer. Try again.";
}

/**
 * Whole video as a blob URL, so the player can seek freely (the printer
 * ignores Range requests). ``onProgress`` gets 0..1 when the size is known.
 */
async function fetchVideoBlobUrl(url, signal, sizeHint, onProgress) {
  const resp = await fetch(url, { signal, credentials: "same-origin" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const total = Number(resp.headers.get("Content-Length")) || Number(sizeHint) || 0;
  const chunks = [];
  let received = 0;
  const reader = resp.body?.getReader?.();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) onProgress?.(Math.min(1, received / total));
    }
  } else {
    chunks.push(await resp.blob());
  }
  return URL.createObjectURL(new Blob(chunks, { type: "video/mp4" }));
}

/** Read-only definition list for one saved print (Print details panel). */
function printDetailsHtml(p) {
  const finite = (v) => Number.isFinite(parseFloat(v));
  const ended = new Date(p.ended);
  const filamentCost = Number.isFinite(p.estimatedCost) ? p.estimatedCost : null;
  const energyCost = Number.isFinite(p.estimatedEnergyCost) ? p.estimatedEnergyCost : null;
  const total = filamentCost != null || energyCost != null ? (filamentCost || 0) + (energyCost || 0) : null;
  const energy = finite(p.energyKwh)
    ? `${fmtEnergy(parseFloat(p.energyKwh))}${p.energyQuality === "partial" ? " (partial)" : ""}`
    : null;
  const items = [
    ["File", p.file || "Untitled print", true],
    ["Ended", Number.isNaN(ended.getTime()) ? null : ended.toLocaleString(), true],
    ["Result", prettyStatus(p.result)],
    ["Time spent", fmtSpent(p)],
    ["Layers", p.layers || null],
    ["Progress", Number.isFinite(p.progress) ? `${num(p.progress, 0)}%` : null],
    ["Filament used", finite(p.used) ? fmtUsed(p.used, p.usedUnit) : null],
    ["Filament type", p.filamentType || null],
    ["Diameter", finite(p.diameterMm) ? `${p.diameterMm} mm` : null],
    ["Est. weight", Number.isFinite(p.weightG) ? fmtWeight(p.weightG) : null],
    ["Cost / kg", finite(p.costPerKg) ? fmtMoney(parseFloat(p.costPerKg), p.currency) : null],
    ["Filament cost", filamentCost != null ? fmtMoney(filamentCost, p.currency) : null],
    ["Energy", energy],
    ["Cost / kWh", finite(p.costPerKwh) ? fmtMoney(parseFloat(p.costPerKwh), p.currency) : null],
    ["Energy cost", energyCost != null ? fmtMoney(energyCost, p.currency) : null],
    ["Total cost", total != null ? fmtMoney(total, p.currency) : null],
    ["Notes", p.notes || null, true],
  ];
  const thumb = p.preview ? `<img class="log-detail-thumb" src="${esc(p.preview)}" alt="" />` : "";
  return (
    thumb +
    items
      .map(([label, value, wide]) =>
        `<div${wide ? ' class="wide"' : ""}><dt>${esc(label)}</dt><dd>${esc(value ?? "—")}</dd></div>`)
      .join("")
  );
}

function fmtUsed(used, unit) {
  const n = parseFloat(used);
  if (!Number.isFinite(n)) return "—";
  return `${num(n, n >= 100 ? 0 : 1)} ${unit || "mm"}`;
}

function normalizeUnit(unit) {
  return String(unit || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

const METER_UNITS = {
  w: ["power", 1], kw: ["power", 1000],
  wh: ["energy", 0.001], kwh: ["energy", 1], mwh: ["energy", 1000],
};

/** [mode, factor] for a power/energy meter, or null. */
function meterKind(state) {
  if (!state) return null;
  return METER_UNITS[normalizeUnit(state.attributes?.unit_of_measurement)] || null;
}

/**
 * Energy over [startMs, endMs] from recorder history points ({t, v}, NaN = gap).
 * Power is a left sum (HA records changes, so a value holds until the next one);
 * energy counters sum increases. Gaps, a late first sample or a counter reset
 * make the total partial; no usable sample at all returns null. A power
 * `baselineW` (the power offset: the meter's load before the printer was switched on) is removed
 * from every reading, never going below zero.
 */
function integrateMeter(points, [mode, factor], startMs, endMs, baselineW = 0) {
  const pts = points.filter((p) => p.t < endMs).sort((a, b) => a.t - b.t);
  let kwh = 0;
  let partial = false;
  let sampled = false;
  if (!pts.length || pts[0].t > startMs + 60000) partial = true;
  if (mode === "power") {
    pts.forEach((p, i) => {
      const from = Math.max(p.t, startMs);
      const to = Math.min(i + 1 < pts.length ? pts[i + 1].t : endMs, endMs);
      if (to <= from) return;
      if (!Number.isFinite(p.v)) {
        partial = true;
        return;
      }
      sampled = true;
      kwh += (Math.max(0, p.v * factor - baselineW) * (to - from)) / 3.6e9;
    });
  } else {
    let last = null;
    for (const p of pts) {
      if (!Number.isFinite(p.v)) {
        if (p.t > startMs) partial = true;
        continue;
      }
      const v = p.v * factor;
      if (last != null) {
        if (v >= last) kwh += v - last;
        else partial = true;
      }
      sampled = true;
      last = v;
    }
  }
  if (!sampled) return null;
  return { kwh, quality: partial ? "partial" : "complete" };
}

/** " · power offset 85 W removed" / " · no offset found" for a meter result. */
function baselineLabel({ baselineW } = {}) {
  if (baselineW === undefined) return "";
  return Number.isFinite(baselineW)
    ? ` · power offset ${Math.round(baselineW)} W removed`
    : " · no power offset found (full meter reading)";
}

/** Raw [{t, s}] states of one entity from a recorder history response. */
function historyStates(raw, entityId) {
  const list = raw?.[entityId];
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => typeof item.s !== "undefined"
      ? { t: Number(item.lu) > 1e12 ? Number(item.lu) : Number(item.lu) * 1000, s: String(item.s) }
      : { t: new Date(item.last_changed || item.last_updated).getTime(), s: String(item.state) })
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
}

/**
 * Off stretches shorter than this are not a power cycle: a Home Assistant
 * restart or Wi-Fi drop also shows the printer `offline`, and a meter may not
 * have reported the drop yet after a quick plug toggle.
 */
const POWER_OFF_MIN_MS = 5 * 60000;
/** Preparation before the printer's job start time still counts towards the job. */
const JOB_PREP_MAX_MS = 30 * 60000;

/**
 * Last power-on after at least `minOffMs` off, as {off, on} (when that off
 * stretch began and ended), or null. `isOff` tells an off state; unavailable /
 * unknown states (HA starting, device unreachable) neither start nor end one.
 */
function lastPowerOn(states, isOff, minOffMs = POWER_OFF_MIN_MS) {
  let offSince = null;
  let found = null;
  for (const { t, s } of states) {
    if (isMissingState(s)) continue;
    if (isOff(s)) {
      offSince ??= t;
    } else {
      if (offSince != null && t - offSince >= minOffMs) found = { off: offSince, on: t };
      offSince = null;
    }
  }
  return found;
}

/**
 * Start of the active stretch (processing, printing, paused…) of the print
 * status that is in effect at `atMs`, or null when the status is not active then.
 */
function activeSince(states, atMs) {
  let i = states.findLastIndex((p) => p.t <= atMs);
  if (i < 0 || !ACTIVE_STATUSES.includes(states[i].s.toLowerCase())) return null;
  while (i > 0 && ACTIVE_STATUSES.includes(states[i - 1].s.toLowerCase())) i--;
  return states[i].t;
}

function newPrintId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseHistorySeries(raw, entityId) {
  const points = [];
  if (!raw || !entityId) return points;

  let series = raw[entityId];
  if (!series && Array.isArray(raw)) {
    series = raw.find((item) => item?.[0]?.entity_id === entityId) || raw.find(Array.isArray);
  }
  const list = Array.isArray(series) ? series : series?.states;
  if (!Array.isArray(list)) return points;

  for (const item of list) {
    if (item == null) continue;
    if (typeof item.s !== "undefined") {
      const t = Number(item.lu);
      points.push({
        t: t > 1e12 ? t : t * 1000,
        v: parseFloat(item.s),
      });
    } else if (item.state != null) {
      points.push({
        t: new Date(item.last_changed || item.last_updated).getTime(),
        v: parseFloat(item.state),
      });
    }
  }
  // Non-numeric states (unavailable/unknown) stay as NaN gap markers so the
  // chart breaks the line instead of bridging an offline period.
  return points.filter((p) => Number.isFinite(p.t));
}

// Extra frontend modules can load before HA installs its custom-element
// registry polyfill. Wait before both subclassing HTMLElement and registering
// the card so they use the same registry/constructor as the dashboard.
await customElements.whenDefined("home-assistant");

class CrealityCard extends HTMLElement {
  constructor() {
    super();
    this._root = this.attachShadow({ mode: "open" });
    this._samples = [];
    this._history = {};
    this._prints = [];
    this._printPrefs = {
      filamentType: "PLA",
      costPerKg: "",
      costPerKwh: "",
      diameterMm: 1.75,
      currency: "€",
      lastCostByType: {},
    };
    this._editingId = null;
    this._usingLocalPrints = false;
    this._printsLoaded = false;
    this._lastJobDraft = null;
    this._completedJob = null;
    this._savedJobFingerprint = "";
    this._formPreview = "";
    this._previewCaptureBusy = false;
    this._previewAttempt = null;
    this._deletedIds = [];
    this._lastStates = {};
  }

  /** Marks the card served by the integration (vs. the deprecated standalone card). */
  static get bundledCreality() {
    return true;
  }

  static getStubConfig(hass, entities, entitiesFallback) {
    return integrationDefaults(hass, entities, entitiesFallback);
  }

  static getConfigForm() {
    return {
      schema: [
        { name: "title", selector: { text: {} } },
        {
          name: "print_group",
          type: "expandable",
          flatten: true,
          title: "Printing information",
          schema: ["status", "progress", "preview", "object", "layer", "total_layers", "job_time", "time_left", "used_material", "filament"].map(
            (name) => ({
              name,
              selector: { entity: { domain: name === "preview" ? "image" : "sensor" } },
            })
          ),
        },
        {
          name: "layout_group",
          type: "expandable",
          flatten: true,
          title: "Camera & layout",
          schema: [
            { name: "camera", selector: { entity: { domain: "camera" } } },
            {
              name: "camera_aspect",
              selector: {
                select: {
                  mode: "dropdown",
                  options: [
                    { value: "21:9", label: "Short (21:9)" },
                    { value: "16:9", label: "Wide (16:9, default)" },
                    { value: "4:3", label: "Standard (4:3)" },
                    { value: "1:1", label: "Tall (1:1)" },
                  ],
                },
              },
            },
            {
              name: "hide_tiles",
              selector: {
                select: {
                  multiple: true,
                  mode: "list",
                  options: [
                    { value: "profile", label: "2D G-code view" },
                    { value: "preview", label: "Printer preview" },
                  ],
                },
              },
            },
          ],
        },
        {
          name: "power_group",
          type: "expandable",
          flatten: true,
          title: "Power / energy",
          schema: [
            { name: "print_energy", selector: { entity: { domain: "sensor" } } },
            { name: "printer_switch", selector: { entity: { domain: "switch" } } },
          ],
        },
        {
          name: "print_actions_group",
          type: "expandable",
          flatten: true,
          title: "Print actions (camera status bar)",
          schema: [
            { name: "pause", selector: { entity: { domain: "button" } } },
            { name: "resume", selector: { entity: { domain: "button" } } },
            { name: "stop", selector: { entity: { domain: "button" } } },
          ],
        },
        {
          name: "control_group",
          type: "expandable",
          flatten: true,
          title: "Controls",
          schema: [
            { name: "home", selector: { entity: { domain: "button" } } },
            { name: "print_tuning", selector: { entity: { domain: "number" } } },
            { name: "flow_tuning", selector: { entity: { domain: "number" } } },
            { name: "print_speed", selector: { entity: { domain: "sensor" } } },
            { name: "model_fan", selector: { entity: { domain: "fan" } } },
            { name: "case_fan", selector: { entity: { domain: "fan" } } },
            { name: "side_fan", selector: { entity: { domain: "fan" } } },
            {
              name: "filament_change_temp",
              selector: { number: { min: 150, max: 350, step: 1, mode: "box", unit_of_measurement: "°C" } },
            },
            { name: "position_x", selector: { entity: { domain: "sensor" } } },
            { name: "position_y", selector: { entity: { domain: "sensor" } } },
            { name: "position_z", selector: { entity: { domain: "sensor" } } },
          ],
        },
        {
          name: "temp_group",
          type: "expandable",
          flatten: true,
          title: "Temperature",
          schema: [
            { name: "nozzle", selector: { entity: { domain: "sensor" } } },
            { name: "nozzle_target", selector: { entity: { domain: "number" } } },
            { name: "bed", selector: { entity: { domain: "sensor" } } },
            { name: "bed_target", selector: { entity: { domain: "number" } } },
          ],
        },
      ],
      computeLabel: (schema) => LABELS[schema.name] || undefined,
      computeHelper: (schema) => HELPERS[schema.name] || undefined,
    };
  }

  setConfig(config) {
    const nested = config.entities && typeof config.entities === "object" ? config.entities : {};
    this._cfg = {
      title: "Creality Printer",
      ...nested,
      ...config,
    };
    delete this._cfg.entities;
    this._built = false;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) {
      this._render();
      return;
    }
    // HA calls setConfig() before the first hass, so the build could only read local storage.
    if (!this._printsLoaded && hass?.callWS) this._loadPrints();
    if (!this._tlSettingsLoaded && hass?.callWS) this._loadTimelapseSettings();
    // HA replaces `hass` on every state change anywhere; skip unrelated updates.
    if (!this._watchedChanged(hass)) return;
    this._update();
  }

  /** Entity IDs referenced by the card config. */
  _watchedIds() {
    return Object.entries(this._cfg || {})
      .filter(([key, value]) => key !== "title" && typeof value === "string" && /^[a-z_]+\.[^\s]+$/.test(value))
      .map(([, value]) => value);
  }

  _watchedChanged(hass) {
    const states = hass?.states || {};
    let changed = false;
    const next = {};
    for (const id of this._watchedIds()) {
      next[id] = states[id];
      if (this._lastStates[id] !== states[id]) changed = true;
    }
    if (Object.keys(this._lastStates).length !== Object.keys(next).length) changed = true;
    this._lastStates = next;
    return changed;
  }

  get hass() {
    return this._hass;
  }

  getCardSize() {
    return 16;
  }

  getGridOptions() {
    return {
      columns: "full",
      rows: "auto",
      min_rows: 6,
      min_columns: 6,
    };
  }

  connectedCallback() {
    if (this._cfg && this._hass && !this._built) this._render();
    else if (this._built) {
      this._startHistoryTimer();
      this._syncProfile();
    }
  }

  _startHistoryTimer() {
    if (this._histTimer) return;
    this._loadHistory();
    this._histTimer = setInterval(() => this._loadHistory(), 20000);
  }

  disconnectedCallback() {
    clearInterval(this._histTimer);
    this._histTimer = undefined;
    // Forget the job so reattaching fetches again instead of polling while detached.
    clearTimeout(this._profileTimer);
    this._profileTimer = undefined;
    this._profileKey = undefined;
    this._resetTimelapse();
    this._resetDetailTimelapse();
  }

  /** Printer-reported error or warning (`err.key`), described by the integration's error DB. */
  _syncPrinterAlert() {
    const el = this._root.getElementById("printer-alert");
    if (!el) return;
    const attrs = this._st("status")?.attributes;
    const alert = printerAlert(attrs);
    let dismissed = this._loadDismissedAlert();
    // Forget a dismissal only once the printer explicitly reports no error, so the
    // same warning shows again when it recurs (a reconnect without `err` keeps it).
    if (!alert && dismissed && attrs?.err && typeof attrs.err === "object" && !Number(attrs.err.key)) {
      this._saveDismissedAlert(null);
      dismissed = null;
    }
    el.hidden = !alert || alert.id === dismissed;
    if (el.hidden) return;
    el.dataset.alertId = alert.id;
    el.classList.toggle("is-error", alert.severity === "error");
    this._root.getElementById("printer-alert-icon")?.setAttribute(
      "icon", alert.severity === "error" ? "mdi:alert-octagon" : "mdi:alert");
    this._setText("printer-alert-title", alert.title);
    this._setText("printer-alert-detail", alert.detail);
  }

  _dismissPrinterAlert() {
    const id = this._root.getElementById("printer-alert")?.dataset.alertId;
    if (!id) return;
    this._saveDismissedAlert(id);
    this._syncPrinterAlert();
  }

  _dismissedAlertStorageKey() {
    return `creality-card.alert-dismissed.${this._cfg?.status || "default"}`;
  }

  /** `key|value` of the printer alert the user closed (kept across reloads), or null. */
  _loadDismissedAlert() {
    try {
      return localStorage.getItem(this._dismissedAlertStorageKey());
    } catch (_err) {
      return null;
    }
  }

  _saveDismissedAlert(id) {
    try {
      if (id) localStorage.setItem(this._dismissedAlertStorageKey(), id);
      else localStorage.removeItem(this._dismissedAlertStorageKey());
    } catch (_err) {
      /* ignore quota / private mode */
    }
  }

  /** Filament runout banner, with a button that heats the nozzle for a filament swap. */
  _syncFilamentAlert() {
    const el = this._root.getElementById("filament-alert");
    if (!el) return;
    const runout = isFilamentRunout(this._st("filament"));
    // A closed runout banner stays closed until this runout ends (not remembered across reloads).
    if (!runout) this._filamentAlertDismissed = false;
    el.hidden = !runout || Boolean(this._filamentAlertDismissed);
    const temp = this._filamentChangeTemp();
    const target = parseFloat(this._val("nozzle_target"));
    const heating = Number.isFinite(target) && target >= temp;
    const button = this._root.getElementById("filament-heat");
    if (button) {
      button.hidden = el.hidden || !this._cfg.nozzle_target;
      button.disabled = heating || Boolean(this._heatBusy);
      button.textContent = heating
        ? `Nozzle set to ${Math.round(target)} °C`
        : `Heat nozzle to ${temp} °C`;
    }
    // "Replace filament" in Controls: same action, available at any time.
    const replace = this._root.getElementById("filament-change");
    if (replace) {
      replace.hidden = !this._cfg.nozzle_target;
      replace.disabled = heating || Boolean(this._heatBusy);
      replace.title = heating
        ? `Nozzle set to ${Math.round(target)} °C`
        : `Set the nozzle target to ${temp} °C`;
    }
  }

  /** Nozzle target for a filament swap: card option, else 240 °C. */
  _filamentChangeTemp() {
    const temp = parseFloat(this._cfg.filament_change_temp);
    return Number.isFinite(temp) && temp > 0 ? temp : FILAMENT_CHANGE_TEMP;
  }

  async _heatForFilamentChange() {
    if (this._heatBusy || !this._cfg.nozzle_target) return;
    this._heatBusy = true;
    this._syncFilamentAlert();
    try {
      await this._setNumber(this._cfg.nozzle_target, this._filamentChangeTemp());
    } finally {
      this._heatBusy = false;
      this._syncFilamentAlert();
    }
  }

  /** Real / Creality time boxes and the finish clock next to the percentage. */
  _syncTimings(status) {
    const stLower = String(status).toLowerCase();
    const jobActive = ACTIVE_STATUSES.includes(stLower);
    const jobDone = stLower === "completed";
    const elapsedSec = parseDurationSeconds(this._val("job_time"));
    const crealityLeftSec = parseDurationSeconds(this._val("time_left"));

    const realLabel = fmtDuration(elapsedSec ?? this._val("job_time"));
    let crealityLabel = "—";
    if (jobDone) crealityLabel = "0s";
    else if (jobActive) {
      crealityLabel = crealityLeftSec != null ? fmtDuration(crealityLeftSec) : fmtDuration(this._val("time_left"));
    }
    // Finish clock time from the printer's live remaining time.
    const leftSec = jobActive ? crealityLeftSec : null;
    let etaText = "";
    if (jobDone) etaText = "Done";
    else if (leftSec != null) {
      const at = new Date(Date.now() + leftSec * 1000);
      etaText = `${fmtDuration(leftSec)} left · ETA ${fmtClock(at, this._hass?.locale)}`;
    }
    this._setText("progress-eta", etaText);
    this._setText("time-real", realLabel);
    this._setText("time-creality", crealityLabel);
  }

  /**
   * No job: idle (the printer keeps the last file loaded after a print), or no
   * file and nothing printing. Job details are hidden; tiles show a placeholder.
   */
  _noJob(status = this._val("status", "")) {
    const st = this._st("status");
    if (!st) return false;
    return isIdleStatus(status) || (!st.attributes?.file && !ACTIVE_STATUSES.includes(String(status).toLowerCase()));
  }

  _st(key) {
    const id = this._cfg?.[key];
    if (!id || !this._hass) return undefined;
    return this._hass.states[id];
  }

  _val(key, fallback = "") {
    const st = this._st(key);
    if (!st || st.state === "unavailable" || st.state === "unknown") return fallback;
    return st.state;
  }

  _token(entityId) {
    return this._hass?.states?.[entityId]?.attributes?.access_token || "";
  }

  _picture(entityId, stream = false) {
    const st = this._hass?.states?.[entityId];
    if (!st) return "";
    if (entityId.startsWith("image.")) {
      if (isMissingState(st.state)) return "";
      const url = st.attributes.entity_picture || (st.attributes.access_token
        ? `/api/image_proxy/${entityId}?token=${st.attributes.access_token}` : "");
      // HA's image proxy URL is stable; refresh the browser when the image changes.
      return url ? `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(st.state)}` : "";
    }
    if (stream && entityId.startsWith("camera.")) {
      const token = st.attributes.access_token;
      return token ? `/api/camera_proxy_stream/${entityId}?token=${token}` : "";
    }
    if (st.attributes.entity_picture) return st.attributes.entity_picture;
    const token = st.attributes.access_token;
    if (entityId.startsWith("camera.") && token) {
      return `/api/camera_proxy/${entityId}?token=${token}`;
    }
    return "";
  }

  _moreInfo(entityId) {
    if (!entityId) return;
    this.dispatchEvent(
      new CustomEvent("hass-more-info", {
        detail: { entityId },
        bubbles: true,
        composed: true,
      })
    );
  }

  _confirmPress(entityId, message) {
    if (!entityId) return;
    if (confirm(message)) this._press(entityId);
  }

  _notify(message) {
    this.dispatchEvent(new CustomEvent("hass-notification", { detail: { message }, bubbles: true, composed: true }));
  }

  /** Show a failed action as an HA toast instead of an unhandled rejection. */
  _notifyError(message, error) {
    console.warn(`Creality card: ${message}`, error);
    const detail = error?.message ? `${message}: ${error.message}` : message;
    this.dispatchEvent(new CustomEvent("hass-notification", {
      detail: { message: detail },
      bubbles: true,
      composed: true,
    }));
  }

  async _callService(domain, service, data, failure) {
    try {
      await this._hass.callService(domain, service, data);
    } catch (error) {
      this._notifyError(failure, error);
    }
  }

  async _press(entityId) {
    if (!this._hass || !entityId) return;
    const domain = entityId.split(".")[0];
    if (domain === "button" || domain === "input_button") {
      await this._callService(domain, "press", { entity_id: entityId }, "Printer command failed");
    } else {
      await this._callService("homeassistant", "turn_on", { entity_id: entityId }, "Printer command failed");
    }
  }

  async _togglePrinterPower() {
    const entityId = this._cfg?.printer_switch;
    const state = this._st("printer_switch")?.state;
    if (!entityId?.startsWith("switch.") || state !== "off" || this._powerBusy || this._waitingForPrinter) return;
    this._waitingForPrinter = true;
    this._powerOnObserved = false;
    this._powerStartStatus = this._st("status");
    this._powerBusy = true;
    this._setText("printer-power-error", "");
    this._update();
    try {
      await this._hass.callService("switch", "turn_on", { entity_id: entityId });
    } catch (error) {
      this._waitingForPrinter = false;
      this._setText("printer-power-error", "Unable to switch printer power. Please try again.");
    } finally {
      this._powerBusy = false;
      this._update();
    }
  }

  _updateOffline() {
    const state = this._st("status")?.state;
    const powerState = this._st("printer_switch")?.state;
    const disconnected = Boolean(this._cfg.status) &&
      (this._st("status")?.attributes?.connected === false ||
        isMissingState(state) || String(state).toLowerCase() === "offline");
    if (this._waitingForPrinter) {
      if (powerState === "on") this._powerOnObserved = true;
      const responded = Boolean(this._cfg.status) && !disconnected &&
        this._st("status") !== this._powerStartStatus;
      if (!this._cfg.printer_switch || (this._powerOnObserved && powerState === "off") ||
          (powerState === "on" && responded)) this._waitingForPrinter = false;
    }
    const waiting = Boolean(this._waitingForPrinter);
    const offline = Boolean(this._cfg.printer_switch) && (waiting || powerState === "off" || disconnected);
    this._setText("offline-message", waiting ? "Waiting for printer…" : "Printer is offline.");
    const spinner = this._root.getElementById("printer-loading");
    if (spinner) spinner.hidden = !waiting;
    this._root.querySelector(".wrap").classList.toggle("offline", offline);
    this._root.getElementById("offline-notice").hidden = !offline;
    const button = this._root.getElementById("printer-power");
    // Power-on only: turning the printer off is left to the switch itself.
    button.hidden = !this._cfg.printer_switch || powerState === "on";
    button.disabled = this._powerBusy || waiting || powerState !== "off";
    button.textContent = "Turn on printer";
    if (offline) {
      // Stop the live stream while the printer is unreachable.
      this._root.getElementById("camera")?.querySelector("img, .camera-live")?.remove();
      this._closeCameraZoom();
    }
    return offline;
  }

  async _toggleFan(entityId) {
    if (!this._hass || !entityId) return;
    const st = this._hass.states[entityId];
    const service = isOn(st) ? "turn_off" : "turn_on";
    await this._callService("fan", service, { entity_id: entityId }, "Fan command failed");
  }

  async _setNumber(entityId, value) {
    if (!this._hass || !entityId) return;
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    await this._callService("number", "set_value", { entity_id: entityId, value: n }, "Setting value failed");
  }

  _render() {
    if (!this._cfg) return;

    this._root.innerHTML = `
      <ha-card>
        <style>
          :host {
            display: block;
            container-type: inline-size;
            container-name: creality;
          }
          ha-card {
            /* Follow the active HA theme; fallbacks reproduce the Creality dark UI. */
            --cp-bg: var(--ha-card-background, var(--card-background-color, #1b1b1b));
            --cp-panel: var(--secondary-background-color, #2a2a2a);
            --cp-border: var(--divider-color, #3c3c3c);
            --cp-text: var(--primary-text-color, #f2f2f2);
            --cp-muted: var(--secondary-text-color, #9a9a9a);
            --cp-input: var(--input-fill-color, var(--card-background-color, #1f1f1f));
            --cp-inset: var(--primary-background-color, #141414);
            --cp-accent: var(--creality-accent-color, #2dce89);
            --cp-nozzle: #e85d4c;
            --cp-bed: #4b9fff;
            background: var(--cp-bg);
            color: var(--cp-text);
            border: 1px solid var(--cp-border);
            overflow: hidden;
            position: relative;
          }
          .wrap { padding: 12px; display: flex; flex-direction: column; gap: 12px; }
          .title {
            font-size: 16px;
            font-weight: 600;
            margin: 0 4px;
          }
          .layout {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
            gap: 12px;
          }
          .panel-log { width: 100%; min-width: 0; }
          .panel-print { grid-column: 1 / -1; }
          @container creality (max-width: 800px) {
            .layout { grid-template-columns: 1fr; }
          }
          .col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
          .panel {
            background: var(--cp-panel);
            border: 1px solid var(--cp-border);
            border-radius: 10px;
            overflow: hidden;
            min-width: 0;
          }
          .panel-h {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 10px 12px;
            border-bottom: 1px solid var(--cp-border);
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            user-select: none;
          }
          .panel-h:hover { background: rgba(127, 127, 127, 0.08); }
          .panel-title {
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
            flex: 1;
          }
          .panel-h .chevron {
            --mdc-icon-size: 18px;
            color: var(--cp-muted);
            flex: none;
            transform: rotate(180deg);
            transition: transform 0.15s ease;
          }
          .panel.is-collapsed .chevron { transform: none; }
          .panel.is-collapsed .panel-h { border-bottom: none; }
          .panel.is-collapsed .panel-b { display: none; }
          .panel-b { padding: 12px; }
          .badge {
            font-size: 11px;
            font-weight: 600;
            padding: 3px 10px;
            border-radius: 999px;
            background: #4a4a4a;
            color: #fff;
          }
          .badge.is-print { background: var(--cp-accent); color: #083322; }
          .badge.is-pause { background: #fc6d09; }
          .badge.is-error { background: #e5484d; }
          .badge.is-idle { background: #5c5c5c; }
          /* Row 1: camera (2 units), G-code profile (1) and printer thumbnail (1).
             Tiles whose entity is not configured are removed and the rest share the row. */
          .media-row {
            display: grid;
            grid-template-columns: repeat(var(--media-cols, 4), minmax(0, 1fr));
            gap: 12px;
            margin-bottom: 12px;
          }
          .media-row[hidden], .tile[hidden] { display: none; }
          .tile { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
          .tile > .thumb { flex: 1 1 auto; min-height: 0; }
          .tile-camera { grid-column: span 2; }
          .media-row:not(.has-camera) .tile { aspect-ratio: 1; max-height: 360px; }
          /* No job: one placeholder tile in place of profile + thumbnail. */
          .tile-wide { grid-column: span 2; }
          .media-row:not(.has-camera) .tile.tile-wide { aspect-ratio: 2; }
          @container creality (max-width: 600px) {
            .media-row { grid-template-columns: repeat(var(--media-cols-narrow, 2), minmax(0, 1fr)); }
            .tile-camera { grid-column: 1 / -1; }
            .tile:not(.tile-camera) { aspect-ratio: 1; }
            .tile.tile-wide { aspect-ratio: 2; }
          }
          .tile-camera { --cam-ar: 16 / 9; }
          .tile-camera.ar-4-3 { --cam-ar: 4 / 3; }
          .tile-camera.ar-1-1 { --cam-ar: 1 / 1; }
          .tile-camera.ar-21-9 { --cam-ar: 21 / 9; }
          /* Status bar over the bottom of the camera; a plain strip in row 2 without one. */
          .cam-bar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 6px 8px;
            color: #fff;
            font-size: 12px;
          }
          .cam-bar[hidden] { display: none; }
          .tile-camera .cam-bar {
            position: absolute;
            left: 1px;
            right: 1px;
            bottom: 1px;
            border-radius: 0 0 7px 7px;
            background: linear-gradient(transparent, #000c 40%);
            padding-top: 14px;
          }
          .bar-slot .cam-bar {
            background: var(--cp-inset);
            border: 1px solid var(--cp-border);
            border-radius: 8px;
            color: var(--cp-text);
          }
          .bar-slot:empty { display: none; }
          .cam-bar-status, .cam-bar-acts { display: flex; align-items: center; gap: 6px; min-width: 0; }
          .cam-pct { font-size: 13px; font-variant-numeric: tabular-nums; }
          .cam-layer { opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .ring { width: 22px; height: 22px; flex: 0 0 auto; transform: rotate(-90deg); }
          .ring[hidden] { display: none; }
          .ring circle { fill: none; stroke-width: 4; }
          .ring-bg { stroke: #ffffff33; }
          .bar-slot .ring-bg { stroke: var(--cp-border); }
          .ring-fg { stroke: var(--cp-accent); stroke-dasharray: 0 100; stroke-linecap: round; }
          .ring.paused .ring-fg { stroke: #fc6d09; }
          .cam-pct[hidden], .ring[hidden], .cam-layer[hidden], .badge[hidden], .bar-btn[hidden] { display: none; }
          .bar-btn {
            width: 32px;
            height: 30px;
            display: flex;
            align-items: center;
            justify-content: center;
            border: 1px solid #ffffff40;
            border-radius: 8px;
            background: #0006;
            color: inherit;
            cursor: pointer;
            padding: 0;
          }
          .bar-slot .bar-btn { border-color: var(--cp-border); background: var(--cp-input); }
          .bar-btn:hover, .bar-btn:focus-visible { border-color: var(--cp-accent); outline: none; }
          .bar-btn.stop:hover { border-color: #e5484d; color: #e5484d; }
          .bar-btn[disabled] { opacity: 0.35; cursor: default; }
          .bar-btn ha-icon { --mdc-icon-size: 18px; }
          .panel-print:not(.is-collapsed) #status-badge { display: none; }
          .thumb {
            background: var(--cp-inset);
            border: 1px solid var(--cp-border);
            border-radius: 8px;
            min-height: 110px;
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
          }
          .thumb img { width: 100%; height: 100%; object-fit: contain; display: block; }
          #preview { flex-direction: column; }
          /* The fit box keeps the image's aspect ratio so the overlay matches the drawn thumbnail. */
          .layer-stage { display: flex; width: 100%; flex: 1 1 0; min-height: 0; container-type: size; }
          .layer-fit { position: relative; margin: auto; height: min(100cqh, calc(100cqw / var(--ar, 1))); aspect-ratio: var(--ar, 1); }
          .layer-fit img { position: absolute; inset: 0; }
          .layer-overlay { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
          .layer-overlay[hidden], .layer-caption[hidden] { display: none; }
          .layer-remaining { position: absolute; inset: 0 0 auto; height: calc(100% - var(--layer-progress)); background: #080a0bd4; }
          .layer-printed { position: absolute; inset: auto 0 0; height: var(--layer-progress); background: #65d6a51a; }
          .layer-line { position: absolute; left: 0; right: 0; bottom: clamp(1px, var(--layer-progress), calc(100% - 2px)); height: 2px; background: var(--cp-accent); box-shadow: 0 0 8px var(--cp-accent); }
          .layer-overlay.paused .layer-line { background: #ffb34d; box-shadow: 0 0 6px #ffb34d; }
          .layer-caption { width: 100%; box-sizing: border-box; padding: 6px 4px; font-size: 10px; line-height: 1.4; text-align: center; color: var(--cp-text); background: var(--cp-inset); }
          .layer-caption small { display: block; color: var(--cp-muted); font-size: 9px; }
          .thumb.empty { color: var(--cp-muted); font-size: 12px; }
          .thumb[hidden] { display: none; }
          .profile { flex-direction: column; padding: 0; color: inherit; font: inherit; width: 100%; }
          .profile:hover, .profile:focus-visible { border-color: var(--cp-accent); outline: none; }
          .profile-stage { display: block; width: 100%; box-sizing: border-box; padding: 10px; flex: 1 1 0; min-height: 0; }
          .profile svg { width: 100%; height: 100%; display: block; overflow: visible; }
          .thumb.empty { text-align: center; padding: 8px; box-sizing: border-box; cursor: default; }
          .meta { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
          .progress-head { display: flex; align-items: baseline; justify-content: space-between; gap: 4px 16px; flex-wrap: wrap; }
          .progress-head[hidden], .coord[hidden], .coords[hidden], .fan-row[hidden], .ctrl-row[hidden], .field[hidden], .icon-btn[hidden], .panel[hidden] { display: none; }
          .big-pct { font-size: 30px; line-height: 1; font-weight: 700; font-variant-numeric: tabular-nums; }
          .big-pct[hidden] { display: none; }
          .progress-eta { font-size: 14px; color: var(--cp-muted); font-variant-numeric: tabular-nums; }
          .progress-eta b { color: var(--cp-text); }
          .meta-head[hidden] { display: none; }
          .meta-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 16px; }
          .meta-head .kv { min-width: 0; overflow-wrap: anywhere; }
          .kv[hidden], .bar[hidden], .times[hidden], .timing-row[hidden] { display: none; }
          .kv { font-size: 13px; color: var(--cp-muted); }
          .kv b { color: var(--cp-text); font-weight: 600; }
          .bar {
            height: 10px;
            background: var(--cp-inset);
            border-radius: 99px;
            overflow: hidden;
          }
          .bar > span {
            display: block;
            height: 100%;
            width: 0%;
            background: var(--cp-accent);
          }
          .times { font-size: 12px; color: var(--cp-muted); }
          .power-now { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-top: 4px; }
          .baseline-field { display: inline-flex; align-items: center; gap: 6px; }
          .baseline-field input {
            width: 64px;
            background: var(--cp-input);
            color: var(--cp-text);
            border: 1px solid var(--cp-border);
            border-radius: 6px;
            padding: 3px 6px;
            font: inherit;
          }
          .timing-row {
            display: grid;
            grid-auto-flow: column;
            grid-auto-columns: minmax(0, 1fr);
            gap: 6px;
          }
          .timing[hidden] { display: none; }
          .timing {
            background: var(--cp-inset);
            border: 1px solid var(--cp-border);
            border-radius: 8px;
            padding: 6px 8px;
            min-width: 0;
          }
          .timing span {
            display: block;
            font-size: 10px;
            color: var(--cp-muted);
            text-transform: uppercase;
            letter-spacing: 0.03em;
            margin-bottom: 2px;
          }
          .timing b {
            display: block;
            font-size: 13px;
            font-weight: 650;
            font-variant-numeric: tabular-nums;
            color: var(--cp-text);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .coords {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 8px;
          }
          .coord {
            background: var(--cp-input);
            border: 1px solid var(--cp-border);
            border-radius: 8px;
            padding: 8px;
          }
          .coord span { display: block; font-size: 11px; color: var(--cp-muted); }
          .coord b { font-size: 18px; font-variant-numeric: tabular-nums; }
          .icon-btn, .act {
            border: 1px solid var(--cp-border);
            background: var(--cp-input);
            color: var(--cp-text);
            border-radius: 8px;
            cursor: pointer;
            font: inherit;
          }
          .icon-btn {
            width: 40px;
            height: 34px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
          }
          .icon-btn:hover, .act:hover { border-color: var(--cp-accent); }
          .icon-btn ha-icon, .act ha-icon { --mdc-icon-size: 20px; }
          .ctrl-row, .fan-row {
            display: flex;
            flex-wrap: wrap;
            gap: 10px 16px;
            align-items: center;
          }
          .ctrl-row, .fan-row { margin-bottom: 12px; }
          .ctrl-row .act { flex: 0 0 auto; min-height: 34px; padding: 6px 12px; }
          .field {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13px;
            color: var(--cp-muted);
          }
          .field input {
            width: 72px;
            background: var(--cp-input);
            color: var(--cp-text);
            border: 1px solid var(--cp-border);
            border-radius: 6px;
            padding: 6px 8px;
            font: inherit;
          }
          .switch {
            width: 38px;
            height: 20px;
            border-radius: 99px;
            background: #444;
            position: relative;
            cursor: pointer;
            border: 0;
            padding: 0;
          }
          .switch.on { background: var(--cp-accent); }
          .switch i {
            position: absolute;
            top: 2px;
            left: 2px;
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: #fff;
            transition: left 0.15s;
          }
          .switch.on i { left: 20px; }
          .acts { display: flex; gap: 8px; }
          .act {
            flex: 1;
            padding: 8px 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            font-size: 12px;
            font-weight: 600;
          }
          .act[disabled] { opacity: 0.35; cursor: default; }
          .act[hidden] { display: none; }
          .act.stop:hover { border-color: #e5484d; color: #e5484d; }
          .camera-body {
            flex: 1 1 auto;
            aspect-ratio: var(--cam-ar, 16 / 9);
            background: var(--cp-inset);
            border: 1px solid var(--cp-border);
            border-radius: 8px;
            overflow: hidden;
            cursor: pointer;
          }
          /* Streaming (WebRTC) cameras embed HA's own live view and size to the video. */
          .camera-body:has(.camera-live) { aspect-ratio: auto; }
          .camera-zoom {
            width: min(96vw, calc((90vh - 96px) * 16 / 9), 1600px);
            max-width: 96vw;
            padding: 0;
            border: 1px solid var(--cp-border);
            border-radius: 12px;
            background: var(--cp-bg);
            color: var(--cp-text);
            overflow: hidden;
          }
          .camera-zoom::backdrop { background: #000c; }
          .camera-zoom-h {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 8px 8px 8px 14px;
            font-size: 14px;
            font-weight: 600;
          }
          .camera-zoom-acts { display: flex; gap: 6px; }
          .camera-zoom-body { background: #000; }
          .camera-zoom-body img { width: 100%; max-height: calc(90vh - 96px); object-fit: contain; display: block; }
          .camera-zoom-body:fullscreen { display: flex; align-items: center; justify-content: center; }
          .camera-zoom-body:fullscreen img, .camera-zoom-body:fullscreen .camera-live { width: 100%; max-height: 100vh; }
          .camera-zoom-f { padding: 8px 14px; font-size: 13px; color: var(--cp-muted); font-variant-numeric: tabular-nums; }
          .camera-zoom-f:empty { display: none; }
          .camera-zoom-body .empty { padding: 48px; text-align: center; color: var(--cp-muted); }
          .tl-dialog {
            width: min(92vw, 460px);
            padding: 16px;
            border: 1px solid var(--cp-border);
            border-radius: 12px;
            background: var(--cp-bg);
            color: var(--cp-text);
          }
          .tl-dialog::backdrop { background: #0009; }
          .tl-dialog h3 { margin: 0 0 8px; font-size: 15px; }
          .tl-file { margin: 0 0 12px; font-size: 13px; color: var(--cp-muted); overflow-wrap: anywhere; }
          .tl-choices { display: flex; flex-direction: column; gap: 8px; }
          .tl-choices .act { min-height: 44px; justify-content: flex-start; padding: 8px 12px; font-size: 13px; }
          .tl-choices .act span { overflow-wrap: anywhere; text-align: left; }
          .tl-suggest { display: flex; flex-wrap: wrap; gap: 6px; }
          .tl-suggest:empty { display: none; }
          .tl-suggest .act { flex: 0 1 auto; padding: 4px 8px; font-weight: 500; }
          .tl-suggest .act.on { border-color: var(--cp-accent); color: var(--cp-accent); }
          .form label.tl-check { flex-direction: row; align-items: center; gap: 8px; font-size: 13px; color: var(--cp-text); }
          .tl-line {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 10px;
            font-size: 12px;
            color: var(--cp-muted);
          }
          .tl-line[hidden] { display: none; }
          .tl-line span { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
          .tl-line .act { flex: 0 0 auto; }
          .camera-live {
            display: block;
            --ha-card-border-width: 0;
            --ha-card-border-radius: 0;
            --ha-card-box-shadow: none;
            --ha-card-background: transparent;
          }
          .camera-body img, .camera-body ha-camera-stream {
            width: 100%;
            height: 100%;
            object-fit: cover;
            display: block;
          }
          .camera-body .empty {
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--cp-muted);
            font-size: 13px;
          }
          table.temps {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
          }
          table.temps th {
            color: var(--cp-muted);
            font-weight: 500;
            text-align: left;
            padding: 0 8px 8px;
          }
          table.temps td {
            padding: 8px;
            border-top: 1px solid var(--cp-border);
            font-variant-numeric: tabular-nums;
          }
          .dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            display: inline-block;
            margin-right: 8px;
          }
          .dot.nozzle { background: var(--cp-nozzle); }
          .dot.bed { background: var(--cp-bed); }
          table.temps input {
            width: 72px;
            background: var(--cp-input);
            color: var(--cp-text);
            border: 1px solid var(--cp-border);
            border-radius: 6px;
            padding: 5px 8px;
            font: inherit;
          }
          .chart {
            height: 120px;
            width: 100%;
            min-width: 0;
            flex: 1 1 auto;
            display: block;
          }
          .temp-viz { display: flex; gap: 10px; margin-top: 12px; align-items: stretch; }
          .profile .printed { fill: var(--cp-accent); }
          .profile .remaining { fill: var(--cp-muted); opacity: .35; }
          .profile .cursor { stroke: var(--cp-accent); stroke-width: 1.5; }
          .profile.paused .cursor { stroke: #ffb34d; }
          .completion {
            position: relative; border-radius: 20px; padding: 18px 20px;
            border: 1px solid #529b78; background: #19342c; color: #f1fff6;
            box-shadow: 0 6px 20px #0002; margin-bottom: 8px;
          }
          .completion[hidden] { display: none; }
          .wrap.offline .layout, .wrap.offline .completion, .wrap.offline .printer-alert { display: none; }
          .printer-alert .act { flex: 0 0 auto; margin-left: auto; align-self: center; }
          .printer-alert .act[hidden] { display: none; }
          .printer-alert.is-error .act { border-color: #8f2a2e; }
          .printer-alert {
            display: flex; gap: 10px; align-items: flex-start;
            margin-bottom: 12px; padding: 10px 12px; border-radius: 8px;
            background: #3b2c1b; border: 1px solid #bb8b47; color: var(--cp-text);
          }
          .printer-alert[hidden] { display: none; }
          .printer-alert.is-error { background: #3b1d1f; border-color: #e5484d; }
          .printer-alert ha-icon { flex: 0 0 auto; color: #fc6d09; --mdc-icon-size: 20px; }
          .printer-alert.is-error ha-icon { color: #e5484d; }
          .printer-alert-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
          .printer-alert-title { font-weight: 600; font-size: 14px; }
          .printer-alert-detail { font-size: 12px; color: var(--cp-muted); }
          .printer-alert-detail:empty { display: none; }
          .printer-alert .alert-close {
            flex: 0 0 auto; align-self: flex-start; display: inline-flex; padding: 2px; margin: -2px -4px 0 0;
            border: 0; border-radius: 6px; background: none; color: var(--cp-muted); cursor: pointer;
          }
          .printer-alert .alert-close:hover { color: var(--cp-text); background: #ffffff14; }
          .printer-alert .alert-close ha-icon { color: inherit; --mdc-icon-size: 18px; }
          .offline-notice { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
          .offline-notice[hidden], #printer-power[hidden] { display: none; }
          #printer-loading { width: 16px; height: 16px; border: 2px solid var(--cp-border); border-top-color: var(--cp-accent); border-radius: 50%; animation: printer-spin 0.8s linear infinite; }
          #printer-loading[hidden] { display: none; }
          @keyframes printer-spin { to { transform: rotate(360deg); } }
          @media (prefers-reduced-motion: reduce) { #printer-loading { animation: none; } }
          #printer-power { flex: 0 0 auto; }
          #printer-power-error { color: var(--error-color, #e85d4c); }
          .completion::after {
            content: ""; position: absolute; bottom: -9px; left: 28px;
            width: 16px; height: 16px; background: inherit;
            border-right: inherit; border-bottom: inherit; transform: rotate(45deg);
          }
          .completion.interrupted { background: #3b2c1b; border-color: #bb8b47; }
          .completion h3 { margin: 0 0 6px; font-size: 17px; }
          .completion-file { overflow-wrap: anywhere; font-size: 13px; opacity: .85; }
          .completion-stats { display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 14px 0; font-size: 13px; }
          .completion-actions { display: flex; flex-wrap: wrap; gap: 10px; }
          .completion-actions .act { flex: 0 1 auto; min-height: 40px; padding: 8px 14px; }
          .completion-actions .act:disabled { opacity: .55; cursor: default; }
          .completion-note { margin: 8px 0 0; font-size: 12px; opacity: .8; }
          .completion-note:empty { display: none; }
          .completion-video { display: block; width: 100%; max-height: 60vh; margin-top: 12px; border-radius: 10px; background: #000; }
          .completion-video[hidden] { display: none; }
          @media (max-width: 480px) {
            .completion { padding: 16px; }
            .completion-actions .act { flex: 1 1 100%; }
          }
          .log-summary {
            font-size: 12px;
            color: var(--cp-muted);
            margin-bottom: 10px;
          }
          .log-list { display: flex; flex-direction: column; gap: 8px; }
          .log-row {
            display: grid;
            grid-template-columns: 48px 1fr auto;
            gap: 8px;
            align-items: center;
            background: var(--cp-input);
            border: 1px solid var(--cp-border);
            border-radius: 8px;
            padding: 8px 10px;
            cursor: pointer;
          }
          .log-row:hover { border-color: var(--cp-muted); }
          .log-thumb {
            width: 48px;
            height: 48px;
            border-radius: 6px;
            object-fit: cover;
            background: var(--cp-inset);
            border: 1px solid var(--cp-border);
            display: block;
          }
          .log-thumb.empty {
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--cp-muted);
            font-size: 10px;
          }
          .log-row b {
            display: block;
            font-size: 13px;
            font-weight: 600;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .log-row span {
            display: block;
            font-size: 11px;
            color: var(--cp-muted);
            margin-top: 2px;
          }
          .filament-custom {
            margin-top: 6px;
          }
          .filament-custom[hidden] { display: none !important; }
          .log-acts { display: flex; align-items: center; gap: 4px; }
          .log-act {
            border: 0;
            background: transparent;
            color: var(--cp-muted);
            cursor: pointer;
            padding: 4px;
            border-radius: 6px;
            display: inline-flex;
          }
          .log-act:hover { color: var(--cp-accent); background: #ffffff10; }
          .log-act[disabled] { opacity: 0.35; cursor: default; background: none; color: var(--cp-muted); }
          .log-del:hover { color: #e5484d; }
          .log-act ha-icon { --mdc-icon-size: 18px; }
          .log-empty { font-size: 12px; color: var(--cp-muted); }
          .log-note {
            font-size: 11px;
            color: #c9a227;
            margin-top: 8px;
          }
          /* Save / edit / details of a print: a dialog filling the screen. */
          .log-dialog {
            width: 100vw; height: 100vh; height: 100dvh; max-width: none; max-height: none;
            margin: 0; padding: 0; border: 0; border-radius: 0;
            background: var(--cp-bg); color: var(--cp-text);
          }
          .log-dialog[open] { display: flex; flex-direction: column; }
          .log-dialog::backdrop { background: #000c; }
          .log-dialog-h {
            flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px;
            padding: 10px 12px 10px 16px; border-bottom: 1px solid var(--cp-border);
          }
          .log-dialog-h h3 { margin: 0; font-size: 16px; }
          .log-dialog-b { flex: 1 1 auto; overflow: auto; padding: 16px; }
          .log-dialog-b > div { max-width: 760px; margin: 0 auto; }
          #log-view[hidden], #log-edit[hidden] { display: none; }
          .log-detail {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px 14px;
          }
          .log-detail .wide { grid-column: 1 / -1; }
          .log-detail-thumb {
            grid-column: 1 / -1;
            justify-self: center;
            max-width: 100%;
            max-height: 180px;
            border-radius: 8px;
            background: var(--cp-inset);
          }
          .log-detail div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
          .log-tl[hidden], .log-tl video[hidden] { display: none; }
          .log-tl { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--cp-border); }
          .log-tl-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
          .log-tl-text { flex: 1 1 180px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
          .log-tl-label { font-size: 11px; color: var(--cp-muted); }
          #log-tl-text { font-size: 13px; color: var(--cp-text); overflow-wrap: anywhere; }
          .log-tl-row .act { flex: 0 0 auto; min-height: 36px; padding: 6px 12px; }
          .log-tl video { margin-top: 10px; }
          .log-detail dt { font-size: 11px; color: var(--cp-muted); }
          .log-detail dd {
            margin: 0;
            font-size: 13px;
            color: var(--cp-text);
            overflow-wrap: anywhere;
            white-space: pre-wrap;
          }
          .form {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
          }
          .form label {
            display: flex;
            flex-direction: column;
            gap: 4px;
            font-size: 11px;
            color: var(--cp-muted);
          }
          .form .wide { grid-column: 1 / -1; }
          .form input, .form select, .form textarea {
            background: var(--cp-input);
            color: var(--cp-text);
            border: 1px solid var(--cp-border);
            border-radius: 6px;
            padding: 7px 8px;
            font: inherit;
            font-size: 13px;
          }
          .form textarea { min-height: 56px; resize: vertical; }
          .est {
            grid-column: 1 / -1;
            background: var(--cp-input);
            border: 1px solid var(--cp-border);
            border-radius: 8px;
            padding: 8px 10px;
            font-size: 12px;
            color: var(--cp-text);
          }
          .est b { color: var(--cp-accent); }
          .modal-acts {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            margin-top: 12px;
          }
          .modal-acts .act { flex: 0 0 auto; min-width: 96px; }
        </style>
        <div class="wrap">
          <div class="title" id="title"></div>
          <div class="offline-notice" id="offline-notice" hidden>
            <span id="printer-loading" hidden aria-hidden="true"></span>
            <span id="offline-message" role="status" aria-live="polite">Printer is offline.</span>
            <button class="act" id="printer-power" type="button" hidden></button>
            <span id="printer-power-error" role="alert"></span>
          </div>
          <div class="printer-alert" id="printer-alert" role="alert" hidden>
            <ha-icon id="printer-alert-icon" icon="mdi:alert"></ha-icon>
            <div class="printer-alert-body">
              <span class="printer-alert-title" id="printer-alert-title"></span>
              <span class="printer-alert-detail" id="printer-alert-detail"></span>
            </div>
            <button class="alert-close" id="printer-alert-close" type="button" title="Dismiss" aria-label="Dismiss printer alert">
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>
          <div class="printer-alert is-error" id="filament-alert" role="alert" hidden>
            <ha-icon icon="mdi:printer-3d-nozzle-alert"></ha-icon>
            <div class="printer-alert-body">
              <span class="printer-alert-title">Filament runout</span>
              <span class="printer-alert-detail">The filament sensor reports no filament. Heat the nozzle, then unload and load new filament.</span>
            </div>
            <button class="act" id="filament-heat" type="button" hidden></button>
            <button class="alert-close" id="filament-alert-close" type="button" title="Dismiss" aria-label="Dismiss filament runout alert">
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>
          <section class="completion" id="completion-banner" hidden aria-label="Print result">
            <h3 id="completion-title" role="status" aria-live="polite"></h3>
            <div class="completion-file" id="completion-file"></div>
            <div class="completion-stats" id="completion-stats"></div>
            <div class="completion-actions">
              <button class="act" id="completion-timelapse" type="button" disabled aria-controls="completion-video">Checking timelapse…</button>
              <button class="act" id="completion-timelapse-download" type="button" hidden aria-haspopup="dialog">Save timelapse…</button>
              <button class="act" id="save-print" type="button">Save to history</button>
            </div>
            <p class="completion-note" id="completion-note" role="status"></p>
            <video class="completion-video" id="completion-video" controls playsinline preload="none" hidden></video>
          </section>
          <div class="layout">
            <section class="panel panel-print" data-panel="print">
              <div class="panel-h" role="button" tabindex="0" aria-expanded="true">
                <span class="panel-title">Printing information</span>
                <span class="badge" id="status-badge">—</span>
                <ha-icon class="chevron" icon="mdi:chevron-down"></ha-icon>
              </div>
              <div class="panel-b">
                <div class="media-row" id="media-row">
                  <div class="tile tile-camera" id="camera-tile">
                    <div class="camera-body" id="camera" data-more="camera">
                      <div class="empty">No camera</div>
                    </div>
                    <div class="cam-bar" id="cam-bar">
                      <div class="cam-bar-status">
                        <svg class="ring" id="ring" viewBox="0 0 36 36" aria-hidden="true">
                          <circle class="ring-bg" cx="18" cy="18" r="15.5"></circle>
                          <circle class="ring-fg" id="ring-fg" cx="18" cy="18" r="15.5" pathLength="100"></circle>
                        </svg>
                        <b class="cam-pct" id="cam-pct">—</b>
                        <span class="badge" id="cam-badge">—</span>
                        <span class="cam-layer" id="cam-layer"></span>
                      </div>
                      <div class="cam-bar-acts">
                        <button class="bar-btn" id="pause" type="button" title="Pause print" aria-label="Pause print"><ha-icon icon="mdi:pause"></ha-icon></button>
                        <button class="bar-btn" id="resume" type="button" title="Resume print" aria-label="Resume print"><ha-icon icon="mdi:play"></ha-icon></button>
                        <button class="bar-btn stop" id="stop" type="button" title="Stop print" aria-label="Stop print"><ha-icon icon="mdi:stop"></ha-icon></button>
                        <button class="bar-btn" id="camera-expand" type="button" title="Expand camera" aria-label="Expand camera"><ha-icon icon="mdi:arrow-expand"></ha-icon></button>
                      </div>
                    </div>
                  </div>
                  <div class="tile" id="profile-tile">
                    <button class="thumb profile" id="profile" type="button" hidden>
                      <span class="profile-stage"><svg id="profile-svg" preserveAspectRatio="xMidYMax meet" aria-hidden="true"></svg></span>
                      <span class="layer-caption" id="profile-caption"></span>
                    </button>
                    <div class="thumb empty" id="profile-empty">No G-code profile</div>
                  </div>
                  <div class="tile" id="preview-tile">
                    <div class="thumb empty" id="preview" data-more="preview">No preview</div>
                  </div>
                </div>
                <div class="meta">
                  <div class="bar-slot" id="bar-slot"></div>
                  <div class="progress-head" id="progress-head">
                    <b class="big-pct" id="big-pct">—</b>
                    <span class="progress-eta" id="progress-eta"></span>
                  </div>
                  <div class="meta-head" id="meta-head">
                    <div class="kv" id="file-row">File: <b id="file">—</b></div>
                    <div class="kv" id="layer-row">Layer: <b id="layer">—</b></div>
                  </div>
                  <div class="bar" id="bar-row"><span id="bar"></span></div>
                  <div class="timing-row" id="timings" title="Real = print job time. Creality = printer time left.">
                    <div class="timing" id="timing-real" title="Elapsed printing time reported by the printer"><span>Real</span><b id="time-real">—</b></div>
                    <div class="timing" id="timing-creality" title="Time remaining estimated by the printer"><span>Creality</span><b id="time-creality">—</b></div>
                  </div>
                  <div class="times" id="times" data-more="used_material">—</div>
                  <div class="times" id="filament"></div>
                  <div class="times" id="power-line" data-more="print_energy" hidden>
                    <div id="power-text"></div>
                    <div class="power-now" id="power-now" hidden>
                      <span id="power-reading"></span>
                      <label class="baseline-field" id="baseline-field" title="Power offset subtracted from every power reading, so only the printer's share is counted. Leave empty to use the meter reading at the printer's last power-on.">Power offset
                        <input id="baseline" type="number" min="0" step="1" inputmode="numeric" /> W
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <div class="col col-main">
              <section class="panel" data-panel="controls" id="controls-panel">
                <div class="panel-h" role="button" tabindex="0" aria-expanded="true">
                  <span class="panel-title">Controls</span>
                  <ha-icon class="chevron" icon="mdi:chevron-down"></ha-icon>
                </div>
                <div class="panel-b">
                  <div class="ctrl-row" id="ctrl-row">
                    <button class="icon-btn" id="home" title="Home XY then Z">
                      <ha-icon icon="mdi:home"></ha-icon>
                    </button>
                    <label class="field" id="speed-field">Printing speed:
                      <input id="speed" type="number" min="50" max="200" step="1" /> %
                    </label>
                    <label class="field" id="flow-field">Flow:
                      <input id="flow" type="number" min="50" max="150" step="1" /> %
                    </label>
                    <button class="act" id="filament-change" type="button" hidden>
                      <ha-icon icon="mdi:printer-3d-nozzle-heat"></ha-icon><span>Replace filament</span>
                    </button>
                  </div>
                  <div class="fan-row" id="fan-row">
                    <label class="field">Model Fan
                      <button class="switch" id="fan-model" type="button"><i></i></button>
                    </label>
                    <label class="field">Case
                      <button class="switch" id="fan-case" type="button"><i></i></button>
                    </label>
                    <label class="field">Side
                      <button class="switch" id="fan-side" type="button"><i></i></button>
                    </label>
                  </div>
                  <div class="coords" id="coords">
                    <div class="coord" id="coord-x"><span>X</span><b id="pos-x">—</b></div>
                    <div class="coord" id="coord-y"><span>Y</span><b id="pos-y">—</b></div>
                    <div class="coord" id="coord-z"><span>Z</span><b id="pos-z">—</b></div>
                  </div>
                </div>
              </section>
            </div>

            <div class="col col-side">
              <section class="panel" data-panel="temp">
                <div class="panel-h" role="button" tabindex="0" aria-expanded="true">
                  <span class="panel-title">Temperature</span>
                  <ha-icon class="chevron" icon="mdi:chevron-down"></ha-icon>
                </div>
                <div class="panel-b">
                  <table class="temps">
                    <thead>
                      <tr><th></th><th>Current</th><th>Target</th></tr>
                    </thead>
                    <tbody>
                      <tr data-more="nozzle">
                        <td><span class="dot nozzle"></span>Nozzle</td>
                        <td id="nozzle-now">—</td>
                        <td><input id="nozzle-target" type="number" min="0" max="300" step="1" /></td>
                      </tr>
                      <tr data-more="bed">
                        <td><span class="dot bed"></span>Hot Bed</td>
                        <td id="bed-now">—</td>
                        <td><input id="bed-target" type="number" min="0" max="120" step="1" /></td>
                      </tr>
                    </tbody>
                  </table>
                  <div class="temp-viz">
                    <svg class="chart" id="chart" viewBox="0 0 320 120" preserveAspectRatio="none"></svg>
                  </div>
                </div>
              </section>
            </div>
          </div>

          <section class="panel panel-log" data-panel="log">
            <div class="panel-h" role="button" tabindex="0" aria-expanded="true">
              <span class="panel-title">Print history</span>
              <ha-icon class="chevron" icon="mdi:chevron-down"></ha-icon>
            </div>
            <div class="panel-b">
              <div class="log-summary" id="log-summary"></div>
              <div class="log-list" id="log-list"></div>
              <div class="log-note" id="log-store-note" hidden></div>
              <div class="tl-line" id="tl-line" hidden>
                <ha-icon icon="mdi:filmstrip-box-multiple"></ha-icon>
                <span id="tl-line-text">Timelapses: checking…</span>
                <button class="act" id="tl-line-settings" type="button" aria-haspopup="dialog">Timelapse settings</button>
              </div>
            </div>
          </section>
        <dialog class="log-dialog" id="log-modal" aria-labelledby="log-modal-title">
          <div class="log-dialog-h">
            <h3 id="log-modal-title">Save print</h3>
            <button class="icon-btn" id="log-modal-close" type="button" title="Close" aria-label="Close">
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>
          <div class="log-dialog-b">
            <div id="log-view" hidden>
              <dl class="log-detail" id="log-detail"></dl>
              <div class="log-tl" id="log-tl" hidden>
                <div class="log-tl-row">
                  <div class="log-tl-text">
                    <span class="log-tl-label">Timelapse</span>
                    <span id="log-tl-text" role="status">Checking…</span>
                  </div>
                  <button class="act" id="log-tl-play" type="button" hidden aria-controls="log-tl-video">Play</button>
                  <button class="act" id="log-tl-download" type="button" hidden>
                    <ha-icon icon="mdi:download"></ha-icon> Download
                  </button>
                </div>
                <video class="completion-video" id="log-tl-video" controls playsinline preload="none" hidden></video>
              </div>
              <div class="modal-acts">
                <button class="act" id="log-close" type="button">Close</button>
                <button class="act" id="log-edit" type="button">Edit</button>
              </div>
            </div>
            <div id="log-edit-form">
            <div class="form">
              <label class="wide">Ended
                <input id="log-ended" type="datetime-local" />
              </label>
              <label class="wide">File
                <input id="log-file" type="text" />
              </label>
              <label>Result
                <select id="log-result">
                  <option value="completed">Completed</option>
                  <option value="stopped">Stopped</option>
                  <option value="failed">Failed</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label>Time spent
                <input id="log-time" type="text" placeholder="1:23:45" />
              </label>
              <label>Layers
                <input id="log-layers" type="text" />
              </label>
              <label>Progress %
                <input id="log-progress" type="number" min="0" max="100" step="1" />
              </label>
              <label>Energy (kWh)
                <input id="log-energy" type="number" min="0" step="0.001" placeholder="0.000" />
              </label>
              <label>Cost / kWh
                <input id="log-energy-cost" type="number" min="0" step="0.001" placeholder="e.g. 0.18" />
              </label>
              <p class="completion-note wide" id="log-energy-quality"></p>
              <label>Filament used
                <input id="log-used" type="number" min="0" step="0.1" />
              </label>
              <label>Unit
                <input id="log-used-unit" type="text" list="log-units" />
                <datalist id="log-units">
                  <option value="mm"></option>
                  <option value="m"></option>
                  <option value="g"></option>
                  <option value="kg"></option>
                </datalist>
              </label>
              <label>Filament type
                <select id="log-type-select">
                  ${FILAMENT_TYPES.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("")}
                  <option value="${FILAMENT_CUSTOM}">Custom…</option>
                </select>
                <input id="log-type" class="filament-custom" type="text" hidden placeholder="Type filament…" />
              </label>
              <label>Diameter (mm)
                <input id="log-diameter" type="number" min="0.5" max="3.5" step="0.05" />
              </label>
              <label>Cost / kg
                <input id="log-cost" type="number" min="0" step="0.01" placeholder="e.g. 22.50" />
              </label>
              <label>Currency
                <input id="log-currency" type="text" maxlength="4" />
              </label>
              <div class="est" id="log-est">Add filament and energy costs to estimate the print cost.</div>
              <label class="wide">Notes
                <textarea id="log-notes" placeholder="Color, brand, settings…"></textarea>
              </label>
            </div>
            <div class="modal-acts">
              <button class="act" id="log-cancel" type="button">Cancel</button>
              <button class="act" id="log-save" type="button">Save</button>
            </div>
            </div>
          </div>
        </dialog>
        </div>
        <dialog class="camera-zoom" id="camera-zoom" aria-labelledby="camera-zoom-title">
          <div class="camera-zoom-h">
            <span id="camera-zoom-title">Camera</span>
            <div class="camera-zoom-acts">
              <button class="icon-btn" id="camera-zoom-snapshot" type="button" title="Download snapshot" aria-label="Download snapshot">
                <ha-icon icon="mdi:camera"></ha-icon>
              </button>
              <button class="icon-btn" id="camera-zoom-fullscreen" type="button" title="Fullscreen" aria-label="Fullscreen">
                <ha-icon icon="mdi:fullscreen"></ha-icon>
              </button>
              <button class="icon-btn" id="camera-zoom-close" type="button" title="Close" aria-label="Close camera">
                <ha-icon icon="mdi:close"></ha-icon>
              </button>
            </div>
          </div>
          <div class="camera-zoom-body" id="camera-zoom-body"></div>
          <div class="camera-zoom-f" id="camera-zoom-info" role="status"></div>
        </dialog>
        <dialog class="tl-dialog" id="tl-save" aria-labelledby="tl-save-title">
          <h3 id="tl-save-title">Save timelapse</h3>
          <p class="tl-file" id="tl-save-file"></p>
          <div class="tl-choices">
            <button class="act" id="tl-save-download" type="button">
              <ha-icon icon="mdi:download"></ha-icon> Download to this device
            </button>
            <button class="act" id="tl-save-share" type="button">
              <ha-icon icon="mdi:folder-network"></ha-icon> <span id="tl-save-share-label">Save to folder</span>
            </button>
          </div>
          <p class="completion-note" id="tl-save-note" role="status"></p>
          <div class="modal-acts">
            <button class="act" id="tl-save-settings" type="button">Folder settings…</button>
            <button class="act" id="tl-save-close" type="button">Close</button>
          </div>
        </dialog>
        <dialog class="tl-dialog" id="tl-settings" aria-labelledby="tl-settings-title">
          <h3 id="tl-settings-title">Timelapse and G-code saving</h3>
          <div class="form">
            <label class="wide">Folder or network share
              <input id="tl-folder" type="text" placeholder="/media/nas/timelapses" autocomplete="off" />
            </label>
            <div class="wide tl-suggest" id="tl-suggest"></div>
            <label class="wide tl-check">
              <input id="tl-auto" type="checkbox" /> Save each print's timelapse automatically
            </label>
          </div>
          <p class="completion-note" id="tl-settings-note" role="status"></p>
          <div class="modal-acts">
            <button class="act" id="tl-settings-cancel" type="button">Cancel</button>
            <button class="act" id="tl-settings-save" type="button">Save</button>
          </div>
        </dialog>
      </ha-card>
    `;

    this._profileDrawn = null; // Fresh DOM: the profile must be drawn again.
    this._bind();
    this._applyCollapsed();
    this._built = true;
    this._update();
    this._renderPrintLog();
    this._loadPrints();
    this._drawTimelapseSettingsLine();
    if (!this._tlSettingsLoaded) this._loadTimelapseSettings();
    this._lastStates = {};
    this._watchedChanged(this._hass);
    this._startHistoryTimer();
  }

  _bind() {
    const on = (id, event, fn) => {
      this._root.getElementById(id)?.addEventListener(event, fn);
    };
    on("printer-power", "click", () => this._togglePrinterPower());
    on("home", "click", () => this._confirmPress(this._cfg.home, "Home XY then Z?"));
    on("pause", "click", () => this._confirmPress(this._cfg.pause, "Pause the current print?"));
    on("resume", "click", () => this._confirmPress(this._cfg.resume, "Resume the current print?"));
    on("stop", "click", () => this._confirmPress(this._cfg.stop, "Stop the current print?"));
    on("save-print", "click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._openPrintModal();
    });
    on("completion-timelapse", "click", () => this._toggleTimelapse());
    on("completion-timelapse-download", "click", () => this._openTimelapseSave());
    on("tl-save-download", "click", () => this._downloadTimelapse());
    on("tl-save-share", "click", () => this._saveTimelapseToFolder());
    on("tl-save-settings", "click", () => this._openTimelapseSettings());
    on("tl-save-close", "click", () => this._root.getElementById("tl-save")?.close());
    on("tl-line-settings", "click", () => this._openTimelapseSettings());
    on("log-tl-play", "click", () => this._toggleDetailTimelapse());
    on("log-tl-download", "click", () => this._downloadDetailTimelapse());
    on("tl-settings-cancel", "click", () => this._root.getElementById("tl-settings")?.close());
    on("tl-settings-save", "click", () => this._saveTimelapseSettings());
    on("tl-suggest", "click", (ev) => {
      const path = ev.target?.closest?.("[data-path]")?.dataset.path;
      if (!path) return;
      this._root.getElementById("tl-folder").value = path;
      this._drawFolderSuggestions();
    });
    on("tl-folder", "input", () => this._drawFolderSuggestions());
    on("log-cancel", "click", () => {
      // Editing a saved print: Cancel returns to its read-only details.
      if (this._editingId) this._showPrintDetails(this._editingId);
      else this._closePrintModal();
    });
    on("log-close", "click", () => this._closePrintModal());
    on("log-modal-close", "click", () => this._closePrintModal());
    // Close button, Save or Escape: the dialog's close event resets the panel.
    on("log-modal", "close", () => this._printModalClosed());
    on("log-edit", "click", () => this._editPrintFromDetails());
    on("log-save", "click", () => this._savePrintFromModal());
    on("log-energy", "input", () => {
      this._formEnergyQuality = "manual";
      this._formEnergyBaselineW = undefined;
      this._setText("log-energy-quality", "Energy measurement: manual");
    });
    this._root.getElementById("log-list")?.addEventListener("click", (ev) => {
      const repeat = ev.target.closest("[data-repeat]");
      if (repeat) {
        ev.stopPropagation();
        this._printAgain(repeat.dataset.repeat);
        return;
      }
      const del = ev.target.closest("[data-del]");
      if (del) {
        ev.preventDefault();
        ev.stopPropagation();
        this._deletePrint(del.dataset.del);
        return;
      }
      const row = ev.target.closest("[data-edit]");
      if (row) this._showPrintDetails(row.dataset.edit);
    });
    on("log-type-select", "change", () => {
      this._syncFilamentTypeUI();
      this._applyCostForType();
      this._refreshPrintEstimate();
    });
    ["log-used", "log-used-unit", "log-type", "log-diameter", "log-cost", "log-currency", "log-energy", "log-energy-cost"].forEach((id) => {
      this._root.getElementById(id)?.addEventListener("input", () => {
        if (id === "log-type") this._applyCostForType();
        this._refreshPrintEstimate();
      });
    });
    on("camera-expand", "click", () => this._openCameraZoom());
    on("camera-zoom-close", "click", () => this._closeCameraZoom());
    on("camera-zoom-fullscreen", "click", () => this._toggleZoomFullscreen());
    on("camera-zoom-snapshot", "click", () => this._downloadSnapshot());
    const zoom = this._root.getElementById("camera-zoom");
    // A click on the backdrop lands on the dialog itself.
    zoom?.addEventListener("click", (ev) => { if (ev.target === zoom) this._closeCameraZoom(); });
    // Drop the enlarged stream once the dialog closes (button, backdrop or Escape).
    zoom?.addEventListener("close", () => {
      this._root.getElementById("camera-zoom-body")?.replaceChildren();
      // Not while offline: the tile stream stays stopped until the printer returns.
      if (!this._root.querySelector(".wrap")?.classList.contains("offline")) this._syncCamera();
    });
    on("profile", "click", () => {
      this._profileAxis = this._profileAxis === "y" ? "x" : "y";
      this._drawProfile();
    });
    on("filament-heat", "click", () => this._heatForFilamentChange());
    on("filament-change", "click", () => this._heatForFilamentChange());
    on("printer-alert-close", "click", () => this._dismissPrinterAlert());
    on("filament-alert-close", "click", () => {
      this._filamentAlertDismissed = true;
      this._syncFilamentAlert();
    });
    on("fan-model", "click", () => this._toggleFan(this._cfg.model_fan));
    on("fan-case", "click", () => this._toggleFan(this._cfg.case_fan));
    on("fan-side", "click", () => this._toggleFan(this._cfg.side_fan));

    const commitNumber = (inputId, key) => {
      const el = this._root.getElementById(inputId);
      el?.addEventListener("change", () => this._setNumber(this._cfg[key], el.value));
    };
    commitNumber("speed", "print_tuning");
    commitNumber("flow", "flow_tuning");
    commitNumber("nozzle-target", "nozzle_target");
    commitNumber("bed-target", "bed_target");
    const baselineInput = this._root.getElementById("baseline");
    baselineInput?.addEventListener("change", () => this._setManualBaseline(baselineInput.value));

    this._root.querySelectorAll("[data-more]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        if (ev.target.closest("input, button, .switch")) return;
        this._moreInfo(this._cfg[el.dataset.more]);
      });
    });

    this._root.querySelectorAll(".panel-h").forEach((header) => {
      const panel = header.closest(".panel");
      header.addEventListener("click", (ev) => {
        if (ev.target.closest("button, input, a")) return;
        this._togglePanel(panel);
      });
      header.addEventListener("keydown", (ev) => {
        if (ev.target.closest("button, input, a")) return;
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          this._togglePanel(panel);
        }
      });
    });
  }

  _collapsedStorageKey() {
    return `creality-card.collapsed.v3.${this._cfg?.status || this._cfg?.title || "default"}`;
  }

  _loadCollapsed() {
    try {
      const raw = localStorage.getItem(this._collapsedStorageKey());
      return raw ? JSON.parse(raw) : null;
    } catch (_err) {
      return null;
    }
  }

  _saveCollapsed() {
    const state = {};
    this._root.querySelectorAll(".panel[data-panel]").forEach((panel) => {
      if (DEFAULT_COLLAPSED[panel.dataset.panel]) return;
      state[panel.dataset.panel] = panel.classList.contains("is-collapsed");
    });
    try {
      localStorage.setItem(this._collapsedStorageKey(), JSON.stringify(state));
    } catch (_err) {
      /* ignore quota / private mode */
    }
  }

  _applyCollapsed() {
    const saved = this._loadCollapsed();
    this._root.querySelectorAll(".panel[data-panel]").forEach((panel) => {
      const key = panel.dataset.panel;
      const collapsed = DEFAULT_COLLAPSED[key] || (saved && key in saved ? !!saved[key] : false);
      panel.classList.toggle("is-collapsed", collapsed);
      panel.querySelector(".panel-h")?.setAttribute("aria-expanded", String(!collapsed));
    });
  }

  _togglePanel(panel) {
    if (!panel) return;
    const collapsed = !panel.classList.contains("is-collapsed");
    panel.classList.toggle("is-collapsed", collapsed);
    panel.querySelector(".panel-h")?.setAttribute("aria-expanded", String(!collapsed));
    this._saveCollapsed();
  }

  _printStorageKey() {
    const id = this._cfg?.status || this._cfg?.title || "default";
    return `${PRINT_STORE_KEY}_${String(id).replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
  }

  _printLocalKey() {
    return `creality-card.prints.${this._cfg?.status || this._cfg?.title || "default"}`;
  }

  _defaultPrintStore() {
    return {
      version: 1,
      prefs: {
        filamentType: "PLA",
        costPerKg: "",
        costPerKwh: "",
        diameterMm: 1.75,
        currency: "€",
        lastCostByType: {},
      },
      prints: [],
      deleted: [],
    };
  }

  _normalizePrintStore(raw) {
    const base = this._defaultPrintStore();
    if (!raw || typeof raw !== "object") return base;
    const prefs = raw.prefs && typeof raw.prefs === "object" ? raw.prefs : {};
    const prints = Array.isArray(raw.prints) ? raw.prints : [];
    const deleted = Array.isArray(raw.deleted) ? raw.deleted.filter((id) => typeof id === "string") : [];
    return {
      version: 1,
      prefs: { ...base.prefs, ...prefs, lastCostByType: { ...base.prefs.lastCostByType, ...(prefs.lastCostByType || {}) } },
      prints,
      deleted,
    };
  }

  _readLocalPrintStore() {
    try {
      const raw = localStorage.getItem(this._printLocalKey());
      return raw ? this._normalizePrintStore(JSON.parse(raw)) : this._defaultPrintStore();
    } catch (_err) {
      return this._defaultPrintStore();
    }
  }

  _writeLocalPrintStore(store) {
    try {
      localStorage.setItem(this._printLocalKey(), JSON.stringify(store));
    } catch (_err) {
      /* ignore quota / private mode */
    }
  }

  _mergePrintStores(primary, extra) {
    // Deletions are remembered as tombstones so a stale copy in another browser
    // cannot bring a deleted print back when the stores are merged.
    const deleted = [...new Set([...(extra.deleted || []), ...(primary.deleted || [])])].slice(-DELETED_LIMIT);
    const gone = new Set(deleted);
    const ids = new Set((primary.prints || []).map((p) => p.id));
    const extras = (extra.prints || []).filter((p) => p.id && !ids.has(p.id));
    return {
      version: 1,
      prefs: {
        ...extra.prefs,
        ...primary.prefs,
        lastCostByType: { ...(extra.prefs?.lastCostByType || {}), ...(primary.prefs?.lastCostByType || {}) },
      },
      prints: [...extras, ...(primary.prints || [])]
        .filter((p) => !gone.has(p.id))
        .sort((a, b) => new Date(b.ended) - new Date(a.ended))
        .slice(0, PRINT_LIMIT),
      deleted,
    };
  }

  async _fetchServerPrintStore() {
    const res = await this._hass.callWS({
      type: "frontend/get_user_data",
      key: this._printStorageKey(),
    });
    return res?.value ? this._normalizePrintStore(res.value) : null;
  }

  async _loadPrints() {
    let store = this._readLocalPrintStore();
    let localOnly = false;
    if (this._hass?.callWS) {
      this._printsLoaded = true;
      try {
        const server = await this._fetchServerPrintStore();
        if (server) {
          const ids = new Set(server.prints.map((p) => p.id));
          store = this._mergePrintStores(server, store);
          localOnly = store.prints.some((p) => !ids.has(p.id));
        } else {
          localOnly = store.prints.length > 0;
        }
      } catch (_err) {
        this._usingLocalPrints = !!store.prints.length;
      }
    }
    this._prints = store.prints;
    this._printPrefs = store.prefs;
    this._deletedIds = store.deleted || [];
    this._renderPrintLog();
    this._syncSaveButton();
    this._loadGcodeFiles();
    // Upload prints only this browser had (e.g. saved while the server copy was not read).
    if (localOnly) await this._persistPrints();
  }

  async _persistPrints() {
    let store = {
      version: 1,
      prefs: this._printPrefs,
      prints: this._prints.slice(0, PRINT_LIMIT),
      deleted: (this._deletedIds || []).slice(-DELETED_LIMIT),
    };
    this._writeLocalPrintStore(store);
    this._usingLocalPrints = true;
    if (this._hass?.callWS) {
      try {
        // Another browser may have saved since we loaded; never overwrite its prints.
        const server = await this._fetchServerPrintStore();
        if (server) {
          store = this._mergePrintStores(store, server);
          this._prints = store.prints;
          this._deletedIds = store.deleted;
          this._writeLocalPrintStore(store);
        }
        await this._hass.callWS({
          type: "frontend/set_user_data",
          key: this._printStorageKey(),
          value: store,
        });
        this._usingLocalPrints = false;
      } catch (_err) {
        this._usingLocalPrints = true;
      }
    }
    this._renderPrintLog();
  }

  _isPrintModalOpen() {
    return !!this._root.getElementById("log-modal")?.open;
  }

  _showPrintModal() {
    const dialog = this._root.getElementById("log-modal");
    if (dialog && !dialog.open) dialog.showModal?.();
  }

  _setPrintPanelMode(mode) {
    const view = this._root.getElementById("log-view");
    const edit = this._root.getElementById("log-edit-form");
    if (view) view.hidden = mode !== "view";
    if (edit) edit.hidden = mode !== "edit";
  }

  _showPrintDetails(id) {
    const p = this._prints.find((row) => row.id === id);
    if (!p) return;
    this._editingId = p.id;
    this._setText("log-modal-title", "Print details");
    const detail = this._root.getElementById("log-detail");
    if (detail) detail.innerHTML = printDetailsHtml(p);
    this._loadDetailTimelapse(p);
    this._setPrintPanelMode("view");
    this._showPrintModal();
    this._root.getElementById("log-edit")?.focus({ preventScroll: true });
  }

  /** Timelapse of a saved print, looked up on the printer by its job id. */
  _resetDetailTimelapse() {
    const state = this._detailTl;
    this._detailTl = null;
    state?.abort?.abort();
    if (state?.blobUrl) URL.revokeObjectURL(state.blobUrl);
    this._drawDetailTimelapse();
  }

  async _loadDetailTimelapse(row) {
    this._resetDetailTimelapse();
    const start = rowStartTime(row);
    if (!start || !this._cfg?.status || !this._hass?.callWS) return;
    const state = { rowId: row.id, status: "checking", open: false };
    this._detailTl = state;
    this._drawDetailTimelapse();
    let res;
    try {
      res = await this._hass.callWS({ type: "creality/timelapse", entity_id: this._cfg.status, print_start_time: start });
    } catch (_err) {
      res = { status: "error" };
    }
    if (this._detailTl !== state) return;
    state.status = ["ready", "missing", "unavailable"].includes(res?.status) ? res.status : "error";
    state.result = res || null;
    state.fetchedAt = Date.now();
    this._drawDetailTimelapse();
  }

  async _toggleDetailTimelapse() {
    const state = this._detailTl;
    if (state?.status !== "ready") return;
    if (state.open) {
      state.open = false;
      state.abort?.abort();
      this._drawDetailTimelapse();
      return;
    }
    state.open = true;
    state.loadError = false;
    this._drawDetailTimelapse();
    if (!state.blobUrl) {
      const row = this._prints.find((p) => p.id === state.rowId);
      // Signed URLs last an hour; ask again for an old answer.
      if (Date.now() - state.fetchedAt > 30 * 60 * 1000 && row) {
        await this._loadDetailTimelapse(row);
        return this._toggleDetailTimelapse();
      }
      state.abort = new AbortController();
      state.progress = 0;
      try {
        const blobUrl = await fetchVideoBlobUrl(state.result.url, state.abort.signal, state.result.size, (progress) => {
          state.progress = progress;
          this._drawDetailTimelapse();
        });
        if (this._detailTl !== state) {
          URL.revokeObjectURL(blobUrl);
          return;
        }
        state.blobUrl = blobUrl;
      } catch (_err) {
        if (this._detailTl === state && !state.abort.signal.aborted) {
          state.loadError = true;
          state.open = false;
        }
      } finally {
        state.abort = undefined;
        state.progress = undefined;
      }
      if (this._detailTl !== state) return;
      this._drawDetailTimelapse();
      if (!state.open || !state.blobUrl) return;
    }
    this._root.getElementById("log-tl-video")?.play?.()?.catch?.(() => {});
  }

  _downloadDetailTimelapse() {
    const state = this._detailTl;
    const result = state?.status === "ready" ? state.result : null;
    if (!result?.download_url) return;
    const link = document.createElement("a");
    link.href = state.blobUrl || result.download_url;
    link.download = result.filename || "";
    link.click();
  }

  _drawDetailTimelapse() {
    const box = this._root?.getElementById("log-tl");
    if (!box) return;
    const state = this._detailTl;
    box.hidden = !state;
    const play = this._root.getElementById("log-tl-play");
    const download = this._root.getElementById("log-tl-download");
    const video = this._root.getElementById("log-tl-video");
    const ready = state?.status === "ready";
    const result = state?.result || {};
    const savedAs = result.saved_as ? `Saved to ${result.saved_as}` : "";
    let text = "Checking…";
    if (ready) {
      text = [Number.isFinite(result.duration) ? fmtDuration(result.duration) : null,
        Number.isFinite(result.size) ? `${(result.size / 1e6).toFixed(1)} MB` : null,
        savedAs || null].filter(Boolean).join(" · ") || "Ready";
      if (state.open && !state.blobUrl) {
        text = Number.isFinite(state.progress) && state.progress > 0
          ? `Loading… ${Math.round(state.progress * 100)}%`
          : "Loading…";
      } else if (state.loadError) {
        text = loadErrorText(result);
      }
    } else if (state?.status === "missing") {
      text = "The printer has no timelapse for this print (timelapse off, or the print was very short).";
    } else if (state?.status === "unavailable") {
      text = "Couldn't reach the printer to look for the timelapse.";
    } else if (state?.status === "error") {
      text = "Couldn't look up the timelapse.";
    }
    this._setText("log-tl-text", text);
    if (play) {
      play.hidden = !ready;
      play.textContent = state?.open ? "Hide" : "Play";
      play.setAttribute("aria-expanded", String(ready && !!state.open));
    }
    if (download) download.hidden = !ready;
    if (video) {
      const src = ready && state.open ? state.blobUrl || "" : "";
      if ((video.dataset.src || "") !== src) {
        video.dataset.src = src;
        if (src) {
          video.src = src;
        } else {
          video.pause?.();
          video.removeAttribute("src");
          video.load?.();
        }
      }
      video.hidden = !src;
    }
  }

  _editPrintFromDetails() {
    const existing = this._prints.find((p) => p.id === this._editingId);
    if (!existing) return;
    this._resetDetailTimelapse();
    this._setText("log-modal-title", "Edit print");
    this._writePrintForm({ ...existing });
    this._refreshPrintEstimate();
    this._setPrintPanelMode("edit");
    this._root.getElementById("log-file")?.focus({ preventScroll: true });
  }

  async _openPrintModal(id) {
    const existing = id ? this._prints.find((p) => p.id === id) : null;
    this._editingId = existing?.id || null;
    const title = this._root.getElementById("log-modal-title");
    if (title) title.textContent = existing ? "Edit print" : "Save print";
    const draft = existing ? { ...existing } : this._snapshotPrintDraft();
    // A new save starts from the filament named in the file; edits keep the saved choice.
    const named = existing ? null : filamentFromFileName(draft.file);
    if (named) {
      draft.filamentType = named;
      draft.costPerKg = this._printPrefs.lastCostByType?.[named] ?? this._printPrefs.costPerKg ?? "";
    }
    if (!existing && !draft.preview) {
      draft.preview = (await this._capturePreviewThumb()) || this._lastJobDraft?.preview || "";
    }
    const measured = existing ? null : await this._measureMeterEnergy(draft);
    if (measured) {
      draft.energyKwh = measured.kwh;
      draft.energyQuality = measured.quality;
      draft.energyBaselineW = measured.baselineW;
    }
    this._writePrintForm(draft);
    this._refreshPrintEstimate();
    this._setPrintPanelMode("edit");
    this._showPrintModal();
    this._root.getElementById("log-file")?.focus({ preventScroll: true });
  }

  _closePrintModal() {
    const dialog = this._root.getElementById("log-modal");
    if (dialog?.open) dialog.close();
    else this._printModalClosed();
  }

  _printModalClosed() {
    this._resetDetailTimelapse();
    this._editingId = null;
    this._formPreview = "";
  }

  _setFilamentTypeUI(type) {
    const select = this._root.getElementById("log-type-select");
    const custom = this._root.getElementById("log-type");
    const value = String(type || "PLA").trim() || "PLA";
    const known = FILAMENT_TYPES.includes(value);
    if (select) select.value = known ? value : FILAMENT_CUSTOM;
    if (custom) {
      custom.value = known ? "" : value;
      custom.hidden = known;
    }
  }

  _getFilamentTypeUI() {
    const select = this._root.getElementById("log-type-select");
    const custom = this._root.getElementById("log-type");
    if (select?.value === FILAMENT_CUSTOM) {
      return custom?.value?.trim() || "PLA";
    }
    return select?.value?.trim() || "PLA";
  }

  _syncFilamentTypeUI() {
    const select = this._root.getElementById("log-type-select");
    const custom = this._root.getElementById("log-type");
    if (!select || !custom) return;
    const isCustom = select.value === FILAMENT_CUSTOM;
    custom.hidden = !isCustom;
    if (isCustom) {
      if (!custom.value) custom.value = "";
      custom.focus();
    }
  }

  _canvasFromImageSource(source, width, height) {
    const size = PREVIEW_THUMB_SIZE;
    const scale = Math.min(size / Math.max(1, width), size / Math.max(1, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.fillStyle = "#141414";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    try {
      return canvas.toDataURL("image/jpeg", 0.7);
    } catch (_err) {
      return "";
    }
  }

  _imageElementToThumb(img) {
    if (!img || !img.naturalWidth) return "";
    return this._canvasFromImageSource(img, img.naturalWidth, img.naturalHeight);
  }

  async _capturePreviewThumb() {
    const mountImg = this._root.getElementById("preview")?.querySelector("img");
    if (mountImg?.complete && mountImg.naturalWidth) {
      const fromDom = this._imageElementToThumb(mountImg);
      if (fromDom) return fromDom;
    }

    const url = this._picture(this._cfg?.preview, false);
    if (!url) return "";

    try {
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) return "";
      const blob = await res.blob();
      if (typeof createImageBitmap === "function") {
        const bitmap = await createImageBitmap(blob);
        const data = this._canvasFromImageSource(bitmap, bitmap.width, bitmap.height);
        bitmap.close?.();
        if (data) return data;
      }
      const objectUrl = URL.createObjectURL(blob);
      try {
        const img = await new Promise((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = reject;
          el.src = objectUrl;
        });
        return this._imageElementToThumb(img);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch (_err) {
      return "";
    }
  }

  _livePrintDraft() {
    const usedSt = this._st("used_material");
    const usedRaw = usedSt?.state;
    const usedN = parseFloat(usedRaw);
    const usedOk = usedSt && Number.isFinite(usedN) && !["unknown", "unavailable"].includes(String(usedRaw).toLowerCase());
    const file = this._val("object");
    const startTime = this._st("status")?.attributes?.print_start_time ?? "";
    const jobKey = [this._cfg?.status || "", startTime || "",
      this._st("status")?.attributes?.print_id || "", file || ""].join("|");
    const previous = this._lastJobDraft?.jobKey === jobKey ? this._lastJobDraft : null;
    const status = String(this._val("status", "completed")).toLowerCase();
    const result = ["completed", "stopped", "failed", "cancelled"].includes(status) ? status : "completed";
    const layer = this._val("layer");
    const total = this._val("total_layers");
    const layers = preferLayers(formatLayers(layer, total), previous?.layers);
    const filamentType = this._printPrefs.filamentType || "PLA";
    const energyKwh = this._energyUsedKwh();
    return {
      ended: new Date().toISOString(),
      jobKey,
      startTime,
      file: file && file !== "unknown" ? file : "",
      result,
      timeLabel: fmtDuration(this._val("job_time")),
      timeSeconds: parseDurationSeconds(this._val("job_time")),
      layers,
      progress: Math.round(progressPct(this._val("progress"), this._st("progress"))),
      used: usedOk ? usedN : "",
      usedUnit: usedOk ? usedSt.attributes?.unit_of_measurement || "mm" : this._printPrefs.usedUnit || "mm",
      filamentType,
      diameterMm: this._printPrefs.diameterMm || 1.75,
      costPerKg: this._printPrefs.lastCostByType?.[filamentType] ?? this._printPrefs.costPerKg ?? "",
      costPerKwh: this._printPrefs.costPerKwh ?? "",
      currency: this._printPrefs.currency || "€",
      notes: "",
      preview: previous?.preview || "",
      energyQuality: this._backendEnergy()?.quality || "partial",
      energyKwh: Number.isFinite(energyKwh)
        ? energyKwh
        : Number.isFinite(previous?.energyKwh)
          ? previous.energyKwh
          : "",
    };
  }

  /** Energy for the current/last job: the card's own meter, else the integration's background total. */
  _energyUsedKwh() {
    const backend = this._backendEnergy();
    if (backend) return backend.kwh;
    if (this._completedJob) return Number.isFinite(this._completedJob.energyKwh) ? this._completedJob.energyKwh : null;
    if (Number.isFinite(this._lastJobDraft?.energyKwh)) return this._lastJobDraft.energyKwh;
    return null;
  }

  _trackEnergy() {
    const el = this._root.getElementById("power-line");
    if (!el) return;
    if (!this._cfg?.print_energy) {
      el.hidden = true;
      this._setText("power-text", "");
      return;
    }
    el.hidden = false;
    const backend = this._backendEnergy();
    const meter = this._cardMeter();
    if (meter) this._refreshMeterEnergy();
    this._syncPowerNow(meter);
    let text;
    if (!meter) {
      text = "Choose a power (W/kW) or energy (Wh/kWh/MWh) sensor in the card editor";
    } else if (Number.isFinite(backend.kwh)) {
      text = `${fmtEnergy(backend.kwh)} this print · ${backend.quality}${baselineLabel(backend)}`;
    } else {
      const name = this._st("print_energy")?.attributes?.friendly_name || meter.id;
      // Idle: the live reading row already shows the meter; no extra label.
      text = this._meterJob() ? `Measuring energy from ${name}…` : "";
    }
    this._setText("power-text", text);
    const textEl = this._root.getElementById("power-text");
    if (textEl) textEl.hidden = !text;
  }

  /** Live meter reading, the printer's share of it and the editable power offset. */
  _syncPowerNow(meter) {
    const row = this._root.getElementById("power-now");
    if (!row) return;
    row.hidden = !meter;
    if (!meter) return;
    const [mode, factor] = meter.kind;
    const value = parseFloat(this._st("print_energy")?.state) * factor;
    const field = this._root.getElementById("baseline-field");
    if (field) field.hidden = mode !== "power";
    if (mode !== "power") {
      this._setText("power-reading", Number.isFinite(value) ? `Meter: ${fmtEnergy(value)}` : "Meter: unavailable");
      return;
    }
    const manual = this._manualBaselineW();
    const auto = this._displayAutoBaseline(meter);
    const baseline = manual ?? auto;
    let reading = Number.isFinite(value) ? `Now ${Math.round(value)} W` : "Now: unavailable";
    if (Number.isFinite(value) && Number.isFinite(baseline)) {
      reading += ` · printer ≈ ${Math.round(Math.max(0, value - baseline))} W`;
    }
    this._setText("power-reading", reading);
    const input = this._root.getElementById("baseline");
    if (input) input.placeholder = Number.isFinite(auto) ? String(Math.round(auto)) : "auto";
    this._setInput("baseline", manual ?? "");
  }

  /** The user's power offset (W) for this printer, or null for automatic. */
  _manualBaselineW() {
    const w = this._printPrefs?.baselineW;
    return typeof w === "number" && Number.isFinite(w) && w >= 0 ? w : null;
  }

  async _setManualBaseline(value) {
    const n = parseFloat(value);
    const w = String(value).trim() === "" || !Number.isFinite(n) ? null : Math.max(0, n);
    if (w === this._manualBaselineW()) return;
    this._printPrefs = { ...this._printPrefs, baselineW: w };
    // Re-measure the current or last job with the new baseline.
    this._meterEnergy = null;
    this._trackEnergy();
    await this._persistPrints();
  }

  /**
   * Automatic baseline to show next to the live reading: the current job's, or
   * while idle the meter reading at the printer's latest power-on (refreshed
   * every 5 minutes). Undefined until known, null when no power-on was found.
   */
  _displayAutoBaseline(meter) {
    const job = this._meterJob();
    const key = job ? job.jobKey : `idle-${Math.floor(Date.now() / 300000)}`;
    const cached = this._meterBaselineCache;
    if (cached?.jobKey === key) return cached.w;
    if (!job && !this._idleBaselineBusy && this._hass?.callWS) {
      this._idleBaselineBusy = true;
      this._autoMeterBaseline(meter, key, Date.now())
        .catch(() => {
          this._meterBaselineCache = { jobKey: key, w: null };
        })
        .finally(() => {
          this._idleBaselineBusy = false;
          this._syncPowerNow(this._cardMeter());
        });
    }
    return this._lastAutoBaselineW;
  }

  /** The card's configured power/energy meter ({id, kind}), or null. */
  _cardMeter() {
    const id = this._cfg?.print_energy;
    const kind = id ? meterKind(this._st("print_energy")) : null;
    return kind ? { id, kind } : null;
  }

  _meterJob() {
    return this._completedJob || this._lastJobDraft || null;
  }

  /** Re-measure the current job from recorder history, at most once a minute (once after it finished). */
  async _refreshMeterEnergy() {
    const job = this._meterJob();
    const cached = this._meterEnergy;
    if (!job || this._meterBusy) return;
    // A finish time corrected from history makes an earlier final measurement stale.
    if (cached?.jobKey === job.jobKey && cached.finishedAt === job.finishedAt &&
        (cached.final || Date.now() - cached.at < 60000)) return;
    this._meterBusy = true;
    const finishedAt = job.finishedAt;
    try {
      const measured = await this._measureMeterEnergy(job);
      this._meterEnergy = { jobKey: job.jobKey, finishedAt, at: Date.now(), final: Boolean(finishedAt),
        kwh: measured?.kwh ?? null, quality: measured?.quality || "unavailable",
        baselineW: measured?.baselineW };
    } finally {
      this._meterBusy = false;
    }
    this._trackEnergy();
  }

  async _fetchHistory(entityId, startMs, endMs) {
    return this._hass.callWS({
      type: "history/history_during_period",
      start_time: new Date(startMs).toISOString(),
      end_time: new Date(endMs).toISOString(),
      entity_ids: [entityId],
      include_start_time_state: true,
      significant_changes_only: false,
      minimal_response: true,
      no_attributes: true,
    });
  }

  /**
   * Power offset: meter load before the printer was switched on (W), for a whole-room power
   * meter. The power-on moment is the printer switch's last off→on before the
   * job (meter read just before it), else the print status leaving `offline`
   * (meter read 2 minutes earlier, before the printer booted). Only an off
   * stretch of 5 minutes or more counts, so HA restarts, reconnects and quick
   * plug toggles never make the printer's own draw the offset. Looks back 48 h;
   * null when no power-on is found or the meter is an energy counter. A power
   * offset the user entered on the card replaces the automatic one.
   */
  async _meterBaseline(meter, job, start) {
    if (meter.kind[0] !== "power") return null;
    return this._manualBaselineW() ?? this._autoMeterBaseline(meter, job.jobKey, start);
  }

  async _autoMeterBaseline(meter, key, start) {
    const cached = this._meterBaselineCache;
    if (cached?.jobKey === key) return cached.w;
    const sw = this._cfg?.printer_switch;
    const id = sw || this._cfg?.status;
    let w = null;
    if (id) {
      const states = historyStates(await this._fetchHistory(id, start - 48 * 3600000, start), id);
      const power = lastPowerOn(states, sw ? (s) => s === "off" : (s) => s.toLowerCase() === "offline");
      if (power) {
        // A plug may record its new reading in the same second it switches on.
        const at = sw ? power.on - 5000 : power.on - 120000;
        const before = parseHistorySeries(await this._fetchHistory(meter.id, at, at + 1000), meter.id)
          .filter((p) => p.t <= at && Number.isFinite(p.v));
        if (before.length) w = before[before.length - 1].v * meter.kind[1];
      }
    }
    this._meterBaselineCache = { jobKey: key, w };
    this._lastAutoBaselineW = w;
    return w;
  }

  /**
   * Integrate the card's meter over a job's window: from when the print status
   * became active for the job (preparation and heating, at most 30 minutes before
   * the printer's start time), else the printer start time (or now minus job
   * time), until the finish recorded at completion, else now. A power meter's
   * power offset is subtracted from every reading.
   */
  async _measureMeterEnergy(job) {
    const meter = this._cardMeter();
    if (!meter || !job || !this._hass?.callWS) return null;
    const end = Number(job.finishedAt) || Date.now();
    let start = Number(job.startTime) * 1000;
    if (!(start > 1e12 && start < end) && job.timeSeconds > 0) start = end - job.timeSeconds * 1000;
    if (!(start > 1e12 && start < end) || end - start > 7 * 86400000) return null;
    try {
      const baselineW = await this._meterBaseline(meter, job, start);
      start = await this._jobActiveSince(job, start);
      const data = await this._fetchHistory(meter.id, start, end);
      const measured = integrateMeter(parseHistorySeries(data, meter.id), meter.kind, start, end, baselineW || 0);
      return measured && { ...measured, baselineW: meter.kind[0] === "power" ? baselineW : undefined };
    } catch (_err) {
      return null;
    }
  }

  /** Earlier start of the job from print status history (cached per job), else `start`. */
  async _jobActiveSince(job, start) {
    const id = this._cfg?.status;
    if (!id) return start;
    const cached = this._jobActiveCache;
    if (cached?.jobKey !== job.jobKey) {
      // The status may turn active a moment after the printer's start time.
      const states = historyStates(await this._fetchHistory(id, start - JOB_PREP_MAX_MS, start + 60000), id);
      const found = { jobKey: job.jobKey, t: activeSince(states, start + 60000) };
      // Right after the start the recorder may not have written the change yet: ask again later.
      this._jobActiveCache = Date.now() > start + 120000 ? found : null;
      return this._earlierStart(found.t, start);
    }
    return this._earlierStart(cached.t, start);
  }

  _earlierStart(t, start) {
    return t != null && t < start ? Math.max(t, start - JOB_PREP_MAX_MS) : start;
  }

  /** Energy of the current/last job measured from the card's meter, or null without one. */
  _backendEnergy() {
    if (!this._cardMeter()) return null;
    const job = this._meterJob();
    const cached = job && this._meterEnergy?.jobKey === job.jobKey ? this._meterEnergy : null;
    return { kwh: cached?.kwh ?? null, quality: cached?.quality || "unavailable", baselineW: cached?.baselineW };
  }

  _jobFingerprint(draft) {
    if (!draft) return "";
    return [draft.file || "", draft.timeSeconds ?? (draft.timeLabel || ""), draft.used ?? "", draft.usedUnit || ""].join("|");
  }

  _hasPrintToSave() {
    if (this._completedJob) return !this._prints.some((row) => row.jobKey === this._completedJob.jobKey);
    return !!this._lastJobDraft && this._jobFingerprint(this._lastJobDraft) !== this._savedJobFingerprint;
  }

  _syncSaveButton() {
    const banner = this._root.getElementById("completion-banner");
    if (banner) banner.hidden = !this._completedJob;
    this._syncTimelapse();
    if (!this._completedJob) return;
    const job = this._completedJob;
    const success = job.result === "completed";
    banner?.classList.toggle("interrupted", !success);
    this._setText("completion-title", success ? "Print finished successfully" : `Print ${prettyStatus(job.result).toLowerCase()} — not completed`);
    this._setText("completion-file", job.file || "Untitled print");
    const bits = [
      job.timeSeconds ? `Duration: ${fmtDuration(job.timeSeconds)}` : null,
      job.layers ? `Layers: ${job.layers}` : null,
      Number.isFinite(parseFloat(job.used)) ? `Material: ${fmtUsed(job.used, job.usedUnit)}` : null,
      Number.isFinite(job.energyKwh) ? `Energy: ${fmtEnergy(job.energyKwh)}${job.energyQuality === "partial" ? " (partial)" : ""}` : null,
      !success ? `Progress: ${job.progress}%` : null,
    ].filter(Boolean);
    const stats = this._root.getElementById("completion-stats");
    if (stats) stats.innerHTML = bits.map((bit) => `<span>${esc(bit)}</span>`).join("");
    const btn = this._root.getElementById("save-print");
    if (btn) {
      btn.disabled = !this._hasPrintToSave();
      btn.textContent = btn.disabled ? "Saved to history" : "Save to history";
    }
  }

  /** Timelapse lookup for the job shown in the completion banner. */
  _timelapseKey() {
    const job = this._completedJob;
    return job && this._cfg?.status ? `${this._cfg.status}|${job.jobKey}` : "";
  }

  _resetTimelapse() {
    clearTimeout(this._timelapseTimer);
    this._timelapseTimer = undefined;
    this._timelapse?.abort?.abort();
    if (this._timelapse?.blobUrl) URL.revokeObjectURL(this._timelapse.blobUrl);
    this._timelapse = null;
    this._root?.getElementById?.("tl-save")?.close?.();
  }

  _syncTimelapse() {
    const key = this._timelapseKey();
    if (key !== (this._timelapse?.key || "")) {
      this._resetTimelapse();
      if (key) {
        // Measure the render wait from the job's end, not from when this card
        // (re)attached: view switches and reloads must not restart it.
        const ended = Number(this._completedJob?.finishedAt);
        this._timelapse = { key, status: "checking", since: Number.isFinite(ended) ? ended : Date.now(), open: false };
        this._fetchTimelapse(key);
      }
    }
    this._drawTimelapse();
  }

  async _fetchTimelapse(key) {
    const state = this._timelapse;
    if (state?.key !== key) return null;
    clearTimeout(this._timelapseTimer);
    this._timelapseTimer = undefined;
    const start = Number(this._completedJob?.startTime);
    let res;
    if (!this._completedJob?.startTime || !Number.isFinite(start)) {
      res = { status: "missing", final: true };
    } else if (!this._hass?.callWS) {
      res = { status: "error" };
    } else {
      try {
        res = await this._hass.callWS({ type: "creality/timelapse", entity_id: this._cfg.status, print_start_time: start });
      } catch (_err) {
        res = { status: "error" };
      }
    }
    if (this._timelapse !== state) return null; // Job changed or card detached meanwhile.
    state.status = ["ready", "missing", "unavailable"].includes(res?.status) ? res.status : "error";
    state.result = state.status === "ready" ? res : null;
    // Folder copy (auto-save or the save dialog); the integration reports it
    // only while the file exists, and then serves it instead of the printer's.
    if (state.status !== "error") state.savedAs = res.saved_as || null;
    state.fetchedAt = Date.now();
    let wait = 0;
    if (state.status === "missing" && !res.final && Date.now() - state.since < TIMELAPSE_WAIT_MS) wait = TIMELAPSE_POLL_MS;
    else if (state.status === "unavailable") wait = TIMELAPSE_RETRY_MS;
    state.waiting = state.status === "missing" && wait > 0;
    if (wait) {
      this._timelapseTimer = setTimeout(() => {
        this._timelapseTimer = undefined;
        this._fetchTimelapse(key);
      }, wait);
    }
    this._drawTimelapse();
    return state.result;
  }

  /** Ready result whose signed URLs are still comfortably valid. */
  async _freshTimelapse() {
    const state = this._timelapse;
    if (!state?.result) return null;
    const maxAge = (Number(state.result.expires_in) || 3600) * 500;
    if (Date.now() - state.fetchedAt < maxAge) return state.result;
    return this._fetchTimelapse(state.key);
  }

  async _toggleTimelapse() {
    const state = this._timelapse;
    if (state?.status !== "ready") return;
    if (state.open) {
      state.open = false;
      state.abort?.abort();
      this._drawTimelapse();
      return;
    }
    state.open = true;
    state.loadError = false;
    this._drawTimelapse();
    if (!state.blobUrl && !(await this._loadTimelapseVideo(state))) return;
    if (this._timelapse !== state || !state.open) return;
    this._drawTimelapse();
    this._root.getElementById("completion-video")?.play?.()?.catch?.(() => {});
  }

  /**
   * Download the whole video into the browser so the player can seek freely
   * (the printer ignores Range requests). The copy lives in this page only.
   */
  async _loadTimelapseVideo(state) {
    if (state.loading) return state.loading;
    state.loading = (async () => {
      const result = await this._freshTimelapse();
      if (!result?.url || this._timelapse !== state) return false;
      state.abort = new AbortController();
      state.progress = 0;
      try {
        const blobUrl = await fetchVideoBlobUrl(result.url, state.abort.signal, result.size, (progress) => {
          state.progress = progress;
          this._drawTimelapse();
        });
        if (this._timelapse !== state) {
          URL.revokeObjectURL(blobUrl);
          return false;
        }
        state.blobUrl = blobUrl;
        return true;
      } catch (_err) {
        if (this._timelapse === state && !state.abort.signal.aborted) {
          state.loadError = true;
          state.open = false;
          this._drawTimelapse();
        }
        return false;
      } finally {
        state.abort = undefined;
        state.loading = undefined;
        state.progress = undefined;
      }
    })();
    return state.loading;
  }

  async _downloadTimelapse() {
    const state = this._timelapse;
    const result = state?.blobUrl ? state.result : await this._freshTimelapse();
    if (!result?.download_url) return;
    const link = document.createElement("a");
    // Reuse the copy already loaded for the player instead of fetching it again.
    link.href = state?.blobUrl || result.download_url;
    link.download = result.filename || "";
    link.click();
  }

  /** Folder / auto-save settings of the printer's integration (shared by all cards). */
  async _loadTimelapseSettings() {
    if (!this._hass?.callWS || !this._cfg?.status) return null;
    this._tlSettingsLoaded = true;
    try {
      this._tlSettings = await this._hass.callWS({ type: "creality/timelapse_settings", entity_id: this._cfg.status });
    } catch (_err) {
      this._tlSettings = null;
    }
    this._drawTimelapseSettingsLine();
    return this._tlSettings;
  }

  _drawTimelapseSettingsLine() {
    const line = this._root?.getElementById("tl-line");
    if (!line) return;
    line.hidden = !this._cfg?.status || (this._tlSettingsLoaded && !this._tlSettings);
    const s = this._tlSettings;
    let text = "Timelapses: checking…";
    if (s && !s.folder) text = "Timelapses: no folder set";
    else if (s) text = `Timelapses: ${s.auto_save ? "saved automatically to" : "save manually to"} ${s.folder}`;
    if (s?.status === "failed" && s.last_error) text += ` · last save failed: ${s.last_error}`;
    this._setText("tl-line-text", text);
  }

  async _openTimelapseSave() {
    const dialog = this._root.getElementById("tl-save");
    const result = this._timelapse?.result;
    if (!dialog || !result) return;
    this._setText("tl-save-file", result.filename || result.file || "");
    this._setText("tl-save-note", "");
    this._drawTimelapseSaveChoices();
    if (!dialog.open) dialog.showModal?.();
    await this._loadTimelapseSettings();
    this._drawTimelapseSaveChoices();
  }

  _drawTimelapseSaveChoices() {
    const share = this._root.getElementById("tl-save-share");
    const folder = this._tlSettings?.folder || "";
    if (share) share.disabled = !folder || !!this._tlSaving;
    this._setText("tl-save-share-label", folder ? `Save to ${folder}` : "Save to a folder or share");
    const note = this._root.getElementById("tl-save-note");
    if (!folder && note && !note.textContent) {
      this._setText("tl-save-note", "No folder set yet. Choose one with Folder settings.");
    }
  }

  async _saveTimelapseToFolder() {
    const start = Number(this._completedJob?.startTime);
    if (!this._tlSettings?.folder || !Number.isFinite(start) || this._tlSaving) return;
    this._tlSaving = true;
    this._setText("tl-save-note", `Saving to ${this._tlSettings.folder}…`);
    this._drawTimelapseSaveChoices();
    try {
      const res = await this._hass.callWS({
        type: "creality/timelapse_save", entity_id: this._cfg.status, print_start_time: start,
      });
      this._setText("tl-save-note", `Saved as ${res.path}`);
      if (this._timelapse && Number(this._completedJob?.startTime) === start) this._timelapse.savedAs = res.path;
    } catch (err) {
      this._setText("tl-save-note", `Couldn't save: ${err?.message || "unknown error"}`);
    } finally {
      this._tlSaving = false;
      this._drawTimelapseSaveChoices();
      this._drawTimelapse();
      this._loadTimelapseSettings();
    }
  }

  async _openTimelapseSettings() {
    const dialog = this._root.getElementById("tl-settings");
    if (!dialog) return;
    this._root.getElementById("tl-save")?.close?.();
    this._setText("tl-settings-note", "Loading…");
    if (!dialog.open) dialog.showModal?.();
    const s = await this._loadTimelapseSettings();
    const folder = this._root.getElementById("tl-folder");
    const auto = this._root.getElementById("tl-auto");
    const save = this._root.getElementById("tl-settings-save");
    if (!s) {
      this._setText("tl-settings-note", "Couldn't load the settings. Is the integration up to date?");
      if (save) save.disabled = true;
      return;
    }
    folder.value = s.folder || "";
    auto.checked = !!s.auto_save;
    folder.disabled = auto.disabled = !s.can_edit;
    if (save) save.disabled = !s.can_edit;
    this._drawFolderSuggestions();
    this._setText("tl-settings-note", s.can_edit
      ? "Pick a share or type a path. Timelapses go to timelapses/YYYYMMDD/ and each print's G-code to gcode-files/, so it can be printed again from Print history. Network storage added in Settings → System → Storage with usage \"Media\" appears under /media."
      : "Only administrators can change these settings.");
  }

  _drawFolderSuggestions() {
    const box = this._root.getElementById("tl-suggest");
    if (!box) return;
    const current = this._root.getElementById("tl-folder")?.value.trim().replace(/\/+$/, "") || "";
    const list = this._tlSettings?.can_edit ? this._tlSettings.suggestions || [] : [];
    box.innerHTML = list.map((path) =>
      `<button class="act${path === current ? " on" : ""}" type="button" data-path="${esc(path)}">${esc(path)}</button>`
    ).join("");
  }

  async _saveTimelapseSettings() {
    const folder = this._root.getElementById("tl-folder")?.value.trim() || "";
    const auto = !!this._root.getElementById("tl-auto")?.checked;
    if (auto && !folder) {
      this._setText("tl-settings-note", "Choose a folder to save timelapses automatically.");
      return;
    }
    this._setText("tl-settings-note", "Saving…");
    try {
      this._tlSettings = await this._hass.callWS({
        type: "creality/timelapse_settings/set", entity_id: this._cfg.status, folder, auto_save: auto,
      });
    } catch (err) {
      this._setText("tl-settings-note", err?.message || "Couldn't save the settings.");
      return;
    }
    this._drawTimelapseSettingsLine();
    this._root.getElementById("tl-settings")?.close?.();
  }

  _drawTimelapse() {
    const btn = this._root?.getElementById("completion-timelapse");
    const download = this._root?.getElementById("completion-timelapse-download");
    const video = this._root?.getElementById("completion-video");
    const state = this._timelapse;
    const ready = state?.status === "ready" && !!state.result;
    const savedAs = state?.savedAs ? `Saved to ${state.savedAs}` : "";
    let label = "Checking timelapse…";
    let note = "";
    if (ready) {
      label = state.open ? "Hide timelapse" : "Play timelapse";
      const { duration, size } = state.result;
      note = ["Timelapse",
        Number.isFinite(duration) ? fmtDuration(duration) : null,
        Number.isFinite(size) ? `${(size / 1e6).toFixed(1)} MB` : null,
        savedAs || null].filter(Boolean).join(" · ");
      if (state.open && !state.blobUrl) {
        note = Number.isFinite(state.progress) && state.progress > 0
          ? `Loading timelapse… ${Math.round(state.progress * 100)}%`
          : "Loading timelapse…";
      } else if (state.loadError) {
        note = loadErrorText(state.result);
      }
    } else if (state?.waiting) {
      label = "Waiting for timelapse…";
      note = "Waiting for the printer to save the timelapse…";
    } else if (state?.status === "missing") {
      label = "No timelapse";
      note = "The printer has no timelapse for this print (timelapse off, or the print was very short).";
    } else if (state?.status === "unavailable") {
      label = "Timelapse unavailable";
      note = "Couldn't reach the printer to look for the timelapse. Retrying…";
    } else if (state?.status === "error") {
      label = "Timelapse unavailable";
      note = "Couldn't look up the timelapse.";
    }
    if (btn) {
      btn.disabled = !ready;
      btn.textContent = label;
      btn.setAttribute("aria-expanded", String(ready && !!state.open));
    }
    if (download) download.hidden = !ready;
    this._setText("completion-note", note);
    if (video) {
      const src = ready && state.open ? state.blobUrl || "" : "";
      if ((video.dataset.src || "") !== src) {
        video.dataset.src = src;
        if (src) {
          video.src = src;
        } else {
          video.pause?.();
          video.removeAttribute("src");
          video.load?.();
        }
      }
      video.hidden = !src;
    }
  }

  async _rememberJobDraft() {
    const status = String(this._val("status", "")).toLowerCase();
    const active = ["printing", "resuming", "pausing", "paused", "processing"].includes(status);
    const raw = this._st("status")?.attributes?.state_raw;
    // Do not infer success from 100%: some firmware reaches it before finishing.
    const result = raw != null
      ? (Number(raw) === 2 ? "completed" : Number(raw) === 4 ? "stopped" : null)
      : (["completed", "stopped", "failed", "cancelled"].includes(status) ? status : null);
    if (!active && !result) return;
    if (this._completedJob && !active) return;
    if (active && this._completedJob) {
      this._completedJob = null;
      this._lastJobDraft = null;
    }
    const live = this._livePrintDraft();
    if (this._lastJobDraft && live.jobKey !== this._lastJobDraft.jobKey && live.file) this._lastJobDraft = null;
    if (!(live.file || parseFloat(live.used) > 0 || live.timeSeconds)) return;
    const prevPreview = this._lastJobDraft?.preview || "";
    const prevEnergy = this._lastJobDraft?.energyKwh;
    this._lastJobDraft = {
      ...live,
      preview: live.preview || prevPreview,
      energyKwh: Number.isFinite(live.energyKwh)
        ? live.energyKwh
        : Number.isFinite(prevEnergy)
          ? prevEnergy
          : "",
    };
    if (result) {
      const previous = this._lastActiveDraft?.jobKey === live.jobKey ? this._lastActiveDraft : null;
      // When the status entity turned terminal; bounds the card's energy window.
      const finishedAt = this._terminalAt();
      this._lastJobDraft = {
        ...this._lastJobDraft, result,
        finishedAt,
        // The card may first see the finish long after it happened (no dashboard open).
        ended: new Date(finishedAt).toISOString(),
        timeSeconds: Math.max(live.timeSeconds || 0, previous?.timeSeconds || 0),
        used: Number.isFinite(parseFloat(live.used)) || Number.isFinite(parseFloat(previous?.used))
          ? Math.max(parseFloat(live.used) || 0, parseFloat(previous?.used) || 0) : "",
        layers: preferLayers(live.layers, previous?.layers),
      };
      this._lastJobDraft.timeLabel = fmtDuration(this._lastJobDraft.timeSeconds);
      this._completedJob = { ...this._lastJobDraft };
      this._finishLookup = this._refineFinishedAt(this._completedJob);
    } else {
      this._lastActiveDraft = { ...this._lastJobDraft };
    }
    const draft = this._lastJobDraft;
    if (!this._lastJobDraft.preview && !this._previewCaptureBusy && this._mayCapturePreview(draft.jobKey)) {
      this._previewCaptureBusy = true;
      try {
        const thumb = await this._capturePreviewThumb();
        if (thumb && this._lastJobDraft === draft) {
          draft.preview = thumb;
          if (this._completedJob?.jobKey === draft.jobKey) this._completedJob.preview = thumb;
        }
      } finally {
        this._previewCaptureBusy = false;
      }
    }
  }

  _terminalAt() {
    const t = Date.parse(this._st("status")?.last_changed);
    return Number.isFinite(t) ? t : Date.now();
  }

  /**
   * The status entity's last change is the finish only if nothing happened
   * since: an HA restart or the printer going offline moves it. Recorder history
   * knows when the job's status first turned completed/stopped after being
   * active; use that when it is earlier, and measure energy and the timelapse
   * wait from it.
   */
  async _refineFinishedAt(job) {
    const id = this._cfg?.status;
    if (!id || !this._hass?.callWS || !Number.isFinite(job?.finishedAt)) return;
    const startMs = Number(job.startTime) * 1000;
    const from = startMs > 1e12 && startMs < job.finishedAt ? startMs : job.finishedAt - 7 * 86400000;
    let states;
    try {
      states = historyStates(await this._fetchHistory(id, from, job.finishedAt + 1000), id);
    } catch (_err) {
      return;
    }
    let active = false;
    let at = null;
    for (const { t, s } of states) {
      const status = s.toLowerCase();
      if (ACTIVE_STATUSES.includes(status)) active = true;
      else if (active && TERMINAL_STATUSES.includes(status)) {
        at = t;
        break;
      }
    }
    if (!Number.isFinite(at) || at >= job.finishedAt || this._completedJob?.jobKey !== job.jobKey) return;
    for (const draft of [this._completedJob, this._lastJobDraft]) {
      if (draft?.jobKey !== job.jobKey) continue;
      draft.finishedAt = at;
      draft.ended = new Date(at).toISOString();
    }
    if (this._timelapse && this._timelapse.key === this._timelapseKey()) this._timelapse.since = at;
    this._trackEnergy();
  }

  /** At most one background thumbnail capture per job per minute. */
  _mayCapturePreview(jobKey) {
    const now = Date.now();
    const last = this._previewAttempt;
    if (last && last.jobKey === jobKey && now - last.at < PREVIEW_RETRY_MS) return false;
    this._previewAttempt = { jobKey, at: now };
    return true;
  }

  _snapshotPrintDraft() {
    if (this._completedJob) return { ...this._completedJob };
    const live = this._livePrintDraft();
    const empty = !live.file && !(parseFloat(live.used) > 0) && !live.timeSeconds;
    if (empty && this._lastJobDraft) {
      return {
        ...this._lastJobDraft,
        ended: new Date().toISOString(),
        layers: preferLayers(live.layers, this._lastJobDraft.layers),
      };
    }
    if (this._lastJobDraft) {
      return {
        ...live,
        preview: live.preview || this._lastJobDraft.preview || "",
        layers: preferLayers(live.layers, this._lastJobDraft.layers),
        energyKwh: Number.isFinite(live.energyKwh)
          ? live.energyKwh
          : this._lastJobDraft.energyKwh,
      };
    }
    return live;
  }

  _writePrintForm(row) {
    this._formJobKey = row.jobKey || "";
    this._formStartTime = rowStartTime(row);
    this._formEnded = row.ended;
    this._formEnergyQuality = row.energyQuality || "partial";
    this._formEnergyBaselineW = row.energyBaselineW;
    this._setText("log-energy-quality", `Energy measurement: ${this._formEnergyQuality}${baselineLabel({ baselineW: row.energyBaselineW })}`);
    const set = (id, value) => {
      const el = this._root.getElementById(id);
      if (el) el.value = value == null || value === "—" ? "" : String(value);
    };
    set("log-ended", toLocalDateTimeValue(row.ended));
    set("log-file", row.file || "");
    set("log-result", row.result || "completed");
    set("log-time", row.timeLabel && row.timeLabel !== "—" ? row.timeLabel : "");
    set("log-layers", row.layers || "");
    set("log-progress", Number.isFinite(row.progress) ? row.progress : "");
    set("log-energy", Number.isFinite(parseFloat(row.energyKwh)) ? Number(row.energyKwh).toFixed(3) : "");
    set("log-energy-cost", row.costPerKwh === "" || row.costPerKwh == null ? this._printPrefs.costPerKwh || "" : row.costPerKwh);
    set("log-used", row.used === "" || row.used == null ? "" : row.used);
    set("log-used-unit", row.usedUnit || "mm");
    this._setFilamentTypeUI(row.filamentType || this._printPrefs.filamentType || "PLA");
    set("log-diameter", row.diameterMm || 1.75);
    set("log-cost", row.costPerKg === "" || row.costPerKg == null ? "" : row.costPerKg);
    set("log-currency", row.currency || "€");
    set("log-notes", row.notes || "");
    this._formPreview = row.preview || "";
  }

  _readPrintForm() {
    const val = (id) => this._root.getElementById(id)?.value ?? "";
    const type = this._getFilamentTypeUI();
    const used = val("log-used");
    const usedUnit = val("log-used-unit").trim() || "mm";
    const diameterMm = parseFloat(val("log-diameter")) || 1.75;
    const costPerKg = val("log-cost");
    const costPerKwh = val("log-energy-cost");
    const currency = val("log-currency").trim() || "€";
    const timeLabel = val("log-time").trim();
    const energyKwh = val("log-energy") === "" ? "" : parseFloat(val("log-energy"));
    const weightG = estimateWeightG(used, usedUnit, type, diameterMm);
    const estimatedCost = estimateCost(weightG, costPerKg);
    const estimatedEnergyCost = estimateEnergyCost(energyKwh, costPerKwh);
    const endedRaw = val("log-ended");
    // The field has minute precision; keep the exact end time unless it was edited.
    const original = this._formEnded ? new Date(this._formEnded) : null;
    const ended = endedRaw && original && !Number.isNaN(original.getTime()) && endedRaw === toLocalDateTimeValue(original)
      ? original.toISOString()
      : endedRaw ? new Date(endedRaw).toISOString() : new Date().toISOString();
    return {
      id: this._editingId || newPrintId(),
      jobKey: this._formJobKey || "",
      startTime: this._formStartTime ?? null,
      energyQuality: this._formEnergyQuality || "partial",
      energyBaselineW: this._formEnergyBaselineW,
      savedAt: new Date().toISOString(),
      ended: Number.isNaN(new Date(ended).getTime()) ? new Date().toISOString() : ended,
      file: val("log-file").trim(),
      result: val("log-result") || "completed",
      timeLabel: timeLabel || "—",
      timeSeconds: parseDurationSeconds(timeLabel),
      layers: val("log-layers").trim(),
      progress: parseFloat(val("log-progress")),
      energyKwh,
      costPerKwh: costPerKwh === "" ? "" : parseFloat(costPerKwh),
      estimatedEnergyCost,
      used: used === "" ? "" : parseFloat(used),
      usedUnit,
      filamentType: type,
      diameterMm,
      costPerKg: costPerKg === "" ? "" : parseFloat(costPerKg),
      currency,
      weightG,
      estimatedCost,
      notes: val("log-notes").trim(),
      preview: this._formPreview || "",
    };
  }

  _applyCostForType() {
    const type = this._getFilamentTypeUI();
    const costEl = this._root.getElementById("log-cost");
    if (!type || !costEl) return;
    const remembered = this._printPrefs.lastCostByType?.[type];
    if (remembered != null && remembered !== "") costEl.value = remembered;
  }

  _refreshPrintEstimate() {
    const row = this._readPrintForm();
    const el = this._root.getElementById("log-est");
    if (!el) return;
    const bits = [];
    if (Number.isFinite(row.weightG)) {
      bits.push(`Est. weight: <b>${esc(fmtWeight(row.weightG))}</b>`);
    }
    if (Number.isFinite(row.estimatedCost)) {
      bits.push(`Filament: <b>${esc(fmtMoney(row.estimatedCost, row.currency))}</b>`);
    } else if (Number.isFinite(parseFloat(row.used))) {
      bits.push("Add cost / kg for filament");
    }
    if (Number.isFinite(row.estimatedEnergyCost)) {
      bits.push(`Energy: <b>${esc(fmtMoney(row.estimatedEnergyCost, row.currency))}</b>`);
    } else if (Number.isFinite(parseFloat(row.energyKwh)) && parseFloat(row.energyKwh) > 0) {
      bits.push("Add cost / kWh for energy");
    }
    const total =
      (Number.isFinite(row.estimatedCost) ? row.estimatedCost : 0) +
      (Number.isFinite(row.estimatedEnergyCost) ? row.estimatedEnergyCost : 0);
    if (Number.isFinite(row.estimatedCost) || Number.isFinite(row.estimatedEnergyCost)) {
      bits.push(`Total: <b>${esc(fmtMoney(total, row.currency))}</b>`);
    }
    el.innerHTML = bits.length
      ? bits.join(" · ")
      : "Add filament and energy costs to estimate the print cost.";
  }

  async _savePrintFromModal() {
    const row = this._readPrintForm();
    const existing = this._prints.find((p) => p.id === row.id);
    if (!row.preview) {
      row.preview = existing?.preview || "";
      if (!this._editingId) {
        row.preview =
          row.preview || this._lastJobDraft?.preview || (await this._capturePreviewThumb()) || "";
      }
    }
    const idx = this._prints.findIndex((p) => p.id === row.id);
    if (idx >= 0) this._prints[idx] = { ...existing, ...row };
    else this._prints.unshift(row);
    this._prints = this._prints.slice(0, PRINT_LIMIT);
    this._printPrefs = {
      ...this._printPrefs,
      filamentType: row.filamentType,
      costPerKg: row.costPerKg,
      costPerKwh: row.costPerKwh,
      diameterMm: row.diameterMm,
      currency: row.currency,
      usedUnit: row.usedUnit,
      lastCostByType: {
        ...(this._printPrefs.lastCostByType || {}),
        ...(Number.isFinite(row.costPerKg) ? { [row.filamentType]: row.costPerKg } : {}),
      },
    };
    if (!this._editingId) {
      this._savedJobFingerprint = this._jobFingerprint(this._lastJobDraft || row);
      this._lastJobDraft = null;
    }
    this._closePrintModal();
    this._syncSaveButton();
    await this._persistPrints();
    this._loadGcodeFiles();
  }

  async _deletePrint(id) {
    if (!id || !confirm("Delete this saved print?")) return;
    this._prints = this._prints.filter((p) => p.id !== id);
    this._deletedIds = [...(this._deletedIds || []).filter((d) => d !== id), id];
    await this._persistPrints();
  }

  /** Jobs that can be printed again: saved G-code copies and the printer's files. */
  async _loadGcodeFiles() {
    if (!this._hass?.callWS || !this._cfg?.status || this._gcodeFilesBusy) return;
    this._gcodeFilesBusy = true;
    try {
      const res = await this._hass.callWS({ type: "creality/gcode_files", entity_id: this._cfg.status });
      this._gcodeFiles = { saved: new Set(res?.saved || []), printer: res?.printer ? new Set(res.printer) : null };
    } catch (_err) {
      this._gcodeFiles = null; // Older integration: no Print again.
    } finally {
      this._gcodeFilesBusy = false;
    }
    this._renderPrintLog();
  }

  /** A saved copy of the row's G-code exists, or the printer still has the file. */
  _canPrintAgain(row) {
    const files = this._gcodeFiles;
    if (!files) return false;
    return files.saved.has(rowStartTime(row)) || Boolean(row.file && files.printer?.has(row.file));
  }

  /** Connected and not running a job. */
  _readyForJob() {
    const status = String(this._val("status", "")).toLowerCase();
    return Boolean(status) && status !== "offline" && !ACTIVE_STATUSES.includes(status);
  }

  async _printAgain(id) {
    const row = this._prints.find((p) => p.id === id);
    if (!row || this._printAgainBusy || !this._readyForJob()) return;
    const name = row.file || "this print";
    if (!confirm(`Print "${name}" again?\n\nMake sure the build plate is clear.`)) return;
    this._printAgainBusy = true;
    this._renderPrintLog();
    try {
      const res = await this._hass.callWS({
        type: "creality/print_again", entity_id: this._cfg.status, print_start_time: rowStartTime(row), file: row.file || null,
      });
      this._notify(`Printing ${name} again${res?.uploaded ? " (copied from the saved G-code)" : ""}`);
    } catch (error) {
      this._notifyError("Couldn't print again", error);
    } finally {
      this._printAgainBusy = false;
      this._renderPrintLog();
    }
  }

  _renderPrintLog() {
    const list = this._root.getElementById("log-list");
    const summary = this._root.getElementById("log-summary");
    const note = this._root.getElementById("log-store-note");
    if (!list) return;

    const ready = this._readyForJob() && !this._printAgainBusy;
    if (!this._prints.length) {
      list.innerHTML = `<div class="log-empty">No saved prints yet. When a print finishes, use Save to history in the banner above.</div>`;
    } else {
      list.innerHTML = this._prints
        .map((p) => {
          const filamentCost = Number.isFinite(p.estimatedCost) ? p.estimatedCost : 0;
          const energyCost = Number.isFinite(p.estimatedEnergyCost) ? p.estimatedEnergyCost : 0;
          const totalCost = filamentCost + energyCost;
          const bits = [
            prettyStatus(p.result),
            fmtSpent(p),
            Number.isFinite(parseFloat(p.used)) ? fmtUsed(p.used, p.usedUnit) : null,
            p.filamentType || null,
            Number.isFinite(parseFloat(p.energyKwh)) ? fmtEnergy(parseFloat(p.energyKwh)) : null,
            p.energyQuality === "partial" ? "Partial energy measurement" : null,
            totalCost > 0 ? fmtMoney(totalCost, p.currency) : null,
          ].filter(Boolean);
          const thumb = p.preview
            ? `<img class="log-thumb" src="${esc(p.preview)}" alt="" />`
            : `<div class="log-thumb empty" aria-hidden="true"></div>`;
          return `<div class="log-row" data-edit="${esc(p.id)}">
            ${thumb}
            <div>
              <b>${esc(p.file || "Untitled print")}</b>
              <span>${esc(fmtDateShort(p.ended))} · ${esc(bits.join(" · "))}</span>
              ${p.notes ? `<span>${esc(p.notes)}</span>` : ""}
            </div>
            <div class="log-acts">
              ${this._canPrintAgain(p) ? `<button class="log-act" type="button" data-repeat="${esc(p.id)}"
                ${ready ? 'title="Print again"' : 'title="Print again (printer busy or offline)" disabled'} aria-label="Print again">
                <ha-icon icon="mdi:printer-3d-nozzle"></ha-icon>
              </button>` : ""}
              <button class="log-act log-del" type="button" title="Delete" data-del="${esc(p.id)}">
                <ha-icon icon="mdi:delete-outline"></ha-icon>
              </button>
            </div>
          </div>`;
        })
        .join("");
    }

    const totalSec = this._prints.reduce((sum, p) => sum + (Number.isFinite(p.timeSeconds) ? p.timeSeconds : 0), 0);
    const totalCost = this._prints.reduce((sum, p) => {
      const filament = Number.isFinite(p.estimatedCost) ? p.estimatedCost : 0;
      const energy = Number.isFinite(p.estimatedEnergyCost) ? p.estimatedEnergyCost : 0;
      return sum + filament + energy;
    }, 0);
    const totalEnergy = this._prints.reduce(
      (sum, p) => sum + (Number.isFinite(parseFloat(p.energyKwh)) ? parseFloat(p.energyKwh) : 0),
      0
    );
    const currency = this._prints.find((p) => p.currency)?.currency || this._printPrefs.currency || "€";
    if (summary) {
      const parts = [
        `${this._prints.length} print${this._prints.length === 1 ? "" : "s"}`,
        fmtDuration(totalSec),
        totalEnergy > 0 ? fmtEnergy(totalEnergy) : null,
        fmtMoney(totalCost, currency),
      ].filter(Boolean);
      summary.textContent = this._prints.length ? parts.join(" · ") : "";
    }
    if (note) {
      note.hidden = !this._usingLocalPrints || !this._prints.length;
      note.textContent = this._usingLocalPrints
        ? "Saved in this browser only. Home Assistant user storage was unavailable."
        : "";
    }
  }

  _setText(id, value) {
    const el = this._root.getElementById(id);
    if (el) el.textContent = value;
  }

  /** Mirror a number entity's min/max onto its input. */
  _applyLimits(inputId, key) {
    const input = this._root.getElementById(inputId);
    const attrs = this._st(key)?.attributes || {};
    if (!input) return;
    if (attrs.min != null) input.min = attrs.min;
    if (attrs.max != null) input.max = attrs.max;
  }

  _setInput(id, value) {
    const el = this._root.getElementById(id);
    if (!el) return;
    if (this._root.activeElement === el) return;
    const next = value == null || value === "" || value === "unavailable" || value === "unknown"
      ? ""
      : String(Math.round(parseFloat(value)) || value);
    if (el.value !== next) el.value = next;
  }

  _update() {
    if (!this._built || !this._cfg) return;

    this._setText("title", this._cfg.title || "Creality Printer");
    if (this._updateOffline()) return;

    const status = this._val("status", "unknown");
    for (const id of ["status-badge", "cam-badge"]) {
      const badge = this._root.getElementById(id);
      if (!badge) continue;
      badge.textContent = prettyStatus(status);
      badge.className = `badge ${statusClass(status)}`;
    }
    this._syncPrinterAlert();
    this._syncFilamentAlert();

    this._syncPrintLayout(status);

    const file = this._val("object");
    this._setText("file", file && file !== "unknown" ? file : "—");

    const layer = this._val("layer");
    const total = this._val("total_layers");
    const layerText = formatLayers(layer, total);
    this._setText("layer", layerText || "—");
    this._setText("cam-layer", layerText ? `Layer ${layerText}` : "");

    const pct = progressPct(this._val("progress"), this._st("progress"));
    const bar = this._root.getElementById("bar");
    if (bar) bar.style.width = `${pct}%`;
    const pctLabel = `${pct.toFixed(0)}%`;
    this._setText("big-pct", pctLabel);
    this._setText("cam-pct", pctLabel);
    this._root.getElementById("ring-fg")?.style.setProperty("stroke-dasharray", `${pct.toFixed(1)} 100`);
    this._root.getElementById("ring")?.classList.toggle("paused", statusClass(status) === "is-pause");

    this._syncTimings(status);

    const usedSt = this._st("used_material");
    const usedRaw = usedSt?.state;
    const usedN = parseFloat(usedRaw);
    const usedOk = usedSt && Number.isFinite(usedN) && !["unknown", "unavailable"].includes(String(usedRaw).toLowerCase());
    const usedText = usedOk
      ? ` · ${num(usedN, usedN >= 100 ? 0 : 1)} ${usedSt.attributes?.unit_of_measurement || "mm"} used`
      : "";
    this._setText("times", usedText ? usedText.slice(3) : "—");

    const filament = this._val("filament");
    const filEl = this._root.getElementById("filament");
    if (filEl) {
      // A runout has its own banner at the top.
      const show = filament && !["unknown", "unavailable", "normal", "runout", ""].includes(String(filament).toLowerCase());
      filEl.textContent = show ? `Filament: ${filament}` : "";
    }

    this._trackEnergy();

    // No job: the image entity may still hold the last job's thumbnail.
    const noJob = this._noJob();
    this._syncMedia("preview", noJob ? "" : this._cfg.preview, false, noJob ? NO_JOB_TEXT : "No preview");
    this._syncLayerOverlay();
    this._syncProfile();
    this._syncCameraViews();

    this._setText("pos-x", num(this._val("position_x")));
    this._setText("pos-y", num(this._val("position_y")));
    this._setText("pos-z", num(this._val("position_z")));

    const speed = this._val("print_tuning") || this._val("print_speed");
    this._setInput("speed", speed);
    this._setInput("flow", this._val("flow_tuning"));
    // Without a speed multiplier the print speed sensor is shown read-only.
    const speedInput = this._root.getElementById("speed");
    if (speedInput) speedInput.disabled = !this._cfg.print_tuning;
    this._applyLimits("speed", "print_tuning");
    this._applyLimits("flow", "flow_tuning");

    this._root.getElementById("fan-model")?.classList.toggle("on", isOn(this._st("model_fan")));
    this._root.getElementById("fan-case")?.classList.toggle("on", isOn(this._st("case_fan")));
    this._root.getElementById("fan-side")?.classList.toggle("on", isOn(this._st("side_fan")));

    this._syncPrintActions(status);

    this._setText("nozzle-now", `${num(this._val("nozzle"), 2)} °C`);
    this._setText("bed-now", `${num(this._val("bed"), 2)} °C`);
    this._setInput("nozzle-target", this._val("nozzle_target"));
    this._setInput("bed-target", this._val("bed_target"));

    this._applyLimits("nozzle-target", "nozzle_target");
    this._applyLimits("bed-target", "bed_target");

    // A job ending adds a G-code copy; a job starting makes the printer busy.
    if (status !== this._gcodeStatus) {
      this._gcodeStatus = status;
      if (this._printsLoaded) this._loadGcodeFiles();
      else this._renderPrintLog();
    }
    this._rememberJobDraft();
    this._syncSaveButton();
    this._sampleTemps();
    this._drawChart();
  }

  _syncMedia(mountId, entityId, stream, emptyLabel) {
    const mount = this._root.getElementById(mountId);
    if (!mount) return;
    const url = this._picture(entityId, stream);
    if (!url) {
      if (mountId === "preview") mount.classList.add("empty"); // Muted text after an image was shown.
      const empty = mount.querySelector(".empty");
      if (!empty) mount.innerHTML = `<div class="empty">${esc(emptyLabel)}</div>`;
      else if (empty.textContent !== emptyLabel) empty.textContent = emptyLabel;
      return;
    }
    let img = mount.querySelector("img");
    if (!img) {
      mount.classList.remove("empty");
      mount.innerHTML = mountId === "preview"
        ? `<div class="layer-stage"><div class="layer-fit"><img alt="Print preview" />
            <div class="layer-overlay" hidden role="progressbar" aria-label="Approximate layer progress" aria-valuemin="0" aria-valuemax="100">
              <div class="layer-remaining"></div><div class="layer-printed"></div><div class="layer-line"></div>
            </div></div></div><div class="layer-caption" hidden></div>`
        : `<img alt="${esc(emptyLabel)}" />`;
      img = mount.querySelector("img");
      if (mountId === "preview") {
        img.onload = () => {
          img.dataset.loaded = "true";
          const stage = mount.querySelector(".layer-stage");
          if (stage && img.naturalWidth && img.naturalHeight) stage.style.setProperty("--ar", String(img.naturalWidth / img.naturalHeight));
          this._syncLayerOverlay();
        };
        img.onerror = () => {
          img.dataset.loaded = "false";
          this._syncLayerOverlay();
        };
      }
    }
    const token = entityId.startsWith("image.") ? url : this._token(entityId) || url;
    if (img.dataset.token !== token) {
      if (mountId === "preview") img.dataset.loaded = "false";
      img.src = url;
      img.dataset.token = token;
    }
  }

  /**
   * MJPEG cameras keep the proxied <img> stream. Cameras that support streaming
   * (Creality WebRTC via HA's go2rtc) embed HA's picture-entity card in live
   * mode, which negotiates WebRTC/HLS itself and follows HA frontend changes.
   */
  _syncCamera(mountId = "camera") {
    const mount = this._root.getElementById(mountId);
    if (!mount) return;
    const entityId = this._cfg?.camera;
    const st = entityId ? this._hass?.states?.[entityId] : undefined;
    const streams = !!st && !isMissingState(st.state) &&
      (Number(st.attributes?.supported_features) & CAMERA_SUPPORT_STREAM) !== 0;
    let live = mount.querySelector(".camera-live");
    if (live && (!streams || live.dataset.entity !== entityId)) {
      live.remove();
      live = null;
    }
    if (!streams) {
      this._syncMedia(mountId, entityId, true, "No camera");
      return;
    }
    if (!live) {
      live = this._createLiveCamera(entityId);
      if (!live) {
        // Helpers still loading or unavailable: show stills meanwhile.
        this._syncMedia(mountId, entityId, false, "No camera");
        return;
      }
      mount.classList.remove("empty");
      mount.replaceChildren(live);
    }
    live.hass = this._hass;
  }

  /** Enlarged camera in a modal dialog; a second live view, dropped again on close. */
  _openCameraZoom() {
    const dialog = this._root.getElementById("camera-zoom");
    if (!dialog || dialog.open || !this._cfg?.camera) return;
    const name = this._st("camera")?.attributes?.friendly_name;
    this._setText("camera-zoom-title", name || "Camera");
    dialog.showModal();
    this._syncCameraViews();
  }

  /**
   * One camera stream at a time: the enlarged view replaces the tile's stream
   * while the dialog is open, and the tile resumes when it closes.
   */
  _syncCameraViews() {
    if (this._root.getElementById("camera-zoom")?.open) {
      this._root.getElementById("camera")?.querySelector("img, .camera-live")?.remove();
      this._syncCamera("camera-zoom-body");
      this._syncZoomInfo();
    } else {
      this._syncCamera();
    }
  }

  _closeCameraZoom() {
    const dialog = this._root.getElementById("camera-zoom");
    if (!dialog?.open) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    dialog.close();
  }

  /**
   * Row 1 tiles and row 2 details follow the card configuration only: a tile or
   * line whose entity is not selected in the editor is removed, not left empty.
   */
  _syncPrintLayout(status) {
    const cfg = this._cfg;
    const show = (id, visible) => {
      const el = this._root.getElementById(id);
      if (!el) return;
      el.hidden = !visible;
      // SVG elements have no hidden property; set the attribute (CSS hides it).
      if (el.namespaceURI === "http://www.w3.org/2000/svg") el.toggleAttribute("hidden", !visible);
    };
    const hiddenTiles = Array.isArray(cfg.hide_tiles) ? cfg.hide_tiles : [];
    // The G-code profile is requested through the print status entity.
    const tiles = {
      camera: !!cfg.camera,
      profile: !!cfg.status && !hiddenTiles.includes("profile"),
      preview: !!cfg.preview && !hiddenTiles.includes("preview"),
    };
    // No job: both tiles would say so; the profile tile alone spans their slots.
    const noJob = this._noJob(status);
    const merged = noJob && tiles.profile && tiles.preview;
    show("camera-tile", tiles.camera);
    show("profile-tile", tiles.profile);
    show("preview-tile", tiles.preview && !merged);
    this._root.getElementById("profile-tile")?.classList.toggle("tile-wide", merged);
    const row = this._root.getElementById("media-row");
    if (row) {
      const units = (tiles.camera ? 2 : 0) + (tiles.profile ? 1 : 0) + (tiles.preview ? 1 : 0);
      const small = (tiles.profile ? 1 : 0) + (tiles.preview ? 1 : 0);
      row.hidden = !units;
      row.classList.toggle("has-camera", tiles.camera);
      row.style.setProperty("--media-cols", String(Math.max(units, 1)));
      row.style.setProperty("--media-cols-narrow", String(Math.max(small, 1)));
    }
    const camTile = this._root.getElementById("camera-tile");
    if (camTile) {
      const aspect = CAMERA_ASPECTS.includes(cfg.camera_aspect) ? cfg.camera_aspect : "16:9";
      for (const value of CAMERA_ASPECTS) camTile.classList.toggle(`ar-${value.replace(":", "-")}`, value === aspect);
    }
    if (!tiles.camera) this._closeCameraZoom();
    // The status bar sits over the camera; without one it becomes a strip in row 2.
    const camBar = this._root.getElementById("cam-bar");
    const barHome = tiles.camera ? camTile : this._root.getElementById("bar-slot");
    if (camBar && barHome && camBar.parentNode !== barHome) barHome.append(camBar);
    show("camera-expand", tiles.camera);
    show("ring", !noJob && !!cfg.progress);
    show("cam-pct", !noJob && !!cfg.progress);
    show("cam-badge", !!cfg.status);
    show("cam-layer", !noJob && !!cfg.layer);
    show("cam-bar", tiles.camera || !!(cfg.progress || cfg.status || cfg.pause || cfg.resume || cfg.stop));

    // No job: percentage, file, layer, bar, estimates and material used are hidden.
    show("progress-head", !noJob && !!(cfg.progress || cfg.time_left));
    show("big-pct", !!cfg.progress);
    show("file-row", !noJob && !!cfg.object);
    show("layer-row", !noJob && !!cfg.layer);
    show("meta-head", !noJob && !!(cfg.object || cfg.layer));
    show("bar-row", !noJob && !!cfg.progress);
    show("timing-real", !!cfg.job_time);
    show("timing-creality", !!cfg.time_left);
    show("timings", !noJob && !!(cfg.job_time || cfg.time_left));
    show("times", !noJob && !!cfg.used_material);

    // Controls: speed/flow, home, fans and X/Y/Z, each only when configured.
    show("home", !!cfg.home);
    show("speed-field", !!(cfg.print_tuning || cfg.print_speed));
    show("flow-field", !!cfg.flow_tuning);
    show("filament-change", !!cfg.nozzle_target);
    show("ctrl-row", !!(cfg.home || cfg.print_tuning || cfg.print_speed || cfg.flow_tuning || cfg.nozzle_target));
    const fans = { "fan-model": "model_fan", "fan-case": "case_fan", "fan-side": "side_fan" };
    for (const [id, key] of Object.entries(fans)) {
      const field = this._root.getElementById(id)?.closest?.(".field");
      if (field) field.hidden = !cfg[key];
    }
    show("fan-row", !!(cfg.model_fan || cfg.case_fan || cfg.side_fan));
    show("coord-x", !!cfg.position_x);
    show("coord-y", !!cfg.position_y);
    show("coord-z", !!cfg.position_z);
    show("coords", !!(cfg.position_x || cfg.position_y || cfg.position_z));
    show("controls-panel", !!(cfg.home || cfg.print_tuning || cfg.print_speed || cfg.flow_tuning || cfg.nozzle_target ||
      cfg.model_fan || cfg.case_fan || cfg.side_fan || cfg.position_x || cfg.position_y || cfg.position_z));
  }

  /** Pause/Resume/Stop in the status bar: configured buttons that apply right now. */
  _syncPrintActions(status) {
    const st = String(status).toLowerCase();
    const printing = ["printing", "resuming", "pausing"].includes(st);
    const paused = st === "paused";
    // A job that is still heating/preparing ("processing") can be stopped too.
    const stoppable = printing || paused || st === "processing";
    const set = (id, key, applies) => {
      const btn = this._root.getElementById(id);
      if (!btn) return;
      btn.hidden = !this._cfg[key] || !applies;
      btn.disabled = !applies;
    };
    set("pause", "pause", printing);
    set("resume", "resume", paused);
    set("stop", "stop", stoppable);
  }

  /** Status, progress and layer under the enlarged camera. */
  _syncZoomInfo() {
    const parts = [];
    const layerText = formatLayers(this._val("layer"), this._val("total_layers"));
    if (this._cfg.status) parts.push(prettyStatus(this._val("status", "unknown")));
    if (this._cfg.progress) parts.push(`${progressPct(this._val("progress"), this._st("progress")).toFixed(0)}%`);
    if (this._cfg.layer && layerText) parts.push(`Layer ${layerText}`);
    const eta = this._zoomEta();
    if (eta) parts.push(eta);
    this._setText("camera-zoom-info", parts.join(" · "));
  }

  /** Time left and finish clock for the enlarged camera's status line. */
  _zoomEta() {
    return this._root.getElementById("progress-eta")?.textContent || "";
  }

  _toggleZoomFullscreen() {
    const body = this._root.getElementById("camera-zoom-body");
    if (!body) return;
    // Fullscreen lives on the document, not the shadow root.
    if (document.fullscreenElement) document.exitFullscreen?.();
    else body.requestFullscreen?.().catch((error) => this._notifyError("Fullscreen unavailable", error));
  }

  async _downloadSnapshot() {
    const entityId = this._cfg?.camera;
    const token = this._token(entityId);
    if (!entityId || !token) {
      this._notifyError("Camera snapshot unavailable");
      return;
    }
    try {
      const res = await fetch(`/api/camera_proxy/${entityId}?token=${token}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
      link.href = url;
      link.download = `${entityId.split(".")[1]}-${stamp}.jpg`;
      this._root.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      this._notifyError("Camera snapshot failed", error);
    }
  }

  _createLiveCamera(entityId) {
    if (!this._cardHelpers) {
      this._loadCardHelpers();
      return null;
    }
    try {
      const card = this._cardHelpers.createCardElement({
        type: "picture-entity",
        entity: entityId,
        camera_view: "live",
        show_name: false,
        show_state: false,
        tap_action: { action: "none" },
        hold_action: { action: "none" },
      });
      card.classList.add("camera-live");
      card.dataset.entity = entityId;
      return card;
    } catch (error) {
      console.warn("Creality card: live camera view unavailable", error);
      return null;
    }
  }

  _loadCardHelpers() {
    if (this._cardHelpersRequested || typeof window.loadCardHelpers !== "function") return;
    this._cardHelpersRequested = true;
    window.loadCardHelpers()
      .then((helpers) => {
        this._cardHelpers = helpers;
        if (this._built) this._syncCameraViews();
      })
      .catch((error) => console.warn("Creality card: card helpers unavailable", error));
  }

  _syncLayerOverlay() {
    const mount = this._root.getElementById("preview");
    const overlay = mount?.querySelector(".layer-overlay");
    const caption = mount?.querySelector(".layer-caption");
    if (!overlay || !caption) return;
    const status = String(this._val("status", "")).toLowerCase();
    const attrs = this._st("status")?.attributes || {};
    const key = [this._cfg.preview, attrs.print_start_time, attrs.print_id, this._val("object")].join("|");
    let progress = layerPreviewProgress(this._val("layer"), this._val("total_layers"), status, attrs.state_raw);
    if (progress?.paused && this._layerOverlayState?.key === key && this._layerOverlayState.progress.paused) {
      progress = this._layerOverlayState.progress;
    }
    this._layerOverlayState = progress ? { key, progress } : null;
    // The G-code profile shows the same progress more accurately; draw the
    // thumbnail overlay only when the profile tile is not on screen.
    const visible = !!progress && !this._profileShown() && mount.querySelector("img")?.dataset.loaded === "true";
    overlay.hidden = caption.hidden = !visible;
    if (!visible) {
      mount.title = "";
      return;
    }
    overlay.style.setProperty("--layer-progress", `${progress.fraction * 100}%`);
    overlay.classList.toggle("paused", progress.paused);
    overlay.setAttribute("aria-valuenow", String(progress.percent));
    const text = layerProgressText(progress);
    overlay.setAttribute("aria-valuetext", text);
    caption.innerHTML = `${esc(text)}<small>Approximate layer view</small>`;
    mount.title = "Layer-count progress over the printer thumbnail; not an exact model cross-section.";
  }

  /** True while the G-code profile silhouette is drawn in a visible tile. */
  _profileShown() {
    if (!this._profile) return false;
    const tile = this._root?.getElementById("profile-tile");
    const box = this._root?.getElementById("profile");
    return !!tile && !tile.hidden && !!box && !box.hidden;
  }

  /** Job identity for the G-code profile; empty when no file is loaded. */
  _profileJobKey() {
    const attrs = this._st("status")?.attributes || {};
    return this._cfg?.status && attrs.file ? `${this._cfg.status}|${attrs.file}|${attrs.print_start_time ?? ""}` : "";
  }

  _syncProfile() {
    // Hidden in the editor: nothing to show, so do not ask the integration.
    const hidden = Array.isArray(this._cfg?.hide_tiles) && this._cfg.hide_tiles.includes("profile");
    const key = hidden || this._noJob() ? "" : this._profileJobKey();
    if (key !== this._profileKey) {
      this._profileKey = key;
      this._profile = null;
      this._profileStatus = undefined;
      clearTimeout(this._profileTimer);
      this._profileTimer = undefined;
      if (key) this._fetchProfile(key);
    }
    this._drawProfile();
  }

  async _fetchProfile(key) {
    if (!this._hass?.callWS) return;
    let res = null;
    try {
      res = await this._hass.callWS({ type: "creality/print_profile", entity_id: this._cfg.status });
    } catch (_err) {
      // Not served (e.g. older integration).
      if (key === this._profileKey) {
        this._profileStatus = "unavailable";
        this._drawProfile();
      }
      return;
    }
    if (key !== this._profileKey) return;
    const file = this._st("status")?.attributes?.file;
    this._profileStatus = res?.status;
    if (res?.status === "ready" && res.profile && res.file === file) {
      this._profile = res.profile;
      this._drawProfile();
      return;
    }
    this._drawProfile();
    // Ask again while downloading or racing a job change; failures retry slowly
    // (the integration re-downloads after a few minutes). "unavailable" is final.
    let wait = 0;
    // "pending": the integration starts the download once the printer leaves idle.
    if (["loading", "pending"].includes(res?.status) || res?.file !== file) wait = 5000;
    else if (res?.status === "failed") wait = 60000;
    if (!wait) return;
    this._profileTimer = setTimeout(() => {
      this._profileTimer = undefined;
      if (key === this._profileKey) this._fetchProfile(key);
    }, wait);
  }

  _drawProfile() {
    const box = this._root?.getElementById("profile");
    const svg = this._root?.getElementById("profile-svg");
    if (!box || !svg) return;
    const profile = this._profile;
    // The profile has its own tile; without one, the tile says why.
    const empty = this._root.getElementById("profile-empty");
    box.hidden = !profile;
    if (empty) {
      empty.hidden = !!profile;
      empty.textContent = profileEmptyText(this._profileKey, this._profileStatus);
    }
    this._syncLayerOverlay();
    if (!profile) return;
    const axis = this._profileAxis === "y" ? "y" : "x";
    const status = String(this._val("status", "")).toLowerCase();
    const attrs = this._st("status")?.attributes || {};
    const progress = layerPreviewProgress(this._val("layer"), this._val("total_layers"), status, attrs.state_raw);
    const printed = progress ? Math.round(progress.fraction * profile.layers) : 0;
    // Temperatures update the card every few seconds; redraw only on change.
    const text = progress ? layerProgressText(progress) : `${profile.layers} layers`;
    const drawn = { profile, axis, printed, text, paused: !!progress?.paused };
    const last = this._profileDrawn;
    if (last && Object.keys(drawn).every((k) => last[k] === drawn[k])) return;
    this._profileDrawn = drawn;
    const drawing = CrealityCard.profileSvg(profile, axis, printed);
    svg.setAttribute("viewBox", drawing.viewBox);
    svg.innerHTML = drawing.body;
    box.classList.toggle("paused", !!progress?.paused);
    const view = axis === "x" ? "Front" : "Side";
    const caption = this._root.getElementById("profile-caption");
    if (caption) caption.innerHTML = `${esc(text)}<small>Approximate layer view · ${view}</small>`;
    box.title = `${view} silhouette from the job's G-code (${axis === "x" ? "X" : "Y"} against Z). Click to switch view.`;
    box.setAttribute("aria-label", `Print profile, ${view.toLowerCase()} view, ${text}`);
  }

  /**
   * SVG body for a G-code silhouette: layers below `printed` are filled, the
   * rest dimmed, with a line at the current layer. Units are millimetres.
   */
  static profileSvg(profile, axis, printed) {
    const zs = profile.z || [];
    const data = profile[axis] || { size: 0, bands: [] };
    const width = Math.max(1, Number(data.size) || 0);
    const top = zs.length ? zs[zs.length - 1] : 0;
    // Keep flat parts visible; the drawing sits on the bottom edge.
    const height = Math.max(top, width * 0.12, 1);
    const yOf = (z) => height - z;
    const paths = { printed: [], remaining: [] };
    const rect = (target, a, b, spans) => {
      const z0 = a > 0 ? zs[a - 1] : 0;
      const z1 = zs[b];
      if (!(z1 > z0)) return;
      for (const [s0, s1] of spans) {
        const w = Math.max(s1 - s0, 0.5);
        paths[target].push(`M${s0} ${(yOf(z1)).toFixed(2)}h${w}V${yOf(z0).toFixed(2)}h${-w}z`);
      }
    };
    for (const [a, b, spans] of data.bands || []) {
      if (b < printed) rect("printed", a, b, spans);
      else if (a >= printed) rect("remaining", a, b, spans);
      else {
        rect("printed", a, printed - 1, spans);
        rect("remaining", printed, b, spans);
      }
    }
    let body = Object.entries(paths)
      .filter(([, d]) => d.length)
      .map(([cls, d]) => `<path class="${cls}" d="${d.join("")}"/>`)
      .join("");
    if (printed > 0 && printed < zs.length) {
      const y = yOf(zs[printed - 1]).toFixed(2);
      body += `<line class="cursor" x1="0" x2="${width}" y1="${y}" y2="${y}" vector-effect="non-scaling-stroke"/>`;
    }
    return { viewBox: `0 0 ${width} ${height}`, body };
  }

  _sampleTemps() {
    const now = Date.now();
    if (this._lastSample && now - this._lastSample < 5000) return;
    this._lastSample = now;
    const nozzle = parseFloat(this._val("nozzle"));
    const bed = parseFloat(this._val("bed"));
    if (!Number.isFinite(nozzle) && !Number.isFinite(bed)) return;
    this._samples.push({ t: now, nozzle, bed });
    if (this._samples.length > 80) this._samples.shift();
  }

  async _loadHistory() {
    if (!this._hass || this._histBusy) return;
    const ids = [this._cfg.nozzle, this._cfg.bed].filter((id) => id && this._hass.states[id]);
    if (!ids.length) return;
    this._histBusy = true;
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 60 * 1000);
    try {
      const data = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        entity_ids: ids,
        significant_changes_only: false,
        minimal_response: true,
        no_attributes: true,
      });
      this._history = data || {};
      this._drawChart();
    } catch (_err) {
      try {
        const path = `history/period/${start.toISOString()}?filter_entity_id=${ids.join(",")}&end_time=${end.toISOString()}`;
        this._history = await this._hass.callApi("GET", path);
        this._drawChart();
      } catch (_err2) {
        /* live samples still draw */
      }
    } finally {
      this._histBusy = false;
    }
  }

  _series(entityKey, sampleKey) {
    const fromHist = parseHistorySeries(this._history, this._cfg[entityKey]);
    if (fromHist.filter((p) => Number.isFinite(p.v)).length > 1) return fromHist;
    return this._samples
      .filter((s) => Number.isFinite(s[sampleKey]))
      .map((s) => ({ t: s.t, v: s[sampleKey] }));
  }

  _drawChart() {
    const svg = this._root.getElementById("chart");
    if (!svg) return;
    const nozzle = this._series("nozzle", "nozzle");
    const bed = this._series("bed", "bed");
    const all = [...nozzle, ...bed].filter((p) => Number.isFinite(p.v));
    const w = 320;
    const h = 120;
    const padL = 28;
    const padR = 6;
    const padT = 8;
    const padB = 16;
    const minT = all.length ? Math.min(...all.map((p) => p.t)) : Date.now() - 1800000;
    const maxT = all.length ? Math.max(...all.map((p) => p.t)) : Date.now();
    const maxV = Math.max(60, ...all.map((p) => p.v), 0);
    const minV = 0;
    const x = (t) => padL + ((t - minT) / Math.max(1, maxT - minT)) * (w - padL - padR);
    const y = (v) => padT + (1 - (v - minV) / Math.max(1, maxV - minV)) * (h - padT - padB);

    const path = (pts, color) => {
      let pen = "M";
      const d = pts
        .map((p) => {
          if (!Number.isFinite(p.v)) {
            pen = "M";
            return "";
          }
          const seg = `${pen}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
          pen = "L";
          return seg;
        })
        .filter(Boolean)
        .join(" ");
      if (!d) return "";
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" />`;
    };

    const ticks = [0, Math.round(maxV / 2), Math.round(maxV)];
    const grid = ticks
      .map((v) => {
        const yy = y(v).toFixed(1);
        return `<line x1="${padL}" x2="${w - padR}" y1="${yy}" y2="${yy}" style="stroke: var(--cp-border)" />
          <text x="2" y="${Number(yy) + 3}" style="fill: var(--cp-muted)" font-size="8">${v}</text>`;
      })
      .join("");

    svg.innerHTML = `${grid}${path(nozzle, "#e85d4c")}${path(bed, "#4b9fff")}`;
  }
}

const COMPACT_TAG = "creality-compact-card";

// Config keys the compact card uses; all share their meaning with the full card.
const COMPACT_KEYS = [
  "title", "status", "camera", "preview", "progress", "object", "layer", "total_layers", "job_time",
  "time_left", "filament", "print_energy",
  "printer_switch", "pause", "resume", "stop",
];

const COMPACT_LABELS = {
  preview: "Printer thumbnail",
  print_energy: "Power sensor",
};

const COMPACT_HELPERS = {
  preview: "Shown in the G-code tile while the G-code view is not available.",
  print_energy: "Power (W) sensor of the printer's plug or room meter. The card shows the printer's share, without the power offset set on the full card (else the reading before the printer was switched on).",
};

/**
 * custom:creality-compact-card: camera, G-code view, status, progress, layers,
 * finish time and power in a small tile. Shares the full card's
 * camera, G-code profile, banner and power-on code by extending it.
 */
class CrealityCompactCard extends CrealityCard {
  static async getStubConfig(hass, entities, entitiesFallback) {
    const defaults = await integrationDefaults(hass, entities, entitiesFallback);
    return Object.fromEntries(Object.entries(defaults).filter(([key]) => COMPACT_KEYS.includes(key)));
  }

  static getConfigForm() {
    const entity = (name, domain) => ({ name, selector: { entity: { domain } } });
    const group = (name, title, schema) => ({ name, type: "expandable", flatten: true, title, schema });
    return {
      schema: [
        { name: "title", selector: { text: {} } },
        entity("status", "sensor"),
        entity("camera", "camera"),
        entity("preview", "image"),
        group("print_group", "Print", ["progress", "object", "layer", "total_layers", "job_time", "time_left", "filament"]
          .map((name) => entity(name, "sensor"))),
        group("power_group", "Power", [entity("print_energy", "sensor"), entity("printer_switch", "switch")]),
        group("print_actions_group", "Print actions", ["pause", "resume", "stop"].map((name) => entity(name, "button"))),
      ],
      computeLabel: (schema) => COMPACT_LABELS[schema.name] || LABELS[schema.name] || undefined,
      computeHelper: (schema) => COMPACT_HELPERS[schema.name] || HELPERS[schema.name] || undefined,
    };
  }

  setConfig(config) {
    const nested = config.entities && typeof config.entities === "object" ? config.entities : {};
    // No default title: without one the header holds only the status.
    this._cfg = { ...nested, ...config };
    delete this._cfg.entities;
    this._built = false;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) {
      this._render();
      return;
    }
    if (this._watchedChanged(hass)) this._update();
  }

  get hass() {
    return this._hass;
  }

  getCardSize() {
    return 5;
  }

  getGridOptions() {
    return { columns: 6, rows: "auto", min_columns: 4, min_rows: 3 };
  }

  connectedCallback() {
    if (this._cfg && this._hass && !this._built) this._render();
    else if (this._built) this._update();
  }

  disconnectedCallback() {
    // Stop the camera stream and profile polling while the card is not shown.
    clearTimeout(this._profileTimer);
    this._profileTimer = undefined;
    this._profileKey = undefined;
    this._closeCameraZoom();
    this._root.getElementById("camera")?.querySelector("img, .camera-live")?.remove();
  }

  _render() {
    if (!this._cfg) return;
    this._root.innerHTML = `
      <ha-card>
        <style>
          :host { display: block; container-type: inline-size; container-name: creality-compact; }
          [hidden] { display: none !important; }
          ha-card {
            --cp-bg: var(--ha-card-background, var(--card-background-color, #1b1b1b));
            --cp-border: var(--divider-color, #3c3c3c);
            --cp-text: var(--primary-text-color, #f2f2f2);
            --cp-muted: var(--secondary-text-color, #9a9a9a);
            --cp-input: var(--input-fill-color, var(--card-background-color, #1f1f1f));
            --cp-inset: var(--primary-background-color, #141414);
            --cp-accent: var(--creality-accent-color, #2dce89);
            background: var(--cp-bg);
            color: var(--cp-text);
            border: 1px solid var(--cp-border);
            overflow: hidden;
          }
          .wrap { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
          .head { display: flex; align-items: center; gap: 8px; }
          .title { flex: 1 1 auto; min-width: 0; font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .badge { margin-left: auto; flex: none; font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 999px; background: #4a4a4a; color: #fff; }
          .badge.is-print { background: var(--cp-accent); color: #083322; }
          .badge.is-pause { background: #fc6d09; }
          .badge.is-error { background: #e5484d; }
          .badge.is-idle { background: #5c5c5c; }
          .offline-notice { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; color: var(--cp-muted); }
          #printer-loading { width: 14px; height: 14px; border: 2px solid var(--cp-border); border-top-color: var(--cp-accent); border-radius: 50%; animation: printer-spin 0.8s linear infinite; }
          @keyframes printer-spin { to { transform: rotate(360deg); } }
          @media (prefers-reduced-motion: reduce) { #printer-loading { animation: none; } }
          #printer-power-error { color: var(--error-color, #e85d4c); }
          .wrap.offline .body, .wrap.offline .alert { display: none; }
          .act, .icon-btn, .bar-btn {
            border: 1px solid var(--cp-border); background: var(--cp-input); color: var(--cp-text);
            border-radius: 8px; cursor: pointer; font: inherit; display: inline-flex; align-items: center; justify-content: center;
          }
          .act { padding: 5px 10px; font-size: 12px; font-weight: 600; gap: 6px; }
          .icon-btn { width: 40px; height: 34px; }
          .bar-btn { width: 30px; height: 28px; padding: 0; flex: none; }
          .act:hover, .icon-btn:hover, .bar-btn:hover, .bar-btn:focus-visible { border-color: var(--cp-accent); outline: none; }
          .bar-btn.stop:hover { border-color: #e5484d; color: #e5484d; }
          .act[disabled], .bar-btn[disabled] { opacity: 0.35; cursor: default; }
          .bar-btn ha-icon, .icon-btn ha-icon { --mdc-icon-size: 18px; }
          .alert {
            display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; font-size: 12px;
            background: #3b2c1b; border: 1px solid #bb8b47;
          }
          .alert.is-error { background: #3b1d1f; border-color: #e5484d; }
          .alert > ha-icon { flex: none; color: #fc6d09; --mdc-icon-size: 18px; }
          .alert.is-error > ha-icon { color: #e5484d; }
          .alert-title { flex: 1 1 auto; min-width: 0; font-weight: 600; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
          .alert .act { flex: none; }
          .alert-close { flex: none; display: inline-flex; padding: 2px; border: 0; border-radius: 6px; background: none; color: var(--cp-muted); cursor: pointer; }
          .alert-close:hover { color: var(--cp-text); background: #ffffff14; }
          .alert-close ha-icon { --mdc-icon-size: 16px; }
          .body { display: flex; flex-direction: column; gap: 8px; }
          .media { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 8px; }
          .media.single { grid-template-columns: minmax(0, 1fr); }
          .cam { position: relative; min-width: 0; }
          .camera-body {
            aspect-ratio: 16 / 9; background: var(--cp-inset); border: 1px solid var(--cp-border);
            border-radius: 8px; overflow: hidden; cursor: zoom-in;
          }
          /* Streaming (WebRTC) cameras embed HA's own live view and size to the video. */
          .camera-body:has(.camera-live) { aspect-ratio: auto; }
          .camera-body img { width: 100%; height: 100%; object-fit: cover; display: block; }
          .camera-body .empty, .thumb.empty {
            height: 100%; display: flex; align-items: center; justify-content: center; text-align: center;
            padding: 6px; box-sizing: border-box; color: var(--cp-muted); font-size: 12px;
          }
          .camera-live {
            display: block; --ha-card-border-width: 0; --ha-card-border-radius: 0;
            --ha-card-box-shadow: none; --ha-card-background: transparent;
          }
          .cam .bar-btn { position: absolute; right: 6px; bottom: 6px; background: #0009; border-color: #ffffff40; color: #fff; }
          /* The G-code tile takes the camera's height and never sets it. */
          .gcode { position: relative; min-width: 0; min-height: 90px; }
          .media.single .gcode { height: 120px; }
          .thumb {
            position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
            background: var(--cp-inset); border: 1px solid var(--cp-border); border-radius: 8px; overflow: hidden;
          }
          .thumb img { width: 100%; height: 100%; object-fit: contain; display: block; }
          .profile { padding: 0; color: inherit; font: inherit; cursor: pointer; }
          .profile:hover, .profile:focus-visible { border-color: var(--cp-accent); outline: none; }
          .profile-stage { display: block; width: 100%; height: 100%; box-sizing: border-box; padding: 6px; }
          .profile svg { width: 100%; height: 100%; display: block; overflow: visible; }
          .profile .printed { fill: var(--cp-accent); }
          .profile .remaining { fill: var(--cp-muted); opacity: .35; }
          .profile .cursor { stroke: var(--cp-accent); stroke-width: 1.5; }
          .profile.paused .cursor { stroke: #ffb34d; }
          .layer-caption { display: none; }
          .job { display: flex; flex-direction: column; gap: 4px; }
          .job-line { display: flex; align-items: center; gap: 8px; min-height: 28px; }
          .file { flex: 1 1 auto; min-width: 0; font-size: 13px; color: var(--cp-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .pct { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
          .acts { display: flex; gap: 4px; }
          .bar { height: 6px; background: var(--cp-inset); border-radius: 99px; overflow: hidden; }
          .bar > span { display: block; height: 100%; width: 0%; background: var(--cp-accent); }
          .bar.paused > span { background: #fc6d09; }
          /* The shown stats share one row. */
          .stats { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 6px; }
          /* Phones: values keep the room, icons go. */
          @container creality-compact (max-width: 400px) {
            .stat { padding: 5px 6px; }
            .stat > ha-icon { display: none; }
          }
          @container creality-compact (max-width: 360px) {
            .stats { grid-auto-flow: row; grid-template-columns: repeat(2, minmax(0, 1fr)); }
          }
          .stat {
            display: flex; align-items: center; gap: 6px; min-width: 0; padding: 5px 8px; cursor: pointer;
            background: var(--cp-inset); border: 1px solid var(--cp-border); border-radius: 8px;
          }
          .stat > ha-icon { flex: none; color: var(--cp-muted); --mdc-icon-size: 18px; }
          .stat > div { min-width: 0; }
          .stat span, .stat small { display: block; font-size: 10px; color: var(--cp-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .stat span { text-transform: uppercase; letter-spacing: 0.03em; }
          .stat b { display: block; font-size: 13px; font-weight: 650; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .stat small:empty { display: none; }
          .camera-zoom {
            width: min(96vw, calc((90vh - 96px) * 16 / 9), 1600px); max-width: 96vw; padding: 0;
            border: 1px solid var(--cp-border); border-radius: 12px; background: var(--cp-bg); color: var(--cp-text); overflow: hidden;
          }
          .camera-zoom::backdrop { background: #000c; }
          .camera-zoom-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 8px 8px 14px; font-size: 14px; font-weight: 600; }
          .camera-zoom-acts { display: flex; gap: 6px; }
          .camera-zoom-body { background: #000; }
          .camera-zoom-body img { width: 100%; max-height: calc(90vh - 96px); object-fit: contain; display: block; }
          .camera-zoom-body:fullscreen { display: flex; align-items: center; justify-content: center; }
          .camera-zoom-body:fullscreen img, .camera-zoom-body:fullscreen .camera-live { width: 100%; max-height: 100vh; }
          .camera-zoom-body .empty { padding: 48px; text-align: center; color: var(--cp-muted); }
          .camera-zoom-f { padding: 8px 14px; font-size: 13px; color: var(--cp-muted); font-variant-numeric: tabular-nums; }
          .camera-zoom-f:empty { display: none; }
        </style>
        <div class="wrap">
          <div class="head">
            <span class="title" id="title"></span>
            <span class="badge" id="status-badge" data-more="status">—</span>
          </div>
          <div class="offline-notice" id="offline-notice" hidden>
            <span id="printer-loading" hidden aria-hidden="true"></span>
            <span id="offline-message" role="status" aria-live="polite">Printer is offline.</span>
            <button class="act" id="printer-power" type="button" hidden></button>
            <span id="printer-power-error" role="alert"></span>
          </div>
          <div class="alert" id="printer-alert" role="alert" hidden>
            <ha-icon id="printer-alert-icon" icon="mdi:alert"></ha-icon>
            <span class="alert-title" id="printer-alert-title"></span>
            <button class="alert-close" id="printer-alert-close" type="button" title="Dismiss" aria-label="Dismiss printer alert">
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>
          <div class="alert is-error" id="filament-alert" role="alert" hidden>
            <ha-icon icon="mdi:printer-3d-nozzle-alert"></ha-icon>
            <span class="alert-title">Filament runout</span>
            <button class="act" id="filament-heat" type="button" hidden></button>
            <button class="alert-close" id="filament-alert-close" type="button" title="Dismiss" aria-label="Dismiss filament runout alert">
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>
          <div class="body">
            <div class="media" id="media">
              <div class="cam" id="camera-tile">
                <div class="camera-body" id="camera" title="Enlarge camera"><div class="empty">No camera</div></div>
                <button class="bar-btn" id="camera-expand" type="button" title="Enlarge camera" aria-label="Enlarge camera"><ha-icon icon="mdi:arrow-expand"></ha-icon></button>
              </div>
              <div class="gcode" id="gcode-tile">
                <button class="thumb profile" id="profile" type="button" hidden>
                  <span class="profile-stage"><svg id="profile-svg" preserveAspectRatio="xMidYMax meet" aria-hidden="true"></svg></span>
                  <span class="layer-caption" id="profile-caption"></span>
                </button>
                <div class="thumb" id="thumb" data-more="preview" hidden></div>
                <div class="thumb empty" id="profile-empty">No G-code profile</div>
              </div>
            </div>
            <div class="job" id="job">
              <div class="job-line">
                <span class="file" id="file" data-more="object"></span>
                <b class="pct" id="pct" data-more="progress">—</b>
                <div class="acts">
                  <button class="bar-btn" id="pause" type="button" title="Pause print" aria-label="Pause print"><ha-icon icon="mdi:pause"></ha-icon></button>
                  <button class="bar-btn" id="resume" type="button" title="Resume print" aria-label="Resume print"><ha-icon icon="mdi:play"></ha-icon></button>
                  <button class="bar-btn stop" id="stop" type="button" title="Stop print" aria-label="Stop print"><ha-icon icon="mdi:stop"></ha-icon></button>
                </div>
              </div>
              <div class="bar" id="bar-row"><span id="bar"></span></div>
            </div>
            <div class="stats" id="stats">
              <div class="stat" id="stat-layer" data-more="layer"><ha-icon icon="mdi:layers-triple"></ha-icon>
                <div><span>Layer</span><b id="c-layer">—</b></div></div>
              <div class="stat" id="stat-eta" data-more="time_left"><ha-icon icon="mdi:flag-checkered"></ha-icon>
                <div><span>ETA</span><b id="c-eta">—</b><small id="c-eta-left"></small></div></div>
              <div class="stat" id="stat-elapsed" data-more="job_time"><ha-icon icon="mdi:timer-outline"></ha-icon>
                <div><span>Elapsed</span><b id="c-elapsed">—</b></div></div>
              <div class="stat" id="stat-power" data-more="print_energy"><ha-icon icon="mdi:flash"></ha-icon>
                <div><span id="c-power-label">Power</span><b id="c-power">—</b></div></div>
            </div>
          </div>
        </div>
        <dialog class="camera-zoom" id="camera-zoom" aria-labelledby="camera-zoom-title">
          <div class="camera-zoom-h">
            <span id="camera-zoom-title">Camera</span>
            <div class="camera-zoom-acts">
              <button class="icon-btn" id="camera-zoom-snapshot" type="button" title="Download snapshot" aria-label="Download snapshot">
                <ha-icon icon="mdi:camera"></ha-icon>
              </button>
              <button class="icon-btn" id="camera-zoom-fullscreen" type="button" title="Fullscreen" aria-label="Fullscreen">
                <ha-icon icon="mdi:fullscreen"></ha-icon>
              </button>
              <button class="icon-btn" id="camera-zoom-close" type="button" title="Close" aria-label="Close camera">
                <ha-icon icon="mdi:close"></ha-icon>
              </button>
            </div>
          </div>
          <div class="camera-zoom-body" id="camera-zoom-body"></div>
          <div class="camera-zoom-f" id="camera-zoom-info" role="status"></div>
        </dialog>
      </ha-card>
    `;
    this._profileDrawn = null; // Fresh DOM: the profile must be drawn again.
    this._bind();
    this._built = true;
    this._lastStates = {};
    this._watchedChanged(this._hass);
    this._update();
  }

  _bind() {
    const on = (id, event, fn) => this._root.getElementById(id)?.addEventListener(event, fn);
    on("printer-power", "click", () => this._togglePrinterPower());
    on("pause", "click", () => this._confirmPress(this._cfg.pause, "Pause the current print?"));
    on("resume", "click", () => this._confirmPress(this._cfg.resume, "Resume the current print?"));
    on("stop", "click", () => this._confirmPress(this._cfg.stop, "Stop the current print?"));
    on("camera", "click", () => this._openCameraZoom());
    on("camera-expand", "click", () => this._openCameraZoom());
    on("camera-zoom-close", "click", () => this._closeCameraZoom());
    on("camera-zoom-fullscreen", "click", () => this._toggleZoomFullscreen());
    on("camera-zoom-snapshot", "click", () => this._downloadSnapshot());
    const zoom = this._root.getElementById("camera-zoom");
    // A click on the backdrop lands on the dialog itself.
    zoom?.addEventListener("click", (ev) => { if (ev.target === zoom) this._closeCameraZoom(); });
    // The small preview resumes once the enlarged stream is dropped (not while offline).
    zoom?.addEventListener("close", () => {
      this._root.getElementById("camera-zoom-body")?.replaceChildren();
      if (!this._root.querySelector(".wrap")?.classList.contains("offline")) this._syncCamera();
    });
    on("profile", "click", () => {
      this._profileAxis = this._profileAxis === "y" ? "x" : "y";
      this._drawProfile();
    });
    on("printer-alert-close", "click", () => this._dismissPrinterAlert());
    on("filament-heat", "click", () => this._heatForFilamentChange());
    on("filament-alert-close", "click", () => {
      this._filamentAlertDismissed = true;
      this._syncFilamentAlert();
    });
    this._root.querySelectorAll("[data-more]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        if (ev.target.closest("button")) return;
        this._moreInfo(this._cfg[el.dataset.more]);
      });
    });
  }

  _update() {
    if (!this._built || !this._cfg) return;
    const cfg = this._cfg;
    this._setText("title", cfg.title || "");
    const status = this._val("status", cfg.status ? "unknown" : "");
    const badge = this._root.getElementById("status-badge");
    if (badge) {
      badge.hidden = !cfg.status;
      badge.textContent = prettyStatus(status);
      badge.className = `badge ${statusClass(status)}`;
    }
    if (this._updateOffline()) return;
    this._syncPrinterAlert();
    this._syncFilamentAlert();

    const noJob = this._noJob(status);
    const show = (id, visible) => {
      const el = this._root.getElementById(id);
      if (el) el.hidden = !visible;
    };
    // Tiles and stats whose entity is not configured are left out.
    const camera = !!cfg.camera;
    const gcode = !!(cfg.status || cfg.preview);
    show("media", camera || gcode);
    show("camera-tile", camera);
    show("gcode-tile", gcode);
    this._root.getElementById("media")?.classList.toggle("single", !(camera && gcode));
    if (!camera) this._closeCameraZoom();
    show("job", !noJob && !!(cfg.progress || cfg.object || cfg.pause || cfg.resume || cfg.stop));
    show("file", !!cfg.object);
    show("pct", !!cfg.progress);
    show("bar-row", !!cfg.progress);
    const stats = {
      "stat-layer": !noJob && !!cfg.layer,
      "stat-eta": !noJob && !!cfg.time_left,
      "stat-elapsed": !noJob && !!cfg.job_time,
      "stat-power": !!cfg.print_energy,
    };
    for (const [id, visible] of Object.entries(stats)) show(id, visible);
    show("stats", Object.values(stats).some(Boolean));

    const file = this._val("object");
    this._setText("file", file && file !== "unknown" ? file : "—");
    const pct = progressPct(this._val("progress"), this._st("progress"));
    this._setText("pct", `${pct.toFixed(0)}%`);
    const bar = this._root.getElementById("bar");
    if (bar) bar.style.width = `${pct}%`;
    this._root.getElementById("bar-row")?.classList.toggle("paused", statusClass(status) === "is-pause");
    this._syncPrintActions(status);

    this._setText("c-layer", formatLayers(this._val("layer"), this._val("total_layers")) || "—");
    this._syncEta(status);
    this._setText("c-elapsed", fmtDuration(this._val("job_time")));
    if (!this._prefsLoaded && cfg.print_energy && this._hass?.callWS) this._loadPowerOffset();
    this._syncPowerNow();

    this._syncProfile();
    this._syncCameraViews();
  }

  /** Finish clock and time left from the printer's estimate; "Done" once completed. */
  _syncEta(status) {
    const st = String(status).toLowerCase();
    const left = ACTIVE_STATUSES.includes(st) ? parseDurationSeconds(this._val("time_left")) : null;
    let clock = "—";
    let leftText = "";
    if (st === "completed") clock = "Done";
    else if (left != null) {
      clock = fmtClock(new Date(Date.now() + left * 1000), this._hass?.locale);
      leftText = `${fmtDuration(left)} left`;
    }
    this._setText("c-eta", clock);
    this._setText("c-eta-left", leftText);
    this._etaText = st === "completed" ? "Done" : leftText ? `${leftText} · ETA ${clock}` : "";
  }

  _zoomEta() {
    return this._etaText || "";
  }

  /**
   * Printer's power draw: the meter reading minus the power offset entered on
   * the full card, else minus the reading at the printer's last power-on.
   * Also called by the full card's offset lookup when it completes.
   */
  _syncPowerNow(meter = this._cardMeter()) {
    if (!this._root?.getElementById("stat-power")) return;
    let label = "Power";
    let value = "—";
    let title = "";
    const st = this._st("print_energy");
    if (meter) {
      const [mode, factor] = meter.kind;
      const reading = parseFloat(st?.state) * factor;
      if (mode === "energy") {
        // An energy counter has no live power; show its total instead.
        label = "Energy";
        if (Number.isFinite(reading)) value = fmtEnergy(reading);
      } else if (Number.isFinite(reading)) {
        const offset = this._manualBaselineW() ?? this._displayAutoBaseline(meter);
        value = `${Math.round(Number.isFinite(offset) ? Math.max(0, reading - offset) : reading)} W`;
        title = Number.isFinite(offset)
          ? `Meter ${Math.round(reading)} W, power offset ${Math.round(offset)} W removed`
          : `Meter ${Math.round(reading)} W`;
      }
    } else if (st && !isMissingState(st.state)) {
      value = `${st.state} ${st.attributes?.unit_of_measurement || ""}`.trim();
    }
    this._setText("c-power-label", label);
    this._setText("c-power", value);
    this._root.getElementById("stat-power").title = title;
  }

  /** Read the power offset from the print-history preferences the full card saves. */
  async _loadPowerOffset() {
    this._prefsLoaded = true;
    let store = this._readLocalPrintStore();
    try {
      store = (await this._fetchServerPrintStore()) || store;
    } catch (_err) {
      /* keep this browser's copy */
    }
    this._printPrefs = store.prefs;
    this._syncPowerNow();
  }

  /** Silhouette when available; otherwise the printer's thumbnail stands in. */
  _drawProfile() {
    super._drawProfile();
    const thumb = this._root?.getElementById("thumb");
    const empty = this._root?.getElementById("profile-empty");
    if (!thumb || !empty) return;
    const url = !this._profile && !this._noJob() ? this._picture(this._cfg.preview) : "";
    thumb.hidden = !url;
    if (!url) return;
    empty.hidden = true;
    this._syncMedia("thumb", this._cfg.preview, false, "No preview");
  }
}

const registeredCard = customElements.get(CARD_TAG);
if (!registeredCard) {
  customElements.define(CARD_TAG, CrealityCard);
} else if (!registeredCard.bundledCreality) {
  // Only one class can own the tag: an old dashboard resource won the race.
  console.warn(
    "Creality card: an older 'creality-card' (standalone card resource, e.g. /local/creality/card.js) " +
      "was registered before the card bundled with the Creality integration, so the old card is in use. " +
      "Remove that resource in Settings → Dashboards → Resources (Repairs offers a one-click fix) and reload."
  );
}

window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === CARD_TAG)) {
  window.customCards.push({
    type: CARD_TAG,
    name: "Creality Printer",
    description: "Creality Print-style device card for Ender 3 V3 KE",
    preview: true,
  });
}

if (!customElements.get(COMPACT_TAG)) customElements.define(COMPACT_TAG, CrealityCompactCard);
if (!window.customCards.some((card) => card.type === COMPACT_TAG)) {
  window.customCards.push({
    type: COMPACT_TAG,
    name: "Creality Printer (compact)",
    description: "Camera, G-code view, status, layers, finish time and power in a small card",
    preview: true,
  });
}
