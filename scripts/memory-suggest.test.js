// Tests memory-suggest.js (node:test) — moteur sémantique 2-tiers (noyau pur).
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('./memory-suggest.js');
const STATE = require('./memory-state.js');

// ── formatSystemMessage (pur) — transparence user-only ──
test('formatSystemMessage — injecté + rappel, ⁰ marque le tier-0', () => {
  const msg = S.formatSystemMessage([{ id: 'a' }], [{ id: 'b', tier: 1 }, { id: 'c', tier: 0 }]);
  assert.match(msg, /🧠 injecté: a/);
  assert.match(msg, /💡 rappel: b, c⁰/);
});
test('formatSystemMessage — rien à montrer → chaîne vide', () => {
  assert.strictEqual(S.formatSystemMessage([], []), '');
  assert.strictEqual(S.formatSystemMessage(null, undefined), '');
});
test('formatSystemMessage — injecté seul (pas de rappel)', () => {
  assert.strictEqual(S.formatSystemMessage([{ id: 'x' }], []), '🧠 injecté: x');
});

// ── partitionByTier (pur) — LE cœur du modèle ──
test('partitionByTier — tier-0 1er match → à injecter', () => {
  const { toInject, toRecall } = S.partitionByTier([{ id: 'a', tier: 0 }], STATE.initialState());
  assert.deepStrictEqual(toInject.map((h) => h.id), ['a']);
  assert.deepStrictEqual(toRecall, []);
});
test('partitionByTier — tier-1 → toujours rappel', () => {
  const { toInject, toRecall } = S.partitionByTier([{ id: 'b', tier: 1 }], STATE.initialState());
  assert.deepStrictEqual(toInject, []);
  assert.deepStrictEqual(toRecall.map((h) => h.id), ['b']);
});
test('partitionByTier — tier-0 DÉJÀ injecté cette génération → rappel (dédup)', () => {
  let st = STATE.markInjected(STATE.initialState(), 'a');
  const { toInject, toRecall } = S.partitionByTier([{ id: 'a', tier: 0 }], st);
  assert.deepStrictEqual(toInject, []);
  assert.deepStrictEqual(toRecall.map((h) => h.id), ['a']);
});
test('partitionByTier — après compaction (bump) → tier-0 ré-injecté', () => {
  let st = STATE.markInjected(STATE.initialState(), 'a');
  st = STATE.bumpGeneration(st);
  const { toInject } = S.partitionByTier([{ id: 'a', tier: 0 }], st);
  assert.deepStrictEqual(toInject.map((h) => h.id), ['a']);
});
test('partitionByTier — mélange tier-0/tier-1', () => {
  const hits = [{ id: 'a', tier: 0 }, { id: 'b', tier: 1 }, { id: 'c', tier: 0 }];
  const { toInject, toRecall } = S.partitionByTier(hits, STATE.initialState());
  assert.deepStrictEqual(toInject.map((h) => h.id), ['a', 'c']);
  assert.deepStrictEqual(toRecall.map((h) => h.id), ['b']);
});
test('partitionByTier — entrées invalides → vides, jamais throw', () => {
  assert.deepStrictEqual(S.partitionByTier(null, STATE.initialState()), { toInject: [], toRecall: [] });
  const r = S.partitionByTier([null, { id: 'x', tier: 1 }], STATE.initialState());
  assert.deepStrictEqual(r.toRecall.map((h) => h.id), ['x']);
});

// ── formatRecall (pur) ──
test('formatRecall — vide si rien', () => {
  assert.strictEqual(S.formatRecall([]), '');
  assert.strictEqual(S.formatRecall(null), '');
});
test('formatRecall — sortie EXACTE (tue les mutants de string)', () => {
  const b = S.formatRecall([{ id: 'memX', description: 'desc', score: 0.4567 }]);
  assert.strictEqual(b,
    '<memory-recall note="Mémoires pertinentes (relis le fichier si utile).">\n'
    + '- memX — desc (0.46)\n</memory-recall>');
});
test('formatRecall — sans description + score absent', () => {
  assert.match(S.formatRecall([{ id: 'm' }]), /- m \(0\.00\)/);
});
test('formatRecall — borné à RECALL_MAX', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ id: 'm' + i, score: 0.5 }));
  const lines = S.formatRecall(many).split('\n').filter((l) => l.startsWith('- '));
  assert.strictEqual(lines.length, S.RECALL_MAX);
});

