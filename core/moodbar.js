/**
 * 情绪曲线进度条
 *
 * - canvas 画能量曲线，只在曲线数据变化时重绘（setCurve 置 dirty）
 * - 已播放部分用暖色遮罩覆盖，形成"随时间由冷转暖"
 * - 进度条填充色随当前能量线性插值
 * - canvas 尺寸按 devicePixelRatio 设置
 */

function energyColor(e, accent) {
  const t = Math.min(1, Math.max(0, e));
  const cold = [accent[0], accent[1], Math.min(255, accent[2] + 40)];
  const warm = [255, 150, 82];
  const r = Math.round(cold[0] + (warm[0] - cold[0]) * t);
  const g = Math.round(cold[1] + (warm[1] - cold[1]) * t);
  const b = Math.round(cold[2] + (warm[2] - cold[2]) * t);
  return `rgb(${r},${g},${b})`;
}

export class Moodbar {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.curve = null;
    this.playback = opts.playback || (() => ({ t: 0, dur: 0 }));
    this.getAccent = opts.getAccent || (() => [165, 152, 255]);
    this.progressEl = opts.progressEl || null;   // 已播放遮罩
    this.fillEl = opts.fillEl || null;           // 进度条填充
    this.tagEl = opts.tagEl || null;             // 段落标签

    this._dirty = true;
    this._lastColor = '';
    this._lastTag = '';
    this._segments = [];
  }

  setCurve(curve) {
    this.curve = curve;
    this._segments = (curve && curve.segments) || [];
    this._dirty = true;
    this._lastTag = '';
  }

  clear() {
    this.setCurve(null);
  }

  /** 尺寸变化或 DPR 变化时调用 */
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._dirty = true;
  }

  /** 每帧调用 */
  tick() {
    const { t, dur } = this.playback();
    if (!dur || !isFinite(dur) || dur <= 0) return;

    if (this._dirty) this._draw();

    // 已播放遮罩宽度
    if (this.progressEl) {
      const pct = Math.min(100, (t / dur) * 100);
      this.progressEl.style.width = pct + '%';
    }

    // 填充色随当前能量
    const e = this._energyAt(t);
    const color = energyColor(e, this.getAccent());
    if (this.fillEl && color !== this._lastColor) {
      this._lastColor = color;
      this.fillEl.style.background = color;
    }

    // 段落标签
    this._updateTag(t);
  }

  _energyAt(t) {
    const c = this.curve;
    if (!c || !c.energy || !c.energy.length) return 0;
    const rate = c.sampleRate || 10;
    const idx = t * rate;
    const i0 = Math.floor(idx);
    if (i0 < 0) return c.energy[0];
    if (i0 >= c.energy.length - 1) return c.energy[c.energy.length - 1];
    const frac = idx - i0;
    // 线性插值对齐当前帧
    return c.energy[i0] * (1 - frac) + c.energy[i0 + 1] * frac;
  }

  _draw() {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);

    const c = this.curve;
    if (!c || !c.energy || !c.energy.length) {
      this._dirty = false;
      return;
    }

    const accent = this.getAccent();
    const n = c.energy.length;
    const stepX = w / Math.max(1, n - 1);
    const baseline = h - 2;
    const maxH = h - 4;

    // 两条：底部淡色底线 + 能量起伏线
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = `rgba(${accent[0]},${accent[1]},${accent[2]},0.42)`;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = i * stepX;
      const e = c.energy[i];
      const y = baseline - Math.pow(e, 0.58) * maxH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    this._dirty = false;
  }

  _updateTag(t) {
    if (!this.tagEl) return;
    let label = '';
    for (const s of this._segments) {
      if (t >= s.t0 && t < s.t1) { label = s.label; break; }
    }
    if (label !== this._lastTag) {
      this._lastTag = label;
      this.tagEl.textContent = label;
      this.tagEl.style.opacity = label ? '1' : '0';
    }
  }
}
