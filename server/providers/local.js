'use strict';
/**
 * 本地音源适配器
 * 直接读取本地磁盘上的音频文件（任何音乐软件的下载目录都能用），
 * 音质 = 文件原始音质，不做任何转码。
 */

const fs = require('fs');
const { readCover, readSidecarCover, readSidecarLyric } = require('../lib/audio-meta');

class LocalProvider {
  constructor() {
    this.id = 'local';
    this.name = '本地音乐';
    this.tracks = [];
    this.index = new Map(); // id -> track
  }

  setTracks(tracks) {
    this.tracks = tracks;
    this.index = new Map(tracks.map(t => [t.id, t]));
  }

  isAvailable() {
    return this.tracks.length > 0;
  }

  getTrack(id) {
    return this.index.get(id) || null;
  }

  async search(query) {
    const q = (query || '').toLowerCase().trim();
    if (!q) return this.tracks.slice(0, 200);
    const words = q.split(/\s+/).filter(Boolean);
    const scored = [];
    for (const t of this.tracks) {
      const hay = `${t.title} ${t.artist} ${t.album} ${t.fileName}`.toLowerCase();
      let score = 0;
      let hit = true;
      for (const w of words) {
        const idx = hay.indexOf(w);
        if (idx < 0) { hit = false; break; }
        score += idx === 0 ? 3 : 1;
      }
      if (hit) scored.push({ t, score });
    }
    scored.sort((a, b) => b.score - a.score || a.t.title.localeCompare(b.t.title));
    return scored.slice(0, 300).map(s => s.t);
  }

  /** 本地文件直接流式返回（由 server 处理 Range） */
  async getStream(track) {
    if (!track || !track.filePath) throw new Error('曲目不存在');
    if (!fs.existsSync(track.filePath)) throw new Error('文件已被移动或删除');
    return { filePath: track.filePath };
  }

  async getLyric(track) {
    if (!track || !track.filePath) return null;
    const lrc = readSidecarLyric(track.filePath);
    if (!lrc) return null;
    return { lrc, source: 'lrc 文件' };
  }

  async getCover(track) {
    if (!track || !track.filePath) return null;
    // 优先内嵌封面，其次同目录同名图 / cover.jpg
    const embedded = readCover(track.filePath);
    if (embedded) return { mime: embedded.mime, data: embedded.data };
    return readSidecarCover(track.filePath);
  }
}

module.exports = LocalProvider;
