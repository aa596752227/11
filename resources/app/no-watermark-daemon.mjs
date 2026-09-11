// 元画布 V46 内置无水印素材捕获服务。
// 独立于原生生成/回填流程：捕获失败不会影响画布任务。
// 1) 发现页面目标并注入 user.js（当前文档 + 未来导航）
// 2) 轮询 window.__dbnw 领取任务：decrypt(qAAB 视频解密) / download(无水印文件下载)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { ensureH264Mp4 } = require("./video-compat.js");
const { assertRunning, currentSignal, delay: taskDelay } = require("./task-runtime.js");

const PORT = Number(process.env.DBNW_PORT || 9705);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const USER_JS = path.join(HERE, "no-watermark-user.js");
const SAVE_DIR = process.env.DBNW_SAVE_DIR ? path.resolve(process.env.DBNW_SAVE_DIR) : path.join(os.homedir(), "Downloads", "DoubaoNoWatermark");
const HIDE_PAGE_UI = process.env.DBNW_HIDE_PAGE_UI !== "0";
const POLL_MS = 2000;
const TASK_POLL_MS = 700;
const FAIL_EXIT = 90;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const SALT_B64 = "TdTC5rgxYgkOUrPHpnM7pByyRiuCmrWKGWs521cXdST0m69/COjWjSanLjfBqVovHwWlGJKu8pSXMrYqOKrdWA==";

fs.mkdirSync(SAVE_DIR, { recursive: true });
const CAPTURE_LOG = path.join(SAVE_DIR, "捕获日志.log");
function daemonLog(message) {
  console.log(message);
  try { fs.appendFileSync(CAPTURE_LOG, `${new Date().toISOString()} ${message}\n`, "utf8"); } catch {}
}
daemonLog(`[daemon] save dir: ${SAVE_DIR}`);

// ---------- CDP 基础 ----------
function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error("ws connect fail"));
  });
}

let msgId = 0;
const pending = new Map();
function attachCall(ws, onEvent = () => {}) {
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result,m.error);
      pending.delete(m.id);
    } else if (m.method) onEvent(m);
  });
}
const CALL_TIMEOUT_MS = 15000;
function call(ws, method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    const timer = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`CDP timeout: ${method}`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, (result,error) => {
      clearTimeout(timer);
      if(error)rej(new Error(error.message||'CDP error'));else res(result);
    });
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      rej(e);
    }
  });
}

