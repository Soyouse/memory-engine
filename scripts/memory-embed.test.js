// Tests memory-embed.js (node:test) — noyau pur similarité. Cible mutation.
const { test } = require('node:test');
const assert = require('node:assert');
const E = require('./memory-embed.js');

// ── cosine ──
test('cosine — vecteurs identiques → 1', () => {
  assert.ok(Math.abs(E.cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
});
test('cosine — orthogonaux → 0', () => {
  assert.strictEqual(E.cosine([1, 0], [0, 1]), 0);
});
test('cosine — opposés → -1', () => {
  assert.ok(Math.abs(E.cosine([1, 1], [-1, -1]) + 1) < 1e-9);
});
test('cosine — colinéaires (échelle) → 1', () => {
  assert.ok(Math.abs(E.cosine([2, 4], [1, 2]) - 1) < 1e-9);
});
test('cosine — invalides / tailles ≠ / vide → 0', () => {
  assert.strictEqual(E.cosine([1, 2], [1, 2, 3]), 0);
  assert.strictEqual(E.cosine([], []), 0);
  assert.strictEqual(E.cosine(null, [1]), 0);
  assert.strictEqual(E.cosine([0, 0], [1, 1]), 0); // norme nulle
});
test('cosine — valeur EXACTE (tue les mutants arithmétiques)', () => {
  // [1,2,3]·[4,5,6]=32 ; |a|=√14, |b|=√77 → 32/√1078 ≈ 0.974631846
  assert.ok(Math.abs(E.cosine([1, 2, 3], [4, 5, 6]) - 0.9746318) < 1e-6);
});

// ── topK ──
const ITEMS = [
  { id: 'a', vector: [1, 0] },
  { id: 'b', vector: [0.9, 0.1] },
  { id: 'c', vector: [0, 1] },
];
test('topK — ordonne par proximité', () => {
  const r = E.topK([1, 0], ITEMS, 2);
  assert.deepStrictEqual(r.map((x) => x.id), ['a', 'b']);
  assert.ok(r[0].score >= r[1].score);
});
test('topK — seuil exclut les trop éloignés', () => {
  const r = E.topK([1, 0], ITEMS, 5, 0.5);
  assert.ok(r.every((x) => x.score >= 0.5));
  assert.ok(!r.find((x) => x.id === 'c')); // orthogonal → exclu
});
test('topK — k borne le résultat', () => {
  assert.strictEqual(E.topK([1, 0], ITEMS, 1).length, 1);
});
test('topK — entrées invalides → []', () => {
  assert.deepStrictEqual(E.topK([1, 0], ITEMS, 0), []);
  assert.deepStrictEqual(E.topK(null, ITEMS, 3), []);
  assert.deepStrictEqual(E.topK([1, 0], 'nope', 3), []);
});
test('topK — ignore items sans vecteur', () => {
  const r = E.topK([1, 0], [{ id: 'x' }, { id: 'a', vector: [1, 0] }], 5);
  assert.deepStrictEqual(r.map((x) => x.id), ['a']);
});
test('topK — seuil INCLUSIF (score == seuil retenu)', () => {
  // [1,0] vs [1,0] = 1 exactement → seuil 1 doit l'inclure (>=, pas >)
  const r = E.topK([1, 0], [{ id: 'a', vector: [1, 0] }], 5, 1);
  assert.deepStrictEqual(r.map((x) => x.id), ['a']);
});

// ── searchDedup (chunking par section) ──
const CHUNKS = [
  { id: 'fileA', chunk: 's1', vector: [1, 0] },
  { id: 'fileA', chunk: 's2', vector: [0.2, 0.98] }, // même fichier, autre section
  { id: 'fileB', chunk: '', vector: [0, 1] },
];
test('searchDedup — garde le MEILLEUR chunk par fichier', () => {
  const r = E.searchDedup([1, 0], CHUNKS, 5, 0);
  const a = r.find((x) => x.id === 'fileA');
  assert.strictEqual(a.chunk, 's1'); // s1 plus proche de [1,0] que s2
  assert.strictEqual(r.filter((x) => x.id === 'fileA').length, 1); // 1 seule entrée fileA
});
test('searchDedup — classe les fichiers par leur meilleur score', () => {
  const r = E.searchDedup([1, 0], CHUNKS, 5, 0);
  assert.strictEqual(r[0].id, 'fileA');
});
test('searchDedup — seuil + k', () => {
  assert.ok(E.searchDedup([1, 0], CHUNKS, 5, 0.99).every((x) => x.score >= 0.99));
  assert.strictEqual(E.searchDedup([1, 0], CHUNKS, 1, 0).length, 1);
});
test('searchDedup — entrées invalides → []', () => {
  assert.deepStrictEqual(E.searchDedup(null, CHUNKS, 3), []);
  assert.deepStrictEqual(E.searchDedup([1, 0], CHUNKS, 0), []);
  assert.deepStrictEqual(E.searchDedup([1, 0], 'nope', 3), []);
});
test('searchDedup — ignore chunks sans vecteur', () => {
  const r = E.searchDedup([1, 0], [{ id: 'z', chunk: 'x' }, { id: 'a', chunk: 'y', vector: [1, 0] }], 5, 0);
  assert.deepStrictEqual(r.map((x) => x.id), ['a']);
});
test('searchDedup — sur égalité de score, garde le PREMIER chunk vu', () => {
  const items = [
    { id: 'f', chunk: 'premier', vector: [1, 0] },
    { id: 'f', chunk: 'second', vector: [1, 0] }, // même score (1)
  ];
  const r = E.searchDedup([1, 0], items, 5, 0);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].chunk, 'premier'); // > strict, pas >= → pas remplacé
});
test('searchDedup — seuil INCLUSIF (score == seuil retenu)', () => {
  const r = E.searchDedup([1, 0], [{ id: 'a', chunk: '', vector: [1, 0] }], 5, 1);
  assert.deepStrictEqual(r.map((x) => x.id), ['a']);
});

// ── dimMismatch (pur) — garde anti-swap de modèle ──
test('dimMismatch — dim index == taille requête → false', () => {
  assert.strictEqual(E.dimMismatch([1, 2, 3], { dim: 3 }), false);
});
test('dimMismatch — tailles différentes → true', () => {
  assert.strictEqual(E.dimMismatch([1, 2], { dim: 3 }), true);
});
test('dimMismatch — dim absente/0 → false (pas de garde, vieil index)', () => {
  assert.strictEqual(E.dimMismatch([1, 2], {}), false);
  assert.strictEqual(E.dimMismatch([1, 2], { dim: 0 }), false);
  assert.strictEqual(E.dimMismatch([1, 2], null), false);
});
test('dimMismatch — vecteur requête vide/invalide → false', () => {
  assert.strictEqual(E.dimMismatch([], { dim: 3 }), false);
  assert.strictEqual(E.dimMismatch(null, { dim: 3 }), false);
});
