#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// memory-bump.js — COQUILLE I/O : incrémente la génération de contexte
//   d'UNE session à chaque compaction. Cœur de la détection compaction-proof.
// ═══════════════════════════════════════════════════════════════════════
//
// DÉTECTION DOUBLE (redondante, anti-trou) — câblée sur 2 events dans
//   settings.json : `PreCompact` ET `SessionStart`. shouldBump() ne déclenche
//   QUE sur une vraie compaction :
//     - PreCompact (tout trigger : manual ET auto)
//     - SessionStart avec source === 'compact' (filet si PreCompact rate)
//   ⚠️ SessionStart source=startup|resume|clear → JAMAIS bump (pas une compaction).
//
// POURQUOI double : un hook NE VOIT PAS le contexte → impossible de vérifier
//   par observation si une mémoire est encore présente. On DOIT capter
//   l'événement. Un seul signal = trou si ce signal rate. Deux signaux
//   redondants = filet. La génération n'a qu'à CHANGER (pas valoir une valeur
//   précise) → double bump dans une même compaction = inoffensif (idempotent
//   au sens "tout devient à réinjecter"). Cf [[project_memory_system_v2]].
//
// ⚠️ FAIL-OPEN : toute erreur (stdin vide, JSON cassé, FS) → exit 0 SILENCIEUX.
//   Un hook qui plante NE DOIT JAMAIS bloquer la session de Théo.
// ⚠️ Logique pure (shouldBump) exportée + MUTÉE. I/O = exclu mutation.
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');
const S = require('./memory-state.js');

// ── NOYAU PUR (mutable Stryker) ──
// Décide si ce payload de hook correspond à une compaction → bump requis.
function shouldBump(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const event = p.hook_event_name;
  if (event === 'PreCompact') return true;               // manual + auto
  if (event === 'SessionStart' && p.source === 'compact') return true; // filet
  return false;
}

// Chemin du fichier d'état PAR SESSION (isolé → multi-session safe).
function stateFileFor(sessionId, dir) {
  const safe = typeof sessionId === 'string' && sessionId ? sessionId : 'unknown';
  return path.join(dir, `mem-state-${safe}.json`);
}

module.exports = { shouldBump, stateFileFor };

// ── COQUILLE I/O (exclue mutation) ──
// Stryker disable all
if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try {
      const payload = JSON.parse(raw || '{}');
      if (!shouldBump(payload)) { process.exit(0); }

      const dir = require('./paths.js').stateDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = stateFileFor(payload.session_id, dir);

      let state;
      try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch { state = S.initialState(); }

      const next = S.bumpGeneration(state);
      fs.writeFileSync(file, JSON.stringify(next));
    } catch {
      // fail-open : on ne bloque jamais
    }
    process.exit(0);
  });
  // stdin jamais fermé (edge) → ne pas pendre
  process.stdin.on('error', () => process.exit(0));
}
