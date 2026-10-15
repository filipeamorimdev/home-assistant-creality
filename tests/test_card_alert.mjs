// Run with node --test tests/test_card_alert.mjs; no Home Assistant required.
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
const storage = new Map();
globalThis.localStorage = {
  getItem: k => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: k => storage.delete(k),
};
const source = fs.readFileSync(new URL('../custom_components/creality/frontend/creality-card.js', import.meta.url));
await import(`data:text/javascript;base64,${source.toString('base64')}`);

function alertCard(attributes, { keepStorage = false } = {}) {
  if (!keepStorage) storage.clear();
  const card = Object.create(Card.prototype);
  const classes = new Set();
  const nodes = {
    'printer-alert': { hidden: true, dataset: {}, classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } },
    'printer-alert-icon': { setAttribute(_, v) { this.icon = v; } },
    'printer-alert-title': {},
    'printer-alert-detail': {},
  };
  card._root = { getElementById: id => nodes[id] };
  card._cfg = { status: 'sensor.status' };
  card._hass = { states: { 'sensor.status': { state: 'idle', attributes } } };
  card._syncPrinterAlert();
  return { card, nodes, classes };
}

test('no alert without an error key', () => {
  const { nodes } = alertCard({ err_key: 0, err_severity: 'ok', err_message: '' });
  assert.equal(nodes['printer-alert'].hidden, true);
  assert.equal(alertCard(undefined).nodes['printer-alert'].hidden, true);
});

test('warning shows the message with the printer value and the solution', () => {
  const { nodes, classes } = alertCard({
    err_key: 508, err_severity: 'warning', err_value: '90%',
    err_message: 'Current storage space usage has reached %s, please clean up in time',
    err_solution: 'Delete old G-code files.',
  });
  assert.equal(nodes['printer-alert'].hidden, false);
  assert.ok(!classes.has('is-error'));
  assert.equal(nodes['printer-alert-title'].textContent,
    'Printer warning 508: Current storage space usage has reached 90%, please clean up in time');
  assert.equal(nodes['printer-alert-detail'].textContent, 'Delete old G-code files.');
  assert.equal(nodes['printer-alert-icon'].icon, 'mdi:alert');
});

test('unknown key still shows, fatal errors are styled as errors', () => {
  const unknown = alertCard({ err_key: 9999, err_severity: 'unknown', err_message: 'Error key 9999' });
  assert.equal(unknown.nodes['printer-alert'].hidden, false);
  assert.equal(unknown.nodes['printer-alert-title'].textContent, 'Printer warning 9999: Error key 9999');
  assert.equal(unknown.nodes['printer-alert-detail'].textContent, '');
  const fatal = alertCard({ err_key: 1, err_severity: 'error', err_message: 'Nozzle heating failed' });
  assert.ok(fatal.classes.has('is-error'));
  assert.equal(fatal.nodes['printer-alert-icon'].icon, 'mdi:alert-octagon');
});

test('dismissed warning stays hidden until it changes or the printer clears it', () => {
  const warning = { err_key: 508, err_severity: 'warning', err_value: '90%', err_message: 'Storage %s' };
  const { card, nodes } = alertCard(warning);
  card._dismissPrinterAlert();
  assert.equal(nodes['printer-alert'].hidden, true);
  // Survives a reload (new card instance).
  assert.equal(alertCard(warning, { keepStorage: true }).nodes['printer-alert'].hidden, true);
  // A different value or key shows again.
  assert.equal(alertCard({ ...warning, err_value: '95%' }, { keepStorage: true }).nodes['printer-alert'].hidden, false);
  assert.equal(alertCard({ ...warning, err_key: 509 }, { keepStorage: true }).nodes['printer-alert'].hidden, false);
  // No `err` reported (e.g. after a reconnect) keeps the dismissal.
  alertCard({ err_key: 0 }, { keepStorage: true });
  assert.equal(alertCard(warning, { keepStorage: true }).nodes['printer-alert'].hidden, true);
  // The printer reporting no error forgets it, so a recurrence shows.
  alertCard({ err_key: 0, err: { key: 0, value: '' } }, { keepStorage: true });
  assert.equal(alertCard(warning, { keepStorage: true }).nodes['printer-alert'].hidden, false);
});

