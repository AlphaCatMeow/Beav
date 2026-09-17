// Injected into the page MAIN world; keep all helpers inside this function.
export async function extractDouyinVideoPayload() {
  function normalizeText(value) {
    return String(value || '').trim();
  }

  function normalizeTitle(value) {
    return normalizeText(value).replace(/\s*[-|_|]\s*抖音.*$/i, '').trim();
  }

  function toAbsoluteUrl(value) {
    const raw = normalizeText(value);
    if (!raw) return '';
    try {
      return new URL(raw, location.href).toString();
    } catch {
      return raw;
    }
  }

  function extractDouyinVideoIdFromUrl(value) {
    const raw = normalizeText(value);
    if (!raw) return '';
    try {
      const parsed = new URL(raw, location.href);
      for (const key of ['modal_id', 'aweme_id', 'awemeId', 'item_id', 'itemId', 'vid']) {
        const queryValue = normalizeText(parsed.searchParams.get(key));
        if (/^\d{8,}$/.test(queryValue)) return queryValue;
      }
      const pathMatch = String(parsed.pathname || '').match(/\/(?:video|note)\/(\d{8,})/i);
      if (pathMatch?.[1]) return pathMatch[1];
      const anyMatch = raw.match(/(?:modal_id|aweme_id|item_id|video_id|vid)[=:](\d{8,})/i);
      if (anyMatch?.[1]) return anyMatch[1];
    } catch {
      const fallbackMatch = raw.match(/\/(?:video|note)\/(\d{8,})/i)
        || raw.match(/(?:modal_id|aweme_id|item_id|video_id|vid)[=:](\d{8,})/i);
      if (fallbackMatch?.[1]) return fallbackMatch[1];
    }
    return '';
  }

  function createCanonicalDouyinVideoUrl(videoId) {
    const id = normalizeText(videoId);
    if (!id) return location.href;
    return `https://www.douyin.com/video/${encodeURIComponent(id)}`;
  }

  function pushUniqueUrl(list, value) {
    const url = toAbsoluteUrl(value);
    if (!url || list.includes(url)) return;
    list.push(url);
  }

  function parseCountText(value) {
    if (!value) return 0;
    const text = String(value).trim();
    const cleaned = text.replace(/[\s,]/g, '').replace(/[^0-9.\u4e00-\u9fa5]/g, '');
    if (!cleaned) return 0;
    if (cleaned.includes('亿')) {
      const num = parseFloat(cleaned.replace('亿', ''));
      return Number.isNaN(num) ? 0 : Math.round(num * 100000000);
    }
    if (cleaned.includes('万')) {
      const num = parseFloat(cleaned.replace('万', ''));
      return Number.isNaN(num) ? 0 : Math.round(num * 10000);
    }
    const num = parseFloat(cleaned);
    return Number.isNaN(num) ? 0 : Math.round(num);
  }

  function nodeVideoId(node) {
    return normalizeText(node?.getAttribute('data-e2e-vid')
      || node?.getAttribute('data-e2e-aweme-id')
      || node?.getAttribute('class')?.match(/(?:^|\s)video_(\d{8,})(?=\s|$)/)?.[1]);
  }

  function visibleArea(node) {
    if (!node || !(node instanceof Element)) return 0;
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) return 0;
    }
    const rect = node.getBoundingClientRect();
    const width = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
    const height = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
    return width > 40 && height > 40 ? width * height : 0;
  }

  function videoRoot(video) {
    // The work container owns selection; nested video-info IDs do not.
    return video.closest('[data-e2e="feed-active-video"], [data-e2e="feed-video"], .video-detail-container[data-e2e="player-container"]')
      || video.closest('[data-e2e-vid], [data-e2e-aweme-id]');
  }

  function getMainVideoElement(urlId) {
    const candidates = Array.from(document.querySelectorAll('video'))
      .map((video) => ({ video, root: videoRoot(video), area: visibleArea(video) }))
      .filter(({ root, area }) => area > 0
        && root?.getAttribute('data-e2e') !== 'feed-video'
        && (!urlId || !nodeVideoId(root) || nodeVideoId(root) === urlId));
    const priority = ({ root }) => Number(Boolean(urlId && nodeVideoId(root) === urlId)) * 4
      + Number(Boolean(root?.matches('.video-detail-container[data-e2e="player-container"]'))) * 2
      + Number(root?.getAttribute('data-e2e') === 'feed-active-video');
    const topPriority = Math.max(...candidates.map(priority));
    const selected = candidates.filter((candidate) => priority(candidate) === topPriority);
    // Two visible works during a feed transition are ambiguous. Never let a
    // larger preload or an old, still-connected player win by its dimensions.
    if (new Set(selected.map(({ root }) => root)).size !== 1) return null;
    if (selected.length === 1) return selected[0].video;
    const playing = selected.filter(({ video }) => !video.paused && !video.ended && video.readyState >= 2);
    return playing.length === 1 ? playing[0].video : null;
  }

  function awemeId(value) {
    const id = value?.aweme_id ?? value?.awemeId;
    // Douyin IDs exceed Number's safe integer range; never match rounded IDs.
    if (typeof id === 'number' && !Number.isSafeInteger(id)) return '';
    const text = normalizeText(id);
    return /^\d{8,}$/.test(text) ? text : '';
  }

  function findAweme(input, id, maxNodes = 3000) {
    const seen = new WeakSet();
    const queue = [{ value: input, depth: 0 }];
    for (let index = 0; index < queue.length && index < maxNodes; index += 1) {
      const { value, depth } = queue[index];
      if (!value || typeof value !== 'object' || seen.has(value) || value instanceof Element) continue;
      seen.add(value);
      const candidateId = awemeId(value);
      if (candidateId === id && value.video && getVideoUrls(value, null).length > 0) return value;
      if (candidateId && candidateId !== id) continue;
      if (depth >= 16) continue;
      for (const key of Object.keys(value)) {
        // Do not follow React's fiber/owner graph or invoke getters.
        if (key.startsWith('_') || ['return', 'alternate', 'stateNode', 'queue', 'baseQueue', 'deps'].includes(key)) continue;
        const child = Object.getOwnPropertyDescriptor(value, key)?.value;
        if (child && typeof child === 'object' && queue.length < maxNodes) {
          queue.push({ value: child, depth: depth + 1 });
        }
      }
    }
    return null;
  }

  function getCurrentAweme(video, root, id) {
    // Feed data is loaded after RENDER_DATA and may live in a hook/ref rather
    // than props. Read only this player's ancestry, always by exact work ID.
    const seenFibers = new Set();
    for (let node = video; node; node = node.parentElement) {
      const keys = Object.keys(node);
      const props = node[keys.find((key) => key.startsWith('__reactProps$'))];
      const fromProps = findAweme(props, id);
      if (fromProps) return { item: fromProps, source: 'player-props' };
      let fiber = node[keys.find((key) => key.startsWith('__reactFiber$'))];
      for (let depth = 0; fiber && depth < 24; depth += 1, fiber = fiber.return) {
        if (seenFibers.has(fiber)) break;
        seenFibers.add(fiber);
        const fromFiber = findAweme(fiber.memoizedProps, id);
        if (fromFiber) return { item: fromFiber, source: 'player-props' };
        const fromState = findAweme(fiber.memoizedState, id);
        if (fromState) return { item: fromState, source: 'player-state' };
      }
      if (node === root) break;
    }
    const scripts = new Set([
      document.getElementById('RENDER_DATA'),
      ...document.querySelectorAll('script[type="application/json"]'),
    ]);
    for (const script of scripts) {
      const text = script?.textContent || '';
      if (!text) continue;
      const candidates = [text];
      try { candidates.push(decodeURIComponent(text)); } catch { /* Plain JSON. */ }
      for (const candidate of candidates) {
        try {
          const item = findAweme(JSON.parse(candidate), id);
          if (item) return { item, source: 'render-data' };
        } catch { /* Unrelated script. */ }
      }
    }
    return { item: null, source: 'player-src' };
  }

  function addressUrls(value) {
    if (typeof value === 'string') return /^(https?:)?\/\//i.test(value) ? [toAbsoluteUrl(value)] : [];
    if (Array.isArray(value)) return value.flatMap(addressUrls);
    if (!value || typeof value !== 'object') return [];
    return addressUrls(value.url_list || value.urlList || value.src || value.url);
  }

  function isCompleteVideoUrl(value) {
    try {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol)) return false;
      // DASH video/audio tracks and playlists are not standalone videos.
      if (/media-(?:video|audio)|\/dash(?:\/|$)|\.(?:m3u8|mpd|m4s|m4a|mp3|jpe?g|png|webp)(?:$|\?)/i.test(url.pathname)) return false;
      if (/^audio/i.test(url.searchParams.get('mime_type') || '')) return false;
      return /\.mp4$/i.test(url.pathname)
        || /^video_mp4$/i.test(url.searchParams.get('mime_type') || '')
        || /(^|\.)douyinvod\.com$/i.test(url.hostname)
        || (/^www\.douyin\.com$/i.test(url.hostname) && /^\/aweme\/v1\/play\/?$/.test(url.pathname));
    } catch {
      return false;
    }
  }

  function getVideoUrls(item, video) {
    const data = item?.video || {};
    const urls = [];
    const add = (value) => addressUrls(value).filter(isCompleteVideoUrl).forEach((url) => pushUniqueUrl(urls, url));
    // Default play addresses carry complete audio + video; prefer H.264 for compatibility.
    add(data.playAddr || data.play_addr);
    const rawRates = data.bitRateList || data.bit_rate;
    const rates = (Array.isArray(rawRates) ? rawRates : []).filter((rate) => (
      rate && typeof rate === 'object'
      && !/dash|hls/i.test(String(rate.format || rate.videoFormat || rate.video_format || ''))
    )).sort((a, b) => Number(a.isH265 || a.is_h265 || 0) - Number(b.isH265 || b.is_h265 || 0)
      || Number(b.bitRate || b.bit_rate || 0) - Number(a.bitRate || a.bit_rate || 0));
    for (const rate of rates) add(rate.playAddr || rate.play_addr);
    add(data.playAddrH265 || data.play_addr_h265);
    add(data.playApi || data.play_api);
    for (const rate of rates) add(rate.playApi || rate.play_api);
    if (!item) {
      add(video.currentSrc || video.src);
      for (const source of video.querySelectorAll('source')) add(source.src);
    }
    return urls;
  }

  async function resolveVideoPlaybackUrl(candidates) {
    // Feed CDN URLs can reject downloads even with Referer. Resolve the work's
    // own play endpoint in its browser session to obtain a fresh signed URL.
    const playApis = candidates.filter((value) => {
      const url = new URL(value);
      return url.origin === location.origin && /^\/aweme\/v1\/play\/?$/.test(url.pathname);
    });
    const signal = AbortSignal.timeout(8_000);
    for (const playApi of playApis.slice(0, 2)) {
      let response;
      try {
        response = await fetch(playApi, {
          credentials: 'same-origin',
          headers: { Range: 'bytes=0-31' },
          cache: 'no-store',
          signal,
        });
        const resolved = response.url;
        if (response.ok && /^video\/mp4(?:;|$)/i.test(response.headers.get('content-type') || '')
          && isCompleteVideoUrl(resolved) && new URL(resolved).origin !== location.origin) {
          return resolved;
        }
      } catch { /* Keep the other complete sources available to Desktop. */ }
      finally {
        try { await response?.body?.cancel(); } catch { /* Already closed or aborted. */ }
      }
      if (signal.aborted) break;
    }
    return '';
  }

  function getTitle() {
    const candidates = [
      root.querySelector('[data-e2e="detail-video-info"] h1')?.textContent,
      root.querySelector('[data-e2e="video-desc"]')?.textContent,
      root.querySelector('[data-e2e="feed-active-video-desc"]')?.textContent,
      root.querySelector('[data-e2e="note-desc"]')?.textContent,
      root.querySelector('h1')?.textContent,
      root.querySelector('[class*="title"]')?.textContent,
      root.querySelector('[class*="desc"]')?.textContent,
    ];
    for (const candidate of candidates) {
      const normalized = normalizeTitle(candidate);
      if (normalized) return normalized;
    }
    return '';
  }

  function getAuthor() {
    const candidates = [
      root.querySelector('[data-e2e="user-info"] [data-click-from="title"]')?.textContent,
      root.querySelector('[data-e2e="user-info-name"]')?.textContent,
      root.querySelector('[data-e2e="video-author-name"]')?.textContent,
      root.querySelector('[data-e2e="video-author-nickname"]')?.textContent,
      root.querySelector('[data-e2e="feed-author-name"]')?.textContent,
      root.querySelector('[data-e2e="feed-video-nickname"]')?.textContent,
      root.querySelector('a[href*="/user/"] span')?.textContent,
      root.querySelector('meta[name="author"]')?.getAttribute('content'),
    ];
    for (const candidate of candidates) {
      const normalized = normalizeText(candidate).replace(/^@+/, '');
      if (normalized) return normalized;
    }
    return '';
  }

  function getAuthorProfileUrl() {
    const candidates = [
      root.querySelector('[data-e2e="user-info"] a[href*="/user/"]'),
      root.querySelector('a[href*="/user/"]'),
    ];
    for (const candidate of candidates) {
      const href = toAbsoluteUrl(candidate?.getAttribute?.('href') || '');
      if (href) return href;
    }
    return '';
  }

  function extractCountFromContainer(container) {
    if (!container) return 0;
    const candidates = [
      ...Array.from(container.querySelectorAll('span, div, p'))
        .map((node) => normalizeText(node.textContent || ''))
        .filter(Boolean),
      normalizeText(container.textContent || ''),
    ];
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (!/[0-9一二三四五六七八九十百千万亿]/.test(candidate)) continue;
      const parsed = parseCountText(candidate);
      if (parsed > 0) return parsed;
    }
    return 0;
  }

  function getPublishedAt() {
    const candidates = [
      root.querySelector('[data-e2e="detail-video-publish-time"]')?.textContent,
      root.querySelector('[class*="publish-time"]')?.textContent,
      root.querySelector('meta[property="article:published_time"]')?.getAttribute('content'),
    ];
    for (const candidate of candidates) {
      const normalized = normalizeText(candidate).replace(/^发布时间[:：]\s*/, '');
      if (normalized) return normalized;
    }
    return '';
  }

  function getStats() {
    const likeEl = root.querySelector('[data-e2e="video-player-digg"], [data-e2e="like-count"], [data-e2e*="like"]');
    const commentEl = root.querySelector('[data-e2e="feed-comment-icon"], [data-e2e*="comment"]');
    const collectEl = root.querySelector('[data-e2e="video-player-collect"], [data-e2e="collect-count"], [data-e2e*="collect"], [data-e2e*="favorite"]');
    const shareEl = root.querySelector('[data-e2e="video-player-share"], [data-e2e*="share"]');
    return {
      likes: extractCountFromContainer(likeEl),
      comments: extractCountFromContainer(commentEl),
      collects: extractCountFromContainer(collectEl),
      shares: extractCountFromContainer(shareEl),
    };
  }

  function getCommentsSnapshot(limit = 12) {
    const items = Array.from(root.querySelectorAll('[data-e2e="comment-item"]')).slice(0, limit);
    return items.map((item) => {
      const author = normalizeText(
        item.querySelector('.BT7MlqJC a, [data-click-from="title"]')?.textContent || '',
      );
      const text = normalizeText(
        item.querySelector('.C7LroK_h, .WFJiGxr7')?.textContent || '',
      );
      const meta = normalizeText(
        item.querySelector('.fJhvAqos')?.textContent || '',
      );
      const likes = parseCountText(
        item.querySelector('.xZhLomAs span:last-child')?.textContent || '',
      );
      const replies = parseCountText(
        item.querySelector('.comment-reply-expand-btn span')?.textContent || '',
      );
      const [createdAt = '', location = ''] = meta.split('·').map((value) => normalizeText(value));
      return {
        author,
        text,
        likes,
        replies,
        createdAt,
        location,
      };
    }).filter((item) => item.author || item.text);
  }

  function captureVideoCoverDataUrl(videoEl) {
    try {
      if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return '';
      const canvas = document.createElement('canvas');
      canvas.width = videoEl.videoWidth;
      canvas.height = videoEl.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return '';
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.92);
    } catch {
      return '';
    }
  }

  async function blobToDataUrl(blob) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Failed to read blob as data url'));
      reader.readAsDataURL(blob);
    });
  }

  async function fetchBinaryAsDataUrl(url, mimePrefix) {
    const target = String(url || '').trim();
    if (!target) return '';
    if (/^data:/i.test(target)) return target;
    if (!/^https?:\/\//i.test(target) && !/^blob:/i.test(target)) return '';
    try {
      const response = await fetch(target, {
        credentials: /^https?:\/\//i.test(target) ? 'omit' : 'same-origin',
        cache: 'force-cache',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return '';
      const blob = await response.blob();
      if (!blob || !blob.size || !blob.type.startsWith(mimePrefix)) return '';
      if (mimePrefix === 'video/' && blob.size > 32 * 1024 * 1024) return '';
      return await blobToDataUrl(blob);
    } catch {
      return '';
    }
  }

  const initialUrl = location.href;
  const currentUrlVideoId = extractDouyinVideoIdFromUrl(initialUrl);
  const videoEl = getMainVideoElement(currentUrlVideoId);
  if (!videoEl) throw new Error('未找到当前可见的抖音视频，请打开作品并播放后重试');
  const initialPlayerRoot = videoRoot(videoEl);
  const root = initialPlayerRoot || videoEl.closest('[data-e2e="feed-active-video"], [data-e2e="detail-video-info"]') || videoEl.parentElement;
  const initialSelection = root?.getAttribute('data-e2e') || '';
  const videoId = currentUrlVideoId || nodeVideoId(root);
  if (!/^\d{8,}$/.test(videoId)) throw new Error('未能确认当前抖音作品，请打开视频详情后重试');
  const initialPlayerSrc = videoEl.currentSrc || videoEl.src;
  const { item, source: dataSource } = getCurrentAweme(videoEl, root, videoId);
  const videoCandidates = getVideoUrls(item, videoEl);
  const resolvedVideoUrl = await resolveVideoPlaybackUrl(videoCandidates);
  if (resolvedVideoUrl) {
    const duplicateIndex = videoCandidates.indexOf(resolvedVideoUrl);
    if (duplicateIndex >= 0) videoCandidates.splice(duplicateIndex, 1);
    videoCandidates.unshift(resolvedVideoUrl);
  }
  const videoUrl = videoCandidates[0] || '';
  const blobVideoUrl = /^blob:/i.test(initialPlayerSrc) ? initialPlayerSrc : '';
  const videoDataUrl = !videoUrl && !item && blobVideoUrl
    ? await fetchBinaryAsDataUrl(blobVideoUrl, 'video/') : '';
  if (!videoUrl && !videoDataUrl) {
    throw new Error('未能取得当前作品的完整视频，请刷新抖音页面，播放后再保存');
  }
  const rawCoverUrl = addressUrls(item?.video?.cover || item?.video?.origin_cover || item?.video?.originCover)[0]
    || toAbsoluteUrl(videoEl.getAttribute('poster') || '');
  const coverDataUrl = rawCoverUrl
    ? await fetchBinaryAsDataUrl(rawCoverUrl, 'image/')
    : captureVideoCoverDataUrl(videoEl);
  // Extraction can await media reads while an SPA switches the selected work.
  if (location.href !== initialUrl || !videoEl.isConnected || getMainVideoElement(currentUrlVideoId) !== videoEl
    || videoRoot(videoEl) !== initialPlayerRoot || (root?.getAttribute('data-e2e') || '') !== initialSelection
    || (nodeVideoId(root) && nodeVideoId(root) !== videoId)
    || (videoEl.currentSrc || videoEl.src) !== initialPlayerSrc) {
    throw new Error('抖音已切换作品，请在当前视频停留后重新保存');
  }
  const sourceUrl = createCanonicalDouyinVideoUrl(videoId);
  const title = normalizeTitle(item?.desc || item?.item_title || item?.itemTitle) || getTitle();
  const description = normalizeText(item?.desc) || title;
  const authorInfo = item?.authorInfo || item?.author || {};
  const author = normalizeText(authorInfo.nickname) || getAuthor();
  const secUid = normalizeText(authorInfo.secUid || authorInfo.sec_uid);
  const createdAt = Number(item?.createTime || item?.create_time || 0);
  const publishedAt = createdAt > 0 && Number.isFinite(new Date(createdAt * 1000).getTime())
    ? new Date(createdAt * 1000).toISOString() : getPublishedAt();
  const commentsSnapshot = getCommentsSnapshot();
  const indexText = [
    title,
    description,
    author ? `作者：${author}` : '',
    publishedAt ? `发布时间：${publishedAt}` : '',
    commentsSnapshot.length > 0
      ? `评论快照：\n${commentsSnapshot.map((item, index) => {
          const meta = [
            item.author,
            item.location,
            item.createdAt,
            item.likes ? `赞${item.likes}` : '',
            item.replies ? `回复${item.replies}` : '',
          ].filter(Boolean).join(' · ');
          return `${index + 1}. ${meta}\n${item.text}`;
        }).join('\n\n')}`
      : '',
  ].filter(Boolean).join('\n\n');

  return {
    noteId: videoId,
    title,
    author,
    authorProfileUrl: secUid ? `https://www.douyin.com/user/${encodeURIComponent(secUid)}` : getAuthorProfileUrl(),
    content: description,
    text: description,
    description,
    publishedAt,
    coverUrl: rawCoverUrl || '',
    coverDataUrl,
    videoUrl,
    videoUrls: videoCandidates,
    videoDataUrl: videoDataUrl || '',
    stats: item?.statistics ? {
      likes: Number(item.statistics.digg_count || 0),
      comments: Number(item.statistics.comment_count || 0),
      collects: Number(item.statistics.collect_count || 0),
      shares: Number(item.statistics.share_count || 0),
    } : getStats(),
    captureDiagnostics: {
      urlVideoId: currentUrlVideoId,
      playerVideoId: nodeVideoId(root),
      playerSelection: initialSelection || 'detail',
      matchedVideoId: awemeId(item),
      dataSource,
      playerSourceType: blobVideoUrl ? 'blob' : 'http',
      candidateCount: videoCandidates.length,
      mediaHost: videoUrl ? new URL(videoUrl).hostname : '',
      resolvedPlayback: Boolean(resolvedVideoUrl),
      durationMs: Number(item?.video?.duration || videoEl.duration * 1000 || 0),
    },
    commentsSnapshot,
    indexText,
    source: sourceUrl,
  };
}
