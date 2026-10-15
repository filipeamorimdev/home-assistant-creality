// Run with node --test tests/test_card_profile.mjs; no Home Assistant required.
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

const PROFILE = {
  version: 1,
  layers: 4,
  z: [0.2, 0.4, 0.6, 0.8],
  x: { min: 10, size: 20, bands: [[0, 1, [[0, 20]]], [2, 3, [[0, 5], [15, 20]]]] },
  y: { min: 0, size: 8, bands: [[0, 3, [[0, 8]]]] },
};

test('profileSvg splits bands at the printed layer and draws the cursor', () => {
  const { viewBox, body } = Card.profileSvg(PROFILE, 'x', 3);
  // Flat parts are lifted to 12% of the width so they stay visible.
  assert.equal(viewBox, '0 0 20 2.4');
  const printed = body.match(/class="printed" d="([^"]+)"/)[1];
  const remaining = body.match(/class="remaining" d="([^"]+)"/)[1];
  assert.equal(printed.split('M').length - 1, 3); // layers 0-1 band + two spans of layer 2
  assert.equal(remaining.split('M').length - 1, 2); // two spans of layer 3
  assert.match(body, /<line class="cursor"[^>]*y1="1.80"/);
});

test('profileSvg omits the cursor before the first and after the last layer', () => {
  assert.doesNotMatch(Card.profileSvg(PROFILE, 'y', 0).body, /cursor|class="printed"/);
  const done = Card.profileSvg(PROFILE, 'y', 4).body;
  assert.doesNotMatch(done, /cursor|class="remaining"/);
});

