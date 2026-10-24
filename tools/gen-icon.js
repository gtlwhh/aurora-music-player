'use strict';
/**
 * 应用图标生成器
 * 纯像素绘制 + 手写 PNG / ICO 编码，零第三方依赖。
 * 输出：build/icon.png（512）、build/icon.ico（256，内嵌 PNG）
 *
 * 运行：node tools/gen-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------- PNG 编码 ---------------- */
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
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** ICO 容器（内嵌 PNG，Windows Vista 以上支持） */
function encodeICO(pngBuffers) {
  const count = pngBuffers.length;
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + 16 * count;
  for (const { png, size } of pngBuffers) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32BE(0, 8);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }

  return Buffer.concat([dir, ...entries, ...pngBuffers.map(p => p.png)]);
}

/* ---------------- 绘制 ---------------- */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

/** 圆角矩形 SDF（负值在内部） */
function roundRectSDF(x, y, cx, cy, w, h, r) {
  const dx = Math.abs(x - cx) - w / 2 + r;
  const dy = Math.abs(y - cy) - h / 2 + r;
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(dx, dy), 0) - r;
}

function hex(h) {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function drawIcon(size) {
  const S = size;
  const rgba = Buffer.alloc(S * S * 4);

  const pad = S * 0.035;
  const radius = S * 0.235;
  const cx = S / 2, cy = S / 2;
  const boxW = S - pad * 2;
  const boxH = S - pad * 2;

  const c1 = hex('#8b7bff');
  const c2 = hex('#4b3fd6');
  const c3 = hex('#2fd0b4');

  // 声波条：4 根，中间高两边低
  const bars = [
    { x: 0.335, h: 0.30, w: 0.062 },
    { x: 0.445, h: 0.46, w: 0.062 },
    { x: 0.555, h: 0.38, w: 0.062 },
    { x: 0.665, h: 0.24, w: 0.062 }
  ];

  const aa = 1.35 / S; // 抗锯齿宽度（相对）

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;

      // 圆角底板
      const d = roundRectSDF(x + 0.5, y + 0.5, cx, cy, boxW, boxH, radius);
      const alpha = 1 - smoothstep(-0.5, 0.9, d);
      if (alpha <= 0.004) { rgba[i + 3] = 0; continue; }

      // 对角渐变
      const t = clamp01((x / S) * 0.45 + (y / S) * 0.55);
      let r, g, b;
      if (t < 0.55) {
        const k = t / 0.55;
        r = mix(c1[0], c2[0], k); g = mix(c1[1], c2[1], k); b = mix(c1[2], c2[2], k);
      } else {
        const k = (t - 0.55) / 0.45;
        r = mix(c2[0], c3[0], k); g = mix(c2[1], c3[1], k); b = mix(c2[2], c3[2], k);
      }

      // 左上高光
      const hx = (x / S - 0.28), hy = (y / S - 0.22);
      const hl = Math.max(0, 1 - Math.sqrt(hx * hx + hy * hy) / 0.55);
      r = mix(r, 255, hl * 0.22);
      g = mix(g, 255, hl * 0.22);
      b = mix(b, 255, hl * 0.22);

      // 声波条
      let barA = 0;
      for (const bar of bars) {
        const bx = bar.x * S;
        const bw = bar.w * S;
        const bh = bar.h * S;
        const bd = roundRectSDF(x + 0.5, y + 0.5, bx, cy, bw, bh, bw / 2);
        barA = Math.max(barA, 1 - smoothstep(-0.4, 0.7, bd));
      }
      if (barA > 0) {
        r = mix(r, 255, barA);
        g = mix(g, 255, barA);
        b = mix(b, 255, barA);
      }

      // 边缘细微内描边，增加精致度
      const rim = 1 - smoothstep(0, 2.2 / S * S * 0.0055, Math.abs(d + 1.2));
      if (rim > 0) {
        r = mix(r, 255, rim * 0.16);
        g = mix(g, 255, rim * 0.16);
        b = mix(b, 255, rim * 0.16);
      }

      rgba[i] = Math.round(clamp01(r / 255) * 255);
      rgba[i + 1] = Math.round(clamp01(g / 255) * 255);
      rgba[i + 2] = Math.round(clamp01(b / 255) * 255);
      rgba[i + 3] = Math.round(clamp01(alpha) * 255);
    }
  }
  return rgba;
}

/* ---------------- 输出 ---------------- */
function main() {
  const outDir = path.join(__dirname, '..', 'build');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const sizes = [256, 128, 64, 48, 32, 16];
  const pngs = [];

  for (const size of sizes) {
    process.stdout.write(`绘制 ${size}×${size} ... `);
    const rgba = drawIcon(size);
    const png = encodePNG(rgba, size, size);
    pngs.push({ png, size });
    console.log('ok');

    if (size === 256) {
      fs.writeFileSync(path.join(outDir, 'icon.png'), png);
    }
  }

  fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeICO(pngs));
  console.log('\n图标已输出到:', outDir);
}

main();
