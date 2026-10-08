/**
 * Creality WS Recorder — standalone browser client.
 *
 * Direct WS to the printer often fails in browsers because Creality does not
 * echo Sec-WebSocket-Protocol (wsslicer). Prefer serve.py local proxy.
 *
 * Protocol reference (ha_creality_ws):
 * - Printer: ws://{host}:9999  (subprotocol optional; ignored by many firmwares)
 * - Heartbeat: ModeCode === "heart_beat" → reply literal "ok"
 * - Periodic get: ReqPrinterPara (~5s), reqPrintObjects (~2s), boxsInfo (~5m)
 */

const GET_PARA_MS = 5000;
const GET_OBJECTS_MS = 2000;
const GET_CFS_MS = 300_000;
const PROBE_SILENCE_MS = 10_000;
const UI_STATE_MS = 250;
const LOG_LIMIT = 200;

const $ = (id) => document.getElementById(id);

const els = {
  host: $("host"),
  port: $("port"),
  useProxy: $("use-proxy"),
  pill: $("conn-pill"),
  btnConnect: $("btn-connect"),
  btnDisconnect: $("btn-disconnect"),
  btnRecStart: $("btn-rec-start"),
  btnRecStop: $("btn-rec-stop"),
  btnClearLog: $("btn-clear-log"),
  filter: $("filter"),
  stateBody: $("state-body"),
  log: $("log"),
  hint: $("hint"),
  statMsgs: $("stat-msgs"),
  statKeys: $("stat-keys"),
  statRec: $("stat-rec"),
  statFrames: $("stat-frames"),
  statRx: $("stat-rx"),
  wFile: $("w-file"),
  wState: $("w-state"),
  wProgress: $("w-progress"),
  wLayer: $("w-layer"),
  wNozzle: $("w-nozzle"),
  wBed: $("w-bed"),
};

const state = {
  ws: null,
  merged: {},
  keysMeta: {},
  msgCount: 0,
  lastRx: 0,
  timers: [],
  recording: false,
  recStartedAt: null,
  timeline: [],
  dirtyUi: true,
};

function logLine(msg, level = "info") {
  const ts = new Date().toLocaleTimeString();
  const prefix = level === "err" ? "!" : level === "ok" ? "✓" : "·";
  els.log.textContent = `[${ts}] ${prefix} ${msg}\n` + els.log.textContent.split("\n").slice(0, LOG_LIMIT).join("\n");
}

function setPill(label, dataState) {
  els.pill.textContent = label;
  els.pill.dataset.state = dataState;
}

function valueType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function coerceNumbers(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (/^-?\d+$/.test(trimmed)) {
        out[k] = parseInt(trimmed, 10);
        continue;
      }
      if (/^-?\d+\.\d+$/.test(trimmed)) {
        out[k] = parseFloat(trimmed);
        continue;
      }
    }
    out[k] = v;
  }
  return out;
}

function formatValue(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function trackKeys(frame) {
  const now = Date.now();
  for (const [k, v] of Object.entries(frame)) {
    const t = valueType(v);
    const prev = state.keysMeta[k];
    if (!prev) {
      state.keysMeta[k] = { type: t, firstSeen: now, lastSeen: now, sample: v };
    } else {
      prev.lastSeen = now;
      prev.type = t;
      prev.sample = v;
    }
  }
}

function sendJson(obj) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify(obj));
}

function clearTimers() {
  for (const id of state.timers) clearInterval(id);
  state.timers = [];
}

function startPeriodicGets() {
  clearTimers();
  const para = () => sendJson({ method: "get", params: { ReqPrinterPara: 1 } });
  const objs = () => sendJson({ method: "get", params: { reqPrintObjects: 1 } });
  const cfs = () => sendJson({ method: "get", params: { boxsInfo: 1 } });

  setTimeout(para, 500);
  setTimeout(objs, 800);
  setTimeout(cfs, 1200);

  state.timers.push(setInterval(para, GET_PARA_MS));
  state.timers.push(setInterval(objs, GET_OBJECTS_MS));
  state.timers.push(setInterval(cfs, GET_CFS_MS));
  state.timers.push(
    setInterval(() => {
      if (!state.lastRx) return;
      if (Date.now() - state.lastRx > PROBE_SILENCE_MS) para();
    }, 5000)
  );
}

function updateButtons() {
  const open = state.ws && state.ws.readyState === WebSocket.OPEN;
  const connecting = state.ws && state.ws.readyState === WebSocket.CONNECTING;
  els.btnConnect.disabled = open || connecting;
  els.btnDisconnect.disabled = !state.ws;
  els.btnRecStart.disabled = !open || state.recording;
  els.btnRecStop.disabled = !state.recording; // keep Stop enabled if link drops mid-capture
  els.host.disabled = open || connecting;
  els.port.disabled = open || connecting;
  if (els.useProxy) els.useProxy.disabled = open || connecting;
}

const STATE_LABELS = {
  0: "idle/processing",
  1: "printing",
  2: "finished?",
  4: "stopped",
  5: "paused",
};

