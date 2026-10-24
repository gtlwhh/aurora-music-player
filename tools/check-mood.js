/** 功能2 验收：缓存落盘 / 曲线 / 耗时 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, '..', 'shots');
(async () => {
  const v = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  const b = await puppeteer.connect({ browserWSEndpoint: v.webSocketDebuggerUrl, defaultViewport: null });
  const p = (await b.pages()).find(x => x.url().includes('127.0.0.1'));
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

  // 清空缓存，确保是无缓存首次播放
  await p.evaluate(() => { window.__aurora.analysis._cache.clear(); });

  const t0 = Date.now();
  await p.evaluate(() => {
    const a = window.__aurora;
    a.playQueue(a.state.library.tracks, 0);
  });
  await new Promise(r => setTimeout(r, 5000));

  const st = await p.evaluate(() => {
    const a = window.__aurora;
    const c = a.moodbar.curve;
    return {
      title: a.state.current?.title,
      analyzing: a.analysis.isAnalyzing,
      hasCurve: !!(c && c.energy && c.energy.length),
      curveLen: c ? c.energy.length : 0,
      source: c ? (c.live ? 'live' : 'offline/cache') : 'none',
      segments: c ? (c.segments || []).length : 0,
      sampleRate: c ? c.sampleRate : 0,
      duration: c ? c.duration : 0,
      createdAt: c ? c.createdAt : 0
    };
  });
  console.log('① 5秒后状态:', JSON.stringify(st, null, 1));
  console.log('   耗时(截至采样):', Date.now() - t0, 'ms');

  // 再等 5 秒确认离线分析完成 + 落盘
  await new Promise(r => setTimeout(r, 5000));
  const st2 = await p.evaluate(() => {
    const c = window.__aurora.moodbar.curve;
    return {
      analyzing: window.__aurora.analysis.isAnalyzing,
      curveLen: c ? c.energy.length : 0,
      live: c ? c.live : null,
      energySample: c ? c.energy.slice(0, 6).map(v => +v.toFixed(3)) : null
    };
  });
  console.log('② 10秒后:', JSON.stringify(st2));

  // 检查磁盘缓存文件
  const cacheDir = path.join(__dirname, '..', 'data', 'cache', 'analysis');
  let files = [];
  if (fs.existsSync(cacheDir)) files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'));
  console.log('③ 缓存文件:', JSON.stringify(files));
  if (files.length) {
    const raw = JSON.parse(fs.readFileSync(path.join(cacheDir, files[0]), 'utf8'));
    console.log('   文件内容摘要:', JSON.stringify({
      trackId: raw.trackId,
      sampleRate: raw.sampleRate,
      energyLen: raw.energy.length,
      duration: raw.duration,
      segments: (raw.segments || []).length,
      createdAt: raw.createdAt,
      savedAt: raw.savedAt
    }));
  }

  // 截图
  await p.screenshot({ path: path.join(OUT, 'mood-01-播放中.png') });

  // 有缓存：切走再切回，检查是否命中内存/磁盘
  await p.evaluate(() => {
    const a = window.__aurora;
    a.playQueue(a.state.library.tracks, 1);
  });
  await new Promise(r => setTimeout(r, 3500));
  await p.evaluate(() => {
    const a = window.__aurora;
    a.playQueue(a.state.library.tracks, 0);
  });
  await new Promise(r => setTimeout(r, 1500));
  const st3 = await p.evaluate(() => {
    const a = window.__aurora;
    const c = a.moodbar.curve;
    return { hasCurve: !!(c && c.energy), len: c ? c.energy.length : 0, analyzing: a.analysis.isAnalyzing };
  });
  console.log('④ 切回第一首(命中缓存):', JSON.stringify(st3));

  console.log('\n错误:', errs.length ? [...new Set(errs)].slice(0, 5).join(' | ') : '（无）');
  b.disconnect();
})().catch(e => console.error('ERR', e.message));
