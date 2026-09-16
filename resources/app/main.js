const { app, BrowserWindow, clipboard, dialog, ipcMain, net, session, shell, webContents } = require("electron");
const crypto = require("crypto");
const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
function canvasIcon() {
  const file = path.join(__dirname, "app", "icon.png");
  try { return fs.existsSync(file) ? file : undefined; } catch { return undefined; }
}
const { fileURLToPath, pathToFileURL } = require("url");
const { clearSubmissionFeedbackSuppressions, connectRecoveryPage, ensureControlledNative, inspectNativeAccounts, isPortReady, listVideoFiles, monitorImageResult, monitorResult, openProfile, profilePort, submitImageJob, submitJob, switchToAccount, resumePendingSubmission } = require("./doubao-controller");
const { NoWatermarkService } = require("./no-watermark-service");
const { ensureH264Mp4, ffmpegStatus, prepareBundledFfmpegCache } = require("./video-compat");
const { runWithSignal, stoppedError } = require("./task-runtime");
const { hasStableIdentity, nativeConversationKey } = require('./message-identity');
const browserAccountService = require('./browser-account-service');
const platformHelper = require('./platform-helper');
const licenseClient = require('./license-client');
const integrityCheck = require('./integrity-check');
const updateClient = require('./update-client');
const settingsStore = require('./settings-store');
const MAIN_BOOT_SEAL = "JXPB-BOOT-71ae5c90d3f24b18";
const XIANYU_SHOP_URL = "https://m.tb.cn/h.8js2tsw?tk=OkKiT2yF9Ur";

function executableFolder() {
  return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
}

function portableDataPath() {
  if (process.env.DOUBAO_CANVAS_DATA_DIR) return path.resolve(process.env.DOUBAO_CANVAS_DATA_DIR);
  return path.join(executableFolder(), "数据");
}

function resetFlagPath() {
  return path.join(executableFolder(), ".jx-reset-pending");
}

function wipePortableUserData() {
  const root = path.resolve(portableDataPath());
  const exeDir = path.resolve(executableFolder());
  if (!root || root.length < 8) return;
  if (root.toLowerCase() === exeDir.toLowerCase()) return;
  const custom = Boolean(process.env.DOUBAO_CANVAS_DATA_DIR);
  if (!custom && path.basename(root) !== "数据") return;
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 16, retryDelay: 200 });
  } catch {
    try {
      if (!fs.existsSync(root)) return;
      for (const name of fs.readdirSync(root)) {
        try { fs.rmSync(path.join(root, name), { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch {}
      }
    } catch {}
  }
}

function consumeResetRequest() {
  let requested = false;
  try { requested = fs.existsSync(resetFlagPath()); } catch {}
  if (process.argv.includes("--reset-user-data")) requested = true;
  if (!requested) return false;
  wipePortableUserData();
  try { fs.unlinkSync(resetFlagPath()); } catch {}
  return true;
}

const justResetUserData = consumeResetRequest();

const gpuSafeFile = path.join(portableDataPath(), 'gpu-safe-mode.json');
function gpuSafeModeEnabled() {
  try { return Boolean(JSON.parse(fs.readFileSync(gpuSafeFile, 'utf8')).enabled); } catch { return false; }
}
function enableGpuSafeMode() {
  try {
    fs.mkdirSync(path.dirname(gpuSafeFile), { recursive: true });
    fs.writeFileSync(gpuSafeFile, JSON.stringify({ enabled: true, at: Date.now() }));
  } catch {}
}

// Windows 上 GPU 合成失败会整窗闪白；只关合成、不关硬件加速，界面才能画出来。
if (process.platform === 'win32' || gpuSafeModeEnabled() || process.env.DOUBAO_CANVAS_DISABLE_GPU === '1') {
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}
if (process.env.DOUBAO_CANVAS_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
}

function migratePreviousData(destination) {
  try {
    const previous = path.join(app.getPath("appData"), "doubao-canvas");
    if (path.resolve(previous).toLowerCase() === path.resolve(destination).toLowerCase()) return;
    if (!fs.existsSync(previous) || fs.existsSync(destination)) return;
    fs.mkdirSync(destination, { recursive: true });
    fs.cpSync(previous, destination, {
      recursive: true,
      force: false,
      filter: source => !/(^|[\\/])(Cache|Code Cache|GPUCache|DawnCache)([\\/]|$)/i.test(source)
    });
  } catch {}
}

const dataRoot = portableDataPath();
if (!justResetUserData) migratePreviousData(dataRoot);
app.setPath("userData", dataRoot);
licenseClient.setLicensePath(path.join(dataRoot, "license.json"));
process.env.META_CANVAS_FFMPEG_CACHE = path.join(dataRoot, "运行组件", "ffmpeg.exe");
const noWatermarkService = new NoWatermarkService({
  dataRoot,
  log: (message, details) => automationLog(message, details),
  onChange: () => emitNoWatermarkStatus()
});

let win;
let browserWin;
let canvasRecovering = false;
let canvasRecoverCount = 0;
let lastCanvasRecoverAt = 0;
let resetUserDataBusy = false;

function canvasPageStillAlive() {
  try {
    if (!win || win.isDestroyed()) return false;
    if (win.webContents.isCrashed()) return false;
    const url = String(win.webContents.getURL() || "");
    if (!url) return false;
    return !win.webContents.isLoadingMainFrame();
  } catch {
    return false;
  }
}

function recoverCanvasWindow(reason) {
  if (!win || win.isDestroyed() || canvasRecovering) return;
  const reasonText = String(reason || "");
  const rendererGone = /render-process-gone/i.test(reasonText);
  if (!rendererGone && canvasPageStillAlive()) {
    automationLog("画布页面仍在运行，已取消自动刷新", { reason: reasonText });
    return;
  }
  const now = Date.now();
  if (canvasRecoverCount >= 2) {
    automationLog("本轮已恢复画布两次，停止自动刷新", { reason: reasonText });
    try {
      dialog.showErrorBox("画布画面中断", "画布没有再次自动刷新，以免反复闪屏丢掉正在编辑的内容。请完全退出后重新打开。");
    } catch {}
    return;
  }
  if (lastCanvasRecoverAt && now - lastCanvasRecoverAt < 15000 && !rendererGone) {
    automationLog("画布恢复冷却中，跳过自动刷新", { reason: reasonText });
    return;
  }
  canvasRecovering = true;
  canvasRecoverCount += 1;
  lastCanvasRecoverAt = now;
  automationLog("画布渲染进程已退出，正在恢复一次", { reason: reasonText, count: canvasRecoverCount });
  setTimeout(() => {
    if (!win || win.isDestroyed()) { canvasRecovering = false; return; }
    try { win.reload(); } catch {}
    setTimeout(() => { canvasRecovering = false; }, 8000);
  }, 400);
}
const browserTaskWorkers = [];
const browserTaskQueue = [];
const browserTaskOwners = new Map();
const browserPendingJobs = new Map();
const harvestedBrowserUrls = new Set();
const completingBrowserJobs = new Set();
const browserReadyBackfills = new Map();
const browserJobOrigins = new Map();
const BROWSER_JOB_ORIGINS_PATH = path.join(dataRoot, "browser-job-origins.json");
function loadBrowserJobOrigins() {
  try {
    const list = JSON.parse(fs.readFileSync(BROWSER_JOB_ORIGINS_PATH, "utf8"));
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item?.jobId && item?.nodeId) browserJobOrigins.set(String(item.jobId), {
        jobId: String(item.jobId),
        nodeId: String(item.nodeId),
        nodeTitle: String(item.nodeTitle || "视频生成"),
        accountId: String(item.accountId || ""),
        provider: String(item.provider || ""),
        boundAt: Number(item.boundAt) || Date.now()
      });
    }
  } catch {}
}
function saveBrowserJobOrigins() {
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(BROWSER_JOB_ORIGINS_PATH, JSON.stringify([...browserJobOrigins.values()].slice(-300)));
  } catch {}
}
function rememberBrowserJobOrigin(task, extra = {}) {
  const jobId = String(task?.id || task?.jobId || "");
  const nodeId = String(task?.nodeId || extra.nodeId || "");
  if (!jobId || !nodeId) return;
  const previous = browserJobOrigins.get(jobId);
  if (previous && previous.nodeId !== nodeId) return previous;
  const origin = {
    jobId,
    nodeId,
    nodeTitle: String(task?.title || task?.nodeTitle || extra.nodeTitle || previous?.nodeTitle || "视频生成"),
    accountId: String(extra.accountId || task?.browserAccountId || task?.accountId || previous?.accountId || ""),
    provider: String(extra.provider || task?.provider || previous?.provider || ""),
    boundAt: previous?.boundAt || Date.now()
  };
  browserJobOrigins.set(jobId, origin);
  saveBrowserJobOrigins();
  return origin;
}
function jobIdSuffix(jobId) {
  return String(jobId || "").replace(/[^A-Za-z0-9]/g, "").slice(-4).toUpperCase();
}
loadBrowserJobOrigins();
let browserHarvestTimer = null;
let browserHarvestBusy = false;
let browserAccountCursor = 0;
let browserPreferredProvider = '';
let browserPreferredAccountIds = [];
const MAX_BROWSER_TASK_WORKERS = 50;
const DOLA_DAILY_SOFT_CAP = 3;
const DOLA_ACCOUNT_COOLDOWN_MS = 75 * 1000;
const DOLA_GLOBAL_STAGGER_MS = 18 * 1000;
const accountLastSubmitAt = new Map();
let lastDolaSubmitAt = 0;
let browserPaceTimer = 0;
const countedUsageJobs = new Set();
const activeSubmissions = new Set();
const activeMonitors = new Map();
const taskControls = new Map();
const submissionQueue = [];
const batchHolds = new Map();
let submissionBusy = false;
let submissionPumpTimer = 0;
function scheduleSubmissionPump(delayMs = 1500) {
  if (submissionPumpTimer || !submissionQueue.length) return;
  submissionPumpTimer = setTimeout(() => {
    submissionPumpTimer = 0;
    pumpSubmissionQueue();
  }, Math.max(400, Number(delayMs) || 1500));
  submissionPumpTimer.unref?.();
}
let accountSyncBusy = false;
let resultViewLeases=0,resultViewTimer=null,currentResultView='',lastResultViewAt=0,resultViewPriorityJobId='';
const RESULT_VIEW_DWELL_MS=30000;
const resultViewVisits=new Map();
const resultViewFailures=new Map(),resultViewRetryAfter=new Map();
function resultViewKey(m){const url=(m.baseline?.confirmationContext||m.baseline?.submissionContext)?.url;return m.profileId+'|'+(nativeConversationKey(url)||url);}
function canRotateResult(m){
  const context=m.baseline?.confirmationContext||m.baseline?.submissionContext;
  return !m.baseline?.awaitingSubmissionReceipt&&Boolean(context?.root?.messageId)&&/^doubao-chat\/chat\/\d+$/.test(nativeConversationKey(context?.url));
}
function closeHiddenBrowserWindows() {
  for (const worker of browserTaskWorkers) {
    try { if (worker.win && !worker.win.isDestroyed()) worker.win.close(); } catch {}
  }
  try { if (browserWin && !browserWin.isDestroyed()) browserWin.close(); } catch {}
}

function focusMainWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else app.on("second-instance", () => focusMainWindow());

function tasksRoot() {
  const folder = path.join(app.getPath("userData"), "任务和日志");
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

function automationLog(message, details) {
  try {
    const entry = { time: new Date().toISOString(), message, ...(details ? { details } : {}) };
    fs.appendFileSync(path.join(tasksRoot(), "自动控制日志.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {}
}

function emitNoWatermarkStatus() {
  try { win && !win.isDestroyed() && win.webContents.send("no-watermark-status-updated", noWatermarkService.status()); } catch {}
}

function progress(message, jobId) {
  if (jobId && taskControls.get(jobId)?.cancelled) return;
  automationLog(message, jobId ? { jobId } : undefined);
  try { win && !win.isDestroyed() && win.webContents.send("doubao-progress", { message, jobId }); } catch {}
}

function emitJobState(job, state, message, details = {}) {
  if (taskControls.get(job.id)?.cancelled && !["stopping", "stopped", "awaiting_backfill", "completed"].includes(state)) return;
  const control=taskControl(job.id);
  if(control.state==='completed'&&!['completed','recovering','stopping','stopped'].includes(state))return;
  control.state=state;
  control.job=job;
  if(['monitor_timeout','needs_attention','conversion_pending'].includes(state))batchHolds.set(job.id,job);
  else if(['completed','failed','quota_exhausted','paid_blocked','stopped','generating','awaiting_receipt','recovering','awaiting_backfill'].includes(state))batchHolds.delete(job.id);
  const payload = { jobId: job.id, nodeId: job.nodeId, profileId: job.profileId || "default", state, message: String(message || ""), ...details, sequence:++control.sequence, updatedAt:new Date().toISOString() };
  try{
    const folder=jobFolder(job.id);fs.mkdirSync(folder,{recursive:true});
    const file=path.join(folder,'任务运行状态.json'),temp=file+'.tmp';
    fs.writeFileSync(temp,JSON.stringify(payload,null,2),'utf8');fs.renameSync(temp,file);
  }catch(error){automationLog('保存任务运行状态失败',{jobId:job.id,error:error.message});}
  automationLog("任务状态更新", payload);
  try { win && !win.isDestroyed() && win.webContents.send("doubao-job-state", payload); } catch {}
  return payload;
}

function licensedIpc(handler) {
  return async (...args) => {
    await licenseClient.refresh("heartbeat").catch(() => {});
    licenseClient.broadcast(win);
    licenseClient.assertLicensed();
    return handler(...args);
  };
}

let licenseExitBusy = false;
let licenseWatchTimer = null;
const MAIN_LOCK_SEAL = "JXPB-LOCK-b8e14d27c6a03e5f";
void MAIN_BOOT_SEAL;
void MAIN_LOCK_SEAL;
async function enforceLicense(force = false) {
  if (licenseExitBusy) return;
  const integrity = integrityCheck.verify();
  if (!integrity.skipped && !integrity.ok && integrity.tamper) {
    await licenseClient.reportTamper({ files: integrity.files }).catch(() => {});
    licenseExitBusy = true;
    try {
      const box = {
        type: "warning",
        title: "设备已锁定",
        message: licenseClient.LOCKED_MESSAGE,
        detail: "如需解封请联系作者。",
        buttons: ["退出"]
      };
      if (win && !win.isDestroyed()) await dialog.showMessageBox(win, box);
      else await dialog.showMessageBox(box);
    } catch {}
    app.quit();
    return;
  }
  const status = await licenseClient.refresh("heartbeat", force).catch(() => licenseClient.current());
  licenseClient.broadcast(win);
  if (status?.ok || !status?.mustExit) return;
  licenseExitBusy = true;
  const locked = Boolean(status.machineLocked);
  try {
    const box = {
      type: "warning",
      title: locked ? "设备已锁定" : "授权校验失败",
      message: locked
        ? (licenseClient.LOCKED_MESSAGE || "此设备因篡改程序已被锁定，无法再使用本软件。")
        : "无法连接授权服务器，或卡密已失效。软件即将退出。",
      detail: locked ? "如需解封请联系作者。" : String(status.message || "请检查网络后重新打开"),
      buttons: ["退出"]
    };
    if (win && !win.isDestroyed()) await dialog.showMessageBox(win, box);
    else await dialog.showMessageBox(box);
  } catch {}
  app.quit();
}

function jobFolder(jobId) {
  const safe = String(jobId || "");
  if (!/^(?:DB|IMG)-[A-Za-z0-9-]{1,80}$/.test(safe)) throw new Error("任务编号无效");
  return path.join(tasksRoot(), safe);
}

function newestVideoFile(folder) {
  return listVideoFiles(folder).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

function newestPendingH264File(folder) {
  try {
    return fs.readdirSync(folder)
      .filter(name => /\.h264-pending\.mp4$/i.test(name))
      .map(name => path.join(folder, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
  } catch { return null; }
}

async function recoverPendingH264(folder) {
  const pending = newestPendingH264File(folder);
  if (!pending) return null;
  await ensureH264Mp4(pending, message => automationLog(message, { file: path.basename(pending) }));
  const completed = pending.replace(/\.h264-pending\.mp4$/i, ".mp4");
  fs.renameSync(pending, completed);
  return completed;
}

function imageResultFiles(folder) {
  try {
    return fs.readdirSync(folder)
      .filter(name => /^豆包生成图片-\d+\.(?:png|jpe?g|webp|gif)$/i.test(name))
      .sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }))
      .map(name => path.join(folder, name));
  } catch { return []; }
}

function savedImageResult(folder, job) {
  const files = imageResultFiles(folder);
  if (!files.length) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, "图片结果清单.json"), "utf8"));
    if (manifest.jobId !== job.id || manifest.nodeId !== job.nodeId || !manifest.resultClaim) return null;
    return { files, claimSignature: manifest.resultClaim, messageId: manifest.messageId || "" };
  } catch { return null; }
}

async function retryBoundMaterial(job,folder) {
  if(!noWatermarkService.status().enabled)return {message:'无水印素材开关未开启'};
  const manual=activeManualSubmission(job.id);
  if(manual)return {message:`原视频已保留；任务 ${manual.job.id} 正在等待人工提交，完成或停止后再补存无水印素材`};
  try{
    const previous=JSON.parse(fs.readFileSync(path.join(folder,'无水印结果.json'),'utf8'));
    if(previous.jobId===job.id&&previous.state==='completed'&&previous.file&&fs.existsSync(previous.file)){
      await ensureH264Mp4(previous.file);return {file:previous.file,message:'无水印素材已保存'};
    }
  }catch{}
  if(submissionBusy||accountSyncBusy||activeSubmissions.size||require('./doubao-controller').completedCardInteractionBusy()
    ||[...activeMonitors.values()].some(m=>m.profileId!==job.profileId))return {message:'原视频已保留；请在提交或切号结束后再次同步，补存无水印素材'};
  let proof,baseline;
  try{
    proof=JSON.parse(fs.readFileSync(path.join(folder,'视频结果凭据.json'),'utf8'));
    if(proof.jobId!==job.id||!proof.video?.messageId||!proof.video?.videoId)throw new Error('缺少成品编号');
    const receipt=JSON.parse(fs.readFileSync(path.join(folder,'豆包提交凭据.json'),'utf8'));
    if(receipt.jobId!==job.id)throw new Error('原任务凭据不一致');
    baseline=receipt.baseline;
  }catch{return {message:'旧任务没有可核验的成品编号，不能自动猜测下载；原视频文件保留'};}
  let client;accountSyncBusy=true;
  try{
    client=await connectRecoveryPage(baseline,job.accountIdentity);
    const video=await client.evaluate(require('./completed-video-source').readCompletedVideoSourceScript(proof.video,proof.video.conversationUrl));
    if(!video||video.messageId!==proof.video.messageId||video.videoId!==proof.video.videoId)throw new Error('原成品暂不可见，请在豆包打开原账号对话后再次同步');
    await noWatermarkService.armCapture({jobId:job.id,targetId:client.targetId,pageUrl:video.conversationUrl});
    const file=await noWatermarkService.captureResult({client,job,video,folder});
    return {file,message:file?'无水印素材已补存':'原视频已保留；无水印下载未完成，请查看本任务下载状态'};
  }catch(error){
    if(taskControl(job.id).cancelled)throw error;
    return {message:'原视频已保留；无水印补存暂未完成：'+error.message};
  }finally{
    client?.close();accountSyncBusy=false;pumpSubmissionQueue();
    await noWatermarkService.disarmCapture(job.id).catch(()=>{});
  }
}

const manualMaterialJobs = new Set();