function profileCard(responses, file = '/usr/data/printer_data/gcodes/a.gcode') {
  const card = Object.create(Card.prototype);
  const calls = [];
  card._cfg = { status: 'sensor.status' };
  card._hass = {
    states: { 'sensor.status': { state: 'printing', attributes: { file, print_start_time: 1 } } },
    callWS: async (msg) => {
      calls.push(msg);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  card._drawProfile = () => {};
  card._profileKey = card._profileJobKey();
  return { card, calls };
}

test('fetchProfile stores a ready profile for the current file', async () => {
  const file = '/usr/data/printer_data/gcodes/a.gcode';
  const { card, calls } = profileCard([{ status: 'ready', file, profile: PROFILE }]);
  await card._fetchProfile(card._profileKey);
  assert.deepEqual(calls, [{ type: 'creality/print_profile', entity_id: 'sensor.status' }]);
  assert.equal(card._profile, PROFILE);
  assert.equal(card._profileTimer, undefined);
});

test('fetchProfile polls while loading and stops on unavailable or errors', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const file = '/usr/data/printer_data/gcodes/a.gcode';
  const { card, calls } = profileCard([
    { status: 'loading', file, profile: null },
    { status: 'unavailable', file, profile: null },
  ]);
  await card._fetchProfile(card._profileKey);
  assert.equal(card._profile ?? null, null);
  assert.ok(card._profileTimer);
  t.mock.timers.tick(5000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(card._profileTimer, undefined);

  const failing = profileCard([new Error('unknown_command')]);
  await failing.card._fetchProfile(failing.card._profileKey);
  assert.equal(failing.card._profileTimer, undefined);
});

test('fetchProfile ignores an answer for a job the card no longer shows', async () => {
  const { card } = profileCard([{ status: 'ready', file: '/x.gcode', profile: PROFILE }]);
  const key = card._profileKey;
  card._profileKey = 'other';
  await card._fetchProfile(key);
  assert.equal(card._profile, undefined);
});

test('the profile has its own tile; without one the tile explains why', () => {
  const card = Object.create(Card.prototype);
  const node = () => ({ hidden: false, textContent: '', classList: { toggle() {} }, setAttribute() {}, querySelector: () => null });
  const nodes = { profile: node(), 'profile-svg': node(), 'profile-caption': node(), 'profile-empty': node(), preview: node() };
  card._root = { getElementById: (id) => nodes[id] };
  card._cfg = { status: 'sensor.status', preview: 'image.preview', layer: 'sensor.layer', total_layers: 'sensor.total' };
  card._hass = { states: {
    'sensor.status': { state: 'printing', attributes: { state_raw: 1 } },
    'image.preview': { state: 'x', attributes: { entity_picture: '/p.png' } },
    'sensor.layer': { state: '2' }, 'sensor.total': { state: '4' },
  } };
  card._profileKey = 'job';
  card._profile = PROFILE;
  card._drawProfile();
  // The printer thumbnail keeps its own tile either way.
  assert.deepEqual([nodes.profile.hidden, nodes['profile-empty'].hidden, nodes.preview.hidden], [false, true, false]);
  assert.match(nodes['profile-caption'].innerHTML, /Layer 2 \/ 4 · 50%<small>Approximate layer view · Front/);

  card._profile = null;
  card._profileStatus = 'unavailable';
  card._drawProfile();
  assert.deepEqual([nodes.profile.hidden, nodes['profile-empty'].hidden, nodes.preview.hidden], [true, false, false]);
  assert.equal(nodes['profile-empty'].textContent, 'No G-code profile for this print');

  card._profileKey = '';
  card._drawProfile();
  assert.equal(nodes['profile-empty'].textContent, 'No printing job running');
});

function layoutCard() {
  const card = Object.create(Card.prototype);
  const nodes = {};
  const node = (id) => nodes[id] ??= {
    id, hidden: false, parentNode: null, props: {}, classes: new Set(),
    classList: { toggle(c, on) { on ? this.owner.classes.add(c) : this.owner.classes.delete(c); } },
    style: { setProperty(k, v) { nodes[id].props[k] = v; } },
    append(child) { child.parentNode = this; },
    closest() { return null; },
  };
  card._root = { getElementById: (id) => { const n = node(id); n.classList.owner = n; return n; } };
  card._closeCameraZoom = () => { card.closed = true; };
  return { card, nodes };
}

const hiddenIds = (nodes, ids) => ids.filter((id) => nodes[id].hidden);

test('print layout shows only tiles and lines whose entity is configured', () => {
  const { card, nodes } = layoutCard();
  card._cfg = { camera: 'camera.p', status: 'sensor.s', preview: 'image.p', object: 'sensor.o', job_time: 'sensor.j' };
  card._syncPrintLayout('printing');
  assert.deepEqual(hiddenIds(nodes, ['camera-tile', 'profile-tile', 'preview-tile', 'file-row', 'layer-row', 'bar-row',
    'timing-real', 'timing-creality', 'timings', 'times', 'big-pct', 'controls-panel']),
  ['layer-row', 'bar-row', 'timing-creality', 'times', 'big-pct', 'controls-panel']);
  assert.equal(nodes['media-row'].props['--media-cols'], '4');
  assert.ok(nodes['media-row'].classes.has('has-camera'));
  // The status bar sits over the camera.
  assert.equal(nodes['cam-bar'].parentNode, nodes['camera-tile']);
  assert.ok(nodes['camera-tile'].classes.has('ar-16-9'));

  card._cfg = { preview: 'image.p', status: 'sensor.s', progress: 'sensor.p' };
  card._syncPrintLayout('printing');
  assert.deepEqual(hiddenIds(nodes, ['camera-tile', 'profile-tile', 'preview-tile']), ['camera-tile']);
  assert.equal(nodes['media-row'].props['--media-cols'], '2');
  assert.equal(card.closed, true);
  // Without a camera the status bar becomes a strip in row 2.
  assert.equal(nodes['cam-bar'].parentNode, nodes['bar-slot']);
  assert.equal(nodes['camera-expand'].hidden, true);

  card._cfg = {};
  card._syncPrintLayout('unknown');
  assert.equal(nodes['media-row'].hidden, true);
});

test('idle printers get one placeholder tile next to the camera; editor options hide tiles and set its height', () => {
  const { card, nodes } = layoutCard();
  card._cfg = { camera: 'camera.p', status: 'sensor.s', preview: 'image.p', camera_aspect: '4:3' };
  card._hass = { states: { 'sensor.s': { state: 'idle', attributes: { file: 'last.gcode' } } } };
  card._syncPrintLayout('idle');
  assert.deepEqual(hiddenIds(nodes, ['camera-tile', 'profile-tile', 'preview-tile']), ['preview-tile']);
  assert.ok(nodes['profile-tile'].classes.has('tile-wide'));
  assert.equal(nodes['media-row'].props['--media-cols'], '4');
  assert.ok(nodes['camera-tile'].classes.has('ar-4-3'));
  assert.ok(!nodes['camera-tile'].classes.has('ar-16-9'));

  card._cfg = { ...card._cfg, hide_tiles: ['profile'], camera_aspect: 'bogus' };
  card._syncPrintLayout('printing');
  assert.deepEqual(hiddenIds(nodes, ['camera-tile', 'profile-tile', 'preview-tile']), ['profile-tile']);
  assert.equal(nodes['media-row'].props['--media-cols'], '3');
  assert.ok(nodes['camera-tile'].classes.has('ar-16-9'));
});

test('controls panel and print actions follow the configuration and printer state', () => {
  const { card, nodes } = layoutCard();
  card._cfg = { home: 'button.h', position_z: 'sensor.z', pause: 'button.p', stop: 'button.s' };
  card._syncPrintLayout('printing');
  assert.deepEqual(hiddenIds(nodes, ['controls-panel', 'home', 'speed-field', 'flow-field', 'fan-row', 'coords', 'coord-x', 'coord-z']),
    ['speed-field', 'flow-field', 'fan-row', 'coord-x']);

  card._syncPrintActions('printing');
  assert.deepEqual(hiddenIds(nodes, ['pause', 'resume', 'stop']), ['resume']);
  card._syncPrintActions('paused');
  // Resume is not configured, so only Stop remains.
  assert.deepEqual(hiddenIds(nodes, ['pause', 'resume', 'stop']), ['pause', 'resume']);
  card._syncPrintActions('idle');
  assert.deepEqual(hiddenIds(nodes, ['pause', 'resume', 'stop']), ['pause', 'resume', 'stop']);

  card._cfg = {};
  card._syncPrintLayout('idle');
  assert.equal(nodes['controls-panel'].hidden, true);
});

test('a profile hidden in the editor is never requested', () => {
  const { card, calls } = profileCard([{ status: 'ready', file: '/x.gcode', profile: PROFILE }]);
  card._profileKey = undefined;
  card._cfg = { ...card._cfg, hide_tiles: ['profile'] };
  card._syncProfile();
  assert.equal(card._profileKey, '');
  assert.deepEqual(calls, []);
});
