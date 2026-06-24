// Tests memory-guard.js (node:test) — gardien fichiers mémoire (noyau pur).
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('./memory-guard.js');

// ── extractFrontmatter (pur) ──
test('extractFrontmatter — extrait le bloc', () => {
  assert.strictEqual(G.extractFrontmatter('---\na: 1\nb: 2\n---\ncorps'), 'a: 1\nb: 2');
});
test('extractFrontmatter — absent / non-string → vide', () => {
  assert.strictEqual(G.extractFrontmatter('pas de fm'), '');
  assert.strictEqual(G.extractFrontmatter(null), '');
});

// ── assessIndex (pur) ──
test('assessIndex — ok sous les seuils', () => {
  assert.strictEqual(G.assessIndex('petit').level, 'ok');
});
test('assessIndex — warn près du cap (lignes)', () => {
  assert.strictEqual(G.assessIndex('x\n'.repeat(G.LINES_WARN)).level, 'warn');
});
test('assessIndex — over au cap (lignes)', () => {
  assert.strictEqual(G.assessIndex('x\n'.repeat(G.LINES_CAP)).level, 'over');
});
test('assessIndex — over au cap (octets)', () => {
  assert.strictEqual(G.assessIndex('x'.repeat(G.BYTES_CAP)).level, 'over');
});

test('assessIndex — BORNES exactes (tue >= vs >)', () => {
  // exactement au cap → over (>=)
  assert.strictEqual(G.assessIndex('x\n'.repeat(G.LINES_CAP - 1) + 'x').level, 'over');
  // exactement au warn → warn
  assert.strictEqual(G.assessIndex('x\n'.repeat(G.LINES_WARN - 1) + 'x').level, 'warn');
  // juste sous le warn → ok
  assert.strictEqual(G.assessIndex('x\n'.repeat(G.LINES_WARN - 2) + 'x').level, 'ok');
});
test('assessIndex — branche OCTETS seule (peu de lignes)', () => {
  assert.strictEqual(G.assessIndex('x'.repeat(G.BYTES_WARN)).level, 'warn');
  assert.strictEqual(G.assessIndex('x'.repeat(G.BYTES_CAP)).level, 'over');
});
test('assessIndex — non-string → ok (0/1)', () => {
  const a = G.assessIndex(null);
  assert.strictEqual(a.level, 'ok');
  assert.strictEqual(a.lines, 1);
});

// ── indexMessage (pur) ──
test('indexMessage — ok → vide', () => {
  assert.strictEqual(G.indexMessage({ level: 'ok' }), '');
  assert.strictEqual(G.indexMessage(null), '');
});
test('indexMessage — over : texte distinctif + valeurs', () => {
  const m = G.indexMessage({ level: 'over', lines: 200, bytes: 25000 });
  assert.match(m, /🛑/);
  assert.match(m, /DÉPASSÉ/);
  assert.match(m, /Troncage SILENCIEUX/);
  assert.match(m, /200\/200 lignes/);
  assert.match(m, /25000\/25000 o/);
});
test('indexMessage — warn : texte distinctif (≠ over)', () => {
  const m = G.indexMessage({ level: 'warn', lines: 170, bytes: 21000 });
  assert.match(m, /⚠️/);
  assert.match(m, /proche du cap/);
  assert.doesNotMatch(m, /DÉPASSÉ/);
});

// ── suspectTierKeys (pur) — LE garde-fou anti-typo ──
test('suspectTierKeys — tier0 exact → aucun suspect', () => {
  assert.deepStrictEqual(G.suspectTierKeys('type: x\ntier0: true'), []);
  assert.deepStrictEqual(G.suspectTierKeys('tier0:'), []);
});
test('suspectTierKeys — rien de tier → aucun suspect', () => {
  assert.deepStrictEqual(G.suspectTierKeys('name: x\ntype: feedback'), []);
});
test('suspectTierKeys — DÉTECTE les typos/variantes', () => {
  assert.deepStrictEqual(G.suspectTierKeys('tier: 0'), ['tier']);
  assert.deepStrictEqual(G.suspectTierKeys('teir0: true'), ['teir0']);
  assert.deepStrictEqual(G.suspectTierKeys('tier1: true'), ['tier1']);
  assert.deepStrictEqual(G.suspectTierKeys('critical: yes'), ['critical']);
  assert.deepStrictEqual(G.suspectTierKeys('TIER0: x'), []); // insensible casse → ok
});
test('suspectTierKeys — variantes + multiples + espace avant `:`', () => {
  assert.deepStrictEqual(G.suspectTierKeys('tier2: x'), ['tier2']);
  assert.deepStrictEqual(G.suspectTierKeys('tier_alpha: x'), ['tier_alpha']);
  assert.deepStrictEqual(G.suspectTierKeys('tier: 0\nteir0: y'), ['tier', 'teir0']);
  assert.deepStrictEqual(G.suspectTierKeys('tier0 : x'), []); // espace avant : reste valide
});
test('suspectTierKeys — non-string → []', () => {
  assert.deepStrictEqual(G.suspectTierKeys(null), []);
});

// ── tierMessage (pur) ──
test('tierMessage — vide si aucun suspect', () => {
  assert.strictEqual(G.tierMessage([]), '');
  assert.strictEqual(G.tierMessage(null), '');
});
test('tierMessage — liste les suspects + 🛑 + rappelle tier0', () => {
  const m = G.tierMessage(['tier', 'teir0']);
  assert.match(m, /🛑/);
  assert.match(m, /tier, teir0/);
  assert.match(m, /IGNORÉE EN SILENCE/);
  assert.match(m, /`tier0`/);
});
test('tierMessage — un seul suspect (pas de virgule)', () => {
  assert.match(G.tierMessage(['critical']), /suspect : critical\./);
});

// ── Intégration I/O ──
function run(filePath) {
  return spawnSync('node', [path.join(__dirname, 'memory-guard.js')], {
    input: JSON.stringify({ tool_input: { file_path: filePath } }), encoding: 'utf8',
  });
}

test('MEMORY.md sous le cap → exit 0', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'g-'));
  const f = path.join(d, 'MEMORY.md'); fs.writeFileSync(f, '- une ligne');
  assert.strictEqual(run(f).status, 0);
});
test('MEMORY.md au-dessus du cap → exit 2 + alerte', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'g-'));
  const f = path.join(d, 'MEMORY.md'); fs.writeFileSync(f, 'x\n'.repeat(G.LINES_CAP));
  const r = run(f);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /CAP MEMORY.md/);
});
test('mémoire avec tier0 correct → exit 0', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-'));
  const f = path.join(d, 'memory', 'foo.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '---\nname: foo\ntier0: true\n---\ncorps');
  assert.strictEqual(run(f).status, 0);
});
test('mémoire avec tier mal écrit → exit 2 + alerte', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-'));
  const f = path.join(d, 'memory', 'bar.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '---\nname: bar\ntier: 0\n---\ncorps');
  const r = run(f);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /Marqueur tier suspect/);
});
test('fichier hors mémoire → exit 0 (pas de validation tier)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));
  const f = path.join(d, 'random.md'); fs.writeFileSync(f, '---\ntier: 0\n---\nx');
  assert.strictEqual(run(f).status, 0);
});
test('fichier illisible → exit 0 fail-open', () => {
  assert.strictEqual(run('/inexistant/nope.md').status, 0);
});
