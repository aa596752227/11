// Fetch the recipe for ONE already verified completed video, without opening its player.
function fetchBoundRecipe(recipe) {
  return `(async()=>{
    const recipe=${JSON.stringify(recipe)};
    if(location.href!==recipe.conversationUrl)throw new Error('原任务对话已变化');
    const roots=[...document.querySelectorAll('[data-message-id]')].filter(e=>e.getAttribute('data-message-id')===recipe.messageId);
    if(roots.length!==1)throw new Error('原成品消息不再唯一可见');
    const url=new URL(recipe.fallbackUrl);
    if(url.protocol!=='https:'||url.username||url.password||!/(?:^|\\.)(?:snssdk\\.com|doubao\\.com|doubaocdn\\.com)$/.test(url.hostname))throw new Error('视频源接口校验未通过');
    url.searchParams.delete('force_fids');url.searchParams.delete('logo_type');url.searchParams.set('codec_type','0');
    const fetchOriginal=window.__dbnwHooks?.fetch||window.fetch;
    const response=await fetchOriginal(url.toString(),{signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw new Error('视频源接口 HTTP '+response.status);
    const data=await response.json(),info=data.video_info?.data||data;
    if(info.video_id&&String(info.video_id)!==recipe.videoId)throw new Error('视频源返回了不同的视频编号');
    const score=v=>(/h264|avc/i.test(String(v.codec_type))||v.codec_type===0?1000000000:0)+Number(v.bitrate||0);
    const choices=Object.values(info.video_list||{}).filter(v=>v?.main_url).sort((a,b)=>score(b)-score(a));
    if(!choices.length)throw new Error('原任务视频源尚未提供下载地址');
    if(location.href!==recipe.conversationUrl)throw new Error('下载源返回期间原对话已变化');
    return {mainUrl:choices[0].main_url,keySeed:recipe.keySeed||url.searchParams.get('key_seed')||'',videoId:recipe.videoId};
  })()`;
}
module.exports={fetchBoundRecipe};
