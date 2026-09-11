(() => {
  const $ = selector => document.querySelector(selector);
  let accounts = [];
  let activeId = '';
  let activeWebview = null;
  let monitorTimer = 0;
  let loadQuotaTimer = 0;
  let pendingCanvasTask = null;
  let readyBackfill = null;
  let lastCanvasTask = null;
  let composerBusy = false;
  let runningCanvasTaskId = '';
  const launchParams = new URLSearchParams(location.search);
  let lockedAccountId = String(launchParams.get('accountId') || '');
  const incomingCanvasTasks = [];
function fillBlocked() {
    return Boolean(composerBusy);
  }
  function enqueueCanvasTask(task) {
    if (!task?.id) return { ok: false };
    const same = task.id === runningCanvasTaskId || incomingCanvasTasks.some(item => item.id === task.id) || pendingCanvasTask?.task?.id === task.id;
    if (same) return { ok: true, duplicate: true };
    incomingCanvasTasks.push(task);
    lastCanvasTask = task;
    showCanvasOrigin(task);
    window.desktop.reportBrowserTaskStatus({
      jobId: task.id, nodeId: task.nodeId, state: fillBlocked() ? 'submitting' : 'preparing',
      message: fillBlocked() ? '账号窗口正在发送上一条，本条会立刻接着填写，不会空等失败任务' : '账号窗口已收到任务，开始填写发送'
    });
    pumpIncomingCanvasTasks();
    return { ok: true };
  }
  function pumpIncomingCanvasTasks() {
    if (fillBlocked() || !incomingCanvasTasks.length) return;
    const next = incomingCanvasTasks.shift();
    prepareCanvasTask(next).catch(error => window.desktop.reportBrowserTaskStatus({ jobId: next.id, nodeId: next.nodeId, state: 'failed', message: `内置浏览器任务准备失败：${error.message}` }));
  }
  let resultMonitorTimer = 0;
  let lastComposerSettings = null;

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[character]);
  const activeAccount = () => accounts.find(account => account.id === activeId);
  const quotaLabel = account => account.quotaStatus === 'exhausted' ? '额度不足' : account.quotaStatus === 'available' ? `可用${account.quotaValue == null ? '' : ` · ${account.quotaValue}`}` : '额度未知';
  function canvasOriginLabel(task) {
    const title = String(task?.title || task?.nodeTitle || '视频生成').replace(/\s+/g, ' ').trim() || '视频生成';
    return `画布节点「${title}」`;
  }

  function showCanvasOrigin(task, mode = '') {
    const text = $('#browserCanvasOriginText');
    const button = $('#addToCanvasBtn');
    if (!text) return;
    const jobId = String(task?.id || task?.jobId || '');
    const origin = task ? canvasOriginLabel(task) : '';
    if (mode === 'page-ready') {
      text.textContent = task
        ? `页面已有成片。点「回填到画布」写入 ${origin}`
        : '页面已有成片。点「回填到画布」写入发出该任务的视频节点；同一节点的旧成片会被覆盖。';
      if (button) { button.hidden = false; button.disabled = false; button.textContent = task ? `回填到画布 · ${String(task.title || task.nodeTitle || '视频生成')}` : '回填到画布'; }
      return;
    }
    if (!task) {
      text.textContent = '将回填到发出任务的视频节点。同一节点若有旧成片，会被当前这条覆盖。';
      if (button) { button.hidden = false; button.disabled = false; button.textContent = '回填到画布'; }
      return;
    }
    const ready = mode === 'ready' || Boolean(readyBackfill);
    if (mode === 'done') text.textContent = `已回填到发出窗口：${origin} · 任务 ${jobId}`;
    else if (ready) text.textContent = `成片已保存。点「回填到画布」写入 ${origin}，覆盖该节点上的旧视频。`;
    else text.textContent = `当前任务来自 ${origin}。生成完成后点「回填到画布」即可。`;
    if (button) {
      button.hidden = false;
      button.disabled = mode === 'done';
      button.textContent = mode === 'done' ? `已回填 · ${String(task.title || task.nodeTitle || '视频生成')}` : `回填到画布 · ${String(task.title || task.nodeTitle || '视频生成')}`;
    }
  }

  async function pageHasCompletedVideo() {
    if (!activeWebview) return false;
    try {
      return await activeWebview.executeJavaScript(`(() => {
        const text = String(document.body && document.body.innerText || '');
        return /你的视频生成好了|视频(?:已经|已)?生成(?:完成|好了)|your video is ready/i.test(text) && document.querySelectorAll('video').length > 0;
      })()`);
    } catch { return false; }
  }

  async function refreshBackfillButton() {
    if (readyBackfill) return showCanvasOrigin(lastCanvasTask || readyBackfill, 'ready');
    const pageReady = await pageHasCompletedVideo();
    if (pageReady) return showCanvasOrigin(lastCanvasTask, 'page-ready');
    if (lastCanvasTask) return showCanvasOrigin(lastCanvasTask, 'assigned');
    showCanvasOrigin(null);
  }

  function overlayPick(title, bodyHtml, options) {
    return new Promise(resolve => {
      document.querySelector('.backfillVerify')?.remove();
      const overlay = document.createElement('div');
      overlay.className = 'backfillVerify';
      overlay.innerHTML = `<section class="backfillVerifyCard">
        <div class="backfillVerifyHead"><b>${escapeHtml(title)}</b><button type="button" data-cancel>×</button></div>
        <div class="backfillVerifyBody">${bodyHtml}</div>
      </section>`;
      document.body.append(overlay);
      const finish = value => { overlay.remove(); resolve(value); };
      overlay.querySelector('[data-cancel]').onclick = () => finish(null);
      overlay.addEventListener('click', event => { if (event.target === overlay) finish(null); });
      options.forEach(option => {
        overlay.querySelector(`[data-pick="${option.id}"]`)?.addEventListener('click', () => finish(option.value));
      });
    });
  }

  function latestPerNode(list) {
    const byNode = new Map();
    for (const item of list) {
      const key = String(item.nodeId || '');
      if (!key) continue;
      const prev = byNode.get(key);
      if (!prev) { byNode.set(key, item); continue; }
      const newer = String(item.jobId || '') > String(prev.jobId || '') || (item.ready && !prev.ready);
      if (newer) byNode.set(key, item);
    }
    return [...byNode.values()];
  }

  async function chooseBackfillCandidate() {
    const account = activeAccount();
    const bound = lastCanvasTask || readyBackfill;
    let candidates = [];
    if (typeof window.desktop.listBrowserBackfillCandidates === 'function') {
      candidates = await window.desktop.listBrowserBackfillCandidates(account?.id || '').catch(() => []);
    }
    if (!Array.isArray(candidates)) candidates = [];
    if (bound?.nodeId && (bound.id || bound.jobId)) {
      const jobId = String(bound.jobId || bound.id);
      const same = candidates.find(item => String(item.jobId) === jobId);
      if (same) {
        same.nodeId = bound.nodeId;
        same.ready = Boolean(same.ready || bound.url);
      } else {
        candidates.unshift({
          jobId, nodeId: bound.nodeId, nodeTitle: bound.title || bound.nodeTitle || '视频生成',
          accountId: bound.accountId || account?.id || '', ready: Boolean(bound.url)
        });
      }
    }
    candidates = latestPerNode(candidates);
    if (bound?.nodeId) {
      const current = candidates.find(item => String(item.nodeId) === String(bound.nodeId));
      if (current) {
        current.jobId = String(bound.jobId || bound.id || current.jobId);
        current.nodeTitle = bound.title || bound.nodeTitle || current.nodeTitle;
        return current;
      }
    }
    if (!candidates.length) {
      setStatus('找不到发出任务的视频节点。请先打开画布，确认该节点还在。');
      return null;
    }
    if (candidates.length === 1) return candidates[0];
    const body = `<p>这个窗口对应多个视频节点。请选择<strong>发出当前成片的那个节点</strong>；该节点上的旧视频会被覆盖。</p>
      <div class="backfillVerifyList">${candidates.map(item => `<button type="button" data-pick="${escapeHtml(item.nodeId)}"><b>${escapeHtml(item.nodeTitle || '视频生成')}</b><small>回填当前任务 ${escapeHtml(item.jobId)}</small></button>`).join('')}</div>`;
    return overlayPick('选择发出节点', body, candidates.map(item => ({ id: item.nodeId, value: item })));
  }

  function accountDisplayName(account) {
    const live = String(account?.pageUserName || '').replace(/\s+/g, ' ').trim();
    if (live && !/^(账号|Dola账号|豆包账号|Dola|豆包)$/i.test(live)) return live;
    return String(account?.name || '未命名账号').trim();
  }

  function renderAccounts() {
    const currentId = lockedAccountId || activeId;
    const locked = Boolean(lockedAccountId);
    $('#browserAccountList').innerHTML = accounts.length ? accounts.map(account => {
      const current = account.id === currentId;
      const bits = [
        account.provider === 'dola' ? 'Dola' : '豆包',
        `今日${Number(account.todayVideoCount || 0)}次`,
        quotaLabel(account),
        current ? '当前窗口' : ''
      ].filter(Boolean);
      return `<div class="browserAccountItem ${locked ? 'readonly' : ''} ${current ? 'active' : ''}" data-account-id="${escapeHtml(account.id)}"><span><b>${escapeHtml(accountDisplayName(account))}</b><small>${escapeHtml(bits.join(' · '))}</small></span><button type="button" data-delete-account="${escapeHtml(account.id)}" title="删除这个账号并关闭对应浏览器">${current ? '删除当前' : '删除'}</button></div>`;
    }).join('') : '<div class="browserNoAccounts">还没有内置浏览器账号</div>';
    $('#browserAccountList').querySelectorAll('[data-delete-account]').forEach(button => {
      button.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        removeAccount(button.getAttribute('data-delete-account')).catch(error => setStatus(`删除失败：${error.message}`));
      };
    });
    if (!locked) {
      $('#browserAccountList').querySelectorAll('.browserAccountItem[data-account-id]').forEach(item => {
        item.onclick = () => openAccount(item.getAttribute('data-account-id'));
      });
    }
  }

  async function refreshAccounts() { accounts = await window.desktop.listBrowserAccounts(); renderAccounts(); }

  function accountEditor() {
    return new Promise(resolve => {
      document.querySelector('.browserAccountEditor')?.remove();
      const overlay = document.createElement('div');
      overlay.className = 'browserAccountEditor';
      overlay.innerHTML = `<section class="browserAccountEditorCard">
        <div class="browserAccountEditorHead"><div><b>添加浏览器账号</b><small>第一步：选择账号平台</small></div><button type="button" data-account-cancel>×</button></div>
        <div class="browserProviderStep">
          <button type="button" data-provider="doubao"><i>豆</i><span><b>豆包</b><small>中国版 · doubao.com</small></span><em>选择</em></button>
          <button type="button" data-provider="dola"><i>Do</i><span><b>Dola</b><small>豆包国际版 · dola.com</small></span><em>选择</em></button>
        </div>
        <form class="browserAccountForm" hidden>
          <input type="hidden" name="provider">
          <label>账号名称<input name="name" maxlength="50" required></label>
          <label>邮箱、手机号或登录账号<input name="username" autocomplete="username" placeholder="可留空，稍后在网页中手动登录"></label>
          <label>密码<input name="password" type="password" autocomplete="current-password" placeholder="可留空；填写后使用 Windows 本机加密"></label>
          <p>首次登录仍可能需要验证码或 Google 验证。软件不会自动点击登录或绕过验证。</p>
          <div><button type="button" data-account-back>上一步</button><button type="submit">保存并打开</button></div>
        </form>
      </section>`;
      document.body.append(overlay);
      const finish = value => { overlay.remove(); resolve(value); };
      overlay.querySelector('[data-account-cancel]').onclick = () => finish(null);
      overlay.querySelectorAll('[data-provider]').forEach(button => button.onclick = () => {
        const provider = button.dataset.provider;
        overlay.querySelector('.browserProviderStep').hidden = true;
        const form = overlay.querySelector('.browserAccountForm');
        form.hidden = false;
        form.provider.value = provider;
        form.name.value = provider === 'dola' ? 'Dola账号' : '豆包账号';
        overlay.querySelector('.browserAccountEditorHead small').textContent = `第二步：填写${provider === 'dola' ? ' Dola' : '豆包'}账号信息`;
        form.name.focus(); form.name.select();
      });
      overlay.querySelector('[data-account-back]').onclick = () => {
        overlay.querySelector('.browserAccountForm').hidden = true;
        overlay.querySelector('.browserProviderStep').hidden = false;
        overlay.querySelector('.browserAccountEditorHead small').textContent = '第一步：选择账号平台';
      };
      overlay.querySelector('form').onsubmit = event => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(event.currentTarget));
        if (!values.name.trim()) return;
        finish({ provider: values.provider, name: values.name.trim(), username: values.username.trim(), password: values.password });
      };
    });
  }

  async function addAccount() {
    const host = $('#browserWebviewHost');
    const previous = host ? host.style.visibility : '';
    if (host) host.style.visibility = 'hidden';
    try {
      const input = await accountEditor();
      if (!input) return;
      const account = await window.desktop.saveBrowserAccount(input);
      await refreshAccounts();
      openAccount(account.id);
    } finally {
      if (host) host.style.visibility = previous || '';
    }
  }

  async function removeAccount(id) {
    const targetId = String(id || lockedAccountId || activeId || '');
    const account = accounts.find(item => item.id === targetId);
    if (!account) return setStatus('当前窗口没有可删除的账号');
    const name = accountDisplayName(account);
    if (!confirm(`删除账号「${name}」并关闭对应浏览器窗口？\n登录 Cookie 和缓存也会一起清除，无法恢复。`)) return;
    const deletingHere = (lockedAccountId || activeId) === account.id;
    await window.desktop.removeBrowserAccount(account.id);
    if (deletingHere && document.body.classList.contains('browserStandalone')) return;
    if (activeId === account.id) {
      activeId = '';
      lockedAccountId = '';
      activeWebview?.remove();
      activeWebview = null;
      $('#browserWebviewHost').innerHTML = '<div class="browserEmpty"><b>账号已删除</b><span>可在左侧添加新账号，或关闭本窗口。</span></div>';
    }
    await refreshAccounts();
    setStatus(`已删除账号「${name}」并关闭对应浏览器`);
  }

  function allowedUrl(account) { return account.provider === 'dola' ? 'https://www.dola.com/' : 'https://www.doubao.com/'; }

  function webviewIsLive(view) {
    return Boolean(view && view.isConnected !== false && document.contains(view));
  }

  function openAccount(id, options = {}) {
    const account = accounts.find(item => item.id === id);
    if (!account) return;
    if (lockedAccountId && id !== lockedAccountId) {
      setStatus(`本窗口固定为当前账号，不会自动打开 ${account.name} 的新浏览器`);
      return;
    }
    const storedTitle = String(account.pageUserName || '').trim();
    if (window.desktop.setBrowserWindowTitle) {
      document.title = storedTitle || account.name || '';
      window.desktop.setBrowserWindowTitle(storedTitle).catch(() => {});
    }
    if (!options.forceReload && activeId === id && webviewIsLive(activeWebview)) {
      renderAccounts();
      try { $('#browserAddress').textContent = activeWebview.getURL(); } catch {}
      setStatus(`${account.name} 沿用当前已打开的页面，不再重新加载`);
      return;
    }
    activeId = id;
    clearInterval(monitorTimer);
    clearTimeout(loadQuotaTimer);
    $('#browserWebviewHost').innerHTML = '';
    const webview = document.createElement('webview');
    webview.setAttribute('partition', account.partition);
    webview.setAttribute('allowpopups', '');
    webview.src = 'about:blank';
    const goHome = () => { try { webview.src = allowedUrl(account); } catch {} };
    webview.addEventListener('did-attach', () => setTimeout(goHome, 500), { once: true });
    setTimeout(() => { try { const url = webview.getURL && webview.getURL(); if (!url || url === 'about:blank') goHome(); } catch { goHome(); } }, 1600);
    webview.addEventListener('did-start-loading', () => setStatus(`正在打开 ${account.name}…`));
    webview.addEventListener('did-stop-loading', () => {
      $('#browserAddress').textContent = webview.getURL();
      setStatus(`${account.name} 已载入，正在检查视频积分/额度…`);
      clearTimeout(loadQuotaTimer);
      loadQuotaTimer = setTimeout(() => inspectQuota(false).catch(() => {}), 2500);
    });
    webview.addEventListener('did-fail-load', event => setStatus(`页面加载失败：${event.errorDescription}`));
    webview.addEventListener('will-navigate', event => {
      try {
        if (!event.url || event.url === 'about:blank') return;
        const host = new URL(event.url).hostname.toLowerCase();
        const google = /(^|\.)google\.com$|(^|\.)googleapis\.com$|(^|\.)gstatic\.com$|(^|\.)googleusercontent\.com$/i.test(host);
        if (!host.endsWith('doubao.com') && !host.endsWith('dola.com') && !(account.provider === 'dola' && google)) event.preventDefault();
      } catch { event.preventDefault(); }
    });
    $('#browserWebviewHost').append(webview);
    activeWebview = webview;
    renderAccounts();
    monitorTimer = setInterval(() => inspectQuota(false).catch(() => {}), 60000);
  }

  function setStatus(message) { $('#browserStatusBar').textContent = message; }

  async function fillCredential() {
    const account = activeAccount();
    if (!account || !activeWebview) return setStatus('请先选择账号');
    const credential = await window.desktop.browserAccountCredential(account.id);
    if (!credential.username && !credential.password) return setStatus('该账号没有保存登录资料，请手动登录');
    const result = await activeWebview.executeJavaScript(`(() => {
      const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0};
      const set=(element,value)=>{if(!element||!value)return false;const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));return true};
      const inputs=[...document.querySelectorAll('input')].filter(visible);
      const password=inputs.find(input=>input.type==='password');
      const username=inputs.find(input=>input!==password&&['email','tel','text'].includes(input.type))||inputs.find(input=>/email|username|identifier|account/i.test((input.name||'')+' '+(input.id||'')+' '+(input.autocomplete||'')));
      return {username:set(username,${JSON.stringify(credential.username)}),password:set(password,${JSON.stringify(credential.password)})};
    })()`);
    setStatus(result?.username || result?.password ? '账号资料已填充，请检查并手动完成登录/验证码' : '当前页面没有找到登录输入框');
  }

  async function inspectQuota(allowRotate = true) {
    const account = activeAccount();
    if (!account || !activeWebview) return null;
    const result = await activeWebview.executeJavaScript(`(() => {
      const clean=v=>String(v||'').replace(/\\s+/g,' ').trim();
      const text=(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,300000);
      const loginRequired=!!document.querySelector('input[type="password"]')||/(?:登录|注册|sign\\s*in|log\\s*in).{0,40}(?:账号|邮箱|手机|google|email)/i.test(text.slice(0,12000));
      const patterns=[/(?:视频|video)?.{0,12}(?:积分|额度|credits?|points?)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)/ig,/(\\d+(?:\\.\\d+)?)\\s*(?:视频)?(?:积分|credits?|points?)/ig];
      const hits=[];for(const pattern of patterns){let match;while((match=pattern.exec(text))&&hits.length<12)hits.push({value:Number(match[1]),text:match[0]})}
      const exhausted=/(?:视频|video).{0,28}(?:积分|额度|credits?|points?).{0,24}(?:不足|用完|用尽|耗尽|为\\s*0\\b)|今天的生成次数已经达到上限|(?:insufficient|no)\\s+(?:video\\s*)?(?:credits?|points?)/i.test(text);
      const best=hits.find(hit=>Number.isFinite(hit.value));
      const skip=/登录|注册|额度|积分|切换|设置|最近|聊天|新对话|标准套餐|专业套餐|免费套餐|视频生成|会员|下载|分享|创作|首页|助手|^Dola$|^豆包$|Sign in|Log in|Credits|New chat|Home|Explore|Settings|Recents|History|Upgrade|Library/i;
      const generic=/^(账号|Dola账号|豆包账号|User|Guest)$/i;
      const tidy=s=>clean(s).replace(/^[A-Za-z0-9]\\s+/, '');
      const ok=s=>{const t=tidy(s);return t.length>=2&&t.length<=32&&!skip.test(t)&&!generic.test(t)&&!/套餐|会员|Plus|Pro/.test(t)&&!/^\\d+$/.test(t)};
      let pageUserName='';
      const userHit=(text.match(/用户\\d{3,12}/)||[])[0]||'';
      if(userHit) pageUserName=userHit;
      if(!pageUserName){
        const avatars=[...document.querySelectorAll('div,span,button,a')].filter(el=>{
          const r=el.getBoundingClientRect();
          const letter=clean(el.innerText||'');
          return r.width>=18&&r.width<=56&&r.height>=18&&r.height<=56&&Math.abs(r.width-r.height)<10&&letter.length===1&&/[A-Za-z0-9\\u4e00-\\u9fff]/.test(letter)&&r.top>=0&&r.top<240;
        });
        for(const av of avatars){
          const sibling=tidy(av.nextElementSibling?.innerText||'');
          if(ok(sibling)){pageUserName=sibling;break;}
          let host=av.closest('button,a,[role="button"]')||av.parentElement;
          for(let i=0;i<4&&host;i++){
            const name=String(host.innerText||'').split(/\\n/).map(tidy).find(ok);
            if(name){pageUserName=name;break;}
            host=host.parentElement;
          }
          if(pageUserName) break;
        }
      }
      if(!pageUserName){
        const chips=[...document.querySelectorAll('button,a,[role="button"]')].filter(el=>{
          const r=el.getBoundingClientRect();
          return r.width>36&&r.height>16&&r.top>=0&&r.top<160&&r.left>=0&&r.left<720;
        });
        for(const el of chips){
          const name=String(el.innerText||'').split(/\\n/).map(tidy).find(ok);
          if(name){pageUserName=name;break;}
        }
      }
      if(!pageUserName){
        const nodes=[...document.querySelectorAll('button,a,div,span,p')];
        const plan=nodes.find(el=>{
          const t=clean((el.innerText||'').split('\\n')[0]);
          const r=el.getBoundingClientRect();
          return r.width>0&&r.height>0&&r.left<360&&t.length<16&&/套餐|会员|Plus|Pro/.test(t);
        });
        if(plan){
          let box=plan.closest('button,a,[role="button"]')||plan.parentElement;
          for(let i=0;i<4&&box;i++){
            const name=String(box.innerText||'').split(/\\n/).map(tidy).find(ok);
            if(name){pageUserName=name;break;}
            box=box.parentElement;
          }
        }
      }
      return {quotaStatus:loginRequired?'unknown':exhausted?'exhausted':best?'available':'unknown',quotaValue:loginRequired?null:(best?.value??null),quotaText:(loginRequired?'尚未登录，无法检查额度':hits.map(hit=>hit.text).join(' · ')||'页面未识别到明确视频积分/额度').slice(0,300),pageUserName};
    })()`);
    const pageUserName = String(result?.pageUserName || '').trim();
    if (pageUserName && window.desktop.setBrowserWindowTitle) {
      document.title = pageUserName;
      window.desktop.setBrowserWindowTitle(pageUserName).catch(() => {});
    }
    if (pendingCanvasTask || composerBusy) {
      if (pageUserName) await window.desktop.updateBrowserAccountQuota(account.id, { pageUserName }).catch(() => {});
      return null;
    }
    const updated = await window.desktop.updateBrowserAccountQuota(account.id, { ...result, pageUserName });
    accounts = accounts.map(item => item.id === account.id ? updated : item);
    renderAccounts();
    setStatus(`${pageUserName || account.name}：${quotaLabel(updated)} · ${updated.quotaText || ''}`);
    if (allowRotate && !pendingCanvasTask && updated.quotaStatus === 'exhausted' && $('#browserAutoRotate').checked) rotateToNextAvailable(account.id);
    return updated;
  }

  function rotateToNextAvailable(currentId) {
    const current = accounts.find(account => account.id === currentId);
    if (lockedAccountId) {
      return setStatus(`${current?.name || '当前账号'}额度不足。本窗口已固定账号，不会自动弹出其他浏览器`);
    }
    const provider = current?.provider;
    const enabled = accounts.filter(account => account.enabled !== false && account.id !== currentId && account.quotaStatus !== 'exhausted' && (!provider || account.provider === provider));
    if (!enabled.length) return setStatus(`${current?.name || '当前账号'}额度不足，同一平台没有下一个可用账号`);
    const next = enabled[0];
    setStatus(`当前账号额度不足，正在切换到同平台 ${next.name}`);
    openAccount(next.id);
  }

  function parseImportedText(text, filename = '') {
    let rows;
    if (filename.toLowerCase().endsWith('.json') || /^\s*[\[{]/.test(text)) rows = JSON.parse(text);
    else if (text.split(/\r?\n/).some(line => line.includes('----'))) {
      rows = text.split(/\r?\n/).map(line => line
        .replace(/^\s*[`'\"]+|[`'\"]+\s*$/g, '')
        .replace(/&#x20;|&nbsp;/gi, ' ')
        .trim()).filter(Boolean).map((line, index) => {
          const parts = line.split('----').map(part => part.trim());
          const username = (parts[0] || '').replace(/\\([@.])/g, '$1').trim();
          const password = (parts[1] || '').trim();
          if (/^(账号|邮箱|email|username|user)$/i.test(username) && /^(密码|password|pass)$/i.test(password)) return null;
          if (!username || !password) throw new Error(`第 ${index + 1} 行缺少邮箱或密码，格式应为：账号----密码----其他`);
          return { provider: 'dola', name: `Dola · ${username}`, username, password };
        }).filter(Boolean);
    }
    else {
      const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const header = lines.shift().split(',').map(value => value.trim().toLowerCase());
      rows = lines.map(line => { const values=line.split(','); return Object.fromEntries(header.map((key,index)=>[key,(values[index]||'').trim()])); });
    }
    return Array.isArray(rows) ? rows : [rows];
  }

  async function importText(text, filename = '') {
    const rows = parseImportedText(text, filename);
    if (!rows.length) throw new Error('没有识别到可导入的账号');
    await window.desktop.importBrowserAccounts(rows);
    await refreshAccounts();
    setStatus(`已导入 ${rows.length} 个账号，明文仅用于本次导入，登录资料已转为 Windows 本机加密存储`);
  }

  async function importAccounts(file) { return importText(await file.text(), file.name); }

  async function pasteImportAccounts() {
    const text = await window.desktop.readClipboardText();
    if (!text?.trim()) return;
    await importText(text, 'dola-accounts.txt');
  }

  const waitForWebview = (timeout = 60000) => new Promise((resolve, reject) => {
    const view = activeWebview;
    if (!view) return reject(new Error('没有可用账号页面'));
    const startedAt = Date.now();
    let timer = 0;
    let checking = false;
    const cleanup = () => {
      clearTimeout(timer);
      view.removeEventListener('did-fail-load', failed);
      view.removeEventListener('destroyed', destroyed);
    };
    const finish = value => { cleanup(); resolve(value); };
    const fail = error => { cleanup(); reject(error); };
    const failed = event => {
      if (event.isMainFrame === false || event.errorCode === -3) return;
      fail(new Error(`账号页面加载失败：${event.errorDescription || event.errorCode}`));
    };
    const destroyed = () => fail(new Error('账号页面已经关闭'));
    const probe = async () => {
      if (checking) return;
      checking = true;
      try {
        const state = await view.executeJavaScript(`({ready:document.readyState,body:!!document.body,url:location.href})`);
        if (state?.body && ['interactive','complete'].includes(state.ready) && /^https:\/\/(?:[^/]+\.)?(?:doubao|dola)\.com\//i.test(state.url || '')) return finish(view);
      } catch {}
      finally { checking = false; }
      if (Date.now() - startedAt >= timeout) return fail(new Error('账号页面在60秒内仍未进入可操作状态，请检查网络后点刷新重试'));
      timer = setTimeout(probe, 350);
    };
    view.addEventListener('did-fail-load', failed);
    view.addEventListener('destroyed', destroyed);
    probe();
  });

  async function applyComposerSettings(settings) {
    if (!activeWebview) return { ok: false, error: '还没有打开账号页面' };
    lastComposerSettings = {
      model: String(settings?.model || ''),
      duration: String(settings?.duration || ''),
      ratio: String(settings?.ratio || ''),
      provider: String(settings?.provider || activeAccount()?.provider || 'doubao')
    };
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const webContentsId = activeWebview.getWebContentsId();
    const inspectComposer = () => activeWebview.executeJavaScript(`(() => {
      const visible = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width>2 && r.height>2 && s.visibility!=='hidden' && s.display!=='none'; };
      const clean = v => String(v||'').replace(/\\s+/g,' ').trim();
      const inComposer = e => {
        if (e.closest('[data-slot="dropdown-menu-content"],[data-slot="dropdown-menu-sub-content"],[data-slot="dropdown-menu-sub-trigger"],[role="menu"],[data-radix-popper-content-wrapper]')) return false;
        const r = e.getBoundingClientRect();
        if (r.width >= 720 || r.height >= 160 || r.left <= 40) return false;
        const editors = [...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"],.ProseMirror')].filter(visible);
        const editor = editors.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
        if (editor) {
          const er = editor.getBoundingClientRect();
          return r.bottom > er.top - 96 && r.top < er.bottom + 96 && r.left >= er.left - 48 && r.right <= Math.max(er.right + 140, innerWidth - 8);
        }
        return r.top > innerHeight * 0.28 && r.bottom > innerHeight * 0.34 && r.top < innerHeight;
      };
      const blocked = e => /新工作任务|创建项目|新对话|定时任务|输入项目名称|云盘|技能|连接器|伙伴|API服务|安排任务|工作周报|^(项目|更多)$/.test(clean(e.innerText||e.textContent||e.getAttribute('aria-label')||e.getAttribute('title')));
      const nodes = [...document.querySelectorAll('button,[role="button"],[role="combobox"],[role="tab"],[data-slot="dropdown-menu-trigger"],[aria-haspopup="menu"],[data-input-engine-actionbar-render-entry-key],[data-creation-params-panel-id]')].filter(visible).filter(inComposer).filter(e => !blocked(e));
      const point = el => {
        const r = el.getBoundingClientRect();
        return { text: clean(el.innerText||el.textContent||el.getAttribute('aria-label')||el.getAttribute('title')), x: r.left+r.width/2, y: r.top+r.height/2, left: r.left, right: r.right, key: el.getAttribute('data-input-engine-actionbar-render-entry-key')||el.getAttribute('data-creation-params-panel-id')||'', w: r.width, h: r.height, svg: Boolean(el.querySelector('svg')) };
      };
      const all = nodes.map(point);
      const items = all.filter(item => item.text && item.text.length < 80);
      const model = items.find(item => /^模型/.test(item.text) || (/seedance/i.test(item.text) && item.text.length < 40 && !/生成|项目|任务|周报/.test(item.text)));
      const durationOnly = items.find(item => /^\\d+\\s*(s|秒)$/i.test(item.text));
      const combined = items.find(item => /video-generation-params|creation-video-generation-params/.test(item.key) || /^(自动|比例|\\d+\\s*:\\s*\\d+)\\s*[·•・/\\s]+\\d+\\s*(s|秒)$/i.test(item.text) || (/[·•・]\\s*\\d+\\s*(s|秒)/i.test(item.text) && /(\\d+\\s*:\\s*\\d+|自动|比例)/.test(item.text)) || (/比例/.test(item.text) && /\\d+\\s*(s|秒)|时长/.test(item.text)));
      const ratioOnly = items.find(item => /^(比例|自动|\\d+\\s*:\\s*\\d+)$/.test(item.text));
      const rounds = all.filter(item => Math.abs(item.w-item.h)<16 && item.w>=20 && item.w<=56);
      const send = [...rounds].sort((a,b)=>b.left-a.left)[0] || null;
      const paramsByKey = all.find(item => /video-generation-params|creation-video-generation-params|params-panel/.test(item.key));
      const moreButton = model ? all.find(item => {
          if (/模型|seedance/i.test(item.text || '')) return false;
          if (send && item.left >= send.left - 8) return false;
          const toRight = item.left >= (model.right || model.x) - 2 && item.left <= (model.right || model.x) + 56;
          return toRight && Math.abs(item.y - model.y) < 28 && item.w <= 44 && item.h <= 44 && item.w >= 20;
        }) : null;
      const paramsIcon = combined || paramsByKey || moreButton || items.find(item => /参数|时长设置|视频参数/.test(item.text));
      return { model, durationOnly, combined, ratioOnly, paramsIcon, moreButton, labels: items.map(item => item.text) };
    })()`, true);
    const menuItems = () => activeWebview.executeJavaScript(`(() => {
      const visible = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width>8 && r.height>8 && s.visibility!=='hidden' && s.display!=='none'; };
      const clean = v => String(v||'').replace(/\\s+/g,' ').trim();
      return [...document.querySelectorAll('button,[role="menuitem"],[role="option"],[role="button"]')].filter(visible).map(el => {
        const r = el.getBoundingClientRect();
        const text = clean(el.innerText||el.textContent||el.getAttribute('aria-label'));
        return text && text.length < 48 && el.getAttribute('role') !== 'slider' && !/新工作任务|创建项目|新对话|定时任务|云盘|^项目$|^技能$|连接器|^更多$/.test(text) ? { text, x: r.left + r.width/2, y: r.top + r.height/2 } : null;
      }).filter(Boolean);
    })()`, true);
    const modelMaxSec = /2\.5/i.test(String(lastComposerSettings.model || '')) ? 30 : 15;
    const inspectDurationPanel = () => activeWebview.executeJavaScript(`(() => {
      const visible = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width>2 && r.height>2 && s.visibility!=='hidden' && s.display!=='none'; };
      const clean = v => String(v||'').replace(/\\s+/g,' ').trim();
      const box = el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2, left: r.left, width: r.width, height: r.height }; };
      const menus = [...document.querySelectorAll('[data-slot="dropdown-menu-sub-content"],[data-slot="dropdown-menu-content"],[role="menu"],[role="dialog"],[role="listbox"],[data-radix-popper-content-wrapper],[data-state="open"]')].filter(visible);
      const subTrigger = [...document.querySelectorAll('[data-slot="dropdown-menu-sub-trigger"]')].filter(visible).map(el => {
        const text = clean(el.innerText||el.textContent);
        return /^(自动|比例|\\d+\\s*:\\s*\\d+)\\s*[·•・/\\s]+\\d+\\s*(s|秒)$/i.test(text) ? { ...box(el), text } : null;
      }).filter(Boolean)[0] || null;
      const menu = menus.find(el => el.getAttribute('data-slot') === 'dropdown-menu-sub-content' && /时长/.test(clean(el.innerText||el.textContent)))
        || menus.find(el => {
          const text = clean(el.innerText||el.textContent);
          const r = el.getBoundingClientRect();
          if (r.width < 220 || r.height < 90) return false;
          if (/seedance/i.test(text) && !/时长|比例/.test(text)) return false;
          return (/时长/.test(text) && /比例|自动/.test(text)) || Boolean(el.querySelector('input[type="range"],[role="slider"]'));
        }) || null;
      if (!menu) return { open: false, moreOpen: menus.length > 0, subTrigger };
      const numbers = [...menu.querySelectorAll('span,div,button,label')].filter(visible).map(el => /^(\\d+)\\s*(s|秒)$/i.exec(clean(el.innerText||el.textContent))).filter(Boolean).map(match => Number(match[1]));
      const range = [...menu.querySelectorAll('input[type="range"]')].filter(visible).at(-1) || null;
      const sliderEl = [...menu.querySelectorAll('[role="slider"]')].filter(visible)[0] || null;
      let trackEl = sliderEl;
      if (sliderEl) {
        let node = sliderEl;
        for (let i = 0; i < 6 && node && node !== menu; i++) {
          const r = node.getBoundingClientRect();
          if (r.width > 80 && r.height >= 8 && r.height <= 48) { trackEl = node; break; }
          node = node.parentElement;
        }
      }
      const ticks = [...menu.querySelectorAll('span,div,button,label')].filter(visible).map(el => {
        const text = clean(el.innerText||el.textContent||el.getAttribute('aria-label'));
        return /^\\d+\\s*(s|秒)$/i.test(text) ? { ...box(el), text } : null;
      }).filter(Boolean);
      const options = [...menu.querySelectorAll('button,[role="option"],[role="menuitem"]')].filter(visible).map(el => {
        const text = clean(el.innerText||el.textContent||el.getAttribute('aria-label'));
        return /^\\d+\\s*(s|秒)$/i.test(text) ? { ...box(el), text } : null;
      }).filter(Boolean);
      const ratioRoot = menus.find(el => {
        const text = clean(el.innerText||el.textContent);
        return /比例/.test(text) && (el.getAttribute('data-slot') === 'dropdown-menu-content' || /自动|16:9|9:16|1:1/.test(text));
      }) || menus.find(el => /比例/.test(clean(el.innerText||el.textContent))) || menu;
      const ratioOptions = [...(ratioRoot || menu).querySelectorAll('button,[role="option"],[role="menuitem"],[role="radio"]')].filter(visible).map(el => {
        const text = clean(el.innerText||el.textContent||el.getAttribute('aria-label'));
        if (!/^(自动|比例|\\d+\\s*:\\s*\\d+)$/i.test(text)) return null;
        return { ...box(el), text };
      }).filter(Boolean);
      const selected = [...menu.querySelectorAll('[aria-selected="true"],[data-state="checked"],[data-state="on"]')].map(el => clean(el.innerText||el.textContent)).find(text => /^\\d+\\s*(s|秒)$/i.test(text));
      const rangeValue = range ? Number(range.value) : NaN;
      const sliderMin = sliderEl ? Number(sliderEl.getAttribute('aria-valuemin')) : (range ? Number(range.min) : NaN);
      const sliderMax = sliderEl ? Number(sliderEl.getAttribute('aria-valuemax')) : (range ? Number(range.max) : NaN);
      const sliderNow = sliderEl ? Number(sliderEl.getAttribute('aria-valuenow')) : rangeValue;
      const modelMax = ${modelMaxSec};
      const chipSec = Number((/(\\d+)\\s*(?:s|秒)\\s*$/i.exec((subTrigger && subTrigger.text) || '') || [])[1]);
      const tickNumbers = numbers.filter(n => n >= 4 && n <= 30 && n !== chipSec);
      const minSec = tickNumbers.length ? Math.min(...tickNumbers) : 4;
      const labeledMax = tickNumbers.length ? Math.max(...tickNumbers) : modelMax;
      const maxSec = Math.max(minSec + 1, labeledMax, modelMax);
      const sliderSpan = sliderMax - sliderMin;
      const labeledSpan = maxSec - minSec;
      let currentSeconds = 0;
      if (Number.isFinite(sliderNow) && Number.isFinite(sliderSpan) && sliderSpan > 0 && Number.isFinite(labeledSpan) && labeledSpan > 0) {
        if (sliderSpan === labeledSpan) currentSeconds = minSec + (sliderNow - sliderMin);
        else currentSeconds = minSec + Math.round(((sliderNow - sliderMin) / sliderSpan) * labeledSpan);
      } else if (rangeValue >= 4 && rangeValue <= 30) currentSeconds = rangeValue;
      else if (selected) currentSeconds = Number((/^(\\d+)/.exec(selected) || [])[1]) || 0;
      if (Number.isFinite(chipSec) && chipSec >= 4 && chipSec <= 30) currentSeconds = chipSec;
      const currentLabel = currentSeconds ? (currentSeconds + 's') : (selected || '');
      return {
        open: true,
        minSec,
        maxSec,
        currentLabel,
        currentSeconds,
        sliderMin: Number.isFinite(sliderMin) ? sliderMin : 0,
        sliderMax: Number.isFinite(sliderMax) ? sliderMax : labeledSpan,
        sliderNow: Number.isFinite(sliderNow) ? sliderNow : currentSeconds,
        range: range ? { ...box(range), min: Number(range.min || minSec), max: Number(range.max || maxSec), value: Number(range.value) } : null,
        slider: trackEl ? { ...box(trackEl), min: Number.isFinite(sliderMin) ? sliderMin : 0, max: Number.isFinite(sliderMax) ? sliderMax : 100, now: Number.isFinite(sliderNow) ? sliderNow : 0 } : null,
        options,
        ticks,
        ratioOptions,
        subTrigger
      };
    })()`, true);
    const applyRangeValue = seconds => activeWebview.executeJavaScript(`(() => {
      const value = ${Number(seconds)};
      const ranges = [...document.querySelectorAll('input[type="range"]')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 0; });
      const range = ranges[ranges.length - 1];
      if (!range) return null;
      const minimum = Number(range.min || 4);
      if (!Number.isFinite(Number(range.max)) || Number(range.max) < value) range.max = String(Math.max(value, 30));
      const maximum = Number(range.max || 30);
      const next = Math.max(minimum, Math.min(maximum, value));
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(range, String(next));
      range.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(next) }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
      const sliders = [...document.querySelectorAll('[role="slider"]')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 8 && r.height > 0; });
      const slider = sliders[0];
      if (slider) {
        const sMax = Number(slider.getAttribute('aria-valuemax'));
        if (!Number.isFinite(sMax) || sMax < value) slider.setAttribute('aria-valuemax', String(Math.max(value, 30)));
        slider.setAttribute('aria-valuenow', String(next));
      }
      return { value: Number(range.value), minimum, maximum };
    })()`, true);
    const compact = v => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/秒/g, 's').replace(/\s+/g, '');
    const secondsOf = value => {
      const matched = String(value || '').match(/(\d+)\s*(?:s|秒)\s*$/i) || String(value || '').match(/(\d+)\s*(?:s|秒)/i) || String(value || '').match(/^(\d+)$/);
      return matched ? String(Number(matched[1])) : '';
    };
    const modelNeedles = target => {
      const n = compact(target);
      if (n.includes('2.5')) return { already: t => /2\.5/.test(compact(t)), option: t => /2\.5/.test(compact(t)) && compact(t).length < 40 };
      if (n.includes('mini')) return { already: t => /mini/.test(compact(t)), option: t => /mini/.test(compact(t)) };
      if (n.includes('fast')) return { already: t => /fast/.test(compact(t)) && !/2\.5/.test(compact(t)), option: t => /fast/.test(compact(t)) && !/2\.5/.test(compact(t)) };
      return { already: t => compact(t).includes(n.replace(/^seedance/, '')), option: t => compact(t).includes(n) || compact(t).includes(n.replace(/^seedance/, '')) };
    };
    const durationNeedles = target => {
      const seconds = secondsOf(target) || String(parseInt(String(target || ''), 10));
      return {
        already: t => secondsOf(t) === seconds,
        option: t => secondsOf(t) === seconds || compact(t) === seconds + 's' || compact(t) === seconds
      };
    };
    const ratioNeedles = target => {
      const n = compact(target);
      if (!n || n === '自动' || n === 'auto') return {
        already: t => /自动|auto/.test(compact(t)) || (/比例/.test(compact(t)) && !/\d+:\d+/.test(compact(t))),
        option: t => /^(自动|auto)$/.test(compact(t))
      };
      return { already: t => compact(t).includes(n), option: t => compact(t) === n || compact(t) === '比例' + n || compact(t).startsWith(n) };
    };
    const ratioConfirmed = (chip, wanted) => {
      const needles = ratioNeedles(wanted);
      return needles.already(chip);
    };
    const click = async point => {
      if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return { ok: false };
      return window.desktop.trustedClick({ webContentsId, x: point.x, y: point.y });
    };
    const hover = async point => {
      if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return { ok: false };
      return window.desktop.trustedClick({ webContentsId, x: point.x, y: point.y, hoverOnly: true });
    };
    const dismissProjectModal = () => activeWebview.executeJavaScript(`(() => {
      const visible = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width>2 && r.height>2 && s.visibility!=='hidden' && s.display!=='none'; };
      const clean = v => String(v||'').replace(/\\s+/g,' ').trim();
      const dialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(visible);
      const project = dialogs.find(el => /创建项目|输入项目名称/.test(clean(el.innerText||el.textContent)));
      const heading = [...document.querySelectorAll('h1,h2,div,p,span,label')].filter(visible).find(el => /^(创建项目|输入项目名称)$/.test(clean(el.innerText)));
      if (!project && !heading) return { open: false };
      const scope = project || heading.closest('[role="dialog"],[role="alertdialog"]') || heading.parentElement || document.body;
      const cancel = [...scope.querySelectorAll('button')].filter(visible).find(b => /^(取消|关闭)$/.test(clean(b.innerText||b.textContent)));
      if (cancel) { cancel.click(); return { open: true, dismissed: true }; }
      return { open: true, dismissed: false };
    })()`, true);
    const press = async (key, code, vk) => window.desktop.trustedKey({ webContentsId, key, code, windowsVirtualKeyCode: vk });
    const durationValue = () => Number.parseInt(secondsOf(lastComposerSettings.duration) || lastComposerSettings.duration, 10);
    const durationConfirmed = (chip, seconds) => secondsOf(chip) === String(seconds);
    const setDurationFromPanel = async (seconds, options = {}) => {
      const desired = Number(seconds);
      const once = options.once === true;
      const panelMatches = panel => Number(panel?.currentSeconds) === desired || durationConfirmed(panel?.currentLabel, desired) || durationConfirmed(panel?.subTrigger?.text, desired);
      let panel = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        panel = await inspectDurationPanel();
        if (panel?.open) break;
        if (panel?.subTrigger) {
          await hover(panel.subTrigger);
          await pause(250);
          panel = await inspectDurationPanel();
          if (panel?.open || panelMatches(panel)) break;
          await click(panel.subTrigger);
          await pause(350);
          continue;
        }
        await pause(150);
      }
      if (panelMatches(panel)) return { ok: true, alreadySelected: true, chip: panel?.subTrigger?.text || panel?.currentLabel || `${desired}s` };
      if (!panel?.open) return { error: '时长面板没有展开', chip: panel?.subTrigger?.text || '' };
      const discrete = (panel.options || []).find(item => durationConfirmed(item.text, desired) && Number(item.width) < 64 && Number(item.height) < 36);
      if (discrete && !once) {
        await click(discrete);
        await pause(350);
        panel = await inspectDurationPanel();
        if (panelMatches(panel)) return { ok: true, chip: panel?.subTrigger?.text || panel?.currentLabel || discrete.text };
      }
      const track = (panel.slider && panel.slider.width > 80 ? panel.slider : null) || (panel.range && panel.range.width > 80 ? panel.range : null) || panel.slider || panel.range;
      const minSec = Number.isFinite(panel.minSec) ? panel.minSec : 4;
      const maxSec = Math.max(Number.isFinite(panel.maxSec) ? panel.maxSec : (minSec + 1), desired, modelMaxSec);
      const sliderMin = Number.isFinite(panel.sliderMin) ? panel.sliderMin : (Number.isFinite(panel.slider?.min) ? panel.slider.min : 0);
      const sliderMax = Number.isFinite(panel.sliderMax) ? panel.sliderMax : (Number.isFinite(panel.slider?.max) ? panel.slider.max : maxSec - minSec);
      const target = Math.round(sliderMin + ((desired - minSec) / Math.max(1, maxSec - minSec)) * (sliderMax - sliderMin));
      const readNow = next => Number(next?.currentSeconds) || Number(secondsOf(next?.subTrigger?.text || next?.currentLabel)) || 0;
      const nudgeDuration = async () => {
        panel = await inspectDurationPanel();
        if (panelMatches(panel)) return true;
        const now = readNow(panel);
        if (!panel?.open || !now) return false;
        const diff = desired - now;
        if (!diff) return true;
        if (Math.abs(diff) > 6) return false;
        if (diff > 0) {
          for (let step = 0; step < diff; step++) await press('ArrowRight', 'ArrowRight', 39);
        } else {
          for (let step = 0; step < -diff; step++) await press('ArrowLeft', 'ArrowLeft', 37);
        }
        await pause(180);
        panel = await inspectDurationPanel();
        return panelMatches(panel);
      };
      if (track && track.width > 8) {
        const t = (desired - minSec) / Math.max(1, maxSec - minSec);
        const x = track.left + (desired >= maxSec ? track.width - 1 : desired <= minSec ? 1 : Math.max(1, Math.min(track.width - 1, t * track.width)));
        await click({ x, y: track.y });
        await pause(280);
        panel = await inspectDurationPanel();
        if (panelMatches(panel) || await nudgeDuration()) return { ok: true, chip: panel?.subTrigger?.text || panel?.currentLabel || `${desired}s` };
      }
      if (panel?.open && track) {
        await click({ x: track.left + (desired >= maxSec ? Math.max(1, track.width - 1) : Math.max(1, track.width / 2)), y: track.y });
        await pause(80);
        if (desired >= maxSec) await press('End', 'End', 35);
        else {
          await press('Home', 'Home', 36);
          const steps = Math.max(0, Math.min(sliderMax - sliderMin, target - sliderMin));
          for (let step = 0; step < steps; step++) await press('ArrowRight', 'ArrowRight', 39);
        }
        await pause(160);
        if (await nudgeDuration()) return { ok: true, chip: panel?.subTrigger?.text || panel?.currentLabel || `${desired}s` };
        for (let attempt = 0; attempt < 8; attempt++) {
          await pause(120);
          panel = await inspectDurationPanel();
          if (panelMatches(panel) || await nudgeDuration()) return { ok: true, chip: panel?.subTrigger?.text || panel?.currentLabel || `${desired}s` };
        }
      }
      return { error: `没有把时长调到 ${desired} 秒`, chip: panel?.currentLabel || panel?.subTrigger?.text || '' };
    };
    const closeParamsPanel = async () => {
      await press('Escape', 'Escape', 27);
      await pause(120);
      await press('Escape', 'Escape', 27);
      await pause(180);
    };
    const pickFromMenu = async (needles, label, target, chipText) => {
      let option = null;
      let labels = [];
      for (let attempt = 0; attempt < 24; attempt++) {
        const items = await menuItems();
        labels = (items || []).map(item => item.text);
        option = (items || []).find(item => item.text !== chipText && needles.option(item.text));
        if (option) break;
        await pause(150);
      }
      if (!option) return { error: label + '菜单中没有找到画布选项 ' + target, chip: chipText, openLabels: labels.slice(-24) };
      await click(option);
      await pause(400);
      return { ok: true, chip: option.text };
    };
    const pickChip = async (chip, needles, label, target) => {
      if (!chip) return { error: '没有找到' + label + '按钮' };
      if (needles.already(chip.text)) return { ok: true, alreadySelected: true, chip: chip.text };
      await click(chip);
      await pause(500);
      return pickFromMenu(needles, label, target, chip.text);
    };
    let found = null;
    await dismissProjectModal();
    const pageUrl = await activeWebview.executeJavaScript('location.href').catch(() => '');
    if (/scheduled_tasks|\/drive\b|\/skills?\b|\/connectors?\b|\/cloud|\/workspace/i.test(String(pageUrl || ''))) {
      const home = /dola\.com/i.test(String(pageUrl)) ? 'https://www.dola.com/' : 'https://www.doubao.com/chat/';
      await activeWebview.executeJavaScript(`location.assign(${JSON.stringify(home)})`);
      await pause(1200);
    }
    for (let attempt = 0; attempt < 24; attempt++) {
      found = await inspectComposer();
      if (found?.durationOnly || found?.combined || found?.paramsIcon || found?.moreButton || (attempt > 2 && found?.model)) break;
      await pause(250);
    }
    const model = await pickChip(found?.model, modelNeedles(lastComposerSettings.model), '模型', lastComposerSettings.model);
    if (model.error && !/seedance/i.test(found?.model?.text || '')) return { ...model, openLabels: found?.labels };
    await closeParamsPanel();
    found = await inspectComposer() || found;
    for (let attempt = 0; attempt < 16 && !found?.durationOnly && !found?.combined && !found?.paramsIcon && !found?.moreButton; attempt++) {
      await pause(200);
      found = await inspectComposer() || found;
    }
    let duration;
    let ratio;
    const wantedSeconds = durationValue();
    const pageIsDola = /dola\.com/i.test(String(pageUrl || ''));
    const pageIsDoubao = /doubao\.com/i.test(String(pageUrl || '')) || !pageIsDola;
    const paramsTrigger = pageIsDoubao
      ? (found?.moreButton || found?.paramsIcon || found?.combined)
      : (found?.combined || found?.paramsIcon || found?.moreButton);
    const findDoubaoMore = () => activeWebview.executeJavaScript(`(() => {
      const visible = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width>2 && r.height>2 && s.visibility!=='hidden' && s.display!=='none'; };
      const clean = v => String(v||'').replace(/\\s+/g,' ').trim();
      const model = [...document.querySelectorAll('button,[role="button"]')].filter(visible).find(el => /^模型/.test(clean(el.innerText||el.textContent)));
      if (!model) return null;
      const mr = model.getBoundingClientRect();
      const rounds = [...document.querySelectorAll('button,[role="button"],[data-slot="dropdown-menu-trigger"]')].filter(visible).filter(el => {
        const r = el.getBoundingClientRect();
        return Math.abs(r.width-r.height)<16 && r.width>=20 && r.width<=48 && Math.abs(r.top - mr.top) < 36;
      });
      const send = [...rounds].sort((a,b)=>b.getBoundingClientRect().left-a.getBoundingClientRect().left)[0];
      const hit = rounds.find(el => {
        const r = el.getBoundingClientRect();
        if (send && Math.abs(r.left - send.getBoundingClientRect().left) < 4) return false;
        return r.left >= mr.right - 2 && r.left <= mr.right + 72 && Math.abs(r.top - mr.top) < 28;
      });
      if (!hit) return null;
      const r = hit.getBoundingClientRect();
      return { x: r.left+r.width/2, y: r.top+r.height/2, left: r.left, text: clean(hit.innerText||hit.textContent), w: r.width, h: r.height };
    })()`, true);
    const openParams = async trigger => {
      if (!trigger) return false;
      await closeParamsPanel();
      await click(trigger);
      await pause(280);
      for (let attempt = 0; attempt < 20; attempt++) {
        const panel = await inspectDurationPanel();
        if (panel?.open) return true;
        if (panel?.subTrigger) {
          await hover(panel.subTrigger);
          await pause(280);
          if ((await inspectDurationPanel())?.open) return true;
          await click(panel.subTrigger);
          await pause(400);
          continue;
        }
        const items = await menuItems();
        const subItem = (items || []).find(item => /^(自动|比例|\d+\s*:\s*\d+)\s*[·•・/\s]+\d+\s*(s|秒)$/i.test(item.text));
        if (subItem) {
          await hover(subItem);
          await pause(280);
          if ((await inspectDurationPanel())?.open) return true;
          await click(subItem);
          await pause(400);
          continue;
        }
        const durationEntry = (items || []).find(item => !/创建项目|新工作任务|新对话|定时任务|云盘|^项目$|技能|连接器/.test(item.text) && (/^(时长|视频时长|duration)$/i.test(item.text) || (/时长/.test(item.text) && item.text.length < 12)));
        if (durationEntry) {
          await click(durationEntry);
          await pause(400);
          continue;
        }
        await pause(150);
      }
      return false;
    };
    const peekMenuDuration = async trigger => {
      if (!trigger) return '';
      await closeParamsPanel();
      await click(trigger);
      await pause(450);
      let panel = await inspectDurationPanel();
      if (!panel?.open && panel?.subTrigger) {
        const sub = panel.subTrigger;
        await hover(sub);
        await pause(400);
        panel = await inspectDurationPanel();
        if (!panel?.open) {
          await click(sub);
          await pause(450);
          panel = await inspectDurationPanel();
        }
      }
      const chip = panel?.subTrigger?.text || (Number(panel?.currentSeconds) ? `${panel.currentSeconds}s` : '') || panel?.currentLabel || '';
      await closeParamsPanel();
      return chip;
    };
    const forceSetDuration = async trigger => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const opened = trigger ? await openParams(trigger) : (await inspectDurationPanel())?.open;
        if (!opened) {
          await pause(250);
          continue;
        }
        const result = await setDurationFromPanel(wantedSeconds);
        const panel = await inspectDurationPanel();
        const panelSeconds = Number(panel?.currentSeconds);
        const panelChip = panel?.subTrigger?.text || panel?.currentLabel || result?.chip || '';
        await closeParamsPanel();
        found = await inspectComposer() || found;
        let chip = found?.durationOnly?.text || found?.combined?.text || '';
        if (!durationConfirmed(chip, wantedSeconds)) chip = panelChip;
        if (!durationConfirmed(chip, wantedSeconds) && (trigger || paramsTrigger)) {
          chip = await peekMenuDuration(trigger || paramsTrigger) || chip;
        }
        if ((result && !result.error && durationConfirmed(chip, wantedSeconds)) || panelSeconds === wantedSeconds || durationConfirmed(chip, wantedSeconds)) {
          return { ok: true, chip: chip || `${wantedSeconds}s` };
        }
        await pause(300);
      }
      found = await inspectComposer() || found;
      const actual = found?.durationOnly?.text || found?.combined?.text || await peekMenuDuration(trigger || paramsTrigger) || '';
      return { error: `画布时长 ${wantedSeconds} 秒，页面仍是 ${actual || '未选择'}` };
    };
    const pickDoubaoRatioInPanel = async () => {
      const wanted = lastComposerSettings.ratio || '自动';
      const needles = ratioNeedles(wanted);
      for (let attempt = 0; attempt < 8; attempt++) {
        const panel = await inspectDurationPanel();
        const chip = panel?.subTrigger?.text || '';
        if (chip && ratioConfirmed(chip, wanted)) return { ok: true, alreadySelected: true, chip };
        const fromPanel = (panel?.ratioOptions || []).find(item => needles.option(item.text) && !/\d+\s*(s|秒)/i.test(item.text));
        const items = await menuItems();
        const hit = fromPanel || (items || []).find(item => needles.option(item.text) && !/\d+\s*(s|秒)/i.test(item.text));
        if (hit) {
          await click(hit);
          await pause(320);
          const after = await inspectDurationPanel();
          const nextChip = after?.subTrigger?.text || hit.text;
          if (ratioConfirmed(nextChip, wanted) || needles.option(hit.text)) return { ok: true, chip: nextChip };
        }
        await pause(160);
      }
      return { error: `豆包页面没有自动选中画布比例 ${wanted}` };
    };
    const syncDoubaoVideoParams = async () => {
      let trigger = found?.moreButton || (await findDoubaoMore()) || paramsTrigger;
      if (!trigger) return { error: '豆包页面没有找到模型右侧的参数按钮（…），无法同步时长和比例。豆包和 Dola 的入口不同，不会去点 Dola 的组合按钮' };
      const openDoubaoPanel = async () => {
        await closeParamsPanel();
        trigger = (await findDoubaoMore()) || trigger;
        await click(trigger);
        await pause(400);
        let panel = await inspectDurationPanel();
        if (!panel?.open && panel?.subTrigger) {
          const sub = panel.subTrigger;
          await hover(sub);
          await pause(350);
          panel = await inspectDurationPanel();
          if (!panel?.open) {
            await click(sub);
            await pause(350);
            panel = await inspectDurationPanel();
          }
        }
        return panel;
      };
      let panel = await openDoubaoPanel();
      if (!panel?.open && !panel?.subTrigger && !(panel?.ratioOptions || []).length) {
        return { error: '豆包比例和时长面板没有展开' };
      }
      const ratio = await pickDoubaoRatioInPanel();
      if (ratio.error) {
        await closeParamsPanel();
        return ratio;
      }
      panel = await inspectDurationPanel();
      const chipNow = panel?.subTrigger?.text || '';
      if (durationConfirmed(chipNow, wantedSeconds) && ratioConfirmed(chipNow, lastComposerSettings.ratio)) {
        await closeParamsPanel();
        return { ok: true, chip: chipNow, ratio: ratio.chip || lastComposerSettings.ratio };
      }
      let lastChip = chipNow;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) {
          panel = await openDoubaoPanel();
          if (!panel?.open && !panel?.subTrigger) break;
          await pickDoubaoRatioInPanel();
          panel = await inspectDurationPanel();
          if (durationConfirmed(panel?.subTrigger?.text, wantedSeconds) && ratioConfirmed(panel?.subTrigger?.text, lastComposerSettings.ratio)) {
            await closeParamsPanel();
            return { ok: true, chip: panel.subTrigger.text, ratio: lastComposerSettings.ratio };
          }
        }
        const result = await setDurationFromPanel(wantedSeconds, { once: true });
        panel = await inspectDurationPanel();
        lastChip = panel?.subTrigger?.text || result?.chip || lastChip;
        if (durationConfirmed(lastChip, wantedSeconds) || Number(panel?.currentSeconds) === wantedSeconds) {
          const ratioAgain = await pickDoubaoRatioInPanel();
          if (ratioAgain.error) {
            await closeParamsPanel();
            return ratioAgain;
          }
          panel = await inspectDurationPanel();
          lastChip = panel?.subTrigger?.text || lastChip;
          await closeParamsPanel();
          return { ok: true, chip: lastChip || `${wantedSeconds}s`, ratio: ratioAgain.chip || lastComposerSettings.ratio };
        }
        await pause(200);
      }
      await closeParamsPanel();
      return { error: `画布时长 ${wantedSeconds} 秒，豆包页面仍是 ${lastChip || '未选择'}（已按豆包 … 子菜单同步，不是 Dola 组合按钮）` };
    };
    if (pageIsDoubao) {
      duration = await syncDoubaoVideoParams();
      if (duration.error) return duration;
      ratio = { ok: true, chip: duration.ratio || lastComposerSettings.ratio };
    } else if (found?.combined && !found?.durationOnly) {
      if (durationConfirmed(found.combined.text, wantedSeconds) && ratioNeedles(lastComposerSettings.ratio).already(found.combined.text)) {
        duration = { ok: true, alreadySelected: true, chip: found.combined.text };
        ratio = { ok: true, alreadySelected: true, chip: found.combined.text };
      } else {
        duration = await forceSetDuration(found.combined);
        if (duration.error) return duration;
        if (await openParams(found.combined || paramsTrigger)) {
          ratio = await pickFromMenu(ratioNeedles(lastComposerSettings.ratio), '比例', lastComposerSettings.ratio, found.combined.text);
          await closeParamsPanel();
        }
        if (ratio?.error) ratio = { ok: true, chip: lastComposerSettings.ratio };
        found = await inspectComposer() || found;
        if (!durationConfirmed(found?.combined?.text || duration.chip, wantedSeconds)) {
          return { error: `画布时长 ${wantedSeconds} 秒，页面仍是 ${found?.combined?.text || duration.chip || '未选择'}` };
        }
        duration = { ok: true, chip: found?.combined?.text || duration.chip };
        ratio = { ok: true, chip: found?.combined?.text || ratio?.chip || lastComposerSettings.ratio };
      }
    } else if (found?.durationOnly) {
      duration = await pickChip(found.durationOnly, durationNeedles(lastComposerSettings.duration), '时长', lastComposerSettings.duration);
      if (duration.error || !durationConfirmed(duration.chip, wantedSeconds)) {
        duration = await forceSetDuration(found.paramsIcon || found.combined);
      }
      if (duration.error) return duration;
      if (found?.ratioOnly || found?.combined) {
        ratio = await pickChip(found.ratioOnly || found.combined, ratioNeedles(lastComposerSettings.ratio), '比例', lastComposerSettings.ratio);
        if (ratio.error) ratio = { ok: true, chip: lastComposerSettings.ratio };
      } else if (found?.paramsIcon) {
        await openParams(found.paramsIcon);
        ratio = await pickFromMenu(ratioNeedles(lastComposerSettings.ratio), '比例', lastComposerSettings.ratio, '');
        if (ratio.error) ratio = { ok: true, chip: lastComposerSettings.ratio };
        await closeParamsPanel();
      } else {
        ratio = { ok: true, chip: lastComposerSettings.ratio };
      }
    } else if (paramsTrigger) {
      duration = await forceSetDuration(paramsTrigger);
      if (duration.error) return duration;
      if (await openParams(paramsTrigger)) {
        ratio = await pickFromMenu(ratioNeedles(lastComposerSettings.ratio), '比例', lastComposerSettings.ratio, '');
        if (ratio.error) ratio = { ok: true, chip: lastComposerSettings.ratio };
        await closeParamsPanel();
      } else {
        ratio = { ok: true, chip: lastComposerSettings.ratio };
      }
      found = await inspectComposer() || found;
      if (!durationConfirmed(found?.durationOnly?.text || found?.combined?.text || duration.chip, wantedSeconds)) {
        return { error: `画布时长 ${wantedSeconds} 秒，页面仍是 ${found?.combined?.text || found?.durationOnly?.text || duration.chip || '未选择'}` };
      }
      duration = { ok: true, chip: found?.durationOnly?.text || found?.combined?.text || duration.chip };
    } else {
      return { error: `没有找到时长设置入口，无法把页面调到画布的 ${wantedSeconds} 秒` };
    }
    found = await inspectComposer() || found;
    const visibleDuration = found?.durationOnly?.text || found?.combined?.text || '';
    if (!pageIsDoubao && Number.isFinite(wantedSeconds) && wantedSeconds > 0) {
      if (visibleDuration && !durationConfirmed(visibleDuration, wantedSeconds)) {
        return { error: `画布时长 ${wantedSeconds} 秒，页面仍是 ${visibleDuration}` };
      }
      if (!visibleDuration && !durationConfirmed(duration?.chip, wantedSeconds)) {
        return { error: `画布时长 ${wantedSeconds} 秒，页面仍是 ${duration?.chip || '未选择'}` };
      }
    }
    if (pageIsDoubao && Number.isFinite(wantedSeconds) && wantedSeconds > 0 && !durationConfirmed(duration?.chip, wantedSeconds)) {
      return { error: `画布时长 ${wantedSeconds} 秒，豆包页面仍是 ${duration?.chip || '未选择'}` };
    }
    if (pageIsDoubao && lastComposerSettings.ratio && !ratioConfirmed(duration?.chip, lastComposerSettings.ratio) && !ratioConfirmed(ratio?.chip, lastComposerSettings.ratio)) {
      return { error: `画布比例 ${lastComposerSettings.ratio}，豆包页面仍是 ${duration?.chip || ratio?.chip || '未选择'}` };
    }
    if (!duration?.chip) duration = { ok: true, chip: `${wantedSeconds}s` };
    if (!ratio?.chip) ratio = { ok: true, chip: lastComposerSettings.ratio };
    return { ok: true, model: model.chip, duration: duration.chip, ratio: ratio.chip };
  }

  async function prepareCanvasTask(task) {
    pendingCanvasTask = null;
    composerBusy = true;
    runningCanvasTaskId = String(task.id || '');
    lastCanvasTask = task;
    $('#submitBrowserTask').disabled = true;
    showCanvasOrigin(task);
    readyBackfill = null;
    try {
    await window.desktop.reportBrowserTaskStatus({ jobId: task.id, nodeId: task.nodeId, state: 'preparing', message: '账号窗口已开始准备视频任务' });
    await refreshAccounts();
    if (!accounts.length) return window.desktop.reportBrowserTaskStatus({ jobId: task.id, nodeId: task.nodeId, state: 'needs_attention', message: '请先在独立浏览器中导入或添加豆包/Dola账号' });
    const requestedAccount = accounts.find(account => account.id === task.browserAccountId);
    const lockedProvider = ['dola', 'doubao'].includes(task.provider) ? task.provider : (requestedAccount?.provider || 'dola');
    const eligibleAccounts = accounts.filter(account => account.enabled !== false && account.provider === lockedProvider);
    if (!eligibleAccounts.length) return window.desktop.reportBrowserTaskStatus({ jobId: task.id, nodeId: task.nodeId, state: 'quota_exhausted', message: `当前没有可用的 ${lockedProvider === 'dola' ? 'Dola' : '豆包'} 账号，已阻止切换到其他平台`, provider: lockedProvider, accountId: task.browserAccountId || '' });
    const account = eligibleAccounts.find(item => item.id === task.browserAccountId) || eligibleAccounts.find(item => item.id === (lockedAccountId || activeId)) || eligibleAccounts[0];
    if (lockedAccountId && account.id !== lockedAccountId) {
      return window.desktop.reportBrowserTaskStatus({ jobId: task.id, nodeId: task.nodeId, state: 'failed', message: `本窗口已固定账号，不会切换到 ${account.name}`, provider: account.provider, accountId: lockedAccountId });
    }
    if (activeId !== account.id || !webviewIsLive(activeWebview)) openAccount(account.id);
    await window.desktop.reportBrowserTaskStatus({ jobId: task.id, nodeId: task.nodeId, state: 'preparing', message: `正在使用 ${account.name} 准备视频任务`, provider: account.provider, accountId: account.id });
    const view = await waitForWebview();
    const taskImages = Array.isArray(task.images) ? task.images.slice(0, 10) : [];
    let uploadManifest = [];
    setStatus(`正在确认 ${account.name} 已进入视频生成界面…`);
    let videoMode = null;
    try {
      if (typeof window.desktop.ensureVideoMode === 'function') {
        videoMode = await window.desktop.ensureVideoMode({ webContentsId: view.getWebContentsId(), timeoutMs: 45000 });
      }
    } catch (error) {
      if (!/No handler registered|ensureVideoMode is not a function/i.test(String(error.message || error))) {
        return window.desktop.reportBrowserTaskStatus({ jobId: task.id, nodeId: task.nodeId, state: 'failed', message: `进入视频模式失败：${error.message}`, provider: account.provider, accountId: account.id });
      }
    }
    if (!videoMode || videoMode.error) {
      videoMode = await view.executeJavaScript(`(async()=>{
        const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>2&&r.height>2&&s.visibility!=='hidden'&&s.display!=='none'};
        const clean=v=>String(v||'').replace(/\\s+/g,' ').trim();
        const modelVisible=()=>[...document.querySelectorAll('button,[role="button"]')].filter(visible).some(element=>/(?:^模型|seedance)/i.test(clean(element.innerText||element.textContent)) && clean(element.innerText||element.textContent).length<40);
        const findExact=t=>[...document.querySelectorAll('button,[role="button"],[role="tab"],[role="menuitem"]')].filter(visible).find(e=>{const r=e.getBoundingClientRect();const x=clean(e.innerText||e.textContent);return r.left>200&&r.width>=40&&r.width<=280&&x===t});
        for(let attempt=0;attempt<50&&!modelVisible();attempt++){
          const video=findExact('视频生成')||findExact('Create video')||findExact('Video');
          if(video){video.click();await pause(500);continue;}
          const more=findExact('更多');
          if(more){more.click();await pause(400);continue;}
          await pause(400);
        }
        return{ok:modelVisible()};
      })()`);
      if (!videoMode?.ok) return window.desktop.reportBrowserTaskStatus({ jobId: task.id, nodeId: task.nodeId, state: 'failed', message: videoMode?.error || '没有成功切换到豆包/Dola 视频生成模式', provider: account.provider, accountId: account.id });
    }
    const uploadBaseline = await view.executeJavaScript(`(() => {
      const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>2&&r.height>2&&s.visibility!=='hidden'&&s.display!=='none'};
      return [...document.querySelectorAll('img,[style*="background-image"]')].filter(visible).map(element=>{const r=element.getBoundingClientRect();const source=element.currentSrc||element.src||getComputedStyle(element).backgroundImage||'';return r.top>innerHeight*.22&&r.width>=24&&r.width<=240&&r.height>=24&&r.height<=240&&source&&!/avatar|logo|icon/i.test(source)?source:''}).filter(Boolean);
    })()`).catch(() => []);
    setStatus(`正在等待 ${account.name} 的视频界面完全加载…`);
    const uiReady = await window.desktop.waitComposerReady({ webContentsId: view.getWebContentsId(), expectedImages: 0, timeoutMs: 90000 });
    if (uiReady?.error) return window.desktop.reportBrowserTaskStatus({ jobId: task.id, nodeId: task.nodeId, state: 'failed', message: uiReady.error, provider: account.provider, accountId: account.id });
    const loginState = await view.executeJavaScript(`(() => {
      const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>2&&r.height>2&&s.visibility!=='hidden'&&s.display!=='none'};
      const clean=v=>String(v||'').replace(/\\s+/g,' ').trim();
      const text=clean(document.body?.innerText);
      const provider=${JSON.stringify(String(account.provider || ''))};
      const loginButton=[...document.querySelectorAll('button,a,[role="button"]')].filter(visible).some(element=>/^(登录|sign in|log in)$/i.test(clean(element.innerText||element.textContent||element.getAttribute('aria-label'))));
      return {needLogin:Boolean(document.querySelector('input[type="password"]')||loginButton||(provider!=='dola'&&/(登录|sign in|log in).{0,30}(账号|邮箱|email|google)/i.test(text.slice(0,12000))))};
    })()`);
    if (loginState?.needLogin) return window.desktop.reportBrowserTaskStatus({ jobId: task.id, nodeId: task.nodeId, state: 'needs_attention', message: `${account.name} 尚未登录，请在独立窗口完成登录后重新点击生成`, provider: account.provider, accountId: account.id });
    setStatus(`正在把提示词写入 ${account.name} 的输入框…`);
    let filled = { error: 'fillComposerPrompt 不可用' };
    try {
      if (typeof window.desktop.fillComposerPrompt === 'function') {
        filled = await window.desktop.fillComposerPrompt({ webContentsId: view.getWebContentsId(), prompt: String(task.prompt || '') });
      }
    } catch (error) {
      filled = { error: error.message };
    }
    if (filled?.error) {
      filled = await view.executeJavaScript(`(async()=>{
        const prompt=${JSON.stringify(String(task.prompt || ''))};
        const clean=v=>String(v||'').replace(/\\s+/g,' ').trim();
        const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>8&&r.height>8&&s.visibility!=='hidden'&&s.display!=='none'};
        const editors=[...document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"],.tiptap.ProseMirror')].filter(e=>{
          const r=e.getBoundingClientRect();const s=getComputedStyle(e);
          return s.display!=='none'&&(r.width>=24||r.height>=8);
        });
        const editor=editors.find(el=>/视频|描述|想要|提示|prompt|message/i.test(clean(el.getAttribute('placeholder')||el.getAttribute('data-placeholder')||el.getAttribute('aria-label')||el.querySelector?.('[data-placeholder]')?.getAttribute('data-placeholder'))))||editors.sort((a,b)=>b.getBoundingClientRect().top-a.getBoundingClientRect().top)[0];
        if(!editor)return{error:'没有找到提示词输入框'};
        let node=editor;
        for(let i=0;i<10&&node&&node!==document.body;i++){
          const cls=String(node.className||'');
          const s=getComputedStyle(node);
          if(/\\binvisible\\b/.test(cls)||s.visibility==='hidden'||s.pointerEvents==='none'){
            try{node.classList.remove('invisible')}catch{}
            node.style.visibility='visible';
            node.style.pointerEvents='auto';
            if(/\\babsolute\\b/.test(cls)){node.style.position='relative';node.style.inset='auto'}
          }
          node=node.parentElement;
        }
        editor.focus();
        if(editor instanceof HTMLTextAreaElement||editor instanceof HTMLInputElement){
          const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor),'value')?.set||Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
          setter.call(editor,prompt);
        }else{
          document.execCommand('selectAll',false,null);
          const ok=document.execCommand('insertText',false,prompt);
          if(!ok) editor.textContent=prompt;
        }
        editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:prompt.slice(0,24)}));
        await new Promise(resolve=>setTimeout(resolve,300));
        const written=clean('value'in editor?editor.value:editor.innerText||editor.textContent);
        return written.length>=Math.min(40,prompt.length)?{ok:true,len:written.length}:{error:'提示词写入后反读校验失败'};
      })()`);
    }
    if (filled?.error) return window.desktop.reportBrowserTaskStatus({ jobId: task.id, nodeId: task.nodeId, state: 'failed', message: filled.error, provider: account.provider, accountId: account.id });
    if (taskImages.length) {
      try {
        setStatus(`正在按任务框顺序批量上传参考图：上传后核对从左到右顺序，异常则停止…`);
        const upload = await window.desktop.uploadBrowserReferences({ accountId: account.id, jobId: task.id, images: taskImages, webContentsId: view.getWebContentsId() });
        if (!upload?.ok || upload.count !== taskImages.length || upload.verifiedCount !== taskImages.length) throw new Error(`画布连接 ${taskImages.length} 张，上传核验通过 ${upload?.verifiedCount || 0} 张`);
        uploadManifest = Array.isArray(upload.manifest) ? upload.manifest.map(item => ({ order: item.order, name: item.name, size: item.size, sha256: item.sha256 })) : [];
        if (uploadManifest.length !== taskImages.length || uploadManifest.some((item, index) => item.order !== index + 1)) throw new Error('参考图有序上传清单不完整');
        if ((upload.orderSignatures || []).length !== taskImages.length) throw new Error('参考图页面顺序核验未完成');
        setStatus(`文件已交给页面，正在对 ${taskImages.length} 张参考图连续自检两次…`);
        const imagesReady = await window.desktop.waitComposerReady({ webContentsId: view.getWebContentsId(), expectedImages: taskImages.length, timeoutMs: 120000 });
        if (imagesReady?.error) throw new Error(imagesReady.error);
        const firstCount = Number(imagesReady?.first?.count || 0);
        const secondCount = Number(imagesReady?.last?.count || 0);
        if (firstCount < taskImages.length || secondCount < taskImages.length) {
          throw new Error(`参考图需连续两次自检通过 ${taskImages.length} 张，实际 ${firstCount} / ${secondCount}`);
        }
        setStatus(`参考图已连续两次自检通过：${taskImages.length} 张`);
        const again = await window.desktop.fillComposerPrompt({ webContentsId: view.getWebContentsId(), prompt: String(task.prompt || '') });
        if (again?.error) throw new Error(again.error);
      } catch (error) {
        return window.desktop.reportBrowserTaskStatus({ jobId: task.id, nodeId: task.nodeId, state: 'failed', message: `参考图没有上传成功，本次未发送：${error.message}`, provider: account.provider, accountId: account.id });
      }
    }
    const synced = await applyComposerSettings({ model: task.model, duration: task.duration, ratio: task.ratio, provider: account.provider });
    if (synced?.error) return window.desktop.reportBrowserTaskStatus({ jobId: task.id, nodeId: task.nodeId, state: 'failed', message: `画布选项没有同步到页面：${synced.error}`, provider: account.provider, accountId: account.id });
    const promptReady = await window.desktop.fillComposerPrompt({ webContentsId: view.getWebContentsId(), prompt: String(task.prompt || '') });
    if (promptReady?.error) return window.desktop.reportBrowserTaskStatus({ jobId: task.id, nodeId: task.nodeId, state: 'failed', message: promptReady.error, provider: account.provider, accountId: account.id });
    setStatus(`已同步画布选项：${synced.model || task.model} · ${synced.duration || task.duration} · ${synced.ratio || task.ratio}`);
    const baselineSnap = await view.executeJavaScript(`(() => {
      const videos=[...document.querySelectorAll('video')].map(video=>video.currentSrc||video.src).filter(Boolean);
      const recipes=Array.isArray(window.__jxCleanVideos)?window.__jxCleanVideos.map(item=>String(item&&item.fallbackApi||'')).filter(Boolean):[];
      return {videos,recipes,cleanMedia:String(window.__jxCleanMediaUrl||'')};
    })()`);
    pendingCanvasTask = {
      task, account,
      baselineVideos: Array.isArray(baselineSnap?.videos) ? baselineSnap.videos : [],
      baselineRecipes: [...new Set([...(baselineSnap?.recipes || []), baselineSnap?.cleanMedia].filter(Boolean))],
      uploadBaseline: Array.isArray(uploadBaseline) ? uploadBaseline : [],
      uploadManifest, expectedImageCount: taskImages.length
    };
    $('#submitBrowserTask').disabled = false;
    setStatus(`画布任务 ${task.id} 已填入 ${account.name}；正在确认参考图上传完成后点击发送…`);
    await window.desktop.reportBrowserTaskStatus({ jobId: task.id, nodeId: task.nodeId, state: 'submitting', message: `已在 ${account.name} 填入提示词和设置，等待图片上传完成后发送`, provider: account.provider, accountId: account.id });
    try {
      await submitPendingCanvasTask();
    } catch (error) {
      $('#submitBrowserTask').disabled = false;
      const message=`自动提交失败：${error.message}`;
      setStatus(`${message}；可点击“确认并提交当前任务”重试`);
      window.desktop.reportBrowserTaskStatus({ jobId: task.id, nodeId: task.nodeId, state: 'needs_attention', message, provider: account.provider, accountId: account.id });
    }
    return { ok: true, autoSubmitting: true };
    } finally {
      composerBusy = false;
      runningCanvasTaskId = pendingCanvasTask?.task?.id || '';
      pumpIncomingCanvasTasks();
    }
  }

  async function monitorCanvasTask(context) {
    clearInterval(resultMonitorTimer);
    const baseline = new Set(context.baselineVideos || []);
    const baselineRecipes = new Set(context.baselineRecipes || []);
    const submittedAt = Number(context.submittedAt || Date.now());
    const baselineDoneAt = Number(context.baselineDoneAt ?? -1);
    let checks = 0;
    let savingVideo = false;
    resultMonitorTimer = setInterval(async () => {
      if (!activeWebview) return clearInterval(resultMonitorTimer);
      if (savingVideo) return;
      checks += 1;
      try {
        const state = await activeWebview.executeJavaScript(`(() => {
          const clean=value=>String(value||'').replace(/\\s+/g,' ').trim();
          const text=clean(document.body?.innerText||'');
          const lastIndex=pattern=>{let last=-1;const re=new RegExp(pattern,'gi');let match;while((match=re.exec(text)))last=match.index;return last};
          const doneAt=lastIndex('你的视频生成好了|视频(?:已经|已)?生成(?:完成|好了)|主动发送给你|your video is ready');
          const failAt=lastIndex('无法生成该视频|视频生成失败|本次.{0,24}生成失败|generation failed|could not generate');
          const done=doneAt>=0 && doneAt>=failAt;
          const failed=failAt>=0 && failAt>doneAt;
          const pending=/正在生成|生成中|排队中|任务处理中|预计等待|正在渲染|in queue|making your video/i.test(text);
          const videos=[...document.querySelectorAll('video')].map(video=>{let container=video,context='';for(let i=0;i<9&&container?.parentElement;i++){container=container.parentElement;context=clean(container.innerText||container.textContent);if(/你的视频生成好了|视频(?:已经|已)?生成(?:完成|好了)/.test(context))break}return{src:video.currentSrc||video.src||'',duration:Number(video.duration)||0,readyState:video.readyState,width:video.videoWidth||0,height:video.videoHeight||0,completedContext:/你的视频生成好了|视频(?:已经|已)?生成(?:完成|好了)/.test(context)}}).filter(item=>item.src);
          return {videos,failed,failureText:failed?text.slice(-500):'',completedText:done,pending,doneAt,recipes:Array.isArray(window.__jxCleanVideos)?window.__jxCleanVideos.slice(-8):[],cleanMedia:String(window.__jxCleanMediaUrl||'')};
        })()`);
        if (state.failed && !state.completedText) {
          clearInterval(resultMonitorTimer); pendingCanvasTask = null; $('#submitBrowserTask').disabled = true;
          pumpIncomingCanvasTasks();
          return window.desktop.reportBrowserTaskStatus({ jobId: context.task.id, nodeId: context.task.nodeId, state: 'failed', message: state.failureText || '页面提示视频生成失败', provider: context.account.provider, accountId: context.account.id });
        }
        const newerDone = Number(state.doneAt ?? -1) > baselineDoneAt;
        if (state.pending && !newerDone) {
          if (checks % 30 === 0) {
            window.desktop.reportBrowserTaskStatus({ jobId: context.task.id, nodeId: context.task.nodeId, state: 'generating', message: `${context.account.name} 仍在生成，正在等待本条任务的新成片`, provider: context.account.provider, accountId: context.account.id });
          }
          return;
        }
        const freshRecipes = (state.recipes || []).filter(item => {
          const api = String(item?.fallbackApi || '');
          const at = Number(item?.at || 0);
          return api && !baselineRecipes.has(api) && at >= submittedAt - 2000;
        });
        const created = state.videos?.find(video => video.src && !baseline.has(video.src) && !/^blob:/i.test(video.src) && video.readyState >= 2 && newerDone);
        const clean = await window.desktop.peekCleanVideoUrl?.({ webContentsId: activeWebview.getWebContentsId() });
        const cleanUrl = String(clean?.url || state.cleanMedia || '');
        const cleanFallback = String(clean?.fallbackApi || '');
        const staleClean = (cleanUrl && baseline.has(cleanUrl)) || (cleanFallback && baselineRecipes.has(cleanFallback));
        const freshMedia = Boolean(freshRecipes.length || created || (cleanUrl && !staleClean && newerDone));
        if (!freshMedia) {
          if (checks % 30 === 0) {
            window.desktop.reportBrowserTaskStatus({ jobId: context.task.id, nodeId: context.task.nodeId, state: 'generating', message: `${context.account.name} 仍在生成，已忽略上一条成片，等待本条新视频`, provider: context.account.provider, accountId: context.account.id });
          }
          return;
        }
        if (Date.now() - submittedAt < 4000) return;
        savingVideo = true;
        setStatus(`任务 ${context.task.id} 已检测到新视频，请在保存窗口中选择当前成片的保存位置…`);
        try {
          const saved = await window.desktop.downloadBrowserVideo({ accountId: context.account.id, jobId: context.task.id, webContentsId: activeWebview.getWebContentsId(), recipes: freshRecipes.length ? freshRecipes : (state.recipes || []).filter(item => item?.fallbackApi && !baselineRecipes.has(item.fallbackApi)) });
          clearInterval(resultMonitorTimer); $('#submitBrowserTask').disabled = true;
          pendingCanvasTask = null;
          setStatus(`视频已保存，等待手动回填到 ${canvasOriginLabel(context.task)}：${saved.file}`);
          showCanvasOrigin(context.task, 'ready');
          readyBackfill = { jobId: context.task.id, nodeId: context.task.nodeId, title: context.task.title, nodeTitle: context.task.title, url: saved.url, file: saved.file, provider: context.account.provider, accountId: context.account.id };
          pumpIncomingCanvasTasks();
          return window.desktop.reportBrowserTaskStatus({ jobId: context.task.id, nodeId: context.task.nodeId, nodeTitle: context.task.title, state: 'awaiting_backfill', message: `成片已保存，请回填到发出窗口：${canvasOriginLabel(context.task)}`, url: saved.url, file: saved.file, width: created?.width, height: created?.height, provider: context.account.provider, accountId: context.account.id });
        } catch (error) {
          savingVideo = false;
          if (/已取消保存/.test(String(error.message || ''))) {
            setStatus('已取消保存窗口。可稍后点右上角「回填到画布」再保存当前成片');
            pendingCanvasTask = context;
            $('#submitBrowserTask').disabled = true;
            return;
          }
          if (/无水印|预览片|上一条|等待本条/.test(String(error.message || ''))) {
            setStatus(`视频已生成，正在等待无水印原片：${error.message}`);
            return;
          }
          pendingCanvasTask = context; $('#submitBrowserTask').disabled = true;
          return window.desktop.reportBrowserTaskStatus({ jobId: context.task.id, nodeId: context.task.nodeId, state: 'needs_attention', message: `视频已经生成，但保存到无水印素材失败：${error.message}`, provider: context.account.provider, accountId: context.account.id });
        }
      } catch {}
    }, 2500);
  }

  async function clickDolaSendButton() {
    if (!activeWebview) return { error: '还没有打开账号页面' };
    const expectedImages = Number(pendingCanvasTask?.expectedImageCount || 0);
    setStatus(expectedImages ? `正在等待 ${expectedImages} 张参考图完全上传后再点击发送…` : '正在等待视频界面就绪后再点击发送…');
    return window.desktop.clickDolaSend({ webContentsId: activeWebview.getWebContentsId(), expectedImages, timeoutMs: 120000 });
  }

  async function submitPendingCanvasTask() {
    const context = pendingCanvasTask;
    if (!context || !activeWebview) return setStatus('当前没有已经准备好的画布任务');
    $('#submitBrowserTask').disabled = true;
    setStatus(`正在点击 ${context.account.name} 的蓝色发送按钮…`);
    const outcome = {};
    const clicked = await clickDolaSendButton();
    if (clicked?.error) outcome.error = clicked.error;
    else if (clicked?.state?.accepted) outcome.accepted = true;
    if (!outcome.error && !outcome.accepted) {
      for (let i = 0; i < 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const after = await activeWebview.executeJavaScript(`(() => {
          const clean = v => String(v||'').replace(/\\s+/g,' ').trim();
          const text = clean(document.body?.innerText).slice(-120000);
          const quota = /(?:视频|video).{0,28}(?:积分|额度|credits?|points?).{0,24}(?:不足|用完|用尽|耗尽|为\\s*0\\b)|今天的生成次数已经达到上限|(?:insufficient|no)\\s+(?:video\\s*)?(?:credits?|points?)/i.test(text);
          const blocked = /(肖像保护|未认证人脸|暂不支持用.{0,40}生成视频)/.test(text);
          const accepted = /(视频生成已提交|正在生成|生成中|排队中|预计等待|视频生成好后|submitted|generating|in queue|将消耗|生成视频：)/i.test(text);
          return { quota, blocked, accepted, snippet: text.slice(-240) };
        })()`, true);
        if (after?.quota) { outcome.quotaExhausted = true; break; }
        if (after?.blocked) { outcome.error = after.snippet || 'Dola 拒绝了本次视频生成'; break; }
        if (after?.accepted) { outcome.accepted = true; break; }
      }
      if (!outcome.accepted && !outcome.quotaExhausted && !outcome.error) outcome.uncertain = true;
    }
    if (outcome.quotaExhausted) {
      await window.desktop.updateBrowserAccountQuota(context.account.id, { quotaStatus: 'exhausted', quotaValue: 0, quotaText: '提交前后页面明确提示视频积分/额度不足' });
      await refreshAccounts();
      pendingCanvasTask = null;
      runningCanvasTaskId = '';
      pumpIncomingCanvasTasks();
      if ($('#browserAutoRotate').checked) {
        setStatus(`${context.account.name} 额度/免费次数不足，页面已拒绝本次任务，正在准备下一个账号`);
        return prepareCanvasTask({ ...context.task, provider: context.account.provider, browserAccountId: '' });
      }
      return window.desktop.reportBrowserTaskStatus({ jobId: context.task.id, nodeId: context.task.nodeId, state: 'quota_exhausted', message: `${context.account.name} 视频积分/额度不足`, provider: context.account.provider, accountId: context.account.id });
    }
    if (outcome.error || outcome.uncertain) {
      $('#submitBrowserTask').disabled = false;
      const message = outcome.error || '点击后没有识别到正式受理提示；为防止重复扣额度，不会再次点击';
      setStatus(message);
      return window.desktop.reportBrowserTaskStatus({ jobId: context.task.id, nodeId: context.task.nodeId, state: 'needs_attention', message, provider: context.account.provider, accountId: context.account.id });
    }
    setStatus(`任务 ${context.task.id} 已被页面受理，正在监听新视频…`);
    await window.desktop.reportBrowserTaskStatus({ jobId: context.task.id, nodeId: context.task.nodeId, state: 'generating', message: `${context.account.name} 已确认接收任务，正在生成视频`, provider: context.account.provider, accountId: context.account.id });
    if (pendingCanvasTask) pendingCanvasTask.submitted = true;
    try {
      const snap = await activeWebview.executeJavaScript(`(() => {
        const clean=v=>String(v||'').replace(/\\s+/g,' ').trim();
        const text=clean(document.body?.innerText||'');
        const lastIndex=pattern=>{let last=-1;const re=new RegExp(pattern,'gi');let match;while((match=re.exec(text)))last=match.index;return last};
        return {
          videos:[...document.querySelectorAll('video')].map(video=>video.currentSrc||video.src).filter(Boolean),
          recipes:Array.isArray(window.__jxCleanVideos)?window.__jxCleanVideos.map(item=>({fallbackApi:String(item&&item.fallbackApi||''),at:Number(item&&item.at)||0})).filter(item=>item.fallbackApi):[],
          cleanMedia:String(window.__jxCleanMediaUrl||''),
          doneAt:lastIndex('你的视频生成好了|视频(?:已经|已)?生成(?:完成|好了)|主动发送给你|your video is ready')
        };
      })()`);
      const current = pendingCanvasTask || context;
      current.submittedAt = Date.now();
      current.baselineVideos = [...new Set([...(current.baselineVideos || []), ...(snap?.videos || []), snap?.cleanMedia].filter(Boolean))];
      current.baselineRecipes = [...new Set([...(current.baselineRecipes || []), ...(snap?.recipes || []).map(item => item.fallbackApi)].filter(Boolean))];
      current.baselineDoneAt = Number.isFinite(Number(snap?.doneAt)) ? Number(snap.doneAt) : -1;
    } catch {}
    monitorCanvasTask(pendingCanvasTask || context);
    pumpIncomingCanvasTasks();
  }

  const warmupButton = $('#warmupBrowserWorkersBtn');
  if (warmupButton) warmupButton.onclick = async () => {
    warmupButton.disabled = true; warmupButton.textContent = '启动中…';
    try {
      const selected = accounts.filter(account => account.provider === 'dola' && account.enabled !== false && account.hasCredential).sort((a,b) => String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
      if (!selected.length) throw new Error('需要至少一个已保存登录资料的 Dola 账号');
      const result = await window.desktop.warmupBrowserWorkers({ provider: 'dola', accountIds: selected.map(account => account.id) });
      warmupButton.textContent = `已开${result.workers}个窗口`;
      setStatus(`已为 ${result.accounts} 个账号各打开一个任务栏浏览器，可在任务栏随时切换监控`);
    }
    catch (error) { warmupButton.textContent = '打开全部账号窗口'; setStatus(`打开监控窗口失败：${error.message}`); }
    finally { warmupButton.disabled = false; }
  };
  $('#closeBrowserAccounts')?.addEventListener('click', () => document.body.classList.contains('browserStandalone')
    ? window.desktop.closeBrowserWindow()
    : ($('#browserAccountsModal').classList.remove('show'), $('#browserAccountsModal').setAttribute('aria-hidden','true')));
  $('#minimizeBrowserWindow')?.addEventListener('click', () => window.desktop.minimizeBrowserWindow());
  $('#addBrowserAccount').onclick = addAccount;
  $('#pasteBrowserAccounts').onclick = () => pasteImportAccounts().catch(error => setStatus(`导入失败：${error.message}`));
  $('#importBrowserAccounts').onchange = event => { const file=event.target.files?.[0]; if(file)importAccounts(file).catch(error=>setStatus(`导入失败：${error.message}`)); event.target.value=''; };
  $('#fillBrowserCredential').onclick = () => fillCredential().catch(error => setStatus(`填充失败：${error.message}`));
  $('#checkBrowserQuota').onclick = () => inspectQuota(true).catch(error => setStatus(`额度检查失败：${error.message}`));
  $('#browserBack').onclick = () => activeWebview?.canGoBack() && activeWebview.goBack();
  $('#browserReload').onclick = () => activeWebview?.reload();
  $('#deleteCurrentBrowserAccount')?.addEventListener('click', () => {
    removeAccount(lockedAccountId || activeId).catch(error => setStatus(`删除失败：${error.message}`));
  });
  $('#submitBrowserTask').onclick = () => submitPendingCanvasTask().catch(error => { $('#submitBrowserTask').disabled = false; setStatus(`提交失败：${error.message}`); });
  $('#addToCanvasBtn')?.addEventListener('click', async () => {
    const button = $('#addToCanvasBtn');
    if (button) button.disabled = true;
    try {
      const pageReady = Boolean(readyBackfill?.url) || await pageHasCompletedVideo();
      if (!pageReady) {
        setStatus('当前页面还没有检测完成片（需要出现「你的视频生成好了」和视频）。不会回填，以免填错。');
        await refreshBackfillButton();
        return;
      }
      const candidate = await chooseBackfillCandidate();
      if (!candidate) {
        await refreshBackfillButton();
        return;
      }
      const jobId = String(candidate.jobId);
      const title = candidate.nodeTitle || candidate.title || '视频生成';
      const account = activeAccount();
      const task = { ...candidate, id: jobId, jobId, title, nodeTitle: title };
      setStatus(`正在保存当前成片，准备回填到 ${canvasOriginLabel(task)}…`);
      let ready = readyBackfill && String(readyBackfill.jobId) === jobId ? readyBackfill : null;
      if (!ready?.url) {
        if (!account || !activeWebview) throw new Error('账号页面还没有打开');
        const recipes = await activeWebview.executeJavaScript(`Array.isArray(window.__jxCleanVideos)?window.__jxCleanVideos.slice(-8):[]`).catch(() => []);
        const saved = await window.desktop.downloadBrowserVideo({
          accountId: account.id,
          jobId,
          webContentsId: activeWebview.getWebContentsId(),
          recipes,
          manual: true
        });
        ready = { jobId, nodeId: task.nodeId, title, nodeTitle: title, url: saved.url, file: saved.file, provider: account.provider, accountId: account.id };
        readyBackfill = ready;
        await window.desktop.reportBrowserTaskStatus({
          jobId, nodeId: task.nodeId, nodeTitle: title, state: 'awaiting_backfill',
          url: saved.url, file: saved.file, provider: account.provider, accountId: account.id
        });
      }
      if (String(ready.nodeId) !== String(task.nodeId)) throw new Error('保存结果的节点与核对本节点不一致，已取消回填');
      await window.desktop.commitCanvasBackfill({
        jobId: ready.jobId,
        nodeId: task.nodeId,
        accountId: account?.id || ready.accountId || '',
        overwrite: true
      });
      lastCanvasTask = task;
      showCanvasOrigin(ready, 'done');
      readyBackfill = null;
      lastCanvasTask = null;
      setStatus(`已回填到发出窗口：${canvasOriginLabel(ready)}`);
    } catch (error) {
      setStatus(`回填失败：${error.message}`);
      await refreshBackfillButton();
    } finally {
      if (button && button.textContent.indexOf('已回填') !== 0) button.disabled = false;
    }
  });
  const startBrowser = async () => {
    try {
      await refreshAccounts();
      if (launchParams.get('add') === '1') {
        addAccount();
      } else if (lockedAccountId) {
        if (activeId !== lockedAccountId || !webviewIsLive(activeWebview)) openAccount(lockedAccountId);
      } else if (accounts[0]) {
        openAccount(accounts[0].id);
      } else {
        setStatus('还没有内置浏览器账号，请先添加豆包或 Dola 账号');
        addAccount();
      }
      if (launchParams.get('fill') === '1') {
        await waitForWebview();
        await fillCredential();
      }
      if (typeof window.desktop.browserOriginTask === 'function') {
        const origin = await window.desktop.browserOriginTask().catch(() => null);
        if (origin?.id || origin?.jobId) {
          lastCanvasTask = { ...origin, id: origin.id || origin.jobId, title: origin.title || origin.nodeTitle };
          if (origin.url) readyBackfill = { ...lastCanvasTask, jobId: lastCanvasTask.id };
        }
      }
      await refreshBackfillButton();
    } catch (error) {
      setStatus(`打开内置浏览器账号失败：${error.message}`);
    }
  };
  if (launchParams.get('worker') === '1') {
    document.body.classList.add('browserWorker');
    startBrowser();
  } else if (document.body.classList.contains('browserStandalone')) {
    startBrowser();
  } else {
    refreshAccounts().catch(error => setStatus(`读取账号失败：${error.message}`));
  }
  window.desktop.onBrowserPromptAddAccount?.(() => {
    if (document.querySelector('.browserAccountEditor')) return;
    addAccount();
  });
  window.desktop.onBrowserCanvasTask?.(task => enqueueCanvasTask(task));
  window.desktop.onBrowserReadyBackfill?.(payload => {
    if (payload?.committed) {
      if (readyBackfill && String(readyBackfill.jobId) !== String(payload.jobId)) return;
      showCanvasOrigin(payload, 'done');
      readyBackfill = null;
      setStatus(`已回填到发出窗口：${canvasOriginLabel(payload)}`);
      return;
    }
    if (!payload?.jobId || !payload?.url) return;
    readyBackfill = { ...payload, id: payload.jobId, jobId: payload.jobId, title: payload.nodeTitle || payload.title };
    lastCanvasTask = lastCanvasTask || readyBackfill;
    showCanvasOrigin(readyBackfill, 'ready');
    setStatus(`成片已保存，请回填到发出窗口：${canvasOriginLabel(readyBackfill)}`);
  });
  setInterval(() => {
    pumpIncomingCanvasTasks();
    refreshBackfillButton().catch(() => {});
    if (!window.desktop.takeBrowserCanvasTask) return;
    window.desktop.takeBrowserCanvasTask().then(task => { if (task) enqueueCanvasTask(task); }).catch(() => {});
  }, 800);
  window.desktop.onBrowserSyncComposer?.(payload => {
    if (lockedAccountId) return;
    if (pendingCanvasTask || composerBusy) return;
    applyComposerSettings(payload).then(result => {
      if (result?.error) setStatus(`画布选项同步失败：${result.error}`);
      else setStatus(`已同步画布选项：${result.model || payload.model || ''} · ${result.duration || payload.duration || ''} · ${result.ratio || payload.ratio || ''}`);
    }).catch(error => setStatus(`画布选项同步失败：${error.message}`));
  });
  window.jxBrowser = { refreshAccounts, openAccount, prepareCanvasTask, enqueueCanvasTask, applyComposerSettings, clickDolaSendButton };
})();
