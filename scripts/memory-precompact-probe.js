#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// Hook PreCompact — SONDE (validation empirique)
// ═══════════════════════════════════════════════════════════════════════
//
// FONCTION : logge chaque déclenchement de PreCompact pour PROUVER
//   empiriquement qu'il fire sur l'AUTO-compaction (trigger="auto"), pas
//   seulement sur /compact manuel (trigger="manual"). Fondation du tier-0
//   force-inject (cf [[project_memory_system_v2]]) : si PreCompact ne fire
//   pas sur l'auto-compaction, tout le mécanisme génération doit changer.
//
// SORTIE : append une ligne dans hooks/state/precompact-probe.log
//   format : <ISO> trigger=<auto|manual> session=<id>
//
// ⚠️ exit 0 TOUJOURS — ne JAMAIS bloquer une compaction. Fail-open total.
// ⚠️ Sonde temporaire : à retirer une fois la fiabilité PreCompact prouvée.
// ⚠️ 1 hook = 1 fichier (convention .claude/hooks/).
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

// ── Noyau pur (testable + mutable) : formate la ligne de log ──
function formatProbeLine(data, isoNow) {
  const trigger = (data && data.trigger) || 'unknown';
  const session = (data && data.session_id) || 'unknown';
  return `${isoNow} trigger=${trigger} session=${session}`;
}

// ── Coquille I/O (exclue mutation) ──
// Stryker disable all
function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => (input += c));
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(input || '{}');
      const stateDir = process.env.PROBE_STATE_DIR || require('./paths.js').stateDir();
      fs.mkdirSync(stateDir, { recursive: true });
      const line = formatProbeLine(data, new Date().toISOString());
      fs.appendFileSync(path.join(stateDir, 'precompact-probe.log'), line + '\n');
    } catch (e) {
      // fail-open : jamais bloquer une compaction
    }
    process.exit(0);
  });
}

// Export pour les tests ; exécute seulement si lancé directement.
if (require.main === module) main();
module.exports = { formatProbeLine };
