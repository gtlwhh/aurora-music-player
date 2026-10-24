'use strict';
/**
 * 本地独立歌单存储（脱离任何平台）
 *
 * 数据结构（data/local-playlists.json）：
 *   playlists: [{ id, name, system, tracks: [{ key, snapshot }] }]
 *     - id: "lp_liked"（默认"我喜欢"，固定存在不可删）或 "lp_<8位随机>"
 *     - key: "provider--gid"（同 trackId 语义），快照冗余存完整曲目元数据，
 *       离线可渲染；播放时按 provider 路由到对应平台取流。
 *   liked: ["netease--186016", ...]  本地红心 key 集合（与平台收藏解耦）
 *
 * 写入策略：原子写（tmp + rename），任何读失败按空库处理。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { fileInData } = require('./paths');
const FILE = fileInData('local-playlists.json');

function _empty() {
  return { version: 1, savedAt: 0, playlists: [{ id: 'lp_liked', name: '我喜欢', system: true, tracks: [] }], liked: [] };
}

function _writeAtomically(data) {
  data.savedAt = Date.now();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, FILE);
}

class LocalPlaylists {
  constructor() {
    this.data = _empty();
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(FILE)) {
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        if (raw && Array.isArray(raw.playlists)) {
          this.data = raw;
          // 确保"我喜欢"永远存在
          if (!this.data.playlists.some(p => p.id === 'lp_liked')) {
            this.data.playlists.unshift({ id: 'lp_liked', name: '我喜欢', system: true, tracks: [] });
          }
        }
      }
    } catch (err) {
      console.warn('[local-pl] 歌单库损坏，按空库处理:', err.message);
      this.data = _empty();
    }
  }

  _save() {
    try {
      if (!fs.existsSync(path.dirname(FILE))) fs.mkdirSync(path.dirname(FILE), { recursive: true });
      _writeAtomically(this.data);
    } catch (err) {
      console.error('[local-pl] 保存失败:', err.message);
    }
  }

  _find(id) {
    return this.data.playlists.find(p => p.id === id) || null;
  }

  /** 曲目 → { key, snapshot }（快照只留渲染与取流所需字段） */
  entryOf(track) {
    const t = track || {};
    const gid = t.gid || t.nid || t.id;
    const key = t.provider + '--' + gid;
    const snapshot = {
      id: t.id, provider: t.provider, sourceId: t.sourceId,
      gid: t.gid, nid: t.nid, songId: t.songId,
      title: t.title, artist: t.artist, album: t.album,
      albumId: t.albumId, picUrl: t.picUrl, duration: t.duration,
      hasCover: t.hasCover, hasLyric: t.hasLyric
    };
    return { key, snapshot };
  }

  /* ---- 歌单 CRUD ---- */

  list() {
    return this.data.playlists.map(p => ({
      id: p.id,
      name: p.name,
      system: !!p.system,
      count: p.tracks.length,
      covers: p.tracks.slice(0, 3).map(t => t.snapshot.picUrl).filter(Boolean)
    }));
  }

  create(name) {
    const id = 'lp_' + crypto.randomBytes(4).toString('hex');
    this.data.playlists.push({ id, name: String(name || '新建歌单').slice(0, 40), tracks: [] });
    this._save();
    return { id, name: this._find(id).name };
  }

  remove(id) {
    const p = this._find(id);
    if (!p) return { ok: false, error: '歌单不存在' };
    if (p.system) return { ok: false, error: '"我喜欢"是默认歌单，不能删除' };
    this.data.playlists = this.data.playlists.filter(x => x.id !== id);
    this._save();
    return { ok: true };
  }

  rename(id, name) {
    const p = this._find(id);
    if (!p) return { ok: false, error: '歌单不存在' };
    p.name = String(name || '').slice(0, 40);
    this._save();
    return { ok: true };
  }

  tracks(id) {
    const p = this._find(id);
    if (!p) return null;
    return { id: p.id, name: p.name, system: !!p.system, tracks: p.tracks.map(t => t.snapshot) };
  }

  addTrack(id, track) {
    const p = this._find(id);
    if (!p) return { ok: false, error: '歌单不存在' };
    const e = this.entryOf(track);
    if (p.tracks.some(t => t.key === e.key)) return { ok: true, dup: true };
    p.tracks.push(e);
    this._save();
    return { ok: true };
  }

  removeTrack(id, track) {
    const p = this._find(id);
    if (!p) return { ok: false, error: '歌单不存在' };
    const e = this.entryOf(track);
    p.tracks = p.tracks.filter(t => t.key !== e.key);
    this._save();
    return { ok: true };
  }

  /* ---- 本地红心（"我喜欢"的 key 索引） ---- */

  isLiked(track) {
    const e = this.entryOf(track);
    return this.data.liked.includes(e.key);
  }

  like(track, like) {
    const e = this.entryOf(track);
    const had = this.data.liked.includes(e.key);
    if (like && !had) this.data.liked.push(e.key);
    if (!like && had) this.data.liked = this.data.liked.filter(k => k !== e.key);
    // 同步维护"我喜欢"歌单本体
    const likedPl = this._find('lp_liked');
    if (like && likedPl && !likedPl.tracks.some(t => t.key === e.key)) {
      likedPl.tracks.push(e);
    }
    if (!like && likedPl) {
      likedPl.tracks = likedPl.tracks.filter(t => t.key !== e.key);
    }
    this._save();
    return { ok: true, liked: !!like };
  }

  likedKeys() {
    return [...this.data.liked];
  }
}

module.exports = { LocalPlaylists };
