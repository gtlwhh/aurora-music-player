'use strict';
/**
 * 目录扫描器：递归扫描音乐文件夹，构建曲库索引
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isAudio, readTags, readSidecarLyric, hasSidecarCover } = require('./audio-meta');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '$RECYCLE.BIN', 'System Volume Information',
  'AppData', 'Windows', 'Program Files', 'Program Files (x86)'
]);

/** 用绝对路径生成稳定 id */
function makeId(filePath) {
  return crypto.createHash('md5').update(filePath.toLowerCase()).digest('hex').slice(0, 16);
}

/** 播放源 id（对应 providers） */
function makeSourceId(provider, key) {
  return `${provider}:${key}`;
}

/**
 * 读取目录级元数据覆盖文件 album.json
 * 支持两种写法：
 *   { "artist": "...", "album": "...", "tracks": { "文件.wav": {...} } }
 *   { "文件.wav": { "title": "...", "artist": "..." } }
 */
function readAlbumMeta(dir) {
  const file = path.join(dir, 'album.json');
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(raw);
    return json && typeof json === 'object' ? json : null;
  } catch (_) {
    return null;
  }
}

/**
 * 扫描单个目录
 * @param {string} root 根目录
 * @param {object} opt { maxFiles, maxDepth }
 * @returns {Array} 曲目数组
 */
function scanDir(root, opt = {}) {
  const maxFiles = opt.maxFiles || 20000;
  const maxDepth = opt.maxDepth || 12;
  const results = [];
  const visited = new Set(); // 防止符号链接环路

  const walk = (dir, depth) => {
    if (results.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) { return; }

    // 目录级元数据覆盖（可选）
    const albumMeta = readAlbumMeta(dir);
    const dirDefaults = albumMeta ? {
      artist: albumMeta.artist,
      album: albumMeta.album,
      albumArtist: albumMeta.albumArtist,
      year: albumMeta.year
    } : {};

    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const name = entry.name;
      if (name.startsWith('.') && name !== '.') continue;

      let full;
      try {
        full = path.join(dir, name);
      } catch (_) { continue; }

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = fs.statSync(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch (_) { continue; }
      }

      if (isDir) {
        if (SKIP_DIRS.has(name)) continue;
        let real = full;
        try { real = fs.realpathSync(full); } catch (_) {}
        if (visited.has(real)) continue;
        visited.add(real);
        walk(full, depth + 1);
      } else if (isFile && isAudio(name)) {
        try {
          const st = fs.statSync(full);
          if (st.size < 1024) continue; // 跳过空/损坏文件
          const tag = readTags(full) || {};
          const base = path.basename(name, path.extname(name));

          // album.json 中的逐文件覆盖
          let ov = null;
          if (albumMeta) {
            ov = albumMeta[name] ||
              (albumMeta.tracks && (albumMeta.tracks[name] || albumMeta.tracks[base])) ||
              null;
            if (ov && typeof ov !== 'object') ov = null;
          }

          // 文件名常见格式："艺术家 - 歌名" 或 "01. 歌名"
          let title = (ov && ov.title) || tag.title;
          let artist = (ov && ov.artist) || tag.artist || dirDefaults.artist;
          if (!title) {
            const m = base.match(/^\d{1,3}[.\s\-_]+(.+)$/);
            let guess = m ? m[1] : base;
            const sep = guess.split(/\s+-\s+|\s+–\s+/);
            if (sep.length >= 2 && !artist) {
              artist = sep[0].trim();
              guess = sep.slice(1).join(' - ').trim();
            }
            title = guess.trim();
          }
          results.push({
            id: makeId(full),
            provider: 'local',
            sourceId: makeSourceId('local', makeId(full)),
            title: title || base,
            artist: artist || '未知艺术家',
            album: (ov && ov.album) || tag.album || dirDefaults.album || '',
            albumArtist: tag.albumArtist || dirDefaults.albumArtist || '',
            year: (ov && ov.year) || tag.year || dirDefaults.year || '',
            hasCover: !!tag.hasCover || hasSidecarCover(full),
            hasLyric: !!readSidecarLyric(full),
            filePath: full,
            fileName: name,
            folder: path.basename(dir),
            size: st.size,
            mtime: st.mtimeMs
          });
        } catch (_) { /* 单文件失败不影响整体 */ }
      }
    }
  };

  walk(root, 0);
  return results;
}

/**
 * 扫描多个目录并合并去重
 */
function scanDirs(dirs, opt = {}) {
  const all = [];
  const seen = new Set();
  for (const d of dirs) {
    if (!d || typeof d !== 'string') continue;
    try {
      if (!fs.statSync(d).isDirectory()) continue;
    } catch (_) { continue; }
    for (const item of scanDir(d, opt)) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      all.push(item);
    }
  }
  return all;
}

module.exports = { scanDir, scanDirs, makeId };
