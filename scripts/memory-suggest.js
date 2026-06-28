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

// Résumé USER-ONLY (systemMessage) : transparence des mémoires de ce tour.
//   MESURÉ 2026-06-28 : systemMessage s'affiche chez l'utilisateur SANS entrer
//   dans le contexte du modèle (≠ additionalContext) → zéro pollution agent.
//   🧠 injecté = tier-0 corps entré ce tour · 💡 rappel = tier-1 + tier-0 déjà vus (⁰).
//   '' si rien (pas de systemMessage émis).
function formatSystemMessage(injected, toRecall) {
  const inj = (Array.isArray(injected) ? injected : []).filter(Boolean);
  const rec = (Array.isArray(toRecall) ? toRecall : []).filter(Boolean);
  const segs = [];
  if (inj.length) segs.push('🧠 injecté: ' + inj.map((it) => it.id).join(', '));
  if (rec.length) segs.push('💡 rappel: ' + rec.map((h) => h.id + (h.tier === 0 ? '⁰' : '')).join(', '));
  return segs.join('  ·  ');
}

// Statut TRI-ÉTAT (lu par la statusline) à partir du résultat d'embed + sonde
//   /health du serveur : embed OK → 'ok' ; serveur joignable mais modèle en
//   cours de chargement (HTTP 503) → 'booting' ; injoignable → 'down'.
//   L'état 'booting' évite un faux « DOWN » alarmant pendant le démarrage.
function statusFrom(embedOk, probe) {
  if (embedOk) return 'ok';
  if (probe === 'loading') return 'booting';
  return 'down';
}

// Enregistrement de santé (lu par la statusline). `status` optionnel : sinon
//   dérivé de `ok` (rétro-compat). `ok` reste booléen (lecteurs historiques).
function healthRecord(ok, latencyMs, model, isoNow, error, status) {
  return {
    ok: !!ok,
    status: status || (ok ? 'ok' : 'down'),
    latencyMs: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
    model: model || null,
    ts: isoNow,
    error: error ? String(error).slice(0, 200) : null,
  };
}

module.exports = {
  partitionByTier, formatRecall, formatInjected, formatSystemMessage, healthRecord, statusFrom,
  K, RECALL_MAX, MIN_SCORE, INJECT_MAX_CHARS,
};

// ── COQUILLE I/O (exclue mutation) ──
// Stryker disable all
const { spawn } = require('child_process');
const INC = require('./incident-log.js');
const INCIDENTS = PATHS.incidentsPath();
const EMBED_HOST = process.env.MEM_EMBED_HOST || '127.0.0.1';
const EMBED_PORT = process.env.MEM_EMBED_PORT || '8181';

// Journalise un incident d'observabilité (down/booting/dim_mismatch/recovered).
//   fail-open total : ne casse JAMAIS le hook. ts stampé ici (hors noyau pur).
function logIncident(rec) {
  try { INC.appendIncident(INCIDENTS, { ...rec, ts: new Date().toISOString() }); }
  catch { /* un journal ne casse jamais le prompt */ }
}

function readBody(id) {
  const raw = fs.readFileSync(path.join(MEM_DIR, id + '.md'), 'utf8');
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  return (m ? m[1] : raw).trim();
}

// Sonde /health pour distinguer 'booting' (503 modèle en cours) de 'down'
//   (injoignable). llama-server répond 503 tant que le modèle charge.
async function probeServer() {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1000);
    const r = await fetch(`http://${EMBED_HOST}:${EMBED_PORT}/health`, { signal: c.signal });
    clearTimeout(t);
    if (r.ok) return 'ok';
    if (r.status === 503) return 'loading';
    return 'down';
  } catch { return 'down'; }
}

// Résilience anti-crash : si le serveur est injoignable (vrai crash CRT — PAS
//   un sleep idle, où le process reste vivant et /health répond), relance le
//   daemon en process détaché (idempotent, non-bloquant). Remplace le keepalive.
function relaunchDaemon() {
  try {
    const child = spawn(process.execPath, [path.join(__dirname, 'bootstrap.js'), '--fetch'],
      { detached: true, stdio: 'ignore' });
    child.unref();
  } catch { /* fail-open */ }
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
    // État de santé PRÉCÉDENT (avant écrasement) → log d'incident PAR TRANSITION
    //   (anti-spam SSD) : on n'écrit que si l'état change vs le prompt d'avant.
    let prevOk = null, prevStatus = null;
    try {
      const h = JSON.parse(fs.readFileSync(HEALTH, 'utf8'));
      prevOk = h.ok; prevStatus = h.status || (h.ok ? 'ok' : 'down');
    } catch { /* pas encore de santé */ }
    let sessionId = 'unknown';
    try {
      const payload = JSON.parse(raw || '{}');
      const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
      sessionId = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : 'unknown';
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
        const msg = `dim mismatch: index=${idx.dim} requête=${qv.length} (modèle serveur ≠ index → reindex requis)`;
        writeHealth(healthRecord(false, latency, idx.model, new Date().toISOString(), msg));
        if (INC.shouldLogTransition(prevStatus, 'down')) {
          logIncident({ kind: 'dim_mismatch', status: 'down', latencyMs: latency, error: msg, session: sessionId });
        }
        process.exit(0);
      }
      writeHealth(healthRecord(true, latency, idx.model, new Date().toISOString(), null));
      // Retour à ok après un incident → clôt l'incident dans le journal.
      if (INC.recoveryKind(prevOk, true)) {
        logIncident({ kind: 'recovered', status: 'ok', latencyMs: latency, session: sessionId });
      }

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
      if (out) {
        // additionalContext = injection (modèle) ; systemMessage = transparence (user-only).
        const payload = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: out } };
        const sys = formatSystemMessage(injected, toRecall);
        if (sys) payload.systemMessage = sys;
        process.stdout.write(JSON.stringify(payload));
      }
    } catch (e) {
      // Embed a échoué : sonde le serveur pour distinguer démarrage vs panne.
      //   'booting' (modèle en cours) → statusline « démarrage », pas « DOWN ».
      //   'down' (injoignable) → relance le daemon (réveil après idle-kill).
      let probe = 'down';
      try { probe = await probeServer(); } catch { /* down */ }
      const relaunched = probe === 'down';
      if (relaunched) relaunchDaemon();
      const status = statusFrom(false, probe);
      writeHealth(healthRecord(false, null, null, new Date().toISOString(), e && e.message, status));
      // Trace l'incident SEULEMENT sur transition (anti-spam) : distingue reload
      //   (booting) d'un vrai crash (down+relance). down persistant = 1 ligne.
      if (INC.shouldLogTransition(prevStatus, status)) {
        logIncident({ kind: status, status, probe, relaunched, error: e && e.message, session: sessionId });
      }
    }
    process.exit(0);
  });
}
// Stryker restore all
