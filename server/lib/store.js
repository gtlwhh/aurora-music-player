'use strict';
/**
 * 配置持久化：保存在 data/settings.json
 */

const fs = require('fs');
const path = require('path');

const { DATA_DIR, ensureDataDir } = require('./paths');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  // 本地音乐目录（可多个）
  musicDirs: [],
  // 网易云 API 服务地址，例如 http://127.0.0.1:3000
  neteaseBaseUrl: '',
  // 网易云登录 Cookie（MUSIC_U=...）
  neteaseCookie: '',
  // 默认音质档位：standard / higher / exhigh / lossless / hires
  neteaseLevel: 'exhigh',
  // 播放器偏好
  ui: {
    glowEnabled: true,
    autoRotate: false,
    volume: 0.8
  },
  // 上次播放
  lastTrackId: '',
  lastPosition: 0
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!patch || typeof patch !== 'object') return out;
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

let cache = null;

function read() {
  if (cache) return cache;
  ensureDir();
  let stored = {};
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (_) { stored = {}; }
  cache = deepMerge(DEFAULTS, stored);
  return cache;
}

function write(patch) {
  const current = read();
  const next = deepMerge(current, patch);
  cache = next;
  ensureDir();
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.error('[settings] 写入失败:', err.message);
  }
  return next;
}

module.exports = { read, write, DATA_DIR, SETTINGS_FILE };
