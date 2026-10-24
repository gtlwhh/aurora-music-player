'use strict';
/**
 * 内置演示音乐生成器
 *
 * 本机没有任何音频文件时，播放器需要内容才能展示 3D 封面 / 律动光效 / 歌词同步。
 * 这里用纯数学合成 4 首不同风格的器乐片段（无版权问题），生成 WAV + LRC。
 *
 * 运行：node tools/gen-demo.js
 */

const fs = require('fs');
const path = require('path');

const SR = 44100;

/* ==================================================================
   基础工具
   ================================================================== */

const TAU = Math.PI * 2;

/** 半音 → 频率（A4 = 440） */
const noteFreq = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

/** 音名 → MIDI，如 "A3" "C#4" */
function nm(s) {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(s);
  if (!m) throw new Error('bad note ' + s);
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]];
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return 12 * (parseInt(m[3], 10) + 1) + base + acc;
}

/** 带限波形：用谐波求和避免混叠 */
function waveform(phase, type, maxHarm) {
  // phase 在 [0,1)
  switch (type) {
    case 'sine': return Math.sin(TAU * phase);
    case 'saw': {
      let v = 0;
      for (let n = 1; n <= maxHarm; n++) v += Math.sin(TAU * phase * n) / n;
      return v * (2 / Math.PI) * 0.5;
    }
    case 'square': {
      let v = 0;
      for (let n = 1; n <= maxHarm; n += 2) v += Math.sin(TAU * phase * n) / n;
      return v * (4 / Math.PI) * 0.5;
    }
    case 'tri': {
      let v = 0;
      for (let n = 1; n <= maxHarm; n += 2) {
        v += Math.pow(-1, (n - 1) / 2) * Math.sin(TAU * phase * n) / (n * n);
      }
      return v * (8 / (Math.PI * Math.PI));
    }
    default: return Math.sin(TAU * phase);
  }
}

/** 简易一阶低通 */
class LowPass {
  constructor(cutoff) { this.setCutoff(cutoff); this.y = 0; }
  setCutoff(hz) {
    this.a = 1 - Math.exp(-TAU * hz / SR);
  }
  process(x) {
    this.y += this.a * (x - this.y);
    return this.y;
  }
}

/** 软削波 */
function softClip(x) {
  return Math.tanh(x * 1.15) * 0.86;
}

/* ==================================================================
   混响（Schroeder）
   ================================================================== */
class Reverb {
  constructor({ roomSize = 0.82, damp = 0.32, wet = 0.3 } = {}) {
    const combTune = [1116, 1188, 1277, 1356, 1422, 1491];
    this.combs = combTune.map(d => ({
      buf: new Float32Array(Math.round(d * (0.7 + roomSize * 0.6))),
      idx: 0, store: 0
    }));
    this.aps = [556, 441, 341].map(d => ({ buf: new Float32Array(d), idx: 0 }));
    this.damp = damp;
    this.wet = wet;
  }
  process(x) {
    let out = 0;
    for (const c of this.combs) {
      const y = c.buf[c.idx];
      c.store = y * (1 - this.damp) + c.store * this.damp;
      c.buf[c.idx] = x + c.store * 0.82;
      c.idx = (c.idx + 1) % c.buf.length;
      out += y;
    }
    out /= this.combs.length;
    for (const a of this.aps) {
      const y = a.buf[a.idx];
      a.buf[a.idx] = out + y * 0.5;
      a.idx = (a.idx + 1) % a.buf.length;
      out = y - out * 0.5;
    }
    return out;
  }
}

/* ==================================================================
   曲目构建
   ================================================================== */
class Builder {
  constructor(bpm, bars) {
    this.bpm = bpm;
    this.beat = 60 / bpm;
    this.bars = bars;
    this.dur = bars * 4 * this.beat;
    this.n = Math.ceil((this.dur + 3) * SR);
    this.dry = new Float32Array(this.n);
    this.send = new Float32Array(this.n);   // 送混响的信号
    this.kickEnv = new Float32Array(this.n); // 侧链包络
  }

