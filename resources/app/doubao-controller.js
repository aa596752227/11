const SOFTWARE_SEAL = "JXPB-DB-e6b30a4c91d87f12";
void SOFTWARE_SEAL;
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { spawn } = require("child_process");
const { ensureH264Mp4 } = require("./video-compat");

const { assertRunning, currentSignal, delay, onAbort, stoppedError } = require("./task-runtime");
const { beginPreviewScript, endPreviewScript, wrongToolCloseScript, recoverPreviewScript, prepareComposerScript, previewHoverScript } = require("./page-recovery");
const { CONFIRM_REPLY, transientVideoFeedback, parameterConfirmation, confirmationChain, confirmationEditorScript, confirmationSendScript } = require("./submission-recovery");
const { readCompletedVideoSourceScript } = require("./completed-video-source");
const { readConversationMessagesScript, sameMessage, hasStableIdentity, nativeConversationKey, sameConversationUrl } = require("./message-identity");
const { runPasteProbe } = require("./prompt-paste-evidence");
const NATIVE_DOUBAO_PORT = 9705;
const NATIVE_CONTROL_MARKER = "--doubao-canvas-native=1";
const QUOTA_TEXT_PATTERN = /(?:今日|当天).{0,30}(?:免费)?(?:额度|次数).{0,20}(?:已经|已)?(?:用完|用尽|耗尽|不足)|免费(?:额度|次数).{0,20}(?:已经|已)?(?:用完|用尽|耗尽)|额度不足|请明日再试|明天再来/;
const GENERATION_FAILURE_PATTERN = /生成失败|审核未通过|未通过审核|无法生成(?:视频)?|不能生成(?:视频)?|生成异常|内容违规|涉嫌违规|疑似.{0,24}(?:侵权|违规)|侵权.{0,12}违规|违规.{0,12}侵权|无法返回该内容|违反.{0,16}(?:规范|规则|政策)|不符合.{0,16}(?:规范|规则|政策)/;
const VIDEO_READY_PATTERN = /你的视频生成好了|视频已生成|视频生成完成|已经生成好了|视频已经准备好|可以下载视频|主动发送给你|生成好啦/;
const COMPLIANCE_CONFIRM_PATTERN = /(?:请|需要|须|务必)?(?:先)?(?:确认|声明).{0,30}(?:素材|内容|图片|视频|文件).{0,30}(?:合规|版权|授权|权利|合法|使用权)|(?:素材|内容|图片|视频|文件).{0,30}(?:合规|版权|授权|权利|合法|使用权).{0,30}(?:确认|声明|继续)/;
const SUBMISSION_ACCEPTED_PATTERN = /视频生成已提交|预计等待.{0,20}分钟|视频生成好后.{0,20}(?:发送|通知)|本次生成将消耗/;
const PAID_QUOTA_CONFIRM_PATTERN = /(?:付费额度|消耗.{0,12}付费|是否继续生成|确认继续.{0,8}生成)/;
const QUOTA_NOT_DEDUCTED_PATTERN = /(?:生成)?额度未扣除|未扣除(?:生成)?额度/;
const suppressedFeedbackSignatures = new Set();
const suppressedFeedbackTexts = new Set();

function isQuotaExhaustedText(value) {
  return QUOTA_TEXT_PATTERN.test(String(value || ""));
}

function isGenerationFailureText(value) {
  return GENERATION_FAILURE_PATTERN.test(String(value || ""));
}

function isComplianceConfirmationText(value) {
  return COMPLIANCE_CONFIRM_PATTERN.test(String(value || ""));
}

function isPaidQuotaConfirmationText(value) {
  const text = String(value || "");
  return isQuotaExhaustedText(text) && PAID_QUOTA_CONFIRM_PATTERN.test(text);
}

function isQuotaNotDeductedFailureText(value) {
  return QUOTA_NOT_DEDUCTED_PATTERN.test(String(value || ""));
}

function suppressFeedback(item) {
  if (!item?.signature) return;
  suppressedFeedbackSignatures.add(item.signature);
  if (item.text) suppressedFeedbackTexts.add(String(item.text).replace(/\s+/g, " ").trim());
  while (suppressedFeedbackSignatures.size > 500) suppressedFeedbackSignatures.delete(suppressedFeedbackSignatures.values().next().value);
  while (suppressedFeedbackTexts.size > 200) suppressedFeedbackTexts.delete(suppressedFeedbackTexts.values().next().value);
}

function isSuppressedFeedback(item) {
  const text = String(item?.text || "").replace(/\s+/g, " ").trim();
  return Boolean(item?.signature && suppressedFeedbackSignatures.has(item.signature)) || Boolean(text && suppressedFeedbackTexts.has(text));
}

function clearSubmissionFeedbackSuppressions() {
  suppressedFeedbackSignatures.clear();
  suppressedFeedbackTexts.clear();
}

function profilePort() { return NATIVE_DOUBAO_PORT; }

function controllerError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function getJson(url, timeout = 2500) {
  assertRunning();
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    const detach = onAbort(() => request.destroy(stoppedError()));
    request.on("close", detach);
    request.setTimeout(timeout, () => request.destroy(new Error("timeout")));
  });
}

class CdpClient {
  constructor(url, timeout = 20000) {
    this.url = url;
    this.timeout = timeout;
    this.nextId = 0;
    this.pending = new Map();
  }

  async connect() {
    assertRunning();
    this.socket = new WebSocket(this.url);
    this.detachAbort = onAbort(() => this.close());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { detach(); reject(new Error("连接豆包页面超时")); }, 8000);
      const detach = onAbort(() => { clearTimeout(timer); reject(stoppedError()); });
      this.socket.addEventListener("open", () => { clearTimeout(timer); detach(); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timer); detach(); reject(new Error("无法连接豆包页面")); }, { once: true });
    });
    this.socket.addEventListener("message", event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.detach();
      if (message.error) waiter.reject(new Error(message.error.message || "豆包页面操作失败"));
      else waiter.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      this.closed = true;
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.detach();
        waiter.reject(new Error("豆包页面控制连接已断开"));
      }
      this.pending.clear();
    });
    await this.send("Runtime.enable");
    await this.send("Page.enable");
    try { await this.send("DOM.enable"); } catch {}
    try { await this.send("Network.enable"); } catch {}
  }

  send(method, params = {}, timeout = this.timeout) {
    assertRunning();
    if (this.closed) return Promise.reject(new Error("豆包页面控制连接已关闭"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        detach();
        reject(new Error(`豆包操作超时：${method}`));
      }, timeout);
      const detach = onAbort(() => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(stoppedError());
      });
      this.pending.set(id, { resolve, reject, timer, detach });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); detach(); this.pending.delete(id); reject(error); }
    });
  }

  async evaluate(expression, returnByValue = true, timeout = this.timeout) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue,
      userGesture: true
    }, timeout);
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
      throw new Error(description || "豆包页面脚本执行失败");
    }
    return returnByValue ? response.result.value : response.result;
  }

  close() {
    this.closed = true;
    this.detachAbort?.();
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.detach();
      waiter.reject(currentSignal()?.aborted ? stoppedError() : new Error("豆包页面控制连接已关闭"));
    }
    this.pending.clear();
    try { this.socket.close(); } catch {}
  }
}

async function listTargets(port) {
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  return targets.filter(target => target.type === "page" && target.webSocketDebuggerUrl && !String(target.url).includes("doubao-background"));
}

async function connectBestPage(port, waitMilliseconds = 45000) {
  const deadline = Date.now() + waitMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets(port);
      const candidates = [];
      for (const target of targets) {
        const client = new CdpClient(target.webSocketDebuggerUrl);
        try {
          await client.connect();
          const probe = await client.evaluate(`(() => {
            const visible=element=>{if(!element)return false;const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>2&&rect.height>2&&style.display!=='none'&&style.visibility!=='hidden'};
            const text=String(document.body?.innerText||'').replace(/\\s+/g,' ').trim();
            const videoParams=[...document.querySelectorAll('[data-input-engine-actionbar-render-entry-key="creation-video-generation-params-panel"],[data-input-engine-actionbar-render-entry-key="video-generation-params-panel"]')].filter(visible);
            const imageModels=[...document.querySelectorAll('[data-input-engine-actionbar-control-key="model"]')].filter(visible).filter(element=>/Seedream|模型/.test(String(element.innerText||element.textContent||'')));
            const editors=[...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(visible);
            const controls=[...document.querySelectorAll('button,[role="button"]')].filter(visible).map(element=>String(element.innerText||element.textContent||'').replace(/\\s+/g,' ').trim());
            const accountButton=document.querySelector('[data-testid="sidebar_bottom"] button,[data-testid="sidebar_bottom"] [role="button"]');
            const accountRect=accountButton?.getBoundingClientRect();
            const accountInViewport=!!(accountRect&&accountRect.width>2&&accountRect.height>2&&accountRect.left>=0&&accountRect.top>=0&&accountRect.right<=innerWidth&&accountRect.bottom<=innerHeight);
            const openInChat=document.querySelector('[data-testid="open-in-chat-btn"]');
            const backgroundMainReady=visible(accountButton)&&!!String(accountButton.innerText||accountButton.textContent||'').trim()&&editors.length>0&&!visible(openInChat)&&innerWidth>300&&innerHeight>300;
            return{ready:document.readyState,url:location.href,body:!!document.body,visibility:document.visibilityState,focused:document.hasFocus(),viewportWidth:innerWidth,viewportHeight:innerHeight,accountInViewport,backgroundMainReady,openInChat:visible(openInChat),workHome:/今天有什么工作要处理/.test(text),videoMode:videoParams.length>0&&editors.length>0,imageMode:imageModels.length>0&&editors.length>0,hasAiCreation:/AI ?创作/.test(text),hasVideoEntry:controls.some(control=>control==='视频生成'||control==='视频')};
          })()`, true, 8000);
          if (!probe?.body) { client.close(); continue; }
          const useful=probe.videoMode||probe.imageMode||probe.workHome||probe.hasAiCreation||probe.hasVideoEntry;
          const viewportReady=probe.viewportWidth>300&&probe.viewportHeight>300;
          const score=(probe.backgroundMainReady?4000:0)+(probe.focused&&useful?1000:0)+(probe.visibility==='visible'?200:0)+(viewportReady?250:-1800)+(probe.accountInViewport?900:0)+(probe.openInChat?360:0)+(probe.videoMode?500:0)+(probe.imageMode?500:0)+(probe.workHome?450:0)+(probe.hasVideoEntry?260:0)+(probe.hasAiCreation?80:0)+(String(target.url).includes('doubao-chat')?120:0)+(String(target.url).includes('doubao-launcher')?40:0)+(!useful&&!probe.openInChat&&String(target.url).includes('doubao-launcher')?-500:0);
          client.port = port;
          client.targetId = target.id;
          candidates.push({ client, target, probe, score });
        } catch (error) {
          lastError = error;
          client.close();
        }
      }
      if (candidates.length) {
        candidates.sort((a,b)=>b.score-a.score);
        const best=candidates[0];
        for (const candidate of candidates.slice(1)) candidate.client.close();
        return { client: best.client, target: best.target, probe: best.probe };
      }
    } catch (error) { lastError = error; }
    await delay(600);
  }
  throw new Error(lastError?.message || "豆包客户端已启动，但主页面没有准备完成");
}

async function connectPageById(port, targetId, waitMilliseconds = 8000) {
  if (!targetId) return null;
  const deadline = Date.now() + waitMilliseconds;
  while (Date.now() < deadline) {
    try {
      const target = (await listTargets(port)).find(item => item.id === targetId);
      if (target) {
        const client = new CdpClient(target.webSocketDebuggerUrl);
        await client.connect();
        client.port = port;
        client.targetId = target.id;
        return { client, target };
      }
    } catch {}
    await delay(300);
  }
  return null;
}

async function connectRecoveryPage(baseline, identity, allowRestore = true) {
  const context=baseline?.confirmationContext||baseline?.submissionContext;
  if(context&&!hasStableIdentity(context.root)&&baseline.messageState)context.previousMessages||=baseline.messageState.messages||[];
  const expectedUrl=context?.url||baseline?.url;
  if(!expectedUrl)throw new Error('原任务没有保存对话地址，不能从当前页面猜测结果');
  const targets=await listTargets(NATIVE_DOUBAO_PORT);
  // A recreated target has a new ID, and target.url may lag SPA navigation.
  // Probe only native chat pages, then verify live URL, account and task messages.
  const candidates=targets.filter(t=>sameConversationUrl(t.url,expectedUrl)||(baseline.targetId&&t.id===baseline.targetId)||nativeConversationKey(t.url));
  const verified=[],rejected=[];
  for(const target of candidates){
    let client;
    try{
      client=new CdpClient(target.webSocketDebuggerUrl);await client.connect();client.port=NATIVE_DOUBAO_PORT;client.targetId=target.id;
      await verifyTaskAccount(client,identity);
      const current=await conversationMessageState(client);
      const chain=context?confirmationChain(context,current):null;
      if(!sameConversationUrl(current.url,expectedUrl)||(context&&hasStableIdentity(context.root)&&!chain?.valid))throw new Error('对话或原任务消息不一致');
      verified.push(client);client=null;
    }catch(error){assertRunning();rejected.push({targetId:target.id,reason:error.message});}finally{client?.close();}
  }
  if(verified.length===0&&allowRestore&&!baseline.awaitingSubmissionReceipt&&context?.root?.messageId){
    try{
      const url=new URL(expectedUrl);
      if(nativeConversationKey(expectedUrl)&&/^\/chat\/\d+$/.test(url.pathname)){
        await restoreBoundResultView(baseline,identity);
        return connectRecoveryPage(baseline,identity,false);
      }
    }catch(error){rejected.push({targetId:'restore',reason:error.message});}
  }
  if(verified.length!==1){verified.forEach(c=>c.close());throw controllerError('DOUBAO_RECOVERY_NOT_FOUND','暂未找到唯一的原账号、原任务对话，正在等待视图恢复；不会重新生成或领取其他任务结果',{candidateCount:candidates.length,verifiedCount:verified.length,rejected});}
  baseline.targetId=verified[0].targetId;
  return verified[0];
}

// Restore a previously accepted task's view, never a composer or a new task.
async function restoreBoundResultView(baseline, identity) {
  const context=baseline?.confirmationContext||baseline?.submissionContext;
  if(!context?.root?.messageId||baseline.awaitingSubmissionReceipt)throw new Error('任务尚未建立正式关联，不能跨账号切走');
  const url=new URL(context.url);
  if(!nativeConversationKey(context.url)||!/^\/chat\/\d+$/.test(url.pathname))throw new Error('原任务没有可靠的正式对话地址');
  let {client}=await connectBestPage(NATIVE_DOUBAO_PORT,4000);
  try{
    client=await ensureMainChatPage(client,()=>{}, {allowWindowActivation:true});
    if(!accountIdentityMatches(await readCurrentAccountStable(client),identity)){
      const selected=await switchToAccount({client,target:identity,allowWindowActivation:true});client=selected.client;
    }
    await verifyTaskAccount(client,identity);
    if(!sameConversationUrl(await client.evaluate('location.href'),context.url)){
      await client.send('Page.navigate',{url:context.url});
    }
    const ready=await waitFor(client,async()=>{
      try{
        if(!sameConversationUrl(await client.evaluate('location.href'),context.url)||!accountIdentityMatches(await readCurrentAccount(client),identity))return false;
        return confirmationChain(context,await conversationMessageState(client)).valid;
      }catch{return false;}
    },12000,300);
    if(!ready)throw new Error('原账号、原对话或原任务消息尚未就绪，保留任务等待下一轮');
    await verifyTaskAccount(client,identity);
  }finally{client?.close();}
}

async function isPortReady(port) {
  try {
    const version = await getJson(`http://127.0.0.1:${port}/json/version`, 1000);
    return Boolean(version?.webSocketDebuggerUrl);
  } catch { return false; }
}

async function browserCommandLine(port) {
  const version = await getJson(`http://127.0.0.1:${port}/json/version`, 1500);
  if (!version?.webSocketDebuggerUrl) return [];
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      try { socket.close(); } catch {}
      reject(new Error("读取豆包启动状态超时"));
    }, 3500);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Browser.getBrowserCommandLine", params: {} })), { once: true });
    socket.addEventListener("message", event => {
      clearTimeout(timer);
      let message;
      try { message = JSON.parse(String(event.data)); } catch (error) { reject(error); return; }
      try { socket.close(); } catch {}
      if (message.error) reject(new Error(message.error.message || "无法读取豆包启动状态"));
      else resolve(Array.isArray(message.result?.arguments) ? message.result.arguments : []);
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("无法读取豆包启动状态"));
    }, { once: true });
  });
}

async function nativeControlState(port = NATIVE_DOUBAO_PORT) {
  if (!(await isPortReady(port))) return { ready: false, native: false, arguments: [] };
  try {
    const args = await browserCommandLine(port);
    return { ready: true, native: args.includes(NATIVE_CONTROL_MARKER), arguments: args };
  } catch {
    return { ready: true, native: false, arguments: [] };
  }
}

async function ensureControlledNative({ exe, progress = () => {}, log = () => {}, allowWindowActivation = true }) {
  if (!exe || path.basename(String(exe)).toLowerCase() !== "doubao.exe" || !fs.existsSync(exe) || path.resolve(exe).toLowerCase() === path.resolve(process.execPath).toLowerCase()) {
    throw controllerError("DOUBAO_PATH_INVALID", "选择的不是官方豆包 Doubao.exe，请重新选择；不要选择家兴豆包无限画布.exe");
  }
  const port = NATIVE_DOUBAO_PORT;
  let state = await nativeControlState(port);
  if (state.ready && !state.native) {
    throw controllerError("DOUBAO_RESTART_REQUIRED", "当前豆包不是由画布接管的原生窗口，需要重启一次后才能继续");
  }
  if (!state.ready) {
    if (!allowWindowActivation) throw controllerError("DOUBAO_MAIN_WINDOW_REQUIRED", "豆包尚未连接，请先点击画布顶部“切换豆包”打开主对话，登录后同步账号，再重试；本次未上传或提交");
    progress("正在连接你电脑上原来的豆包……");
    const args = [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
      "--force-renderer-accessibility",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--enable-automation",
      NATIVE_CONTROL_MARKER
    ];
    log(`启动原生豆包主窗口：${exe} ${args.join(" ")}`);
    assertRunning();
    const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    const deadline = Date.now() + 18000;
    do {
      await delay(500);
      state = await nativeControlState(port);
      if (state.native) break;
    } while (Date.now() < deadline);
    if (!state.native) {
      throw controllerError("DOUBAO_RESTART_REQUIRED", "豆包已经在普通模式运行，需要关闭后由画布重新打开一次");
    }
  }
  const page = await connectBestPage(port);
  const client = await ensureMainChatPage(page.client, progress, { allowWindowActivation });
  return { ...page, client, port };
}

// 保留旧导出名称，已有调用会自动迁移到唯一的原生豆包主窗口。
async function ensureControlledProfile(options) { return ensureControlledNative(options); }

const visibleHelpers = `
  const isVisible = element => {
    if (!element || !(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 2 && rect.height > 2 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };
  const clean = value => String(value || '').replace(/\\s+/g, ' ').trim();
`;

async function accountPageState(client) {
  return client.evaluate(`(() => {
    const visible=element=>{if(!element)return false;const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>2&&rect.height>2&&style.display!=='none'&&style.visibility!=='hidden'};
    const accountButton=document.querySelector('[data-testid="sidebar_bottom"] button,[data-testid="sidebar_bottom"] [role="button"]');
    const accountRect=accountButton?.getBoundingClientRect();
    const accountInViewport=!!(accountRect&&visible(accountButton)&&accountRect.left>=0&&accountRect.top>=0&&accountRect.right<=innerWidth&&accountRect.bottom<=innerHeight);
    const openInChat=document.querySelector('[data-testid="open-in-chat-btn"]');
    const openRect=openInChat?.getBoundingClientRect();
    const editors=[...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(visible);
    const backgroundMainReady=visible(accountButton)&&!!String(accountButton.innerText||accountButton.textContent||'').trim()&&editors.length>0&&!visible(openInChat)&&innerWidth>300&&innerHeight>300;
    return{
      width:innerWidth,
      height:innerHeight,
      accountInViewport,
      backgroundMainReady,
      openInChat:!!(openInChat&&visible(openInChat)),
      openTarget:openRect?{x:openRect.left+openRect.width/2,y:openRect.top+openRect.height/2}:null
    };
  })()`);
}

async function connectVisibleAccountPage(port, waitMilliseconds = 15000, recoverMedia = false) {
  const deadline = Date.now() + waitMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    let targets = [];
    try { targets = await listTargets(port); } catch (error) { lastError = error; }
    for (const target of targets) {
      const client = new CdpClient(target.webSocketDebuggerUrl, 8000);
      try {
        await client.connect();
        if(recoverMedia)try{await client.evaluate(prepareComposerScript)}catch{assertRunning();}
        const state = await accountPageState(client);
        if (state.accountInViewport || state.backgroundMainReady) {
          client.port = port;
          client.targetId = target.id;
          return client;
        }
      } catch (error) { lastError = error; }
      client.close();
    }
    await delay(300);
  }
  throw new Error(lastError?.message || "豆包主对话窗口没有显示");
}

async function ensureMainChatPage(client, progress = () => {}, { allowWindowActivation = true } = {}) {
  const port = client.port || NATIVE_DOUBAO_PORT;
  let state = await accountPageState(client);
  // 后台主页面可读并不要求账号按钮完全落在视口内；账号身份仍由原流程核验。
  if (state.accountInViewport || state.backgroundMainReady) return client;

  // A split media viewer can hide the sidebar account entrance too. Recover the
  // exact media tab before deciding that the main chat is missing (no foreground).
  try {
    const recovered=await client.evaluate(prepareComposerScript);
    if(recovered?.closed){state=await accountPageState(client);if(state.accountInViewport||state.backgroundMainReady)return client;}
  } catch { assertRunning(); }

  // 冷启动或账号切换时主页面会异步重建。豆包端口通常先就绪，
  // 真正的聊天页可能还要十几秒；轮询到页面出现即返回，不固定等待。
  try {
    const visibleClient = await connectVisibleAccountPage(port, 25000, true);
    try { client.close(); } catch {}
    return visibleClient;
  } catch {}

  // 自动提交不能通过“在主对话中打开”抢占前台。真正丢失主页面时交给用户恢复。
  if (!allowWindowActivation) {
    try { client.close(); } catch {}
    assertRunning();
    throw controllerError("DOUBAO_MAIN_WINDOW_REQUIRED", "豆包主对话暂不可用。请点击画布顶部“切换豆包”恢复主对话后重试；本次尚未上传或提交，不要反复点击生成");
  }

  let launcherClient = state.openInChat ? client : null;
  if (!launcherClient) {
    const deadline = Date.now() + 10000;
    while (!launcherClient && Date.now() < deadline) {
      let targets = [];
      try { targets = await listTargets(port); } catch {}
      for (const target of targets) {
        const candidate = new CdpClient(target.webSocketDebuggerUrl, 8000);
        try {
          await candidate.connect();
          candidate.port = port;
          candidate.targetId = target.id;
          const candidateState = await accountPageState(candidate);
          if (candidateState.openInChat) {
            launcherClient = candidate;
            state = candidateState;
            break;
          }
        } catch {}
        candidate.close();
      }
      if (!launcherClient) await delay(250);
    }
  }
  if (!launcherClient || !state.openTarget) {
    try { client.close(); } catch {}
    throw new Error("豆包主对话窗口当前不可见，也没有找到“在主对话中打开”按钮");
  }
  progress("正在从豆包快捷窗口打开原来的主对话……");
  await activatePageForInput(launcherClient);
  await realClick(launcherClient, state.openTarget);
  await delay(700);
  try { launcherClient.close(); } catch {}
  if (launcherClient !== client) try { client.close(); } catch {}
  return connectVisibleAccountPage(port, 20000);
}

