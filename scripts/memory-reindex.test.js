// Tests memory-reindex.js (node:test) — noyaux purs index (upsert/purge/parse).
const { test } = require('node:test');
const assert = require('node:assert');
const R = require('./memory-reindex.js');

// ── parseFile (pur) ──
test('parseFile — tier0 présent → tier 0', () => {
  const p = R.parseFile('---\nname: x\ndescription: "d"\ntier0: true\n---\ncorps');
  assert.strictEqual(p.tier, 0);
  assert.strictEqual(p.name, 'x');
  assert.strictEqual(p.description, 'd');
  assert.strictEqual(p.body, 'corps');
});
test('parseFile — tier0 absent → tier 1 (défaut)', () => {
  assert.strictEqual(R.parseFile('---\nname: x\n---\ncorps').tier, 1);
});
test('parseFile — tier0 même sans valeur → tier 0 (présence)', () => {
  assert.strictEqual(R.parseFile('---\ntier0:\n---\nc').tier, 0);
});
test('parseFile — pas de frontmatter → corps = tout, tier 1', () => {
  const p = R.parseFile('juste du texte');
  assert.strictEqual(p.tier, 1);
  assert.strictEqual(p.body, 'juste du texte');
});
test('parseFile — content falsy (null/undefined/"") → corps vide, tier 1', () => {
  for (const v of [null, undefined, '']) {
    const p = R.parseFile(v);
    assert.strictEqual(p.body, '', 'body vide');
    assert.strictEqual(p.tier, 1);
    assert.strictEqual(p.name, '');
  }
});

// ── chunksOf (pur) ──
test('chunksOf — sans section → 1 chunk', () => {
  const c = R.chunksOf({ name: 'n', description: 'd', body: 'court' });
  assert.strictEqual(c.length, 1);
  assert.match(c[0].text, /court/);
});
test('chunksOf — sections ## → 1 chunk par section', () => {
  const c = R.chunksOf({ name: 'n', description: 'd', body: '## A\naaa\n## B\nbbb' });
  assert.strictEqual(c.length, 2);
  assert.deepStrictEqual(c.map((x) => x.chunk), ['A', 'B']);
});
test('chunksOf — en-tête (name+desc) répété dans chaque chunk', () => {
  const c = R.chunksOf({ name: 'NOM', description: 'DESC', body: '## A\na\n## B\nb' });
  assert.ok(c.every((x) => x.text.includes('NOM') && x.text.includes('DESC')));
});

test('parseFile — description : strip guillemets simples/doubles + trim', () => {
  assert.strictEqual(R.parseFile('---\ndescription: "double"\n---\nx').description, 'double');
  assert.strictEqual(R.parseFile("---\ndescription: 'simple'\n---\nx").description, 'simple');
  assert.strictEqual(R.parseFile('---\nname:   espacé   \n---\nx').name, 'espacé');
});
test('parseFile — champ absent → chaîne vide', () => {
  assert.strictEqual(R.parseFile('---\nname: x\n---\nc').description, '');
});
test('field — extrait la valeur après la clé', () => {
  assert.strictEqual(R.field('a: 1\nfoo: bar', 'foo'), 'bar');
  assert.strictEqual(R.field('a: 1', 'foo'), '');
});
test('field — espaces multiples + trim de la valeur', () => {
  assert.strictEqual(R.field('foo:    bar   ', 'foo'), 'bar');
});
test('field — clé sans valeur → vide (exige au moins 1 char)', () => {
  assert.strictEqual(R.field('foo:', 'foo'), '');
});
test('field — clé ancrée début/newline, PAS sous-chaîne', () => {
  assert.strictEqual(R.field('xfoo: v', 'foo'), ''); // xfoo ≠ foo
  assert.strictEqual(R.field('  foo: v', 'foo'), 'v'); // indentée OK
});
test('field — strip guillemets simples ET doubles', () => {
  assert.strictEqual(R.field('foo: "d"', 'foo'), 'd');
  assert.strictEqual(R.field("foo: 'd'", 'foo'), 'd');
});
test('parseFile — tier0 indenté → tier 0 ; xtier0 → tier 1', () => {
  assert.strictEqual(R.parseFile('---\n  tier0: x\n---\nc').tier, 0);
  assert.strictEqual(R.parseFile('---\nxtier0: y\n---\nc').tier, 1);
});

