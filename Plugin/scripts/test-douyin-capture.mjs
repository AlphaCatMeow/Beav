import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { extractDouyinVideoPayload } from '../src/capture/douyinCapture.js';

const currentId = '7685374259320900905';
const otherId = '7685604693032144179';
const currentMedia = 'https://v26-web.douyinvod.com/current/video/full/?mime_type=video_mp4';
const otherMedia = 'https://v26-web.douyinvod.com/other/video/full/?mime_type=video_mp4';

function fixture({ url = `https://www.douyin.com/jingxuan?modal_id=${currentId}` } = {}) {
  const { window, document } = parseHTML(`<html><head><meta name="description" content="推荐页描述"></head><body>
    <div data-e2e="feed-video" data-e2e-vid="${otherId}"><video></video><span data-e2e="video-desc">广告</span></div>
    <div data-e2e="feed-active-video" data-e2e-vid="${currentId}"><video></video>
      <span data-e2e="video-desc">当前作品</span><span data-e2e="feed-video-nickname">@当前作者</span>
      <span data-e2e="video-player-digg">2313</span></div></body></html>`);
  window.innerWidth = 1600;
  window.innerHeight = 950;
  window.getComputedStyle = (node) => ({ display: node.style.display || 'block', visibility: 'visible', opacity: '1' });
  const [other, current] = document.querySelectorAll('video');
  other.getBoundingClientRect = () => ({ left: 0, top: 975, right: 1558, bottom: 1902, width: 1558, height: 927 });
  current.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1112, bottom: 927, width: 1112, height: 927 });
  other.currentSrc = 'blob:https://www.douyin.com/other';
  current.currentSrc = 'blob:https://www.douyin.com/current';
  const location = { href: url, origin: new URL(url).origin };
  const fetches = [];
  const context = vm.createContext({
    window, document, Element: window.Element, location, URL, AbortSignal,
    performance: { getEntriesByType: () => [{ name: otherMedia }, { name: 'https://www.douyin.com/aweme/v1/web/aweme/detail/' }] },
    fetch: async (url) => { fetches.push(url); return { ok: false }; },
  });
  const run = () => vm.runInContext(`(${extractDouyinVideoPayload.toString()})()`, context);
  function attach(item) {
    current.parentElement.__reactFiber$fixture = { return: { memoizedProps: { item } } };
  }
  return { document, current, other, location, context, fetches, run, attach };
}

function item(overrides = {}) {
  return { awemeId: currentId, desc: '预售衣衣的套路？', authorInfo: { nickname: '胖哥智保局', secUid: 'author-id' },
    video: { playAddr: [{ src: currentMedia }], duration: 75222 }, ...overrides };
}

test('modal capture binds the visible work and metadata, ignoring the larger offscreen ad and historical requests', async () => {
  const f = fixture();
  f.attach(item());
  f.other.parentElement.__reactProps$fixture = { item: item({ awemeId: otherId, video: { playAddr: [{ src: otherMedia }] } }) };
  const payload = await f.run();
  assert.equal(payload.noteId, currentId);
  assert.equal(payload.source, `https://www.douyin.com/video/${currentId}`);
  assert.equal(payload.videoUrl, currentMedia);
  assert.equal(payload.title, '预售衣衣的套路？');
  assert.equal(payload.author, '胖哥智保局');
  assert.equal(payload.content, payload.title);
  assert.equal(payload.stats.likes, 2313);
  assert.equal(payload.captureDiagnostics.matchedVideoId, currentId);
  assert.deepEqual(f.fetches, []);
});

test('feed URL without an ID uses the active player ID and ignores a hidden ancestor', async () => {
  const f = fixture({ url: 'https://www.douyin.com/' });
  f.other.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1558, bottom: 927 });
  f.other.parentElement.style.display = 'none';
  f.attach(item());
  assert.equal((await f.run()).noteId, currentId);
});

test('RENDER_DATA supports raw snake_case fields and exact ID matching after unrelated JSON scripts', async () => {
  const f = fixture({ url: `https://www.douyin.com/video/${currentId}` });
  f.document.head.innerHTML += '<script type="application/json">{"config":true}</script>';
  const script = f.document.createElement('script');
  script.id = 'RENDER_DATA';
  script.textContent = encodeURIComponent(JSON.stringify({ items: [
    { aweme_id: otherId, video: { play_addr: { url_list: [otherMedia] } } },
    { aweme_id: currentId, desc: '原始数据作品', author: { nickname: '原始作者' }, video: { play_addr: { url_list: [currentMedia] } } },
  ] }));
  f.document.head.append(script);
  const payload = await f.run();
  assert.equal(payload.videoUrl, currentMedia);
  assert.equal(payload.author, '原始作者');
  assert.equal(payload.captureDiagnostics.dataSource, 'render-data');
});

test('DASH tracks, audio, images, APIs and playlists cannot replace a complete MP4', async () => {
  const f = fixture();
  f.attach(item({ video: {
    playAddr: [{ src: 'https://v26-web.douyinvod.com/media-video-avc1/?mime_type=video_mp4' }],
    bitRateList: [
      { format: 'dash', bitRate: 9999999, playAddr: [{ src: otherMedia }] },
      { format: 'mp4', bitRate: 999999, playAddr: [
        { src: 'https://v26-web.douyinvod.com/cover.jpeg' },
        { src: 'https://www.douyin.com/aweme/v1/web/aweme/detail/' },
        { src: 'https://v26-web.douyinvod.com/audio.mp3' },
        { src: 'https://v26-web.douyinvod.com/video.m3u8' },
      ] },
      { format: 'mp4', isH265: 1, bitRate: 2000, playAddr: [{ src: otherMedia }] },
      { format: 'mp4', isH265: 0, bitRate: 1000, playAddr: [{ src: currentMedia }] },
    ],
  } }));
  assert.equal((await f.run()).videoUrl, currentMedia);
});

