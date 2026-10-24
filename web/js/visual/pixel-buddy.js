/**
 * PixelBuddy · 像素唱歌小人
 *
 * 纯 Canvas 2D 点阵绘制（16×18 逻辑格，4px/格），零外部图片。
 * 音频驱动：
 *   - bass     → 嘴巴开合大小（越响嘴越大）
 *   - mid      → 身体左右摇摆
 *   - beat     → bass 瞬时峰值触发跳跃（抛物线，带冷却防连跳）
 *   - 播放中   → 呼吸弹跳幅度加大 + 冒 ♪ 音符粒子
 * 性能：独立 rAF；document.hidden 时自动暂停；关闭开关时彻底停止。
 */

const PAL = {
  hair: '#5b3a8f',      // 紫发
  skin: '#ffd9a0',
  eye:  '#2b2340',
  mouth:'#d94f5c',
  blush:'#ff9aa8',
  body: '#7c6cff',      // 衣服从主题紫
  arm:  '#6a5ae0',
  micH: '#cfd6ff',      // 麦克风银头
  micS: '#3a3f52',      // 麦克风杆
  shoe: '#2b2340',
  note: '#ffe08a'
};

/* 14×17 点阵：. 空 | H 发 | S 肤 | B 身 | A 手臂 | m 腮红 | F 鞋 | K 麦杆 | D 麦头
   嘴（O）和眼（E）由程序动态画，留空位 */
const SPRITE = [
  '....HHHHHH....',
  '...HHHHHHHH...',
  '..HHHHHHHHHH..',
  '..HSSSSSSSSH..',
  '..HS.....SSH..',
  '..HS.....SSH..',
  '..HSSSSSSSSH..',
  '...SSSmSSmSD..',
  '....SSSSSS.K..',
  '..AABBBBBBAK..',
  '..AABBBBBB.K..',
  '..ABBBBBBB....',
  '...BBBBBBB....',
  '...BB...BB....',
  '...FF...FF....'
];

const W = 14, H = 16, CELL = 4;       // 画布逻辑 56×64 + 留白
const CVW = 64, CVH = 76;

export class PixelBuddy {
  /**
   * @param host   容器元素（canvas 挂进去）
   * @param opts   { getLevels, isPlaying }
   */
  constructor(host, opts = {}) {
    this.getLevels = opts.getLevels || (() => ({ bass: 0, energy: 0, mid: 0 }));
    this.isPlaying = opts.isPlaying || (() => false);
    this.enabled = true;

    this.canvas = document.createElement('canvas');
    this.canvas.width = CVW;
    this.canvas.height = CVH;
    this.canvas.className = 'pixel-buddy';
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;

    this.t = 0;
    this._raf = 0;
    this._running = false;
    this._jumpY = 0;
    this._jumpV = 0;
    this._lastBeat = 0;
    this._notes = [];          // {x, y, vx, vy, life, ch}
    this._noteTick = 0;
    this._personality = 'normal';  // normal | hype | calm（曲风自适应）
    this._switchUntil = 0;         // 切歌反应截止时间戳
    // 低通滤波状态（未初始化会导致 NaN 传播 → 整个 canvas 静默不画！）
    this._sBass = 0;
    this._sMid = 0;
    this._sSway = 0;
    this._sBob = 0;
    this._muted = 0;           // document.hidden 计数
    this._onVis = () => {
      if (document.hidden) this._pause();
      else if (this.enabled) this._resume();
    };
    document.addEventListener('visibilitychange', this._onVis);
  }

  /**
   * 切歌反应：被"晃一下"——身体快速左右摇摆 + 头顶冒感叹号和汗滴，
   * 约 1.3s，结束时振幅线性衰减平滑回唱歌状态。纯状态变量，不抢帧。
   */
  reactSwitch() {
    this._switchUntil = performance.now() + 1300;
  }

  /** 曲风性格：normal | hype(高能狂热) | calm(抒情沉醉) */
  setPersonality(m) {
    if (m !== this._personality) this._personality = m;
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.canvas.style.display = this.enabled ? '' : 'none';
    if (this.enabled) this._resume(); else this._pause();
  }

  destroy() {
    this._pause();
    document.removeEventListener('visibilitychange', this._onVis);
    this.canvas.remove();
  }

