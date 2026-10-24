'use strict';
/**
 * PlaylistSession · 统一歌单抽象与动态取歌
 *
 * 静态歌单：统一 Playlist 对象 { id, platform, name, cover, count, kind:'static' }，
 *          分页取曲目（offset/limit），绝不一次性拉完整列表。
 *
 * 动态来源（心动模式 / 私人漫游 / 本地电台）：
 *   - 缓冲策略：内部缓冲目标 5 首；每次取歌后若剩余 < 3 首，**异步**请求下一批追加
 *     （不阻塞取歌），缓冲完全为空时才同步等一次。
 *   - 去重：本会话内已播过的曲目不再进缓冲（provider+gid / provider+id 识别）。
 *   - 持久化：会话上下文（含缓冲）落 data/dynamic-sessions.json，重启恢复，
 *     恢复失败或缓冲失效时由 next() 自动重新生成，不报错。
 *   - 失败上限：单轮补货失败重试最多 2 次，仍失败则标记 exhausted（不死循环）。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./paths');
const SESSIONS_FILE = path.join(DATA_DIR, 'dynamic-sessions.json');

const SESSION_TTL = 12 * 60 * 60 * 1000;  // 会话闲置 12 小时回收
const BUFFER_TARGET = 5;                  // 缓冲补货目标
const BUFFER_LOW = 3;                     // 低于此数触发异步补货
const REFILL_RETRY_MAX = 2;               // 单轮补货失败重试上限

/**
 * 会话结构版本号：结构变更（如 mix 双平台、cursor 字段）时 +1，
 * _restore 只恢复同版本会话——旧版本会话直接作废，避免"恢复出旧平台会话
 * 导致心动/漫游只推单平台"这类跨版本污染（升级后用户重新点一次即可）。
 */
const SESSION_VER = 2;

class PlaylistSession {
  /**
   * @param opts.asyncCtx { getStore(), run(store, fn) }  AsyncLocalStorage 载体。
   * 后台补货跑在 setTimeout 里——ALS 上下文会丢失（QQ/网易云凭证取不到，
   * 表现为"心动模式只推单平台"）。创建会话/取歌时把请求上下文快照带进来，
   * 补货时用 ctx.run(快照) 还原凭证。
   */
  constructor(opts = {}) {
    /** id -> { id, platform, type, seed, buffer:[], cursor, playedIds:Set, ... } */
    this._sessions = new Map();
    this._adapters = {};
    this._asyncCtx = opts.asyncCtx || null;
    this._restore();
  }

  /* ---------------- 持久化 ---------------- */

