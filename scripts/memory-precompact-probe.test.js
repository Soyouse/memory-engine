// Tests memory-precompact-probe.js (node:test). Noyau pur + intégration I/O.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, 'memory-precompact-probe.js');
const { formatProbeLine } = require('./memory-precompact-probe.js');

// ── Noyau pur (mutable) ──
test('formatProbeLine — trigger auto + session', () => {
  const l = formatProbeLine({ trigger: 'auto', session_id: 'abc' }, '2026-06-20T10:00:00Z');
  assert.strictEqual(l, '2026-06-20T10:00:00Z trigger=auto session=abc');
});

test('formatProbeLine — manuel', () => {
  const l = formatProbeLine({ trigger: 'manual', session_id: 'x' }, 'T');
  assert.match(l, /trigger=manual/);
});

test('formatProbeLine — champs manquants → unknown', () => {
  const l = formatProbeLine({}, 'T');
  assert.strictEqual(l, 'T trigger=unknown session=unknown');
});

// ── Intégration I/O ──
test('append au log + exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ trigger: 'auto', session_id: 's1' }),
    env: { ...process.env, PROBE_STATE_DIR: dir },
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0);
  const log = fs.readFileSync(path.join(dir, 'precompact-probe.log'), 'utf8');
  assert.match(log, /trigger=auto session=s1/);
});

test('stdin vide → exit 0, pas de crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  const r = spawnSync('node', [HOOK], { input: '', env: { ...process.env, PROBE_STATE_DIR: dir }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
});
