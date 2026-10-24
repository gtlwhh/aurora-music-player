/**
 * 真机外网联调检查：用浏览器跑移动端页面，直连已部署的 ECS 服务端
 * （不做 mock，验证 搜索 / 双平台徽章 / 账号状态 / 网络通道）
 *
 *   node tools/mobile-live-check.mjs [bffBase]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('D:/音乐开发/package.json');
const puppeteer = require('puppeteer-core');

const ROOT = 'D:/音乐开发/mobile/www';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const base = (process.argv[2] || '').trim();

const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => srv.listen(4331, '127.0.0.1', r));

const errors = [];
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  args: ['--no-proxy-server', '--enable-unsafe-swiftshader']
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
page.on('pageerror', e => errors.push(String(e)));

await page.goto('http://127.0.0.1:4331/index.html', { waitUntil: 'networkidle2' });
await new Promise(r => setTimeout(r, 800));

const out = {};
out.bffBaseInSettings = await page.$eval('#bffBase', el => el.value);

if (base) {
  await page.evaluate((b) => {
    const i = document.querySelector('#bffBase');
    i.value = b;
    i.dispatchEvent(new Event('change'));
  }, base);
  await new Promise(r => setTimeout(r, 2500));
}

// 账号状态（真实服务端）
out.acctNetease = await page.$eval('#stNetease', el => el.textContent);
out.acctQq = await page.$eval('#stQq', el => el.textContent);
await page.screenshot({ path: 'D:/音乐开发/shots/live-settings.png' });

// 搜索
await page.evaluate(() => document.querySelectorAll('#tabbar .tab').forEach(t => { if (t.dataset.page === 'search') t.click(); }));
await page.evaluate(() => {
  const i = document.querySelector('#searchInput');
  i.value = '夜曲';
  i.dispatchEvent(new Event('input'));
});
await page.evaluate(() => document.querySelector('#btnSearchReal').click());
await new Promise(r => setTimeout(r, 6000));
out.rows = await page.$$eval('.search-row', els => els.length);
out.badges = await page.$$eval('.src-badge', els => els.map(e => e.textContent));
out.first = await page.$$eval('.search-row', els => els.slice(0, 3).map(e => e.textContent.replace(/\s+/g, ' ').trim()));
out.coverLoaded = await page.$$eval('.sr-cover', els => els.filter(i => i.tagName === 'IMG' && i.complete && i.naturalWidth > 0).length);
await page.screenshot({ path: 'D:/音乐开发/shots/live-search.png' });

// 3D 开关（真实渲染）
await page.evaluate(() => document.querySelectorAll('#tabbar .tab').forEach(t => { if (t.dataset.page === 'settings') t.click(); }));
await page.evaluate(() => { const c = document.querySelector('#set3d'); c.checked = true; c.dispatchEvent(new Event('change')); });
await new Promise(r => setTimeout(r, 4000));
out.canvas3d = await page.evaluate(() => {
  const cv = document.querySelector('#c3d');
  return cv ? { w: cv.width, h: cv.height, cssW: cv.style.width } : null;
});
await page.evaluate(() => document.querySelectorAll('#tabbar .tab').forEach(t => { if (t.dataset.page === 'home') t.click(); }));
await new Promise(r => setTimeout(r, 800));
await page.screenshot({ path: 'D:/音乐开发/shots/live-home-3d.png' });

// 扫码面板 + 保存到相册按钮（单手机登录入口）
await page.evaluate(() => document.querySelectorAll('#tabbar .tab').forEach(t => { if (t.dataset.page === 'settings') t.click(); }));
await page.evaluate(() => document.querySelector('[data-login="qq"]').click());
await new Promise(r => setTimeout(r, 5000));
out.qrHasImg = await page.evaluate(() => {
  const im = document.querySelector('#qrImg');
  return !!(im && im.getAttribute('src'));
});
out.saveBtnText = await page.$eval('#btnQrSave', el => el.textContent.trim());
out.saveBtnVisible = await page.evaluate(() => {
  const b = document.querySelector('#btnQrSave');
  return !!(b && b.offsetParent !== null);
});
await page.evaluate(() => document.querySelector('#btnQrSave').click());
await new Promise(r => setTimeout(r, 1800));
out.qrTipAfterSave = await page.$eval('#qrTip', el => el.textContent);
out.toastAfterSave = await page.$$eval('.toast', els => els.map(e => e.textContent));
await page.evaluate(() => document.querySelector('#qrWrap').scrollIntoView({ block: 'center' }));
await new Promise(r => setTimeout(r, 400));
await page.screenshot({ path: 'D:/音乐开发/shots/live-qr.png' });
await page.evaluate(() => document.querySelector('#btnQrClose').click());

// 我的歌单页（心动 / 漫游 卡片 + 平台歌单）
await page.evaluate(() => document.querySelectorAll('#tabbar .tab').forEach(t => { if (t.dataset.page === 'playlists') t.click(); }));
await new Promise(r => setTimeout(r, 2500));
out.mixCards = await page.$$eval('.mix-card', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
out.remoteCount = await page.$$eval('#remotePl .pl-card', els => els.length);
await page.screenshot({ path: 'D:/音乐开发/shots/live-playlists.png' });
await page.evaluate(() => document.querySelector('#btnHeartMix').click());
await new Promise(r => setTimeout(r, 9000));
out.dynTitle = await page.$eval('#dynTitle', el => el.textContent);
out.dynRows = await page.$$eval('#dynList .search-row', els => els.length);
await page.screenshot({ path: 'D:/音乐开发/shots/live-dynamic.png' });

out.errors = errors;
await browser.close();
srv.close();
console.log(JSON.stringify(out, null, 2));
process.exit(errors.length ? 1 : 0);
