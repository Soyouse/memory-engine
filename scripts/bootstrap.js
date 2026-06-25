#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// bootstrap.js — Amorçage CROSS-OS du moteur d'inférence (SessionStart).
//   Détecte OS+GPU → choisit le profil (GPU Qwen3 / CPU Gemma) → télécharge
//   le binaire llama.cpp + le modèle GGUF dans ${CLAUDE_PLUGIN_DATA} si absent
//   → lance le daemon. Remplace start-llama.ps1 + VBS + tâche planifiée (Windows).
//   Cf [[project_memory_system_v2]].
// ═══════════════════════════════════════════════════════════════════════
//
// ⚠️ NE JAMAIS BLOQUER : ce hook tourne à CHAQUE SessionStart. Séquence rapide :
//   serveur up → exit 0 ; binaire+modèle présents → spawn daemon → exit 0 ;
//   sinon → délègue le DOWNLOAD (lent, ~Go) à un process DÉTACHÉ (`--fetch`)
//   et rend la main IMMÉDIATEMENT. La mémoire fail-open tant que pas prête.
// ⚠️ Sources OFFICIELLES uniquement : binaire = releases ggml-org/llama.cpp,
//   modèle = HuggingFace (cf profiles.js). Aucun mirroir maison.
// ⚠️ Noyau PUR (détection/sélection/args) exporté + muté ; I/O (fetch/spawn) exclu.
// ⚠️ fail-open ABSOLU : toute erreur → exit 0 (jamais bloquer une session).
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');
const PATHS = require('./paths.js');
const { PROFILES } = require('./profiles.js');

// Stryker disable all : config déclarative.
const HOST = process.env.MEM_EMBED_HOST || '127.0.0.1';
const PORT = process.env.MEM_EMBED_PORT || '8181';
const GH_LATEST = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';
// Stryker restore all

// ── NOYAU PUR (mutable Stryker) ──

// Secondes d'inactivité avant que llama.cpp décharge le modèle (GPU rendu au
//   gaming). Défaut 1200 (20 min) ; override `MEMORY_ENGINE_IDLE_SECONDS` ; 0 =
//   jamais (serveur toujours chaud). ⚠️ PUR + testé : garde anti-régression — si
//   le défaut tombait à 0, le serveur tiendrait le GPU H24 (le bug qu'on a tué).
function idleSeconds(env) {
  const n = Number((env || {}).MEMORY_ENGINE_IDLE_SECONDS);
  return Number.isFinite(n) && n >= 0 ? n : 1200;
}

// Choix du profil. userGpu explicite (true/false) gagne ; sinon auto = GPU
// (Mac=Metal, Win/Linux=Vulkan). Pas de GPU réel → l'utilisateur met gpu:false
// (le binaire GPU retombe sur CPU mais lentement → on AVERTIT, jamais silencieux).
function detectProfileId(platform, arch, userGpu) {
  if (userGpu === false) return 'cpu';
  if (userGpu === true) return 'gpu';
  return 'gpu';
}

// Sélectionne l'asset de release llama.cpp selon OS/arch/GPU (match par nom).
// assets = [{ name, browser_download_url }]. Renvoie l'asset ou null.
// ⚠️ EXTENSIONS RÉELLES (vérifié release réelle) : Windows = .zip ; macOS &
//   Linux = .tar.gz. macOS = Metal (toujours). Linux/Win GPU = Vulkan (couvre
//   AMD/NVIDIA/Intel). Plateforme inconnue → null (jamais un défaut hasardeux).
function pickAsset(assets, platform, arch, useGpu) {
  const list = Array.isArray(assets) ? assets : [];
  const ext = '\\.(zip|tar\\.gz)$';
  let rx;
  if (platform === 'darwin') rx = new RegExp((arch === 'arm64' ? 'macos-arm64' : 'macos-x64') + ext);
  else if (platform === 'win32') rx = new RegExp((useGpu ? 'win-vulkan-x64' : 'win-cpu-x64') + ext);
  else if (platform === 'linux') rx = new RegExp((useGpu ? 'ubuntu-vulkan-x64' : 'ubuntu-x64') + ext);
  else return null;
  return list.find((a) => a && typeof a.name === 'string' && rx.test(a.name)) || null;
}

