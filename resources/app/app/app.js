const SOFTWARE_SEAL = "JXPB-UI-a2f7c19e84d50b3c";
void SOFTWARE_SEAL;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const THEME_KEY = "jiaxing-canvas-theme";
function canvasTheme() {
  return document.documentElement.getAttribute("data-theme") === "day" ? "day" : "night";
}
function syncThemeButtons() {
  const theme = canvasTheme();
  $$("[data-set-theme]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.setTheme === theme));
  });
}
function setCanvasTheme(theme) {
  const next = theme === "day" ? "day" : "night";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  syncThemeButtons();
}
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;
const GRID_WORLD_SIZE = 22;
const freshState = { nodes: [], edges: [], jobs: [], selected: null, zoom: 1, pan: { x: 0, y: 0 }, activeProfileId: "default", generationChannel: "native" };
let restored;
try { restored = JSON.parse(localStorage.getItem("doubao-canvas-nodes-v3") || ""); } catch {}
const state = restored || freshState;
state.nodes = Array.isArray(state.nodes) ? state.nodes : [];
state.edges = Array.isArray(state.edges) ? state.edges : [];
state.jobs = Array.isArray(state.jobs) ? state.jobs : [];
const retiredImageNodeIds = new Set(state.nodes.filter(item => item.type === "image-gen").map(item => item.id));
if (retiredImageNodeIds.size) {
  try {
    localStorage.setItem("doubao-canvas-retired-image-nodes-v1", JSON.stringify({
      nodes: state.nodes.filter(item => retiredImageNodeIds.has(item.id)),
      edges: state.edges.filter(edge => retiredImageNodeIds.has(edge.from) || retiredImageNodeIds.has(edge.to)),
      jobs: state.jobs.filter(job => job.type === "image")
    }));
  } catch {}
  state.nodes = state.nodes.filter(item => !retiredImageNodeIds.has(item.id));
  state.edges = state.edges.filter(edge => !retiredImageNodeIds.has(edge.from) && !retiredImageNodeIds.has(edge.to));
  state.jobs = state.jobs.filter(job => job.type !== "image");
  if (retiredImageNodeIds.has(state.selected)) state.selected = null;
}
state.pan = state.pan || { x: 0, y: 0 };
state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(state.zoom) || 1));
state.activeProfileId ||= "default";
state.generationChannel ||= "native";
const MAX_VIDEO_REFERENCES = 10;
const REFERENCE_NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

state.nodes.forEach(item => {
  if (item.type === "image") {
    item.w = Math.min(Number(item.w) || 280, 280);
    item.h = 210;
  }
  if (item.type === "video") {
    item.w = Math.min(Number(item.w) || 470, 470);
    item.h = 390;
    item.status = item.status === "waiting" ? "draft" : (item.status || "draft");
    const videoModels = ["Seedance 2.5", "Seedance 2.0", "Seedance 2.0 Fast", "Seedance 2.0 Mini"];
    item.model = item.model === "Seedance Fast" || item.model === "客户端当前模型" ? "Seedance 2.0 Fast" : item.model;
    if (!videoModels.includes(item.model)) item.model = "Seedance 2.0 Fast";
    item.ratio ||= "16:9";
    item.duration = /^(?:[4-9]|1\d|2\d|30)秒$/.test(item.duration || "") ? item.duration : "10秒";
    const maximumDuration = videoDurationLimit(item);
    if (Number.parseInt(item.duration, 10) > maximumDuration) item.duration = `${maximumDuration}秒`;
    item.profileId ||= item.account || state.activeProfileId;
    item.refOrder = Array.isArray(item.refOrder) ? item.refOrder : [];
    item.prompt = String(item.prompt || "")
      .replace(/图([一二三四五六七八九十])（@图片(?:10|[1-9])）/g, "（图$1）")
      .replace(/@?（@?图([一二三四五六七八九十])）/g, "（图$1）")
      .replace(/@图片(10|[1-9])/g, (_match, order) => referenceToken(Number(order) - 1));
    delete item.quality;
  }
});

function videoDurationLimit(item) {
  if (item?.model === "Seedance 2.5" || state.generationChannel === "browser") return 30;
  return 15;
}
state.jobs = state.jobs.map(({ images, quality, ...job }) => ({ ...job, status: job.status === "正在传送到豆包" ? "上次提交已中断" : job.status })).slice(0, 100);

let profiles = [];
let gesture = null;
let connection = null;
let menuPoint = { x: 200, y: 160 };
let idSeed = Date.now();
let saveTimer = 0;
let composerSyncTimer = 0;
let wireFrame = 0;
let viewportFrame = 0;
let nodeDragFrame = 0;
let toastTimer = 0;
let panelMode = "node";
let sidebarOpen = false;
const undoStack = [];
const UNDO_LIMIT = 40;
const RUNTIME_NODE_FIELDS = ["status", "lastJobId", "output", "file", "outputs", "selectedOutput"];
// 仅保存在当前界面的编辑状态，不写入节点、任务或提交队列。
const expandedPrompts = new Set();
const selectedIds = new Set();
let canvasPointerMode = "select";
let spacePanHeld = false;
const PORT_SNAP_PX = 44;
function findNode(id) {
  return state.nodes.find(item => item.id === id || String(item.id) === String(id));
}
function selectedNode() {
  return findNode(state.selected);
}

function undoSnapshot() {
  return JSON.parse(JSON.stringify({
    nodes: state.nodes.map(node => node.type === "image" ? { ...node, image: node.image ? `idb:${node.id}` : "" } : node),
    edges: state.edges,
    selected: state.selected
  }));
}

function updateUndoButton() {
  const button = $("#undoBtn");
  if (button) button.disabled = undoStack.length === 0;
}

function checkpointUndo() {
  const snapshot = undoSnapshot();
  const serialized = JSON.stringify(snapshot);
  if (undoStack.length && undoStack[undoStack.length - 1].serialized === serialized) return;
  undoStack.push({ snapshot, serialized });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  updateUndoButton();
}

function undoCanvasStep() {
  const entry = undoStack.pop();
  if (!entry) return flash("当前没有可以返回的上一步");
  const currentNodes = new Map(state.nodes.map(node => [String(node.id), node]));
  const restoredNodes = entry.snapshot.nodes.map(node => {
    const current = currentNodes.get(String(node.id));
    if (!current) return node;
    const restored = { ...node };
    for (const field of RUNTIME_NODE_FIELDS) if (Object.prototype.hasOwnProperty.call(current, field)) restored[field] = current[field];
    return restored;
  });
  state.nodes.splice(0, state.nodes.length, ...restoredNodes);
  state.edges.splice(0, state.edges.length, ...entry.snapshot.edges);
  state.selected = entry.snapshot.selected;
  [...selectedIds].forEach(id => { if (!findNode(id)) selectedIds.delete(id); });
  if (state.selected && !findNode(state.selected)) state.selected = null;
  if (editingVideoId && !findNode(editingVideoId)) editingVideoId = null;
  saveNow();
  render();
  renderPanel();
  updateUndoButton();
  flash("已返回上一步");
}

function applyPromptExpansion(element, expanded) {
  element?.querySelector(".promptWrap")?.classList.toggle("expanded", expanded);
  const button = element?.querySelector("[data-expand-prompt]");
  if (button) {
    button.textContent = expanded ? "收起" : "展开编辑";
    button.setAttribute("aria-expanded", String(expanded));
  }
}

function setPromptExpanded(id, expanded, focus = false) {
  if (expanded) expandedPrompts.add(id); else expandedPrompts.delete(id);
  const element = document.querySelector(`#canvas .node[data-id="${CSS.escape(String(id))}"]`);
  applyPromptExpansion(element, expanded);
  if(editingVideoId===id)showVideoEditor(id);
  if (focus) element?.querySelector(".prompt textarea")?.focus({ preventScroll: true });
  scheduleWires();
}

function setSidebarOpen(open, mode = panelMode) {
  sidebarOpen = open;
  panelMode = mode;
  $("#sidebar").hidden = !open;
  $("#helpToggle").setAttribute("aria-expanded", String(open && mode !== "history"));
  if (open) renderPanel();
}

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const uid = prefix => `${prefix}${++idSeed}`;
function nodeBox(item) {
  const element = document.querySelector(`#canvas .node[data-id="${CSS.escape(String(item.id))}"]`);
  return {
    w: element?.offsetWidth || Number(item.w) || 280,
    h: element?.offsetHeight || Number(item.h) || (item.type === "video" ? 390 : 210)
  };
}

function selectionNodes() {
  const nodes = [...selectedIds].map(findNode).filter(Boolean);
  if (nodes.length) return nodes;
  const current = selectedNode();
  return current ? [current] : [];
}

function isSelected(id) {
  return selectedIds.has(String(id)) || state.selected === id;
}

function paintSelection() {
  $$("#canvas .node").forEach(element => {
    element.classList.toggle("selected", isSelected(element.dataset.id));
  });
  const count = selectedIds.size || (state.selected ? 1 : 0);
  const bar = $("#arrangeBar");
  const label = $("#arrangeCount");
  if (label) label.textContent = count ? `已选 ${count}` : "未选择";
  if (bar) bar.hidden = count < 2;
}

function setSelection(ids, primary) {
  const unique = [...new Set((ids || []).map(id => String(id)).filter(id => findNode(id)))];
  selectedIds.clear();
  if (unique.length > 1) unique.forEach(id => selectedIds.add(id));
  state.selected = primary && unique.includes(String(primary)) ? primary : unique.at(-1) || null;
  paintSelection();
}

function selectOnly(id) {
  selectedIds.clear();
  state.selected = id || null;
  paintSelection();
}

function toggleSelected(id) {
  const key = String(id);
  if (!findNode(key)) return;
  const current = new Set(selectedIds);
  if (!current.size && state.selected) current.add(String(state.selected));
  if (current.has(key)) current.delete(key);
  else current.add(key);
  setSelection([...current], current.has(key) ? key : [...current].at(-1));
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function nodesInRect(x1, y1, x2, y2) {
  const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  if (box.w < 4 && box.h < 4) return [];
  return state.nodes.filter(item => {
    const size = nodeBox(item);
    return rectsOverlap(box, { x: item.x, y: item.y, w: size.w, h: size.h });
  });
}

function hideMarquee() {
  const marquee = $("#marquee");
  if (marquee) { marquee.hidden = true; marquee.removeAttribute("style"); }
}

function canvasPanActive() {
  return spacePanHeld || canvasPointerMode === "pan";
}

function syncCanvasPointerMode() {
  const stage = $("#stage");
  const tip = $(".canvas-tip");
  const button = $("#pointerModeBtn");
  const pan = canvasPanActive();
  stage?.classList.toggle("tool-pan", pan);
  stage?.classList.toggle("tool-select", !pan);
  document.documentElement.dataset.canvasTool = pan ? "pan" : "select";
  if (button) {
    button.textContent = pan ? "拖动画布" : "选择";
    button.setAttribute("aria-pressed", String(pan));
    button.title = pan ? "松开空格回到选择。中键也可拖动" : "按住空格不放再拖鼠标可移动画布；左键框选或拖节点";
  }
  if (tip) {
    tip.textContent = pan
      ? "按住空格拖动画布 · 松开空格回到选择 · 滚轮缩放 · 右键新建"
      : "按住空格拖动画布 · 左键框选 · Shift 加选 · 点节点可拖动 · 滚轮缩放";
  }
}

function toggleCanvasPointerMode() {
  canvasPointerMode = canvasPointerMode === "pan" ? "select" : "pan";
  hideMarquee();
  syncCanvasPointerMode();
}

function arrangeTargets() {
  const selected = selectionNodes();
  return selected.length >= 2 ? selected : state.nodes.slice();
}

function applyArrangedPositions(updates) {
  if (!updates.length) return;
  checkpointUndo();
  updates.forEach(({ id, x, y }) => {
    const item = findNode(id);
    if (!item) return;
    item.x = x;
    item.y = y;
  });
  save();
  render();
  paintSelection();
  flash("已排列节点");
}

function arrangeRow() {
  const nodes = arrangeTargets();
  if (nodes.length < 2) return flash("至少两个节点才能排列");
  const sorted = [...nodes].sort((a, b) => a.x - b.x || a.y - b.y);
  const y = Math.min(...sorted.map(item => item.y));
  let x = Math.min(...sorted.map(item => item.x));
  applyArrangedPositions(sorted.map(item => {
    const box = nodeBox(item);
    const next = { id: item.id, x, y };
    x += box.w + 36;
    return next;
  }));
}

function arrangeColumn() {
  const nodes = arrangeTargets();
  if (nodes.length < 2) return flash("至少两个节点才能排列");
  const sorted = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x);
  const x = Math.min(...sorted.map(item => item.x));
  let y = Math.min(...sorted.map(item => item.y));
  applyArrangedPositions(sorted.map(item => {
    const box = nodeBox(item);
    const next = { id: item.id, x, y };
    y += box.h + 28;
    return next;
  }));
}

function arrangeGrid() {
  const nodes = arrangeTargets();
  if (nodes.length < 2) return flash("至少两个节点才能排列");
  const sorted = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x);
  const originX = Math.min(...sorted.map(item => item.x));
  const originY = Math.min(...sorted.map(item => item.y));
  const maxWidth = Math.max(720, ($("#stage").getBoundingClientRect().width - 120) / state.zoom);
  let x = originX, y = originY, rowHeight = 0;
  const updates = [];
  for (const item of sorted) {
    const box = nodeBox(item);
    if (x > originX && x + box.w - originX > maxWidth) {
      x = originX;
      y += rowHeight + 36;
      rowHeight = 0;
    }
    updates.push({ id: item.id, x, y });
    x += box.w + 36;
    rowHeight = Math.max(rowHeight, box.h);
  }
  applyArrangedPositions(updates);
}

function arrangeTidy() {
  const pool = arrangeTargets();
  if (pool.length < 2) return flash("至少两个节点才能排列");
  const inPool = new Set(pool.map(item => item.id));
  const videos = pool.filter(item => item.type === "video").sort((a, b) => a.y - b.y || a.x - b.x);
  const used = new Set();
  const originX = Math.min(...pool.map(item => item.x));
  let y = Math.min(...pool.map(item => item.y));
  const updates = [];
  const place = (item, x, top) => {
    updates.push({ id: item.id, x, y: top });
    used.add(item.id);
    return nodeBox(item);
  };
  for (const video of videos) {
    const refs = edgeInputs(video.id).filter(item => inPool.has(item.id));
    const videoBox = nodeBox(video);
    let stackWidth = 0, stackHeight = 0;
    const stacks = refs.map(item => {
      const box = nodeBox(item);
      stackWidth = Math.max(stackWidth, box.w);
      stackHeight += box.h + 18;
      return { item, box };
    });
    if (stacks.length) stackHeight -= 18;
    let imageY = y;
    for (const { item, box } of stacks) {
      place(item, originX, imageY);
      imageY += box.h + 18;
    }
    place(video, originX + (stackWidth ? stackWidth + 40 : 0), y);
    y += Math.max(videoBox.h, stackHeight) + 48;
  }
  const leftovers = pool.filter(item => !used.has(item.id)).sort((a, b) => a.y - b.y || a.x - b.x);
  if (leftovers.length) {
    const maxWidth = Math.max(720, ($("#stage").getBoundingClientRect().width - 120) / state.zoom);
    let x = originX, rowHeight = 0;
    for (const item of leftovers) {
      const box = nodeBox(item);
      if (x > originX && x + box.w - originX > maxWidth) {
        x = originX;
        y += rowHeight + 28;
        rowHeight = 0;
      }
      place(item, x, y);
      x += box.w + 28;
      rowHeight = Math.max(rowHeight, box.h);
    }
  }
  applyArrangedPositions(updates);
}
const profileName = id => profiles.find(profile => profile.id === id)?.name || "豆包账号";
const quotaExhausted = (profile, capability = "video") => {
  const quota = profile?.quotas?.[capability];
  if (quota?.status === "exhausted") return true;
  return capability === "video" && profile?.quotaStatus === "exhausted";
};
const profileLabel = (profile, capability) => {
  const exhausted = capability
    ? quotaExhausted(profile, capability)
    : [quotaExhausted(profile, "video") ? "视频额度尽" : "", quotaExhausted(profile, "image") ? "图片额度尽" : ""].filter(Boolean).join("、");
  return `${profile.name}${exhausted ? `（${exhausted === true ? "今日额度已用完" : exhausted}）` : !profile.accountName ? "（待同步）" : ""}`;
};

const imageDatabase = new Promise((resolve, reject) => {
  const request = indexedDB.open("doubao-canvas-assets", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("images");
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const storedImages = new Map();
const imageDisplay = new Map();
let canvasBooting = false;
const MAX_IMPORT_BATCH = 40;
const MAX_IMAGE_BYTES = 28 * 1024 * 1024;
const DISPLAY_MAX_EDGE = 720;
let imageImportQueue = Promise.resolve();

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
}

async function sourceToBlob(data) {
  if (!data) return null;
  if (data instanceof Blob) return data;
  const raw = String(data);
  if (!raw || raw.startsWith("idb:")) return null;
  if (raw.startsWith("data:") || /^(blob:|https?:|file:)/i.test(raw)) {
    try { return await (await fetch(raw)).blob(); } catch { return null; }
  }
  return null;
}

async function makeDisplayThumb(blob) {
  if (!blob || typeof createImageBitmap !== "function") return blob;
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, DISPLAY_MAX_EDGE / Math.max(bitmap.width, bitmap.height, 1));
    if (scale >= 0.98 && blob.size < 900 * 1024) {
      bitmap.close?.();
      return blob;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const thumb = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.82));
    return thumb || blob;
  } catch {
    return blob;
  }
}

async function putImage(id, data) {
  if (!data || (typeof data === "string" && data.startsWith("idb:"))) return;
  const blob = await sourceToBlob(data);
  if (!blob || !blob.size) return;
  try {
    const database = await imageDatabase;
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("images", "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error("图片保存失败"));
      transaction.objectStore("images").put(blob, id);
    });
    storedImages.set(id, blob);
    await ensureDisplayUrl(id, blob);
    storedImages.delete(id);
  } catch (error) {
    storedImages.delete(id);
    console.error("image save failed", error);
    throw error;
  }
}

function revokeDisplayImage(id) {
  const cached = imageDisplay.get(id);
  if (!cached) return;
  if (String(cached.url || "").startsWith("blob:")) {
    try { URL.revokeObjectURL(cached.url); } catch {}
  }
  imageDisplay.delete(id);
}

