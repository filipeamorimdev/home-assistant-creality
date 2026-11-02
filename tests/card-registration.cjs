const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname,
  "../custom_components/creality/frontend/creality-card.js"), "utf8");

function registry(ready) {
  const definitions = new Map();
  return {
    get: (name) => definitions.get(name),
    whenDefined: (name) => {
      assert.equal(name, "home-assistant");
      return ready;
    },
    define: (name, cls) => {
      assert.equal(definitions.has(name), false, "no duplicate definitions");
      definitions.set(name, cls);
    },
  };
}

// Wrap module contents in an async function to exercise top-level await using
// Node's VM without requiring a browser or experimental module support.
function load(context) {
  return vm.runInContext(`(async () => {\n${source}\n})()`, context);
}

test("early module waits for HA's replacement registry and HTMLElement", async () => {
  let finishBoot;
  const ready = new Promise((resolve) => { finishBoot = resolve; });
  const initialRegistry = registry(ready);
  const context = vm.createContext({
    customElements: initialRegistry,
    HTMLElement: class NativeHTMLElement {},
    window: {},
  });
  const loading = load(context);
  assert.equal(initialRegistry.get("creality-card"), undefined);
  assert.equal(context.window.customCards, undefined);

  class HaHTMLElement {
    attachShadow() { return {}; }
  }
  context.customElements = registry(Promise.resolve());
  context.HTMLElement = HaHTMLElement;
  finishBoot();
  await loading;

  const Card = context.customElements.get("creality-card");
  assert.ok(new Card() instanceof HaHTMLElement);
  assert.equal(initialRegistry.get("creality-card"), undefined);
  assert.equal(context.window.customCards[0].type, "creality-card");
});

test("late and duplicate module loads keep a single registered card", async () => {
  const context = vm.createContext({
    customElements: registry(Promise.resolve()),
    HTMLElement: class { attachShadow() { return {}; } },
    window: {},
  });
  await load(context);
  const Card = context.customElements.get("creality-card");
  const Compact = context.customElements.get("creality-compact-card");
  assert.ok(new Card());
  assert.ok(new Compact() instanceof Card, "the compact card reuses the full card's code");
  await load(context);
  assert.equal(context.customElements.get("creality-card"), Card);
  assert.equal(context.customElements.get("creality-compact-card"), Compact);
  assert.deepEqual(Array.from(context.window.customCards, (card) => card.type), ["creality-card", "creality-compact-card"]);
});

test("an older standalone card registered first is reported, not replaced", async () => {
  const warnings = [];
  const context = vm.createContext({
    customElements: registry(Promise.resolve()),
    HTMLElement: class { attachShadow() { return {}; } },
    window: {},
    console: { warn: (message) => warnings.push(message) },
  });
  class LegacyCard {}
  context.customElements.define("creality-card", LegacyCard);
  await load(context);
  assert.equal(context.customElements.get("creality-card"), LegacyCard);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("/local/creality/card.js"));
  await load(context);
  assert.equal(warnings.length, 2, "each bundled load explains why it is not active");
});

async function cardClass() {
  const context = vm.createContext({
    customElements: registry(Promise.resolve()),
    HTMLElement: class { attachShadow() { return {}; } },
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    window: {},
    console: { warn() {} },
  });
  await load(context);
  return context.customElements.get("creality-card");
}

function entity(entity_id, suffix, config_entry_id = "printer-a", extra = {}) {
  return { entity_id, unique_id: `${config_entry_id}_${suffix}`,
    config_entry_id, device_id: config_entry_id, platform: "creality", ...extra };
}

function mockHass(entries) {
  return {
    states: Object.fromEntries(entries.map((entry) => [entry.entity_id, { state: "unavailable" }])),
    devices: { "printer-a": { name: "Workshop", name_by_user: "My printer" } },
    async callWS(message) {
      assert.equal(message.type, "config/entity_registry/list");
      return entries;
    },
  };
}

test("defaults use renamed and suffixed integration IDs, even while offline", async () => {
  const Card = await cardClass();
  const entries = [
    entity("sensor.my_progress_2", "print_progress"),
    entity("sensor.arbitrary_name", "print_status"),
    entity("camera.workshop_2", "printer_camera"),
    entity("button.renamed_home", "home_xy_then_z"),
    entity("number.hotend", "nozzle_target"),
    entity("fan.cooling", "model_fan"),
    entity("image.my_print", "current_print_preview"),
  ];
  const config = await Card.getStubConfig(mockHass(entries));
  assert.equal(config.title, "My printer");
  assert.equal(config.progress, "sensor.my_progress_2");
  assert.equal(config.status, "sensor.arbitrary_name");
  assert.equal(config.camera, "camera.workshop_2");
  assert.equal(config.home, "button.renamed_home");
  assert.equal(config.nozzle_target, "number.hotend");
  assert.equal(config.model_fan, "fan.cooling");
  assert.equal(config.preview, "image.my_print");
  assert.equal(config.print_energy, undefined, "no integration energy sensor to default to");
  assert.equal(config.printer_switch, "");
  assert.equal(config.power, undefined, "legacy browser-side power tracking was removed");
});

