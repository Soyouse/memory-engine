// Tests memory-state.js (node:test) — noyau pur tier-0. Cible mutation Stryker.
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('./memory-state.js');

test('initialState = génération 0, injected vide', () => {
  assert.deepStrictEqual(S.initialState(), { generation: 0, injected: {} });
});

test('normalize — garbage/partiel → état sain', () => {
  assert.deepStrictEqual(S.normalize(null), { generation: 0, injected: {} });
  assert.deepStrictEqual(S.normalize({ generation: -5 }), { generation: 0, injected: {} });
  assert.deepStrictEqual(S.normalize({ generation: 3, injected: 'x' }), { generation: 3, injected: {} });
  assert.deepStrictEqual(S.normalize({ generation: 2, injected: { a: 1 } }), { generation: 2, injected: { a: 1 } });
});

test('bumpGeneration incrémente + préserve injected + immutable', () => {
  const s0 = { generation: 4, injected: { a: 4 } };
  const s1 = S.bumpGeneration(s0);
  assert.strictEqual(s1.generation, 5);
  assert.deepStrictEqual(s1.injected, { a: 4 });
  assert.strictEqual(s0.generation, 4); // input non muté
});

test('needsReinject — vrai si jamais injecté', () => {
  assert.strictEqual(S.needsReinject(S.initialState(), 'doctrine'), true);
});

test('needsReinject — faux après injection dans la MÊME génération', () => {
  let s = S.initialState();
  s = S.markInjected(s, 'doctrine');
  assert.strictEqual(S.needsReinject(s, 'doctrine'), false);
});

// ⭐ INVARIANT COMPACTION-PROOF : après bump, tout redevient à réinjecter.
test('needsReinject — VRAI à nouveau après compaction (bump) = zéro faux positif', () => {
  let s = S.initialState();
  s = S.markInjected(s, 'doctrine');
  assert.strictEqual(S.needsReinject(s, 'doctrine'), false); // présent dans gen 0
  s = S.bumpGeneration(s);                                   // compaction → gen 1
  assert.strictEqual(S.needsReinject(s, 'doctrine'), true);  // gen 0 ≠ gen 1 → réinjecter
});

test('markInjected — pose la génération courante + immutable', () => {
  const s0 = { generation: 2, injected: {} };
  const s1 = S.markInjected(s0, 'x');
  assert.strictEqual(s1.injected.x, 2);
  assert.deepStrictEqual(s0.injected, {}); // input non muté
});

test('markInjected — n écrase pas les autres entrées', () => {
  let s = { generation: 1, injected: { a: 1 } };
  s = S.markInjected(s, 'b');
  assert.deepStrictEqual(s.injected, { a: 1, b: 1 });
});

test('selectForceTier — filtre tier=force, robuste', () => {
  const mems = [{ id: 'a', tier: 'force' }, { id: 'b', tier: 'suggest' }, null, { id: 'c' }];
  assert.deepStrictEqual(S.selectForceTier(mems).map(m => m.id), ['a']);
  assert.deepStrictEqual(S.selectForceTier('nope'), []);
});
