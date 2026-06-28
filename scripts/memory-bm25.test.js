// Tests memory-bm25.js (node:test) — récupération lexicale BM25 + fusion RRF (noyau pur).
const { test } = require('node:test');
const assert = require('node:assert');
const B = require('./memory-bm25.js');

// ── unaccent ──
test('unaccent — retire les diacritiques', () => {
  assert.strictEqual(B.unaccent('déploiement'), 'deploiement');
  assert.strictEqual(B.unaccent('où à é è ê ç'), 'ou a e e e c');
});
test('unaccent — null/undefined/non-string → chaîne', () => {
  assert.strictEqual(B.unaccent(null), '');
  assert.strictEqual(B.unaccent(undefined), '');
  assert.strictEqual(B.unaccent(42), '42');
});

// ── tokenize ──
test('tokenize — minuscule + sans accents + split non-alphanum', () => {
  assert.deepStrictEqual(B.tokenize('Déploiement VPS-Prod'), ['deploiement', 'vps', 'prod']);
});
test('tokenize — retire les tokens < 2 et les stop-words', () => {
  // "a", "le", "de", "où" = stop ; "à" stop ; "x" trop court → tout saute sauf "sylvia"
  assert.deepStrictEqual(B.tokenize('où en est la facture de Sylvia ?'), ['facture', 'sylvia']);
});
test('tokenize — garde les chiffres et alphanumériques ≥ 2', () => {
  assert.deepStrictEqual(B.tokenize('rncp36297 h24 2026 x'), ['rncp36297', 'h24', '2026']);
});
test('tokenize — vide/null → []', () => {
  assert.deepStrictEqual(B.tokenize(''), []);
  assert.deepStrictEqual(B.tokenize(null), []);
});

// ── idf ──
test('idf — token rare pèse plus que token fréquent', () => {
  assert.ok(B.idf(1, 100) > B.idf(50, 100));
});
test('idf — toujours strictement positif (0 < n ≤ N)', () => {
  assert.ok(B.idf(1, 10) > 0);
  assert.ok(B.idf(10, 10) > 0); // n === N reste > 0 (variante +1)
});

// ── buildCorpus ──
test('buildCorpus — df, avgdl, N, et inclut le champ text', () => {
  const items = [
    { id: 'a', chunk: 'Titre A', description: 'desc', text: 'sylvia facture devis' },
    { id: 'b', chunk: 'Titre B', description: 'desc', text: 'sylvia booking planning' },
  ];
  const c = B.buildCorpus(items);
  assert.strictEqual(c.N, 2);
  assert.strictEqual(c.df.get('sylvia'), 2);   // dans les 2 docs
  assert.strictEqual(c.df.get('facture'), 1);  // dans 1 doc
  assert.ok(c.avgdl > 0);
  assert.strictEqual(c.docs.length, 2);
});
test('buildCorpus — ignore items sans id / null', () => {
  const c = B.buildCorpus([null, { chunk: 'x' }, { id: 'ok', text: 'mot' }]);
  assert.strictEqual(c.N, 1);
  assert.strictEqual(c.docs[0].id, 'ok');
});
test('buildCorpus — vide/non-array → corpus vide', () => {
  const c = B.buildCorpus(null);
  assert.strictEqual(c.N, 0);
  assert.strictEqual(c.avgdl, 0);
});

// ── scoreDoc ──
test('scoreDoc — > 0 si token de requête présent, 0 sinon', () => {
  const corpus = B.buildCorpus([
    { id: 'a', text: 'sylvia facture' },
    { id: 'b', text: 'booking planning' },
  ]);
  const docA = corpus.docs[0];
  assert.ok(B.scoreDoc(docA, ['sylvia'], corpus) > 0);
  assert.strictEqual(B.scoreDoc(docA, ['inexistant'], corpus), 0);
});
test('scoreDoc — garde-fous null', () => {
  const corpus = B.buildCorpus([{ id: 'a', text: 'mot' }]);
  assert.strictEqual(B.scoreDoc(null, ['mot'], corpus), 0);
  assert.strictEqual(B.scoreDoc(corpus.docs[0], null, corpus), 0);
  assert.strictEqual(B.scoreDoc(corpus.docs[0], ['mot'], null), 0);
});