test("defaults never mix printers or select third-party, disabled, or absent entities", async () => {
  const Card = await cardClass();
  const entries = [
    entity("sensor.a_progress", "print_progress"),
    entity("camera.a_camera", "printer_camera"),
    entity("sensor.b_progress", "print_progress", "printer-b"),
    entity("sensor.b_status", "print_status", "printer-b", { disabled_by: "user" }),
    entity("sensor.b_object", "current_object", "printer-b"),
    entity("button.b_stop", "stop_print", "printer-b", { platform: "ha_creality_ws" }),
    entity("number.b_target", "nozzle_target", "printer-b", { unique_id: "unrelated_nozzle_target" }),
  ];
  const hass = mockHass(entries);
  delete hass.states["sensor.b_object"];
  const config = await Card.getStubConfig(hass, ["sensor.b_progress"]);
  assert.equal(config.progress, "sensor.b_progress");
  for (const key of ["camera", "status", "object", "stop", "nozzle_target"]) {
    assert.equal(config[key], undefined);
  }
  assert.equal((await Card.getStubConfig(hass, [], ["sensor.b_progress"])).progress, "sensor.b_progress");
  assert.equal((await Card.getStubConfig(hass)).progress, "sensor.a_progress");
});

test("empty or failed discovery returns no invented entity IDs", async () => {
  const Card = await cardClass();
  const blank = { title: "Creality Printer", preview: "", printer_switch: "" };
  for (const hass of [undefined, mockHass([]), { callWS: async () => { throw Error("Disconnected"); } }]) {
    assert.deepEqual(JSON.parse(JSON.stringify(await Card.getStubConfig(hass))), blank);
  }
});

test("saved manual entity choices are not overwritten", async () => {
  const Card = await cardClass();
  const card = new Card();
  card._render = () => {};
  card.setConfig({ type: "custom:creality-card", progress: "sensor.manual", preview: "image.custom" });
  card.hass = mockHass([entity("sensor.detected", "print_progress")]);
  assert.equal(card._cfg.progress, "sensor.manual");
  assert.equal(card._cfg.preview, "image.custom");
});

test("preview URL changes with image timestamp and hides unavailable images", async () => {
  const Card = await cardClass();
  const card = new Card();
  const state = { state: "2026-09-21T12:00:00Z", attributes: {
    entity_picture: "/api/image_proxy/image.preview?token=test",
  } };
  card._hass = { states: { "image.preview": state } };
  const first = card._picture("image.preview");
  assert.ok(first.includes("&v="));
  state.state = "2026-09-21T13:00:00Z";
  assert.notEqual(card._picture("image.preview"), first);
  state.state = "unavailable";
  assert.equal(card._picture("image.preview"), "");
});

async function completionCard() {
  const Card = await cardClass();
  const card = new Card();
  let status = "printing";
  let raw = 1;
  let live = { jobKey: "printer|100|same.gcode", file: "same.gcode", ended: "2026-09-21T12:00:00Z",
    timeSeconds: 120, timeLabel: "2:00", layers: "12 / 12", progress: 99,
    used: 250, usedUnit: "mm", preview: "data:image/png;base64,test", energyKwh: 0.2 };
  const elements = Object.fromEntries(["completion-banner", "completion-title", "completion-file",
    "completion-stats", "save-print"].map((id) => [id, { hidden: false, classList: { toggle() {} } }]));
  card._root = { getElementById: (id) => elements[id] };
  card._val = () => status;
  card._st = () => ({ attributes: { state_raw: raw }, last_changed: "2026-09-21T12:05:00Z" });
  card._livePrintDraft = () => ({ ...live });
  return { card, elements, update: async (nextStatus, nextRaw, changes = {}) => {
    status = nextStatus; raw = nextRaw; live = { ...live, ...changes };
    await card._rememberJobDraft(); card._syncSaveButton();
  } };
}

