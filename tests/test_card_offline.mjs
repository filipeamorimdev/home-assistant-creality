// Run with node --test tests/test_card_offline.mjs; no Home Assistant required.
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

for (const configured of [true, false]) {
  for (const power of ['on', 'off', 'unknown', 'unavailable', undefined]) {
    for (const [state, connected, disconnected] of [
      ['idle', false, true], ['offline', false, true],
      ['unavailable', undefined, true], ['printing', true, false], ['idle', true, false],
    ]) {
      test(`configured=${configured}, power=${power}, status=${state}, connected=${connected}`, () => {
        const card = Object.create(Card.prototype);
        const nodes = Object.fromEntries(['offline-notice', 'printer-power', 'camera'].map(id =>
          [id, { setAttribute() {}, querySelector() { return null; } }]));
        let hiddenPanels;
        card._root = {
          querySelector: () => ({ classList: { toggle: (_, value) => { hiddenPanels = value; } } }),
          getElementById: id => nodes[id],
        };
        card._cfg = { status: 'sensor.status', ...(configured ? { printer_switch: 'switch.printer' } : {}) };
        card._hass = { states: {
          'sensor.status': { state, attributes: { connected } },
          'switch.printer': { state: power },
        } };
        const expected = configured && (power === 'off' || disconnected);
        assert.equal(card._updateOffline(), expected);
        assert.equal(hiddenPanels, expected);
        assert.equal(nodes['offline-notice'].hidden, !expected);
        if (configured && power === 'off') {
          assert.equal(nodes['printer-power'].textContent, 'Turn on printer');
          assert.ok(!nodes['printer-power'].disabled);
        }
        // There is no turn-off control; the button is only shown to power on.
        if (power === 'on') assert.equal(nodes['printer-power'].hidden, true);
        // Reconnection restores the regular view without rebuilding the card.
        card._hass.states['sensor.status'] = { state: 'idle', attributes: { connected: true } };
        card._hass.states['switch.printer'].state = 'on';
        assert.equal(card._updateOffline(), false);
        assert.equal(hiddenPanels, false);
      });
    }
  }
}

function startingCard(callService = async () => {}) {
  const card = Object.create(Card.prototype);
  const nodes = Object.fromEntries(['offline-notice', 'offline-message', 'printer-loading', 'printer-power', 'printer-power-error', 'camera'].map(id =>
    [id, { setAttribute() {}, querySelector() { return null; } }]));
  card._root = {
    querySelector: () => ({ classList: { toggle() {} } }),
    getElementById: id => nodes[id],
  };
  card._cfg = { status: 'sensor.status', printer_switch: 'switch.printer' };
  card._hass = { callService, states: {
    'sensor.status': { state: 'offline', attributes: { connected: false } },
    'switch.printer': { state: 'off' },
  } };
  card._update = () => card._updateOffline();
  return { card, nodes };
}

test('loading persists after service completion until printer responds', async () => {
  let finish;
  let calls = 0;
  const { card, nodes } = startingCard(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const request = card._togglePrinterPower();
  assert.equal(nodes['printer-loading'].hidden, false);
  assert.equal(nodes['offline-message'].textContent, 'Waiting for printer…');
  finish();
  await request;
  await card._togglePrinterPower();
  assert.equal(calls, 1);
  assert.equal(nodes['printer-loading'].hidden, false);
  card._hass.states['switch.printer'].state = 'on';
  assert.equal(card._updateOffline(), true);
  assert.equal(nodes['printer-loading'].hidden, false);
  card._hass.states['sensor.status'] = { state: 'idle', attributes: { connected: true } };
  assert.equal(card._updateOffline(), false);
  assert.equal(nodes['printer-loading'].hidden, true);
});

test('service failure stops loading and allows retry', async () => {
  const { card, nodes } = startingCard(async () => { throw new Error('service failed'); });
  await card._togglePrinterPower();
  assert.equal(nodes['printer-loading'].hidden, true);
  assert.equal(nodes['offline-message'].textContent, 'Printer is offline.');
  assert.ok(nodes['printer-power-error'].textContent.includes('Unable'));
  assert.ok(!nodes['printer-power'].disabled);
});

test('power off during startup stops loading', async () => {
  const { card, nodes } = startingCard();
  await card._togglePrinterPower();
  card._hass.states['switch.printer'].state = 'on';
  card._updateOffline();
  card._hass.states['switch.printer'].state = 'off';
  assert.equal(card._updateOffline(), true);
  assert.equal(nodes['printer-loading'].hidden, true);
});