async function ensureDisplayUrl(id, data) {
  const cached = imageDisplay.get(id);
  if (cached?.url) return cached.url;
  const blob = data instanceof Blob ? data : await sourceToBlob(data) || await getImageBlob(id);
  if (!blob) return "";
  const thumb = await makeDisplayThumb(blob);
  const url = URL.createObjectURL(thumb);
  revokeDisplayImage(id);
  imageDisplay.set(id, { url });
  return url;
}

function displayImageSrc(item) {
  if (!item) return "";
  const pointer = String(item.image || "");
  if (/^(blob:|https?:|file:)/i.test(pointer)) return pointer;
  const cached = imageDisplay.get(item.id);
  if (cached?.url) return cached.url;
  if (pointer && !pointer.startsWith("idb:") && !pointer.startsWith("data:")) return pointer;
  return "";
}

async function getImageBlob(id) {
  const cached = storedImages.get(id);
  if (cached instanceof Blob) return cached;
  if (typeof cached === "string") return sourceToBlob(cached);
  try {
    const database = await imageDatabase;
    return await new Promise(resolve => {
      const request = database.transaction("images").objectStore("images").get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function getImage(id) {
  const blob = await getImageBlob(id);
  if (!blob) return "";
  if (typeof blob === "string") return blob.startsWith("data:") ? blob : "";
  return blobToDataUrl(blob);
}

async function deleteImage(id) {
  storedImages.delete(id);
  revokeDisplayImage(id);
  try {
    const database = await imageDatabase;
    database.transaction("images", "readwrite").objectStore("images").delete(id);
  } catch {}
}

function pinImageRef(item) {
  if (item?.type === "image") item.image = item.image ? `idb:${item.id}` : "";
  return item;
}

function compactState() {
  for (const item of state.nodes) {
    if (item.type === "image" && item.image && !String(item.image).startsWith("idb:")) {
      putImage(item.id, item.image).catch(() => {});
      item.image = `idb:${item.id}`;
    }
  }
  return {
    ...state,
    nodes: state.nodes.map(item => item.type === "image" ? { ...item, image: item.image ? `idb:${item.id}` : "" } : item),
    jobs: state.jobs.map(({ images, ...job }) => job).slice(0, 100)
  };
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  try { localStorage.setItem("doubao-canvas-nodes-v3", JSON.stringify(compactState())); }
  catch (error) { console.error("canvas save failed", error); }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 350);
}

function syncComposerFromCanvas(item) {
  if (state.generationChannel !== "browser" || item?.type !== "video") return;
  clearTimeout(composerSyncTimer);
  composerSyncTimer = setTimeout(() => {
    window.desktop.syncBrowserComposer?.({
      model: item.model,
      duration: item.duration,
      ratio: item.ratio,
      provider: item.provider || ""
    }).catch(() => {});
  }, 200);
}

function flash(message, duration = 3000) {
  const toast = $("#toast");
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("show");
  toastTimer = setTimeout(() => toast.classList.remove("show"), duration);
}

let progressJobId = null;
function hideProgress(jobId) {
  if (jobId && progressJobId !== jobId) return;
  $("#progressCard").classList.remove("show");
  progressJobId = null;
}

function showProgress(message, jobId) {
  const job = state.jobs.find(item => item.id === jobId);
  if (job?.stopped || (job && ['completed','failed','stopped','quota_exhausted','paid_blocked','conversion_pending','monitor_timeout','needs_attention','awaiting_backfill'].includes(job.state))) return;
  progressJobId = jobId || null;
  $("#progressCard").classList.add("show");
  $("#progressTitle").textContent = jobId ? `任务 ${jobId}` : "原生豆包连接";
  $("#progressText").textContent = message;
  if (job) { job.progressMessage = message; save(); }
}

const RUNNING_JOB_STATES = new Set(["preparing", "queued", "queued_account", "submitting", "waiting_prompt_recognition", "waiting_manual_submission", "recovering", "awaiting_receipt", "waiting_confirmation", "waiting_paid_confirmation", "generating", "monitor_paused", "stopping"]);
const JOB_BUTTON_LABELS = {
  preparing: "准备中",
  queued: "排队中",
  queued_account: "等待账号",
  submitting: "提交中",
  waiting_prompt_recognition: "识别提示词",
  waiting_manual_submission: "等待手动提交",
  recovering: "恢复中",
  awaiting_receipt: "核验中",
  waiting_confirmation: "待确认",
  needs_attention: "需处理",
  waiting_paid_confirmation: "额度确认",
  generating: "生成中",
  awaiting_backfill: "待回填",
  monitor_paused: "监听暂停",
  conversion_pending: "待转H.264",
  stopping: "正在停止",
  paid_blocked: "生成"
};

function applyJobState(payload) {
  const job = state.jobs.find(entry => entry.id === payload.jobId);
  const item = findNode(payload.nodeId || job?.nodeId);
  if (job?.stopped && !["stopping", "stopped", "awaiting_backfill", "completed"].includes(payload.state)) return;
  if(job && payload.sequence && payload.sequence <= (job.stateSequence||0))return;
  if(job?.state==='completed'&&!['completed','recovering','stopping','stopped'].includes(payload.state))return;
  const previousState = job?.state;
  const previousOutput = job?.output || item?.output || "";
  if (job) {
    if(payload.sequence)job.stateSequence=payload.sequence;
    job.state = payload.state;
    if(payload.state==='stopped')job.stopped=true;
    job.status = payload.message || job.status;
    if(payload.noWatermark)job.noWatermark=payload.noWatermark;
    if(payload.state==='awaiting_backfill'&&payload.url){job.output=payload.url;job.file=payload.file||'';job.pendingBackfill=true;job.stopped=false;if(payload.nodeTitle)job.title=job.title||payload.nodeTitle;}
    if(payload.state==='completed'&&payload.url){job.output=payload.url;job.file=payload.file||'';job.completedAt=payload.completedAt;job.pendingBackfill=false;job.stopped=false;}
    if (payload.quotaExhausted) job.quotaExhausted = true;
    if (payload.quotaNotDeducted) job.quotaNotDeducted = true;
    if (payload.retryable) job.retryable = true;
  }
  if (item && String(item.id) === String(payload.nodeId || item.id)) {
    if (payload.state === "completed" && payload.url) {
      item.output = payload.url;
      item.status = "completed";
      item.lastJobId = payload.jobId;
    } else if (item.lastJobId === payload.jobId || payload.state === "awaiting_backfill") {
      item.status = payload.state;
    }
  }
  if (["stopping", "stopped", "failed", "quota_exhausted", "paid_blocked", "completed", "conversion_pending", "monitor_timeout", "needs_attention", "awaiting_backfill"].includes(payload.state)) hideProgress(payload.jobId);
  else if(progressJobId===payload.jobId&&payload.message){
    $("#progressTitle").textContent=`任务 ${payload.jobId}`;
    $("#progressText").textContent=payload.message;
  }
  const heartbeat = previousState === payload.state && ["generating", "submitting", "preparing", "queued", "queued_account", "awaiting_receipt"].includes(payload.state);
  const outputChanged = Boolean(payload.url && payload.url !== previousOutput);
  if (heartbeat && !outputChanged) {
    const statusNode = item && document.querySelector(`#canvas .node[data-id="${CSS.escape(String(item.id))}"] .compactTaskStatus span`);
    if (statusNode && payload.message) statusNode.textContent = payload.message;
    if (sidebarOpen && panelMode === "history") renderHistoryPanel();
    return;
  }
  save();
  if (!canvasBooting) render();
}

function primeVideoPreview(video) {
  if (!video || video.dataset.previewPrimed) return;
  video.dataset.previewPrimed = "1";
  video.preload = "auto";
  video.playsInline = true;
  video.disablePictureInPicture = true;
  const applySize = () => {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      const preview = video.closest(".compactVideoPreview");
      if (preview) preview.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
      video.style.height = "100%";
      requestAnimationFrame(drawWires);
    }
  };
  const recoverCodec = async () => {
    if (video.dataset.previewConverted || video.videoWidth > 0) return;
    const src = video.currentSrc || video.getAttribute("src") || "";
    if (!src || !window.desktop?.ensureCanvasVideoPreview) return;
    video.dataset.previewConverted = "1";
    try {
      const result = await window.desktop.ensureCanvasVideoPreview(src);
      if (!result?.ok) return;
      const next = result.url || src;
      video.src = next.includes("?") ? `${next}&preview=1` : `${next}?preview=1`;
      video.load();
    } catch (error) {
      console.warn("canvas video preview convert failed", error);
    }
  };
  video.addEventListener("loadedmetadata", () => {
    applySize();
    if (video.videoWidth === 0) recoverCodec();
    try { video.currentTime = Math.min(0.15, Math.max(0.01, video.duration / 50)); } catch {}
  });
  video.addEventListener("loadeddata", () => { try { video.pause(); } catch {} }, { once: true });
  try { video.load(); } catch {}
}

function canvasPoint(clientX, clientY) {
  const bounds = $("#stage").getBoundingClientRect();
  return {
    x: (clientX - bounds.left - state.pan.x) / state.zoom,
    y: (clientY - bounds.top - state.pan.y) / state.zoom
  };
}

function viewportCanvasCenter() {
  const bounds = $("#stage").getBoundingClientRect();
  return canvasPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
}

function createImageNode(x, y, data = "", title = "参考图片") {
  const id = uid("img");
  const item = { id, type: "image", x, y, w: 280, h: 210, title, image: data ? `idb:${id}` : "" };
  if (data && !String(data).startsWith("idb:")) {
    putImage(id, data).then(() => { pinImageRef(item); save(); render(); }).catch(error => flash(`图片保存失败：${error.message}`, 6000));
  }
  state.nodes.push(item);
  selectedIds.clear();
  state.selected = item.id;
  showVideoEditor(null);
  save();
  render();
  return item;
}

function nextVideoNodeTitle() {
  const titles = new Set(state.nodes.filter(node => node.type === "video").map(node => String(node.title || "").trim()));
  if (!titles.has("视频生成") && !titles.has("视频生成 1")) return "视频生成";
  let index = 2;
  while (titles.has(`视频生成 ${index}`)) index += 1;
  return `视频生成 ${index}`;
}

function createVideoNode(x, y) {
  const item = {
    id: uid("vid"), type: "video", x, y, w: 350, h: 325, title: nextVideoNodeTitle(), prompt: "",
    ratio: "16:9", model: "Seedance 2.0 Fast", duration: "10秒", profileId: state.activeProfileId,
    status: "draft", output: "", refOrder: []
  };
  state.nodes.push(item);
  selectedIds.clear();
  state.selected = item.id;
  editingVideoId=item.id;
  save();
  render();
  return item;
}

function spawnLinkedVideoFromImage(image, point) {
  if (!isImageSourceNode(image)) return null;
  let x = point ? Number(point.x) : image.x + (Number(image.w) || 280) + 72;
  let y = point ? Number(point.y) - 40 : image.y;
  const occupied = () => state.nodes.some(node => node.type === "video" && Math.abs(node.x - x) < 36 && Math.abs(node.y - y) < 36);
  while (occupied()) y += 48;
  const video = {
    id: uid("vid"), type: "video", x, y, w: 350, h: 325, title: nextVideoNodeTitle(), prompt: "",
    ratio: "16:9", model: "Seedance 2.0 Fast", duration: "10秒", profileId: state.activeProfileId,
    status: "draft", output: "", refOrder: []
  };
  state.nodes.push(video);
  if (!state.edges.some(edge => edge.from === image.id && edge.to === video.id)) {
    state.edges.push({ id: uid("edge"), from: image.id, to: video.id });
    video.refOrder = [image.id];
  }
  state.selected = video.id;
  editingVideoId = video.id;
  save();
  render();
  flash("已弹出视频节点并连上这张参考图");
  requestAnimationFrame(() => document.querySelector(`[data-id="${CSS.escape(video.id)}"] .prompt textarea`)?.focus({ preventScroll: true }));
  return video;
}

function removeNode(id) {
  state.nodes = state.nodes.filter(item => item.id !== id);
  state.edges = state.edges.filter(edge => edge.from !== id && edge.to !== id);
  state.nodes.forEach(node => {
    if (node.type === "video" && Array.isArray(node.refOrder)) {
      node.refOrder = node.refOrder.filter(refId => refId !== id);
    }
  });
  if (state.selected === id) state.selected = null;
  selectedIds.delete(String(id));
  deleteImage(id);
  save();
  render();
}

function duplicateNode(item) {
  const copy = JSON.parse(JSON.stringify(item.type === "image" ? { ...item, image: item.image ? `idb:${item.id}` : "" } : item));
  copy.id = uid(item.type === "image" ? "img" : "vid");
  copy.x += 35;
  copy.y += 35;
  copy.title += " 副本";
  copy.status = "draft";
  copy.output = "";
  copy.lastJobId = "";
  copy.lastImageJobId = "";
  copy.lastImageClaim = "";
  if (item.type === "image" && item.image) {
    copy.image = `idb:${copy.id}`;
    getImageBlob(item.id).then(blob => blob && putImage(copy.id, blob)).then(() => render()).catch(() => {});
  }
  state.nodes.push(copy);
  if (item.type === "video") {
    for (const edge of state.edges.filter(entry => entry.to === item.id)) {
      if (state.edges.some(existing => existing.from === edge.from && existing.to === copy.id)) continue;
      state.edges.push({ id: uid("edge"), from: edge.from, to: copy.id });
    }
    copy.refOrder = Array.isArray(item.refOrder) && item.refOrder.length
      ? [...item.refOrder]
      : state.edges.filter(entry => entry.to === copy.id).map(entry => entry.from);
    applyVideoRefOrder(copy, copy.refOrder);
  }
  state.selected = copy.id;
  save();
  render();
}

function connectedFromIds(videoId) {
  return state.edges.filter(edge => edge.to === videoId).map(edge => edge.from);
}

function syncRefOrder(video) {
  if (!video || video.type !== "video") return [];
  const connected = connectedFromIds(video.id);
  const connectedSet = new Set(connected.map(String));
  const stored = (Array.isArray(video.refOrder) ? video.refOrder : []).filter(id => connectedSet.has(String(id)));
  const storedSet = new Set(stored.map(String));
  video.refOrder = [...stored, ...connected.filter(id => !storedSet.has(String(id)))];
  return video.refOrder;
}

function applyVideoRefOrder(video, orderedIds) {
  if (!video || video.type !== "video") return;
  const wanted = [...new Set((orderedIds || []).map(String))];
  video.refOrder = wanted;
  const others = state.edges.filter(edge => edge.to !== video.id);
  const kept = wanted.map(from => state.edges.find(edge => String(edge.from) === from && edge.to === video.id)).filter(Boolean);
  const leftover = state.edges.filter(edge => edge.to === video.id && !wanted.includes(String(edge.from)));
  state.edges = [...others, ...kept, ...leftover];
}

function edgeInputs(id) {
  const nodes = state.edges.filter(edge => edge.to === id).map(edge => findNode(edge.from)).filter(Boolean);
  const video = findNode(id);
  if (video?.type !== "video") return nodes;
  const order = syncRefOrder(video);
  const byId = new Map(nodes.map(node => [String(node.id), node]));
  return order.map(nodeId => byId.get(String(nodeId))).filter(Boolean);
}

function removeEdgeById(edgeId, silent) {
  const edge = state.edges.find(item => item.id === edgeId);
  if (!edge) return;
  state.edges = state.edges.filter(item => item.id !== edgeId);
  const video = findNode(edge.to);
  if (video?.type === "video") {
    video.refOrder = (Array.isArray(video.refOrder) ? video.refOrder : []).filter(id => id !== edge.from);
  }
  if (selectedEdgeId === edgeId) selectedEdgeId = null;
  if (!silent) {
    save();
    render();
    flash("已删除连线");
  }
}

function removeVideoReference(video, imageId) {
  const edge = state.edges.find(item => item.to === video.id && item.from === imageId);
  if (edge) removeEdgeById(edge.id, true);
  if (video.refOrder) video.refOrder = video.refOrder.filter(id => id !== imageId);
  save();
  render();
}

function referenceImage(item) {
  if (item?.type !== "image") return "";
  if (item.image || storedImages.has(item.id) || imageDisplay.has(item.id)) return item.image || `idb:${item.id}`;
  return "";
}

const isImageSourceNode = item => item?.type === "image";

function addEdge(first, second) {
  if (first === second || !findNode(first) || !findNode(second)) return;
  let from = first;
  let to = second;
  if (findNode(from).type === "video" && isImageSourceNode(findNode(to))) [from, to] = [to, from];
  if (!isImageSourceNode(findNode(from)) || findNode(to).type !== "video") return flash("图片节点只能连接到视频节点");
  if (state.edges.some(edge => edge.from === from && edge.to === to)) return flash("这张参考图已经连接");
  if (state.edges.filter(edge => edge.to === to).length >= MAX_VIDEO_REFERENCES) return flash(`豆包视频节点最多连接 ${MAX_VIDEO_REFERENCES} 张参考图`);
  state.edges.push({ id: uid("edge"), from, to });
  const video = findNode(to);
  if (video?.type === "video") {
    syncRefOrder(video);
    if (!video.refOrder.includes(from)) video.refOrder.push(from);
  }
  save();
  render();
  flash("参考图片已连接");
}

function portMarkup() {
  return `<div class="port left" data-side="left" title="靠近即可吸附连线"></div><div class="port right" data-side="right" title="从这里拉线；图片右侧松开可弹出视频节点"></div>`;
}

function portClientCenter(id, side) {
  const node = document.querySelector(`#canvas .node[data-id="${CSS.escape(String(id))}"]`);
  const port = node?.querySelector(`.port.${side}`);
  const box = (port || node)?.getBoundingClientRect();
  if (!box) return null;
  if (port) return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  return { x: side === "right" ? box.right : box.left, y: box.top + box.height / 2 };
}

function nearestConnectTarget(fromId, clientX, clientY) {
  const source = findNode(fromId);
  if (!source) return null;
  const wantType = isImageSourceNode(source) ? "video" : "image";
  const side = wantType === "video" ? "left" : "right";
  let best = null;
  for (const item of state.nodes) {
    if (item.id === fromId || item.type !== wantType) continue;
    if (wantType === "video" && !isImageSourceNode(source)) continue;
    if (wantType === "image" && source.type !== "video") continue;
    const center = portClientCenter(item.id, side);
    if (!center) continue;
    const distance = Math.hypot(center.x - clientX, center.y - clientY);
    if (distance > PORT_SNAP_PX) continue;
    if (!best || distance < best.distance) best = { id: item.id, side, x: center.x, y: center.y, distance };
  }
  return best;
}

function paintPortMagnet(snapId) {
  $$("#canvas .node").forEach(element => {
    const on = Boolean(snapId) && element.dataset.id === String(snapId);
    element.classList.toggle("portTarget", on);
    element.querySelectorAll(".port").forEach(port => port.classList.toggle("magnet", on));
  });
}

function profileOptions(selectedId, capability) {
  return profiles.map(profile => `<option value="${escapeHtml(profile.id)}" ${profile.id === selectedId ? "selected" : ""}>${escapeHtml(profileLabel(profile, capability))}</option>`).join("");
}

function referenceToken(index) {
  return `（图${REFERENCE_NUMERALS[index] || index + 1}）`;
}

let editingVideoId = null;
let selectedEdgeId = null;
let lastEdgeClick = { id: null, at: 0 };
function pauseCanvasVideos() {
  $$("#canvas video").forEach(video => { try { video.pause(); } catch {} });
}

function syncVideoPreviewControls() {
  $$("#canvas .videoNode video").forEach(video => {
    const node = video.closest(".videoNode");
    const open = Boolean(node && editingVideoId && node.dataset.id === String(editingVideoId));
    if (open) video.setAttribute("controls", "");
    else video.removeAttribute("controls");
  });
}

function leaveVideoNodeMode() {
  pauseCanvasVideos();
  showVideoEditor(null);
}

function showVideoEditor(id) {
  editingVideoId=findNode(id)?.type==='video'?id:null;
  if (!editingVideoId) pauseCanvasVideos();
  document.querySelectorAll('#canvas .videoNode').forEach(element=>{
    const open=element.dataset.id===editingVideoId;
    element.classList.toggle('editorOpen',open);
    element.querySelector('.videoEditor')?.setAttribute('aria-hidden',String(!open));
    if(open){
      const panel=element.querySelector('.videoEditor'),stage=$('#stage').getBoundingClientRect(),node=element.getBoundingClientRect(),zoom=state.zoom||1;
      // Keep editing text at screen scale; zoom only the canvas preview and wires.
      panel.style.transform=`scale(${1/zoom})`;
      panel.style.width=Math.max(1,Math.min(670,stage.width-24))+'px';
      panel.style.maxHeight=Math.max(80,stage.height-72)+'px';
      panel.style.left='0px';panel.style.top=(element.offsetHeight+12/zoom)+'px';
      const bounds=panel.getBoundingClientRect();
      panel.style.left=(Math.min(Math.max(node.left,stage.left+12),stage.right-bounds.width-12)-node.left)/zoom+'px';
      if(bounds.bottom>stage.bottom-52||bounds.top<stage.top+12)panel.style.top=(Math.max(stage.top+12,stage.bottom-bounds.height-52)-node.top)/zoom+'px';
    }
  });
  syncVideoPreviewControls();
}

function nodeMarkup(item) {
  if (item.type === "image") {
    const src = displayImageSrc(item);
    const hasImage = Boolean(item.image) || storedImages.has(item.id) || imageDisplay.has(item.id);
    return `<article class="node imageNode ${isSelected(item.id) ? "selected" : ""}" data-id="${item.id}" style="left:${item.x}px;top:${item.y}px;width:${item.w}px">
      ${portMarkup()}
      <div class="imageBody">${src ? `<img draggable="false" src="${escapeHtml(src)}" alt="${escapeHtml(item.title)}">` : hasImage ? `<div class="imagePending" aria-hidden="true"></div>` : `<label class="dropZone"><b>＋</b><span>点击、拖入或粘贴图片</span><small>PNG / JPG / WEBP</small><input type="file" accept="image/*"></label>`}</div>
      ${hasImage ? `<div class="imageActions"><label>替换<input type="file" accept="image/*"></label><button data-preview>预览</button><button data-clear>移除</button></div>` : ""}
    </article>`;
  }
  const references = edgeInputs(item.id).filter(reference => referenceImage(reference));
  const videoModels = ["Seedance 2.5", "Seedance 2.0", "Seedance 2.0 Fast", "Seedance 2.0 Mini"];
  const maximumDuration = videoDurationLimit(item);
  const currentDuration = Number.parseInt(item.duration, 10);
  if (!Number.isFinite(currentDuration) || currentDuration < 4 || currentDuration > maximumDuration) item.duration = `${Math.min(10, maximumDuration)}秒`;
  const durations = Array.from({ length: maximumDuration - 3 }, (_unused, index) => `${index + 4}秒`);
  const normalizedState = item.status === "waiting" ? "submitting" : item.status === "submitted" ? "generating" : item.status;
  const running = RUNNING_JOB_STATES.has(normalizedState);
  const needsReview = ['needs_attention','monitor_timeout','conversion_pending'].includes(normalizedState);
  const boundJob = item.lastJobId ? state.jobs.find(job => job.id === item.lastJobId) : null;
  const statusText = ({paid_blocked:'本次已停止 · 需要付费',completed:'已完成',failed:'本次生成失败',monitor_timeout:'核验已结束 · 可同步结果',stopped:'已停止',quota_exhausted:'额度不足 · 本次已结束',awaiting_backfill:`已生成 · 待回填到本节点`})[normalizedState]||JOB_BUTTON_LABELS[normalizedState]||'';
  const statusAccount = boundJob ? (boundJob.profileName || profileName(boundJob.profileId)) : '';
  const awaitingBackfill = (normalizedState === "awaiting_backfill" || boundJob?.pendingBackfill) && Boolean(boundJob?.output || boundJob?.file);
  return `<article class="node videoNode ${isSelected(item.id) ? "selected" : ""}" data-id="${item.id}" style="left:${item.x}px;top:${item.y}px;width:${item.w}px">
    ${portMarkup()}
    <header class="nodeHeader"><span>▣</span><input value="${escapeHtml(item.title)}" data-title><button data-more>•••</button></header>
    <div class="compactVideoPreview" title="单击展开视频设置">${item.output ? `<div class="result"><video src="${escapeHtml(item.output)}" playsinline preload="metadata"${editingVideoId === item.id ? " controls" : ""}></video></div>` : `<div class="videoPlaceholder"><span>▷</span></div>`}</div>
    ${statusText||running||needsReview||awaitingBackfill?`<div class="compactTaskStatus"><span>${escapeHtml(statusText)}${statusAccount?` · ${escapeHtml(statusAccount)}`:''}${awaitingBackfill?` · ${escapeHtml(item.title)}`:''}</span>${awaitingBackfill?`<button class="addToCanvas" data-backfill-canvas>添加到画布</button>`:running||needsReview?'<button class="stopTask" data-stop-task>停止</button>':''}</div>`:''}
    <section class="videoEditor" aria-hidden="true"><div class="videoEditorHeader"><b>视频任务设置</b><button type="button" data-close-editor title="收起编辑">收起 ×</button></div>
    <div class="refs" title="拖拽缩略图可改上传顺序，点 × 可单独删除"><b>参考图片</b><span>${references.length}/${MAX_VIDEO_REFERENCES} · 任务框顺序优先上传</span><div>${references.length ? references.map((reference, index) => `<figure data-ref-id="${escapeHtml(reference.id)}" draggable="false" title="第 ${index + 1} 张：${escapeHtml(reference.title)}（可拖拽排序）"><i>${index + 1}</i><img draggable="false" src="${escapeHtml(displayImageSrc(reference))}" alt="${escapeHtml(reference.title)}"><button type="button" class="refRemove" data-remove-ref="${escapeHtml(reference.id)}" title="删除这张参考图">×</button></figure>`).join("") : `<small>按住图片节点可弹出并连接视频节点；也可先选中视频再 Ctrl+左键图片</small>`}</div></div>
    <div class="promptWrap"><button type="button" class="promptExpand" data-expand-prompt aria-expanded="false" title="展开提示词；点击生成时自动收起">展开编辑</button><label class="prompt">提示词<textarea rows="5" placeholder="输入 @ 选择参考图；超过 6 张可在下拉里滚动……">${escapeHtml(item.prompt)}</textarea></label>${references.length ? `<div class="mentionPicker${references.length > 6 ? " many" : ""}"><b>选择要引用的参考图</b><div class="mentionList">${references.map((reference, index) => `<button type="button" data-mention="${escapeHtml(referenceToken(index))}"><img src="${escapeHtml(displayImageSrc(reference))}"><span>${escapeHtml(referenceToken(index))}<small>${escapeHtml(reference.title)}</small></span></button>`).join("")}</div></div>` : ""}</div>
    <div class="params compactParams">
      <label>模型<select data-key="model">${videoModels.map(value => `<option ${value === item.model ? "selected" : ""}>${value}</option>`).join("")}</select></label>
      <label>比例<select data-key="ratio">${["自动", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"].map(value => `<option ${value === item.ratio ? "selected" : ""}>${value}</option>`).join("")}</select></label>
      <label>时长<select data-key="duration">${durations.map(value => `<option ${value === item.duration ? "selected" : ""}>${value}</option>`).join("")}</select></label>
      <div class="taskActions inlineTaskActions"><button class="generate" data-generate title="生成视频" aria-label="生成视频" ${running||needsReview||awaitingBackfill ? "disabled" : ""}>${JOB_BUTTON_LABELS[normalizedState] || "↑"}</button>${normalizedState === "needs_attention" ? `<button class="stopTask" data-resume-task title="仅核验原任务，不重新提交">继续核验</button>` : awaitingBackfill ? `<button class="addToCanvas" data-backfill-canvas>添加到画布</button>` : ""}</div>
    </div>
    </section>
  </article>`;
}

const renderedNodes = new Map();
function render() {
  const canvas = $("#canvas");
  canvas.style.transform = `translate(${state.pan.x}px,${state.pan.y}px) scale(${state.zoom})`;
  updateGrid();
  if (!canvas.querySelector("#wires")) canvas.insertAdjacentHTML("afterbegin", '<svg id="wires" aria-hidden="true"></svg>');
  const liveIds = new Set(state.nodes.map(item => String(item.id)));
  for (const element of canvas.querySelectorAll(".node")) {
    if (!liveIds.has(element.dataset.id)) { renderedNodes.delete(element.dataset.id); expandedPrompts.delete(element.dataset.id); element.remove(); }
  }
  const changed = [];
  const draggingIds = new Set((gesture?.kind === "node" ? (gesture.group || [{ id: gesture.id }]) : []).map(member => String(member.id)));
  for (const item of state.nodes) {
    if (draggingIds.has(String(item.id))) continue;
    const markup = nodeMarkup(item);
    if (renderedNodes.get(String(item.id)) === markup && canvas.querySelector(`[data-id="${CSS.escape(String(item.id))}"]`)) continue;
    const template = document.createElement("template");
    template.innerHTML = markup;
    const element = template.content.firstElementChild;
    const previous = canvas.querySelector(`[data-id="${CSS.escape(String(item.id))}"]`);
    const oldVideo=previous?.querySelector('video'),newVideo=element.querySelector('video');
    if(oldVideo&&newVideo&&oldVideo.getAttribute('src')===newVideo.getAttribute('src'))newVideo.replaceWith(oldVideo);
    if (previous) {
      const used = new Set();
      element.querySelectorAll("img").forEach(next => {
        const src = next.getAttribute("src");
        if (!src) return;
        const prev = [...previous.querySelectorAll("img")].find(img => !used.has(img) && img.getAttribute("src") === src);
        if (!prev) return;
        used.add(prev);
        next.replaceWith(prev);
      });
      previous.replaceWith(element);
    } else canvas.append(element);
    renderedNodes.set(String(item.id), markup);
    changed.push(element);
  }
  $("#jobCount").textContent = state.jobs.length;
  bindNodes(changed);
  showVideoEditor(editingVideoId);
  $$("#canvas video").forEach(primeVideoPreview);
  drawWires();
  paintSelection();
  renderPanel();
}

function bindNodes(elements = $$(".node")) {
  elements.forEach(element => {
    const item = findNode(element.dataset.id);
    // 局部刷新会保留图片 DOM；同一次快捷连线产生的 click 不能再选中图片。
    // 在 pointerdown 记录，而非在 click 检查 Ctrl，兼容先松开 Ctrl 的操作。
    let ctrlLinkClickPending = false;
    let nodeDragMoved = false;
    let holdTimer = 0;
    let holdSpawned = false;
    const clearHoldTimer = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; } };
    element.querySelectorAll("img").forEach(image => { image.ondragstart = event => event.preventDefault(); });
    element.onpointerdown = event => {
      ctrlLinkClickPending = false;
      nodeDragMoved = false;
      holdSpawned = false;
      clearHoldTimer();
      const selected = selectedNode();
      if (event.button === 0 && event.ctrlKey && isImageSourceNode(item) && selected?.type === "video" && !event.target.closest("button,input,select,.port")) {
        event.preventDefault();
        event.stopPropagation();
        ctrlLinkClickPending = true;
        showVideoEditor(null);
        addEdge(item.id, selected.id);
        return;
      }
      if (canvasPanActive()) return;
      if (event.button !== 0 || event.target.closest("button,label,input,textarea,select,.port,.refs,.mentionPicker")) return;
      if (event.shiftKey) {
        event.stopPropagation();
        toggleSelected(item.id);
      } else if (!(selectedIds.size > 1 && selectedIds.has(String(item.id)))) {
        selectOnly(item.id);
      } else {
        state.selected = item.id;
      }
      if(editingVideoId&&editingVideoId!==item.id)showVideoEditor(null);
      const moving = selectedIds.size > 1 && selectedIds.has(String(item.id))
        ? [...selectedIds].map(findNode).filter(Boolean)
        : [item];
      gesture = {
        kind: "node",
        id: item.id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: item.x,
        y: item.y,
        dx: 0,
        dy: 0,
        lastWireAt: 0,
        captured: true,
        group: moving.map(node => ({ id: node.id, x: node.x, y: node.y }))
      };
      try { element.setPointerCapture(event.pointerId); } catch {}
      element.classList.add("moving");
      $$(".node.selected").forEach(node => node.classList.remove("selected"));
      paintSelection();
      renderPanel();
      if (isImageSourceNode(item) && !event.ctrlKey) {
        holdTimer = setTimeout(() => {
          holdTimer = 0;
          if (nodeDragMoved || gesture?.kind !== "node" || gesture.id !== item.id) return;
          holdSpawned = true;
          element.classList.remove("moving");
          try { if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId); } catch {}
          gesture = null;
          spawnLinkedVideoFromImage(item);
        }, 380);
      }
    };
    element.onpointermove = event => {
      if (gesture?.kind !== "node" || gesture.id !== item.id) return;
      gesture.dx = (event.clientX - gesture.startX) / state.zoom;
      gesture.dy = (event.clientY - gesture.startY) / state.zoom;
      if(Math.abs(gesture.dx)>3||Math.abs(gesture.dy)>3){
        nodeDragMoved=true;
        clearHoldTimer();
      }
      event.preventDefault();
      if (nodeDragFrame) return;
      nodeDragFrame = requestAnimationFrame(() => {
        nodeDragFrame = 0;
        if (gesture?.kind !== "node" || gesture.id !== item.id) return;
        const members = gesture.group || [{ id: item.id, x: gesture.x, y: gesture.y }];
        members.forEach(member => {
          const live = findNode(member.id);
          const node = document.querySelector(`#canvas .node[data-id="${CSS.escape(String(member.id))}"]`);
          const x = member.x + gesture.dx;
          const y = member.y + gesture.dy;
          if (live) { live.x = x; live.y = y; }
          if (node) {
            node.style.transform = "";
            node.style.left = `${x}px`;
            node.style.top = `${y}px`;
            node.classList.add("moving");
          }
        });
        scheduleWires();
      });
    };
    const finishNodeDrag = event => {
      clearHoldTimer();
      if (holdSpawned) {
        holdSpawned = false;
        element.classList.remove("moving");
        gesture = null;
        if (event) event.preventDefault();
        return;
      }
      if (gesture?.kind !== "node" || gesture.id !== item.id) return;
      if (nodeDragFrame) { cancelAnimationFrame(nodeDragFrame); nodeDragFrame = 0; }
      const moved = nodeDragMoved;
      const members = gesture.group || [{ id: item.id, x: gesture.x, y: gesture.y }];
      members.forEach(member => {
        const node = findNode(member.id);
        const el = document.querySelector(`#canvas .node[data-id="${CSS.escape(String(member.id))}"]`);
        if (node) {
          node.x = member.x + (moved ? gesture.dx : 0);
          node.y = member.y + (moved ? gesture.dy : 0);
        }
        if (el) {
          el.style.transform = "";
          if (node) { el.style.left = `${node.x}px`; el.style.top = `${node.y}px`; }
          el.classList.remove("moving");
        }
      });
      element.classList.remove("moving");
      try { if (event && element.hasPointerCapture(gesture.pointerId)) element.releasePointerCapture(gesture.pointerId); } catch {}
      gesture = null;
      if (moved) {
        if (event) event.preventDefault();
        save();
        drawWires();
      }
    };
    element.onpointerup = finishNodeDrag;
    element.onlostpointercapture = event => { if (gesture?.kind === "node" && gesture.id === item.id) finishNodeDrag(event); };
    element.onpointercancel = event => { ctrlLinkClickPending = false; finishNodeDrag(event); };
    element.onclick = event => {
      if (holdSpawned || nodeDragMoved) {
        holdSpawned = false;
        event.preventDefault();
        return;
      }
      if (ctrlLinkClickPending) {
        ctrlLinkClickPending = false;
        event.preventDefault();
        return;
      }
      if (!event.target.closest("button,label,input,textarea,select,.port")) {
        if (event.target.closest("video") && editingVideoId === item.id) return;
        if (event.shiftKey) return;
        if (selectedIds.size <= 1) selectOnly(item.id);
        if(item.type==='video')showVideoEditor(item.id);
        else if(editingVideoId&&editingVideoId!==item.id)showVideoEditor(null);
      }
    };
    element.querySelector("video")?.addEventListener("click", event => {
      if (editingVideoId === item.id) return;
      event.preventDefault();
      try { event.currentTarget.pause(); } catch {}
    }, true);
    element.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); showNodeMenu(event, item); };
    const title = element.querySelector("[data-title]");
    if (title) title.onchange = () => { item.title = title.value; save(); renderPanel(); };
    element.querySelector("[data-more]")?.addEventListener("click", event => showNodeMenu(event, item));
    element.querySelectorAll('input[type="file"]').forEach(input => { input.onchange = event => readImageFile(event.target.files[0], item); });
    const dropZone = element.querySelector(".dropZone");
    if (dropZone) {
      dropZone.ondragover = event => { event.preventDefault(); dropZone.classList.add("over"); };
      dropZone.ondragleave = () => dropZone.classList.remove("over");
      dropZone.ondrop = event => {
        event.preventDefault(); event.stopPropagation(); dropZone.classList.remove("over");
        readImageFile(event.dataTransfer.files[0], item);
      };
    }
    element.querySelector("[data-preview]")?.addEventListener("click", () => preview(displayImageSrc(item) || item.image, item.id));
    element.querySelector("[data-clear]")?.addEventListener("click", () => { item.image = ""; deleteImage(item.id); save(); render(); });
    element.querySelectorAll("[data-select-output]").forEach(button => {
      button.addEventListener("click", event => {
        if (event.target.closest("[data-preview-output]")) return;
        const index = Number(button.dataset.selectOutput);
        if (!item.outputs?.[index]?.url) return;
        item.selectedOutput = index;
        save(); render();
        flash(`已将第 ${index + 1} 张生成图设为视频参考图`);
      });
    });
    element.querySelectorAll("[data-preview-output]").forEach(button => {
      button.addEventListener("click", event => {
        event.stopPropagation();
        const output = item.outputs?.[Number(button.dataset.previewOutput)];
        if (output?.url) preview(output.url);
      });
    });
    const prompt = element.querySelector("textarea");
    applyPromptExpansion(element, expandedPrompts.has(item.id));
    element.querySelector("[data-expand-prompt]")?.addEventListener("click", event => {
      event.stopPropagation();
      setPromptExpanded(item.id, !expandedPrompts.has(item.id), true);
    });
    const mentionPicker = element.querySelector(".mentionPicker");
    const updateMentionPicker = () => {
      if (!prompt || !mentionPicker) return;
      const caret = prompt.selectionStart ?? 0;
      mentionPicker.classList.toggle("show", prompt.value[caret - 1] === "@");
    };
    if (prompt) {
      prompt.oninput = () => { item.prompt = prompt.value; updateMentionPicker(); save(); };
      prompt.onkeyup = updateMentionPicker;
      prompt.onkeydown = event => {
        if (event.key === "Escape") {
          if (mentionPicker?.classList.contains("show")) mentionPicker.classList.remove("show");
          else setPromptExpanded(item.id, false);
        }
      };
    }
    element.querySelectorAll("[data-remove-ref]").forEach(button => {
      button.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        checkpointUndo();
        removeVideoReference(item, button.dataset.removeRef);
        flash("已从任务中移除这张参考图");
      };
    });
    const refStrip = element.querySelector(".refs > div");
    if (refStrip) {
      refStrip.querySelectorAll("figure[data-ref-id]").forEach(figure => {
        figure.onpointerdown = event => {
          if (event.button !== 0 || event.target.closest("[data-remove-ref]")) return;
          event.preventDefault();
          event.stopPropagation();
          const figures = [...refStrip.querySelectorAll("figure[data-ref-id]")];
          const startIndex = figures.indexOf(figure);
          if (startIndex < 0) return;
          const rects = figures.map(node => node.getBoundingClientRect());
          const origin = rects[startIndex];
          const stride = rects.length > 1 ? rects[1].left - rects[0].left : origin.width + 8;
          const drag = {
            pointerId: event.pointerId,
            from: startIndex,
            over: startIndex,
            startX: event.clientX,
            startY: event.clientY,
            grabX: event.clientX - origin.left,
            grabY: event.clientY - origin.top,
            active: false,
            ghost: null
          };
          const targetIndex = over => {
            if (over === startIndex || over === startIndex + 1) return startIndex;
            return over > startIndex ? over - 1 : over;
          };
          const stampStyle = (source, target, names) => {
            const computed = getComputedStyle(source);
            names.forEach(name => { target.style[name] = computed[name]; });
          };
          const applyShifts = over => {
            const insertAt = targetIndex(over);
            figures.forEach((node, index) => {
              if (index === startIndex) {
                node.style.transform = "";
                return;
              }
              let shift = 0;
              if (insertAt > startIndex && index > startIndex && index <= insertAt) shift = -stride;
              else if (insertAt < startIndex && index >= insertAt && index < startIndex) shift = stride;
              node.style.transform = shift ? `translateX(${shift}px)` : "";
            });
          };
          const liftGhost = () => {
            if (drag.ghost) return;
            const ghost = figure.cloneNode(true);
            ghost.classList.add("refDragGhost");
            ghost.removeAttribute("data-ref-id");
            ghost.querySelector(".refRemove")?.remove();
            stampStyle(figure, ghost, ["width", "height", "border", "borderRadius", "boxShadow", "backgroundColor", "overflow"]);
            const sourceImg = figure.querySelector("img");
            const ghostImg = ghost.querySelector("img");
            if (sourceImg && ghostImg) stampStyle(sourceImg, ghostImg, ["width", "height", "objectFit", "borderRadius", "display"]);
            const sourceBadge = figure.querySelector("i");
            const ghostBadge = ghost.querySelector("i");
            if (sourceBadge && ghostBadge) stampStyle(sourceBadge, ghostBadge, ["position", "left", "top", "right", "bottom", "width", "height", "display", "placeItems", "alignItems", "justifyContent", "borderRadius", "backgroundColor", "color", "font", "fontSize", "fontStyle", "padding", "border", "zIndex"]);
            ghost.style.position = "fixed";
            ghost.style.left = `${origin.left}px`;
            ghost.style.top = `${origin.top}px`;
            ghost.style.margin = "0";
            ghost.style.zIndex = "100000";
            ghost.style.pointerEvents = "none";
            document.body.appendChild(ghost);
            drag.ghost = ghost;
            figure.classList.add("dragging");
            refStrip.classList.add("refSorting");
            document.body.classList.add("refThumbDragging");
          };
          const moveGhost = (clientX, clientY) => {
            if (!drag.ghost) return;
            drag.ghost.style.left = `${clientX - drag.grabX}px`;
            drag.ghost.style.top = `${clientY - drag.grabY}px`;
          };
          const insertionFromX = x => {
            let over = figures.length;
            for (let index = 0; index < figures.length; index++) {
              if (x < rects[index].left + rects[index].width / 2) {
                over = index;
                break;
              }
            }
            return over;
          };
          try { figure.setPointerCapture(event.pointerId); } catch {}
          const onMove = moveEvent => {
            if (moveEvent.pointerId !== drag.pointerId) return;
            moveEvent.preventDefault();
            if (!drag.active && Math.hypot(moveEvent.clientX - drag.startX, moveEvent.clientY - drag.startY) < 4) return;
            drag.active = true;
            liftGhost();
            moveGhost(moveEvent.clientX, moveEvent.clientY);
            drag.over = insertionFromX(moveEvent.clientX);
            applyShifts(drag.over);
          };
          const finish = upEvent => {
            if (upEvent.pointerId !== drag.pointerId) return;
            figure.removeEventListener("pointermove", onMove);
            figure.removeEventListener("pointerup", finish);
            figure.removeEventListener("pointercancel", finish);
            try { if (figure.hasPointerCapture(upEvent.pointerId)) figure.releasePointerCapture(upEvent.pointerId); } catch {}
            drag.ghost?.remove();
            drag.ghost = null;
            figure.classList.remove("dragging");
            refStrip.classList.remove("refSorting");
            document.body.classList.remove("refThumbDragging");
            figures.forEach(node => { node.style.transform = ""; });
            const insertAt = targetIndex(drag.over);
            if (!drag.active || insertAt === startIndex) return;
            const ids = syncRefOrder(item);
            const next = [...ids];
            const [moved] = next.splice(startIndex, 1);
            next.splice(insertAt, 0, moved);
            checkpointUndo();
            applyVideoRefOrder(item, next);
            save();
            render();
            flash("已按缩略图顺序更新参考图");
          };
          figure.addEventListener("pointermove", onMove);
          figure.addEventListener("pointerup", finish);
          figure.addEventListener("pointercancel", finish);
        };
      });
    }
    element.querySelectorAll("[data-mention]").forEach(button => {
      button.onclick = () => {
        const token = button.dataset.mention;
        const start = prompt.selectionStart ?? prompt.value.length;
        const end = prompt.selectionEnd ?? start;
        const previousScrollTop = prompt.scrollTop;
        const previousScrollLeft = prompt.scrollLeft;
        const replaceTypedAt = start > 0 && prompt.value[start - 1] === "@";
        const before = prompt.value.slice(0, replaceTypedAt ? start - 1 : start);
        const after = prompt.value.slice(end);
        const prefix = before && !/\s$/.test(before) ? " " : "";
        const suffix = after && !/^\s/.test(after) ? " " : "";
        prompt.value = `${before}${prefix}${token}${suffix}${after}`;
        item.prompt = prompt.value;
        const caret = before.length + prefix.length + token.length + suffix.length;
        prompt.focus({ preventScroll: true });
        prompt.setSelectionRange(caret, caret);
        prompt.scrollTop = previousScrollTop;
        prompt.scrollLeft = previousScrollLeft;
        requestAnimationFrame(() => {
          prompt.scrollTop = previousScrollTop;
          prompt.scrollLeft = previousScrollLeft;
        });
        mentionPicker?.classList.remove("show");
        save();
      };
    });
    element.querySelectorAll("[data-key]").forEach(select => {
      select.onchange = () => {
        item[select.dataset.key] = select.value;
        if (select.dataset.key === "model") {
          const maximum = videoDurationLimit(item);
          if (Number.parseInt(item.duration, 10) > maximum) item.duration = `${maximum}秒`;
          syncComposerFromCanvas(item);
          save();
          render();
          return;
        }
        syncComposerFromCanvas(item);
        save();
      };
    });
    element.querySelector("[data-generate]")?.addEventListener("click", () => prepare(item));
    element.querySelectorAll("[data-backfill-canvas]").forEach(button => button.addEventListener("click", event => {
      event.stopPropagation();
      const job = state.jobs.find(entry => entry.id === item.lastJobId);
      if (job) backfillJobToOriginNode(job);
    }));
    element.querySelector('[data-close-editor]')?.addEventListener('click',()=>showVideoEditor(null));
    element.querySelectorAll("[data-stop-task]").forEach(button=>button.addEventListener("click", () => stopTask(item)));
    element.querySelector("[data-resume-task]")?.addEventListener("click", () => { const job=state.jobs.find(entry=>entry.id===item.lastJobId);if(job)syncHistoryJob(job); });
    element.querySelectorAll(".port").forEach(port => {
      port.onpointerdown = event => {
        if (event.button !== 0 || canvasPanActive()) return;
        event.stopPropagation();
        event.preventDefault();
        connection = {
          from: item.id,
          side: port.dataset.side,
          x: event.clientX,
          y: event.clientY,
          startX: event.clientX,
          startY: event.clientY,
          snap: null
        };
        paintPortMagnet(null);
        try { port.setPointerCapture(event.pointerId); } catch {}
        scheduleWires();
      };
      port.onpointermove = event => {
        if (connection?.from !== item.id) return;
        const snap = nearestConnectTarget(item.id, event.clientX, event.clientY);
        connection.snap = snap;
        connection.x = snap ? snap.x : event.clientX;
        connection.y = snap ? snap.y : event.clientY;
        paintPortMagnet(snap?.id);
        scheduleWires();
      };
      port.onpointerup = event => {
        if (!connection || connection.from !== item.id) return;
        const snap = connection.snap || nearestConnectTarget(item.id, event.clientX, event.clientY);
        const dragged = Math.hypot(event.clientX - connection.startX, event.clientY - connection.startY) > 8;
        const source = findNode(connection.from);
        const fromSide = connection.side;
        connection = null;
        paintPortMagnet(null);
        if (snap?.id) {
          addEdge(item.id, snap.id);
        } else {
          const hovered = document.elementFromPoint(event.clientX, event.clientY)?.closest(".node");
          const target = hovered?.dataset.id && hovered.dataset.id !== item.id ? findNode(hovered.dataset.id) : null;
          const canLink = target && ((isImageSourceNode(source) && target.type === "video") || (source?.type === "video" && isImageSourceNode(target)));
          if (canLink) addEdge(item.id, target.id);
          else if (dragged && isImageSourceNode(source) && fromSide === "right") {
            spawnLinkedVideoFromImage(source, canvasPoint(event.clientX, event.clientY));
          }
        }
        drawWires();
      };
      port.onlostpointercapture = event => {
        if (connection?.from === item.id) port.onpointerup(event);
      };
    });
  });
}

