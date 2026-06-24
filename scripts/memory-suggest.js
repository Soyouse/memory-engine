#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// memory-suggest.js — MOTEUR SÉMANTIQUE UNIFIÉ (UserPromptSubmit).
//   Un seul match (cosine), DEUX tiers de réaction selon `metadata.tier`.
//   Cf [[project_memory_system_v2]].
// ═══════════════════════════════════════════════════════════════════════
//
// MODÈLE (le cœur, ne pas re-déformer) : à chaque prompt → match sémantique.
//   Pour chaque mémoire qui matche (cosine ≥ seuil) :
//     - tier-0 (critique) + PREMIÈRE fois de cette génération → INJECTE le
//       CORPS direct. Matchs suivants (même génération) → simple rappel.
//       La compaction reset le « première fois » (compteur de génération).
//     - tier-1 (normal) → toujours simple RAPPEL (id + description).
//   → tier-0 = surensemble de tier-1 : garantit que le CONTENU entre quand
//     c'est pertinent (le cosine ne peut pas « rater mollement » un critique).
//
// AVANTAGE vs industrie : on injecte UNE fois puis on SAIT (via le compteur
//   de génération) que c'est déjà dans le contexte → zéro ré-injection
//   redondante, et ré-injection PILE quand la compaction l'a éjecté. Les
//   systèmes cloud sont aveugles à la compaction → re-poussent en boucle.
//
// RÉSILIENCE ANTI-SILENCE : écrit mem-health.json (ok/down + latence).
// ⚠️ exit 0 TOUJOURS (UserPromptSubmit : exit 2 bloquerait le prompt).
// ⚠️ Pur (partition/format/health) exporté + muté ; I/O (embed/fichiers) exclu.
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');
const { embedText, searchDedup, dimMismatch, MODEL } = require('./memory-embed.js');
const STATE = require('./memory-state.js');
const PATHS = require('./paths.js');

// Stryker disable all : config déclarative (seuils de tuning + chemins) —
//   aucun contrat comportemental à muter (cf doctrine discord-mcp).
const K = 5;                  // candidats considérés par match
const RECALL_MAX = 3;         // rappels affichés max
// seuil de match — COUPLÉ au modèle, vient du profil actif (profiles.js) :
//   GPU/Qwen3 = 0.55 (bruit hors-sujet ~0.50, vrais positifs ≥0.66) ;
//   CPU/Gemma = 0.40. Fallback 0.55 si profil illisible.
const MIN_SCORE = (MODEL && typeof MODEL.minScore === 'number') ? MODEL.minScore : 0.55;
const INJECT_MAX_CHARS = 3000; // corps injecté tronqué au-delà (anti-bloat)
const TIMEOUT_MS = 2500;
const INDEX = PATHS.indexPath();
const HEALTH = PATHS.healthPath();
const STATE_DIR = PATHS.stateDir();
const MEM_DIR = PATHS.memoryDir();
// Stryker restore all

// ── NOYAU PUR (mutable Stryker) ──

// Répartit les hits : tier-0 jamais injecté cette génération → à INJECTER ;
// tout le reste (tier-1, ou tier-0 déjà injecté) → à RAPPELER. state via ledger.
function partitionByTier(hits, state) {
  const toInject = [], toRecall = [];
  for (const h of (Array.isArray(hits) ? hits : [])) {
    if (!h) continue;
    if (h.tier === 0 && STATE.needsReinject(state, h.id)) toInject.push(h);
    else toRecall.push(h);
  }
  return { toInject, toRecall };
}

// Bloc de RAPPEL (tier-1 + tier-0 déjà présents). '' si rien.
function formatRecall(hits) {
  const list = (Array.isArray(hits) ? hits : []).filter(Boolean).slice(0, RECALL_MAX);
  if (list.length === 0) return '';
  const lines = list.map((h) =>
    `- ${h.id}${h.description ? ' — ' + h.description : ''} (${(h.score || 0).toFixed(2)})`);
  return '<memory-recall note="Mémoires pertinentes (relis le fichier si utile).">\n'
    + lines.join('\n') + '\n</memory-recall>';
}

