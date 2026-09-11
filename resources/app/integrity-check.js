const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const BOOK = require("./password-book");

const SOFTWARE_SEAL = "JXPB-INT-9f3c2a7e1b84d0c6";

const FILES = [
  "password-book.js",
  "integrity-check.js",
  "license-client.js",
  "main.js",
  "preload.js"
];

const MARKS = [
  ["integrity-check.js", BOOK.integrity],
  ["license-client.js", BOOK.license],
  ["main.js", BOOK.mainBoot],
  ["main.js", BOOK.mainLock],
  ["preload.js", BOOK.preload],
  ["app/app.js", BOOK.ui],
  ["doubao-controller.js", BOOK.doubao],
  ["platform-helper.js", BOOK.helper]
];

function fileHash(rel) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, rel))).digest("hex");
}

function readText(rel) {
  return fs.readFileSync(path.join(__dirname, rel), "utf8");
}

function verifyPasswordBook() {
  if (SOFTWARE_SEAL !== BOOK.integrity) return false;
  try {
    const license = require("./license-client");
    if (license.SOFTWARE_SEAL !== BOOK.license) return false;
  } catch {
    return false;
  }
  for (const [rel, seal] of MARKS) {
    let text = "";
    try { text = readText(rel); } catch { return false; }
    if (!seal || !text.includes(seal)) return false;
  }
  return true;
}

function verify() {
  if (fs.existsSync(path.join(__dirname, ".integrity-dev"))) {
    return { ok: true, skipped: true, tamper: false };
  }
  let expected = {};
  try {
    expected = JSON.parse(fs.readFileSync(path.join(__dirname, "integrity-manifest.json"), "utf8")).files || {};
  } catch {
    return { ok: false, tamper: false, message: "程序文件不完整，请重新下载官方安装包。" };
  }
  const files = {};
  for (const rel of FILES) {
    let actual = "";
    try { actual = fileHash(rel); } catch {
      return { ok: false, tamper: false, message: "程序文件不完整，请重新下载官方安装包。" };
    }
    files[rel] = actual;
    if (String(expected[rel] || "") !== actual) {
      return { ok: false, tamper: true, files, message: "检测到程序文件被修改，此设备已被锁定。" };
    }
  }
  if (!verifyPasswordBook()) {
    return { ok: false, tamper: true, files, message: "检测到程序文件被修改，此设备已被锁定。" };
  }
  return { ok: true, tamper: false };
}

module.exports = { verify, SOFTWARE_SEAL };
