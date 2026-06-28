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
const fs = require('fs'); // ⚠️ requis par isDisabled() (existsSync du fichier sentinelle).

function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA
    || process.env.MEMORY_ENGINE_HOME
    || path.join(os.homedir(), '.memory-engine');
}

const indexPath = () => process.env.MEM_INDEX || path.join(dataDir(), 'embeddings.json');
const healthPath = () => process.env.MEM_HEALTH || path.join(dataDir(), 'mem-health.json');
const incidentsPath = () => process.env.MEM_INCIDENTS || path.join(dataDir(), 'incidents.log');
const stateDir = () => process.env.MEM_STATE_DIR || path.join(dataDir(), 'state');
const memoryDir = () => process.env.MEMORY_DIR || path.join(dataDir(), 'memory');
// Runtime du moteur d'inférence (bootstrap) — binaire, modèles, profil actif, log.
const profilePath = () => path.join(dataDir(), 'profile.json');
const binDir = () => path.join(dataDir(), 'bin');
const modelsDir = () => path.join(dataDir(), 'models');
const serverLog = () => path.join(dataDir(), 'server.log');
// Cycle de vie EVENT-DRIVEN du serveur : 1 lease/session Claude (leasesDir),
//   PID du daemon (serverPid) pour l'arrêt quand la dernière session se ferme.
const leasesDir = () => path.join(dataDir(), 'leases');
const serverPidPath = () => path.join(dataDir(), 'server.pid');
const watchdogPidPath = () => path.join(dataDir(), 'watchdog.pid');

// ── KILL-SWITCH À CHAUD (fichier sentinelle, relu à CHAQUE exec de hook) ──
// ⚠️ PAS une env var : Windows fige l'env au lancement de Claude → invisible aux
//   hooks sans restart. Un FICHIER est relu à chaque process hook = vrai hot.
//   Présence du fichier `DISABLED` → moteur OFF (chaque entrypoint exit 0 d'emblée :
//   zéro injection, zéro serveur, zéro indexation). Le supprimer rallume à chaud.
const disabledFlagPath = () => path.join(dataDir(), 'DISABLED');
const isDisabled = () => { try { return fs.existsSync(disabledFlagPath()); } catch { return false; } };

module.exports = { dataDir, indexPath, healthPath, incidentsPath, stateDir, memoryDir, profilePath, binDir, modelsDir, serverLog, leasesDir, serverPidPath, watchdogPidPath, disabledFlagPath, isDisabled };
// Stryker restore all
