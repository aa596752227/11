// Conservative recovery: a text response is never itself a generation receipt.
const CONFIRM_REPLY = '确认，按上述参数生成视频。';
// Temporary service feedback is not a terminal task rejection.
function transientVideoFeedback(text = '') {
  text = String(text);
  if (/审核未通过|未通过审核|侵权|违规|无法返回该内容|额度.{0,12}(?:用完|用尽|不足)|次数.{0,12}(?:用完|用尽)/.test(text)) return false;
  return /人数过多|人(?:数)?太多|使用人数较多|繁忙|拥挤|稍后(?:再试|重试)|暂时(?:无法|不能)|暂(?:无法|不能)|网络异常|请求超时|响应超时/.test(text);
}
const blocked = /付费|扣费|扣除|消耗|购买|订阅|充值|额度|积分|合规|版权|授权|使用权|侵权|违规|确认身份|删除|移除|重新上传|更换|改为|改成|修改|变更|重新登录|验证码|密码|无法|不能/;
function parameterConfirmation(text = '', job = {}) {
  text = String(text).replace(/\s+/g, ' ').trim();
  const detected = /确认.{0,15}(?:生成|制作)|(?:生成|制作).{0,15}确认/.test(text)
    && /视频|生成参数/.test(text);
  if (!detected) return { detected:false, safe:false };
  const ratios = [...text.matchAll(/\b(\d{1,2})\s*[:：]\s*(\d{1,2})\b/g)].map(m=>`${m[1]}:${m[2]}`);
  const durations = [...text.matchAll(/(?:时长\s*[:：]?\s*)(\d+(?:\.\d+)?)\s*(?:秒|s)/gi)].map(m=>Number(m[1]));
  const expectedSeconds = Number.parseFloat(job.duration);
  const models = [...text.matchAll(/Seedance\s*2\.0\s*(Fast|Mini)?/gi)].map(m=>m[0].replace(/\s+/g,' ').toLowerCase());
  const safe = !blocked.test(text) && ratios.length>0 && ratios.every(v=>v===job.ratio)
    && durations.length>0 && Number.isFinite(expectedSeconds) && durations.every(v=>v===expectedSeconds)
    && models.every(v=>v===String(job.model||'').toLowerCase());
  return { detected:true, safe, reason:safe?'':'参数不完整、不一致，或涉及费用/权利确认，需要人工处理' };
}
function isConfirmationReply(text = '') {
  return /^(?:确认[，,、\s]*)?(?:按上述参数生成视频|确认|生成视频|确认生成|确认生成视频|开始生成|直接生成|生成吧|可以生成|我已确认|确认并继续|同意并继续|继续生成|确认素材|确认素材合规)[。！!\s]*$/.test(String(text).trim());
}
function confirmationChain(context, state) {
  const invalid=reason=>({valid:false,reason,assistant:[],users:[]});
  if(!context?.root?.signature)return invalid('missing-root');
  const {sameMessage,hasStableIdentity,sameConversationUrl}=require('./message-identity');
  const messages=state?.messages||[];
  let roots=messages.filter(m=>m.sender==='user'&&sameMessage(context.root,m));
  // Legacy records without server IDs may be upgraded only when their text is unique.
  if(!roots.length&&!hasStableIdentity(context.root)){
    const compact=t=>String(t||'').replace(/\s+/g,'');
    let candidates=messages.filter(m=>m.sender==='user'&&compact(m.text)===compact(context.root.text));
    if(Array.isArray(context.previousMessages)){
      // A pre-click snapshot is an exclusion boundary, not an ordinal guess.
      candidates=candidates.filter(m=>!context.previousMessages.some(old=>sameMessage(old,m)));
      if(Array.isArray(context.nextSubmissionMessages))candidates=candidates.filter(m=>context.nextSubmissionMessages.some(next=>sameMessage(next,m)));
      if(candidates.length===1&&hasStableIdentity(candidates[0]))roots=candidates;
    }else if(candidates.length===1&&candidates[0].legacySignature===context.root.signature)roots=candidates;
  }
  if(roots.length>1)return invalid('ambiguous-root');
  const observedRoot=roots[0];
  if(!sameConversationUrl(state?.url,context.url)){
    try{
      const from=new URL(context.url),to=new URL(state.url);
      const actualId=observedRoot?.conversationId;
      const temporary=/^\/chat(?:\/(?:create-image|create-video|local_[A-Za-z0-9_-]+))?\/?$/.test(from.pathname);
      const target=/^\/chat\/([A-Za-z0-9_-]+)\/?$/.exec(to.pathname);
      if(from.protocol===to.protocol&&from.host===to.host&&temporary&&target&&observedRoot
        &&(!actualId||actualId===target[1]))context.url=state.url;
    }catch{}
  }
  if(!sameConversationUrl(state?.url,context.url))return invalid('different-conversation');
  if(!observedRoot&&!hasStableIdentity(context.root))return invalid('root-not-rendered');
  const root=observedRoot||context.root;
  if(observedRoot)context.root={...context.root,...observedRoot};
  const users=[root],assistant=[],ids=new Set([root.messageId,root.localMessageId,...(context.ownedMessageIds||[])].filter(Boolean));
  let interrupted=false;
  // A reply_id is authoritative even if a later task was submitted in between.
  // DOM order is only a conservative fallback for messages without reply metadata.
  for(const message of messages){
    if(sameMessage(message,root))continue;
    const explicit=Boolean(message.replyId&&message.replyId!=='0');
    const directlyOwned=explicit&&ids.has(message.replyId);
    const inSegment=Boolean(observedRoot&&message.index>root.index&&!interrupted);
    if(message.sender==='user'){
      if((directlyOwned||inSegment)&&isConfirmationReply(message.text)){
        users.push(message);if(message.messageId)ids.add(message.messageId);if(message.localMessageId)ids.add(message.localMessageId);
      }else if(inSegment)interrupted=true;
    }else if(message.sender==='assistant'&&(directlyOwned||(!explicit&&inSegment))){
      assistant.push(message);if(message.messageId)ids.add(message.messageId);if(message.localMessageId)ids.add(message.localMessageId);
    }
  }
  context.ownedMessageIds=[...ids].slice(-200);
  return {valid:true,root,users,assistant,interrupted,rootVisible:Boolean(observedRoot)};
}

