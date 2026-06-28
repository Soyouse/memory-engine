#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// memory-reindex.js — Construit/maintient l'index sémantique des mémoires.
//   3 modes : full (défaut) · `<fichier>` (upsert 1 mémoire) · `--reconcile`
//   (sync index↔dossier : maj des changées + purge des supprimées).
//   Cf [[project_memory_system_v2]].
// ═══════════════════════════════════════════════════════════════════════
//
// AUTO-REINDEX (anti index-périmé silencieux) :
//   - hook `memory-autoindex.js` (PostToolUse) → upsert immédiat à l'édition.
//   - `--reconcile` au SessionStart → rattrape ajouts/modifs ratés + PURGE les
//     mémoires dont le .md a disparu (suppression non détectable par Write/Edit).
//
// ⚠️ tier-0 = PRÉSENCE de la clé `tier0` au frontmatter (binaire). Absente = tier-1.
// ⚠️ upsert NE bump PAS `builtAt` (sinon reconcile raterait les autres fichiers
//   modifiés depuis). Seuls full/reconcile posent builtAt = maintenant.
// ⚠️ Noyau pur (parse/chunk/upsert/purge) exporté + muté ; I/O (embed/fs) exclu.
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');
const { embedText, MODEL } = require('./memory-embed.js');
const PATHS = require('./paths.js');

// Stryker disable all : config déclarative (chemins).
const MEM_DIR = PATHS.memoryDir();
const OUT = PATHS.indexPath();
const CHUNK_MAX = 1400;   // plafond DUR par chunk (tokens > 512 rejetés par llama si trop gros).
const CHUNK_TARGET = 350; // taille VISÉE d'un chunk de corps (anti-dilution, cf bug 2026-06-21).
// Stryker restore all

// ── NOYAU PUR (mutable Stryker) ──