test("completion banner requires finished state, freezes stats and survives idle", async () => {
  const { card, elements, update } = await completionCard();
  await update("printing", 1);
  assert.equal(elements["completion-banner"].hidden, true);
  await update("completed", 1, { progress: 100 });
  assert.equal(card._completedJob, null, "100% is not proof of completion");
  await update("completed", 2, { timeSeconds: 0, used: 0, layers: "0 / 0" });
  assert.equal(elements["completion-banner"].hidden, false);
  assert.equal(card._completedJob.timeSeconds, 120);
  assert.equal(card._completedJob.used, 250);
  assert.equal(card._completedJob.layers, "12 / 12");
  assert.equal(elements["completion-title"].textContent, "Print finished successfully");
  await update("idle", 0, { energyKwh: 1.2 });
  assert.equal(card._snapshotPrintDraft().energyKwh, 0.2);
  assert.equal(card._energyUsedKwh(), 0.2);
  assert.equal(card._snapshotPrintDraft().ended, "2026-09-21T12:05:00.000Z",
    "ended is when the status turned terminal, not when the card noticed");
});

test("stopped jobs are not labelled successful; saved jobs cannot be saved twice", async () => {
  const { card, elements, update } = await completionCard();
  await update("printing", 1);
  await update("stopped", 4);
  assert.equal(card._completedJob.result, "stopped");
  assert.ok(elements["completion-title"].textContent.includes("not completed"));
  card._prints.push({ ...card._completedJob });
  card._syncSaveButton();
  assert.equal(elements["save-print"].disabled, true);
  await update("printing", 1, { jobKey: "printer|200|same.gcode", timeSeconds: 1 });
  assert.equal(card._completedJob, null);
  assert.equal(elements["completion-banner"].hidden, true);
  await update("completed", 2);
  assert.equal(elements["save-print"].disabled, false);
});

test("pause, error and unavailable do not announce completion", async () => {
  const { card, update } = await completionCard();
  for (const [status, raw] of [["paused",5], ["error",1], ["unavailable",undefined]]) {
    await update(status, raw);
    assert.equal(card._completedJob, null);
  }
  await update("failed", undefined);
  assert.equal(card._completedJob.result, "failed");
});

test("save button exists only in the full-width banner, not the history header", () => {
  assert.equal((source.match(/id="save-print"/g) || []).length, 1);
  const banner = source.indexOf('id="completion-banner"');
  assert.ok(banner < source.indexOf('<div class="layout">'));
  assert.ok(source.indexOf('id="save-print"') < source.indexOf('data-panel="log"'));
});

test("energy comes only from the card's meter; no integration total or legacy code", async () => {
  const Card = await cardClass();
  const card = new Card();
  card._cfg = {};
  card._lastJobDraft = { energyKwh: 0.013 };
  card._st = () => ({ state: "completed", attributes: { energy_tracking: true, energy_kwh: 0.319 } });
  assert.equal(card._backendEnergy(), null);
  assert.equal(card._energyUsedKwh(), 0.013, "without a meter the saved draft total is kept");
  for (const name of ["_sampleEnergy", "_startEnergySession", "_powerOffsetW"]) {
    assert.equal(typeof card[name], "undefined", `${name} legacy code removed`);
  }
});

test("energy line is hidden without a configured sensor and asks for a meter otherwise", async () => {
  const Card = await cardClass();
  const card = new Card();
  const { els, root } = powerLineEls();
  card._root = root;
  card._cfg = { status: "sensor.status" };
  card._st = (key) => (key === "print_energy"
    ? { state: "0.4", attributes: { unit_of_measurement: "%" } }
    : { state: "idle", attributes: {} });
  card._trackEnergy();
  assert.equal(els["power-line"].hidden, true);
  card._cfg.print_energy = "sensor.old_print_energy";
  card._trackEnergy();
  assert.equal(els["power-line"].hidden, false);
  assert.equal(els["power-now"].hidden, true, "no live reading without a meter");
  assert.ok(els["power-text"].textContent.includes("card editor"));
});

function powerLineEls() {
  const els = {
    "power-line": { hidden: true }, "power-text": { textContent: "" }, "power-now": { hidden: true },
    "power-reading": { textContent: "" }, "baseline-field": { hidden: true },
    baseline: { value: "", placeholder: "" },
  };
  return { els, root: { getElementById: (id) => els[id] || null, activeElement: null } };
}

test("idle card meter shows the live reading, the printer's share and the power-on baseline", async () => {
  const now = Date.now() / 1000;
  const { card } = await meterCard("W", [{ s: "85", lu: now - 7200 }, { s: "300", lu: now - 600 }],
    { "switch.printer": [{ s: "off", lu: now - 9000 }, { s: "on", lu: now - 3600 }] });
  card._cfg.printer_switch = "switch.printer";
  const { els, root } = powerLineEls();
  card._root = root;
  card._trackEnergy();
  assert.equal(els["power-line"].hidden, false);
  assert.equal(els["power-now"].hidden, false);
  assert.equal(els["baseline-field"].hidden, false);
  assert.equal(els["power-text"].textContent, "", "no idle label; the reading row shows the meter");
  assert.equal(els["power-reading"].textContent, "Now 300 W", "baseline not known yet");
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(els["power-reading"].textContent, "Now 300 W · printer ≈ 215 W");
  assert.equal(els.baseline.placeholder, "85");
  assert.equal(els.baseline.value, "", "automatic baseline leaves the field empty");
});