  /** 渲染一个音符 */
  note(beatStart, beatLen, midi, opt = {}) {
    const {
      type = 'sine', amp = 0.2, attack = 0.006, decay = 0.12,
      sustain = 0.7, release = 0.2, detune = 0, pan = 0,
      lp = 8000, harm = 12, send = 0.15, glideFrom = null
    } = opt;

    const start = Math.floor(beatStart * this.beat * SR);
    const len = Math.floor(beatLen * this.beat * SR) + Math.floor(release * SR);
    const freq = noteFreq(midi);
    const f0 = glideFrom !== null ? noteFreq(glideFrom) : freq;
    const filter = new LowPass(lp);
    const maxH = Math.min(harm, Math.floor((SR / 2) / Math.max(40, freq)));

    const atk = Math.max(1, Math.floor(attack * SR));
    const dec = Math.max(1, Math.floor(decay * SR));
    const rel = Math.max(1, Math.floor(release * SR));
    const holdEnd = len - rel;

    const panL = Math.cos((pan + 1) * Math.PI / 4);
    const panR = Math.sin((pan + 1) * Math.PI / 4);

    let phase = 0;
    let phase2 = 0;

    for (let i = 0; i < len; i++) {
      const j = start + i;
      if (j >= this.n) break;

      // 包络
      let env;
      if (i < atk) env = i / atk;
      else if (i < atk + dec) env = 1 - (1 - sustain) * ((i - atk) / dec);
      else if (i < holdEnd) env = sustain;
      else env = sustain * Math.max(0, 1 - (i - holdEnd) / rel);

      // 音高滑音
      const t = i / len;
      const f = glideFrom !== null ? f0 + (freq - f0) * Math.min(1, t * 6) : freq;

      phase += f / SR;
      if (phase >= 1) phase -= Math.floor(phase);
      phase2 += (f * Math.pow(2, detune / 1200)) / SR;
      if (phase2 >= 1) phase2 -= Math.floor(phase2);

      let s = waveform(phase, type, maxH);
      if (detune) s = (s + waveform(phase2, type, maxH)) * 0.5;
      s = filter.process(s) * env * amp;

      // 轻微立体声扩散
      this.dry[j] += s * panL;
      this.send[j] += s * send;
    }
  }

  /** 底鼓 */
  kick(beatStart, opt = {}) {
    const { amp = 0.85, len = 0.42, send = 0.05, f0 = 135, f1 = 44 } = opt;
    const start = Math.floor(beatStart * this.beat * SR);
    const dur = Math.floor(len * SR);
    let phase = 0;
    for (let i = 0; i < dur; i++) {
      const j = start + i;
      if (j >= this.n) break;
      const t = i / SR;
      const p = i / dur;
      const f = f1 + (f0 - f1) * Math.exp(-t * 26);
      phase += f / SR;
      const env = Math.exp(-p * 5.2) * (1 - Math.exp(-t * 900));
      const click = Math.exp(-t * 260) * 0.22 * Math.sin(TAU * 1800 * t);
      const s = (Math.sin(TAU * phase) * env + click) * amp;
      this.dry[j] += s;
      this.send[j] += s * send;
      // 侧链包络（供 pad 使用）
      this.kickEnv[j] = Math.max(this.kickEnv[j], Math.exp(-p * 4.6));
    }
  }

  /** 军鼓 / 拍手 */
  snare(beatStart, opt = {}) {
    const { amp = 0.34, len = 0.26, tone = 195, send = 0.28, bright = 0.6 } = opt;
    const start = Math.floor(beatStart * this.beat * SR);
    const dur = Math.floor(len * SR);
    const hp = new LowPass(2600); // 用低通做差分得到高通
    let prev = 0;
    for (let i = 0; i < dur; i++) {
      const j = start + i;
      if (j >= this.n) break;
      const t = i / SR;
      const p = i / dur;
      const noise = Math.random() * 2 - 1;
      const hpv = noise - prev * 0.92;
      prev = noise;
      const nEnv = Math.exp(-p * 7.5);
      const body = Math.sin(TAU * tone * t) * Math.exp(-t * 22) * 0.6;
      const s = (hpv * nEnv * bright + body) * amp;
      this.dry[j] += s;
      this.send[j] += s * send;
    }
  }

