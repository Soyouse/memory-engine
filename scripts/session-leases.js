#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════════════
// session-leases.js — REFCOUNT de sessions par LIVENESS OS (le « top du top »).
//   Cf [[project_memory_false_down_reload]] / [[project_memory_system_v2]].
// ═══════════════════════════════════════════════════════════════════════
//
// PRINCIPE (fiable, vérifié 2026-06-28) :
//   - SessionStart (`--start`) → trouve le PID du process `claude` de la session
//     (proc-tree, remontée d'ascendance) et l'écrit dans `leases/<session_id>`.
//     Lance le watchdog (singleton) qui veille à l'arrêt.
//   - SessionEnd  (`--end`)   → BEST-EFFORT : retire la lease + si plus aucun
//     `claude` vivant → arrête le serveur tout de suite. ⚠️ SessionEnd est CASSÉ
//     (ne fire pas sur /exit, /clear, crash) → ce n'est qu'un raccourci ; la
//     garantie vient du WATCHDOG qui détecte la mort des PID `claude` (vérité OS).
//   - « Session vivante » = son PID `claude` existe ENCORE (indépendant des hooks
//     et de l'activité) → modèle chaud tant qu'UNE fenêtre Claude est ouverte,
//     arrêté DÈS la dernière fermeture, robuste au crash. AUCUN timer aveugle.
//
// ⚠️ fail-open ABSOLU : toute erreur → exit 0. Un hook ne casse JAMAIS la session.
// ⚠️ Noyau PUR (sanitize/refcount) exporté + muté ; I/O (fs/kill/proc) exclu.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const PATHS = require('./paths.js');
const PROC = require('./proc-tree.js');

// Stryker disable all : config déclarative.
const HOST = process.env.MEM_EMBED_HOST || '127.0.0.1';
const PORT = process.env.MEM_EMBED_PORT || '8181';
// Stryker restore all

// ── NOYAU PUR (mutable Stryker) ──

// Nom de fichier sûr pour un session_id (UUID Claude). ⚠️ Anti path-traversal.
function sanitizeId(id) {
  const s = String(id == null ? '' : id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 200);
  return s || 'unknown';
}

// Combien de PID sont vivants (aliveFn injectée → testable sans OS).
function countAlive(pids, aliveFn) {
  if (!Array.isArray(pids) || typeof aliveFn !== 'function') return 0;
  let n = 0;
  for (const p of pids) if (aliveFn(p)) n++;
  return n;
}

// Parmi des entrées {file, pid}, celles dont le PID est MORT (lease à purger).
function deadEntries(entries, aliveFn) {
  if (!Array.isArray(entries) || typeof aliveFn !== 'function') return [];
  return entries.filter((e) => e && !aliveFn(e.pid));
}

// Faut-il arrêter le serveur ? OUI ssi plus AUCUNE session vivante.
function shouldStop(aliveCount) {
  return aliveCount === 0;
}

module.exports = { sanitizeId, countAlive, deadEntries, shouldStop };

// ── COQUILLE I/O (exclue mutation) ──
// Stryker disable all
function leasePath(id) { return path.join(PATHS.leasesDir(), sanitizeId(id)); }

// Lit toutes les leases : [{file, pid}] (pid = process claude écrit au --start).
function readLeases() {
  const dir = PATHS.leasesDir();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const file of names) {
    try { out.push({ file, pid: Number(fs.readFileSync(path.join(dir, file), 'utf8').trim()) }); }
    catch { /* disparue */ }
  }
  return out;
}

// Supprime les leases dont le process claude est mort (crash, /exit sans hook).
function purgeDead() {
  for (const e of deadEntries(readLeases(), PROC.isClaudeAlive)) {
    try { fs.unlinkSync(path.join(PATHS.leasesDir(), e.file)); } catch { /* ignore */ }
  }
}

// Nb de sessions VIVANTES (après purge des mortes).
function aliveCount() {
  purgeDead();
  return countAlive(readLeases().map((e) => e.pid), PROC.isClaudeAlive);
}

function addLease(sessionId, claudePid) {
  try {
    fs.mkdirSync(PATHS.leasesDir(), { recursive: true });
    fs.writeFileSync(leasePath(sessionId), String(claudePid));
  } catch { /* fail-open */ }
}

function removeLease(sessionId) {
  try { fs.unlinkSync(leasePath(sessionId)); } catch { /* déjà absente */ }
}

// Arrête le serveur — seulement s'il répond (anti PID réutilisé). Réutilisé par le watchdog.
async function stopServer() {
  let pid;
  try { pid = Number(fs.readFileSync(PATHS.serverPidPath(), 'utf8').trim()); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  let alive = false;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1000);
    const r = await fetch(`http://${HOST}:${PORT}/health`, { signal: c.signal });
    clearTimeout(t);
    alive = r.ok || r.status === 503;
  } catch { alive = false; }
  if (!alive) { try { fs.unlinkSync(PATHS.serverPidPath()); } catch { /* ignore */ } return false; }
  try { process.kill(pid, 'SIGTERM'); } catch { return false; }
  try { fs.unlinkSync(PATHS.serverPidPath()); } catch { /* ignore */ }
  return true;
}

// Le watchdog tourne-t-il déjà ? (lockfile + PID vivant).
function watchdogAlive() {
  let pid;
  try { pid = Number(fs.readFileSync(PATHS.watchdogPidPath(), 'utf8').trim()); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Lance le watchdog en process détaché s'il n'est pas déjà actif (idempotent, singleton).
function ensureWatchdog() {
  if (watchdogAlive()) return;
  try {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [path.join(__dirname, 'session-watchdog.js')], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch { /* fail-open */ }
}

async function run(mode, sessionId) {
  if (mode === '--start') {
    // PID du process claude de CETTE session (remontée d'ascendance depuis ce node).
    //   ⚠️ Détection ratée (cp=0) → on NE pose NI lease NI watchdog : dégradation
    //   SÛRE (serveur reste chaud, jamais tué par erreur ; suggest le relance au besoin).
    const cp = PROC.claudePid(process.pid);
    if (cp > 0) { addLease(sessionId, cp); ensureWatchdog(); }
    return;
  }
  // --end : retire ma lease (best-effort). ⚠️ NE TUE PAS le serveur ici : seul le
  //   WATCHDOG arrête (il n'existe qu'en régime établi → pas de kill intempestif
  //   pendant la transition où des sessions vivent sans lease encore posée). Il
  //   détecte 0 claude vivant en ≤ POLL_MS et arrête proprement.
  removeLease(sessionId);
}

// Exportés pour les tests d'INTÉGRATION (coquille I/O, exclue mutation).
module.exports.addLease = addLease;
module.exports.removeLease = removeLease;
module.exports.readLeases = readLeases;
module.exports.purgeDead = purgeDead;
module.exports.aliveCount = aliveCount;
module.exports.stopServer = stopServer;
module.exports.watchdogAlive = watchdogAlive;
module.exports.ensureWatchdog = ensureWatchdog;
module.exports.run = run;

if (require.main === module) {
  // KILL-SWITCH : moteur OFF (fichier sentinelle) → ni lease ni watchdog.
  if (PATHS.isDisabled()) process.exit(0);
  const mode = process.argv[2];
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    let sessionId = process.env.CLAUDE_CODE_SESSION_ID || 'unknown';
    try {
      const p = JSON.parse(raw || '{}');
      if (typeof p.session_id === 'string' && p.session_id) sessionId = p.session_id;
    } catch { /* stdin vide → env/unknown */ }
    Promise.resolve(run(mode, sessionId)).catch(() => {}).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 4000).unref();
}
// Stryker restore all