test("a power offset entered on the card replaces the automatic one and is saved", async () => {
  const { card } = await meterCard("W", [{ s: "380", lu: T0 }, { s: "60", lu: T0 + 1800 }]);
  const { els, root } = powerLineEls();
  card._root = root;
  card._printPrefs = { currency: "€" };
  let persisted = 0;
  card._persistPrints = async () => { persisted++; };
  card._meterEnergy = { jobKey: "job", final: true, kwh: 1 };
  await card._setManualBaseline("100");
  assert.equal(card._printPrefs.baselineW, 100);
  assert.equal(persisted, 1);
  assert.equal(card._meterEnergy, null, "current job is re-measured");
  assert.equal(els.baseline.value, "100");
  assert.equal(els["power-reading"].textContent, "Now 300 W · printer ≈ 200 W");
  const measured = await card._measureMeterEnergy(HOUR_JOB);
  assert.equal(measured.baselineW, 100);
  // (380 - 100) W for 30 min, then 60 W < baseline counts as zero.
  assert.ok(Math.abs(measured.kwh - 0.14) < 1e-9);
  await card._setManualBaseline("");
  assert.equal(card._manualBaselineW(), null, "empty field returns to automatic");
  assert.equal(persisted, 2);
});

test("energy-counter meter shows its reading without a baseline field", async () => {
  const { card } = await meterCard("kWh", []);
  card._st = (key) => (key === "print_energy"
    ? { state: "12.5", attributes: { unit_of_measurement: "kWh", friendly_name: "Plug" } }
    : { state: "idle", attributes: {} });
  const { els, root } = powerLineEls();
  card._root = root;
  card._trackEnergy();
  assert.equal(els["power-now"].hidden, false);
  assert.equal(els["baseline-field"].hidden, true);
  assert.equal(els["power-reading"].textContent, "Meter: 12.50 kWh");
});

async function meterCard(unit, history, others = {}) {
  const Card = await cardClass();
  const card = new Card();
  const calls = [];
  card._root = { getElementById: () => null };
  card._cfg = { status: "sensor.status", print_energy: "sensor.plug" };
  card._st = (key) => (key === "print_energy"
    ? { state: "300", attributes: { unit_of_measurement: unit, friendly_name: "Plug" } }
    : { state: "completed", attributes: {} });
  const series = { "sensor.plug": history, ...others };
  card._hass = { callWS: async (msg) => {
    calls.push(msg);
    const id = msg.entity_ids[0];
    // Like the recorder: the state in effect at start_time, then changes inside the window.
    const from = Date.parse(msg.start_time) / 1000;
    const to = Date.parse(msg.end_time) / 1000;
    const list = series[id] || [];
    const before = list.filter((p) => p.lu <= from).pop();
    return { [id]: [...(before ? [{ ...before, lu: from }] : []), ...list.filter((p) => p.lu > from && p.lu < to)] };
  } };
  return { card, calls };
}

// One-hour job; recorder `lu` timestamps are in seconds like HA's compressed history.
const HOUR_JOB = { jobKey: "job", startTime: 1_800_000_000, finishedAt: (1_800_000_000 + 3600) * 1000 };
const T0 = HOUR_JOB.startTime;

test("card meter integrates power history over the job window without the integration", async () => {
  const { card, calls } = await meterCard("W", [
    { s: "200", lu: T0 - 50 }, { s: "400", lu: T0 + 1800 }, { s: "999", lu: T0 + 4000 },
  ]);
  const measured = await card._measureMeterEnergy(HOUR_JOB);
  const meterCall = calls.at(-1);
  assert.equal(meterCall.entity_ids[0], "sensor.plug");
  assert.equal(meterCall.start_time, new Date(T0 * 1000).toISOString());
  assert.equal(meterCall.end_time, new Date(HOUR_JOB.finishedAt).toISOString());
  assert.equal(measured.baselineW, null, "no power-on found: whole-room total");
  assert.ok(Math.abs(measured.kwh - 0.3) < 1e-9);
  assert.equal(measured.quality, "complete");

  card._completedJob = HOUR_JOB;
  await card._refreshMeterEnergy();
  assert.ok(Math.abs(card._energyUsedKwh() - 0.3) < 1e-9, "card meter measures the job");
  assert.equal(card._backendEnergy().quality, "complete");
});

