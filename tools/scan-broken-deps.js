/** 全量扫描 node_modules（含嵌套）里 main 入口缺失的损坏包 */
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/音乐开发/node_modules';
const pkgs = [];
function walk(d, depth) {
  if (depth > 4) return;
  let names;
  try { names = fs.readdirSync(d); } catch (_) { return; }
  for (const n of names) {
    if (n === '.bin' || n === '.package-lock.json') continue;
    const p = path.join(d, n);
    let st;
    try { st = fs.statSync(p); } catch (_) { continue; }
    if (!st.isDirectory()) continue;
    if (fs.existsSync(path.join(p, 'package.json'))) pkgs.push(p);
    walk(p, depth + 1);
  }
}
walk(ROOT, 0);
const bad = [];
for (const p of pkgs) {
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')); } catch (_) { continue; }
  const main = m.main || (m.exports && typeof m.exports === 'string' ? m.exports : null);
  if (!main || typeof main !== 'string' || main.includes('*')) continue;
  const cand = main.endsWith('.js') || main.endsWith('.cjs') || main.endsWith('.mjs')
    ? [main]
    : [main, main + '.js', main + '.cjs', path.join(main, 'index.js')];
  const ok = cand.some(c => fs.existsSync(path.join(p, c)) && fs.statSync(path.join(p, c)).isFile());
  if (!ok) bad.push({ pkg: path.relative(ROOT, p), main, ver: m.version });
}
if (!bad.length) { console.log('✓ 全部 ' + pkgs.length + ' 个包入口完好'); }
else { console.log('✗ 损坏包 ' + bad.length + ' / ' + pkgs.length + ':'); bad.forEach(b => console.log('  ' + b.pkg + '@' + b.ver + ' (main=' + b.main + ')')); }