// ── bm25Search ──
test('bm25Search — trie par pertinence, dédup par id, format attendu', () => {
  const corpus = B.buildCorpus([
    { id: 'sylvia', chunk: 'Cliente', description: 'd1', tier: 1, text: 'sylvia sylvia devis facture' },
    { id: 'booking', chunk: 'Resa', description: 'd2', tier: 0, text: 'booking planning sylvia' },
    { id: 'video', chunk: 'Video', description: 'd3', tier: 1, text: 'rendu hyperframes' },
  ]);
  const hits = B.bm25Search('facture de sylvia', corpus, 5);
  assert.strictEqual(hits[0].id, 'sylvia');                 // le + pertinent en tête
  assert.deepStrictEqual(Object.keys(hits[0]).sort(), ['chunk', 'description', 'id', 'idf', 'score', 'tier']);
  assert.ok(hits[0].idf > 0);                               // idf du token rare matché
  assert.ok(!hits.some((h) => h.id === 'video'));           // 0 token commun → absent
});
test('bm25Search — requête sans token / corpus vide / k≤0 → []', () => {
  const corpus = B.buildCorpus([{ id: 'a', text: 'mot' }]);
  assert.deepStrictEqual(B.bm25Search('le la de', corpus, 5), []); // que des stop-words
  assert.deepStrictEqual(B.bm25Search('mot', corpus, 0), []);
  assert.deepStrictEqual(B.bm25Search('mot', B.buildCorpus([]), 5), []);
});
test('bm25Search — respecte k (slice)', () => {
  const corpus = B.buildCorpus([
    { id: 'a', text: 'mot' }, { id: 'b', text: 'mot' }, { id: 'c', text: 'mot' },
  ]);
  assert.strictEqual(B.bm25Search('mot', corpus, 2).length, 2);
});

// ── rrfFuse ──
test('rrfFuse — somme 1/(k+rang), trie décroissant', () => {
  const a = [{ id: 'x' }, { id: 'y' }];          // x rang0, y rang1
  const b = [{ id: 'y' }, { id: 'x' }];          // y rang0, x rang1
  const fused = B.rrfFuse([a, b], 30);
  // x : 1/31 + 1/32 ; y : 1/31 + 1/32 → égalité, mais présence des 2
  assert.strictEqual(fused.length, 2);
  // un doc présent en tête des 2 listes bat un doc présent dans une seule
  const a2 = [{ id: 'top' }, { id: 'x' }];
  const b2 = [{ id: 'top' }, { id: 'z' }];
  const f2 = B.rrfFuse([a2, b2], 30);
  assert.strictEqual(f2[0].id, 'top');
});
test('rrfFuse — ignore items sans id, listes non-array', () => {
  const f = B.rrfFuse([[{ id: 'a' }, null, {}], 'pasunelist', null], 30);
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].id, 'a');
});
test('rrfFuse — k défaut si k≤0', () => {
  const f = B.rrfFuse([[{ id: 'a' }]], 0);
  assert.ok(f[0].rrf > 0);
});

// ── matchedIdf ──
test('matchedIdf — max IDF des tokens de requête présents dans le doc', () => {
  const corpus = B.buildCorpus([
    { id: 'a', text: 'sylvia facture' },   // sylvia : rare (1 doc)
    { id: 'b', text: 'facture devis' },    // facture : 2 docs
    { id: 'c', text: 'facture autre' },
  ]);
  const docA = corpus.docs[0];
  // 'sylvia' (1 doc) doit peser plus que 'facture' (3 docs) → max = idf(sylvia)
  assert.strictEqual(B.matchedIdf(docA, ['sylvia', 'facture'], corpus), B.idf(1, 3));
});
test('matchedIdf — 0 si aucun token présent / garde-fous null', () => {
  const corpus = B.buildCorpus([{ id: 'a', text: 'mot' }]);
  assert.strictEqual(B.matchedIdf(corpus.docs[0], ['absent'], corpus), 0);
  assert.strictEqual(B.matchedIdf(null, ['mot'], corpus), 0);
  assert.strictEqual(B.matchedIdf(corpus.docs[0], null, corpus), 0);
});

