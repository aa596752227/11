const crypto = require('node:crypto');

const PROBE_KEY = '__META_CANVAS_PASTE_PROBE__';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = value => crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
const normalizeSemantic = value => String(value ?? '')
  .replace(/\r\n?/g, '\n')
  .replace(/\u00a0/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function summarizeEvidence(evidence, prompt) {
  const values = Array.isArray(evidence?.values) ? evidence.values.map(value => String(value ?? '')) : [];
  const authoritative = String(evidence?.value ?? values.sort((left, right) => right.length - left.length)[0] ?? '');
  return {
    found: evidence?.found === true,
    connected: evidence?.connected !== false,
    candidateCount: values.length,
    longestLength: authoritative.length,
    empty: normalizeSemantic(authoritative) === '',
    semanticMatch: normalizeSemantic(authoritative) === normalizeSemantic(prompt)
  };
}

function installExpression({ token, prompt, ttlMs }) {
  return `(() => {
    const key=${JSON.stringify(PROBE_KEY)};
    const token=${JSON.stringify(token)};
    const expected=${JSON.stringify(prompt)};
    const ttlMs=${Number(ttlMs)};
    const old=globalThis[key];
    try{old?.cleanup?.()}catch{}
    const visible=element=>{
      if(!(element instanceof Element)||!element.isConnected)return false;
      const style=getComputedStyle(element),rect=element.getBoundingClientRect();
      return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity||1)>0&&rect.width>8&&rect.height>8;
    };
    const editorFromNode=node=>{
      if(!(node instanceof Element))return null;
      if(node.matches('textarea,[contenteditable="true"],[role="textbox"]'))return node;
      return node.closest?.('textarea,[contenteditable="true"],[role="textbox"]')||null;
    };
    const describe=element=>element?{
      tag:String(element.tagName||'').toLowerCase(),
      role:String(element.getAttribute?.('role')||''),
      contenteditable:String(element.getAttribute?.('contenteditable')||''),
      proseMirror:/ProseMirror/i.test(String(element.className||'')),
      tiptap:/tiptap/i.test(String(element.className||''))
    }:null;
    const qualify=editor=>{
      if(!editor||!visible(editor))return{qualified:false,score:0,reasons:['not-visible']};
      const reasons=[];
      let score=0;
      const hint=String(editor.placeholder||editor.getAttribute?.('data-placeholder')||editor.getAttribute?.('aria-label')||editor.querySelector?.('[data-placeholder]')?.getAttribute('data-placeholder')||'');
      const className=String(editor.className||'');
      if(/ProseMirror/i.test(className)){score+=90;reasons.push('prosemirror')}
      if(/tiptap/i.test(className)){score+=90;reasons.push('tiptap')}
      if(editor.getAttribute?.('role')==='textbox'){score+=25;reasons.push('textbox-role')}
      if(/视频|描述|想要|提示词/.test(hint)){score+=70;reasons.push('video-hint')}
      if(/搜索|search/i.test(hint)){score-=180;reasons.push('search-excluded')}
      let ancestor=editor;
      for(let depth=0;ancestor&&ancestor!==document.body&&depth<14;depth++,ancestor=ancestor.parentElement){
        if(ancestor.matches?.('[role="dialog"]')&&/确认|验证码|登录/.test(String(ancestor.innerText||''))){score-=150;reasons.push('dialog-excluded')}
        if(ancestor.querySelector?.('[data-input-engine-actionbar-render-entry-key="creation-video-generation-params-panel"],[data-input-engine-actionbar-render-entry-key="video-generation-params-panel"]')){score+=180;reasons.push('video-params') ;break}
        const text=String(ancestor.innerText||ancestor.textContent||'').replace(/\\s+/g,' ').slice(-3000);
        if(/Seedance/.test(text)&&(/比例|16:9|9:16|1:1/.test(text))&&(/时长|\\d+秒|\\d+s/.test(text))){score+=130;reasons.push('video-controls');break}
      }
      return{qualified:score>=120,score,reasons};
    };
    const locate=()=>{
      const editors=[...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')]
        .filter(visible)
        .map((editor,index)=>({editor,index,...qualify(editor)}))
        .filter(item=>item.qualified)
        .sort((a,b)=>b.score-a.score||b.index-a.index);
      const best=editors[0]||null;
      const ambiguous=Boolean(best&&editors[1]&&editors[1].score===best.score);
      return{editor:ambiguous?null:best?.editor||null,count:editors.length,ambiguous,bestScore:best?.score||0,reasons:best?.reasons||[]};
    };
    const state={token,installedAt:Date.now(),expiresAt:Date.now()+ttlMs,installedUrl:location.href,event:null,initialEditor:null,focusedEditor:null,locate};
    const handler=event=>{
      if(Date.now()>state.expiresAt)return state.cleanup();
      const path=typeof event.composedPath==='function'?event.composedPath():[event.target];
      let editor=null;
      for(const node of path){editor=editorFromNode(node);if(editor)break}
      const qualification=qualify(editor);
      let active=document.activeElement;
      while(active?.shadowRoot?.activeElement)active=active.shadowRoot.activeElement;
      const activeMatches=Boolean(editor&&active&&(active===editor||editor.contains(active)||active.contains?.(editor)));
      let text='',textAvailable=false,readError='';
      try{
        const types=[...(event.clipboardData?.types||[])].map(String);
        text=event.clipboardData?.getData('text/plain');
        textAvailable=typeof text==='string'&&(types.includes('text/plain')||text.length>0);
      }catch(error){readError=String(error?.message||error)}
      const normalized=value=>String(value??'').replace(/\\r\\n?/g,'\\n').replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim();
      const normalizedLineEndings=value=>String(value??'').replace(/\\r\\n?/g,'\\n');
      state.event={
        received:true,
        at:Date.now(),
        isTrusted:event.isTrusted===true,
        targetQualified:qualification.qualified,
        targetScore:qualification.score,
        targetReasons:qualification.reasons,
        target:describe(editor),
        activeMatches,
        editorReplacedSinceInstall:Boolean(state.initialEditor&&editor&&state.initialEditor!==editor),
        editorReplacedBeforePaste:Boolean(state.focusedEditor&&editor&&state.focusedEditor!==editor),
        textAvailable,
        textLength:textAvailable?text.length:null,
        exact:textAvailable?text===expected:false,
        lineEndingMatch:textAvailable?normalizedLineEndings(text)===normalizedLineEndings(expected):false,
        semanticMatch:textAvailable?normalized(text)===normalized(expected):false,
        readError
      };
      state.cleanup();
    };
    state.cleanup=()=>{try{document.removeEventListener('paste',handler,true)}catch{}};
    document.addEventListener('paste',handler,true);
    globalThis[key]=state;
    const located=locate();
    state.initialEditor=located.editor;
    return{installed:true,token,url:location.href,candidateCount:located.count,ambiguous:located.ambiguous,bestScore:located.bestScore,reasons:located.reasons,iframeCount:document.querySelectorAll('iframe').length};
  })()`;
}

function focusExpression(token) {
  return `(() => {
    const state=globalThis[${JSON.stringify(PROBE_KEY)}];
    if(!state||state.token!==${JSON.stringify(token)})return{ok:false,reason:'probe-missing'};
    if(Date.now()>state.expiresAt)return{ok:false,reason:'probe-expired'};
    const located=state.locate();
    if(!located.editor)return{ok:false,reason:located.ambiguous?'editor-ambiguous':'editor-not-found',candidateCount:located.count,bestScore:located.bestScore,reasons:located.reasons};
    located.editor.focus({preventScroll:true});
    state.focusedEditor=located.editor;
    let active=document.activeElement;
    while(active?.shadowRoot?.activeElement)active=active.shadowRoot.activeElement;
    const focused=active===located.editor||located.editor.contains(active)||active?.contains?.(located.editor);
    return{ok:Boolean(focused),reason:focused?'focused':'focus-rejected',candidateCount:located.count,bestScore:located.bestScore,reasons:located.reasons};
  })()`;
}

function readExpression(token) {
  return `(() => {
    const state=globalThis[${JSON.stringify(PROBE_KEY)}];
    if(!state||state.token!==${JSON.stringify(token)})return{present:false,reason:'document-reloaded-or-probe-missing',url:location.href};
    return{present:true,expired:Date.now()>state.expiresAt,urlUnchanged:state.installedUrl===location.href,event:state.event};
  })()`;
}

function cleanupExpression(token) {
  return `(() => {
    const key=${JSON.stringify(PROBE_KEY)},state=globalThis[key];
    if(!state||state.token!==${JSON.stringify(token)})return false;
    try{state.cleanup?.()}catch{}
    delete globalThis[key];
    return true;
  })()`;
}

async function dispatchCtrlV(client) {
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 2,
    windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'v', code: 'KeyV', modifiers: 2,
    windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86
  });
}