async function pageSnapshot(client) {
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const text = clean(document.body?.innerText || '');
    const editorElements = [...document.querySelectorAll('textarea,input,[contenteditable="true"]')].filter(isVisible);
    const editors = editorElements.map(element => {
      const nestedPlaceholder=element.querySelector?.('[data-placeholder]')?.getAttribute('data-placeholder');
      return{
        tag:element.tagName,
        placeholder:clean(element.placeholder||element.getAttribute('data-placeholder')||element.getAttribute('aria-label')||nestedPlaceholder),
        value:clean(element.value??element.innerText??element.textContent),
        rect:(()=>{const r=element.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()
      };
    });
    const controls = [...document.querySelectorAll('button,[role="button"],[role="option"],label')].filter(isVisible).map(element => clean(element.innerText || element.textContent || element.getAttribute('aria-label') || element.getAttribute('title'))).filter(Boolean).slice(0,500);
    const videoParams=[...document.querySelectorAll('[data-input-engine-actionbar-render-entry-key="creation-video-generation-params-panel"],[data-input-engine-actionbar-render-entry-key="video-generation-params-panel"]')].filter(isVisible);
    const imageModels=[...document.querySelectorAll('[data-input-engine-actionbar-control-key="model"]')].filter(isVisible).filter(element=>/Seedream|模型/.test(clean(element.innerText||element.textContent)));
    const creationParams=[...document.querySelectorAll('[data-input-engine-actionbar-render-entry-key^="creation-"]')].filter(isVisible);
    return {
      url: location.href,
      title: document.title,
      text: text.slice(0,50000),
      loginRequired: /手机号登录|验证码登录|扫码登录|立即登录|登录后使用|请先登录/.test(text),
      workHome: /今天有什么工作要处理/.test(text),
      videoMode: videoParams.length>0&&editors.length>0,
      imageMode: imageModels.length>0&&editors.length>0,
      creationMode: creationParams.length>0,
      hasVideoSwitch: controls.some(control=>control==='视频'||control==='视频生成'),
      editors,
      controls
    };
  })()`);
}

function normalizeAccountIdentity(identity = {}) {
  // 豆包切号后会短暂返回 null；把“页面尚未就绪”当成空身份，
  // 交给上层等待或重试，不能在恢复已受理任务时直接崩溃。
  identity = identity || {};
  const rawAvatar = String(identity.avatarKey || "").trim();
  const stableAvatar = rawAvatar.match(/[a-f0-9]{24,}/i)?.[0]?.toLowerCase() || rawAvatar;
  return {
    name: String(identity.name || "").replace(/\s+/g, " ").trim(),
    subtitle: String(identity.subtitle || "").trim().split(/\s+/).filter(part => !/^(专业版|免费版|企业版|个人版|会员)$/.test(part)).join(" "),
    avatarKey: stableAvatar,
    avatarShared: Boolean(identity.avatarShared)
  };
}

function accountIdentityMatches(left, right) {
  const a = normalizeAccountIdentity(left);
  const b = normalizeAccountIdentity(right);
  // Avatars (including the default image) and plan labels are not account IDs.
  // Never let an avatar match override different account names. Same-name rows
  // are preserved below and rejected as ambiguous before any account click.
  return Boolean(a.name && b.name && a.name === b.name);
}

function mergeAccountIdentities(existing = [], discovered = []) {
  const merged = Array.isArray(existing) ? existing.slice() : [];
  for (const account of Array.isArray(discovered) ? discovered : []) {
    if (!account?.name || merged.some(item => item.name === account.name && item.subtitle === account.subtitle && item.avatarKey === account.avatarKey && item.rowKey === account.rowKey)) continue;
    merged.push(account);
  }
  return merged;
}

async function readCurrentAccount(client) {
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const avatarKey = source => {
      const value = String(source || '');
      return value.match(/[a-f0-9]{24,}/i)?.[0]?.toLowerCase() || (() => { try { return new URL(value, location.href).pathname; } catch { return value.split('?')[0]; } })();
    };
    const bottom = document.querySelector('[data-testid="sidebar_bottom"]');
    if (!bottom || !isVisible(bottom)) return null;
    const buttons = [...bottom.querySelectorAll('button,[role="button"]')].filter(isVisible);
    const button = buttons.find(element => element.querySelector('img[alt="avatar"],img'))
      || buttons.find(element => clean(element.innerText || element.textContent))
      || bottom;
    const lines = String(button.innerText || button.textContent || '').split(/\\n+/).map(clean).filter(Boolean);
    const image = button.querySelector('img[alt="avatar"],img') || bottom.querySelector('img[alt="avatar"],img');
    const leafTexts = [...button.querySelectorAll('div,span')].filter(isVisible).filter(element => !element.querySelector('div,span')).map(element => clean(element.innerText || element.textContent)).filter(Boolean);
    const nameElement = [...button.querySelectorAll('div,span')].filter(isVisible).find(element => {
      const value = clean(element.innerText || element.textContent);
      return value && !/专业版|免费版|会员|企业版|个人版/.test(value) && !element.querySelector('div,span');
    });
    const name = clean(nameElement?.innerText || nameElement?.textContent || lines[0]);
    const subtitle = leafTexts.filter(value => value !== name && /专业版|免费版|会员|企业版|个人版/.test(value)).join(' ') || lines.filter(value => value !== name).join(' ');
    if (!name) return null;
    return { name, subtitle, avatarKey: avatarKey(image?.src), display: [name, subtitle].filter(Boolean).join(' · ') };
  })()`);
}

async function readCurrentAccountStable(client, attempts = 3) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const current = await readCurrentAccount(client);
      if (current) {
        if (last && accountIdentityMatches(last, current)) return current;
        last = current;
      }
    } catch {}
    if (attempt + 1 < attempts) await delay(220);
  }
  return last;
}

// Radix keeps closing menus mounted during the exit animation, including while
// a background window is not painting. Dimensions alone do NOT mean open.
const accountDomHelpers = `
  ${visibleHelpers}
  const accountVisible = element => {
    if (!isVisible(element)) return false;
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
      if (current.getAttribute('role') === 'menu' && current.getAttribute('data-state') === 'closed') return false;
    }
    return true;
  };
  const accountMenus = () => [...document.querySelectorAll('[role="menu"]')].filter(menu => accountVisible(menu) && menu.getAttribute('data-state') === 'open' && clean(menu.innerText || menu.textContent).includes('添加账号'));
  const accountRowForImage = (image, menu) => {
    const imageRect = image?.getBoundingClientRect();
    if (!imageRect || imageRect.width < 24 || imageRect.height < 24) return null;
    for (let row = image.parentElement; row && row !== menu; row = row.parentElement) {
      if (!accountVisible(row)) continue;
      const rect = row.getBoundingClientRect();
      const text = clean(row.innerText || row.textContent);
      const images = row.querySelectorAll('img[alt="avatar"],img');
      if (text && images.length === 1 && rect.width >= 100 && rect.height >= 40 && rect.height <= 92
        && !/添加账号|退出登录|切换账号|设置|帮助与反馈|额度状态/.test(text)) return row;
    }
    return null;
  };
  const profileAccountMenu = () => [...document.querySelectorAll('[data-testid="chat_header_menu"],[role="menu"]')].find(menu => accountVisible(menu) && menu.getAttribute('data-state') === 'open' && [...menu.querySelectorAll('[role="menuitem"],button,[role="button"],div')].some(item => accountVisible(item) && clean(item.innerText || item.textContent) === '切换账号'));
`;

async function openAccountSwitcher(client, attempt = 0) {
  assertRunning();
  if (attempt > 3) throw controllerError('DOUBAO_ACCOUNT_MENU_NOT_OPEN', '账号菜单没有稳定展开，本次未切换或提交，请重试');
  await activatePageForInput(client);
  const state = await client.evaluate(`(() => {
    ${accountDomHelpers}
    const switcher = accountMenus()[0];
    if (switcher) return { stage: 'already' };
    const menu = profileAccountMenu();
    if (!menu) {
      const bottom = document.querySelector('[data-testid="sidebar_bottom"]');
      const buttons = [...(bottom?.querySelectorAll('button,[role="button"]') || [])].filter(accountVisible);
      const button = buttons.find(element => element.querySelector('img[alt="avatar"],img'))
        || buttons.find(element => clean(element.innerText || element.textContent));
      if (!button) return { stage: 'missing-profile-button' };
      const rect = button.getBoundingClientRect();
      const x=rect.left+rect.width/2,y=rect.top+rect.height/2,top=document.elementFromPoint(x,y);
      if(!top||!(top===button||button.contains(top)))return {stage:'blocked-profile-button'};
      return { stage: 'profile-button', x, y };
    }
    const item = [...menu.querySelectorAll('[role="menuitem"],button,[role="button"],div')].filter(accountVisible).find(element => clean(element.innerText || element.textContent) === '切换账号');
    const target = item?.closest('[role="menuitem"],button,[role="button"]') || item;
    if (!target) return { stage: 'missing-switch-item' };
    const rect = target.getBoundingClientRect();
    return { stage: 'switch-entry', x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (state.stage === "missing-profile-button") throw new Error("豆包页面中没有找到当前账号入口");
  if (state.stage === 'blocked-profile-button') throw controllerError('DOUBAO_ACCOUNT_ENTRY_BLOCKED','豆包账号入口被其他面板遮挡或不在可点击区域，未切号、未提交；请关闭遮挡面板后重试');
  if (state.stage === "missing-switch-item") throw new Error("豆包账号菜单中没有找到“切换账号”");
  if (state.stage === "profile-button") {
    await realClick(client, state);
    const ready = await waitFor(client, async () => {
      const ready = await client.evaluate(`(() => {
        ${accountDomHelpers}
        return !!profileAccountMenu() || accountMenus().length>0;
      })()`);
      return ready || null;
    }, 5000, 120);
    if (!ready) {
      if(attempt>=2)throw controllerError('DOUBAO_ACCOUNT_MENU_NOT_OPEN','点击豆包账号入口后菜单仍未打开，本次未提交；请检查遮挡面板或客户端响应');
      await delay(250);
    }
    return openAccountSwitcher(client, attempt + 1);
  }
  if (state.stage === "already") return;
  const submenuVisible = async () => client.evaluate(`(() => {
    ${accountDomHelpers}
    return accountMenus().length > 0;
  })()`);
  if (state.stage === "switch-entry") {
    // 豆包的“切换账号”是悬停式子菜单触发器。CDP 的真实鼠标移动会触发
    // React/Radix 的 pointerenter；单纯 element.click() 不会可靠地打开它。
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: state.x, y: state.y });
    let ready = await waitFor(client, async () => (await submenuVisible()) || null, 1800, 100);
    if (!ready) {
      await realClick(client, state);
      ready = await waitFor(client, async () => (await submenuVisible()) || null, 3500, 100);
    }
    if (!ready) throw new Error("豆包账号切换列表没有打开");
    // 等待弹出动画结束；动画期间 DOM 已可见，但命中测试仍可能落到聊天内容上。
    await delay(320);
  }
}

async function accountSwitcherRows(client) {
  return client.evaluate(`(() => {
    ${accountDomHelpers}
    const avatarKey = source => {
      const value = String(source || '');
      return value.match(/[a-f0-9]{24,}/i)?.[0]?.toLowerCase() || (() => { try { return new URL(value, location.href).pathname; } catch { return value.split('?')[0]; } })();
    };
    const menus = accountMenus();
    const menu = menus.sort((a,b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).at(-1);
    if (!menu) return [];
    const rowElements = new Set();
    const rows = [...menu.querySelectorAll('img[alt="avatar"],img')].map((image, index) => {
      const row = accountRowForImage(image, menu);
      if (!row || row === menu || !accountVisible(row)) return null;
      if (rowElements.has(row)) return null;
      rowElements.add(row);
      const lines = String(row.innerText || row.textContent || '').split(/\\n+/).map(clean).filter(Boolean);
      const name = lines[0] || '';
      const subtitle = lines.slice(1).join(' ');
      const rect = row.getBoundingClientRect();
      const rowKey = row.getAttribute('data-account-id') || row.getAttribute('data-user-id') || row.id || String(index);
      return { name, subtitle, rowKey, avatarKey: avatarKey(image.src), display: [name, subtitle].filter(Boolean).join(' · '), x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }).filter(Boolean);
    const avatarCounts = new Map();
    for (const row of rows) if (row.avatarKey) avatarCounts.set(row.avatarKey, (avatarCounts.get(row.avatarKey) || 0) + 1);
    for (const row of rows) row.avatarShared = Boolean(row.avatarKey && avatarCounts.get(row.avatarKey) > 1);
    return rows;
  })()`);
}

async function scrollAccountSwitcher(client, mode = "next") {
  return client.evaluate(`(() => {
    ${accountDomHelpers}
    const mode = ${JSON.stringify(mode)};
    const menus = accountMenus();
    const menu = menus.sort((a,b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).at(-1);
    if (!menu) return { found: false, moved: false };
    const candidates = [menu, ...menu.querySelectorAll('*')]
      .filter(isVisible)
      .filter(element => element.scrollHeight > element.clientHeight + 4)
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    const scroller = candidates[0];
    if (!scroller) return { found: true, moved: false, top: 0, max: 0 };
    const before = Number(scroller.scrollTop || 0);
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const next = mode === 'start' ? 0 : Math.min(max, before + Math.max(120, Math.floor(scroller.clientHeight * .78)));
    scroller.scrollTop = next;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    return { found: true, moved: Math.abs(Number(scroller.scrollTop || 0) - before) > 2, top: Number(scroller.scrollTop || 0), max };
  })()`);
}

async function closeAccountMenus(client) {
  for (let index = 0; index < 2; index++) {
    try {
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await delay(80);
    } catch {}
  }
}

async function listAvailableAccounts(client, { keepOpen = false } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    let accounts = [];
    try {
      if (attempt) {
        await closeAccountMenus(client);
        await delay(350 + attempt * 250);
      }
      await openAccountSwitcher(client);
      await scrollAccountSwitcher(client, "start");
      await delay(220);
      for (let pass = 0; pass < 48; pass++) {
        const rows = await waitFor(client, async () => {
          const found = await accountSwitcherRows(client);
          return found.length ? found : null;
        }, pass === 0 ? 5000 + attempt * 1500 : 1600, 120);
        accounts = mergeAccountIdentities(accounts, rows);
        const scroll = await scrollAccountSwitcher(client, "next");
        if (!scroll.found || !scroll.moved) break;
        await delay(180);
      }
      if (accounts.length) {
        if (!keepOpen) await closeAccountMenus(client);
        return accounts.map(({ x, y, ...identity }) => identity);
      }
      lastError = new Error("账号菜单已打开，但账号行仍在加载");
    } catch (error) {
      lastError = error;
    }
  }
  await closeAccountMenus(client);
  throw controllerError("DOUBAO_ACCOUNT_LIST_READ_FAILED", `豆包账号列表暂未就绪：${lastError?.message || "没有读取到已登录账号"}；请稍候后重试`);
}

async function waitForAccountPage(port, wanted, timeout = 15000) {
  const deadline = Date.now() + timeout;
  const observedNames = new Set();
  while (Date.now() < deadline) {
    assertRunning();
    let targets = [];
    try { targets = await listTargets(port); } catch { assertRunning(); }
    for (const target of targets.filter(item => /doubao-chat/.test(item.url || ''))) {
      const candidate = new CdpClient(target.webSocketDebuggerUrl, 2500);
      let keep = false;
      try {
        await candidate.connect();
        candidate.port = port;
        candidate.targetId = target.id;
        // Account identity remains readable when Doubao rebuilds a hidden main
        // window with a temporary 0x0 viewport. Composer readiness is checked
        // separately; do not mistake window size for a failed account switch.
        const identity = await readCurrentAccount(candidate);
        if (identity?.name) observedNames.add(identity.name);
        if (!accountIdentityMatches(identity, wanted)) continue;
        await delay(180);
        const stable = await readCurrentAccount(candidate);
        if (!accountIdentityMatches(stable, wanted)) continue;
        keep = true;
        return { client: candidate, current: stable };
      } catch { assertRunning(); }
      finally { if (!keep) candidate.close(); }
    }
    await delay(250);
  }
  throw controllerError('DOUBAO_ACCOUNT_VERIFY_FAILED', `未确认豆包切换到“${wanted.name}”（读取到：${[...observedNames].join('、') || '账号页面未就绪'}），任务未上传或提交`);
}

async function switchToAccount({ client, target, progress = () => {}, allowWindowActivation = true }) {
  client = await ensureMainChatPage(client, progress, { allowWindowActivation });
  const wanted = normalizeAccountIdentity(target);
  if (!wanted.name) throw controllerError("DOUBAO_ACCOUNT_UNBOUND", "画布账号尚未绑定豆包中的真实账号");
  const current = await readCurrentAccountStable(client);
  progress(`正在核对豆包账号列表，目标账号：“${wanted.name}”……`);
  // Keep the validated menu open. Closing/reopening used to reuse Radix's
  // outgoing menu and click its stale position in the chat underneath.
  const available = await listAvailableAccounts(client, { keepOpen: true });
  const matches = available.filter(row => accountIdentityMatches(row, wanted));
  if (matches.length !== 1) {
    await closeAccountMenus(client);
    if (!matches.length) throw controllerError("DOUBAO_ACCOUNT_NOT_FOUND", `豆包切换列表中没有找到“${wanted.name}”，请先在官方豆包中登录该账号`);
    throw controllerError("DOUBAO_ACCOUNT_AMBIGUOUS", `豆包中存在多个无法区分的“${wanted.name}”，请重新同步账号列表`);
  }
  if (accountIdentityMatches(current, wanted)) {
    await closeAccountMenus(client);
    return { client, current, switched: false };
  }
  progress(`账号列表已展开，正在定位“${wanted.name}”……`);
  await openAccountSwitcher(client);
  await scrollAccountSwitcher(client, "start");
  let targetRow = null;
  for (let pass = 0; pass < 48; pass++) {
    await delay(140);
    const rows = await waitFor(client, async () => {
      const values = await accountSwitcherRows(client);
      return values.length ? values : null;
    }, 2200, 120);
    const visibleMatches = (rows || []).filter(row => accountIdentityMatches(row, wanted));
    if (visibleMatches.length > 1) throw controllerError("DOUBAO_ACCOUNT_AMBIGUOUS", "账号列表存在同名身份，已停止切换");
    if (visibleMatches.length === 1) { targetRow = visibleMatches[0]; break; }
    const scroll = await scrollAccountSwitcher(client, "next");
    if (!scroll.found || !scroll.moved) break;
  }
  if (!targetRow) { await closeAccountMenus(client); throw controllerError("DOUBAO_ACCOUNT_NOT_FOUND", "账号菜单未能稳定定位目标账号，任务未上传或提交，请重试"); }
  // Hover can close a submenu or finish an outgoing animation. Recheck the
  // exact hit after movement, before pressing; never click the chat underneath.
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: targetRow.x, y: targetRow.y, buttons: 0, pointerType: 'mouse' });
  await delay(90);
  const hitValid = await client.evaluate(`(() => {
    ${accountDomHelpers}
    const x = ${JSON.stringify(targetRow.x)};
    const y = ${JSON.stringify(targetRow.y)};
    let element = document.elementFromPoint(x, y);
    const menu = element?.closest('[role="menu"]');
    if (!menu || !accountMenus().includes(menu)) return false;
    while (element && element !== document.body) {
      const rect = element.getBoundingClientRect();
      const text = clean(element.innerText || element.textContent);
      if (text && rect.width >= 100 && rect.height >= 40 && rect.height <= 92) break;
      element = element.parentElement;
    }
    if (!element || element === document.body || !accountVisible(element)) return false;
    const name = String(element.innerText || element.textContent || '').split(/\\n+/).map(clean).filter(Boolean)[0];
    return name === ${JSON.stringify(wanted.name)};
  })()`);
  if (!hitValid) {
    await closeAccountMenus(client);
    throw controllerError("DOUBAO_ACCOUNT_CLICK_TARGET_LOST", `豆包账号列表发生变化，没有安全点中“${wanted.name}”，请重试`);
  }
  assertRunning();
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: targetRow.x, y: targetRow.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  try { await delay(60); }
  finally { await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: targetRow.x, y: targetRow.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' }); }
  progress(`已点击账号“${wanted.name}”，正在核验豆包实际账号……`);
  // Re-enumerate during the whole verification window, not just once while
  // the old renderer is still present. Never select a page merely by its score.
  await delay(350);
  const port = client.port || NATIVE_DOUBAO_PORT;
  try { client.close(); } catch {}
  const verified = await waitForAccountPage(port, wanted);
  progress(`已确认豆包当前账号：${verified.current.name}`);
  return { ...verified, switched: true };
}

async function findClickable(client, texts, options = {}) {
  const wanted = texts.map(text => String(text));
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const wanted = ${JSON.stringify(wanted)}.map(clean);
    const options = ${JSON.stringify(options)};
    const all = [...document.querySelectorAll('button,[role="button"],[role="tab"],[role="option"],label,a,span,div')].filter(isVisible);
    const matches = [];
    for (const source of all) {
      const ownText = clean(source.innerText || source.textContent || source.getAttribute('aria-label') || source.getAttribute('title'));
      const matched = wanted.find(value => options.contains ? ownText.includes(value) : ownText === value);
      if (!matched) continue;
      const element = source.closest('button,[role="button"],[role="tab"],[role="option"],label,a') || source;
      if (!isVisible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width > innerWidth * .9 && rect.height > innerHeight * .5) continue;
      let score = options.contains ? 20 : 100;
      if (['BUTTON','A','LABEL'].includes(element.tagName) || element.getAttribute('role')) score += 30;
      score += Math.max(0, 20 - Math.log10(Math.max(1, rect.width * rect.height)) * 4);
      if (options.preferBottom) score += rect.top / innerHeight * 30;
      if (options.preferLeft) score += (1 - rect.left / innerWidth) * 20;
      if (options.minYRatio && rect.top < innerHeight * options.minYRatio) score -= 80;
      matches.push({score,text:ownText,tag:element.tagName,x:rect.left+rect.width/2,y:rect.top+rect.height/2,width:rect.width,height:rect.height});
    }
    matches.sort((a,b) => b.score-a.score);
    return matches[0] || null;
  })()`);
}

async function realClick(client, target) {
  if (!target) return false;
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y, buttons: 0, pointerType: "mouse" });
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
  await delay(60);
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
  return true;
}

async function activatePageForInput(client) {
  assertRunning();
  // CDP input does not require stealing desktop focus. Keep a diagnostic opt-in fallback.
  if (process.env.META_CANVAS_FOREGROUND_INPUT === "1") {
    await client.send("Page.bringToFront");
    await client.evaluate("window.focus(); true");
  }
}

async function clickText(client, texts, options = {}) {
  const target = await findClickable(client, texts, options);
  if (!target) return null;
  await realClick(client, target);
  return target;
}

async function clickMatching(client, patternSource, options = {}) {
  const flags = options.flags || "i";
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const pattern = new RegExp(${JSON.stringify(patternSource)}, ${JSON.stringify(flags)});
    const options = ${JSON.stringify(options)};
    const list = [...document.querySelectorAll('button,[role="button"],[role="tab"],[role="option"],label,a,span,div')].filter(isVisible);
    const found=[];
    for(const source of list){
      const text=clean(source.innerText||source.textContent||source.getAttribute('aria-label')||source.getAttribute('title'));
      if(!pattern.test(text)) continue;
      const element=source.closest('button,[role="button"],[role="tab"],[role="option"],label,a')||source;
      const r=element.getBoundingClientRect(); if(!isVisible(element)||r.width>innerWidth*.9||r.height>innerHeight*.5)continue;
      let score=30+(element.tagName==='BUTTON'||element.getAttribute('role')?30:0)-Math.log10(Math.max(1,r.width*r.height))*4;
      if(options.preferBottom)score+=r.top/innerHeight*30;
      found.push({score,text,x:r.left+r.width/2,y:r.top+r.height/2,width:r.width,height:r.height});
    }
    found.sort((a,b)=>b.score-a.score); return found[0]||null;
  })()`);
}

async function realClickMatching(client, patternSource, options = {}) {
  const target = await clickMatching(client, patternSource, options);
  if (!target) return null;
  await realClick(client, target);
  return target;
}

async function waitFor(client, predicate, timeout = 15000, interval = 400) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    assertRunning();
    try { value = await predicate(); if (value) return value; }
    catch (error) { if (error.code === "DOUBAO_TASK_STOPPED") throw error; assertRunning(); }
    await delay(interval);
  }
  return null;
}

async function captureStage(client, folder, name) {
  assertRunning();
  // Keep receipt/failure evidence; routine PNG capture is opt-in, not on the hot path.
  if (!folder || (process.env.META_CANVAS_TRACE_SCREENSHOTS !== "1" && !/失败|无法|未接受|最终检查/.test(name))) return "";
  try {
    fs.mkdirSync(folder, { recursive: true });
    const response = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }, 5000);
    const file = path.join(folder, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(response.data, "base64"));
    return file;
  } catch { return ""; }
}

async function refreshControlledPage(client, waitMilliseconds = 10000) {
  if (!client?.port) return client;
  await delay(600);
  const next = await connectBestPage(client.port, waitMilliseconds);
  client.close();
  return next.client;
}

async function prepareComposerRecovery(client) {
  let result=await client.evaluate(prepareComposerScript);
  if(result?.blocked){
    const hover=await client.evaluate(previewHoverScript);
    if(hover){
      await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:hover.x,y:hover.y});
      result=await waitFor(client,async()=>{const next=await client.evaluate(prepareComposerScript);return !next?.blocked?next:null;},1800,150)||result;
    }
  }
  return result;
}

async function ensureVideoComposer(client, progress, folder) {
  let activeClient = client;
  const previewRecovery = await prepareComposerRecovery(activeClient);
  if(previewRecovery?.closed) progress("正在收起媒体预览侧栏，恢复视频编辑区……");
  if(previewRecovery?.blocked)throw controllerError("DOUBAO_PREVIEW_RECOVERY_REQUIRED","检测到媒体预览，但无法唯一确定关闭按钮；请关闭右侧“图片与视频”标签后重试，本次未上传");
  if(previewRecovery?.remaining){
    const recovered=await waitFor(activeClient,async()=>{const result=await activeClient.evaluate(recoverPreviewScript);return !result?.remaining},1500,150);
    if(!recovered)throw controllerError("DOUBAO_PREVIEW_RECOVERY_REQUIRED","上次回填打开的“图片与视频”侧栏尚未关闭，请关闭该标签后重试；不会重新生成已完成的视频");
  }
  const wrongTool = await activeClient.evaluate(wrongToolCloseScript);
  if (wrongTool?.blocked) throw controllerError("DOUBAO_TOOL_RECOVERY_REQUIRED", "豆包处于解题答疑，但未识别到安全的关闭工具按钮；请退出该工具后重试，任务未提交");
  if (wrongTool) {
    progress("正在退出解题答疑工具并恢复视频生成入口……");
    await realClick(activeClient, wrongTool);
    const recovered = await waitFor(activeClient, async () => !(await activeClient.evaluate(wrongToolCloseScript)), 3000, 120);
    if (!recovered) throw controllerError("DOUBAO_TOOL_RECOVERY_REQUIRED", "未能退出解题答疑工具，任务未提交");
  }
  let snapshot = await pageSnapshot(activeClient);
  if(!snapshot.loginRequired&&!snapshot.videoMode&&!snapshot.creationMode&&!snapshot.workHome&&!snapshot.editors?.length){
    progress('豆包界面正在加载，等待编辑区就绪；尚未上传任何内容……');
    snapshot=await waitFor(activeClient,async()=>{const next=await pageSnapshot(activeClient);return next.loginRequired||next.videoMode||next.creationMode||next.workHome||next.editors?.length?next:null;},8000,250)||snapshot;
  }
  if (snapshot.loginRequired) return { needLogin: true, snapshot };

  if (snapshot.workHome) {
    progress("豆包当前在工作首页，正在检查直接的“视频生成”入口……");
    const directVideo = await findClickable(activeClient, ["视频生成"], { preferBottom: true });
    if (directVideo) {
      progress("正在打开豆包视频生成……");
      await realClick(activeClient, directVideo);
      activeClient = await refreshControlledPage(activeClient);
      snapshot = await waitFor(activeClient, async () => {
        const current = await pageSnapshot(activeClient);
        return current.videoMode || current.creationMode ? current : null;
      }, 15000, 300) || await pageSnapshot(activeClient);
    }

    if (!snapshot.videoMode && !snapshot.creationMode) {
      progress("直接入口不可用，正在切换到对话……");
      const dialogue = await findClickable(activeClient, ["对话"], {});
      if (!dialogue) throw new Error("豆包工作首页中没有找到“对话”切换按钮");
      await realClick(activeClient, dialogue);
      activeClient = await refreshControlledPage(activeClient);
      snapshot = await waitFor(activeClient, async () => {
        const current = await pageSnapshot(activeClient);
        return !current.workHome ? current : null;
      }, 15000, 300);
      if (!snapshot) throw new Error("点击“对话”后豆包仍停留在工作首页");
    }
  }

  if (!snapshot.videoMode && !snapshot.creationMode) {
    const videoGeneration = await waitFor(activeClient,()=>findClickable(activeClient, ["视频生成"], { preferBottom: true }),2500,200);
    if (videoGeneration) {
      progress("正在打开豆包视频生成……");
      await realClick(activeClient, videoGeneration);
      activeClient = await refreshControlledPage(activeClient);
      snapshot = await waitFor(activeClient, async () => {
        const current = await pageSnapshot(activeClient);
        return current.videoMode || current.creationMode ? current : null;
      }, 15000, 300) || await pageSnapshot(activeClient);
    }
  }

  if (!snapshot.videoMode && !snapshot.creationMode) {
    progress("当前界面没有直接入口，正在通过“更多”查找视频生成……");
    const more = await findClickable(activeClient, ["更多"], { preferBottom: true });
    if (more) {
      await realClick(activeClient, more);
      await delay(350);
      const videoInMore = await waitFor(activeClient, () => findClickable(activeClient, ["视频生成"], { preferBottom: true }), 5000, 180);
      if (videoInMore) {
        progress("已在“更多”中找到视频生成，正在打开……");
        await realClick(activeClient, videoInMore);
        activeClient = await refreshControlledPage(activeClient);
        snapshot = await waitFor(activeClient, async () => {
          const current = await pageSnapshot(activeClient);
          return current.videoMode || current.creationMode ? current : null;
        }, 15000, 300) || await pageSnapshot(activeClient);
      }
    }
  }

  if (!snapshot.videoMode && !snapshot.creationMode) {
    progress("正在进入豆包 AI 创作……");
    const clicked = await clickText(activeClient, ["AI创作", "AI 创作"], { preferLeft: true });
    if (!clicked) throw controllerError("DOUBAO_VIDEO_ENTRY_UNAVAILABLE","当前豆包界面尚未提供可核验的视频生成入口，未上传、未提交。请检查账号的视频生成入口是否可用后再试");
    activeClient = await refreshControlledPage(activeClient);
    snapshot = await waitFor(activeClient, async () => {
      const current = await pageSnapshot(activeClient);
      return current.loginRequired || current.videoMode || current.creationMode || current.hasVideoSwitch ? current : null;
    }, 15000, 300);
    if (!snapshot) throw new Error("点击“AI 创作”后页面没有完成加载");
    if (snapshot.loginRequired) return { needLogin: true, snapshot };
  }
  if (!snapshot.videoMode) {
    progress("正在切换到视频生成……");
    const target = await waitFor(activeClient, async () => {
      return await findClickable(activeClient, ["视频", "视频生成"], { preferBottom: true });
    }, 15000, 300);
    if (!target) throw new Error("豆包 AI 创作页面中没有找到“视频”切换入口");
    await realClick(activeClient, target);
    activeClient = await refreshControlledPage(activeClient);
    snapshot = await waitFor(activeClient, async () => {
      const current = await pageSnapshot(activeClient);
      return current.videoMode ? current : null;
    }, 15000);
    if (!snapshot) {
      await captureStage(activeClient, folder, "01-无法进入视频模式");
      throw new Error("豆包没有进入视频生成模式，诊断截图已经保存");
    }
  }
  await captureStage(activeClient, folder, "01-视频模式");
  return { needLogin: false, snapshot, client: activeClient };
}

async function findImageModeEntry(client) {
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const exact=document.querySelector('[data-testid="skill_bar_button_3"]');
    const candidates=[exact,...document.querySelectorAll('button,[role="button"],[role="tab"]')].filter(Boolean).filter(isVisible);
    const element=candidates.find(item=>item===exact)||candidates.find(item=>/^(图片生成|生成图片|图片)$/.test(clean(item.innerText||item.textContent||item.getAttribute('aria-label')||item.getAttribute('title'))));
    if(!element)return null;
    const rect=element.getBoundingClientRect();
    return{x:rect.left+rect.width/2,y:rect.top+rect.height/2,width:rect.width,height:rect.height,text:clean(element.innerText||element.textContent)};
  })()`);
}