// ── hybridSearch (2 régimes) ──
const OPTS = { minScore: 0.55, idfStrong: 4.0, k: 5, rrfK: 30 };

test('hybridSearch — régime 1 : ≥1 cosine fort → garde les forts SEULS', () => {
  const cos = [{ id: 'a', chunk: 't', description: 'd', tier: 1, score: 0.70 }];
  const out = B.hybridSearch(cos, [], OPTS);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'a');
  assert.strictEqual(out[0].score, 0.70);              // cosine préservé
  assert.ok(out[0].rrf > 0);
});
test('hybridSearch — régime 1 : N\'AJOUTE PAS de doc sous-seuil (cas « booking », anti-bruit)', () => {
  const cos = [
    { id: 'booking', chunk: 't', description: 'd', tier: 1, score: 0.76 }, // fort
    { id: 'bruit', chunk: 't', description: 'd', tier: 1, score: 0.52 },   // sous seuil
  ];
  const bm = [{ id: 'bruit', score: 8, idf: 9 }, { id: 'booking', score: 5, idf: 5 }];
  const out = B.hybridSearch(cos, bm, OPTS);
  assert.deepStrictEqual(out.map((h) => h.id), ['booking']); // le sous-seuil reste dehors
});
test('hybridSearch — régime 2 : presque-vu (cosine ≥ floor) + token DISCRIMINANT → récupéré', () => {
  // « pooling last Qwen3 » : pas de hit ≥ 0.55, mais le bon doc est à 0.52 + « qwen3 » rare.
  const cos = [{ id: 'memv2', chunk: 't', description: 'd', tier: 1, score: 0.52 }];
  const bm = [{ id: 'memv2', chunk: 't', description: 'd', tier: 1, score: 12, idf: 4.6 }];
  const out = B.hybridSearch(cos, bm, OPTS);
  assert.deepStrictEqual(out.map((h) => h.id), ['memv2']);
});
test('hybridSearch — régime 2 BORNÉ : doc à cosine ~0 rejeté même si idf très fort (anti-bruit)', () => {
  const cos = [{ id: 'vu', chunk: 't', description: 'd', tier: 1, score: 0.50 }]; // sous 0.55
  const bm = [{ id: 'ghost', chunk: 't', description: 'd', tier: 1, score: 20, idf: 6 }]; // absent du cosine
  const out = B.hybridSearch(cos, bm, OPTS);
  assert.strictEqual(out.length, 0);                   // ghost (cosine 0) ne remonte pas
});
test('hybridSearch — régime 2 : token FAIBLE (idf < seuil) → ∅ (« rien si rien »)', () => {
  const cos = [{ id: 'y', chunk: 't', description: 'd', tier: 1, score: 0.49 }];
  const bm = [{ id: 'y', chunk: 't', description: 'd', tier: 1, score: 6, idf: 1.2 }]; // mot commun
  const out = B.hybridSearch(cos, bm, OPTS);
  assert.strictEqual(out.length, 0);
});
test('hybridSearch — dégradation : BM25 vide = cosine seul (≥ minScore)', () => {
  const cos = [
    { id: 'a', chunk: 't', description: 'd', tier: 1, score: 0.60 },
    { id: 'b', chunk: 't', description: 'd', tier: 1, score: 0.52 }, // sous seuil
  ];
  const out = B.hybridSearch(cos, [], OPTS);
  assert.deepStrictEqual(out.map((h) => h.id), ['a']);
});
test('hybridSearch — RÉORDONNE : le lexical remonte le bon parmi les pertinents', () => {
  const cos = [
    { id: 'generic', chunk: 't', description: 'd', tier: 1, score: 0.66 }, // 1er sémantique
    { id: 'cible', chunk: 't', description: 'd', tier: 1, score: 0.64 },   // 2e sémantique
  ];
  const bm = [{ id: 'cible', chunk: 't', description: 'd', tier: 1, score: 15, idf: 5 }];
  const out = B.hybridSearch(cos, bm, OPTS);
  assert.strictEqual(out[0].id, 'cible'); // RRF : cos#2 + bm#1 bat cos#1 seul
});
test('hybridSearch — respecte k', () => {
  const cos = Array.from({ length: 8 }, (_, i) => ({ id: 'd' + i, chunk: 't', description: 'd', tier: 1, score: 0.60 }));
  const out = B.hybridSearch(cos, [], { ...OPTS, k: 3 });
  assert.strictEqual(out.length, 3);
});
test('hybridSearch — entrées non-array / opts absentes → défauts sûrs', () => {
  assert.deepStrictEqual(B.hybridSearch(null, null), []);
  const out = B.hybridSearch([{ id: 'a', score: 0.99 }], null); // opts défaut minScore 0.55
  assert.strictEqual(out[0].id, 'a');
});

