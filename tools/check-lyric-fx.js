/** 功能1 最终验收：逐字 + 景深 + 图标 + 旋转独立性 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, '..', 'shots');
(async () => {
  const v = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  const b = await puppeteer.connect({ browserWSEndpoint: v.webSocketDebuggerUrl, defaultViewport: null });
  const p = (await b.pages()).find(x => x.url().includes('127.0.0.1'));
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const c = await p.createCDPSession();
  await c.send('Network.clearBrowserCache');
  await p.reload({ waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 2000));

  const cur = await p.evaluate(() => !!window.__aurora.state.current);
  if (!cur) await p.click('#btnPlay');
  await new Promise(r => setTimeout(r, 4000));

  // 跳到含关键词的行
  const target = await p.evaluate(() => {
    const lines = window.__aurora.state.lyrics.lines;
    const words = ['雨','夜','星','海','风','梦','光','花','路','雪','月'];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].text || '';
      if (words.some(w => t.includes(w))) return { i, time: lines[i].time, text: t };
    }
    return null;
  });
  if (target) {
    await p.evaluate((t) => window.__aurora.audio.seek(t + 0.55), target.time);
  }
  await new Promise(r => setTimeout(r, 1600));
  await p.screenshot({ path: path.join(OUT, 'fx-01-关键词行.png') });

  // 采一帧逐字状态
  const charState = await p.evaluate(() => {
    const chs = [...document.querySelectorAll('#lyricInner .lyric-line.active .ch')];
    return {
      n: chs.length,
      moving: chs.filter(e => e.style.transform).length,
      sample: chs.slice(0, 5).map(e => e.style.transform || '-'),
      colors: chs.slice(0, 5).map(e => e.style.color || '-')
    };
  });
  console.log('逐字:', JSON.stringify(charState));

  // 旋转前记录歌词区几何
  const before = await p.evaluate(() => {
    const pane = document.querySelector('.lyric-pane').getBoundingClientRect();
    const active = document.querySelector('#lyricInner .lyric-line.active');
    const r = active.getBoundingClientRect();
    return { pane: { x: pane.x, y: pane.y, w: pane.width, h: pane.height },
             line: { x: r.x, y: r.y, w: r.width, h: r.height } };
  });

  // 拖动封面
  const box = await p.$eval('#coverCanvas', el => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await p.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
  await p.mouse.down();
  for (let i = 0; i < 12; i++) {
    await p.mouse.move(box.x + box.w / 2 + i * 8, box.y + box.h / 2 - i * 3);
    await new Promise(r => setTimeout(r, 16));
  }
  await p.mouse.up();
  await new Promise(r => setTimeout(r, 800));

  const after = await p.evaluate(() => {
    const pane = document.querySelector('.lyric-pane').getBoundingClientRect();
    const active = document.querySelector('#lyricInner .lyric-line.active');
    const r = active.getBoundingClientRect();
    return { pane: { x: pane.x, y: pane.y, w: pane.width, h: pane.height },
             line: { x: r.x, y: r.y, w: r.width, h: r.height },
             coverRot: window.__aurora.stage.rotation.y.toFixed(3) };
  });

  const paneStable = Math.abs(before.pane.x - after.pane.x) < 0.5 &&
                     Math.abs(before.pane.w - after.pane.w) < 0.5;
  const lineWidthStable = Math.abs(before.line.w - after.line.w) < 0.5;
  console.log('封面旋转角:', after.coverRot);
  console.log('歌词面板位置/宽度是否不变:', paneStable);
  console.log('当前行宽度是否不变:', lineWidthStable);
  console.log('旋转前后 line.x/y:', before.line.x.toFixed(1), before.line.y.toFixed(1),
              '→', after.line.x.toFixed(1), after.line.y.toFixed(1));

  await p.screenshot({ path: path.join(OUT, 'fx-02-旋转后.png') });
  b.disconnect();
})().catch(e => console.error('ERR', e.message));