// Flags de lancement du serveur (pooling COUPLÉ au profil : Qwen3=last).
//   --sleep-idle-seconds : NATIF llama.cpp. Le serveur décharge le modèle de la
//   VRAM après N s sans requête (GPU rendu au gaming) et le RECHARGE seul à la
//   requête suivante. Remplace tout lifecycle custom (lease/watchdog/SessionEnd) :
//   chaque embedding = signal d'activité, le serveur tient son propre timer idle.
function serverArgs(profile, modelPath, host, port, idleSeconds) {
  const a = ['-m', modelPath, '--embeddings', '-ngl', String(profile.ngl),
    '--host', String(host), '--port', String(port),
    '--ctx-size', '2048', '--batch-size', '2048', '--ubatch-size', '2048'];
  if (profile.pooling) a.push('--pooling', profile.pooling);
  if (idleSeconds > 0) a.push('--sleep-idle-seconds', String(idleSeconds));
  return a;
}

const serverExeName = (platform) => (platform === 'win32' ? 'llama-server.exe' : 'llama-server');

// Le log de llama.cpp énumère le device GPU au boot → preuve qu'un GPU est utilisé.
function gpuFoundInLog(text) {
  return /Vulkan\d|Metal|CUDA|ROCm|Radeon|GeForce|Apple M|Intel.*Graphics/i.test(String(text || ''));
}

module.exports = { detectProfileId, pickAsset, serverArgs, serverExeName, gpuFoundInLog, idleSeconds };

// ── COQUILLE I/O (exclue mutation) ──
// Stryker disable all
const { spawn, spawnSync } = require('child_process');
const { Readable } = require('stream');

function log(msg) { try { process.stdout.write(`[memory-engine] ${msg}\n`); } catch { /* ignore */ } }

async function isServerUp() {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1500);
    const r = await fetch(`http://${HOST}:${PORT}/health`, { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

// Cherche récursivement l'exécutable du serveur sous `dir` (le zip peut nicher).
function findExe(dir, name) {
  let found = null;
  const walk = (d) => {
    if (found) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === name) { found = p; return; }
    }
  };
  walk(dir);
  return found;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'memory-engine' } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tmp);
    Readable.fromWeb(res.body).pipe(file);
    file.on('finish', resolve);
    file.on('error', reject);
  });
  fs.renameSync(tmp, dest);
}

// Extraction zip cross-OS via `tar` (bsdtar : Win10+, macOS, Linux gèrent .zip).
function extractZip(zip, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync('tar', ['-xf', zip, '-C', destDir], { stdio: 'ignore' });
  if (r.status !== 0) {
    const u = spawnSync('unzip', ['-o', zip, '-d', destDir], { stdio: 'ignore' });
    if (u.status !== 0) throw new Error('extraction zip échouée (ni tar ni unzip)');
  }
}

function launchDaemon(exe, profile, modelPath) {
  const args = serverArgs(profile, modelPath, HOST, PORT, idleSeconds(process.env));
  const out = fs.openSync(PATHS.serverLog(), 'a');
  const child = spawn(exe, args, { detached: true, stdio: ['ignore', out, out] });
  child.unref();
}

function writeProfile(profile) {
  try {
    fs.mkdirSync(PATHS.dataDir(), { recursive: true });
    fs.writeFileSync(PATHS.profilePath(), JSON.stringify(profile));
  } catch { /* fail-open */ }
}

function userGpuPref() {
  const v = process.env.MEMORY_ENGINE_GPU;
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return undefined; // auto
}