async function ensureImageComposer(client, progress, folder) {
  let activeClient = client;
  let snapshot = await pageSnapshot(activeClient);
  if (snapshot.loginRequired) return { needLogin: true, snapshot };
  if (!snapshot.imageMode) {
    progress("正在进入豆包图片生成……");
    let target = await findImageModeEntry(activeClient);
    if (!target && snapshot.workHome) {
      const dialogue = await findClickable(activeClient, ["对话"], {});
      if (dialogue) {
        await realClick(activeClient, dialogue);
        activeClient = await refreshControlledPage(activeClient);
        snapshot = await waitFor(activeClient, () => pageSnapshot(activeClient), 12000, 300) || await pageSnapshot(activeClient);
        target = await findImageModeEntry(activeClient);
      }
    }
    if (!target) {
      const aiCreation = await findClickable(activeClient, ["AI创作", "AI 创作"], { preferLeft: true });
      if (aiCreation) {
        await realClick(activeClient, aiCreation);
        activeClient = await refreshControlledPage(activeClient);
        await delay(500);
        target = await findImageModeEntry(activeClient);
      }
    }
    if (!target) throw new Error("豆包页面中没有找到“图片生成”入口");
    await activatePageForInput(activeClient);
    await realClick(activeClient, target);
    snapshot = await waitFor(activeClient, async () => {
      const current = await pageSnapshot(activeClient);
      return current.imageMode ? current : null;
    }, 15000, 250);
    if (!snapshot) {
      await captureStage(activeClient, folder, "01-无法进入图片模式");
      throw new Error("豆包没有进入图片生成模式，诊断截图已经保存");
    }
  }
  await captureStage(activeClient, folder, "01-图片模式");
  return { needLogin: false, snapshot, client: activeClient };
}

async function findImagePromptEditor(client) {
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const model=[...document.querySelectorAll('[data-input-engine-actionbar-control-key="model"]')].filter(isVisible).find(element=>/Seedream|模型/.test(clean(element.innerText||element.textContent)));
    if(!model)return null;
    const editors=[...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(isVisible);
    const scored=editors.map((element,index)=>{
      const nested=element.querySelector?.('[data-placeholder]')?.getAttribute('data-placeholder');
      const hint=clean(element.placeholder||element.getAttribute('data-placeholder')||element.getAttribute('aria-label')||nested);
      const rect=element.getBoundingClientRect();
      return{element,score:(/图片|画面|描述|想要|生成/.test(hint)?100:0)+rect.top/innerHeight*25+index/100};
    }).sort((a,b)=>b.score-a.score);
    return scored[0]?.element||null;
  })()`, false);
}

async function fillImagePrompt(client, prompt, progress, folder) {
  progress("正在填写并核对图片提示词……");
  const editor = await findImagePromptEditor(client);
  if (!editor?.objectId) throw new Error("豆包图片页面中没有找到提示词输入框");
  const response = await client.send("Runtime.callFunctionOn", {
    objectId: editor.objectId,
    functionDeclaration: `function(value){
      this.focus();
      if(this instanceof HTMLTextAreaElement||this instanceof HTMLInputElement){
        const proto=this instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto,'value').set.call(this,value);
      }else this.replaceChildren(document.createTextNode(value));
      try{this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));}catch{this.dispatchEvent(new Event('input',{bubbles:true}));}
      this.dispatchEvent(new Event('change',{bubbles:true}));
      return this.value??this.innerText??this.textContent??'';
    }`,
    arguments: [{ value: prompt }], returnByValue: true, userGesture: true
  });
  if (normalizePromptReadback(response.result.value) !== normalizePromptReadback(prompt)) {
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
    await client.send("Input.insertText", { text: prompt });
  }
  await delay(350);
  const verified = await readImagePrompt(client);
  if (normalizePromptReadback(verified) !== normalizePromptReadback(prompt)) throw new Error("图片提示词写入后被豆包页面清除或截断");
  await captureStage(client, folder, "02-图片提示词已填写");
  return true;
}

async function readImagePrompt(client) {
  const editor = await findImagePromptEditor(client);
  if (!editor?.objectId) return "";
  const response = await client.send("Runtime.callFunctionOn", {
    objectId: editor.objectId,
    functionDeclaration: "function(){return this.value??this.innerText??this.textContent??''}",
    returnByValue: true
  });
  return String(response.result.value || "");
}

async function findImageControl(client, key) {
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const key=${JSON.stringify(String(key))};
    let candidates=[];
    if(key==='model')candidates=[...document.querySelectorAll('[data-input-engine-actionbar-control-key="model"]')];
    else candidates=[...document.querySelectorAll('button,[role="button"]')].filter(element=>/^比例\\s*(自动|9:16|2:3|3:4|1:1|4:3|3:2|16:9)$/.test(clean(element.innerText||element.textContent)));
    const element=candidates.filter(isVisible)[0];
    if(!element)return null;
    const rect=element.getBoundingClientRect();
    return{text:clean(element.innerText||element.textContent),state:element.getAttribute('data-state')||'',expanded:element.getAttribute('aria-expanded')||'',x:rect.left+rect.width/2,y:rect.top+rect.height/2,width:rect.width,height:rect.height};
  })()`);
}

async function closeImageOptionMenu(client) {
  const open = await client.evaluate(`(() => {
    ${visibleHelpers}
    return [...document.querySelectorAll('[role="menu"],[role="listbox"],[data-slot="dropdown-menu-content"]')].some(isVisible);
  })()`);
  if (!open) return false;
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await delay(120);
  return true;
}

async function findOpenMenuOption(client, value) {
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const wanted=${JSON.stringify(String(value))};
    const roots=[...document.querySelectorAll('[role="menu"],[role="listbox"],[data-radix-menu-content],[data-slot="dropdown-menu-content"]')].filter(isVisible);
    const scope=roots[roots.length-1]||document.body;
    const candidates=[...scope.querySelectorAll('button,[role="option"],[role="menuitem"],[data-radix-collection-item],div')].filter(isVisible).filter(element=>{const text=clean(element.innerText||element.textContent);return text===wanted||text.startsWith(wanted+' ')||text.startsWith(wanted+'（')});
    const element=candidates.sort((a,b)=>a.children.length-b.children.length||a.getBoundingClientRect().width*a.getBoundingClientRect().height-b.getBoundingClientRect().width*b.getBoundingClientRect().height)[0];
    if(!element)return null;
    const target=element.closest('button,[role="option"],[role="menuitem"],[data-radix-collection-item]')||element;
    const rect=target.getBoundingClientRect();
    return{text:wanted,x:rect.left+rect.width/2,y:rect.top+rect.height/2,width:rect.width,height:rect.height};
  })()`);
}

async function chooseImageModel(client, model) {
  const wanted = String(model || "Seedream 4.5");
  let control = await findImageControl(client, "model");
  if (!control) throw new Error("豆包图片页面中没有找到模型设置");
  if (control.text.includes(wanted)) { await closeImageOptionMenu(client); return control; }
  await realClick(client, control);
  const option = await waitFor(client, () => findOpenMenuOption(client, wanted), 5000, 120);
  if (!option) throw new Error(`当前豆包账号没有提供图片模型：${wanted}`);
  await realClick(client, option);
  control = await waitFor(client, async () => {
    const current = await findImageControl(client, "model");
    return current?.text?.includes(wanted) ? current : null;
  }, 5000, 120);
  if (!control) throw new Error(`豆包没有确认图片模型：${wanted}`);
  return control;
}

async function chooseImageRatio(client, ratio) {
  const wanted = String(ratio || "自动");
  let control = await findImageControl(client, "ratio");
  if (!control) throw new Error("豆包图片页面中没有找到比例设置");
  if (control.text.replace(/^比例\s*/, "") === wanted) { await closeImageOptionMenu(client); return control; }
  await realClick(client, control);
  const option = await waitFor(client, () => findOpenMenuOption(client, wanted), 5000, 120);
  if (!option) throw new Error(`当前豆包没有提供图片比例：${wanted}`);
  await realClick(client, option);
  control = await waitFor(client, async () => {
    const current = await findImageControl(client, "ratio");
    return current?.text?.replace(/^比例\s*/, "") === wanted ? current : null;
  }, 5000, 120);
  if (!control) throw new Error(`豆包没有确认图片比例：${wanted}`);
  return control;
}

async function findImageSubmitButton(client) {
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const model=[...document.querySelectorAll('[data-input-engine-actionbar-control-key="model"]')].filter(isVisible).find(element=>/Seedream|模型/.test(clean(element.innerText||element.textContent)));
    const editors=[...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(isVisible);
    const editor=editors[editors.length-1];
    if(!model||!editor)return null;
    let composer=editor;
    while(composer&&composer!==document.body&&!composer.contains(model))composer=composer.parentElement;
    composer=composer||document.body;
    const exactSelectors=['#flow-end-msg-send','[data-testid="chat_input_send_button"]','button[class*="send-msg-btn"]'];
    const exact=new Set(exactSelectors.flatMap(selector=>[...composer.querySelectorAll(selector)]));
    const editorRect=editor.getBoundingClientRect();
    const scored=[...composer.querySelectorAll('button,[role="button"]')].filter(isVisible).map(element=>{
      const text=clean(element.innerText||element.textContent||element.getAttribute('aria-label')||element.getAttribute('title'));
      const className=String(element.className||'');const testId=String(element.getAttribute('data-testid')||'');const rect=element.getBoundingClientRect();
      const top=document.elementFromPoint(Math.max(0,Math.min(innerWidth-1,rect.left+rect.width/2)),Math.max(0,Math.min(innerHeight-1,rect.top+rect.height/2)));
      const centerBelongsToButton=top?.closest?.('button,[role="button"]')===element;
      let score=0,identified=false;
      if(exact.has(element)||element.id==='flow-end-msg-send'||testId==='chat_input_send_button'){score+=1000;identified=true}
      if(/send-msg-button|send-msg-btn|submit/i.test(className+' '+testId)){score+=320;identified=true}
      if(/生成图片|立即生成|^生成$|发送/.test(text)){score+=220;identified=true}
      if(rect.left>editorRect.left+editorRect.width*.65)score+=60;
      if(rect.width>=28&&rect.width<=58&&rect.height>=28&&rect.height<=58)score+=30;
      if(centerBelongsToButton)score+=20;else score-=300;
      const disabled=element.disabled||element.getAttribute('aria-disabled')==='true'||element.getAttribute('data-disabled')==='true';
      if(disabled)score-=1000;
      return{score:identified?score:-1000,text,id:element.id||'',testId,x:rect.left+rect.width/2,y:rect.top+rect.height/2,width:rect.width,height:rect.height,disabled,centerBelongsToButton};
    }).filter(item=>item.score>0).sort((a,b)=>b.score-a.score);
    return scored[0]||null;
  })()`);
}

async function findImageInput(client) {
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const videoParams=[...document.querySelectorAll('[data-input-engine-actionbar-render-entry-key="creation-video-generation-params-panel"],[data-input-engine-actionbar-render-entry-key="video-generation-params-panel"]')].filter(isVisible);
    const editors=[...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(isVisible);
    if(!videoParams.length||!editors.length)return null;
    const inputs=[...document.querySelectorAll('input[type="file"]')];
    const scored=inputs.map((element,index)=>{
      const accept=String(element.accept||'');
      const near=element.closest('form,[class*="input"],[class*="composer"],[class*="editor"],[class*="creation"]');
      const text=String(near?.innerText||'');
      let score=(/image|png|jpe?g|webp/i.test(accept)?100:0)+(element.multiple?20:0)+(/视频|参考|上传/.test(text)?25:0)+index/100;
      return{element,score,index,multiple:!!element.multiple,accept};
    }).sort((a,b)=>b.score-a.score);
    return scored[0]?.element||null;
  })()`, false);
}

async function composerMediaCount(client) {
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const editors=[...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(isVisible);
    const editor=editors.find(e=>/视频|描述/.test(String(e.placeholder||e.getAttribute('data-placeholder')||e.getAttribute('aria-label')||'')))||editors[editors.length-1];
    if(!editor)return 0;
    let root=editor.parentElement,best=root;
    while(root&&root!==document.body){const r=root.getBoundingClientRect();if(r.width<innerWidth*.95&&r.height<innerHeight*.6)best=root;else break;root=root.parentElement}
    return [...best.querySelectorAll('img,[role="img"],canvas')].filter(isVisible).length;
  })()`);
}

