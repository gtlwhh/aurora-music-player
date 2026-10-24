/**
 * 歌词引擎：LRC 解析 + 时间轴同步
 * 支持：标准 LRC、多时间标签、翻译歌词、offset 偏移、纯文本歌词降级
 */

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** 解析时间标签为秒 */
function parseTimeTag(m, s, ms) {
  const minutes = parseInt(m, 10);
  const seconds = parseInt(s, 10);
  let frac = 0;
  if (ms !== undefined) {
    frac = parseInt(ms, 10) / Math.pow(10, ms.length);
  }
  return minutes * 60 + seconds + frac;
}

/**
 * 解析 LRC 文本
 * @returns {{lines: Array<{time:number,text:string,tr:string}>, offset:number, meta:object, plain:boolean}}
 */
export function parseLRC(text) {
  const result = { lines: [], offset: 0, meta: {}, plain: false };
  if (!text || typeof text !== 'string') return result;

  const rawLines = text.split(/\r?\n/);
  const buckets = new Map(); // time -> {text, tr}
  let hasTimeTag = false;

  for (const raw of rawLines) {
    const line = raw.trim();
    if (!line) continue;

    // 元信息标签 [ti:xxx] [ar:xxx] ...
    const metaMatch = /^\[(ti|ar|al|by|offset|re|ve|length):(.*)\]$/i.exec(line);
    if (metaMatch) {
      const key = metaMatch[1].toLowerCase();
      const val = metaMatch[2].trim();
      if (key === 'offset') {
        const off = parseInt(val, 10);
        if (!isNaN(off)) result.offset = off / 1000;
      } else {
        result.meta[key] = val;
      }
      continue;
    }

    // 提取所有时间标签
    TIME_TAG.lastIndex = 0;
    const times = [];
    let m;
    while ((m = TIME_TAG.exec(line)) !== null) {
      times.push(parseTimeTag(m[1], m[2], m[3]));
    }

    if (times.length === 0) {
      // 没有时间轴 → 纯文本歌词
      if (!hasTimeTag) {
        result.lines.push({ time: -1, text: line, tr: '' });
      }
      continue;
    }

    hasTimeTag = true;
    // 去掉时间标签后的正文
    const content = line.replace(TIME_TAG, '').trim();
    if (!content) continue;

    for (const t of times) {
      const key = Math.round(t * 100) / 100;
      const existing = buckets.get(key);
      if (existing) {
        // 同时间戳已有内容：可能是双语对照
        if (!existing.text) existing.text = content;
        else if (!existing.tr) existing.tr = content;
      } else {
        buckets.set(key, { text: content, tr: '' });
      }
    }
  }

  if (!hasTimeTag && result.lines.length) {
    result.plain = true;
    return result;
  }

  // 若解析出纯文本但也被标记为有时间轴，清掉无时间的行
  result.lines = [...buckets.entries()]
    .filter(([, v]) => v.text)
    .map(([time, v]) => ({ time, text: v.text, tr: v.tr }))
    .sort((a, b) => a.time - b.time);

  // 应用 offset
  if (result.offset) {
    for (const l of result.lines) l.time = Math.max(0, l.time + result.offset);
  }

  return result;
}

/**
 * 合并翻译歌词：按时间戳把 tlyric 的文本挂到主歌词上
 */
export function mergeTranslation(mainLRC, transLRC) {
  const main = parseLRC(mainLRC);
  if (!transLRC || !main.lines.length) return main;

  const trans = parseLRC(transLRC);
  if (!trans.lines.length) return main;

  const map = new Map();
  for (const l of trans.lines) map.set(Math.round(l.time * 100) / 100, l.text);

  for (const l of main.lines) {
    const key = Math.round(l.time * 100) / 100;
    if (map.has(key)) {
      const t = map.get(key);
      if (t && t !== l.text) l.tr = t;
    } else {
      // 容错：找最接近的时间戳（±0.35s）
      for (const [k, v] of map) {
        if (Math.abs(k - l.time) < 0.35) { l.tr = v; break; }
      }
    }
  }
  return main;
}

/**
 * 找到当前时间对应的歌词行
 * @returns {number} 索引，-1 表示还没到第一句
 */
export function findLineIndex(lines, time) {
  if (!lines.length) return -1;
  if (time < lines[0].time - 0.25) return -1;
  let lo = 0, hi = lines.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= time + 0.02) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/** 秒 → m:ss */
export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
