// Run with node --test tests/test_card_compact.mjs; no Home Assistant required.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const cards = {};
globalThis.HTMLElement = class {};
globalThis.customElements = {
  whenDefined: async () => {},
  get: () => undefined,
  define: (name, cls) => { cards[name] = cls; },
};
globalThis.window = {};
const source = fs.readFileSync(new URL('../custom_components/creality/frontend/creality-card.js', import.meta.url));
await import(`data:text/javascript;base64,${source.toString('base64')}`);
const Compact = cards['creality-compact-card'];

/** Element stand-in: enough of the DOM for the card's sync methods. */
function node() {
  const classes = new Set();
  return {
    hidden: false, textContent: '', title: '', className: '',
    classList: { toggle: (cls, on) => (on ? classes.add(cls) : classes.delete(cls)), contains: cls => classes.has(cls) },
    style: { setProperty() {} },
    setAttribute() {},
    querySelector: () => null,
  };
}

function compactCard(cfg, states, extra = {}) {
  const card = Object.create(Compact.prototype);
  const nodes = {};
  card._root = { getElementById: id => (nodes[id] ??= node()), querySelector: () => node() };
  card._cfg = cfg;
  card._hass = { states, locale: { language: 'en', time_format: '24' }, ...extra };
  card._printPrefs = {};
  card._built = true;
  return { card, nodes };
}

const PRINTING = {
  'sensor.status': { state: 'printing', attributes: { file: 'part.gcode', state_raw: 1 } },
  'sensor.progress': { state: '42', attributes: { unit_of_measurement: '%' } },
  'sensor.file': { state: 'part.gcode', attributes: {} },
  'sensor.layer': { state: '12', attributes: {} },
  'sensor.layers': { state: '150', attributes: {} },
  'sensor.left': { state: '1200', attributes: {} },
  'sensor.job': { state: '3600', attributes: {} },
  'sensor.nozzle': { state: '209.6', attributes: {} },
  'number.nozzle_target': { state: '210', attributes: {} },
  'sensor.bed': { state: '60.2', attributes: {} },
  'sensor.plug': { state: '123.4', attributes: { unit_of_measurement: 'W' } },
};
const CONFIG = {
  status: 'sensor.status', progress: 'sensor.progress', object: 'sensor.file', layer: 'sensor.layer',
  total_layers: 'sensor.layers', time_left: 'sensor.left', job_time: 'sensor.job', nozzle: 'sensor.nozzle',
  nozzle_target: 'number.nozzle_target', bed: 'sensor.bed', print_energy: 'sensor.plug',
};

/** Run _update without the camera stream and G-code fetch. */
function update(card) {
  card._syncProfile = () => {};
  card._syncCameraViews = () => {};
  card._update();
}

test('stub config keeps only the compact card keys of one printer', async () => {
  const entry = (entity_id, suffix) => ({ entity_id, unique_id: `printer-a_${suffix}`, config_entry_id: 'printer-a',
    device_id: 'printer-a', platform: 'creality' });
  const entries = [entry('sensor.status', 'print_status'), entry('camera.cam', 'printer_camera'),
    entry('fan.model', 'model_fan'), entry('button.home', 'home_xy_then_z'), entry('number.nozzle', 'nozzle_target'),
    entry('sensor.nozzle', 'nozzle_temperature')];
  const hass = {
    states: Object.fromEntries(entries.map(e => [e.entity_id, { state: 'idle' }])),
    devices: { 'printer-a': { name: 'Workshop' } },
    callWS: async () => entries,
  };
  const config = await Compact.getStubConfig(hass);
  assert.deepEqual(config, { title: 'Workshop', preview: '', printer_switch: '', status: 'sensor.status',
    camera: 'camera.cam' });
});

test('running job shows progress, layers, finish time and power', () => {
  const { card, nodes } = compactCard(CONFIG, PRINTING);
  update(card);
  assert.equal(nodes['status-badge'].textContent, 'Printing');
  assert.equal(nodes['status-badge'].className, 'badge is-print');
  assert.equal(nodes.job.hidden, false);
  assert.equal(nodes.file.textContent, 'part.gcode');
  assert.equal(nodes.pct.textContent, '42%');
  assert.equal(nodes['c-layer'].textContent, '12 / 150');
  assert.match(nodes['c-eta'].textContent, /^\d\d:\d\d$/);
  assert.equal(nodes['c-eta-left'].textContent, '20:00 left');
  assert.equal(nodes['c-elapsed'].textContent, '1:00:00');
  for (const id of ['stat-layer', 'stat-eta', 'stat-elapsed', 'stat-power']) {
    assert.equal(nodes[id].hidden, false, id);
  }
  // No camera configured: the G-code tile has the media row to itself.
  assert.equal(nodes['camera-tile'].hidden, true);
  assert.equal(nodes['gcode-tile'].hidden, false);
  assert.equal(nodes.media.classList.contains('single'), true);
});

test('no job hides the job line and job stats but keeps power', () => {
  const states = { ...PRINTING, 'sensor.status': { state: 'idle', attributes: { file: 'part.gcode' } } };
  const { card, nodes } = compactCard({ ...CONFIG, camera: 'camera.cam' }, states);
  update(card);
  assert.equal(nodes['status-badge'].textContent, 'Idle');
  assert.equal(nodes.job.hidden, true);
  for (const id of ['stat-layer', 'stat-eta', 'stat-elapsed']) assert.equal(nodes[id].hidden, true, id);
  for (const id of ['stat-power', 'stats']) assert.equal(nodes[id].hidden, false, id);
  assert.equal(nodes.media.classList.contains('single'), false);
});