function field(fm, key) {
  const r = new RegExp('(?:^|\\n)\\s*' + key + ':\\s*(.+)').exec(fm);
  return r ? r[1].trim().replace(/^["']/, '').replace(/["']$/, '').trim() : '';
}

function parseFile(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content || '');
  const fm = m ? m[1] : '';
  const body = (m ? m[2] : content || '').trim();
  return {
    name: field(fm, 'name'),
    description: field(fm, 'description'),
    // PRÉSENCE de `tier0` = critique. Absente = tier-1 (défaut). Marqueur binaire.
    tier: /(^|\n)\s*tier0\s*:/.test(fm) ? 0 : 1,
    body,
  };
}

// Découpe un corps en sections `##`/`###` (+ préambule de titre ''). Pur, simple.
function splitSections(body) {
  const lines = String(body || '').split('\n');
  const parts = [];
  let cur = { title: '', lines: [] };
  const has = (s) => Boolean(s.title || s.lines.join('').trim());
  for (const ln of lines) {
    if (/^#{2,3}\s+/.test(ln)) {
      if (has(cur)) parts.push(cur);
      cur = { title: ln.replace(/^#+\s*/, '').trim(), lines: [] };
    } else {
      cur.lines.push(ln);
    }
  }
  if (has(cur)) parts.push(cur);
  return parts;
}

// ⚠️ ANTI-DILUTION (bug 2026-06-21) : une SECTION entière en 1 chunk noie le terme
//   précis dans la moyenne du vecteur → match raté. On PACKE par paragraphe jusqu'à
//   CHUNK_TARGET pour des chunks fins (terme saillant) sans exploser le nombre.
// Découpe un texte en paragraphes (séparés par ≥1 ligne vide), trimmés, non-vides.
function paragraphs(text) {
  return String(text || '')
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

// Regroupe des paragraphes en blocs ~CHUNK_TARGET (flush quand on dépasse).
// Un paragraphe seul > CHUNK_MAX est tronqué. Préserve l'ordre. Pur.
function packParagraphs(paras) {
  const out = [];
  let buf = '';
  for (const p of Array.isArray(paras) ? paras : []) {
    const piece = p.slice(0, CHUNK_MAX);
    if (buf && buf.length + piece.length + 1 > CHUNK_TARGET) { out.push(buf); buf = ''; }
    buf = buf ? buf + '\n' + piece : piece;
    if (buf.length >= CHUNK_TARGET) { out.push(buf); buf = ''; }
  }
  if (buf) out.push(buf);
  return out;
}

// Assemble les chunks à embed. En-tête (name+description) + titre de section
// répétés dans CHAQUE chunk fin (garde le contexte sans diluer le corps).
function chunksOf(parsed) {
  const head = [parsed.name, parsed.description].filter(Boolean).join('\n');
  const parts = splitSections(parsed.body);
  const out = [];
  for (const p of parts) {
    const blocks = packParagraphs(paragraphs(p.lines.join('\n'))); // splitSections garantit lines:[]
    for (const b of blocks) {
      out.push({ chunk: p.title, text: [head, p.title, b].filter(Boolean).join('\n') });
    }
  }
  // Fallback : corps vide/whitespace (splitSections → 0 part) → en-tête seul.
  if (!out.length) return [{ chunk: '', text: head }];
  return out;
}

// Remplace tous les chunks d'un id par les nouveaux (immutable).
function upsertChunks(items, id, newItems) {
  const kept = (Array.isArray(items) ? items : []).filter((it) => it && it.id !== id);
  return kept.concat(Array.isArray(newItems) ? newItems : []);
}

// Garde seulement les items dont l'id est dans existingIds (purge des morts).
function purgeMissing(items, existingIds) {
  const set = existingIds instanceof Set ? existingIds : new Set(existingIds || []);
  return (Array.isArray(items) ? items : []).filter((it) => it && set.has(it.id));
}

module.exports = { field, parseFile, splitSections, paragraphs, packParagraphs, chunksOf, upsertChunks, purgeMissing, CHUNK_MAX, CHUNK_TARGET };

// ── COQUILLE I/O (exclue mutation) ──
// Stryker disable all
function idsInFolder() {
  return fs.readdirSync(MEM_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md' && f !== 'ARCHIVE.md')
    .map((f) => f.replace(/\.md$/, ''));
}

function readIndex() {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); }
  catch { return { model: MODEL.name, items: [] }; }
}

function writeIndex(idx) {
  // ⚠️ ÉCRITURE ATOMIQUE OBLIGATOIRE : 3 écrivains concurrents possibles
  //   (autoindex à l'édition + reconcile au démarrage d'une autre session +
  //   full manuel). Un writeFileSync direct = lecture partielle → JSON cassé →
  //   index VIDE → plus aucun recall. tmp+rename = swap atomique (même volume).
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const tmp = OUT + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(idx));
  fs.renameSync(tmp, OUT);
}

async function embedMemory(id) {
  const parsed = parseFile(fs.readFileSync(path.join(MEM_DIR, id + '.md'), 'utf8'));
  const out = [];
  for (const c of chunksOf(parsed)) {
    const vector = await embedText(c.text, { kind: 'document', timeoutMs: 15000 });
    // `text` (corps complet du chunk) stocké pour la récupération LEXICALE BM25
    //   (memory-bm25.js) — le cosine seul rate le mot exact. +~0.3 Mo sur 46 Mo
    //   (négligeable, borné par le nb de mémoires). Absent = BM25 dégrade en cosine seul.
    out.push({ id, chunk: c.chunk, tier: parsed.tier, description: parsed.description, text: c.text, vector });
  }
  return out;
}

function tier0Warn(items) {
  const t0 = new Set(items.filter((it) => it.tier === 0).map((it) => it.id));
  if (t0.size > 8) process.stdout.write(`\n⚠️ ${t0.size} mémoires tier-0 (> 8) : ${[...t0].join(', ')}\n   Vérifier les 3 conditions (miss coûteux + corps nécessaire + récurrent).\n`);
}

async function full() {
  let items = [];
  let fail = 0;
  for (const id of idsInFolder()) {
    try { items = items.concat(await embedMemory(id)); process.stdout.write('.'); }
    catch { fail++; process.stdout.write('x'); }
  }
  const dim = items.length ? items[0].vector.length : 0;
  tier0Warn(items);
  writeIndex({ model: MODEL.name, dim, builtAt: new Date().toISOString(), chunks: items.length, items });
  process.stdout.write(`\nFull : ${items.length} chunks (dim ${dim}), ${fail} échecs → ${OUT}\n`);
}

async function upsertOne(filePath) {
  const id = path.basename(filePath).replace(/\.md$/, '');
  const idx = readIndex();
  const fresh = await embedMemory(id); // throw si serveur down → fail-open côté hook
  idx.items = upsertChunks(idx.items, id, fresh);
  // NE PAS toucher builtAt (laisse reconcile rattraper les autres).
  writeIndex(idx);
  process.stdout.write(`Upsert ${id} : ${fresh.length} chunks.\n`);
}

async function reconcile() {
  const idx = readIndex();
  const folder = idsInFolder();
  const folderSet = new Set(folder);
  const before = idx.items.length;
  idx.items = purgeMissing(idx.items, folderSet); // purge des supprimées
  const purged = before - idx.items.length;

  const builtAt = idx.builtAt ? Date.parse(idx.builtAt) : 0;
  const indexed = new Set(idx.items.map((it) => it.id));
  let updated = 0, fail = 0;
  for (const id of folder) {
    let stale = !indexed.has(id);
    try { if (!stale) stale = fs.statSync(path.join(MEM_DIR, id + '.md')).mtimeMs > builtAt; } catch { /* ignore */ }
    if (!stale) continue;
    try { idx.items = upsertChunks(idx.items, id, await embedMemory(id)); updated++; }
    catch { fail++; }
  }
  idx.builtAt = new Date().toISOString();
  idx.chunks = idx.items.length;
  tier0Warn(idx.items);
  writeIndex(idx);
  process.stdout.write(`Reconcile : ${updated} maj, ${purged} purgées, ${fail} échecs.\n`);
}

if (require.main === module) {
  // KILL-SWITCH : moteur OFF (fichier sentinelle) → pas d'indexation.
  if (PATHS.isDisabled()) process.exit(0);
  const arg = process.argv[2];
  const run = arg === '--reconcile' ? reconcile() : arg ? upsertOne(arg) : full();
  run.catch((e) => { process.stdout.write(`\nErreur reindex : ${e && e.message}\n`); process.exit(0); });
}
// Stryker restore all
