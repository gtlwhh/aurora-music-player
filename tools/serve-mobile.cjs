const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'mobile', 'www');
const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png', svg: 'image/svg+xml' };
http.createServer((req, res) => {
  let f = decodeURIComponent(req.url.split('?')[0]);
  if (f === '/') f = '/index.html';
  const full = path.join(ROOT, f);
  if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const buf = fs.readFileSync(full);
    res.writeHead(200, { 'Content-Type': MIME[f.split('.').pop()] || 'application/octet-stream' });
    res.end(buf);
  } catch (_) { res.writeHead(404); res.end('404'); }
}).listen(7890, '127.0.0.1', () => console.log('mobile dev @ 7890'));
