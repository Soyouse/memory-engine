#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════════════
// watchdog.js — LIBÈRE le GPU quand plus aucune session n'est vivante.
// ═══════════════════════════════════════════════════════════════════════
// Process DÉTACHÉ lancé par bootstrap en même temps que le daemon. Boucle
//   toutes les POLL_MS : purge les leases périmés, et si 0 lease vivant →
//   tue le daemon d'inférence (libère le GPU) puis s'auto-termine. C'est le
//   filet ROBUSTE de l'extinction : indépendant de SessionEnd (qui peut ne
//   jamais fire). Cf [[project_memory_system_v2]] + lease.js.
//
// ⚠️ SINGLETON : un seul watchdog à la fois (lock pid). bootstrap vérifie le
//   lock avant de spawn. Deux watchdogs = double-kill bénin mais inutile.
// ⚠️ Si le daemon est déjà mort (pid absent/inactif) → le watchdog s'arrête
//   (rien à garder). Pas d'orphelin qui tourne dans le vide.
// ⚠️ Noyau PUR (parsePid/decideAction) exporté + muté ; I/O exclu.
// ═══════════════════════════════════════════════════════════════════════

const lease = require('./lease.js');
const PATHS = require('./paths.js');

// ── NOYAU PUR (mutable Stryker) ──

// Lit un pid depuis le contenu d'un fichier. Invalide → null.
function parsePid(text) {
  const n = parseInt(String(text == null ? '' : text).trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Décision à chaque tick :
//   - daemon déjà mort        → 'exit'     (plus rien à garder)
//   - daemon vivant, 0 lease  → 'kill'     (libérer le GPU puis sortir)
//   - daemon vivant, ≥1 lease → 'continue' (usage en cours)
function decideAction(liveCount, serverAlive) {
  if (!serverAlive) return 'exit';
  if (liveCount === 0) return 'kill';
  return 'continue';
}

module.exports = { parsePid, decideAction };

// ── COQUILLE I/O (exclue mutation) ──
// Stryker disable all
const fs = require('fs');
const { spawnSync } = require('child_process');

const POLL_MS = Number(process.env.MEMORY_ENGINE_POLL_MS) || 60 * 1000; // 60 s

function readServerPid() {
  try { return parsePid(fs.readFileSync(PATHS.serverPid(), 'utf8')); } catch { return null; }
}

// Le pid est-il un process vivant ? signal 0 = test d'existence (cross-OS).
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

// Tue le daemon. SIGTERM d'abord ; Windows = taskkill /F en renfort.
function killServer(pid) {
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* déjà mort */ }
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
}

function cleanup() {
  for (const f of [PATHS.serverPid(), PATHS.watchdogLock()]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

function tick() {
  try {
    const now = Date.now();
    lease.purgeStale(now);
    const action = decideAction(lease.liveLeaseCount(now), pidAlive(readServerPid()));
    if (action === 'continue') return;
    if (action === 'kill') killServer(readServerPid());
    cleanup();
    process.exit(0);
  } catch {
    // fail-open : un tick qui plante ne doit pas tuer le watchdog (il retentera).
  }
}

if (require.main === module) {
  // Écrit son lock (singleton) — bootstrap a déjà vérifié l'absence d'un vivant.
  try {
    fs.mkdirSync(PATHS.dataDir(), { recursive: true });
    fs.writeFileSync(PATHS.watchdogLock(), String(process.pid));
  } catch { /* ignore */ }
  // ⚠️ Timer NON-unref'd VOLONTAIREMENT : c'est lui (et lui seul) qui maintient
  //   l'event loop — donc le process — vivant entre deux ticks. Le unref'er +
  //   stdin.resume() ne marche PAS : bootstrap lance ce watchdog détaché avec
  //   stdio:'ignore', donc stdin émet 'end' aussitôt et ne garde rien → l'event
  //   loop se vide et le watchdog meurt juste après avoir écrit son lock.
  //   NE JAMAIS unref ce timer. Un daemon de poll DOIT rester ref'd.
  setInterval(tick, POLL_MS);
}
// Stryker restore all
