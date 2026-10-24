'use strict';
/**
 * 演示专辑封面生成器
 *
 * 纯像素级绘制 + 手写 PNG 编码（zlib 是 Node 内置），零第三方依赖。
 * 为 4 首演示曲各生成一张 800×800 的抽象封面，风格统一在同一张专辑的视觉语言下。
 *
 * 运行：node tools/gen-covers.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 800;

/* ==================================================================
   PNG 编码
   ================================================================== */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** rgba: Buffer(w*h*4) → PNG 文件 */
function encodePNG(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ==================================================================
   绘制工具
   ================================================================== */
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

function makeCanvas(w, h) {
  return { w, h, data: new Float32Array(w * h * 3) };
}

/** 叠加颜色（alpha 混合） */
function blend(cv, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= cv.w || y >= cv.h || a <= 0) return;
  const i = (y * cv.w + x) * 3;
  const k = clamp01(a);
  cv.data[i] = cv.data[i] * (1 - k) + r * k;
  cv.data[i + 1] = cv.data[i + 1] * (1 - k) + g * k;
  cv.data[i + 2] = cv.data[i + 2] * (1 - k) + b * k;
}

function hex(h) {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 伪随机（可复现） */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** 垂直/对角渐变填充背景 */
function fillGradient(cv, stops, angle = Math.PI / 2) {
  const { w, h } = cv;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x / w - 0.5) * cos + (y / h - 0.5) * sin + 0.5;
      const t = clamp01(nx);
      // 找到区间
      let c0 = stops[0], c1 = stops[stops.length - 1];
      for (let i = 0; i < stops.length - 1; i++) {
        if (t >= stops[i][0] && t <= stops[i + 1][0]) { c0 = stops[i]; c1 = stops[i + 1]; break; }
      }
      const span = Math.max(1e-6, c1[0] - c0[0]);
      const k = clamp01((t - c0[0]) / span);
      const i = (y * w + x) * 3;
      cv.data[i] = lerp(c0[1], c1[1], k);
      cv.data[i + 1] = lerp(c0[2], c1[2], k);
      cv.data[i + 2] = lerp(c0[3], c1[3], k);
    }
  }
}

/** 径向光斑 */
function radialGlow(cv, cx, cy, radius, color, strength = 1, falloff = 2) {
  const { w, h } = cv;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(w - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(h - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / radius;
      const dy = (y - cy) / radius;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 1) continue;
      const a = Math.pow(1 - d, falloff) * strength;
      blend(cv, x, y, color[0], color[1], color[2], a);
    }
  }
}

/** 抗锯齿圆环 */
function ring(cv, cx, cy, radius, thickness, color, alpha) {
  const { w, h } = cv;
  const outer = radius + thickness / 2 + 1;
  const x0 = Math.max(0, Math.floor(cx - outer));
  const x1 = Math.min(w - 1, Math.ceil(cx + outer));
  const y0 = Math.max(0, Math.floor(cy - outer));
  const y1 = Math.min(h - 1, Math.ceil(cy + outer));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const edge = 1 - smoothstep(thickness / 2 - 1.2, thickness / 2 + 1.2, Math.abs(d - radius));
      if (edge <= 0) continue;
      blend(cv, x, y, color[0], color[1], color[2], alpha * edge);
    }
  }
}

/** 加颗粒噪点 */
function grain(cv, amount = 0.03, seed = 1) {
  const rand = rng(seed);
  for (let i = 0; i < cv.data.length; i += 3) {
    const n = (rand() - 0.5) * amount * 255;
    cv.data[i] += n;
    cv.data[i + 1] += n;
    cv.data[i + 2] += n;
  }
}

/** 暗角 */
function vignette(cv, strength = 0.55) {
  const { w, h } = cv;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x / w - 0.5) * 2;
      const dy = (y / h - 0.5) * 2;
      const d = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;
      const k = 1 - smoothstep(0.45, 1.05, d) * strength;
      const i = (y * w + x) * 3;
      cv.data[i] *= k;
      cv.data[i + 1] *= k;
      cv.data[i + 2] *= k;
    }
  }
}

