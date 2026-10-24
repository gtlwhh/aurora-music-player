/** QQ 播放链路 e2e：搜索→取链→状态机播放→歌词→封面 */
const puppeteer = require('puppeteer-core');
(async () => {
  const v = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  const b = await puppeteer.connect({ browserWSEndpoint: v.webSocketDebuggerUrl, defaultViewport: null });
  const p = (await b.pages()).find(x => x.url().includes('127.0.0.1'));
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));

  // ① QQ 搜索并播放第一首（晴天）
  const t0 = Date.now();
  const started = await p.evaluate(async () => {
    const a = window.__aurora;
    const r = await a.api.search('晴天 周杰伦', 'qq', 5);
    const t = (r.tracks || [])[0];
    if (!t) return { err: '搜索无结果' };
    a.playQueue([t], 0);
    return { trackId: a.analysis.constructor.stableId(t), title: t.title, artist: t.artist, gid: t.gid };
  });
  console.log('① 播放:', JSON.stringify(started), `(搜索+启动 ${Date.now() - t0}ms)`);
  if (started.err) { b.disconnect(); return; }

  // ② 等待音频真正出声
  let playing = null;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 700));
    playing = await p.evaluate(() => {
      const a = window.__aurora;
      return { playing: !a.audio.paused, t: +a.audio.currentTime.toFixed(1), src: (a.audio.el ? a.audio.el.src || '' : '').slice(0, 70) };
    });
    if (playing.playing && playing.t > 0.5) break;
  }
  console.log('② 出声状态:', JSON.stringify(playing));

  // ③ 歌词（composite → QQ getLyric）
  await new Promise(r => setTimeout(r, 1500));
  const lyric = await p.evaluate(() => ({
    lines: window.__aurora.state.lyrics.lines.length,
    source: window.__aurora.state.lyrics.source
  }));
  console.log('③ 歌词:', JSON.stringify(lyric));

  // ④ 情绪曲线 + 封面（QQ 新 trackId 应无缓存 → 实时兜底或离线分析）
  const mood = await p.evaluate(() => {
    const a = window.__aurora;
    const c = a.moodbar.curve;
    return { hasCurve: !!(c && c.energy), live: c ? !!c.live : null, coverUrl: (document.querySelector('#miniCover')?.style.backgroundImage || '').slice(0, 60) };
  });
  console.log('④ 情绪曲线/封面:', JSON.stringify(mood));

  // 截图
  await new Promise(r => setTimeout(r, 1500));
  await p.screenshot({ path: 'shots/qq-playing.png' });

  console.log('页面错误:', errs.length ? [...new Set(errs)].slice(0, 3).join(' | ') : '（无）');
  b.disconnect();
})().catch(e => console.error('ERR', e.message));