// ── Anti-mutants ciblés (verrouille les frontières/arithmétique) ──
test('tokenize — garde un token de longueur EXACTEMENT 2 (frontière ≥ 2)', () => {
  assert.deepStrictEqual(B.tokenize('go ax z'), ['go', 'ax']); // go/ax len2 gardés, z len1 viré
});
test('idf — valeurs numériques exactes (verrouille la formule)', () => {
  assert.ok(Math.abs(B.idf(1, 1) - Math.log(1.3333333333)) < 1e-6);  // (0.5/1.5)
  assert.ok(Math.abs(B.idf(1, 10) - Math.log(7.3333333333)) < 1e-6); // (9.5/1.5)
  assert.ok(Math.abs(B.idf(2, 10) - Math.log(4.4)) < 1e-6);          // (8.5/2.5)
});
test('buildCorpus — champ manquant : aucun token « undefined » (filter Boolean)', () => {
  const c = B.buildCorpus([{ id: 'zztop' }]); // ni chunk/desc/text
  assert.ok(c.df.has('zztop'));
  assert.ok(!c.df.has('undefined'));
});
test('buildCorpus — tf compte les répétitions ; avgdl = moyenne exacte', () => {
  const c = B.buildCorpus([{ id: 'a', text: 'alpha alpha beta' }, { id: 'b', text: 'delta' }]);
  assert.strictEqual(c.docs[0].tf.get('alpha'), 2);
  assert.strictEqual(c.docs[0].tf.get('beta'), 1);
  assert.strictEqual(c.avgdl, 2); // (3 + 1) / 2
});
test('bm25Search — dédup 2 chunks du MÊME fichier → 1 hit (le meilleur)', () => {
  const c = B.buildCorpus([
    { id: 'x', text: 'rarissime' },
    { id: 'x', text: 'rarissime rarissime' }, // tf plus élevé → meilleur score
  ]);
  const hits = B.bm25Search('rarissime', c, 5);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].id, 'x');
});
test('scoreDoc — avgdl 0 → fallback 1 (pas de division par zéro)', () => {
  const corpus = { docs: [], df: new Map([['mot', 1]]), avgdl: 0, N: 1 };
  const doc = { len: 1, tf: new Map([['mot', 1]]) };
  const s = B.scoreDoc(doc, ['mot'], corpus);
  assert.ok(Number.isFinite(s) && s > 0); // sans fallback : 1/0 = Infinity
});
test('rrfFuse — lists non-array (null) → []', () => {
  assert.deepStrictEqual(B.rrfFuse(null, 30), []);
});
test('rrfFuse — valeur RRF EXACTE 1/(k+rang+1) (verrouille la formule)', () => {
  const f = B.rrfFuse([[{ id: 'a' }, { id: 'b' }]], 30);
  const a = f.find((x) => x.id === 'a').rrf, b = f.find((x) => x.id === 'b').rrf;
  assert.ok(Math.abs(a - 1 / 31) < 1e-12); // rang 0 → 1/(30+0+1)
  assert.ok(Math.abs(b - 1 / 32) < 1e-12); // rang 1 → 1/(30+1+1)
});

