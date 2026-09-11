const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { net } = require("electron");

const LICENSE_SERVER = "http://101.133.149.8:8787";
const APP_TOKEN = "JxCnv56-k7mQ2pL9wR4tY8uE";
const SOFTWARE_SEAL = "JXPB-LIC-c4d81e6a02b75f93";
const LICENSE_TEST = false;
const GRACE_MS = LICENSE_TEST ? 30 * 1000 : 20 * 60 * 1000;
const WATCH_MS = LICENSE_TEST ? 30 * 1000 : 12 * 60 * 1000;
let licensePath = "";
let cache = { ok: false, expired: true, trial: false, badge: "未授权", message: "尚未激活" };
let lastBroadcast = "";
let lastRefreshAt = 0;

function setLicensePath(file) {
  licensePath = file;
}

function readLocal() {
  try { return JSON.parse(fs.readFileSync(licensePath, "utf8")); } catch { return {}; }
}

function writeLocal(data) {
  if (!licensePath) return;
  fs.mkdirSync(path.dirname(licensePath), { recursive: true });
  const temp = licensePath + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(temp, licensePath);
}

function windowsMachineGuid() {
  try {
    const raw = execFileSync("reg", [
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
      "/v",
      "MachineGuid"
    ], { encoding: "utf8", windowsHide: true, timeout: 4000 });
    return String(raw.match(/MachineGuid\s+REG_\w+\s+(\S+)/i)?.[1] || "").trim();
  } catch {
    return "";
  }
}

function machineId() {
  const parts = [
    windowsMachineGuid(),
    os.hostname(),
    os.userInfo().username,
    os.arch(),
    os.platform()
  ].join("|");
  return crypto.createHash("sha256").update(parts).digest("hex").slice(0, 32);
}

function formatExpireBadge(ok, expires) {
  if (!ok) return "未授权";
  if (!expires) return "已授权";
  const end = Date.parse(expires);
  if (!Number.isFinite(end)) return "已授权";
  const days = Math.max(0, Math.ceil((end - Date.now()) / 86400000));
  if (days <= 0) return "已授权 · 今天到期";
  return `已授权 · 剩${days}天`;
}

function formatExpireHint(expires) {
  const end = Date.parse(expires || "");
  if (!Number.isFinite(end)) return "";
  const date = new Date(end);
  const text = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return `正版授权至 ${text}`;
}

function publicStatus(extra = {}) {
  const expires = cache.expires || "";
  return {
    ok: Boolean(cache.ok),
    expired: Boolean(cache.expired),
    trial: Boolean(cache.trial),
    badge: cache.ok ? formatExpireBadge(true, expires) : (cache.badge || "未授权"),
    message: cache.ok ? (formatExpireHint(expires) || cache.message || "正版授权有效") : (cache.message || ""),
    expires,
    mustExit: Boolean(cache.mustExit),
    machineLocked: Boolean(cache.machineLocked),
    hasKey: Boolean(String(readLocal().key || "").trim()),
    ...extra
  };
}

const LOCKED_MESSAGE = "此设备因篡改程序已被锁定，无法再使用本软件。如需解封请联系作者。";

function deviceLockFiles() {
  const files = [];
  if (licensePath) files.push(path.join(path.dirname(licensePath), "device-lock.json"));
  const programData = process.env.ProgramData || "C:\\ProgramData";
  files.push(path.join(programData, "JiaxingDoubaoCanvas", "device-lock.json"));
  return files;
}

function readDeviceLock() {
  for (const file of deviceLockFiles()) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data && data.locked) return true;
    } catch {}
  }
  return false;
}

function writeDeviceLock() {
  const payload = JSON.stringify({ locked: true, at: Date.now(), machineId: machineId() }, null, 2);
  for (const file of deviceLockFiles()) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, payload, "utf8");
    } catch {}
  }
}

function clearDeviceLock() {
  for (const file of deviceLockFiles()) {
    try { fs.unlinkSync(file); } catch {}
  }
}

function lockedStatus() {
  cache = {
    ok: false,
    expired: false,
    trial: false,
    badge: "设备已锁定",
    message: LOCKED_MESSAGE,
    expires: "",
    mustExit: true,
    machineLocked: true
  };
  return publicStatus();
}

function applyLocalGrace() {
  if (readDeviceLock()) return false;
  const local = readLocal();
  const key = String(local.key || "").trim();
  const lastOk = Number(local.lastOkAt || 0);
  if (key && lastOk && Date.now() - lastOk < GRACE_MS) {
    cache = {
      ok: true,
      expired: false,
      trial: false,
      badge: "已授权",
      message: "授权有效（短暂离线）",
      expires: local.expires || ""
    };
    return true;
  }
  return false;
}