async function attachmentState(client) {
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const area=document.querySelector('[data-testid="attachment_area"]')||document.querySelector('[data-testid="video-attachment-scroll-container"]');
    if(!area)return{count:0,uploading:false,progress:[],failed:false};
    const cards=[...area.querySelectorAll('[data-testid="attachment-image-card"][data-kind="image"]')].filter(element=>{
      const rect=element.getBoundingClientRect();
      return rect.width>2&&rect.height>2;
    });
    const text=clean(area.innerText||area.textContent||'');
    const progress=[...text.matchAll(/(?:^|\\s)(\\d{1,3})%(?:\\s|$)/g)].map(match=>Number(match[1]));
    const progressBars=[...area.querySelectorAll('[role="progressbar"]')].filter(element=>{
      const rect=element.getBoundingClientRect();
      return rect.width>2&&rect.height>2;
    });
    return{
      count:cards.length,
      uploading:progress.some(value=>value<100)||progressBars.some(element=>{
        if(element.getAttribute('aria-hidden')==='true'||!isVisible(element))return false;
        const raw=element.getAttribute('aria-valuenow'),max=Number(element.getAttribute('aria-valuemax')||100);
        if(raw!==null&&raw.trim()!==''&&Number.isFinite(Number(raw))&&max>0)return Number(raw)<max;
        const label=String(element.getAttribute('aria-valuetext')||'');
        return !/100[ ]*%|上传完成|上传成功/.test(label);
      }),
      unknownProgress:progressBars.filter(element=>isVisible(element)&&element.getAttribute('aria-hidden')!=='true'&&element.getAttribute('aria-valuenow')===null).length,
      progress,
      failed:/上传失败|重新上传|重试/.test(text)
    };
  })()`);
}

async function findAttachmentDeleteButton(client) {
  return client.evaluate(`(() => {
    const area=document.querySelector('[data-testid="attachment_area"]')||document.querySelector('[data-testid="video-attachment-scroll-container"]');
    if(!area)return null;
    const card=area.querySelector('[data-testid="attachment-image-card"][data-kind="image"]');
    if(!card)return null;
    const button=card.querySelector('[data-testid="attachment-delete-btn"]');
    const cardRect=card.getBoundingClientRect();
    if(!button)return{hoverOnly:true,x:cardRect.left+cardRect.width/2,y:cardRect.top+cardRect.height/2};
    const rect=button.getBoundingClientRect();
    if(rect.width<=2||rect.height<=2)return{hoverOnly:true,x:cardRect.left+cardRect.width/2,y:cardRect.top+cardRect.height/2};
    return{x:rect.left+rect.width/2,y:rect.top+rect.height/2,width:rect.width,height:rect.height,hoverOnly:false};
  })()`);
}

async function clearComposerAttachments(client, progress = () => {}, folder = "") {
  const initial = await attachmentState(client);
  if (!initial.count) return { before: 0, cleared: 0, after: 0 };
  progress(`正在清理豆包输入框中残留的 ${initial.count} 张参考图……`);
  let previous = initial.count;
  let cleared = 0;
  for (let attempt = 0; attempt < initial.count + 3 && previous > 0; attempt++) {
    let target = await findAttachmentDeleteButton(client);
    if (!target) break;
    if (target.hoverOnly) {
      await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y });
      await delay(180);
      target = await findAttachmentDeleteButton(client);
    }
    if (!target || target.hoverOnly) break;
    await realClick(client, target);
    const reduced = await waitFor(client, async () => {
      const current = await attachmentState(client);
      return current.count < previous ? current : null;
    }, 5000, 150);
    if (!reduced) break;
    cleared += previous - reduced.count;
    previous = reduced.count;
  }
  const final = await attachmentState(client);
  if (final.count) {
    if (folder) await captureStage(client, folder, "00-残留参考图无法清除");
    throw new Error(`豆包输入框仍残留 ${final.count} 张旧参考图，已停止提交以免图片错乱`);
  }
  return { before: initial.count, cleared, after: final.count };
}

async function uploadReferences(client, files, progress, folder, verifyAccount = async () => {}, options = {}) {
  const started = Date.now();
  const timings = {};
  const stage = (name, detail = {}) => { timings[name] = Date.now() - started; options.onStage?.(name, { elapsedMs:timings[name], ...detail }); };
  const cleanup = await clearComposerAttachments(client, progress, folder);
  if (!files.length) return { expected: 0, assigned: [], before: cleanup.before, cleared: cleanup.cleared, after: 0 };
  progress(`正在按连线顺序上传 ${files.length} 张参考图……`);
  const assigned = [];
  // Prepare the prompt before image assignment can occupy Doubao's renderer.
  // Reacquire the file input afterwards: filling the prompt may rerender it.
  let promptPrepared = false;
  if (options.onBeforeAssign) {
    await verifyAccount();
    try { await options.onBeforeAssign(); promptPrepared = true; stage("交付图片前提示词已填写"); }
    catch (error) { assertRunning(); if(error.code==='DOUBAO_TASK_STOPPED')throw error; stage("提示词稍后重新填写", {reason:error.message}); }
  }
  if (promptPrepared) progress(`提示词已准备好，正在交付 ${files.length} 张参考图并等待豆包接收……`);
  let input = await findImageInput(client);
  if (!input?.objectId) {
    const add = await realClickMatching(client, "添加参考|参考图|上传|^\\+$", { preferBottom: true });
    if (add) await delay(500);
    input = await findImageInput(client);
  }
  if (!input?.objectId) throw new Error("豆包视频页面中没有找到参考图上传入口");
  const described = await client.send("DOM.describeNode", { objectId: input.objectId });
  const multiple = await client.send("Runtime.callFunctionOn", {
    objectId: input.objectId,
    functionDeclaration: "function(){return !!this.multiple}",
    returnByValue: true
  });
  const groups = multiple.result.value ? [files] : files.map(file => [file]);
  for (let index = 0; index < groups.length; index++) {
    await verifyAccount();
    if (index > 0) {
      input = await findImageInput(client);
      if (!input?.objectId) throw new Error(`上传第 ${index + 1} 张图片前，豆包的上传入口消失了`);
    }
    const node = index === 0 ? described.node : (await client.send("DOM.describeNode", { objectId: input.objectId })).node;
    await client.send("DOM.setFileInputFiles", { files: groups[index], backendNodeId: node.backendNodeId }, 30000);
    stage("文件已交给豆包", { group:index+1, count:groups[index].length });
    assigned.push(...groups[index].map(file => path.basename(file)));
    // Wait for attachment acknowledgement, not a fixed delay per image.
    if (index + 1 < groups.length) {
      const acknowledged = await waitFor(client, async () => (await attachmentState(client)).count >= assigned.length, 5000, 120);
      if (!acknowledged) throw new Error("豆包尚未确认收到上一张参考图，已停止继续上传以免图片错乱");
    }
  }
  stage("图片卡片检查结束", await attachmentState(client));
  // 网络上传继续进行时填写提示词；最终仍会复核附件和完整提示词，失败则走原填写路径。
  if (!promptPrepared && options.onAssigned) {
    try { await options.onAssigned(); promptPrepared = true; stage("上传期间提示词已填写"); }
    catch (error) { assertRunning(); if(error.code==='DOUBAO_TASK_STOPPED')throw error; stage("提示词稍后重新填写", { reason:error.message }); }
  }
  let lastEvidence = "";
  const ready = await waitFor(client, async () => {
    const state = await attachmentState(client);
    const evidence=JSON.stringify(state);
    if(evidence!==lastEvidence){lastEvidence=evidence;stage("附件状态变化",state);}
    return state.count === files.length && !state.uploading && !state.failed ? state : null;
  }, 60000, 150);
  const final = ready || await attachmentState(client);
  await captureStage(client, folder, "02-参考图已上传");
  if (final.failed) throw new Error("豆包提示参考图上传失败，已停止提交");
  if (final.count !== files.length) {
    throw new Error(`参考图核对失败：画布连接 ${files.length} 张，豆包实际收到 ${final.count} 张`);
  }
  if (final.uploading) throw new Error(final.unknownProgress ? "豆包仍显示无法确定进度的上传条，不能确认参考图已上传成功；已停止提交，请检查附件状态" : "等待豆包参考图上传完成超时，已停止提交");
  stage("参考图已就绪");
  return { expected: files.length, assigned, before: cleanup.before, cleared: cleanup.cleared, after: final.count, timings, promptPrepared };
}

async function findPromptEditor(client) {
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const videoParams=[...document.querySelectorAll('[data-input-engine-actionbar-render-entry-key="creation-video-generation-params-panel"],[data-input-engine-actionbar-render-entry-key="video-generation-params-panel"]')].filter(isVisible);
    if(!videoParams.length)return null;
    const editors=[...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(isVisible);
    const scored=editors.map((element,index)=>{
      const nestedPlaceholder=element.querySelector?.('[data-placeholder]')?.getAttribute('data-placeholder');
      const hint=clean(element.placeholder||element.getAttribute('data-placeholder')||element.getAttribute('aria-label')||nestedPlaceholder);
      const r=element.getBoundingClientRect();
      const className=String(element.className||'');
      const score=(/视频|描述|想要/.test(hint)?100:0)+(/ProseMirror|tiptap/i.test(className)?50:0)+(element.getAttribute('role')==='textbox'?20:0)+r.top/innerHeight*25+index/100;
      return{element,score};
    }).sort((a,b)=>b.score-a.score);
    return scored[0]?.element||null;
  })()`, false);
}

function normalizePromptText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").trim();
}

// 豆包的富文本编辑器会把换行折叠成普通空格；这是展示格式变化，
// 不是提示词被清除或截断。仅用于“写入后的回读核对”，绝不改动提交原文。
function normalizePromptReadback(value) {
  return normalizePromptText(value).replace(/\s+/g, " ").trim();
}

async function readPromptEvidence(client) {
  const editor = await findPromptEditor(client);
  if (!editor?.objectId) return { found: false, values: [], value: "" };
  try {
    const response = await client.send("Runtime.callFunctionOn", {
      objectId: editor.objectId,
      functionDeclaration: `function(){
        const values=[];
        const add=value=>{value=String(value??'');if(value&&!values.includes(value))values.push(value)};
        add(this.value);
        add(this.innerText);
        add(this.textContent);
        for(const child of this.querySelectorAll?.('textarea,input,[contenteditable="true"]')||[]){
          add(child.value);add(child.innerText);add(child.textContent);
        }
        return{connected:this.isConnected!==false,values};
      }`,
      returnByValue: true
    });
    const values = Array.isArray(response.result.value?.values) ? response.result.value.values.map(value => String(value ?? "")) : [];
    const value = [...values].sort((left, right) => normalizePromptText(right).length - normalizePromptText(left).length)[0] || "";
    return { found: true, connected: response.result.value?.connected !== false, values, value };
  } catch {
    return { found: false, values: [], value: "" };
  }
}

function promptEvidenceMatches(evidence, prompt) {
  const expected = normalizePromptReadback(prompt);
  return Boolean(expected) && (evidence?.values || []).some(value => normalizePromptReadback(value) === expected);
}

async function waitForPromptRecognition(client, prompt, {
  timeout = 15000,
  interval = 350,
  shouldStop = () => false,
  onWaiting = () => {}
} = {}) {
  let evidence = await readPromptEvidence(client);
  if (promptEvidenceMatches(evidence, prompt)) return { matched: true, evidence, waitedMs: 0 };
  const startedAt = Date.now();
  onWaiting({ evidence, timeout, startedAt });
  const readWithin = milliseconds => new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ found: false, values: [], value: "", timedOut: true }), Math.max(1, milliseconds));
    Promise.resolve(readPromptEvidence(client)).then(finish, () => finish({ found: false, values: [], value: "" }));
  });
  let consecutiveMatches = 0;
  while (Date.now() - startedAt < timeout) {
    if (shouldStop()) throw controllerError("DOUBAO_TASK_STOPPED", "任务已由用户停止");
    await delay(Math.min(interval, Math.max(1, timeout - (Date.now() - startedAt))));
    const remaining = timeout - (Date.now() - startedAt);
    if (remaining <= 0) break;
    evidence = await readWithin(remaining);
    if (evidence.timedOut) break;
    if (promptEvidenceMatches(evidence, prompt)) {
      consecutiveMatches += 1;
      if (consecutiveMatches >= 2) return { matched: true, evidence, waitedMs: Date.now() - startedAt };
    } else {
      consecutiveMatches = 0;
    }
  }
  return { matched: false, evidence, waitedMs: Date.now() - startedAt };
}

async function fillPrompt(client, prompt, progress, folder) {
  progress("正在首次填写提示词……");
  const editor = await findPromptEditor(client);
  if (!editor?.objectId) throw new Error("豆包视频页面中没有找到提示词输入框");
  await client.send("Runtime.callFunctionOn", {
    objectId: editor.objectId,
    functionDeclaration: `function(value){
      this.focus();
      if(this instanceof HTMLTextAreaElement || this instanceof HTMLInputElement){
        const proto=this instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto,'value').set.call(this,value);
      }else{
        this.replaceChildren(document.createTextNode(value));
      }
      try{this.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,inputType:'insertText',data:value}));}catch{}
      try{this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));}catch{this.dispatchEvent(new Event('input',{bubbles:true}));}
      this.dispatchEvent(new Event('change',{bubbles:true}));
      return true;
    }`,
    arguments: [{ value: prompt }],
    returnByValue: true,
    userGesture: true
  });
  await delay(350);
  const evidence = await readPromptEvidence(client);
  if (promptEvidenceMatches(evidence, prompt)) {
    await captureStage(client, folder, "03-提示词已填写");
  } else {
    progress("提示词已经完成首次填写；豆包暂未返回可核对的完整内容，将在点击生成前继续识别，不会重复填写");
  }
  return true;
}

async function resetPromptDraftForPaste(client, progress = () => {}) {
  await activatePageForInput(client);
  const editor = await findPromptEditor(client);
  if (!editor?.objectId) throw new Error("豆包视频页面中没有找到提示词输入框");
  const focused = await client.send("Runtime.callFunctionOn", {
    objectId: editor.objectId,
    functionDeclaration: `function(){
      this.focus({preventScroll:true});
      const active=document.activeElement;
      return this.isConnected!==false&&Boolean(active&&(active===this||this.contains(active)||active.contains?.(this)));
    }`,
    returnByValue: true,
    userGesture: true
  });
  if (focused.result.value !== true) throw new Error("豆包最终提示词输入框无法取得焦点，本次没有清空、粘贴或提交");
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  const cleared = await waitFor(client, async () => {
    const evidence = await readPromptEvidence(client);
    return evidence.found && evidence.connected && !normalizePromptReadback(evidence.value) ? evidence : null;
  }, 2500, 100);
  if (!cleared) throw new Error("豆包提示词输入框中的旧草稿未能安全清空，本次没有粘贴或提交");
  progress("已定位最终提示词输入框，正在执行本任务唯一一次粘贴……");
  return true;
}

function qualifiedPromptPasteEvidence(report) {
  const paste = report?.paste;
  const event = paste?.event;
  return Boolean(
    paste?.present && !paste.expired && paste.urlUnchanged &&
    event?.received && event.isTrusted && event.targetQualified && event.activeMatches &&
    event.textAvailable && (event.exact || event.lineEndingMatch)
  );
}

async function pastePromptWithEvidence(client, prompt, progress, folder) {
  let report;
  try {
    report = await runPasteProbe({
      client,
      prompt,
      ttlMs: 5000,
      readPromptEvidence
    });
  } catch (error) {
    report = {
      ok: false,
      error: String(error?.message || error),
      expectedLength: String(prompt || "").length,
      safeToAutoSubmitByPasteEvidence: false,
      generated: false
    };
  }
  report.ok = report.safeToAutoSubmitByPasteEvidence === true;
  report.qualifiedPasteEvent = qualifiedPromptPasteEvidence(report);
  report.recordedAt = new Date().toISOString();
  if (folder) {
    try { fs.writeFileSync(path.join(folder, "提示词粘贴凭据.json"), JSON.stringify(report, null, 2), "utf8"); }
    catch {}
  }
  if (report.safeToAutoSubmitByPasteEvidence) {
    progress("豆包输入框已收到完整可信的提示词粘贴，继续核对提交参数……");
  } else if (report.qualifiedPasteEvent) {
    progress("豆包已收到完整提示词粘贴，但输入区辅助核对尚未稳定；将限时监听，不会重复粘贴");
  } else {
    progress("本次唯一粘贴未取得完整可信回执；不会再次粘贴或自动冒险提交");
  }
  return report;
}

async function selectedControlContains(client, value) {
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const wanted=${JSON.stringify(String(value))};
    return [...document.querySelectorAll('button,[role="button"],[aria-selected="true"],[data-state="checked"]')].filter(isVisible).some(e=>clean(e.innerText||e.textContent||e.getAttribute('aria-label')).includes(wanted));
  })()`);
}

async function selectedVideoModelIs(client, value) {
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const wanted=${JSON.stringify(String(value))};
    const pattern=/Seedance\\s+2\\.5|Seedance\\s+2\\.0(?:\\s+(?:Fast|Mini))?/i;
    return [...document.querySelectorAll('button,[role="button"],[aria-selected="true"],[data-state="checked"]')]
      .filter(isVisible)
      .some(element => {
        const match=clean(element.innerText||element.textContent||element.getAttribute('aria-label')).match(pattern);
        return match&&match[0].toLowerCase()===wanted.toLowerCase();
      });
  })()`);
}

async function chooseModel(client, model) {
  if (!model) return;
  if (await selectedVideoModelIs(client, model)) return;
  let trigger = await realClickMatching(client, "Seedance|模型", { preferBottom: true });
  if (!trigger) throw new Error("豆包页面中没有找到视频模型设置");
  await delay(350);
  const option = await clickText(client, [model], { preferBottom: true });
  if (!option) throw new Error(`当前豆包账号没有提供模型：${model}`);
  await delay(400);
  if (!(await selectedVideoModelIs(client, model))) {
    const snapshot = await pageSnapshot(client);
    if (!snapshot.text.includes(model)) throw new Error(`豆包没有切换到模型：${model}`);
  }
}

async function setDurationRange(client, seconds) {
  return client.evaluate(`(() => {
    const value=${Number(seconds)};
    const ranges=[...document.querySelectorAll('input[type="range"]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>30&&r.height>0});
    const range=ranges[ranges.length-1]; if(!range)return null;
    if(!Number.isFinite(Number(range.max))||Number(range.max)<value) range.max=String(Math.max(value,30));
    const minimum=Number(range.min||4),maximum=Number(range.max||30),next=Math.max(minimum,Math.min(maximum,value));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(range,String(next));
    range.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:String(next)}));
    range.dispatchEvent(new Event('change',{bubbles:true}));
    return{value:Number(range.value),minimum,maximum};
  })()`);
}

async function findCreationParamsTrigger(client) {
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const exact=/^(自动|16:9|9:16|1:1|4:3|3:4|21:9|比例)\\s*[·・]\\s*\\d+\\s*s$/i;
    const selectors=[
      'button[data-input-engine-actionbar-render-entry-key="creation-video-generation-params-panel"]',
      'button[data-input-engine-actionbar-render-entry-key="video-generation-params-panel"]',
      'button[data-creation-params-panel-id]',
      'button[data-slot="dropdown-menu-trigger"][aria-haspopup="menu"]'
    ];
    const candidates=[...new Set(selectors.flatMap(selector=>[...document.querySelectorAll(selector)]))].filter(isVisible).filter(element=>exact.test(clean(element.innerText||element.textContent)));
    if(!candidates.length){
      candidates.push(...[...document.querySelectorAll('button')].filter(isVisible).filter(element=>exact.test(clean(element.innerText||element.textContent))));
    }
    let element=candidates.sort((a,b)=>b.getBoundingClientRect().top-a.getBoundingClientRect().top)[0];
    if(!element){
      const model=[...document.querySelectorAll('button,[role="button"]')].filter(isVisible).find(el=>/^模型/.test(clean(el.innerText||el.textContent)));
      if(model){
        const mr=model.getBoundingClientRect();
        const rounds=[...document.querySelectorAll('button,[role="button"],[data-slot="dropdown-menu-trigger"]')].filter(isVisible).filter(el=>{
          const r=el.getBoundingClientRect();
          return Math.abs(r.width-r.height)<16 && r.width>=20 && r.width<=48 && r.top>innerHeight*0.35;
        });
        const send=[...rounds].sort((a,b)=>b.getBoundingClientRect().left-a.getBoundingClientRect().left)[0];
        element=rounds.find(el=>{
          const r=el.getBoundingClientRect();
          if(send && Math.abs(r.left-send.getBoundingClientRect().left)<4) return false;
          return r.left>=mr.right-2 && r.left<=mr.right+56 && Math.abs(r.top-mr.top)<28;
        }) || null;
      }
    }
    if(!element)return null;
    const rect=element.getBoundingClientRect();
    return{text:clean(element.innerText||element.textContent),state:element.getAttribute('data-state'),expanded:element.getAttribute('aria-expanded'),x:rect.left+rect.width/2,y:rect.top+rect.height/2,width:rect.width,height:rect.height};
  })()`);
}

async function findDurationSubTrigger(client) {
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const exact=/^(自动|比例|\\d+\\s*:\\s*\\d+)\\s*[·•・/\\s]+\\d+\\s*(s|秒)$/i;
    const element=[...document.querySelectorAll('[data-slot="dropdown-menu-sub-trigger"]')].filter(isVisible).find(el=>exact.test(clean(el.innerText||el.textContent)));
    if(!element)return null;
    const rect=element.getBoundingClientRect();
    return{text:clean(element.innerText||element.textContent),x:rect.left+rect.width/2,y:rect.top+rect.height/2,width:rect.width,height:rect.height};
  })()`);
}

async function creationParamsPanelOpen(client) {
  return client.evaluate(`(() => {
    ${visibleHelpers}
    return [...document.querySelectorAll('[data-slot="dropdown-menu-sub-content"],[data-slot="dropdown-menu-content"][data-state="open"],[role="menu"][data-state="open"]')].filter(isVisible).some(element=>{
      const text=clean(element.innerText||element.textContent);
      const r=element.getBoundingClientRect();
      if(r.width<220 || r.height<90) return false;
      return /时长/.test(text) && (/比例/.test(text) || Boolean(element.querySelector('[role="slider"],input[type="range"]')));
    });
  })()`);
}

async function openCreationParamsPanel(client) {
  if (await creationParamsPanelOpen(client)) return true;
  const trigger = await findCreationParamsTrigger(client);
  if (!trigger) throw new Error("豆包页面中没有找到“自动/比例 · 时长”设置按钮");
  await realClick(client, trigger);
  if (await waitFor(client, () => creationParamsPanelOpen(client), 1200, 100)) return true;
  const sub = await waitFor(client, () => findDurationSubTrigger(client), 2500, 100);
  if (sub) {
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: sub.x, y: sub.y, buttons: 0, pointerType: "mouse" });
    await delay(280);
    if (await creationParamsPanelOpen(client)) return true;
    await realClick(client, sub);
  }
  const opened = await waitFor(client, () => creationParamsPanelOpen(client), 4000, 120);
  if (!opened) throw new Error("已点击豆包比例按钮，但比例和时长面板没有展开");
  return true;
}

async function chooseRatioOption(client, ratio) {
  const selected = await client.evaluate(`(() => {
    ${visibleHelpers}
    const wanted=${JSON.stringify(String(ratio))};
    const menu=[...document.querySelectorAll('[data-slot="dropdown-menu-content"][data-state="open"],[role="menu"][data-state="open"]')].filter(isVisible).find(element=>/比例/.test(clean(element.innerText||element.textContent)));
    if(!menu)return null;
    const candidates=[...menu.querySelectorAll('button,[role="option"],[role="menuitem"]')].filter(isVisible).filter(element=>clean(element.innerText||element.textContent||element.getAttribute('aria-label'))===wanted);
    const element=candidates.sort((a,b)=>a.getBoundingClientRect().width*a.getBoundingClientRect().height-b.getBoundingClientRect().width*b.getBoundingClientRect().height)[0];
    if(!element)return null;
    const rect=element.getBoundingClientRect();
    return{x:rect.left+rect.width/2,y:rect.top+rect.height/2,width:rect.width,height:rect.height,text:wanted};
  })()`);
  if (!selected) return false;
  await realClick(client, selected);
  await delay(250);
  return true;
}

async function pressKey(client, key, code, windowsVirtualKeyCode) {
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
}

async function setCustomDurationSlider(client, seconds) {
  const slider = await client.evaluate(`(() => {
    ${visibleHelpers}
    const menus=[...document.querySelectorAll('[data-slot="dropdown-menu-sub-content"],[data-slot="dropdown-menu-content"][data-state="open"],[role="menu"][data-state="open"]')].filter(isVisible);
    const menu=menus.find(element=>element.getAttribute('data-slot')==='dropdown-menu-sub-content' && /时长/.test(clean(element.innerText||element.textContent)))
      || menus.find(element=>/时长/.test(clean(element.innerText||element.textContent)) && element.getBoundingClientRect().width>220);
    if(!menu)return null;
    const element=[...menu.querySelectorAll('[role="slider"]')].filter(isVisible)[0];
    if(!element)return null;
    let track=element;
    for (let node=element, i=0; i<6 && node && node!==menu; i++) {
      const r=node.getBoundingClientRect();
      if(r.width>80 && r.height>=8 && r.height<=48){ track=node; break; }
      node=node.parentElement;
    }
    const numbers=[...menu.querySelectorAll('span,div')].filter(isVisible).map(item=>/^(\\d+)\\s*s$/i.exec(clean(item.innerText||item.textContent))).filter(Boolean).map(match=>Number(match[1]));
    const rect=track.getBoundingClientRect();
    const minSec=numbers.length?Math.min(...numbers):4;
    const maxSec=Math.max(numbers.length?Math.max(...numbers):15, ${Number(seconds)}||15);
    return{x:rect.left+rect.width/2,y:rect.top+rect.height/2,left:rect.left,width:rect.width,minimum:Number(element.getAttribute('aria-valuemin')),maximum:Number(element.getAttribute('aria-valuemax')),current:Number(element.getAttribute('aria-valuenow')),minimumSeconds:minSec,maximumSeconds:maxSec};
  })()`);
  if (!slider) return null;
  const desired = Math.max(slider.minimumSeconds, Math.min(slider.maximumSeconds, Number(seconds)));
  const ratio = (desired - slider.minimumSeconds) / Math.max(1, slider.maximumSeconds - slider.minimumSeconds);
  const target = Math.round(slider.minimum + ratio * (slider.maximum - slider.minimum));
  if (slider.width > 80) {
    await realClick(client, { x: slider.left + Math.max(6, Math.min(slider.width - 6, ratio * slider.width)), y: slider.y });
    await delay(200);
  }
  await realClick(client, slider);
  await pressKey(client, "Home", "Home", 36);
  for (let step = slider.minimum; step < target; step++) await pressKey(client, "ArrowRight", "ArrowRight", 39);
  const confirmed = await waitFor(client, () => client.evaluate(`(() => {
    ${visibleHelpers}
    const element=[...document.querySelectorAll('[role="slider"]')].filter(isVisible)[0];
    return element&&Number(element.getAttribute('aria-valuenow'))===${target};
  })()`), 4000, 100);
  return confirmed ? { value: desired, minimum: slider.minimumSeconds, maximum: slider.maximumSeconds } : null;
}

