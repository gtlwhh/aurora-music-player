/**
 * 端到端检查脚本（开发用）
 * 用系统 Edge 打开播放器，自动播放、切歌、转动封面，抓取控制台错误并截图。
 *
 * 运行：node tools/e2e-check.js
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL = 'http://127.0.0.1:7788/';
const OUT = path.join(__dirname, '..', 'shots');

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: [
      '--no-proxy-server',
      '--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1600,900',
      '--hide-scrollbars',
      '--mute-audio'
    ],
    defaultViewport: { width: 1600, height: 900 }
  });

  const page = await browser.newPage();

  const errors = [];
  const logs = [];
  page.on('console', (msg) => {
    const t = msg.type();
    const text = msg.text();
    logs.push(`[${t}] ${text}`);
    if (t === 'error') errors.push(text);
  });
  page.on('pageerror', (err) => errors.push('PAGEERROR: ' + err.message));
  page.on('requestfailed', (req) => {
    errors.push(`REQFAIL: ${req.url()} — ${req.failure()?.errorText}`);
  });

  console.log('→ 打开页面');
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));

  await page.screenshot({ path: path.join(OUT, '01-初始.png') });

  // 检查曲库是否加载
  const libInfo = await page.evaluate(() => {
    return {
      tracks: window.__aurora?.state?.queue?.length ?? -1,
      title: document.querySelector('#trackTitle')?.textContent
    };
  });
  console.log('→ 曲库状态:', JSON.stringify(libInfo));

  // 点击播放按钮
  console.log('→ 点击播放');
  await page.click('#btnPlay');
  await new Promise(r => setTimeout(r, 2600));
  await page.screenshot({ path: path.join(OUT, '02-播放中.png') });

  // 检查音频状态
  const audioState = await page.evaluate(() => {
    const a = document.querySelector('audio') || window.__aurora?.audio?.audio;
    return a ? {
      paused: a.paused,
      currentTime: a.currentTime,
      duration: a.duration,
      readyState: a.readyState,
      src: (a.src || '').slice(0, 80)
    } : null;
  });
  console.log('→ 音频状态:', JSON.stringify(audioState));

  // 歌词状态
  const lyricState = await page.evaluate(() => {
    const lines = document.querySelectorAll('#lyricInner .lyric-line');
    const active = document.querySelector('.lyric-line.active');
    return {
      total: lines.length,
      active: active ? active.textContent.slice(0, 30) : null,
      source: document.querySelector('#lyricSource')?.textContent
    };
  });
  console.log('→ 歌词状态:', JSON.stringify(lyricState));

  // 切歌：抓拼图动画中间帧（此时还没拖动，封面是初始角度）
  console.log('→ 切歌（抓拼图动画）');
  await page.click('#btnNext');
  await new Promise(r => setTimeout(r, 240));
  await page.screenshot({ path: path.join(OUT, '03-拼图中间帧.png') });
  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: path.join(OUT, '04-拼图后段.png') });
  await new Promise(r => setTimeout(r, 2600));
  await page.screenshot({ path: path.join(OUT, '05-播放中2.png') });

  // 拖动封面
  console.log('→ 拖动封面');
  const box = await page.$eval('#coverCanvas', el => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
  await page.mouse.down();
  for (let i = 0; i < 14; i++) {
    await page.mouse.move(box.x + box.w / 2 + i * 9, box.y + box.h / 2 - i * 2);
    await new Promise(r => setTimeout(r, 16));
  }
  await page.mouse.up();
  await new Promise(r => setTimeout(r, 900));
  await page.screenshot({ path: path.join(OUT, '06-旋转后.png') });

  // 打开播放列表
  console.log('→ 打开播放列表');
  await page.click('#btnPlaylist');
  await new Promise(r => setTimeout(r, 800));
  await page.screenshot({ path: path.join(OUT, '07-播放列表.png') });
  await page.click('#btnDrawerClose');
  await new Promise(r => setTimeout(r, 600));

  // 打开设置
  console.log('→ 打开设置');
  await page.click('#btnSettings');
  await new Promise(r => setTimeout(r, 700));
  await page.screenshot({ path: path.join(OUT, '08-设置.png') });
  await page.click('#btnModalClose');

  // 关闭光效对比
  await new Promise(r => setTimeout(r, 500));
  await page.click('#btnGlow');
  await new Promise(r => setTimeout(r, 900));
  await page.screenshot({ path: path.join(OUT, '09-光效关闭.png') });

  // 窄屏
  await page.setViewport({ width: 900, height: 800 });
  await new Promise(r => setTimeout(r, 900));
  await page.screenshot({ path: path.join(OUT, '10-窄屏.png') });

  console.log('\n===== 控制台错误 =====');
  if (errors.length === 0) console.log('（无）');
  else errors.slice(0, 20).forEach(e => console.log('  ✗', e));

  console.log('\n===== 关键日志 =====');
  logs.filter(l => !l.includes('[log]')).slice(0, 15).forEach(l => console.log('  ', l));

  await browser.close();
})().catch(err => {
  console.error('测试脚本失败:', err);
  process.exit(1);
});