test('unconfigured entities are left out', () => {
  const { card, nodes } = compactCard({ status: 'sensor.status', layer: 'sensor.layer' }, PRINTING);
  update(card);
  assert.equal(nodes['stat-layer'].hidden, false);
  for (const id of ['stat-eta', 'stat-elapsed', 'stat-power', 'file', 'pct', 'bar-row']) {
    assert.equal(nodes[id].hidden, true, id);
  }
});

test('finish time: clock while printing, Done when completed, nothing when idle', () => {
  const { card, nodes } = compactCard(CONFIG, PRINTING);
  card._syncEta('printing');
  assert.match(card._zoomEta(), /^20:00 left · ETA \d\d:\d\d$/);
  card._syncEta('completed');
  assert.equal(nodes['c-eta'].textContent, 'Done');
  assert.equal(nodes['c-eta-left'].textContent, '');
  assert.equal(card._zoomEta(), 'Done');
  card._syncEta('idle');
  assert.equal(nodes['c-eta'].textContent, '—');
  assert.equal(card._zoomEta(), '');
});

test('power shows the printer share once the power offset is known', () => {
  const { card, nodes } = compactCard(CONFIG, PRINTING);
  card._displayAutoBaseline = () => undefined; // Offset lookup still running.
  card._syncPowerNow();
  assert.equal(nodes['c-power'].textContent, '123 W');
  assert.equal(nodes['c-power-label'].textContent, 'Power');
  card._displayAutoBaseline = () => 20; // Meter reading at the printer's last power-on.
  card._syncPowerNow();
  assert.equal(nodes['c-power'].textContent, '103 W');
  assert.equal(nodes['stat-power'].title, 'Meter 123 W, power offset 20 W removed');
  card._printPrefs = { baselineW: 100 }; // Set on the full card; wins over the automatic one.
  card._syncPowerNow();
  assert.equal(nodes['c-power'].textContent, '23 W');
  card._printPrefs = { baselineW: 500 };
  card._syncPowerNow();
  assert.equal(nodes['c-power'].textContent, '0 W');
});

test('power converts kW, and energy counters show their total', () => {
  const kw = { ...PRINTING, 'sensor.plug': { state: '0.25', attributes: { unit_of_measurement: 'kW' } } };
  let { card, nodes } = compactCard(CONFIG, kw);
  card._displayAutoBaseline = () => null;
  card._syncPowerNow();
  assert.equal(nodes['c-power'].textContent, '250 W');
  const kwh = { ...PRINTING, 'sensor.plug': { state: '12.5', attributes: { unit_of_measurement: 'kWh' } } };
  ({ card, nodes } = compactCard(CONFIG, kwh));
  card._syncPowerNow();
  assert.equal(nodes['c-power-label'].textContent, 'Energy');
  assert.equal(nodes['c-power'].textContent, '12.50 kWh');
  const unavailable = { ...PRINTING, 'sensor.plug': { state: 'unavailable', attributes: {} } };
  ({ card, nodes } = compactCard(CONFIG, unavailable));
  card._syncPowerNow();
  assert.equal(nodes['c-power'].textContent, '—');
});

test('power offset is read from the full card preferences without saving them', async () => {
  const calls = [];
  const callWS = async (msg) => {
    calls.push(msg.type);
    return { value: { prefs: { baselineW: 80 }, prints: [] } };
  };
  const { card, nodes } = compactCard(CONFIG, PRINTING, { callWS });
  card._readLocalPrintStore = () => card._defaultPrintStore();
  await card._loadPowerOffset();
  assert.deepEqual(calls, ['frontend/get_user_data']);
  assert.equal(nodes['c-power'].textContent, '43 W');
});

test('printer thumbnail stands in until the G-code silhouette is ready', () => {
  const states = { ...PRINTING, 'image.preview': { state: 't1', attributes: { entity_picture: '/thumb.png' } } };
  const { card, nodes } = compactCard({ ...CONFIG, preview: 'image.preview' }, states);
  nodes['profile-svg'] = node();
  let shown = null;
  card._syncMedia = (mount, entity) => { shown = [mount, entity]; };
  card._drawProfile();
  assert.equal(nodes.profile.hidden, true);
  assert.equal(nodes.thumb.hidden, false);
  assert.equal(nodes['profile-empty'].hidden, true);
  assert.deepEqual(shown, ['thumb', 'image.preview']);
  // With no job, the placeholder text shows instead of the last job's thumbnail.
  card._hass.states['sensor.status'] = { state: 'idle', attributes: {} };
  card._drawProfile();
  assert.equal(nodes.thumb.hidden, true);
  assert.equal(nodes['profile-empty'].hidden, false);
  assert.equal(nodes['profile-empty'].textContent, 'No printing job running');
});

test('enlarged camera shows status, progress, layer and finish time', () => {
  const { card, nodes } = compactCard(CONFIG, PRINTING);
  card._syncEta('printing');
  card._syncZoomInfo();
  assert.match(nodes['camera-zoom-info'].textContent, /^Printing · 42% · Layer 12 \/ 150 · 20:00 left · ETA \d\d:\d\d$/);
});
