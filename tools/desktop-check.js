/**
 * 桌面版（Electron）自动化验收
 * 通过 CDP 连接到运行中的窗口，验证界面与扫码登录流程。
 */

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'shots');

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  // 找到 Electron 里的页面
  const res = await fetch('http://127.0.0.1:9222/json/list');
  const targets = await res.json();
  const page = targets.find(t => t.type === 'page' && t.url.includes('127.0.0.1'));
  if (!page) {
    console.log('未找到页面，targets:', targets.map(t => `${t.type} ${t.url}`).join(' | '));
    process.exit(1);
  }
  console.log('→ 连接页面:', page.url);

  const browser = await puppeteer.connect({
    browserWSEndpoint: (await (await fetch('http://127.0.0.1:9222/json/version')).json()).webSocketDebuggerUrl,
    defaultViewport: null
  });

  // Electron 不支持新建标签页，直接用已有页面
  const pages = await browser.pages();
  const p = pages.find(pg => pg.url().includes('127.0.0.1')) || pages[0];
  if (!p) { console.log('没有可用页面'); process.exit(1); }
  console.log('→ 使用页面:', p.url());
  await new Promise(r => setTimeout(r, 1200));

  // 1. 桌面环境识别
  const env = await p.evaluate(() => ({
    desktop: document.body.classList.contains('desktop'),
    hasApi: !!window.auroraDesktop,
    winControlsVisible: !document.getElementById('winControls').hidden,
    playIconState: document.querySelector('#btnPlay').classList.contains('playing') ? 'pause' : 'play'
  }));
  console.log('① 桌面环境:', JSON.stringify(env));

  await p.screenshot({ path: path.join(OUT, 'd01-初始.png') });

  // 2. 播放
  console.log('② 播放第一首');
  await p.click('#btnPlay');
  await new Promise(r => setTimeout(r, 3000));
  const playing = await p.evaluate(() => ({
    playing: document.getElementById('btnPlay').classList.contains('playing'),
    title: document.querySelector('#trackTitle').textContent,
    paused: window.__aurora.audio.paused,
    t: +window.__aurora.audio.currentTime.toFixed(1)
  }));
  console.log('   →', JSON.stringify(playing));
  await p.screenshot({ path: path.join(OUT, 'd02-播放中.png') });

  // 3. 打开设置
  console.log('③ 打开设置');
  await p.click('#btnSettings');
  await new Promise(r => setTimeout(r, 1200));
  const netInfo = await p.evaluate(() => ({
    status: document.querySelector('#netStatus').textContent,
    loginName: document.querySelector('#loginName').textContent,
    btn: document.querySelector('#btnNeteaseLogin').textContent
  }));
  console.log('   →', JSON.stringify(netInfo));
  await p.screenshot({ path: path.join(OUT, 'd03-设置.png') });

  // 4. 扫码登录
  console.log('④ 点击扫码登录');
  await p.click('#btnNeteaseLogin');
  await new Promise(r => setTimeout(r, 3500));
  const qr = await p.evaluate(() => ({
    visible: document.querySelector('#qrMask').classList.contains('show'),
    imgLoaded: (() => { const i = document.querySelector('#qrImg'); return i && i.src.startsWith('data:image') && i.complete; })(),
    status: document.querySelector('#qrStatus').textContent
  }));
  console.log('   →', JSON.stringify(qr));
  await p.screenshot({ path: path.join(OUT, 'd04-扫码登录.png') });

  // 5. 网易云搜索
  console.log('⑤ 关闭弹窗，切到网易云搜索');
  await p.click('#btnQrClose');
  await new Promise(r => setTimeout(r, 400));
  await p.click('#btnModalClose');
  await new Promise(r => setTimeout(r, 400));
  await p.click('.source-tab[data-provider="netease"]');
  await p.type('#searchInput', '晴天');
  await new Promise(r => setTimeout(r, 4000));
  const search = await p.evaluate(() => ({
    rows: document.querySelectorAll('#drawerBody .trk').length,
    foot: document.querySelector('#drawerFoot').textContent,
    first: document.querySelector('#drawerBody .trk .trk-title')?.textContent
  }));
  console.log('   →', JSON.stringify(search));
  await p.screenshot({ path: path.join(OUT, 'd05-网易云搜索.png') });

  console.log('\n完成。');
  // 不要关闭页面（Electron 只有一个窗口，关掉应用就退出了）
  browser.disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
