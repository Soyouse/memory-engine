// Tests session-leases.js (node:test) — refcount par liveness PID : pur + intégration I/O.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./session-leases.js');

// Isole un data dir temp (paths lit MEMORY_ENGINE_HOME à l'appel).
function withTempHome(fn) {
  const prev = process.env.MEMORY_ENGINE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leases-'));
  process.env.MEMORY_ENGINE_HOME = dir;
  try { return fn(dir); }
  finally { if (prev === undefined) delete process.env.MEMORY_ENGINE_HOME; else process.env.MEMORY_ENGINE_HOME = prev; }
}

// ── sanitizeId (pur) ──
test('sanitizeId — UUID conservé', () => {
  assert.strictEqual(L.sanitizeId('f3af1bcd-506f-475d-8e93-3807219bfb28'), 'f3af1bcd-506f-475d-8e93-3807219bfb28');
});
test('sanitizeId — anti path-traversal + vide → unknown', () => {
  assert.strictEqual(L.sanitizeId('../../etc/passwd'), 'etcpasswd');
  assert.strictEqual(L.sanitizeId(''), 'unknown');
  assert.strictEqual(L.sanitizeId(null), 'unknown');
  assert.strictEqual(L.sanitizeId('!!!'), 'unknown');
});
test('sanitizeId — tronqué à 200', () => {
  assert.strictEqual(L.sanitizeId('a'.repeat(500)).length, 200);
});

// ── countAlive (pur) — aliveFn injectée ──
test('countAlive — compte les PID vivants selon aliveFn', () => {
  const alive = new Set([10, 30]);
  assert.strictEqual(L.countAlive([10, 20, 30, 40], (p) => alive.has(p)), 2);
});
test('countAlive — tous morts → 0 ; non-array / non-fonction → 0', () => {
  assert.strictEqual(L.countAlive([1, 2], () => false), 0);
  assert.strictEqual(L.countAlive(null, () => true), 0);
  assert.strictEqual(L.countAlive([1], 'pasunefonction'), 0);
});

// ── deadEntries (pur) ──
test('deadEntries — renvoie les entrées dont le PID est mort', () => {
  const alive = new Set([200]);
  const entries = [{ file: 'a', pid: 100 }, { file: 'b', pid: 200 }];
  assert.deepStrictEqual(L.deadEntries(entries, (p) => alive.has(p)).map((e) => e.file), ['a']);
});
test('deadEntries — non-array / non-fonction → []', () => {
  assert.deepStrictEqual(L.deadEntries(null, () => false), []);
  assert.deepStrictEqual(L.deadEntries([{ file: 'a', pid: 1 }], 'x'), []);
});

// ── shouldStop (pur) ──
test('shouldStop — vrai SEULEMENT si 0 session vivante', () => {
  assert.strictEqual(L.shouldStop(0), true);
  assert.strictEqual(L.shouldStop(1), false);
  assert.strictEqual(L.shouldStop(2), false);
});

// ── Intégration I/O : leases sur disque ──
test('addLease / readLeases / removeLease — écrit le PID, le relit, supprime', () => {
  withTempHome(() => {
    L.addLease('s1', 26868);
    L.addLease('s2', 12345);
    const leases = L.readLeases().sort((a, b) => a.file.localeCompare(b.file));
    assert.deepStrictEqual(leases, [{ file: 's1', pid: 26868 }, { file: 's2', pid: 12345 }]);
    L.removeLease('s1');
    assert.deepStrictEqual(L.readLeases(), [{ file: 's2', pid: 12345 }]);
  });
});
test('purgeDead — supprime les leases dont le PID claude est mort (PID bidons)', () => {
  withTempHome(() => {
    L.addLease('mort1', 999990); // PID inexistant → isClaudeAlive false
    L.addLease('mort2', 999991);
    L.purgeDead();
    assert.strictEqual(L.readLeases().length, 0); // tout purgé (aucun n'est un claude vivant)
  });
});
test('aliveCount — 0 quand toutes les leases pointent des PID morts', () => {
  withTempHome(() => {
    L.addLease('x', 999992);
    assert.strictEqual(L.aliveCount(), 0);
  });
});
test('readLeases — répertoire absent → [] (fail-open)', () => {
  withTempHome(() => {
    assert.deepStrictEqual(L.readLeases(), []);
  });
});
