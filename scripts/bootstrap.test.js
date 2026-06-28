'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { detectProfileId, pickAsset, serverArgs, serverExeName, gpuFoundInLog, idleSeconds } = require('./bootstrap.js');
const { PROFILES } = require('./profiles.js');

test('detectProfileId : explicite gagne', () => {
  assert.equal(detectProfileId('win32', 'x64', false), 'cpu');
  assert.equal(detectProfileId('linux', 'x64', false), 'cpu');
  assert.equal(detectProfileId('darwin', 'arm64', false), 'cpu');
  assert.equal(detectProfileId('win32', 'x64', true), 'gpu');
});

test('detectProfileId : auto = gpu', () => {
  assert.equal(detectProfileId('win32', 'x64', undefined), 'gpu');
  assert.equal(detectProfileId('linux', 'x64', undefined), 'gpu');
  assert.equal(detectProfileId('darwin', 'arm64', undefined), 'gpu');
});

// Noms RÉELS de release llama.cpp : Windows = .zip, macOS/Linux = .tar.gz.
const ASSETS = [
  { name: 'llama-b9999-bin-win-vulkan-x64.zip', browser_download_url: 'u1' },
  { name: 'llama-b9999-bin-win-cpu-x64.zip', browser_download_url: 'u2' },
  { name: 'llama-b9999-bin-win-cuda-x64.zip', browser_download_url: 'u3' },
  { name: 'llama-b9999-bin-ubuntu-vulkan-x64.tar.gz', browser_download_url: 'u4' },
  { name: 'llama-b9999-bin-ubuntu-rocm-7.2-x64.tar.gz', browser_download_url: 'urocm' },
  { name: 'llama-b9999-bin-ubuntu-x64.tar.gz', browser_download_url: 'u5' },
  { name: 'llama-b9999-bin-macos-arm64.tar.gz', browser_download_url: 'u6' },
  { name: 'llama-b9999-bin-macos-x64.tar.gz', browser_download_url: 'u7' },
];

test('pickAsset : Windows GPU = vulkan, CPU = cpu', () => {
  assert.equal(pickAsset(ASSETS, 'win32', 'x64', true).browser_download_url, 'u1');
  assert.equal(pickAsset(ASSETS, 'win32', 'x64', false).browser_download_url, 'u2');
});

test('pickAsset : Linux GPU = ubuntu-vulkan, CPU = ubuntu (pas vulkan)', () => {
  assert.equal(pickAsset(ASSETS, 'linux', 'x64', true).browser_download_url, 'u4');
  // ⚠️ le CPU ne doit PAS attraper ubuntu-vulkan-x64.
  assert.equal(pickAsset(ASSETS, 'linux', 'x64', false).browser_download_url, 'u5');
});

test('pickAsset : macOS arm64 vs x64 (Metal, indépendant du GPU flag)', () => {
  assert.equal(pickAsset(ASSETS, 'darwin', 'arm64', true).browser_download_url, 'u6');
  assert.equal(pickAsset(ASSETS, 'darwin', 'x64', true).browser_download_url, 'u7');
  assert.equal(pickAsset(ASSETS, 'darwin', 'arm64', false).browser_download_url, 'u6');
});

test('pickAsset : aucun match = null', () => {
  assert.equal(pickAsset([], 'win32', 'x64', true), null);
  assert.equal(pickAsset(ASSETS, 'sunos', 'x64', true), null);
  assert.equal(pickAsset(null, 'win32', 'x64', true), null);
});

test('serverArgs : GPU ajoute --pooling last + -ngl 99', () => {
  const a = serverArgs(PROFILES.gpu, '/m.gguf', '127.0.0.1', '8181');
  assert.ok(a.includes('--pooling') && a[a.indexOf('--pooling') + 1] === 'last');
  assert.equal(a[a.indexOf('-ngl') + 1], '99');
  assert.ok(a.includes('--embeddings'));
  assert.equal(a[a.indexOf('--batch-size') + 1], '2048');
});

test('serverArgs : CPU (pooling null) = pas de flag --pooling, -ngl 0', () => {
  const a = serverArgs(PROFILES.cpu, '/m.gguf', '127.0.0.1', '8181');
  assert.ok(!a.includes('--pooling'));
  assert.equal(a[a.indexOf('-ngl') + 1], '0');
});

test('serverArgs : idleSeconds > 0 ajoute --sleep-idle-seconds (GPU rendu à l\'idle)', () => {
  const a = serverArgs(PROFILES.gpu, '/m.gguf', '127.0.0.1', '8181', 1200);
  assert.equal(a[a.indexOf('--sleep-idle-seconds') + 1], '1200');
});

test('serverArgs : idleSeconds absent/0 = PAS de flag sleep (serveur toujours chaud)', () => {
  assert.ok(!serverArgs(PROFILES.gpu, '/m.gguf', '127.0.0.1', '8181').includes('--sleep-idle-seconds'));
  assert.ok(!serverArgs(PROFILES.gpu, '/m.gguf', '127.0.0.1', '8181', 0).includes('--sleep-idle-seconds'));
});

test('idleSeconds : défaut = 0 (cycle de vie géré par les sessions, pas par timer)', () => {
  assert.equal(idleSeconds({}), 0);
  assert.equal(idleSeconds(undefined), 0);
  assert.equal(idleSeconds({ MEMORY_ENGINE_IDLE_SECONDS: 'xx' }), 0);
});

test('idleSeconds : override env respecté (opt-in sleep) ; 0 = jamais', () => {
  assert.equal(idleSeconds({ MEMORY_ENGINE_IDLE_SECONDS: '300' }), 300);
  assert.equal(idleSeconds({ MEMORY_ENGINE_IDLE_SECONDS: '0' }), 0);
});

// ⚠️ GARDE ANTI-RÉGRESSION CLÉ (inversée 2026-06-28) : le défaut NE DOIT PAS produire
//   --sleep-idle-seconds. Le timer aveugle causait des faux-DOWN (sleep EN session
//   active sans embed). Le serveur reste chaud ; son arrêt = session-leases au
//   SessionEnd de la DERNIÈRE session. Réintroduire le défaut sleep = ressusciter le bug.
test('REGRESSION : défaut idleSeconds → serveur lancé SANS --sleep-idle-seconds', () => {
  const a = serverArgs(PROFILES.gpu, '/m.gguf', '127.0.0.1', '8181', idleSeconds({}));
  assert.ok(!a.includes('--sleep-idle-seconds'));
});

test('serverExeName : .exe sur Windows seulement', () => {
  assert.equal(serverExeName('win32'), 'llama-server.exe');
  assert.equal(serverExeName('darwin'), 'llama-server');
  assert.equal(serverExeName('linux'), 'llama-server');
});

test('gpuFoundInLog : détecte les devices, false sur log CPU', () => {
  assert.equal(gpuFoundInLog('Vulkan0 : AMD Radeon RX 7600'), true);
  assert.equal(gpuFoundInLog('ggml_metal_init: found device Apple M2'), true);
  assert.equal(gpuFoundInLog('CUDA0: NVIDIA GeForce RTX'), true);
  assert.equal(gpuFoundInLog('llama_model_loader: CPU buffer'), false);
  assert.equal(gpuFoundInLog(''), false);
  assert.equal(gpuFoundInLog(null), false);
});