async function evaluate(ws, expression) {
  const r = await call(ws, "Runtime.evaluate", { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "evaluate exception");
  return r.result?.value;
}

// ---------- 注入 ----------
const active = new Map(); // targetId -> {ws, url, acks:[], busy}
const captureContexts = new Map(); // jobId -> {jobId,targetIds[],pageUrl,armedAt}
const TARGET_BASELINE_MS = 5000;

function isInternalDoubaoTarget(url) {
  return /^(?:doubao|chrome):\/\/doubao-(?:chat|background|launcher)\//i.test(String(url || ""));
}

async function applyCaptureContexts(targetId, entry = active.get(targetId)) {
  if (!entry || entry.ws.readyState !== 1) return false;
  const contexts = [...captureContexts.values()].filter(context => context.targetIds.includes(targetId));
  const payload = JSON.stringify(contexts);
  await evaluate(entry.ws, `(window.__dbnw && window.__dbnw.setCaptureContexts) ? window.__dbnw.setCaptureContexts(${JSON.stringify(payload)}) : 0`);
  return true;
}

async function injectTarget(t) {
  let ws;
  try { ws = await connect(t.webSocketDebuggerUrl); } catch { return; }
  const entry = { ws, url: t.url, acks: [], busy: false, injectedAt: Date.now() };
  attachCall(ws, message => {
    if (message.method !== "Network.webSocketFrameReceived") return;
    const payload = message.params?.response?.payloadData;
    if (typeof payload !== "string" || !/creation|video|fallback_api|main_url|key_seed/i.test(payload)) return;
    evaluate(ws, `(window.__dbnw && window.__dbnw.ingestNetworkPayload) ? window.__dbnw.ingestNetworkPayload(${JSON.stringify(payload)}, "cdp-ws") : false`).catch(() => {});
  });
  active.set(t.id, entry);
  const drop = () => active.delete(t.id);
  ws.onclose = drop;
  ws.onerror = drop;
  try {
    const src = fs.readFileSync(USER_JS, "utf8");
    await call(ws, "Page.enable");
    await call(ws, "Network.enable");
    const installed = await call(ws, "Page.addScriptToEvaluateOnNewDocument", { source: src });
    entry.scriptId = installed?.identifier || "";
    await call(ws, "Runtime.evaluate", { expression: src });
    if (HIDE_PAGE_UI) {
      await call(ws, "Runtime.evaluate", { expression: `(() => { try{window.__dbnwHideObserver?.disconnect()}catch{};const hide=()=>{const ui=document.getElementById('dbnw-ui');if(ui)ui.style.display='none'};hide();window.__dbnwHideObserver=new MutationObserver(hide);window.__dbnwHideObserver.observe(document.documentElement,{childList:true,subtree:true});return true })()` });
    }
    await applyCaptureContexts(t.id, entry);
    daemonLog(`[daemon] injected: ${t.url}`);
  } catch (e) {
    daemonLog(`[daemon] inject fail: ${t.url} ${e.message}`);
    drop();
    try { ws.close(); } catch {}
  }
}

async function detachTarget(targetId) {
  const entry = active.get(targetId);
  if (!entry) return false;
  active.delete(targetId);
  try { await call(entry.ws, "Runtime.evaluate", { expression: `(() => { try{window.__dbnwHideObserver?.disconnect()}catch{};try{return window.__dbnw?.dispose?.()!==false}catch{return false} })()` }); } catch {}
  try { if (entry.scriptId) await call(entry.ws, "Page.removeScriptToEvaluateOnNewDocument", { identifier: entry.scriptId }); } catch {}
  try { entry.ws.close(); } catch {}
  return true;
}

// ---------- 视频解密 ----------
function b64d(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  s += "=".repeat((4 - (s.length % 4)) % 4);
  return new Uint8Array(Buffer.from(s, "base64"));
}
const SALT = b64d(SALT_B64);

async function decryptQaab(mainB64, seedB64) {
  const ct = b64d(mainB64).subarray(4);
  const seed = b64d(seedB64);
  const h1 = new Uint8Array(await crypto.subtle.digest("SHA-512", seed));
  const km = new Uint8Array(128);
  km.set(h1, 0);
  km.set(SALT, 64);
  const derived = new Uint8Array(await crypto.subtle.digest("SHA-512", km));
  const key = await crypto.subtle.importKey("raw", derived.subarray(0, 16), { name: "AES-CBC" }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-CBC", iv: derived.subarray(16, 32) }, key, ct);
  return new TextDecoder().decode(pt).trim();
}

// ---------- 下载 ----------
let saveDir = SAVE_DIR;
const reservedPaths = new Set();
const globalTaskRuns = new Map();

function sanitize(name) {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 120);
}
function uniqPath(dir, name) {
  let p = path.join(dir, name);
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  for (let i = 2; fs.existsSync(p) || reservedPaths.has(p.toLowerCase()); i++) p = path.join(dir, `${base} (${i})${ext}`);
  reservedPaths.add(p.toLowerCase());
  return p;
}

async function download(task) {
  const headers = { "User-Agent": UA };
  if (!task.noReferer) headers["Referer"] = "https://www.doubao.com/";
  fs.mkdirSync(saveDir, { recursive: true });
  const out = uniqPath(saveDir, sanitize(task.filename));
  const extension = path.extname(out) || ".bin";
  const incoming = path.join(saveDir, `.dbnw-incoming-${crypto.randomUUID()}${extension}`);
  try {
    const signal=currentSignal()?AbortSignal.any([currentSignal(),AbortSignal.timeout(300000)]):AbortSignal.timeout(300000);
    const res = await fetch(task.url, { headers, redirect: "follow", signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body),fs.createWriteStream(incoming),{signal});
    assertRunning();
    if (/\.mp4$/i.test(out)) {
      await ensureH264Mp4(incoming, message => daemonLog(`[daemon] ${message}`));
    }
    assertRunning();
    fs.renameSync(incoming, out);
    const size = fs.statSync(out).size;
    return { size, path: out };
  } catch (error) {
    if (fs.existsSync(incoming)) {
      try {
        const failedFolder = path.join(saveDir, "转换失败-原始文件");
        fs.mkdirSync(failedFolder, { recursive: true });
        fs.renameSync(incoming, path.join(failedFolder, `${Date.now()}-${path.basename(out)}`));
      } catch {}
    }
    throw error;
  } finally {
    reservedPaths.delete(out.toLowerCase());
  }
}

async function runTask(task) {
  if (task.op === "decrypt") {
    const url = await decryptQaab(task.mainUrl, task.keySeed);
    daemonLog(`[daemon] decrypted video -> ${url.slice(0, 100)}`);
    return { id: task.id, decryptUrl: url };
  }
  const { size, path } = await download(task);
  daemonLog(`[daemon] saved ${path} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  return { id: task.id, ok: true, size, filename: path.split(/[\\/]/).pop(), savedPath: path };
}

function globalTaskKey(task) {
  if (task.op === "download") {
    return `download:${path.resolve(saveDir).toLowerCase()}:${sanitize(String(task.filename || "video.mp4")).toLowerCase()}`;
  }
  if (task.op === "decrypt") {
    const digest = createHash("sha256").update(String(task.mainUrl || "")).update("\0").update(String(task.keySeed || "")).digest("hex");
    return `decrypt:${digest}`;
  }
  return `${String(task.op || "unknown")}:${String(task.id || "")}`;
}

async function runTaskOnce(task) {
  const key = globalTaskKey(task);
  let running = globalTaskRuns.get(key);
  let duplicate = Boolean(running);
  if (!running && task.op === "download") {
    const existingPath = path.join(saveDir, sanitize(String(task.filename || "video.mp4")));
    if (fs.existsSync(existingPath)) {
      running = (async () => {
        if (/\.mp4$/i.test(existingPath)) await ensureH264Mp4(existingPath, message => daemonLog(`[daemon] ${message}`));
        const size = fs.statSync(existingPath).size;
        return { ok: true, size, filename: path.basename(existingPath), savedPath: existingPath, duplicate: true };
      })();
      duplicate = true;
    }
  }
  if (!running) {
    running = runTask(task);
    globalTaskRuns.set(key, running);
  }
  try {
    const result = await running;
    globalTaskRuns.set(key, Promise.resolve(result));
    if (duplicate) daemonLog(`[daemon] duplicate skipped ${task.op} ${String(task.filename || task.id || "").slice(0, 120)}`);
    return { ...result, id: task.id, duplicate: duplicate || Boolean(result.duplicate) };
  } catch (error) {
    if (globalTaskRuns.get(key) === running) globalTaskRuns.delete(key);
    throw error;
  }
}

// Invoked only after the controller has bound a completed message to an original job.
// There is no page-wide scan and no automatic historical-media enumeration here.
export async function downloadBoundVideo({mainUrl,keySeed,videoId,jobId}) {
  assertRunning();
  if(!/^DB-[A-Za-z0-9-]{1,80}$/.test(jobId||'')||!/^[A-Za-z0-9_-]{5,120}$/.test(videoId||''))throw new Error('缺少有效的任务和视频编号');
  let url=String(mainUrl||'');
  if(!/^https?:\/\//i.test(url)){
    let plain='';try{plain=Buffer.from(url.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8');}catch{}
    if(/^https?:\/\//i.test(plain))url=plain;
    else {if(!keySeed)throw new Error('本任务视频缺少解密参数');url=await decryptQaab(url,keySeed);}
  }
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||!/(?:^|\.)(?:doubaocdn\.com|bytecdn\.cn|bytecdn\.com|byteimg\.com|ibytedtos\.com|ibyted-vod\.com|bytedance\.com|doubao\.com|douyin\.com|volcvod\.com|volccdn\.com|vcloud\.com|toutiaovod\.com)$/.test(parsed.hostname))throw new Error('本任务视频地址校验未通过');
  assertRunning();
  const task={id:jobId,op:'download',url,filename:'db_video_'+videoId+'.mp4',noReferer:true};
  const key=globalTaskKey(task),cached=globalTaskRuns.get(key);
  if(cached){const previous=await cached.catch(()=>null);if(!previous?.savedPath||!fs.existsSync(previous.savedPath))globalTaskRuns.delete(key);}
  const result=await runTaskOnce(task);
  return {...result,jobId,videoId};
}

async function pollTarget(entry) {
  if (entry.busy) return;
  entry.busy = true;
  try {
    const acksArg = entry.acks.length ? JSON.stringify(JSON.stringify(entry.acks)) : "null";
    const expr = `(window.__dbnw && window.__dbnw.poll) ? window.__dbnw.poll(${acksArg}) : null`;
    entry.acks = [];
    const raw = await evaluate(entry.ws, expr);
    if (raw) {
      const obj = JSON.parse(raw);
      const tasks = Array.isArray(obj) ? obj : obj.tasks || [];
      if (obj && obj.dir && obj.dir !== saveDir) {
        try {
          fs.mkdirSync(obj.dir, { recursive: true });
          saveDir = obj.dir;
          daemonLog(`[daemon] save dir -> ${saveDir}`);
        } catch (e) {
          daemonLog(`[daemon] 目录不可用 ${obj.dir}: ${e.message}，沿用 ${saveDir}`);
        }
      }
      if (tasks.length) {
        const queue = [...tasks];
        const n = Math.min(3, queue.length);
        await Promise.all(Array.from({ length: n }, async () => {
          for (;;) {
            const task = queue.shift();
            if (!task) return;
            try {
              if (task.op === "download") entry.acks.push({ id: task.id, status: "downloading", size: 0 });
              const r = await runTaskOnce(task);
              entry.acks.push(r);
            } catch (e) {
              daemonLog(`[daemon] task fail: ${e.message || e}`);
              entry.acks.push({ id: task.id, ok: false, error: String(e.message || e).slice(0, 120) });
            }
          }
        }));
      }
    }
  } catch {
    // 上下文销毁时 ws 会关闭，由 onclose 清理
  } finally {
    entry.busy = false;
  }
}

// ---------- 主循环 ----------
let fails = 0;
let discoveryTimer = null;
let taskTimer = null;

async function discoverTargets() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    if (!res.ok) throw new Error("http " + res.status);
    const targets = await res.json();
    fails = 0;
    for (const t of targets) {
      if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
      if (!isInternalDoubaoTarget(t.url)) continue;
      const cur = active.get(t.id);
      if (cur && cur.ws.readyState === 1) continue;
      active.delete(t.id);
      await injectTarget(t);
    }
  } catch {
    fails = Math.min(FAIL_EXIT, fails + 1);
  }
}

function pollTargets() {
  for (const entry of active.values()) {
    if (entry.ws.readyState === 1) pollTarget(entry).catch(() => {});
  }
}

export function startNoWatermarkDaemon(options = {}) {
  if(options.taskBoundOnly){
    daemonLog('[daemon] task-bound mode: only verified result IDs can download; passive history capture is disabled');
    return;
  }
  if (discoveryTimer || taskTimer) return;
  daemonLog(`[daemon] watching CDP 127.0.0.1:${PORT}, payload: ${USER_JS}`);
  discoverTargets().catch(() => {});
  discoveryTimer = setInterval(() => discoverTargets().catch(() => {}), POLL_MS);
  taskTimer = setInterval(pollTargets, TASK_POLL_MS);
}

export async function armNoWatermarkCapture(context = {}) {
  assertRunning();
  const jobId = String(context.jobId || "");
  const targetId = String(context.targetId || "");
  if (!jobId || !targetId) return false;
  try { await discoverTargets(); } catch {}
  assertRunning();
  const primary = active.get(targetId);
  if (primary) {
    const waitMs = Math.max(0, primary.injectedAt + TARGET_BASELINE_MS - Date.now());
    if (waitMs) await taskDelay(waitMs);
  }
  const now = Date.now();
  assertRunning();
  const targetIds = [...active.entries()]
    .filter(([id, entry]) => id === targetId || now - entry.injectedAt >= TARGET_BASELINE_MS)
    .map(([id]) => id);
  if (!targetIds.includes(targetId) && active.has(targetId)) targetIds.push(targetId);
  captureContexts.set(jobId, {
    jobId,
    targetIds,
    pageUrl: String(context.pageUrl || ""),
    armedAt: Number(context.armedAt || Date.now())
  });
  let applied = false;
  for (const id of targetIds) {
    try { applied = (await applyCaptureContexts(id)) || applied; } catch {}
  }
  return applied;
}

export async function disarmNoWatermarkCapture(jobId) {
  const key = String(jobId || "");
  const previous = captureContexts.get(key);
  captureContexts.delete(key);
  if (!previous) return false;
  for (const targetId of previous.targetIds) {
    try { await applyCaptureContexts(targetId); } catch {}
  }
  return true;
}

export async function stopNoWatermarkDaemon() {
  if (discoveryTimer) clearInterval(discoveryTimer);
  if (taskTimer) clearInterval(taskTimer);
  discoveryTimer = null;
  taskTimer = null;
  captureContexts.clear();
  for (const targetId of [...active.keys()]) await detachTarget(targetId);
}
