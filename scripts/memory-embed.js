// ═══════════════════════════════════════════════════════════════════════
// memory-embed.js — NOYAU PUR (similarité) + I/O embeddings (llama-server)
//   du tier-1 SÉMANTIQUE (cf [[project_memory_system_v2]]).
// ═══════════════════════════════════════════════════════════════════════
//
// CHOIX ARCHI (2026-06-20, dévie de la spec sqlite-vec) : à ~130 mémoires,
//   brute-force cosine en JS PUR = <5ms, zéro dépendance native (pas de
//   better-sqlite3/node-gyp fragile Windows), déterministe + MUTABLE Stryker.
//   sqlite-vec = upgrade documenté si > ~10k vecteurs (couture : remplacer
//   topK + le store, garder l'interface).
//
// MODÈLE : EmbeddingGemma-300M Q8_0 (GGUF) via llama-server backend Vulkan
//   (GPU AMD RX 7600, JAMAIS CPU/DDR4). Endpoint OpenAI /v1/embeddings.
//   ⚠️ Préfixes de tâche EmbeddingGemma OBLIGATOIRES (qualité) :
//     - documents indexés  : "search_document: <texte>"
//     - requête utilisateur : "search_query: <texte>"
//   Les mélanger ou les omettre dégrade fortement le retrieval.
//
// ⚠️ cosine/topK = PURS (mutés). embedText = I/O (fetch, exclu mutation).
// ═══════════════════════════════════════════════════════════════════════

'use strict';

// Stryker disable all : config déclarative (endpoint + profil modèle) —
//   aucun contrat comportemental à muter (cf doctrine discord-mcp).
const EMBED_URL = process.env.MEM_EMBED_URL || 'http://127.0.0.1:8181/v1/embeddings';

// ⚠️⚠️ PROFIL MODÈLE — SOURCE UNIQUE. CHANGER DE MODÈLE D'EMBEDDING =
//   1) éditer CE bloc, 2) `node memory-reindex.js` (FULL reindex OBLIGATOIRE —
//   un index d'un autre modèle est INCOMPATIBLE), 3) recalibrer `MIN_SCORE`
//   (memory-suggest.js — chaque modèle a sa propre échelle de cosine).
//   Les 4 params ci-dessous sont COUPLÉS au modèle, JAMAIS portables tels quels :
//   - dim : taille du vecteur. Si elle change, tout l'index est invalide.
//   - queryPrefix/docPrefix : propres à la FAMILLE du modèle. Mauvais préfixe
//       = retrieval dégradé SANS erreur. Mélanger query/doc = idem.
//       · EmbeddingGemma : search_query: / search_document:
//       · BGE-M3 : AUCUN préfixe ; familles E5 : query: / passage:
//       · Qwen3-Embedding (ACTUEL) : requête = "Instruct: <tâche>\nQuery: <txt>",
//         document = BRUT (aucun préfixe). Omettre l'instruct = -1 à -5% recall.
//   - apiName : champ "model" envoyé à llama-server (API OpenAI ; ignoré côté
//       serveur mono-modèle, mais requis non-vide).
//   `name` DOIT matcher `model` écrit dans l'index par memory-reindex.js.
// ⚠️ Qwen3-Embedding EXIGE AUSSI `--pooling last` au serveur (cf bootstrap.js) :
//   pooling mean (défaut Gemma) → embeddings FAUX silencieusement. NE PAS retirer.
// DATA-DRIVEN : le profil ACTIF est choisi par bootstrap.js (GPU/CPU) et écrit
//   dans profile.json. On le lit ici ; fallback = profil GPU (Qwen3). Les profils
//   canoniques vivent dans profiles.js (source unique des paires modèle).
const { PROFILES } = require('./profiles.js');
const PATHS = require('./paths.js');
function loadModel() {
  try {
    const p = JSON.parse(require('fs').readFileSync(PATHS.profilePath(), 'utf8'));
    if (p && p.name && p.dim) return p;
  } catch { /* pas encore de profil → défaut */ }
  return PROFILES.gpu;
}
const MODEL = loadModel();
const QUERY_PREFIX = MODEL.queryPrefix; // alias rétro-compat
const DOC_PREFIX = MODEL.docPrefix;
// Stryker restore all

// ── NOYAU PUR (mutable Stryker) ──

// Similarité cosinus de deux vecteurs. Retourne 0 si invalides/tailles ≠.
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    dot += x * y; na += x * x; nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Top-k items {id, vector, ...} par cosine au vecteur requête, score ≥ seuil.
// Retourne [{...item, score}] trié décroissant. k>0, sinon [].
function topK(queryVec, items, k, minScore) {
  if (!Array.isArray(queryVec) || !Array.isArray(items) || !(k > 0)) return [];
  const thr = typeof minScore === 'number' ? minScore : -Infinity;
  const scored = [];
  for (const it of items) {
    if (!it || !Array.isArray(it.vector)) continue;
    const score = cosine(queryVec, it.vector);
    if (score >= thr) scored.push({ ...it, score });
  }
  scored.sort((p, q) => q.score - p.score);
  return scored.slice(0, k);
}

// Recherche avec DÉDUP par fichier : items = chunks {id, chunk, vector, ...}.
// Plusieurs chunks par fichier (chunking par section) → on garde le MEILLEUR
// score par `id` (fichier), puis top-k. Évite qu'un gros fichier monopolise
// le top-k avec ses N sections. Pur (mutable).
function searchDedup(queryVec, items, k, minScore) {
  if (!Array.isArray(queryVec) || !Array.isArray(items) || !(k > 0)) return [];
  const thr = typeof minScore === 'number' ? minScore : -Infinity;
  const best = new Map();
  for (const it of items) {
    if (!it || !Array.isArray(it.vector)) continue;
    const score = cosine(queryVec, it.vector);
    if (score < thr) continue;
    const prev = best.get(it.id);
    if (!prev || score > prev.score) {
      best.set(it.id, { id: it.id, chunk: it.chunk, description: it.description, tier: it.tier, score });
    }
  }
  return [...best.values()].sort((p, q) => q.score - p.score).slice(0, k);
}

// GARDE ANTI-SWAP SILENCIEUX : si l'index a une `dim` connue et que le vecteur
// requête a une AUTRE taille, le serveur tourne un modèle ≠ celui qui a indexé
// → tous les scores sont du bruit. Mieux vaut signaler DOWN que mentir. dim
// absente (vieil index) → pas de garde (false). Pur (mutable).
function dimMismatch(queryVec, idx) {
  const idxDim = idx && Number.isFinite(idx.dim) ? idx.dim : 0;
  if (!idxDim || !Array.isArray(queryVec) || queryVec.length === 0) return false;
  return queryVec.length !== idxDim;
}

module.exports = { cosine, topK, searchDedup, dimMismatch, MODEL, EMBED_URL, QUERY_PREFIX, DOC_PREFIX, embedText };

// ── I/O (exclue mutation) ──
// Stryker disable all
async function embedText(text, opts) {
  const o = opts || {};
  const url = o.url || EMBED_URL;
  const prefix = o.kind === 'query' ? QUERY_PREFIX : o.kind === 'document' ? DOC_PREFIX : '';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), o.timeoutMs || 4000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: prefix + String(text), model: MODEL.apiName }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const vec = json && json.data && json.data[0] && json.data[0].embedding;
    if (!Array.isArray(vec)) throw new Error('réponse sans embedding');
    return vec;
  } finally {
    clearTimeout(timeout);
  }
}
// Stryker restore all
