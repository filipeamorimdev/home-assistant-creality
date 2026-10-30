// Run with node --test tests/test_card_print_again.mjs; no Home Assistant required.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

let Card;
globalThis.HTMLElement = class {};
globalThis.customElements = {
  whenDefined: async () => {},
  get: () => undefined,
  define: (name, cls) => { if (name === 'creality-card') Card = cls; },
};
globalThis.window = {};
const source = fs.readFileSync(new URL('../custom_components/creality/frontend/creality-card.js', import.meta.url));
await import(`data:text/javascript;base64,${source.toString('base64')}`);

const ROWS = [
  { id: 'saved', jobKey: 'sensor.status|1791818714||a_PLA_1h.gcode', file: 'a_PLA_1h.gcode', ended: '2026-10-12T15:28:00Z' },
  { id: 'printer', jobKey: 'sensor.status|1791000000||b_PETG_2h.gcode', file: 'b_PETG_2h.gcode', ended: '2026-10-11T15:28:00Z' },
  { id: 'gone', jobKey: 'sensor.status|1790000000||c.gcode', file: 'c.gcode', ended: '2026-10-10T15:28:00Z' },
];

function historyCard(status, callWS) {
  const card = Object.create(Card.prototype);
  const nodes = {};
  card._root = { getElementById: id => (nodes[id] ??= { innerHTML: '', textContent: '', hidden: false }) };
  card._cfg = { status: 'sensor.status' };
  card._prints = ROWS.map(row => ({ ...row }));
  card._printPrefs = {};
  card._hass = { states: { 'sensor.status': { state: status, attributes: {} } }, callWS };
  card.dispatchEvent = (ev) => { card.events = [...(card.events || []), ev]; };
  return { card, nodes };
}

const buttons = html => [...html.matchAll(/data-repeat="([^"]+)"([^>]*)>/g)].map(m => [m[1], /disabled/.test(m[2])]);

test('print again shows on rows with a saved copy or a file on the printer', async () => {
  const { card, nodes } = historyCard('completed', async () => ({ saved: [1791818714], printer: ['b_PETG_2h.gcode'] }));
  await card._loadGcodeFiles();
  assert.deepEqual(buttons(nodes['log-list'].innerHTML), [['saved', false], ['printer', false]]);
});

test('print again is disabled while a job runs or the printer is offline', async () => {
  for (const status of ['printing', 'paused', 'processing', 'offline']) {
    const { card, nodes } = historyCard(status, async () => ({ saved: [1791818714], printer: null }));
    await card._loadGcodeFiles();
    assert.deepEqual(buttons(nodes['log-list'].innerHTML), [['saved', true]], status);
  }
});

test('older integrations without the command show no print again buttons', async () => {
  const { card, nodes } = historyCard('idle', async () => { throw new Error('unknown_command'); });
  await card._loadGcodeFiles();
  assert.deepEqual(buttons(nodes['log-list'].innerHTML), []);
});

test('print again asks first, then starts the job by its start time and file', async () => {
  const calls = [];
  const { card } = historyCard('idle', async (msg) => {
    calls.push(msg);
    return msg.type === 'creality/print_again' ? { file: '/x/a_PLA_1h.gcode', uploaded: true } : { saved: [], printer: [] };
  });
  globalThis.confirm = () => false;
  await card._printAgain('saved');
  assert.deepEqual(calls, []);
  let asked = '';
  globalThis.confirm = (text) => { asked = text; return true; };
  await card._printAgain('saved');
  assert.match(asked, /Print "a_PLA_1h\.gcode" again\?/);
  assert.match(asked, /build plate is clear/);
  assert.deepEqual(calls, [{ type: 'creality/print_again', entity_id: 'sensor.status', print_start_time: 1791818714, file: 'a_PLA_1h.gcode' }]);
  assert.equal(card.events.at(-1).detail.message, 'Printing a_PLA_1h.gcode again (copied from the saved G-code)');
  // A refusal from the integration becomes a notification.
  card._hass.callWS = async () => { throw { code: 'no_gcode', message: 'The G-code of this print is neither on the printer nor saved in the folder.' }; };
  await card._printAgain('gone');
  assert.match(card.events.at(-1).detail.message, /^Couldn't print again: The G-code of this print/);
  delete globalThis.confirm;
});

/** Open the save form for `file` (or edit row `existing`) and return the row the form was filled with. */
async function openForm(file, existing) {
  const card = Object.create(Card.prototype);
  card._root = { getElementById: () => ({ focus() {}, textContent: '' }) };
  card._printPrefs = { filamentType: 'PLA', costPerKg: 20, lastCostByType: { PETG: 25, 'CF-PLA': 40 } };
  card._prints = existing ? [existing] : [];
  card._snapshotPrintDraft = () => ({ file, filamentType: 'PLA', costPerKg: 20, preview: 'x' });
  card._measureMeterEnergy = async () => null;
  card._refreshPrintEstimate = () => {};
  card._setPrintPanelMode = () => {};
  card._showPrintModal = () => {};
  let written;
  card._writePrintForm = (row) => { written = row; };
  await card._openPrintModal(existing?.id);
  return written;
}

test('a new save takes the filament type and its price from the file name', async () => {
  const cases = {
    'Shiny A_PETG_2h57m.gcode': ['PETG', 25],
    'turnigy_PLA_1m.gcode': ['PLA', 20],
    'bracket_PLA-CF_3h.gcode': ['CF-PLA', 40],
    'vase_CF-PLA_3h.gcode': ['CF-PLA', 40],
    'PC case_TPU_1h.gcode': ['TPU', 20], // The material next to the time wins over a word in the name.
    'gift_Silk_PLA_2h.gcode': ['Silk PLA', 20],
    'grip_pla+_45m.gcode': ['PLA+', 20],
  };
  for (const [file, [type, cost]] of Object.entries(cases)) {
    const row = await openForm(file);
    assert.equal(row.filamentType, type, file);
    assert.equal(row.costPerKg, cost, file);
  }
  // No known type in the name: the last used type stays.
  assert.equal((await openForm('benchy.gcode')).filamentType, 'PLA');
  assert.equal((await openForm('explain_display_2h.gcode')).filamentType, 'PLA');
});

test('editing a saved print keeps the filament chosen before', async () => {
  const saved = { id: 'p1', file: 'Shiny A_PETG_2h57m.gcode', filamentType: 'ASA', costPerKg: 30 };
  const row = await openForm('ignored', saved);
  assert.equal(row.filamentType, 'ASA');
  assert.equal(row.costPerKg, 30);
});

test('the print dialog opens full screen and every way of closing resets it', () => {
  const card = Object.create(Card.prototype);
  let resets = 0;
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; card._printModalClosed(); } };
  card._root = { getElementById: id => (id === 'log-modal' ? dialog : null) };
  card._resetDetailTimelapse = () => { resets++; };
  card._editingId = 'p1';
  card._showPrintModal();
  assert.equal(card._isPrintModalOpen(), true);
  card._closePrintModal(); // Close / Cancel / Save; Escape fires the same close event.
  assert.equal(card._isPrintModalOpen(), false);
  assert.equal(resets, 1);
  assert.equal(card._editingId, null);
});
