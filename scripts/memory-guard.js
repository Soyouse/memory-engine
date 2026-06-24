#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// memory-guard.js — GARDIEN d'intégrité des fichiers mémoire (PostToolUse
//   Write|Edit). Deux responsabilités, routées par le fichier touché :
//   1) MEMORY.md (index réinjecté) → anti-troncage : alerte près du cap.
//   2) Mémoire .md (dossier memory/) → valide le marqueur tier (anti-typo).
//   Cf [[reference_memory_index_cap]] + [[project_memory_system_v2]].
// ═══════════════════════════════════════════════════════════════════════
//
// 1) ANTI-TRONCAGE MEMORY.md : Claude Code tronque MEMORY.md à 200 lignes /
//    25 Ko AU CHARGEMENT, SILENCIEUSEMENT. On alerte juste après l'écriture.
//
// 2) MARQUEUR TIER : tier-0 = PRÉSENCE de la clé `tier0` (binaire, pas de
//    valeur). Le danger = une clé MAL ÉCRITE (`tier`, `tier0` typo, `tier: 0`,
//    `teir0`, `critical`) → ignorée en silence → mémoire critique jamais
//    injectée. Le garde-fou fuzzy détecte toute clé « tier-like » ≠ `tier0`
//    et ALERTE. Zéro perte d'intention silencieuse.
//
// ⚠️ Fail-open : toute erreur → exit 0 (ne jamais casser une édition).
// ⚠️ exit 2 = stderr remonte à Claude (PostToolUse : l'écriture a déjà eu lieu).
// ⚠️ Noyau PUR exporté + muté ; I/O (lecture fichier, routage) exclu.
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');

// Stryker disable all : caps déclaratifs (Claude Code, vérifiés web 2026-06).
const LINES_CAP = 200;
const BYTES_CAP = 25000;
const LINES_WARN = 170;
const BYTES_WARN = 21000;
// Stryker restore all

// ── NOYAU PUR (mutable Stryker) ──

// Extrait le bloc frontmatter (entre les deux ---). '' si absent.
function extractFrontmatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(typeof content === 'string' ? content : '');
  return m ? m[1] : '';
}

// Mesure l'index MEMORY.md → niveau 'ok' | 'warn' | 'over'.
function assessIndex(content) {
  const text = typeof content === 'string' ? content : '';
  const bytes = Buffer.byteLength(text, 'utf8');
  const lines = text.split('\n').length;
  const over = lines >= LINES_CAP || bytes >= BYTES_CAP;
  const warn = lines >= LINES_WARN || bytes >= BYTES_WARN;
  return { level: over ? 'over' : warn ? 'warn' : 'ok', lines, bytes };
}

// Message d'alerte index (ou '' si ok).
function indexMessage(a) {
  if (!a || a.level === 'ok') return '';
  const stamp = `MEMORY.md = ${a.lines}/${LINES_CAP} lignes · ${a.bytes}/${BYTES_CAP} o`;
  return a.level === 'over'
    ? `🛑 CAP MEMORY.md DÉPASSÉ — ${stamp}. Troncage SILENCIEUX au prochain chargement : les entrées du bas DISPARAÎTRONT. Archive/condense MAINTENANT.`
    : `⚠️ MEMORY.md proche du cap — ${stamp}. Archive (ARCHIVE.md) ou raccourcis avant le cap (tronque en silence au chargement).`;
}

// Clés « tier-like » du frontmatter qui ne sont PAS exactement `tier0`
// (marqueur de présence du tier-0). Retourne la liste des suspectes.
function suspectTierKeys(fm) {
  const re = /(?:^|\n)[ \t]*(tier[\w-]*|teir[\w-]*|critical)[ \t]*:/gi;
  const suspects = [];
  let m;
  while ((m = re.exec(typeof fm === 'string' ? fm : ''))) {
    if (m[1].toLowerCase() !== 'tier0') suspects.push(m[1]);
  }
  return suspects;
}

// Message d'alerte marqueur tier (ou '' si rien de suspect).
function tierMessage(suspects) {
  if (!Array.isArray(suspects) || suspects.length === 0) return '';
  return `🛑 Marqueur tier suspect : ${suspects.join(', ')}. Le SEUL marqueur valide est \`tier0\` (présence = critique). Toute autre clé est IGNORÉE EN SILENCE → la mémoire reste tier-1. Corrige en \`tier0:\` ou retire-la.`;
}

module.exports = {
  extractFrontmatter, assessIndex, indexMessage, suspectTierKeys, tierMessage,
  LINES_CAP, BYTES_CAP, LINES_WARN, BYTES_WARN,
};

// ── COQUILLE I/O (exclue mutation) ──
// Stryker disable all
function isMemoryFile(filePath) {
  const p = String(filePath).replace(/\\/g, '/');
  const base = path.basename(p);
  return p.includes('/memory/') && p.endsWith('.md') && base !== 'MEMORY.md' && base !== 'ARCHIVE.md';
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(input || '{}');
      const filePath = (data.tool_input && data.tool_input.file_path) || '';
      const base = path.basename(filePath);

      let content;
      try { content = fs.readFileSync(filePath, 'utf8'); }
      catch { process.exit(0); }

      let msg = '';
      if (base === 'MEMORY.md') {
        msg = indexMessage(assessIndex(content));
      } else if (isMemoryFile(filePath)) {
        msg = tierMessage(suspectTierKeys(extractFrontmatter(content)));
      }

      if (msg) { process.stderr.write(msg + '\n'); process.exit(2); }
    } catch { /* fail-open */ }
    process.exit(0);
  });
}
// Stryker restore all