function portCenter(id, side) {
  const element = $(`.node[data-id="${id}"]`);
  if (!element) return null;
  const x = element.offsetLeft;
  const y = element.offsetTop;
  return { x: x + (side === "right" ? element.offsetWidth : 0), y: y + element.offsetHeight / 2 };
}

function curve(from, to) {
  const distance = Math.max(70, Math.abs(to.x - from.x) * 0.45);
  const direction = to.x >= from.x ? 1 : -1;
  return `M${from.x},${from.y} C${from.x + distance * direction},${from.y} ${to.x - distance * direction},${to.y} ${to.x},${to.y}`;
}

function cubicPoint(from, to, t) {
  const distance = Math.max(70, Math.abs(to.x - from.x) * 0.45);
  const direction = to.x >= from.x ? 1 : -1;
  const p0 = from;
  const p1 = { x: from.x + distance * direction, y: from.y };
  const p2 = { x: to.x - distance * direction, y: to.y };
  const p3 = to;
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y
  };
}

function hitTestEdgeId(clientX, clientY) {
  const point = canvasPoint(clientX, clientY);
  const threshold = Math.max(12, 16 / Math.max(0.2, state.zoom || 1));
  let best = null;
  for (const edge of state.edges) {
    const source = findNode(edge.from);
    const target = findNode(edge.to);
    if (!source || !target) continue;
    const sourceSide = source.x + source.w / 2 <= target.x + target.w / 2 ? "right" : "left";
    const targetSide = sourceSide === "right" ? "left" : "right";
    const start = portCenter(edge.from, sourceSide);
    const end = portCenter(edge.to, targetSide);
    if (!start || !end) continue;
    for (let step = 0; step <= 28; step++) {
      const along = cubicPoint(start, end, step / 28);
      const distance = Math.hypot(along.x - point.x, along.y - point.y);
      if (distance <= threshold && (!best || distance < best.distance)) best = { id: edge.id, distance };
    }
  }
  return best?.id || null;
}

