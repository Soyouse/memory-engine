// Tests mem-health-label.js (node:test) — segment santé mémoire 🧠 (helper statusline).
const { test } = require('node:test');
const assert = require('node:assert');
const { memHealthLabel } = require('./mem-health-label');

test('disabled PRIME — santé absente → désactivé', () => {
  assert.strictEqual(memHealthLabel(true, null), '🧠 désactivé');
});

test('disabled PRIME — même sur une santé ok (kill-switch volontaire ≠ panne)', () => {
  assert.strictEqual(memHealthLabel(true, { status: 'ok' }), '🧠 désactivé');
});

test('disabled PRIME — même sur une santé down', () => {
  assert.strictEqual(memHealthLabel(true, { status: 'down' }), '🧠 désactivé');
});

test('actif + santé absente → null (segment omis)', () => {
  assert.strictEqual(memHealthLabel(false, null), null);
  assert.strictEqual(memHealthLabel(false, undefined), null);
  assert.strictEqual(memHealthLabel(false, 'pas-un-objet'), null);
});

test('actif + status ok → 🧠 ok', () => {
  assert.strictEqual(memHealthLabel(false, { status: 'ok' }), '🧠 ok');
});

test('actif + booting → démarrage (PAS down)', () => {
  assert.strictEqual(memHealthLabel(false, { status: 'booting' }), '🧠… démarrage');
});

test('actif + status down → DOWN', () => {
  assert.strictEqual(memHealthLabel(false, { status: 'down' }), '🧠⚠️ DOWN');
});

test('rétro-compat : status absent → dérivé du booléen ok', () => {
  assert.strictEqual(memHealthLabel(false, { ok: true }), '🧠 ok');
  assert.strictEqual(memHealthLabel(false, { ok: false }), '🧠⚠️ DOWN');
  assert.strictEqual(memHealthLabel(false, {}), '🧠⚠️ DOWN');
});
