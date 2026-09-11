// 豆包无水印下载 - 页面注入端 v2.16-task-scope
// 被动监听豆包自身网络流量；下载/解密由 inject-daemon.mjs 经 CDP 轮询完成
(() => {
  const VERSION = "2.16-task-scope";
  if (window.__dbnw && window.__dbnw.VERSION === VERSION) return;
  try { window.__dbnw?.dispose?.(); } catch {}
  document.querySelectorAll("#dbnw-ui, #dbnw-preview").forEach((el) => el.remove());

  if (window.__dbnwHooks) {
    window.fetch = window.__dbnwHooks.fetch;
    XMLHttpRequest.prototype.open = window.__dbnwHooks.xhrOpen;
    XMLHttpRequest.prototype.send = window.__dbnwHooks.xhrSend;
    window.WebSocket = window.__dbnwHooks.WS;
  }
  window.__dbnwHooks = {
    fetch: window.fetch,
    xhrOpen: XMLHttpRequest.prototype.open,
    xhrSend: XMLHttpRequest.prototype.send,
    WS: window.WebSocket,
  };

  const state = {
    VERSION,
    items: [],
    tasks: [],
    log: [],
    logView: false,
    netlog: [],
    vidsamples: [],
    chainDump: null,
    auto: localStorage.getItem("dbnw:auto") !== "0",
    dir: localStorage.getItem("dbnw:dir") || "",
    captureContexts: [],
    disposed: false,
  };
  const seenPath = new Set();
  const seenKey = new Set();
  const seenDecrypt = new Set();
  // 启动静默期：页面加载后的同步爆发期不捕获历史图片，之后的切会话/按需读取不受影响
  const bootTs = Date.now();
  const HISTORY_QUIET_MS = 10000;

  function captureAllowed() {
    return state.captureContexts.length > 0 && !state.disposed;
  }

  state.setCaptureContexts = (raw) => {
    try {
      const contexts = typeof raw === "string" ? JSON.parse(raw) : raw;
      state.captureContexts = Array.isArray(contexts) ? contexts.filter((item) => item && item.jobId) : [];
      addLog(state.captureContexts.length ? `画布任务捕获已授权 x${state.captureContexts.length}` : "画布任务捕获已解除");
      render();
      return state.captureContexts.length;
    } catch {
      state.captureContexts = [];
      return 0;
    }
  };

  // CDP 可看到页面脚本创建之前已经存在的 WebSocket；只把帧内容送入同一套
  // 任务授权、历史基线和去重逻辑，不另开下载通道。
  state.ingestNetworkPayload = (payload, source = "cdp") => {
    try { scan(String(payload || ""), String(source || "cdp"), true); } catch {}
    return true;
  };

  // 列表持久化：切换会话页面重载后仍保留，去重键同步恢复
  function persist() {
    try {
      if (!state.items.length) {
        const cur = JSON.parse(localStorage.getItem("dbnw:items") || "[]");
        if (cur.length) return; // 空列表不覆盖非空存储（其他 target / 误操作保护）
      }
      const slim = state.items.slice(0, 200).map((i) => ({
        id: i.id, kind: i.kind, url: i.url, pathKey: i.pathKey, videoId: i.videoId,
        filename: i.filename, title: i.title, prompt: i.prompt, keySeed: i.keySeed,
        maybeWm: i.maybeWm, status: i.status === "downloading" || i.status === "queued" ? "new" : i.status,
        size: i.size, savedPath: i.savedPath,
      }));
      localStorage.setItem("dbnw:items", JSON.stringify(slim));
    } catch {}
  }
  function restore() {
    try {
      const arr = JSON.parse(localStorage.getItem("dbnw:items") || "[]");
      for (const it of arr) {
        it.url = normalizeUrl(it.url || "");
        state.items.push(it);
        if (it.pathKey) {
          seenPath.add(it.pathKey);
          if (it.pathKey.startsWith("vid:")) seenKey.add(it.pathKey);
        }
      }
    } catch {}
  }
  restore();

  const addLog = (msg) => {
    state.log.unshift(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (state.log.length > 120) state.log.length = 120;
  };
  const addNet = (url, ct, size) => {
    if (/mcs\.doubao|opt\.doubao|monitor_browser|\/list\b/.test(url + ct)) return;
    state.netlog.unshift(`${new Date().toLocaleTimeString()} ${ct || "?"} ${(size || 0) + "B"} ${url}`.slice(0, 220));
    if (state.netlog.length > 200) state.netlog.length = 200;
  };
  const addVidSample = (snippet) => {
    state.vidsamples.unshift(snippet.slice(0, 600));
    if (state.vidsamples.length > 20) state.vidsamples.length = 20;
  };

  const urlPath = (u) => { try { return new URL(u).pathname; } catch { return u; } };
  const vidFromUrl = (u) => { try { return new URL(u).pathname.split("/").filter(Boolean).pop() || ""; } catch { return ""; } };

  function makeImageName(key, url) {
    if (key) {
      const base = key.split("/").pop();
      if (base && /\.[a-z0-9]{3,5}$/i.test(base)) return base;
    }
    const ts = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");
    return `db_img_${ts}_${Math.random().toString(36).slice(2, 5)}.png`;
  }

  function addItem(kind, url, extra = {}) {
    if (!url) return;
    const p = urlPath(url);
    if (seenPath.has(p)) return;
    seenPath.add(p);
    // 未绑定画布任务时只建立历史基线，绝不创建条目或下载任务。
    if (!captureAllowed()) return;
    const item = {
      id: "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      kind, url, pathKey: p,
      filename: extra.filename || (kind === "image" ? makeImageName(extra.tosKey, url) : `db_video_${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "")}_${Math.random().toString(36).slice(2, 5)}.mp4`),
      status: "new", size: 0, savedPath: "",
      ...extra,
    };
    delete item.filename2;
    state.items.unshift(item);
    if (state.items.length > 200) state.items.length = 200;
    addLog(`捕获${kind === "image" ? "无水印图" : "视频"}: ${item.filename}`);
    if (state.auto) {
      item.status = "queued";
      state.tasks.push({ id: item.id, op: "download", url, filename: item.filename, noReferer: kind === "video" });
    }
    render();
  }

  function queueDecrypt(mainUrl, keySeed, via, itemId) {
    if (!captureAllowed()) return;
    const decryptKey = `${mainUrl}|${keySeed}`;
    if (seenDecrypt.has(decryptKey)) return;
    seenDecrypt.add(decryptKey);
    state.tasks.push({ id: itemId || "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), op: "decrypt", mainUrl, keySeed });
    addLog(`捕获加密视频(待解密) via ${via}`);
  }

  // 统一的视频捕获入口：vid 去重 → 建条目 → 自动模式下走页面 fallback 链路
  function queueVideo(fbUrl, seed, vid, title = "", via = "scan") {
    if (!fbUrl || !vid || seenKey.has("vid:" + vid)) return;
    seenKey.add("vid:" + vid);
    // 登录、切账号、打开历史会话时仍会看到历史 vid，但只能记入基线。
    if (!captureAllowed()) return;
    const item = {
      id: "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      kind: "video", url: fbUrl, pathKey: "vid:" + vid, videoId: vid,
      filename: `db_video_${vid}.mp4`, title: title.slice(0, 60),
      status: "new", size: 0, savedPath: "", via, keySeed: seed || "",
    };
    state.items.unshift(item);
    if (state.items.length > 200) state.items.length = 200;
    addLog(`捕获视频(${vid.slice(0, 16)}...) 走 fallback 解密链路`);
    if (state.auto) startVideoItem(item);
    render();
  }

  // 无水印配方在页面侧执行（fallback_api 需要 Cookie），daemon 只做解密 + 下载
  async function startVideoItem(it) {
    it.status = "queued";
    render();
    try {
      const u = new URL(it.url);
      u.searchParams.delete("force_fids");
      u.searchParams.delete("logo_type");
      // 0 请求 AVC/H.264；daemon 仍会在落盘前二次检测，必要时真实转码。
      u.searchParams.set("codec_type", "0");
      // 用原生 fetch 绕过自身 hook，避免响应被扫描器重复处理
      const r = await origFetch(u.toString());
      if (!r.ok) throw new Error(`fallback HTTP ${r.status}`);
      const j = await r.json();
      const vl = (j.video_info && j.video_info.data && j.video_info.data.video_list) || j.video_list || {};
      const codecScore = candidate => {
        const label = [candidate.codec_type, candidate.codec, candidate.vcodec, candidate.format, candidate.definition].join(" ").toLowerCase();
        if (/h264|avc/.test(label) || Number(candidate.codec_type) === 0) return 1000000000;
        if (/h265|hevc|bytevc1/.test(label) || Number(candidate.codec_type) === 1) return -1000000000;
        return 0;
      };
      const best = Object.values(vl).filter((g) => g && g.main_url).sort((a, b) => (codecScore(b) + Number(b.bitrate || 0)) - (codecScore(a) + Number(a.bitrate || 0)))[0];
      if (!best) throw new Error("fallback 响应无 main_url");
      addLog(`视频 ${it.videoId} ${best.definition || ""} 提取成功，待解密`);
      queueDecrypt(best.main_url, it.keySeed || u.searchParams.get("key_seed") || "", "fallback", it.id);
    } catch (e) {
      it.status = "error";
      addLog(`fallback 请求失败(${it.videoId}): ${e.message}`);
      render();
    }
  }

  // ---------- SSE STREAM_CHUNK 正式解析 ----------
  function parseSSEChunk(obj) {
    try {
      const blocks = [];
      const walk = (o, depth) => {
        if (!o || depth > 9) return;
        if (Array.isArray(o)) { for (const v of o) walk(v, depth + 1); return; }
        if (typeof o !== "object") return;
        const cb = o.creation_block || (o.content && o.content.creation_block);
        if (cb && Array.isArray(cb.creations)) blocks.push(cb.creations);
        for (const v of Object.values(o)) walk(v, depth + 1);
      };
      walk(obj, 0);
      for (const creations of blocks) {
        for (const c of creations) {
          if (c.type === 1 && c.image) {
            const img = c.image;
            const raw = (img.image_ori_raw && img.image_ori_raw.url) || "";
            if (raw && img.status === 2 && !seenKey.has(img.key)) {
              seenKey.add(img.key);
              const prompt = (img.gen_params && img.gen_params.prompt) || "";
              addItem("image", raw, { tosKey: img.key, filename: makeImageName(img.key, raw), prompt: prompt.slice(0, 60), via: "sse" });
            }
          }
          if (c.type === 2 || c.video) {
            const v = c.video || {};
            const u = (v.video_ori && v.video_ori.url) || v.video_url || "";
            const vmStr = typeof v.video_model === "string" ? v.video_model : "";
            let fb = "", seed = "";
            if (vmStr) { try { const vm = JSON.parse(vmStr); fb = vm.fallback_api || ""; seed = vm.key_seed || ""; } catch {} }
            if (!fb) fb = v.fallback_api || "";
            if (!seed) seed = v.key_seed || "";
            const vid = v.vid || vidFromUrl(fb);
            if (fb && seed && vid) {
              addVidSample("creation_video: " + JSON.stringify(v).slice(0, 600));
              queueVideo(normalizeUrl(fb), seed, vid, "", "sse");
            } else if (u) {
              addVidSample("creation_video_url: " + JSON.stringify(v).slice(0, 600));
              addItem("video", u, { via: "sse", maybeWm: true });
            } else {
              addVidSample("creation_video_other: " + JSON.stringify(c).slice(0, 600));
            }
          }
        }
      }
    } catch {}
  }

  // ---------- 通用文本扫描（兜底 + 侦察） ----------
  const RE_IMG = /"image_ori_raw":\s*\{[^{}]*?"url":\s*"([^"]+)"/g;
  const RE_MAIN_URL = /"main_url":\s*"(qAAB[^"]{40,})"/g;
  const RE_SEED = /"key_seed":\s*"([^"]+)"/g;
  const RE_FALLBACK = /"fallback_api":\s*"(https:[^"]+)"/g;
  const RE_VID = /"video_id":\s*"([^"]+)"/g;

  function unescJson(s) {
    return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, "/").replace(/\\{1,2}"/g, '"');
  }
  // 双层转义扁平化：&→& 等 + \\\" → "，让正则能命中嵌套 JSON 字符串里的字段和 URL
  const flatten = (s) =>
    s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\{1,2}"/g, '"');
  const normalizeUrl = (u) => u.replace(/\\u(0026|003d|003a)/gi, (_, h) => ({ "0026": "&", "003d": "=", "003a": ":" }[h.toLowerCase()]));

  function scanVideoFlat(flat, src) {
    let m;
    RE_FALLBACK.lastIndex = 0;
    while ((m = RE_FALLBACK.exec(flat))) {
      const fb = normalizeUrl(m[1]);
      let vid = vidFromUrl(fb), seed = "";
      try { seed = new URL(fb).searchParams.get("key_seed") || ""; } catch {}
      if (!vid) {
        const vm = flat.slice(Math.max(0, m.index - 600), m.index).match(/"video_id":\s*"([^"]+)"/);
        if (vm) vid = vm[1];
      }
      if (!seed) {
        RE_SEED.lastIndex = Math.max(0, m.index - 2000);
        const sm = RE_SEED.exec(flat);
        if (sm) seed = sm[1];
      }
      if (!vid || seenKey.has("vid:" + vid)) continue;
      const back = flat.slice(Math.max(0, m.index - 30000), m.index);
      let title = "";
      const tm = back.match(/(?:生成视频[：:]\s*|生成图片[：:]\s*|帮我生成[：:]?\s*)([^"\\]{4,60})/);
      const tbs = back.match(/"text_block":\{"text":"([^"]{4,80})"/g);
      if (tm) title = tm[0];
      else if (tbs) title = tbs[tbs.length - 1].replace(/^"text_block":\{"text":"|"$/g, "");
      queueVideo(fb, seed, vid, title, src);
    }
  }

  function scan(text, src, live) {
    if (!text || text.length < 20) return;
    if (/chain\/single/.test(src)) {
      state.chainDump = { src, time: new Date().toISOString(), len: text.length, body: text.slice(0, 2000000) };
      addLog(`chain/single 响应转储 ${text.length}B`);
    }
    let m;
    const flat = text.length < 400000 && /\\/.test(text) ? flatten(text) : text;
    // 图片：SSE 生成流始终捕获；历史/同步来源要过启动静默期，避免启动同步数据全量涌入
    if (live || Date.now() - bootTs > HISTORY_QUIET_MS) {
      let n = 0;
      RE_IMG.lastIndex = 0;
      while ((m = RE_IMG.exec(flat))) {
        const fwd = flat.slice(m.index, m.index + 2500);
        const pm = fwd.match(/"prompt":\s*"([^"]{4,80})"/);
        addItem("image", unescJson(m[1]), { via: src, prompt: pm ? unescJson(pm[1]).slice(0, 60) : "" });
        n++;
      }
      if (!live && n) addLog(`历史图片入列 x${n} (${urlPath(src).slice(0, 70)})`);
    } else if (flat.indexOf('"image_ori_raw"') >= 0) {
      addLog(`启动静默期跳过历史图片 (${urlPath(src).slice(0, 70)})`);
    }
    scanVideoFlat(flat, src);

    const seeds = [];
    RE_SEED.lastIndex = 0;
    while ((m = RE_SEED.exec(flat))) seeds.push(m[1]);
    if (seeds.length) {
      RE_MAIN_URL.lastIndex = 0;
      while ((m = RE_MAIN_URL.exec(flat))) queueDecrypt(m[1], seeds[0], src);
    }

    if (/video/i.test(text) && src !== "sse-buf") {
      const idx = flat.search(/"(?:video_model|fallback_api|video_url|main_url|vid"|video_id|play_info)/);
      if (idx >= 0) addVidSample(`${src} :: ${flat.slice(Math.max(0, idx - 50), idx + 550)}`);
    }
  }

  // ---------- hooks ----------
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
    p.then((res) => {
      try {
        const ct = res.headers.get("content-type") || "";
        if (/event-stream/i.test(ct)) {
          // 只扫描 clone，不替换豆包原响应的 body；捕获失败不影响原生消费者。
          const copy = res.clone();
          if (copy.body) scanSSE(copy.body, url);
        } else if (/json|text|event/i.test(ct) || /completion|message|chain|resource|media|share|video|play/i.test(url)) {
          res.clone().text().then((t) => { addNet(url + " [" + ct + "]", ct, t.length); scan(t, url); }).catch(() => {});
        } else {
          addNet(url, ct, 0);
        }
      } catch {}
    }).catch(() => {});
    return p;
  };

  function scanSSE(stream, src) {
    (async () => {
      const reader = stream.getReader();
      const dec = new TextDecoder();
      let acc = "";
      let processed = 0;
      try {
        for (;;) {
          if (state.disposed) { try { await reader.cancel(); } catch {} break; }
          const { done, value } = await reader.read();
          if (done) break;
          acc += dec.decode(value, { stream: true });
          if (acc.length > 300000) { acc = acc.slice(-200000); processed = acc.length; continue; }
          // 增量：处理自上次位置以来的新数据（图片完成事件在流末尾，必须及时处理），留 8KB 重叠防跨界截断
          const start = Math.max(0, processed - 8192);
          const fresh = acc.slice(start);
          processed = acc.length;
          for (const line of fresh.split("\n")) {
            if (line.indexOf("data:") !== 0) continue;
            const body = line.slice(5).trim();
            if (body[0] !== "{" || !/creation|video|image/.test(body)) continue;
            let obj;
            try { obj = JSON.parse(body); } catch { continue; }
            parseSSEChunk(obj);
          }
          scan(fresh, src, true);
        }
      } catch {}
    })();
  }

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__dbnwUrl = url;
    return xhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("loadend", () => {
      try {
        const u = this.__dbnwUrl || "xhr";
        if (this.responseType === "" || this.responseType === "text") { addNet(u, "xhr", (this.responseText || "").length); scan(this.responseText, u); }
        else if (this.responseType === "json" && this.response) { const t = JSON.stringify(this.response); addNet(u, "xhr/json", t.length); scan(t, u); }
        else if ((this.responseType === "arraybuffer" || this.responseType === "blob") && this.response) {
          const blob = this.responseType === "blob" ? this.response : new Blob([this.response]);
          addNet(u, "xhr/" + this.responseType + "/" + (blob.type || "bin"), blob.size);
          blob.text().then((t) => scan(t, u + "[bin]")).catch(() => {});
        }
      } catch {}
    });
    return xhrSend.apply(this, args);
  };

  const OrigWS = window.WebSocket;
  window.WebSocket = function WebSocket(...args) {
    const ws = new OrigWS(...args);
    ws.addEventListener("message", (e) => {
      if (typeof e.data === "string") { addNet("ws:" + (args[0] || ""), "ws", e.data.length); scan(e.data, "ws"); }
    });
    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;
  Object.setPrototypeOf(window.WebSocket, OrigWS); // 继承 CONNECTING/OPEN/CLOSING/CLOSED 等静态常量

  // 故障隔离：关闭插件或适配失败时，完整恢复豆包原生网络函数。
  state.dispose = () => {
    if (state.disposed) return true;
    state.disposed = true;
    try { window.fetch = window.__dbnwHooks.fetch; } catch {}
    try { XMLHttpRequest.prototype.open = window.__dbnwHooks.xhrOpen; } catch {}
    try { XMLHttpRequest.prototype.send = window.__dbnwHooks.xhrSend; } catch {}
    try { window.WebSocket = window.__dbnwHooks.WS; } catch {}
    try { clearInterval(quietTicker); } catch {}
    try { document.querySelectorAll("#dbnw-ui,#dbnw-preview").forEach(element => element.remove()); } catch {}
    return true;
  };

  // ---------- daemon 通道 ----------
  state.poll = (acksJson) => {
    try {
      const acks = acksJson ? JSON.parse(acksJson) : [];
      const byId = new Map(state.items.map((i) => [i.id, i]));
      for (const a of acks) {
        const linked = a.decryptUrl ? byId.get(a.id) : null;
        if (a.decryptUrl && linked) {
          // 挂钩条目的解密结果：直接下载回原条目，不再新建
          linked.status = "queued";
          state.tasks.push({ id: linked.id, op: "download", url: a.decryptUrl, filename: linked.filename, noReferer: true });
        } else if (a.decryptUrl) {
          addItem("video", a.decryptUrl, { via: "decrypt", maybeWm: false });
        } else if (byId.has(a.id)) {
          const it = byId.get(a.id);
          if (a.status === "downloading") it.status = "downloading";
          else if (a.ok) { it.status = "done"; it.size = a.size; it.savedPath = a.savedPath || ""; addLog(`已保存 ${it.filename} (${fmtSize(a.size)})`); }
          else { it.status = "error"; addLog(`下载失败 ${it.filename}: ${a.error || "unknown"}`); }
        }
      }
      if (acks.length) render();
    } catch (e) { addLog("poll err " + e.message); }
    const out = state.tasks.splice(0);
    return JSON.stringify({ tasks: out });
  };

  const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + "MB" : n > 1024 ? (n / 1024).toFixed(0) + "KB" : (n || 0) + "B");

  // ---------- UI ----------
  let ui = null, panel = null, panelOpen = false, pillIcon = null, pillLabel = null, pillBadge = null;
  function ensureUI() {
    if (ui && document.body.contains(ui)) return;
    ui = document.createElement("div");
    ui.id = "dbnw-ui";
    ui.style.cssText = "position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;width:max-content;";
    document.body.appendChild(ui);

    const pill = document.createElement("div");
    pill.style.cssText = `display:flex;align-items:center;gap:8px;padding:7px 15px;border-radius:999px;cursor:pointer;user-select:none;
      background:linear-gradient(135deg,rgba(38,42,54,.9),rgba(26,29,38,.94));
      backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
      border:1px solid rgba(255,255,255,.13);color:#eef1f6;font-size:12.5px;font-weight:600;letter-spacing:.2px;
      box-shadow:0 4px 18px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.08);
      transition:transform .15s ease,box-shadow .15s ease,border-color .15s ease;`;
    pill.onmouseenter = () => { pill.style.transform = "translateY(-1px)"; pill.style.boxShadow = "0 6px 22px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.1)"; pill.style.borderColor = "rgba(120,170,255,.5)"; };
    pill.onmouseleave = () => { pill.style.transform = ""; pill.style.boxShadow = "0 4px 18px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.08)"; pill.style.borderColor = "rgba(255,255,255,.13)"; };
    const icon = document.createElement("span");
    icon.textContent = "⬇";
    icon.style.cssText = `width:19px;height:19px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;
      background:linear-gradient(135deg,#4f8cff,#2f6bff);color:#fff;box-shadow:0 1px 5px rgba(47,107,255,.55);transition:transform .4s ease;`;
    pillIcon = icon;
    const label = document.createElement("span");
    pillLabel = label;
    const badge = document.createElement("span");
    badge.style.cssText = `display:none;min-width:18px;height:18px;padding:0 5px;border-radius:9px;font-size:10.5px;font-weight:700;
      background:linear-gradient(135deg,#4f8cff,#2f6bff);color:#fff;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(47,107,255,.4);`;
    pillBadge = badge;
    pill.title = "倒计时为启动静默期，结束后切换会话即可捕获该会话的历史图片；点击展开捕获列表";
    pill.append(icon, label, badge);
    pill.onclick = () => {
      panelOpen = !panelOpen;
      if (panel) {
        panel.style.display = panelOpen ? "flex" : "none";
        if (panelOpen) {
          panel.style.opacity = "0";
          panel.style.transform = "translateX(-50%) translateY(-6px)";
          requestAnimationFrame(() => { panel.style.opacity = "1"; panel.style.transform = "translateX(-50%) translateY(0)"; });
        }
      }
    };
    ui.appendChild(pill);

    panel = document.createElement("div");
    panel.style.cssText = `display:none;flex-direction:column;position:absolute;top:calc(100% + 10px);left:50%;transform:translateX(-50%);
      width:360px;max-height:430px;overflow:hidden;border-radius:14px;color:#e8ebf2;font-size:12.5px;
      background:rgba(28,31,40,.94);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
      border:1px solid rgba(255,255,255,.1);box-shadow:0 12px 40px rgba(0,0,0,.5);
      transition:opacity .18s ease,transform .18s ease;`;
    ui.appendChild(panel);
    render();
  }

  // 胶囊按钮状态：待处理数 + 启动静默期倒计时
  function updatePill() {
    if (!pillLabel || !pillLabel.isConnected) return;
    const pend = state.items.filter((i) => i.status !== "done").length;
    const left = Math.ceil((bootTs + HISTORY_QUIET_MS - Date.now()) / 1000);
    pillLabel.textContent = left > 0 ? `请等待 ${left}s 后再切换会话` : "豆包无水印";
    pillBadge.style.display = pend ? "flex" : "none";
    pillBadge.textContent = String(pend);
    if (pillIcon) pillIcon.style.transform = pend ? "rotate(360deg)" : "";
  }

  // ---------- 图片预览 ----------
  let previewOv = null, previewKey = null;
  function closePreview() {
    if (previewOv) { previewOv.remove(); previewOv = null; }
    if (previewKey) { document.removeEventListener("keydown", previewKey); previewKey = null; }
  }
  function openPreview(it) {
    closePreview();
    const ov = document.createElement("div");
    ov.id = "dbnw-preview";
    ov.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(10,12,18,.85);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;cursor:zoom-out;";
    const img = document.createElement("img");
    img.src = it.url;
    img.alt = it.filename;
    img.style.cssText = "max-width:92vw;max-height:80vh;border-radius:10px;box-shadow:0 18px 60px rgba(0,0,0,.6);";
    const cap = document.createElement("div");
    cap.style.cssText = "color:#dfe5ef;font-size:12px;font-family:'Segoe UI',system-ui,sans-serif;max-width:80vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    cap.textContent = ((it.title || it.prompt || "") + "  " + it.filename).trim();
    const hint = document.createElement("div");
    hint.style.cssText = "color:#7a8496;font-size:10.5px;";
    hint.textContent = "点击任意处 / Esc 关闭";
    img.onerror = () => { cap.textContent = "图片加载失败（链接可能已过期）: " + it.filename; };
    ov.append(img, cap, hint);
    ov.onclick = closePreview;
    previewKey = (e) => { if (e.key === "Escape") closePreview(); };
    document.addEventListener("keydown", previewKey);
    (document.body || document.documentElement).appendChild(ov);
    previewOv = ov;
  }

  function render() {
    if (!document.body) { setTimeout(render, 500); return; }
    persist();
    ensureUI();
    updatePill();
    if (!panel) return;
    panel.innerHTML = "";
    const head = document.createElement("div");
    head.style.cssText = "padding:12px 14px 10px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,.08);";
    const htitle = document.createElement("div");
    htitle.style.cssText = "font-weight:700;font-size:13px;";
    htitle.textContent = "捕获列表";
    const autoBtn = document.createElement("label");
    autoBtn.style.cssText = "cursor:pointer;display:flex;gap:6px;align-items:center;font-size:11.5px;color:#aab3c5;";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.auto;
    cb.style.accentColor = "#4f8cff";
    cb.onchange = () => {
      state.auto = cb.checked;
      localStorage.setItem("dbnw:auto", cb.checked ? "1" : "0");
    };
    autoBtn.append(cb, document.createTextNode("自动下载"));
    head.append(htitle, autoBtn);
    panel.appendChild(head);

    const list = document.createElement("div");
    list.style.cssText = "overflow-y:auto;padding:6px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.2) transparent;";
    if (state.logView) {
      if (!state.log.length) {
        const e = document.createElement("div");
        e.style.cssText = "padding:22px;color:#7a8496;text-align:center;font-size:12px;";
        e.textContent = "暂无日志";
        list.appendChild(e);
      }
      for (const line of state.log) {
        const e = document.createElement("div");
        e.style.cssText = "padding:4px 8px;font-size:10.5px;color:#9aa5b8;font-family:Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
        e.title = line;
        e.textContent = line;
        list.appendChild(e);
      }
    }
    if (!state.logView && !state.items.length) {
      const e = document.createElement("div");
      e.style.cssText = "padding:22px;color:#7a8496;text-align:center;font-size:12px;";
      e.textContent = "生成图片 / 视频后自动出现在这里";
      list.appendChild(e);
    }
    for (const it of state.logView ? [] : state.items) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:9px;padding:8px;border-radius:9px;transition:background .12s ease;";
      row.onmouseenter = () => (row.style.background = "rgba(255,255,255,.06)");
      row.onmouseleave = () => (row.style.background = "");
      const isImg = it.kind === "image";
      let tag;
      if (isImg) {
        tag = document.createElement("img");
        tag.src = it.url;
        tag.loading = "lazy";
        tag.style.cssText = "flex:0 0 30px;height:30px;border-radius:8px;object-fit:cover;background:rgba(79,140,255,.16);cursor:zoom-in;";
      } else {
        tag = document.createElement("span");
        tag.style.cssText = "flex:0 0 30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;background:rgba(255,110,80,.16);color:#ff8f70;";
        tag.textContent = "视";
      }
      const name = document.createElement("div");
      name.style.cssText = "flex:1;overflow:hidden;white-space:nowrap;";
      const title = document.createElement("div");
      title.style.cssText = "overflow:hidden;text-overflow:ellipsis;font-size:12px;color:#e8ebf2;";
      title.textContent = (it.title || it.prompt || it.filename) + (it.maybeWm ? " (可能带水印)" : "");
      const sub = document.createElement("div");
      sub.style.cssText = "overflow:hidden;text-overflow:ellipsis;font-size:10px;color:#7a8496;";
      sub.textContent = it.filename;
      name.append(title, sub);
      name.title = (it.title || it.prompt || "") + "\n" + it.filename + "\n" + it.url;
      if (isImg) {
        name.style.cursor = "zoom-in";
        name.onclick = () => openPreview(it);
      }
      const btn = document.createElement("button");
      const st = { new: "下载", queued: "排队中", downloading: fmtSize(it.size), done: "已保存", error: "重试" }[it.status] || it.status;
      btn.textContent = st;
      const bc = { done: ["rgba(46,204,113,.15)", "#4ade80"], error: ["rgba(255,90,90,.15)", "#ff7a7a"], new: ["linear-gradient(135deg,#4f8cff,#2f6bff)", "#fff"], queued: ["rgba(255,255,255,.08)", "#aab3c5"], downloading: ["rgba(79,140,255,.18)", "#8ab6ff"] }[it.status] || ["rgba(255,255,255,.08)", "#e8ebf2"];
      btn.style.cssText = `flex:0 0 auto;border:none;border-radius:8px;padding:5px 12px;font-size:11.5px;font-weight:600;
        cursor:${it.status === "queued" || it.status === "downloading" ? "default" : "pointer"};
        background:${bc[0]};color:${bc[1]};transition:filter .12s ease;`;
      if (it.status !== "queued" && it.status !== "downloading") {
        btn.onmouseenter = () => (btn.style.filter = "brightness(1.18)");
        btn.onmouseleave = () => (btn.style.filter = "");
        btn.onclick = () => {
          if (it.status === "downloading" || it.status === "queued") return;
          if (it.videoId) { startVideoItem(it); return; }
          it.status = "queued";
          state.tasks.push({ id: it.id, op: "download", url: it.url, filename: it.filename, noReferer: it.kind === "video" });
          render();
        };
      }
      row.append(tag, name, btn);
      list.appendChild(row);
    }
    panel.appendChild(list);

    const foot = document.createElement("div");
    foot.style.cssText = "padding:9px 14px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid rgba(255,255,255,.08);color:#7a8496;font-size:10.5px;";
    const fpath = document.createElement("span");
    fpath.textContent = "Downloads / DoubaoNoWatermark";
    const clearBtn = document.createElement("span");
    clearBtn.textContent = "清空列表";
    clearBtn.style.cssText = "cursor:pointer;color:#6ba1ff;transition:color .12s ease;";
    clearBtn.onmouseenter = () => (clearBtn.style.color = "#8ab6ff");
    clearBtn.onmouseleave = () => (clearBtn.style.color = "#6ba1ff");
    const logBtn = document.createElement("span");
    logBtn.textContent = state.logView ? "返回列表" : "日志";
    logBtn.style.cssText = "cursor:pointer;color:#6ba1ff;transition:color .12s ease;";
    logBtn.onmouseenter = () => (logBtn.style.color = "#8ab6ff");
    logBtn.onmouseleave = () => (logBtn.style.color = "#6ba1ff");
    logBtn.onclick = () => { state.logView = !state.logView; render(); };
    let armed = false, armTimer = 0;
    clearBtn.onclick = () => {
      if (!armed) {
        armed = true;
        clearBtn.textContent = "确认清空？";
        clearBtn.style.color = "#ff7a7a";
        armTimer = setTimeout(() => { armed = false; clearBtn.textContent = "清空列表"; clearBtn.style.color = "#6ba1ff"; }, 3000);
        return;
      }
      clearTimeout(armTimer);
      state.items.length = 0;
      localStorage.setItem("dbnw:items", "[]");
      render();
    };
    foot.append(fpath, logBtn, clearBtn);
    panel.appendChild(foot);
  }

  window.__dbnw = state;
  addLog(`user.js v${VERSION} 已加载 @ ${location.href}`);
  console.log("[dbnw] v" + VERSION, location.href);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ensureUI);
  else ensureUI();

  // 静默期倒计时：结束后开启历史图片捕获并在日志里留痕
  const quietTicker = setInterval(() => {
    const left = Math.ceil((bootTs + HISTORY_QUIET_MS - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(quietTicker);
      addLog("启动静默期结束，历史图片捕获已开启");
    }
    updatePill();
  }, 500);
})();
