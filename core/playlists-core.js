/**
 * core/playlists-core.js · 本地歌单纯业务逻辑（双端共享）
 *
 * 从桌面端 server/lib/local-playlists.js 抽离：
 *   - 完全不含 fs / path / require，存储通过 backend（见 core/storage.js）注入
 *   - 数据结构与桌面端 JSON 完全一致，可互相导入导出
 *
 * backend 只需实现：async read() -> 整个文档对象（可为 null）；async write(doc)
 */

const LIKED_ID = 'lp_liked';

function emptyDoc() {
  return {
    version: 1,
    savedAt: 0,
    playlists: [{ id: LIKED_ID, name: '我喜欢', system: true, tracks: [] }],
    liked: []
  };
}

export class PlaylistsCore {
  constructor(backend) {
    this.backend = backend;          // { read, write }
    this.data = null;                // 惰性加载
    this._loading = null;
  }

  async _ensure() {
    if (this.data) return this.data;
    if (this._loading) return this._loading;
    this._loading = (async () => {
      let doc = null;
      try { doc = await this.backend.read(); } catch (_) {}
      if (!doc || !Array.isArray(doc.playlists)) doc = emptyDoc();
      if (!doc.playlists.some(p => p.id === LIKED_ID)) {
        doc.playlists.unshift({ id: LIKED_ID, name: '我喜欢', system: true, tracks: [] });
      }
      if (!Array.isArray(doc.liked)) doc.liked = [];
      this.data = doc;
      return doc;
    })();
    return this._loading;
  }

  async _save() {
    this.data.savedAt = Date.now();
    try { await this.backend.write(this.data); } catch (err) {
      console.warn('[playlists-core] 持久化失败:', err.message);
    }
  }

  _find(id) {
    return this.data.playlists.find(p => p.id === id) || null;
  }

  /** 曲目 → { key, snapshot }（与桌面端一致：key = provider--gid，快照冗余存元数据） */
  entryOf(track) {
    const t = track || {};
    const gid = t.gid || t.nid || t.id;
    return {
      key: t.provider + '--' + gid,
      snapshot: {
        id: t.id, provider: t.provider, sourceId: t.sourceId,
        gid: t.gid, nid: t.nid, songId: t.songId,
        title: t.title, artist: t.artist, album: t.album,
        albumId: t.albumId, picUrl: t.picUrl, duration: t.duration,
        hasCover: t.hasCover, hasLyric: t.hasLyric
      }
    };
  }

  /* ---- 查询 ---- */

  async list() {
    await this._ensure();
    return this.data.playlists.map(p => ({
      id: p.id, name: p.name, system: !!p.system, count: p.tracks.length,
      covers: p.tracks.slice(0, 3).map(t => t.snapshot.picUrl).filter(Boolean)
    }));
  }

  async tracks(id) {
    await this._ensure();
    const p = this._find(id);
    if (!p) return null;
    return { id: p.id, name: p.name, system: !!p.system, tracks: p.tracks.map(t => t.snapshot) };
  }

  /* ---- 歌单 CRUD ---- */

  async create(name) {
    await this._ensure();
    const id = 'lp_' + Math.random().toString(16).slice(2, 10);
    this.data.playlists.push({ id, name: String(name || '新建歌单').slice(0, 40), tracks: [] });
    await this._save();
    return { id, name: this._find(id).name };
  }

  async remove(id) {
    await this._ensure();
    const p = this._find(id);
    if (!p) return { ok: false, error: '歌单不存在' };
    if (p.system) return { ok: false, error: '"我喜欢"是默认歌单，不能删除' };
    this.data.playlists = this.data.playlists.filter(x => x.id !== id);
    await this._save();
    return { ok: true };
  }

  async rename(id, name) {
    await this._ensure();
    const p = this._find(id);
    if (!p) return { ok: false, error: '歌单不存在' };
    p.name = String(name || '').slice(0, 40);
    await this._save();
    return { ok: true };
  }

  async addTrack(id, track) {
    await this._ensure();
    const p = this._find(id);
    if (!p) return { ok: false, error: '歌单不存在' };
    const e = this.entryOf(track);
    if (p.tracks.some(t => t.key === e.key)) return { ok: true, dup: true };
    p.tracks.push(e);
    await this._save();
    return { ok: true };
  }

  async removeTrack(id, track) {
    await this._ensure();
    const p = this._find(id);
    if (!p) return { ok: false, error: '歌单不存在' };
    const e = this.entryOf(track);
    p.tracks = p.tracks.filter(t => t.key !== e.key);
    await this._save();
    return { ok: true };
  }

  /* ---- 本地红心（"我喜欢"） ---- */

  async isLiked(track) {
    await this._ensure();
    return this.data.liked.includes(this.entryOf(track).key);
  }

  async like(track, like) {
    await this._ensure();
    const e = this.entryOf(track);
    const had = this.data.liked.includes(e.key);
    if (like && !had) this.data.liked.push(e.key);
    if (!like && had) this.data.liked = this.data.liked.filter(k => k !== e.key);
    const likedPl = this._find(LIKED_ID);
    if (like && likedPl && !likedPl.tracks.some(t => t.key === e.key)) likedPl.tracks.push(e);
    if (!like && likedPl) likedPl.tracks = likedPl.tracks.filter(t => t.key !== e.key);
    await this._save();
    return { ok: true, liked: !!like };
  }

  async likedKeys() {
    await this._ensure();
    return [...this.data.liked];
  }
}
