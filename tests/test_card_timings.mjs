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

function timings(status, ours, cfg = { time_left_estimated: 'sensor.ours' }) {
  const card = Object.create(Card.prototype);
  const nodes = { 'time-real': {}, 'time-creality': {}, 'time-ours': {}, 'timing-ours': { hidden: false } };
  card._root = { getElementById: id => nodes[id] };
  card._cfg = { job_time: 'sensor.job', time_left: 'sensor.left', ...cfg };
  card._hass = { states: {
    'sensor.job': { state: '3600', attributes: {} },
    'sensor.left': { state: '1200', attributes: {} },
    ...(ours === undefined ? {} : { 'sensor.ours': { state: ours, attributes: {} } }),
  } };
  card._syncTimings(status);
  return nodes;
}

test('own estimate is shown while its sensor is available', () => {
  const nodes = timings('printing', '1500');
  assert.equal(nodes['timing-ours'].hidden, false);
  assert.equal(nodes['time-ours'].textContent, '25:00');
  assert.notEqual(nodes['time-creality'].textContent, '—');
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

test('progress header shows time left and finish clock from the best estimate', () => {
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
  assert.match(nodes['progress-eta'].textContent, /^25:00 left · ETA \d/);
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