function selectCanvasEdge(edgeId, event) {
  if (!edgeId) return false;
  const now = Date.now();
  if (event?.type === "dblclick" || (lastEdgeClick.id === edgeId && now - lastEdgeClick.at < 420)) {
    lastEdgeClick = { id: null, at: 0 };
    checkpointUndo();
    removeEdgeById(edgeId);
    return true;
  }
  lastEdgeClick = { id: edgeId, at: now };
  selectedEdgeId = edgeId;
  drawWires();
  return true;
}

function scheduleWires() {
  if (wireFrame) return;
  wireFrame = requestAnimationFrame(() => { wireFrame = 0; drawWires(); });
}

function edgePath(edge) {
  const source = findNode(edge.from);
  const target = findNode(edge.to);
  if (!source || !target) return "";
  const sourceSide = source.x + source.w / 2 <= target.x + target.w / 2 ? "right" : "left";
  const targetSide = sourceSide === "right" ? "left" : "right";
  const start = portCenter(edge.from, sourceSide);
  const end = portCenter(edge.to, targetSide);
  return start && end ? curve(start, end) : "";
}

function updateConnectedWires(nodeId) {
  const svg = $("#wires");
  if (!svg) return;
  state.edges.filter(edge => edge.from === nodeId || edge.to === nodeId).forEach(edge => {
    const path = edgePath(edge);
    svg.querySelectorAll(`[data-edge="${edge.id}"]`).forEach(element => element.setAttribute("d", path));
  });
}

function drawWires() {
  const svg = $("#wires");
  if (!svg) return;
  let maxX = 1600;
  let maxY = 1200;
  for (const node of state.nodes) {
    maxX = Math.max(maxX, Number(node.x || 0) + Number(node.w || 360) + 120);
    maxY = Math.max(maxY, Number(node.y || 0) + 640);
  }
  svg.setAttribute("width", String(Math.ceil(maxX)));
  svg.setAttribute("height", String(Math.ceil(maxY)));
  svg.style.width = `${Math.ceil(maxX)}px`;
  svg.style.height = `${Math.ceil(maxY)}px`;
  let markup = state.edges.map(edge => {
    const path = edgePath(edge);
    const selected = selectedEdgeId === edge.id ? " selected" : "";
    return path ? `<path class="wireHit" data-edge="${edge.id}" d="${path}"></path><path class="wire${selected}" data-edge="${edge.id}" d="${path}"></path>` : "";
  }).join("");
  if (connection) {
    const start = portCenter(connection.from, connection.side);
    const end = canvasPoint(connection.x, connection.y);
    if (start) markup += `<path class="wire temp" d="${curve(start, end)}"></path>`;
  }
  svg.innerHTML = markup;
}

function readImageFile(file, item) {
  ingestImageIntoNode(file, item).catch(error => flash(error.message || "图片添加失败", 6000));
}

function preview(source, nodeId) {
  const img = $("#preview img");
  const cached = nodeId ? displayImageSrc(findNode(nodeId)) : "";
  img.src = cached || source || "";
  if (!img.src && nodeId) {
    getImage(nodeId).then(data => { if (data) img.src = data; }).catch(() => {});
  }
  $("#preview").classList.add("show");
}

async function ingestImageIntoNode(file, item) {
  if (!file || (file.type && !file.type.startsWith("image/") && !/\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name || ""))) {
    throw new Error("请选择图片文件");
  }
  if (file.size > MAX_IMAGE_BYTES) throw new Error(`图片过大（${file.name || "未命名"}超过 28MB），已跳过`);
  await putImage(item.id, file);
  pinImageRef(item);
  save();
  render();
}