  /** 踩镲 */
  hat(beatStart, opt = {}) {
    const { amp = 0.11, len = 0.055, send = 0.08 } = opt;
    const start = Math.floor(beatStart * this.beat * SR);
    const dur = Math.floor(len * SR);
    let prev = 0;
    for (let i = 0; i < dur; i++) {
      const j = start + i;
      if (j >= this.n) break;
      const p = i / dur;
      const noise = Math.random() * 2 - 1;
      const hpv = noise - prev;
      prev = noise;
      const s = hpv * Math.exp(-p * 9) * amp * 0.5;
      this.dry[j] += s;
      this.send[j] += s * send;
    }
  }

  /** 金属质感拍手 */
  clap(beatStart, opt = {}) {
    const { amp = 0.22, send = 0.3 } = opt;
    const offsets = [0, 0.009, 0.019, 0.031];
    for (const o of offsets) {
      const start = Math.floor((beatStart + o / this.beat) * this.beat * SR);
      const dur = Math.floor(0.09 * SR);
      let prev = 0;
      for (let i = 0; i < dur; i++) {
        const j = start + i;
        if (j >= this.n) break;
        const p = i / dur;
        const noise = Math.random() * 2 - 1;
        const hpv = noise - prev * 0.75;
        prev = noise;
        const s = hpv * Math.exp(-p * 5) * amp * 0.34;
        this.dry[j] += s;
        this.send[j] += s * send;
      }
    }
  }

  /** 加一层随底鼓起伏的侧链压缩到 pad 上，做出电子乐"呼吸感" */
  applySidechain(amount = 0.55) {
    for (let i = 0; i < this.n; i++) {
      const k = 1 - this.kickEnv[i] * amount;
      this.dry[i] *= k;
      this.send[i] *= k;
    }
  }

  /** 混音并输出左右声道 */
  render({ wet = 0.32, master = 0.9, width = 0.14 } = {}) {
    const revL = new Reverb({ wet });
    const revR = new Reverb({ wet });

    const L = new Float32Array(this.n);
    const R = new Float32Array(this.n);

    // 延迟（制造立体声宽度）
    const dL = Math.floor(0.011 * SR);
    const dR = Math.floor(0.017 * SR);

    for (let i = 0; i < this.n; i++) {
      const dryL = this.dry[i];
      const dryR = this.dry[i] * (1 - width) +
        (i > dR ? this.dry[i - dR] * width : 0);

      const wL = revL.process(this.send[i]);
      const wR = revR.process(this.send[i] * 0.97 + (i > dL ? this.send[i - dL] * 0.03 : 0));

      let l = dryL * 0.9 + wL * wet * 1.5;
      let r = dryR * 0.9 + wR * wet * 1.5;

      L[i] = softClip(l * master);
      R[i] = softClip(r * master);
    }

    // 淡入淡出
    const fadeIn = Math.floor(0.04 * SR);
    const fadeOut = Math.floor(1.6 * SR);
    for (let i = 0; i < fadeIn; i++) { const k = i / fadeIn; L[i] *= k; R[i] *= k; }
    for (let i = 0; i < fadeOut; i++) {
      const k = i / fadeOut;
      const j = this.n - 1 - i;
      if (j >= 0) { L[j] *= k; R[j] *= k; }
    }

    return { L, R };
  }
}

/* ==================================================================
   WAV 输出
   ================================================================== */
function writeWav(file, L, R, sr = SR) {
  const n = L.length;
  const bytes = n * 4;
  const buf = Buffer.alloc(44 + bytes);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);        // PCM
  buf.writeUInt16LE(2, 22);        // 立体声
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 4, 28);   // byte rate
  buf.writeUInt16LE(4, 32);        // block align
  buf.writeUInt16LE(16, 34);       // bits
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(bytes, 40);

  let off = 44;
  for (let i = 0; i < n; i++) {
    let l = Math.max(-1, Math.min(1, L[i]));
    let r = Math.max(-1, Math.min(1, R[i]));
    buf.writeInt16LE((l * 32767) | 0, off); off += 2;
    buf.writeInt16LE((r * 32767) | 0, off); off += 2;
  }
  fs.writeFileSync(file, buf);
  return buf.length;
}