/** 输出 */
function writePNG(cv, file) {
  const { w, h } = cv;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0, j = 0; i < cv.data.length; i += 3, j += 4) {
    rgba[j] = clamp01(cv.data[i] / 255) * 255;
    rgba[j + 1] = clamp01(cv.data[i + 1] / 255) * 255;
    rgba[j + 2] = clamp01(cv.data[i + 2] / 255) * 255;
    rgba[j + 3] = 255;
  }
  fs.writeFileSync(file, encodePNG(rgba, w, h));
}

/* ==================================================================
   1. Neon Drift —— 霓虹光带
   ================================================================== */
function coverNeonDrift() {
  const cv = makeCanvas(SIZE, SIZE);
  fillGradient(cv, [
    [0.0, 12, 10, 26],
    [0.42, 30, 20, 62],
    [0.72, 18, 16, 44],
    [1.0, 8, 8, 18]
  ], Math.PI / 2 + 0.35);

  const cy0 = SIZE * 0.5;

  // 多条被正弦扰动的发光长条
  const bands = 22;
  for (let b = 0; b < bands; b++) {
    const t = b / (bands - 1);
    const baseY = cy0 + (t - 0.5) * SIZE * 1.05;
    const amp = 26 + Math.sin(b * 1.7) * 34;
    const phase = b * 0.85;
    const thick = 1.2 + Math.pow(Math.abs(Math.sin(b * 0.6)), 6) * 7;

    // 颜色：紫 → 品红 → 青
    const hueT = t;
    const c1 = hex('#7c6cff'), c2 = hex('#ff5fa2'), c3 = hex('#35d0ba');
    let col;
    if (hueT < 0.5) {
      const k = hueT / 0.5;
      col = [lerp(c1[0], c2[0], k), lerp(c1[1], c2[1], k), lerp(c1[2], c2[2], k)];
    } else {
      const k = (hueT - 0.5) / 0.5;
      col = [lerp(c2[0], c3[0], k), lerp(c2[1], c3[1], k), lerp(c2[2], c3[2], k)];
    }

    const alpha = 0.1 + Math.pow(Math.abs(Math.sin(b * 1.3)), 3) * 0.4;

    for (let x = 0; x < SIZE; x++) {
      const nx = x / SIZE;
      const y = baseY
        + Math.sin(nx * Math.PI * 2.2 + phase) * amp
        + Math.sin(nx * Math.PI * 6.5 + phase * 2) * amp * 0.22;

      // 中间亮两头暗
      const fade = Math.pow(Math.sin(nx * Math.PI), 0.6);
      for (let dy = -thick; dy <= thick; dy += 0.4) {
        const fall = 1 - Math.abs(dy) / thick;
        blend(cv, Math.round(x), Math.round(y + dy), col[0], col[1], col[2],
          alpha * fade * fall * fall * 0.5);
      }
    }
  }

  radialGlow(cv, SIZE * 0.5, SIZE * 0.5, SIZE * 0.62, [90, 70, 200], 0.28, 2.4);
  radialGlow(cv, SIZE * 0.72, SIZE * 0.34, SIZE * 0.3, [255, 95, 162], 0.16, 2.6);
  radialGlow(cv, SIZE * 0.28, SIZE * 0.68, SIZE * 0.3, [53, 208, 186], 0.13, 2.6);

  grain(cv, 0.022, 7);
  vignette(cv, 0.5);
  return cv;
}

/* ==================================================================
   2. Velvet Rain —— 天鹅绒雨
   ================================================================== */