// ── splitSections (pur, exhaustif) ──
test('splitSections — vide/null → []', () => {
  assert.deepStrictEqual(R.splitSections(''), []);
  assert.deepStrictEqual(R.splitSections(null), []);
});
test('splitSections — sans section → 1 part titre vide', () => {
  assert.deepStrictEqual(R.splitSections('abc\ndef'), [{ title: '', lines: ['abc', 'def'] }]);
});
test('splitSections — une section ##', () => {
  assert.deepStrictEqual(R.splitSections('## A\na1\na2'), [{ title: 'A', lines: ['a1', 'a2'] }]);
});
test('splitSections — préambule PUIS section', () => {
  assert.deepStrictEqual(R.splitSections('pre\n## A\na'),
    [{ title: '', lines: ['pre'] }, { title: 'A', lines: ['a'] }]);
});
test('splitSections — 2 sections', () => {
  assert.deepStrictEqual(R.splitSections('## A\na\n## B\nb'),
    [{ title: 'A', lines: ['a'] }, { title: 'B', lines: ['b'] }]);
});
test('splitSections — ### (h3) découpe ; #### (h4) NON', () => {
  assert.deepStrictEqual(R.splitSections('### H3\nx'), [{ title: 'H3', lines: ['x'] }]);
  assert.deepStrictEqual(R.splitSections('#### H4\ny'), [{ title: '', lines: ['#### H4', 'y'] }]);
});
test('splitSections — section à titre seul (corps vide) est gardée', () => {
  assert.deepStrictEqual(R.splitSections('## A'), [{ title: 'A', lines: [] }]);
});
test('splitSections — ## sans espace après n\'est PAS une section', () => {
  assert.deepStrictEqual(R.splitSections('##NoSpace\nx'), [{ title: '', lines: ['##NoSpace', 'x'] }]);
});

// ── chunksOf : TEXTE EXACT (tue les mutants de construction) ──
test('chunksOf — sans section : texte EXACT = head + corps', () => {
  assert.deepStrictEqual(R.chunksOf({ name: 'N', description: 'D', body: 'corps' }),
    [{ chunk: '', text: 'N\nD\ncorps' }]);
});
test('chunksOf — 2 sections : texte EXACT par chunk (head+titre+buf)', () => {
  const c = R.chunksOf({ name: 'N', description: 'D', body: '## A\nl1\n## B\nl2' });
  assert.deepStrictEqual(c, [
    { chunk: 'A', text: 'N\nD\nA\nl1' },
    { chunk: 'B', text: 'N\nD\nB\nl2' },
  ]);
});
test('chunksOf — préambule : texte EXACT (titre vide filtré)', () => {
  const c = R.chunksOf({ name: 'N', description: 'D', body: 'pre\n## A\na' });
  assert.deepStrictEqual(c[0], { chunk: '', text: 'N\nD\npre' });
});

// ── chunksOf : préambule + ### + troncature ──
test('chunksOf — préambule avant le 1er ## = chunk séparé', () => {
  const c = R.chunksOf({ name: 'n', description: 'd', body: 'PREAMBULE ici\n## A\naaa' });
  assert.strictEqual(c.length, 2);
  assert.strictEqual(c[0].chunk, '');
  assert.match(c[0].text, /PREAMBULE/);
  assert.strictEqual(c[1].chunk, 'A');
});
test('chunksOf — détecte aussi les ### (h3)', () => {
  const c = R.chunksOf({ name: 'n', description: 'd', body: '## A\na\n### B\nb' });
  assert.deepStrictEqual(c.map((x) => x.chunk), ['A', 'B']);
});
test('chunksOf — tronque le corps de section à CHUNK_MAX', () => {
  const big = 'z'.repeat(R.CHUNK_MAX + 2000);
  const c = R.chunksOf({ name: 'n', description: 'd', body: '## A\n' + big + '\n## B\nb' });
  const a = c.find((x) => x.chunk === 'A');
  assert.ok(a.text.length < R.CHUNK_MAX + 200); // tronqué (head+title+CHUNK_MAX)
});
test('chunksOf — en-tête vide (ni name ni desc) → pas de ligne d\'en-tête', () => {
  const c = R.chunksOf({ name: '', description: '', body: 'juste du corps' });
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].text, 'juste du corps');
});
test('chunksOf — corps vide/whitespace → fallback en-tête seul', () => {
  assert.deepStrictEqual(R.chunksOf({ name: 'N', description: 'D', body: '' }),
    [{ chunk: '', text: 'N\nD' }]);
  assert.deepStrictEqual(R.chunksOf({ name: 'N', description: 'D', body: '   \n  ' }),
    [{ chunk: '', text: 'N\nD' }]);
});

// ── paragraphs (pur) — découpe par ligne vide ──
test('paragraphs — sépare sur ≥1 ligne vide, trim, non-vides', () => {
  assert.deepStrictEqual(R.paragraphs('a\n\nb'), ['a', 'b']);
  assert.deepStrictEqual(R.paragraphs('a\n  \nb'), ['a', 'b']); // ligne vide à espaces
  assert.deepStrictEqual(R.paragraphs('  x  '), ['x']);
});
test('paragraphs — pas de ligne vide → 1 seul paragraphe (multi-ligne gardé)', () => {
  assert.deepStrictEqual(R.paragraphs('l1\nl2'), ['l1\nl2']);
});
test('paragraphs — vide/null → []', () => {
  assert.deepStrictEqual(R.paragraphs(''), []);
  assert.deepStrictEqual(R.paragraphs(null), []);
});

