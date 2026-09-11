// Read only the selected completed card's own playback props. Never click a card,
// invoke a component callback, scan global stores, or guess another task's URL.
function readCompletedVideoSource(item, expectedUrl) {
  if (!item?.coverSource || !expectedUrl || location.href !== expectedUrl) return null;
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const blocks = [...document.querySelectorAll('[data-testid="message-block-container"]')];
  const covers = [...document.querySelectorAll('[data-testid="receive_message"] img')]
    .filter(image => String(image.currentSrc || image.src) === item.coverSource);
  if (covers.length !== 1) return null;
  const cover = covers[0], block = cover.closest('[data-testid="message-block-container"]');
  if (!block || !/你的视频生成好了|视频已生成|视频生成完成|已经生成好了|视频已经准备好|可以下载视频|主动发送给你/.test(clean(block.textContent))) return null;
  const content = cover.closest('[data-message-id]');
  const messageId = content && block.contains(content) ? content.getAttribute('data-message-id') : '';
  if (!messageId || (item.messageId && item.messageId !== messageId)) return null;
  if (!item.messageId && Number.isInteger(item.messageIndex) && item.messageIndex !== blocks.indexOf(block)) return null;
  const data = (object, key) => object && Object.getOwnPropertyDescriptor(object, key)?.value;
  let fiber = data(cover, Object.keys(cover).find(key => key.startsWith('__reactFiber$')));
  const candidates = new Map();
  for (let depth = 0; fiber && depth < 10; depth++, fiber = data(fiber, 'return')) {
    const host = data(fiber, 'stateNode');
    if (host instanceof Element && !block.contains(host)) break;
    const props = data(fiber, 'memoizedProps'), video = data(props, 'video');
    if (!video) continue;
    if (data(video, 'messageId') !== messageId || data(video, 'isSuccess') !== true || data(video, 'isLoading') || data(video, 'isError')) return null;
    if (![data(video, 'thumbCoverUrl'), data(video, 'previewCoverUrl')].includes(item.coverSource)) return null;
    const raw = data(video, 'videoModel'), vid = data(video, 'vid');
    if (typeof raw !== 'string' || raw.length > 250000 || !vid) return null;
    let model; try { model = JSON.parse(raw); } catch { return null; }
    if (model.video_id !== vid || model.media_type !== 'video') return null;
    candidates.set(vid + '|' + raw, {model, vid});
  }
  if (candidates.size !== 1) return null;
  const {model, vid} = [...candidates.values()][0];
  const decode = (value, fallback = false) => {
    if (typeof value !== 'string' || value.length > 16000) return '';
    let url = value;
    if (!/^https?:\/\//i.test(url)) {
      // Ordinary base64 playback URLs only. Encrypted/unknown payloads are not guessed.
      if (!/^[A-Za-z0-9+/_=-]+$/.test(url)) return '';
      try { url = atob(url.replace(/-/g, '+').replace(/_/g, '/')); } catch { return ''; }
    }
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return '';
      if (!/(?:^|\.)(?:doubaocdn\.com|bytecdn\.cn|bytecdn\.com|byteimg\.com|ibytedtos\.com|ibyted-vod\.com|bytedance\.com|doubao\.com|douyin\.com|volcvod\.com|volccdn\.com|vcloud\.com|toutiaovod\.com)$/.test(parsed.hostname)
        && !(fallback&&/(?:^|\.)snssdk\.com$/.test(parsed.hostname))) return '';
      return url;
    } catch { return ''; }
  };
  const variants = Object.values(model.video_list || {}).filter(v => v && !v.encryption_method && (!v.vtype || v.vtype === 'mp4'))
    .map(v => ({source:decode(v.main_url), codec:v.codec_type || '', area:Number(v.vwidth || 0)*Number(v.vheight || 0)}))
    .filter(v => v.source)
    .sort((a,b) => b.area-a.area || Number(/h264|avc/i.test(b.codec))-Number(/h264|avc/i.test(a.codec)));
  const fallback=decode(model.fallback_api,true);
  const captureRecipe=fallback?{videoId:String(vid),messageId,conversationUrl:expectedUrl,fallbackUrl:fallback,keySeed:String(model.key_seed||'')}:null;
  if ((!variants.length&&!captureRecipe) || location.href !== expectedUrl) return null;
  return {source:variants[0]?.source||'', codec:variants[0]?.codec||'', captureRecipe, videoId:vid, messageId, conversationUrl:expectedUrl,
    messageIndex:blocks.indexOf(block), coverSource:item.coverSource};
}

module.exports = {readCompletedVideoSourceScript:(item,url)=>`(${readCompletedVideoSource.toString()})(${JSON.stringify(item)},${JSON.stringify(url)})`};
