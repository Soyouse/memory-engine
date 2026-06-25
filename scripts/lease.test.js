'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('./lease.js');

// ── sanitizeId ──
test('sanitizeId — garde alphanum/-/_, remplace le reste', () => {
  assert.strictEqual(L.sanitizeId('abc-123_DEF'), 'abc-123_DEF');
  assert.strictEqual(L.sanitizeId('a/b\\c..d'), 'a_b_c__d');
});
test('sanitizeId — vide/non-string → unknown', () => {
  assert.strictEqual(L.sanitizeId(''), 'unknown');
  assert.strictEqual(L.sanitizeId(null), 'unknown');
  assert.strictEqual(L.sanitizeId(42), 'unknown');
});
test('sanitizeId — tronque à 128', () => {
  assert.strictEqual(L.sanitizeId('x'.repeat(500)).length, 128);
});

// ── isFresh ──
test('isFresh — dans la fenêtre = frais, hors = périmé', () => {
  assert.strictEqual(L.isFresh(1000, 5000, 10000), true);   // 4s d'âge < 10s
  assert.strictEqual(L.isFresh(1000, 20000, 10000), false); // 19s d'âge > 10s
});
test('isFresh — pile à la limite = frais (≤, pas <)', () => {
  assert.strictEqual(L.isFresh(1000, 11000, 10000), true);  // exactement 10s
  assert.strictEqual(L.isFresh(1000, 11001, 10000), false); // 10s+1ms
});
test('isFresh — valeurs non finies → jamais frais (fail-safe extinction)', () => {
  assert.strictEqual(L.isFresh(NaN, 5000, 10000), false);
  assert.strictEqual(L.isFresh(1000, Infinity, 10000), false);
  assert.strictEqual(L.isFresh(1000, 5000, NaN), false);
});

// ── liveCount / staleNames ──
const NOW = 100000, IDLE = 10000;
const ENTRIES = [
  { name: 'a.lease', mtimeMs: 95000 },  // 5s → frais
  { name: 'b.lease', mtimeMs: 80000 },  // 20s → périmé
  { name: 'c.lease', mtimeMs: 99000 },  // 1s → frais
];
test('liveCount — compte les frais uniquement', () => {
  assert.strictEqual(L.liveCount(ENTRIES, NOW, IDLE), 2);
});
test('liveCount — non-tableau → 0', () => {
  assert.strictEqual(L.liveCount(null, NOW, IDLE), 0);
  assert.strictEqual(L.liveCount(undefined, NOW, IDLE), 0);
});
test('liveCount — ignore les entrées nulles', () => {
  assert.strictEqual(L.liveCount([null, ENTRIES[0]], NOW, IDLE), 1);
});
test('staleNames — renvoie les noms périmés', () => {
  assert.deepStrictEqual(L.staleNames(ENTRIES, NOW, IDLE), ['b.lease']);
});
test('staleNames — non-tableau → []', () => {
  assert.deepStrictEqual(L.staleNames(null, NOW, IDLE), []);
});
test('liveCount + staleNames partitionnent tout (complémentaires)', () => {
  assert.strictEqual(L.liveCount(ENTRIES, NOW, IDLE) + L.staleNames(ENTRIES, NOW, IDLE).length, ENTRIES.length);
});
