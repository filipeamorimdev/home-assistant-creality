// Run with node --test tests/test_card_print_details.mjs; no Home Assistant required.
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

const flush = () => new Promise(resolve => setImmediate(resolve));
const fetches = [];
const revoked = [];
globalThis.fetch = async (url) => {
  fetches.push(url);
  return new Response(new Uint8Array(11), { headers: { 'Content-Length': '11' } });
};
let blobs = 0;
URL.createObjectURL = (blob) => `blob:${++blobs}:${blob.size}`;
URL.revokeObjectURL = (url) => revoked.push(url);

// Saved 2026-10-12 from a live print (turnigy_PLA_1m.gcode, printer history: 98 s, 52.25 mm).
const ROW = {
  id: 'p1', jobKey: 'sensor.status|1791818714||turnigy_PLA_1m.gcode', ended: '2026-10-12T15:28:00.000Z',
  file: 'turnigy_PLA_1m.gcode', result: 'completed', timeLabel: '1:38', timeSeconds: 98, layers: '35 / 35',
  progress: 100, used: 52, usedUnit: 'mm', filamentType: 'PLA', diameterMm: 1.75, costPerKg: 16,
  currency: '€', weightG: 0.155, estimatedCost: 0.0025, energyKwh: 0.014, energyQuality: 'complete',
  costPerKwh: 0.14, estimatedEnergyCost: 0.00196, notes: '',
};
const READY = {
  status: 'ready', url: '/api/creality/timelapse/e/1791818714.mp4?authSig=a',
  download_url: '/api/creality/timelapse/e/1791818714.mp4?download=1&authSig=a', size: 5811324, duration: 58,
  expires_in: 3600, filename: 'turnigy_PLA_1m-timelapse.mp4', saved_as: '/media/tl/2026-10-12_162514_turnigy_PLA_1m.mp4',
};

function node() {
  return {
    dataset: {}, attrs: {}, hidden: false, played: 0, innerHTML: '', textContent: '',
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; this.src = undefined; },
    pause() {}, load() {}, focus() {}, querySelector: () => null,
    play() { this.played++; return Promise.resolve(); },
  };
}

function detailsCard(responses) {
  const card = Object.create(Card.prototype);
  const nodes = {};
  const calls = [];
  card._root = { getElementById: id => (nodes[id] ??= node()) };
  card._cfg = { status: 'sensor.status' };
  card._prints = [{ ...ROW }];
  card._hass = {
    states: {},
    callWS: async (msg) => {
      calls.push(msg);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { card, nodes, calls };
}

test('details show units, sub-cent costs and no internal energy tag', () => {
  const { card, nodes } = detailsCard([]);
  card._hass = null;
  card._showPrintDetails('p1');
  const html = nodes['log-detail'].innerHTML;
  assert.match(html, /<dt>Time spent<\/dt><dd>1m 38s<\/dd>/);
  assert.match(html, /<dt>Energy<\/dt><dd>0\.014 kWh<\/dd>/);
  assert.match(html, /<dt>Filament cost<\/dt><dd>&lt; €0\.01<\/dd>/);
  assert.match(html, /<dt>Total cost<\/dt><dd>&lt; €0\.01<\/dd>/);
  assert.match(html, /<dt>Cost \/ kg<\/dt><dd>€16\.00<\/dd>/);
  assert.equal(nodes['log-tl'].hidden, true); // No way to look it up.
});

test('details look up the timelapse by job id, play it whole and drop it on close', async () => {
  fetches.length = 0;
  revoked.length = 0;
  const { card, nodes, calls } = detailsCard([READY]);
  card._showPrintDetails('p1');
  assert.equal(nodes['log-tl'].hidden, false);
  assert.equal(nodes['log-tl-text'].textContent, 'Checking…');
  await flush();
  assert.deepEqual(calls, [{ type: 'creality/timelapse', entity_id: 'sensor.status', print_start_time: 1791818714 }]);
  assert.equal(nodes['log-tl-text'].textContent, '58s · 5.8 MB · Saved to /media/tl/2026-10-12_162514_turnigy_PLA_1m.mp4');
  assert.equal(nodes['log-tl-play'].hidden, false);
  assert.equal(nodes['log-tl-download'].hidden, false);

  await card._toggleDetailTimelapse();
  assert.deepEqual(fetches, [READY.url]);
  assert.equal(nodes['log-tl-video'].src, 'blob:1:11');
  assert.equal(nodes['log-tl-video'].hidden, false);
  assert.equal(nodes['log-tl-video'].played, 1);
  assert.equal(nodes['log-tl-play'].textContent, 'Hide');

  card._closePrintModal();
  assert.deepEqual(revoked, ['blob:1:11']);
  assert.equal(nodes['log-tl'].hidden, true);
  assert.equal(nodes['log-tl-video'].hidden, true);
});

test('missing timelapse explains why or points at the saved copy', async () => {
  const { card, nodes } = detailsCard([{ status: 'missing' }, { status: 'missing', saved_as: '/media/tl/a.mp4' }]);
  card._showPrintDetails('p1');
  await flush();
  assert.match(nodes['log-tl-text'].textContent, /no timelapse for this print/);
  assert.equal(nodes['log-tl-play'].hidden, true);
  assert.equal(nodes['log-tl-download'].hidden, true);
  card._showPrintDetails('p1');
  await flush();
  assert.equal(nodes['log-tl-text'].textContent, 'Saved to /media/tl/a.mp4 (no longer on the printer)');
});

test('rows without a job id skip the lookup', async () => {
  const { card, nodes, calls } = detailsCard([READY]);
  card._prints = [{ ...ROW, jobKey: '' }];
  card._showPrintDetails('p1');
  await flush();
  assert.deepEqual(calls, []);
  assert.equal(nodes['log-tl'].hidden, true);
});
