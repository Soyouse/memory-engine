# Memory Engine

Mémoire long terme **sémantique et 100% locale** pour [Claude Code](https://claude.com/claude-code), distribuée comme plugin.

Recall fiable (embeddings), **compaction-aware** (réinjecte au bon moment, sans spam), GPU avec **fallback CPU automatique**. Aucune donnée envoyée à un service tiers.

> ⚠️ **Statut : en construction (v0.1.0).** Squelette de plugin. Le code moteur (live, éprouvé) est en cours de portage depuis les hooks Claude Code vers ce package autonome. Voir [Roadmap](#roadmap).

## Ce qui le distingue

- **Compaction-aware** — un compteur de génération sait quand une mémoire est déjà dans le contexte → réinjection *pile* après une compaction, zéro répétition. Là où les systèmes cloud (mem0, Letta) re-poussent en boucle ou ratent.
- **Sémantique sur le corps** — chaque paragraphe d'une mémoire est indexé, pas seulement le titre. On matche le contenu réel.
- **Deux tiers** — mémoires critiques (`tier0`) : corps injecté au 1er match pertinent ; mémoires normales : rappel léger.
- **Local-first** — embeddings via [llama.cpp](https://github.com/ggml-org/llama.cpp). GPU (Vulkan/Metal/CUDA) → Qwen3-Embedding-4B ; sinon CPU → EmbeddingGemma-300M.
- **Anti-silence** — toute dégradation (serveur down, modèle incompatible) est visible, jamais un recall mensonger.

## Architecture

```
UserPromptSubmit ─→ memory-suggest  (embed prompt → cosine top-k → inject/recall)
PostToolUse ──────→ memory-autoindex (upsert incrémental à l'édition d'une mémoire)
                    memory-guard     (garde-fous: cap index, marqueurs tier)
PreCompact ───────→ memory-bump      (incrémente la génération → réinjection post-compaction)
SessionStart ─────→ bootstrap        (télécharge binaire+modèle, lance le daemon llama.cpp)
                    memory-reindex --reconcile (sync index ↔ mémoires, purge supprimées)
```

Index = embeddings JSON (brute-force cosine, < 10k chunks). État par session. Tout dans `${CLAUDE_PLUGIN_DATA}` (survit aux updates).

## Installation

```
/plugin marketplace add Soyouse/memory-engine
/plugin install memory-engine
```

Au premier démarrage, le plugin télécharge le binaire llama.cpp adapté à ton OS/GPU et le modèle d'embedding dans son dossier de données. (À venir — voir Roadmap.)

## Roadmap

- [x] Moteur sémantique fiable (Qwen3-Embedding-4B, FR/multilingue), compaction-aware, testé + mutation.
- [ ] **P-A** Portabilité des chemins → `${CLAUDE_PLUGIN_DATA}`.
- [ ] **P-B** Bootstrap cross-OS (détection GPU, download binaire+modèle, daemon) — remplace les scripts Windows-only.
- [ ] **P-C** Structure plugin finalisée.
- [ ] **P-D** Packaging (LICENSE, CI cross-OS, docs format mémoire).
- [ ] **P-E** Publication marketplace.
- [ ] Eval-set (golden queries) pour prouver la fiabilité du recall.
- [ ] Consolidation autonome (capture épisodique + « dreaming »).

## Licence

[Apache-2.0](./LICENSE).
