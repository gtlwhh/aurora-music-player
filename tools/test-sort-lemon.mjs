/** 搜索排序真实验证：双平台拉真实结果 → 走 core/sort.js 新算法 → 检查 Top1 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// core/sort.js 是浏览器 ESM；node 侧镜像成 .mjs 再导入（每次运行取最新）
const MIRROR = path.join(import.meta.dirname, '.sort-mirror.mjs');
fs.copyFileSync(path.join(import.meta.dirname, '../core/sort.js'), MIRROR);
const { buildSortContext, mixedSortCompare, isPenalized } = await import(pathToFileURL(MIRROR).href);

const BASE = 'http://127.0.0.1:3398';

async function search(q, provider, limit = 30) {
  const res = await fetch(`${BASE}/api/search?provider=${provider}&q=${encodeURIComponent(q)}&limit=${limit}`);
  const d = await res.json();
  return d.tracks || [];
}

async function verify(query, expectArtist) {
  const [ne, qq] = await Promise.all([search(query, 'netease'), search(query, 'qq')]);
  const merged = [];
  [ne, qq].forEach((list, i) => {
    const pf = i === 0 ? 'netease' : 'qq';
    list.forEach((t, k) => { t._srcRank = k; t._srcTotal = list.length; t.provider = t.provider || pf; });
    merged.push(...list);
  });
  // 去重（同 app.js）
  const seen = new Set();
  const dedup = merged.filter(t => {
    const k = t.provider + ':' + (t.gid || t.nid);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  const sortCtx = buildSortContext(dedup, query);
  const sorted = [...dedup].sort((a, b) => mixedSortCompare(a, b, query, sortCtx));
  const top5 = sorted.slice(0, 5).map(t => `${t.title} — ${t.artist} [${t.provider}#rank${t._srcRank}]`);
  const ok = sorted[0] && sorted[0].artist.replace(/師/g, '师').includes(expectArtist);
  console.log(`\n【${query}】Top1 = "${sorted[0].title}" / ${sorted[0].artist} (${sorted[0].provider}) ${ok ? '✅' : '❌ 期望 ' + expectArtist}`);
  top5.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  // 翻唱检查：Top1 不能是翻唱标记
  if (isPenalized(sorted[0])) console.log('  ❌ Top1 是翻唱/伴奏标记条目!');
  return ok;
}


const r1 = await verify('Lemon', '米津玄师');
const r2 = await verify('晴天', '周杰伦');
console.log('\n' + (r1 && r2 ? '🎉 两个用例全部通过' : '❌ 有用例未通过'));
process.exit(r1 && r2 ? 0 : 1);
