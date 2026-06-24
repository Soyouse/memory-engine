#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// memory-autoindex.js — COQUILLE I/O (PostToolUse Write|Edit) : réindexe
//   IMMÉDIATEMENT la mémoire qu'on vient d'éditer (upsert incrémental).
//   Évite l'index périmé en silence. Cf [[project_memory_system_v2]].
// ═══════════════════════════════════════════════════════════════════════
//
// Ne touche QUE les .md du dossier mémoire (sinon exit 0 instantané — 99 %
// des Write/Edit). Édition de mémoire = rare → upsert synchrone (~300 ms) OK.
// Suppressions = NON détectables ici (Write/Edit only) → rattrapées par
// `memory-reindex.js --reconcile` au SessionStart.
//
// ⚠️ FAIL-OPEN : serveur embeddings down / erreur → exit 0, l'édition n'est
//   JAMAIS bloquée. Le reconcile au prochain démarrage rattrapera.
// ⚠️ Réutilise les noyaux PURS de memory-reindex (parseFile/chunksOf/upsertChunks).
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');
const { embedText } = require('./memory-embed.js');
const { parseFile, chunksOf, upsertChunks } = require('./memory-reindex.js');
const PATHS = require('./paths.js');

// Stryker disable all
const OUT = PATHS.indexPath();

function isMemoryFile(filePath) {
  const p = String(filePath).replace(/\\/g, '/');
  const base = path.basename(p);
  return p.includes('/memory/') && p.endsWith('.md') && base !== 'MEMORY.md' && base !== 'ARCHIVE.md';
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', async () => {
    try {
      const data = JSON.parse(raw || '{}');
      const filePath = (data.tool_input && data.tool_input.file_path) || '';
      if (!isMemoryFile(filePath)) { process.exit(0); }

      const id = path.basename(filePath).replace(/\.md$/, '');
      const parsed = parseFile(fs.readFileSync(filePath, 'utf8'));
      const fresh = [];
      for (const c of chunksOf(parsed)) {
        const vector = await embedText(c.text, { kind: 'document', timeoutMs: 4000 });
        fresh.push({ id, chunk: c.chunk, tier: parsed.tier, description: parsed.description, vector });
      }

      const idx = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      idx.items = upsertChunks(idx.items, id, fresh); // NE PAS toucher builtAt
      idx.chunks = idx.items.length;
      fs.writeFileSync(OUT, JSON.stringify(idx));
    } catch {
      // fail-open : serveur down / index absent → reconcile rattrapera
    }
    process.exit(0);
  });
}
// Stryker restore all