/* ==================================================================
   曲目定义
   ================================================================== */

/* ---------- 1. Neon Drift · Lo-Fi House · 92 BPM ---------- */
function neonDrift() {
  const bpm = 92, bars = 16;
  const B = new Builder(bpm, bars);

  // Am7 - Fmaj7 - Cmaj7 - G6
  const prog = [
    { root: nm('A2'), notes: ['A3', 'C4', 'E4', 'G4'] },
    { root: nm('F2'), notes: ['F3', 'A3', 'C4', 'E4'] },
    { root: nm('C3'), notes: ['C4', 'E4', 'G4', 'B4'] },
    { root: nm('G2'), notes: ['G3', 'B3', 'D4', 'E4'] }
  ];

  for (let bar = 0; bar < bars; bar++) {
    const ch = prog[bar % 4];
    const b0 = bar * 4;

    // Pad：整小节铺底
    if (bar >= 1) {
      ch.notes.forEach((nstr, i) => {
        B.note(b0, 3.92, nm(nstr), {
          type: 'saw', amp: 0.052, attack: 0.5, decay: 0.6,
          sustain: 0.72, release: 0.9, lp: 1500 + i * 320,
          detune: i % 2 ? 7 : -5, pan: (i - 1.5) * 0.32, send: 0.38, harm: 6
        });
      });
    }

    // 贝斯
    const bassPat = [0, 0.75, 1.5, 2.5, 3.25];
    bassPat.forEach((t, i) => {
      B.note(b0 + t, i === 0 ? 0.7 : 0.34, ch.root + (i === 3 ? 12 : 0), {
        type: 'saw', amp: 0.2, attack: 0.008, decay: 0.16,
        sustain: 0.42, release: 0.1, lp: 300, send: 0.04, harm: 8
      });
    });

    // 鼓
    if (bar >= 2) {
      B.kick(b0 + 0); B.kick(b0 + 1.75); B.kick(b0 + 2.5);
      if (bar % 2 === 1) B.kick(b0 + 3.5);
      B.snare(b0 + 1, { amp: 0.2, bright: 0.42 });
      B.snare(b0 + 3, { amp: 0.22, bright: 0.45 });
      for (let h = 0; h < 8; h++) {
        if (h % 2 === 1) B.hat(b0 + h * 0.5, { amp: 0.07 + (h % 4 === 3 ? 0.03 : 0) });
      }
    } else if (bar === 1) {
      B.kick(b0 + 1.75); B.kick(b0 + 3.5);
    }

    // 旋律（琶音化，落在和弦音上）
    if (bar >= 4) {
      const mel = [2, 0, 1, 3, 2, 1, 0, 2];
      for (let i = 0; i < 6; i++) {
        const t = i * 0.62 + 0.3;
        if (t > 3.6) break;
        const nstr = ch.notes[mel[(i + bar) % mel.length]];
        B.note(b0 + t, 0.5, nm(nstr) + 12, {
          type: 'tri', amp: 0.075, attack: 0.004, decay: 0.3,
          sustain: 0.28, release: 0.5, lp: 4200,
          pan: Math.sin(i + bar) * 0.4, send: 0.55, harm: 8
        });
      }
    }
  }

  B.applySidechain(0.42);
  return B.render({ wet: 0.3, master: 0.92 });
}