function coverVelvetRain() {
  const cv = makeCanvas(SIZE, SIZE);
  fillGradient(cv, [
    [0.0, 10, 14, 32],
    [0.38, 22, 30, 66],
    [0.68, 14, 20, 46],
    [1.0, 5, 7, 18]
  ], Math.PI / 2);

  const rand = rng(2024);

  // 大块柔光
  radialGlow(cv, SIZE * 0.36, SIZE * 0.3, SIZE * 0.55, [70, 90, 190], 0.3, 2.2);
  radialGlow(cv, SIZE * 0.7, SIZE * 0.66, SIZE * 0.45, [120, 80, 200], 0.2, 2.4);

  // 雨丝
  for (let i = 0; i < 520; i++) {
    const x = Math.floor(rand() * SIZE);
    const y0 = rand() * SIZE;
    const len = 12 + rand() * 90;
    const bright = 0.05 + rand() * 0.3;
    const tilt = 0.09 + rand() * 0.05;
    for (let k = 0; k < len; k++) {
      const yy = Math.round(y0 + k);
      const xx = Math.round(x + k * tilt);
      if (yy >= SIZE || xx >= SIZE) break;
      const fade = 1 - k / len;
      blend(cv, xx, yy, 190, 210, 255, bright * fade * 0.5);
    }
  }

  // 玻璃上的水珠（模糊圆斑）
  for (let i = 0; i < 42; i++) {
    const cx = rand() * SIZE;
    const cy = rand() * SIZE;
    const r = 3 + rand() * 11;
    radialGlow(cv, cx, cy, r, [180, 200, 255], 0.1 + rand() * 0.14, 1.6);
    radialGlow(cv, cx - r * 0.2, cy - r * 0.25, r * 0.35, [255, 255, 255], 0.16, 1.4);
  }

  // 底部一条暖光，像台灯
  radialGlow(cv, SIZE * 0.5, SIZE * 0.94, SIZE * 0.5, [255, 170, 120], 0.14, 2.8);

  grain(cv, 0.028, 11);
  vignette(cv, 0.58);
  return cv;
}

/* ==================================================================
   3. Pulse Theory —— 脉冲同心环
   ================================================================== */
function coverPulseTheory() {
  const cv = makeCanvas(SIZE, SIZE);
  fillGradient(cv, [
    [0.0, 8, 9, 16],
    [0.5, 12, 12, 24],
    [1.0, 5, 5, 10]
  ], Math.PI / 2);

  const cx = SIZE * 0.5;
  const cy = SIZE * 0.5;

  // 背景细网格
  for (let g = 0; g <= 40; g++) {
    const p = Math.round((g / 40) * SIZE);
    for (let k = 0; k < SIZE; k++) {
      blend(cv, p, k, 120, 140, 200, 0.022);
      blend(cv, k, p, 120, 140, 200, 0.022);
    }
  }

  // 中心辉光
  radialGlow(cv, cx, cy, SIZE * 0.52, [124, 108, 255], 0.5, 2.0);
  radialGlow(cv, cx, cy, SIZE * 0.14, [255, 255, 255], 0.55, 2.4);

  // 脉冲环：越往外越细越暗
  const rings = 26;
  for (let i = 0; i < rings; i++) {
    const t = i / rings;
    const r = SIZE * (0.045 + Math.pow(t, 1.28) * 0.62);
    const th = lerp(9, 0.9, Math.pow(t, 0.75));
    const a = lerp(0.62, 0.07, Math.pow(t, 0.7));
    // 主环
    ring(cv, cx, cy, r, th, [200, 195, 255], a);
    // 每个环外面再套一圈淡的，形成"回声"
    if (i % 3 === 0) ring(cv, cx, cy, r + th * 1.8, th * 0.5, [124, 108, 255], a * 0.42);
  }

  // 十字准线
  for (let k = 0; k < SIZE; k++) {
    const a = 0.1 * (1 - Math.abs(k / SIZE - 0.5) * 1.6);
    if (a > 0) {
      blend(cv, k, cy, 180, 190, 255, a * 0.5);
      blend(cv, cx, k, 180, 190, 255, a * 0.5);
    }
  }

  // 四角刻度
  const corners = [[cx, cy - SIZE * 0.34], [cx, cy + SIZE * 0.34], [cx - SIZE * 0.34, cy], [cx + SIZE * 0.34, cy]];
  for (const [x, y] of corners) {
    radialGlow(cv, x, y, 16, [53, 208, 186], 0.6, 2);
  }

  grain(cv, 0.02, 23);
  vignette(cv, 0.62);
  return cv;
}