function postJson(pathname, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: "POST",
      url: `${LICENSE_SERVER}${pathname}`
    });
    const body = JSON.stringify({ app: "doubao-canvas", machineId: machineId(), ...payload });
    const timer = setTimeout(() => {
      try { request.abort(); } catch {}
      reject(new Error("授权服务器超时"));
    }, timeoutMs);
    const done = fn => value => {
      clearTimeout(timer);
      fn(value);
    };
    request.setHeader("Content-Type", "application/json");
    request.setHeader("X-Jx-Token", APP_TOKEN);
    request.on("response", response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { done(resolve)(JSON.parse(text)); }
        catch { done(reject)(new Error("授权服务器返回了无法识别的内容")); }
      });
    });
    request.on("error", () => done(reject)(new Error("无法连接授权服务器")));
    request.on("abort", () => done(reject)(new Error("授权服务器超时")));
    request.end(body);
  });
}

function postLicense(action, key) {
  return postJson("/v1/license", { action, key });
}

function remember(status, key) {
  if (status && (status.machineLocked || status.banned)) {
    writeDeviceLock();
    return lockedStatus();
  }
  cache = {
    ok: Boolean(status.ok),
    expired: Boolean(status.expired),
    trial: Boolean(status.trial),
    badge: status.badge || (status.ok ? "已授权" : "未授权"),
    message: status.message || "",
    expires: status.expires || "",
    mustExit: Boolean(status.mustExit),
    machineLocked: false
  };
  if (cache.ok) clearDeviceLock();
  const local = readLocal();
  writeLocal({
    key: key || local.key || "",
    machineId: machineId(),
    expires: cache.expires || local.expires || "",
    lastOkAt: cache.ok ? Date.now() : Number(local.lastOkAt || 0),
    lastError: cache.ok ? "" : cache.message
  });
  return publicStatus();
}

async function reportTamper(detail = {}) {
  writeDeviceLock();
  try {
    await postJson("/v1/tamper-report", {
      reason: "integrity",
      files: detail.files || undefined
    }, 8000);
  } catch {}
  return lockedStatus();
}

async function assertMachineAllowed() {
  if (readDeviceLock()) {
    try {
      const remote = await postJson("/v1/machine-status", {}, 8000);
      if (!remote.banned && !remote.machineLocked) {
        clearDeviceLock();
        return { ok: true, machineLocked: false, mustExit: false };
      }
    } catch {}
    return lockedStatus();
  }
  try {
    const remote = await postJson("/v1/machine-status", {}, 8000);
    if (remote.banned || remote.machineLocked) {
      writeDeviceLock();
      return lockedStatus();
    }
  } catch {}
  return { ok: true, machineLocked: false, mustExit: false };
}

async function refresh(action = "heartbeat", force = false) {
  if (readDeviceLock()) return lockedStatus();
  if (!force && cache.ok && Date.now() - lastRefreshAt < (LICENSE_TEST ? 5000 : 8 * 60 * 1000)) return publicStatus();
  const local = readLocal();
  const key = String(local.key || "").trim();
  if (!key) {
    cache = { ok: false, expired: false, trial: false, badge: "未激活", message: "请输入购买时的卡密", mustExit: false };
    return publicStatus();
  }
  try {
    const remote = await postLicense(action, key);
    lastRefreshAt = Date.now();
    return remember(remote, key);
  } catch (error) {
    if (applyLocalGrace()) {
      cache.message = `${error.message}，请尽快恢复联网，否则软件会退出`;
      cache.mustExit = false;
      return publicStatus();
    }
    const hadLicense = Number(readLocal().lastOkAt || 0) > 0;
    cache = {
      ok: false,
      expired: false,
      trial: false,
      badge: "未授权",
      message: hadLicense ? `${error.message}，无法校验正版，软件将退出` : error.message,
      mustExit: hadLicense
    };
    return publicStatus();
  }
}

async function activate(rawKey) {
  const key = String(rawKey || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!key) {
    cache = { ok: false, expired: false, trial: false, badge: "未激活", message: "请输入卡密" };
    return publicStatus();
  }
  writeLocal({ ...readLocal(), key });
  lastRefreshAt = 0;
  return refresh("activate", true);
}

function current() {
  return publicStatus();
}

function assertLicensed() {
  if (cache.ok) return;
  const error = new Error(cache.message || "软件未授权，请先激活");
  error.code = "LICENSE_REQUIRED";
  throw error;
}

function broadcast(win) {
  const payload = publicStatus();
  const stamp = JSON.stringify(payload);
  if (stamp === lastBroadcast) return payload;
  lastBroadcast = stamp;
  try { win && !win.isDestroyed() && win.webContents.send("license-status-updated", payload); } catch {}
  return payload;
}

module.exports = {
  LICENSE_SERVER,
  APP_TOKEN,
  SOFTWARE_SEAL,
  LICENSE_TEST,
  WATCH_MS,
  LOCKED_MESSAGE,
  setLicensePath,
  activate,
  refresh,
  current,
  assertLicensed,
  broadcast,
  machineId,
  reportTamper,
  assertMachineAllowed
};