async function removeVideoWatermark(jobId) {
  if (manualMaterialJobs.has(jobId)) return { ok: false, error: "该视频正在去除水印，请稍候" };
  manualMaterialJobs.add(jobId);
  try {
    const folder = jobFolder(jobId);
    const job = JSON.parse(fs.readFileSync(path.join(folder, "画布任务.json"), "utf8"));
    if (job.id !== jobId || !job.nodeId || job.type === "image" || !job.accountIdentity?.name) {
      throw new Error("缺少原视频任务凭据，无法获取无水印版本");
    }
    if (activeMonitors.has(jobId) || activeSubmissions.has(jobId) || taskControl(jobId).cancelled) {
      throw new Error("任务仍在运行或已停止，请先完成或恢复原任务");
    }
    if (!noWatermarkService.status().running || !noWatermarkService.status().enabled) {
      await noWatermarkService.start();
      const config = loadConfig();
      config.noWatermarkEnabled = true;
      saveConfig(config);
    }
    const material = await retryBoundMaterial(job, folder);
    if (!material.file) return { ok: false, error: material.message || "暂未获取到无水印视频" };
    return { ok: true, file: material.file, url: pathToFileURL(material.file).href, message: material.message };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    manualMaterialJobs.delete(jobId);
    emitNoWatermarkStatus();
  }
}

function emitResult(job, file) {
  if(taskControls.get(job.id)?.cancelled)return null;
  const payload = { jobId: job.id, nodeId: job.nodeId, file, url: pathToFileURL(file).href, completedAt: new Date().toISOString() };
  automationLog("生成结果已回填画布", payload);
  emitJobState(job, "completed", "已生成并回填画布", { file, url: payload.url, completedAt: payload.completedAt });
  try { win && !win.isDestroyed() && win.webContents.send("doubao-result", payload); } catch {}
  return payload;
}

function emitImageResult(job, result) {
  const files = Array.isArray(result?.files) ? result.files : [];
  if (!files.length || !result?.claimSignature) throw new Error("图片回填缺少结果归属凭据");
  const payload = {
    type: "image",
    jobId: job.id,
    nodeId: job.nodeId,
    claimSignature: result.claimSignature,
    messageId: result.messageId || "",
    files,
    urls: files.map(file => pathToFileURL(file).href),
    completedAt: new Date().toISOString()
  };
  automationLog("图片结果已按任务身份回填画布", { ...payload, files: files.map(file => path.basename(file)), urls: undefined });
  try { win && !win.isDestroyed() && win.webContents.send("doubao-image-result", payload); } catch {}
  return payload;
}

function emitJobFailure(job, error, options = {}) {
  if(taskControls.get(job.id)?.cancelled||taskControls.get(job.id)?.state==='completed')return null;
  if (typeof options === "boolean") options = { quotaExhausted: options };
  const quotaExhausted = Boolean(options.quotaExhausted);
  const payload = { type: job.type || "video", capability: job.type === "image" ? "image" : "video", jobId: job.id, nodeId: job.nodeId, error: String(error || "豆包任务失败"), quotaExhausted, retryable: Boolean(options.retryable), quotaNotDeducted: Boolean(options.quotaNotDeducted) };
  automationLog(quotaExhausted ? "账号额度已用完" : "豆包任务失败", payload);
  emitJobState(job, quotaExhausted ? "quota_exhausted" : "failed", payload.error, payload);
  try { win && !win.isDestroyed() && win.webContents.send("doubao-job-failed", payload); } catch {}
  return payload;
}

function taskControl(jobId) {
  if (!taskControls.has(jobId)) {
    let previous={};try{previous=JSON.parse(fs.readFileSync(path.join(jobFolder(jobId),'任务运行状态.json'),'utf8'));}catch{}
    taskControls.set(jobId, { cancelled: false, abort: new AbortController(), sequence:Number(previous.sequence)||0 });
  }
  return taskControls.get(jobId);
}

function stoppedResult(jobId) {
  return { ok: false, stopped: true, error: `任务 ${jobId} 已停止` };
}

function monitoredProfileIds() {
  return new Set([...activeMonitors.values()].map(item => item.profileId).filter(Boolean));
}

function activeBatchProfile() {
  return [...activeMonitors.values()].find(m=>!m.control?.cancelled)?.profileId || [...batchHolds.values()][0]?.profileId || '';
}

function activeManualSubmission(exceptJobId = "") {
  return [...activeMonitors.values()].find(item => item.job.id !== exceptJobId
    && item.baseline?.manualSubmissionRequested
    && item.baseline?.awaitingSubmissionReceipt);
}

function nextSubmissionIndex() {
  if (!submissionQueue.length) return -1;
  const receiptBlocking = [...activeMonitors.values()].some(m => {
    if (!m.baseline?.awaitingSubmissionReceipt) return false;
    if (!(m.baseline.manualSubmissionRequested || !hasStableIdentity((m.baseline.confirmationContext || m.baseline.submissionContext)?.root))) return false;
    const deadline = Number(m.baseline.receiptDeadline || 0);
    if (deadline && Date.now() > deadline) return false;
    return true;
  });
  if (receiptBlocking) {
    scheduleSubmissionPump(2000);
    return -1;
  }
  const owner=activeBatchProfile();
  return owner?submissionQueue.findIndex(entry=>entry.job.profileId===owner):0;
}

function pumpSubmissionQueue() {
  if (submissionBusy || accountSyncBusy || resultViewLeases || require("./doubao-controller").completedCardInteractionBusy()) {
    scheduleSubmissionPump(1500);
    return;
  }
  const index = nextSubmissionIndex();
  if (index < 0) {
    const owner=activeBatchProfile(),holds=[...batchHolds.values()].filter(j=>j.profileId===owner);
    for(const entry of submissionQueue){
      if(!owner||entry.job.profileId===owner)continue;
      const message=holds.length?`等待前一账号处理完毕：${holds.map(j=>j.id).join('、')} 需要继续核验或停止监听；本任务尚未提交`:'等待前一账号本批任务回填或明确结束后再切号；本任务尚未提交';
      if(entry.control.queueMessage!==message){entry.control.queueMessage=message;emitJobState(entry.job,'queued_account',message);}
    }
    if (submissionQueue.length) scheduleSubmissionPump(2500);
    return;
  }
  const [entry] = submissionQueue.splice(index, 1);
  submissionBusy = true;
  emitJobState(entry.job, "submitting", "正在独占豆包提交界面并核对本次任务");
  entry.control.finished = Promise.resolve(runWithSignal(entry.control.abort.signal, () => runSubmission(entry.job, entry.control)))
    .then(entry.resolve, entry.reject)
    .finally(() => {
      submissionBusy = false;
      pumpSubmissionQueue();
    });
}

async function pumpResultViews(){
  if(submissionBusy||accountSyncBusy||resultViewLeases||Date.now()-lastResultViewAt<RESULT_VIEW_DWELL_MS||require('./doubao-controller').completedCardInteractionBusy())return;
  if(activeManualSubmission())return;
  if(nextSubmissionIndex()>=0){pumpSubmissionQueue();return;}
  // Restore conversations only within the current account batch. Never rotate
  // to a queued/different account while this batch still owns the native UI.
  const owner=activeBatchProfile();
  const monitors=[...activeMonitors.values()].filter(m=>m.profileId===owner&&!m.control?.cancelled);
  if(!monitors.length||!monitors.every(canRotateResult))return;
  const groups=[...new Map(monitors.map(m=>[resultViewKey(m),m])).values()];
  const now=Date.now();
  const ready=groups.filter(m=>(resultViewRetryAfter.get(resultViewKey(m))||0)<=now);
  const priorityMonitor=resultViewPriorityJobId&&monitors.find(m=>m.job.id===resultViewPriorityJobId);
  const priorityKey=priorityMonitor?resultViewKey(priorityMonitor):'';
  const priority=priorityKey&&ready.find(m=>resultViewKey(m)===priorityKey);
  const selected=priority||ready.filter(m=>resultViewKey(m)!==currentResultView).sort((a,b)=>(resultViewVisits.get(resultViewKey(a))||0)-(resultViewVisits.get(resultViewKey(b))||0))[0]||ready.find(m=>m.control.state==='monitor_paused');
  if(!selected)return;
  const selectedKey=resultViewKey(selected);
  const selectedWasPriority=Boolean(priority&&selectedKey===priorityKey);
  accountSyncBusy=true;
  try{
    await runWithSignal(selected.control.abort.signal,()=>require('./doubao-controller').restoreBoundResultView(selected.baseline,selected.job.accountIdentity));
    currentResultView=selectedKey;resultViewVisits.set(currentResultView,Date.now());
    resultViewFailures.delete(selectedKey);resultViewRetryAfter.delete(selectedKey);
    for(const m of monitors)if(resultViewKey(m)===currentResultView&&!m.control.cancelled)emitJobState(m.job,'generating','已回到任务所属账号和原对话，正在核验并接收结果');
  }catch(error){
    if(!selected.control.cancelled){
      const failures=(resultViewFailures.get(selectedKey)||0)+1;
      const retryDelay=Math.min(5*60*1000,30000*2**Math.min(failures-1,4));
      resultViewFailures.set(selectedKey,failures);resultViewRetryAfter.set(selectedKey,Date.now()+retryDelay);
      automationLog('自动恢复任务账号和原对话暂未成功',{jobId:selected.job.id,error:error.message});
      for(const m of monitors)if(resultViewKey(m)===selectedKey&&!m.control.cancelled)emitJobState(m.job,'monitor_paused','暂时无法切回本任务所属账号和原对话。豆包中的任务仍保留，画布稍后自动重试；也可点“同步结果”立即优先核验。不会重新生成，也不会使用其他账号的结果');
    }
  }finally{if(selectedWasPriority&&resultViewPriorityJobId===priorityMonitor?.job.id)resultViewPriorityJobId='';lastResultViewAt=Date.now();accountSyncBusy=false;pumpSubmissionQueue();}
}

function rejectQueuedSubmissionsForProfile(profileId, message) {
  for (let index = submissionQueue.length - 1; index >= 0; index--) {
    const entry = submissionQueue[index];
    if (entry.job.profileId !== profileId) continue;
    submissionQueue.splice(index, 1);
    const error = String(message || "当前账号今日免费视频额度已经用完");
    emitJobState(entry.job, "quota_exhausted", `账号额度不足，任务尚未提交：${error}`, { quotaExhausted: true });
    entry.resolve({ ok: false, quotaExhausted: true, capability: "video", error });
  }
}

function cancelQueuedSubmission(jobId) {
  const index = submissionQueue.findIndex(entry => entry.job.id === jobId);
  if (index < 0) return false;
  const [entry] = submissionQueue.splice(index, 1);
  emitJobState(entry.job, "stopped", "任务在安全队列中被用户停止，尚未提交豆包");
  entry.resolve(stoppedResult(jobId));
  return true;
}

function beginResultMonitor({ client, baseline, folder, job, forceLatest = false, timeout, control = taskControl(job.id) }) {
  const seconds = Number.parseInt(String(job?.duration || ""), 10);
  if (!Number.isFinite(Number(timeout))) timeout = seconds >= 25 ? 75 * 60 * 1000 : seconds >= 14 ? 50 * 60 * 1000 : 35 * 60 * 1000;
  if (activeMonitors.has(job.id)) {
    try { client?.close(); } catch {}
    return false;
  }
  if (control.cancelled) {
    try { client?.close(); } catch {}
    return false;
  }
  activeMonitors.set(job.id, { client, control, job, baseline, profileId: job.profileId || "default", type: "video" });
  currentResultView=resultViewKey(activeMonitors.get(job.id));lastResultViewAt=Date.now();
  resultViewVisits.set(currentResultView,lastResultViewAt);
  control.monitorFinished = runWithSignal(control.abort.signal, () => monitorResult({
    client,
    baseline,
    folder,
    forceLatest,
    timeout,
    expectedPrompt: job.prompt || "",
    expectedJobId: job.id,
    expectedAccountIdentity: job.accountIdentity,
    job,
    shouldStop: () => control.cancelled,
    hasConcurrent: () => activeMonitors.size > 1,
    canInteract: () => activeSubmissions.size === 0 && !accountSyncBusy,
    acquireResultView:()=>{
      const entry=activeMonitors.get(job.id);
      if(submissionBusy||accountSyncBusy||(currentResultView&&entry&&resultViewKey(entry)!==currentResultView))return null;
      resultViewLeases++;
      let released=false;
      return ()=>{if(released)return;released=true;resultViewLeases--;pumpSubmissionQueue();};
    },
    onInteractionComplete: () => {
      const entry=activeMonitors.get(job.id);
      if(entry){
        currentResultView=resultViewKey(entry);
        lastResultViewAt=Date.now();
        resultViewVisits.set(currentResultView,lastResultViewAt);
      }
      pumpSubmissionQueue();
    },
    progress: message => progress(message, job.id),
    onBoundVideo: video => noWatermarkService.captureResult({client:video.client,job,video,folder}),
    onResult: file => { if (!control.cancelled) emitResult(job, file); },
    onStateChange: update => {
      if(control.cancelled)return;
      if(update.state==='generating'&&baseline.awaitingSubmissionReceipt===false&&!submissionBusy){currentResultView=resultViewKey(activeMonitors.get(job.id));lastResultViewAt=Date.now();resultViewVisits.set(currentResultView,lastResultViewAt);}
      emitJobState(job,update.state,update.message);
      if(['waiting_paid_confirmation','paid_blocked'].includes(update.state))gatePaidVideoSubmissions(job);
    },
    onFailure: (message, details) => {
      if(control.cancelled)return;
      if(details?.quotaExhausted){markProfileQuotaExhausted(job.profileId,'video',message);rejectQueuedSubmissionsForProfile(job.profileId,message);}
      emitJobFailure(job,message,details||{retryable:true});
    }
  })).catch(error => {
    if (!control.cancelled) {
      automationLog("结果监听暂时中断", { jobId: job.id, error: error.message });
      emitJobState(job,'needs_attention','豆包页面读取中断，原任务已保留；请恢复原对话后点击继续核验，不要重新生成');
    }
  }).finally(async () => {
    await noWatermarkService.disarmCapture(job.id)
      .then(emitNoWatermarkStatus)
      .catch(error => automationLog("无水印任务捕获解除失败", { jobId: job.id, error: error.message }));
    activeMonitors.delete(job.id);
    pumpSubmissionQueue();
  });
  return true;
}

function beginImageResultMonitor({ client, baseline, folder, job, timeout, control = taskControl(job.id) }) {
  if (activeMonitors.has(job.id)) {
    try { client?.close(); } catch {}
    return false;
  }
  if (control.cancelled) {
    try { client?.close(); } catch {}
    return false;
  }
  activeMonitors.set(job.id, { client, control, job, profileId: job.profileId || "default", type: "image" });
  monitorImageResult({
    client,
    baseline,
    folder,
    job,
    timeout,
    shouldStop: () => control.cancelled,
    progress: message => progress(message, job.id),
    onResult: result => { if (!control.cancelled) emitImageResult(job, result); },
    onQuotaExhausted: (message, affectsTask) => {
      if (control.cancelled) return;
      markProfileQuotaExhausted(job.profileId || "default", "image", message);
      if (affectsTask) emitJobFailure(job, message, true);
    },
    onFailure: message => { if (!control.cancelled) emitJobFailure(job, message, false); }
  }).catch(error => automationLog("图片结果监听失败", { jobId: job.id, error: error.message })).finally(() => {
    activeMonitors.delete(job.id);
    pumpSubmissionQueue();
  });
  return true;
}

function configFile() { return path.join(app.getPath("userData"), "settings.json"); }
function loadConfig() {
  return settingsStore.loadSettings(configFile());
}
function saveConfig(config) {
  settingsStore.saveSettings(configFile(), config);
}
function localDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function capabilityQuota(profile, capability) {
  const value = profile?.quotas?.[capability];
  return value?.status === "exhausted" && value?.date === localDayKey() ? value : null;
}
function profiles() {
  const config = loadConfig();
  if (!Array.isArray(config.profiles) || !config.profiles.length) {
    config.profiles = [{ id: "default", name: "待同步的豆包账号", port: profilePort() }];
    saveConfig(config);
  }
  let changed = false;
  config.profiles = config.profiles.map(profile => {
    const next = { ...profile, port: profilePort() };
    next.quotas = { ...(next.quotas || {}) };
    if (!next.quotas.video && next.quotaStatus === "exhausted" && next.quotaDate === localDayKey()) {
      next.quotas.video = { status: "exhausted", date: next.quotaDate, detectedAt: next.quotaDetectedAt, message: next.quotaMessage || "今日免费视频额度已经用完" };
      changed = true;
    }
    for (const capability of ["video", "image"]) {
      const quota = next.quotas[capability];
      if (quota?.status === "exhausted" && quota.date !== localDayKey()) {
        next.quotas[capability] = { status: "unknown" };
        changed = true;
      }
    }
    const legacyVideo = capabilityQuota(next, "video");
    next.quotaStatus = legacyVideo ? "exhausted" : "unknown";
    if (legacyVideo) {
      next.quotaDate = legacyVideo.date;
      next.quotaDetectedAt = legacyVideo.detectedAt;
      next.quotaMessage = legacyVideo.message;
    } else {
      delete next.quotaMessage;
      delete next.quotaDetectedAt;
    }
    return next;
  });
  if (changed) saveConfig(config);
  return config.profiles;
}
function profileById(id) { return profiles().find(profile => profile.id === id) || profiles()[0]; }
function profileIdentity(profile) {
  return {
    name: String(profile?.accountName || ""),
    subtitle: String(profile?.accountSubtitle || ""),
    avatarKey: String(profile?.avatarKey || ""),
    avatarShared: Boolean(profile?.avatarShared)
  };
}
function identityMatches(left, right) {
  return require("./doubao-controller").accountIdentityMatches(left, right);
}
function syncProfiles(accounts, currentAccount) {
  const config = loadConfig();
  const existing = profiles();
  const discovered = Array.isArray(accounts) ? accounts : [];
  const duplicateNames = discovered.filter((account, index) => discovered.findIndex(other => identityMatches(other, account)) !== index).map(account => account.name);
  if (duplicateNames.length) throw new Error(`豆包账号存在重名：${[...new Set(duplicateNames)].join('、')}。请先在豆包中改为不同昵称后同步，画布不会猜测账号身份。`);
  const unboundDefault = existing.find(profile => profile.id === "default" && !profile.accountName);
  // 当前账号只用于排列已读到的菜单条目，不作为另一个账号写入。
  const currentRow = currentAccount && discovered.find(account => identityMatches(account, currentAccount));
  const ordered = currentRow ? [currentRow, ...discovered.filter(account => account !== currentRow)] : discovered;
  for (const account of ordered) {
    let profile = existing.find(item => identityMatches(profileIdentity(item), account));
    if (!profile && unboundDefault && !unboundDefault.accountName) profile = unboundDefault;
    if (!profile) {
      profile = { id: `account-${crypto.randomUUID()}`, name: account.name || `豆包账号 ${existing.length + 1}`, port: profilePort() };
      existing.push(profile);
    }
    profile.accountName = account.name;
    profile.accountSubtitle = account.subtitle || "";
    profile.avatarKey = account.avatarKey || "";
    profile.avatarShared = Boolean(account.avatarShared);
    if (!profile.customName) profile.name = account.name || profile.name;
  }
  config.profiles = existing;
  saveConfig(config);
  emitProfilesUpdated();
  return existing;
}
function emitProfilesUpdated() {
  try { win && !win.isDestroyed() && win.webContents.send("profiles-updated", profiles()); } catch {}
}

function isOfficialDoubaoExecutable(file) {
  if (!file || path.basename(String(file)).toLowerCase() !== "doubao.exe") return false;
  try {
    if (path.resolve(file).toLowerCase() === path.resolve(process.execPath).toLowerCase()) return false;
    return fs.statSync(file).isFile();
  } catch { return false; }
}

