/** 交互功能验证（开发用） */
const puppeteer = require('puppeteer-core');
const path = require('path');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.join(__dirname, '..', 'shots');

(async () => {
  const b = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-proxy-server', '--enable-unsafe-swiftshader',
           '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--hide-scrollbars'],
    defaultViewport: { width: 1600, height: 900 }
  });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

  await p.goto('http://127.0.0.1:7788/', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1200));

  // 1. 本地搜索
  console.log('① 本地搜索 "drift"');
  await p.type('#searchInput', 'drift');
  await new Promise(r => setTimeout(r, 1400));
  const res = await p.evaluate(() => ({
    tab: document.querySelector('.dtab.active')?.dataset.tab,
    rows: document.querySelectorAll('#drawerBody .trk').length,
    foot: document.querySelector('#drawerFoot')?.textContent
  }));
  console.log('   →', JSON.stringify(res));
  await p.screenshot({ path: path.join(OUT, '11-搜索结果.png') });

  // 2. 从搜索结果播放
  console.log('② 点击搜索结果播放');
  await p.click('#drawerBody .trk');
  await new Promise(r => setTimeout(r, 2500));
  const playing = await p.evaluate(() => ({
    title: document.querySelector('#trackTitle')?.textContent,
    paused: window.__aurora.audio.paused,
    t: +window.__aurora.audio.currentTime.toFixed(1)
  }));
  console.log('   →', JSON.stringify(playing));

  // 3. 切到网易云 tab 搜索（未配置，应给出友好提示）
  console.log('③ 网易云 tab 搜索（未配置）');
  await p.click('#btnDrawerClose');
  await new Promise(r => setTimeout(r, 400));
  await p.click('.source-tab[data-provider="netease"]');
  await p.click('#searchInput', { clickCount: 3 });
  await p.type('#searchInput', '周杰伦');
  await new Promise(r => setTimeout(r, 1600));
  const netTip = await p.evaluate(() => ({
    toast: [...document.querySelectorAll('.toast')].map(t => t.textContent),
    rows: document.querySelectorAll('#drawerBody .trk').length
  }));
  console.log('   →', JSON.stringify(netTip));
  await p.screenshot({ path: path.join(OUT, '12-网易云未配置.png') });

  // 4. 文件夹选择器
  console.log('④ 打开文件夹选择器');
  await p.click('#btnDrawerClose');
  await new Promise(r => setTimeout(r, 300));
  await p.click('#btnSettings');
  await new Promise(r => setTimeout(r, 500));
  await p.click('#btnAddDir');
  await new Promise(r => setTimeout(r, 1400));
  const fsState = await p.evaluate(() => ({
    path: document.querySelector('#fsPath')?.textContent,
    drives: [...document.querySelectorAll('#fsBody .fs-item')].slice(0, 6).map(e => e.textContent.trim())
  }));
  console.log('   →', JSON.stringify(fsState));
  await p.screenshot({ path: path.join(OUT, '13-文件夹选择.png') });

  // 5. 进入 D 盘
  console.log('⑤ 进入 D 盘');
  await p.evaluate(() => {
    const items = [...document.querySelectorAll('#fsBody .fs-item')];
    const d = items.find(e => e.textContent.includes('D:'));
    if (d) d.click();
  });
  await new Promise(r => setTimeout(r, 1500));
  const dState = await p.evaluate(() => ({
    path: document.querySelector('#fsPath')?.textContent,
    items: [...document.querySelectorAll('#fsBody .fs-item .n')].slice(0, 8).map(e => e.textContent)
  }));
  console.log('   →', JSON.stringify(dState));
  await p.screenshot({ path: path.join(OUT, '14-D盘.png') });

  // 6. 键盘快捷键
  console.log('⑥ 键盘：空格 / 方向键');
  await p.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 300));
  await p.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 300));
  const before = await p.evaluate(() => window.__aurora.audio.currentTime);
  await p.keyboard.press('Space');
  await new Promise(r => setTimeout(r, 500));
  const paused = await p.evaluate(() => window.__aurora.audio.paused);
  await p.keyboard.press('Space');
  await new Promise(r => setTimeout(r, 300));
  await p.keyboard.press('ArrowRight');
  await new Promise(r => setTimeout(r, 300));
  const after = await p.evaluate(() => window.__aurora.audio.currentTime);
  console.log(`   → 空格暂停=${paused}, 前后时间 ${before.toFixed(1)} → ${after.toFixed(1)}`);

  console.log('\n===== JS 错误 =====');
  const uniq = [...new Set(errs)].filter(e => !e.includes('ERR_ABORTED'));
  if (!uniq.length) console.log('（无）');
  else uniq.slice(0, 10).forEach(e => console.log(' ✗', e));

  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