function enqueueImageImport(task) {
  imageImportQueue = imageImportQueue.catch(() => {}).then(task);
  return imageImportQueue;
}

async function dropFiles(files, point) {
  const images = [...files].filter(file => (file.type || "").startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name || ""));
  if (!images.length) return flash("请拖入图片文件");
  const batch = images.slice(0, MAX_IMPORT_BATCH);
  if (images.length > MAX_IMPORT_BATCH) flash(`一次最多导入 ${MAX_IMPORT_BATCH} 张，已先加入前 ${MAX_IMPORT_BATCH} 张`, 7000);
  else flash(`正在添加 ${batch.length} 张图片，请稍候`);
  await enqueueImageImport(async () => {
    for (let index = 0; index < batch.length; index++) {
      const file = batch[index];
      const item = createImageNode(point.x + index * 28, point.y + index * 28, "", file.name.replace(/\.[^.]+$/, "") || "参考图片");
      try {
        await ingestImageIntoNode(file, item);
      } catch (error) {
        flash(error.message || "有一张图片添加失败", 6000);
      }
      if (index % 2 === 1) await new Promise(resolve => setTimeout(resolve, 0));
    }
    flash(`已添加 ${batch.length} 张参考图`);
  });
}

function renderPanel() {
  if (!sidebarOpen) return;
  if (panelMode === "history") return renderHistoryPanel();
  $("#panelTitle").textContent = "使用帮助";
  $("#closePanel").hidden = false;
  // 节点选择和任务进度变化不重建帮助，保留用户正在看的章节和滚动位置。
  if (!$("#panel").querySelector(".sidebarHelp")) {
    $("#panel").innerHTML = usageHelpMarkup();
  }
}

function usageHelpMarkup() {
  return `<div class="sidebarHelp helpSections">
    <details open><summary><i>1</i> 第一次使用：激活与通道</summary><div><p>把整个文件夹解压到电脑后再打开，不要只拷贝 exe，也不要在压缩包里直接运行。双击「启动家兴豆包无限画布.bat」或「家兴豆包无限画布.exe」。</p><p>首次会弹出激活窗口，填入购买时的卡密。一张卡绑定一台电脑，激活需联网。没有卡密、激活失败或换机解绑，请扫售后人员「无限画布」的微信开卡。</p><p>顶部通道二选一：<b>原生豆包</b>走本机官方豆包客户端；<b>内置多账号</b>走画布自带的豆包 / Dola 独立浏览器。生成前先选好通道。顶部「白天 / 夜晚」可切换浅色或深色画布，下次打开会记住。</p></div></details>
    <details><summary><i>2</i> 教学前期配置</summary><div>
      <p><b>环境准备与网络配置</b></p>
      <p>推荐梯子地址：<b>www.fanresai.com</b></p>
      <p><b>网络工具：</b>请自行注册并购买梯子账号，支持手机端下载。使用 Dola 期间需全程开启网络代理。</p>
      <p><b>节点选择：</b>推荐优先选择台湾或韩国节点。</p>
      <p><b>防封策略：</b>建议定期更换节点，避免长时间固定使用单一节点，以降低封号风险。</p>
      <p><b>账号注册与登录</b></p>
      <p><b>注册额度：</b>单个手机号码最多可注册 3 个 Dola 账号。</p>
      <p><b>登录方式：</b>支持通过 Google、Dola 及 Facebook 三种方式登录 Dola。</p>
      <p><b>多开上限：</b>单台手机设备最多可同时登录 20 个 Dola 账号。</p>
      <p><b>快捷登录：</b>支持在浏览器界面通过扫码方式完成登录。</p>
      <p><b>软件更新说明</b></p>
      <p>本软件将持续进行功能迭代与优化，感谢您的关注与支持！</p>
    </div></details>
    <details><summary><i>3</i> 内置多账号浏览器</summary><div><p>通道选「内置多账号」后，点「打开全部窗口」管理账号。每个账号独立登录会话，登录状态保存在本机「数据」文件夹。添加时可选豆包或 Dola（国际版 dola.com）。</p><p>第一次仍需你自己在窗口里登录；可用「填充账号」辅助填写，但不能替你过验证码。点「检查积分/额度」查看当前号；勾选「额度不足自动切换」后，空闲号可轮换。</p><p>画布点生成时，可选<strong>自动分配</strong>到空闲窗口，或指定某个账号。内置通道会尽量自动填参、提交；成片保存后，在浏览器点绿色「核对后回填到画布」，写入发出该任务的视频节点。同一节点新成片会覆盖旧视频。</p><p>「打开全部账号窗口」会为每个号各开一个任务栏窗口，方便监控。内存不够时只开 1～2 个窗口。</p></div></details>
    <details><summary><i>4</i> 原生豆包通道</summary><div><p>通道选「原生豆包」时，先安装并打开官方豆包电脑版，用自己的账号登录。回到画布点「同步账号」，再在顶部「豆包账号」里选择。</p><p>要增加账号：先在豆包的账号切换菜单中添加并登录，再回画布同步一次。「手动添加待绑定项」不等于已经登录。重新登录或账号列表变化时，请再同步。</p><p>「切换豆包」会在当前唯一官方窗口切到所选账号。已提交任务仍绑定提交时的原账号，不会跟着顶部下拉框一起改。</p></div></details>
    <details><summary><i>5</i> 视频节点与参考图</summary><div><p>右键画布空白处可以创建视频节点，也可以选择「上传图片」，一次最多导入 40 张。图片会先存到本机画布库并显示缩略图，避免一次塞进太多原图把内存撑爆。也可 Ctrl+V 粘贴剪贴板里的图。</p><p>节点平时直接显示视频预览和状态；单击节点展开设置，点击空白或「收起」会关闭设置并暂停播放，不改变右侧历史或帮助。视频回填后会出现在节点主预览区，无需先展开。</p><p>上传后的图片只是参考素材，还需要连到视频节点才会随任务提交。Ctrl 连线时编辑面板会收起，但目标视频节点保持选中，可连续连接。单个视频任务最多连接 10 张参考图。</p></div></details>
    <details><summary><i>6</i> 连接顺序</summary><div><p>从图片节点右侧圆点拉出连线，靠近视频节点左侧会自动吸附。从图片右侧拉线后在空白处松开，会自动弹出视频节点并连上。也可以先选中视频节点，再按住 Ctrl 依次点击图片。连接顺序就是平台收到参考图的顺序。</p><p>提交前检查视频节点内的参考图缩略图和顺序，避免引用错图。</p></div></details>
    <details><summary><i>7</i> 提示词、模型与提交</summary><div><p>单击视频节点展开设置，填写提示词；输入 @ 可以选择已连接的参考图，插入「（图一）」「（图二）」等标记。文字较多时点「展开编辑」，可手动点「收起」或按 Esc 收起。点击右下角 ↑ 生成时，编辑面板会立即收起，提示词不会清空。</p><p>内置通道：画布把参考图、时长和模型（含 30 秒 / Seedance 2.5）写入对应浏览器窗口后再提交。请等窗口处理完，不要同时手改页面输入。</p><p>原生通道：画布在参考图和参数就绪后，向最终输入框执行本任务唯一一次粘贴；只有收到完整可信回执才自动提交。异常时最多限时识别 15 秒，不会重复粘贴或刷新豆包。超时后请在当前豆包页面手动确认并点击生成，画布会继续监听本次任务；正式回执出现前不要切号或打开其他对话。</p><p>识别到付费确认时，画布不代替你同意；本次及同账号尚未提交的排队任务结束。节点可以换账号再用，已经在生成的视频继续接收结果。</p></div></details>
    <details><summary><i>8</i> 并发生成与账号分批</summary><div><p>原生通道：同一个账号可以连续提交多个视频节点并发生成。不同账号按批次处理：A 账号本批回填或明确结束后，才切到 B 账号提交下一批。提前选 B 并点生成只会排队，不会立即切走 A。</p><p>内置通道：自动分配会优先今日次数少、当前空闲的窗口并行发任务；指定账号则固定走该窗口。本窗口勾选了额度不足自动切换时，才会换到其他已登录号，不会跳到另一个平台。</p><p>上传参考图和提示词期间请勿手动改页面内容或切号。停止画布监听不等于取消云端生成。</p></div></details>
    <details><summary><i>9</i> 回填、无水印与停止</summary><div><p>成片保存后，原生通道会尽量自动回填到发出该任务的视频节点；内置通道请在浏览器点「核对后回填到画布」。同一节点的新成片会覆盖旧视频。可在「历史记录」查看进度。</p><p>顶部「无水印」只捕获画布自己提交的任务原始媒体，不改变生成流程。点「无水印素材」可打开本机素材文件夹。</p><p>节点或历史里的「停止」只停止画布后续提交、监听和自动回填。<strong>已经提交到豆包 / Dola 的云端任务不会因此撤销，也不代表额度会退回。</strong>能否取消以平台为准。</p><p>若平台已经有成品但画布未回填：原生通道先在历史里点「同步结果」；内置通道在对应窗口点「回填到画布」。不要直接再点生成，避免重复扣费。已停止的任务需点「恢复已有结果」才会继续接收，不会重新生成。</p></div></details>
    <details><summary><i>10</i> 常见问题怎么处理</summary><div><p><b>激活失败：</b>确认已联网、卡密无空格。一张卡只能绑一台电脑，换机须先解绑。</p><p><b>内置浏览器没有账号：</b>点「打开全部窗口」添加豆包或 Dola，先登录成功再点生成。</p><p><b>回填错节点 / 仍是旧视频：</b>回填只写入发出该任务的节点并覆盖该节点旧成片。请看浏览器提示里的节点名称，或到历史记录定位发出节点。</p><p><b>账号没有同步到（原生）：</b>先去官方豆包确认该账号已登录、在切换菜单中可见，再回画布同步。不要把新建待绑定项当成已登录账号。</p><p><b>提示主对话暂不可用：</b>先停止受影响的画布任务，点「切换豆包」或手动打开豆包，回到正常主对话再重试。需要后台运行时可最小化，不要直接退出。</p><p><b>额度用尽／要求付费：</b>不想付费就停止该画布任务，不要在页面上同意付费；再换其他已登录账号。已在生成的其他任务单独看待，不要一起重提。</p><p><b>侵权、违规或内容无法返回：</b>按平台提示改提示词或更换有权使用的参考图。画布不能绕过审核。</p><p><b>视频已找到但 H.264 转换失败：</b>先不要重新生成。确认是完整安装包、安全软件未拦截、磁盘空间足够。仍失败时保留任务文件夹，联系作者后再用「同步结果」重试。</p><p><b>一直排队／回填失败：</b>查看历史里哪一个任务在等待确认或提交；先处理或停止。把任务编号、报错截图和任务文件夹发给作者。不要发送密码或验证码。</p></div></details>
    <details><summary><i>11</i> 历史、纯净版与更新</summary><div><p>顶部「历史记录」可以定位节点、同步结果、打开任务文件夹。删除历史时可只删记录，也可把对应任务文件夹移入回收站；不会删除豆包 / Dola 云端对话。</p><p>顶部「恢复纯净版」会删除软件旁边「数据」文件夹中的全部内容（画布、历史任务、内置浏览器账号和登录缓存、无水印素材、设置），软件会自动重启并回到刚解压时的空白状态。官方豆包客户端和卡密绑定都不受影响。此操作无法撤销。</p><p>「检查更新」会安装最新版，不会删除画布和任务数据。手动换包时请先退出画布并备份「数据」文件夹，完整解压后再运行，不要在压缩包内打开，也不要覆盖旧数据。</p></div></details>
    <details><summary><i>12</i> 软件信息与电脑配置</summary><div>
      <p><b>软件：</b>家兴豆包无限画布纯洁版 56.5.0</p>
      <p><b>系统：</b>Windows 10 64 位（1903 及以上）或 Windows 11。不支持 Windows 7 / 32 位。</p>
      <p><b>最低配置（能打开画布、少量预览）：</b>4 核 CPU（约 i5-8 代 / Ryzen 5 2400 档）、<strong>8 GB 内存</strong>、带硬解的核显（Intel UHD / AMD Vega 等）、SSD 且至少空余 8 GB、建议 1920×1080。</p>
      <p>最低配置请只开画布和 1～2 个内置浏览器，不要点「打开全部账号窗口」，也不要 10 路并发。</p>
      <p><b>日常推荐：</b>6 核及以上 CPU、<strong>16 GB 内存</strong>、核显或独显、SSD 空余 20 GB 以上。</p>
      <p><b>多账号 / 10 路并发：</b>建议 <strong>32 GB 内存</strong>、8 核 CPU。每个内置浏览器窗口大约再占用 300～500 MB 内存；内存不够容易卡顿、黑屏或视频只有声音没有画面。</p>
      <p><b>显卡：</b>不要关闭硬件加速。关掉 GPU 后，视频节点常见「有声音、灰框没画面」。</p>
      <p><b>其他：</b>本机同时开官方豆包客户端会再占内存。HEVC 成片第一次预览可能转成 H.264，会短暂占用 CPU。请勿修改程序文件，否则本机可能被锁定。</p>
    </div></details>
    <details><summary><i>13</i> 联系售后</summary><div>
      <p>开卡、解绑、激活失败请加<strong>售后人员（无限画布）</strong>。使用问题和学习交流请加<strong>售后交流群</strong>；群码过期后加个人微信拉群。</p>
      <div class="qrRow">
        <figure>
          <img src="wechat-staff.png?v=20260911-f9" alt="售后人员无限画布">
          <figcaption>售后人员 · 无限画布</figcaption>
        </figure>
        <figure>
          <img src="wechat-group.png?v=20260911-f9" alt="豆包无限画布售后AI学习群">
          <figcaption>售后交流群</figcaption>
        </figure>
      </div>
      <p><b>作者：家兴</b>　微信：1413521239　官网：jxcanvas.cn</p>
      <p>遇到功能异常请附上任务编号、错误提示和相关截图。不要发送密码或验证码。</p>
    </div></details>
    <div class="helpShortcuts"><b>快捷操作</b><span>按住空格拖动画布</span><span>松开空格框选</span><span>点击空白收起设置并暂停</span><span>Ctrl+Z 返回上一步</span><span>滚轮缩放</span><span>中键也可移动画布</span><span>左键框选空白</span><span>Shift 加选</span><span>Ctrl+A 全选</span><span>Del 删除图片节点</span><span>Backspace 删除节点</span><span>Ctrl+D 复制</span><span>Ctrl+V 粘贴图片</span></div>
  </div>`;
}