function runningDoubaoExecutable() {
  try {
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const output = execFileSync(powershell, [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-Process -Name Doubao -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique"
    ], { windowsHide: true, encoding: "utf8", timeout: 3500 });
    return String(output || "").split(/\r?\n/).map(value => value.trim()).find(isOfficialDoubaoExecutable) || "";
  } catch { return ""; }
}

function doubaoExe() {
  const config = loadConfig();
  const configured = config.doubaoPath;
  if (configured && !isOfficialDoubaoExecutable(configured)) {
    delete config.doubaoPath;
    saveConfig(config);
    automationLog("已清除错误的豆包程序路径", { configured });
  }
  const local = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.ProgramFiles || "";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "";
  const guesses = [
    isOfficialDoubaoExecutable(configured) ? configured : "",
    "D:\\LLQXZ\\Doubao\\app\\Doubao.exe",
    path.join(local, "Doubao", "app", "Doubao.exe"),
    path.join(local, "Programs", "Doubao", "Doubao.exe"),
    path.join(local, "Programs", "Doubao", "app", "Doubao.exe"),
    programFiles ? path.join(programFiles, "Doubao", "Doubao.exe") : "",
    programFiles ? path.join(programFiles, "Doubao", "app", "Doubao.exe") : "",
    programFilesX86 ? path.join(programFilesX86, "Doubao", "Doubao.exe") : "",
    programFilesX86 ? path.join(programFilesX86, "Doubao", "app", "Doubao.exe") : ""
  ].filter(Boolean);
  return guesses.find(isOfficialDoubaoExecutable) || runningDoubaoExecutable();
}

function saveReferenceFiles(job, folder) {
  const images = Array.isArray(job.images) ? job.images.slice(0, 10) : [];
  const files = [];
  images.forEach((data, index) => {
    const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([\s\S]+)$/i.exec(String(data || ""));
    let buffer;
    let extension;
    if (match) {
      extension = match[1].includes("png") ? "png" : match[1].includes("webp") ? "webp" : "jpg";
      buffer = Buffer.from(match[2], "base64");
    } else if (/^file:/i.test(String(data || ""))) {
      let source;
      try { source = fileURLToPath(String(data)); } catch { throw new Error(`第 ${index + 1} 张生成图文件地址无效`); }
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`第 ${index + 1} 张生成图文件不存在`);
      buffer = fs.readFileSync(source);
      if (buffer[0] === 0x89 && buffer.slice(1, 4).toString("ascii") === "PNG") extension = "png";
      else if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) extension = "jpg";
      else if (buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") extension = "webp";
      else throw new Error(`第 ${index + 1} 张生成图不是受支持的 PNG、JPG 或 WEBP 文件`);
    } else {
      throw new Error(`第 ${index + 1} 张参考图数据无效`);
    }
    const file = path.join(folder, `${String(index + 1).padStart(2, "0")}-参考图.${extension}`);
    if (!buffer.length) throw new Error(`第 ${index + 1} 张参考图是空文件`);
    fs.writeFileSync(file, buffer);
    files.push(file);
  });
  return files;
}

async function chooseDoubaoExecutable() {
  while (true) {
    const result = await dialog.showOpenDialog(win, {
      title: "请选择官方豆包的 Doubao.exe（不要选择本画布程序）",
      buttonLabel: "选择官方 Doubao.exe",
      properties: ["openFile"],
      filters: [{ name: "官方豆包 Doubao.exe", extensions: ["exe"] }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = result.filePaths[0];
    if (!isOfficialDoubaoExecutable(selected)) {
      const wrongName = path.basename(selected || "");
      const answer = await dialog.showMessageBox(win, {
        type: "error",
        title: "选错程序了",
        message: wrongName.toLowerCase() === path.basename(process.execPath).toLowerCase() ? "你选择的是画布程序，不是官方豆包。" : `你选择的“${wrongName || '未知文件'}”不是官方 Doubao.exe。`,
        detail: "请进入官方豆包的安装目录，选择文件名恰好为 Doubao.exe 的程序。不要选择画布程序、安装包或快捷方式。",
        buttons: ["重新选择", "取消"],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      });
      if (answer.response !== 0) return null;
      continue;
    }
    const config = loadConfig();
    config.doubaoPath = selected;
    saveConfig(config);
    return selected;
  }
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function doubaoProcessesRunning() {
  const tasklist = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tasklist.exe");
  return new Promise(resolve => {
    execFile(tasklist, ["/FI", "IMAGENAME eq Doubao.exe", "/FO", "CSV", "/NH"], { windowsHide: true }, (_error, stdout) => {
      resolve(/^"?Doubao\.exe"?[,\s]/im.test(String(stdout || "")));
    });
  });
}

async function terminateDoubaoProcesses() {
  const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await new Promise(resolve => {
      execFile(taskkill, ["/IM", "Doubao.exe", "/T", "/F"], { windowsHide: true }, error => {
        if (error && ![128, 255].includes(Number(error.code))) lastError = error;
        resolve();
      });
    });
    await wait(450);
    if (!(await doubaoProcessesRunning())) return;
  }
  throw new Error(lastError?.message || "豆包后台进程没有完全退出，请从系统托盘退出豆包后重试");
}

async function waitForDoubaoShutdown() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const processesRunning = await doubaoProcessesRunning();
    const controlPortReady = await isPortReady(profilePort());
    if (!processesRunning && !controlPortReady) return;
    await wait(300);
  }
  throw new Error(`豆包已经关闭，但本地控制端口 ${profilePort()} 仍未释放；请完全退出豆包和其他画布实例后重试`);
}

async function withNativeDoubao(action, jobId) {
  let permissionGranted = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (jobId && taskControls.get(jobId)?.cancelled) throw stoppedError();
    try {
      return await action();
    } catch (error) {
      if (jobId && taskControls.get(jobId)?.cancelled) throw stoppedError();
      if (error.code !== "DOUBAO_RESTART_REQUIRED") throw error;
      if (attempt === 2) {
        throw new Error("已经自动重启豆包两次，但豆包仍处于普通模式。请从系统托盘完全退出豆包，再回到画布点击同步账号");
      }
      if (!permissionGranted) {
        const answer = await dialog.showMessageBox(win, {
          type: "info",
          title: "首次连接需要重启一次豆包",
          message: "家兴豆包无限画布需要关闭并重新打开你电脑上原来的豆包 App。",
          detail: "只在首次接管时执行，不会删除登录账号、账号切换列表、对话或生成任务。点击继续后请等待画布自动完成，不需要你手动打开豆包。",
          buttons: ["重启豆包并继续", "取消"],
          defaultId: 0,
          cancelId: 1,
          noLink: true
        });
        if (answer.response !== 0) throw new Error("已取消首次连接豆包");
        if (jobId && taskControls.get(jobId)?.cancelled) throw stoppedError();
        permissionGranted = true;
      }
      const round = attempt + 1;
      if (jobId && taskControls.get(jobId)?.cancelled) throw stoppedError();
      progress(round === 1 ? "正在彻底关闭豆包后台进程……" : "检测到豆包仍未接管，正在自动清理残留进程并重试……", jobId);
      automationLog("准备重启原生豆包", { jobId, round, reason: error.message });
      await terminateDoubaoProcesses();
      await waitForDoubaoShutdown();
      progress("豆包已完全关闭，正在用画布控制模式重新打开……", jobId);
      await wait(700);
    }
  }
}

async function ensureLogin(profile, exe, jobId) {
  const first = await withNativeDoubao(() => openProfile({
    exe,
    accountIdentity: profileIdentity(profile),
    progress: message => progress(message, jobId),
    log: message => automationLog(message, { profileId: profile.id, jobId })
  }), jobId);
  if (!first.loginRequired) return true;
  const answer = await dialog.showMessageBox(win, {
    type: "info",
    title: "请先登录原来的豆包",
    message: "你电脑上的官方豆包已经打开，请先正常登录账号。",
    detail: "登录完成后回到这里点击“我已登录，继续”。画布不会保存密码或验证码。",
    buttons: ["我已登录，继续", "取消"],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  return answer.response === 0;
}

function markProfileQuotaExhausted(profileId, capability, message) {
  const key = capability === "image" ? "image" : "video";
  const config = loadConfig();
  config.profiles = profiles().map(profile => profile.id === profileId ? {
    ...profile,
    quotas: {
      ...(profile.quotas || {}),
      [key]: {
        status: "exhausted",
        date: localDayKey(),
        detectedAt: new Date().toISOString(),
        message: String(message || `今日免费${key === "image" ? "图片" : "视频"}额度已经用完`).slice(0, 240)
      }
    },
    ...(key === "video" ? {
      quotaStatus: "exhausted",
      quotaDate: localDayKey(),
      quotaDetectedAt: new Date().toISOString(),
      quotaMessage: String(message || "今日免费视频额度已经用完").slice(0, 240)
    } : {})
  } : profile);
  saveConfig(config);
  emitProfilesUpdated();
}

function gatePaidVideoSubmissions(job) {
  const config=loadConfig();
  config.profiles=profiles().map(item=>item.id===job.profileId?{...item,paidQuotaGate:{date:localDayKey(),jobId:job.id}}:item);
  saveConfig(config);
  emitProfilesUpdated();
  blockUnconsentedPaidQueue(job.profileId);
}

async function runSubmission(job, control = taskControl(job.id)) {
  if (control.cancelled) return stoppedResult(job.id);
  const exe = doubaoExe();
  if (!exe) return { ok: false, needPath: true, error: "尚未选择豆包客户端" };
  const profile = profiles().find(item => item.id === (job.profileId || "default"));
  if (!profile) return { ok: false, error: "任务绑定的账号已不存在，请重新选择；不会替换成其他账号提交" };
  if (requiresPaidConsent(profile) && !job.paidQuotaConsent) return paidBlockedResult(job);
  job.profileId = profile.id;
  job.accountIdentity ||= profileIdentity(profile);
  if (!job.accountIdentity.name) return { ok: false, accountUnbound: true, error: `“${profile.name}”尚未绑定真实豆包账号，请先点击顶部“同步账号”` };
  if (capabilityQuota(profile, "video")) {
    emitJobState(job, "quota_exhausted", `${profile.name} 今日免费视频额度已经用完，任务尚未提交`, { quotaExhausted: true });
    return { ok: false, quotaExhausted: true, capability: "video", error: `${profile.name} 今日免费视频额度已经用完` };
  }
  if (activeMonitors.size === 0) clearSubmissionFeedbackSuppressions();
  activeSubmissions.add(job.id);
  const folder = jobFolder(job.id);
  let captureArmed = false;
  const handleSubmissionState = update => {
    if (control.cancelled) return;
    emitJobState(job, update.state, update.message, { detail: update.detail || "", quotaExhausted: Boolean(update.quotaExhausted) });
    // Keep already accepted jobs alive. Subsequent submissions need their own consent.
    if (["waiting_paid_confirmation","paid_blocked"].includes(update.state)) {
      gatePaidVideoSubmissions(job);
    }
  };
  const armTaskCapture = async client => {
    if(requiresPaidConsent(profiles().find(item=>item.id===job.profileId))&&!job.paidQuotaConsent){
      const error=new Error('同账号已有任务触发付费提示，本次提交已停止，未点击生成');error.code='DOUBAO_PAYMENT_REQUIRED';throw error;
    }
    try {
      if (control.cancelled) throw stoppedError();
      let pageUrl = "";
      try { pageUrl = await client.evaluate("location.href"); } catch {}
      captureArmed = await noWatermarkService.armCapture({ jobId: job.id, targetId: client.targetId, pageUrl });
      if (control.cancelled) { await noWatermarkService.disarmCapture(job.id); throw stoppedError(); }
      emitNoWatermarkStatus();
    } catch (error) {
      captureArmed = false;
      await noWatermarkService.disarmCapture(job.id).catch(() => {});
      if (control.cancelled) throw stoppedError();
      automationLog("无水印任务捕获启动失败，视频提交继续", { jobId: job.id, error: error.message });
    }
  };
  const preparePromptClipboard = async () => {
    if (control.cancelled) throw stoppedError();
    const expected = String(job.submittedPrompt || job.prompt || "");
    clipboard.writeText(expected);
    const copied = clipboard.readText();
    if (copied !== expected) throw new Error("系统剪贴板没有完整保存本次提示词，已停止粘贴和提交");
    job.promptClipboardVerified = true;
    job.promptClipboardLength = expected.length;
    job.promptClipboardSha256 = crypto.createHash("sha256").update(expected, "utf8").digest("hex");
  };
  fs.mkdirSync(folder, { recursive: true });
  try {
    job.submittedPrompt = String(job.prompt || "").trim();
    const files = saveReferenceFiles(job, folder);
    const metadata = { ...job, images: undefined, imageCount: files.length, profileName: profile.name, accountIdentity: job.accountIdentity };
    fs.writeFileSync(path.join(folder, "画布任务.json"), JSON.stringify(metadata, null, 2), "utf8");
    progress(`准备使用 ${profile.name} 提交任务……`, job.id);
    if (control.cancelled) return stoppedResult(job.id);
    // submitJob already connects, verifies login and switches accounts. Avoid doing it twice.
    let result = await withNativeDoubao(() => submitJob({
      exe,
      job,
      accountIdentity: job.accountIdentity,
      files,
      folder,
      progress: message => progress(message, job.id),
      log: message => automationLog(message, { profileId: profile.id, jobId: job.id }),
      shouldStop: () => control.cancelled,
      onBeforeSubmit: armTaskCapture,
      onBeforePromptPaste: preparePromptClipboard,
      onSubmissionState: handleSubmissionState
    }), job.id);
    if (result.needLogin) {
      const loggedInAgain = await ensureLogin(profile, exe, job.id);
      if (!loggedInAgain) return { ok: false, error: "豆包账号尚未登录" };
      result = await withNativeDoubao(() => submitJob({
        exe,
        job,
        accountIdentity: job.accountIdentity,
        files,
        folder,
        progress: message => progress(message, job.id),
        log: message => automationLog(message, { profileId: profile.id, jobId: job.id }),
        shouldStop: () => control.cancelled,
        onBeforeSubmit: armTaskCapture,
        onBeforePromptPaste: preparePromptClipboard,
        onSubmissionState: handleSubmissionState
      }), job.id);
    }
    if (!result.ok) return { ok: false, error: "豆包账号尚未登录" };
    if (control.cancelled) {
      try { result.client?.close(); } catch {}
      return stoppedResult(job.id);
    }
    if (result.needsAttention) {
      emitJobState(job,"needs_attention",result.message);
      return {ok:true,needsAttention:true,message:result.message,jobId:job.id,taskFolder:folder};
    }
    if(result.paidBlocked){gatePaidVideoSubmissions(job);return paidBlockedResult(job,result.message);}
    if(result.pendingReceipt){
      emitJobState(job,result.pendingState||'awaiting_receipt',result.message);
      beginResultMonitor({client:result.client,baseline:result.baseline,folder,job,control});
      return {ok:true,pendingReceipt:true,pendingState:result.pendingState||'awaiting_receipt',message:result.message,jobId:job.id};
    }
    automationLog("任务已由豆包页面确认接收", { jobId: job.id, profileId: profile.id });
    emitJobState(job, "generating", "豆包已返回本次任务的正式提交凭据，正在生成");
    beginResultMonitor({
      client: result.client,
      baseline: result.baseline,
      folder,
      job,
      control
    });
    return { ok: true, submitted: true, jobId: job.id, profileId: profile.id, taskFolder: folder };
  } catch (error) {
    automationLog("任务失败", { jobId: job.id, profileId: profile.id, error: error.message, stack: error.stack });
    if(error.code==='DOUBAO_PAYMENT_REQUIRED'){gatePaidVideoSubmissions(job);return paidBlockedResult(job,error.message);}
    if (error.code === "DOUBAO_TASK_STOPPED" || control.cancelled) {
      emitJobState(job, "stopped", "任务已由用户停止");
      return stoppedResult(job.id);
    }
    if (error.code === "DOUBAO_QUOTA_EXHAUSTED") {
      markProfileQuotaExhausted(profile.id, "video", error.message);
      rejectQueuedSubmissionsForProfile(profile.id, error.message);
      emitJobFailure(job, error.message, { quotaExhausted: true });
      return { ok: false, quotaExhausted: true, capability: "video", error: `${profile.name}：${error.message}`, taskFolder: folder, profiles: profiles() };
    }
    const preSubmissionFailure = new Set([
      "DOUBAO_ACCOUNT_LIST_READ_FAILED", "DOUBAO_ACCOUNT_MENU_NOT_OPEN", "DOUBAO_ACCOUNT_ENTRY_BLOCKED",
      "DOUBAO_ACCOUNT_NOT_FOUND", "DOUBAO_ACCOUNT_AMBIGUOUS", "DOUBAO_ACCOUNT_VERIFY_FAILED",
      "DOUBAO_ACCOUNT_CLICK_TARGET_LOST", "DOUBAO_ACCOUNT_UNBOUND", "DOUBAO_MAIN_WINDOW_REQUIRED"
    ]).has(error.code);
    const retryable = error.code === "DOUBAO_GENERATION_REJECTED" || preSubmissionFailure;
    const quotaNotDeducted = Boolean(error.details?.quotaNotDeducted) || preSubmissionFailure;
    emitJobFailure(job, error.message, { retryable, quotaNotDeducted });
    return { ok: false, error: error.message, code: error.code, retryable, quotaNotDeducted, taskFolder: folder };
  } finally {
    activeSubmissions.delete(job.id);
    if (captureArmed && !activeMonitors.has(job.id)) {
      await noWatermarkService.disarmCapture(job.id)
        .then(emitNoWatermarkStatus)
        .catch(error => automationLog("提交结束后解除无水印捕获失败", { jobId: job.id, error: error.message }));
    }
  }
}

async function runImageSubmission(job, control = taskControl(job.id)) {
  job.type = "image";
  if (control.cancelled) return stoppedResult(job.id);
  const exe = doubaoExe();
  if (!exe) return { ok: false, needPath: true, error: "尚未选择豆包客户端" };
  const profile = profileById(job.profileId || "default");
  job.profileId = profile.id;
  job.accountIdentity = profileIdentity(profile);
  if (!job.accountIdentity.name) return { ok: false, accountUnbound: true, error: `“${profile.name}”尚未绑定真实豆包账号，请先点击顶部“同步账号”` };
  if (capabilityQuota(profile, "image")) {
    return { ok: false, quotaExhausted: true, capability: "image", error: `${profile.name} 今日免费图片额度已经用完` };
  }
  activeSubmissions.add(job.id);
  const folder = jobFolder(job.id);
  fs.mkdirSync(folder, { recursive: true });
  try {
    job.submittedPrompt = String(job.prompt || "").trim();
    clipboard.writeText(job.prompt || "");
    fs.writeFileSync(path.join(folder, "画布任务.json"), JSON.stringify({ ...job, profileName: profile.name, accountIdentity: job.accountIdentity }, null, 2), "utf8");
    progress(`准备使用 ${profile.name} 提交图片任务……`, job.id);
    if (control.cancelled) return stoppedResult(job.id);
    const loggedIn = await ensureLogin(profile, exe, job.id);
    if (!loggedIn) return { ok: false, error: "已取消登录豆包账号" };
    if (control.cancelled) return stoppedResult(job.id);
    let result = await withNativeDoubao(() => submitImageJob({
      exe,
      job,
      accountIdentity: job.accountIdentity,
      folder,
      progress: message => progress(message, job.id),
      log: message => automationLog(message, { profileId: profile.id, jobId: job.id, type: "image" }),
      shouldStop: () => control.cancelled
    }), job.id);
    if (result.needLogin) {
      const loggedInAgain = await ensureLogin(profile, exe, job.id);
      if (!loggedInAgain) return { ok: false, error: "豆包账号尚未登录" };
      result = await withNativeDoubao(() => submitImageJob({
        exe,
        job,
        accountIdentity: job.accountIdentity,
        folder,
        progress: message => progress(message, job.id),
        log: message => automationLog(message, { profileId: profile.id, jobId: job.id, type: "image" }),
        shouldStop: () => control.cancelled
      }), job.id);
    }
    if (!result.ok) return { ok: false, error: "豆包账号尚未登录" };
    if (control.cancelled) {
      try { result.client?.close(); } catch {}
      return stoppedResult(job.id);
    }
    automationLog("图片任务已由豆包页面确认接收", { jobId: job.id, profileId: profile.id });
    beginImageResultMonitor({ client: result.client, baseline: result.baseline, folder, job, control });
    return { ok: true, submitted: true, type: "image", jobId: job.id, profileId: profile.id, taskFolder: folder };
  } catch (error) {
    automationLog("图片任务失败", { jobId: job.id, profileId: profile.id, error: error.message, stack: error.stack });
    if (error.code === "DOUBAO_QUOTA_EXHAUSTED") {
      markProfileQuotaExhausted(profile.id, "image", error.message);
      return { ok: false, quotaExhausted: true, capability: "image", error: `${profile.name}：${error.message}`, taskFolder: folder, profiles: profiles() };
    }
    return { ok: false, error: error.message, code: error.code, taskFolder: folder };
  } finally {
    activeSubmissions.delete(job.id);
  }
}

function requiresPaidConsent(profile) { return profile?.paidQuotaGate?.date === localDayKey(); }

function paidBlockedResult(job, reason) {
  const error = reason || "本账号需要付费，本次排队任务已停止、未提交；节点可换账号后重新生成";
  emitJobState(job, "paid_blocked", error);
  return { ok: false, paidBlocked: true, error };
}

function blockUnconsentedPaidQueue(profileId) {
  for (let index = submissionQueue.length - 1; index >= 0; index--) {
    const entry = submissionQueue[index];
    if (entry.job.profileId !== profileId || entry.job.paidQuotaConsent) continue;
    submissionQueue.splice(index, 1);
    entry.resolve(paidBlockedResult(entry.job));
  }
}

function enqueueSubmission(job) {
  if (!/^(?:DB|IMG)-[A-Za-z0-9-]{1,80}$/.test(String(job?.id || ""))) return Promise.resolve({ ok: false, error: "任务编号无效" });
  if (!doubaoExe()) return Promise.resolve({ ok: false, needPath: true, error: "尚未选择豆包客户端" });
  if (taskControls.has(job.id)) return Promise.resolve({ ok: false, error: "任务编号已使用，拒绝重复提交" });
  const control = taskControl(job.id);
  job = { ...job, images: Array.isArray(job.images) ? job.images.slice() : [] };
  control.job = job;
  const profile = profiles().find(item => item.id === (job.profileId || "default"));
  if (!profile) return Promise.resolve({ ok: false, error: "选择的账号已不存在，请重新选择；任务未提交" });
  job.profileId = profile.id;
  job.accountIdentity = profileIdentity(profile);
  job.profileName = profile.name;
  if (requiresPaidConsent(profile) && !job.paidQuotaConsent) return Promise.resolve(paidBlockedResult(job));
  const owner=activeBatchProfile();
  if (owner && owner!==job.profileId) {
    progress(`“${profile.name}”等待前一账号本批任务回填或明确结束后再切号`, job.id);
    emitJobState(job, "queued_account", '等待前一账号本批任务回填或明确结束后再切号；本任务尚未提交');
  } else {
    emitJobState(job, "queued", "任务已进入提交队列，将按同一豆包窗口依次提交");
  }
  startQueuedSubmission(job, control);
  return Promise.resolve({ ok: true, queued: true, message: "任务已进入提交队列，将按同一豆包窗口依次提交" });
}

function startQueuedSubmission(job, control) {
  return new Promise((resolve, reject) => {
    submissionQueue.push({ job, control, resolve, reject, queuedAt: Date.now() });
    pumpSubmissionQueue();
  }).then(result => {
    if (result?.ok === false && !result?.stopped && !result?.paidBlocked && !result?.quotaExhausted && control.state !== "failed" && control.state !== "quota_exhausted" && control.state !== "paid_blocked" && control.state !== "stopped") {
      emitJobFailure(job, result.error || "提交失败", { retryable: true });
    }
    return result;
  }).catch(error => {
    emitJobFailure(job, error.message || String(error), { retryable: true });
    return { ok: false, error: error.message || String(error) };
  });
}

function isGoogleAuthHost(hostname) {
  return /(^|\.)google\.com$/i.test(hostname)
    || /(^|\.)googleapis\.com$/i.test(hostname)
    || /(^|\.)gstatic\.com$/i.test(hostname)
    || /(^|\.)googleusercontent\.com$/i.test(hostname);
}

function isAllowedBrowserUrl(url, partition = '') {
  const value = String(url || '').trim();
  if (!value || value === 'about:blank') return true;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'file:') return true;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'doubao.com' || hostname.endsWith('.doubao.com') || hostname === 'dola.com' || hostname.endsWith('.dola.com')) return true;
    return /^persist:jx-dola-/i.test(partition) && isGoogleAuthHost(hostname);
  } catch {
    return false;
  }
}

