const fs = require("fs");
const path = require("path");

function readObject(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function backupFile(file) {
  return `${file}.backup`;
}

function loadSettings(file) {
  return readObject(file) || readObject(backupFile(file)) || {};
}

function saveSettings(file, config) {
  const folder = path.dirname(file);
  const temporary = `${file}.tmp`;
  const backup = backupFile(file);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2), "utf8");
  const current = readObject(file);
  if (current) fs.copyFileSync(file, backup);
  try {
    fs.copyFileSync(temporary, file);
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

module.exports = { backupFile, loadSettings, saveSettings };
