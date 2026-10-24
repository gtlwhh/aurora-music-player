/**
 * 移动端 UI 冒烟测试：
 *  1. 本地静态服务托管 mobile/www
 *  2. 本地 mock 服务模拟 ECS Node 服务的接口形状
 *  3. Edge 无头打开页面 → 填服务端地址 → 网易云/QQ 扫码登录 → 搜索 → 断言结果
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('D:/音乐开发/package.json');
const puppeteer = require('puppeteer-core');

const ROOT = 'D:/音乐开发/mobile/www';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const staticSrv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const QR_SVG = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#fff"/><rect x="20" y="20" width="60" height="60" fill="#000"/></svg>').toString('base64')}`;

const pollCount = { netease: 0, qq: 0 };
const calls = [];

function json(res, data, code = 200) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(data));
}

const mockSrv = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    return res.end();
  }
  const u = new URL(req.url, 'http://x');
  calls.push(u.pathname + u.search);

  if (u.pathname === '/api/health') return json(res, { ok: true, name: 'mock-bff' });

  if (u.pathname === '/api/search') {
    const provider = u.searchParams.get('provider');
    const q = u.searchParams.get('q') || '';
    const tracks = provider === 'qq'
      ? [{ provider: 'qq', gid: 'QQ1', title: q + ' QQ 结果', artist: 'QQ歌手', album: 'QQ专辑', picUrl: '' }]
      : [{ provider: 'netease', nid: 'NE1', title: q + ' 网易结果', artist: '云歌手', album: '云专辑', picUrl: '' }];
    return json(res, { provider, total: tracks.length, tracks });
  }

  if (/^\/api\/account\/(netease|qq)\/status$/.test(u.pathname)) {
    return json(res, { platform: u.pathname.split('/')[3], loggedIn: false, user: null });
  }

  const qr = u.pathname.match(/^\/api\/account\/(netease|qq)\/login\/qr$/);
  if (qr) return json(res, { key: 'key-' + qr[1], qrimg: QR_SVG });

  const chk = u.pathname.match(/^\/api\/account\/(netease|qq)\/login\/check$/);
  if (chk) {
    const pf = chk[1];
    pollCount[pf]++;
    if (pollCount[pf] === 1) return json(res, { code: 801, message: '等待扫码' });
    return json(res, { code: 803, ok: true, user: { nickname: pf === 'qq' ? 'QQ测试号' : '云村测试号' } });
  }

  if (/^\/api\/account\/(netease|qq)\/logout$/.test(u.pathname)) return json(res, { ok: true });

  return json(res, { error: 'not found: ' + u.pathname }, 404);
});

const wait = (ms) => new Promise(r => setTimeout(r, ms));

await new Promise(r => staticSrv.listen(4321, '127.0.0.1', r));
await new Promise(r => mockSrv.listen(4399, '127.0.0.1', r));

const logs = [];
const errors = [];
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  args: ['--no-proxy-server', '--enable-unsafe-swiftshader', '--disable-features=IsolateOrigins,site-per-process']
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
page.on('console', m => logs.push(m.type() + ': ' + m.text()));
page.on('pageerror', e => errors.push(String(e)));

await page.goto('http://127.0.0.1:4321/index.html', { waitUntil: 'networkidle2' });
await wait(600);

const result = {};

// 初始渲染检查
result.homeTitle = await page.$eval('#homeTitle', el => el.textContent);

// 设置页：切过去并填服务端地址
await page.evaluate(() => {
  document.querySelectorAll('#tabbar .tab').forEach(t => { if (t.dataset.page === 'settings') t.click(); });
});
await wait(300);
result.acctRows = await page.$$eval('.acct-row', els => els.map(e => e.dataset.platform));

await page.evaluate(() => {
  const inp = document.querySelector('#bffBase');
  inp.value = 'http://127.0.0.1:4399';
  inp.dispatchEvent(new Event('change'));
});
await wait(700);

// 网易云扫码登录
await page.evaluate(() => document.querySelector('[data-login="netease"]').click());
await wait(700);
result.qrVisible = await page.$eval('#qrWrap', el => !el.classList.contains('hidden'));
result.qrHasImg = await page.$eval('#qrImg', el => !!el.getAttribute('src'));
await page.evaluate(() => document.querySelector('#qrWrap').scrollIntoView({ block: 'center' }));
await wait(400);
await page.screenshot({ path: 'D:/音乐开发/shots/mobile-p1-settings.png' });
await wait(4200);   // 轮询 1.8s * 2
result.neState = await page.$eval('#stNetease', el => el.textContent);
result.neOkClass = await page.$eval('#stNetease', el => el.classList.contains('ok'));
result.neLogoutVisible = await page.$eval('[data-logout="netease"]', el => !el.classList.contains('hidden'));

// QQ 扫码登录
await page.evaluate(() => document.querySelector('[data-login="qq"]').click());
await wait(4600);
result.qqState = await page.$eval('#stQq', el => el.textContent);

// 搜索
await page.evaluate(() => {
  document.querySelectorAll('#tabbar .tab').forEach(t => { if (t.dataset.page === 'search') t.click(); });
});
await page.evaluate(() => {
  const i = document.querySelector('#searchInput');
  i.value = '夜曲';
  i.dispatchEvent(new Event('input'));
});
await page.evaluate(() => document.querySelector('#btnSearchReal').click());
await wait(1200);
result.searchRows = await page.$$eval('.search-row', els => els.length);
result.searchText = await page.$$eval('.search-row', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
result.badges = await page.$$eval('.src-badge', els => els.map(e => e.textContent));

// 网络错误提示：把地址改到不存在的端口，触发 Toast
await page.evaluate(() => {
  document.querySelectorAll('#tabbar .tab').forEach(t => { if (t.dataset.page === 'settings') t.click(); });
});
await page.evaluate(() => {
  const inp = document.querySelector('#bffBase');
  inp.value = 'http://127.0.0.1:4599';
  inp.dispatchEvent(new Event('change'));
});
await page.evaluate(() => document.querySelectorAll('#tabbar .tab').forEach(t => { if (t.dataset.page === 'search') t.click(); }));
await page.evaluate(() => document.querySelector('#btnSearchReal').click());
await wait(1500);
result.toastText = await page.$$eval('.toast', els => els.map(e => e.textContent));
result.searchFailText = await page.$$eval('#searchResults .tab-hint', els => els.map(e => e.textContent));

result.calls = calls;
result.errors = errors;
result.consoleErrors = logs.filter(l => l.startsWith('error'));

await page.screenshot({ path: 'D:/音乐开发/shots/mobile-p1-check.png' });

await browser.close();
staticSrv.close();
mockSrv.close();

console.log(JSON.stringify(result, null, 2));
process.exit(errors.length ? 1 : 0);