function shortName(path) {
  if (!path) return "—";
  const s = String(path);
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function renderStats() {
  els.statMsgs.textContent = String(state.msgCount);
  els.statKeys.textContent = String(Object.keys(state.keysMeta).length);
  els.statRec.textContent = state.recording ? "ON" : "off";
  els.statFrames.textContent = String(state.timeline.length);
  els.statRx.textContent = state.lastRx ? new Date(state.lastRx).toLocaleTimeString() : "—";
}

function renderWatch() {
  const m = state.merged;
  if (!els.wFile) return;
  const st = m.state;
  const label = st == null ? "—" : `${st}${STATE_LABELS[st] ? ` (${STATE_LABELS[st]})` : ""}`;
  const layer = m.layer;
  const total = m.TotalLayer;
  const layers =
    layer != null || total != null
      ? `${layer ?? "—"} / ${total ?? "—"}`
      : "—";
  const prog = m.printProgress ?? m.dProgress;
  els.wFile.textContent = shortName(m.printFileName);
  els.wFile.title = m.printFileName ? String(m.printFileName) : "";
  els.wState.textContent = label;
  els.wProgress.textContent = prog == null ? "—" : `${prog}%`;
  els.wLayer.textContent = layers;
  const nz = m.nozzleTemp;
  const nt = m.targetNozzleTemp;
  els.wNozzle.textContent =
    nz == null ? "—" : `${Number(nz).toFixed(1)}°${nt != null ? ` / ${nt}` : ""}`;
  const bd = m.bedTemp0 ?? m.bedTemp;
  const bt = m.targetBedTemp0 ?? m.targetBedTemp;
  els.wBed.textContent =
    bd == null ? "—" : `${Number(bd).toFixed(1)}°${bt != null ? ` / ${bt}` : ""}`;
}

function renderStateTable() {
  const q = (els.filter.value || "").trim().toLowerCase();
  const keys = Object.keys(state.merged).sort((a, b) => a.localeCompare(b));
  const filtered = q ? keys.filter((k) => k.toLowerCase().includes(q)) : keys;

  if (!filtered.length) {
    els.stateBody.innerHTML = `<tr class="empty"><td colspan="3">${
      keys.length ? "No keys match filter." : "Connect to see telemetry."
    }</td></tr>`;
    return;
  }

  els.stateBody.innerHTML = filtered
    .map((k) => {
      const v = state.merged[k];
      return `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(formatValue(v))}</td><td>${escapeHtml(
        valueType(v)
      )}</td></tr>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scheduleUi() {
  state.dirtyUi = true;
}

function tickUi() {
  if (state.dirtyUi) {
    state.dirtyUi = false;
    renderWatch();
    renderStateTable();
    renderStats();
    updateButtons();
  }
}

function handleFrame(rawText) {
  if (rawText === "ok") return;

  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    logLine(`non-JSON frame (${rawText.slice(0, 80)})`, "err");
    return;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;

  state.lastRx = Date.now();

  if (payload.ModeCode === "heart_beat") {
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send("ok");
    if (state.recording) state.timeline.push({ t: state.lastRx, kind: "heartbeat" });
    scheduleUi();
    return;
  }

  const frame = coerceNumbers(payload);
  Object.assign(state.merged, frame);
  trackKeys(frame);
  state.msgCount += 1;

  if (state.recording) {
    state.timeline.push({ t: state.lastRx, kind: "telemetry", data: frame });
  }

  const highlight = ["model", "printFileName", "state", "printProgress", "layer", "TotalLayer"];
  const bits = highlight.filter((k) => k in frame).map((k) => `${k}=${formatValue(frame[k])}`);
  if (bits.length) logLine(bits.join(" · "));

  scheduleUi();
}

function buildWsUrl(host, port) {
  const useProxy = els.useProxy?.checked !== false;
  if (useProxy) {
    const loc = window.location;
    const wsProto = loc.protocol === "https:" ? "wss:" : "ws:";
    const q = new URLSearchParams({ host, port: String(port) });
    return `${wsProto}//${loc.host}/proxy?${q}`;
  }
  return `ws://${host}:${port}`;
}

function attachSocket(ws, label) {
  state.ws = ws;
  updateButtons();

  ws.addEventListener("open", () => {
    setPill("Connected", "connected");
    logLine(`WebSocket open (${label}) — waiting for telemetry`, "ok");
    startPeriodicGets();
    updateButtons();
  });

  ws.addEventListener("message", (ev) => {
    const data = typeof ev.data === "string" ? ev.data : "";
    if (!data && ev.data instanceof Blob) {
      ev.data.text().then(handleFrame).catch(() => {});
      return;
    }
    handleFrame(data);
  });

  ws.addEventListener("error", () => {
    setPill("Error", "error");
    logLine(
      els.useProxy?.checked
        ? "WebSocket error — is serve.py running? (.venv/bin/python serve.py)"
        : "WebSocket error — try enabling “Via local proxy” and run serve.py",
      "err"
    );
  });

  ws.addEventListener("close", (ev) => {
    clearTimers();
    state.ws = null;
    setPill("Disconnected", "disconnected");
    logLine(`Closed (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`);
    if (state.recording) {
      logLine(
        "Connection lost while recording — click Connect again (timeline kept). Proxy should stay up now after ping fix.",
        "err"
      );
    }
    updateButtons();
  });
}

function connect() {
  const host = els.host.value.trim();
  const port = Number(els.port.value) || 9999;
  if (!host) {
    logLine("Enter printer host / IP", "err");
    return;
  }

  disconnect(false);

  // Keep recording timeline across reconnects; only reset live merge/counters.
  state.merged = {};
  state.keysMeta = {};
  state.msgCount = 0;
  state.lastRx = 0;

  const url = buildWsUrl(host, port);
  const viaProxy = els.useProxy?.checked !== false;
  setPill("Connecting…", "connecting");
  logLine(`Connecting ${url}${viaProxy ? "" : " (direct, no subprotocol)"}…`);
  els.hint.textContent = viaProxy
    ? "Using local proxy. Keep `python serve.py` running in the recorder folder."
    : "Direct mode: no wsslicer subprotocol (printer does not negotiate it). If this fails, enable proxy.";

  let ws;
  try {
    // Never pass wsslicer — browsers abort when the printer omits it from the handshake.
    ws = new WebSocket(url);
  } catch (err) {
    setPill("Error", "error");
    logLine(`WebSocket constructor failed: ${err.message}`, "err");
    updateButtons();
    return;
  }

  attachSocket(ws, viaProxy ? "proxy" : "direct");
}

function disconnect(log = true) {
  clearTimers();
  if (state.ws) {
    try {
      state.ws.close();
    } catch {
      /* ignore */
    }
    state.ws = null;
  }
  if (log) logLine("Disconnected");
  setPill("Disconnected", "disconnected");
  updateButtons();
}

function startRecording() {
  if (state.recording) return;
  state.recording = true;
  state.recStartedAt = new Date().toISOString();
  state.timeline = [];
  if (Object.keys(state.merged).length) {
    state.timeline.push({
      t: Date.now(),
      kind: "snapshot",
      data: { ...state.merged },
    });
  }
  logLine("Recording started", "ok");
  scheduleUi();
}

function stopRecordingAndDownload() {
  if (!state.recording) return;
  state.recording = false;
  const endedAt = new Date().toISOString();
  const host = els.host.value.trim();
  const port = Number(els.port.value) || 9999;

  const keys = Object.fromEntries(
    Object.entries(state.keysMeta).map(([k, meta]) => [
      k,
      {
        type: meta.type,
        firstSeen: new Date(meta.firstSeen).toISOString(),
        lastSeen: new Date(meta.lastSeen).toISOString(),
        sample: meta.sample,
      },
    ])
  );

  const payload = {
    meta: {
      host,
      port,
      viaProxy: els.useProxy?.checked !== false,
      startedAt: state.recStartedAt,
      endedAt,
      messageCount: state.msgCount,
      frameCount: state.timeline.length,
      uniqueKeys: Object.keys(keys).length,
      userAgent: navigator.userAgent,
      note: "Standalone Creality WS recorder (clean-room). For discovering sensor candidates.",
    },
    keys,
    finalState: { ...state.merged },
    timeline: state.timeline,
  };

  const stamp = endedAt.replace(/[:.]/g, "-");
  const fileHint = String(state.merged.printFileName || "session")
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 40);
  const filename = `creality-ws-${fileHint}-${stamp}.json`;

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);

  logLine(`Recording saved → ${filename} (${state.timeline.length} frames, ${Object.keys(keys).length} keys)`, "ok");
  scheduleUi();
}