// ── packParagraphs (pur) — regroupement anti-dilution ──
test('packParagraphs — [] → []', () => {
  assert.deepStrictEqual(R.packParagraphs([]), []);
  assert.deepStrictEqual(R.packParagraphs(null), []);
});
test('packParagraphs — petits paragraphes regroupés en 1 bloc', () => {
  assert.deepStrictEqual(R.packParagraphs(['a', 'b', 'c']), ['a\nb\nc']);
});
test('packParagraphs — flush quand le bloc atteint CHUNK_TARGET', () => {
  const big = 'A'.repeat(R.CHUNK_TARGET + 10);
  const r = R.packParagraphs([big, 'queue']);
  assert.strictEqual(r.length, 2);      // big flush seul, queue ensuite
  assert.strictEqual(r[0], big);
  assert.strictEqual(r[1], 'queue');
});
test('packParagraphs — flush par ACCUMULATION (petits paras cumulés > TARGET)', () => {
  const q = Math.ceil(R.CHUNK_TARGET / 2); // 2 paras se cumulent au-delà de TARGET
  const r = R.packParagraphs(['A'.repeat(q), 'B'.repeat(q), 'C'.repeat(q)]);
  assert.strictEqual(r.length, 3);          // chaque para flush par accumulation
  assert.ok(r.every((b) => b.length === q));
});
test('packParagraphs — bordure : buf+piece+1 == TARGET → PAS de flush par accumulation', () => {
  // a(t-176)+b(175) : +1 == TARGET exact → `>` strict ne flush pas → 1 bloc joint.
  const a = 'a'.repeat(R.CHUNK_TARGET - 176), b = 'b'.repeat(175);
  assert.strictEqual(R.packParagraphs([a, b]).length, 1); // tue `>=` et `>` faux
});
test('packParagraphs — bordure : buf+piece+1 > TARGET d\'un seul char → flush', () => {
  // a(t-175)+b(175) : +1 dépasse de 1 → flush ; avec `-1` ne dépasserait pas (tue ArithmeticOperator).
  const a = 'a'.repeat(R.CHUNK_TARGET - 175), b = 'b'.repeat(175);
  assert.strictEqual(R.packParagraphs([a, b]).length, 2);
});
test('packParagraphs — paragraphe > CHUNK_MAX est tronqué', () => {
  const huge = 'Z'.repeat(R.CHUNK_MAX + 500);
  const r = R.packParagraphs([huge]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].length, R.CHUNK_MAX);
});

// ── chunksOf : ANTI-DILUTION (bug 2026-06-21) ──
test('chunksOf — section grosse multi-paragraphe → SOUS-DÉCOUPÉE (terme isolé du bruit)', () => {
  const bruit = 'A'.repeat(R.CHUNK_TARGET + 20);
  const c = R.chunksOf({ name: 'n', description: 'd', body: '## S\n' + bruit + '\n\nhusky pre-push cible' });
  assert.ok(c.length >= 2, 'la section doit produire ≥ 2 chunks');
  const hk = c.find((x) => x.text.includes('husky'));
  assert.ok(hk && !hk.text.includes('AAAA'), 'le terme cible doit être isolé du bruit');
});

// ── upsertChunks (pur) ──
test('upsertChunks — remplace les chunks de l\'id, garde les autres', () => {
  const items = [{ id: 'a', chunk: '1' }, { id: 'b', chunk: '1' }, { id: 'a', chunk: '2' }];
  const r = R.upsertChunks(items, 'a', [{ id: 'a', chunk: 'neuf' }]);
  assert.deepStrictEqual(r.filter((x) => x.id === 'a').map((x) => x.chunk), ['neuf']);
  assert.strictEqual(r.filter((x) => x.id === 'b').length, 1); // b intact
});
test('upsertChunks — id absent → simple ajout', () => {
  const r = R.upsertChunks([{ id: 'a' }], 'c', [{ id: 'c' }]);
  assert.deepStrictEqual(r.map((x) => x.id), ['a', 'c']);
});
test('upsertChunks — entrées invalides → robuste', () => {
  assert.deepStrictEqual(R.upsertChunks(null, 'a', [{ id: 'a' }]), [{ id: 'a' }]);
  assert.deepStrictEqual(R.upsertChunks([{ id: 'a' }], 'a', null), []);
});

// ── purgeMissing (pur) — gère les SUPPRESSIONS ──
test('purgeMissing — retire les ids absents du dossier', () => {
  const items = [{ id: 'vivant' }, { id: 'mort' }, { id: 'vivant' }];
  const r = R.purgeMissing(items, new Set(['vivant']));
  assert.ok(r.every((x) => x.id === 'vivant'));
  assert.strictEqual(r.length, 2);
});
test('purgeMissing — accepte un array d\'ids', () => {
  assert.deepStrictEqual(R.purgeMissing([{ id: 'a' }, { id: 'b' }], ['a']).map((x) => x.id), ['a']);
});
test('purgeMissing — entrées invalides → robuste', () => {
  assert.deepStrictEqual(R.purgeMissing(null, ['a']), []);
  assert.deepStrictEqual(R.purgeMissing([{ id: 'a' }], null), []);
});