// scoreDoc : valeur BM25 Okapi EXACTE calculée à la main → verrouille toute la
//   formule (num=f·(k1+1), den=f+k1·(1-b+b·len/avgdl), idf) d'un seul coup.
test('scoreDoc — score BM25 EXACT (pin formule complète, len ≠ avgdl)', () => {
  const corpus = B.buildCorpus([
    { id: 'aa', text: 'alpha beta' },
    { id: 'bb', text: 'alpha' }, // 'alpha' dans 2 fichiers → df=2, N=2 ⇒ idf(2,2)=ln(1.2)
  ]);
  const s = B.scoreDoc(corpus.docs[0], ['alpha'], corpus);
  // Attendu recalculé avec constantes EN LITTÉRAL (pin num/den/opérateurs) à partir
  //   des longueurs réelles du corpus. idf(2,2) stable = ln(1.2) (n=2 fichiers, N=2).
  const len = corpus.docs[0].len, avg = corpus.avgdl;
  const expected = Math.log(1.2) * (1 * (1.2 + 1)) / (1 + 1.2 * (1 - 0.75 + 0.75 * (len / avg)));
  assert.ok(Math.abs(s - expected) < 1e-9);
});

// bm25Search : chaque sous-condition de la garde (5 branches → 8 mutants).
test('bm25Search — gardes : corpus null / docs non-array → []', () => {
  assert.deepStrictEqual(B.bm25Search('mot', null, 5), []);
  assert.deepStrictEqual(B.bm25Search('mot', { docs: 'pasunearray', df: new Map(), N: 1, avgdl: 1 }, 5), []);
});

// hybridSearch : chaque option custom DOIT changer le comportement (tue les défauts).
test('hybridSearch — minScore custom déplace la frontière sémantique', () => {
  const cos = [{ id: 'a', chunk: 't', description: 'd', tier: 1, score: 0.60 }];
  assert.strictEqual(B.hybridSearch(cos, [], { minScore: 0.55 }).length, 1); // 0.60 ≥ 0.55
  assert.strictEqual(B.hybridSearch(cos, [], { minScore: 0.70 }).length, 0); // 0.60 < 0.70 → régime 2 vide
});
test('hybridSearch — frontière minScore INCLUSIVE (≥, pas >)', () => {
  const cos = [{ id: 'a', chunk: 't', description: 'd', tier: 1, score: 0.55 }];
  assert.strictEqual(B.hybridSearch(cos, [], { minScore: 0.55 }).length, 1); // 0.55 ≥ 0.55 inclus
});
test('hybridSearch — idfStrong custom resserre la récupération (régime 2)', () => {
  const cos = [{ id: 'x', chunk: 't', description: 'd', tier: 1, score: 0.50 }]; // < minScore
  const bm = [{ id: 'x', chunk: 't', description: 'd', tier: 1, score: 9, idf: 4.5 }];
  assert.strictEqual(B.hybridSearch(cos, bm, { minScore: 0.55, idfStrong: 4.0, regime2Floor: 0.45 }).length, 1); // 4.5 ≥ 4.0
  assert.strictEqual(B.hybridSearch(cos, bm, { minScore: 0.55, idfStrong: 5.0, regime2Floor: 0.45 }).length, 0); // 4.5 < 5.0
});
test('hybridSearch — regime2Floor custom resserre le plancher cosine', () => {
  const cos = [{ id: 'x', chunk: 't', description: 'd', tier: 1, score: 0.46 }];
  const bm = [{ id: 'x', chunk: 't', description: 'd', tier: 1, score: 9, idf: 9 }];
  assert.strictEqual(B.hybridSearch(cos, bm, { minScore: 0.55, idfStrong: 4.0, regime2Floor: 0.45 }).length, 1); // 0.46 ≥ 0.45
  assert.strictEqual(B.hybridSearch(cos, bm, { minScore: 0.55, idfStrong: 4.0, regime2Floor: 0.50 }).length, 0); // 0.46 < 0.50
});

