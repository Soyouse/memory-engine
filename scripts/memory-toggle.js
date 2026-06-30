#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// memory-toggle.js — INTERrupteur du moteur mémoire (interface du kill-switch).
//   Actionne le fichier sentinelle `DISABLED` lu par paths.js (isDisabled).
//   Destiné à être appelé par une slash-command /memory off|on|status.
// ═══════════════════════════════════════════════════════════════════════
// ⚠️ Le MÉCANISME reste le fichier `DISABLED` (Ops Toggle, relu à chaque exec
//   de hook = hot). Ce script n'est QUE l'interface qui le crée/supprime.
// ⚠️ Action INCONNUE → 'status' (JAMAIS de bascule accidentelle).
// ⚠️ CROSS-OS : chemin résolu par paths.js (CLAUDE_PLUGIN_DATA en hook,
//   MEMORY_ENGINE_HOME / ~/.memory-engine en standalone). AUCUN chemin codé.
//   ⚠️ Limite plateforme : une slash-command de PLUGIN ne reçoit pas
//   ${CLAUDE_PLUGIN_ROOT}/${CLAUDE_PLUGIN_DATA} (bug claude-code #9354) → la
//   commande qui appelle ce script doit lui passer le bon data dir via env
//   (MEM_DATA_DIR/MEMORY_ENGINE_HOME) si l'hôte n'expose pas CLAUDE_PLUGIN_DATA.
// ═══════════════════════════════════════════════════════════════════════
'use strict';

// ── NOYAU PUR (mutable Stryker) ──
// Normalise l'argument utilisateur en action sûre. Inconnu → 'status'.
function normalizeAction(arg) {
  const a = String(arg == null ? '' : arg).trim().toLowerCase();
  if (a === 'off' || a === 'disable' || a === '0' || a === 'false') return 'off';
  if (a === 'on' || a === 'enable' || a === '1' || a === 'true') return 'on';
  return 'status';
}

// Message lisible à partir de l'action effectuée et de l'état résultant.
function report(action, disabled) {
  if (action === 'off') return '🧠 Mémoire DÉSACTIVÉE (fichier DISABLED créé). Effet dès le prochain message.';
  if (action === 'on') return '🧠 Mémoire RÉACTIVÉE (fichier DISABLED supprimé). Effet dès le prochain message.';
  return disabled ? '🧠 État : DÉSACTIVÉE (fichier DISABLED présent).' : '🧠 État : active.';
}

module.exports = { normalizeAction, report };

// ── COQUILLE I/O (exclue mutation) ──
// Stryker disable all
const fs = require('fs');
const PATHS = require('./paths.js');

function apply(action) {
  const flag = PATHS.disabledFlagPath();
  if (action === 'off') {
    try { fs.mkdirSync(PATHS.dataDir(), { recursive: true }); } catch (e) { /* existe */ }
    try { fs.writeFileSync(flag, 'OFF manuel via /memory\n'); } catch (e) { /* fail-open */ }
  } else if (action === 'on') {
    try { fs.unlinkSync(flag); } catch (e) { /* déjà absent */ }
  }
  let disabled = false;
  try { disabled = fs.existsSync(flag); } catch (e) { disabled = false; }
  return report(action, disabled);
}

if (require.main === module) {
  const action = normalizeAction(process.argv[2]);
  process.stdout.write(apply(action) + '\n');
}
// Stryker restore all
