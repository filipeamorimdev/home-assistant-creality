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
const source = fs.readFileSync(new URL('../custom_components/creality/frontend/creality-card.js', import.meta.url));
await import(`data:text/javascript;base64,${source.toString('base64')}`);

function alertCard(attributes) {
  const card = Object.create(Card.prototype);
  const classes = new Set();
  const nodes = {
    'printer-alert': { hidden: true, classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } },
    'printer-alert-icon': { setAttribute(_, v) { this.icon = v; } },
    'printer-alert-title': {},
    'printer-alert-detail': {},
  };
  card._root = { getElementById: id => nodes[id] };
  card._cfg = { status: 'sensor.status' };
  card._hass = { states: { 'sensor.status': { state: 'idle', attributes } } };
  card._syncPrinterAlert();
  return { nodes, classes };
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