async function chooseRatioAndDuration(client, ratio, duration, model) {
  await openCreationParamsPanel(client);
  if (ratio) {
    const trigger = await findCreationParamsTrigger(client);
    if (!trigger?.text?.startsWith(ratio)) {
      const ratioOption = await chooseRatioOption(client, ratio);
      if (!ratioOption) throw new Error(`当前豆包页面没有提供比例：${ratio}`);
      await openCreationParamsPanel(client);
    }
  }
  const seconds = Number.parseInt(String(duration || "10"), 10);
  let range = null;
  if (Number.isFinite(seconds)) {
    const maximumDuration = String(model || "").trim() === "Seedance 2.5" ? 30 : 15;
    if (seconds < 4 || seconds > maximumDuration) throw new Error(`${model || "当前模型"} 视频时长只支持 4 到 ${maximumDuration} 秒`);
    range = await setDurationRange(client, seconds);
    if (!range) range = await setCustomDurationSlider(client, seconds);
    if (!range) {
      const option = await clickText(client, [`${seconds}s`, `${seconds}秒`], { preferBottom: true, contains: false });
      if (!option) throw new Error(`当前豆包页面没有提供 ${seconds} 秒时长`);
    } else if (range.value !== seconds) {
      throw new Error(`豆包时长滑块未能设置为 ${seconds} 秒`);
    }
  }
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await delay(120);
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await delay(200);
  const confirmed = await findCreationParamsTrigger(client);
  const confirmedText = String(confirmed?.text || "");
  if (ratio && confirmedText && !confirmedText.startsWith(ratio) && !/^模型/.test(confirmedText)) throw new Error(`豆包没有确认比例：${ratio}`);
  if (Number.isFinite(seconds) && confirmedText && !confirmedText.includes(`${seconds}s`) && range?.value !== seconds) {
    throw new Error(`豆包没有确认 ${seconds} 秒时长`);
  }
  if (Number.isFinite(seconds) && !confirmedText && range?.value !== seconds) {
    throw new Error(`豆包没有确认 ${seconds} 秒时长`);
  }
  return confirmed || { text: `${seconds}s`, value: seconds };
}

async function readPrompt(client) {
  return (await readPromptEvidence(client)).value;
}

async function downloadState(client, confirmationContext = null) {
  const messageState = await conversationMessageState(client);
  const chain = confirmationContext ? confirmationChain(confirmationContext, messageState) : null;
  const state = await client.evaluate(`(() => {
    ${visibleHelpers}
    const failurePattern=${GENERATION_FAILURE_PATTERN.toString()};
    const donePattern=${VIDEO_READY_PATTERN.toString()};
    const pickCover=images=>{
      const scored=images.map(image=>{
        const rect=image.getBoundingClientRect();
        const cls=String(image.className||'');
        const big=(rect.width>=120&&rect.height>=68)||(image.naturalWidth>=160&&image.naturalHeight>=90);
        if(!big||/avatar|logo|icon/i.test(cls)||/avatar|logo|icon/i.test(String(image.currentSrc||image.src||'')))return null;
        return{image,rect,score:(/cover|poster|thumb|preview/i.test(cls)?1000000:0)+rect.width*rect.height};
      }).filter(Boolean).sort((a,b)=>b.score-a.score);
      return scored[0]||null;
    };
    const downloads=[...document.querySelectorAll('button,a,[role="button"]')].filter(isVisible).filter(e=>/下载|保存到本地/.test(clean(e.innerText||e.textContent||e.getAttribute('aria-label')||e.getAttribute('title'))));
    const videos=[...document.querySelectorAll('video')].filter(element=>String(element.currentSrc||element.src||element.querySelector('source')?.src||element.poster||''));
    const downloadItems=downloads.map((element,index)=>{const rect=element.getBoundingClientRect();const text=clean(element.innerText||element.textContent||element.getAttribute('aria-label')||element.getAttribute('title'));return{text,href:String(element.href||''),signature:text+'|'+String(element.href||''),index,x:rect.left+rect.width/2,y:rect.top+rect.height/2,width:rect.width,height:rect.height};});
    const videoItems=videos.map((element,index)=>{const rect=element.getBoundingClientRect();const source=String(element.currentSrc||element.src||element.querySelector('source')?.src||'');const poster=String(element.poster||'');let container=element;const contexts=[];for(let depth=0;container&&container!==document.body&&depth<13;depth++,container=container.parentElement){const value=clean(container.innerText||container.textContent);if(value&&value.length<=8000&&!contexts.includes(value))contexts.push(value)}return{source,poster,signature:source||poster||('video-'+index+'-'+Math.round(rect.top)),contexts,index,visible:isVisible(element),x:rect.left+rect.width/2,y:rect.top+rect.height/2,width:rect.width,height:rect.height};});
    const completedCardItems=[...document.querySelectorAll('[data-testid="message-block-container"]')].filter(isVisible).map((container,index)=>{const text=clean(container.innerText||container.textContent);if(!donePattern.test(text)&&!/下载视频|保存到本地/.test(text))return null;const receiver=container.querySelector('[data-testid="receive_message"]');if(!receiver)return null;const picked=pickCover([...receiver.querySelectorAll('img')]);if(!picked)return null;const cover=picked.image,rect=picked.rect;const coverSource=String(cover.currentSrc||cover.src||'');let parent=container;const contexts=[];for(let depth=0;parent&&parent!==document.body&&depth<10;depth++,parent=parent.parentElement){const value=clean(parent.innerText||parent.textContent);if(value&&value.length<=8000&&!contexts.includes(value))contexts.push(value)}return{signature:coverSource||('completed-card-'+index+'-'+text.slice(0,160)),coverSource,contexts,index,x:rect.left+rect.width/2,y:rect.top+rect.height/2,width:rect.width,height:rect.height};}).filter(Boolean);
    const failureItems=[];
    const messageBlocks=[...document.querySelectorAll('[data-testid="message-block-container"]')];
    const failureElements=[...document.querySelectorAll('[data-testid="message-block-container"] [data-testid="receive_message"],[role="alert"],[role="dialog"]')].filter(isVisible);
    failureElements.forEach((element,index)=>{const text=clean(element.innerText||element.textContent);if(!text||text.length>1200||!failurePattern.test(text))return;const block=element.closest('[data-testid="message-block-container"]');let previousUserText='';let previousUserIndex=-1;if(block){const blockIndex=messageBlocks.indexOf(block);for(let cursor=blockIndex-1;cursor>=0;cursor--){const user=messageBlocks[cursor].querySelector('[data-testid="send_message"]');if(!user)continue;previousUserText=clean(user.innerText||user.textContent);previousUserIndex=cursor;break}}else{const childHasSame=[...element.children].some(child=>isVisible(child)&&failurePattern.test(clean(child.innerText||child.textContent)));if(childHasSame)return}let container=block||element;const contexts=[text,previousUserText].filter(Boolean);for(let depth=0;container&&container!==document.body&&depth<10;depth++,container=container.parentElement){const value=clean(container.innerText||container.textContent);if(value&&value.length<=8000&&!contexts.includes(value))contexts.push(value)}failureItems.push({signature:[block?messageBlocks.indexOf(block):index,text,previousUserText].join('|'),text,previousUserText,previousUserIndex,contexts,index});});
    const text=clean(document.body?.innerText||'').slice(-30000);
    const blocks=[...document.querySelectorAll('[data-testid="message-block-container"]')];
    const mediaIdentity=(item,block)=>{item.messageIndex=blocks.indexOf(block);item.localText=clean(block?.innerText||block?.textContent);const ids=[...new Set([block,...(block?.querySelectorAll('[data-message-id]')||[])].map(e=>e?.getAttribute('data-message-id')).filter(Boolean))];item.messageId=ids.length===1?ids[0]:'';};
    videoItems.forEach((item,index)=>mediaIdentity(item,videos[index].closest('[data-testid="message-block-container"]')));
    completedCardItems.forEach(item=>{const candidates=blocks.filter(b=>[...b.querySelectorAll('img')].some(img=>String(img.currentSrc||img.src||'')===item.coverSource));mediaIdentity(item,candidates.length===1?candidates[0]:null)});
    failureItems.forEach(item=>mediaIdentity(item,item.previousUserIndex>=0?blocks[Number(String(item.signature).split('|')[0])]:null));
    return{url:location.href,downloads:downloads.length,videos:videos.length,downloadItems,videoItems,completedCardItems,failureItems,downloadSignatures:downloadItems.map(item=>item.signature),videoSignatures:videoItems.map(item=>item.signature),completedCardSignatures:completedCardItems.map(item=>item.signature),failureSignatures:failureItems.map(item=>item.signature),pending:/生成中|正在生成|排队中|任务处理中|预计等待|正在渲染|高清渲染|处理中/.test(text),failed:failureItems.length>0,text};
  })()`, true, 60000);
  for(const key of ['videoItems','completedCardItems','failureItems']){
    for(const item of state[key]||[]){
      const message=messageState.url===state.url?messageState.messages?.find(m=>item.messageId?m.messageId===item.messageId:m.index===item.messageIndex&&!m.messageId):null;
      item.messageIndex=message?.index??-1;
      item.messageId=message?.messageId||'';
      item.replyId=message?.replyId||'';
      item.conversationUrl=state.url;
      // Never include the whole conversation as a candidate's prompt context.
      item.contexts=[item.localText||'',message?.previousUserText||''].filter(Boolean);
    }
  }
  if (chain) {
    const owned = new Set(chain.valid ? chain.assistant.map(item=>item.index) : []);
    const sameConversation=state.url===confirmationContext.url;
    for(const key of ['videoItems','completedCardItems','failureItems']) state[key]=(state[key]||[])
      .filter(item=>chain.valid&&sameConversation&&owned.has(item.messageIndex))
      .map(item=>({...item,contexts:[...(item.contexts||[]),confirmationContext.root.text],previousUserText:confirmationContext.root.text}));
    state.confirmationValid=chain.valid&&sameConversation;
    state.ownedMessages=chain.valid&&sameConversation?chain.assistant:[];
  }
  return state;
}

async function imageResultState(client) {
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const sourceKey=value=>{const text=String(value||'');let a=2166136261,b=2246822507;for(let index=0;index<text.length;index++){const code=text.charCodeAt(index);a=Math.imul(a^code,16777619);b=Math.imul(b^code,3266489909)}return text.length.toString(36)+'-'+(a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0')};
    const receivers=[...document.querySelectorAll('[data-testid="receive_message"]')];
    const imageSets=receivers.map((receiver,index)=>{
      const container=receiver.closest('[data-testid="message-block-container"]')||receiver.parentElement;
      if(!container)return null;
      const all=[...receiver.querySelectorAll('img')];
      const images=all.map((image,imageIndex)=>{
        const rect=image.getBoundingClientRect();
        const source=String(image.currentSrc||image.src||'');
        const className=String(image.className||'');
        const role=String(image.getAttribute('role')||'');
        const decorative=/avatar|emoji|icon|logo|badge|sticker|cover/i.test(className+' '+role+' '+String(image.alt||''));
        const large=(image.naturalWidth>=256&&image.naturalHeight>=256)||(rect.width>=150&&rect.height>=150);
        if(!source||/svg(?:$|[?#])|data:image\\/svg/i.test(source)||decorative||!large)return null;
        return{source,index:imageIndex,naturalWidth:Number(image.naturalWidth||0),naturalHeight:Number(image.naturalHeight||0),width:rect.width,height:rect.height,complete:Boolean(image.complete&&image.naturalWidth>0)};
      }).filter(Boolean);
      if(!images.length)return null;
      const contexts=[];let parent=container;
      for(let depth=0;parent&&parent!==document.body&&depth<10;depth++,parent=parent.parentElement){
        const value=clean(parent.innerText||parent.textContent);
        if(value&&value.length<=8000&&!contexts.includes(value))contexts.push(value);
      }
      const messageBlocks=[...document.querySelectorAll('[data-testid="message-block-container"]')];
      const blockIndex=messageBlocks.indexOf(container);
      for(let offset=1;offset<=3&&blockIndex-offset>=0;offset++){
        const value=clean(messageBlocks[blockIndex-offset].innerText||messageBlocks[blockIndex-offset].textContent);
        if(value&&value.length<=5000&&!contexts.includes(value))contexts.push(value);
      }
      const ids=[];
      for(const element of [receiver,container])for(const name of ['data-id','data-message-id','data-msg-id','id']){const value=element?.getAttribute?.(name);if(value)ids.push(name+'='+value)}
      const messageId=ids.join('|');
      const sources=images.map(image=>image.source);
      const signature=(messageId||'assistant-image-'+index)+'|'+sources.map(sourceKey).join('|');
      const localText=clean(container.innerText||container.textContent);
      const pending=/生成中|正在生成|排队中|任务处理中|加载中/.test(localText)||images.some(image=>!image.complete);
      return{signature,messageId,sources,images,contexts,index,pending,complete:!pending&&images.every(image=>image.complete)};
    }).filter(Boolean);
    const text=clean(document.body?.innerText||'').slice(-30000);
    return{conversationKey:location.href,imageSets,imageSetSignatures:imageSets.map(item=>item.signature),pending:imageSets.some(item=>item.pending)||/生成中|正在生成|排队中|任务处理中/.test(text)};
  })()`);
}

function imageExtension(buffer, mime = "", source = "") {
  if (buffer?.length >= 12) {
    if (buffer[0] === 0x89 && buffer.slice(1, 4).toString("ascii") === "PNG") return "png";
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
    if (buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") return "webp";
    if (buffer.slice(0, 6).toString("ascii").startsWith("GIF8")) return "gif";
  }
  if (/png/i.test(mime)) return "png";
  if (/jpe?g/i.test(mime)) return "jpg";
  if (/webp/i.test(mime)) return "webp";
  if (/gif/i.test(mime)) return "gif";
  const match = /\.(png|jpe?g|webp|gif)(?:$|[?#])/i.exec(String(source));
  return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "";
}

async function readImageSource(client, source) {
  const result = await client.evaluate(`(async()=>{
    const source=${JSON.stringify(String(source || ""))};
    const response=await fetch(source,{credentials:'include'});
    if(!response.ok&&!source.startsWith('blob:'))throw new Error('HTTP '+response.status);
    const blob=await response.blob();
    const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=()=>reject(reader.error||new Error('图片读取失败'));reader.readAsDataURL(blob)});
    return{dataUrl,mime:blob.type||response.headers.get('content-type')||'',bytes:blob.size};
  })()`, true, 120000);
  const match = /^data:([^;,]+)?;base64,([\s\S]+)$/i.exec(String(result?.dataUrl || ""));
  if (!match) throw new Error("豆包图片不是可读取的图片数据");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length < 1024) throw new Error("豆包图片文件为空或不完整");
  const extension = imageExtension(buffer, result.mime || match[1], source);
  if (!extension) throw new Error("豆包返回了不支持的图片格式");
  return { buffer, extension, mime: result.mime || match[1] || "" };
}

async function saveImageSet(client, imageSet, folder, job) {
  if (!imageSet?.signature || !Array.isArray(imageSet.sources) || !imageSet.sources.length) throw new Error("图片结果身份不完整，已暂停回填");
  const files = [];
  for (let index = 0; index < imageSet.sources.length; index++) {
    const media = await readImageSource(client, imageSet.sources[index]);
    const file = path.join(folder, `豆包生成图片-${String(index + 1).padStart(2, "0")}.${media.extension}`);
    const temporary = `${file}.download`;
    fs.writeFileSync(temporary, media.buffer);
    fs.renameSync(temporary, file);
    files.push(file);
  }
  const outputs = files.map((file, index) => ({
    order: index + 1,
    file: path.basename(file),
    bytes: fs.statSync(file).size,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
  }));
  const manifest = {
    jobId: job.id,
    nodeId: job.nodeId,
    resultClaim: imageSet.signature,
    messageId: imageSet.messageId || "",
    conversationKey: imageSet.conversationKey || "",
    completedAt: new Date().toISOString(),
    outputs
  };
  fs.writeFileSync(path.join(folder, "图片结果清单.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { files, manifest };
}

async function openCompletedVideoCard(client, item) {
  if (!item?.coverSource) return false;
  const target = await client.evaluate(`(async() => {
    ${visibleHelpers}
    const source=${JSON.stringify(String(item.coverSource))};
    const images=[...document.querySelectorAll('[data-testid="message-block-container"] [data-testid="receive_message"] img')];
    const cover=images.find(image=>String(image.currentSrc||image.src||'')===source);
    if(!cover)return null;
    const container=cover.closest('[data-testid="message-block-container"]');
    const receiver=container?.querySelector('[data-testid="receive_message"]');
    if(!container||!receiver||!receiver.contains(cover)||container.querySelector('video')||!/你的视频生成好了|视频已生成|视频生成完成|已经生成好了|视频已经准备好|可以下载视频|主动发送给你/.test(clean(container.innerText||container.textContent)))return null;
    cover.scrollIntoView({block:'center',inline:'nearest'});
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const rect=cover.getBoundingClientRect();
    const x=rect.left+rect.width/2,y=rect.top+rect.height/2;
    const top=document.elementFromPoint(Math.max(0,Math.min(innerWidth-1,x)),Math.max(0,Math.min(innerHeight-1,y)));
    if(!top||!receiver.contains(top)||top.closest('[data-testid="message-block-container"]')!==container)return null;
    return{x,y,width:rect.width,height:rect.height};
  })()`, true, 10000);
  if (!target || target.width < 120 || target.height < 70) return false;
  await realClick(client, target);
  await delay(900);
  return true;
}

async function configureDownloadBehavior(client, folder) {
  fs.mkdirSync(folder, { recursive: true });
  try {
    await client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: folder, eventsEnabled: true });
    return true;
  } catch {
    try {
      await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: folder });
      return true;
    } catch { return false; }
  }
}

function listVideoFiles(folder) {
  try {
    return fs.readdirSync(folder).filter(name => /\.(mp4|mov|webm|m4v)$/i.test(name) && !/\.(crdownload|download)$/i.test(name) && !/\.h264-pending\.mp4$/i.test(name)).map(name => path.join(folder, name));
  } catch { return []; }
}

async function waitForStableVideoFile(folder, knownFiles = [], timeout = 10 * 60 * 1000) {
  const known = new Set(knownFiles.map(file => path.resolve(file).toLowerCase()));
  const sizes = new Map();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const candidates = listVideoFiles(folder).filter(file => !known.has(path.resolve(file).toLowerCase())).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const file of candidates) {
      const size = fs.statSync(file).size;
      if (size > 0 && sizes.get(file) === size) return file;
      sizes.set(file, size);
    }
    await delay(900);
  }
  return null;
}

function extensionForMedia(contentType, source) {
  if (/webm/i.test(contentType)) return "webm";
  if (/quicktime|mov/i.test(contentType)) return "mov";
  const match = /\.(mp4|mov|webm|m4v)(?:$|[?#])/i.exec(String(source));
  return match ? match[1].toLowerCase() : "mp4";
}

async function downloadHttpMedia(client, source, folder) {
  if (!/^https?:\/\//i.test(String(source))) return null;
  let cookies = [];
  try { cookies = (await client.send("Network.getCookies", { urls: [source] })).cookies || []; } catch {}
  let userAgent = "Mozilla/5.0";
  try { userAgent = (await client.send("Browser.getVersion")).userAgent || userAgent; } catch {}
  let referer = "";
  try { referer = await client.evaluate("location.href"); } catch {}
  const headers = { "User-Agent": userAgent, Accept: "video/*,*/*;q=0.8" };
  if (cookies.length) headers.Cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  if (/^https?:\/\//i.test(referer)) headers.Referer = referer;
  const requestMedia = (url, redirects = 5) => new Promise((resolve, reject) => {
    assertRunning();
    let output;
    let responseStream;
    const transport = url.startsWith("https:") ? https : http;
    const request = transport.get(url, { headers }, response => {
      responseStream = response;
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects > 0) {
        response.resume();
        return resolve(requestMedia(new URL(response.headers.location, url).href, redirects - 1));
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        return reject(new Error(`视频下载返回 HTTP ${response.statusCode}`));
      }
      const file = path.join(folder, `豆包生成结果-${Date.now()}.mp4`);
      const temporary = `${file}.download`;
      output = fs.createWriteStream(temporary);
      response.pipe(output);
      output.on("finish", () => output.close(() => {
        try { assertRunning(); fs.renameSync(temporary, file); resolve(file); } catch (error) { reject(error); }
      }));
      output.on("error", error => { try { fs.unlinkSync(temporary); } catch {} reject(error); });
      response.on("error", error => { output.destroy(); try { fs.unlinkSync(temporary); } catch {} reject(error); });
    });
    request.setTimeout(10 * 60 * 1000, () => request.destroy(new Error("下载豆包视频超时")));
    request.on("error", reject);
    const detach = onAbort(() => {
      output?.destroy(stoppedError());
      responseStream?.destroy(stoppedError());
      request.destroy(stoppedError());
      reject(stoppedError());
    });
    request.on("close", detach);
  });
  const file = await requestMedia(source);
  try {
    await ensureH264Mp4(file, message => console.log(`[video-compat] ${message}`));
  } catch (error) {
    error.downloadedFile = file;
    throw error;
  }
  return file;
}

async function findSubmitButton(client) {
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const params=[...document.querySelectorAll('[data-input-engine-actionbar-render-entry-key="creation-video-generation-params-panel"],[data-input-engine-actionbar-render-entry-key="video-generation-params-panel"]')].filter(isVisible)[0];
    const editors=[...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(isVisible);
    const editor=editors.find(element=>/视频|描述|想要/.test(clean(element.placeholder||element.getAttribute('data-placeholder')||element.getAttribute('aria-label')||element.querySelector?.('[data-placeholder]')?.getAttribute('data-placeholder'))))||editors[editors.length-1];
    if(!params||!editor)return null;
    let composer=editor;
    while(composer&&composer!==document.body&&!composer.contains(params))composer=composer.parentElement;
    composer=composer||document.body;
    const exactSelectors=['#flow-end-msg-send','[data-testid="chat_input_send_button"]','button[class*="send-msg-btn"]'];
    const exact=new Set(exactSelectors.flatMap(selector=>[...composer.querySelectorAll(selector)]));
    const list=[...composer.querySelectorAll('button,[role="button"]')].filter(isVisible);
    const scored=list.map(element=>{
      const text=clean(element.innerText||element.textContent||element.getAttribute('aria-label')||element.getAttribute('title'));
      const className=String(element.className||'');
      const testId=String(element.getAttribute('data-testid')||'');
      const r=element.getBoundingClientRect();
      const editorRect=editor.getBoundingClientRect();
      const top=document.elementFromPoint(Math.max(0,Math.min(innerWidth-1,r.left+r.width/2)),Math.max(0,Math.min(innerHeight-1,r.top+r.height/2)));
      const centerBelongsToButton=top?.closest?.('button,[role="button"]')===element;
      let score=0;
      let identified=false;
      if(exact.has(element)||element.id==='flow-end-msg-send'||testId==='chat_input_send_button'){score+=1000;identified=true}
      if(/video-send-msg-button|send-msg-button|send-msg-btn|submit/i.test(className+' '+testId)){score+=320;identified=true}
      if(/生成视频|立即生成|^生成$|发送/.test(text)){score+=220;identified=true}
      if(r.left>editorRect.left+editorRect.width*.65)score+=60;
      if(r.width>=28&&r.width<=56&&r.height>=28&&r.height<=56)score+=30;
      if(centerBelongsToButton)score+=20;else score-=300;
      const disabled=element.disabled||element.getAttribute('aria-disabled')==='true'||element.getAttribute('data-disabled')==='true';
      if(disabled)score-=1000;
      return{score:identified?score:-1000,text,id:element.id||'',testId,x:r.left+r.width/2,y:r.top+r.height/2,width:r.width,height:r.height,disabled,centerBelongsToButton};
    }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
    return scored[0]||null;
  })()`);
}