/* ---------- 2. Velvet Rain · Chill Piano · 74 BPM ---------- */
function velvetRain() {
  const bpm = 74, bars = 12;
  const B = new Builder(bpm, bars);

  // Dm9 - Bbmaj7 - Gm7 - A7sus4
  const prog = [
    { root: nm('D2'), notes: ['D4', 'F4', 'A4', 'C5', 'E5'] },
    { root: nm('Bb1'), notes: ['Bb3', 'D4', 'F4', 'A4'] },
    { root: nm('G2'), notes: ['G3', 'Bb3', 'D4', 'F4'] },
    { root: nm('A2'), notes: ['A3', 'D4', 'E4', 'G4'] }
  ];

  for (let bar = 0; bar < bars; bar++) {
    const ch = prog[bar % 4];
    const b0 = bar * 4;

    // 弦乐 pad
    ch.notes.slice(0, 4).forEach((nstr, i) => {
      B.note(b0, 3.95, nm(nstr), {
        type: 'saw', amp: 0.042, attack: 0.9, decay: 0.8,
        sustain: 0.8, release: 1.4, lp: 1100 + i * 250,
        detune: i % 2 ? 9 : -7, pan: (i - 1.5) * 0.35, send: 0.55, harm: 5
      });
    });

    // 低音
    B.note(b0, 3.6, ch.root, {
      type: 'sine', amp: 0.26, attack: 0.02, decay: 0.5,
      sustain: 0.55, release: 0.6, lp: 240, send: 0.1, harm: 6
    });

    // 钢琴（分解和弦）
    if (bar >= 1) {
      const pat = [0, 2, 1, 3, 2, 4, 3, 1];
      pat.forEach((ni, i) => {
        const nstr = ch.notes[Math.min(ni, ch.notes.length - 1)];
        B.note(b0 + i * 0.5, 0.42, nm(nstr) + (i > 4 ? 12 : 0), {
          type: 'tri', amp: 0.11, attack: 0.003, decay: 0.55,
          sustain: 0.12, release: 0.7, lp: 3800,
          pan: Math.sin(i * 0.8) * 0.42, send: 0.6, harm: 10
        });
      });
    }

    // 轻鼓
    if (bar >= 3) {
      B.kick(b0 + 0, { amp: 0.5, len: 0.5, f0: 100, f1: 40 });
      B.kick(b0 + 2.5, { amp: 0.38, len: 0.45 });
      B.snare(b0 + 2, { amp: 0.12, bright: 0.28, len: 0.4, send: 0.5 });
      for (let h = 0; h < 4; h++) B.hat(b0 + h + 0.5, { amp: 0.035, len: 0.09 });
    }
  }

  B.applySidechain(0.3);
  return B.render({ wet: 0.42, master: 0.88 });
}

/* ---------- 3. Pulse Theory · Deep House · 124 BPM ---------- */
function pulseTheory() {
  const bpm = 124, bars = 20;
  const B = new Builder(bpm, bars);

  // F#m - D - A - E
  const prog = [
    { root: nm('F#2'), notes: ['F#3', 'A3', 'C#4', 'E4'] },
    { root: nm('D2'), notes: ['D3', 'F#3', 'A3', 'C#4'] },
    { root: nm('A2'), notes: ['A3', 'C#4', 'E4', 'G4'] },
    { root: nm('E2'), notes: ['E3', 'G#3', 'B3', 'D4'] }
  ];

  for (let bar = 0; bar < bars; bar++) {
    const ch = prog[bar % 4];
    const b0 = bar * 4;

    // 侧链 pad
    if (bar >= 2) {
      ch.notes.forEach((nstr, i) => {
        B.note(b0, 3.9, nm(nstr), {
          type: 'saw', amp: 0.045, attack: 0.03, decay: 0.2,
          sustain: 0.85, release: 0.35, lp: 2200 + i * 400,
          detune: i % 2 ? 11 : -9, pan: (i - 1.5) * 0.38, send: 0.3, harm: 7
        });
      });
    }

    // 律动贝斯
    if (bar >= 1) {
      const pat = [0.5, 1.0, 1.75, 2.5, 3.0, 3.5];
      pat.forEach((t, i) => {
        B.note(b0 + t, 0.22, ch.root + (i === 4 ? 12 : 0), {
          type: 'saw', amp: 0.24, attack: 0.004, decay: 0.09,
          sustain: 0.3, release: 0.08, lp: 420, send: 0.03, harm: 9
        });
      });
    }

    // 四拍 kick
    if (bar >= 1) {
      for (let k = 0; k < 4; k++) B.kick(b0 + k, { amp: 0.92, len: 0.36 });
      B.clap(b0 + 1, { amp: 0.26 });
      B.clap(b0 + 3, { amp: 0.28 });
      for (let h = 0; h < 16; h++) {
        B.hat(b0 + h * 0.25, { amp: h % 4 === 2 ? 0.085 : 0.04, len: 0.045 });
      }
    }

    // 16 分琶音
    if (bar >= 4) {
      for (let i = 0; i < 16; i++) {
        const ni = [0, 1, 2, 3, 2, 3, 1, 2][i % 8];
        B.note(b0 + i * 0.25, 0.16, nm(ch.notes[ni]) + 12, {
          type: 'square', amp: 0.035, attack: 0.002, decay: 0.1,
          sustain: 0.06, release: 0.16, lp: 5200,
          pan: Math.sin(i * 1.1) * 0.55, send: 0.42, harm: 5
        });
      }
    }
  }

  B.applySidechain(0.7);
  return B.render({ wet: 0.26, master: 0.95 });
}