function formatJobTime(job) {
  if (!job.createdAt) return job.created || "";
  const date = new Date(job.createdAt);
  return Number.isNaN(date.getTime()) ? (job.created || "") : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const renderedHistory = new Map();
const syncingJobs = new Set();
function renderHistoryPanel() {
  $("#panelTitle").textContent = "生成历史";
  $("#closePanel").hidden = false;
  const markup = state.jobs.length ? `<div class="historyList">${state.jobs.map(job => `
    <section class="job ${job.output || job.outputs?.length ? "complete" : ""}" data-job="${escapeHtml(job.id)}">
      <div class="jobHead"><b>${escapeHtml(job.title || (job.type === "image" ? "图片生成" : "视频生成"))}</b><span>${escapeHtml(formatJobTime(job))}</span></div>
      <small>${escapeHtml(job.id)} · 发出节点「${escapeHtml(job.title || "视频生成")}」 · ${escapeHtml(job.profileName || profileName(job.profileId))}</small>
      <p class="jobStatus">${escapeHtml(job.status || "等待处理")}</p>
      ${job.syncNotice?`<p class="jobSyncNotice">${escapeHtml(job.syncNotice)}</p>`:''}
      ${job.noWatermark?`<p class="jobSyncNotice">无水印素材：${escapeHtml(job.noWatermark.message||job.noWatermark.state)}</p>`:''}
      ${!job.stopped&&(RUNNING_JOB_STATES.has(job.state)||['needs_attention','monitor_timeout','conversion_pending'].includes(job.state))?`<div class="jobActions"><button data-stop-history ${job.state==='stopping'?'disabled':''}>${job.state==='stopping'?'正在停止':'停止监听'}</button></div>`:''}
      <div class="jobParams">${job.type === "image" ? `<i>图片生成</i>` : `<i>${Number(job.imageCount || 0)} 张参考图</i>`}<i>${escapeHtml(job.model || "")}</i><i>${escapeHtml(job.ratio || "")}</i>${job.duration ? `<i>${escapeHtml(job.duration)}</i>` : ""}</div>
      ${job.prompt ? `<p class="jobPrompt">${escapeHtml(job.prompt)}</p>` : ""}
      ${job.type === "image" && job.outputs?.length ? `<div class="historyImageGrid">${job.outputs.map(output => `<img loading="lazy" decoding="async" src="${escapeHtml(output.url || output)}">`).join("")}</div>` : job.output ? `<video src="${escapeHtml(job.output)}" controls playsinline preload="metadata"></video>` : ""}
      <div class="jobActions"><button data-focus ${findNode(job.nodeId) ? "" : "disabled"}>定位发出节点</button>${job.retryable ? `<button data-retry ${findNode(job.nodeId) ? "" : "disabled"}>修改后重试</button>` : ""}${job.state === "awaiting_backfill" || job.pendingBackfill || (job.stopped && (job.output || job.file)) ? `<button data-backfill ${findNode(job.nodeId) ? "" : "disabled"}>核对后添加到画布 · ${escapeHtml(job.title || "视频生成")}</button>` : ""}<button data-sync ${syncingJobs.has(job.id)||job.state==='stopping'?'disabled':''}>${syncingJobs.has(job.id)?'正在核验':job.stopped?'恢复已有结果':job.state==='waiting_manual_submission'?'已手动提交，立即核验':job.state === "needs_attention" ? "继续核验" : job.output || job.outputs?.length ? "重新同步" : "同步结果"}</button><button data-folder>任务文件夹</button><button data-delete class="danger">删除…</button></div>
    </section>`).join("")}</div>` : `<div class="emptyPanel"><b>还没有生成历史</b><p>图片和视频任务的账号、提示词、模型、比例、状态与生成结果都会保存在这里。</p></div>`;
  const panel = $("#panel");
  if (!state.jobs.length) { panel.innerHTML = markup; renderedHistory.clear(); }
  else {
    if (!panel.querySelector(".historyList")) { panel.innerHTML = '<div class="historyList"></div>'; renderedHistory.clear(); }
    const container = panel.querySelector(".historyList");
    const template = document.createElement("template");
    template.innerHTML = markup;
    const ids = new Set(state.jobs.map(job => job.id));
    for (const old of container.querySelectorAll("[data-job]")) if (!ids.has(old.dataset.job)) { renderedHistory.delete(old.dataset.job); old.remove(); }
    let previous = null;
    for (const next of template.content.querySelectorAll("[data-job]")) {
      const id = next.dataset.job;
      const html = next.outerHTML;
      let current = container.querySelector(`[data-job="${CSS.escape(id)}"]`);
      if (!current || renderedHistory.get(id) !== html) {
        if (current) current.replaceWith(next);
        current = next;
        renderedHistory.set(id, html);
      }
      if (current.previousElementSibling !== previous || current.parentElement !== container) container.insertBefore(current, previous ? previous.nextElementSibling : container.firstElementChild);
      previous = current;
    }
  }
  $$("[data-job]").forEach(element => {
    const job = state.jobs.find(item => item.id === element.dataset.job);
    element.querySelector("[data-focus]").onclick = () => focusNode(job.nodeId);
    const retry = element.querySelector("[data-retry]");
    if (retry) retry.onclick = () => { focusNode(job.nodeId); flash(job.quotaNotDeducted ? "本次额度未扣除；请修改可能侵权或违规的内容后重新提交" : "请修改提示词或参考素材后重新提交", 8000); };
    element.querySelector("[data-sync]").onclick = () => syncHistoryJob(job);
    const backfill = element.querySelector("[data-backfill]");
    if (backfill) backfill.onclick = () => backfillJobToOriginNode(job);
    const stopHistory = element.querySelector('[data-stop-history]');
    if (stopHistory) stopHistory.onclick = () => {
      const node=findNode(job.nodeId);
      return stopTask(node?.lastJobId===job.id?node:{lastJobId:job.id,status:job.state});
    };
    element.querySelector("[data-folder]").onclick = () => window.desktop.openJobFolder(job.id);
    element.querySelector("[data-delete]").onclick = () => deleteHistoryJob(job);
  });
  $$("#panel video").forEach(primeVideoPreview);
}

async function deleteHistoryJob(job) {
  const result = await window.desktop.deleteHistoryJob({ id: job.id, title: job.title || "视频生成" });
  if (!result?.ok) {
    if (!result?.canceled) flash(`删除失败：${result?.error || "未知错误"}`, 7000);
    return;
  }
  state.jobs = state.jobs.filter(item => item.id !== job.id);
  saveNow();
  $("#jobCount").textContent = state.jobs.length;
  renderHistoryPanel();
  flash(result.folderDeleted ? "历史记录已删除，任务文件夹已移入回收站" : result.folderMissing ? "历史记录已删除；对应任务文件夹原本就不存在" : "历史记录已删除，任务文件夹已保留", 5000);
}

async function backfillJobToOriginNode(job) {
  if (!job) return;
  const node = findNode(job.nodeId);
  if (!node) return flash(`找不到发出此任务的画布节点，无法回填。任务 ${job.id}`, 8000);
  const title = node.title || job.title || "视频生成";
  try {
    if (typeof window.desktop.commitCanvasBackfill === "function") {
      await window.desktop.commitCanvasBackfill({ jobId: job.id, nodeId: node.id, overwrite: true });
      return;
    }
  } catch (error) {
    if (!job.output) return flash(`回填失败：${error.message}`, 8000);
  }
  if (!job.output) return flash("没有可回填的成片文件");
  node.output = job.output;
  node.status = "completed";
  node.lastJobId = job.id;
  job.state = "completed";
  job.stopped = false;
  job.status = `已回填到发出节点「${title}」`;
  job.pendingBackfill = false;
  save();
  render();
  flash(`已覆盖回填到发出节点「${title}」`);
}

function focusNode(nodeId) {
  const item = findNode(nodeId);
  if (!item) return flash("这个历史任务对应的节点已经被删除");
  const stage = $("#stage").getBoundingClientRect();
  state.pan.x = stage.width / 2 - (item.x + item.w / 2) * state.zoom;
  state.pan.y = stage.height / 2 - (item.y + item.h / 2) * state.zoom;
  state.selected = item.id;
  showVideoEditor(null);
  save();
  render();
}

async function syncHistoryJob(job) {
  if(syncingJobs.has(job.id)||job.state==='stopping')return;
  const recoverStopped=Boolean(job.stopped);
  if(recoverStopped&&!confirm('这个任务已停止。是否只恢复豆包已经生成的结果？不会重新上传、重新生成或确认付费。'))return;
  const previous={state:job.state,status:job.status,stopped:job.stopped,sequence:job.stateSequence||0};
  syncingJobs.add(job.id);job.syncNotice='正在核验已有结果，不重复生成';
  if(recoverStopped)job.stopped=false;
  renderHistoryPanel();
  try{
    const result=await window.desktop.syncDoubaoResult({...job,recoverStopped});
    if(job.stopped)return;
    if(!result?.ok){
      if(recoverStopped&&(job.stateSequence||0)===previous.sequence){job.stopped=previous.stopped;job.state=previous.state;job.status=previous.status;}
      job.syncNotice=(result?.busy?'暂不能恢复：':'恢复结果提示：')+(result?.error||result?.message||'连接异常');
      return flash(job.syncNotice,8000);
    }
    job.syncNotice=result.message||(result.completed?'已有视频已回填':'已恢复原任务监听');
    flash(job.syncNotice,6000);
  }catch(error){
    if(recoverStopped&&(job.stateSequence||0)===previous.sequence){job.stopped=previous.stopped;job.state=previous.state;job.status=previous.status;}
    job.syncNotice='恢复连接暂不可用：'+error.message;flash(job.syncNotice,7000);
  }finally{syncingJobs.delete(job.id);save();render();}
}

function showEdgeMenu(event, edgeId) {
  const menu = $("#contextMenu");
  menu.innerHTML = `<button id="deleteEdge"><b>×</b><span>删除连线<small>断开这张参考图</small></span></button>`;
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  menu.classList.add("show");
  $("#deleteEdge").onclick = () => {
    checkpointUndo();
    removeEdgeById(edgeId);
    hideMenu();
  };
}

const removingWatermarkJobs = new Set();

function videoOutputJob(item) {
  if (item.type !== "video" || !item.output) return null;
  return state.jobs.find(job => job.id === item.lastJobId && job.output === item.output)
    || state.jobs.find(job => job.output === item.output)
    || null;
}

async function removeNodeWatermark(item) {
  const job = videoOutputJob(item);
  if (!job) return flash("找不到这段视频的原任务记录，无法获取无水印版本", 7000);
  if (removingWatermarkJobs.has(job.id)) return;
  const originalOutput = item.output;
  const originalJobId = item.lastJobId;
  removingWatermarkJobs.add(job.id);
  flash("正在获取这段视频的无水印版本……", 6000);
  try {
    const result = await window.desktop.removeVideoWatermark(job.id);
    if (!result?.ok || !result.url) throw new Error(result?.error || "未获取到无水印视频");
    job.noWatermark = { jobId: job.id, state: "completed", file: result.file, message: result.message };
    const current = findNode(item.id);
    if (current && current.output === originalOutput && current.lastJobId === originalJobId) {
      checkpointUndo();
      current.output = result.url;
      job.output = result.url;
      job.file = result.file;
      flash("无水印视频已替换到当前节点，原文件已保留", 6000);
    } else {
      flash("无水印视频已保存；节点已变化，未覆盖当前视频，可在无水印素材文件夹查看", 8000);
    }
    saveNow();
    render();
  } catch (error) {
    flash(`去除水印未完成：${error.message}`, 8000);
  } finally {
    removingWatermarkJobs.delete(job.id);
    void refreshNoWatermarkStatus();
  }
}

function showNodeMenu(event, item) {
  event.stopPropagation();
  const menu = $("#contextMenu");
  const multi = selectedIds.size > 1 && selectedIds.has(String(item.id));
  menu.innerHTML = `${multi ? `<button id="arrangeSelected"><b>⊞</b><span>排列所选<small>把选中的节点整理整齐</small></span></button>` : ""}<button id="duplicateNode"><b>⧉</b><span>复制节点</span></button><button id="deleteNode"><b>×</b><span>${multi ? "删除所选" : "删除节点"}</span></button>`;
  if (item.type === "video" && item.output) {
    const busy = removingWatermarkJobs.has(videoOutputJob(item)?.id);
    menu.insertAdjacentHTML("afterbegin", `<button id="removeVideoWatermark" ${busy ? "disabled" : ""}><b>↓</b><span>${busy ? "正在去除水印…" : "去除水印"}</span></button>`);
    $("#removeVideoWatermark").onclick = () => { hideMenu(); void removeNodeWatermark(item); };
  }
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  menu.classList.add("show");
  $("#arrangeSelected")?.addEventListener("click", () => { arrangeTidy(); hideMenu(); });
  $("#duplicateNode").onclick = () => { duplicateNode(item); hideMenu(); };
  $("#deleteNode").onclick = () => {
    if (multi) [...selectedIds].forEach(id => removeNode(id));
    else removeNode(item.id);
    hideMenu();
  };
}

function showCanvasMenu(event) {
  const menu = $("#contextMenu");
  menu.innerHTML = `<button id="createVideoNode"><b>▴</b><span>视频节点<small>创建节点并填写提示词</small></span></button><button id="uploadImage"><b>▧</b><span>上传图片<small>选择一张或多张参考图</small></span></button><button id="arrangeTidy"><b>⊞</b><span>整理画布<small>按任务把参考图排到视频左边</small></span></button><button id="arrangeGrid"><b>▦</b><span>网格排列</span></button>`;
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  menu.classList.add("show");
  $("#createVideoNode").onclick = () => {
    const item = createVideoNode(menuPoint.x, menuPoint.y);
    hideMenu();
    requestAnimationFrame(() => document.querySelector(`[data-id="${item.id}"] .prompt textarea`)?.focus({ preventScroll: true }));
  };
  $("#uploadImage").onclick = () => { chooseImagesAt(menuPoint); hideMenu(); };
  $("#arrangeTidy").onclick = () => { arrangeTidy(); hideMenu(); };
  $("#arrangeGrid").onclick = () => { arrangeGrid(); hideMenu(); };
}

function hideMenu() { $("#contextMenu").classList.remove("show"); }

function chooseImagesAt(point) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.onchange = () => {
    dropFiles(input.files, point);
    input.remove();
  };
  input.addEventListener("cancel", () => input.remove(), { once: true });
  input.click();
}

async function pasteAt(point) {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find(value => value.startsWith("image/"));
      if (!type) continue;
      const blob = await item.getType(type);
      const node = createImageNode(point.x, point.y, "", "粘贴图片");
      ingestImageIntoNode(blob, node).then(() => flash("图片已添加")).catch(error => flash(error.message || "粘贴失败", 6000));
      return;
    }
    flash("剪贴板中没有图片");
  } catch { flash("请使用 Ctrl+V 粘贴图片"); }
}

async function prepare(item) {
  return prepareVideo(item);
}

async function chooseBrowserAccount() {
  const accounts = ((await window.desktop.listBrowserAccounts()) || []).filter(account => account.enabled !== false);
  if (!accounts.length) {
    flash("请先在内置浏览器中添加账号，再点击生成", 7000);
    return null;
  }
  return new Promise(resolve => {
    const modal = $("#accountPickModal");
    const list = $("#accountPickList");
    const finish = account => {
      modal.classList.remove("show");
      modal.setAttribute("aria-hidden", "true");
      resolve(account || null);
    };
    list.innerHTML = `<button type="button" class="accountPickItem ok auto" data-id="__auto__">
        <span class="accountPickName">自动分配空闲账号<small>有哪个平台的号就用哪个；优先今日次数少的号，不会因为误判额度而全部拒发</small></span>
        <span class="accountPickCount">自动</span>
      </button>` + accounts.map(account => {
      const count = Number(account.todayVideoCount || 0);
      const hot = count >= 2;
      const brand = account.provider === "dola" ? "Dola" : "豆包";
      return `<button type="button" class="accountPickItem ${hot ? "hot" : "ok"}" data-id="${escapeHtml(account.id)}">
        <span class="accountPickName">${escapeHtml(brand)} · ${escapeHtml(account.name)}<small>${hot ? "今日已用较多，建议换号或明天再用" : "今日次数较少"}</small></span>
        <span class="accountPickCount">今日 ${count} 次</span>
      </button>`;
    }).join("");
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    list.onclick = event => {
      const button = event.target.closest("[data-id]");
      if (!button) return;
      if (button.dataset.id === "__auto__") {
        const hasDoubao = accounts.some(item => item.provider === "doubao");
        const hasDola = accounts.some(item => item.provider === "dola");
        const provider = hasDoubao && !hasDola ? "doubao" : hasDola && !hasDoubao ? "dola" : "";
        return finish({ id: "", name: "自动分配空闲账号", provider, auto: true });
      }
      finish(accounts.find(account => account.id === button.dataset.id) || null);
    };
    modal.querySelector("[data-close-account-pick]").onclick = () => finish(null);
  });
}

