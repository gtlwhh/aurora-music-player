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
/** 标题里自曝「原唱：xxx / 原唱 xxx / 翻自 xxx」= 这是翻唱别人（正版标题几乎不含"原唱"二字） */
const COVER_MARK_RE = /原唱|翻自|cover\s*by|翻唱|cover版|cover版本/i;

/** 该条目是否应垫底（标题**或歌手名**带翻唱/伴奏/抖音等标记） */
function isPenalized(t) {
  const title = String(t.title || '');
  if (PENAL_RE.test(title) || COVER_MARK_RE.test(title)) return true;
  // 歌手名自曝翻唱身份（「XX翻唱」「XX Cover」「抖音歌手」等）同样垫底
  const artist = String(t.artist || '');
  return /翻唱|cover|翻自|抖音|\blive\b|弹唱|翻唱版/i.test(artist);
}

/**
 * 从整个结果集里推断「原唱歌手」：
 * 翻唱条目的标题常常自带 `原唱：周杰伦`，把这些名字收集起来，
 * 那么同一位歌手自己那条同名单曲就是原唱，应当排在最前面。
 *
 * 同时统计「双平台共识」：同一歌手（标题命中查询）在 ≥2 个平台都出现，
 * 就是跨平台确认的原唱信号（如米津玄师的 Lemon 两边都有）。
 *
 * @returns {{origArtists: Set<string>, artistPlatforms: Map<string,Set<string>>}}
 */
function buildSortContext(tracks, q) {
  const origArtists = new Set();
  const artistPlatforms = new Map();   // norm(artist) -> Set(provider)
  (tracks || []).forEach(t => {
    const m = String(t.title || '').match(/原唱\s*[:：]\s*([^)）\]】]+)/);
    if (!m || !m[1]) return;
    m[1].split(/[\/、,&]/).forEach(x => {
      const n = norm(x);
      if (n) origArtists.add(n);
    });
  });
  // 双平台共识：只统计标题命中查询的条目（排除纯名字撞车）
  const qn = norm(q);
  (tracks || []).forEach(t => {
    const title = norm(t.title);
    if (!title || (qn && !title.includes(qn) && !qn.includes(title))) return;
    const a = norm(t.artist);
    if (!a) return;
    const pf = String(t.provider || '');
    if (!pf) return;
    if (!artistPlatforms.has(a)) artistPlatforms.set(a, new Set());
    artistPlatforms.get(a).add(pf);
  });
  return { origArtists, artistPlatforms, q: qn };
}

/**
 * 热度：跨平台归一。
 *  - 网易云有 pop（0~100）；QQ 侧没有——用平台内原始排名做代理
 *    （各平台接口返回顺序本身就是「热度+相关度」序）。
 *  - 两者取最大值，上限 8 分：足以在同一档内把原唱压过冷门翻唱，
 *    又不会跨档（档位规则仍然最高优先）。
 */
function heatOf(t) {
  let s = 0;
  const v = Number(t && (t.pop || t.popularity || 0));
  if (isFinite(v) && v > 0) s = Math.min(4, v / 25);
  const rank = Number(t && t._srcRank), total = Number(t && t._srcTotal);
  if (isFinite(rank) && isFinite(total) && total > 0) {
    const proxy = Math.max(0, (total - rank) / total);   // 第 1 名 → 1
    s = Math.max(s, proxy * 8);
  }
  return s;
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
  if (artistExact) {
    // ★ 纯歌名查询的艺名撞车：artist 恰好等于查询词、但标题与查询零命中
    //   （搜「晴天」来的艺名叫「晴天」的翻唱）→ 降为弱相关，绝不压标题匹配的正版
    if (artist === ql && !titleHitFull && !titleHitAny) return 3;
    return 1;
  }
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

/** 档内相关度：命中越多、标题越短、热度越高、双平台共识越强越靠前 */
function relevanceScore(t, q, ctx) {
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

  // ★ 双平台共识：同一歌手在 ≥2 个平台都有标题命中版本 → 跨平台确认的原唱
  if (ctx && ctx.artistPlatforms) {
    const set = ctx.artistPlatforms.get(artist);
    if (set && set.size >= 2) s += 18;                 // 终极杀招：米津玄师两边都有 Lemon
    else if (set && set.size === 1) {
      // 单平台出现 ≠ 加分，但可记录；同平台内同名多版本说明是热歌
      if (set.has(String(t.provider || ''))) s += 2;
    }
  }
  return s;
}

/**
 * 混合列表排序（桌面端 / 移动端共用）
 * 分档 → 相关度（含热度） → 标题更短的优先 → 歌手字典序（保证结果稳定）
 */
function mixedSortCompare(a, b, q, ctx) {
  const ra = rankOf(a, q, ctx), rb = rankOf(b, q, ctx);
  if (ra !== rb) return ra - rb;

  const rel = relevanceScore(b, q, ctx) - relevanceScore(a, q, ctx);
  if (rel !== 0) return rel;

  const la = String(a.title || '').length, lb = String(b.title || '').length;
  if (la !== lb) return la - lb;

  return String(a.artist || '').localeCompare(String(b.artist || ''), 'zh-Hans-CN');
}

export { relevanceScore, mixedSortCompare, rankOf, isPenalized, buildSortContext };
