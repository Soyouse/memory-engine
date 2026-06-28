'use strict';
// ═══════════════════════════════════════════════════════════════════════
// proc-tree.js — Identifie le PROCESS Claude Code d'une session via l'OS.
//   Les hooks tournent dans un node éphémère (parent = bash jetable) ; en
//   REMONTANT la chaîne de process on trouve le `claude`(.exe) STABLE qui vit
//   toute la session. Son PID = signal de liveness 100% fiable (vérité OS),
//   indépendant des hooks de fermeture (SessionEnd est cassé — vérifié 2026-06-28).
//   Cf [[project_memory_false_down_reload]].
// ═══════════════════════════════════════════════════════════════════════
// ⚠️ Noyau PUR (pickClaudePid) exporté + muté ; I/O (wmic/ps/tasklist) exclu.

const { spawnSync } = require('child_process');

// Stryker disable all : config déclarative.
//   Nom EXACT (ancré) — `claude.exe` (Windows) / `claude` (Unix), constaté au diag.
//   Ancré pour éviter les faux positifs (« clauder-fake » ne doit PAS matcher).
const CLAUDE_RX = /^claude(\.exe)?$/i;
const MAX_DEPTH = 8;               // profondeur max de remontée (claude vu à ~3, marge large).
// Stryker restore all

// ── NOYAU PUR (mutable Stryker) ──

// Dans une chaîne d'ascendance [{pid,name}], le PID du 1er process nommé « claude ».
//   0 si aucun (jamais un faux positif : on exige le nom).
function pickClaudePid(chain) {
  for (const e of (Array.isArray(chain) ? chain : [])) {
    if (e && CLAUDE_RX.test(String(e.name || '')) && Number.isInteger(e.pid) && e.pid > 0) {
      return e.pid;
    }
  }
  return 0;
}

module.exports = { pickClaudePid, CLAUDE_RX, MAX_DEPTH };

// ── COQUILLE I/O (exclue mutation) — dépend de l'OS ──
// Stryker disable all
const isWin = process.platform === 'win32';

// Nom du process `pid` ('' si mort/inconnu).
function procName(pid) {
  try {
    if (isWin) {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
      const m = /^"([^"]+)"/.exec((r.stdout || '').trim());
      return m ? m[1] : '';
    }
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
    return (r.stdout || '').trim();
  } catch { return ''; }
}

// PID parent de `pid` (0 si inconnu).
function parentOf(pid) {
  try {
    if (isWin) {
      const r = spawnSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'ParentProcessId', '/format:value'], { encoding: 'utf8' });
      const m = /ParentProcessId=(\d+)/.exec(r.stdout || '');
      return m ? Number(m[1]) : 0;
    }
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8' });
    const n = parseInt((r.stdout || '').trim(), 10);
    return Number.isInteger(n) ? n : 0;
  } catch { return 0; }
}

// Chaîne d'ascendance de `startPid` : [{pid,name}] du parent vers le haut.
function ancestry(startPid, maxDepth) {
  const out = [];
  let cur = startPid;
  const depth = maxDepth > 0 ? maxDepth : MAX_DEPTH;
  for (let i = 0; i < depth; i++) {
    const par = parentOf(cur);
    if (!par || par === cur) break;
    out.push({ pid: par, name: procName(par) });
    cur = par;
  }
  return out;
}

// PID du process `claude` de la session courante (remonte depuis ce process node).
//   0 si introuvable (ex : hook lancé hors d'une vraie session).
function claudePid(startPid) {
  return pickClaudePid(ancestry(Number.isInteger(startPid) ? startPid : process.pid, MAX_DEPTH));
}

// Le process `pid` est-il un Claude VIVANT ? (existe ET nommé claude → anti PID réutilisé).
function isClaudeAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return CLAUDE_RX.test(procName(pid));
}

module.exports.procName = procName;
module.exports.parentOf = parentOf;
module.exports.ancestry = ancestry;
module.exports.claudePid = claudePid;
module.exports.isClaudeAlive = isClaudeAlive;
// Stryker restore all
