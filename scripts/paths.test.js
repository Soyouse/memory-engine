// Tests paths.js (node:test) — kill-switch à chaud (fichier sentinelle DISABLED).
//   I/O pur : on isole un data dir temp via MEMORY_ENGINE_HOME (lu à chaque appel).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PATHS = require('./paths.js');

function withTempHome(fn) {
  const prev = process.env.MEMORY_ENGINE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-'));
  process.env.MEMORY_ENGINE_HOME = dir;
  try { return fn(dir); }
  finally { if (prev === undefined) delete process.env.MEMORY_ENGINE_HOME; else process.env.MEMORY_ENGINE_HOME = prev; }
}

test('disabledFlagPath — fichier DISABLED dans le data dir', () => {
  withTempHome((dir) => {
    assert.strictEqual(PATHS.disabledFlagPath(), path.join(dir, 'DISABLED'));
  });
});

test('isDisabled — false quand le fichier sentinelle est absent', () => {
  withTempHome(() => {
    assert.strictEqual(PATHS.isDisabled(), false);
  });
});

test('isDisabled — true dès que le fichier sentinelle existe (hot)', () => {
  withTempHome(() => {
    assert.strictEqual(PATHS.isDisabled(), false);
    fs.writeFileSync(PATHS.disabledFlagPath(), '');
    assert.strictEqual(PATHS.isDisabled(), true); // relu à chaque appel = vrai hot-toggle
  });
});

test('isDisabled — redevient false après suppression du fichier (rallumage à chaud)', () => {
  withTempHome(() => {
    fs.writeFileSync(PATHS.disabledFlagPath(), '');
    assert.strictEqual(PATHS.isDisabled(), true);
    fs.unlinkSync(PATHS.disabledFlagPath());
    assert.strictEqual(PATHS.isDisabled(), false);
  });
});
