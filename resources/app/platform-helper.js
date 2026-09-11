const SOFTWARE_SEAL = "JXPB-HP-3c7f18d2a90b4e61";
void SOFTWARE_SEAL;
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const ENDPOINTS = {
  doubaoSkillPack: "doubao.com/samantha/skill/pack",
  dolaSkillPack: "dola.com/samantha/skill/pack",
  actionBarConfig: ".com/alice/slot/action_bar_v3/get_item_conf",
  doubaoChainSingle: "doubao.com/im/chain/single",
  dolaChainSingle: "dola.com/im/chain/single"
};
const DURATION_LABELS = new Set(["时长", "鏃堕暱", "閺冨爼鏆?"]);
const INJECTED_DURATIONS = [5, 10, 15, 30];
const QAAB_SALT_HEX = "4dd4c2e6b83162090e52b3c7a6733ba4"
  + "1cb2462b829ab58a196b39db57177524"
  + "f49baf7f08e8d68d26a72e37c1a95a2f"
  + "1f05a51892aef2949732b62a38aadd58";
const UNWATERMARK_QUERY = { channel: "no", codec_type: "8", logo_type: "unwatermarked" };
const PAGE_VIDEO_URL_KEYS = new Set([
  "main_url", "play_url", "man_url", "download_url", "downloadUrl",
  "origin_video", "origin_video_url", "video_url", "ori_url", "playUrl", "videoUrl"
]);
const FETCH_PATTERNS = [
  { urlPattern: `*${ENDPOINTS.doubaoSkillPack}*`, requestStage: "Request" },
  { urlPattern: `*${ENDPOINTS.dolaSkillPack}*`, requestStage: "Request" },
  { urlPattern: `*${ENDPOINTS.actionBarConfig}*`, requestStage: "Response" },
  { urlPattern: `*${ENDPOINTS.doubaoChainSingle}*`, requestStage: "Response" },
  { urlPattern: `*${ENDPOINTS.dolaChainSingle}*`, requestStage: "Response" }
];

const attached = new Map();
const videosByContents = new Map();
const skillBodies = {
  "doubao-skill-pack-response.json": null,
  "dola-skill-pack-response.json": null
};

function loadSkillBody(fileName) {
  if (!skillBodies[fileName]) {
    skillBodies[fileName] = fs.readFileSync(path.join(__dirname, "platform-helper", fileName), "utf8");
  }
  return skillBodies[fileName];
}

function send(guest, method, params = {}) {
  return guest.debugger.sendCommand(method, params);
}

function continueRequest(guest, requestId) {
  return send(guest, "Fetch.continueRequest", { requestId }).catch(() => {});
}

function corsHeaders() {
  return [
    { name: "access-control-allow-origin", value: "*" },
    { name: "access-control-allow-credentials", value: "true" },
    { name: "access-control-allow-methods", value: "GET, POST, OPTIONS" },
    { name: "access-control-allow-headers", value: "*" }
  ];
}

function toBase64Utf8(text) {
  return Buffer.from(String(text || ""), "utf8").toString("base64");
}

function fromBase64Utf8(text) {
  return Buffer.from(String(text || ""), "base64").toString("utf8");
}

function responseHeadersForTextBody(headers, body) {
  const contentLength = String(Buffer.byteLength(body, "utf8"));
  const nextHeaders = [];
  let hasContentType = false;
  let hasContentLength = false;
  for (const header of headers || []) {
    const name = header.name || "";
    const lowerName = name.toLowerCase();
    if (lowerName === "content-encoding") continue;
    if (lowerName === "content-type") {
      hasContentType = true;
      nextHeaders.push({ name, value: "application/json; charset=utf-8" });
      continue;
    }
    if (lowerName === "content-length") {
      hasContentLength = true;
      nextHeaders.push({ name, value: contentLength });
      continue;
    }
    nextHeaders.push(header);
  }
  if (!hasContentType) nextHeaders.push({ name: "content-type", value: "application/json; charset=utf-8" });
  if (!hasContentLength) nextHeaders.push({ name: "content-length", value: contentLength });
  return nextHeaders;
}

async function fulfillJsonFile(guest, requestId, method, fileName) {
  if (String(method || "").toUpperCase() === "OPTIONS") {
    await send(guest, "Fetch.fulfillRequest", {
      requestId, responseCode: 204, responsePhrase: "No Content", responseHeaders: corsHeaders()
    });
    return;
  }
  const body = loadSkillBody(fileName);
  await send(guest, "Fetch.fulfillRequest", {
    requestId,
    responseCode: 200,
    responsePhrase: "OK",
    responseHeaders: responseHeadersForTextBody(corsHeaders(), body),
    body: toBase64Utf8(body)
  });
}

async function getPausedResponseBody(guest, requestId) {
  const response = await send(guest, "Fetch.getResponseBody", { requestId });
  return { body: response.base64Encoded ? fromBase64Utf8(response.body) : response.body };
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function isPlayInfoApiUrl(url) {
  const href = String(url || "");
  return /\/video\/fplay\//i.test(href)
    || /\/media\/get_play_info/i.test(href)
    || /vod-urls[^/]*\.byteintlapi\.com\/video/i.test(href);
}

function setQueryParamPreserve(url, key, value) {
  const href = String(url || "");
  const hash = href.indexOf("#");
  const base = hash >= 0 ? href.slice(0, hash) : href;
  const frag = hash >= 0 ? href.slice(hash) : "";
  const encoded = encodeURIComponent(value);
  const re = new RegExp(`([?&])${key}=[^&#]*`, "i");
  if (re.test(base)) return base.replace(re, `$1${key}=${encoded}`) + frag;
  const join = base.includes("?") ? "&" : "?";
  return `${base}${join}${key}=${encoded}${frag}`;
}

function withUnwatermarkParams(url) {
  if (!isPlayInfoApiUrl(url)) return String(url || "");
  let next = String(url || "");
  for (const [key, value] of Object.entries(UNWATERMARK_QUERY)) next = setQueryParamPreserve(next, key, value);
  return next;
}

function rewriteCiciPreviewUrl(url) {
  return String(url || "")
    .replace(/([?&]lr=)cici_ai\b/ig, "$1unwatermarked")
    .replace(/([?&]lr=)watermarked\b/ig, "$1unwatermarked");
}

function shouldRewriteLogoType(url) {
  if (typeof url !== "string" || !url.includes("logo_type=")) return false;
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("logo_type") !== "unwatermarked"
      || parsed.searchParams.get("channel") !== "no"
      || parsed.searchParams.get("codec_type") !== "8";
  } catch {
    return !/[?&]logo_type=unwatermarked(?:&|$)/i.test(url);
  }
}