// These scripts only operate in a composer with an empty editor and an exact send button.
function confirmationComposer() {
  const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'};
  const editors=[...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(visible);
  if(editors.length!==1)return null;
  const editor=editors[0];
  let root=editor.parentElement;
  for(let i=0;root&&root!==document.body&&i<10;i++,root=root.parentElement){
    const buttons=[...root.querySelectorAll('#flow-end-msg-send,[data-testid="chat_input_send_button"],button[class*="send-msg-btn"]')].filter(visible);
    if(buttons.length===1)return {editor,button:buttons[0]};
  }
  return null;
}
const composerScript = `(${confirmationComposer.toString()})()`;
const confirmationEditorScript = `(()=>{const c=${composerScript};return c&&!String(c.editor.value??c.editor.innerText??'').trim()?c.editor:null})()`;
const confirmationSendScript = `(()=>{const c=${composerScript};if(!c)return null;const b=c.button;
  if(b.disabled||b.getAttribute('aria-disabled')==='true'||/停止|stop/i.test((b.getAttribute('aria-label')||'')+' '+b.textContent))return null;
  const r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,top=document.elementFromPoint(x,y);
  if(!top||!(top===b||b.contains(top)))return null;
  return {x,y,value:String(c.editor.value??c.editor.innerText??'')};})()`;
module.exports={CONFIRM_REPLY,transientVideoFeedback,parameterConfirmation,isConfirmationReply,confirmationChain,confirmationEditorScript,confirmationSendScript};
