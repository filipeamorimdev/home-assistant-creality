// Run with node --test tests/test_card_timelapse_save.mjs; no Home Assistant required.
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

const SETTINGS = {
  folder: '/media/nas/timelapses', auto_save: true, can_edit: true, status: 'idle',
  suggestions: ['/media', '/media/nas'],
};

function node() {
  return {
    textContent: '', value: '', checked: false, disabled: false, hidden: false, innerHTML: '', open: false,
    showModal() { this.open = true; },
    close() { this.open = false; },
  };
}

function saveCard(responses) {
  const card = Object.create(Card.prototype);
  const nodes = {};
  const calls = [];
  card._root = { getElementById: id => (nodes[id] ??= node()) };
  card._cfg = { status: 'sensor.status' };
  card._completedJob = { jobKey: 'job-1', startTime: 1789985709 };
  card._timelapse = { status: 'ready', result: { filename: 'Part-timelapse.mp4', download_url: '/x' } };
  card._hass = {
    callWS: async (msg) => {
      calls.push(msg);
      const next = typeof responses[msg.type] === 'function' ? responses[msg.type](msg) : responses[msg.type];
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { card, nodes, calls };
}

test('Save timelapse opens a popup offering download or the configured share', async () => {
  const { card, nodes, calls } = saveCard({
    'creality/timelapse_settings': SETTINGS,
    'creality/timelapse_save': { path: '/media/nas/timelapses/2026_Part.mp4', filename: '2026_Part.mp4' },
  });
  await card._openTimelapseSave();
  assert.ok(nodes['tl-save'].open);
  assert.equal(nodes['tl-save-file'].textContent, 'Part-timelapse.mp4');
  assert.equal(nodes['tl-save-share-label'].textContent, 'Save to /media/nas/timelapses');
  assert.equal(nodes['tl-save-share'].disabled, false);

  await card._saveTimelapseToFolder();
  assert.deepEqual(calls.at(-2), { type: 'creality/timelapse_save', entity_id: 'sensor.status', print_start_time: 1789985709 });
  assert.equal(nodes['tl-save-note'].textContent, 'Saved as /media/nas/timelapses/2026_Part.mp4');
});

test('without a folder the share choice is disabled and points to the settings', async () => {
  const { card, nodes } = saveCard({ 'creality/timelapse_settings': { ...SETTINGS, folder: '', auto_save: false } });
  await card._openTimelapseSave();
  assert.equal(nodes['tl-save-share'].disabled, true);
  assert.match(nodes['tl-save-note'].textContent, /Folder settings/);
  card._drawTimelapseSettingsLine();
  assert.equal(nodes['tl-line-text'].textContent, 'Timelapses: no folder set');
});

test('a failed share save shows the error from Home Assistant', async () => {
  const { card, nodes } = saveCard({
    'creality/timelapse_settings': SETTINGS,
    'creality/timelapse_save': Object.assign(new Error('Share is offline'), { code: 'save_failed' }),
  });
  await card._openTimelapseSave();
  await card._saveTimelapseToFolder();
  assert.equal(nodes['tl-save-note'].textContent, "Couldn't save: Share is offline");
  assert.equal(nodes['tl-save-share'].disabled, false);
});

test('settings dialog edits folder and auto-save through the integration', async () => {
  const { card, nodes, calls } = saveCard({
    'creality/timelapse_settings': SETTINGS,
    'creality/timelapse_settings/set': (msg) => ({ ...SETTINGS, folder: msg.folder, auto_save: msg.auto_save }),
  });
  await card._openTimelapseSettings();
  assert.ok(nodes['tl-settings'].open);
  assert.equal(nodes['tl-folder'].value, '/media/nas/timelapses');
  assert.equal(nodes['tl-auto'].checked, true);
  assert.match(nodes['tl-suggest'].innerHTML, /data-path="\/media\/nas"/);

  nodes['tl-folder'].value = '/media/nas';
  nodes['tl-auto'].checked = false;
  await card._saveTimelapseSettings();
  assert.deepEqual(calls.at(-1), {
    type: 'creality/timelapse_settings/set', entity_id: 'sensor.status', folder: '/media/nas', auto_save: false,
  });
  assert.equal(nodes['tl-settings'].open, false);
  assert.equal(nodes['tl-line-text'].textContent, 'Timelapses: save manually to /media/nas');

  // Auto-save needs a folder; checked locally before asking Home Assistant.
  const before = calls.length;
  nodes['tl-folder'].value = ' ';
  nodes['tl-auto'].checked = true;
  await card._saveTimelapseSettings();
  assert.equal(calls.length, before);
  assert.match(nodes['tl-settings-note'].textContent, /Choose a folder/);
});

test('non-admins see the settings read-only', async () => {
  const { card, nodes } = saveCard({ 'creality/timelapse_settings': { ...SETTINGS, can_edit: false } });
  await card._openTimelapseSettings();
  assert.equal(nodes['tl-folder'].disabled, true);
  assert.equal(nodes['tl-settings-save'].disabled, true);
  assert.equal(nodes['tl-suggest'].innerHTML, '');
  assert.match(nodes['tl-settings-note'].textContent, /administrators/);
});