// ── formatInjected (pur) ──
test('formatInjected — vide si rien / pas de corps', () => {
  assert.strictEqual(S.formatInjected([]), '');
  assert.strictEqual(S.formatInjected([{ id: 'a' }]), '');
});
test('formatInjected — inclut id + corps complet', () => {
  const b = S.formatInjected([{ id: 'memY', body: 'contenu complet' }]);
  assert.match(b, /memory-inject/);
  assert.match(b, /### memY/);
  assert.match(b, /contenu complet/);
});
test('formatInjected — tronque au-delà de INJECT_MAX_CHARS + marqueur', () => {
  const big = 'x'.repeat(S.INJECT_MAX_CHARS + 500);
  const b = S.formatInjected([{ id: 'gros', body: big }]);
  assert.match(b, /…tronqué — lire gros/);
  assert.ok(b.length < big.length + 200); // bien tronqué
});
test('formatInjected — sous le cap : PAS de troncature', () => {
  const b = S.formatInjected([{ id: 'p', body: 'court' }]);
  assert.doesNotMatch(b, /tronqué/);
});

// ── statusFrom (pur) ──
test('statusFrom — embed ok → ok (quel que soit le probe)', () => {
  assert.strictEqual(S.statusFrom(true, 'down'), 'ok');
  assert.strictEqual(S.statusFrom(true, 'loading'), 'ok');
});
test('statusFrom — embed ko + serveur en chargement → booting', () => {
  assert.strictEqual(S.statusFrom(false, 'loading'), 'booting');
});
test('statusFrom — embed ko + injoignable/inconnu → down', () => {
  assert.strictEqual(S.statusFrom(false, 'down'), 'down');
  assert.strictEqual(S.statusFrom(false, null), 'down');
  assert.strictEqual(S.statusFrom(false, 'ok'), 'down'); // ok+!embed incohérent → down prudent
});

// ── healthRecord (pur) ──
test('healthRecord — ok complet', () => {
  assert.deepStrictEqual(S.healthRecord(true, 182.6, 'gemma', 'T', null),
    { ok: true, status: 'ok', latencyMs: 183, model: 'gemma', ts: 'T', error: null, bm25: null });
});
test('healthRecord — flag bm25 (on/degraded) porté', () => {
  assert.strictEqual(S.healthRecord(true, 5, 'm', 'T', null, undefined, 'on').bm25, 'on');
  assert.strictEqual(S.healthRecord(true, 5, 'm', 'T', null, undefined, 'degraded').bm25, 'degraded');
  assert.strictEqual(S.healthRecord(true, 5, 'm', 'T').bm25, null); // absent → null
});
test('healthRecord — status explicite (booting) override le défaut', () => {
  const r = S.healthRecord(false, null, 'm', 'T', null, 'booting');
  assert.strictEqual(r.ok, false);       // ok reste booléen (rétro-compat)
  assert.strictEqual(r.status, 'booting');
});
test('healthRecord — sans status explicite → dérivé de ok', () => {
  assert.strictEqual(S.healthRecord(true, 5, 'm', 'T').status, 'ok');
  assert.strictEqual(S.healthRecord(false, 5, 'm', 'T').status, 'down');
});
test('healthRecord — down + erreur tronquée 200', () => {
  const r = S.healthRecord(false, null, null, 'T', 'x'.repeat(500));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.latencyMs, null);
  assert.strictEqual(r.error.length, 200);
});
test('healthRecord — arrondi (distingue round/floor/ceil)', () => {
  assert.strictEqual(S.healthRecord(true, 182.6, 'm', 'T').latencyMs, 183);
  assert.strictEqual(S.healthRecord(true, 182.4, 'm', 'T').latencyMs, 182);
});
test('healthRecord — latence non-finie → null ; model absent → null ; ok coercé', () => {
  assert.strictEqual(S.healthRecord(true, NaN, 'm', 'T').latencyMs, null);
  assert.strictEqual(S.healthRecord(true, 5, null, 'T').model, null);
  assert.strictEqual(S.healthRecord(1, 5, 'm', 'T').ok, true);
  assert.strictEqual(S.healthRecord(0, 5, 'm', 'T').ok, false);
});

// ── Intégration I/O ──
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sug-'));
  const memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
  fs.writeFileSync(path.join(memDir, 'critique.md'), '---\nname: critique\n---\nLE CORPS CRITIQUE');
  fs.writeFileSync(path.join(dir, 'embeddings.json'), JSON.stringify({
    model: 'm', items: [
      { id: 'critique', chunk: '', tier: 0, description: 'd', vector: [1, 0] },
      { id: 'normale', chunk: '', tier: 1, description: 'dn', vector: [0.95, 0.05] },
    ],
  }));
  return { stateDir: dir, idx: path.join(dir, 'embeddings.json'), health: path.join(dir, 'mem-health.json'), memDir };
}

test('serveur down → exit 0, aucune sortie, health=down', () => {
  const s = setup();
  const r = spawnSync('node', [path.join(__dirname, 'memory-suggest.js')], {
    input: JSON.stringify({ prompt: 'test', session_id: 's1' }),
    env: { ...process.env, MEM_INDEX: s.idx, MEM_HEALTH: s.health, MEM_STATE_DIR: s.stateDir, MEMORY_DIR: s.memDir, MEM_EMBED_URL: 'http://127.0.0.1:59999/v1/embeddings' },
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
  assert.strictEqual(JSON.parse(fs.readFileSync(s.health, 'utf8')).ok, false);
});

test('prompt vide → exit 0 sans rien', () => {
  const r = spawnSync('node', [path.join(__dirname, 'memory-suggest.js')], {
    input: JSON.stringify({ prompt: '' }), encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});