async function prepareVideo(item) {
  const editor = document.querySelector(`#canvas .node[data-id="${CSS.escape(String(item.id))}"] .prompt textarea`);
  if (editor) item.prompt = editor.value;
  if (RUNNING_JOB_STATES.has(item.status)) return flash("请等待当前任务结束或停止完成");
  if(['needs_attention','monitor_timeout','conversion_pending'].includes(item.status)&&!confirm('原任务可能已经在豆包生成。建议先在历史记录恢复已有结果。仍要提交一次新的生成任务吗？'))return;
  if (!item.prompt.trim()) return flash("请先填写提示词");
  const useBrowser = state.generationChannel === "browser";
  const selectedProfile = profiles.find(profile => profile.id === state.activeProfileId);
  const pickedAccount = useBrowser ? await chooseBrowserAccount() : null;
  if (useBrowser && !pickedAccount) return;
  if (expandedPrompts.has(item.id)) setPromptExpanded(item.id, false);
  showVideoEditor(null);
  if (useBrowser) syncComposerFromCanvas(item);
  if (!useBrowser && !selectedProfile?.accountName) return flash("这个账号尚未绑定真实豆包账号，请先点击顶部“同步账号”", 7000);
  const today = new Date();
  const dayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const paidQuotaConsent = !useBrowser && selectedProfile?.paidQuotaGate?.date === dayKey;
  if (paidQuotaConsent && !confirm(`账号“${selectedProfile.name}”今天已出现付费额度提示。是否明确允许【本次任务】使用付费额度？\n取消后不会提交，可切换其他账号。此选择不授权后续任务。`)) return;
  if (!useBrowser && quotaExhausted(selectedProfile, "video")) return flash(`${selectedProfile.name} 今日免费视频额度已经用完；图片额度不受影响`, 7000);
  const references = edgeInputs(item.id).filter(reference => referenceImage(reference));
  if (references.length > MAX_VIDEO_REFERENCES) return flash(`一个视频节点最多连接 ${MAX_VIDEO_REFERENCES} 张参考图`);
  let resolvedImages = [];
  try {
    resolvedImages = await Promise.all(references.map(async reference => {
      const data = await getImage(reference.id);
      if (!data || !/^data:image\//i.test(data)) throw new Error(`参考图「${reference.title || "未命名"}」还没有准备好`);
      return data;
    }));
  } catch (error) {
    return flash(error.message || "参考图读取失败", 7000);
  }
  const id = `DB-${Date.now().toString().slice(-7)}-${(++idSeed).toString(36).slice(-4)}`;
  const createdAt = new Date().toISOString();
  const created = new Date(createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const transport = {
    ...JSON.parse(JSON.stringify(item)), id, nodeId: item.id, created,
    profileId: useBrowser ? "browser-multi-account" : selectedProfile.id,
    generationChannel: useBrowser ? "browser" : "native",
    provider: useBrowser ? (pickedAccount.auto ? (pickedAccount.provider || "") : (pickedAccount.provider || "dola")) : "doubao",
    browserAccountId: useBrowser ? (pickedAccount.auto ? "" : pickedAccount.id) : "",
    paidQuotaConsent,
    images: resolvedImages,
    referenceNodeIds: references.map(reference => reference.id),
    referenceTitles: references.map(reference => reference.title),
    imageCount: references.length,
    nodeTitle: item.title,
    title: item.title
  };
  const job = {
    id, nodeId: item.id, title: item.title, created, createdAt, state: "preparing", status: "正在准备豆包任务", imageCount: references.length,
    prompt: item.prompt, referenceTitles: references.map(reference => reference.title), model: item.model, ratio: item.ratio,
    duration: item.duration, profileId: transport.profileId, profileName: useBrowser ? (pickedAccount.auto ? "自动分配空闲账号" : pickedAccount.name) : profileName(transport.profileId), output: "", file: ""
  };
  state.jobs.unshift(job);
  item.status = "submitting";
  item.lastJobId = id;
  save();
  render();
  showProgress("正在连接豆包并执行提交前检查……", id);
  let result;
  try { result = useBrowser ? await window.desktop.dispatchBrowserTask(transport) : await window.desktop.sendToDoubao(transport); }
  catch (error) { result = { ok: false, error: error.message || "任务连接失败" }; }
  if (job.stopped || item.lastJobId !== id || ['completed','failed','quota_exhausted','conversion_pending','monitor_timeout'].includes(job.state)) return;
  if (result?.queued || result?.sent) {
    if (job.state === "preparing") {
      job.state = "submitting";
      item.status = "submitting";
      job.status = result.message || "已发给账号窗口，正在填写并发送";
    } else {
      item.status = job.state;
    }
    save(); render();
    showProgress(job.status, id);
    return;
  }
  if (job.stopped || item.lastJobId !== id || ['completed','failed','quota_exhausted','conversion_pending','monitor_timeout'].includes(job.state)) return;
  if (result?.pendingReceipt) {
    // A late IPC response cannot rewind a newer receipt/result event.
    if(['preparing','submitting'].includes(job.state)){
      job.state=result.pendingState||'awaiting_receipt';item.status=job.state;job.status=result.message;
    }
    save();render();
    if(!['completed','failed','quota_exhausted','needs_attention'].includes(job.state))showProgress(job.status,id);
    return;
  }
  if (result.needsAttention) {
    item.status="needs_attention";job.state="needs_attention";job.status=result.message||"请处理原对话后在历史中继续核验";
    hideProgress(id);save();render();return flash(job.status,8000);
  }
  if (!result.ok) {
    if (result.stopped || job.stopped) {
      item.status = "stopped";
      job.stopped = true;
      job.state = "stopped";
      job.status = "已停止：画布不再提交、监听或回填此任务";
      save(); render();
      hideProgress(id);
      return;
    }
    item.status = result.paidBlocked ? "paid_blocked" : result.quotaExhausted ? "quota_exhausted" : "failed";
    job.state = item.status;
    job.status = result.paidBlocked ? result.error : result.quotaExhausted ? `今日视频额度已用完，任务未提交：${result.error || "豆包反馈额度用尽"}` : `失败：${result.error || "未知错误"}`;
    if (result.quotaExhausted) await refreshProfiles();
    save(); render();
    hideProgress(id);
    return flash(result.paidBlocked?result.error:`生成失败：${result.error || "未知错误"}`, 7000);
  }
  item.status = "generating";
  job.state = "generating";
  job.status = "豆包已确认接收，正在生成";
  save(); render();
  showProgress("豆包已确认接收任务，正在等待视频生成完成……", id);
  flash("豆包已确认接收任务");
}

async function stopTask(item) {
  const job = state.jobs.find(entry => entry.id === item.lastJobId);
  if (!job) return flash("没有找到这个节点正在执行的任务");
  if (item.status === "stopping") return;
  item.status = "stopping";
  job.stopped = true;
  job.state = "stopping";
  job.status = "正在停止本任务的后台操作……";
  hideProgress(job.id);
  save();
  render();
  let result;
  try { result = await window.desktop.stopDoubaoJob(job.id); }
  catch (error) { result = { ok: false, error: error.message }; }
  if (result?.ok) {
    job.state = "stopped";
    job.status = "画布后台已停止；豆包已接收的任务需在豆包中确认取消";
    if (item.lastJobId === job.id) item.status = "stopped";
  } else {
    job.status = `停止尚未确认：${result?.error || "连接异常"}。请退出画布阻断后续操作`;
  }
  hideProgress(job.id);
  save(); render();
  flash(result?.ok ? "该节点任务已停止" : `停止失败：${result?.error || "未知错误"}`, 6000);
}

function applyViewport() {
  $("#canvas").style.transform = `translate(${state.pan.x}px,${state.pan.y}px) scale(${state.zoom})`;
  if(editingVideoId)showVideoEditor(editingVideoId);
  updateGrid();
}

function scheduleViewport() {
  if (viewportFrame) return;
  viewportFrame = requestAnimationFrame(() => {
    viewportFrame = 0;
    applyViewport();
  });
}

function updateGrid() {
  const stage = $("#stage");
  let gridWorldSize = GRID_WORLD_SIZE;
  while (gridWorldSize * state.zoom < 12) gridWorldSize *= 2;
  stage.style.setProperty("--grid-size", `${gridWorldSize * state.zoom}px`);
  stage.style.setProperty("--grid-x", `${state.pan.x}px`);
  stage.style.setProperty("--grid-y", `${state.pan.y}px`);
}

function fitToContent() {
  const stageBounds = $("#stage").getBoundingClientRect();
  if (!state.nodes.length) {
    state.zoom = 1;
    state.pan = { x: 0, y: 0 };
    save();
    applyViewport();
    return;
  }
  const minimumX = Math.min(...state.nodes.map(item => item.x));
  const minimumY = Math.min(...state.nodes.map(item => item.y));
  const maximumX = Math.max(...state.nodes.map(item => item.x + Number(item.w || 320)));
  const maximumY = Math.max(...state.nodes.map(item => item.y + Number(item.h || (item.type === "video" ? 560 : 340))));
  const contentWidth = Math.max(1, maximumX - minimumX);
  const contentHeight = Math.max(1, maximumY - minimumY);
  const padding = 90;
  state.zoom = Math.max(MIN_ZOOM, Math.min(1, MAX_ZOOM, (stageBounds.width - padding * 2) / contentWidth, (stageBounds.height - padding * 2) / contentHeight));
  state.pan.x = (stageBounds.width - contentWidth * state.zoom) / 2 - minimumX * state.zoom;
  state.pan.y = (stageBounds.height - contentHeight * state.zoom) / 2 - minimumY * state.zoom;
  save();
  applyViewport();
}

async function refreshProfiles() {
  profiles = await window.desktop.listProfiles();
  if (!profiles.some(profile => profile.id === state.activeProfileId)) state.activeProfileId = profiles[0]?.id || "default";
  $("#profileSelect").innerHTML = profileOptions(state.activeProfileId);
  const currentProfile = profiles.find(profile => profile.id === state.activeProfileId);
  const exhausted = [quotaExhausted(currentProfile, "video") ? "视频额度尽" : "", quotaExhausted(currentProfile, "image") ? "图片额度尽" : ""].filter(Boolean).join("、");
  $("#profileState").textContent = exhausted || `当前：${currentProfile?.name || "已连接"}`;
  save();
}

function renderProfileModal() {
  $("#profileList").innerHTML = profiles.map(profile => {
    const labels = [quotaExhausted(profile, "video") ? "免费视频额度已用完" : "", quotaExhausted(profile, "image") ? "免费图片额度已用完" : ""].filter(Boolean);
    return `<div class="profileRow ${labels.length ? "quotaEmpty" : ""}" data-profile="${escapeHtml(profile.id)}"><span><b>${escapeHtml(profile.name)}</b><small>${profile.accountName ? `已绑定：${escapeHtml(profile.accountName)}${profile.accountSubtitle ? ` · ${escapeHtml(profile.accountSubtitle)}` : ""}` : "尚未绑定，请同步豆包账号"}</small>${labels.map(label => `<em>今日${label}</em>`).join("")}</span><button data-open ${profile.accountName ? "" : "disabled"}>切换</button><button data-rename>改名</button><button data-remove>移除</button></div>`;
  }).join("");
  $$(".profileRow").forEach(row => {
    const id = row.dataset.profile;
    row.querySelector("[data-open]").onclick = () => openProfileWorkspace(id);
    row.querySelector("[data-rename]").onclick = async () => {
      const current = profiles.find(profile => profile.id === id);
      const name = prompt("画布中的账号名称", current?.name || "豆包账号");
      if (!name?.trim()) return;
      profiles = await window.desktop.renameProfile(id, name.trim());
      await refreshProfiles(); renderProfileModal(); render();
    };
    row.querySelector("[data-remove]").onclick = async () => {
      const result = await window.desktop.removeProfile(id);
      if (!result.ok) return result.error && flash(result.error);
      await refreshProfiles(); renderProfileModal(); render();
    };
  });
}

async function openProfileWorkspace(id = state.activeProfileId) {
  const selectedProfile = profiles.find(profile => profile.id === id);
  if (!selectedProfile?.accountName) return syncAccountsFromDoubao();
  $("#profileState").textContent = "正在切换……";
  showProgress(`正在原来的豆包窗口切换到 ${selectedProfile.name}……`);
  let result = await window.desktop.openProfile(id);
  if (result.needPath) {
    const executable = await window.desktop.chooseDoubao();
    if (executable) result = await window.desktop.openProfile(id);
  }
  $("#progressCard").classList.remove("show");
  if (!result.ok) { $("#profileState").textContent = "切换失败"; return flash(result.error || "无法切换豆包账号", 7000); }
  $("#profileState").textContent = result.loginRequired ? "请在豆包中登录" : `当前：${result.currentAccount?.name || selectedProfile.name}`;
  flash(result.loginRequired ? "请在原来的官方豆包窗口完成登录" : `豆包已经切换到 ${result.currentAccount?.name || selectedProfile.name}`, 5000);
}

async function syncAccountsFromDoubao() {
  $("#profileState").textContent = "正在同步……";
  showProgress("正在读取原来的豆包账号切换列表……");
  let result = await window.desktop.syncAccounts();
  if (result.needPath) {
    const executable = await window.desktop.chooseDoubao();
    if (executable) result = await window.desktop.syncAccounts();
  }
  $("#progressCard").classList.remove("show");
  if (!result.ok) {
    $("#profileState").textContent = result.needLogin ? "请先登录豆包" : "同步失败";
    return flash(result.error || "无法读取豆包账号", 8000);
  }
  profiles = result.profiles || await window.desktop.listProfiles();
  if (!profiles.some(profile => profile.id === state.activeProfileId)) state.activeProfileId = profiles[0]?.id || "default";
  $("#profileSelect").innerHTML = profileOptions(state.activeProfileId);
  $("#profileState").textContent = `当前：${result.currentAccount?.name || "已连接"}`;
  renderProfileModal();
  save(); render();
  flash(`已经同步 ${result.accountCount || profiles.length} 个豆包登录账号`, 6000);
}

function renderNoWatermarkStatus(status) {
  const button = $("#noWatermarkToggle");
  if (!button) return;
  const enabled = Boolean(status?.enabled);
  button.dataset.enabled = enabled ? "1" : "0";
  button.textContent = enabled
    ? `无水印：${Number(status?.activeJobs || 0) > 0 ? `捕获中${status.activeJobs > 1 ? `×${status.activeJobs}` : ""}` : (status?.running ? "待任务" : "等待豆包")}`
    : "无水印：关闭";
  button.classList.toggle("active", enabled);
  let changed=false;
  for(const result of status?.jobs||[]){
    const job=state.jobs.find(j=>j.id===result.jobId);
    if(job&&JSON.stringify(job.noWatermark)!==JSON.stringify(result)){job.noWatermark=result;changed=true;}
  }
  const errors=(status?.jobs||[]).filter(j=>j.state==='failed'||j.state==='unavailable');
  button.title=errors.length?`有 ${errors.length} 个任务素材未下载完成，请看历史记录中的具体原因`:'仅下载与原任务编号匹配的成品，不扫描历史视频';
  if(changed){save();if(sidebarOpen&&panelMode==='history')renderHistoryPanel();}
}

async function refreshNoWatermarkStatus() {
  try {
    const status = await window.desktop.noWatermarkStatus();
    renderNoWatermarkStatus(status);
    return status;
  } catch (error) {
    renderNoWatermarkStatus({ enabled: false, running: false });
    flash(`无水印功能状态读取失败：${error.message}`, 6000);
    return null;
  }
}

async function toggleNoWatermark() {
  const button = $("#noWatermarkToggle");
  const enabled = button?.dataset.enabled !== "1";
  button.disabled = true;
  try {
    const status = await window.desktop.setNoWatermarkEnabled(enabled);
    renderNoWatermarkStatus(status);
    flash(enabled ? "无水印功能已待命；只捕获画布自己提交的视频任务" : "无水印素材捕获已关闭", 5000);
  } catch (error) {
    flash(`无水印功能切换失败：${error.message}`, 7000);
  } finally {
    button.disabled = false;
  }
}

function bindPage() {
  const stage = $("#stage");
  stage.oncontextmenu = event => {
    const edgeId = event.target.closest?.("[data-edge]")?.dataset.edge || hitTestEdgeId(event.clientX, event.clientY);
    if (edgeId) {
      event.preventDefault();
      selectedEdgeId = edgeId;
      drawWires();
      showEdgeMenu(event, edgeId);
      return;
    }
    if (event.target.closest(".node")) return;
    event.preventDefault();
    menuPoint = canvasPoint(event.clientX, event.clientY);
    showCanvasMenu(event);
  };
  const beginPan = event => {
    if (event.button === 2) return;
    if (event.target.closest("#helpToggle,#arrangeBar,#marquee,#pointerModeBtn")) return;
    if (event.button === 0 && !event.target.closest(".node,button,input,textarea,select,.videoEditor,.mentionPicker,.refs")) {
      const edgeId = hitTestEdgeId(event.clientX, event.clientY);
      if (edgeId) {
        event.preventDefault();
        event.stopPropagation();
        hideMenu();
        selectCanvasEdge(edgeId, event);
        return;
      }
    }
    if (event.target.closest("[data-edge],.wireHit,.wire")) return;
    const panTool = canvasPanActive();
    if (!panTool && event.target.closest(".node")) return;
    const middleButton = event.button === 1;
    const blankLeftButton = event.button === 0 && !event.target.closest("button,input,textarea,select");
    if (!middleButton && !blankLeftButton) return;
    event.preventDefault();
    if (middleButton || panTool) event.stopPropagation();
    hideMenu();
    if (middleButton || panTool) {
      gesture = { kind: "pan", pointerId: event.pointerId, middleButton: true, startX: event.clientX, startY: event.clientY, x: state.pan.x, y: state.pan.y };
      stage.setPointerCapture(event.pointerId);
      stage.classList.add("panning");
      return;
    }
    const start = canvasPoint(event.clientX, event.clientY);
    gesture = {
      kind: "marquee",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      curX: event.clientX,
      curY: event.clientY,
      origin: start,
      additive: event.shiftKey,
      moved: false
    };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add("selecting");
  };
  const movePan = event => {
    if (gesture?.pointerId !== event.pointerId) return;
    if (gesture.kind === "pan") {
      event.preventDefault();
      if (gesture.middleButton) event.stopPropagation();
      state.pan.x = gesture.x + event.clientX - gesture.startX;
      state.pan.y = gesture.y + event.clientY - gesture.startY;
      scheduleViewport();
      return;
    }
    if (gesture.kind !== "marquee") return;
    event.preventDefault();
    gesture.curX = event.clientX;
    gesture.curY = event.clientY;
    if (Math.abs(event.clientX - gesture.startX) > 4 || Math.abs(event.clientY - gesture.startY) > 4) gesture.moved = true;
    const stageBox = stage.getBoundingClientRect();
    const marquee = $("#marquee");
    if (marquee) {
      marquee.hidden = false;
      marquee.style.left = `${Math.min(gesture.startX, gesture.curX) - stageBox.left}px`;
      marquee.style.top = `${Math.min(gesture.startY, gesture.curY) - stageBox.top}px`;
      marquee.style.width = `${Math.abs(gesture.curX - gesture.startX)}px`;
      marquee.style.height = `${Math.abs(gesture.curY - gesture.startY)}px`;
    }
    const end = canvasPoint(event.clientX, event.clientY);
    const hits = nodesInRect(gesture.origin.x, gesture.origin.y, end.x, end.y);
    $$("#canvas .node").forEach(element => {
      const on = hits.some(item => item.id === element.dataset.id) || (gesture.additive && isSelected(element.dataset.id));
      element.classList.toggle("selected", on);
    });
  };
  const endPan = event => {
    if (gesture?.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (gesture.kind === "pan" && gesture.middleButton) event.stopPropagation();
    try { if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId); } catch {}
    if (gesture.kind === "pan") {
      if (viewportFrame) { cancelAnimationFrame(viewportFrame); viewportFrame = 0; }
      applyViewport();
      save();
      const tap = Math.abs(event.clientX - gesture.startX) < 5 && Math.abs(event.clientY - gesture.startY) < 5;
      if (tap && !event.target.closest(".node,.videoEditor,[data-edge]")) {
        selectedEdgeId = null;
        leaveVideoNodeMode();
        selectOnly(null);
        drawWires();
      }
    } else if (gesture.kind === "marquee") {
      const end = canvasPoint(event.clientX, event.clientY);
      const hits = nodesInRect(gesture.origin.x, gesture.origin.y, end.x, end.y);
      if (!gesture.moved) {
        if (!event.target.closest("[data-edge]")) selectedEdgeId = null;
        leaveVideoNodeMode();
        selectOnly(null);
        drawWires();
      }
      else if (gesture.additive) setSelection([...new Set([...selectedIds, ...hits.map(item => item.id), state.selected].filter(Boolean))], hits.at(-1)?.id);
      else setSelection(hits.map(item => item.id), hits.at(-1)?.id);
      hideMarquee();
      if (gesture.moved && hits.length === 1 && hits[0].type === "video") showVideoEditor(hits[0].id);
      else if (!hits.length) leaveVideoNodeMode();
    }
    gesture = null;
    stage.classList.remove("panning");
    stage.classList.remove("selecting");
  };
  stage.addEventListener("pointerdown", beginPan, true);
  stage.addEventListener("pointermove", movePan, true);
  stage.addEventListener("pointerup", endPan, true);
  stage.addEventListener("pointercancel", endPan, true);
  stage.addEventListener("auxclick", event => { if (event.button === 1) event.preventDefault(); });
  stage.onwheel = event => {
    if (event.target.closest?.(".mentionPicker")) { event.stopPropagation(); return; }
    const videoNode = event.target.closest?.(".videoNode");
    const prompt = videoNode?.querySelector(".prompt textarea");
    if (prompt && event.target.closest?.(".refs, .prompt")) {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? prompt.clientHeight : 1;
      prompt.scrollTop += event.deltaY * unit;
      return;
    }
    if(event.target.closest?.('.videoEditor')){event.stopPropagation();return;}
    event.preventDefault();
    const previous = state.zoom;
    state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.zoom - event.deltaY * 0.0015));
    const bounds = stage.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    state.pan.x = x - (x - state.pan.x) * state.zoom / previous;
    state.pan.y = y - (y - state.pan.y) * state.zoom / previous;
    save(); applyViewport();
  }, { passive: false };
  stage.ondragover = event => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    if (event.target.closest?.(".dropZone,.imageActions")) { stage.classList.remove("fileOver"); return; }
    event.preventDefault(); stage.classList.add("fileOver");
  };
  stage.ondragleave = event => { if (!stage.contains(event.relatedTarget)) stage.classList.remove("fileOver"); };
  stage.ondrop = event => {
    stage.classList.remove("fileOver");
    if (event.target.closest(".dropZone") || !event.dataTransfer?.types?.includes("Files") || !event.dataTransfer.files.length) return;
    event.preventDefault();
    dropFiles(event.dataTransfer.files, canvasPoint(event.clientX, event.clientY));
  };
  document.addEventListener("drop", () => stage.classList.remove("fileOver"), true);
  document.addEventListener("dragend", () => stage.classList.remove("fileOver"), true);
  addEventListener("blur", () => stage.classList.remove("fileOver"));
  document.onclick = event => { if (!event.target.closest("#contextMenu") && !event.target.closest("[data-more]")) hideMenu(); };
  document.addEventListener("pointerdown", event => {
    if (event.target.closest("#undoBtn")) return;
    if (event.target.closest("#stage,#contextMenu")) checkpointUndo();
  }, true);
  document.addEventListener("focusin", event => {
    if (event.target.closest("#canvas .node") && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) checkpointUndo();
  }, true);
  document.onkeydown = event => {
    const activeElement = document.activeElement;
    if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === "z") { event.preventDefault(); undoCanvasStep(); return; }
    if (["INPUT", "TEXTAREA", "SELECT"].includes(activeElement.tagName) || activeElement.isContentEditable) return;
    if (event.key === " " ) {
      event.preventDefault();
      if (!event.repeat) {
        spacePanHeld = true;
        syncCanvasPointerMode();
      }
      return;
    }
    if (event.key === "Escape") { selectedEdgeId = null; drawWires(); leaveVideoNodeMode(); selectOnly(null); hideMarquee(); return; }
    if (event.ctrlKey && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelection(state.nodes.map(item => item.id));
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      if (selectedEdgeId && state.edges.some(edge => edge.id === selectedEdgeId)) {
        event.preventDefault();
        checkpointUndo();
        removeEdgeById(selectedEdgeId);
        return;
      }
      const ids = selectedIds.size ? [...selectedIds] : (state.selected ? [state.selected] : []);
      if (!ids.length) return;
      if (ids.length === 1 && event.key === "Delete" && findNode(ids[0])?.type !== "image") return;
      event.preventDefault();
      checkpointUndo();
      ids.forEach(id => removeNode(id));
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === "d" && selectedNode()) { event.preventDefault(); checkpointUndo(); duplicateNode(selectedNode()); }
    if (event.ctrlKey && event.key.toLowerCase() === "v") { checkpointUndo(); pasteAt(canvasPoint(innerWidth / 2, innerHeight / 2)); }
  };
  document.onkeyup = event => {
    if (event.key !== " ") return;
    if (!spacePanHeld) return;
    spacePanHeld = false;
    syncCanvasPointerMode();
  };
  addEventListener("blur", () => {
    if (!spacePanHeld) return;
    spacePanHeld = false;
    syncCanvasPointerMode();
  });
  $("#undoBtn").onclick = undoCanvasStep;
  $("#pointerModeBtn")?.addEventListener("click", () => toggleCanvasPointerMode());
  syncCanvasPointerMode();
  $("#arrangeBtn")?.addEventListener("click", () => arrangeTidy());
  $$("[data-arrange]").forEach(button => {
    button.onclick = () => {
      const mode = button.dataset.arrange;
      if (mode === "row") arrangeRow();
      else if (mode === "column") arrangeColumn();
      else if (mode === "grid") arrangeGrid();
      else arrangeTidy();
    };
  });
  $$("[data-set-theme]").forEach(button => {
    button.onclick = () => setCanvasTheme(button.dataset.setTheme);
  });
  syncThemeButtons();
  const resetConfirmModal = $("#resetConfirmModal");
  const showResetConfirm = () => {
    $("#profileModal")?.classList.remove("show");
    resetConfirmModal?.classList.add("show");
  };
  const hideResetConfirm = () => resetConfirmModal?.classList.remove("show");
  const requestResetUserData = async (button) => {
    hideResetConfirm();
    if (!window.desktop.resetUserData) {
      flash("当前版本还没有恢复纯净版功能，请完全退出后重新打开", 8000);
      return;
    }
    if (button) button.disabled = true;
    try {
      const result = await window.desktop.resetUserData();
      if (result?.cancelled) return;
      if (!result?.ok) flash(result?.error || "无法恢复纯净版", 8000);
      else flash("正在删除用户数据并重启…", 8000);
    } catch (error) {
      flash(`无法恢复纯净版：${error.message}`, 8000);
    } finally {
      if (button) button.disabled = false;
    }
  };
  const resetHeaderBtn = $("#resetUserDataBtn");
  if (resetHeaderBtn) resetHeaderBtn.onclick = showResetConfirm;
  const resetModalBtn = $("#resetUserDataModalBtn");
  if (resetModalBtn) resetModalBtn.onclick = showResetConfirm;
  $("#cancelResetConfirm")?.addEventListener("click", hideResetConfirm);
  $("#confirmResetUserDataBtn")?.addEventListener("click", () => requestResetUserData($("#confirmResetUserDataBtn")));
  const openAllBrowsers = async (button) => {
    if (button) { button.disabled = true; const old = button.textContent; button.textContent = '正在打开…'; button.dataset.prevLabel = old; }
    try {
      const listed = await window.desktop.listBrowserAccounts();
      const accounts = listed.filter(account => account.enabled !== false);
      const result = await window.desktop.openBrowserWindow();
      state.generationChannel = 'browser'; $("#generationChannel").value = 'browser'; save();
      if (!accounts.length) {
        flash('还没有内置浏览器账号，已打开添加窗口。请选择豆包或 Dola，填好后点「保存并打开」。', 8000);
        if (button) button.textContent = '请先添加账号';
      } else {
        flash(`已打开 ${result.workers || accounts.length} 个账号浏览器。关掉某一个后，再点「打开全部窗口」会重新打开全部。`);
        if (button && button.id === "warmupBrowserWorkersBtn") button.textContent = `已开${result.workers || accounts.length}个窗口`;
        else if (button) button.textContent = "打开全部窗口";
      }
    } catch (error) {
      if (button) button.textContent = button.dataset.prevLabel || (button.id === "warmupBrowserWorkersBtn" ? "打开全部账号窗口" : "打开全部窗口");
      flash(`打开账号浏览器失败：${error.message}`, 6000);
    } finally {
      if (button) button.disabled = false;
    }
  };
  $("#browserAccountsBtn").onclick = () => openAllBrowsers($("#browserAccountsBtn"));
  const warmupWorkers = $("#warmupBrowserWorkersBtn");
  if (warmupWorkers) warmupWorkers.onclick = () => openAllBrowsers(warmupWorkers);
  $("#closePanel").onclick = () => setSidebarOpen(false);
  $("#helpToggle").onclick = () => setSidebarOpen(!(sidebarOpen && panelMode !== "history"), "node");
  $("#queueBtn").onclick = () => {
    selectOnly(null);
    setSidebarOpen(true, "history");
  };
  $("#preview button").onclick = () => $("#preview").classList.remove("show");
  $("#progressClose").onclick = () => $("#progressCard").classList.remove("show");
  $("#profileSelect").onchange = event => {
    state.activeProfileId = event.target.value;
    $("#profileState").textContent = "生成时自动切换";
    save(); render();
  };
  $("#generationChannel").value = state.generationChannel;
  $("#generationChannel").onchange = event => {
    state.generationChannel = event.target.value === "browser" ? "browser" : "native";
    save();
    $("#profileState").textContent = state.generationChannel === "browser" ? "内置多账号浏览器：无水印回填 · 30秒/2.5 可用" : "原生豆包客户端通道";
    render();
  };
  $("#syncProfiles").onclick = syncAccountsFromDoubao;
  $("#syncProfilesModal").onclick = syncAccountsFromDoubao;
  $("#openProfile").onclick = () => openProfileWorkspace();
  $("#manageProfiles").onclick = () => { renderProfileModal(); $("#profileModal").classList.add("show"); };
  $("#noWatermarkToggle").onclick = toggleNoWatermark;
  window.desktop.onNoWatermarkStatus(renderNoWatermarkStatus);
  $("#openNoWatermarkFolder").onclick = async () => {
    const error = await window.desktop.openNoWatermarkFolder();
    if (error) flash(`素材文件夹无法打开：${error}`, 6000);
  };
  $("#updateAppBtn")?.addEventListener("click", runAppUpdate);
  window.desktop.onUpdateProgress(payload => {
    const button = $("#updateAppBtn");
    if (!button || !payload) return;
    if (payload.stage === "download" && payload.total) {
      button.textContent = `下载 ${Math.min(99, Math.round(payload.received / payload.total * 100))}%`;
    } else if (payload.message) button.textContent = payload.message;
  });
  refreshUpdateButton();
  $("[data-close-profile]").onclick = () => $("#profileModal").classList.remove("show");
  $("#profileModal").onclick = event => { if (event.target === $("#profileModal")) $("#profileModal").classList.remove("show"); };
  $("#addProfile").onclick = async () => {
    const name = prompt("给待绑定账号项起个名字", `待绑定账号 ${profiles.length + 1}`);
    if (!name?.trim()) return;
    const profile = await window.desktop.addProfile(name.trim());
    profiles.push(profile);
    state.activeProfileId = profile.id;
    await refreshProfiles(); renderProfileModal(); render();
    flash("已添加待绑定项；请登录对应账号后点击“同步账号”", 6000);
  };
}