// Le gros œuvre (lent) : télécharge binaire + modèle si absents, puis lance.
// Tourne en process DÉTACHÉ (jamais dans le hook synchrone).
async function fetchAndLaunch() {
  const profile = PROFILES[detectProfileId(process.platform, process.arch, userGpuPref())] || PROFILES.gpu;
  writeProfile(profile);
  const exeName = serverExeName(process.platform);
  let exe = findExe(PATHS.binDir(), exeName);

  if (!exe) {
    log('téléchargement du binaire llama.cpp…');
    const rel = await (await fetch(GH_LATEST, { headers: { 'User-Agent': 'memory-engine' } })).json();
    const asset = pickAsset(rel && rel.assets, process.platform, process.arch, profile.id === 'gpu');
    if (!asset) throw new Error(`aucun binaire llama.cpp pour ${process.platform}/${process.arch}`);
    const zip = path.join(PATHS.binDir(), asset.name);
    await download(asset.browser_download_url, zip);
    extractZip(zip, PATHS.binDir());
    try { fs.unlinkSync(zip); } catch { /* ignore */ }
    exe = findExe(PATHS.binDir(), exeName);
    if (!exe) throw new Error('binaire introuvable après extraction');
  }

  const modelPath = path.join(PATHS.modelsDir(), profile.modelFile);
  if (!fs.existsSync(modelPath)) {
    log(`téléchargement du modèle ${profile.name} (~Go, une seule fois)…`);
    await download(profile.modelUrl, modelPath);
  }

  launchDaemon(exe, profile, modelPath);
  log(`daemon lancé (profil ${profile.id}).`);

  // Anti-silence : si GPU attendu mais absent du log → AVERTIR (pas un échec).
  if (profile.id === 'gpu') {
    setTimeout(() => {
      try {
        const t = fs.readFileSync(PATHS.serverLog(), 'utf8');
        if (t && !gpuFoundInLog(t)) log('⚠️ aucun GPU détecté — embeddings lents. Mettre gpu:false pour le modèle CPU léger.');
      } catch { /* ignore */ }
    }, 8000);
  }
}

async function main() {
  // 1) Déjà up → rien (idempotent, instantané).
  if (await isServerUp()) { process.exit(0); }

  const profile = PROFILES[detectProfileId(process.platform, process.arch, userGpuPref())] || PROFILES.gpu;
  writeProfile(profile);
  const exe = findExe(PATHS.binDir(), serverExeName(process.platform));
  const modelPath = path.join(PATHS.modelsDir(), profile.modelFile);

  // 2) Tout est là → lancer le daemon (rapide) et rendre la main.
  if (exe && fs.existsSync(modelPath)) {
    try { launchDaemon(exe, profile, modelPath); log(`daemon relancé (profil ${profile.id}).`); } catch { /* ignore */ }
    process.exit(0);
  }

  // 3) Manque binaire/modèle → DÉLÉGUER le download à un process détaché.
  //    Ne JAMAIS bloquer le SessionStart sur un download de plusieurs Go.
  try {
    const child = spawn(process.execPath, [__filename, '--fetch'], { detached: true, stdio: 'ignore' });
    child.unref();
    log('première installation : téléchargement du moteur en arrière-plan. La mémoire s\'activera dès qu\'il sera prêt.');
  } catch { /* fail-open */ }
  process.exit(0);
}

// SessionStart : lance le daemon s'il est down (idempotent). Le serveur gère
//   lui-même son cycle de vie GPU (--sleep-idle-seconds) → aucun lease ni
//   watchdog à poser. main() ne lit pas stdin : on n'attend rien, on avance.
if (require.main === module) {
  if (process.argv[2] === '--fetch') {
    Promise.resolve(fetchAndLaunch()).catch((e) => { log(`bootstrap: ${e && e.message}`); process.exit(0); });
  } else {
    Promise.resolve(main()).catch((e) => { log(`bootstrap: ${e && e.message}`); process.exit(0); });
  }
}
// Stryker restore all
