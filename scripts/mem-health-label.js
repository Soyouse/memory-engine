#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// mem-health-label.js — NOYAU PUR. Décide le segment santé mémoire 🧠 d'une
//   statusline à partir de 2 entrées : le kill-switch (fichier DISABLED) et
//   la santé du moteur (mem-health.json). Zéro I/O — helper réutilisable par
//   l'hôte qui câble sa statusline (le plugin ne rend pas de statusline).
// ═══════════════════════════════════════════════════════════════════════
// ⚠️ disabled PRIME sur TOUT : kill-switch manuel = OFF VOULU, pas une panne.
//   Quand OFF, memory-suggest sort avant d'écrire la santé → mem-health.json
//   est PÉRIMÉ. Ne JAMAIS l'afficher dans ce cas (ok/DOWN seraient un mensonge).
// ⚠️ Quad-état : désactivé > ok > démarrage > DOWN. `booting` (503) ≠ down.
//   Rétro-compat : `status` absent → dérivé du booléen `ok`.
// ═══════════════════════════════════════════════════════════════════════
'use strict';

function memHealthLabel(disabled, health) {
  if (disabled) return '🧠 désactivé';
  if (!health || typeof health !== 'object') return null;
  const st = health.status || (health.ok ? 'ok' : 'down');
  if (st === 'ok') return '🧠 ok';
  if (st === 'booting') return '🧠… démarrage';
  return '🧠⚠️ DOWN';
}

module.exports = { memHealthLabel };
