'use strict';
const test = require('node:test');
const assert = require('node:assert');
const W = require('./watchdog.js');

// ── parsePid ──
test('parsePid — entier positif valide', () => {
  assert.strictEqual(W.parsePid('12345'), 12345);
  assert.strictEqual(W.parsePid('  678 \n'), 678);
});
test('parsePid — invalide/négatif/zéro → null', () => {
  assert.strictEqual(W.parsePid(''), null);
  assert.strictEqual(W.parsePid('abc'), null);
  assert.strictEqual(W.parsePid('0'), null);
  assert.strictEqual(W.parsePid('-5'), null);
  assert.strictEqual(W.parsePid(null), null);
  assert.strictEqual(W.parsePid(undefined), null);
});

// ── decideAction ──
test('decideAction — daemon mort → exit (rien à garder)', () => {
  assert.strictEqual(W.decideAction(0, false), 'exit');
  assert.strictEqual(W.decideAction(3, false), 'exit');
});
test('decideAction — daemon vivant + 0 lease → kill (libère GPU)', () => {
  assert.strictEqual(W.decideAction(0, true), 'kill');
});
test('decideAction — daemon vivant + ≥1 lease → continue', () => {
  assert.strictEqual(W.decideAction(1, true), 'continue');
  assert.strictEqual(W.decideAction(9, true), 'continue');
});
test('decideAction — serverAlive prime sur le compte de leases', () => {
  // Mort d'abord testé : même 0 lease, si mort → exit (pas kill).
  assert.notStrictEqual(W.decideAction(0, false), 'kill');
});
