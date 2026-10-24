/** 阶段1 端到端：旧缓存命中 + composite 播放链路 + 搜索回归 */
const puppeteer = require('puppeteer-core');
(async () => {
  const v = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  const b = await puppeteer.connect({ browserWSEndpoint: v.webSocketDebuggerUrl, defaultViewport: null });
  const p = (await b.pages()).find(x => x.url().includes('127.0.0.1'));
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));

  // ① 搜索回归（composite：GD 不可达 → 平台 API 回落）
  const search = await p.evaluate(async () => {
    const r = await window.__aurora.api.search('晴天', 'netease', 5);
    return { n: (r.tracks || []).length, first: r.tracks && r.tracks[0] ? `${r.tracks[0].title}/${r.tracks[0].artist}` : '-' };
  });
  console.log('① 网易云搜索:', JSON.stringify(search));

  // ② 旧缓存命中：播 netease--509781655（上轮功能2已分析的想你就写信）
  const hit = await p.evaluate(async () => {
    const a = window.__aurora;
    const r = await a.api.search('想你就写信', 'netease', 5);
    const t = (r.tracks || []).find(t => /live/i.test(t.title)) || (r.tracks || [])[0];
    if (!t) return { err: 'no track' };
    a.analysis._cache.clear();          // 清内存缓存，强制走磁盘命中
    a.playQueue([t], 0);
    const id = a.analysis.constructor.stableId(t);
    return { trackId: id, title: t.title };
  });
  await new Promise(r => setTimeout(r, 4000));
  const hit2 = await p.evaluate((id) => {
    const a = window.__aurora;
    const c = a.analysis.curveFor(id);
    return {
      curveLoaded: !!(c && c.energy && c.energy.length),
      source: c ? (c.live ? 'live重分析' : '磁盘缓存') : 'none',
      onsets: c ? (c.flux ? c.flux.length : 0) : 0,
      calib: c ? c.lyricCalib : null,
      autoApplied: a.state.autoCalib,
      playing: !a.audio.paused,
      t: +a.audio.currentTime.toFixed(1)
    };
  }, hit.trackId);
  console.log('② 曲目:', JSON.stringify(hit));
  console.log('   旧缓存命中:', JSON.stringify(hit2));

  // ③ 歌词（composite：平台 API 优先）与封面
  await new Promise(r => setTimeout(r, 1500));
  const lyric = await p.evaluate(() => ({
    lines: window.__aurora.state.lyrics.lines.length,
    source: window.__aurora.state.lyrics.source
  }));
  console.log('③ 歌词:', JSON.stringify(lyric));

  // ④ 动态电台接进前端队列（用动态会话取歌构造队列播放）
  const radio = await p.evaluate(async () => {
    const r = await fetch('/api/dynamic/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"platform":"local","type":"localRadio"}' }).then(x => x.json());
    const next = await fetch(`/api/dynamic/next?session=${r.sessionId}&n=2`).then(x => x.json());
    return { got: next.tracks.length, first: next.tracks[0] ? next.tracks[0].title : '-' };
  });
  console.log('④ 动态电台取歌:', JSON.stringify(radio));

  console.log('页面错误:', errs.length ? [...new Set(errs)].slice(0, 4).join(' | ') : '（无）');
  b.disconnect();
})().catch(e => console.error('ERR', e.message));