/* ==================================================================
   4. Midnight Bloom —— 午夜花
   ================================================================== */
function coverMidnightBloom() {
  const cv = makeCanvas(SIZE, SIZE);
  fillGradient(cv, [
    [0.0, 6, 12, 20],
    [0.4, 10, 22, 34],
    [0.75, 8, 14, 28],
    [1.0, 4, 6, 12]
  ], Math.PI / 2 + 0.2);

  const cx = SIZE * 0.5;
  const cy = SIZE * 0.52;

  // 底部幽光
  radialGlow(cv, cx, SIZE * 0.9, SIZE * 0.6, [40, 120, 130], 0.22, 2.6);

  // 层叠花瓣：用 sin(nθ) 调制半径
  const layers = [
    { petals: 6, r: 0.30, rot: 0.0, col: [110, 90, 220], a: 0.30, w: 1.9 },
    { petals: 8, r: 0.36, rot: 0.4, col: [150, 100, 230], a: 0.24, w: 2.4 },
    { petals: 5, r: 0.22, rot: 1.1, col: [80, 190, 190], a: 0.26, w: 1.5 },
    { petals: 10, r: 0.44, rot: 0.8, col: [60, 90, 180], a: 0.16, w: 3.0 }
  ];

  for (const L of layers) {
    const R = SIZE * L.r;
    for (let ang = 0; ang < Math.PI * 2; ang += 0.0022) {
      const mod = 0.62 + 0.38 * Math.abs(Math.sin(ang * L.petals / 2 + L.rot));
      const rr = R * mod;
      const x = cx + Math.cos(ang) * rr;
      const y = cy + Math.sin(ang) * rr;
      // 花瓣边缘羽化
      for (let d = -L.w; d <= L.w; d += 0.5) {
        const fall = 1 - Math.abs(d) / L.w;
        const px = Math.round(x + Math.cos(ang) * d);
        const py = Math.round(y + Math.sin(ang) * d);
        blend(cv, px, py, L.col[0], L.col[1], L.col[2], L.a * fall * 0.55);
      }
    }
  }

  // 花心
  radialGlow(cv, cx, cy, SIZE * 0.19, [200, 220, 255], 0.34, 2.2);
  radialGlow(cv, cx, cy, SIZE * 0.055, [255, 255, 255], 0.72, 2.6);

  // 飘散的光点
  const rand = rng(555);
  for (let i = 0; i < 130; i++) {
    const a = rand() * Math.PI * 2;
    const r = SIZE * (0.18 + rand() * 0.42);
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r * 0.95;
    const s = 1 + rand() * 3.2;
    radialGlow(cv, x, y, s * 3, [180, 220, 255], 0.1 + rand() * 0.35, 2);
  }

  grain(cv, 0.024, 91);
  vignette(cv, 0.6);
  return cv;
}

/* ==================================================================
   主流程
   ================================================================== */
const COVERS = [
  ['Neon Drift', coverNeonDrift],
  ['Velvet Rain', coverVelvetRain],
  ['Pulse Theory', coverPulseTheory],
  ['Midnight Bloom', coverMidnightBloom]
];

function main() {
  const outDir = path.join(__dirname, '..', 'demo');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  for (const [name, fn] of COVERS) {
    const t0 = Date.now();
    process.stdout.write(`绘制 ${name} 封面 ... `);
    const cv = fn();
    const file = path.join(outDir, `${name}.png`);
    writePNG(cv, file);
    console.log(`完成 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  console.log('\n封面已输出到:', outDir);
}

main();