async function runPasteProbe({ client, prompt, ttlMs = 4000, delayBeforePasteMs = 0, readPromptEvidence }) {
  const token = crypto.randomUUID();
  const report = {
    token,
    expectedLength: prompt.length,
    expectedSha256: sha256(prompt),
    installed: null,
    focus: null,
    paste: null,
    prePaste: null,
    domAuxiliary: null,
    safeToAutoSubmitByPasteEvidence: false,
    generated: false
  };
  try {
    report.installed = await client.evaluate(installExpression({ token, prompt, ttlMs }));
    if (delayBeforePasteMs > 0) {
      report.delayBeforePasteMs = Math.min(Number(delayBeforePasteMs) || 0, Math.max(0, ttlMs - 500));
      await wait(report.delayBeforePasteMs);
    }
    report.focus = await client.evaluate(focusExpression(token));
    if (!report.focus?.ok) return report;
    if (typeof readPromptEvidence === 'function') {
      try {
        report.prePaste = summarizeEvidence(await readPromptEvidence(client), prompt);
      } catch (error) {
        report.prePaste = { found: false, connected: false, error: String(error?.message || error) };
      }
      if (!report.prePaste.found || !report.prePaste.connected) {
        report.blockedReason = 'pre-paste-editor-unreadable';
        return report;
      }
      if (!report.prePaste.empty) {
        report.blockedReason = 'editor-not-empty';
        return report;
      }
    }
    await dispatchCtrlV(client);
    const deadline = Date.now() + Math.min(ttlMs, 2500);
    do {
      report.paste = await client.evaluate(readExpression(token));
      if (!report.paste?.present || report.paste.event) break;
      await wait(50);
    } while (Date.now() < deadline);

    if (typeof readPromptEvidence === 'function') {
      try {
        report.domAuxiliary = summarizeEvidence(await readPromptEvidence(client), prompt);
      } catch (error) {
        report.domAuxiliary = { found: false, error: String(error?.message || error) };
      }
    }
    const event = report.paste?.event;
    report.safeToAutoSubmitByPasteEvidence = Boolean(
      event?.received && event.isTrusted && event.targetQualified && event.activeMatches &&
      event.textAvailable && (event.exact || event.lineEndingMatch) && report.domAuxiliary?.semanticMatch === true
    );
    return report;
  } finally {
    try { await client.evaluate(cleanupExpression(token)); } catch {}
  }
}

module.exports = {
  PROBE_KEY,
  cleanupExpression,
  dispatchCtrlV,
  focusExpression,
  installExpression,
  normalizeSemantic,
  readExpression,
  runPasteProbe,
  summarizeEvidence,
  sha256
};