test('unmatched data plus an unreadable MediaSource blob fails instead of saving another work', async () => {
  const f = fixture();
  f.attach(item({ awemeId: otherId, video: { playAddr: [{ src: otherMedia }] } }));
  await assert.rejects(f.run(), /完整视频/);
  assert.deepEqual(f.fetches, ['blob:https://www.douyin.com/current']);
});

test('URL pointing to a different work cannot reuse a visible player', async () => {
  const f = fixture({ url: `https://www.douyin.com/video/${otherId}` });
  f.attach(item());
  await assert.rejects(f.run(), /当前可见/);
});

test('switching the SPA work during an awaited cover read aborts the save', async () => {
  const f = fixture();
  f.attach(item({ video: { playAddr: [{ src: currentMedia }], cover: 'https://example.com/cover.jpg' } }));
  f.context.fetch = async () => {
    f.current.parentElement.setAttribute('data-e2e-vid', otherId);
    return { ok: false };
  };
  await assert.rejects(f.run(), /切换作品/);
});

test('direct player MP4 fallback retains scoped text and never sends blob URLs to Desktop', async () => {
  const f = fixture();
  f.current.currentSrc = currentMedia;
  const payload = await f.run();
  assert.equal(payload.videoUrl, currentMedia);
  assert.equal(payload.title, '当前作品');
  assert.equal(payload.author, '当前作者');
  assert.equal(payload.videoDataUrl, '');
});

test('detail containers expose an exact work ID through their video class', async () => {
  const f = fixture({ url: 'https://www.douyin.com/' });
  f.current.parentElement.removeAttribute('data-e2e-vid');
  f.current.parentElement.setAttribute('data-e2e', 'player-container');
  f.current.parentElement.className = `video_${currentId} video-detail-container`;
  f.attach(item());
  const payload = await f.run();
  assert.equal(payload.noteId, currentId);
  assert.equal(payload.captureDiagnostics.playerVideoId, currentId);
  f.location.href = `https://www.douyin.com/video/${otherId}`;
  await assert.rejects(f.run(), /当前可见/);
});

const playApi = 'https://www.douyin.com/aweme/v1/play/?video_id=current';
const refreshedMedia = 'https://v11-web-prime.douyinvod.com/current/?mime_type=video_mp4&signature=fresh';

test('the browser resolves the work play API and releases the probe body, preserving all fallback sources', async () => {
  const f = fixture();
  f.attach(item({ video: { playAddr: [{ src: currentMedia }], playApi } }));
  let cancelled = false;
  f.context.fetch = async (url, options) => {
    assert.equal(url, playApi);
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers.Range, 'bytes=0-31');
    return { ok: true, url: refreshedMedia, headers: new Headers({ 'content-type': 'video/mp4' }),
      body: { cancel: async () => { cancelled = true; } } };
  };
  const payload = await f.run();
  assert.equal(payload.videoUrl, refreshedMedia);
  assert.deepEqual(Array.from(payload.videoUrls), [refreshedMedia, currentMedia, playApi]);
  assert.equal(payload.captureDiagnostics.resolvedPlayback, true);
  assert.equal(cancelled, true);
});

test('a rejected play API cannot discard complete CDN alternatives or promote an HTML response', async () => {
  const f = fixture();
  f.attach(item({ video: { playAddr: [{ src: currentMedia }, { src: otherMedia }], playApi } }));
  let cancelled = false;
  f.context.fetch = async () => ({ ok: true, url: refreshedMedia,
    headers: new Headers({ 'content-type': 'text/html' }), body: { cancel: async () => { cancelled = true; } } });
  const payload = await f.run();
  assert.equal(payload.videoUrl, currentMedia);
  assert.deepEqual(Array.from(payload.videoUrls), [currentMedia, otherMedia, playApi]);
  assert.equal(payload.captureDiagnostics.resolvedPlayback, false);
  assert.equal(cancelled, true);
});

test('resolution uses a complete bitrate play API after the default rejects, excluding DASH', async () => {
  const f = fixture();
  const fallbackApi = `${playApi}&quality=720p`;
  f.attach(item({ video: { playAddr: [{ src: currentMedia }], playApi, bitRateList: [
    { format: 'dash', playApi: `${playApi}&quality=dash` },
    { format: 'mp4', playApi: fallbackApi },
  ] } }));
  const calls = [];
  f.context.fetch = async (url) => {
    calls.push(url);
    return { ok: url === fallbackApi, url: refreshedMedia, headers: new Headers({ 'content-type': 'video/mp4' }),
      body: { cancel: async () => {} } };
  };
  const payload = await f.run();
  assert.deepEqual(calls, [playApi, fallbackApi]);
  assert.equal(payload.videoUrl, refreshedMedia);
  assert.equal(payload.videoUrls.some((url) => url.includes('quality=dash')), false);
});

test('switching the work during play API resolution aborts the capture', async () => {
  const f = fixture();
  f.attach(item({ video: { playAddr: [{ src: currentMedia }], playApi } }));
  f.context.fetch = async () => {
    f.current.parentElement.setAttribute('data-e2e-vid', otherId);
    return { ok: true, url: refreshedMedia, headers: new Headers({ 'content-type': 'video/mp4' }),
      body: { cancel: async () => {} } };
  };
  await assert.rejects(f.run(), /切换作品/);
});
