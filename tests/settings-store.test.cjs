const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { backupFile, loadSettings, saveSettings } = require('../resources/app/settings-store');

test('settings survive repeated saves and keep the previous valid backup', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-settings-'));
  const file = path.join(folder, 'settings.json');
  try {
    saveSettings(file, { profiles: [{ id: 'one' }], noWatermarkEnabled: true });
    saveSettings(file, { profiles: [{ id: 'one' }, { id: 'two' }], noWatermarkEnabled: true });
    assert.equal(loadSettings(file).profiles.length, 2);
    assert.equal(JSON.parse(fs.readFileSync(backupFile(file), 'utf8')).profiles.length, 1);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('a truncated primary file recovers accounts and feature flags from backup', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-settings-'));
  const file = path.join(folder, 'settings.json');
  try {
    saveSettings(file, { profiles: [{ id: 'one' }], noWatermarkEnabled: true });
    saveSettings(file, { profiles: [{ id: 'one' }, { id: 'two' }], noWatermarkEnabled: true });
    fs.writeFileSync(file, '{"profiles":', 'utf8');
    const recovered = loadSettings(file);
    assert.equal(recovered.profiles.length, 1);
    assert.equal(recovered.noWatermarkEnabled, true);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
