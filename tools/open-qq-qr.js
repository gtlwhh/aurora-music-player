const puppeteer = require('puppeteer-core');
(async () => {
  const v = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  const b = await puppeteer.connect({ browserWSEndpoint: v.webSocketDebuggerUrl, defaultViewport: null });
  const p = (await b.pages()).find(x => x.url().includes('127.0.0.1'));
  // 打开设置 → 点 QQ 扫码登录
  await p.evaluate(() => document.querySelector('#btnSettings')?.click());
  await new Promise(r => setTimeout(r, 600));
  await p.evaluate(() => document.querySelector('#btnQqLogin')?.click());
  await new Promise(r => setTimeout(r, 2500));
  const st = await p.evaluate(() => ({
    qrShown: !document.querySelector('#qrImg').hidden,
    status: document.querySelector('#qrStatus')?.textContent,
    title: document.querySelector('#qrTitle')?.textContent
  }));
  console.log(JSON.stringify(st));
  await p.screenshot({ path: 'shots/qq-qr-showing.png' });
  b.disconnect();
})().catch(e => console.error('ERR', e.message));
