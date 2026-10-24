/**
 * core/mix.mjs · 双平台推荐合并（共享源头：桌面端 server 与移动端 BFF 共用）
 *
 * mergeMixRecommendations({ ne, qq, bpmOf, targetBpm, tolerance }):
 *   - 网易云与 QQ 的推荐曲目**交替穿插**（一首网易、一首 QQ），避免整段同平台
 *   - 某一侧为空/失败时自然退化为单平台连续（不报错、不卡死）
 *   - 传了 bpmOf + targetBpm 时做**节奏定向**：
 *       ① 先只穿插「BPM 差值 ≤ tolerance（默认 ±8）」的候选
 *       ② 再穿插「尚无 BPM 缓存」的候选
 *       ③ 最后才是 BPM 差太远的候选
 *     三个桶内部都保持平台交替，所以定向排序不会把某一家堆到前面。
 *     若一个接近的都没有，直接退回普通交替穿插（推荐队列不断流）。
 *   - 返回 { tracks, sides, matched }，matched = 命中节奏的条数
 */
export function mergeMixRecommendations({
  ne = [],
  qq = [],
  bpmOf = null,
  targetBpm = 0,
  tolerance = 8
} = {}) {
  const a = (Array.isArray(ne) ? ne : []).filter(Boolean);
  const b = (Array.isArray(qq) ? qq : []).filter(Boolean);

  const interleave = (x, y) => {
    const out = [];
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length) out.push(x[i++]);
      if (j < y.length) out.push(y[j++]);
    }
    return out;
  };

  const sides = [];
  if (a.length) sides.push('netease');
  if (b.length) sides.push('qq');

  const target = Math.round(Number(targetBpm) || 0);
  if (!target || typeof bpmOf !== 'function') {
    return { tracks: interleave(a, b), sides, matched: 0 };
  }

  // 三个桶：节奏接近 / 未分析 / 差距过大
  const bucketize = (list) => {
    const close = [], unknown = [], far = [];
    for (const t of list) {
      const v = Math.round(Number(bpmOf(t)) || 0);
      if (!v) unknown.push(t);
      else if (Math.abs(v - target) <= tolerance) close.push(t);
      else far.push(t);
    }
    return { close, unknown, far };
  };

  const A = bucketize(a);
  const B = bucketize(b);
  const matched = A.close.length + B.close.length;

  if (!matched) {
    // 没有节奏接近的 → 降级为普通推荐（仍然双平台交替）
    return { tracks: interleave(a, b), sides, matched: 0 };
  }

  const tracks = interleave(A.close, B.close)
    .concat(interleave(A.unknown, B.unknown))
    .concat(interleave(A.far, B.far));

  return { tracks, sides, matched };
}

/** 平台分布统计（供日志 / UI 提示） */
export function mixSidesOf(tracks) {
  const set = new Set((tracks || []).map(t => t && t.provider).filter(Boolean));
  return [...set];
}