test("whole-room meter: load at the printer switch's power-on is removed from every reading", async () => {
  const { card } = await meterCard("W", [
    { s: "80", lu: T0 - 7200 }, { s: "95", lu: T0 - 3600 + 2 }, { s: "380", lu: T0 }, { s: "60", lu: T0 + 1800 },
  ], { "switch.printer": [{ s: "on", lu: T0 - 90000 }, { s: "off", lu: T0 - 20000 }, { s: "on", lu: T0 - 3600 }] });
  card._cfg.printer_switch = "switch.printer";
  const measured = await card._measureMeterEnergy(HOUR_JOB);
  assert.equal(measured.baselineW, 80, "meter value at the off→on moment");
  // (380 - 80) W for 30 min, then 60 W < baseline counts as zero.
  assert.ok(Math.abs(measured.kwh - 0.15) < 1e-9);
  card._completedJob = HOUR_JOB;
  await card._refreshMeterEnergy();
  assert.equal(card._backendEnergy().baselineW, 80);
});

test("without a switch, the baseline is read 2 minutes before print status left offline", async () => {
  const { card } = await meterCard("kW", [
    { s: "0.1", lu: T0 - 4000 }, { s: "0.13", lu: T0 - 3550 }, { s: "0.4", lu: T0 - 60 },
  ], { "sensor.status": [{ s: "offline", lu: T0 - 5000 }, { s: "idle", lu: T0 - 3500 }] });
  const measured = await card._measureMeterEnergy(HOUR_JOB);
  assert.equal(measured.baselineW, 100);
  assert.ok(Math.abs(measured.kwh - 0.3) < 1e-9);
});

test("an HA restart or reconnect is not a power-on: the printer's own draw is not removed", async () => {
  // Smart plug on the printer only: 0 W while off, 15 W idle, 200 W printing.
  const { card } = await meterCard("W", [
    { s: "0", lu: T0 - 90000 }, { s: "15", lu: T0 - 80000 }, { s: "200", lu: T0 },
  ], { "sensor.status": [
    { s: "offline", lu: T0 - 90000 }, { s: "idle", lu: T0 - 79900 },
    // Home Assistant restarted an hour before the print, and the Wi-Fi dropped for 40 s.
    { s: "unavailable", lu: T0 - 3660 }, { s: "offline", lu: T0 - 3630 }, { s: "idle", lu: T0 - 3600 },
    { s: "offline", lu: T0 - 1240 }, { s: "idle", lu: T0 - 1200 },
  ] });
  const measured = await card._measureMeterEnergy(HOUR_JOB);
  assert.equal(measured.baselineW, 0, "reading before the real power-on, not the printer idling");
  assert.ok(Math.abs(measured.kwh - 0.2) < 1e-9);
});

test("a quick plug off/on is skipped; its stale reading is not the room load", async () => {
  // The plug still showed the printer's 150 W when it was switched back on 20 s later.
  const { card } = await meterCard("W", [
    { s: "40", lu: T0 - 20000 }, { s: "150", lu: T0 - 9000 }, { s: "390", lu: T0 },
  ], { "switch.printer": [
    { s: "off", lu: T0 - 30000 }, { s: "on", lu: T0 - 9000 }, { s: "off", lu: T0 - 3620 }, { s: "on", lu: T0 - 3600 },
  ] });
  card._cfg.printer_switch = "switch.printer";
  const measured = await card._measureMeterEnergy(HOUR_JOB);
  assert.equal(measured.baselineW, 40, "room load before the last real power-on");
  assert.ok(Math.abs(measured.kwh - 0.35) < 1e-9);
});

test("energy window starts when the job became active, before the printer's start time", async () => {
  const { card, calls } = await meterCard("W", [{ s: "300", lu: T0 - 600 }], { "sensor.status": [
    { s: "idle", lu: T0 - 5000 }, { s: "processing", lu: T0 - 300 }, { s: "printing", lu: T0 + 5 },
  ] });
  const measured = await card._measureMeterEnergy(HOUR_JOB);
  assert.equal(calls.at(-1).start_time, new Date((T0 - 300) * 1000).toISOString());
  // 300 W from preparation (5 min) to the end of the one-hour job.
  assert.ok(Math.abs(measured.kwh - 0.325) < 1e-9);
});

test("card meter marks gaps and late history partial; no samples is unavailable", async () => {
  let { card } = await meterCard("kW", [
    { s: "0.2", lu: T0 }, { s: "unavailable", lu: T0 + 1800 }, { s: "0.2", lu: T0 + 2700 },
  ]);
  let measured = await card._measureMeterEnergy(HOUR_JOB);
  assert.ok(Math.abs(measured.kwh - 0.15) < 1e-9);
  assert.equal(measured.quality, "partial");
  ({ card } = await meterCard("W", []));
  assert.equal(await card._measureMeterEnergy(HOUR_JOB), null);
});