els.btnConnect.addEventListener("click", connect);
els.btnDisconnect.addEventListener("click", () => disconnect(true));
els.btnRecStart.addEventListener("click", startRecording);
els.btnRecStop.addEventListener("click", stopRecordingAndDownload);
els.btnClearLog.addEventListener("click", () => {
  els.log.textContent = "";
});
els.filter.addEventListener("input", () => scheduleUi());
els.host.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") connect();
});

try {
  const saved = localStorage.getItem("creality-recorder-host");
  if (saved) els.host.value = saved;
  els.host.addEventListener("change", () => {
    localStorage.setItem("creality-recorder-host", els.host.value.trim());
  });
  const savedProxy = localStorage.getItem("creality-recorder-proxy");
  if (savedProxy != null && els.useProxy) els.useProxy.checked = savedProxy === "1";
  els.useProxy?.addEventListener("change", () => {
    localStorage.setItem("creality-recorder-proxy", els.useProxy.checked ? "1" : "0");
  });
} catch {
  /* ignore */
}

setInterval(tickUi, UI_STATE_MS);
updateButtons();
renderStats();
logLine("Ready. Prefer: .venv/bin/python serve.py  then Connect with proxy checked.");
els.hint.textContent =
  "Run serve.py in this folder (not plain http.server) so the WS proxy is available.";
