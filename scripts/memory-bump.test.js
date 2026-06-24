// Tests memory-bump.js (node:test) — détection compaction + bump I/O.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, 'memory-bump.js');
const { shouldBump, stateFileFor } = require('./memory-bump.js');

// ── Noyau pur : shouldBump (mutable) ──
test('shouldBump — PreCompact (auto) → true', () => {
  assert.strictEqual(shouldBump({ hook_event_name: 'PreCompact', trigger: 'auto' }), true);
});
test('shouldBump — PreCompact (manual) → true', () => {
  assert.strictEqual(shouldBump({ hook_event_name: 'PreCompact', trigger: 'manual' }), true);
});
test('shouldBump — SessionStart source=compact → true (filet)', () => {
  assert.strictEqual(shouldBump({ hook_event_name: 'SessionStart', source: 'compact' }), true);
});
test('shouldBump — SessionStart source=startup → false', () => {
  assert.strictEqual(shouldBump({ hook_event_name: 'SessionStart', source: 'startup' }), false);
});
test('shouldBump — SessionStart source=resume → false', () => {
  assert.strictEqual(shouldBump({ hook_event_name: 'SessionStart', source: 'resume' }), false);
});
test('shouldBump — autre event → false', () => {
  assert.strictEqual(shouldBump({ hook_event_name: 'UserPromptSubmit' }), false);
});
test('shouldBump — garbage → false (jamais throw)', () => {
  assert.strictEqual(shouldBump(null), false);
  assert.strictEqual(shouldBump('nope'), false);
  assert.strictEqual(shouldBump({}), false);
});

// ── stateFileFor pur ──
test('stateFileFor — session manquante → unknown', () => {
  assert.match(stateFileFor(undefined, '/d'), /mem-state-unknown\.json$/);
  assert.match(stateFileFor('abc', '/d'), /mem-state-abc\.json$/);
});

// ── Intégration I/O ──
test('PreCompact → crée état génération 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bump-'));
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: 's1' }),
    env: { ...process.env, MEM_STATE_DIR: dir }, encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0);
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'mem-state-s1.json'), 'utf8'));
  assert.strictEqual(st.generation, 1);
});

test('double bump (PreCompact puis SessionStart compact) → génération 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bump-'));
  const env = { ...process.env, MEM_STATE_DIR: dir };
  spawnSync('node', [HOOK], { input: JSON.stringify({ hook_event_name: 'PreCompact', session_id: 's2' }), env, encoding: 'utf8' });
  spawnSync('node', [HOOK], { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', session_id: 's2' }), env, encoding: 'utf8' });
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'mem-state-s2.json'), 'utf8'));
  assert.strictEqual(st.generation, 2); // changement = ce qui compte
});

test('SessionStart startup → AUCUN fichier (pas de bump)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bump-'));
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 's3' }),
    env: { ...process.env, MEM_STATE_DIR: dir }, encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.existsSync(path.join(dir, 'mem-state-s3.json')), false);
});

test('stdin vide / JSON cassé → exit 0 fail-open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bump-'));
  const env = { ...process.env, MEM_STATE_DIR: dir };
  assert.strictEqual(spawnSync('node', [HOOK], { input: '', env, encoding: 'utf8' }).status, 0);
  assert.strictEqual(spawnSync('node', [HOOK], { input: '{bad', env, encoding: 'utf8' }).status, 0);
});

test('sessions distinctes → fichiers isolés (multi-session safe)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bump-'));
  const env = { ...process.env, MEM_STATE_DIR: dir };
  spawnSync('node', [HOOK], { input: JSON.stringify({ hook_event_name: 'PreCompact', session_id: 'A' }), env, encoding: 'utf8' });
  spawnSync('node', [HOOK], { input: JSON.stringify({ hook_event_name: 'PreCompact', session_id: 'B' }), env, encoding: 'utf8' });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'mem-state-A.json'), 'utf8')).generation, 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'mem-state-B.json'), 'utf8')).generation, 1);
});