test("card meter sums energy counter increases and flags resets", async () => {
  let { card } = await meterCard("Wh", [{ s: "1000", lu: T0 - 5 }, { s: "1100", lu: T0 + 900 }, { s: "1250", lu: T0 + 3500 }]);
  let measured = await card._measureMeterEnergy(HOUR_JOB);
  assert.ok(Math.abs(measured.kwh - 0.25) < 1e-9);
  assert.equal(measured.quality, "complete");
  ({ card } = await meterCard("kWh", [{ s: "5", lu: T0 }, { s: "0.1", lu: T0 + 900 }, { s: "0.3", lu: T0 + 1800 }]));
  measured = await card._measureMeterEnergy(HOUR_JOB);
  assert.ok(Math.abs(measured.kwh - 0.2) < 1e-9);
  assert.equal(measured.quality, "partial");
});

test("updates run only when a configured entity changes", async () => {
  const Card = await cardClass();
  const card = new Card();
  let updates = 0;
  card._built = true;
  card._update = () => { updates++; };
  card._cfg = { title: "Printer", status: "sensor.status", nozzle: "sensor.nozzle" };
  const status = { state: "printing" };
  const nozzle = { state: "200" };
  card.hass = { states: { "sensor.status": status, "sensor.nozzle": nozzle, "light.kitchen": { state: "on" } } };
  assert.equal(updates, 1);
  card.hass = { states: { "sensor.status": status, "sensor.nozzle": nozzle, "light.kitchen": { state: "off" } } };
  assert.equal(updates, 1, "unrelated entity changes are ignored");
  card.hass = { states: { "sensor.status": status, "sensor.nozzle": { state: "201" } } };
  assert.equal(updates, 2);
});

test("history polling restarts when the card is re-attached", async () => {
  const context = vm.createContext({
    customElements: registry(Promise.resolve()),
    HTMLElement: class { attachShadow() { return { addEventListener() {}, getElementById() { return null; } }; } },
    window: {},
    console: { warn() {} },
    setInterval: () => 42,
    clearInterval: () => {},
    clearTimeout: () => {},
  });
  await load(context);
  const Card = context.customElements.get("creality-card");
  const card = new Card();
  let loads = 0;
  card._loadHistory = () => { loads++; };
  card._built = true;
  card._cfg = {};
  card._histTimer = 7;
  card.disconnectedCallback();
  assert.equal(card._histTimer, undefined);
  card.connectedCallback();
  assert.equal(card._histTimer, 42);
  assert.equal(loads, 1);
  card.connectedCallback();
  assert.equal(loads, 1, "no duplicate timers");
});

test("deleted prints stay deleted when merged with a stale browser copy", async () => {
  const Card = await cardClass();
  const card = new Card();
  const server = card._normalizePrintStore({ prints: [{ id: "b", ended: "2026-09-02" }], deleted: ["a"] });
  const staleLocal = card._normalizePrintStore({ prints: [
    { id: "a", ended: "2026-09-01" }, { id: "b", ended: "2026-09-02" }, { id: "c", ended: "2026-09-03" },
  ] });
  const merged = card._mergePrintStores(server, staleLocal);
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(merged.prints.map((p) => p.id)), ["c", "b"]);
  assert.deepEqual(plain(merged.deleted), ["a"]);
  const fromOldFormat = card._normalizePrintStore({ prints: [] });
  assert.deepEqual(plain(fromOldFormat.deleted), []);
});

function printStoreHass(serverValue) {
  const calls = [];
  return { calls, hass: { states: {}, async callWS(message) {
    calls.push(message.type);
    if (message.type === "frontend/get_user_data") return { value: serverValue && JSON.parse(JSON.stringify(serverValue)) };
    if (message.type === "frontend/set_user_data") { serverValue = message.value; return null; }
    throw new Error(message.type);
  } }, server: () => serverValue };
}

test("saved prints load from HA once hass arrives after setConfig", async () => {
  const Card = await cardClass();
  const card = new Card();
  card._renderPrintLog = () => {};
  card._syncSaveButton = () => {};
  card._built = true; // setConfig() rendered before HA provided hass
  card._watchedChanged = () => false;
  const { hass, calls } = printStoreHass({ prints: [{ id: "a", ended: "2026-10-05T20:26:15Z" }] });
  card.hass = hass;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...card._prints.map((p) => p.id)], ["a"]);
  card.hass = hass;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((t) => t === "frontend/get_user_data").length, 1, "loaded once");
});

