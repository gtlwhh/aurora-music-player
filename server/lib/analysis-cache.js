'use strict';
/**
 * 歌曲能量分析结果缓存
 *
 * 落盘位置：data/cache/analysis/{trackId}.json
 * trackId 由前端用「音源 + 音源内歌曲 ID」生成，稳定不变；
 * 这里只做文件名安全化和读写，不参与 ID 生成。
 */

const fs = require('fs');
const path = require('path');

const { fileInData } = require('./paths');
const CACHE_DIR = fileInData('cache', 'analysis');

/** 去掉文件名非法字符 */
function safeName(trackId) {
  return String(trackId).replace(/[\\/:*?"<>|]/g, '_');
}

/**
 * 同一个曲目在不同版本里出现过多种 id 写法：
 *   netease_123 / netease:123 / netease-123 / netease--123（老版本写下的缓存）
 * 缓存文件名只取决于写入时的写法，所以读取时要把这些写法都试一遍，
 * 否则 BPM / 能量曲线会大面积"查不到"（表现为智能过渡不触发、推荐不做节奏定向）。
 */
function keyVariants(trackId) {
  const s = String(trackId || '');
  const out = new Set([s]);
  const compact = s.replace(/[:_\-]+/g, '');
  const m = compact.match(/^(netease|qq|local)(.+)$/i);
  if (m) {
    const [, pf, rest] = m;
    ['_', '-', '--', ':'].forEach(sep => out.add(`${pf}${sep}${rest}`));
  }
  return [...out];
}

function fileFor(trackId) {
  return path.join(CACHE_DIR, safeName(trackId) + '.json');
}

function read(trackId) {
  for (const key of keyVariants(trackId)) {
    try {
      const f = fileFor(key);
      if (fs.existsSync(f)) {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
      }
    } catch (err) {
      console.warn('[analysis] 读取缓存失败:', err.message);
    }
  }
  return null;
}

function write(trackId, data) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(fileFor(trackId), JSON.stringify(data), 'utf8');
    return true;
  } catch (err) {
    console.warn('[analysis] 写入缓存失败:', err.message);
    return false;
  }
}

module.exports = { read, write, CACHE_DIR, safeName };
