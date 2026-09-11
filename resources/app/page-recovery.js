// Only temporary UI owned by this automation is cleaned up. Never close a chat.
function mediaPreviewTabs() {
  const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'};
  const candidates=[];
  const labels=[...document.querySelectorAll('[role="tab"],span,div,p,a')].filter(e=>visible(e)&&/^图片[与和]视频$/.test(e.textContent.trim())&&![...e.children].some(c=>/^图片[与和]视频$/.test(c.textContent.trim()))&&!e.closest('[data-testid="message-block-container"]'));
  for(const label of labels){
    let tab=label.parentElement;
    for(let level=0;tab&&tab!==document.body&&level<4;level++,tab=tab.parentElement){
      const r=tab.getBoundingClientRect();
      if(r.height>100||r.width>500||r.top>Math.min(250,innerHeight/3))break;
      if(tab.closest('[data-testid="message-block-container"]'))break;
      const buttons=[...tab.querySelectorAll('button,[role="button"],[data-testid*="close"],[class*="close"],[class*="Close"],[data-icon*="close"],[data-icon*="Close"]')].filter(visible).filter(e=>{
        const name=(e.getAttribute('aria-label')||e.title||e.textContent||'').trim();
        return /^(×|✕|关闭|关闭预览|关闭标签|关闭标签页|Close|Close tab)$/i.test(name)||/close/i.test(e.getAttribute('data-testid')||e.getAttribute('data-icon')||'')||(/close/i.test(String(e.getAttribute('class')||''))&&!name);
      }).map(e=>e.closest('button,[role="button"]')||e).filter((e,index,all)=>tab.contains(e)&&all.indexOf(e)===index&&!e.disabled&&e.getAttribute('aria-disabled')!=='true');
      if(buttons.length===1){candidates.push({tab,button:buttons[0]});break;}
    }
  }
  return candidates.filter((item,index)=>candidates.findIndex(other=>other.tab===item.tab)===index);
}

function recoverOwnedPreviews(findTabs, includeUntracked = false) {
  const visible=e=>e?.isConnected&&e.getBoundingClientRect().width>2&&e.getBoundingClientRect().height>2;
  const owned=window.__metaCanvasOwnedPreviews ||= new Set();
  let closed=0;
  const tabs=findTabs();
  const unrecognized=includeUntracked && [...document.querySelectorAll('span,div,[role="tab"],p,a')].some(e=>visible(e)&&!e.closest('[data-testid="message-block-container"]')&&/^图片[与和]视频$/.test(e.textContent.trim())&&e.getBoundingClientRect().top<Math.min(250,innerHeight/3)) && tabs.length!==1;
  for(const {tab,button} of tabs){
    if(!owned.has(tab)&&!(includeUntracked&&tabs.length===1))continue;
    owned.add(tab);
    const r=button.getBoundingClientRect(),top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
    if(top&&(top===button||button.contains(top))){button.click();closed++;}
  }
  for(const tab of owned)if(!visible(tab))owned.delete(tab);
  return {closed,remaining:owned.size,blocked:unrecognized};
}