test("saving merges with the server copy instead of overwriting other browsers' prints", async () => {
  const Card = await cardClass();
  const card = new Card();
  card._renderPrintLog = () => {};
  const { hass, server } = printStoreHass({ prints: [{ id: "other", ended: "2026-10-04T21:33:44Z" }],
    deleted: ["gone"] });
  card._hass = hass;
  card._prints = [{ id: "new", ended: "2026-10-05T20:26:15Z" }, { id: "gone", ended: "2026-10-01T00:00:00Z" }];
  await card._persistPrints();
  const ids = (store) => [...store.prints.map((p) => p.id)];
  assert.deepEqual(ids(server()), ["new", "other"]);
  assert.deepEqual(ids({ prints: card._prints }), ["new", "other"]);
});

test("thumbnail capture is throttled per job", async () => {
  const Card = await cardClass();
  const card = new Card();
  assert.equal(card._mayCapturePreview("job-1"), true);
  assert.equal(card._mayCapturePreview("job-1"), false);
  assert.equal(card._mayCapturePreview("job-2"), true);
});

function fakeMount() {
  return {
    children: [],
    classList: { remove() {} },
    replaceChildren(...children) { this.children = children; },
    querySelector(selector) {
      assert.equal(selector, ".camera-live");
      return this.children.find((child) => child.classList.contains("camera-live")) || null;
    },
  };
}

function fakeLiveCard() {
  const classes = new Set();
  const card = { dataset: {}, classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c) } };
  card.remove = () => { card.removed = true; };
  return card;
}

test("the enlarged camera replaces the tile stream while open", async () => {
  const Card = await cardClass();
  const card = new Card();
  const removed = [];
  const synced = [];
  let open = true;
  const tile = { querySelector: () => ({ remove: () => removed.push("tile") }) };
  card._root = { getElementById: (id) => (id === "camera-zoom" ? { open } : id === "camera" ? tile : null) };
  card._syncCamera = (mount = "camera") => synced.push(mount);
  card._syncZoomInfo = () => synced.push("info");
  card._syncCameraViews();
  assert.deepEqual(removed, ["tile"]);
  assert.deepEqual(synced, ["camera-zoom-body", "info"]);
  open = false;
  synced.length = 0;
  card._syncCameraViews();
  assert.deepEqual(synced, ["camera"]);
});

test("streaming cameras embed HA's live view; MJPEG cameras keep the proxied image", async () => {
  const Card = await cardClass();
  const card = new Card();
  const mount = fakeMount();
  const media = [];
  const created = [];
  card._root = { getElementById: (id) => (id === "camera" ? mount : null) };
  card._syncMedia = (...args) => media.push(args);
  card._cfg = { camera: "camera.printer" };
  const hass = { states: { "camera.printer": { state: "idle", attributes: { supported_features: 0 } } } };
  card._hass = hass;
  card._syncCamera();
  assert.deepEqual(JSON.parse(JSON.stringify(media.pop())), ["camera", "camera.printer", true, "No camera"]);

  // WebRTC camera, helpers not loaded yet: stills meanwhile, helpers requested once.
  hass.states["camera.printer"] = { state: "streaming", attributes: { supported_features: 2 } };
  card._loadCardHelpers = () => { card._requested = (card._requested || 0) + 1; };
  card._syncCamera();
  assert.deepEqual(JSON.parse(JSON.stringify(media.pop())), ["camera", "camera.printer", false, "No camera"]);
  assert.equal(card._requested, 1);

  card._cardHelpers = { createCardElement: (config) => { created.push(config); return fakeLiveCard(); } };
  card._syncCamera();
  assert.equal(created.length, 1);
  assert.equal(created[0].type, "picture-entity");
  assert.equal(created[0].camera_view, "live");
  assert.equal(mount.children[0].hass, hass);
  card._hass = { ...hass };
  card._syncCamera();
  assert.equal(created.length, 1, "live card is reused");
  assert.equal(mount.children[0].hass, card._hass, "hass is forwarded on updates");

  hass.states["camera.printer"] = { state: "idle", attributes: { supported_features: 0 } };
  card._hass = hass;
  const live = mount.children[0];
  card._syncCamera();
  assert.equal(live.removed, true, "falls back to MJPEG when streaming is no longer offered");
  assert.equal(media.pop()[2], true);
});

test("failed service calls surface a notification instead of rejecting", async () => {
  const Card = await cardClass();
  const card = new Card();
  const events = [];
  card.dispatchEvent = (event) => events.push(event);
  card._hass = { callService: async () => { throw new Error("Printer not connected"); } };
  await card._press("button.pause");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "hass-notification");
  assert.ok(events[0].detail.message.includes("Printer not connected"));
});