function presentBrowserWindow(target, options = {}) {
  if (!target || target.isDestroyed()) return target;
  target.__jxAllowShow = true;
  try { target.setSkipTaskbar(false); } catch {}
  try { if (target.isMinimized()) target.restore(); } catch {}
  if (options.maximize) {
    try { target.maximize(); } catch {}
  } else {
    try {
      const { screen } = require('electron');
      const area = screen.getPrimaryDisplay().workArea;
      const width = Math.min(1320, Math.max(920, area.width - 80));
      const height = Math.min(840, Math.max(620, area.height - 80));
      if (target.isMaximized()) target.unmaximize();
      target.setSize(width, height);
      target.center();
    } catch {}
  }
  target.show();
  target.moveTop();
  target.focus();
  return target;
}

function eachBrowserHostWindow(fn) {
  const seen = new Set();
  const list = [];
  if (browserWin && !browserWin.isDestroyed()) list.push(browserWin);
  for (const worker of liveBrowserWorkers()) {
    if (worker.win && !worker.win.isDestroyed()) list.push(worker.win);
  }
  for (const target of list) {
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    try { fn(target); } catch {}
  }
}

function raiseOperatingBrowserWindow(target) {
  if (!target || target.isDestroyed()) return false;
  try { target.setAlwaysOnTop(false); } catch {}
  return true;
}

function unpinBrowserWindow(target) {
  if (!target || target.isDestroyed()) return;
  try { target.setAlwaysOnTop(false); } catch {}
}

function hostWindowFromIpc(event, input) {
  const fromSender = event?.sender ? BrowserWindow.fromWebContents(event.sender) : null;
  if (fromSender && !fromSender.isDestroyed()) return fromSender;
  const guest = Number(input?.webContentsId) ? webContents.fromId(Number(input.webContentsId)) : null;
  return hostWindowForGuest(guest);
}

function importPendingDolaAccountFile() {
  const file = path.join(dataRoot, '待导入Dola账号.txt');
  if (!fs.existsSync(file)) return;
  try {
    const rows = browserAccountService.parseDolaCredentialLines(fs.readFileSync(file, 'utf8'));
    if (!rows.length) return;
    const imported = browserAccountService.importMany(dataRoot, rows);
    const archived = path.join(dataRoot, `待导入Dola账号-已导入-${Date.now()}.txt`);
    fs.renameSync(file, archived);
    try { fs.unlinkSync(archived); } catch {}
    automationLog('已导入待写入的 Dola 谷歌账号', { count: imported.length, names: imported.map(account => account.name) });
  } catch (error) {
    automationLog('导入待写入 Dola 账号失败', { error: error.message });
  }
}

function secureWebviews(targetWindow) {
  targetWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const partition = params.partition || webPreferences.partition || '';
    const allowed = isAllowedBrowserUrl(params.src, partition);
    if (!allowed || !/^persist:jx-(doubao|dola)-[a-z0-9-]+$/i.test(partition)) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });
  targetWindow.webContents.on('did-attach-webview', (_event, guestContents) => {
    platformHelper.attach(guestContents).catch(error => {
      automationLog('内置浏览器接口助手附加失败', { error: error.message });
    });
    guardManualVideoDownloads(guestContents);
    guardGuestWindowOpen(guestContents);
  });
}

