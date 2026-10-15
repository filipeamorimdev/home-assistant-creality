// Run with node --test tests/test_card_timelapse.mjs; no Home Assistant required.
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
let fetchFails = false;
globalThis.fetch = async (url) => {
  fetches.push(url);
  if (fetchFails) return new Response('', { status: 502 });
  return new Response(new Uint8Array(11), { headers: { 'Content-Length': '11' } });
};
let blobs = 0;
URL.createObjectURL = (blob) => `blob:${++blobs}:${blob.size}:${blob.type}`;
URL.revokeObjectURL = (url) => revoked.push(url);
const READY = {
  status: 'ready', url: '/api/creality/timelapse/e/1.mp4?authSig=a',
  download_url: '/api/creality/timelapse/e/1.mp4?download=1&authSig=a', size: 5811324, duration: 9, expires_in: 3600,
  filename: 'Shiny A_PETG_30m-timelapse.mp4',
};

function node() {
  return {
    dataset: {}, attrs: {}, hidden: false, played: 0,
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; this.src = undefined; },
    pause() {}, load() {},
    play() { this.played++; return Promise.resolve(); },
  };
}

function timelapseCard(responses, job = { jobKey: 'job-1', startTime: 1789985709 }) {
  const card = Object.create(Card.prototype);
  const nodes = Object.fromEntries(['completion-timelapse', 'completion-timelapse-download', 'completion-note', 'completion-video']
    .map(id => [id, node()]));
  const calls = [];
  card._root = { getElementById: id => nodes[id] };
  card._cfg = { status: 'sensor.status' };
  card._completedJob = job;
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

test('ready timelapse is loaded whole into the browser, played and hidden again', async () => {
  fetches.length = 0;
  const { card, nodes, calls } = timelapseCard([READY]);
  card._syncTimelapse();
  assert.equal(nodes['completion-timelapse'].textContent, 'Checking timelapse…');
  assert.ok(nodes['completion-timelapse'].disabled);
  await flush();
  assert.deepEqual(calls, [{ type: 'creality/timelapse', entity_id: 'sensor.status', print_start_time: 1789985709 }]);
  const btn = nodes['completion-timelapse'];
  assert.equal(btn.textContent, 'Play timelapse');
  assert.ok(!btn.disabled);
  assert.equal(nodes['completion-timelapse-download'].hidden, false);
  assert.equal(nodes['completion-note'].textContent, 'Timelapse · 9s · 5.8 MB');
  assert.equal(nodes['completion-video'].hidden, true);

  await card._toggleTimelapse();
  assert.deepEqual(fetches, [READY.url]);
  const blobUrl = card._timelapse.blobUrl;
  assert.match(blobUrl, /^blob:\d+:11:video\/mp4$/);
  assert.equal(nodes['completion-video'].src, blobUrl);
  assert.equal(nodes['completion-video'].hidden, false);
  assert.equal(nodes['completion-note'].textContent, 'Timelapse · 9s · 5.8 MB');
  assert.equal(nodes['completion-video'].played, 1);
  assert.equal(btn.textContent, 'Hide timelapse');
  assert.equal(btn.attrs['aria-expanded'], 'true');
  // Redraws from unrelated state updates must not reload the player.
  nodes['completion-video'].src = 'kept';
  card._syncTimelapse();
  assert.equal(nodes['completion-video'].src, 'kept');

  await card._toggleTimelapse();
  assert.equal(nodes['completion-video'].hidden, true);
  assert.equal(nodes['completion-video'].src, undefined);
  // Playing again reuses the copy already in the browser.
  await card._toggleTimelapse();
  assert.equal(fetches.length, 1);
  assert.equal(nodes['completion-video'].src, blobUrl);
  assert.equal(calls.length, 1);
  // The browser copy is released when the banner moves on to another job.
  card._completedJob = null;
  card._syncTimelapse();
  assert.ok(revoked.includes(blobUrl));
  assert.equal(nodes['completion-video'].hidden, true);
});

test('download reuses the loaded copy, otherwise streams the signed URL', async () => {
  const clicks = [];
  globalThis.document = { createElement: () => ({ click() { clicks.push({ href: this.href, download: this.download }); } }) };
  const { card } = timelapseCard([READY]);
  card._syncTimelapse();
  await flush();
  await card._downloadTimelapse();
  assert.deepEqual(clicks[0], { href: READY.download_url, download: READY.filename });
  await card._toggleTimelapse();
  await card._downloadTimelapse();
  assert.deepEqual(clicks[1], { href: card._timelapse.blobUrl, download: READY.filename });
  delete globalThis.document;
});

test('a failed load closes the player and allows retrying', async () => {
  fetchFails = true;
  const { card, nodes } = timelapseCard([READY]);
  card._syncTimelapse();
  await flush();
  await card._toggleTimelapse();
  fetchFails = false;
  assert.equal(card._timelapse.open, false);
  assert.equal(nodes['completion-video'].hidden, true);
  assert.equal(nodes['completion-timelapse'].textContent, 'Play timelapse');
  assert.match(nodes['completion-note'].textContent, /Couldn't load the timelapse/);
  await card._toggleTimelapse();
  assert.equal(nodes['completion-video'].hidden, false);
});

test('stale signed URLs are requested again before playing', async () => {
  const fresh = { ...READY, url: '/fresh' };
  const { card, nodes, calls } = timelapseCard([READY, fresh]);
  card._syncTimelapse();
  await flush();
  card._timelapse.fetchedAt -= 31 * 60000;
  fetches.length = 0;
  await card._toggleTimelapse();
  assert.equal(calls.length, 2);
  assert.deepEqual(fetches, ['/fresh']);
  assert.equal(nodes['completion-video'].hidden, false);
});

test('missing timelapse is polled while the printer may still render it', async () => {
  const { card, nodes, calls } = timelapseCard([{ status: 'missing' }, { status: 'missing' }]);
  card._syncTimelapse();
  await flush();
  assert.equal(nodes['completion-note'].textContent, 'Waiting for the printer to save the timelapse…');
  assert.equal(nodes['completion-timelapse'].textContent, 'Waiting for timelapse…');
  assert.ok(card._timelapseTimer);
  // Past the render window the lookup is final.
  card._timelapse.since -= 6 * 60000;
  await card._fetchTimelapse(card._timelapse.key);
  assert.equal(calls.length, 2);
  assert.equal(card._timelapseTimer, undefined);
  assert.equal(nodes['completion-timelapse'].textContent, 'No timelapse');
  assert.ok(nodes['completion-timelapse'].disabled);
  assert.equal(nodes['completion-timelapse-download'].hidden, true);
  assert.match(nodes['completion-note'].textContent, /no timelapse for this print/);
});

test('render wait counts from the job end, so reattaching does not restart it', async () => {
  const job = { jobKey: 'job-1', startTime: 1789985709, finishedAt: Date.now() - 7 * 60000 };
  const { card, nodes, calls } = timelapseCard([{ status: 'missing' }, { status: 'missing' }], job);
  card._syncTimelapse();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(card._timelapseTimer, undefined);
  assert.equal(nodes['completion-timelapse'].textContent, 'No timelapse');
  // Dashboard view switch: detached and attached again.
  card._resetTimelapse();
  card._syncTimelapse();
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(card._timelapseTimer, undefined);
  assert.equal(nodes['completion-timelapse'].textContent, 'No timelapse');
});

test('banner shows where auto-save copied the timelapse', async () => {
  const { card, nodes } = timelapseCard([{ ...READY, saved_as: '/media/nas/2026-10-12_a.mp4' }]);
  card._syncTimelapse();
  await flush();
  assert.match(nodes['completion-note'].textContent, /Saved to \/media\/nas\/2026-10-12_a\.mp4/);
  const gone = timelapseCard([{ status: 'missing', saved_as: '/media/nas/b.mp4' }],
    { jobKey: 'job-2', startTime: 1, finishedAt: Date.now() - 60 * 60000 });
  gone.card._syncTimelapse();
  await flush();
  assert.equal(gone.nodes['completion-note'].textContent, 'Saved to /media/nas/b.mp4 (no longer on the printer)');
});

test('job without a start time skips the lookup', async () => {
  const { card, nodes, calls } = timelapseCard([], { jobKey: 'usb', startTime: '' });
  card._syncTimelapse();
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(card._timelapseTimer, undefined);
  assert.equal(nodes['completion-timelapse'].textContent, 'No timelapse');
});

test('unreachable printer retries; WS errors are final', async () => {
  const { card, nodes } = timelapseCard([{ status: 'unavailable' }, new Error('unknown_command')]);
  card._syncTimelapse();
  await flush();
  assert.equal(nodes['completion-timelapse'].textContent, 'Timelapse unavailable');
  assert.match(nodes['completion-note'].textContent, /Retrying/);
  assert.ok(card._timelapseTimer);
  await card._fetchTimelapse(card._timelapse.key);
  assert.equal(nodes['completion-note'].textContent, "Couldn't look up the timelapse.");
  assert.equal(card._timelapseTimer, undefined);
});

test('a new job or a detached card drops the previous lookup', async () => {
  const { card, nodes, calls } = timelapseCard([READY]);
  card._syncTimelapse();
  card._completedJob = null; // Next print started before the answer arrived.
  card._syncTimelapse();
  await flush();
  assert.equal(card._timelapse, null);
  assert.equal(nodes['completion-video'].hidden, true);
  assert.equal(nodes['completion-timelapse-download'].hidden, true);
  assert.equal(calls.length, 1);

  const other = timelapseCard([{ status: 'unavailable' }]);
  other.card._syncTimelapse();
  await flush();
  assert.ok(other.card._timelapseTimer);
  other.card.disconnectedCallback();
  assert.equal(other.card._timelapseTimer, undefined);
  assert.equal(other.card._timelapse, null);
});