test("layer overlay rises, holds while paused, resets per job and only completes on finish", async () => {
  const Card = await cardClass();
  const card = new Card();
  const css = {}, attrs = {};
  const overlay = { style: { setProperty: (k,v) => css[k] = v }, classList: { toggle() {} },
    setAttribute: (k,v) => attrs[k] = v };
  const caption = {};
  const img = { dataset: { loaded: "true" } };
  const mount = { querySelector: s => ({ ".layer-overlay": overlay, ".layer-caption": caption, img })[s] };
  card._root = { getElementById: () => mount };
  card._cfg = { preview: "image.print" };
  const values = { layer: "25", total_layers: "100", status: "printing", object: "part" };
  const metadata = { state_raw: 1, print_start_time: 1 };
  card._val = k => values[k];
  card._st = () => ({ attributes: metadata });
  const update = () => card._syncLayerOverlay();
  update();
  assert.equal(css["--layer-progress"], "25%");
  assert.equal(attrs["aria-valuenow"], "25");
  assert.ok(caption.innerHTML.includes("Approximate layer view"));
  values.status = "paused"; metadata.state_raw = 5; update();
  values.layer = "50"; update();
  assert.equal(css["--layer-progress"], "25%");
  values.status = "printing"; metadata.state_raw = 1; update();
  assert.equal(css["--layer-progress"], "50%");
  values.status = "completed"; update();
  assert.equal(css["--layer-progress"], "50%", "Heuristic completed state does not force 100%");
  metadata.state_raw = 2; update();
  assert.equal(css["--layer-progress"], "100%");
  assert.ok(caption.innerHTML.includes("Complete"));
  metadata.print_start_time = 2; metadata.state_raw = 1;
  values.status = "printing"; values.layer = "0"; update();
  assert.equal(css["--layer-progress"], "0%");
  values.layer = "250"; update();
  assert.equal(css["--layer-progress"], "100%", "Clamp overrange layers");
  for (const total of ["0", "unknown", "unavailable", "-1", "NaN"]) {
    values.total_layers = total; update(); assert.equal(overlay.hidden, true);
  }
  values.total_layers = "100"; values.layer = "unavailable"; update();
  assert.equal(overlay.hidden, true);
  values.layer = "50"; img.dataset.loaded = "false"; update();
  assert.equal(overlay.hidden, true, "No overlay on a loading or broken image");
  img.dataset.loaded = "true"; update();
  assert.equal(overlay.hidden, false);
  card._profile = { layers: 100 }; update();
  assert.equal(overlay.hidden, true, "Profile silhouette replaces the thumbnail overlay");
  assert.equal(caption.hidden, true);
  mount.hidden = true; update();
  assert.equal(overlay.hidden, false, "Overlay returns when the profile tile is hidden");
});

test("finish time comes from history when an HA restart moved the status's last change", async () => {
  // The print ended an hour in; HA restarted three hours later (status offline, then completed again).
  const end = T0 + 3600;
  const { card, calls } = await meterCard("W", [{ s: "100", lu: T0 - 60 }], { "sensor.status": [
    { s: "processing", lu: T0 - 120 }, { s: "printing", lu: T0 }, { s: "completed", lu: end },
    { s: "unavailable", lu: end + 10800 }, { s: "offline", lu: end + 10805 }, { s: "completed", lu: end + 10830 },
  ] });
  const restartedAt = (end + 10830) * 1000;
  const job = { jobKey: "job", startTime: T0, finishedAt: restartedAt, ended: new Date(restartedAt).toISOString() };
  card._completedJob = job;
  card._lastJobDraft = { ...job };
  card._timelapse = { key: "sensor.status|job", since: restartedAt };
  await card._refineFinishedAt(job);
  assert.equal(calls[0].entity_ids[0], "sensor.status");
  assert.equal(card._completedJob.finishedAt, end * 1000);
  assert.equal(card._completedJob.ended, new Date(end * 1000).toISOString());
  assert.equal(card._lastJobDraft.finishedAt, end * 1000);
  assert.equal(card._timelapse.since, end * 1000, "timelapse wait measured from the real finish");
  // A final measurement up to the restart is redone up to the real finish:
  // 100 W from the meter's first sample (T0-60 s) to the end.
  card._meterEnergy = { jobKey: "job", finishedAt: restartedAt, final: true, kwh: 1.4, at: Date.now() };
  await card._refreshMeterEnergy();
  assert.ok(Math.abs(card._energyUsedKwh() - (100 * 3660) / 3.6e6) < 1e-9);
  assert.equal(card._meterEnergy.finishedAt, end * 1000);
});

test("finish lookup ignores an earlier job's completion and a job with no active history", async () => {
  // The previous job's "completed" is still in effect at this job's start time.
  const { card } = await meterCard("W", [], { "sensor.status": [{ s: "completed", lu: T0 - 900 }] });
  const job = { jobKey: "job", startTime: T0, finishedAt: (T0 + 3600) * 1000 };
  card._completedJob = job;
  await card._refineFinishedAt(job);
  assert.equal(card._completedJob.finishedAt, (T0 + 3600) * 1000, "never moved to the start time");
});