async function quotaFeedbackState(client) {
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const pattern = ${QUOTA_TEXT_PATTERN.toString()};
    const elements = [...document.querySelectorAll('[role="alert"],[role="dialog"],[data-testid],div,p,span')].filter(isVisible);
    const results = [];
    for (const element of elements) {
      const text = clean(element.innerText || element.textContent);
      if (!text || text.length > 500 || !pattern.test(text)) continue;
      const childHasSame = [...element.children].some(child => isVisible(child) && pattern.test(clean(child.innerText || child.textContent)));
      if (childHasSame) continue;
      let container=element;const contexts=[];for(let depth=0;container&&container!==document.body&&depth<13;depth++,container=container.parentElement){const value=clean(container.innerText||container.textContent);if(value&&value.length<=8000)contexts.push(value)}
      const signature = [element.tagName, element.getAttribute('role') || '', element.getAttribute('data-testid') || '', String(element.className || '').slice(0,100), text].join('|');
      results.push({ signature, text, contexts, index: results.length });
    }
    return results;
  })()`);
}

async function complianceConfirmationState(client) {
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const pattern = ${COMPLIANCE_CONFIRM_PATTERN.toString()};
    const elements = [...document.querySelectorAll('[role="alert"],[role="dialog"],[aria-modal="true"],[data-testid],button,[role="button"],div,p,span')].filter(isVisible);
    const results = [];
    for (const element of elements) {
      const text = clean(element.innerText || element.textContent);
      if (!text || text.length > 700 || !pattern.test(text)) continue;
      const childHasSame = [...element.children].some(child => isVisible(child) && pattern.test(clean(child.innerText || child.textContent)));
      if (childHasSame) continue;
      let container=element;const contexts=[];for(let depth=0;container&&container!==document.body&&depth<13;depth++,container=container.parentElement){const value=clean(container.innerText||container.textContent);if(value&&value.length<=8000&&!contexts.includes(value))contexts.push(value)}
      const localContext=contexts.find(value=>value.length>text.length+8&&value.length<=3000)||contexts[0]||'';
      const signature=[element.tagName,element.getAttribute('role')||'',element.getAttribute('data-testid')||'',text,localContext].join('|');
      results.push({signature,text,contexts,index:results.length});
    }
    return results;
  })()`);
}

async function findComplianceConfirmButton(client, scope = null) {
  return client.evaluate(`(() => {
    ${visibleHelpers}
    const scope = ${JSON.stringify(scope)};
    const compliance = ${COMPLIANCE_CONFIRM_PATTERN.toString()};
    const paid = ${PAID_QUOTA_CONFIRM_PATTERN.toString()};
    const positive = /^(?:确认|我已确认|确认并继续|同意并继续|继续生成|确认素材)$/;
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(isVisible);
    const candidates=[];
    for(const button of buttons){
      const label=clean(button.innerText||button.textContent||button.getAttribute('aria-label')||button.getAttribute('title'));
      if(!positive.test(label)||button.disabled||button.getAttribute('aria-disabled')==='true')continue;
      let context='';let root=button;
      for(let depth=0;root&&root!==document.body&&depth<14;depth++,root=root.parentElement){
        const text=clean(root.innerText||root.textContent);
        if(text&&text.length<=3200&&compliance.test(text)){context=text;break}
      }
      if(!context||paid.test(context))continue;
      if(scope){
        const block=button.closest('[data-testid="message-block-container"]');
        const blocks=[...document.querySelectorAll('[data-testid="message-block-container"]')];
        if(block ? (scope.messageId ? ![...block.querySelectorAll('[data-message-id]')].some(e=>e.getAttribute('data-message-id')===scope.messageId) : blocks.indexOf(block)!==scope.messageIndex) : !clean(context).includes(clean(scope.text)))continue;
      }
      const r=button.getBoundingClientRect();
      const x=r.left+r.width/2,y=r.top+r.height/2;
      const top=document.elementFromPoint(x,y);
      if(!top||!(top===button||button.contains(top)))continue;
      candidates.push({x,y,label,context,width:r.width,height:r.height,score:(root?.getAttribute?.('role')==='dialog'?60:0)+r.top/innerHeight*20-r.width/innerWidth*10});
    }
    candidates.sort((a,b)=>b.score-a.score);
    return candidates.length===1?candidates[0]:null;
  })()`);
}

async function autoConfirmCompliance(client, {scope, verifyAccount = async()=>{}, shouldStop = ()=>false} = {}) {
  if(shouldStop())throw stoppedError();
  await verifyAccount();
  await activatePageForInput(client);
  const target = await waitFor(client, () => findComplianceConfirmButton(client,scope), 5000, 200);
  if (!target) return { clicked: false };
  await verifyAccount();
  if(shouldStop())throw stoppedError();
  const fresh=await findComplianceConfirmButton(client,scope);
  if(!fresh)return {clicked:false};
  await realClick(client,fresh);
  // A button can remain mounted after accepting a click. Never click a second time
  // or require its disappearance as proof of whether the server accepted the video.
  return {clicked:true,label:fresh.label,context:fresh.context};
}

async function conversationMessageState(client) {
  return client.evaluate(readConversationMessagesScript, true, 45000);
}

function relatedSubmissionMessages(before, current, prompt) {
  const known = new Set(before?.messageSignatures || before?.messages?.map(item => item.signature) || []);
  const expected = compactForMatch(prompt);
  const fresh = (current?.messages || []).filter(item => item?.signature && !known.has(item.signature)
    && !(before?.messages||[]).some(old=>sameMessage(old,item)||old.signature===item.legacySignature));
  const user = [...fresh].reverse().find(item => item.sender === "user" && expected && compactForMatch(item.text).includes(expected));
  if (!user) return { fresh, user: null, assistant: [] };
  const assistant = fresh.filter(item => item.sender === "assistant" && item.index > user.index);
  return { fresh, user, assistant };
}

function manualSubmissionRootAllowed(before, current, user) {
  if (!before?.manualSubmissionRequested || !user || !hasStableIdentity(user)) return false;
  const origin = String(before.manualOriginUrl || before.messageState?.url || "");
  const currentUrl = String(current?.url || "");
  if (sameConversationUrl(origin, currentUrl)) return true;
  const originKey = nativeConversationKey(origin);
  const currentKey = nativeConversationKey(currentUrl);
  const temporaryOrigin = originKey === "doubao-chat/chat" || /^doubao-chat\/chat\/(?:create-video|local_[^/]+)$/.test(originKey);
  const isNewConversationTransition = temporaryOrigin && /^doubao-chat\/chat\/[^/]+$/.test(currentKey) && currentKey !== originKey;
  if (!isNewConversationTransition) return false;
  const raw = String(user.createdAt || "").trim();
  let createdAt = Number(raw);
  while (Number.isFinite(createdAt) && createdAt > 1e14) createdAt /= 1000;
  if (Number.isFinite(createdAt) && createdAt > 0 && createdAt < 1e12) createdAt *= 1000;
  if (!Number.isFinite(createdAt) || createdAt <= 0) createdAt = Date.parse(raw);
  return Number.isFinite(createdAt)
    && createdAt >= Number(before.manualSubmissionStartedAt || 0) - 5000
    && createdAt <= Date.now() + 60000;
}

function newQuotaFeedback(before = [], current = []) {
  const counts = new Map();
  for (const item of before) counts.set(item.signature, (counts.get(item.signature) || 0) + 1);
  for (const item of current) {
    const remaining = counts.get(item.signature) || 0;
    if (remaining > 0) counts.set(item.signature, remaining - 1);
    else return item;
  }
  return null;
}

function newFeedback(before = [], current = []) {
  const counts = new Map();
  for (const item of before) counts.set(item.signature, (counts.get(item.signature) || 0) + 1);
  for (const item of current) {
    const remaining = counts.get(item.signature) || 0;
    if (remaining > 0) counts.set(item.signature, remaining - 1);
    else return item;
  }
  return null;
}

async function waitForSubmissionAccepted(client, prompt, before, timeout, shouldStop = () => false, ignoredSignatures = new Set()) {
  let lastConfirmationText = "", stableSince = 0;
  return waitFor(client, async () => {
    if (shouldStop()) return { stopped: true };
    if (before.accountIdentity?.name) {
      const actual = await readCurrentAccount(client);
      if (!actual || !accountIdentityMatches(actual,before.accountIdentity)) return {needsAttention:true,message:"当前不是原任务账号，已暂停核验，不能读取其他账号的回执"};
    }
    const messages = await conversationMessageState(client);
    let related = relatedSubmissionMessages(before.messageState, messages, prompt);
    if (related.user && before.manualSubmissionRequested && !manualSubmissionRootAllowed(before, messages, related.user)) {
      return {needsAttention:true,keepMonitoring:true,message:"人工提交监听仍停留在原任务；请回到刚才的豆包视频生成页面操作，画布不会从其他历史对话认领任务"};
    }
    // In manual takeover mode Doubao may visually fold a very long sent message.
    // The submission lane is still locked at this point, so a single fresh user
    // message with a stable identity and a matching prompt prefix is safe to bind.
    if (!related.user && before.manualSubmissionRequested) {
      const expected = compactForMatch(prompt);
      const prefixLength = Math.min(120, expected.length);
      const prefix = expected.slice(0, prefixLength);
      const manualRoots = related.fresh.filter(item => {
        if (item.sender !== "user" || !hasStableIdentity(item)) return false;
        const actual = compactForMatch(item.text);
        return prefixLength >= 12 && actual.includes(prefix) && manualSubmissionRootAllowed(before, messages, item);
      });
      if (manualRoots.length === 1) {
        const user = manualRoots[0];
        related = { ...related, user, manualRoot: true, assistant: related.fresh.filter(item => item.sender === "assistant" && item.index > user.index) };
      }
    }
    if (!before.confirmationContext && !before.submissionContext && related.user) {
      const expected = compactForMatch(prompt);
      const roots = related.fresh.filter(item => item.sender === 'user' && expected && compactForMatch(item.text).includes(expected));
      if (roots.length !== 1 && !related.manualRoot) return {needsAttention:true,message:"出现多个相同提示词的提交，不能确定原任务归属；保留任务，请核对原对话"};
      before.submissionContext = {url:messages.url,root:related.user,autoAttempted:false};
    }
    const context=before.confirmationContext||before.submissionContext;
    if(context&&!hasStableIdentity(context.root)&&!context.previousMessages&&before.messageState){
      context.previousMessages=before.messageState.messages||[];
    }
    const chain = context ? confirmationChain(context, messages) : null;
    if (chain && !chain.valid) return {needsAttention:true, keepMonitoring:true, reason:chain.reason, message:chain.reason==='different-conversation'?"正在核对原任务对话地址，尚未恢复结果关联":"已连接原对话，正在核对本次提交消息；尚未找到唯一对应关系"};
    const strictAssistant = (chain ? chain.assistant : related.assistant.filter(item => item.previousUserIndex === related.user?.index))
      .filter(item=>!ignoredSignatures.has(item.signature));
    const accepted = receipt => {
      before.acceptedMessageIndex = receipt.index;
      before.acceptedMessageId = receipt.messageId || '';
      before.acceptedReceipt = receipt;
      return {accepted:true,receipt,messageState:messages,submittedUserMessage:chain?.root||related.user};
    };
    // Resolve THIS task's timeline, not the first matching phrase anywhere on the page.
    // A later receipt supersedes an earlier confirmation/busy response; a later rejection still wins.
    for (const item of [...strictAssistant].sort((a,b)=>b.index-a.index)) {
      const common={messageState:messages,submittedUserMessage:chain?.root||related.user};
      const action=actionType=>{
        if(context)before.confirmationContext ||= context;
        return {actionRequired:true,actionType,actionMessage:item.text,actionSignature:item.signature,actionMessageIndex:item.index,...common};
      };
      if (/视频生成已提交/.test(item.text) && !isGenerationFailureText(item.text)) return accepted(item);
      if (isPaidQuotaConfirmationText(item.text)) return action('paid_quota');
      if (isQuotaExhaustedText(item.text)) return {quotaExhausted:true,quotaMessage:item.text,...common};
      if (transientVideoFeedback(item.text)) return {temporarilyUnavailable:true,message:item.text,...common};
      if (isGenerationFailureText(item.text)) return {generationFailure:true,failureMessage:item.text,quotaNotDeducted:isQuotaNotDeductedFailureText(item.text),...common};
      if (/你的视频生成好了|视频已生成|视频生成完成|已经生成好了|可以下载视频/.test(item.text) && chain) {
        const media=await downloadState(client,context);
        if ([...(media.completedCardItems||[]),...(media.videoItems||[])].some(card=>card.messageIndex===item.index)) return accepted(item);
      }
      if (isComplianceConfirmationText(item.text)) return action('compliance');
      if (parameterConfirmation(item.text,before.requestedJob).detected) {
        if(item.text!==lastConfirmationText){lastConfirmationText=item.text;stableSince=Date.now();}
        return Date.now()-stableSince>=800 ? action('generation_parameters') : null;
      }
      // Cost wording alone is not an acceptance receipt.
      if (/预计等待.{0,20}分钟/.test(item.text) && /视频生成好后.{0,20}(?:发送|通知)/.test(item.text)) return accepted(item);
    }
    if (chain?.interrupted) return {needsAttention:true,keepMonitoring:true,message:"已检测到后续消息，继续按原提交编号核验，不会读取其他任务回执"};

    // An unowned page-wide dialog must not fail another concurrent task.
    return null;
  }, timeout, 500);
}

