/**
 * 歌词特效层
 *
 * 职责：
 *   1. 渲染歌词 DOM（翻译、间奏标记、点击跳转）
 *   2. 当前行逐字错峰弹跳 + 颜色推进
 *   3. 关键词意象图标在行背后淡入淡出
 *
 * 设计约束：
 *   - 位移只写 transform，绝不碰 layout 属性，避免重排
 *   - 歌词是独立 DOM 层，和 3D canvas 完全隔离，转封面不影响这里
 *   - 所有值计算后与上次比较，没变化就不写 style
 */

import { findImagery } from '../data/imagery.js';
import { iconDataURL } from '../data/pixel-icons.js';

const PUNCT = /[，。！？、；：""''（）《》〈〉…—,.!?;:"'()\[\]\-~·、]/;
const HIT_DURATION = 0.46;   // 单个字的弹跳时长（秒）
const COLOR_DURATION = 0.3;  // 颜色推进时长（秒）
const ICON_DELAY = 220;      // 切行后多久浮现图标
const ICON_LIFE = 2000;      // 图标存活时长

/** 字符在时间轴上的权重：标点占得少，空白不占 */
function charWeight(ch) {
  if (!ch || /\s|\u3000/.test(ch)) return 0;
  if (PUNCT.test(ch)) return 0.32;
  return 1;
}

/**
 * 切词：连续拉丁字母（含撇号）算一个词，其余按单字切。
 * 英文按字母拆会在换行时把单词劈开，所以必须以词为单位。
 */
export function tokenize(text) {
  const tokens = [];
  const re = /[A-Za-z][A-Za-z'’]*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      for (const ch of Array.from(text.slice(last, m.index))) tokens.push(ch);
    }
    tokens.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    for (const ch of Array.from(text.slice(last))) tokens.push(ch);
  }
  return tokens;
}

