'use strict';
// ═══════════════════════════════════════════════════════════════════════
// memory-bm25.js — Récupération LEXICALE (BM25 Okapi) + fusion RRF.
//   COMPLÉMENT du sémantique (memory-embed) : capte le MOT EXACT — noms
//   propres, identifiants, termes rares — que le cosine « rate mollement ».
//   Cf [[project_memory_system_v2]].
// ═══════════════════════════════════════════════════════════════════════
//
// POURQUOI BM25 et PAS un 2e modèle (SPLADE) :
//   - SPLADE = modèle entraîné EN ANGLAIS (monolingue, doit traduire les docs).
//     Nos mémoires sont en FRANÇAIS → son seul atout (expansion de synonymes)
//     s'effondre. Les variantes multilingues ne font PAS d'expansion → ≈ BM25
//     mais coûtent un 2e serveur GPU. Vérifié web 2026-06-28.
//   - L'expansion sémantique (synonymes) est DÉJÀ couverte par le dense Qwen3
//     (multilingue). BM25 n'ajoute QUE l'axe lexical manquant. Zéro recouvrement.
//   - BM25 = 0 modèle, 0 GPU, 0 serveur, déterministe, agnostique à la langue.
//     Construit EN RAM à chaque prompt depuis l'index déjà chargé → 0 fichier,
//     0 SSD, 0 fuite.
//
// 100% PUR (aucun I/O, aucun require de fichier) → entièrement muté Stryker.
//   Reçoit les items de l'index en argument ; n'écrit/ne lit rien.
// ═══════════════════════════════════════════════════════════════════════

// Stryker disable all : config déclarative (constantes de tuning BM25/RRF) —
//   bornes empiriques, pas un contrat comportemental à muter.
const K1 = 1.2;   // saturation de fréquence (standard Okapi).
const B = 0.75;   // normalisation par longueur (standard Okapi).
// RRF : k petit = plus de poids aux tout premiers rangs. L'industrie prend 60
//   sur de GROS corpus ; sur ~124 mémoires un k modéré (30) sépare mieux le top.
const RRF_K = 30;
// Stop-words FR (les mots ultra-fréquents portent ~0 d'information). BM25 les
//   pénalise déjà via l'IDF, mais les retirer réduit le bruit de fusion à la marge.
const STOP = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'au', 'aux', 'et', 'ou', 'où',
  'a', 'à', 'en', 'dans', 'sur', 'sous', 'par', 'pour', 'avec', 'sans', 'que', 'qui',
  'quoi', 'dont', 'est', 'sont', 'ce', 'se', 'sa', 'son', 'ses', 'ne', 'pas', 'plus',
  'on', 'il', 'elle', 'je', 'tu', 'nous', 'vous', 'ils', 'elles', 'me', 'te', 'mon',
  'ma', 'mes', 'ton', 'ta', 'tes', 'leur', 'leurs', 'y', 'si', 'mais', 'comme', 'fait',
]);
// Stryker restore all

// ── NOYAU PUR (mutable Stryker) ──