async function refreshUpdateButton() {
  const button = $("#updateAppBtn");
  if (!button || !window.desktop.checkUpdate) return;
  try {
    const status = await window.desktop.checkUpdate();
    button.dataset.newer = status.newer ? "1" : "0";
    button.textContent = status.newer ? `一键更新 ${status.latest}` : "已是最新";
    button.title = status.notes || status.message || "";
  } catch {
    button.textContent = "检查更新";
  }
}

async function runAppUpdate() {
  const button = $("#updateAppBtn");
  if (!button) return;
  button.disabled = true;
  try {
    const status = await window.desktop.checkUpdate();
    if (!status.newer) {
      flash(status.message || "已是最新版本", 4000);
      button.textContent = "已是最新";
      return;
    }
    if (!confirm(`发现新版本 ${status.latest}。将下载并重启软件，画布数据不会删除。${status.notes ? "\n" + status.notes : ""}`)) return;
    button.textContent = "正在更新";
    const result = await window.desktop.applyUpdate();
    flash(result.message || "正在安装并重启", 6000);
  } catch (error) {
    flash(`更新失败：${error.message}`, 8000);
    button.textContent = "检查更新";
  } finally {
    button.disabled = false;
  }
}

function applyLicenseStatus(status) {
  const badge = $("#licenseBadge");
  if (!badge) return;
  badge.textContent = status?.badge || (status?.ok ? "已授权" : "未授权");
  badge.title = status?.message || "";
  badge.classList.toggle("expired", !status?.ok);
}

function showLicenseModal(status) {
  const modal = $("#licenseModal");
  const message = $("#licenseModalMessage");
  if (message) message.textContent = status?.message && !status?.ok ? status.message : "";
  modal?.classList.add("show");
  $("#licenseKeyInput")?.focus();
}

function hideLicenseModal() {
  $("#licenseModal")?.classList.remove("show");
}

async function submitLicenseKey() {
  const input = $("#licenseKeyInput");
  const message = $("#licenseModalMessage");
  const button = $("#activateLicenseBtn");
  const key = input?.value?.trim() || "";
  if (!key) {
    if (message) message.textContent = "请输入卡密";
    return false;
  }
  if (button) button.disabled = true;
  try {
    const status = await window.desktop.activateLicense(key);
    applyLicenseStatus(status);
    if (status?.ok) {
      hideLicenseModal();
      flash(status.message || "激活成功", 4000);
      return true;
    }
    if (message) message.textContent = status?.message || "激活失败";
    return false;
  } catch (error) {
    if (message) message.textContent = error.message || "激活失败";
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

async function initializeLicense() {
  let unlock;
  $("#activateLicenseBtn")?.addEventListener("click", async () => {
    if (await submitLicenseKey()) unlock?.();
  });
  $("#licenseKeyInput")?.addEventListener("keydown", event => {
    if (event.key === "Enter") $("#activateLicenseBtn")?.click();
  });
  $("#licenseBadge")?.addEventListener("click", async () => {
    const status = await window.desktop.licenseStatus();
    applyLicenseStatus(status);
    if (!status?.ok) showLicenseModal(status);
  });
  window.desktop.onLicenseStatus(status => {
    applyLicenseStatus(status);
    if (status?.ok) {
      hideLicenseModal();
      unlock?.();
    }
  });
  const status = await window.desktop.licenseStatus();
  applyLicenseStatus(status);
  if (status?.ok) return true;
  showLicenseModal(status);
  return new Promise(resolve => { unlock = () => resolve(true); });
}

async function initializeCanvas() {
  canvasBooting = true;
  bindPage();
  render();
  const hydrateImages = (async () => {
    const items = state.nodes.filter(item => item.type === "image");
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const pointer = String(item.image || "");
      const blob = await getImageBlob(item.id) || (pointer && !pointer.startsWith("idb:") ? await sourceToBlob(pointer) : null);
      if (!blob) continue;
      if (!pointer.startsWith("idb:")) {
        try { await putImage(item.id, blob); } catch {}
      }
      pinImageRef(item);
      await ensureDisplayUrl(item.id, blob);
      const element = document.querySelector(`#canvas .node[data-id="${CSS.escape(String(item.id))}"]`);
      const body = element?.querySelector(".imageBody");
      const src = displayImageSrc(item);
      if (body && src) {
        let img = body.querySelector("img");
        if (!img) {
          body.replaceChildren();
          img = document.createElement("img");
          img.draggable = false;
          img.alt = item.title || "";
          body.append(img);
        }
        if (img.getAttribute("src") !== src) img.src = src;
        renderedNodes.set(String(item.id), nodeMarkup(item));
      }
      if (index % 2 === 1) await new Promise(resolve => setTimeout(resolve, 0));
    }
    saveNow();
    render();
  })();
  await refreshProfiles();
  await refreshNoWatermarkStatus();
  const dataLocation = await window.desktop.dataLocation();
  const dataPath = $("#dataPath");
  if (dataPath) dataPath.textContent = `画布和日志保存在：${dataLocation}；豆包登录信息仍由原来的豆包 App 管理。`;
  window.desktop.onDoubaoProgress(payload => {
    const message = typeof payload === "string" ? payload : payload.message;
    const jobId = typeof payload === "object" ? payload.jobId : undefined;
    showProgress(message, jobId);
  });
  window.desktop.onDoubaoJobState(payload => {
    applyJobState(payload);
    if (["waiting_confirmation", "waiting_paid_confirmation", "waiting_manual_submission"].includes(payload.state)) {
      flash(payload.message, 10000);
    }
  });
  window.desktop.onDoubaoResult(payload => {
    const item = findNode(payload.nodeId);
    const job = state.jobs.find(entry => entry.id === payload.jobId);
    if (item) {
      item.output = payload.url;
      item.status = "completed";
      item.lastJobId = payload.jobId;
    }
    const title = item?.title || payload.nodeTitle || job?.title || "视频生成";
    if (job) {
      job.state = "completed";
      job.status = `已回填到发出节点「${title}」`;
      job.output = payload.url;
      job.file = payload.file || "";
      job.completedAt = payload.completedAt || new Date().toISOString();
      job.pendingBackfill = false;
    }
    save(); render();
    hideProgress(payload.jobId);
    flash(`已回填到发出节点「${title}」`, 6000);
  });
  window.desktop.onDoubaoJobFailed(payload => {
    const item = findNode(payload.nodeId);
    const job = state.jobs.find(entry => entry.id === payload.jobId);
    if (job?.stopped || job?.state==='completed') return;
    if (item && item.lastJobId === payload.jobId) item.status = payload.quotaExhausted ? "quota_exhausted" : "failed";
    const capabilityName = payload.capability === "image" ? "图片" : "视频";
    if (job) {
      job.state = payload.quotaExhausted ? "quota_exhausted" : "failed";
      job.retryable = Boolean(payload.retryable);
      job.quotaNotDeducted = Boolean(payload.quotaNotDeducted);
      job.status = payload.quotaExhausted
        ? `账号${capabilityName}额度已用完，任务未提交：${payload.error}`
        : `生成失败${payload.quotaNotDeducted ? "（额度未扣除，可修改后重试）" : ""}：${payload.error}`;
    }
    save(); render();
    hideProgress(payload.jobId);
    flash(payload.quotaExhausted ? `豆包账号${capabilityName}额度已用完；另一类额度不受影响` : payload.error, 8000);
  });
  window.desktop.onProfilesUpdated(async payload => {
    profiles = Array.isArray(payload) ? payload : await window.desktop.listProfiles();
    $("#profileSelect").innerHTML = profileOptions(state.activeProfileId);
    const currentProfile = profiles.find(profile => profile.id === state.activeProfileId);
    const exhausted = [quotaExhausted(currentProfile, "video") ? "视频额度尽" : "", quotaExhausted(currentProfile, "image") ? "图片额度尽" : ""].filter(Boolean).join("、");
    $("#profileState").textContent = exhausted || `当前：${currentProfile?.name || "已连接"}`;
    if ($("#profileModal").classList.contains("show")) renderProfileModal();
  });
  if(window.desktop.taskSnapshots){
    const snapshots=await window.desktop.taskSnapshots(state.jobs.map(job=>job.id));
    const restored=new Set();
    for(const payload of Array.isArray(snapshots)?snapshots:[]){
      restored.add(payload.jobId);
      const job=state.jobs.find(j=>j.id===payload.jobId);
      if(job&&payload.sequence===(job.stateSequence||0))job.stateSequence=payload.sequence-1;
      applyJobState(payload);
    }
    for(const job of state.jobs){
      if(!restored.has(job.id)&&!job.stopped&&RUNNING_JOB_STATES.has(job.state)){
        job.state='needs_attention';job.status='上次监听已中断，原任务保留；请恢复已有结果，不要重复生成';
      }
    }
  }
  for(const job of state.jobs){
    if(job.stopped){job.state='stopped';job.status='画布后台已停止；豆包云端任务请单独查看';}
    const item=findNode(job.nodeId);if(item?.lastJobId===job.id&&job.state)item.status=job.state;
  }
  addEventListener("beforeunload", saveNow);
  new ResizeObserver(()=>{if(editingVideoId)showVideoEditor(editingVideoId);}).observe($("#stage"));
  await hydrateImages;
  canvasBooting = false;
  saveNow();
  render();
  window.jxCanvas = { state, prepareVideo, createVideoNode, render };
}

async function initialize() {
  if (!(await initializeLicense())) return;
  await initializeCanvas();
}

initialize().catch(error => {
  console.error(error);
  try { flash(`画布初始化失败：${error.message}`, 10000); } catch {}
  const stage = document.querySelector("#stage");
  if (stage && !document.querySelector(".bootError")) {
    const box = document.createElement("div");
    box.className = "bootError";
    box.style.cssText = "position:absolute;inset:80px 40px auto;z-index:50;padding:18px 20px;border:1px solid #f0c2c2;border-radius:14px;background:#fff6f6;color:#8a1f1f;font-size:14px;";
    box.textContent = `画布没有正常打开：${error.message}。请完全退出后重新打开。`;
    stage.append(box);
  }
});