/** 词元权重：英文词按长度加权，避免一个长词和单个标点占一样的时间 */
function tokenWeight(tok) {
  if (/^[A-Za-z]/.test(tok)) return 1 + (tok.length - 1) * 0.45;
  return charWeight(tok);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;

export class LyricFX {
  constructor(container, opts = {}) {
    this.container = container;
    this.onSeek = opts.onSeek || null;
    this.getAccent = opts.getAccent || (() => [165, 152, 255]);
    this.getScrollEl = opts.getScrollEl || (() => null);
    // 能量查询：(audioTime) => 0~1 | null。用于逐字均分前裁掉行首行尾静音
    this.getEnergy = opts.getEnergy || null;

    this.lines = [];
    this.nodes = [];          // 行节点
    this.charNodes = [];      // 每行的字节点（仅可拆分的行有）
    this.charTimes = [];      // 每行每个字的起始时间
    this.nodeChars = [];      // 与 charNodes 对应的“唱到进度”缓存

    this.activeIdx = -1;
    this.plain = false;

    // 逐字律动开关与生效时间偏移（全项目统一语义：加到 audio.currentTime 上的补偿值）
    this.charFxEnabled = opts.charFx !== false;
    this._offsetSec = (Number(opts.offsetMs) || 0) / 1000;

    this._rawLyrics = null;

    this._iconTimers = [];
    this._iconNodes = [];
    this._accent = [165, 152, 255];
    this._accentDim = null;

    this._built = false;
  }

  /** 运行时调整（设置面板改完立刻生效，不重启播放） */
  applyPrefs({ charFx, offsetMs, render = true } = {}) {
    let needRender = false;

    if (charFx !== undefined && (charFx !== false) !== this.charFxEnabled) {
      this.charFxEnabled = charFx !== false;
      needRender = true;
    }
    if (offsetMs !== undefined) {
      const sec = (Number(offsetMs) || 0) / 1000;
      if (sec !== this._offsetSec) { this._offsetSec = sec; needRender = true; }
    }

    if (needRender && render && this._rawLyrics) {
      const keep = this.activeIdx;
      this.render(this._rawLyrics);
      if (keep >= 0) {
        this.setIndex(keep);
        this.scrollTo(keep);
      }
    }
  }

  /* ---------------- 渲染 ---------------- */

  render(lyrics) {
    this.clear();
    this._rawLyrics = lyrics;
    this.lines = (lyrics && lyrics.lines) || [];
    this.plain = !!(lyrics && lyrics.plain);
    this.container.classList.toggle('lyric-plain', this.plain);

    const frag = document.createDocumentFragment();

    this.lines.forEach((line, i) => {
      const d = document.createElement('div');
      d.className = 'lyric-line';
      d.dataset.index = String(i);

      const text = line.text || '';
      const isInterlude = /^[♪♫·\-—…\s]+$/.test(text);
      if (isInterlude) d.classList.add('interlude');

      // 图标的落点（在文字层之下）
      const iconLayer = document.createElement('div');
      iconLayer.className = 'line-icons';
      d.appendChild(iconLayer);

      const textWrap = document.createElement('span');
      textWrap.className = 'line-text';

      // 只有“有时间轴 + 非间奏 + 非纯文本 + 开启了逐字律动”的行才拆字
      const canSplit = this.charFxEnabled && !this.plain && !isInterlude &&
                       line.time >= 0 && text.length > 0;

      if (canSplit) {
        const chars = tokenize(text);
        const next = this.lines[i + 1];
        let t0 = line.time;
        let t1 = next && next.time > line.time
          ? Math.min(next.time, line.time + 12)
          : line.time + 4.2;

        // 能量裁剪：行首/行尾静音段不参与字级均分，字的时间落在真正有声的部分
        const trimmed = this._trimSpan(t0, t1);
        if (trimmed) { t0 = trimmed[0]; t1 = trimmed[1]; }

        const span = t1 - t0;
        // 留一点间隔，避免最后一个字和下一行首字挤在一起
        const usable = Math.max(0.5, span - 0.18);

        const weights = chars.map(tokenWeight);
        const total = weights.reduce((a, b) => a + b, 0) || 1;

        const offset = this._offsetSec;
        let acc = 0;
        const times = [];
        const nodes = [];

        for (let c = 0; c < chars.length; c++) {
          const w = weights[c];
          const startAt = t0 - offset + (acc / total) * usable;
          acc += w;

          const s = document.createElement('span');
          s.className = 'ch';
          s.textContent = chars[c];
          // 纯空白不参与动画。
          // ★ 英文粘连修复：inline-block 会把普通空格折叠成零宽，
          //   必须用不换行空格占位，单词之间的间距才不会丢失。
          if (w === 0) { s.classList.add('ch-space'); s.textContent = '\u00A0'; }
          textWrap.appendChild(s);

          times.push(startAt);
          nodes.push(s);
        }

        this.charNodes[i] = nodes;
        this.charTimes[i] = times;
        this.nodeChars[i] = new Float32Array(chars.length).fill(-1);
      } else {
        textWrap.textContent = text;
        this.charNodes[i] = null;
        this.charTimes[i] = null;
        this.nodeChars[i] = null;
      }

      d.appendChild(textWrap);

      if (line.tr) {
        d.classList.add('has-tr');
        const tr = document.createElement('span');
        tr.className = 'tr';
        tr.textContent = line.tr;
        d.appendChild(tr);
      }

      if (!this.plain && line.time >= 0 && this.onSeek) {
        d.addEventListener('click', () => this.onSeek(line.time + 0.02));
      }

      frag.appendChild(d);
      this.nodes.push(d);
    });

    this.container.appendChild(frag);
    this.container.style.transform = 'translateY(0)';
    this._built = true;
    this.activeIdx = -1;
  }

  /* ---------------- 静音裁剪 ---------------- */

  /**
   * 用能量曲线把行窗口 [t0, t1]（LRC 时间域）两端的静音裁掉。
   * 返回裁剪后的 [t0', t1']；无能量数据 / 整段都静音时返回 null（退回均分）。
   * 单侧最多裁掉窗口的 45%，防止把整行裁没。
   */
  _trimSpan(t0, t1) {
    if (!this.getEnergy || t1 - t0 < 0.6) return null;
    const off = this._offsetSec;
    const a = t0 - off, b = t1 - off;          // 转成音频时间域
    const stepT = 0.05;
    const n = Math.max(2, Math.floor((b - a) / stepT));

    let maxE = 0;
    const vals = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) {
      const e = this.getEnergy(a + (i / n) * (b - a));
      if (e === null || e === undefined) return null;   // 无曲线，不裁
      vals[i] = e;
      if (e > maxE) maxE = e;
    }

    const thr = Math.max(0.12, maxE * 0.35);
    let first = -1, last = -1;
    for (let i = 0; i <= n; i++) {
      if (vals[i] >= thr) { if (first < 0) first = i; last = i; }
    }
    if (first < 0 || last <= first) return null;          // 整段静音

    const win = b - a;
    let lead = (first / n) * win;
    let trail = ((n - last) / n) * win;
    lead = Math.min(lead, win * 0.45);
    trail = Math.min(trail, win * 0.45);
    if (win - lead - trail < 0.4) return null;

    return [t0 + lead, t1 - trail];
  }

  clear() {
    this._clearIconTimers();
    this._removeIcons();
    this.container.innerHTML = '';
    this.lines = [];
    this.nodes = [];
    this.charNodes = [];
    this.charTimes = [];
    this.nodeChars = [];
    this.activeIdx = -1;
    this._built = false;
  }

  /** 供外部（主题色变化时）刷新强调色 */
  setAccent(rgb) {
    this._accent = rgb || [165, 152, 255];
    this._accentDim = null;
    // 强制下一帧重算颜色
    for (const arr of this.nodeChars) {
      if (arr) arr.fill(-1);
    }
  }

  /* ---------------- 切行 ---------------- */

  setIndex(idx) {
    if (!this._built || idx === this.activeIdx) return;
    const prev = this.activeIdx;
    this.activeIdx = idx;

    if (prev >= 0 && this.nodes[prev]) {
      const pn = this.nodes[prev];
      pn.classList.remove('active');
      pn.classList.add('past');
      this._resetRow(prev);
    }

    // seek 回跳时，新行之后的行可能残留"已唱"的字位移；不重置会高亮卡死
    const lo = Math.max(0, Math.min(prev, idx));
    const hi = Math.max(prev, idx);
    for (let i = lo; i <= hi; i++) {
      if (i !== idx && this.nodes[i]) this._resetRow(i);
    }

    for (let i = 0; i < this.nodes.length; i++) {
      if (i < idx) this.nodes[i].classList.add('past');
      else if (i > idx) this.nodes[i].classList.remove('active', 'past');
    }

    if (idx >= 0 && this.nodes[idx]) {
      this.nodes[idx].classList.remove('past');
      this.nodes[idx].classList.add('active');
      this._resetRow(idx);
      this._scheduleIcon(idx);
    }
  }

  _resetRow(idx) {
    const arr = this.nodeChars[idx];
    if (arr) arr.fill(-1);
    const nodes = this.charNodes[idx];
    if (nodes) {
      for (const n of nodes) {
        n.style.transform = '';
        n._ty = '';
      }
    }
  }

  /* ---------------- 每帧驱动 ---------------- */

  /**
   * @param {number} time 当前播放时间
   * @param {{bass:number, energy:number}} levels 音频特征
   */
  tick(time, levels) {
    const idx = this.activeIdx;
    if (idx < 0) return;

    const chars = this.charNodes[idx];
    const times = this.charTimes[idx];
    if (!chars || !times) return;

    const accent = this._accent;
    // 未唱的字偏主色且压暗，唱到的字推向白
    const dimR = Math.round(accent[0] * 0.52 + 40);
    const dimG = Math.round(accent[1] * 0.52 + 40);
    const dimB = Math.round(accent[2] * 0.52 + 46);

    const bass = levels && isFinite(levels.bass) ? levels.bass : 0;
    const amp = 1 + bass * 2.1;   // 1–3px

    const progress = this.nodeChars[idx];

    for (let i = 0; i < chars.length; i++) {
      const el = chars[i];
      if (el.classList.contains('ch-space')) continue;

      const dt = time - times[i];
      const p = progress[i];

      if (dt < 0) {
        // 还没唱到：保持原位、暗色
        if (p !== 0) {
          el.style.transform = '';
          el.style.color = `rgb(${dimR},${dimG},${dimB})`;
          progress[i] = 0;
        }
        continue;
      }

      // 位移：一记短促的弹起再落回（y 为负表示向上）
      let y = 0;
      if (dt < HIT_DURATION) {
        const k = dt / HIT_DURATION;
        y = -Math.sin(k * Math.PI) * amp;
      }

      // 颜色：0 → 1，达到 1 后不再写
      const ck = clamp01(dt / COLOR_DURATION);

      // 变化足够小就跳过写入，省掉大量 style 操作
      if (Math.abs(ck - p) > 0.015 || (dt >= HIT_DURATION && p < 1)) {
        const r = Math.round(mix(dimR, 255, ck));
        const g = Math.round(mix(dimG, 255, ck));
        const b = Math.round(mix(dimB, 255, ck));
        el.style.color = `rgb(${r},${g},${b})`;
        progress[i] = ck;
      }

      // 只有在真的被抬起时才写 transform，避免每帧无谓的 style 操作
      const ty = Math.abs(y) > 0.02 ? `translate3d(0,${y.toFixed(2)}px,0)` : '';
      if (el._ty !== ty) {
        el.style.transform = ty;
        el._ty = ty;
      }
    }
  }

  /** 暂停时把所有字归位，避免停在半空 */
  settle() {
    const idx = this.activeIdx;
    if (idx < 0) return;
    const chars = this.charNodes[idx];
    if (!chars) return;
    for (const el of chars) {
      el.style.transform = '';
      el._ty = '';
    }
  }

  /* ---------------- 关键词意象 ---------------- */

  _scheduleIcon(idx) {
    this._clearIconTimers();
    this._removeIcons();

    const line = this.lines[idx];
    if (!line || !line.text) return;

    const hits = findImagery(line.text);
    if (!hits.length) return;

    const node = this.nodes[idx];
    if (!node) return;

    const t = setTimeout(() => {
      this._showIcons(idx, hits);
    }, ICON_DELAY);

    this._iconTimers.push(t);
  }

  _showIcons(idx, hits) {
    const node = this.nodes[idx];
    if (!node || this.activeIdx !== idx) return;

    const layer = node.querySelector('.line-icons');
    if (!layer) return;

    hits.forEach((hit, i) => {
      const url = iconDataURL(hit.icon);
      if (!url) return;

      const icon = document.createElement('span');
      icon.className = 'line-icon';
      icon.style.backgroundImage = `url("${url}")`;
      // 两个图标左右分开，避免叠在一起
      icon.style.left = hits.length > 1 ? `${18 + i * 46}%` : '10%';
      icon.style.setProperty('--rot', `${(i % 2 ? 1 : -1) * (3 + Math.random() * 4)}deg`);
      layer.appendChild(icon);
      this._iconNodes.push(icon);

      requestAnimationFrame(() => icon.classList.add('on'));

      const offTimer = setTimeout(() => {
        icon.classList.remove('on');
        const rmTimer = setTimeout(() => icon.remove(), 900);
        this._iconTimers.push(rmTimer);
      }, ICON_LIFE);
      this._iconTimers.push(offTimer);
    });
  }

  _removeIcons() {
    for (const n of this._iconNodes) n.remove();
    this._iconNodes = [];
  }

  _clearIconTimers() {
    for (const t of this._iconTimers) clearTimeout(t);
    this._iconTimers = [];
  }

  /** 滚动到当前行（保持原有手感：整层 transform 平移） */
  scrollTo(idx) {
    const scrollEl = this.getScrollEl();
    const node = this.nodes[idx];
    if (!scrollEl || !node) return;
    const target = node.offsetTop + node.offsetHeight / 2 - scrollEl.clientHeight * 0.42;
    this.container.style.transform = `translateY(${-Math.max(0, target)}px)`;
  }
}