function beginPreview(findTabs, recover) {
  window.__metaCanvasPreview?.finish?.();
  const baseline = new Map([...document.querySelectorAll('video')].map(video => [video, video.currentSrc || video.src]));
  const panels = new Set(document.querySelectorAll('[role="dialog"],[data-testid*="preview"],[class*="preview-panel"]'));
  const baselineTabs = new Set(findTabs().map(item=>item.tab));
  const ownedTabs = window.__metaCanvasOwnedPreviews ||= new Set();
  function trackTabs() { for(const {tab} of findTabs())if(!baselineTabs.has(tab))ownedTabs.add(tab); }
  const touched = new Map();
  const originalPlay = HTMLMediaElement.prototype.play;
  function mute(video) {
    if (video.tagName !== 'VIDEO' || (baseline.has(video) && baseline.get(video) === (video.currentSrc || video.src))) return;
    if (!touched.has(video)) touched.set(video, video.muted);
    video.muted = true;
  }
  function scan() { document.querySelectorAll('video').forEach(mute); trackTabs(); }
  function play(...args) { mute(this); return originalPlay.apply(this, args); }
  let scanFrame=0;
  const observer = new MutationObserver(()=>{
    document.querySelectorAll('video').forEach(mute);
    if(!scanFrame)scanFrame=requestAnimationFrame(()=>{scanFrame=0;trackTabs();});
  });
  observer.observe(document.documentElement, {childList:true,subtree:true,attributes:true,attributeFilter:['src']});
  HTMLMediaElement.prototype.play = play;
  const listener = event => mute(event.target);
  document.addEventListener('play', listener, true);
  let finished = false;
  const timer = setTimeout(() => finish(), 20000);
  function finish() {
    if (finished) return;
    finished = true;
    scan();
    clearTimeout(timer); observer.disconnect(); document.removeEventListener('play', listener, true);
    if(scanFrame)cancelAnimationFrame(scanFrame);
    if (HTMLMediaElement.prototype.play === play) HTMLMediaElement.prototype.play = originalPlay;
    for (const [video, wasMuted] of touched) {
      try { video.pause(); video.muted = wasMuted; } catch {}
      const panel = video.closest('[role="dialog"],[data-testid*="preview"],[class*="preview-panel"]');
      if (panel && !panels.has(panel)) {
        const buttons = [...panel.querySelectorAll('button,[role="button"]')].filter(button => /^(关闭|关闭预览|Close)$/i.test(button.getAttribute('aria-label') || button.title || button.textContent.trim()));
        if (buttons.length === 1) buttons[0].click();
      }
    }
    recover(findTabs);
    if (window.__metaCanvasPreview?.finish === finish) delete window.__metaCanvasPreview;
  }
  window.__metaCanvasPreview = {finish};
  return true;
}

function wrongToolCloseTarget() {
  const visible = element => !!element && element.getBoundingClientRect().width > 2 && element.getBoundingClientRect().height > 2;
  const editor = [...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(visible).find(element => /输入题目|题目图片/.test(element.placeholder || element.getAttribute('data-placeholder') || element.querySelector('[data-placeholder]')?.getAttribute('data-placeholder') || ''));
  if (!editor) return null;
  let scope = editor.parentElement;
  for (let depth = 0; scope && scope !== document.body && depth < 7; depth++, scope = scope.parentElement) {
    if (scope.querySelector('[data-testid="receive_message"],[data-testid="send_message"]')) break;
    const tool = [...scope.querySelectorAll('span,button,div')].find(element => visible(element) && /^(解题答疑|问题解答)$/.test(element.textContent.trim()) && !element.querySelector('span,button,div'));
    if (!tool) continue;
    let chip = tool.parentElement;
    for (let level = 0; chip && chip !== scope.parentElement && level < 3; level++, chip = chip.parentElement) {
      const close = [...chip.querySelectorAll('button,[role="button"]')].filter(visible).filter(element => /^(关闭|取消|移除|关闭工具|取消选择|Close)$/i.test(element.getAttribute('aria-label') || element.title || element.textContent.trim()));
      if (close.length === 1) { const r = close[0].getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; }
    }
  }
  return {blocked:true};
}

function mediaPreviewHoverTarget(){
  const labels=[...document.querySelectorAll('span,div,p,a,[role="tab"]')].filter(e=>{
    const r=e.getBoundingClientRect();
    return /^图片[与和]视频$/.test(e.textContent.trim())&&!e.closest('[data-testid="message-block-container"]')
      &&![...e.children].some(c=>/^图片[与和]视频$/.test(c.textContent.trim()))
      &&r.width>2&&r.height>2&&r.top>=0&&r.top<Math.min(250,innerHeight/3);
  });
  if(labels.length!==1)return null;
  const r=labels[0].getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};
}

module.exports = {
  beginPreviewScript: `(${beginPreview.toString()})(${mediaPreviewTabs.toString()},${recoverOwnedPreviews.toString()})`,
  recoverPreviewScript: `(${recoverOwnedPreviews.toString()})(${mediaPreviewTabs.toString()})`,
  prepareComposerScript: `(${recoverOwnedPreviews.toString()})(${mediaPreviewTabs.toString()},true)`,
  previewHoverScript: `(${mediaPreviewHoverTarget.toString()})()`,
  endPreviewScript: 'window.__metaCanvasPreview?.finish?.(); true',
  wrongToolCloseScript: `(${wrongToolCloseTarget.toString()})()`
};