function isWatermarkedMediaUrl(url) {
  const href = String(url || "");
  if (/^blob:/i.test(href)) return true;
  if (/\/tos-[^/?#]*-ve-/i.test(href)) return true;
  if (/[?&]lr=(?:cici_ai|watermarked)\b/i.test(href)) return true;
  if (/[?&]logo_type=watermarked\b/i.test(href)) return true;
  if (/\/video\/tos\//i.test(href) && !/[?&]lr=unwatermarked\b/i.test(href)) return true;
  return false;
}

function isPlayerPreviewUrl(url) {
  const href = String(url || "");
  if (isPlayInfoApiUrl(href)) return true;
  return isWatermarkedMediaUrl(href);
}

function parseJsonString(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

function walkJsonAndStrings(value, visitor, seen = new Set()) {
  if (value == null) return;
  if (typeof value === "string") {
    const parsed = parseJsonString(value);
    if (parsed !== null) walkJsonAndStrings(parsed, visitor, seen);
    return;
  }
  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  visitor(value);
  if (Array.isArray(value)) {
    for (const item of value) walkJsonAndStrings(item, visitor, seen);
    return;
  }
  for (const key of Object.keys(value)) walkJsonAndStrings(value[key], visitor, seen);
}

function findValuesByKey(value, targetKey) {
  const values = [];
  walkJsonAndStrings(value, node => {
    if (node && typeof node === "object" && !Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, targetKey)) {
      values.push(node[targetKey]);
    }
  });
  return values;
}

function findImageOriRawUrls(value) {
  const urls = [];
  walkJsonAndStrings(value, node => {
    const image = node && node.image_ori_raw;
    if (image && typeof image === "object" && isHttpUrl(image.url)) urls.push(image.url);
  });
  return urls;
}

function decodeJsonEscapedFragment(value) {
  let text = String(value || "");
  for (let index = 0; index < 3; index += 1) {
    try {
      const decoded = JSON.parse(`"${text.replace(/"/g, '\\"')}"`);
      if (decoded === text) break;
      text = decoded;
    } catch { break; }
  }
  return text.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
}

function normalizeFallbackApi(value) {
  return String(value || "").trim()
    .replace(/\\u0026/gi, "&")
    .replace(/&amp;/gi, "&")
    .replace(/\\\//g, "/");
}

function flattenNetworkText(text) {
  return String(text || "")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\{1,2}"/g, '"')
    .replace(/\\\//g, "/");
}

function addFallbackApi(apis, value) {
  if (typeof value !== "string" || !value) return;
  const url = normalizeFallbackApi(value);
  if (isHttpUrl(url) && /\/video\/fplay\//i.test(url)) apis.add(url);
}

function findDoubaoFallbackApis(json, rawBody) {
  const apis = new Set();
  for (const value of findValuesByKey(json, "fallback_api")) addFallbackApi(apis, value);
  const sources = [String(rawBody || ""), flattenNetworkText(rawBody)];
  const patterns = [/fallback_api\\":\\"(.*?)\\"/g, /"fallback_api"\s*:\s*"(https:[^"]+)"/g];
  for (const source of sources) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match = pattern.exec(source);
      while (match) {
        addFallbackApi(apis, decodeJsonEscapedFragment(match[1]));
        match = pattern.exec(source);
      }
    }
  }
  return [...apis];
}

function replaceQueryParams(url, params) {
  const parsedUrl = new URL(url);
  for (const [key, value] of Object.entries(params)) parsedUrl.searchParams.set(key, value);
  return parsedUrl.toString();
}

function getVideoData(payload) {
  const parseMaybe = value => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
    try { return JSON.parse(trimmed); } catch { return value; }
  };
  let videoInfo = parseMaybe(payload?.video_info || payload?.data?.video_info || payload);
  let data = parseMaybe(videoInfo?.data || videoInfo);
  if (data && typeof data === "object" && typeof data.video_list === "string") {
    data = { ...data, video_list: parseMaybe(data.video_list) };
  }
  return data && typeof data === "object" ? data : {};
}

function pickMainUrlToken(data) {
  const videoList = data?.video_list;
  const entries = videoList && typeof videoList === "object" && Object.keys(videoList).length ? Object.values(videoList) : [data];
  let best = null;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const token = entry.main_url || entry.play_url || "";
    if (typeof token !== "string" || !token.trim()) continue;
    const score = Number(entry.bitrate || entry.real_bitrate || 0)
      + Number(entry.vwidth || entry.width || 0) * Number(entry.vheight || entry.height || 0);
    if (!best || score > best.score) best = { token: token.trim(), score };
  }
  return best ? best.token : "";
}

function findKeySeedDeep(value, depth = 0) {
  if (depth > 10 || value == null) return "";
  if (typeof value === "string") {
    let match = value.match(/(?:^|[?&])key_seed=([^&"'<>\\\s]+)/i);
    if (match) return decodeURIComponent(match[1]);
    match = value.match(/["']key_seed["']\s*:\s*["']([^"']+)/i);
    return match ? decodeURIComponent(match[1]) : "";
  }
  if (typeof value !== "object") return "";
  if (typeof value.key_seed === "string" && value.key_seed.trim()) return value.key_seed.trim();
  for (const item of Object.values(value)) {
    const hit = findKeySeedDeep(item, depth + 1);
    if (hit) return hit;
  }
  return "";
}

function padBase64(text) {
  const pad = (4 - (text.length % 4)) % 4;
  return text + "=".repeat(pad);
}

function base64DecodeLoose(text) {
  const input = String(text || "").trim();
  const variants = [
    input,
    input.replace(/[$@#]/g, char => ({ $: "_", "@": "/", "#": "." }[char])),
    input.replace(/[$@#]/g, char => ({ $: "+", "@": "/", "#": "=" }[char]))
  ];
  const seen = new Set();
  for (const candidate of variants) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      return Uint8Array.from(Buffer.from(padBase64(candidate).replace(/-/g, "+").replace(/_/g, "/"), "base64"));
    } catch {}
  }
  return null;
}

function asciiUrlFromBytes(bytes) {
  if (!bytes || !bytes.length) return "";
  const text = Buffer.from(bytes).toString("utf8").replace(/\u0000+$/g, "").trim();
  const match = text.match(/https?:\/\/[^\s"'<>\\]+/i);
  const url = match ? match[0] : text;
  if (!isHttpUrl(url)) return "";
  for (let index = 0; index < Math.min(url.length, 2048); index += 1) {
    const code = url.charCodeAt(index);
    if (code < 32 || code > 126) return "";
  }
  return url;
}

function tryDecodeBase64Url(token) {
  const bytes = base64DecodeLoose(token);
  if (!bytes) return "";
  const text = asciiUrlFromBytes(bytes);
  return isHttpUrl(text) ? text : "";
}

function decryptAesCbcUrl(payload, keyBytes, ivBytes) {
  if (!payload.length || payload.length % 16 !== 0) return "";
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", Buffer.from(keyBytes), Buffer.from(ivBytes));
    const plain = Buffer.concat([decipher.update(Buffer.from(payload)), decipher.final()]);
    const direct = asciiUrlFromBytes(plain);
    if (isHttpUrl(direct)) return direct;
    const url = asciiUrlFromBytes(plain);
    return isHttpUrl(url) ? url : "";
  } catch {
    return "";
  }
}

function qaabKeyPairs(seed) {
  const salt = Buffer.from(QAAB_SALT_HEX, "hex");
  const parts = [seed, seed.slice(0, 32)];
  const pairs = [];
  const seen = new Set();
  for (const part of parts) {
    if (!part || !part.length) continue;
    const mark = Buffer.from(part).toString("hex");
    if (seen.has(mark)) continue;
    seen.add(mark);
    const digest1 = crypto.createHash("sha512").update(Buffer.from(part)).digest();
    const digest2 = crypto.createHash("sha512").update(Buffer.concat([digest1, salt])).digest();
    pairs.push({ key: digest2.subarray(0, 16), iv: digest2.subarray(16, 32) });
  }
  return pairs;
}

function decodeQaabToken(token, keySeed) {
  const data = base64DecodeLoose(token);
  const seed = base64DecodeLoose(keySeed);
  if (!data || !seed) return "";
  const payloads = [];
  if (data.length > 4) payloads.push(data.slice(4));
  payloads.push(data);
  if (data.length > 36) payloads.push(data.slice(36));
  for (const pair of qaabKeyPairs(seed)) {
    for (const payload of payloads) {
      const url = decryptAesCbcUrl(payload, pair.key, pair.iv) || decryptAesCbcUrl(payload, pair.iv, pair.key);
      if (url) return url;
    }
  }
  return "";
}

function decodeMainUrl(token, keySeed = "") {
  if (isHttpUrl(token)) return isPlayerPreviewUrl(token) ? "" : token;
  if (String(token || "").startsWith("qAAB") && keySeed) {
    const url = decodeQaabToken(token, keySeed);
    if (url && !isPlayerPreviewUrl(url)) return url;
  }
  const plainUrl = tryDecodeBase64Url(token);
  if (plainUrl && !isPlayerPreviewUrl(plainUrl)) return plainUrl;
  if (keySeed) {
    const url = decodeQaabToken(token, keySeed);
    if (url && !isPlayerPreviewUrl(url)) return url;
  }
  return "";
}

function fallbackApiVariants(fallbackApi) {
  const raw = String(fallbackApi || "").trim();
  if (!raw) return [];
  const unmarked = withUnwatermarkParams(raw);
  return unmarked && unmarked !== raw ? [unmarked, raw] : [raw];
}

function refererForFallback(url) {
  return /dola\.com|byteintlapi|\/mya\//i.test(String(url || "")) ? "https://www.dola.com/" : "https://www.doubao.com/";
}

function nodeGetText(url, headers) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const requestPath = String(url).replace(/^https?:\/\/[^/?#]+/i, "") || "/";
    const lib = target.protocol === "http:" ? http : https;
    const request = lib.request({
      method: "GET",
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "http:" ? 80 : 443),
      path: requestPath,
      headers
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        ok: Number(response.statusCode) >= 200 && Number(response.statusCode) < 300,
        status: response.statusCode,
        text: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("timeout", () => { request.destroy(); reject(new Error("timeout")); });
    request.on("error", reject);
    request.setTimeout(25000);
    request.end();
  });
}

async function fetchJsonText(url, guest) {
  const headers = {
    Accept: "application/json,text/plain,*/*",
    Referer: refererForFallback(url),
    Origin: refererForFallback(url).replace(/\/$/, ""),
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
  };
  try {
    const box = await nodeGetText(url, headers);
    if (box && box.text) return box;
  } catch {}
  if (guest) {
    try { return await sessionGetText(guest, url); } catch {}
  }
  return null;
}

async function pageFetchFallback(guest, url) {
  if (!guest || guest.isDestroyed()) return "";
  try { await attach(guest); } catch {}
  const expression = `(window.__jxOrigFetch||fetch)(${JSON.stringify(String(url))}).then(r=>r.text()).catch(err=>'')`;
  const found = await send(guest, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return String(found && found.result && found.result.value || "");
}

async function getDoubaoVideoUrlFromFallbackApi(fallbackApi, guest) {
  const traces = [];
  for (const url of fallbackApiVariants(fallbackApi)) {
    try {
      let box = await fetchJsonText(url, guest);
      let payload = null;
      try { payload = box && box.text ? JSON.parse(box.text) : null; } catch { payload = null; }
      if (!payload || payload.code === 1 || !pickMainUrlToken(getVideoData(payload))) {
        const pageText = guest ? await pageFetchFallback(guest, url).catch(() => "") : "";
        if (pageText) {
          try { payload = JSON.parse(pageText); } catch {}
        }
      }
      const decoded = decodePayloadVideoUrl(payload, url);
      traces.push({
        urlLen: String(url).length,
        status: box && box.status,
        code: payload && payload.code,
        token: Boolean(pickMainUrlToken(getVideoData(payload))),
        decodedHost: decoded ? (() => { try { return new URL(decoded).hostname; } catch { return ""; } })() : "",
        preview: decoded ? isPlayerPreviewUrl(decoded) : false
      });
      if (decoded && !isPlayerPreviewUrl(decoded)) {
        try {
          fs.writeFileSync(path.join(__dirname, "..", "..", "数据", "fallback-trace.json"), JSON.stringify({ at: Date.now(), traces }, null, 2));
        } catch {}
        return decoded;
      }
    } catch (error) {
      traces.push({ urlLen: String(url).length, error: String(error && error.message || error) });
    }
  }
  try {
    fs.writeFileSync(path.join(__dirname, "..", "..", "数据", "fallback-trace.json"), JSON.stringify({ at: Date.now(), traces }, null, 2));
  } catch {}
  return "";
}

function addItem(items, seenUrls, type, url) {
  if (!isHttpUrl(url) || seenUrls.has(url)) return;
  seenUrls.add(url);
  items.push({ type, url });
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || !value) return "";
  if (isHttpUrl(value)) return value;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return isHttpUrl(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

function encodeUrlToken(url) {
  return Buffer.from(String(url || ""), "utf8").toString("base64");
}

function nextVideoUrl(videoUrls, used) {
  if (!videoUrls.length) return "";
  if (videoUrls.length === 1) return videoUrls[0];
  const url = videoUrls[Math.min(used.count, videoUrls.length - 1)];
  used.count += 1;
  return url;
}

function patchMediaFieldsInJson(value, videoUrls, used = { count: 0 }, seen = new Set()) {
  if (value == null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  let changed = false;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const child = value[index];
      if (typeof child === "string") {
        const parsed = parseJsonString(child);
        if (parsed && patchMediaFieldsInJson(parsed, videoUrls, used, seen)) {
          value[index] = JSON.stringify(parsed);
          changed = true;
        }
      } else {
        changed = patchMediaFieldsInJson(child, videoUrls, used, seen) || changed;
      }
    }
    return changed;
  }
  for (const key of Object.keys(value)) {
    const child = value[key];
    if (typeof child === "string") {
      if (key === "fallback_api" && isHttpUrl(child)) {
        const next = withUnwatermarkParams(child);
        if (next !== child) {
          value[key] = next;
          changed = true;
        }
        continue;
      }
      if (PAGE_VIDEO_URL_KEYS.has(key) && child) {
        const url = nextVideoUrl(videoUrls, used);
        if (url) {
          value[key] = isHttpUrl(child) ? url : encodeUrlToken(url);
          changed = true;
          continue;
        }
      }
      if (/[?&]lr=cici_ai\b/i.test(child)) {
        value[key] = rewriteCiciPreviewUrl(child);
        changed = true;
      }
      const parsed = parseJsonString(child);
      if (parsed && patchMediaFieldsInJson(parsed, videoUrls, used, seen)) {
        value[key] = JSON.stringify(parsed);
        changed = true;
      }
    } else {
      changed = patchMediaFieldsInJson(child, videoUrls, used, seen) || changed;
    }
  }
  return changed;
}

async function extractAllVideoItems(json, rawBody, guest) {
  const items = [];
  const seenUrls = new Set();
  const videoUrls = [];
  for (const url of findImageOriRawUrls(json)) addItem(items, seenUrls, "image", url);
  for (const fallbackApi of findDoubaoFallbackApis(json, rawBody)) {
    const videoUrl = await getDoubaoVideoUrlFromFallbackApi(fallbackApi);
    const videoId = videoIdentity(fallbackApi);
    const keySeed = findKeySeedDeep(json) || "";
    if (videoUrl && !isPlayerPreviewUrl(videoUrl)) {
      if (!seenUrls.has(videoUrl)) {
        seenUrls.add(videoUrl);
        videoUrls.push(videoUrl);
        items.push({ type: "video", url: videoUrl, fallbackApi, keySeed, videoId });
      }
    } else {
      items.push({ type: "video", url: "", fallbackApi, keySeed, videoId });
    }
  }
  for (const encodedUrl of [...findValuesByKey(json, "man_url"), ...findValuesByKey(json, "main_url")]) {
    let url = decodeBase64Url(encodedUrl) || decodeMainUrl(encodedUrl, findKeySeedDeep(json));
    if (url) url = rewriteCiciPreviewUrl(url);
    if (url && isHttpUrl(url) && !isWatermarkedMediaUrl(url) && !isPlayInfoApiUrl(url)) {
      videoUrls.push(url);
      addItem(items, seenUrls, "video", url);
    }
  }
  return items;
}

function createDurationOption(optionList, seconds) {
  const maxId = optionList.reduce((maxValue, option) => {
    const id = Number(option?.id);
    return Number.isFinite(id) ? Math.max(maxValue, id) : maxValue;
  }, 0);
  return { id: maxId + 1, display_text: `${seconds}s`, message_text: "", option_key: String(seconds) };
}

function ensureDurationOptions(optionList) {
  let changed = false;
  for (let i = 0; i < INJECTED_DURATIONS.length; i++) {
    const seconds = INJECTED_DURATIONS[i];
    const key = String(seconds);
    if (optionList.some(option => option && option.option_key === key)) continue;
    const prevKey = i > 0 ? String(INJECTED_DURATIONS[i - 1]) : "";
    const prevIndex = optionList.findIndex(option => option && option.option_key === prevKey);
    optionList.splice(prevIndex >= 0 ? prevIndex + 1 : optionList.length, 0, createDurationOption(optionList, seconds));
    changed = true;
  }
  return changed;
}

function mightContainDurationLabel(text) {
  return [...DURATION_LABELS].some(label => String(text || "").includes(label));
}

function isDurationSelector(value) {
  return value && typeof value.label === "string" && DURATION_LABELS.has(value.label);
}

function patchJsonStringDurationSafe(text) {
  if (!text || !mightContainDurationLabel(text)) return text;
  try {
    const json = JSON.parse(text);
    return patchDurationSelectorSafe(json) ? JSON.stringify(json) : text;
  } catch {
    return text;
  }
}

function patchDurationSelectorSafe(value, seen = new Set()) {
  if (value == null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  let changed = false;
  if (Array.isArray(value)) {
    for (const item of value) changed = patchDurationSelectorSafe(item, seen) || changed;
    return changed;
  }
  if (isDurationSelector(value) && Array.isArray(value.option_list)) changed = ensureDurationOptions(value.option_list) || changed;
  for (const key of Object.keys(value)) {
    const child = value[key];
    if (typeof child === "string") {
      const patchedString = patchJsonStringDurationSafe(child);
      if (patchedString !== child) { value[key] = patchedString; changed = true; }
    } else {
      changed = patchDurationSelectorSafe(child, seen) || changed;
    }
  }
  return changed;
}

function patchNestedJsonStrings(value, seen = new Set()) {
  if (value == null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  let changed = false;
  if (Array.isArray(value)) {
    for (const item of value) changed = patchNestedJsonStrings(item, seen) || changed;
    return changed;
  }
  for (const key of Object.keys(value)) {
    const child = value[key];
    if (typeof child === "string") {
      const patchedString = patchJsonStringDurationSafe(child);
      if (patchedString !== child) { value[key] = patchedString; changed = true; }
    } else {
      changed = patchNestedJsonStrings(child, seen) || changed;
    }
  }
  return changed;
}

function patchActionBarDuration(body) {
  try {
    const json = JSON.parse(body);
    return patchNestedJsonStrings(json) ? JSON.stringify(json) : body;
  } catch {
    return body;
  }
}

function videoIdentity(url) {
  const href = String(url || "").trim();
  if (!href) return "";
  const query = href.match(/[?&](?:video_id|vid)=([^&?#]+)/i);
  if (query) {
    try { return decodeURIComponent(query[1]).trim(); } catch { return String(query[1] || "").trim(); }
  }
  try {
    const parsed = new URL(href);
    const fromQuery = parsed.searchParams.get("video_id") || parsed.searchParams.get("vid") || parsed.searchParams.get("media_id") || "";
    if (fromQuery) return fromQuery.trim();
    const parts = parsed.pathname.split("/").filter(Boolean);
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const part = String(parts[index] || "").replace(/\.[a-z0-9]+$/i, "");
      if (/^v[0-9a-z]{8,}$/i.test(part)) return part;
    }
  } catch {}
  const hit = href.match(/v[0-9a-z]{10,}/i);
  return hit ? hit[0] : "";
}

function videoIdentityFromName(name) {
  const hit = String(name || "").match(/v[0-9a-z]{10,}/i);
  return hit ? hit[0] : "";
}

function recipeVideoId(item) {
  return String((item && item.videoId) || videoIdentity(item && item.fallbackApi) || videoIdentity(item && item.url) || "").trim();
}

function recipesSame(a, b) {
  const idA = recipeVideoId(a);
  const idB = recipeVideoId(b);
  if (idA && idB && idA === idB) return true;
  if (a && b && a.fallbackApi && b.fallbackApi && a.fallbackApi === b.fallbackApi) return true;
  if (a && b && a.url && b.url && a.url === b.url) return true;
  return false;
}

function rememberVideos(guest, items) {
  const incoming = Array.isArray(items) ? items : [];
  const prev = videosByContents.get(guest.id) || { videos: [], images: [], at: 0 };
  const videos = Array.isArray(prev.videos) ? [...prev.videos] : [];
  const images = Array.isArray(prev.images) ? [...prev.images] : [];
  for (const item of incoming) {
    if (!item) continue;
    if (item.type === "image" && isHttpUrl(item.url)) {
      if (!images.some(image => image.url === item.url)) images.push(item);
      continue;
    }
    const video = {
      type: "video",
      url: isHttpUrl(item.url) && !/^blob:/i.test(item.url) ? item.url : "",
      fallbackApi: isHttpUrl(item.fallbackApi) ? item.fallbackApi : "",
      keySeed: String(item.keySeed || ""),
      videoId: recipeVideoId(item),
      at: Number(item.at || 0) || Date.now()
    };
    if (!video.url && !video.fallbackApi) continue;
    const existing = videos.find(entry => recipesSame(entry, video));
    if (existing) {
      existing.url = video.url || existing.url;
      existing.fallbackApi = video.fallbackApi || existing.fallbackApi;
      existing.keySeed = video.keySeed || existing.keySeed;
      existing.videoId = video.videoId || existing.videoId;
      existing.at = existing.at || video.at;
    } else videos.push(video);
  }
  if (!videos.length && !images.length) return;
  videosByContents.set(guest.id, { at: Date.now(), videos: videos.slice(-20), images: images.slice(-20) });
}

function listStoredVideos(guest) {
  const record = guest && videosByContents.get(guest.id);
  if (!record || Date.now() - record.at > 90 * 60 * 1000) return [];
  return (Array.isArray(record.videos) ? record.videos : []).map(item => ({
    ...item,
    videoId: recipeVideoId(item),
    at: Number(item.at || 0)
  }));
}

function peekCleanVideoUrl(webContentsId) {
  const record = videosByContents.get(Number(webContentsId));
  if (!record || Date.now() - record.at > 90 * 60 * 1000) return null;
  const videos = Array.isArray(record.videos) ? record.videos : [];
  const latest = newestRecipe(videos) || videos[videos.length - 1];
  return latest ? { ...latest, videoId: recipeVideoId(latest), at: Number(latest.at || record.at) } : null;
}

function knownVideoKeys(webContentsId) {
  const keys = [];
  const record = videosByContents.get(Number(webContentsId));
  for (const video of record && Array.isArray(record.videos) ? record.videos : []) {
    if (video && video.url) keys.push(video.url);
    if (video && video.fallbackApi) keys.push(video.fallbackApi);
  }
  return keys;
}

function peekAllCleanVideos() {
  const out = [];
  for (const [id, record] of videosByContents.entries()) {
    if (!record || Date.now() - record.at > 90 * 60 * 1000) continue;
    for (const video of record.videos || []) {
      if (video && video.url) out.push({ webContentsId: Number(id), at: record.at, ...video });
    }
  }
  return out;
}

function installPageVideoHook() {
  const identity = url => {
    const href = String(url || "");
    const query = href.match(/[?&](?:video_id|vid)=([^&?#]+)/i);
    if (query) {
      try { return decodeURIComponent(query[1]); } catch { return query[1]; }
    }
    try {
      const parsed = new URL(href);
      const fromQuery = parsed.searchParams.get("video_id") || parsed.searchParams.get("vid") || "";
      if (fromQuery) return fromQuery;
      const last = parsed.pathname.split("/").filter(Boolean).pop() || "";
      if (/^v[0-9a-z]{8,}$/i.test(last)) return last;
    } catch {}
    const hit = href.match(/v[0-9a-z]{10,}/i);
    return hit ? hit[0] : "";
  };
  const notePlayInfo = url => {
    const href = String(url || "").replace(/\\u0026/gi, "&").replace(/\\\//g, "/").replace(/&amp;/gi, "&");
    if (!/^https?:/i.test(href) || !/\/video\/fplay\//i.test(href) || href.length < 240 || !/[?&]key_seed=/.test(href)) return;
    let keySeed = "";
    let videoId = identity(href);
    try {
      const parsed = new URL(href);
      keySeed = parsed.searchParams.get("key_seed") || "";
      videoId = parsed.searchParams.get("video_id") || parsed.searchParams.get("vid") || videoId;
    } catch {}
    window.__jxLastPlayInfo = { fallbackApi: href, keySeed, videoId, at: Date.now() };
    window.__jxCleanVideos = Array.isArray(window.__jxCleanVideos) ? window.__jxCleanVideos : [];
    const existing = window.__jxCleanVideos.find(item => item && ((videoId && item.videoId === videoId) || item.fallbackApi === href || (item.fallbackApi && (href.startsWith(item.fallbackApi) || item.fallbackApi.startsWith(href)))));
    if (existing) {
      if (href.length >= String(existing.fallbackApi || "").length) existing.fallbackApi = href;
      existing.keySeed = keySeed || existing.keySeed;
      existing.videoId = videoId || existing.videoId;
      existing.at = Date.now();
      return;
    }
    window.__jxCleanVideos.push({ fallbackApi: href, keySeed, videoId, at: Date.now() });
    if (window.__jxCleanVideos.length > 24) window.__jxCleanVideos.splice(0, window.__jxCleanVideos.length - 24);
  };
  const remember = text => {
    if (typeof text !== "string" || text.length < 20 || !/fallback_api|video\/fplay/.test(text)) return;
    window.__jxCleanVideos = Array.isArray(window.__jxCleanVideos) ? window.__jxCleanVideos : [];
    const flat = text
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\{1,2}"/g, '"')
      .replace(/\\\//g, "/");
    const found = [];
    const add = raw => {
      let url = String(raw || "").replace(/\\u0026/gi, "&").replace(/\\\//g, "/").replace(/&amp;/gi, "&");
      if (!/^https?:/i.test(url) || !/\/video\/fplay\//i.test(url)) return;
      if (url.length < 240 || !/[?&]key_seed=/.test(url)) return;
      if (!found.includes(url)) found.push(url);
    };
    const re = /"fallback_api"\s*:\s*"(https:[^"]+)"/g;
    let match;
    while ((match = re.exec(flat))) add(match[1]);
    const re2 = /https:\/\/[^\s"'\\]+\/video\/fplay\/[^\s"'\\]+/g;
    while ((match = re2.exec(flat))) add(match[0]);
    for (const url of found) notePlayInfo(url);
  };
  const readVideoFromNode = start => {
    const data = (object, key) => object && Object.getOwnPropertyDescriptor(object, key)?.value;
    let el = start instanceof Element ? start : null;
    if (!el) return null;
    let videoEl = el.tagName === "VIDEO" ? el : null;
    for (let root = el, i = 0; root && i < 16; i++, root = root.parentElement) {
      if (root.tagName === "VIDEO") { videoEl = root; break; }
      const videos = root.querySelectorAll ? [...root.querySelectorAll("video")] : [];
      if (videos.length === 1) { videoEl = videos[0]; break; }
    }
    const nodes = [];
    if (videoEl) nodes.push(videoEl);
    for (let cur = el, i = 0; cur && i < 12; i++, cur = cur.parentElement) nodes.push(cur);
    for (const node of nodes) {
      const fiberKey = Object.keys(node).find(key => key.startsWith("__reactFiber$"));
      let fiber = fiberKey ? data(node, fiberKey) : null;
      for (let depth = 0; fiber && depth < 18; depth++, fiber = data(fiber, "return")) {
        const props = data(fiber, "memoizedProps");
        const video = data(props, "video") || data(props, "videoInfo") || props;
        if (!video || typeof video !== "object") continue;
        const raw = data(video, "videoModel");
        const vid = String(data(video, "vid") || data(video, "videoId") || data(video, "video_id") || "");
        let fallbackApi = "";
        let keySeed = "";
        let modelVid = vid;
        if (typeof raw === "string" && raw.length < 250000) {
          try {
            const model = JSON.parse(raw);
            fallbackApi = String(model.fallback_api || "");
            keySeed = String(model.key_seed || "");
            modelVid = String(model.video_id || vid || "");
          } catch {}
        }
        if (!fallbackApi && typeof data(video, "fallback_api") === "string") fallbackApi = data(video, "fallback_api");
        if (modelVid || fallbackApi) {
          return {
            vid: modelVid || identity(fallbackApi),
            fallbackApi,
            keySeed,
            src: videoEl ? String(videoEl.currentSrc || videoEl.src || "") : "",
            at: Date.now()
          };
        }
      }
    }
    if (!videoEl) return null;
    const src = String(videoEl.currentSrc || videoEl.src || "");
    return { vid: identity(src), fallbackApi: "", keySeed: "", src, at: Date.now() };
  };
  window.__jxRememberFallback = remember;
  window.__jxNotePlayInfo = notePlayInfo;
  window.__jxCleanVideos = (Array.isArray(window.__jxCleanVideos) ? window.__jxCleanVideos : []).filter(item => item && String(item.fallbackApi || "").length >= 240 && /[?&]key_seed=/.test(item.fallbackApi));
  const apply = url => {
    const clean = String(url || window.__jxCleanMediaUrl || "");
    if (clean && /^https?:/i.test(clean)) window.__jxCleanMediaUrl = clean;
    return true;
  };
  window.__jxApplyCleanVideo = apply;
  if (!window.__jxFocusGuard) {
    window.__jxFocusGuard = 1;
    try {
      const origFocus = window.focus.bind(window);
      window.focus = function () { if (document.hasFocus()) origFocus(); };
    } catch {}
  }
  if (!window.__jxVideoClickWatch) {
    window.__jxVideoClickWatch = true;
    document.addEventListener("click", event => {
      const node = event.target instanceof Element ? event.target : event.target && event.target.parentElement;
      if (!node) return;
      const target = readVideoFromNode(node);
      if (target) window.__jxLastVideoTarget = target;
    }, true);
  }
  if (window.__jxVideoHook === 6) {
    apply(window.__jxCleanMediaUrl);
    return true;
  }
  window.__jxVideoHook = 6;
  window.__jxCleanVideos = Array.isArray(window.__jxCleanVideos) ? window.__jxCleanVideos : [];
  window.__jxOrigFetch = window.__jxOrigFetch || window.fetch;
  window.fetch = function () {
    try {
      const req = arguments[0];
      const href = typeof req === "string" ? req : (req && req.url) || "";
      notePlayInfo(href);
    } catch {}
    return window.__jxOrigFetch.apply(this, arguments).then(res => {
      try {
        try { notePlayInfo(res && res.url); } catch {}
        const ct = String(res.headers.get("content-type") || "");
        if (/event-stream/i.test(ct) && res.body) {
          const copy = res.clone();
          const reader = copy.body.getReader();
          const dec = new TextDecoder();
          (async () => {
            let acc = "";
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              acc += dec.decode(chunk.value, { stream: true });
              if (acc.length > 400000) {
                (window.__jxRememberFallback || remember)(acc);
                const keep = acc.lastIndexOf("fallback_api");
                acc = keep >= 0 ? acc.slice(Math.max(0, keep - 32)) : acc.slice(-120000);
              }
            }
            (window.__jxRememberFallback || remember)(acc);
          })().catch(() => {});
        } else {
          res.clone().text().then(text => (window.__jxRememberFallback || remember)(text)).catch(() => {});
        }
      } catch {}
      return res;
    });
  };
  if (window.__jxXhrHooked !== 6) {
    window.__jxXhrHooked = 6;
    window.__jxOrigXhrOpen = window.__jxOrigXhrOpen || XMLHttpRequest.prototype.open;
    window.__jxOrigXhrSend = window.__jxOrigXhrSend || XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function () {
      try { this.__jxOpenUrl = String(arguments[1] || ""); } catch {}
      return window.__jxOrigXhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      try { notePlayInfo(this.__jxOpenUrl); } catch {}
      this.addEventListener("load", () => {
        try {
          notePlayInfo(this.__jxOpenUrl || this.responseURL);
          (window.__jxRememberFallback || remember)(this.responseText);
        } catch {}
      });
      return window.__jxOrigXhrSend.apply(this, arguments);
    };
  }
  apply(window.__jxCleanMediaUrl);
  return true;
}

const PAGE_VIDEO_HOOK = "(" + installPageVideoHook.toString() + ")()";
const PAGE_FOCUS_GUARD = `(() => {
  if (window.__jxFocusGuard) return true;
  window.__jxFocusGuard = 1;
  try {
    const origFocus = window.focus.bind(window);
    window.focus = function () { if (document.hasFocus()) origFocus(); };
  } catch {}
  return true;
})()`;

const PAGE_VIDEO_STATUS = `(() => {
  const clean = v => String(v || '').replace(/\\s+/g, ' ').trim();
  const text = clean(document.body && document.body.innerText || '');
  const lastIndex = pattern => {
    let last = -1;
    const re = new RegExp(pattern, 'gi');
    let match;
    while ((match = re.exec(text))) last = match.index;
    return last;
  };
  const doneAt = lastIndex('你的视频生成好了|视频(?:已经|已)?生成(?:完成|好了)|主动发送给你|your video is ready');
  const failAt = lastIndex('无法生成该视频|视频生成失败|本次.{0,24}生成失败|generation failed|could not generate');
  const done = doneAt >= 0 && doneAt >= failAt;
  const failed = failAt >= 0 && failAt > doneAt;
  const videos = [...document.querySelectorAll('video')].map(video => video.currentSrc || video.src).filter(Boolean);
  const recipes = Array.isArray(window.__jxCleanVideos) ? window.__jxCleanVideos.slice(-8) : [];
  const pending = /正在生成|生成中|排队中|任务处理中|预计等待|正在渲染|in queue|making your video/i.test(text);
  return { done, failed, pending, videos, recipes, doneAt, failAt, cleanMedia: String(window.__jxCleanMediaUrl || ''), lastTarget: window.__jxLastVideoTarget || null, lastPlay: window.__jxLastPlayInfo || null };
})()`;

async function inspectPageVideos(guest) {
  if (!guest || guest.isDestroyed()) return null;
  await attach(guest);
  await send(guest, "Runtime.evaluate", { expression: PAGE_VIDEO_HOOK, returnByValue: true }).catch(() => null);
  const found = await send(guest, "Runtime.evaluate", { expression: PAGE_VIDEO_STATUS, returnByValue: true });
  return found && found.result && found.result.value;
}

async function sessionGetText(guest, url) {
  const ses = guest && guest.session;
  const referer = refererForFallback(url);
  const headers = {
    Referer: referer,
    Origin: referer.replace(/\/$/, ""),
    Accept: "application/json,text/plain,*/*"
  };
  if (ses && typeof ses.fetch === "function") {
    const response = await ses.fetch(url, { headers });
    return { ok: response.ok, status: response.status, text: await response.text() };
  }
  const { net } = require("electron");
  return await new Promise((resolve, reject) => {
    const request = net.request({ method: "GET", url, session: ses, useSessionCookies: true });
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);
    const chunks = [];
    request.on("response", response => {
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        ok: Number(response.statusCode) >= 200 && Number(response.statusCode) < 300,
        status: response.statusCode,
        text: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

function decodePayloadVideoUrl(payload, fallbackUrl) {
  if (!payload) return "";
  const token = pickMainUrlToken(getVideoData(payload));
  let keySeed = findKeySeedDeep(payload);
  try { keySeed = keySeed || new URL(String(fallbackUrl || "")).searchParams.get("key_seed") || ""; } catch {}
  const decoded = decodeMainUrl(token, keySeed);
  if (decoded) return decoded;
  for (const encoded of [...findValuesByKey(payload, "main_url"), ...findValuesByKey(payload, "play_url"), ...findValuesByKey(payload, "backup_url")]) {
    const url = decodeMainUrl(encoded, keySeed);
    if (url && !isPlayerPreviewUrl(url)) return url;
  }
  return "";
}

async function resolveFallbackApi(guest, fallbackApi) {
  const url = await getDoubaoVideoUrlFromFallbackApi(fallbackApi, guest);
  return url && !isPlayerPreviewUrl(url) ? url : "";
}

function newestRecipe(items) {
  const list = (Array.isArray(items) ? items : []).filter(item => item && isHttpUrl(item.fallbackApi || item.url));
  if (!list.length) return null;
  return list.slice().sort((a, b) => Number(b.at || 0) - Number(a.at || 0) || list.indexOf(b) - list.indexOf(a))[0];
}

function mergeVideoRecipes(...groups) {
  const out = [];
  for (const group of groups) {
    const list = Array.isArray(group) ? group : (group ? [group] : []);
    for (const item of list) {
      if (!item) continue;
      const fallbackApi = normalizeFallbackApi(item.fallbackApi || (isPlayInfoApiUrl(item.url) ? item.url : ""));
      const url = isHttpUrl(item.url) && !isPlayInfoApiUrl(item.url) ? item.url : "";
      const videoId = recipeVideoId({ ...item, fallbackApi, url });
      if (!fallbackApi && !url) continue;
      const existing = out.find(entry => recipesSame(entry, { fallbackApi, url, videoId }));
      if (existing) {
        existing.url = existing.url || url;
        if (String(fallbackApi || "").length >= String(existing.fallbackApi || "").length) existing.fallbackApi = fallbackApi || existing.fallbackApi;
        existing.videoId = existing.videoId || videoId;
        existing.keySeed = existing.keySeed || item.keySeed || "";
        existing.at = Math.max(Number(existing.at || 0), Number(item.at || 0));
        continue;
      }
      out.push({
        url,
        fallbackApi,
        keySeed: String(item.keySeed || ""),
        videoId,
        at: Number(item.at || 0)
      });
    }
  }
  return out;
}

function recipeIsUsed(item, usedKeys) {
  if (!usedKeys || !usedKeys.size) return false;
  const id = recipeVideoId(item);
  if (id && usedKeys.has(id)) return true;
  if (item && item.url && usedKeys.has(item.url)) return true;
  if (item && item.fallbackApi && usedKeys.has(item.fallbackApi)) return true;
  return false;
}

function downloadHint(page, interceptedUrl, filename) {
  const now = Date.now();
  const last = page && page.lastTarget && now - Number(page.lastTarget.at || 0) < 20000 ? page.lastTarget : null;
  const lastPlay = page && page.lastPlay && now - Number(page.lastPlay.at || 0) < 8000 ? page.lastPlay : null;
  const fromLast = last ? String(last.vid || videoIdentity(last.fallbackApi) || videoIdentity(last.src) || "") : "";
  const fromPlay = !fromLast && lastPlay ? String(lastPlay.videoId || videoIdentity(lastPlay.fallbackApi) || "") : "";
  return {
    videoId: fromLast || fromPlay || videoIdentity(interceptedUrl) || videoIdentityFromName(filename) || "",
    fallbackApi: String((last && last.fallbackApi) || (!fromLast && lastPlay && lastPlay.fallbackApi) || ""),
    src: String((last && last.src) || interceptedUrl || "")
  };
}

function pickRecipeForDownload(recipes, hint, usedKeys) {
  const list = Array.isArray(recipes) ? recipes.filter(item => item && (item.fallbackApi || item.url)) : [];
  if (!list.length) return null;
  const hinted = (hint.videoId && list.find(item => recipeVideoId(item) === hint.videoId))
    || list.find(item => hint.fallbackApi && item.fallbackApi && (item.fallbackApi === hint.fallbackApi || item.fallbackApi.startsWith(hint.fallbackApi) || hint.fallbackApi.startsWith(item.fallbackApi)))
    || list.find(item => hint.src && item.url && item.url === hint.src);
  if (hinted) return hinted;
  const unused = list.filter(item => !recipeIsUsed(item, usedKeys));
  return newestRecipe(unused.length ? unused : list);
}

async function resolveChosenRecipe(guest, recipe) {
  if (!recipe) return null;
  const fallback = String(recipe.fallbackApi || "");
  const videoId = recipeVideoId(recipe);
  if (isHttpUrl(fallback) && isPlayInfoApiUrl(fallback)) {
    try {
      const url = await resolveFallbackApi(guest, fallback);
      if (url && !isPlayerPreviewUrl(url)) {
        rememberVideos(guest, [{ type: "video", url, fallbackApi: fallback, keySeed: recipe.keySeed || "", videoId, at: recipe.at }]);
        return { type: "video", url, fallbackApi: fallback, keySeed: recipe.keySeed || "", videoId, at: Date.now() };
      }
    } catch {}
  }
  if (recipe.url && isHttpUrl(recipe.url) && !isPlayerPreviewUrl(recipe.url)) {
    return { type: "video", url: recipe.url, fallbackApi: fallback, keySeed: recipe.keySeed || "", videoId, at: recipe.at || Date.now() };
  }
  return null;
}

async function resolvePeekedCleanUrl(guest) {
  if (!guest || guest.isDestroyed()) return null;
  let page = null;
  try {
    await attach(guest);
    page = await inspectPageVideos(guest);
  } catch {}
  const latest = newestRecipe(mergeVideoRecipes(listStoredVideos(guest), page && page.recipes));
  return resolveChosenRecipe(guest, latest);
}

async function resolveCleanUrlForDownload(guest, interceptedUrl, options = {}) {
  if (!guest || guest.isDestroyed()) return null;
  const usedKeys = options.usedKeys instanceof Set ? options.usedKeys : new Set(options.usedKeys || []);
  const filename = String(options.filename || "");
  let page = null;
  try {
    await attach(guest);
    page = await inspectPageVideos(guest);
  } catch {}
  const recipes = mergeVideoRecipes(
    listStoredVideos(guest),
    page && page.recipes,
    page && page.lastPlay,
    page && page.lastTarget ? { fallbackApi: page.lastTarget.fallbackApi, videoId: page.lastTarget.vid, url: page.lastTarget.src, keySeed: page.lastTarget.keySeed, at: page.lastTarget.at } : null
  );
  const hint = downloadHint(page, interceptedUrl, filename);
  const chosen = pickRecipeForDownload(recipes, hint, usedKeys);
  if (chosen) {
    const resolved = await resolveChosenRecipe(guest, chosen);
    if (resolved && hint.videoId && recipeVideoId(resolved) === hint.videoId) return resolved;
    if (resolved && !recipeIsUsed(resolved, usedKeys)) return resolved;
    const rest = recipes.filter(item => item !== chosen && !recipeIsUsed(item, usedKeys));
    for (const item of rest.sort((a, b) => Number(b.at || 0) - Number(a.at || 0))) {
      const next = await resolveChosenRecipe(guest, item);
      if (next && !recipeIsUsed(next, usedKeys)) return next;
    }
    if (resolved) return resolved;
  }
  const peeked = await resolvePeekedCleanUrl(guest);
  if (peeked && !recipeIsUsed(peeked, usedKeys)) return peeked;
  return peeked && hint.videoId && recipeVideoId(peeked) === hint.videoId ? peeked : null;
}

async function applyCleanVideoToPage(guest, url) {
  const clean = String(url || "");
  if (!guest || guest.isDestroyed() || !clean || isPlayerPreviewUrl(clean)) return;
  rememberVideos(guest, [{ type: "video", url: clean }]);
  const expression = `window.__jxCleanMediaUrl = ${JSON.stringify(clean)}; true`;
  try { await send(guest, "Runtime.evaluate", { expression, returnByValue: true }); } catch {}
}

async function handlePaused(guest, event) {
  const requestId = event.requestId;
  const request = event.request || {};
  const url = request.url || "";
  try {
    const isResponse = Number(event.responseStatusCode) > 0;
    if (!isResponse && isPlayInfoApiUrl(url)) {
      await continueRequest(guest, requestId);
      return;
    }
    if (url.includes(ENDPOINTS.doubaoSkillPack)) {
      await fulfillJsonFile(guest, requestId, request.method, "doubao-skill-pack-response.json");
      return;
    }
    if (url.includes(ENDPOINTS.dolaSkillPack)) {
      await fulfillJsonFile(guest, requestId, request.method, "dola-skill-pack-response.json");
      return;
    }
    if (url.includes(ENDPOINTS.actionBarConfig)) {
      const response = await getPausedResponseBody(guest, requestId);
      const patchedBody = patchActionBarDuration(response.body);
      await send(guest, "Fetch.fulfillRequest", {
        requestId,
        responseCode: event.responseStatusCode || 200,
        responsePhrase: event.responseStatusText || "OK",
        responseHeaders: responseHeadersForTextBody(event.responseHeaders || [], patchedBody),
        body: toBase64Utf8(patchedBody)
      });
      return;
    }
    if (url.includes(ENDPOINTS.doubaoChainSingle) || url.includes(ENDPOINTS.dolaChainSingle)) {
      const response = await getPausedResponseBody(guest, requestId);
      try {
        const json = JSON.parse(response.body);
        const items = await extractAllVideoItems(json, response.body, guest);
        rememberVideos(guest, items);
      } catch {}
      await send(guest, "Fetch.fulfillRequest", {
        requestId,
        responseCode: event.responseStatusCode || 200,
        responsePhrase: event.responseStatusText || "OK",
        responseHeaders: responseHeadersForTextBody(event.responseHeaders || [], response.body),
        body: toBase64Utf8(response.body)
      });
      return;
    }
    await continueRequest(guest, requestId);
  } catch (error) {
    await continueRequest(guest, requestId);
    throw error;
  }
}

async function attach(guest) {
  if (!guest || guest.isDestroyed()) return false;
  if (attached.has(guest.id)) {
    try { await send(guest, "Fetch.enable", { patterns: FETCH_PATTERNS }); } catch {}
    await send(guest, "Runtime.evaluate", { expression: PAGE_FOCUS_GUARD, returnByValue: true }).catch(() => {});
    await send(guest, "Runtime.evaluate", { expression: PAGE_VIDEO_HOOK, returnByValue: true }).catch(() => {});
    return true;
  }
  const dbg = guest.debugger;
  if (!dbg.isAttached()) {
    try { dbg.attach("1.3"); } catch (error) {
      if (!/already attached/i.test(String(error.message || error))) throw error;
    }
  }
  const onMessage = (_event, method, params) => {
    if (method !== "Fetch.requestPaused") return;
    handlePaused(guest, params).catch(() => continueRequest(guest, params.requestId));
  };
  dbg.on("message", onMessage);
  guest.once("destroyed", () => {
    attached.delete(guest.id);
    videosByContents.delete(guest.id);
    try { dbg.removeListener("message", onMessage); } catch {}
  });
  await send(guest, "Fetch.enable", { patterns: FETCH_PATTERNS });
  await send(guest, "Page.enable").catch(() => {});
  await send(guest, "Page.addScriptToEvaluateOnNewDocument", { source: PAGE_FOCUS_GUARD }).catch(() => {});
  await send(guest, "Page.addScriptToEvaluateOnNewDocument", { source: PAGE_VIDEO_HOOK }).catch(() => {});
  await send(guest, "Runtime.evaluate", { expression: PAGE_FOCUS_GUARD, returnByValue: true }).catch(() => {});
  await send(guest, "Runtime.evaluate", { expression: PAGE_VIDEO_HOOK, returnByValue: true }).catch(() => {});
  attached.set(guest.id, { guest, onMessage });
  return true;
}

function isAttached(guest) {
  return Boolean(guest && attached.has(guest.id));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pressKey(guest, key, code, windowsVirtualKeyCode, modifiers = 0) {
  const vk = Number(windowsVirtualKeyCode);
  const mods = Number(modifiers) || 0;
  await send(guest, "Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods });
  await send(guest, "Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods });
}

async function pressEscape(guest) {
  await pressKey(guest, "Escape", "Escape", 27);
}

const PAGE_HELPERS = `(() => {
  const visible = e => {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || 1) > 0.2;
  };
  const clean = v => String(v || '').replace(/\\s+/g, ' ').trim();
  const labelOf = el => clean(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '');
  const isBlockedChrome = el => /新工作任务|创建项目|新对话|定时任务|输入项目名称|工作空间|云盘|技能|连接器|伙伴|API服务|安排任务|工作周报|^(项目|更多)$/.test(labelOf(el));
  const collectEditors = () => {
    const nodes = [...document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"],.tiptap.ProseMirror,.ProseMirror')];
    return nodes.filter(el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (s.display === 'none' || el.disabled) return false;
      if (r.width < 24 && r.height < 8) return false;
      const hint = clean(el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('aria-label') || '');
      if (/安排任务|定时任务|工作周报/.test(hint)) return false;
      return true;
    });
  };
  const pickEditor = () => {
    const editors = collectEditors();
    const hint = el => clean(el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('aria-label') || el.querySelector && el.querySelector('[data-placeholder]') && el.querySelector('[data-placeholder]').getAttribute('data-placeholder') || '');
    return editors.find(el => /视频|描述|想要|提示|prompt|message|describe/i.test(hint(el)))
      || editors.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]
      || null;
  };
  const revealComposerEditor = () => {
    const editor = pickEditor();
    if (!editor) return null;
    let node = editor;
    for (let i = 0; i < 10 && node && node !== document.body; i++) {
      const cls = String(node.className || '');
      const s = getComputedStyle(node);
      if (/\\binvisible\\b/.test(cls) || s.visibility === 'hidden' || s.pointerEvents === 'none') {
        try { node.classList.remove('invisible'); } catch {}
        node.style.visibility = 'visible';
        node.style.pointerEvents = 'auto';
        if (/\\babsolute\\b/.test(cls) && /pointer-events-none|invisible/.test(cls)) {
          node.style.position = 'relative';
          node.style.inset = 'auto';
        }
      }
      if (node.classList && node.classList.contains('guidance-input-editor-wrapper')) break;
      node = node.parentElement;
    }
    try { editor.focus({ preventScroll: true }); } catch {}
    return editor;
  };
  const pageShell = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.height >= innerHeight * 0.9 || (r.width >= innerWidth * 0.96 && r.height >= innerHeight * 0.72);
  };
  const composerShell = editor => {
    const current = editor || pickEditor();
    const fileInput = [...document.querySelectorAll('input[type="file"]')].find(input => /image|png|jpe?g|webp|gif/i.test(input.accept || '')) || document.querySelector('input[type="file"]');
    const named = (fileInput && fileInput.closest('#input-engine-container, [id*="input-engine"], [class*="input-engine"], [class*="composer"], .guidance-input-editor-wrapper'))
      || (current && current.closest('#input-engine-container, [id*="input-engine"], [class*="input-engine"], [class*="composer"], .guidance-input-editor-wrapper'));
    let root = named || (current && current.parentElement) || document.body;
    const thumbCount = node => [...node.querySelectorAll('img,canvas')].filter(el => visible(el) && !(current && current.contains(el))).length;
    if (current) {
      for (let i = 0; i < 10 && root && root.parentElement; i++) {
        const parent = root.parentElement;
        if (!parent || parent === document.body || parent === document.documentElement || pageShell(parent) || !parent.contains(current)) break;
        const better = thumbCount(parent) > thumbCount(root) || (parent.querySelector('input[type="file"]') && !root.querySelector('input[type="file"]'));
        if (!better) break;
        root = parent;
      }
    }
    return root || document.body;
  };
  const inComposerBand = el => {
    const r = el.getBoundingClientRect();
    if (r.width >= 720 || r.left <= 40) return false;
    const editor = pickEditor();
    const shell = composerShell(editor);
    const sr = shell && shell !== document.body ? shell.getBoundingClientRect() : null;
    if (sr && sr.height > 24 && sr.width > 80) {
      return r.bottom > sr.top - 16 && r.top < sr.bottom + 16 && r.left >= sr.left - 32 && r.right <= sr.right + 48;
    }
    const er = editor ? editor.getBoundingClientRect() : null;
    if (er) return r.bottom > er.top - 96 && r.top < er.bottom + 96 && r.left >= er.left - 48;
    return r.top > innerHeight * 0.28 && r.bottom <= innerHeight + 16;
  };
  const isModelChip = el => {
    if (!inComposerBand(el) || isBlockedChrome(el)) return false;
    const t = labelOf(el);
    if (/^模型/.test(t)) return true;
    if (/^(时长|比例|参考图|图片|音频)$/.test(t)) return true;
    return /seedance|2\\.0\\s*fast|2\\.0\\s*pro/i.test(t) && t.length < 40 && !/生成|项目|任务|周报/.test(t);
  };
  const dismissProjectModal = () => {
    const dialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(visible);
    const project = dialogs.find(el => /创建项目|输入项目名称/.test(clean(el.innerText || el.textContent)));
    const heading = [...document.querySelectorAll('h1,h2,div,p,span,label')].filter(visible).find(el => /^(创建项目|输入项目名称)$/.test(clean(el.innerText)));
    if (!project && !heading) return { open: false };
    const scope = project || heading.closest('[role="dialog"],[role="alertdialog"]') || heading.parentElement || document.body;
    const cancel = [...scope.querySelectorAll('button')].filter(visible).find(b => /^(取消|关闭)$/.test(clean(b.innerText || b.textContent)));
    if (cancel) {
      cancel.click();
      return { open: true, dismissed: true };
    }
    return { open: true, dismissed: false };
  };
  const collectButtons = root => {
    const out = [];
    const walk = node => {
      if (!node) return;
      node.querySelectorAll && node.querySelectorAll('button,[role="button"]').forEach(b => out.push(b));
      node.querySelectorAll && node.querySelectorAll('*').forEach(el => { if (el.shadowRoot) walk(el.shadowRoot); });
    };
    walk(root);
    return out;
  };
  const isBlue = bg => {
    const m = String(bg || '').match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/i);
    if (!m) return /#0066ff|#005ce6|#1677ff|#3b82f6|#2f88ff/i.test(String(bg || ''));
    const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
    return b >= 160 && r <= 110 && g <= 170 && b > g && b > r;
  };
  const isRound = rect => Math.abs(rect.width - rect.height) < 14 && rect.width >= 24 && rect.width <= 56;
  const findSend = () => {
    const editors = [...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')].filter(visible);
    const editor = editors[editors.length - 1];
    const editorRect = editor ? editor.getBoundingClientRect() : { left: innerWidth * 0.2, width: innerWidth * 0.5, top: innerHeight * 0.7 };
    const exactSelectors = ['#flow-end-msg-send','[data-testid="chat_input_send_button"]','[data-testid="video-send-msg-button"]','button[class*="send-msg-btn"]'];
    const exact = new Set(exactSelectors.flatMap(selector => { try { return [...document.querySelectorAll(selector)]; } catch { return []; } }));
    const buttons = collectButtons(document).filter(visible);
    const scored = buttons.map(button => {
      const text = String(button.innerText || button.textContent || button.getAttribute('aria-label') || button.getAttribute('title') || '').replace(/\\s+/g, ' ').trim();
      const className = String(button.className || '');
      const testId = String(button.getAttribute('data-testid') || '');
      const rect = button.getBoundingClientRect();
      const disabled = button.disabled || button.getAttribute('aria-disabled') === 'true' || button.getAttribute('data-disabled') === 'true';
      let score = 0;
      if (exact.has(button) || button.id === 'flow-end-msg-send' || testId === 'chat_input_send_button') score += 1000;
      if (/video-send-msg-button|send-msg-button|send-msg-btn|submit/i.test(className + ' ' + testId)) score += 320;
      if (/生成视频|立即生成|^生成$|^发送$|send/i.test(text) && text.length < 12) score += 220;
      if (isBlue(getComputedStyle(button).backgroundColor) && isRound(rect)) score += 180;
      if (rect.left > editorRect.left + editorRect.width * 0.65 && rect.top > editorRect.top - 90) score += 60;
      if (isRound(rect) && rect.top > editorRect.top - 90 && rect.left > editorRect.left + editorRect.width * 0.45) score += 40;
      if (disabled) score -= 1000;
      if (isBlockedChrome(button) || rect.left < 80) score -= 2000;
      return { button, score };
    }).filter(item => item.score > 80).sort((a, b) => b.score - a.score);
    return scored[0] ? scored[0].button : null;
  };
  const menuOpen = () => {
    const pop = [...document.querySelectorAll('[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper],[class*="popover"],[class*="dropdown"]')].find(el => {
      const r = el.getBoundingClientRect();
      return visible(el) && r.height > 48 && r.width > 48 && r.top < innerHeight * 0.92;
    });
    return Boolean(pop);
  };
  return { visible, collectButtons, isBlue, findSend, menuOpen, clean, labelOf, isBlockedChrome, inComposerBand, isModelChip, dismissProjectModal, collectEditors, pickEditor, revealComposerEditor, composerShell };
})()`;

const FIND_SEND_BUTTON = `(() => {
  const helpers = ${PAGE_HELPERS};
  helpers.dismissProjectModal();
  if (helpers.menuOpen()) return { menuOpen: true };
  const btn = helpers.findSend();
  if (!btn) return null;
  btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const rect = btn.getBoundingClientRect();
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), w: rect.width, h: rect.height };
})()`;

const CLICK_SEND_BUTTON = `(() => {
  const helpers = ${PAGE_HELPERS};
  const btn = helpers.findSend();
  if (!btn) return false;
  btn.click();
  return true;
})()`;

function composerReadyExpression(expected) {
  const count = Math.max(0, Number(expected) || 0);
  return `(() => {
    const expected = ${count};
    const helpers = ${PAGE_HELPERS};
    const visible = helpers.visible;
    const clean = v => String(v || '').replace(/\\s+/g, ' ').trim();
    const chipsReady = [...document.querySelectorAll('button,[role="button"]')].filter(visible).some(el => helpers.isModelChip(el));
    const editor = helpers.revealComposerEditor() || helpers.pickEditor();
    const area = helpers.composerShell ? helpers.composerShell(editor) : (editor && editor.parentElement) || document.body;
    const er = editor ? editor.getBoundingClientRect() : { top: innerHeight * 0.7, left: 80, right: innerWidth - 40, bottom: innerHeight - 8 };
    const ar = area && area.getBoundingClientRect ? area.getBoundingClientRect() : er;
    const inHistory = el => Boolean(el.closest && el.closest('[data-testid="message-block-container"],[data-testid="send_message"],[data-testid="receive_message"]'));
    const inComposer = el => {
      const r = el.getBoundingClientRect();
      if (!visible(el) || inHistory(el)) return false;
      if (editor && editor.contains(el)) return false;
      if (r.width < 20 || r.height < 20 || r.width > 480 || r.height > 480) return false;
      const inShell = r.bottom > ar.top - 12 && r.top < ar.bottom + 12 && r.left > ar.left - 16 && r.right < ar.right + 16;
      const nearEditor = r.right > er.left - 64 && r.left < er.right + 64 && r.bottom > er.top - 520 && r.top < er.bottom + 32;
      return inShell || nearEditor;
    };
    const media = [...area.querySelectorAll('img,canvas')].filter(inComposer).filter(el => !/avatar|logo|icon|favicon/i.test(String(el.currentSrc || el.src || el.className || '')));
    const boxes = [];
    const remember = el => {
      const r = el.getBoundingClientRect();
      if (boxes.some(b => Math.abs(b.x - r.left) < 10 && Math.abs(b.y - r.top) < 10)) return;
      boxes.push({ x: r.left, y: r.top, el });
    };
    media.forEach(remember);
    [...area.querySelectorAll('*')].filter(el => el.tagName !== 'IMG' && el.tagName !== 'CANVAS' && inComposer(el) && /url\\(/.test(getComputedStyle(el).backgroundImage || '')).forEach(remember);
    const imgs = boxes.map(b => b.el).filter(el => el.tagName === 'IMG');
    const imagesLoading = imgs.some(img => !img.complete || img.naturalWidth <= 1);
    const loaded = imgs.filter(img => img.complete && img.naturalWidth > 1).length;
    const fileCount = Math.max(0, ...[...document.querySelectorAll('input[type="file"]')].map(input => Number(input.files && input.files.length || 0)));
    const nearbyNodes = [];
    const candidates = area.querySelectorAll('span,div,p,label,small,[role="progressbar"]');
    for (let i = 0; i < candidates.length && nearbyNodes.length < 60; i++) {
      const el = candidates[i];
      const r = el.getBoundingClientRect();
      if (r.width > 520 || r.height > 56) continue;
      if (r.bottom <= er.top - 520 || r.top >= er.bottom + 48) continue;
      if (r.right < er.left - 80 || r.left > er.right + 80) continue;
      nearbyNodes.push(el);
    }
    const failed = nearbyNodes.some(el => /上传失败|图片上传失败|重新上传|upload failed/i.test(clean(el.innerText || el.textContent).slice(0, 80)));
    const percents = nearbyNodes.map(el => {
      const t = clean(el.innerText || el.textContent);
      return /^\\d{1,3}%$/.test(t) ? Number(t) : null;
    }).filter(n => n !== null && n < 100);
    const bars = nearbyNodes.filter(el => el.getAttribute && el.getAttribute('role') === 'progressbar').filter(visible);
    const barBusy = bars.some(el => {
      const now = el.getAttribute('aria-valuenow');
      const max = Number(el.getAttribute('aria-valuemax') || 100);
      if (now !== null && now !== '' && Number.isFinite(Number(now))) return Number(now) < max;
      return true;
    });
    const uploadingText = nearbyNodes.some(el => /上传中|正在上传|uploading/i.test(clean(el.innerText || el.textContent).slice(0, 40)));
    const busyClass = boxes.some(item => {
      const cls = String((item.el.parentElement && item.el.parentElement.className) || '') + ' ' + String(item.el.className || '');
      return /(^|[^a-z])(loading|uploading|spinner)([^a-z]|$)/i.test(cls) && !/loaded|complete/i.test(cls);
    });
    const uploading = expected > 0 && (uploadingText || percents.length > 0 || barBusy || busyClass || imagesLoading);
    const mediaReady = expected === 0 || (
      !imagesLoading && !uploading && (
        boxes.length >= expected ||
        (fileCount >= expected && boxes.length >= 1)
      )
    );
    const seen = boxes.length >= expected ? boxes.length : Math.max(boxes.length, mediaReady ? fileCount : boxes.length);
    const pageReady = document.readyState === 'complete';
    const sendReady = Boolean(helpers.findSend());
    const editorReady = Boolean(editor);
    const ready = pageReady && chipsReady && editorReady && !failed && mediaReady && (expected === 0 || sendReady);
    return { pageReady, chipsReady, editorReady, sendReady, expected, count: seen, loaded, fileCount, uploading, failed, ready };
  })()`;
}

const SEND_RESULT_STATE = `(() => {
  const helpers = ${PAGE_HELPERS};
  const text = String(document.body && document.body.innerText || '').replace(/\\s+/g, ' ');
  const tail = text.slice(-2500);
  const accepted = /生成视频：|正在生成|生成中|排队中|预计等待|将消耗|视频生成好后|肖像保护|未认证人脸/.test(tail);
  const buttons = helpers.collectButtons(document).filter(helpers.visible);
  const send = helpers.findSend();
  const disabledNow = Boolean(send && (send.disabled || send.getAttribute('aria-disabled') === 'true' || !helpers.isBlue(getComputedStyle(send).backgroundColor)));
  return { accepted, disabledNow };
})()`;

async function hoverPoint(guest, x, y) {
  if (!guest || guest.isDestroyed()) throw new Error("页面已关闭");
  await attach(guest);
  const px = Math.round(Number(x));
  const py = Math.round(Number(y));
  await send(guest, "Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, pointerType: "mouse" });
  await sleep(80);
}

async function clickPoint(guest, x, y) {
  if (!guest || guest.isDestroyed()) throw new Error("页面已关闭");
  await attach(guest);
  const px = Math.round(Number(x));
  const py = Math.round(Number(y));
  await send(guest, "Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, pointerType: "mouse" });
  await sleep(40);
  await send(guest, "Input.dispatchMouseEvent", { type: "mousePressed", x: px, y: py, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
  await sleep(55);
  await send(guest, "Input.dispatchMouseEvent", { type: "mouseReleased", x: px, y: py, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
}

async function waitComposerReady(guest, expectedImages = 0, timeoutMs = 120000) {
  if (!guest || guest.isDestroyed()) throw new Error("页面已关闭");
  await attach(guest);
  const restored = await restoreChatSurface(guest);
  if (restored.error) return restored;
  const deadline = Date.now() + Math.max(8000, Number(timeoutMs) || 120000);
  let last = null;
  while (Date.now() < deadline) {
    const found = await send(guest, "Runtime.evaluate", { expression: composerReadyExpression(expectedImages), returnByValue: true });
    last = found && found.result && found.result.value;
    await evaluatePage(guest, `(() => { const helpers = ${PAGE_HELPERS}; return helpers.dismissProjectModal(); })()`).catch(() => null);
    if (last && last.failed) return { error: "页面提示参考图上传失败，本次未发送", last };
    if (last && last.ready) return { ok: true, last };
    await sleep(400);
  }
  const expected = Math.max(0, Number(expectedImages) || 0);
  const detail = last ? `已确认缩略图 ${last.count || 0}/${expected} 张，加载完成 ${last.loaded || 0} 张${last.fileCount ? `，上传控件 ${last.fileCount} 张` : ''}` : "页面状态未知";
  if (expected > 0) return { error: `参考图尚未完全上传，不能点击发送：${detail}`, last };
  return { error: `视频界面还没有完全加载：${detail}`, last };
}

async function waitComposerReadyTwice(guest, expectedImages = 0, timeoutMs = 120000) {
  const first = await waitComposerReady(guest, expectedImages, timeoutMs);
  if (first.error) return first;
  await sleep(650);
  const second = await waitComposerReady(guest, expectedImages, Math.min(25000, Math.max(8000, Number(timeoutMs) || 25000)));
  if (second.error) return { error: `参考图第二次自检未通过：${second.error}`, last: second.last, first: first.last };
  const expected = Math.max(0, Number(expectedImages) || 0);
  if (expected > 0) {
    const a = Number(first.last && first.last.count || 0);
    const b = Number(second.last && second.last.count || 0);
    if (a < expected || b < expected) {
      return { error: `画布 ${expected} 张参考图需要连续两次自检通过，当前为 ${a} / ${b}`, last: second.last, first: first.last };
    }
  }
  return { ok: true, last: second.last, first: first.last, twice: true };
}

async function evaluatePage(guest, expression, returnByValue = true) {
  const found = await send(guest, "Runtime.evaluate", { expression, returnByValue, userGesture: true });
  if (found && found.exceptionDetails) throw new Error(found.exceptionDetails.text || "页面脚本执行失败");
  return returnByValue ? found && found.result && found.result.value : found && found.result;
}

const OFF_COMPOSER_PATH = /scheduled_tasks|\/drive\b|\/skills?\b|\/connectors?\b|\/cloud|\/workspace|samantha\/skill/i;

function composerHomeUrl(href) {
  try {
    const url = new URL(String(href || ''));
    if (/(?:^|\.)dola\.com$/i.test(url.hostname)) return `${url.protocol}//${url.host}/`;
    return 'https://www.doubao.com/chat/';
  } catch {
    return 'https://www.doubao.com/chat/';
  }
}

async function restoreChatSurface(guest) {
  const href = await evaluatePage(guest, 'location.href').catch(() => '');
  if (!OFF_COMPOSER_PATH.test(String(href || ''))) return { ok: true, href, navigated: false };
  const home = composerHomeUrl(href);
  await evaluatePage(guest, `location.assign(${JSON.stringify(home)})`);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(400);
    const next = await evaluatePage(guest, 'location.href').catch(() => '');
    if (next && !OFF_COMPOSER_PATH.test(String(next))) return { ok: true, href: next, navigated: true };
  }
  return { error: '页面停在定时任务或工具页，没有回到对话' };
}

const VIDEO_MODE_EXPRESSION = `(() => {
  const helpers = ${PAGE_HELPERS};
  const visible = helpers.visible;
  const clean = helpers.clean;
  helpers.dismissProjectModal();
  if (/scheduled_tasks|\\/drive\\b|\\/skills?\\b|\\/connectors?\\b|\\/cloud|\\/workspace/i.test(location.href)) {
    return { offComposer: true, href: location.href };
  }
  const modelVisible = [...document.querySelectorAll('button,[role="button"]')].filter(visible).some(el => helpers.isModelChip(el));
  const editorReady = Boolean(helpers.pickEditor());
  if (modelVisible && editorReady) return { ready: true };
  const videoLabel = t => /^(视频生成|video generation|create video|video)$/i.test(t);
  const nodes = [...document.querySelectorAll('button,[role="button"],[role="tab"],[role="menuitem"]')].filter(visible).filter(el => !helpers.isBlockedChrome(el));
  const videoHits = nodes.filter(el => {
    const t = clean(el.innerText || el.textContent);
    const r = el.getBoundingClientRect();
    return videoLabel(t) && r.width >= 40 && r.width <= 280 && r.height <= 56 && r.left > 200;
  }).sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
  if (videoHits[0]) {
    const rect = videoHits[0].getBoundingClientRect();
    return { ready: false, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), kind: 'video' };
  }
  const more = nodes.filter(el => {
    const t = clean(el.innerText || el.textContent);
    const r = el.getBoundingClientRect();
    return t === '更多' && r.top > innerHeight * 0.4 && r.left > 260 && r.width < 120;
  }).sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
  if (more) {
    const rect = more.getBoundingClientRect();
    return { ready: false, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), kind: 'more' };
  }
  return { ready: false };
})()`;

const EDITOR_FOCUS_EXPRESSION = `(() => {
  const helpers = ${PAGE_HELPERS};
  const editor = helpers.revealComposerEditor();
  if (!editor) return null;
  editor.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  editor.focus({ preventScroll: true });
  const rect = editor.getBoundingClientRect();
  const wrap = editor.closest('.guidance-input-editor-wrapper, #input-engine-container') || editor;
  const wr = wrap.getBoundingClientRect();
  const box = wr.width >= 40 && wr.height >= 8 ? wr : rect;
  return { ok: true, x: Math.round(box.left + Math.min(28, Math.max(8, box.width / 2))), y: Math.round(box.top + Math.min(22, Math.max(8, box.height / 2))) };
})()`;

const PROMPT_READ_EXPRESSION = `(() => {
  const helpers = ${PAGE_HELPERS};
  const clean = helpers.clean;
  const editors = helpers.collectEditors();
  const values = [];
  for (const editor of editors) {
    for (const value of [editor.value, editor.innerText, editor.textContent]) {
      const text = clean(value);
      if (text && !values.includes(text)) values.push(text);
    }
  }
  values.sort((a, b) => b.length - a.length);
  return { value: values[0] || '', values };
})()`;

const ADD_ATTACHMENT_EXPRESSION = `(() => {
  const helpers = ${PAGE_HELPERS};
  helpers.dismissProjectModal();
  if (![...document.querySelectorAll('button,[role="button"]')].some(el => helpers.isModelChip(el))) return { skip: true, reason: 'not-video-composer' };
  const nodes = [...document.querySelectorAll('button,[role="button"],[aria-label],[title]')].filter(helpers.visible).filter(el => helpers.inComposerBand(el) && !helpers.isBlockedChrome(el));
  const hit = nodes.find(el => /添加参考|参考图|上传图片|upload image|add reference/i.test(helpers.labelOf(el)))
    || nodes.find(el => helpers.clean(el.innerText || el.textContent) === '+' && !/云盘|项目|技能|连接器/.test(helpers.labelOf(el)));
  if (!hit) return null;
  const rect = hit.getBoundingClientRect();
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), text: helpers.labelOf(hit) };
})()`;

function normalizePromptReadback(value) {
  return String(value || "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

async function ensureVideoMode(guest, timeoutMs = 45000) {
  if (!guest || guest.isDestroyed()) throw new Error("页面已关闭");
  await attach(guest);
  const restored = await restoreChatSurface(guest);
  if (restored.error) return restored;
  const deadline = Date.now() + Math.max(8000, Number(timeoutMs) || 45000);
  while (Date.now() < deadline) {
    const state = await evaluatePage(guest, VIDEO_MODE_EXPRESSION);
    if (state && state.offComposer) {
      const again = await restoreChatSurface(guest);
      if (again.error) return again;
      await sleep(450);
      continue;
    }
    if (state && state.ready) return { ok: true };
    if (state && state.x) await clickPoint(guest, state.x, state.y);
    await sleep(450);
  }
  return { error: "没有成功切换到豆包/Dola 视频生成模式" };
}

function promptOrderSignature(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split(/\n+/)
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function promptCloseEnough(got, wanted) {
  if (!wanted) return true;
  if (!got) return false;
  const a = normalizePromptReadback(got);
  const b = normalizePromptReadback(wanted);
  if (a !== b) return false;
  const wantedLines = promptOrderSignature(wanted);
  const gotLines = promptOrderSignature(got);
  if (wantedLines.length > 1 && gotLines.length === wantedLines.length) {
    return wantedLines.join("\n") === gotLines.join("\n");
  }
  return true;
}

async function fillComposerPrompt(guest, prompt) {
  if (!guest || guest.isDestroyed()) throw new Error("页面已关闭");
  await attach(guest);
  const restored = await restoreChatSurface(guest);
  if (restored.error) return restored;
  const expected = String(prompt || "");
  const wanted = normalizePromptReadback(expected);
  if (!wanted) return { ok: true, empty: true };
  const already = await evaluatePage(guest, PROMPT_READ_EXPRESSION).catch(() => null);
  const alreadyValues = Array.isArray(already && already.values) ? already.values : [already && already.value];
  if (alreadyValues.some(value => promptCloseEnough(value, wanted))) return { ok: true, alreadyFilled: true };
  const writeExpr = `(() => {
    const helpers = ${PAGE_HELPERS};
    const prompt = ${JSON.stringify(expected)};
    const clean = helpers.clean;
    const editor = helpers.revealComposerEditor();
    if (!editor) return { error: 'no-editor' };
    editor.focus();
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value')?.set || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(editor, prompt);
    } else {
      editor.innerHTML = '';
      document.execCommand('selectAll', false, null);
      const ok = document.execCommand('insertText', false, prompt);
      if (!ok || clean(editor.innerText || editor.textContent).length < 8) editor.textContent = prompt;
    }
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: prompt }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    const written = clean(editor.value || editor.innerText || editor.textContent);
    return { ok: written.length > 0, len: written.length };
  })()`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const focused = await evaluatePage(guest, EDITOR_FOCUS_EXPRESSION);
    if (focused && focused.ok) {
      await clickPoint(guest, focused.x, focused.y);
      await sleep(60);
      await pressKey(guest, "a", "KeyA", 65, 2);
      await sleep(30);
      await pressKey(guest, "Backspace", "Backspace", 8);
      await sleep(40);
      await send(guest, "Input.insertText", { text: expected }).catch(() => {});
    }
    await sleep(200);
    let read = await evaluatePage(guest, PROMPT_READ_EXPRESSION);
    let values = Array.isArray(read && read.values) ? read.values : [read && read.value];
    if (values.some(value => promptCloseEnough(value, wanted))) return { ok: true, attempts: attempt + 1 };
    await evaluatePage(guest, writeExpr).catch(() => null);
    await sleep(280);
    read = await evaluatePage(guest, PROMPT_READ_EXPRESSION);
    values = Array.isArray(read && read.values) ? read.values : [read && read.value];
    if (values.some(value => promptCloseEnough(value, wanted))) return { ok: true, attempts: attempt + 1 };
  }
  return { error: "提示词没有按画布原文顺序写入输入框；页面未接受本次填写" };
}

async function clickAddAttachment(guest) {
  const point = await evaluatePage(guest, ADD_ATTACHMENT_EXPRESSION);
  if (!point || point.skip || !point.x) return false;
  await clickPoint(guest, point.x, point.y);
  await sleep(350);
  return true;
}

function composerAttachmentsExpression() {
  return `(() => {
    const helpers = ${PAGE_HELPERS};
    const visible = helpers.visible;
    const clean = helpers.clean;
    const editor = helpers.revealComposerEditor() || helpers.pickEditor();
    const area = helpers.composerShell ? helpers.composerShell(editor) : (editor && editor.parentElement) || document.body;
    const named = document.querySelector('[data-testid="attachment_area"],[data-testid="video-attachment-scroll-container"]');
    const root = named || area;
    const er = editor ? editor.getBoundingClientRect() : { top: innerHeight * 0.7, left: 80, right: innerWidth - 40, bottom: innerHeight - 8 };
    const ar = root && root.getBoundingClientRect ? root.getBoundingClientRect() : er;
    const inHistory = el => Boolean(el.closest && el.closest('[data-testid="message-block-container"],[data-testid="send_message"],[data-testid="receive_message"]'));
    const inComposer = el => {
      const r = el.getBoundingClientRect();
      if (!visible(el) || inHistory(el)) return false;
      if (editor && editor.contains(el)) return false;
      if (r.width < 20 || r.height < 20 || r.width > 480 || r.height > 480) return false;
      const inShell = r.bottom > ar.top - 12 && r.top < ar.bottom + 12 && r.left > ar.left - 16 && r.right < ar.right + 16;
      const nearEditor = r.right > er.left - 64 && r.left < er.right + 64 && r.bottom > er.top - 520 && r.top < er.bottom + 32;
      return inShell || nearEditor;
    };
    const boxes = [];
    const remember = el => {
      const r = el.getBoundingClientRect();
      if (boxes.some(b => Math.abs(b.x - r.left) < 10 && Math.abs(b.y - r.top) < 10)) return;
      const img = el.tagName === 'IMG' ? el : el.querySelector && el.querySelector('img,canvas');
      const src = String((img && (img.currentSrc || img.src)) || el.currentSrc || el.src || '').slice(0, 400);
      boxes.push({ x: r.left, y: r.top, w: r.width, h: r.height, src });
    };
    const cards = named ? [...named.querySelectorAll('[data-testid="attachment-image-card"],[data-kind="image"]')].filter(visible) : [];
    if (cards.length) cards.forEach(remember);
    else {
      [...root.querySelectorAll('img,canvas')].filter(inComposer).filter(el => !/avatar|logo|icon|favicon/i.test(String(el.currentSrc || el.src || el.className || ''))).forEach(remember);
    }
    boxes.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const nearby = [];
    const candidates = root.querySelectorAll('span,div,p,label,small,[role="progressbar"]');
    for (let i = 0; i < candidates.length && nearby.length < 60; i++) {
      const el = candidates[i];
      const r = el.getBoundingClientRect();
      if (r.width > 520 || r.height > 56) continue;
      if (r.bottom <= er.top - 520 || r.top >= er.bottom + 48) continue;
      nearby.push(el);
    }
    const failed = nearby.some(el => /上传失败|图片上传失败|重新上传|upload failed/i.test(clean(el.innerText || el.textContent).slice(0, 80)));
    const percents = nearby.map(el => {
      const t = clean(el.innerText || el.textContent);
      return /^\\d{1,3}%$/.test(t) ? Number(t) : null;
    }).filter(n => n !== null && n < 100);
    const bars = nearby.filter(el => el.getAttribute && el.getAttribute('role') === 'progressbar').filter(visible);
    const uploadingText = nearby.some(el => /上传中|正在上传|uploading/i.test(clean(el.innerText || el.textContent).slice(0, 40)));
    const uploading = percents.length > 0 || uploadingText || bars.some(el => {
      const now = el.getAttribute('aria-valuenow');
      const max = Number(el.getAttribute('aria-valuemax') || 100);
      if (now !== null && now !== '' && Number.isFinite(Number(now))) return Number(now) < max;
      return false;
    });
    const deleteBtn = named && named.querySelector('[data-testid="attachment-delete-btn"]');
    let deletePoint = null;
    if (boxes[0]) {
      const card = cards[0] || null;
      const btn = card && card.querySelector('[data-testid="attachment-delete-btn"]');
      const br = btn && btn.getBoundingClientRect();
      if (br && br.width > 2 && br.height > 2) deletePoint = { x: br.left + br.width / 2, y: br.top + br.height / 2, hoverOnly: false };
      else deletePoint = { x: boxes[0].x + boxes[0].w / 2, y: boxes[0].y + boxes[0].h / 2, hoverOnly: true };
    }
    return { count: boxes.length, cards: boxes, uploading, failed, deletePoint, hasDelete: Boolean(deleteBtn) };
  })()`;
}

function averageHashFromBitmap(bitmap, width, height) {
  const pixels = width * height;
  if (!bitmap || bitmap.length < pixels * 4) return "";
  const gray = new Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const offset = i * 4;
    const blue = bitmap[offset];
    const green = bitmap[offset + 1];
    const red = bitmap[offset + 2];
    gray[i] = red * 0.299 + green * 0.587 + blue * 0.114;
  }
  const average = gray.reduce((sum, value) => sum + value, 0) / pixels;
  let bits = 0n;
  for (let i = 0; i < pixels; i++) {
    if (gray[i] >= average) bits |= (1n << BigInt(i));
  }
  return bits.toString(16).padStart(16, "0");
}

function signatureDistance(left, right) {
  if (!left || !right) return 64;
  if (left === right) return 0;
  if (!/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right) || left.length !== right.length) return 64;
  let bits = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (bits) {
    distance += Number(bits & 1n);
    bits >>= 1n;
  }
  return distance;
}

function signaturesMatchPrefix(actual, expected) {
  if (!Array.isArray(actual) || actual.length < expected.length) return false;
  return expected.every((value, index) => Boolean(value) && Boolean(actual[index]) && signatureDistance(actual[index], value) <= 10);
}

function signaturesReordered(actual, expected) {
  if (!expected.length || actual.length < expected.length) return false;
  const used = new Set();
  for (const value of expected) {
    const hit = actual.findIndex((item, index) => !used.has(index) && signatureDistance(item, value) <= 10);
    if (hit < 0) return false;
    used.add(hit);
  }
  return !signaturesMatchPrefix(actual, expected);
}

async function hashAttachmentClipsInPage(guest, cards) {
  const list = (Array.isArray(cards) ? cards : []).map(card => ({
    x: Number(card.x) || 0,
    y: Number(card.y) || 0
  }));
  if (!list.length) return [];
  const hashes = await evaluatePage(guest, `(() => {
    const cards = ${JSON.stringify(list)};
    const ahash = el => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 8;
        canvas.height = 8;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return "";
        ctx.drawImage(el, 0, 0, 8, 8);
        const data = ctx.getImageData(0, 0, 8, 8).data;
        const gray = [];
        for (let i = 0; i < 64; i++) {
          const offset = i * 4;
          gray[i] = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
        }
        const average = gray.reduce((sum, value) => sum + value, 0) / 64;
        let bits = 0n;
        for (let i = 0; i < 64; i++) {
          if (gray[i] >= average) bits |= (1n << BigInt(i));
        }
        return bits.toString(16).padStart(16, "0");
      } catch {
        return "";
      }
    };
    const images = [...document.querySelectorAll("img,canvas")];
    return cards.map(card => {
      const el = images.find(img => {
        const r = img.getBoundingClientRect();
        return Math.abs(r.left - card.x) < 14 && Math.abs(r.top - card.y) < 14;
      });
      return el ? ahash(el) : "";
    });
  })()`);
  return Array.isArray(hashes) ? hashes : [];
}

async function hashAttachmentClip(guest, card) {
  const hashes = await hashAttachmentClipsInPage(guest, [card]);
  return hashes[0] || "";
}

function hashLocalImageFile(file) {
  const { nativeImage } = require("electron");
  try {
    const image = nativeImage.createFromPath(file).resize({ width: 8, height: 8, quality: "better" });
    const size = image.getSize();
    return averageHashFromBitmap(image.toBitmap(), size.width, size.height);
  } catch {
    return "";
  }
}

function matchAttachmentOrder(actualHashes, expectedHashes) {
  if (!expectedHashes.length || actualHashes.length < expectedHashes.length) return { ok: false, reason: "缩略图数量不足，无法核对顺序" };
  const used = new Set();
  const positions = [];
  for (const expected of expectedHashes) {
    let best = -1;
    let bestDistance = 65;
    actualHashes.forEach((actual, index) => {
      if (used.has(index)) return;
      const distance = signatureDistance(actual, expected);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    if (best < 0) return { ok: false, reason: "页面缩略图无法与画布参考图对应" };
    positions.push({ index: best, distance: bestDistance });
    used.add(best);
  }
  const confident = positions.every(item => item.distance <= 16);
  if (!confident) return { ok: true, uncertain: true, positions: positions.map(item => item.index) };
  const identity = positions.every((item, index) => item.index === index);
  if (!identity) return { ok: false, reason: "页面从左到右的图片顺序与画布不一致", positions: positions.map(item => item.index) };
  return { ok: true, positions: positions.map(item => item.index) };
}

async function readComposerAttachmentSignatures(guest, options = {}) {
  const snap = await evaluatePage(guest, composerAttachmentsExpression()) || { count: 0, cards: [], uploading: false, failed: false };
  const cards = Array.isArray(snap.cards) ? snap.cards : [];
  const srcs = cards.map(card => String(card.src || "").trim()).filter(Boolean);
  const uniqueSrcs = !options.forceHash && srcs.length === cards.length && new Set(srcs).size === srcs.length;
  const signatures = uniqueSrcs
    ? srcs
    : (await hashAttachmentClipsInPage(guest, cards));
  return {
    count: cards.length,
    cards,
    signatures,
    uploading: Boolean(snap.uploading),
    failed: Boolean(snap.failed),
    deletePoint: snap.deletePoint || null
  };
}

async function clearComposerAttachments(guest) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const snap = await evaluatePage(guest, composerAttachmentsExpression());
    if (!snap || !snap.count || !snap.deletePoint) return;
    if (snap.deletePoint.hoverOnly) {
      await hoverPoint(guest, snap.deletePoint.x, snap.deletePoint.y);
      await sleep(180);
    }
    const again = await evaluatePage(guest, composerAttachmentsExpression());
    const point = again && again.deletePoint;
    if (!point || !point.x) return;
    await clickPoint(guest, point.x, point.y);
    await sleep(260);
  }
}

async function waitComposerAttachmentOrder(guest, expectedCount, previousSignatures, timeoutMs = 45000) {
  const deadline = Date.now() + Math.max(4000, Number(timeoutMs) || 45000);
  let last = null;
  while (Date.now() < deadline) {
    last = await readComposerAttachmentSignatures(guest);
    if (last.failed) throw new Error("页面提示参考图上传失败，已停止以免顺序错乱");
    if (!last.uploading && last.signatures.length >= expectedCount && signaturesReordered(last.signatures, previousSignatures)) {
      await sleep(400);
      const swapped = await readComposerAttachmentSignatures(guest);
      if (!swapped.uploading && signaturesReordered(swapped.signatures, previousSignatures)) {
        throw new Error(`参考图顺序与画布不一致：页面已出现前 ${previousSignatures.length} 张，但从左到右的位置对不上`);
      }
    }
    const ready = !last.uploading
      && last.signatures.length >= expectedCount
      && last.signatures.slice(0, expectedCount).every(Boolean)
      && signaturesMatchPrefix(last.signatures, previousSignatures);
    if (ready) {
      await sleep(220);
      const confirm = await readComposerAttachmentSignatures(guest);
      if (!confirm.uploading && confirm.signatures.length >= expectedCount && confirm.signatures.slice(0, expectedCount).every(Boolean) && signaturesMatchPrefix(confirm.signatures, previousSignatures)) {
        return confirm;
      }
    }
    await sleep(280);
  }
  const detail = last ? `缩略图 ${last.count || 0}/${expectedCount} 张${last.uploading ? "，仍在上传" : ""}` : "页面状态未知";
  throw new Error(`核对参考图顺序超时：${detail}`);
}

async function findComposerFileInput(guest) {
  let objectId = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const evaluated = await send(guest, "Runtime.evaluate", {
      expression: `([...document.querySelectorAll('input[type="file"]')].filter(input => !input.files || input.files.length === 0)[0]
        || [...document.querySelectorAll('input[type="file"]')].find(input => /image|png|jpe?g|webp|gif/i.test(input.accept || ''))
        || [...document.querySelectorAll('input[type="file"]')][0] || null)`,
      returnByValue: false,
      userGesture: true
    });
    objectId = evaluated && evaluated.result && evaluated.result.objectId;
    if (objectId) return objectId;
    await clickAddAttachment(guest);
    await sleep(280);
  }
  return null;
}

async function waitComposerBatchOrder(guest, expectedHashes, timeoutMs) {
  const expectedCount = expectedHashes.length;
  const deadline = Date.now() + Math.max(8000, Number(timeoutMs) || 45000);
  let last = null;
  while (Date.now() < deadline) {
    last = await readComposerAttachmentSignatures(guest, { forceHash: true });
    if (last.failed) throw new Error("页面提示参考图上传失败，已停止以免顺序错乱");
    if (!last.uploading && last.signatures.length >= expectedCount && last.signatures.slice(0, expectedCount).every(Boolean)) {
      await sleep(280);
      const confirm = await readComposerAttachmentSignatures(guest, { forceHash: true });
      if (!confirm.uploading && confirm.signatures.length >= expectedCount && confirm.signatures.slice(0, expectedCount).every(Boolean)) {
        const visual = confirm.signatures.slice(0, expectedCount);
        const canMatch = visual.every(value => /^[0-9a-f]+$/i.test(value) && value.length === 16);
        if (canMatch) {
          const matched = matchAttachmentOrder(visual, expectedHashes);
          if (!matched.ok) throw new Error(matched.reason || "参考图顺序异常，已停止任务");
        }
        return confirm;
      }
    }
    await sleep(280);
  }
  const detail = last ? `缩略图 ${last.count || 0}/${expectedCount} 张${last.uploading ? "，仍在上传" : ""}` : "页面状态未知";
  throw new Error(`核对参考图顺序超时：${detail}`);
}

async function setComposerFilesSequential(guest, list) {
  const browserFiles = [];
  let orderSignatures = [];
  for (let index = 0; index < list.length; index++) {
    if (index > 0) {
      await waitComposerAttachmentOrder(guest, index, orderSignatures);
      await clickAddAttachment(guest);
      await sleep(320);
    }
    const objectId = await findComposerFileInput(guest);
    if (!objectId) throw new Error(`第 ${index + 1} 张参考图没有找到上传控件`);
    const described = await send(guest, "DOM.describeNode", { objectId });
    if (!described || !described.node || !described.node.backendNodeId) throw new Error(`第 ${index + 1} 张参考图上传控件不可用`);
    await send(guest, "DOM.setFileInputFiles", { files: [list[index]], backendNodeId: described.node.backendNodeId });
    const verified = await send(guest, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function(){return [...this.files].map(file=>({name:file.name,size:file.size,type:file.type}))}",
      returnByValue: true
    });
    const got = Array.isArray(verified && verified.result && verified.result.value) ? verified.result.value : [];
    const expectedName = path.basename(list[index]);
    if (!got.length) throw new Error(`第 ${index + 1} 张参考图没有进入上传控件`);
    const picked = got.find(file => file && file.name === expectedName) || got[got.length - 1] || got[0];
    browserFiles.push(picked);
    const settled = await waitComposerAttachmentOrder(guest, index + 1, orderSignatures);
    if (!signaturesMatchPrefix(settled.signatures, orderSignatures)) {
      throw new Error(`第 ${index + 1} 张参考图上传后，前面的图片顺序被页面打乱`);
    }
    orderSignatures = settled.signatures.slice(0, index + 1);
    if (orderSignatures.length !== index + 1 || orderSignatures.some(value => !value)) {
      throw new Error(`第 ${index + 1} 张参考图已交给页面，但缩略图顺序还核验不出来`);
    }
  }
  const finalOrder = await waitComposerAttachmentOrder(guest, list.length, orderSignatures);
  if (finalOrder.signatures.length !== list.length || !signaturesMatchPrefix(finalOrder.signatures, orderSignatures)) {
    throw new Error(`画布 ${list.length} 张参考图已上传，但页面从左到右的顺序与画布不一致`);
  }
  if (browserFiles.length !== list.length) throw new Error(`画布连接 ${list.length} 张参考图，但上传控件实际收到 ${browserFiles.length} 张`);
  return { ok: true, count: list.length, verifiedCount: browserFiles.length, browserFiles, orderSignatures };
}

async function setComposerFiles(guest, files) {
  if (!guest || guest.isDestroyed()) throw new Error("页面已关闭");
  await attach(guest);
  const restored = await restoreChatSurface(guest);
  if (restored.error) throw new Error(restored.error);
  await send(guest, "DOM.enable").catch(() => {});
  await send(guest, "Runtime.enable").catch(() => {});
  await send(guest, "Page.enable").catch(() => {});
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!list.length) return { ok: true, count: 0, verifiedCount: 0, orderSignatures: [] };
  await clearComposerAttachments(guest);
  const leftover = await readComposerAttachmentSignatures(guest);
  if (leftover.count) throw new Error(`输入框里还有 ${leftover.count} 张旧参考图，已停止上传以免和新图顺序混在一起`);
  if (list.length === 1) return setComposerFilesSequential(guest, list);
  await clickAddAttachment(guest);
  const objectId = await findComposerFileInput(guest);
  if (!objectId) throw new Error("没有找到可批量上传参考图的控件");
  const described = await send(guest, "DOM.describeNode", { objectId });
  if (!described || !described.node || !described.node.backendNodeId) throw new Error("批量上传控件不可用");
  await send(guest, "DOM.setFileInputFiles", { files: list, backendNodeId: described.node.backendNodeId });
  const verified = await send(guest, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: "function(){return [...this.files].map(file=>({name:file.name,size:file.size,type:file.type}))}",
    returnByValue: true
  });
  const got = Array.isArray(verified && verified.result && verified.result.value) ? verified.result.value : [];
  if (got.length !== list.length) {
    await clearComposerAttachments(guest);
    return setComposerFilesSequential(guest, list);
  }
  for (let index = 0; index < list.length; index++) {
    const expectedName = path.basename(list[index]);
    const actual = got[index];
    if (!actual || actual.name !== expectedName) {
      throw new Error(`批量上传后第 ${index + 1} 张文件顺序异常（期望 ${expectedName}，实际 ${actual && actual.name || "空"}），已停止任务`);
    }
  }
  const expectedHashes = list.map(file => hashLocalImageFile(file));
  const settled = await waitComposerBatchOrder(guest, expectedHashes, 12000 + list.length * 6000);
  return { ok: true, count: list.length, verifiedCount: got.length, browserFiles: got, orderSignatures: settled.signatures.slice(0, list.length), batched: true };
}

async function clickDolaSend(guest, options = {}) {
  if (!guest || guest.isDestroyed()) throw new Error("页面已关闭");
  await attach(guest);
  const expectedImages = Math.max(0, Number(options.expectedImages) || 0);
  const ready = await waitComposerReadyTwice(guest, expectedImages, options.timeoutMs || 120000);
  if (ready.error) return ready;
  let last = null;
  for (let attempt = 0; attempt < 14; attempt++) {
    const found = await send(guest, "Runtime.evaluate", { expression: FIND_SEND_BUTTON, returnByValue: true });
    const box = found && found.result && found.result.value;
    last = box;
    if (box && box.menuOpen) {
      await evaluatePage(guest, `(() => { const helpers = ${PAGE_HELPERS}; return helpers.dismissProjectModal(); })()`).catch(() => null);
      await pressEscape(guest);
      await sleep(220);
      continue;
    }
    if (box && box.x) {
      await clickPoint(guest, box.x, box.y);
      await sleep(70);
      await clickPoint(guest, box.x, box.y);
      await send(guest, "Runtime.evaluate", { expression: CLICK_SEND_BUTTON, returnByValue: true, userGesture: true });
      await sleep(480);
      const stateBox = await send(guest, "Runtime.evaluate", { expression: SEND_RESULT_STATE, returnByValue: true });
      const state = stateBox && stateBox.result && stateBox.result.value;
      if (state && (state.accepted || state.disabledNow)) return { ok: true, attempts: attempt + 1, state };
    }
    await sleep(260);
  }
  return { error: "发送按钮没有稳定点中，页面未受理", last };
}

function ingestFallbackRecipes(guest, recipes) {
  const items = (Array.isArray(recipes) ? recipes : []).map(item => ({
    type: "video",
    url: "",
    fallbackApi: normalizeFallbackApi((item && item.fallbackApi) || item || ""),
    keySeed: String((item && item.keySeed) || ""),
    videoId: String((item && item.videoId) || videoIdentity((item && item.fallbackApi) || item || "")),
    at: Number((item && item.at) || 0) || Date.now()
  })).filter(item => isHttpUrl(item.fallbackApi));
  const seeded = items.filter(item => item.keySeed || /[?&]key_seed=/i.test(item.fallbackApi));
  const chosen = seeded.length ? seeded : items;
  if (!chosen.length) return 0;
  rememberVideos(guest, chosen);
  return chosen.length;
}

async function resolveFromRecipes(guest, recipes) {
  const items = (Array.isArray(recipes) ? recipes : []).map((item, index) => ({
    fallbackApi: String((item && item.fallbackApi) || item || "").trim(),
    keySeed: String((item && item.keySeed) || ""),
    videoId: String((item && item.videoId) || videoIdentity((item && item.fallbackApi) || item || "")),
    at: Number((item && item.at) || 0),
    index
  })).filter(item => isHttpUrl(item.fallbackApi) && /[?&]key_seed=/i.test(item.fallbackApi));
  if (!items.length) return null;
  items.sort((a, b) => (b.at - a.at) || (b.index - a.index));
  for (const item of items.slice(0, 3)) {
    try {
      const resolved = await resolveChosenRecipe(guest, item);
      if (resolved && resolved.url) return resolved;
    } catch {}
  }
  return null;
}

module.exports = { attach, isAttached, peekCleanVideoUrl, peekAllCleanVideos, knownVideoKeys, inspectPageVideos, resolvePeekedCleanUrl, resolveCleanUrlForDownload, resolveFromRecipes, ingestFallbackRecipes, isPlayerPreviewUrl, isWatermarkedMediaUrl, isPlayInfoApiUrl, withUnwatermarkParams, getDoubaoVideoUrlFromFallbackApi, decodePayloadVideoUrl, hoverPoint, clickPoint, clickDolaSend, pressKey, pressEscape, waitComposerReady, waitComposerReadyTwice, ensureVideoMode, fillComposerPrompt, setComposerFiles, clickAddAttachment, restoreChatSurface, promptCloseEnough, promptOrderSignature, normalizePromptReadback, refererForFallback, videoIdentity };