function filamentCard(filament, nozzleTarget, cfg = {}) {
  const card = Object.create(Card.prototype);
  const nodes = {
    'filament-alert': { hidden: true },
    'filament-heat': { hidden: true, disabled: false },
    'filament-change': { hidden: true, disabled: false },
  };
  const calls = [];
  card._root = { getElementById: id => nodes[id] };
  card._cfg = { filament: 'sensor.filament', nozzle_target: 'number.nozzle_target', ...cfg };
  card._hass = {
    states: {
      'sensor.filament': { state: filament, attributes: {} },
      'number.nozzle_target': { state: String(nozzleTarget), attributes: {} },
    },
    callService: async (...args) => { calls.push(args); },
  };
  card._syncFilamentAlert();
  return { card, nodes, calls };
}

test('filament runout shows the banner with a heat button', () => {
  const { nodes } = filamentCard('runout', 0);
  assert.equal(nodes['filament-alert'].hidden, false);
  assert.equal(nodes['filament-heat'].hidden, false);
  assert.equal(nodes['filament-heat'].disabled, false);
  assert.equal(nodes['filament-heat'].textContent, 'Heat nozzle to 240 °C');
});

test('no filament banner while filament is normal or unknown', () => {
  assert.equal(filamentCard('normal', 0).nodes['filament-alert'].hidden, true);
  assert.equal(filamentCard('unavailable', 0).nodes['filament-alert'].hidden, true);
  assert.equal(filamentCard('normal', 0).nodes['filament-heat'].hidden, true);
});

test('heat button sets the nozzle target to 240 and is disabled once reached', async () => {
  const { card, calls } = filamentCard('runout', 0);
  await card._heatForFilamentChange();
  assert.deepEqual(calls, [['number', 'set_value', { entity_id: 'number.nozzle_target', value: 240 }]]);
  const hot = filamentCard('runout', 240).nodes['filament-heat'];
  assert.equal(hot.disabled, true);
  assert.equal(hot.textContent, 'Nozzle set to 240 °C');
});

test('heat button is hidden without a configured nozzle target', () => {
  const { nodes } = filamentCard('runout', 0, { nozzle_target: undefined });
  assert.equal(nodes['filament-alert'].hidden, false);
  assert.equal(nodes['filament-heat'].hidden, true);
});

test('dismissed runout banner returns on the next runout', () => {
  const { card, nodes } = filamentCard('runout', 0);
  card._filamentAlertDismissed = true;
  card._syncFilamentAlert();
  assert.equal(nodes['filament-alert'].hidden, true);
  assert.equal(nodes['filament-heat'].hidden, true);
  card._hass.states['sensor.filament'] = { state: 'normal', attributes: {} };
  card._syncFilamentAlert();
  card._hass.states['sensor.filament'] = { state: 'runout', attributes: {} };
  card._syncFilamentAlert();
  assert.equal(nodes['filament-alert'].hidden, false);
});

test('Replace filament in Controls heats the nozzle without a runout', async () => {
  const { card, nodes, calls } = filamentCard('normal', 0);
  assert.equal(nodes['filament-change'].hidden, false);
  assert.equal(nodes['filament-change'].disabled, false);
  await card._heatForFilamentChange();
  assert.deepEqual(calls, [['number', 'set_value', { entity_id: 'number.nozzle_target', value: 240 }]]);
  assert.equal(filamentCard('normal', 240).nodes['filament-change'].disabled, true);
  assert.equal(filamentCard('normal', 0, { nozzle_target: undefined }).nodes['filament-change'].hidden, true);
});

test('filament_change_temp overrides the 240 °C default', async () => {
  const { card, nodes, calls } = filamentCard('runout', 0, { filament_change_temp: 220 });
  assert.equal(nodes['filament-heat'].textContent, 'Heat nozzle to 220 °C');
  await card._heatForFilamentChange();
  assert.deepEqual(calls, [['number', 'set_value', { entity_id: 'number.nozzle_target', value: 220 }]]);
  assert.equal(filamentCard('normal', 225, { filament_change_temp: 220 }).nodes['filament-change'].disabled, true);
});