// ── Anti-mutants vague 2 : préservation des champs, sélection kk, dédup, skips ──
test('hybridSearch — préserve chunk/description/tier/score de la source', () => {
  const cos = [{ id: 'a', chunk: 'CH', description: 'DE', tier: 0, score: 0.70 }];
  const out = B.hybridSearch(cos, [], OPTS);
  assert.strictEqual(out[0].chunk, 'CH');
  assert.strictEqual(out[0].description, 'DE');
  assert.strictEqual(out[0].tier, 0);
  assert.strictEqual(out[0].score, 0.70);
});
test('hybridSearch — méta : cosine PRIORITAIRE sur bm25 pour l\'affichage', () => {
  const cos = [{ id: 'a', chunk: 'COS', description: 'Dcos', tier: 0, score: 0.70 }];
  const bm = [{ id: 'a', chunk: 'BM', description: 'Dbm', tier: 1, score: 9, idf: 9 }];
  const out = B.hybridSearch(cos, bm, OPTS);
  assert.strictEqual(out[0].description, 'Dcos'); // cos écrase bm
  assert.strictEqual(out[0].tier, 0);
});
test('hybridSearch — régime 2 : hit BM25 SANS idf (→0) est exclu', () => {
  const cos = [{ id: 'x', chunk: 't', description: 'd', tier: 1, score: 0.50 }];
  const bm = [{ id: 'x', score: 9 }]; // pas de champ idf → 0 < idfStrong
  assert.strictEqual(B.hybridSearch(cos, bm, OPTS).length, 0);
});
test('rrfFuse — sélection kk EXACTE : k≤0 → RRF_K(30), k>0 → k', () => {
  assert.ok(Math.abs(B.rrfFuse([[{ id: 'a' }]], 0)[0].rrf - 1 / 31) < 1e-12);  // k≤0 → 1/(30+0+1)
  assert.ok(Math.abs(B.rrfFuse([[{ id: 'a' }]], 5)[0].rrf - 1 / 6) < 1e-12);   // k=5 → 1/(5+0+1)
});
test('bm25Search — dédup MÊME id : conserve le score MAXIMAL des chunks', () => {
  const c = B.buildCorpus([{ id: 'x', text: 'rare' }, { id: 'x', text: 'rare rare rare' }]);
  const s0 = B.scoreDoc(c.docs[0], ['rare'], c), s1 = B.scoreDoc(c.docs[1], ['rare'], c);
  const h = B.bm25Search('rare', c, 5);
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].score, Math.max(s0, s1)); // le meilleur chunk gagne
});
test('bm25Search — tri décroissant par score ; k négatif → []', () => {
  const c = B.buildCorpus([{ id: 'hi', text: 'cible cible cible' }, { id: 'lo', text: 'cible autre mots ici' }]);
  const h = B.bm25Search('cible', c, 5);
  assert.ok(h[0].score >= h[1].score);
  assert.deepStrictEqual(B.bm25Search('cible', c, -1), []);
});
test('scoreDoc — token dans le corpus mais ABSENT du doc → contribue 0 (skip !f)', () => {
  const c = B.buildCorpus([{ id: 'a', text: 'alpha' }, { id: 'b', text: 'beta' }]);
  assert.strictEqual(B.scoreDoc(c.docs[0], ['beta'], c), 0); // beta ∈ df mais ∉ doc a
  assert.strictEqual(B.scoreDoc(c.docs[0], ['zzz'], c), 0);  // zzz ∉ df (skip !n)
});
test('matchedIdf — token du corpus absent du doc (tf 0) → ignoré', () => {
  const c = B.buildCorpus([{ id: 'a', text: 'alpha' }, { id: 'b', text: 'beta' }]);
  assert.strictEqual(B.matchedIdf(c.docs[0], ['beta'], c), 0);
});
