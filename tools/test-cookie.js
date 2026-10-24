/** 验证 cookie 解析：Set-Cookie 带属性时不能把 Path/HttpOnly 混进去 */
const COOKIE_ATTRS = new Set(['path','domain','expires','max-age','httponly','secure','samesite','priority','partitioned','version','comment']);

function extractLoginCookie(r) {
  if (!r) return '';
  const pairs = new Map();
  const add = (raw) => {
    if (!raw) return;
    for (const seg of String(raw).split(';')) {
      const s = seg.trim();
      if (!s) continue;
      const eq = s.indexOf('=');
      if (eq <= 0) continue;
      const k = s.slice(0, eq).trim();
      const v = s.slice(eq + 1).trim();
      if (!k || /\s/.test(k)) continue;
      if (COOKIE_ATTRS.has(k.toLowerCase())) continue;
      pairs.set(k, v);
    }
  };
  const sc = (r.__headers || {})['set-cookie'];
  if (Array.isArray(sc)) { for (const c of sc) add(String(c).split(';')[0]); }
  else if (typeof sc === 'string' && sc) add(sc.split(';')[0]);
  if (typeof r.cookie === 'string' && r.cookie) add(r.cookie);
  if (!pairs.size) return '';
  return [...pairs.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

const cases = [
  {
    name: '真实 Set-Cookie 头（带 Path/HttpOnly）',
    input: {
      __headers: {
        'set-cookie': [
          'MUSIC_U=00ABCDEF123456; Max-Age=1296000; Expires=Fri, 06 Nov 2026 02:00:00 GMT; Path=/; HTTPOnly',
          '__csrf=e5f1a2b3c4; Max-Age=1296000; Path=/',
          'NMTID=00Oxxx; Max-Age=315360000; Path=/'
        ]
      }
    },
    expect: (s) => s.includes('MUSIC_U=00ABCDEF123456') && s.includes('__csrf=e5f1a2b3c4') && !/Path=|HTTPOnly|Max-Age/i.test(s)
  },
  {
    name: '响应体 cookie 拼接（旧接口）',
    input: { cookie: 'MUSIC_U=abc123; Path=/; __csrf=def456; Path=/' },
    expect: (s) => s.includes('MUSIC_U=abc123') && s.includes('__csrf=def456') && !/Path=/.test(s)
  },
  {
    name: '未登录（只有匿名 NMTID）',
    input: { __headers: { 'set-cookie': ['NMTID=00Oyyy; Path=/'] } },
    expect: (s) => s === 'NMTID=00Oyyy' && !/MUSIC_U/.test(s)
  }
];

let pass = 0;
for (const c of cases) {
  const out = extractLoginCookie(c.input);
  const ok = c.expect(out);
  console.log(`${ok ? '✓' : '✗'} ${c.name}`);
  console.log(`   → ${out.slice(0, 110)}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${cases.length} 通过`);
process.exit(pass === cases.length ? 0 : 1);