/* ---------- 4. Midnight Bloom · Ambient · 68 BPM ---------- */
function midnightBloom() {
  const bpm = 68, bars = 10;
  const B = new Builder(bpm, bars);

  // Cm9 - Abmaj7 - Ebmaj7 - Bb
  const prog = [
    { notes: ['C3', 'Eb3', 'G3', 'Bb3', 'D4'] },
    { notes: ['Ab2', 'C3', 'Eb3', 'G3', 'Bb3'] },
    { notes: ['Eb3', 'G3', 'Bb3', 'D4', 'F4'] },
    { notes: ['Bb2', 'D3', 'F3', 'A3', 'C4'] }
  ];

  for (let bar = 0; bar < bars; bar++) {
    const ch = prog[bar % 4];
    const b0 = bar * 4;

    // 厚 pad
    ch.notes.forEach((nstr, i) => {
      B.note(b0, 3.9, nm(nstr), {
        type: 'saw', amp: 0.05, attack: 1.2, decay: 1.0,
        sustain: 0.86, release: 2.0, lp: 900 + i * 220,
        detune: i % 2 ? 12 : -8, pan: (i - 2) * 0.28, send: 0.72, harm: 4
      });
    });

    // 低音
    B.note(b0, 3.8, nm(ch.notes[0]), {
      type: 'sine', amp: 0.2, attack: 0.4, decay: 0.6,
      sustain: 0.6, release: 1.2, lp: 200, send: 0.3, harm: 4
    });

    // 风铃般的点状音
    if (bar >= 1) {
      const sparkle = [0, 2, 4];
      sparkle.forEach((ni, i) => {
        const t = i * 1.35 + (bar % 2) * 0.6;
        B.note(b0 + t, 0.9, nm(ch.notes[Math.min(ni, ch.notes.length - 1)]) + 24, {
          type: 'sine', amp: 0.06, attack: 0.01, decay: 1.1,
          sustain: 0.02, release: 1.6, lp: 7000,
          pan: Math.cos(i * 2.1) * 0.65, send: 0.85, harm: 3
        });
      });
    }

    // 很远的心跳感底鼓
    if (bar >= 3) {
      B.kick(b0 + 0, { amp: 0.4, len: 0.6, f0: 85, f1: 34, send: 0.3 });
      B.kick(b0 + 2.5, { amp: 0.18, len: 0.5, f0: 80, f1: 32, send: 0.3 });
    }
  }

  B.applySidechain(0.25);
  return B.render({ wet: 0.5, master: 0.85 });
}

/* ==================================================================
   歌词
   ================================================================== */