// Retire les diacritiques (NFD + suppression des marques) → "déploiement" et
// "deploiement" tokenisent pareil. Robuste aux accents manquants dans un prompt.
function unaccent(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Tokenise un texte FR : minuscule, sans accents, mots alphanumériques ≥ 2,
// stop-words retirés. Garde les chiffres (ex "h24", "2026", "rncp36297").
function tokenize(text) {
  return unaccent(String(text == null ? '' : text).toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

// IDF BM25 variante « +1 » (Lucene/BM25+) : log(1 + (N-n+0.5)/(n+0.5)).
//   Toujours > 0 pour 0 < n ≤ N (jamais de poids négatif, contrairement à la
//   forme classique sans +1) → token rare = poids fort, token fréquent = faible.
function idf(n, N) {
  return Math.log(1 + (N - n + 0.5) / (n + 0.5));
}

// Construit le corpus lexical depuis les items de l'index. Chaque CHUNK = un doc
// de SCORING (tf/longueur au niveau passage), mais l'IDF compte les FICHIERS
// distincts (id), PAS les chunks.
//   ⚠️ CRUCIAL : l'en-tête (nom+description) est répété dans chaque chunk d'un
//   fichier. Compter l'IDF par chunk écraserait la rareté des noms propres (« sylvia »
//   dans 6 chunks du même fichier paraîtrait fréquent). df = nb de FICHIERS contenant
//   le token, N = nb de fichiers → la rareté reflète la réalité documentaire.
//   Doc lexical = id + titre + description + texte du corps (`text` si présent).
//   Retourne { docs:[{id,chunk,description,tier,len,tf}], df:Map(token→#fichiers), avgdl, N:#fichiers }.
function buildCorpus(items) {
  const docs = [];
  const dfFiles = new Map();   // token → Set(id) ⇒ nb de fichiers distincts.
  const fileIds = new Set();
  for (const it of (Array.isArray(items) ? items : [])) {
    if (!it || !it.id) continue;
    fileIds.add(it.id);
    const raw = [it.id, it.chunk, it.description, it.text].filter(Boolean).join(' ');
    const toks = tokenize(raw);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) {
      let s = dfFiles.get(t);
      if (!s) { s = new Set(); dfFiles.set(t, s); }
      s.add(it.id);
    }
    docs.push({ id: it.id, chunk: it.chunk, description: it.description, tier: it.tier, len: toks.length, tf });
  }
  const df = new Map();
  for (const [t, s] of dfFiles) df.set(t, s.size);
  let sum = 0;
  for (const d of docs) sum += d.len;
  const avgdl = docs.length ? sum / docs.length : 0;
  return { docs, df, avgdl, N: fileIds.size };
}

// Score BM25 Okapi d'un doc pour des tokens de requête, dans un corpus donné.
function scoreDoc(doc, qtokens, corpus) {
  if (!doc || !corpus || !Array.isArray(qtokens)) return 0;
  const avgdl = corpus.avgdl || 1;
  let s = 0;
  for (const t of qtokens) {
    const n = corpus.df.get(t);
    if (!n) continue;
    const f = doc.tf.get(t) || 0;
    if (!f) continue;
    const num = f * (K1 + 1);
    const den = f + K1 * (1 - B + B * (doc.len / avgdl));
    s += idf(n, corpus.N) * (num / den);
  }
  return s;
}

// IDF du token de requête le plus DISCRIMINANT présent dans le doc (0 si aucun).
//   Sert au gate de récupération : un nom propre/terme rare (IDF fort) légitime
//   un rescue lexical ; un mot commun (IDF faible) non. Pur.
function matchedIdf(doc, qtokens, corpus) {
  if (!doc || !corpus || !Array.isArray(qtokens)) return 0;
  let m = 0;
  for (const t of qtokens) {
    const n = corpus.df.get(t);
    if (!n || !(doc.tf.get(t) > 0)) continue;
    const v = idf(n, corpus.N);
    if (v > m) m = v;
  }
  return m;
}

// Recherche BM25 → meilleurs docs DÉDUPLIQUÉS par fichier (id), score > 0.
//   Forme alignée sur searchDedup + `idf` (force du token rare matché, pour le gate).
function bm25Search(query, corpus, k) {
  const q = tokenize(query);
  if (!q.length || !corpus || !Array.isArray(corpus.docs) || !corpus.docs.length || !(k > 0)) return [];
  const best = new Map();
  for (const d of corpus.docs) {
    const score = scoreDoc(d, q, corpus);
    if (!(score > 0)) continue;
    const prev = best.get(d.id);
    if (!prev || score > prev.score) {
      best.set(d.id, { id: d.id, chunk: d.chunk, description: d.description, tier: d.tier, score, idf: matchedIdf(d, q, corpus) });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

// Fusion Reciprocal Rank Fusion de N listes classées (chacune triée desc).
//   RRF(d) = Σ 1/(k + rang). Agnostique à l'ÉCHELLE des scores (cosine ∈ [0,1]
//   et BM25 ∈ [0,∞[ sont incomparables) : opère sur les RANGS, pas les scores.
//   Retourne [{id, rrf}] trié par rrf décroissant.
function rrfFuse(lists, k) {
  const kk = (k > 0) ? k : RRF_K;
  const acc = new Map();
  for (const list of (Array.isArray(lists) ? lists : [])) {
    const arr = Array.isArray(list) ? list : [];
    for (let rank = 0; rank < arr.length; rank++) {
      const it = arr[rank];
      if (!it || !it.id) continue;
      const cur = acc.get(it.id) || { id: it.id, rrf: 0 };
      cur.rrf += 1 / (kk + rank + 1); // rang 0-based → +1
      acc.set(it.id, cur);
    }
  }
  return [...acc.values()].sort((a, b) => b.rrf - a.rrf);
}

// ORCHESTRATEUR hybride (pur) : fusionne sémantique + lexical, rend les top-k
//   au FORMAT de searchDedup (drop-in). cosHits/bm25Hits = searchDedup/bm25Search.
//
// DEUX RÉGIMES (root cause du test live 2026-06-28 : gater le rescue sur le cosine
//   était faux — bruit quand le sémantique réussit, rate le mot-exact quand il échoue) :
//   1. SÉMANTIQUE FORT (≥1 hit cosine ≥ minScore) → on RETIENT ces hits SEULS et on
//      les RÉORDONNE par RRF (le lexical remonte le bon parmi les pertinents).
//      On n'ajoute RIEN sous le seuil → zéro bruit (cas « booking »).
//   2. SÉMANTIQUE VIDE (0 hit ≥ minScore) → RÉCUPÉRATION lexicale BORNÉE : on prend
//      un doc BM25 seulement s'il est À LA FOIS (a) un minimum vu par le sémantique
//      (cosine ≥ regime2Floor — JAMAIS un cosine ~0 = bruit) ET (b) lexicalement
//      DISCRIMINANT (idf ≥ idfStrong = nom propre/terme rare). Le « presque-raté à mot
//      exact » est récupéré (cas « pooling last Qwen3 ») ; un terme absent de la mémoire
//      ou un mot commun → ∅ (« rien si rien » préservé).
//   bm25Hits vide (index sans `text`) → régime 1 sans réordonnancement = ancien comportement.
function hybridSearch(cosHits, bm25Hits, opts) {
  const o = opts || {};
  const minScore = Number.isFinite(o.minScore) ? o.minScore : 0.55;
  const idfStrong = Number.isFinite(o.idfStrong) ? o.idfStrong : 4.0;
  const regime2Floor = Number.isFinite(o.regime2Floor) ? o.regime2Floor : 0.45;
  const k = Number.isFinite(o.k) ? o.k : 5;
  const rrfK = Number.isFinite(o.rrfK) ? o.rrfK : RRF_K;
  const cos = Array.isArray(cosHits) ? cosHits : [];
  const bm = Array.isArray(bm25Hits) ? bm25Hits : [];

  const cosScore = new Map();
  for (const h of cos) if (h && h.id) cosScore.set(h.id, h.score || 0);
  // Méta par id : cosine prioritaire (description/tier d'affichage), bm25 en repli.
  const meta = new Map();
  for (const h of bm) if (h && h.id && !meta.has(h.id)) meta.set(h.id, h);
  for (const h of cos) if (h && h.id) meta.set(h.id, h);

  const semStrong = cos.filter((h) => h && (h.score || 0) >= minScore);
  let allowed;
  if (semStrong.length) {
    allowed = new Set(semStrong.map((h) => h.id));                       // régime 1
  } else {                                                              // régime 2 (borné)
    allowed = new Set(bm
      .filter((h) => h && (h.idf || 0) >= idfStrong && (cosScore.get(h.id) || 0) >= regime2Floor)
      .map((h) => h.id));
  }

  const fused = rrfFuse([cos, bm], rrfK);
  const kept = [];
  for (const f of fused) {
    if (!allowed.has(f.id)) continue;
    const m = meta.get(f.id) || f;
    kept.push({ id: f.id, chunk: m.chunk, description: m.description, tier: m.tier, score: cosScore.get(f.id) || 0, rrf: f.rrf });
    if (kept.length >= k) break;
  }
  return kept;
}

module.exports = {
  unaccent, tokenize, idf, buildCorpus, scoreDoc, matchedIdf, bm25Search, rrfFuse, hybridSearch,
  K1, B, RRF_K,
};