function looksLikeVideoDownload(item, url) {
  const name = String(item?.getFilename?.() || '');
  const mime = String(item?.getMimeType?.() || '');
  const href = String(url || '');
  if (/^image\//i.test(mime) || /\.(png|jpe?g|webp|gif|svg)($|\?)/i.test(name)) return false;
  if (/^blob:/i.test(href)) return !/^image\//i.test(mime);
  return /\.mp4/i.test(name) || /^video\//i.test(mime) || /\/video\/|\.mp4($|\?)|tos-mya|byteintlapi|unwatermarked|watermarked|fplay/i.test(href);
}

function defaultVideoSaveName(jobId) {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const id = String(jobId || '').replace(/[^\w-]+/g, '').slice(0, 24);
  return `${id || 'dola-video'}-${stamp}.mp4`;
}

async function chooseVideoSavePath({ parent, defaultName }) {
  let target = parent && !parent.isDestroyed() ? parent : (win && !win.isDestroyed() ? win : null);
  if (target && !target.isDestroyed()) {
    try { if (target.isMinimized()) target.restore(); } catch {}
    try { if (!target.isVisible()) target.showInactive(); } catch { try { target.show(); } catch {} }
  }
  const suggested = path.join(app.getPath('downloads'), String(defaultName || defaultVideoSaveName()).replace(/[<>:"/\\|?*]/g, '_'));
  const result = await dialog.showSaveDialog(target && !target.isDestroyed() ? target : undefined, {
    title: '保存无水印视频',
    defaultPath: suggested,
    buttonLabel: '保存',
    filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
  });
  if (result.canceled || !result.filePath) return '';
  const dest = result.filePath.toLowerCase().endsWith('.mp4') ? result.filePath : `${result.filePath}.mp4`;
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch {}
  return dest;
}

function refererForVideoUrl(url) {
  if (typeof platformHelper.refererForFallback === 'function') return platformHelper.refererForFallback(url);
  return /dola\.com|byteintlapi|\/mya\//i.test(String(url || '')) ? 'https://www.dola.com/' : 'https://www.doubao.com/';
}

function rewriteUnwatermarkUrl(url) {
  return String(url || '').replace(/([?&]lr=)(?:cici_ai|watermarked)\b/ig, '$1unwatermarked').replace(/([?&]logo_type=)watermarked\b/ig, '$1unwatermarked');
}

function looksLikeMp4Buffer(buffer) {
  if (!buffer || buffer.length < 12) return false;
  const box = buffer.slice(4, 8).toString("ascii");
  if (box === "ftyp" || box === "moov" || box === "mdat") return true;
  const head = buffer.slice(0, 16).toString("utf8");
  if (/^\s*[<{]/.test(head) || /^(error|fail|denied)/i.test(head)) return false;
  return false;
}

async function downloadViaNetRequest(ses, downloadUrl, headers) {
  return await new Promise((resolve, reject) => {
    const request = net.request({
      method: "GET",
      url: downloadUrl,
      session: ses || undefined,
      useSessionCookies: true,
      redirect: "follow"
    });
    for (const [name, value] of Object.entries(headers || {})) {
      try { request.setHeader(name, value); } catch {}
    }
    const chunks = [];
    request.on("response", response => {
      const status = Number(response.statusCode);
      if (status >= 400) {
        reject(new Error(`视频下载失败（${status}）`));
        try { request.abort(); } catch {}
        return;
      }
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

async function downloadViaNodeHttps(ses, downloadUrl, headers) {
  let cookie = String(headers.Cookie || "");
  if (!cookie && ses && typeof ses.cookies?.get === "function") {
    try {
      const list = await ses.cookies.get({ url: downloadUrl });
      cookie = (list || []).map(item => `${item.name}=${item.value}`).join("; ");
    } catch {}
  }
  const parsed = new URL(downloadUrl);
  const lib = parsed.protocol === "http:" ? require("http") : require("https");
  return await new Promise((resolve, reject) => {
    const request = lib.get({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        ...headers,
        ...(cookie ? { Cookie: cookie } : {})
      }
    }, response => {
      const status = Number(response.statusCode);
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        downloadViaNodeHttps(ses, new URL(response.headers.location, downloadUrl).href, headers).then(resolve, reject);
        return;
      }
      if (status >= 400) {
        reject(new Error(`视频下载失败（${status}）`));
        response.resume();
        return;
      }
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.on("error", reject);
  });
}

async function downloadHttpVideoToFile(ses, downloadUrl, dest) {
  const href = String(downloadUrl || '');
  if (!href || /^blob:/i.test(href)) throw new Error('当前还是预览地址，没有拿到可保存的视频链接');
  const referer = refererForVideoUrl(href);
  const headers = {
    Referer: referer,
    Origin: referer.replace(/\/$/, ''),
    Accept: '*/*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
  };
  let buffer = null;
  let lastError = null;
  try {
    buffer = await downloadViaNetRequest(ses, href, headers);
  } catch (error) {
    lastError = error;
  }
  if (!buffer) {
    try {
      buffer = await downloadViaNodeHttps(ses, href, headers);
    } catch (error) {
      lastError = error;
    }
  }
  if (!buffer || buffer.length < 1000) throw lastError || new Error('视频下载内容为空');
  if (!looksLikeMp4Buffer(buffer)) throw new Error('下载到的不是可播放视频，已停止写入以免保存坏文件');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buffer);
  try {
    await ensureH264Mp4(dest, message => automationLog(message, { file: path.basename(dest) }));
  } catch (error) {
    automationLog('保存后转 H.264 未完成，仍保留原文件', { error: error.message, file: dest });
  }
  return { ok: true, file: dest, url: pathToFileURL(dest).href, folder: path.dirname(dest), size: fs.statSync(dest).size };
}

function savedVideoKeys(owner) {
  if (!owner) return new Set();
  if (!(owner.__jxSavedVideoKeys instanceof Set)) owner.__jxSavedVideoKeys = new Set();
  return owner.__jxSavedVideoKeys;
}

function rememberSavedVideo(owner, resolved) {
  const keys = savedVideoKeys(owner);
  const videoId = String(resolved?.videoId || '');
  const url = String(resolved?.url || '');
  const fallbackApi = String(resolved?.fallbackApi || '');
  if (videoId) keys.add(videoId);
  if (url) keys.add(url);
  if (fallbackApi) keys.add(fallbackApi);
}

async function resolveSaveVideoUrl(owner, fallbackUrl, extra = {}) {
  let resolved = null;
  try {
    if (typeof platformHelper.resolveCleanUrlForDownload === 'function') {
      resolved = await platformHelper.resolveCleanUrlForDownload(owner, fallbackUrl, {
        usedKeys: savedVideoKeys(owner),
        filename: extra.filename || ''
      });
    } else if (typeof platformHelper.resolvePeekedCleanUrl === 'function') {
      resolved = await platformHelper.resolvePeekedCleanUrl(owner);
    } else {
      resolved = platformHelper.peekCleanVideoUrl(owner && owner.id);
    }
  } catch {}
  let clean = String(resolved?.url || '');
  if (clean && typeof platformHelper.isPlayerPreviewUrl === 'function' && platformHelper.isPlayerPreviewUrl(clean)) clean = '';
  const interceptedId = typeof platformHelper.videoIdentity === 'function' ? platformHelper.videoIdentity(fallbackUrl) || platformHelper.videoIdentity(extra.filename || '') : '';
  const cleanId = String(resolved?.videoId || (typeof platformHelper.videoIdentity === 'function' ? platformHelper.videoIdentity(clean) : '') || '');
  if (clean && interceptedId && cleanId && interceptedId !== cleanId) clean = '';
  let downloadUrl = clean || rewriteUnwatermarkUrl(fallbackUrl);
  if (typeof platformHelper.isWatermarkedMediaUrl === 'function' && platformHelper.isWatermarkedMediaUrl(downloadUrl)) {
    const rewritten = rewriteUnwatermarkUrl(downloadUrl);
    if (rewritten !== downloadUrl) downloadUrl = rewritten;
  }
  if (!downloadUrl || /^blob:/i.test(downloadUrl) || (typeof platformHelper.isPlayerPreviewUrl === 'function' && platformHelper.isPlayerPreviewUrl(downloadUrl))) {
    throw new Error('还没有拿到当前这条的无水印原片地址');
  }
  return {
    url: downloadUrl,
    videoId: String(resolved?.videoId || cleanId || interceptedId || ''),
    fallbackApi: String(resolved?.fallbackApi || '')
  };
}

function guardManualVideoDownloads(guestContents) {
  const ses = guestContents && guestContents.session;
  if (!ses || ses.__jxCleanDownloadGuard) return;
  ses.__jxCleanDownloadGuard = true;
  ses.on('will-download', (event, item, owner) => {
    const url = String(item.getURL() || '');
    const dest = owner && (owner.__jxProgrammaticSavePath || owner.__jxCleanSavePath);
    if (dest && owner) {
      owner.__jxProgrammaticSavePath = '';
      owner.__jxCleanSavePath = '';
      try { item.setSavePath(dest); } catch {}
      return;
    }
    if (!owner || owner.isDestroyed() || !looksLikeVideoDownload(item, url)) return;
    if (owner.__jxPickingSavePath) {
      event.preventDefault();
      try { item.cancel(); } catch {}
      return;
    }
    let filename = 'video.mp4';
    try { filename = item.getFilename() || filename; } catch {}
    event.preventDefault();
    try { item.cancel(); } catch {}
    owner.__jxPickingSavePath = true;
    const parent = hostWindowForGuest(owner);
    (async () => {
      const resolved = await resolveSaveVideoUrl(owner, url, { filename });
      const defaultName = resolved.videoId ? `${resolved.videoId}.mp4` : filename;
      const saveTo = await chooseVideoSavePath({ parent, defaultName });
      if (!saveTo || owner.isDestroyed()) return;
      await downloadHttpVideoToFile(owner.session || ses, resolved.url, saveTo);
      rememberSavedVideo(owner, resolved);
      automationLog('已保存无水印视频', { file: saveTo, videoId: resolved.videoId || '' });
    })().catch(error => {
      automationLog('手动保存视频失败', { error: error.message, ownerId: owner && owner.id });
      try { dialog.showErrorBox('保存视频失败', error.message || '未能保存当前视频'); } catch {}
    }).finally(() => {
      if (owner && !owner.isDestroyed()) owner.__jxPickingSavePath = false;
    });
  });
}

function createBrowserAccountsWindow(options = {}) {
  const query = {};
  if (options.accountId) query.accountId = String(options.accountId);
  if (options.fill) query.fill = '1';
  if (options.add) query.add = '1';
  const loadBrowserPage = target => target.loadFile(path.join(__dirname, 'app', 'browser-window.html'), Object.keys(query).length ? { query } : undefined);
  if (browserWin && !browserWin.isDestroyed()) {
    presentBrowserWindow(browserWin);
    if (options.add) {
      eachBrowserHostWindow(host => {
        try { host.webContents.send('browser-prompt-add-account'); } catch {}
      });
    }
    return browserWin;
  }
  browserWin = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 920,
    minHeight: 620,
    title: '家兴多账号浏览器 · 豆包 / Dola',
    icon: canvasIcon(),
    backgroundColor: '#f3f7fb',
    autoHideMenuBar: true,
    show: true,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      backgroundThrottling: false
    }
  });
  secureWebviews(browserWin);
  lockNativeWindowTitle(browserWin, '家兴多账号浏览器');
  loadBrowserPage(browserWin);
  browserWin.webContents.once('did-fail-load', (_event, code, description) => {
    automationLog('内置浏览器窗口加载失败', { code, description });
  });
  presentBrowserWindow(browserWin);
  browserWin.on('closed', () => { browserWin = null; });
  return browserWin;
}

function liveBrowserWorkers() {
  return browserTaskWorkers.filter(worker => worker.win && !worker.win.isDestroyed());
}

function lockNativeWindowTitle(win, title) {
  if (!win || win.isDestroyed()) return;
  if (!win.__jxTitleLocked) {
    win.__jxTitleLocked = true;
    win.on('page-title-updated', event => event.preventDefault());
  }
  try { win.setTitle(String(title || '').trim() || '家兴监控浏览器'); } catch {}
}

function genericAccountLabel(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return !text || /^(账号|Dola账号|豆包账号|Dola|豆包|User|Guest)$/i.test(text);
}

function accountWindowTitle(account, pageUserName) {
  const brand = account?.provider === 'dola' ? 'Dola' : '豆包';
  const stripBrand = value => String(value || '').replace(/\s+/g, ' ').trim()
    .replace(/^(Dola|豆包)[·\s]+/i, '').trim();
  let user = stripBrand(pageUserName || account?.pageUserName || '');
  if (genericAccountLabel(user)) {
    const named = stripBrand(account?.name || '').replace(/账号$/u, '').trim();
    user = genericAccountLabel(named) ? '' : named;
  }
  return (user ? `${brand} ${user}` : brand).slice(0, 48);
}

function findWorkerByAccount(accountId) {
  return liveBrowserWorkers().find(worker => worker.accountId === accountId) || null;
}

function hostWindowForGuest(guest) {
  if (!guest || guest.isDestroyed()) return null;
  const host = guest.hostWebContents;
  if (!host || host.isDestroyed()) return null;
  return BrowserWindow.fromWebContents(host);
}

function adoptWorkerForWindow(win, accountId) {
  if (!win || win.isDestroyed()) return null;
  let worker = liveBrowserWorkers().find(item => item.win === win);
  if (!worker) {
    worker = { id: win === browserWin ? 'visible-browser' : `adopted-${accountId}`, accountId, taskId: '', busy: false, ready: true, win };
    browserTaskWorkers.unshift(worker);
  } else {
    worker.ready = true;
    if (!worker.busy) worker.accountId = accountId;
  }
  return worker;
}

function pruneDeadBrowserWorkers() {
  for (const worker of [...browserTaskWorkers]) {
    if (worker.win && !worker.win.isDestroyed()) continue;
    const index = browserTaskWorkers.indexOf(worker);
    if (index >= 0) browserTaskWorkers.splice(index, 1);
  }
}

function guardGuestWindowOpen(guestContents) {
  if (!guestContents || guestContents.isDestroyed() || guestContents.__jxPopupGuard) return;
  guestContents.__jxPopupGuard = true;
  try {
    guestContents.setWindowOpenHandler(({ url }) => {
      const href = String(url || '');
      if (/accounts\.google\.|google\.com\/(?:o\/)?oauth|accounts\.youtube\.|ggpht\.com/i.test(href)) {
        return { action: 'allow' };
      }
      try {
        if (href && href !== 'about:blank') guestContents.loadURL(href);
      } catch {}
      return { action: 'deny' };
    });
  } catch {}
}

function showAccountBrowserWindow(target) {
  if (!target || target.isDestroyed()) return false;
  target.__jxAllowShow = true;
  try {
    if (target.isVisible() && !target.isMinimized()) return true;
    if (target.isMinimized()) target.restore();
    try { target.setSkipTaskbar(false); } catch {}
    target.showInactive();
  } catch {
    try { if (!target.isVisible()) target.show(); } catch {}
  }
  return true;
}

function findExistingWorkerForAccount(account) {
  if (!account) return null;
  const existing = findWorkerByAccount(account.id);
  if (existing && existing.win && !existing.win.isDestroyed() && existing.win !== win) {
    existing.ready = true;
    return existing;
  }
  const guest = findWebviewForAccount(account);
  const owned = hostWindowForGuest(guest);
  if (!owned || owned === win) return null;
  const ownerWorker = liveBrowserWorkers().find(item => item.win === owned);
  if (ownerWorker && ownerWorker.accountId && ownerWorker.accountId !== account.id) return null;
  return adoptWorkerForWindow(owned, account.id);
}

function refreshWorkerTitles() {
  const accounts = browserAccountService.list(dataRoot);
  for (const worker of liveBrowserWorkers()) {
    const account = accounts.find(item => item.id === worker.accountId);
    if (!account) continue;
    lockNativeWindowTitle(worker.win, accountWindowTitle(account, worker.pageUserName));
  }
}

function countBrowserVideoUsage(accountId, jobId) {
  const id = String(jobId || '');
  if (!accountId || !id || countedUsageJobs.has(id)) return;
  countedUsageJobs.add(id);
  browserAccountService.incrementVideoUsage(dataRoot, accountId);
  refreshWorkerTitles();
}

function createBrowserTaskWorker(accountId, options = {}) {
  const accounts = browserAccountService.list(dataRoot);
  const account = accounts.find(item => item.id === accountId) || null;
  const index = liveBrowserWorkers().length;
  const worker = { id: crypto.randomUUID(), accountId, taskId: '', busy: false, ready: false, win: null, inbox: [], pageUserName: account?.pageUserName || '' };
  const visible = options.visible === true;
  const target = new BrowserWindow({
    width: 1180, height: 760, minWidth: 900, minHeight: 600,
    x: 40 + (index % 6) * 32, y: 28 + (index % 6) * 28,
    title: accountWindowTitle(account),
    icon: canvasIcon(),
    backgroundColor: '#f3f7fb', autoHideMenuBar: true, show: false,
    skipTaskbar: !visible,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, webviewTag: true, backgroundThrottling: false }
  });
  worker.win = target;
  worker.openedAt = Date.now();
  secureWebviews(target);
  lockNativeWindowTitle(target, accountWindowTitle(account));
  const reveal = () => {
    if (!visible || target.isDestroyed()) return;
    target.__jxAllowShow = true;
    try { target.setSkipTaskbar(false); } catch {}
    showAccountBrowserWindow(target);
  };
  target.once('ready-to-show', reveal);
  if (visible) setTimeout(reveal, 1800);
  else {
    target.on('show', () => {
      if (target.__jxAllowShow || target.isDestroyed()) return;
      try { target.hide(); } catch {}
    });
    target.once('ready-to-show', () => { try { if (!target.isDestroyed() && !target.__jxAllowShow) target.hide(); } catch {} });
  }
  target.webContents.on('render-process-gone', (_event, details) => {
    if (details?.reason === 'clean-exit' || !worker.accountId) return;
    automationLog('账号浏览器渲染中断，正在重载', { accountId: worker.accountId, reason: details?.reason });
    setTimeout(() => { try { if (target && !target.isDestroyed()) target.reload(); } catch {} }, 400);
  });
  target.loadFile(path.join(__dirname, 'app', 'browser-window.html'), { query: { worker: '1', accountId: String(accountId || '') } });
  target.webContents.once('did-finish-load', () => {
    worker.ready = true;
    if (worker.pendingTask && worker.win && !worker.win.isDestroyed()) {
      deliverBrowserCanvasTask(worker, worker.pendingTask);
      worker.pendingTask = null;
    }
    pumpBrowserTaskQueue();
  });
  target.on('closed', () => {
    unpinBrowserWindow(target);
    const index = browserTaskWorkers.indexOf(worker); if (index >= 0) browserTaskWorkers.splice(index, 1);
    if (worker.taskId) {
      emitJobFailure({ id: worker.taskId, nodeId: '', type: 'video' }, '账号浏览器窗口已关闭，任务未执行', { retryable: true });
      browserTaskOwners.delete(worker.taskId);
    }
    worker.busy = false;
    pumpBrowserTaskQueue();
  });
  browserTaskWorkers.push(worker);
  return worker;
}

function ensureAccountMonitorWindows(options = {}) {
  pruneDeadBrowserWorkers();
  const accounts = browserAccountService.list(dataRoot).filter(account => account.enabled !== false);
  const ids = new Set(accounts.map(account => account.id));
  const createMissing = options.create === true;
  const shouldShow = options.show === true;
  const shouldRepair = options.repair === true;
  const visible = options.visible === true;
  for (const worker of [...browserTaskWorkers]) {
    if (worker.win === win) {
      const index = browserTaskWorkers.indexOf(worker);
      if (index >= 0) browserTaskWorkers.splice(index, 1);
      continue;
    }
    if (worker.accountId && !ids.has(worker.accountId) && !worker.busy && worker.win && !worker.win.isDestroyed()) {
      try { worker.win.close(); } catch {}
    }
  }
  for (const account of accounts) {
    let existing = findExistingWorkerForAccount(account);
    if (existing && existing.win && !existing.win.isDestroyed() && existing.win !== win) {
      const guest = findWebviewForAccount(account);
      const stale = existing.ready && Date.now() - Number(existing.openedAt || 0) > 5000 && !guest;
      if (stale && shouldRepair) {
        try { existing.win.close(); } catch {}
        existing = null;
      }
    } else {
      existing = null;
    }
    if (existing && existing.win && !existing.win.isDestroyed()) {
      try { lockNativeWindowTitle(existing.win, accountWindowTitle(account, existing.pageUserName)); } catch {}
      if (shouldShow) showAccountBrowserWindow(existing.win);
    } else if (createMissing) {
      createBrowserTaskWorker(account.id, { visible });
    }
  }
  return { ok: true, workers: liveBrowserWorkers().length, accounts: accounts.length };
}

function availableBrowserAccounts(providerHint = '', allowExhausted = false) {
  const listed = browserAccountService.list(dataRoot).filter(account => account.enabled !== false);
  const enabled = allowExhausted ? listed : listed.filter(account => account.quotaStatus !== 'exhausted');
  const poolBase = enabled.length ? enabled : listed;
  const lockedProvider = ['doubao', 'dola'].includes(providerHint) ? providerHint : (browserPreferredProvider || '');
  const selected = browserPreferredAccountIds.length ? poolBase.filter(account => browserPreferredAccountIds.includes(account.id)) : [];
  const selectedSame = lockedProvider ? selected.filter(account => account.provider === lockedProvider) : selected;
  const pool = selectedSame.length ? selectedSame : (lockedProvider ? poolBase.filter(account => account.provider === lockedProvider) : poolBase);
  return (pool.length ? pool : poolBase).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function ensureVisibleBrowserWorker(accountId) {
  if (!browserWin || browserWin.isDestroyed()) return null;
  let worker = browserTaskWorkers.find(item => item.win === browserWin);
  if (!worker) {
    worker = { id: 'visible-browser', accountId, taskId: '', busy: false, ready: true, win: browserWin, inbox: [] };
    browserTaskWorkers.unshift(worker);
  } else {
    worker.ready = true;
    if (!worker.busy) worker.accountId = accountId;
  }
  return worker;
}

function scheduleBrowserPump(delayMs) {
  const wait = Math.max(800, Number(delayMs) || 800);
  clearTimeout(browserPaceTimer);
  browserPaceTimer = setTimeout(() => pumpBrowserTaskQueue(), wait);
}

function deliverBrowserCanvasTask(worker, task) {
  if (!worker || !task) return;
  worker.inbox = Array.isArray(worker.inbox) ? worker.inbox : [];
  if (!worker.inbox.some(item => item && item.id === task.id)) worker.inbox.push(task);
  worker.lastTask = task;
  worker.originTask = { id: task.id, jobId: task.id, nodeId: task.nodeId, title: task.title || task.nodeTitle || '视频生成', nodeTitle: task.title || task.nodeTitle || '视频生成', accountId: task.browserAccountId || task.accountId || worker.accountId || '', provider: task.provider || '' };
  rememberBrowserJobOrigin(worker.originTask, { accountId: worker.originTask.accountId, provider: worker.originTask.provider });
  worker.taskSentAt = Date.now();
  worker.acked = false;
  if (worker.win && !worker.win.isDestroyed()) {
    try { worker.win.webContents.send('browser-canvas-task', task); } catch {}
  }
}

function accountCooldownLeft(accountId) {
  const last = Number(accountLastSubmitAt.get(String(accountId || '')) || 0);
  return Math.max(0, last + DOLA_ACCOUNT_COOLDOWN_MS - Date.now());
}

function globalDolaStaggerLeft() {
  return Math.max(0, lastDolaSubmitAt + DOLA_GLOBAL_STAGGER_MS - Date.now());
}

function accountOverDailyCap(account) {
  return Number(account?.todayVideoCount || 0) >= DOLA_DAILY_SOFT_CAP;
}

function markDolaSubmit(accountId) {
  const now = Date.now();
  lastDolaSubmitAt = now;
  if (accountId) accountLastSubmitAt.set(String(accountId), now);
}

function mediaKeyList(...values) {
  return [...new Set(values.flat().map(value => String(value || '').trim()).filter(value => value && !/^blob:/i.test(value)))];
}

function snapshotBrowserJobBaseline(account) {
  const source = findWebviewForAccount(account);
  if (!source) return { keys: [], capturedAt: Date.now() };
  const peeked = platformHelper.peekCleanVideoUrl(source.id);
  const known = typeof platformHelper.knownVideoKeys === 'function' ? platformHelper.knownVideoKeys(source.id) : [];
  return {
    keys: mediaKeyList(known, peeked && peeked.url, peeked && peeked.fallbackApi),
    capturedAt: Date.now()
  };
}

async function enrichBrowserJobBaseline(job, account) {
  if (!job) return job;
  const source = findWebviewForAccount(account);
  const keys = new Set(job.baselineKeys || []);
  for (const key of snapshotBrowserJobBaseline(account).keys) keys.add(key);
  if (source) {
    const page = await platformHelper.inspectPageVideos(source).catch(() => null);
    if (page) {
      for (const src of page.videos || []) keys.add(src);
      for (const recipe of page.recipes || []) {
        if (recipe && recipe.fallbackApi) keys.add(recipe.fallbackApi);
      }
      if (page.cleanMedia) keys.add(page.cleanMedia);
      if (job.baselineDoneAt == null && Number.isFinite(Number(page.doneAt))) job.baselineDoneAt = Number(page.doneAt);
    }
  }
  job.baselineKeys = mediaKeyList([...keys]);
  return job;
}

function isStaleBrowserMedia(job, candidate) {
  const keys = new Set(job?.baselineKeys || []);
  if (!keys.size) return false;
  const url = String(candidate?.url || '');
  const fallback = String(candidate?.fallbackApi || '');
  if (url && keys.has(url)) return true;
  if (fallback && keys.has(fallback)) return true;
  return false;
}
function commitBrowserAssignment(worker, account, entry) {
  worker.busy = true;
  worker.taskId = String(entry.task.id || '');
  worker.accountId = account.id;
  browserTaskOwners.set(worker.taskId, worker);
  const baseline = snapshotBrowserJobBaseline(account);
  browserPendingJobs.set(worker.taskId, {
    jobId: worker.taskId,
    nodeId: entry.task.nodeId,
    accountId: account.id,
    provider: account.provider,
    assignedAt: Date.now(),
    harvesting: false,
    readyToHarvest: false,
    baselineKeys: baseline.keys,
    baselineDoneAt: null,
    nodeId: entry.task.nodeId,
    nodeTitle: String(entry.task.title || entry.task.nodeTitle || '视频生成')
  });
  rememberBrowserJobOrigin(entry.task, { accountId: account.id, provider: account.provider, nodeTitle: entry.task.title || entry.task.nodeTitle });
  enrichBrowserJobBaseline(browserPendingJobs.get(worker.taskId), account).catch(() => {});
  if (account.provider === 'dola') markDolaSubmit(account.id);
  deliverBrowserCanvasTask(worker, { ...entry.task, provider: account.provider, browserAccountId: account.id, browserWorkerId: worker.id });
  if (worker.win && !worker.win.isDestroyed()) presentBrowserWindow(worker.win, { maximize: true });
  const message = `已发给 ${account.name}，正在填写并发送`;
  if (typeof entry.resolve === 'function') entry.resolve({ ok: true, sent: true, workerId: worker.id, accountId: account.id, message });
  emitJobState({ id: entry.task.id, nodeId: entry.task.nodeId, type: 'video' }, 'submitting', message);
  return true;
}

function forceDeliverBrowserTask(entry) {
  const lockedProvider = ['doubao', 'dola'].includes(entry.task?.provider) ? entry.task.provider : (browserPreferredProvider || '');
  const requestedId = String(entry.task.browserAccountId || '');
  const accounts = availableBrowserAccounts(lockedProvider, true);
  const account = (requestedId && accounts.find(item => item.id === requestedId)) || accounts[0];
  if (!account) {
    emitJobFailure({ id: entry.task?.id, nodeId: entry.task?.nodeId, type: 'video' }, '没有可用的浏览器账号，任务无法发送', { retryable: true });
    return true;
  }
  let worker = findExistingWorkerForAccount(account);
  if (!worker || !worker.win || worker.win.isDestroyed()) {
    createBrowserTaskWorker(account.id, { visible: false });
    worker = findExistingWorkerForAccount(account);
  }
  if (!worker) return false;
  return commitBrowserAssignment(worker, account, entry);
}
function assignBrowserTask(entry) {
  const lockedProvider = ['doubao', 'dola'].includes(entry.task?.provider) ? entry.task.provider : (browserPreferredProvider || '');
  const requestedId = String(entry.task.browserAccountId || '');
  let accounts = availableBrowserAccounts(lockedProvider);
  if (requestedId && !accounts.some(item => item.id === requestedId)) {
    accounts = availableBrowserAccounts(lockedProvider, true);
  }
  if (!accounts.length) {
    if (typeof entry.resolve === 'function') entry.resolve({ ok: false, error: lockedProvider ? `没有可用的${lockedProvider === 'dola' ? ' Dola' : '豆包'}账号，任务无法发送` : '没有可用的浏览器账号，任务无法发送' });
    return true;
  }
  let account = null;
  let worker = null;
  if (requestedId) {
    account = accounts.find(item => item.id === requestedId) || null;
    if (!account) {
      if (typeof entry.resolve === 'function') entry.resolve({ ok: false, error: '指定的浏览器账号当前不可用' });
      return true;
    }
    worker = findExistingWorkerForAccount(account);
    if (!worker) {
      if (browserTaskWorkers.length < MAX_BROWSER_TASK_WORKERS) createBrowserTaskWorker(account.id, { visible: false });
      worker = findExistingWorkerForAccount(account);
    }
  } else {
    const ranked = [...accounts].sort((a, b) => Number(a.todayVideoCount || 0) - Number(b.todayVideoCount || 0));
    const idle = ranked.find(item => {
      const candidate = findExistingWorkerForAccount(item);
      return candidate && candidate.ready && !candidate.busy && candidate.win && !candidate.win.isDestroyed();
    });
    const any = ranked.find(item => {
      const candidate = findExistingWorkerForAccount(item);
      return candidate && candidate.win && !candidate.win.isDestroyed();
    });
    const chosen = idle || any || ranked[0];
    account = chosen;
    worker = chosen ? findExistingWorkerForAccount(chosen) : null;
    if (!worker && chosen && browserTaskWorkers.length < MAX_BROWSER_TASK_WORKERS) {
      createBrowserTaskWorker(chosen.id, { visible: false });
      worker = findExistingWorkerForAccount(chosen);
    }
  }
  if (!account) return forceDeliverBrowserTask(entry);
  if (!worker || !worker.win || worker.win.isDestroyed()) return forceDeliverBrowserTask(entry);
  return commitBrowserAssignment(worker, account, entry);
}

function pumpBrowserTaskQueue() {
  const now = Date.now();
  for (const worker of liveBrowserWorkers()) {
    if (worker.busy && worker.lastTask && !worker.acked && worker.ready && worker.win && !worker.win.isDestroyed() && now - Number(worker.taskSentAt || 0) > 8000) {
      worker.resendCount = Number(worker.resendCount || 0) + 1;
      deliverBrowserCanvasTask(worker, worker.lastTask);
      if (worker.resendCount === 3) {
        emitJobState({ id: worker.lastTask.id, nodeId: worker.lastTask.nodeId, type: 'video' }, 'queued', `${worker.accountId ? '账号窗口还在启动或忙碌，任务仍在投递' : '正在等待账号窗口接收任务'}`);
      }
    }
  }
  for (let index = 0; index < browserTaskQueue.length;) {
    const entry = browserTaskQueue[index];
    if (entry?.queuedAt && now - entry.queuedAt > 180000) {
      browserTaskQueue.splice(index, 1);
      emitJobFailure({ id: entry.task?.id, nodeId: entry.task?.nodeId, type: 'video' }, '排队超过 3 分钟仍未轮到执行，请检查账号窗口是否卡住后重试', { retryable: true });
      continue;
    }
    if (assignBrowserTask(browserTaskQueue[index])) browserTaskQueue.splice(index, 1); else index++;
  }
}

function releaseBrowserTask(jobId) {
  const id = String(jobId || '');
  const worker = browserTaskOwners.get(id);
  if (worker) {
    browserTaskOwners.delete(id);
    if (worker.taskId === id) { worker.taskId = ''; worker.busy = false; }
  }
  pumpBrowserTaskQueue();
}

function finishBrowserPendingJob(jobId) {
  browserPendingJobs.delete(String(jobId || ''));
  releaseBrowserTask(jobId);
}

function findWebviewForAccount(account) {
  if (!account?.partition) return null;
  const accountSession = session.fromPartition(account.partition);
  return webContents.getAllWebContents().find(contents => !contents.isDestroyed() && contents.session === accountSession && contents.getType() === 'webview') || null;
}

async function downloadBrowserVideoFile({ account, jobId, url, source, promptSave }) {
  const downloadUrl = String(url || '');
  if (!downloadUrl || (typeof platformHelper.isPlayerPreviewUrl === 'function' && platformHelper.isPlayerPreviewUrl(downloadUrl))) {
    throw new Error('拒绝保存带水印预览片，正在等待无水印原片地址');
  }
  let file = '';
  if (promptSave) {
    file = await chooseVideoSavePath({
      parent: hostWindowForGuest(source),
      defaultName: defaultVideoSaveName(jobId)
    });
    if (!file) throw new Error('已取消保存');
  } else {
    const folder = path.join(dataRoot, '无水印素材');
    fs.mkdirSync(folder, { recursive: true });
    file = path.join(folder, `${jobId}-${Date.now()}.mp4`);
  }
  const ses = (source && !source.isDestroyed() && source.session) || session.fromPartition(account.partition);
  try {
    return await downloadHttpVideoToFile(ses, downloadUrl, file);
  } catch (error) {
    if (!source || source.isDestroyed()) throw error;
    const folder = path.dirname(file);
    return await new Promise((resolve, reject) => {
      let item = null;
      const timer = setTimeout(() => { cleanup(); try { item?.cancel(); } catch {} reject(new Error('视频下载超时')); }, 10 * 60 * 1000);
      const cleanup = () => {
        clearTimeout(timer);
        ses.removeListener('will-download', started);
        if (source && !source.isDestroyed()) {
          if (source.__jxProgrammaticSavePath === file) source.__jxProgrammaticSavePath = '';
          if (source.__jxCleanSavePath === file) source.__jxCleanSavePath = '';
        }
      };
      const started = (event, download, owner) => {
        if (owner?.id !== source.id) return;
        item = download;
        try { download.setSavePath(file); } catch {}
        download.once('done', (_doneEvent, state) => {
          cleanup();
          if (state !== 'completed' || !fs.existsSync(file)) return reject(new Error(`视频下载没有完成：${state}`));
          resolve({ ok: true, file, url: pathToFileURL(file).href, folder });
        });
      };
      ses.on('will-download', started);
      try {
        source.__jxProgrammaticSavePath = file;
        source.__jxCleanSavePath = file;
        source.downloadURL(downloadUrl);
      } catch (startError) { cleanup(); reject(startError); }
    });
  }
}

function canvasOriginLabel(task) {
  const title = String(task?.nodeTitle || task?.title || '视频生成').replace(/\s+/g, ' ').trim() || '视频生成';
  return `画布节点「${title}」`;
}

async function readCanvasBackfillJobs() {
  if (!win || win.isDestroyed()) return [];
  try {
    const list = await win.webContents.executeJavaScript(`(() => {
      const state = window.jxCanvas && window.jxCanvas.state;
      if (!state) return [];
      const nodes = Array.isArray(state.nodes) ? state.nodes : [];
      const jobs = Array.isArray(state.jobs) ? state.jobs : [];
      return jobs.filter(job => job && job.id && job.nodeId).map(job => {
        const node = nodes.find(item => item && String(item.id) === String(job.nodeId));
        return {
          jobId: String(job.id),
          nodeId: String(job.nodeId),
          nodeTitle: String((node && node.title) || job.title || "视频生成"),
          state: String(job.state || ""),
          stopped: Boolean(job.stopped),
          pendingBackfill: Boolean(job.pendingBackfill),
          hasOutput: Boolean(job.output || job.file),
          nodeLastJobId: node ? String(node.lastJobId || "") : "",
          nodeExists: Boolean(node),
          accountId: String(job.browserAccountId || ""),
          profileName: String(job.profileName || "")
        };
      });
    })()`);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function candidateFromOrigin(item, extra = {}) {
  if (!item?.jobId || !item?.nodeId) return null;
  return {
    jobId: String(item.jobId),
    nodeId: String(item.nodeId),
    nodeTitle: String(item.nodeTitle || item.title || "视频生成"),
    accountId: String(item.accountId || extra.accountId || ""),
    provider: String(item.provider || extra.provider || ""),
    ready: Boolean(item.url || extra.ready),
    url: item.url || "",
    file: item.file || "",
    source: extra.source || "origin"
  };
}

async function listBrowserBackfillCandidates(accountId) {
  const wanted = String(accountId || "");
  const map = new Map();
  const add = (item, extra) => {
    const row = candidateFromOrigin(item, extra);
    if (!row) return;
    const current = map.get(row.jobId);
    map.set(row.jobId, current ? { ...current, ...row, ready: Boolean(current.ready || row.ready), url: row.url || current.url, file: row.file || current.file } : row);
  };
  for (const origin of browserJobOrigins.values()) add(origin, { source: "bound" });
  for (const staged of browserReadyBackfills.values()) add(staged, { source: "saved", ready: true });
  for (const pending of browserPendingJobs.values()) add({ jobId: pending.jobId, nodeId: pending.nodeId, nodeTitle: pending.nodeTitle, accountId: pending.accountId, provider: pending.provider }, { source: "pending" });
  for (const worker of liveBrowserWorkers()) {
    if (worker.originTask) add({ ...worker.originTask, jobId: worker.originTask.jobId || worker.originTask.id }, { source: "window", accountId: worker.accountId });
  }
  for (const job of await readCanvasBackfillJobs()) {
    if (!job.nodeExists) continue;
    add(job, { source: "canvas", accountId: job.accountId });
  }
  let list = [...map.values()];
  if (wanted) {
    const matched = list.filter(item => !item.accountId || item.accountId === wanted);
    if (matched.length) list = matched;
  }
  return list.sort((a, b) => Number(Boolean(b.ready)) - Number(Boolean(a.ready)));
}

function notifyBrowserBackfillReady(staged) {
  const payload = { ...staged, originLabel: canvasOriginLabel(staged) };
  for (const worker of liveBrowserWorkers()) {
    if (!worker.win || worker.win.isDestroyed()) continue;
    if (staged.accountId && worker.accountId && worker.accountId !== staged.accountId) continue;
    try { worker.win.webContents.send('browser-ready-backfill', payload); } catch {}
  }
}

function stageBrowserVideoJob(task) {
  const jobId = String(task.jobId || '');
  if (!jobId || !task.url) return;
  if (completingBrowserJobs.has(jobId) || taskControls.get(jobId)?.state === 'completed') {
    finishBrowserPendingJob(jobId);
    return;
  }
  const pending = browserPendingJobs.get(jobId) || browserReadyBackfills.get(jobId) || {};
  const staged = {
    jobId,
    nodeId: task.nodeId || pending.nodeId,
    nodeTitle: String(task.nodeTitle || task.title || pending.nodeTitle || '视频生成'),
    url: task.url,
    file: task.file || '',
    accountId: task.accountId || pending.accountId,
    provider: task.provider || pending.provider,
    stagedAt: Date.now()
  };
  browserReadyBackfills.set(jobId, staged);
  rememberBrowserJobOrigin(staged, { accountId: staged.accountId, provider: staged.provider, nodeTitle: staged.nodeTitle });
  finishBrowserPendingJob(jobId);
  const origin = canvasOriginLabel(staged);
  emitJobState({ id: jobId, nodeId: staged.nodeId, type: 'video' }, 'awaiting_backfill',
    `成片已保存。请手动回填到发出窗口：${origin} · 任务 ${jobId}`,
    { url: staged.url, file: staged.file, nodeTitle: staged.nodeTitle, pendingBackfill: true });
  notifyBrowserBackfillReady(staged);
}

function commitBrowserVideoBackfill(input) {
  const payload = input && typeof input === "object" ? input : { jobId: input };
  const id = String(payload.jobId || "");
  const claimedNodeId = String(payload.nodeId || "");
  const claimedAccountId = String(payload.accountId || "");
  const staged = browserReadyBackfills.get(id);
  const origin = browserJobOrigins.get(id) || (staged && {
    jobId: id,
    nodeId: staged.nodeId,
    nodeTitle: staged.nodeTitle,
    accountId: staged.accountId,
    provider: staged.provider
  });
  if (!id) throw new Error("缺少任务编号，已取消回填");
  const nodeId = String(claimedNodeId || origin?.nodeId || staged?.nodeId || "");
  if (!nodeId) throw new Error("没有这个任务的发出节点记录，不能猜测回填目标");
  if (origin?.nodeId && nodeId !== String(origin.nodeId)) {
    throw new Error(`节点不匹配：成片属于「${origin.nodeTitle}」，不能填到其他节点`);
  }
  rememberBrowserJobOrigin({ jobId: id, nodeId, nodeTitle: origin?.nodeTitle || staged?.nodeTitle }, { accountId: claimedAccountId || origin?.accountId || staged?.accountId, provider: origin?.provider || staged?.provider });
  if (!staged?.url) throw new Error("没有可回填的成片，或已经回填过");
  if (completingBrowserJobs.has(id) || taskControls.get(id)?.state === "completed") {
    browserReadyBackfills.delete(id);
    return { ok: true, already: true, nodeId, nodeTitle: origin.nodeTitle };
  }
  completingBrowserJobs.add(id);
  const result = {
    type: "video",
    jobId: staged.jobId,
    nodeId,
    url: staged.url,
    file: staged.file || "",
    completedAt: new Date().toISOString(),
    provider: staged.provider || origin.provider,
    browserAccountId: origin.accountId || staged.accountId,
    nodeTitle: origin.nodeTitle,
    recoverStopped: true
  };
  emitJobState({ id: staged.jobId, nodeId, type: "video" }, "completed",
    `已回填到发出窗口：${canvasOriginLabel(origin)}`,
    { url: staged.url, file: staged.file, nodeTitle: origin.nodeTitle, recoverStopped: true });
  try { win && !win.isDestroyed() && win.webContents.send("doubao-result", result); } catch {}
  browserReadyBackfills.delete(id);
  finishBrowserPendingJob(id);
  notifyBrowserBackfillReady({ ...staged, ...origin, nodeId, committed: true });
  for (const worker of liveBrowserWorkers()) {
    if (worker.originTask && String(worker.originTask.id || worker.originTask.jobId) === id) worker.originTask = null;
  }
  return { ok: true, nodeId, nodeTitle: origin.nodeTitle };
}

function completeBrowserVideoJob(task) {
  stageBrowserVideoJob(task);
}

async function harvestOneBrowserJob(job) {
  if (!job || job.harvesting || completingBrowserJobs.has(job.jobId) || browserReadyBackfills.has(job.jobId)) return;
  if (!job.readyToHarvest || Date.now() - Number(job.submittedAt || 0) < 4000) return;
  if (taskControls.get(job.jobId)?.cancelled) {
    finishBrowserPendingJob(job.jobId);
    return;
  }
  const account = browserAccountService.list(dataRoot).find(item => item.id === job.accountId);
  if (!account) return;
  const source = findWebviewForAccount(account);
  if (!source || source.__jxRedirectingClean || source.__jxProgrammaticSavePath) return;
  job.harvesting = true;
  try {
    const page = await platformHelper.inspectPageVideos(source).catch(() => null);
    if (page?.failed && !page?.done) {
      emitJobFailure({ id: job.jobId, nodeId: job.nodeId, type: 'video' }, '页面提示视频生成失败', { retryable: true });
      finishBrowserPendingJob(job.jobId);
    }
  } catch (error) {
    automationLog('浏览器成片巡检尚未完成', { jobId: job.jobId, accountId: job.accountId, error: error.message });
  } finally {
    const pending = browserPendingJobs.get(job.jobId);
    if (pending) pending.harvesting = false;
  }
}

async function harvestAllBrowserJobs() {
  pumpBrowserTaskQueue();
  if (browserHarvestBusy || !browserPendingJobs.size) return;
  browserHarvestBusy = true;
  try {
    await Promise.allSettled([...browserPendingJobs.values()].map(job => harvestOneBrowserJob(job)));
  } finally {
    browserHarvestBusy = false;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    title: licenseClient.LICENSE_TEST ? "家兴豆包无限画布 · 授权测试" : "家兴豆包无限画布",
    icon: canvasIcon(),
    backgroundColor: "#f4f7fb",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      backgroundThrottling: false
    }
  });
  secureWebviews(win);
  const showCanvas = () => { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); };
  win.once("ready-to-show", showCanvas);
  setTimeout(showCanvas, 1800);
  win.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    automationLog("画布窗口加载失败", { code, description, url, isMainFrame });
    if (!isMainFrame) return;
    if ([-3, -27].includes(Number(code))) return;
    const failed = String(url || "");
    if (failed && !/index\.html/i.test(failed)) return;
    recoverCanvasWindow(`did-fail-load:${code}`);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    automationLog("画布渲染进程退出", details);
    if (details?.reason === "clean-exit") return;
    recoverCanvasWindow(`render-process-gone:${details?.reason || ""}`);
  });
  win.webContents.session.clearCache().catch(() => {});
  win.loadFile(path.join(__dirname, "app", "index.html"), { query: { v: "20260916-r2" } });
  win.on("closed", () => {
    win = null;
    closeHiddenBrowserWindows();
    app.quit();
  });
}

app.on("gpu-process-crashed", (_event, killed) => {
  automationLog("GPU 进程崩溃，画布保持当前页面，不自动刷新", { killed });
  enableGpuSafeMode();
});
app.on("child-process-gone", (_event, details) => {
  if (String(details?.type || "").toUpperCase() !== "GPU") return;
  automationLog("GPU 子进程退出，画布保持当前页面，不自动刷新", details);
  enableGpuSafeMode();
});

function registerIpcHandle(channel, listener) {
  try { ipcMain.removeHandler(channel); } catch {}
  ipcMain.handle(channel, listener);
}

registerIpcHandle('browser-ensure-video-mode', async (_event, input) => {
  const source = Number(input?.webContentsId) ? webContents.fromId(Number(input.webContentsId)) : null;
  if (!source || source.isDestroyed()) throw new Error('对应页面已经关闭，无法进入视频模式');
  if (typeof platformHelper.ensureVideoMode !== 'function') throw new Error('当前版本缺少视频模式切换能力，请完全退出后重新打开画布');
  return platformHelper.ensureVideoMode(source, Number(input?.timeoutMs || 45000));
});
registerIpcHandle('browser-fill-prompt', async (_event, input) => {
  const source = Number(input?.webContentsId) ? webContents.fromId(Number(input.webContentsId)) : null;
  if (!source || source.isDestroyed()) throw new Error('对应页面已经关闭，无法填写提示词');
  if (typeof platformHelper.fillComposerPrompt !== 'function') throw new Error('当前版本缺少提示词写入能力，请完全退出后重新打开画布');
  return platformHelper.fillComposerPrompt(source, String(input?.prompt || ''));
});
registerIpcHandle('browser-trusted-key', async (_event, input) => {
  const source = Number(input?.webContentsId) ? webContents.fromId(Number(input.webContentsId)) : null;
  if (!source || source.isDestroyed()) throw new Error('对应页面已经关闭，无法调整设置');
  await platformHelper.attach(source);
  await platformHelper.pressKey(source, String(input?.key || 'Escape'), String(input?.code || 'Escape'), Number(input?.windowsVirtualKeyCode || 27));
  return { ok: true };
});

app.whenReady().then(async () => {
  if (!gotLock) return;
  const integrity = integrityCheck.verify();
  if (!integrity.ok && integrity.tamper) {
    await licenseClient.reportTamper({ files: integrity.files }).catch(() => {});
    try {
      dialog.showMessageBoxSync({
        type: "error",
        title: "设备已锁定",
        message: licenseClient.LOCKED_MESSAGE,
        buttons: ["退出"]
      });
    } catch {}
    app.quit();
    return;
  }
  if (!integrity.ok) {
    try {
      dialog.showMessageBoxSync({
        type: "error",
        title: "程序校验失败",
        message: integrity.message || "程序文件不完整，请重新下载官方安装包。",
        buttons: ["退出"]
      });
    } catch {}
    app.quit();
    return;
  }
  const machine = await licenseClient.assertMachineAllowed().catch(() => ({ ok: true }));
  if (machine && machine.machineLocked) {
    try {
      dialog.showMessageBoxSync({
        type: "error",
        title: "设备已锁定",
        message: licenseClient.LOCKED_MESSAGE,
        buttons: ["退出"]
      });
    } catch {}
    app.quit();
    return;
  }
  try { app.setAppUserModelId("jiaxing.doubao.canvas"); } catch {}
  try {
    const converter = prepareBundledFfmpegCache();
    automationLog(converter.ok ? "H.264 转换器自检通过" : "H.264 转换器自检失败", {
      executable: converter.executable || "",
      checkedPaths: converter.candidates || []
    });
  } catch (error) {
    automationLog("H.264 转换器缓存初始化失败", { error: error.message, ...ffmpegStatus() });
  }
  createWindow();
  enforceLicense(true).catch(() => {});
  licenseWatchTimer = setInterval(() => enforceLicense(true).catch(() => {}), licenseClient.WATCH_MS);
  licenseWatchTimer.unref?.();
  importPendingDolaAccountFile();
  resultViewTimer=setInterval(()=>pumpResultViews().catch(error=>automationLog('原任务视图调度异常',{error:error.message})),1500);
  resultViewTimer.unref?.();
  browserHarvestTimer = setInterval(() => harvestAllBrowserJobs().catch(error => automationLog('浏览器成片巡检异常', { error: error.message })), 8000);
  browserHarvestTimer.unref?.();
  if (loadConfig().noWatermarkEnabled !== false) {
    noWatermarkService.start().catch(error => automationLog("无水印素材捕获初始化失败", { error: error.message }));
  }
});
app.on("before-quit", () => {clearInterval(resultViewTimer); clearInterval(browserHarvestTimer); clearInterval(licenseWatchTimer); noWatermarkService.stop().catch(() => {}); });
app.on("window-all-closed", () => app.quit());

ipcMain.handle("choose-doubao", licensedIpc(chooseDoubaoExecutable));
registerIpcHandle('browser-accounts-list', () => browserAccountService.list(dataRoot));
registerIpcHandle('browser-account-save', (_event, account) => {
  const saved = browserAccountService.upsert(dataRoot, account || {});
  ensureAccountMonitorWindows({ create: false, show: false, repair: false });
  return saved;
});
registerIpcHandle('browser-accounts-import', (_event, accounts) => {
  const results = browserAccountService.importMany(dataRoot, accounts);
  ensureAccountMonitorWindows({ create: false, show: false, repair: false });
  return results;
});
registerIpcHandle('browser-account-remove', async (_event, id) => {
  const accountId = String(id || '');
  const listed = browserAccountService.list(dataRoot).find(item => item.id === accountId);
  if (!listed) throw new Error('账号不存在或已经删除');
  const partition = listed.partition;
  const worker = findExistingWorkerForAccount(listed) || findWorkerByAccount(accountId);
  for (const [jobId, job] of [...browserPendingJobs.entries()]) {
    if (String(job.accountId || '') !== accountId) continue;
    emitJobFailure({ id: jobId, nodeId: job.nodeId, type: 'video' }, '账号已被删除，任务已停止', { retryable: true });
    finishBrowserPendingJob(jobId);
  }
  if (worker) {
    worker.taskId = '';
    worker.busy = false;
    worker.inbox = [];
  }
  browserAccountService.remove(dataRoot, accountId);
  const target = worker && worker.win && !worker.win.isDestroyed() ? worker.win : null;
  if (target) {
    await new Promise(resolve => {
      const done = () => resolve();
      target.once('closed', done);
      try { target.close(); } catch { done(); }
      setTimeout(done, 1500);
    });
  }
  if (partition) {
    try { await session.fromPartition(partition).clearStorageData(); } catch {}
  }
  return { ok: true, accountId, closed: Boolean(target) };
});
registerIpcHandle('browser-account-credential', (_event, id) => browserAccountService.credential(dataRoot, id));
registerIpcHandle('browser-account-quota', (_event, id, status) => {
  const updated = browserAccountService.updateQuota(dataRoot, id, status);
  refreshWorkerTitles();
  return updated;
});
registerIpcHandle('browser-wait-composer', async (_event, input) => {
  const source = Number(input?.webContentsId) ? webContents.fromId(Number(input.webContentsId)) : null;
  if (!source || source.isDestroyed()) throw new Error('对应页面已经关闭，无法检查输入框');
  return platformHelper.waitComposerReadyTwice(source, Number(input?.expectedImages || 0), Number(input?.timeoutMs || 120000));
});
registerIpcHandle('browser-click-dola-send', async (_event, input) => {
  const source = Number(input?.webContentsId) ? webContents.fromId(Number(input.webContentsId)) : null;
  if (!source || source.isDestroyed()) throw new Error('对应页面已经关闭，无法点击发送');
  return platformHelper.clickDolaSend(source, { expectedImages: Number(input?.expectedImages || 0), timeoutMs: Number(input?.timeoutMs || 120000) });
});
registerIpcHandle('browser-trusted-click', async (_event, input) => {
  const source = Number(input?.webContentsId) ? webContents.fromId(Number(input.webContentsId)) : null;
  if (!source || source.isDestroyed()) throw new Error('对应页面已经关闭，无法点击设置');
  await platformHelper.attach(source);
  if (input?.hoverOnly) await platformHelper.hoverPoint(source, input.x, input.y);
  else await platformHelper.clickPoint(source, input.x, input.y);
  return { ok: true };
});
registerIpcHandle('browser-sync-composer', (_event, payload) => {
  const message = payload || {};
  const wantedId = String(message.accountId || message.browserAccountId || '');
  const busy = liveBrowserWorkers().find(worker => worker.busy && worker.win && !worker.win.isDestroyed() && (!wantedId || worker.accountId === wantedId));
  if (busy) {
    try { busy.win.webContents.send('browser-sync-composer', message); } catch {}
    return { ok: true, accountId: busy.accountId };
  }
  return { ok: true, skipped: true };
});
registerIpcHandle('browser-window-open', () => {
  try {
    const opened = ensureAccountMonitorWindows({ create: true, show: true, visible: true, repair: true });
    if (!opened.accounts) {
      const target = createBrowserAccountsWindow({ add: true });
      presentBrowserWindow(target);
    }
    automationLog('已打开全部账号浏览器', opened);
    return { ok: true, ...opened };
  } catch (error) {
    automationLog('打开内置浏览器失败', { error: error.message });
    throw error;
  }
});
registerIpcHandle('browser-window-minimize', event => {
  const win = BrowserWindow.fromWebContents(event.sender) || browserWin;
  try { win?.minimize(); } catch {}
  return { ok: true };
});
registerIpcHandle('browser-window-close', event => {
  const win = BrowserWindow.fromWebContents(event.sender) || browserWin;
  try { win?.close(); } catch {}
  return { ok: true };
});
registerIpcHandle('browser-window-set-title', (event, title) => {
  const text = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return { ok: false };
  const worker = liveBrowserWorkers().find(item => item.win === win);
  if (worker && text && !genericAccountLabel(text)) {
    worker.pageUserName = text.replace(/^(Dola|豆包)[·\s]+/i, '').trim() || text;
  }
  const account = worker ? browserAccountService.list(dataRoot).find(item => item.id === worker.accountId) : null;
  const labeled = accountWindowTitle(account, worker?.pageUserName || (genericAccountLabel(text) ? '' : text));
  lockNativeWindowTitle(win, labeled);
  return { ok: true, title: labeled };
});
registerIpcHandle('browser-focus-account', (_event, accountId) => {
  const id = String(accountId || '');
  if (!id) return { ok: false, error: '账号无效' };
  const listed = browserAccountService.list(dataRoot).find(item => item.id === id);
  let worker = listed ? findExistingWorkerForAccount(listed) : findWorkerByAccount(id);
  if (!worker || !worker.win || worker.win.isDestroyed()) worker = createBrowserTaskWorker(id, { visible: true });
  presentBrowserWindow(worker.win);
  return { ok: true, accountId: id };
});
registerIpcHandle('browser-workers-warmup', (_event, input) => {
  browserPreferredProvider = ['doubao','dola'].includes(input?.provider) ? input.provider : '';
  browserPreferredAccountIds = Array.isArray(input?.accountIds) ? [...new Set(input.accountIds.map(String))].slice(0, 50) : [];
  const opened = ensureAccountMonitorWindows({ create: true, show: true, visible: true, repair: true });
  if (!opened.accounts) throw new Error('没有可用于监控的浏览器账号');
  return { ok: true, requested: opened.accounts, workers: opened.workers, provider: browserPreferredProvider || 'auto', accounts: opened.accounts };
});
registerIpcHandle('browser-workers-status', () => ({ max: MAX_BROWSER_TASK_WORKERS, workers: browserTaskWorkers.length, busy: browserTaskWorkers.filter(worker => worker.busy).length, queued: browserTaskQueue.length, pending: browserPendingJobs.size, provider: browserPreferredProvider || 'auto' }));
ipcMain.handle('clipboard-read-text', () => clipboard.readText());
registerIpcHandle('browser-reference-upload', async (_event, input) => {
  const account = browserAccountService.list(dataRoot).find(item => item.id === String(input?.accountId || ''));
  if (!account) throw new Error('上传参考图时没有找到对应浏览器账号');
  const jobId = String(input?.jobId || '');
  if (!/^(?:DB|IMG)-[A-Za-z0-9-]{1,80}$/.test(jobId)) throw new Error('参考图任务编号无效');
  const images = Array.isArray(input?.images) ? input.images.slice(0, 10) : [];
  if (!images.length) return { ok: true, files: [], count: 0 };
  const folder = jobFolder(jobId);
  fs.mkdirSync(folder, { recursive: true });
  const files = saveReferenceFiles({ images }, folder);
  const accountSession = session.fromPartition(account.partition);
  const requestedSource = Number(input?.webContentsId) ? webContents.fromId(Number(input.webContentsId)) : null;
  const source = requestedSource && !requestedSource.isDestroyed() && requestedSource.session === accountSession && requestedSource.getType() === 'webview'
    ? requestedSource : webContents.getAllWebContents().find(contents => !contents.isDestroyed() && contents.session === accountSession && contents.getType() === 'webview');
  if (!source) throw new Error('对应账号页面已经关闭，无法上传参考图');
  const helperWasAttached = platformHelper.isAttached(source);
  try {
    await platformHelper.attach(source);
    const uploaded = await platformHelper.setComposerFiles(source, files);
    const manifest = files.map((file, index) => ({ order: index + 1, file, name: path.basename(file), size: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
    const browserFiles = Array.isArray(uploaded.browserFiles) ? uploaded.browserFiles : [];
    manifest.forEach((expected, index) => {
      const actual = browserFiles[index];
      if (!actual || actual.name !== expected.name || Number(actual.size) !== expected.size) throw new Error(`第 ${index + 1} 张参考图与上传控件中的文件不一致或顺序错误`);
    });
    return { ok: true, files, count: files.length, verifiedCount: uploaded.verifiedCount || browserFiles.length, manifest, browserFiles, orderSignatures: uploaded.orderSignatures || [] };
  } finally {
    if (!helperWasAttached) platformHelper.attach(source).catch(() => {});
  }
});
registerIpcHandle('browser-clean-video', (_event, input) => platformHelper.peekCleanVideoUrl(input?.webContentsId) || null);
registerIpcHandle('browser-video-download', async (_event, input) => {
  const account = browserAccountService.list(dataRoot).find(item => item.id === String(input?.accountId || ''));
  if (!account) throw new Error('下载视频时没有找到对应浏览器账号');
  const jobId = String(input?.jobId || '');
  if (!/^(?:DB|IMG)-[A-Za-z0-9-]{1,80}$/.test(jobId)) throw new Error('视频任务编号无效');
  const requestedSource = Number(input?.webContentsId) ? webContents.fromId(Number(input.webContentsId)) : null;
  const source = (requestedSource && !requestedSource.isDestroyed() && requestedSource.session === session.fromPartition(account.partition) && requestedSource.getType() === 'webview')
    ? requestedSource : findWebviewForAccount(account);
  if (!source) throw new Error('对应账号页面已经关闭，无法下载视频');
  const ingested = typeof platformHelper.ingestFallbackRecipes === 'function'
    ? platformHelper.ingestFallbackRecipes(source, input?.recipes)
    : 0;
  let resolved = typeof platformHelper.resolveFromRecipes === 'function'
    ? await platformHelper.resolveFromRecipes(source, input?.recipes).catch(() => null)
    : null;
  if (!resolved || !resolved.url || input?.manual) {
    const matched = typeof platformHelper.resolveCleanUrlForDownload === 'function'
      ? await platformHelper.resolveCleanUrlForDownload(source, resolved?.url || '', { usedKeys: savedVideoKeys(source) }).catch(() => null)
      : null;
    if (matched && matched.url) resolved = matched;
  }
  if (!resolved || !resolved.url) {
    resolved = typeof platformHelper.resolvePeekedCleanUrl === 'function'
      ? await platformHelper.resolvePeekedCleanUrl(source).catch(() => null)
      : platformHelper.peekCleanVideoUrl(input?.webContentsId);
  }
  const url = String(resolved?.url || '');
  if (!url) throw new Error(`还没有拿到无水印原片地址，未保存带水印预览（配方${Number(ingested) || 0}条）`);
  if (typeof platformHelper.isPlayerPreviewUrl === 'function' && platformHelper.isPlayerPreviewUrl(url)) {
    throw new Error('拒绝保存带水印预览片，正在等待无水印原片地址');
  }
  const pending = browserPendingJobs.get(jobId);
  if (!input?.manual && pending && (harvestedBrowserUrls.has(url) || isStaleBrowserMedia(pending, { url, fallbackApi: resolved?.fallbackApi }))) {
    throw new Error('当前检测到的仍是上一条成片地址，正在等待本条任务的新视频');
  }
  const saved = await downloadBrowserVideoFile({ account, jobId, url, source, promptSave: true });
  harvestedBrowserUrls.add(url);
  rememberSavedVideo(source, resolved);
  return saved;
});
registerIpcHandle('browser-origin-task', event => {
  const worker = browserTaskWorkers.find(item => item.win && !item.win.isDestroyed() && item.win.webContents.id === event.sender.id)
    || (browserWin && !browserWin.isDestroyed() && browserWin.webContents.id === event.sender.id
      ? browserTaskWorkers.find(item => item.win === browserWin)
      : null);
  if (worker?.originTask) return worker.originTask;
  const accountId = worker?.accountId || '';
  const staged = [...browserReadyBackfills.values()].reverse().find(item => !accountId || item.accountId === accountId);
  if (staged) return { id: staged.jobId, jobId: staged.jobId, nodeId: staged.nodeId, title: staged.nodeTitle, nodeTitle: staged.nodeTitle, url: staged.url, file: staged.file, accountId: staged.accountId };
  const pending = [...browserPendingJobs.values()].reverse().find(item => !accountId || item.accountId === accountId);
  if (pending) return { id: pending.jobId, jobId: pending.jobId, nodeId: pending.nodeId, title: pending.nodeTitle, nodeTitle: pending.nodeTitle, accountId: pending.accountId };
  const origin = [...browserJobOrigins.values()].reverse().find(item => !accountId || !item.accountId || item.accountId === accountId);
  if (origin) return { id: origin.jobId, jobId: origin.jobId, nodeId: origin.nodeId, title: origin.nodeTitle, nodeTitle: origin.nodeTitle, accountId: origin.accountId };
  return null;
});
registerIpcHandle('browser-backfill-candidates', (_event, accountId) => listBrowserBackfillCandidates(accountId));
registerIpcHandle('browser-commit-backfill', (_event, payload) => commitBrowserVideoBackfill(payload));
registerIpcHandle('browser-task-dispatch', async (_event, task) => {
  if (!/^(?:DB|IMG)-[A-Za-z0-9-]{1,80}$/.test(String(task?.id || ''))) throw new Error('浏览器任务编号无效');
  const entry = { task: task || {}, queuedAt: Date.now(), resolve: () => {} };
  if (!assignBrowserTask(entry)) forceDeliverBrowserTask(entry);
  return { ok: true, sent: true, message: '已发给账号窗口，正在填写并发送' };
});
registerIpcHandle('browser-task-take', event => {
  const worker = browserTaskWorkers.find(item => item.win && !item.win.isDestroyed() && item.win.webContents.id === event.sender.id)
    || (browserWin && !browserWin.isDestroyed() && browserWin.webContents.id === event.sender.id
      ? browserTaskWorkers.find(item => item.win === browserWin)
      : null);
  if (!worker || !Array.isArray(worker.inbox) || !worker.inbox.length) return null;
  return worker.inbox.shift();
});
registerIpcHandle('browser-task-status', (_event, payload) => {
  const task = payload || {};
  const job = { id: task.jobId, nodeId: task.nodeId, type: 'video' };
  const owner = browserTaskOwners.get(String(task.jobId || '')) || browserTaskWorkers.find(item => item.taskId === String(task.jobId || ''));
  const operatingWin = owner && owner.win;
  if (operatingWin) unpinBrowserWindow(operatingWin);
  if (owner && ['queued', 'preparing', 'submitting', 'generating'].includes(task.state)) {
    owner.acked = true;
    owner.lastTask = null;
    owner.resendCount = 0;
  }
  if (task.state === 'failed' || task.state === 'quota_exhausted') {
    emitJobFailure(job, task.message || '内置浏览器任务失败', { quotaExhausted: task.state === 'quota_exhausted', retryable: true });
    finishBrowserPendingJob(task.jobId);
  } else if (task.state === 'backfill') {
    try {
      commitBrowserVideoBackfill(task.jobId);
    } catch (error) {
      emitJobState(job, 'awaiting_backfill', error.message || '回填到发出节点失败', { pendingBackfill: true });
    }
  } else if ((task.state === 'completed' || task.state === 'awaiting_backfill') && task.url) {
    stageBrowserVideoJob({ ...task, nodeTitle: task.nodeTitle || task.title });
  } else if (task.state === 'needs_attention') {
    emitJobState(job, 'needs_attention', task.message || '请处理原对话后继续', { provider: task.provider, browserAccountId: task.accountId });
    finishBrowserPendingJob(task.jobId);
  } else {
    if (task.state === 'generating') {
      countBrowserVideoUsage(task.accountId, task.jobId);
      const pending = browserPendingJobs.get(String(task.jobId || ''));
      if (pending && !pending.readyToHarvest) {
        pending.readyToHarvest = true;
        pending.submittedAt = Date.now();
        const account = browserAccountService.list(dataRoot).find(item => item.id === (task.accountId || pending.accountId));
        enrichBrowserJobBaseline(pending, account).catch(() => {});
      }
      releaseBrowserTask(task.jobId);
    }
    emitJobState(job, task.state || 'preparing', task.message || '内置浏览器正在处理任务', { provider: task.provider, browserAccountId: task.accountId });
  }
  return { ok: true };
});
ipcMain.handle("doubao-path", licensedIpc(() => doubaoExe() || ""));
ipcMain.handle("list-profiles", licensedIpc(() => profiles()));
ipcMain.handle("sync-accounts", licensedIpc(async () => {
  const exe = doubaoExe();
  if (!exe) return { ok: false, needPath: true, error: "尚未选择豆包客户端" };
  if (submissionBusy || activeSubmissions.size) {
    return { ok: false, busy: true, error: "当前有任务正在提交或等待人工确认；请等待提交完成后再同步账号" };
  }
  if (activeManualSubmission()) {
    return { ok: false, busy: true, error: "当前任务正在等待你在豆包手动提交；为防止打开账号菜单干扰任务识别，请先完成或停止该任务" };
  }
  if(resultViewLeases)return {ok:false,busy:true,error:'正在下载并回填原任务，请稍后再同步账号'};
  if (accountSyncBusy) return { ok: false, busy: true, error: "账号同步正在进行，请稍候" };
  accountSyncBusy = true;
  try {
    progress(activeMonitors.size
      ? "正在安全读取豆包账号列表；不会切换账号，视频回填会暂时停止页面点击……"
      : "正在读取原生豆包中的已登录账号……");
    const result = await withNativeDoubao(() => inspectNativeAccounts({
      exe,
      progress: message => progress(message),
      log: message => automationLog(message)
    }));
    if (result.needLogin) return { ok: false, needLogin: true, error: "请先在官方豆包中登录账号" };
    const updated = syncProfiles(result.accounts, result.currentAccount);
    return { ok: true, profiles: updated, currentAccount: result.currentAccount, accountCount: updated.filter(profile => profile.accountName).length };
  } catch (error) {
    automationLog("同步豆包账号失败", { error: error.message, code: error.code });
    return { ok: false, error: error.message, code: error.code };
  } finally {
    accountSyncBusy = false;
    currentResultView='';
    lastResultViewAt=0;
    pumpSubmissionQueue();
    void pumpResultViews().catch(error=>automationLog('同步账号后恢复任务视图失败',{error:error.message}));
  }
}));
ipcMain.handle("add-profile", licensedIpc((_event, name) => {
  const config = loadConfig();
  config.profiles = profiles();
  const id = `account-${crypto.randomUUID()}`;
  const profile = { id, name: String(name || `待绑定账号 ${config.profiles.length + 1}`).slice(0, 40), port: profilePort() };
  config.profiles.push(profile);
  saveConfig(config);
  return profile;
}));
ipcMain.handle("rename-profile", licensedIpc((_event, id, name) => {
  const config = loadConfig();
  config.profiles = profiles().map(profile => profile.id === id ? { ...profile, name: String(name || profile.name).slice(0, 40), customName: true } : profile);
  saveConfig(config);
  return config.profiles;
}));
ipcMain.handle("remove-profile", licensedIpc(async (_event, id) => {
  const config = loadConfig();
  const existing = profiles();
  if (existing.length <= 1) return { ok: false, error: "至少保留一个豆包账号" };
  const profile = existing.find(item => item.id === id);
  if (!profile) return { ok: false, error: "账号不存在" };
  const answer = await dialog.showMessageBox(win, {
    type: "warning",
    title: "移除画布账号",
    message: `确定移除“${profile.name}”吗？`,
    detail: "只会从画布列表移除，不会退出或删除豆包中的账号，也不会删除画布项目。",
    buttons: ["取消", "移除"],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  if (answer.response !== 1) return { ok: false, canceled: true };
  config.profiles = existing.filter(item => item.id !== id);
  saveConfig(config);
  return { ok: true, profiles: config.profiles };
}));
ipcMain.handle("open-profile", licensedIpc(async (_event, profileId) => {
  const exe = doubaoExe();
  if (!exe) return { ok: false, needPath: true };
  const profile = profileById(profileId);
  if (submissionBusy || accountSyncBusy || activeSubmissions.size || activeMonitors.size) {
    return { ok: false, busy: true, error: "当前有视频正在提交或等待回填；为防止切号造成错回填，请等任务完成后再打开其他账号" };
  }
  accountSyncBusy = true;
  try {
    return await withNativeDoubao(() => openProfile({
      exe,
      accountIdentity: profileIdentity(profile),
      progress: message => progress(message),
      log: message => automationLog(message, { profileId: profile.id })
    }));
  } catch (error) { return { ok: false, error: error.message, code: error.code }; }
  finally { accountSyncBusy = false; pumpSubmissionQueue(); }
}));
ipcMain.handle("send-to-doubao", licensedIpc((_event, job) => enqueueSubmission(job)));
ipcMain.handle("stop-doubao-job", async (_event, jobId) => {
  if (!/^(?:DB|IMG)-[A-Za-z0-9-]{1,80}$/.test(String(jobId || ""))) return { ok: false, error: "任务编号无效" };
  const control = taskControl(jobId);
  control.cancelled = true;
  control.abort.abort();
  const monitor = activeMonitors.get(jobId);
  const stoppedJob = control.job || monitor?.job || { id: jobId, nodeId: "", profileId: monitor?.profileId || "default" };
  emitJobState(stoppedJob, "stopping", "正在停止本任务的后台操作……");
  cancelQueuedSubmission(jobId);
  finishBrowserPendingJob(jobId);
  try { monitor?.client?.close(); } catch {}
  await Promise.allSettled([control.finished, control.monitorFinished]);
  await noWatermarkService.disarmCapture(jobId).catch(error => automationLog("停止任务解除捕获失败", { jobId, error: error.message }));
  emitJobState(stoppedJob, "stopped", "画布后台已停止；豆包已接收的任务需在豆包中确认取消");
  pumpSubmissionQueue();
  automationLog("用户停止任务", { jobId });
  return { ok: true, stopped: true, jobId };
});
ipcMain.handle("open-task-folder", licensedIpc(() => shell.openPath(tasksRoot())));
ipcMain.handle("open-job-folder", licensedIpc((_event, jobId) => {
  try {
    const folder = jobFolder(jobId);
    fs.mkdirSync(folder, { recursive: true });
    return shell.openPath(folder);
  } catch (error) { return error.message; }
}));
ipcMain.handle("no-watermark-status", licensedIpc(() => noWatermarkService.status()));
ipcMain.handle("remove-video-watermark", licensedIpc((_event, jobId) => removeVideoWatermark(jobId)));
ipcMain.handle("set-no-watermark-enabled", licensedIpc(async (_event, enabled) => {
  const config = loadConfig();
  config.noWatermarkEnabled = Boolean(enabled);
  saveConfig(config);
  const status = await (enabled ? noWatermarkService.start() : noWatermarkService.stop());
  emitNoWatermarkStatus();
  return status;
}));
ipcMain.handle("open-no-watermark-folder", licensedIpc(() => {
  fs.mkdirSync(noWatermarkService.outputFolder, { recursive: true });
  return shell.openPath(noWatermarkService.outputFolder);
}));
ipcMain.handle("delete-history-job", licensedIpc(async (_event, summary) => {
  const jobId = String(summary?.id || "");
  if(activeMonitors.has(jobId)||activeSubmissions.has(jobId)||batchHolds.has(jobId))return {ok:false,error:'请先在历史记录点击“停止监听”，再删除记录；避免留下后台任务'};
  let root;
  let folder;
  try {
    root = path.resolve(tasksRoot());
    folder = path.resolve(jobFolder(jobId));
    if (path.dirname(folder).toLowerCase() !== root.toLowerCase() || path.basename(folder) !== jobId) throw new Error("任务文件夹路径校验失败");
  } catch (error) { return { ok: false, error: error.message }; }
  const folderExists = fs.existsSync(folder);
  const title = String(summary?.title || jobId || "视频生成").slice(0, 80);
  const answer = await dialog.showMessageBox(win, {
    type: "warning",
    title: "删除生成历史",
    message: `如何删除“${title}”？`,
    detail: folderExists
      ? "只删除记录：保留电脑中的参考图、诊断截图和视频。\n记录和文件夹一起删除：任务文件夹将移入回收站；画布节点和豆包对话不会被删除。"
      : "没有找到对应的任务文件夹。可以删除历史记录；画布节点和豆包对话不会被删除。",
    buttons: ["取消", "只删除记录", "记录和文件夹一起删除"],
    defaultId: 1,
    cancelId: 0,
    noLink: true
  });
  if (answer.response === 0) return { ok: false, canceled: true };
  if (answer.response === 2 && folderExists) {
    if (activeSubmissions.has(jobId) || activeMonitors.has(jobId)) return { ok: false, error: "任务仍在运行，请先在视频节点停止任务后再删除文件夹" };
    try {
      await shell.trashItem(folder);
      automationLog("历史记录对应任务文件夹已移入回收站", { jobId, folder });
      return { ok: true, deleteRecord: true, folderDeleted: true };
    } catch (error) { return { ok: false, error: `任务文件夹无法删除：${error.message}` }; }
  }
  return { ok: true, deleteRecord: true, folderDeleted: false, folderMissing: !folderExists };
}));
// Upgrade only this saved task's missing identity. Adjacent pre-submit snapshots
// supply an upper boundary; file order, prompt order and latest video never do.
function addLegacyRecoveryBounds(job, baseline) {
  const context=baseline?.confirmationContext||baseline?.submissionContext;
  if(!context||hasStableIdentity(context.root))return;
  context.previousMessages=baseline.messageState?.messages||[];
  try{
    const ownManifest=JSON.parse(fs.readFileSync(path.join(jobFolder(job.id),'提交清单.json'),'utf8'));
    const started=Date.parse(ownManifest.createdAt);
    if(!Number.isFinite(started)||!baseline.targetId)return;
    let nearest=Infinity,nextMessages=null;
    for(const name of fs.readdirSync(tasksRoot())){
      if(name===job.id||!/^DB-[A-Za-z0-9-]+$/.test(name))continue;
      try{
        const dir=jobFolder(name),otherJob=JSON.parse(fs.readFileSync(path.join(dir,'画布任务.json'),'utf8'));
        if(otherJob.profileId!==job.profileId||!require('./doubao-controller').accountIdentityMatches(otherJob.accountIdentity,job.accountIdentity))continue;
        const manifest=JSON.parse(fs.readFileSync(path.join(dir,'提交清单.json'),'utf8')),stamp=Date.parse(manifest.createdAt);
        if(!(stamp>started&&stamp<nearest&&stamp-started<10*60*1000))continue;
        let record;try{record=JSON.parse(fs.readFileSync(path.join(dir,'豆包提交凭据.json'),'utf8'));}catch{record=JSON.parse(fs.readFileSync(path.join(dir,'豆包待确认.json'),'utf8'));}
        const other=record.baseline||record.before;
        if(record.jobId!==otherJob.id||other.targetId!==baseline.targetId||!Array.isArray(other.messageState?.messages))continue;
        nearest=stamp;nextMessages=other.messageState.messages;
      }catch{}
    }
    if(nextMessages)context.nextSubmissionMessages=nextMessages;
  }catch{}
}

function readJsonIfPresent(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function loadDoubaoRecoveryRecord(folder, jobId) {
  const receipt = readJsonIfPresent(path.join(folder, "豆包提交凭据.json"));
  const pending = receipt ? null : readJsonIfPresent(path.join(folder, "豆包待确认.json"));
  const record = receipt || pending;
  if (!record) return { receipt: null, pending: null, baseline: null };
  if (record.jobId !== jobId) throw new Error("原提交凭据与任务不一致");
  const baseline = receipt?.baseline || pending?.before;
  if (!baseline) throw new Error("缺少原任务提交基线");
  return { receipt, pending, baseline };
}

ipcMain.handle("sync-doubao-result", licensedIpc(async (_event, summary) => {
  let folder,job,baseline;
  try{
    folder=jobFolder(summary?.id);
    job=JSON.parse(fs.readFileSync(path.join(folder,"画布任务.json"),"utf8"));
    if(job.id!==summary.id||!job.nodeId||!job.accountIdentity?.name)throw new Error("原任务身份记录缺失，不能猜测账号或节点");
    if(job.type==='image')return {ok:false,error:"图片生成节点已停用，请保留原图片文件"};
  }catch(error){return {ok:false,error:error.message};}
  if(activeMonitors.has(job.id)){
    const active=activeMonitors.get(job.id);
    addLegacyRecoveryBounds(job,active.baseline);
    active.baseline.recheckRequested=true;
    if(active.baseline.awaitingSubmissionReceipt&&!active.baseline.manualSubmissionRequested)active.baseline.receiptDeadline=Math.min(active.baseline.receiptDeadline||Infinity,Date.now()+60000);
    if(canRotateResult(active)){
      const key=resultViewKey(active);resultViewFailures.delete(key);resultViewRetryAfter.delete(key);resultViewPriorityJobId=job.id;lastResultViewAt=0;
      void pumpResultViews().catch(error=>automationLog('手动优先恢复原任务视图失败',{jobId:job.id,error:error.message}));
    }
    return {ok:true,monitoring:true,message:canRotateResult(active)?"已将本任务设为优先：正在恢复原账号和原对话并核验结果；不是重新生成":"已请求重新核对原消息与结果；不是确认恢复成功，不会重发任务或延长本轮核验"};
  }
  if(activeSubmissions.has(job.id))return {ok:false,busy:true,error:"本任务仍在提交中，请等本次提交核验完成"};
  let control=taskControl(job.id),previous={};
  try{previous=JSON.parse(fs.readFileSync(path.join(folder,'任务运行状态.json'),'utf8'));}catch{}
  const wasStopped=control.cancelled||summary.stopped||['stopping','stopped'].includes(previous.state);
  if(wasStopped&&!summary.recoverStopped)return {ok:false,stopped:true,error:"本任务已停止；请明确选择恢复已有结果，不会重新生成"};
  // Local conversion/result recovery never needs to occupy or change the Doubao UI.
  const hasLocal=Boolean(newestVideoFile(folder)||newestPendingH264File(folder));
  if(!hasLocal){
    const manual=activeManualSubmission(job.id);
    if(manual)return {ok:false,busy:true,error:`任务 ${manual.job.id} 正在等待人工提交；为防止切换原对话造成串台，请先完成或停止该任务`};
    if(submissionBusy||accountSyncBusy||activeSubmissions.size||resultViewLeases)return {ok:false,busy:true,error:"正在提交、切换账号或回填，请稍后恢复；原任务状态未改变"};
    if(activeBatchProfile()&&activeBatchProfile()!==job.profileId)return {ok:false,busy:true,error:"其他账号本批任务尚未处理完，请完成或停止后再恢复；不会擅自切号"};
    try{
      const recovery=loadDoubaoRecoveryRecord(folder,job.id);
      if(!recovery.baseline){
        const stoppedBeforeSubmit=previous.state==='failed'&&/(账号|切换|登录|主对话|生成按钮|模型)/.test(String(previous.message||previous.error||''));
        return {ok:false,notSubmitted:true,retryable:true,quotaNotDeducted:true,error:stoppedBeforeSubmit
          ?"本任务在提交前的账号或页面核对阶段已停止，参考图和提示词未上传，豆包端没有结果可同步；当前账号恢复后，请在原视频节点重新生成"
          :"本地没有这条任务的豆包提交凭据，无法安全同步结果；不会按最新视频或提示词顺序猜测"};
      }
      const {receipt}=recovery;
      baseline=recovery.baseline;
      addLegacyRecoveryBounds(job,baseline);
      if(!receipt){baseline.awaitingSubmissionReceipt=true;baseline.receiptDeadline=Date.now()+60000;}
    }catch(error){return {ok:false,needsAttention:true,error:"无法安全恢复原任务："+error.message+"；不会按最新视频或提示词顺序猜测"};}
  }
  if(wasStopped){
    control={cancelled:false,abort:new AbortController(),sequence:control.sequence||0};
    taskControls.set(job.id,control);
  }
  control.job=job;
  if(!hasLocal)accountSyncBusy=true;
  emitJobState(job,"recovering","正在恢复已有任务结果，不上传参考图、不重新生成");
  control.finished=runWithSignal(control.abort.signal,async()=>{
    let client;
    try{
      const recovered=await recoverPendingH264(folder);
      const existing=recovered||newestVideoFile(folder);
      if(existing){
        await ensureH264Mp4(existing,message=>progress(message,job.id));
        if(control.cancelled)return stoppedResult(job.id);
        const material=await retryBoundMaterial(job,folder);
        if(control.cancelled)return stoppedResult(job.id);
        return {ok:true,completed:true,payload:emitResult(job,existing),message:material.message};
      }
      client=await connectRecoveryPage(baseline,job.accountIdentity);
      if(control.cancelled)return stoppedResult(job.id);
      await noWatermarkService.armCapture({jobId:job.id,targetId:client.targetId,pageUrl:(baseline.confirmationContext||baseline.submissionContext)?.url||baseline.url}).catch(error=>automationLog("恢复素材捕获绑定失败",{jobId:job.id,error:error.message}));
      if(control.cancelled)return stoppedResult(job.id);
      emitJobState(job,baseline.awaitingSubmissionReceipt?"awaiting_receipt":"generating",baseline.awaitingSubmissionReceipt?"正在核验原任务是否已受理，不会重复提交":"已恢复原任务的结果监听");
      beginResultMonitor({client,baseline,folder,job,control});
      client=null;
      return {ok:true,monitoring:true,message:"已恢复原任务监听；仅接收原提交编号对应的结果"};
    }catch(error){
      if(control.cancelled)return stoppedResult(job.id);
      const conversionPending=/^VIDEO_(?:H264|FFMPEG)/.test(error.code||'');
      const message=conversionPending?"视频文件已保留，H.264 转换待恢复："+error.message:error.message;
      emitJobState(job,conversionPending?"conversion_pending":"needs_attention",message);
      return {ok:false,needsAttention:!conversionPending,conversionPending,error:message};
    }finally{
      client?.close();
      if(!hasLocal){accountSyncBusy=false;pumpSubmissionQueue();}
      if(!activeMonitors.has(job.id))await noWatermarkService.disarmCapture(job.id).catch(()=>{});
      pumpSubmissionQueue();
    }
  });
  return control.finished;
}));
ipcMain.handle("task-snapshots", licensedIpc((_event, ids) => {
  const results=[];
  for(const id of (Array.isArray(ids)?ids:[]).slice(0,100)){
    try{
      let snapshot=JSON.parse(fs.readFileSync(path.join(jobFolder(id),'任务运行状态.json'),'utf8'));
      if(snapshot.jobId!==id)continue;
      try{const material=JSON.parse(fs.readFileSync(path.join(jobFolder(id),'无水印结果.json'),'utf8'));if(material.jobId===id)snapshot.noWatermark=material;}catch{}
      if(!activeSubmissions.has(id)&&!activeMonitors.has(id)&&!submissionQueue.some(entry=>entry.job.id===id)
        &&["queued","queued_account","submitting","waiting_prompt_recognition","waiting_manual_submission","recovering","awaiting_receipt","waiting_confirmation","waiting_paid_confirmation","generating","monitor_paused","stopping"].includes(snapshot.state)){
        snapshot={...snapshot,state:snapshot.state==="stopping"?"stopped":"needs_attention",message:snapshot.state==="stopping"?"画布已停止，豆包云端任务请单独查看":"上次监听已中断，原任务保留；请恢复已有结果，不要重复生成"};
      }
      results.push(snapshot);
    }catch{}
  }
  return results;
}));
ipcMain.handle("license-status", async () => {
  const status = await licenseClient.refresh("heartbeat").catch(() => licenseClient.current());
  return licenseClient.broadcast(win) || status;
});
ipcMain.handle("activate-license", async (_event, key) => {
  const status = await licenseClient.activate(key);
  return licenseClient.broadcast(win) || status;
});
ipcMain.handle("check-update", async () => updateClient.checkUpdate());
ipcMain.handle("apply-update", async () => {
  return updateClient.applyUpdate(payload => {
    try { win && !win.isDestroyed() && win.webContents.send("update-progress", payload); } catch {}
  });
});
ipcMain.handle("data-location", () => app.getPath("userData"));
ipcMain.handle("reset-user-data", async event => {
  if (resetUserDataBusy) return { ok: false, error: "正在恢复纯净版，请稍候" };
  const parent = BrowserWindow.fromWebContents(event.sender);
  const boxOptions = {
    type: "warning",
    buttons: ["取消", "删除并恢复纯净版"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "恢复纯净版",
    message: "将删除本机全部画布用户数据，软件会恢复成刚解压时的状态。",
    detail: "会删除：画布节点、历史任务、内置浏览器账号和登录缓存、无水印素材、设置。\n不会删除：软件本身、官方豆包客户端的登录。\n此操作无法撤销。确认后软件会自动重启。"
  };
  const result = parent && !parent.isDestroyed()
    ? await dialog.showMessageBox(parent, boxOptions)
    : await dialog.showMessageBox(boxOptions);
  if (result.response !== 1) return { ok: false, cancelled: true };
  resetUserDataBusy = true;
  try {
    fs.writeFileSync(resetFlagPath(), `${Date.now()}\n`, "utf8");
  } catch (error) {
    resetUserDataBusy = false;
    return { ok: false, error: `无法写入重置标记：${error.message}` };
  }
  try { closeHiddenBrowserWindows(); } catch {}
  setTimeout(() => {
    const extra = process.argv.slice(1).filter(arg => arg !== "--reset-user-data");
    extra.push("--reset-user-data");
    try { app.relaunch({ args: extra }); } catch {}
    app.exit(0);
  }, 80);
  return { ok: true };
});
ipcMain.handle("ensure-canvas-video-preview", async (_event, src) => {
  const file = (() => {
    if (typeof src !== "string" || !src) return "";
    if (src.startsWith("file:")) {
      try { return fileURLToPath(src.split("?")[0]); } catch { return ""; }
    }
    if (/^[a-zA-Z]:[\\/]/.test(src)) return src.split("?")[0];
    return "";
  })();
  if (!file || !fs.existsSync(file)) return { ok: false, error: "视频文件不存在" };
  await ensureH264Mp4(file, message => automationLog(message, { file: path.basename(file) }));
  return { ok: true, url: pathToFileURL(file).href };
});
ipcMain.handle("open-xianyu-shop", () => shell.openExternal(XIANYU_SHOP_URL));
