// ═══════════════════════════════════════════════════════════════════════
// memory-state.js — NOYAU PUR du tier-0 (génération + ledger d'injection)
// ═══════════════════════════════════════════════════════════════════════
//
// RÔLE : décider, de façon compaction-proof, quelles mémoires force-inject
//   sont à (ré)injecter dans le contexte d'UNE session. Cf spec
//   [[project_memory_system_v2]].
//
// PRINCIPE anti-faux-positif : un compteur de "génération de contexte".
//   - À chaque compaction → bumpGeneration() (la génération change).
//   - Le ledger retient EN QUELLE GÉNÉRATION chaque mémoire a été injectée.
//   - needsReinject() = vrai si la mémoire n'a PAS été injectée dans la
//     génération COURANTE → donc après une compaction (génération changée),
//     TOUT est à réinjecter. Zéro faux "déjà présent" survivant à la compaction.
//
// ⚠️ MODULE 100% PUR : aucune I/O, aucune dépendance. Testable + MUTABLE
//   (Stryker). L'I/O (lecture/écriture du fichier d'état par session,
//   déclenchement PreCompact, injection stdout) vit dans les hooks-coquilles.
// ⚠️ IMMUABLE : toutes les fonctions retournent un NOUVEL état, ne mutent rien
//   (sûr en concurrence multi-session, pas d'effet de bord partagé).
// ═══════════════════════════════════════════════════════════════════════

'use strict';

// État par session : { generation: number, injected: { [memId]: number } }
function initialState() {
  return { generation: 0, injected: {} };
}

// Normalise un état possiblement partiel/corrompu (fail-safe lecture fichier).
function normalize(state) {
  const s = state && typeof state === 'object' ? state : {};
  const generation = Number.isInteger(s.generation) && s.generation >= 0 ? s.generation : 0;
  const injected = s.injected && typeof s.injected === 'object' ? s.injected : {};
  return { generation, injected };
}

// Compaction → nouvelle génération (invalide tout l'historique d'injection).
function bumpGeneration(state) {
  const s = normalize(state);
  return { generation: s.generation + 1, injected: s.injected };
}

// Une mémoire doit-elle être (ré)injectée dans la génération courante ?
function needsReinject(state, memId) {
  const s = normalize(state);
  return s.injected[memId] !== s.generation;
}

// Marque une mémoire comme injectée dans la génération courante (immutable).
function markInjected(state, memId) {
  const s = normalize(state);
  return { generation: s.generation, injected: { ...s.injected, [memId]: s.generation } };
}

// Parmi des mémoires {id, tier, ...}, celles à force-injecter.
function selectForceTier(memories) {
  if (!Array.isArray(memories)) return [];
  return memories.filter(m => m && m.tier === 'force');
}

module.exports = {
  initialState,
  normalize,
  bumpGeneration,
  needsReinject,
  markInjected,
  selectForceTier,
};
