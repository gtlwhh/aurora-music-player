/**
 * core/sort.js · 聚合搜索排序（桌面端与移动端共享同一份）
 *
 * 排序优先级（严格分档，档内再比相关度）：
 *   0  原唱        —— 查询同时命中「歌名」和「歌手」，且标题没有翻唱/伴奏标记
 *   1  歌手完全匹配 —— 该条目的歌手名就是查询里的歌手
 *   2  歌名完全匹配 —— 标题与查询歌名一致
 *   3  歌手包含     —— 歌手名包含查询里的歌手关键词
 *   4  歌名包含     —— 标题包含查询词
 *   5  伴奏/翻唱/Live/Remix —— 永远垫底
 *   6  其它（弱相关）
 *
 * 关键点：不再假设查询是「歌名 歌手」的顺序，词序反过来（「周杰伦 夜曲」）同样成立。
 */

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[（(]\s*原唱[^）)]*[）)]/g, ' ')   // 去掉「(原唱:xxx)」，避免污染标题匹配
    .replace(/[\s\u3000]+/g, ' ')
    .trim();
}

/** 伴奏 / 翻唱 / Live / DJ 等非原唱版本标记 */
const PENAL_RE = /伴奏|纯音乐|instrumental|karaoke|\bktv\b|cover|翻唱|remix|live|现场|演唱会|铃声|dj版|\bdj\b|片段|试听|消音/i;
/** 标题里自曝「原唱：xxx」= 这是翻唱别人 */
const COVER_MARK_RE = /原唱\s*[:：]|翻自|cover\s*by|翻唱[:：]/i;

/** 该条目是否应垫底 */
function isPenalized(t) {
  const title = String(t.title || '');
  return PENAL_RE.test(title) || COVER_MARK_RE.test(title);
}

/**
 * 从整个结果集里推断「原唱歌手」：
 * 翻唱条目的标题常常自带 `原唱：周杰伦`，把这些名字收集起来，
 * 那么同一位歌手自己那条同名单曲就是原唱，应当排在最前面。
 *
 * @returns {{origArtists: Set<string>}}
 */
function buildSortContext(tracks, q) {
  const origArtists = new Set();
  (tracks || []).forEach(t => {
    const m = String(t.title || '').match(/原唱\s*[:：]\s*([^)）\]】]+)/);
    if (!m || !m[1]) return;
    m[1].split(/[\/、,&]/).forEach(x => {
      const n = norm(x);
      if (n) origArtists.add(n);
    });
  });
  return { origArtists, q: norm(q) };
}

/** 热度：网易云有 pop，QQ 侧可能没有；只做档内微调，不让它跨档压过规则 */
function heatOf(t) {
  const v = Number(t && (t.pop || t.popularity || 0));
  if (!isFinite(v) || v <= 0) return 0;
  return Math.min(4, v / 25);            // 0~4 分
}

/**
 * 分档：数值越小越靠前
 */
function rankOf(t, q, ctx) {
  const ql = norm(q);
  if (!ql) return 9;

  const title = norm(t.title);
  const artist = norm(t.artist);
  const tokens = ql.split(' ').filter(Boolean);

  const artistTokens = tokens.filter(tk => tk.length >= 1);
  const titleHitFull = title === ql || title.includes(ql);
  const titleHitAny = tokens.some(tk => tk.length >= 1 && title.includes(tk));
  const artistExact = artistExactMatch(artist, ql, artistTokens);
  const artistHit = artistTokens.some(tk => tk.length >= 2 && artist.includes(tk));

  // ⑤ 伴奏/翻唱/Live：无论如何垫底
  if (isPenalized(t)) return 5;

  // ① 原唱：结果集里别的翻唱条目点名了这位歌手
  if (ctx && ctx.origArtists && ctx.origArtists.size && ctx.origArtists.has(artist) &&
      (titleHitFull || titleHitAny)) return 0;

  // ① 原唱：歌手完全匹配 + 歌名也命中
  if (artistExact && (titleHitFull || titleHitAny)) return 0;
  // ② 歌手完全匹配（查询里就是这位歌手的歌）
  if (artistExact) return 1;
  // ③ 歌名完全匹配（标题 === 查询 或 查询串完整出现在标题里）
  if (title === ql || title === tokens[0]) return 2;
  if (titleHitFull) return 2;
  // ④ 歌手包含关键词
  if (artistHit) return 3;
  // ⑤ 歌名包含词
  if (titleHitAny) return 4;
  return 6;
}

/** 歌手是否与查询中的某个词完全相等（支持「A/B」「A、B」多歌手） */
function artistExactMatch(artist, ql, tokens) {
  if (!artist) return false;
  if (artist === ql) return true;
  const parts = artist.split(/[\/、,;&·]/).map(s => s.trim()).filter(Boolean);
  return tokens.some(tk => tk.length >= 2 && (artist === tk || parts.includes(tk)));
}

/** 档内相关度：命中越多、标题越短、热度越高越靠前 */
function relevanceScore(t, q) {
  const ql = norm(q);
  const title = norm(t.title);
  const artist = norm(t.artist);
  const tokens = ql.split(' ').filter(Boolean);
  let s = 0;

  if (title === ql) s += 40;
  else if (title.startsWith(ql)) s += 24;
  else if (title.includes(ql)) s += 14;

  tokens.forEach(tk => { if (tk && title.includes(tk)) s += 8; });
  if (artist === ql) s += 30;
  else tokens.forEach(tk => { if (tk.length >= 2 && artist.includes(tk)) s += 10; });

  // 标题越接近查询长度越可信（「夜曲」优于「夜曲 (Live)」）
  s -= Math.min(6, Math.max(0, title.length - ql.length) * 0.4);

  // 同档内用热度拉开原唱与冷门翻唱
  s += heatOf(t);
  return s;
}

/**
 * 混合列表排序（桌面端 / 移动端共用）
 * 分档 → 相关度（含热度） → 标题更短的优先 → 歌手字典序（保证结果稳定）
 */
function mixedSortCompare(a, b, q, ctx) {
  const ra = rankOf(a, q, ctx), rb = rankOf(b, q, ctx);
  if (ra !== rb) return ra - rb;

  const rel = relevanceScore(b, q) - relevanceScore(a, q);
  if (rel !== 0) return rel;

  const la = String(a.title || '').length, lb = String(b.title || '').length;
  if (la !== lb) return la - lb;

  return String(a.artist || '').localeCompare(String(b.artist || ''), 'zh-Hans-CN');
}

export { relevanceScore, mixedSortCompare, rankOf, isPenalized, buildSortContext };
