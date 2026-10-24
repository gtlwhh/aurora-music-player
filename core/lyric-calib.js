/**
 * 歌词自动校准（二值化起音投票）
 *
 * 思路：把起音通量按 p90 阈值二值化成"起音标记"，LRC 每行起始时间在 ±800ms
 * 内滑动候选偏移，统计"行首 ±50ms 内存在起音标记"的行占比（多行投票，
 * 单行不做主）。命中率显著高于随机基线的那个偏移，就是校准值。
 *
 * 为什么二值化而不是直接相关通量幅值：孤立的能量尖峰（观众欢呼、重打击乐）
 * 会主导幅值和，把峰位拉去毫无关系的地方；等权投票只看"有没有起音"，稳健。
 *
 * 置信度（实测标定，见 tools 实验）：
 *   margin = 最优命中率 − 随机基线。鼓点清晰、LRC 真对齐的歌 margin ≈ 0.5+；
 *   氛围曲 / Live / 本已同步的歌 ≈ 0.1~0.2。映射：margin 0.25→0，0.50→1。
 *   另有竞争峰惩罚：±300ms 外存在几乎等高的峰（节拍混叠）时置信度减半。
 *
 * 输出的 offsetMs 语义（全项目统一）：
 *   生效偏移 = 加到 audio.currentTime 上的补偿值。
 *   正值 = 歌词偏慢，判定时间往前补；负值 = 歌词偏快，往后退。
 *   高亮判定直接用 audio.currentTime + offset 与 LRC 时间比较，链上不加任何延迟。
 */

const RANGE = 0.8;      // ±800ms
const STEP = 0.01;      // 候选步长 10ms
const WINDOW = 0.05;    // 行首命中窗口 ±50ms

/**
 * @param {number[]} flux      起音通量（0-255，等间隔）
 * @param {number}   fluxRate  通量采样率（Hz，默认 25）
 * @param {number[]} lineTimes LRC 行起始时间（秒，已含 LRC 自带 offset 标签）
 * @returns {{offsetMs:number, confidence:number, lines:number, matched:number}}
 */
export function calibrateLyricOffset(flux, fluxRate, lineTimes) {
  const empty = { offsetMs: 0, confidence: 0, lines: lineTimes.length, matched: 0 };
  const rate = fluxRate || 25;
  if (!flux || flux.length < 50 || !lineTimes || lineTimes.length < 5) return empty;

  // p90 阈值二值化 + 前缀和（O(1) 区间查询）
  const sorted = Float64Array.from(flux).sort();
  const thr = sorted[Math.floor(sorted.length * 0.9)];
  const pre = new Int32Array(flux.length + 1);
  for (let i = 0; i < flux.length; i++) pre[i + 1] = pre[i] + (flux[i] >= thr ? 1 : 0);

  const hits = (t) => {
    const lo = Math.max(0, Math.floor((t - WINDOW) * rate));
    const hi = Math.min(flux.length - 1, Math.ceil((t + WINDOW) * rate));
    return hi >= lo && pre[hi + 1] - pre[lo] > 0;
  };

  // 逐候选偏移投票
  const nCand = Math.round((RANGE * 2) / STEP) + 1;
  const scores = new Float64Array(nCand);
  let bestIdx = 0;
  for (let c = 0; c < nCand; c++) {
    const o = -RANGE + c * STEP;
    let s = 0;
    for (const L of lineTimes) if (hits(L + o)) s++;
    scores[c] = s / lineTimes.length;
    if (scores[c] > scores[bestIdx]) bestIdx = c;
  }
  const best = scores[bestIdx];
  if (best <= 0) return empty;

  // 匹配数（命中行的绝对数，供 UI 展示）
  let matched = 0;
  for (const L of lineTimes) if (hits(L + (-RANGE + bestIdx * STEP))) matched++;

  // 置信度：命中率显著超出随机基线才算数（实测 0.25 以下不可信，0.5 封顶）
  let sum = 0;
  for (let c = 0; c < nCand; c++) sum += scores[c];
  const baseline = sum / nCand;
  const margin = best - baseline;
  let confidence = Math.min(1, Math.max(0, (margin - 0.25) / 0.25));

  // 幅值合理性先验：LRC 出厂误差极少超过 ±400ms，自动校准声称要修正
  // 更大偏移的（往往是节拍混叠峰）可信度线性衰减，400ms 以上打 4 折
  const absOff = Math.abs(-RANGE + bestIdx * STEP);
  confidence *= 1 - 0.6 * Math.min(1, Math.max(0, (absOff - 0.4) / 0.4));

  return {
    offsetMs: Math.round(-(-RANGE + bestIdx * STEP) * 1000),   // 换算成"补偿值"语义
    confidence: +confidence.toFixed(2),
    lines: lineTimes.length,
    matched
  };
}