// Bloc d'INJECTION (tier-0, corps complet, tronqué si trop long). '' si rien.
// items = [{ id, body }].
function formatInjected(items) {
  const list = (Array.isArray(items) ? items : []).filter((it) => it && it.body);
  if (list.length === 0) return '';
  const blocks = list.map((it) => {
    let body = it.body;
    if (body.length > INJECT_MAX_CHARS) {
      body = body.slice(0, INJECT_MAX_CHARS) + `\n[…tronqué — lire ${it.id} pour la suite]`;
    }
    return `### ${it.id}\n${body}`;
  });
  return '<memory-inject note="Mémoires critiques (tier-0) pertinentes — injectées en entier.">\n'
    + blocks.join('\n\n') + '\n</memory-inject>';
}

// Enregistrement de santé (lu par la statusline).
function healthRecord(ok, latencyMs, model, isoNow, error) {
  return {
    ok: !!ok,
    latencyMs: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
    model: model || null,
    ts: isoNow,
    error: error ? String(error).slice(0, 200) : null,
  };
}

module.exports = {
  partitionByTier, formatRecall, formatInjected, healthRecord,
  K, RECALL_MAX, MIN_SCORE, INJECT_MAX_CHARS,
};

// ── COQUILLE I/O (exclue mutation) ──
// Stryker disable all
function readBody(id) {
  const raw = fs.readFileSync(path.join(MEM_DIR, id + '.md'), 'utf8');
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  return (m ? m[1] : raw).trim();
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', async () => {
    const writeHealth = (rec) => {
      try { fs.mkdirSync(path.dirname(HEALTH), { recursive: true }); fs.writeFileSync(HEALTH, JSON.stringify(rec)); }
      catch { /* ignore */ }
    };
    try {
      const payload = JSON.parse(raw || '{}');
      const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
      const sessionId = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : 'unknown';
      if (!prompt) { process.exit(0); }

      const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
      const stateFile = path.join(STATE_DIR, `mem-state-${sessionId}.json`);
      let state;
      try { state = STATE.normalize(JSON.parse(fs.readFileSync(stateFile, 'utf8'))); }
      catch { state = STATE.initialState(); }

      const t0 = Date.now();
      const qv = await embedText(prompt, { kind: 'query', timeoutMs: TIMEOUT_MS });
      const latency = Date.now() - t0;
      // GARDE ANTI-SWAP : index et serveur doivent parler le même modèle (dim).
      // Mismatch → scores = bruit → DOWN explicite plutôt que recall mensonger.
      if (dimMismatch(qv, idx)) {
        writeHealth(healthRecord(false, latency, idx.model, new Date().toISOString(),
          `dim mismatch: index=${idx.dim} requête=${qv.length} (modèle serveur ≠ index → reindex requis)`));
        process.exit(0);
      }
      writeHealth(healthRecord(true, latency, idx.model, new Date().toISOString(), null));

      const hits = searchDedup(qv, idx.items, K, MIN_SCORE);
      const { toInject, toRecall } = partitionByTier(hits, state);

      // Lire les corps des tier-0 à injecter + marquer injectés.
      let next = state;
      const injected = [];
      for (const h of toInject) {
        try { injected.push({ id: h.id, body: readBody(h.id) }); next = STATE.markInjected(next, h.id); }
        catch { /* corps illisible → on saute, pas d'injection fantôme */ }
      }
      if (injected.length) {
        try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(next)); }
        catch { /* ignore */ }
      }

      const out = [formatInjected(injected), formatRecall(toRecall)].filter(Boolean).join('\n');
      if (out) process.stdout.write(out + '\n');
    } catch (e) {
      writeHealth(healthRecord(false, null, null, new Date().toISOString(), e && e.message));
    }
    process.exit(0);
  });
}
// Stryker restore all