  _pause() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    this._running = false;
  }

  _resume() {
    if (this._running || !this.enabled) return;
    this._running = true;
    this._raf = requestAnimationFrame(this._loop = this._loop || ((ts) => {
      this._raf = 0;
      if (!this._running) return;
      this.tick(ts);
      this._raf = requestAnimationFrame(this._loop);
    }));
  }

  /** 每帧驱动（由外部 rAF 调也可以，内部自循环默认独立跑） */
  tick(ts) {
    if (document.hidden) return;    // 后台标签页：只等待 visibilitychange 恢复
    const lv = this.getLevels() || {};
    const playing = this.isPlaying();
    const bass = Math.max(0, Math.min(1, lv.bass || 0));
    const mid = Math.max(0, Math.min(1, lv.mid || 0));

    const now = ts || performance.now();
    const inSwitch = now < this._switchUntil;
    // 切歌反应包络：easeOutCubic 缓动（前快后慢），绝无瞬移
    const swRaw = inSwitch ? Math.min(1, (this._switchUntil - now) / 1300) : 0;
    const swEase = inSwitch ? (1 - Math.pow(1 - swRaw, 3)) : 0;

    // ---- 曲风性格参数表（振幅已收敛，防鬼畜） ----
    const P = {
      normal: { bobFreq: 0.1,  bobAmp: 1.0, swayFreq: 0.02, swayAmp: 1.0, noteEvery: 42,  beatTh: 0.55, eyes: 'open',   breathAmp: 1.2 },
      hype:   { bobFreq: 0.12, bobAmp: 1.4, swayFreq: 0.025, swayAmp: 1.5, noteEvery: 24,  beatTh: 0.46, eyes: 'open',   breathAmp: 1.4 },
      calm:   { bobFreq: 0.04, bobAmp: 0.2, swayFreq: 0.008, swayAmp: 0.8, noteEvery: 170, beatTh: 9,    eyes: 'closed', breathAmp: 0.6 }
    }[this._personality] || { bobFreq: 0.1, bobAmp: 1.0, swayFreq: 0.02, swayAmp: 1.0, noteEvery: 42, beatTh: 0.55, eyes: 'open', breathAmp: 1.2 };

    // ---- 低通滤波：实时音频先平滑再进位移（防鬼畜核心） ----
    this._sBass = (isFinite(this._sBass) ? this._sBass : 0) + (bass - (isFinite(this._sBass) ? this._sBass : 0)) * 0.12;
    this._sMid += (mid - this._sMid) * 0.1;
    const sBass = this._sBass;
    const sMid = this._sMid;

    // ---- beat 检测：用未滤波的瞬时 bass（保灵敏度）+ 280ms 冷却 ----
    if (playing && bass > P.beatTh && now - this._lastBeat > 280) {
      this._lastBeat = now;
      if (this._jumpY === 0) this._jumpV = -1.2;   // 起跳（幅度收敛）
    }
    if (this._jumpY !== 0 || this._jumpV !== 0) {
      this._jumpY += this._jumpV;
      this._jumpV += 0.12;
      if (this._jumpY >= 0) { this._jumpY = 0; this._jumpV = 0; }
    }

    // ---- 姿态参数（全部基于平滑后的数据） ----
    const breath = Math.sin(this.t * 0.05) * (playing ? P.breathAmp : 0.8);
    const swayBase = Math.sin(this.t * P.swayFreq) * sMid * P.swayAmp;
    // 切歌摇晃：缓动 + 收敛幅度 + 本身再过一次低通
    const swayTarget = swayBase + (inSwitch ? Math.sin(this.t * 0.35) * 1.2 * swEase : 0);
    this._sSway += (swayTarget - this._sSway) * 0.18;
    const bobTarget = Math.abs(Math.sin(this.t * (playing ? P.bobFreq : 0.06))) * (playing ? P.bobAmp + sBass * 1.2 : 0.6);
    this._sBob += (bobTarget - this._sBob) * 0.15;
    const mouth = playing ? Math.round(Math.min(3, sBass * 4.5 + 0.4)) : 0;

    // 音符粒子
    this._noteTick++;
    if (playing && mouth >= 2 && this._noteTick % P.noteEvery === 0) {
      this._notes.push({ x: W - 1, y: 4, vx: 0.12 + Math.random() * 0.08, vy: -0.35, life: 60, ch: Math.random() > 0.5 ? '♪' : '♫' });
    }
    this._notes = this._notes.filter(n => {
      n.x += n.vx; n.y += n.vy; n.vy *= 0.99; n.life--;
      return n.life > 0;
    });

    this._draw(this._sBob, this._sSway, mouth, breath, {
      inSwitch, swEase,
      eyes: inSwitch ? 'wide' : P.eyes
    });
    this.t++;
  }

  _px(cx, cy, color) {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(cx * CELL, cy * CELL, CELL, CELL);
  }

  _draw(bob, sway, mouth, breath, fx = {}) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CVW, CVH);

    const ox = Math.round((CVW / CELL - W) / 2 + sway);      // 水平偏移（摇摆/切歌摇晃）
    // 站在地面上 + 呼吸弹跳（bob 直接驱动上下位移）+ 跳跃
    const oy = Math.round(H - 1 + breath * 0.5 - bob - this._jumpY);

    // 地面阴影
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    const sw = Math.max(6, 12 - this._jumpY * 4);
    ctx.fillRect(((CVW / CELL) - sw) / 2 * CELL, (oy + 1) * CELL, sw * CELL, CELL / 2);

    // ---- 身体点阵 ----
    for (let y = 0; y < SPRITE.length; y++) {
      const row = SPRITE[y];
      for (let x = 0; x < row.length; x++) {
        const c = row[x];
        if (c === '.') continue;
        let color = null;
        if (c === 'H') color = PAL.hair;
        else if (c === 'S') color = PAL.skin;
        else if (c === 'B') color = PAL.body;
        else if (c === 'A') color = PAL.arm;
        else if (c === 'm') color = PAL.blush;
        else if (c === 'F') color = PAL.shoe;
        else if (c === 'K') color = PAL.micS;
        else if (c === 'D') color = PAL.micH;
        if (color) this._px(ox + x, oy - (SPRITE.length - y), color);
      }
    }

    // ---- 眼睛：open 圆点 | wide(切歌惊吓) 大睁 | closed(抒情微闭横线) ----
    const eyeY = oy - 11;
    if (fx.eyes === 'closed') {
      ctx.fillStyle = PAL.eye;
      ctx.fillRect((ox + 3) * CELL, (eyeY + 1) * CELL, 3 * CELL, 2);      // 闭眼横线
      ctx.fillRect((ox + 8) * CELL, (eyeY + 1) * CELL, 3 * CELL, 2);
    } else {
      const eyeH = fx.eyes === 'wide' ? 2 : (mouth >= 3 ? 1 : 2);
      const eyeW = fx.eyes === 'wide' ? 2 : 1;
      this._px(ox + 4, eyeY, PAL.eye);
      if (eyeH > 1) this._px(ox + 4, eyeY + 1, PAL.eye);
      this._px(ox + 9, eyeY, PAL.eye);
      if (eyeH > 1) this._px(ox + 9, eyeY + 1, PAL.eye);
      if (eyeW > 1) { this._px(ox + 5, eyeY, PAL.eye); this._px(ox + 10, eyeY, PAL.eye); }
    }

    // ---- 切歌反应：头顶感叹号 + 侧边汗滴 ----
    if (fx.inSwitch) {
      ctx.fillStyle = '#ff5a5a';
      ctx.fillRect((ox + 6) * CELL, (oy - 19) * CELL, 2 * CELL, 3 * CELL);   // 感叹号竖
      ctx.fillRect((ox + 6) * CELL, (oy - 15) * CELL, 2 * CELL, 2);          // 点
      ctx.fillStyle = '#9ad7ff';
      ctx.fillRect((ox + 12) * CELL, (oy - 17) * CELL, 2 * CELL, 2 * CELL);  // 汗滴
      if (fx.shake > 0.5) { ctx.fillRect((ox + 13) * CELL, (oy - 14) * CELL, CELL, 2); }
    }

    // ---- 嘴（bass 驱动开合：宽 4 格，高 1~3）----
    const mw = mouth >= 2 ? 4 : 3;
    const mh = Math.max(mouth >= 1 ? 1 : 0, mouth);
    if (mh > 0) {
      ctx.fillStyle = PAL.mouth;
      ctx.fillRect((ox + 5) * CELL, (oy - 8 - (mh - 1)) * CELL, mw * CELL, mh * CELL);
      // 唱歌大张嘴时里面加个舌头亮点
      if (mh >= 3) {
        ctx.fillStyle = '#ff8f9a';
        ctx.fillRect((ox + 6) * CELL, (oy - 8) * CELL, 2 * CELL, CELL);
      }
    } else {
      // 闭嘴：一条小线
      ctx.fillStyle = PAL.mouth;
      ctx.fillRect((ox + 5) * CELL, (oy - 8) * CELL, 3 * CELL, 2);
    }

    // ---- 音符粒子（像素 ♪）----
    ctx.fillStyle = PAL.note;
    for (const n of this._notes) {
      const nx = Math.round(n.x * CELL), ny = Math.round(n.y * CELL);
      ctx.globalAlpha = Math.min(1, n.life / 30);
      ctx.fillRect(nx, ny, CELL, CELL);                  // 符头
      ctx.fillRect(nx + CELL, ny, 2, CELL * 2);          // 符杆
      ctx.fillRect(nx + CELL, ny, CELL, 2);              // 符尾横杠
      ctx.globalAlpha = 1;
    }
  }
}