const LYRICS = {
  'Neon Drift': `[ti:Neon Drift]
[ar:Aurora Lab]
[al:Midnight Circuit]
[by:Aurora Player]
[00:00.00]♪
[00:03.20]霓虹在窗上流动
[00:07.60]像没写完的信
[00:11.90]把音量再推高一点
[00:16.20]让城市慢下来
[00:20.60]我们都在寻找
[00:24.90]一段能停留的频率
[00:29.30]在夜色里漂移
[00:33.60]不问去向
[00:37.90]♪
[00:46.50]让节拍替我们说话
[00:50.90]让光替我们记得
[00:55.20]这一秒的温柔
[00:59.60]足够撑到天亮`,

  'Velvet Rain': `[ti:Velvet Rain]
[ar:Aurora Lab]
[al:Midnight Circuit]
[by:Aurora Player]
[00:00.00]♪
[00:04.80]雨落在铁皮屋檐
[00:10.20]像谁在轻轻数拍子
[00:15.60]天鹅绒一样的夜色
[00:21.00]把心事都吸走了
[00:26.40]你说过雨停就走
[00:31.80]可雨一直没有停
[00:37.20]♪
[00:46.80]钢琴在角落里醒着
[00:52.20]替我保管那些句子
[00:57.60]如果明天还是阴天
[01:03.00]就把这首再放一遍`,

  'Pulse Theory': `[ti:Pulse Theory]
[ar:Aurora Lab]
[al:Midnight Circuit]
[by:Aurora Player]
[00:00.00]♪
[00:01.94]四是这个世界的单位
[00:03.87]心跳对齐了低频
[00:05.81]把所有杂音关掉
[00:07.74]只留下一件事
[00:09.68]振动
[00:11.61]振动
[00:13.55]振动
[00:15.48]让地板传递它
[00:17.42]让空气记住它
[00:19.35]我们不需要语言
[00:21.29]只需要这一下
[00:23.23]↓
[00:27.10]↓
[00:31.00]↓
[00:35.00]让脉冲继续
[00:38.90]让脉冲继续`,

  'Midnight Bloom': `[ti:Midnight Bloom]
[ar:Aurora Lab]
[al:Midnight Circuit]
[by:Aurora Player]
[00:00.00]♪
[00:07.06]午夜三点开出一朵花
[00:14.12]没有人看见也没关系
[00:21.18]它开在自己的时区里
[00:28.24]不需要谁的许可
[00:35.30]♪
[00:42.36]光很慢 风也很慢
[00:49.42]连呼吸都放轻了
[00:56.48]如果你也醒着
[01:03.54]就一起安静一会儿`
};

/* ==================================================================
   主流程
   ================================================================== */
const TRACKS = [
  { name: 'Neon Drift', artist: 'Aurora Lab', album: 'Midnight Circuit', style: 'Lo-Fi House · 92 BPM', gen: neonDrift },
  { name: 'Velvet Rain', artist: 'Aurora Lab', album: 'Midnight Circuit', style: 'Chill Piano · 74 BPM', gen: velvetRain },
  { name: 'Pulse Theory', artist: 'Aurora Lab', album: 'Midnight Circuit', style: 'Deep House · 124 BPM', gen: pulseTheory },
  { name: 'Midnight Bloom', artist: 'Aurora Lab', album: 'Midnight Circuit', style: 'Ambient · 68 BPM', gen: midnightBloom }
];

function main() {
  const outDir = path.join(__dirname, '..', 'demo');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  for (const t of TRACKS) {
    const t0 = Date.now();
    process.stdout.write(`生成 ${t.name} (${t.style}) ... `);
    const { L, R } = t.gen();
    const wavPath = path.join(outDir, `${t.name}.wav`);
    const size = writeWav(wavPath, L, R);

    const lrcPath = path.join(outDir, `${t.name}.lrc`);
    fs.writeFileSync(lrcPath, LYRICS[t.name] || '', 'utf8');

    console.log(`完成 ${(size / 1048576).toFixed(1)}MB / ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // 专辑元数据（播放器会读取目录下的 album.json 覆盖标签信息）
  const albumJson = {
    artist: 'Aurora Lab',
    albumArtist: 'Aurora Lab',
    album: 'Midnight Circuit',
    year: '2026',
    tracks: {}
  };
  for (const t of TRACKS) {
    albumJson.tracks[`${t.name}.wav`] = {
      title: t.name, artist: t.artist, album: t.album, year: '2026'
    };
  }
  fs.writeFileSync(path.join(outDir, 'album.json'), JSON.stringify(albumJson, null, 2), 'utf8');

  // 专辑信息文件
  fs.writeFileSync(path.join(outDir, 'README.txt'),
    '这些音频由 tools/gen-demo.js 纯数学合成，用于演示播放器的 3D 封面与律动光效，可自由删除。\n' +
    `生成时间：${new Date().toLocaleString('zh-CN')}\n`, 'utf8');

  console.log('\n演示音乐已输出到:', outDir);
}

main();