function savePendingSubmission(folder, before, job, message) {
  const file=path.join(folder,"豆包待确认.json");
  const temporary=`${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary,JSON.stringify({v:1,jobId:job.id,nodeId:job.nodeId,accountIdentity:job.accountIdentity,before,message},null,2));
  fs.renameSync(temporary,file);
}

async function sendGenerationConfirmation(client, context, verifyAccount, shouldStop) {
  if (shouldStop()) throw stoppedError();
  await verifyAccount();
  const current=await conversationMessageState(client);
  const chain=confirmationChain(context,current);
  if(!chain.valid||chain.interrupted||chain.users.length!==1||chain.assistant.at(-1)?.signature!==context.questionSignature)return false;
  const editor=await client.evaluate(confirmationEditorScript,false);
  if(!editor?.objectId)return false;
  await client.send("Runtime.callFunctionOn",{objectId:editor.objectId,functionDeclaration:`function(value){
    if(String(this.value??this.innerText??'').trim())return false;
    if(this instanceof HTMLTextAreaElement){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(this,value)}
    else this.replaceChildren(document.createTextNode(value));
    this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));this.dispatchEvent(new Event('change',{bubbles:true}));return true;
  }`,arguments:[{value:CONFIRM_REPLY}],returnByValue:true});
  const button=await waitFor(client,async()=>{const b=await client.evaluate(confirmationSendScript);return b?.value===CONFIRM_REPLY?b:null},2000,120);
  if(!button)return false;
  await verifyAccount();
  const recheck=confirmationChain(context,await conversationMessageState(client));
  if(!recheck.valid||recheck.interrupted||recheck.users.length!==1||recheck.assistant.at(-1)?.signature!==context.questionSignature)return false;
  if(shouldStop())throw stoppedError();
  const fresh=await client.evaluate(confirmationSendScript);
  if(!fresh||fresh.value!==CONFIRM_REPLY)return false;
  await realClick(client,fresh);
  return true;
}

async function resumePendingSubmission(client, folder, job, shouldStop = () => false) {
  const pending=JSON.parse(fs.readFileSync(path.join(folder,"豆包待确认.json"),"utf8"));
  if(pending.jobId!==job.id||!accountIdentityMatches(pending.accountIdentity,job.accountIdentity)) throw new Error("待确认记录与原任务账号不一致，已拒绝继续");
  await verifyTaskAccount(client,job.accountIdentity);
  // Manual resume only reads receipts. It NEVER sends a confirmation or uploads again.
  const outcome=await waitForSubmissionAccepted(client,job.submittedPrompt||job.prompt,pending.before,2500,shouldStop);
  if(outcome?.quotaExhausted)throw controllerError("DOUBAO_QUOTA_EXHAUSTED",outcome.quotaMessage);
  if(outcome?.generationFailure)throw controllerError("DOUBAO_GENERATION_REJECTED",outcome.failureMessage);
  if(!outcome?.accepted)return {ok:true,needsAttention:true,message:outcome?.message||"尚未看到原任务的正式受理凭据；请在豆包原对话处理后再继续核验，不要重新生成"};
  pending.before.awaitingSubmissionReceipt=false;
  fs.writeFileSync(path.join(folder,"豆包提交凭据.json"),JSON.stringify({jobId:job.id,receipt:outcome.receipt,baseline:pending.before,acceptedAt:new Date().toISOString()},null,2));
  return {ok:true,baseline:pending.before,client};
}

async function submitAndVerify(client, prompt, progress, folder, expectedAttachments = 0, shouldStop = () => false, onBeforeSubmit = async () => {}, onSubmissionState = () => {}, verifyAccount = async () => {}, job = {}, promptPasteEvidence = null) {
  if (shouldStop()) throw controllerError("DOUBAO_TASK_STOPPED", "任务已由用户停止");
  const before = await downloadState(client);
  const quotaBefore = await quotaFeedbackState(client);
  const confirmationBefore = await complianceConfirmationState(client);
  const messageBefore = await conversationMessageState(client);
  before.quotaItems = quotaBefore;
  before.quotaSignatures = quotaBefore.map(item => item.signature);
  before.confirmationItems = confirmationBefore;
  before.messageState = messageBefore;
  before.targetId = client.targetId || '';
  before.accountIdentity = job.accountIdentity;
  before.requestedJob = {model:job.model,ratio:job.ratio,duration:job.duration};
  const pause = message => {
    savePendingSubmission(folder,before,job,message);
    onSubmissionState({state:"needs_attention",message});
    progress(message);
    return {needsAttention:true,before,message};
  };
  const pending = (message, state = 'awaiting_receipt') => {
    before.awaitingSubmissionReceipt=true;
    before.receiptDeadline ||= Date.now()+2*60*1000;
    before.pendingState=state;
    savePendingSubmission(folder,before,job,message);
    onSubmissionState({state,message});
    progress(message);
    return {pendingReceipt:true,before,message,pendingState:state};
  };
  let submissionPrepared = false;
  const prepareSubmission = async () => {
    if (submissionPrepared) return;
    await onBeforeSubmit(client);
    submissionPrepared = true;
  };
  const attachments = await attachmentState(client);
  if (attachments.count !== expectedAttachments || attachments.uploading) {
    throw new Error(`提交前检查失败：画布连接 ${expectedAttachments} 张参考图，豆包中有 ${attachments.count} 张${attachments.uploading ? "且仍在上传" : ""}`);
  }
  const pasteEvidenceRequired = promptPasteEvidence !== null;
  const pasteEventQualified = !pasteEvidenceRequired || qualifiedPromptPasteEvidence(promptPasteEvidence);
  const promptRecognition = pasteEvidenceRequired && promptPasteEvidence.safeToAutoSubmitByPasteEvidence
    ? { matched: true, evidence: promptPasteEvidence.domAuxiliary, waitedMs: 0, byPasteEvidence: true }
    : await waitForPromptRecognition(client, prompt, {
      timeout: 15000,
      interval: 350,
      shouldStop,
      onWaiting: () => {
        const message = pasteEventQualified
          ? "豆包已收到完整可信粘贴，但输入区辅助核对尚未稳定；现在开始限时识别 15 秒，不会重复填写或刷新页面"
          : "本次唯一粘贴未取得合格可信回执；现在开始限时识别 15 秒，不会重复粘贴、刷新页面或冒险点击生成";
        progress(message);
        onSubmissionState({ state: "waiting_prompt_recognition", message });
      }
    });
  if (!promptRecognition.matched || !pasteEventQualified) {
    await verifyAccount();
    await prepareSubmission();
    before.manualSubmissionRequested = true;
    before.manualSubmissionStartedAt = Date.now();
    before.manualOriginUrl = messageBefore.url || "";
    before.manualTargetId = client.targetId || "";
    before.receiptDeadline = Date.now() + 2 * 60 * 1000;
    await captureStage(client, folder, "05-等待人工提交");
    const reason = !pasteEventQualified
      ? "本次唯一粘贴没有取得可自动提交的完整可信回执"
      : "等待 15 秒后仍未从豆包读取到完整提示词";
    return pending(`${reason}。请在当前豆包页面手动确认提示词并点击生成；画布正在监听这一次人工提交，不会重新上传、补写或点击生成`, "waiting_manual_submission");
  }
  if (promptRecognition.waitedMs > 0) {
    const message = "已经从豆包识别到完整提示词，继续按原流程提交";
    progress(message);
    onSubmissionState({ state: "submitting", message });
  }
  await activatePageForInput(client);
  const button = await waitFor(client, () => findSubmitButton(client), 5000, 120);
  if (!button) throw new Error("豆包页面中没有找到视频生成按钮");
  if (button.disabled) throw new Error("豆包生成按钮不可用，请查看诊断截图中的页面提示");
  if (!button.centerBelongsToButton) throw new Error("豆包生成按钮被其他界面遮挡，已停止提交以避免误点");
  if (shouldStop()) throw controllerError("DOUBAO_TASK_STOPPED", "任务已由用户停止");
  await captureStage(client, folder, "05-提交前最终检查");
  await prepareSubmission();
  await verifyAccount();
  if (shouldStop()) throw stoppedError();
  progress("所有内容已核对，正在点击豆包生成……");
  before.clickedAt=Date.now();
  try { await realClick(client, button); }
  catch(error){assertRunning();if(shouldStop())throw stoppedError();return pending("提交点击结果暂时无法确认，正在核验原任务；不会再次点击以免重复生成");}
  const waitForFinalOutcome = async timeout => {
    const ignoredSignatures = new Set();
    let outcome = await waitForSubmissionAccepted(client, prompt, before, timeout, shouldStop, ignoredSignatures);
    while (outcome?.actionRequired) {
      ignoredSignatures.add(outcome.actionSignature);
      if(outcome.actionType === "generation_parameters") {
        before.confirmationContext ||= {url:outcome.messageState.url,root:outcome.submittedUserMessage,autoAttempted:false};
        const context=before.confirmationContext;
        const check=parameterConfirmation(outcome.actionMessage,job);
        if(context.autoAttempted||!check.safe) return {needsAttention:true,message:context.autoAttempted?"已自动确认一次，豆包仍需处理；请到原对话确认后点历史中的继续核验":"豆包要求确认的参数不完整、不一致或涉及费用/权利，请人工处理后继续核验"};
        context.autoAttempted=true;
        context.questionSignature=outcome.actionSignature;
        savePendingSubmission(folder,before,job,"正在确认生成；任何重启或重试都不会自动再次发送");
        let sent=false;
        try { sent=await sendGenerationConfirmation(client,context,verifyAccount,shouldStop); }
        catch(error){assertRunning();if(error.code==='DOUBAO_TASK_STOPPED')throw error;}
        if(!sent)return {needsAttention:true,message:"未能安全完成确认发送，已停止自动尝试；请查看原对话后继续核验"};
        const message="已自动确认本任务参数一次，正在核验豆包是否正式受理";
        progress(message);onSubmissionState({state:"submitting",message});
        outcome=await waitForSubmissionAccepted(client,prompt,before,20000,shouldStop,ignoredSignatures);
        if(!outcome)return {needsAttention:true,message:"确认后仍未收到原任务正式凭据；保留原任务，请人工处理后继续核验"};
        continue;
      }
      const paidQuota = outcome.actionType === "paid_quota";
      if(paidQuota){
        const message="豆包等待你手动确认付费；画布继续核验原任务回执，超时后可点击同步结果";
        savePendingSubmission(folder,before,job,message);
        onSubmissionState({state:'waiting_paid_confirmation',message,detail:outcome.actionMessage});
        return {pendingReceipt:true,pendingState:'waiting_paid_confirmation',message};
      }
      if (!paidQuota) {
        if(before.complianceAttempted) return {pendingReceipt:true,message:"素材确认已尝试，正在核验原任务回执；不会再次点击或重新提交"};
        // Persist BEFORE the click so an interrupted/retried job cannot click twice.
        before.complianceAttempted=true;
        savePendingSubmission(folder,before,job,"正在尝试本任务素材确认");
        const confirmed = await autoConfirmCompliance(client,{scope:{messageIndex:outcome.actionMessageIndex,text:outcome.actionMessage},verifyAccount,shouldStop});
        if (confirmed.clicked) {
          const message = "画布已识别并点击本任务的豆包素材确认，正在等待正式提交凭据";
          progress(message);
          onSubmissionState({ state: "submitting", message, detail: outcome.actionMessage || "", quotaExhausted: false });
          await captureStage(client, folder, "06-画布已自动确认素材");
          outcome = await waitForSubmissionAccepted(client, prompt, before, 30000, shouldStop, ignoredSignatures);
          continue;
        }
      }
      const state = paidQuota ? "waiting_paid_confirmation" : "waiting_confirmation";
      const message = paidQuota
        ? "豆包提示免费额度已用完并询问是否使用付费额度；画布不会代替你确认，后续提交已暂停"
        : "豆包正在等待素材确认，但没有识别到可安全点击的确认按钮；请在豆包中人工确认，画布会继续监听且不会结束本任务";
      progress(message);
      // “是否使用付费额度”是等待用户选择，不是账号失效或任务失败。
      onSubmissionState({ state, message, detail: outcome.actionMessage || "", quotaExhausted: false });
      before.pendingState=state;
      outcome = await waitForSubmissionAccepted(client, prompt, before, 1000, shouldStop, ignoredSignatures);
      if(!outcome)return {pendingReceipt:true,pendingState:state,message};
      if (outcome?.accepted) onSubmissionState({ state: "submitting", message: "已检测到豆包确认完成和正式提交凭据" });
    }
    return outcome;
  };
  let accepted;
  try { accepted = await waitForFinalOutcome(20000); }
  catch(error){assertRunning();if(shouldStop())throw stoppedError();return pending(`提交后页面暂时无法读取，保留原任务继续核验：${error.message}`);}
  if(accepted?.needsAttention)return pending(accepted.message,'monitor_paused');
  if(accepted?.paidBlocked)return {paidBlocked:true,message:accepted.message,before};
  if(accepted?.pendingReceipt)return pending(accepted.message,accepted.pendingState);
  if(accepted?.temporarilyUnavailable)return pending("豆包暂时繁忙，正在继续核验原任务是否受理；不会重复上传或提交");
  if (accepted?.stopped) throw controllerError("DOUBAO_TASK_STOPPED", "任务已由用户停止");
  if (accepted?.generationFailure) {
    throw controllerError("DOUBAO_GENERATION_REJECTED", `豆包没有受理本次任务：${accepted.failureMessage || "生成被拒绝"}`, { quotaNotDeducted: Boolean(accepted.quotaNotDeducted) });
  }
  if (accepted?.quotaExhausted) {
    throw controllerError("DOUBAO_QUOTA_EXHAUSTED", accepted.quotaMessage || "豆包提示今日免费额度已经用完");
  }
  await captureStage(client, folder, accepted ? "07-豆包已接受任务" : "07-豆包未接受任务");
  if (!accepted) {
    return pending(before.complianceAttempted ? "素材确认后尚未读到正式回执，正在继续核验原任务；不会重复提交" : "已点击提交，豆包回执暂未到达，正在继续核验；不会因响应慢判失败或重复提交");
  }
  return { before, accepted };
}

async function waitForImageSubmissionAccepted(client, prompt, before, quotaBefore, timeout, shouldStop = () => false) {
  const expected = String(prompt || "").replace(/\r\n/g, "\n").trim();
  const known = new Set(before?.imageSetSignatures || []);
  return waitFor(client, async () => {
    if (shouldStop()) return { stopped: true };
    const quota = newQuotaFeedback(quotaBefore, await quotaFeedbackState(client));
    if (quota) return { quotaExhausted: true, quotaMessage: quota.text };
    const currentPrompt = await readImagePrompt(client);
    const state = await imageResultState(client);
    const promptChanged = currentPrompt.replace(/\r\n/g, "\n").trim() !== expected;
    const statusChanged = !before.pending && state.pending;
    const freshAssistantResult = state.imageSets.some(item => item.signature && !known.has(item.signature));
    return promptChanged || statusChanged || freshAssistantResult ? { state, promptChanged, statusChanged, freshAssistantResult } : null;
  }, timeout, 350);
}

async function submitImageAndVerify(client, job, progress, folder, shouldStop = () => false) {
  if (shouldStop()) throw controllerError("DOUBAO_TASK_STOPPED", "任务已由用户停止");
  const before = await imageResultState(client);
  try {
    const failureState = await downloadState(client);
    before.failureItems = failureState.failureItems || [];
    before.failureSignatures = failureState.failureSignatures || [];
  } catch {}
  const quotaBefore = await quotaFeedbackState(client);
  before.quotaItems = quotaBefore;
  before.quotaSignatures = quotaBefore.map(item => item.signature);
  const expected = String(job.submittedPrompt || job.prompt || "").replace(/\r\n/g, "\n").trim();
  const entered = (await readImagePrompt(client)).replace(/\r\n/g, "\n").trim();
  if (entered !== expected) throw new Error("提交前检查失败：豆包图片提示词与画布不一致");
  const model = await findImageControl(client, "model");
  const ratio = await findImageControl(client, "ratio");
  if (!model?.text?.includes(job.model)) throw new Error(`提交前检查失败：豆包图片模型不是 ${job.model}`);
  if (ratio?.text?.replace(/^比例\s*/, "") !== job.ratio) throw new Error(`提交前检查失败：豆包图片比例不是 ${job.ratio}`);
  await closeImageOptionMenu(client);
  const button = await waitFor(client, () => findImageSubmitButton(client), 5000, 120);
  if (!button) throw new Error("豆包页面中没有找到图片生成按钮");
  if (button.disabled) throw new Error("豆包图片生成按钮不可用，请查看诊断截图中的页面提示");
  if (!button.centerBelongsToButton) throw new Error("豆包图片生成按钮被其他界面遮挡，已停止提交以避免误点");
  await activatePageForInput(client);
  await captureStage(client, folder, "04-图片提交前最终检查");
  progress("图片提示词、模型、比例与账号均已核对，正在点击豆包生成……");
  await realClick(client, button);
  const accepted = await waitForImageSubmissionAccepted(client, expected, before, quotaBefore, 15000, shouldStop);
  if (accepted?.stopped) throw controllerError("DOUBAO_TASK_STOPPED", "任务已由用户停止");
  if (accepted?.quotaExhausted) throw controllerError("DOUBAO_QUOTA_EXHAUSTED", accepted.quotaMessage || "豆包提示今日图片额度已经用完");
  await captureStage(client, folder, accepted ? "05-豆包已接受图片任务" : "05-豆包未接受图片任务");
  if (!accepted) throw new Error("豆包没有确认接收图片任务；为避免重复扣图片额度，画布没有自动再次点击");
  // 新对话第一次提交后，豆包会把 chat/? 异步替换为真正的会话 ID。先等地址
  // 稳定，再把它锁进任务清单，避免正常建会话被误判成用户切换了对话。
  let conversationKey = accepted.state?.conversationKey || before.conversationKey;
  let stableRounds = 0;
  const stabilizeDeadline = Date.now() + 4000;
  while (Date.now() < stabilizeDeadline && stableRounds < 3) {
    await delay(220);
    let current;
    try { current = await imageResultState(client); } catch { break; }
    if (current.conversationKey === conversationKey) stableRounds += 1;
    else { conversationKey = current.conversationKey; stableRounds = 0; }
  }
  before.conversationKey = conversationKey;
  return { before, accepted };
}

function writeImageSubmissionManifest(folder, job, baseline) {
  const manifest = {
    jobId: job.id,
    nodeId: job.nodeId,
    type: "image",
    createdAt: new Date().toISOString(),
    profileId: job.profileId || "default",
    accountIdentity: job.accountIdentity,
    prompt: job.prompt,
    submittedPrompt: job.submittedPrompt || job.prompt,
    model: job.model,
    ratio: job.ratio,
    conversationKey: baseline?.conversationKey || "",
    baselineImageSetSignatures: baseline?.imageSetSignatures || []
  };
  fs.writeFileSync(path.join(folder, "图片提交清单.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

async function submitImageOnClient({ client, job, folder, progress, shouldStop = () => false }) {
  const assertRunning = () => { if (shouldStop()) throw controllerError("DOUBAO_TASK_STOPPED", "任务已由用户停止"); };
  try {
    assertRunning();
    if (compactForMatch(job.prompt).length < 4) throw new Error("图片提示词至少填写 4 个有效字符，才能安全核对结果归属");
    const composer = await ensureImageComposer(client, progress, folder);
    if (composer.needLogin) return { ok: false, needLogin: true };
    client = composer.client || client;
    assertRunning();
    job.submittedPrompt = String(job.prompt || "").trim();
    await fillImagePrompt(client, job.submittedPrompt, progress, folder);
    progress("正在同步豆包实际提供的图片模型和比例……");
    await chooseImageModel(client, job.model);
    await chooseImageRatio(client, job.ratio);
    assertRunning();
    await captureStage(client, folder, "03-图片参数已同步");
    const submitted = await submitImageAndVerify(client, job, progress, folder, shouldStop);
    const manifest = writeImageSubmissionManifest(folder, job, submitted.before);
    return { ok: true, submitted: true, manifest, baseline: submitted.before, client };
  } catch (error) {
    await captureStage(client, folder, "99-图片任务失败现场");
    client.close();
    throw error;
  }
}

async function submitImageJob({ exe, job, folder, progress, log, accountIdentity, shouldStop }) {
  const connection = await ensureControlledNative({ exe, progress, log });
  const selected = await switchToAccount({ client: connection.client, target: accountIdentity || job.accountIdentity, progress });
  job.accountIdentity = normalizeAccountIdentity(selected.current || accountIdentity || job.accountIdentity);
  const result = await submitImageOnClient({ client: selected.client, job, folder, progress, shouldStop });
  return { ...result, port: connection.port };
}

function writeManifest(folder, job, files, upload, stages = {}) {
  const references = files.map((file, index) => ({
    order: index + 1,
    label: `（图${["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"][index] || index + 1}）`,
    file: path.basename(file),
    bytes: fs.statSync(file).size,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
  }));
  const manifest = {
    jobId: job.id,
    createdAt: new Date().toISOString(),
    profileId: job.profileId || "default",
    prompt: job.prompt,
    submittedPrompt: job.submittedPrompt || job.prompt,
    model: job.model,
    ratio: job.ratio,
    duration: job.duration,
    references,
    upload,
    stages
  };
  fs.writeFileSync(path.join(folder, "提交清单.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function submitOnClient({ client, job, files, folder, progress, log = () => {}, shouldStop = () => false, onBeforeSubmit = async () => {}, onBeforePromptPaste = null, onSubmissionState = () => {} }) {
  const assertRunning = () => { if (shouldStop()) throw controllerError("DOUBAO_TASK_STOPPED", "任务已由用户停止"); };
  try {
    assertRunning();
    const composer = await ensureVideoComposer(client, progress, folder);
    if (composer.needLogin) return { ok: false, needLogin: true };
    client = composer.client || client;
    assertRunning();
    await verifyTaskAccount(client, job.accountIdentity);
    job.submittedPrompt = String(job.prompt || "").trim();
    const verifiedPasteMode = typeof onBeforePromptPaste === "function";
    const uploadOptions = {
      onStage: (stage, details) => log(`上传阶段 ${stage} ${JSON.stringify(details)}`)
    };
    if (!verifiedPasteMode) uploadOptions.onBeforeAssign = () => fillPrompt(client, job.submittedPrompt, progress, folder);
    const upload = await uploadReferences(client, files, progress, folder, () => verifyTaskAccount(client, job.accountIdentity), uploadOptions);
    assertRunning();
    job.submittedPrompt = String(job.prompt || "").trim();
    // A successful first write is never repeated merely because Doubao's long-text
    // editor is temporarily unreadable. The final pre-submit gate below passively
    // reacquires and observes the live editor for up to 15 seconds.
    if (!verifiedPasteMode && !upload.promptPrepared) {
      try { await fillPrompt(client, job.submittedPrompt, progress, folder); }
      catch (error) {
        assertRunning();
        if (error.code === "DOUBAO_TASK_STOPPED") throw error;
        progress(`首次填写后豆包输入区暂不可读，将在提交前开始限时识别：${error.message}`);
      }
    }
    assertRunning();
    progress("正在同步豆包实际提供的模型、比例和时长……");
    await chooseModel(client, job.model);
    await chooseRatioAndDuration(client, job.ratio, job.duration, job.model);
    assertRunning();
    await captureStage(client, folder, "04-参数已同步");
    await verifyTaskAccount(client, job.accountIdentity);
    let promptPasteEvidence = null;
    if (verifiedPasteMode) {
      await resetPromptDraftForPaste(client, progress);
      await onBeforePromptPaste();
      promptPasteEvidence = await pastePromptWithEvidence(client, job.submittedPrompt, progress, folder);
    }
    const manifest = writeManifest(folder, job, files, upload);
    const submitted = await submitAndVerify(client, job.submittedPrompt, progress, folder, files.length, shouldStop, onBeforeSubmit, onSubmissionState, () => verifyTaskAccount(client, job.accountIdentity), job, promptPasteEvidence);
    if (submitted.needsAttention) {
      client.close();
      return {ok:true, needsAttention:true, message:submitted.message, baseline:submitted.before};
    }
    if(submitted.paidBlocked){client.close();return {ok:true,paidBlocked:true,message:submitted.message,baseline:submitted.before};}
    if(submitted.pendingReceipt)return {ok:true,pendingReceipt:true,message:submitted.message,pendingState:submitted.pendingState,baseline:submitted.before,client};
    fs.writeFileSync(path.join(folder, "豆包提交凭据.json"), JSON.stringify({
      jobId: job.id,
      profileId: job.profileId || "default",
      conversationUrl: submitted.accepted?.messageState?.url || "",
      userMessage: submitted.accepted?.submittedUserMessage || null,
      receipt: submitted.accepted?.receipt || null,
      baseline: submitted.before,
      acceptedAt: new Date().toISOString()
    }, null, 2), "utf8");
    return { ok: true, submitted: true, manifest, baseline: submitted.before, client };
  } catch (error) {
    if (!shouldStop() && error.code !== "DOUBAO_TASK_STOPPED") await captureStage(client, folder, "99-失败现场");
    client.close();
    throw error;
  }
}

async function submitJob({ exe, job, files, folder, progress, log, accountIdentity, shouldStop, onBeforeSubmit, onBeforePromptPaste, onSubmissionState }) {
  const connection = await ensureControlledNative({ exe, progress, log, allowWindowActivation: false });
  const snapshot = await pageSnapshot(connection.client);
  if (snapshot.loginRequired) { connection.client.close(); return { ok: false, needLogin: true }; }
  let selected;
  try { selected = await switchToAccount({ client: connection.client, target: accountIdentity || job.accountIdentity, progress, allowWindowActivation: false }); }
  catch (error) { connection.client.close(); throw error; }
  const result = await submitOnClient({ client: selected.client, job, files, folder, progress, log, shouldStop, onBeforeSubmit, onBeforePromptPaste, onSubmissionState });
  return { ...result, port: connection.port };
}

async function verifyTaskAccount(client, identity) {
  if (!identity?.name) throw controllerError("DOUBAO_ACCOUNT_UNBOUND", "任务缺少账号身份，已停止上传和提交");
  const current = await readCurrentAccountStable(client, 2);
  if (!accountIdentityMatches(current, identity)) throw controllerError("DOUBAO_ACCOUNT_VERIFY_FAILED", "豆包实际账号与本任务不一致，已停止上传和提交");
  return current;
}

async function openProfile({ exe, accountIdentity, progress, log }) {
  const connection = await ensureControlledNative({ exe, progress, log });
  let client = connection.client;
  let current = await readCurrentAccount(client);
  if (accountIdentity?.name) {
    const selected = await switchToAccount({ client, target: accountIdentity, progress });
    client = selected.client;
    current = selected.current;
  }
  const snapshot = await pageSnapshot(client);
  client.close();
  return { ok: true, port: connection.port, loginRequired: snapshot.loginRequired, videoMode: snapshot.videoMode, currentAccount: current };
}

async function inspectNativeAccounts({ exe, progress, log }) {
  const connection = await ensureControlledNative({ exe, progress, log });
  try {
    const currentAccount = await readCurrentAccountStable(connection.client, 5);
    if (!currentAccount) {
      const snapshot = await pageSnapshot(connection.client);
      if (snapshot.loginRequired) return { ok: false, needLogin: true, accounts: [] };
      throw new Error("无法读取豆包当前账号，请确认豆包左下角账号入口已经显示");
    }
    let accounts = [];
    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        accounts = await listAvailableAccounts(connection.client);
        break;
      } catch (error) {
        lastError = error;
        log(`第 ${attempt + 1} 次读取豆包账号切换列表失败：${error.message}`);
        if (attempt < 3) await delay(700 + attempt * 500);
      }
    }
    if (!accounts.length) {
      throw controllerError("DOUBAO_ACCOUNT_LIST_READ_FAILED", `未能完整读取豆包账号列表：${lastError?.message || "账号切换列表为空"}`);
    }
    if (!accounts.some(account => accountIdentityMatches(account, currentAccount))) {
      accounts.unshift({ ...currentAccount, rowKey: "current-account" });
    }
    return { ok: true, currentAccount, accounts, port: connection.port };
  } finally {
    connection.client.close();
  }
}

function compactForMatch(value) {
  return String(value || "").replace(/[\s，。,.!！?？:：；;（）()《》<>“”"'@\[\]【】]/g, "").toLowerCase();
}

function promptMatchChunks(prompt) {
  const compact = compactForMatch(prompt);
  if (!compact) return [];
  if (compact.length <= 24) return compact.length >= 4 ? [compact] : [];
  const length = Math.min(22, Math.max(12, Math.floor(compact.length / 8)));
  const last = Math.max(0, compact.length - length);
  const count = Math.min(16, Math.max(6, Math.ceil(compact.length / 40)));
  const offsets = Array.from({ length: count }, (_value, index) => Math.floor(last * index / Math.max(1, count - 1)));
  return [...new Set(offsets.map(offset => compact.slice(offset, offset + length)))].filter(chunk => chunk.length >= 8);
}

function contextMatchScore(item, expectedPrompt) {
  const chunks = promptMatchChunks(expectedPrompt);
  if (!chunks.length) return 0;
  const compactPrompt = compactForMatch(expectedPrompt);
  return Math.max(0, ...(item.contexts || []).map(context => {
    const compactContext = compactForMatch(context);
    if (compactPrompt.length >= 8 && compactContext.includes(compactPrompt)) {
      return 10000 + Math.max(0, 1000 - compactContext.length);
    }
    const hits = chunks.filter(chunk => compactContext.includes(chunk)).length;
    const specificity = hits ? Math.max(0, 4 - Math.floor(compactContext.length / 500)) : 0;
    return hits * 10 + specificity;
  }));
}

function selectMatchingContextItem(items = [], baselineSignatures = [], expectedPrompt = "", concurrent = false) {
  const known = baselineSignatures instanceof Set ? baselineSignatures : new Set(baselineSignatures || []);
  const candidates = items.filter(item => item?.signature && !known.has(item.signature));
  const scored = candidates.map(item => ({ item, score: contextMatchScore(item, expectedPrompt) })).sort((a, b) => b.score - a.score || Number(a.item.index || 0) - Number(b.item.index || 0));
  const minimum = promptMatchChunks(expectedPrompt).length > 1 ? 20 : 10;
  const unique = !concurrent || !scored[1] || scored[0].score > scored[1].score;
  return unique && scored[0]?.score >= minimum ? scored[0].item : null;
}

function selectMatchingVideo(videoItems = [], baselineSignatures = [], expectedPrompt = "", _expectedJobId = "", concurrent = false) {
  return selectMatchingContextItem(videoItems, baselineSignatures, expectedPrompt, concurrent);
}

function failureMatchesExpectedPrompt(item, expectedPrompt) {
  const expected = compactForMatch(expectedPrompt);
  const previous = compactForMatch(item?.previousUserText || "");
  if (expected.length >= 4 && previous && (previous.includes(expected) || expected.includes(previous))) return true;
  return !previous && contextMatchScore(item || {}, expectedPrompt) >= 20;
}

const resultJobOrder = [];
const videoAssignments = new Map();
const cardAssignments = new Map();
const failureAssignments = new Map();
const quotaAssignments = new Map();
const imageAssignments = new Map();
const imageFailureAssignments = new Map();
const imageQuotaAssignments = new Map();
let completedCardInteractionTail = Promise.resolve();
let completedCardInteractionPending = 0;
function completedCardInteractionBusy() { return completedCardInteractionPending > 0; }

function serializeCompletedCardInteraction(action) {
  completedCardInteractionPending += 1;
  const scheduled = completedCardInteractionTail.catch(() => {}).then(async () => {
    try { return await action(); }
    finally { completedCardInteractionPending = Math.max(0, completedCardInteractionPending - 1); }
  });
  completedCardInteractionTail = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}

function registerResultJob(jobId) {
  if (jobId && !resultJobOrder.includes(jobId)) resultJobOrder.push(jobId);
}

function unregisterResultJob(jobId) {
  const index = resultJobOrder.indexOf(jobId);
  if (index >= 0) resultJobOrder.splice(index, 1);
  for (const assignments of [videoAssignments, cardAssignments, failureAssignments, quotaAssignments, imageAssignments, imageFailureAssignments, imageQuotaAssignments]) {
    while (assignments.size > 300) assignments.delete(assignments.keys().next().value);
  }
}

function claimMatchingImageSet(items, baselineSignatures, expectedPrompt, jobId) {
  const existing = [...imageAssignments.entries()].find(([_signature, owner]) => owner === jobId)?.[0];
  if (existing) return (items || []).find(item => item.signature === existing) || null;
  const known = baselineSignatures instanceof Set ? baselineSignatures : new Set(baselineSignatures || []);
  const candidates = (items || []).filter(item => item?.complete && item.signature && !known.has(item.signature) && !imageAssignments.has(item.signature));
  const matched = selectMatchingImageSet(candidates, [], expectedPrompt);
  if (!matched) return null;
  imageAssignments.set(matched.signature, jobId);
  return matched;
}

function selectMatchingImageSet(items = [], baselineSignatures = [], expectedPrompt = "") {
  const known = baselineSignatures instanceof Set ? baselineSignatures : new Set(baselineSignatures || []);
  const candidates = items.filter(item => item?.complete && item.signature && !known.has(item.signature));
  return selectMatchingContextItem(candidates, [], expectedPrompt, true);
}

function claimContextItem(assignments, items, baselineSignatures, expectedPrompt, jobId, concurrent, orderFallback = false, ownershipVerified = false) {
  const known = baselineSignatures instanceof Set ? baselineSignatures : new Set(baselineSignatures || []);
  const existing = [...assignments.entries()].find(([_signature, owner]) => owner === jobId)?.[0];
  if (existing) {
    const current=items.find(item => item.signature === existing);
    if(current||!ownershipVerified)return current||null;
  }
  const candidates = items.filter(item => item?.signature && !known.has(item.signature) && !assignments.has(item.signature));
  if (!candidates.length) return null;
  const matched = ownershipVerified
    ? [...candidates].sort((a,b)=>(b.messageIndex??-1)-(a.messageIndex??-1))[0]
    : selectMatchingContextItem(candidates, [], expectedPrompt, concurrent);
  if (matched) {
    assignments.set(matched.signature, jobId);
    return matched;
  }
  if(!orderFallback)return null; // Never assign a different task merely because it finished first.
  const assignedOwners = new Set(assignments.values());
  const pendingOrder = resultJobOrder.filter(id => !assignedOwners.has(id));
  const canUseOrder = pendingOrder[0] === jobId && (orderFallback || !concurrent || candidates.length >= pendingOrder.length);
  if (!canUseOrder) return null;
  const first = [...candidates].sort((a, b) => Number(a.index || 0) - Number(b.index || 0))[0];
  assignments.set(first.signature, jobId);
  return first;
}

function reserveExpandedVideos(videoItems, expectedPrompt, expectedJobId, assignments = videoAssignments) {
  const available = (videoItems || []).filter(video => video?.signature);
  for (const video of available) assignments.set(video.signature, expectedJobId);
  return selectMatchingContextItem(available, [], expectedPrompt, false) || available[0] || null;
}

async function expandCompletedVideoCard(client, item, expectedPrompt, expectedJobId, shouldStop = () => false, expectedAccountIdentity = null) {
  if (!item?.signature || !item?.coverSource) return null;
  return serializeCompletedCardInteraction(async () => {
    if (shouldStop()) return null;
    const before = await downloadState(client);
    const currentCard = (before.completedCardItems || []).find(card => card.signature === item.signature);
    if (!currentCard || shouldStop()) return null;
    if (expectedAccountIdentity?.name) await verifyTaskAccount(client, expectedAccountIdentity);
    const video = await client.evaluate(readCompletedVideoSourceScript(currentCard, before.url));
    if ((!video?.source&&!video?.captureRecipe) || shouldStop()) return null;
    if (expectedAccountIdentity?.name) await verifyTaskAccount(client, expectedAccountIdentity);
    if (await client.evaluate('location.href') !== before.url || shouldStop()) return null;
    const identity = `completed-video:${video.messageId}|${video.videoId}`;
    for (const key of [identity, video.source].filter(Boolean)) {
      const owner = videoAssignments.get(key);
      if (owner && owner !== expectedJobId) return null;
    }
    videoAssignments.set(identity, expectedJobId);
    if(video.source)videoAssignments.set(video.source, expectedJobId);
    return {...video, signature:video.source||identity, contexts:currentCard.contexts || [], readWithoutPlayback:true};
  });
}

async function monitorImageResult({ client, baseline, folder, job, progress, onResult, onQuotaExhausted = () => {}, onFailure = () => {}, timeout = 30 * 60 * 1000, shouldStop = () => false }) {
  const deadline = Date.now() + timeout;
  registerResultJob(job.id);
  const closeMonitor = () => {
    unregisterResultJob(job.id);
    try { client.close(); } catch {}
  };
  const baselineImageSignatures = new Set(baseline?.imageSetSignatures || baseline?.imageSets?.map(item => item.signature) || []);
  const baselineFailureSignatures = new Set(baseline?.failureSignatures || []);
  const baselineQuotaSignatures = new Set(baseline?.quotaSignatures || baseline?.quotaItems?.map(item => item.signature) || []);
  const expectedConversation = String(baseline?.conversationKey || "");
  let lastProgress = 0;
  let ambiguityReported = false;
  while (Date.now() < deadline) {
    if (shouldStop()) { closeMonitor(); return null; }
    await delay(3500);
    if (shouldStop()) { closeMonitor(); return null; }
    let state;
    try { state = await imageResultState(client); } catch { if (shouldStop()) { closeMonitor(); return null; } break; }
    if (expectedConversation && state.conversationKey !== expectedConversation) {
      const message = "豆包对话页面已发生切换；为防止拿到其他对话的图片，画布已暂停本任务回填";
      progress(message); onFailure(message); await captureStage(client, folder, "08-图片对话身份变化"); closeMonitor(); return null;
    }
    let quotaItems = [];
    try { quotaItems = await quotaFeedbackState(client); } catch {}
    const quota = claimContextItem(imageQuotaAssignments, quotaItems, baselineQuotaSignatures, job.prompt, job.id, true, false);
    if (quota) {
      const message = quota.text || "豆包提示当前账号图片额度已用完";
      progress(message); onQuotaExhausted(message, true); await captureStage(client, folder, "08-图片额度已用完"); closeMonitor(); return null;
    }
    let failureState = null;
    try { failureState = await downloadState(client); } catch {}
    const failure = claimContextItem(imageFailureAssignments, failureState?.failureItems || [], baselineFailureSignatures, job.prompt, job.id, true, false);
    if (failure) {
      const message = `豆包已停止本次图片任务：${failure.text}`;
      progress(message); onFailure(message); await captureStage(client, folder, "08-豆包图片生成失败"); closeMonitor(); return null;
    }
    const freshComplete = state.imageSets.filter(item => item.complete && !baselineImageSignatures.has(item.signature));
    const imageSet = claimMatchingImageSet(freshComplete, [], job.prompt, job.id);
    if (imageSet) {
      if (job.accountIdentity?.name) {
        let current;
        try { current = await readCurrentAccount(client); } catch {}
        if (!current || !accountIdentityMatches(current, job.accountIdentity)) {
          const message = "豆包当前账号与提交账号不一致；为防止跨账号错图，画布已暂停回填";
          progress(message); onFailure(message); await captureStage(client, folder, "08-图片账号身份变化"); closeMonitor(); return null;
        }
      }
      progress(`已经锁定本任务对应的 ${imageSet.sources.length} 张图片，正在校验并保存……`);
      await captureStage(client, folder, "06-已锁定图片结果");
      try {
        imageSet.conversationKey = state.conversationKey;
        const saved = await saveImageSet(client, imageSet, folder, job);
        onResult({ files: saved.files, claimSignature: imageSet.signature, messageId: imageSet.messageId || "", manifest: saved.manifest });
        await captureStage(client, folder, "07-图片已同步回画布");
        closeMonitor();
        return saved.files;
      } catch (error) {
        progress(`已锁定正确图片，但保存暂时失败，正在继续重试：${error.message}`);
      }
    } else if (freshComplete.length && !ambiguityReported) {
      ambiguityReported = true;
      progress("发现新的豆包图片，但提示词归属证据不足；画布不会猜测回填对象，正在继续等待可核对结果");
    } else if (state.pending && Date.now() - lastProgress > 45000) {
      lastProgress = Date.now();
      progress("豆包仍在生成图片，完成后只会回填到发起任务的图片节点……");
    }
  }
  if (shouldStop()) { closeMonitor(); return null; }
  progress("图片结果监听已超时；未确认归属的图片不会回填，任务诊断资料仍保留在任务文件夹");
  closeMonitor();
  return null;
}

async function monitorPendingReceipt({client,baseline,folder,job,progress,onStateChange,shouldStop,canInteract=()=>true,onInteractionComplete=()=>{}}) {
  const startedAt=Date.now(),deadline=Math.min(baseline.receiptDeadline||Infinity,startedAt+2*60*1000);
  const initialClient=client;let handedOff=false;
  const manualMode=Boolean(baseline.manualSubmissionRequested);
  let lastState='',lastHeartbeat=0,lastReason='尚未看到本任务的正式受理回执',savedRoot='';
  const report=(state,message)=>{const key=state+'|'+message;if(key===lastState)return;lastState=key;onStateChange({state,message});progress(message);};
  try{
  while(Date.now()<Math.min(deadline,baseline.receiptDeadline||Infinity)){
    if(shouldStop())return {stopped:true};
    if(baseline.recheckRequested){baseline.recheckRequested=false;lastState='';report('awaiting_receipt','正在重新核对原消息及正式回执；本轮截止时间不延长');}
    if(client.closed){
      try{
        let recovered=null;
        if(manualMode&&!hasStableIdentity((baseline.confirmationContext||baseline.submissionContext)?.root)&&baseline.manualTargetId){
          const direct=await connectPageById(NATIVE_DOUBAO_PORT,baseline.manualTargetId,2500);
          if(direct?.client){
            try{await verifyTaskAccount(direct.client,job.accountIdentity);recovered=direct.client;}
            catch(error){direct.client.close();throw error;}
          }
        }
        client=recovered||await connectRecoveryPage(baseline,job.accountIdentity);
      }
      catch(error){assertRunning();report('monitor_paused','原页面连接中断，正在等待原账号对话恢复；不会重新生成');await delay(2500);continue;}
    }
    let outcome;
    try{outcome=await waitForSubmissionAccepted(client,job.submittedPrompt||job.prompt,baseline,1500,shouldStop);}
    catch(error){assertRunning();if(shouldStop())return {stopped:true};report('monitor_paused',`豆包页面暂时读取不到，原任务仍在核验：${error.message}`);await delay(1500);continue;}
    if(shouldStop()||outcome?.stopped)return {stopped:true};
    const contextNow=baseline.confirmationContext||baseline.submissionContext;
    const root=JSON.stringify([contextNow?.url,contextNow?.root?.messageId,contextNow?.root?.localMessageId]);
    if(root&&root!==savedRoot){
      savePendingSubmission(folder,baseline,job,manualMode?"已绑定人工提交的任务消息，继续等待正式回执":"已绑定原任务消息，继续等待回执");
      savedRoot=root;
      if(manualMode&&hasStableIdentity(contextNow?.root))report('awaiting_receipt','已经识别并绑定本次人工提交，正在等待豆包正式回执；收到回执后后续节点会自动继续');
      if(!manualMode)onInteractionComplete();
    }
    if(outcome?.accepted){
      baseline.awaitingSubmissionReceipt=false;
      fs.writeFileSync(path.join(folder,'豆包提交凭据.json'),JSON.stringify({jobId:job.id,profileId:job.profileId,conversationUrl:outcome.messageState?.url,userMessage:outcome.submittedUserMessage,receipt:outcome.receipt,baseline,acceptedAt:new Date().toISOString()},null,2),'utf8');
      savePendingSubmission(folder,baseline,job,"原任务已受理，继续监听视频结果");
      report('generating','已读到原任务的正式受理凭据，正在生成并等待回填');
      onInteractionComplete();
      handedOff=true;
      return {...outcome,client};
    }
    if(outcome?.generationFailure||outcome?.quotaExhausted)return outcome;
    if(!manualMode&&outcome?.actionRequired&&outcome.actionType!=='paid_quota'&&canInteract()&&!completedCardInteractionBusy()){
      try{
        await serializeCompletedCardInteraction(async()=>{
          assertRunning();if(shouldStop()||!canInteract())return;
          const context=baseline.confirmationContext||baseline.submissionContext;
          const state=await conversationMessageState(client),chain=context&&confirmationChain(context,state);
          // Reading late receipts is allowed during concurrency; clicking requires an
          // unambiguous current task and a free composer, never another task's dialog.
          if(!chain?.valid||chain.interrupted)return;
          const question=chain.assistant.find(m=>m.signature===outcome.actionSignature);
          if(!question)return;
          const verifyAccount=()=>verifyTaskAccount(client,job.accountIdentity);
          if(outcome.actionType==='generation_parameters'){
            if(context.autoAttempted||!parameterConfirmation(question.text,job).safe)return;
            context.autoAttempted=true;context.questionSignature=question.signature;
            baseline.confirmationContext=context;
            savePendingSubmission(folder,baseline,job,'迟到的参数确认已登记一次尝试');
            await sendGenerationConfirmation(client,context,verifyAccount,shouldStop);
          }else if(!baseline.complianceAttempted){
            baseline.complianceAttempted=true;
            savePendingSubmission(folder,baseline,job,'迟到的素材确认已登记一次尝试');
            await autoConfirmCompliance(client,{scope:{messageId:question.messageId,messageIndex:question.index,text:question.text},verifyAccount,shouldStop});
          }
        });
      }catch(error){assertRunning();if(shouldStop())return {stopped:true};report('monitor_paused','确认操作未完成，继续核验原任务；不会再次提交');}
      finally{onInteractionComplete();}
    }
    if(outcome?.actionType==='paid_quota'){
      lastReason='豆包仍显示付费确认，等待人工处理或原任务正式回执';
      report('waiting_paid_confirmation',lastReason+'；画布不会代替你确认付费，超时后可同步已有结果');
    }
    else if(outcome?.needsAttention){lastReason=outcome.message;report('monitor_paused',outcome.message);}
    else if(outcome?.actionRequired&&!baseline.complianceAttempted)report('waiting_confirmation','豆包仍显示确认要求，正在核验是否已处理；需要操作时请在原对话确认，不要重新提交');
    else {
      lastReason=outcome?.temporarilyUnavailable?'豆包反馈暂时繁忙，尚未发现本任务受理回执':baseline.complianceAttempted?'已尝试素材确认，尚未发现本任务受理回执':manualMode&&!contextNow?'正在等待你在当前豆包页面手动点击生成':'尚未发现本任务的正式受理回执';
      report(manualMode&&!contextNow?'waiting_manual_submission':'awaiting_receipt',lastReason+'；正在限时核验，不会重复上传或点击生成');
    }
    if(Date.now()-lastHeartbeat>=15000){lastHeartbeat=Date.now();progress(`${lastReason}；本轮剩余约 ${Math.max(0,Math.ceil((Math.min(deadline,baseline.receiptDeadline||Infinity)-Date.now())/1000))} 秒`);}
    await delay(1500);
  }
  return {receiptUnconfirmed:true,message:`本轮核验已结束：${lastReason}。未确认豆包是否受理，原记录已保留；可查看原对话后同步结果，不会自动重新生成`};
  }finally{if(client!==initialClient&&!handedOff)try{client.close();}catch{}}
}

async function monitorResult({ client, baseline, folder, progress, onResult, onBoundVideo = async () => null, onFailure = () => {}, onStateChange = () => {}, onInteractionComplete = () => {}, acquireResultView = () => () => {}, timeout, forceLatest = false, expectedPrompt = "", expectedJobId = "", expectedAccountIdentity = null, shouldStop = () => false, hasConcurrent = () => false, canInteract = () => true, job = null }) {
  const seconds = Number.parseInt(String(job?.duration || ""), 10);
  if (!Number.isFinite(Number(timeout))) timeout = seconds >= 25 ? 75 * 60 * 1000 : seconds >= 14 ? 50 * 60 * 1000 : 35 * 60 * 1000;
  let deadline = Date.now() + timeout;
  registerResultJob(expectedJobId);
  const closeMonitor = () => {
    unregisterResultJob(expectedJobId);
    try { client.close(); } catch {}
  };
  try {
  if(baseline?.awaitingSubmissionReceipt){
    const outcome=await monitorPendingReceipt({client,baseline,folder,job:job||{id:expectedJobId,prompt:expectedPrompt,accountIdentity:expectedAccountIdentity},progress,onStateChange,shouldStop,canInteract,onInteractionComplete});
    client=outcome.client||client;
    if(shouldStop()||outcome.stopped)return null;
    if(outcome.paidBlocked)return null;
    if(outcome.receiptUnconfirmed){onStateChange({state:'monitor_timeout',message:outcome.message});return null;}
    if(outcome.needsAttention){onStateChange({state:'needs_attention',message:outcome.message});return null;}
    if(outcome.generationFailure||outcome.quotaExhausted){onFailure(outcome.failureMessage||outcome.quotaMessage,{quotaExhausted:Boolean(outcome.quotaExhausted),retryable:true,quotaNotDeducted:Boolean(outcome.quotaNotDeducted)});return null;}
    deadline=Date.now()+timeout;
  }
  const baselineVideoSignatures = new Set(baseline?.videoSignatures || baseline?.videoItems?.map(item => item.signature) || []);
  const baselineCardSignatures = new Set(baseline?.completedCardSignatures || baseline?.completedCardItems?.map(item => item.signature) || []);
  const baselineFailureSignatures = new Set(baseline?.failureSignatures || baseline?.failureItems?.map(item => item.signature) || []);
  let lastProgress = 0;
  let accountPaused = false;
  let lastAccountPauseProgress = 0;
  let needsReconnect=false;
  while (Date.now() < deadline) {
    if (shouldStop()) { closeMonitor(); return null; }
    await delay(4500);
    if (shouldStop()) { closeMonitor(); return null; }
    const releaseView=acquireResultView();
    if(!releaseView)continue;
    try{
    let state;
    if(client.closed||needsReconnect){
      try{const recovered=await connectRecoveryPage(baseline,expectedAccountIdentity);client.close();client=recovered;needsReconnect=false;}
      catch(error){assertRunning();if(Date.now()-lastProgress>15000){lastProgress=Date.now();onStateChange({state:'monitor_paused',message:error.code==='DOUBAO_RECOVERY_NOT_FOUND'?'正在重新匹配本任务的原账号和对话；并非视频生成失败，不会重新提交':'豆包连接暂不可用，正在重连原任务；不会重新生成'});}continue;}
    }
    try { state = await downloadState(client, baseline?.confirmationContext||baseline?.submissionContext); }
    catch(error) {
      if (shouldStop()) { closeMonitor(); return null; }
      needsReconnect=true;
      try { client.close(); } catch {}
      if(Date.now()-lastProgress>15000){lastProgress=Date.now();onStateChange({state:'monitor_paused',message:'豆包页面暂时读取中断，正在重新连接本任务所属账号和原对话；不会判定生成失败'});}
      continue;
    }
    if (state.confirmationValid === false) {
      needsReconnect=true;
      if(Date.now()-lastProgress>15000){lastProgress=Date.now();onStateChange({state:"monitor_paused",message:"原任务对话暂不可见，已暂停读取其他对话的视频；返回原对话后自动继续监听"});}
      continue;
    }
    if (expectedAccountIdentity?.name) {
      let currentAccount = null;
      try { currentAccount = await readCurrentAccount(client); } catch {}
      if (!currentAccount || !accountIdentityMatches(currentAccount, expectedAccountIdentity)) {
        needsReconnect=true;
        if (!accountPaused) {
          accountPaused = true;
          onStateChange({ state: "monitor_paused", message: "豆包当前账号与本任务不一致，监听已暂停；切回原账号后会自动恢复，任务不会被判失败" });
        }
        if (Date.now() - lastAccountPauseProgress > 45000) {
          lastAccountPauseProgress = Date.now();
          progress("豆包账号已变化，本任务保持生成状态但暂停读取结果；切回原账号即可自动恢复……");
        }
        continue;
      }
      if (accountPaused) {
        accountPaused = false;
        onStateChange({ state: "generating", message: "已切回任务所属豆包账号，结果监听已恢复" });
        progress("已切回任务所属豆包账号，正在恢复结果监听……");
      }
    }
    const acceptedIndex=(state.ownedMessages||[]).find(m=>m.messageId&&m.messageId===baseline?.acceptedMessageId)?.index;
    const successIndex=Math.max(-1,...[...(state.videoItems||[]),...(state.completedCardItems||[])].map(item=>item.messageIndex??-1));
    const failureItems = (state.failureItems || []).filter(item => !transientVideoFeedback(item.text)
      && !(Number.isInteger(acceptedIndex)&&item.messageIndex>=0&&item.messageIndex<acceptedIndex)
      && !(successIndex>=0&&item.messageIndex>=0&&item.messageIndex<successIndex)
      && !isSuppressedFeedback(item) && (state.confirmationValid===true||failureMatchesExpectedPrompt(item, expectedPrompt)));
    const failure = claimContextItem(failureAssignments, failureItems, baselineFailureSignatures, expectedPrompt, expectedJobId, hasConcurrent(), false,state.confirmationValid===true);
    if (failure) {
      const failureMessage = `豆包已停止本次任务：${failure.text}`;
      progress(failureMessage);
      onFailure(failureMessage, { retryable: true, quotaNotDeducted: isQuotaNotDeductedFailureText(failure.text) });
      await captureStage(client, folder, "08-豆包生成失败");
      closeMonitor();
      return null;
    }
    const hasOwnedCard=(state.completedCardItems||[]).length>0;
    let newVideo = completedCardInteractionPending > 0 || hasOwnedCard ? null : claimContextItem(videoAssignments, state.videoItems || [], forceLatest ? [] : baselineVideoSignatures, expectedPrompt, expectedJobId, hasConcurrent(), false,state.confirmationValid===true);
    if (!newVideo) {
      const completedCard = claimContextItem(cardAssignments, state.completedCardItems || [], forceLatest ? [] : baselineCardSignatures, expectedPrompt, expectedJobId, hasConcurrent(), false,state.confirmationValid===true);
      if (completedCard && canInteract()) {
        progress("已找到对应的完成视频卡，正在后台读取本任务视频地址，不打开播放器……");
        try {
          newVideo = await expandCompletedVideoCard(client, completedCard, expectedPrompt, expectedJobId, shouldStop, expectedAccountIdentity);
          if (newVideo) progress("已锁定该任务对应的视频，正在下载回画布……");
        } catch (error) {
          progress(`本任务视频地址暂时无法核验，保留任务继续读取，不打开豆包播放器：${error.message}`);
        } finally { onInteractionComplete(); }
        if(!newVideo)newVideo=claimContextItem(videoAssignments,state.videoItems||[],forceLatest?[]:baselineVideoSignatures,expectedPrompt,expectedJobId,hasConcurrent(),false,state.confirmationValid===true);
      }
    }
    if (newVideo) {
      progress("豆包视频已生成，正在下载回画布……");
      await captureStage(client, folder, "07-发现豆包生成结果");
      let file = null;
      const source = newVideo.source || "";
      if(newVideo.messageId&&newVideo.videoId){
        fs.writeFileSync(path.join(folder,'视频结果凭据.json'),JSON.stringify({jobId:expectedJobId,video:newVideo},null,2),'utf8');
        if(expectedAccountIdentity?.name)await verifyTaskAccount(client,expectedAccountIdentity);
        const captured=await onBoundVideo({...newVideo,client});
        assertRunning();if(shouldStop())return null;
        if(captured&&fs.existsSync(captured)){
          file=path.join(folder,'豆包生成视频.mp4');fs.copyFileSync(captured,file);
        }
      }else{
        // Report a missing verified download recipe without blocking ordinary backfill.
        await onBoundVideo({...newVideo,client});
      }
      if (source&&!file) {
        try { file = await downloadHttpMedia(client, source, folder); } catch (error) {
          if (/^VIDEO_(?:H264|FFMPEG)/.test(String(error.code || ""))) {
            let pendingFile = "";
            if (error.downloadedFile && fs.existsSync(error.downloadedFile)) {
              pendingFile = error.downloadedFile.replace(/\.[^.]+$/i, ".h264-pending.mp4");
              try { fs.renameSync(error.downloadedFile, pendingFile); } catch { pendingFile = error.downloadedFile; }
            }
            const message = `视频已经找到并保留，但 H.264 转换器暂时不可用：${error.message}。修复运行组件后点击“同步结果”即可继续转换，不需要重新生成`;
            progress(message);
            onStateChange({ state: "conversion_pending", message, file: pendingFile });
            await captureStage(client, folder, "09-H264转换失败");
            closeMonitor();
            return null;
          }
          progress(`已经找到对应视频，但直接下载失败，正在继续重试：${error.message}`);
        }
      }
      if (file) {
        await captureStage(client, folder, "09-视频已同步回画布");
        onResult(file);
        closeMonitor();
        return file;
      }
      progress("已发现对应视频但暂时无法读取真实地址；画布不会点击豆包图片，将继续自动重试");
    } else {
      if (Date.now() - lastProgress > 45000) {
        lastProgress = Date.now();
        const seconds = Number.parseInt(String(job?.duration || ""), 10);
        progress(seconds >= 20
          ? "30秒视频仍在等待成品（通常约15分钟），画布会持续监听并自动回填，请不要重复点击生成……"
          : "豆包仍在生成视频，完成后会自动回填原视频节点……");
      }
    }
    }finally{releaseView();}
  }
  if (shouldStop()) { closeMonitor(); return null; }
  progress("结果监听已超时；任务仍保留在历史记录，可稍后点“同步结果”");
  onStateChange({ state: "monitor_timeout", message: "自动监听已超时；任务不会标记失败，可在历史记录中点击“同步结果”" });
  closeMonitor();
  return null;
  } finally { closeMonitor(); }
}

module.exports = {
  restoreBoundResultView,
  connectRecoveryPage,
  resumePendingSubmission,
  CdpClient,
  NATIVE_DOUBAO_PORT,
  accountIdentityMatches,
  accountSwitcherRows,
  attachmentState,
  browserCommandLine,
  captureStage,
  clearSubmissionFeedbackSuppressions,
  chooseImageModel,
  chooseImageRatio,
  clearComposerAttachments,
  closeAccountMenus,
  connectBestPage,
  connectPageById,
  chooseRatioAndDuration,
  claimContextItem,
  downloadState,
  downloadHttpMedia,
  imageResultState,
  ensureImageComposer,
  ensureVideoComposer,
  fillPrompt,
  pastePromptWithEvidence,
  qualifiedPromptPasteEvidence,
  resetPromptDraftForPaste,
  ensureControlledNative,
  ensureControlledProfile,
  expandCompletedVideoCard,
  findSubmitButton,
  findImageSubmitButton,
  findCreationParamsTrigger,
  inspectNativeAccounts,
  isComplianceConfirmationText,
  isPaidQuotaConfirmationText,
  isGenerationFailureText,
  isQuotaNotDeductedFailureText,
  isQuotaExhaustedText,
  isPortReady,
  listAvailableAccounts,
  mergeAccountIdentities,
  listVideoFiles,
  monitorResult,
  waitFor,
  verifyTaskAccount,
  monitorImageResult,
  nativeControlState,
  normalizeAccountIdentity,
  openAccountSwitcher,
  openCompletedVideoCard,
  ensureMainChatPage,
  openProfile,
  pageSnapshot,
  complianceConfirmationState,
  autoConfirmCompliance,
  quotaFeedbackState,
  selectMatchingVideo,
  profilePort,
  quotaFeedbackState,
  readCurrentAccount,
  readCurrentAccountStable,
  readPrompt,
  readPromptEvidence,
  waitForPromptRecognition,
  conversationMessageState,
  relatedSubmissionMessages,
  failureMatchesExpectedPrompt,
  reserveExpandedVideos,
  completedCardInteractionBusy,
  selectMatchingImageSet,
  serializeCompletedCardInteraction,
  switchToAccount,
  submitOnClient,
  submitJob,
  submitImageOnClient,
  submitImageJob,
  uploadReferences,
  writeManifest
};
