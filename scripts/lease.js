'use strict';
// ═══════════════════════════════════════════════════════════════════════
// lease.js — REFCOUNT de sessions vivantes (lifecycle du daemon GPU).
// ═══════════════════════════════════════════════════════════════════════
// RÔLE : le daemon d'inférence tient le GPU. Il ne doit tourner QUE pendant
//   l'usage réel. Chaque session Claude Code pose un « lease » (fichier mtime)
//   rafraîchi à chaque prompt. Quand plus AUCUN lease n'est frais → le watchdog
//   éteint le daemon et libère le GPU. Pattern « daemon partagé » standard
//   (Gradle daemon, language server) : refcount + idle-timeout. Cf
//   [[project_memory_system_v2]].
//
// ⚠️ Idle-timeout = filet ROBUSTE : un lease expire tout seul (mtime périmé)
//   même si SessionEnd ne fire jamais (crash, kill -9, reboot du shell). Ne
//   JAMAIS dépendre uniquement de SessionEnd pour libérer le GPU.
// ⚠️ Noyau PUR (fraîcheur/comptage) exporté + muté ; I/O (fichiers) exclu.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const PATHS = require('./paths.js');

// ── NOYAU PUR (mutable Stryker) ──

// Normalise un session_id en nom de fichier sûr (uuid attendu, mais on blinde).
function sanitizeId(id) {
  const s = (typeof id === 'string' && id) ? id : 'unknown';
  return s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
}

// Un lease est frais si son mtime est dans la fenêtre d'inactivité tolérée.
//   nowMs/mtimeMs en ms. mtime non fini → JAMAIS frais (fail-safe : on préfère
//   éteindre à tort — relance au prochain prompt — que squatter le GPU à vie).
function isFresh(mtimeMs, nowMs, idleMs) {
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(nowMs) || !Number.isFinite(idleMs)) return false;
  return (nowMs - mtimeMs) <= idleMs;
}

// entries = [{ name, mtimeMs }]. Nombre de leases encore vivants.
function liveCount(entries, nowMs, idleMs) {
  if (!Array.isArray(entries)) return 0;
  return entries.filter((e) => e && isFresh(e.mtimeMs, nowMs, idleMs)).length;
}

// Noms des leases périmés (à supprimer par le watchdog).
function staleNames(entries, nowMs, idleMs) {
  if (!Array.isArray(entries)) return [];
  return entries.filter((e) => e && !isFresh(e.mtimeMs, nowMs, idleMs)).map((e) => e.name);
}

module.exports = { sanitizeId, isFresh, liveCount, staleNames };

// ── COQUILLE I/O (exclue mutation) ──
// Stryker disable all
const IDLE_MS = Number(process.env.MEMORY_ENGINE_IDLE_MS) || 20 * 60 * 1000; // 20 min

const leasesDir = () => path.join(PATHS.dataDir(), 'leases');
const leaseFile = (sessionId) => path.join(leasesDir(), sanitizeId(sessionId) + '.lease');

// Pose/rafraîchit le lease de la session (SessionStart + chaque UserPromptSubmit).
function touch(sessionId) {
  try {
    const dir = leasesDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(leaseFile(sessionId), String(process.pid));
  } catch { /* fail-open : l'idle-timeout reste le filet */ }
}

// Retire le lease (SessionEnd).
function remove(sessionId) {
  try { fs.unlinkSync(leaseFile(sessionId)); } catch { /* déjà absent */ }
}

// [{ name, mtimeMs }] pour tous les leases sur disque.
function readEntries() {
  let names = [];
  try { names = fs.readdirSync(leasesDir()); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.lease')) continue;
    try { out.push({ name, mtimeMs: fs.statSync(path.join(leasesDir(), name)).mtimeMs }); }
    catch { /* disparu entre readdir et stat */ }
  }
  return out;
}

// Combien de sessions encore vivantes (lu par le watchdog + SessionEnd).
function liveLeaseCount(nowMs) {
  return liveCount(readEntries(), nowMs, IDLE_MS);
}

// Supprime les leases périmés sur disque (appelé par le watchdog).
function purgeStale(nowMs) {
  for (const name of staleNames(readEntries(), nowMs, IDLE_MS)) {
    try { fs.unlinkSync(path.join(leasesDir(), name)); } catch { /* ignore */ }
  }
}

module.exports.IDLE_MS = IDLE_MS;
module.exports.leasesDir = leasesDir;
module.exports.leaseFile = leaseFile;
module.exports.touch = touch;
module.exports.remove = remove;
module.exports.readEntries = readEntries;
module.exports.liveLeaseCount = liveLeaseCount;
module.exports.purgeStale = purgeStale;
// Stryker restore all
