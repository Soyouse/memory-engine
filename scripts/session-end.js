#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════════════
// session-end.js — Retire le lease à la fermeture d'une session (SessionEnd).
// ═══════════════════════════════════════════════════════════════════════
// Si c'était la DERNIÈRE session → tue le daemon tout de suite (libération
//   GPU immédiate, sans attendre l'idle-timeout du watchdog). Le watchdog
//   reste le filet pour les fermetures qui ne firent PAS SessionEnd (crash,
//   kill -9). Cf [[project_memory_system_v2]] + lease.js + watchdog.js.
//
// ⚠️ fail-open : SessionEnd ne doit jamais planter la fermeture. exit 0.
// ⚠️ Ne tue QUE si 0 lease vivant restant (d'autres sessions // tiennent le GPU).
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const { spawnSync } = require('child_process');
const lease = require('./lease.js');
const PATHS = require('./paths.js');

function killServer(pid) {
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* déjà mort */ }
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
}

function shutdownIfLast() {
  // Encore des sessions vivantes → ne rien tuer.
  if (lease.liveLeaseCount(Date.now()) > 0) return;
  let pid = null;
  try { pid = parseInt(String(fs.readFileSync(PATHS.serverPid(), 'utf8')).trim(), 10); } catch { /* pas de pid */ }
  killServer(Number.isInteger(pid) && pid > 0 ? pid : null);
  for (const f of [PATHS.serverPid(), PATHS.watchdogLock()]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

if (require.main === module) {
  let raw = '';
  const done = () => {
    try {
      const p = JSON.parse(raw || '{}');
      lease.remove(p && p.session_id);
      shutdownIfLast();
    } catch { /* fail-open */ }
    process.exit(0);
  };
  try {
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  } catch { done(); }
  setTimeout(done, 1500);
}
