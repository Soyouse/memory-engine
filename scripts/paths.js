'use strict';
// ═══════════════════════════════════════════════════════════════════════
// paths.js — Résolution CENTRALISÉE des chemins runtime (portabilité plugin).
// ═══════════════════════════════════════════════════════════════════════
// ⚠️ Les données runtime (index, état, santé, modèle GGUF) vont TOUJOURS dans
//   le dossier de DONNÉES persistant, JAMAIS dans ${CLAUDE_PLUGIN_ROOT} (la
//   racine du code est effacée/recréée à CHAQUE update du plugin → perte).
// Ordre de résolution :
//   1) ${CLAUDE_PLUGIN_DATA}  — fourni par Claude Code (~/.claude/plugins/data/<id>/).
//   2) ${MEMORY_ENGINE_HOME}  — override explicite (dev/standalone hors plugin).
//   3) ~/.memory-engine       — défaut raisonnable hors plugin.
// Les env spécifiques (MEM_INDEX/MEM_HEALTH/MEM_STATE_DIR/MEMORY_DIR) gardent
//   la priorité absolue (utilisés par les tests + tuning fin).
// Pur côté logique ; lit l'env à l'appel (comme avant). Config → exclu mutation.
// Stryker disable all
const path = require('path');
const os = require('os');

function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA
    || process.env.MEMORY_ENGINE_HOME
    || path.join(os.homedir(), '.memory-engine');
}

const indexPath = () => process.env.MEM_INDEX || path.join(dataDir(), 'embeddings.json');
const healthPath = () => process.env.MEM_HEALTH || path.join(dataDir(), 'mem-health.json');
const stateDir = () => process.env.MEM_STATE_DIR || path.join(dataDir(), 'state');
const memoryDir = () => process.env.MEMORY_DIR || path.join(dataDir(), 'memory');
// Runtime du moteur d'inférence (bootstrap) — binaire, modèles, profil actif, log.
const profilePath = () => path.join(dataDir(), 'profile.json');
const binDir = () => path.join(dataDir(), 'bin');
const modelsDir = () => path.join(dataDir(), 'models');
const serverLog = () => path.join(dataDir(), 'server.log');
// Lifecycle du daemon (lease/watchdog) — cf lease.js + watchdog.js.
const serverPid = () => path.join(dataDir(), 'server.pid');
const watchdogLock = () => path.join(dataDir(), 'watchdog.pid');

module.exports = { dataDir, indexPath, healthPath, stateDir, memoryDir, profilePath, binDir, modelsDir, serverLog, serverPid, watchdogLock };
// Stryker restore all