  _persist() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const arr = [];
      for (const s of this._sessions.values()) {
        if (s.platform === 'local') continue;          // 本地电台无需持久化
        arr.push({
          id: s.id, platform: s.platform, type: s.type, ver: SESSION_VER,
          seed: s.seed, cursor: s.cursor,
          buffer: s.buffer, playedIds: [...s.playedIds],
          createdAt: s.createdAt, lastUsed: s.lastUsed, exhausted: s.exhausted
        });
      }
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ savedAt: Date.now(), sessions: arr }), 'utf8');
    } catch (_) {}
  }

  _restore() {
    try {
      if (!fs.existsSync(SESSIONS_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      let dropped = 0;
      for (const s of (raw.sessions || [])) {
        if (Date.now() - (s.lastUsed || 0) > SESSION_TTL) continue;
        // 版本门：旧结构会话（如单平台时代的推荐会话）直接作废，防止恢复出
        // "只推网易云"的旧会话；前端下次取歌会得到"会话不存在"并自动重建。
        if (s.platform !== 'local' && s.ver !== SESSION_VER) { dropped++; continue; }
        this._sessions.set(s.id, {
          ...s,
          playedIds: new Set(s.playedIds || []),
          createdAt: s.createdAt || Date.now(),
          lastUsed: Date.now()
        });
      }
      if (dropped) console.log(`[dynamic] 丢弃 ${dropped} 个旧版本会话（结构升级，将按需重建）`);
      if (this._sessions.size) {
        console.log(`[dynamic] 恢复 ${this._sessions.size} 个动态队列会话`);
      }
    } catch (err) {
      console.warn('[dynamic] 会话恢复失败（将重新生成）:', err.message);
    }
  }

  _gc() {
    const now = Date.now();
    let dirty = false;
    for (const [id, s] of this._sessions) {
      if (now - s.lastUsed > SESSION_TTL) { this._sessions.delete(id); dirty = true; }
    }
    if (dirty) this._persist();
  }

  /** 会话内去重：已播过/已在缓冲的不再进 */
  _dedup(session, tracks) {
    const key = (t) => t.provider + ':' + (t.gid || t.nid || t.id);
    return (tracks || []).filter(t => t && !session.playedIds.has(key(t)) &&
      !session.buffer.some(b => key(b) === key(t)));
  }

  /* ---------------- 静态歌单 ---------------- */

  async list(adapter) {
    const raw = await adapter.listPlaylists();
    return (raw || []).map(p => ({
      id: String(p.id),
      platform: adapter.id,
      name: p.name || '未命名歌单',
      cover: p.cover || p.coverUrl || p.picUrl || '',
      count: Number(p.count || p.trackCount || 0),
      kind: 'static',
      special: p.special || ''
    }));
  }

  async tracks(adapter, playlistId, { offset = 0, limit = 50 } = {}) {
    const r = await adapter.playlistTracks(playlistId, { offset, limit });
    const tracks = r.tracks || [];
    return {
      total: r.total !== undefined ? r.total : null,
      offset,
      hasMore: r.hasMore !== undefined ? r.hasMore : (offset + tracks.length < (r.total || Infinity)),
      tracks
    };
  }

  /* ---------------- 动态来源 ---------------- */

  createDynamic(platform, type, seed, ctx = {}) {
    this._gc();

    if (platform === 'local' && type === 'localRadio') {
      const pool = (ctx.localTracks || []).map(t => ({ ...t }));
      if (!pool.length) throw new Error('本地曲库为空，无法创建电台');
      for (let i = pool.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const id = crypto.randomUUID();
      this._sessions.set(id, {
        id, platform, type, seed: seed || null,
        buffer: pool, cursor: 0,
        playedIds: new Set(),
        total: pool.length,
        createdAt: Date.now(), lastUsed: Date.now(),
        exhausted: false, refilling: false
      });
      this._persist();
      return { sessionId: id, platform, type, buffered: pool.length };
    }

    // 平台动态来源：建会话后立即异步预取首批（不阻塞建会话请求）
    const id = crypto.randomUUID();
    const session = {
      id, platform, type, ver: SESSION_VER,
      seed: seed || null,
      // cursor 保全整个 seed（含 seedMid）：QQ 种子心动模式依赖它传给 similar 接口
      cursor: Object.assign({}, seed || {}),
      buffer: [],
      playedIds: new Set(),
      total: null,
      createdAt: Date.now(), lastUsed: Date.now(),
      exhausted: false,
      refilling: false
    };
    // 目标 BPM：补货时优先挑节奏接近的歌，方便触发交叉淡化
    if (ctx.bpm) session.cursor.bpm = Math.round(Number(ctx.bpm)) || 0;
    this._sessions.set(id, session);
    this._refillInBackground(session);
    this._persist();
    return { sessionId: id, platform, type, buffered: 0 };
  }

  /**
   * 从会话取下 n 首。缓冲有货立即返回；低于阈值触发**异步**补货；
   * 缓冲全空时才同步等一次补货（失败重试上限 REFILL_RETRY_MAX）。
   */
  async next(adapter, sessionId, n = 1) {
    const s = this._sessions.get(sessionId);
    if (!s) throw new Error('会话不存在或已过期，请重建');
    s.lastUsed = Date.now();

    if (s.platform === 'local') {
      const out = s.buffer.splice(0, n);
      if (out.length) s.cursor += out.length;
      s.exhausted = s.buffer.length === 0;
      return { tracks: out, exhausted: s.exhausted };
    }

    // 平台来源：缓冲空时，等预取完成或同步补货，绝不拿着空缓冲直接回
    if (s.buffer.length === 0 && !s.exhausted) {
      if (s.refilling && s.refillPromise) {
        await s.refillPromise.catch(() => {});
      } else if (!s.refilling) {
        await this._refill(s, adapter);
      }
    }
    const out = s.buffer.splice(0, n);
    for (const t of out) s.playedIds.add(t.provider + ':' + (t.gid || t.nid || t.id));
    if (s.buffer.length < BUFFER_LOW && !s.exhausted && !s.refilling) {
      this._refillInBackground(s, adapter);              // 低于阈值：异步补，不阻塞
    }
    this._persist();
    return {
      tracks: out,
      exhausted: s.exhausted && out.length === 0 && s.buffer.length === 0,
      sides: s.lastSides || null
    };
  }

  _refillInBackground(session, adapter) {
    // ★ 把发起请求的 ALS 上下文快照带进 setTimeout：没有这一步，后台补货时
    //   QQ/网易云凭证（x-qq-session 等）全部蒸发，QQ 侧永远空手 → 单平台降级。
    const ctx = this._asyncCtx;
    const snapshot = ctx ? ctx.getStore() : null;
    const job = async () => {
      try { await this._refill(session, adapter || this._adapterFor(session)); }
      catch (_) {}
    };
    setTimeout(() => {
      if (ctx && snapshot) ctx.run(snapshot, job);
      else job();
    }, 0);
  }

  _adapterFor(session) {
    return this._adapters[session.platform];
  }

  /** 注册 adapter 引用（index.js 启动后调用一次），供异步补货使用 */
  bindAdapters(map) {
    Object.assign(this._adapters, map);
  }

  async _refill(s, adapter) {
    if (s.refilling || s.exhausted || !adapter) return;
    s.refilling = true;
    s.refillPromise = (async () => {
      try {
        let attempt = 0;
        while (s.buffer.length < BUFFER_TARGET && attempt <= REFILL_RETRY_MAX && !s.exhausted) {
          try {
            const batch = await adapter.dynamicNext(s.type, s.cursor);
            const raw = (batch && batch.tracks) || [];
            const fresh = this._dedup(s, raw);
            if (batch && batch.cursor) s.cursor = batch.cursor;
            // 记录本轮实际出歌平台（供前端提示"双平台混合/单平台降级"）
            if (batch && Array.isArray(batch.sides) && batch.sides.length) s.lastSides = batch.sides;
            s.buffer.push(...fresh);
            if (!raw.length) {
              s.exhausted = true;                          // 上游真没了
            } else if (!fresh.length) {
              // 本轮全是重复：丢一半已播记录再试，避免卡死在去重上
              const keep = [...s.playedIds].slice(Math.ceil(s.playedIds.size / 2));
              s.playedIds = new Set(keep);
            }
          } catch (err) {
            attempt++;
            console.warn(`[dynamic] ${s.type} 补货失败(${attempt}/${REFILL_RETRY_MAX}):`, err.message);
            if (attempt > REFILL_RETRY_MAX) s.exhausted = true;
          }
        }
      } finally {
        s.refilling = false;
        s.refillPromise = null;
        this._persist();
      }
    })();
    await s.refillPromise;
  }

  destroy(sessionId) {
    this._sessions.delete(sessionId);
    this._persist();
  }

  sessionInfo(sessionId) {
    const s = this._sessions.get(sessionId);
    if (!s) return null;
    return {
      id: s.id, platform: s.platform, type: s.type,
      buffered: s.buffer.length, exhausted: s.exhausted,
      played: s.playedIds.size
    };
  }
}

module.exports = { PlaylistSession };
