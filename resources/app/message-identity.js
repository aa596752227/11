// Read only the rendered message's own data. Never inspect global stores or invoke UI callbacks.
function readConversationMessages() {
  const clean=value=>String(value||'').replace(/\s+/g,' ').trim();
  const own=(object,key)=>object&&Object.getOwnPropertyDescriptor(object,key)?.value;
  const hash=value=>{let result=2166136261;for(const ch of value)result=Math.imul(result^ch.charCodeAt(0),16777619);return(result>>>0).toString(16)};
  const blocks=[...document.querySelectorAll('[data-testid="message-block-container"]')];
  const messages=[];
  let previousUserIndex=-1,previousUserText='';
  for(let index=0;index<blocks.length;index++){
    const block=blocks[index],user=block.querySelector('[data-testid="send_message"]');
    const source=user||block.querySelector('[data-testid="receive_message"]');
    if(!source)continue;
    const sender=user?'user':'assistant',text=clean(source.innerText||source.textContent);
    const ids=[source,block,...source.querySelectorAll('[data-message-id]')]
      .map(e=>e.getAttribute('data-message-id')).filter(Boolean);
    const uniqueIds=[...new Set(ids)];
    let messageId=uniqueIds.length===1?uniqueIds[0]:'',localMessageId='',replyId='',conversationId='',createdAt='';
    let fiber=own(source,Object.keys(source).find(k=>k.startsWith('__reactFiber$')));
    for(let depth=0;fiber&&depth<9;depth++,fiber=own(fiber,'return')){
      const host=own(fiber,'stateNode');if(host instanceof Element&&!block.contains(host))break;
      const props=own(fiber,'memoizedProps'),message=own(props,'message');
      if(!message)continue;
      const id=String(own(message,'message_id')||'');
      // The optimistic message can have its own local UUID before data-message-id
      // exists. Read only this block's nearest message, never an ancestor list.
      // Conflicting DOM IDs must not be replaced with a guessed component ID.
      if(uniqueIds.length>1||(messageId&&id!==messageId))continue;
      messageId=id||messageId;
      localMessageId=String(own(message,'local_message_id')||'');
      replyId=String(own(message,'reply_id')||'');
      conversationId=String(own(message,'conversation_id')||'');
      createdAt=String(own(message,'create_time')||'');
      break;
    }
    const legacySignature=[sender,index,hash(text),text.length].join('|');
    const signature=messageId?sender+'|id:'+messageId:localMessageId?sender+'|local:'+localMessageId:legacySignature;
    if(!text&&!messageId&&!localMessageId)continue;
    const item={sender,text,index,signature,legacySignature,messageId,localMessageId,replyId,conversationId,createdAt,
      previousUserIndex,previousUserText,contexts:[text,previousUserText].filter(Boolean)};
    messages.push(item);
    if(sender==='user'&&text){previousUserIndex=index;previousUserText=text;item.previousUserIndex=index;item.previousUserText=text;}
  }
  return {url:location.href,messages,messageSignatures:messages.map(m=>m.signature)};
}
const hasStableIdentity=message=>Boolean(message&&(message.messageId&&message.messageId!=='0'||message.localMessageId));
const sameMessage=(left,right)=>Boolean(left&&right&&(!left.conversationId||!right.conversationId||left.conversationId===right.conversationId)&&(
  (left.messageId&&left.messageId===right.messageId)||(left.localMessageId&&left.localMessageId===right.localMessageId)
  ||(!hasStableIdentity(left)&&!hasStableIdentity(right)&&left.signature&&left.signature===right.signature)));
// Native Doubao exposes doubao:// through /json/list but chrome:// in location.href.
// Only these internal aliases are equivalent; never equate a website or another host.
function nativeConversationKey(value){
  try{const u=new URL(value);return ['chrome:','doubao:'].includes(u.protocol)&&u.host==='doubao-chat'&&/^\/chat(?:\/[^/]+)?\/?$/.test(u.pathname)?u.host+u.pathname.replace(/\/$/,''):'';}catch{return '';}
}
function sameConversationUrl(a,b){return Boolean(a&&b&&(a===b||(nativeConversationKey(a)&&nativeConversationKey(a)===nativeConversationKey(b))));}
module.exports={readConversationMessagesScript:`(${readConversationMessages.toString()})()`,sameMessage,hasStableIdentity,nativeConversationKey,sameConversationUrl};
