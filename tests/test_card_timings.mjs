// Run with node --test tests/test_card_timings.mjs; no Home Assistant required.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

let Card;
globalThis.HTMLElement = class {};
globalThis.customElements = {
  whenDefined: async () => {},
  get: () => undefined,
  define: (_, cls) => { Card = cls; },
};
globalThis.window = {};
const source = fs.readFileSync(new URL('../custom_components/creality/frontend/creality-card.js', import.meta.url));
await import(`data:text/javascript;base64,${source.toString('base64')}`);

const FINISH = '2026-10-13T14:20:00Z';

function timings(status, ours, cfg = { time_left_estimated: 'sensor.ours' }) {
  const card = Object.create(Card.prototype);
  const nodes = { 'time-real': {}, 'time-creality': {}, 'time-ours': {}, 'timing-ours': { hidden: false } };
  card._root = { getElementById: id => nodes[id] };
  card._cfg = { job_time: 'sensor.job', time_left: 'sensor.left', ...cfg };
  card._hass = { states: {
    'sensor.job': { state: '3600', attributes: {} },
    'sensor.left': { state: '1200', attributes: {} },
    ...(ours === undefined ? {} : { 'sensor.ours': { state: ours, attributes: { expected_finish: FINISH } } }),
  } };
  card._hass.locale = { language: 'en', time_format: '24' };
  card._syncTimings(status);
  return nodes;
}

test('own estimate shows the initial print time and its finish clock', () => {
  const clock = new Date(FINISH).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
  const nodes = timings('printing', '1500');
  assert.equal(nodes['timing-ours'].hidden, false);
  assert.equal(nodes['time-ours'].textContent, `25:00 · ETA ${clock}`);
  assert.notEqual(nodes['time-creality'].textContent, '—');
  // Kept on the finished job for comparison with the real time.
  assert.equal(timings('completed', '1500')['time-ours'].textContent, `25:00 · ETA ${clock}`);
  assert.equal(timings('idle', '1500')['time-ours'].textContent, '—');
});

test('switch off (sensor unavailable) hides own estimate, keeps real and Creality', () => {
  const nodes = timings('printing', 'unavailable');
  assert.equal(nodes['timing-ours'].hidden, true);
  assert.notEqual(nodes['time-real'].textContent, '—');
  assert.notEqual(nodes['time-creality'].textContent, '—');
});

test('missing or unconfigured estimate sensor hides own estimate', () => {
  assert.equal(timings('printing', undefined)['timing-ours'].hidden, true);
  assert.equal(timings('printing', '1500', {})['timing-ours'].hidden, true);
});

test('progress header shows the printer time left and finish clock, not the fixed estimate', () => {
  const card = Object.create(Card.prototype);
  const nodes = { 'progress-eta': {}, 'timing-ours': {} };
  card._root = { getElementById: id => nodes[id] };
  card._cfg = { job_time: 'sensor.job', time_left: 'sensor.left', time_left_estimated: 'sensor.ours' };
  card._hass = { states: {
    'sensor.job': { state: '3600', attributes: {} },
    'sensor.left': { state: '1200', attributes: {} },
    'sensor.ours': { state: '1500', attributes: {} },
  } };
  card._syncTimings('printing');
  assert.match(nodes['progress-eta'].textContent, /^20:00 left · ETA \d/);
  card._syncTimings('completed');
  assert.equal(nodes['progress-eta'].textContent, 'Done');
  card._syncTimings('idle');
  assert.equal(nodes['progress-eta'].textContent, '');
});

test('finish clock follows the Home Assistant 12/24-hour setting', () => {
  const card = Object.create(Card.prototype);
  const nodes = { 'progress-eta': {} };
  card._root = { getElementById: id => nodes[id] };
  card._cfg = { time_left: 'sensor.left' };
  const states = { 'sensor.left': { state: '1200', attributes: {} } };
  card._hass = { states, locale: { language: 'en', time_format: '24' } };
  card._syncTimings('printing');
  assert.doesNotMatch(nodes['progress-eta'].textContent, /AM|PM/);
  card._hass = { states, locale: { language: 'en', time_format: '12' } };
  card._syncTimings('printing');
  assert.match(nodes['progress-eta'].textContent, /AM|PM/);
});

test('no job: job details are hidden', () => {
  const card = Object.create(Card.prototype);
  const nodes = {};
  const wide = {};
  card._root = { getElementById: id => (nodes[id] ??= { hidden: false, classList: { toggle(cls, on) { if (cls === 'tile-wide') wide[id] = on; } }, style: { setProperty() {} }, append() {}, closest: () => null }) };
  card._closeCameraZoom = () => {};
  card._cfg = { status: 'sensor.status', progress: 'sensor.p', object: 'sensor.f', layer: 'sensor.l', job_time: 'sensor.job', time_left: 'sensor.left', used_material: 'sensor.m' };
  const ids = ['progress-head', 'meta-head', 'file-row', 'layer-row', 'bar-row', 'timings', 'times'];
  card._hass = { states: { 'sensor.status': { state: 'stopped', attributes: {} } } };
  card._syncPrintLayout('stopped');
  for (const id of ids) assert.equal(nodes[id].hidden, true, id);
  // Profile and thumbnail merge into one placeholder tile.
  card._cfg = { ...card._cfg, preview: 'image.p' };
  card._syncPrintLayout('stopped');
  assert.equal(nodes['preview-tile'].hidden, true);
  assert.equal(nodes['profile-tile'].hidden, false);
  assert.equal(wide['profile-tile'], true);
  card._hass = { states: { 'sensor.status': { state: 'stopped', attributes: { file: 'a.gcode' } } } };
  card._syncPrintLayout('stopped');
  for (const id of ids) assert.equal(nodes[id].hidden, false, id);
  assert.equal(nodes['preview-tile'].hidden, false);
  assert.equal(wide['profile-tile'], false);
  // Idle with the last print's file still loaded is no job either.
  card._hass = { states: { 'sensor.status': { state: 'idle', attributes: { file: 'a.gcode' } } } };
  card._syncPrintLayout('idle');
  for (const id of [...ids, 'ring', 'cam-pct', 'cam-layer']) assert.equal(nodes[id].hidden, true, id);
  assert.equal(nodes['cam-badge'].hidden, false);
  // Without a status entity there is no way to tell, so nothing is hidden.
  card._cfg = { ...card._cfg, status: '' };
  card._syncPrintLayout('unknown');
  for (const id of ids) assert.equal(nodes[id].hidden, false, id);
});

test('controls and temperature start collapsed even after being expanded', () => {
  const panel = key => ({
    dataset: { panel: key },
    classList: { _on: false, contains() { return this._on; }, toggle(_, on) { this._on = on; } },
    querySelector: () => ({ setAttribute() {} }),
  });
  const panels = ['print', 'controls', 'temp', 'log'].map(panel);
  const store = {};
  globalThis.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
  const card = Object.create(Card.prototype);
  card._cfg = { status: 'sensor.status' };
  card._root = { querySelectorAll: () => panels };
  card._applyCollapsed();
  assert.deepEqual(panels.map(p => p.classList._on), [false, true, true, false]);
  card._togglePanel(panels[2]); // expand Temperature
  card._togglePanel(panels[3]); // collapse Print history
  card._applyCollapsed();
  assert.deepEqual(panels.map(p => p.classList._on), [false, true, true, true]);
  delete globalThis.localStorage;
});
