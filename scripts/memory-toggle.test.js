// Tests memory-toggle.js (node:test) — interrupteur du kill-switch mémoire.
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeAction, report } = require('./memory-toggle');

test('normalizeAction — off / disable / 0 / false → off', () => {
  for (const a of ['off', 'disable', '0', 'false', 'OFF', ' Off ']) {
    assert.strictEqual(normalizeAction(a), 'off', a);
  }
});

test('normalizeAction — on / enable / 1 / true → on', () => {
  for (const a of ['on', 'enable', '1', 'true', 'ON', ' On ']) {
    assert.strictEqual(normalizeAction(a), 'on', a);
  }
});

test('normalizeAction — vide / status / inconnu → status (jamais de bascule accidentelle)', () => {
  for (const a of ['', 'status', undefined, null, 'wat', 'offf', 'disabled']) {
    assert.strictEqual(normalizeAction(a), 'status', String(a));
  }
});

test('report — off annonce la désactivation', () => {
  assert.match(report('off', true), /DÉSACTIVÉE/);
});

test('report — on annonce la réactivation', () => {
  assert.match(report('on', false), /RÉACTIVÉE/);
});

test('report — status reflète l\'état réel (présent/absent)', () => {
  assert.match(report('status', true), /DÉSACTIVÉE/);
  assert.match(report('status', false), /active/);
});
