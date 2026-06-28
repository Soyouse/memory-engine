// Tests proc-tree.js (node:test) — détection du PID Claude, noyau PUR.
const { test } = require('node:test');
const assert = require('node:assert');
const P = require('./proc-tree.js');

test('pickClaudePid — renvoie le PID du process nommé claude', () => {
  const chain = [
    { pid: 100, name: 'bash.exe' },
    { pid: 200, name: 'claude.exe' },
    { pid: 300, name: 'cmd.exe' },
  ];
  assert.strictEqual(P.pickClaudePid(chain), 200);
});
test('pickClaudePid — prend le PREMIER claude (le plus proche dans la chaîne)', () => {
  const chain = [
    { pid: 1, name: 'node' },
    { pid: 2, name: 'claude' },        // plus proche
    { pid: 3, name: 'claude.exe' },    // plus haut
  ];
  assert.strictEqual(P.pickClaudePid(chain), 2);
});
test('pickClaudePid — nom insensible à la casse + variante sans .exe (Unix)', () => {
  assert.strictEqual(P.pickClaudePid([{ pid: 7, name: 'Claude' }]), 7);
  assert.strictEqual(P.pickClaudePid([{ pid: 9, name: 'claude' }]), 9);
});
test('pickClaudePid — aucun claude → 0', () => {
  assert.strictEqual(P.pickClaudePid([{ pid: 1, name: 'bash.exe' }, { pid: 2, name: 'cmd.exe' }]), 0);
});
test('pickClaudePid — chaîne vide / non-array / null → 0', () => {
  assert.strictEqual(P.pickClaudePid([]), 0);
  assert.strictEqual(P.pickClaudePid(null), 0);
  assert.strictEqual(P.pickClaudePid('pasunearray'), 0);
});
test('pickClaudePid — ignore les entrées invalides (pid ≤ 0, nom absent, null)', () => {
  const chain = [
    null,
    { pid: 0, name: 'claude.exe' },     // pid invalide
    { name: 'claude.exe' },             // pas de pid
    { pid: -5, name: 'claude.exe' },    // pid négatif
    { pid: 42, name: 'claude.exe' },    // valide
  ];
  assert.strictEqual(P.pickClaudePid(chain), 42);
});
test('pickClaudePid — nom EXACT requis : « clauder-fake » / « xclaude » rejetés', () => {
  assert.strictEqual(P.pickClaudePid([{ pid: 1, name: 'clauder-fake' }]), 0); // substring ≠ match
  assert.strictEqual(P.pickClaudePid([{ pid: 2, name: 'xclaude.exe' }]), 0);
  assert.strictEqual(P.pickClaudePid([{ pid: 3, name: 'claude-code.exe' }]), 0);
});
