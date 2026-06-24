'use strict';
// ═══════════════════════════════════════════════════════════════════════
// profiles.js — Les DEUX profils d'embedding (data-driven).
//   bootstrap.js détecte GPU/CPU → écrit profile.json dans ${CLAUDE_PLUGIN_DATA}.
//   memory-embed.js le lit (sinon défaut GPU). UN profil = modèle + pooling +
//   préfixes + dim + seuil, tous COUPLÉS (jamais mélanger entre profils).
// ⚠️ GPU (Qwen3-4B) : pooling LAST, instruct sur la requête, doc brut, dim 2560.
// ⚠️ CPU (EmbeddingGemma-300M) : pooling mean (défaut), préfixes search_*, dim 768.
//   Léger → tourne en CPU sans tuer la machine. Qualité moindre (seuil 0.40).
// ═══════════════════════════════════════════════════════════════════════

// Stryker disable all : config déclarative (URLs/constantes de profil).
const QWEN = 'https://huggingface.co/Qwen/Qwen3-Embedding-4B-GGUF/resolve/main/Qwen3-Embedding-4B-Q8_0.gguf';
const GEMMA = 'https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf';

const PROFILES = {
  gpu: {
    id: 'gpu',
    name: 'Qwen3-Embedding-4B-Q8_0',
    apiName: 'qwen3-embedding',
    dim: 2560,
    queryPrefix: 'Instruct: Given a message from a user to their AI assistant, retrieve relevant long-term memories (user preferences, feedback, identity, and project facts).\nQuery: ',
    docPrefix: '',
    pooling: 'last',   // ⚠️ Qwen3 EXIGE last ; mean = embeddings faux en silence.
    ngl: 99,           // toutes les couches sur GPU
    minScore: 0.55,    // bande Qwen3 +0.25 vs Gemma
    modelFile: 'Qwen3-Embedding-4B-Q8_0.gguf',
    modelUrl: QWEN,
  },
  cpu: {
    id: 'cpu',
    name: 'embeddinggemma-300M-Q8_0',
    apiName: 'embeddinggemma',
    dim: 768,
    queryPrefix: 'search_query: ',
    docPrefix: 'search_document: ',
    pooling: null,     // mean = défaut du modèle (pas de flag --pooling)
    ngl: 0,            // CPU pur
    minScore: 0.40,
    modelFile: 'embeddinggemma-300M-Q8_0.gguf',
    modelUrl: GEMMA,
  },
};
// Stryker restore all

module.exports = { PROFILES };
