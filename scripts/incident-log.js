'use strict';
// ═══════════════════════════════════════════════════════════════════════
// incident-log.js — Journal d'incidents APPEND-ONLY du moteur mémoire.
// ═══════════════════════════════════════════════════════════════════════
// POURQUOI : `mem-health.json` = SNAPSHOT écrasé à chaque prompt (l'incident
//   disparaît) ; `server.log` = ÉCRASÉ à chaque relance du serveur ; les vrais
//   crashs CRT vont dans l'Event Log Windows (NON cross-OS). Résultat : face à
//   un `🧠 DOWN` on ne savait PAS d'où il venait → on devait REPRODUIRE.
//   Ce journal écrit UNE ligne JSONL à chaque état non-ok (down/booting/
//   dim_mismatch/relance) + le retour à ok (recovered) → la cause se LIT,
//   plus jamais besoin de reproduire. Cross-OS (fichier), aligné anti-silence.
//
// ⚠️ FAIL-OPEN ABSOLU : un log d'incident ne DOIT JAMAIS casser le hook
//   (UserPromptSubmit). Toute I/O wrappée → on avale l'erreur.
// ⚠️ APPEND BORNÉ : rotation à MAX_LINES (anti-bloat) — on garde les dernières.
// ⚠️ Pur (record/format/recovery/cap) exporté + muté ; I/O (append) exclu.
// ⚠️ Concurrence : append = lire→modifier→écrire NON verrouillé (comme l'index).
//   2 sessions // au même instant → au pire 1 ligne d'incident perdue (jamais
//   de corruption : écriture atomique tmp+rename). Acceptable pour un journal.
// ═══════════════════════════════════════════════════════════════════════

// Stryker disable all : seuils déclaratifs (tuning), aucun contrat à muter.
const MAX_LINES = 500;   // rotation : taille bornée du journal
const ERR_MAX = 300;     // troncature des messages d'erreur (anti-bloat)
// Stryker restore all

// ── NOYAU PUR (mutable Stryker) ──

// Normalise un enregistrement d'incident : types sûrs, erreur tronquée.
//   Garantit un JSONL homogène quel que soit l'appelant (jamais de undefined).
function incidentRecord(o) {
  const r = o || {};
  return {
    ts: typeof r.ts === 'string' ? r.ts : null,
    kind: typeof r.kind === 'string' && r.kind ? r.kind : 'unknown',
    status: r.status || null,
    latencyMs: Number.isFinite(r.latencyMs) ? Math.round(r.latencyMs) : null,
    probe: r.probe || null,
    relaunched: !!r.relaunched,
    session: r.session || 'unknown',
    error: r.error ? String(r.error).slice(0, ERR_MAX) : null,
  };
}

// Une ligne JSONL (record normalisé → JSON sur une ligne).
function formatLine(record) {
  return JSON.stringify(incidentRecord(record));
}

// Transition de récupération : était NON-ok, redevient ok → 'recovered'.
//   Sert à clôturer un incident (« down à 14h32 → recovered à 14h33 en 91ms »).
//   prevOk inconnu (null/jamais écrit) → pas de faux 'recovered'.
function recoveryKind(prevOk, nowOk) {
  return prevOk === false && nowOk === true ? 'recovered' : null;
}

// ⚠️ DÉDUP PAR TRANSITION (anti-spam SSD) : on n'écrit un incident QUE si l'état
//   observable CHANGE. Un `down` qui persiste sur 200 prompts = 1 SEULE ligne,
//   pas 200. C'est le standard (log on state-change), et ça borne l'I/O réelle
//   bien en-dessous du cap dur. newStatus absent → jamais de log.
function shouldLogTransition(prevStatus, newStatus) {
  return !!newStatus && newStatus !== prevStatus;
}

// Rotation anti-bloat : garde les `max` DERNIÈRES lignes non vides.
function capLines(text, max) {
  const lines = String(text == null ? '' : text).split('\n').filter((l) => l.trim() !== '');
  const m = max > 0 ? max : MAX_LINES;
  return lines.slice(-m);
}

module.exports = { incidentRecord, formatLine, recoveryKind, shouldLogTransition, capLines, appendIncident, MAX_LINES };

// ── COQUILLE I/O (exclue mutation) ──
// Stryker disable all
const fs = require('fs');
const path = require('path');

// Ajoute un incident au journal (atomique tmp+rename, borné MAX_LINES).
//   fail-open : toute erreur est avalée (ne casse jamais le hook appelant).
function appendIncident(file, record, max) {
  try {
    const line = formatLine(record);
    let prev = '';
    try { prev = fs.readFileSync(file, 'utf8'); } catch { /* fichier pas encore créé */ }
    // Cappe l'ENSEMBLE (ancien + nouvelle ligne) → total borné à `max`, jamais max+1.
    const kept = capLines(prev + '\n' + line, max || MAX_LINES);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, kept.join('\n') + '\n');
    fs.renameSync(tmp, file);
  } catch { /* fail-open : un journal d'incident ne casse JAMAIS le hook */ }
}
// Stryker restore all
