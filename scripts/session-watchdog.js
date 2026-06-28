#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════════════
// session-watchdog.js — VEILLEUR du cycle de vie serveur (process détaché singleton).
//   Lancé par session-leases.js au 1er SessionStart. Poll les leases ; dès qu'AUCUN
//   process `claude` n'est vivant → arrête le serveur d'embeddings et se termine.
//   = SEUL moyen FIABLE de détecter « dernière session fermée » (SessionEnd est
//   cassé) sans timer aveugle. Cf [[project_memory_false_down_reload]].
// ═══════════════════════════════════════════════════════════════════════
// ⚠️ SINGLETON : un seul à la fois (lockfile watchdog.pid). Concurrent → exit.
// ⚠️ fail-open : une erreur de comptage NE tue PAS le serveur (on suppose vivant).
// ⚠️ Pas de pur à muter : pure orchestration I/O. La DÉCISION (shouldStop) et le
//   refcount (aliveCount/stopServer) sont dans session-leases.js (testés).
// ═══════════════════════════════════════════════════════════════════════

// Stryker disable all
const fs = require('fs');
const PATHS = require('./paths.js');
const LEASES = require('./session-leases.js');

const POLL_MS = Number(process.env.MEMORY_ENGINE_WATCH_MS) || 60000; // 60 s par défaut.

// Acquiert le verrou singleton. False si un autre watchdog vit déjà.
function acquireLock() {
  if (LEASES.watchdogAlive()) return false;
  try {
    fs.mkdirSync(PATHS.dataDir(), { recursive: true });
    fs.writeFileSync(PATHS.watchdogPidPath(), String(process.pid));
    return true;
  } catch { return false; }
}

function releaseLock() { try { fs.unlinkSync(PATHS.watchdogPidPath()); } catch { /* ignore */ } }

async function tick() {
  let alive;
  try { alive = LEASES.aliveCount(); }
  catch { return; } // erreur de lecture → NE PAS tuer (on suppose des sessions vivantes).
  if (!LEASES.shouldStop(alive)) return; // ≥1 session vivante → on continue à veiller.
  // Plus aucune session Claude → arrêter le serveur (VRAM rendue) et se retirer.
  try { await LEASES.stopServer(); } catch { /* ignore */ }
  releaseLock();
  process.exit(0);
}

if (require.main === module) {
  if (!acquireLock()) process.exit(0);
  const timer = setInterval(() => { Promise.resolve(tick()).catch(() => {}); }, POLL_MS);
  // NE PAS unref : le watchdog DOIT rester vivant tant que des sessions existent.
  void timer;
  const bye = () => { releaseLock(); process.exit(0); };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}
// Stryker restore all
