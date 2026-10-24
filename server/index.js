'use strict';
/**
 * Aurora 极光音乐播放器 · 本地服务
 *
 * 职责：
 *  1. 提供前端静态资源
 *  2. 扫描本地音乐库 / 解析标签封面歌词
 *  3. 音频流代理（本地文件 + 在线音源），完整支持 Range 拖拽
 *  4. 多音源统一接口
 *
 * 零框架依赖，只用 Node 原生模块。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

const store = require('./lib/store');
const neteaseApi = require('./lib/netease-api');
const analysisCache = require('./lib/analysis-cache');
const { scanDirs, makeId } = require('./lib/scan');
const { isAudio, readCover, readSidecarLyric } = require('./lib/audio-meta');
const { AccountManager, STATELESS } = require('./lib/accounts');
const reqCtx = require('./lib/req-context');
const { PlaylistSession } = require('./lib/playlists');
const qqApi = require('./lib/qq-api');
const { GdStudioClient } = require('./providers/gdstudio');
const { LocalPlaylists } = require('./lib/local-playlists');
const { createComposite } = require('./core/source-adapter');
const LocalProvider = require('./providers/local');
const NeteaseProvider = require('./providers/netease');
const QqProvider = require('./providers/qq');

const PORT = Number(process.env.PORT || 7788);
// 桌面端只监听本机回环；部署到云服务器时用 HOST=0.0.0.0 才会对公网开放
const HOST = process.env.HOST || '127.0.0.1';
const WEB_DIR = path.join(__dirname, '..', 'web');
const VENDOR_DIR = path.join(__dirname, '..', 'node_modules');
const DATA_DIR2 = require('./lib/paths').DATA_DIR;
const CORE_DIR = path.join(__dirname, '..', 'core');

/* ------------------------------------------------------------------ */
/* 音源注册（组合式 adapter：GD Studio 默认 + 平台 API 增强）           */
/* ------------------------------------------------------------------ */

const localProvider = new LocalProvider();
let embeddedBaseUrl = '';   // 内置网易云 API 的地址
let neteaseProvider = new NeteaseProvider(store.read(), embeddedBaseUrl);
const gdClient = new GdStudioClient();

const providers = {
  local: localProvider,
  netease: neteaseProvider      // 启动后由 refreshProviders() 替换为组合 adapter
};

/** 平台账号 cookie 优先（加密存储），历史明文配置兜底
 *  无状态模式下完全不注入：凭证只能来自本次请求的 header */
function settingsWithAccount() {
  const s = { ...store.read() };
  if (accounts.describe('netease').stateless) {
    delete s.neteaseCookie;          // 服务器绝不使用任何本地保存的 cookie
    return s;
  }
  const acct = accounts.getActive('netease');
  if (acct && acct.cookie) s.neteaseCookie = acct.cookie;
  return s;
}

function refreshProviders() {
  neteaseProvider = new NeteaseProvider(settingsWithAccount(), embeddedBaseUrl);
  providers.netease = createComposite({
    id: 'netease',
    name: '网易云音乐',
    gd: gdClient,
    platformApi: neteaseProvider,
    // 平台增强：自家接口支持音质档位降级 + VIP 音质（GD 只是兜底）
    overrides: {
      getStream: (track) => neteaseProvider.getStream(track)
    }
  });
  // QQ 已接入时重建组合（会话恢复后 baseUrl 不变，这里主要是 refresh 语义完整）
  if (qqProviderInstance) {
    providers.qq = createComposite({
      id: 'qq',
      name: 'QQ音乐',
      gd: gdClient,
      platformApi: qqProviderInstance,
      streamFallbackGd: false    // 硬要求：QQ 取链绝不落 GD
    });
  }
  // 动态队列的异步补货需要按平台找 adapter（后台定时器里不再经过路由层）
  playlistSession.bindAdapters({
    netease: providers.netease, qq: providers.qq, local: localProvider,
    mix: buildMixAdapter()   // mix 会话的后台补货也走双平台混合（adapter 无状态，cursor 每次传入）
  });
}

/* ------------------------------------------------------------------ */
/* QQ 音乐内嵌服务（自动端口 / 屏蔽 cookie 出入口 / safeStorage 会话） */
/* ------------------------------------------------------------------ */

let qqProviderInstance = null;
let qqBootstrap = null;

function bootstrapQqApi() {
  if (qqBootstrap) return qqBootstrap;
  qqBootstrap = qqApi.ensureStarted(3200).then((res) => {
    if (res.ok) {
      qqProviderInstance = new QqProvider(res.baseUrl, {
        // 服务器无状态：token 只从请求头来，不读盘也不写盘
        getToken: () => (STATELESS ? '' : qqApi.loadSessionToken()),
        setToken: (t) => { if (!STATELESS) qqApi.saveSessionToken(t); }
      });
      refreshProviders();
    } else {
      console.warn('[qq] QQ 音乐服务未启动:', res.error);
    }
    return res;
  }).catch((err) => {
    console.warn('[qq] QQ 音乐服务启动异常:', err.message);
    return { ok: false, error: err.message };
  });
  return qqBootstrap;
}

/* 生命周期绑定：进程退出（含 Electron will-quit 传播到 exit）时关闭监听 */
try {
  const electron = require('electron');
  if (electron && electron.app) {
    electron.app.on('will-quit', () => qqApi.shutdown());
  }
} catch (_) { /* 纯 node 调试模式 */ }
process.on('exit', () => qqApi.shutdown());

/* ------------------------------------------------------------------ */
/* 账号（safeStorage 加密持久化，每平台单会话）                         */
/* ------------------------------------------------------------------ */

const accounts = new AccountManager();
const playlistSession = new PlaylistSession({
  // ★ 后台补货在 setTimeout 里跑，ALS 会丢——把请求上下文载体传进去，
  //   补货时还原 QQ/网易云凭证（否则心动模式 QQ 侧永远空手 → 单平台）
  asyncCtx: reqCtx.als
});

// 网易云登录后端：二维码 + 轮询（复用现有 provider 的接口封装）
accounts.registerBackend('netease', {
  async qrStart() {
    const emb = await bootstrapEmbeddedApi();
    if (!emb.ok && !store.read().neteaseBaseUrl) {
      throw new Error('网易云音源服务未就绪：' + (emb.error || '未知原因'));
    }
    const keyData = await neteaseProvider.api('/login/qr/key', { _t: Date.now() });
    const unikey = keyData && keyData.data && keyData.data.unikey;
    if (!unikey) throw new Error('获取二维码 key 失败');
    const qrData = await neteaseProvider.api('/login/qr/create', { key: unikey, qrimg: true, _t: Date.now() });
    const data = (qrData && qrData.data) || {};
    return { key: unikey, qrimg: data.qrimg || '' };
  },
  async qrCheck(key) {
    const r = await neteaseProvider.api('/login/qr/check', { key, _t: Date.now() });
    const code = Number(r.code);
    if (code !== 803) return { code, message: r.message || '' };
    const cookie = extractLoginCookie(r);
    if (!cookie || !/MUSIC_U=/.test(cookie)) {
      return { code: 803, cookie: '', message: '扫码成功但没拿到登录凭证' };
    }
    refreshProviders();
    let user = null;
    try {
      const st = await neteaseProvider.status();
      if (st.loggedIn) {
        user = { nickname: st.nickname, avatarUrl: st.avatarUrl, userId: st.userId, vipType: st.vipType };
        console.log(`[accounts] 网易云登录成功: ${st.nickname || st.userId}`);
      }
    } catch (_) {}
    return { code: 803, cookie, credential: cookie, user };
  }
});

// QQ 登录后端：凭证由包内会话仓库加密保存（handled=true 标记，不经 AccountManager 存 cookie）
accounts.registerBackend('qq', {
  async qrStart() {
    const boot = await bootstrapQqApi();
    if (!boot.ok) throw new Error('QQ 音乐服务未就绪：' + (boot.error || '未知原因'));
    const keyRes = await qqProviderInstance.api('/login/qr/key');
    const unikey = keyRes && keyRes.data && keyRes.data.unikey;
    if (!unikey) throw new Error('获取 QQ 二维码 key 失败');
    const qrRes = await qqProviderInstance.api('/login/qr/create', { key: unikey, qrcode: 1 });
    const data = (qrRes && qrRes.data) || {};
    return { key: unikey, qrimg: data.qrimg || '' };
  },
  async qrCheck(key) {
    const r = await qqProviderInstance.api('/login/qr/check', { key });
    const code = Number(r.code);
    // 801=等待扫码 802=已扫码待确认 800=已过期：原样透传给轮询会话（qq.js 已放行这些状态码）
    if (code !== 803) return { code, message: r.message || '' };
    // 令牌从本次请求的上下文里取（api() 扫码成功时写入），桌面端回退实例 getter
    const store = reqCtx.als.getStore();
    // 优先级：返回值携带（定时器轮询场景 ALS 不可用）> 请求上下文 > 实例回退
    const session = r.__qqToken || (store && store.qqLoginToken)
      || (qqProviderInstance ? qqProviderInstance.token : '');
    if (store) delete store.qqLoginToken;
    // ★ 顺手缓存一份搜索兜底令牌：未登录设备的游客搜索用（仅搜索，绝不写账号存储）
    if (session && qqProviderInstance.saveGuestToken) qqProviderInstance.saveGuestToken(session);
    // 凭证已由包内会话仓库加密保存；带着刚换到的令牌拉一次用户信息
    // （无状态模式下实例 getter 拿不到这个令牌，必须显式传）
    let user = null;
    try {
      const st = await qqProviderInstance.status({ token: session });
      if (st.loggedIn) {
        user = { nickname: st.nickname, avatarUrl: st.avatarUrl, userId: st.userId };
        console.log(`[accounts] QQ 扫码登录成功: ${st.nickname || st.userId}`);
      }
    } catch (_) {}
    console.log(`[accounts] QQ 803 令牌长度: ${(session || '').length}`);
    // ★ QQ 登录"无反应"根因：前端读 st.credential，这里却只给 session——字段名对不上
    return { code: 803, handled: true, user, session, credential: session };
  }
});

/** 后台拉起内置网易云 API，失败不影响本地音乐功能 */
let embeddedPromise = null;
function bootstrapEmbeddedApi() {
  if (embeddedPromise) return embeddedPromise;
  embeddedPromise = neteaseApi.ensureStarted(3000).then((res) => {
    if (res.ok) {
      embeddedBaseUrl = res.baseUrl;
      refreshProviders();
      // 启动即校验上次保存的登录态
      setTimeout(async () => {
        try {
          const st = await neteaseProvider.status();
          if (st.loggedIn) {
            console.log(`[netease] 已自动登录: ${st.nickname || st.userId}${st.vipType ? ' (VIP)' : ''}`);
          } else if (store.read().neteaseCookie) {
            console.log('[netease] 本地有登录凭证但校验未通过，可能需要重新扫码');
          }
        } catch (_) {}
      }, 1200);
    } else {
      console.warn('[netease] 内置音源未启动:', res.error);
    }
    return res;
  }).catch((err) => {
    console.warn('[netease] 内置音源启动异常:', err.message);
    return { ok: false, error: err.message };
  });
  return embeddedPromise;
}

/* 曲库缓存 */
let libraryCache = { tracks: [], scannedAt: 0, dirs: [] };
const coverCache = new Map(); // key -> {mime, data, ts}
const COVER_CACHE_MAX = 300;

const localPl = new LocalPlaylists();

/**
 * 跨平台混合动态源：同时向网易云 + QQ 推荐接口要歌，混合成一个队列。
 *   fmix     私人漫游混合：netease /personal_fm + qq /user/guess-you-like
 *   heartmix 心动模式混合：netease 心动模式（种子） + qq 相似歌（种子）
 */
/* ------------------------------------------------------------------ */
/* BPM 工具：读 analysis.json 缓存，供心动 / 漫游做节奏筛选            */
/* ------------------------------------------------------------------ */

const bpmMemo = new Map();          // trackId -> bpm（0 = 未分析过）

function bpmOfTrackId(trackId) {
  const key = String(trackId || '');
  if (!key) return 0;
  if (bpmMemo.has(key)) return bpmMemo.get(key);
  let bpm = 0;
  try {
    const a = analysisCache.read(key);
    const v = Number(a && a.bpm);
    if (isFinite(v) && v > 0) bpm = Math.round(v);
  } catch (_) {}
  bpmMemo.set(key, bpm);
  return bpm;
}

function bpmOfTrack(t) {
  return t && t.id ? bpmOfTrackId(t.id) : 0;
}

/**
 * 按目标 BPM 重排候选：
 *   ① |Δ| ≤ tolerance（默认 ±8）  ② 未分析过 BPM 的  ③ 差距过大的
 * 各桶内部保持原来的「双平台交替穿插」顺序。
 * 一个接近的都没有时原样返回，等价于普通推荐（队列不会断）。
 */
function orderTracksByBpm(tracks, target, tolerance = 8) {
  if (!target || !Array.isArray(tracks) || tracks.length < 2) return { tracks, matched: 0 };
  const close = [], unknown = [], far = [];
  for (const t of tracks) {
    const b = bpmOfTrack(t);
    if (!b) { unknown.push(t); continue; }
    if (Math.abs(b - target) <= tolerance) close.push(t);
    else far.push(t);
  }
  if (!close.length) return { tracks, matched: 0 };
  return { tracks: close.concat(unknown, far), matched: close.length };
}

/**
 * 混合推荐适配器（platform=mix）
 */
function buildMixAdapter() {
  return {
    id: 'mix',
    async dynamicNext(type, cursor = {}) {
      const jobs = [];
      const ne = providers.netease && providers.netease.platformApi;
      const qq = providers.qq && providers.qq.platformApi;
      // seed 字段兼容：会话 cursor 保存的是原始 seed 对象（{id,pid,seedMid}），
      // 老代码传的是 {seed,pid,seedMid} —— 两种形态都认，避免字段错位吞掉种子。
      const seedId = cursor.seed !== undefined ? cursor.seed : cursor.id;
      if (ne && ne.recommend) {
        jobs.push(ne.recommend.next(type === 'heartmix' ? 'heartmode' : 'personalfm', {
          seed: seedId, pid: cursor.pid, ...(cursor.ne || {})
        }).then(r => ({ side: 'ne', r })));
      }
      if (qq && qq.recommend) {
        // 心动模式：优先"相似歌"（QQ 种子）；种子在 QQ 侧搜不到/相似歌失败/为空
        // → 必须回落 QQ 全局推荐（guess-you-like），绝不让 QQ 侧空手。
        const qqJob = async () => {
          if (type === 'heartmix' && cursor.seedMid) {
            try {
              const r = await qq.recommend.next('similar', { seedMid: cursor.seedMid, ...(cursor.qq || {}) });
              if (r && Array.isArray(r.tracks) && r.tracks.length) return r;
              console.log('[mix] QQ 相似歌为空 → 回落 QQ 全局推荐');
            } catch (err) {
              console.log('[mix] QQ 相似歌失败(' + (err.message || err) + ') → 回落 QQ 全局推荐');
            }
          }
          return qq.recommend.next('personalfm', { ...(cursor.qq || {}) });
        };
        jobs.push(qqJob().then(r => ({ side: 'qq', r })));
      }
      const rs = await Promise.allSettled(jobs);
      let neTracks = [], qqTracks = [];
      const newCursor = { seed: cursor.seed, pid: cursor.pid, seedMid: cursor.seedMid };
      rs.forEach(x => {
        if (x.status === 'fulfilled' && x.value.r && Array.isArray(x.value.r.tracks)) {
          if (x.value.side === 'ne') neTracks = x.value.r.tracks;
          else qqTracks = x.value.r.tracks;
          newCursor[x.value.side] = x.value.r.cursor || {};
        } else if (x.status === 'rejected') {
          // 单侧失败绝不报错：另一侧继续（如 QQ 未登录 / 接口波动）
          console.warn('[mix] 一侧推荐失败（另一侧继续）:', x.reason && x.reason.message);
        }
      });

      // ★ 数量配平（严格拉链的前提）：两侧都有歌但数量悬殊时，
      //   从短的一侧用该平台的全局推荐再补几批（每批去重，最多 3 次），
      //   补到与长侧相当（上限 12 首）——这样 interleave 才是严格的 A1→B1→A2→B2。
      if (neTracks.length && qqTracks.length) {
        const dedupe = (arr, have) => {
          const seen = new Set(have.map(t => t.gid || t.nid || t.id));
          return arr.filter(t => { const k = t.gid || t.nid || t.id; if (seen.has(k)) return false; seen.add(k); return true; });
        };
        const balanceSide = async (side, have, other) => {
          const want = Math.min(12, Math.max(other.length, 6)) - have.length;
          if (want <= 0) return have;
          let pool = have.slice();
          let cur2 = side === 'ne' ? cursor.ne : cursor.qq;   // 批间推进游标，避免反复拉同一批
          for (let i = 0; i < 3 && pool.length < Math.min(12, other.length); i++) {
            try {
              const r = side === 'ne'
                ? await ne.recommend.next('personalfm', { ...(cur2 || {}) })
                : await qq.recommend.next('personalfm', { ...(cur2 || {}) });
              const fresh = dedupe((r && r.tracks) || [], pool);
              pool = pool.concat(fresh);
              if (r && r.cursor) cur2 = r.cursor;
              if (!fresh.length) break;
            } catch (_) { break; }
          }
          if (pool.length > have.length) {
            console.log(`[mix] 数量配平：${side === 'ne' ? '网易云' : 'QQ'}侧 ${have.length} → ${pool.length}（另一侧 ${other.length}）`);
          }
          return pool;
        };
        if (neTracks.length < qqTracks.length) neTracks = await balanceSide('ne', neTracks, qqTracks);
        else if (qqTracks.length < neTracks.length) qqTracks = await balanceSide('qq', qqTracks, neTracks);
      }

      // 心动模式在"未登录网易云 / 种子不可用"时经常空手而归：
      // 自动降级一次私人电台，保证"点了心动就有歌"（其余用户反馈的点不动）
      if (type === 'heartmix' && neTracks.length === 0 && ne && ne.recommend) {
        try {
          const r2 = await ne.recommend.next('personalfm', { ...(cursor.ne || {}) });
          if (r2 && Array.isArray(r2.tracks) && r2.tracks.length) {
            neTracks = r2.tracks;
            newCursor.ne = r2.cursor || {};
            console.log('[mix] 心动模式空结果 → 已降级为私人电台推荐');
          }
        } catch (_) {}
      }
      // 共享源头合并（core/mix.mjs）：交替穿插 + BPM 节奏定向，移动端 BFF 复用同一实现
      // 目标 BPM：优先用会话里的 bpm，其次用 seed.trackId 去 analysis.json 缓存里查
      const targetBpm = Math.round(Number(cursor.bpm) || bpmOfTrackId(cursor.trackId) || 0);
      let merge;
      try {
        merge = await import('../core/mix.mjs');
      } catch (_) {
        merge = null;
      }
      let tracks, sides, matched = 0;
      if (merge && typeof merge.mergeMixRecommendations === 'function') {
        const r = merge.mergeMixRecommendations({
          ne: neTracks, qq: qqTracks, bpmOf: bpmOfTrack, targetBpm, tolerance: 8
        });
        tracks = r.tracks; sides = r.sides; matched = r.matched || 0;
      } else {
        // 极端兜底：拿不到共享模块时保持原来的交替合并
        tracks = [];
        for (let i = 0; i < Math.max(neTracks.length, qqTracks.length); i++) {
          if (neTracks[i]) tracks.push(neTracks[i]);
          if (qqTracks[i]) tracks.push(qqTracks[i]);
        }
        sides = [neTracks.length && 'netease', qqTracks.length && 'qq'].filter(Boolean);
      }
      if (sides.length === 2) console.log(`[mix] 双平台混合：网易 ${neTracks.length} + QQ ${qqTracks.length} 首（交替穿插）`);
      else if (sides.length === 1) console.log(`[mix] 单平台降级：仅 ${sides[0]} 出歌`);

      // 老版共享模块不支持 BPM（matched === 0 且确实有目标）时，退回到后置重排
      if (targetBpm && !matched) {
        const res = orderTracksByBpm(tracks, targetBpm);
        if (res.matched) {
          tracks = res.tracks;
          matched = res.matched;
        }
      }
      if (targetBpm) {
        console.log(matched
          ? `[mix] BPM 定向：目标 ${targetBpm} ±8，命中 ${matched}/${tracks.length}`
          : `[mix] BPM 定向：目标 ${targetBpm}，候选里没有接近节奏，降级为普通推荐`);
      }
      return { tracks, cursor: { ...newCursor, bpm: targetBpm }, sides };
    }
  };
}

/* 账号初始化：恢复加密会话 + 迁移历史明文 cookie（必须在 refreshProviders 之前） */
accounts.init({ get: () => store.read(), write: (patch) => store.write(patch) });
refreshProviders();
bootstrapQqApi();   // QQ 服务后台拉起，失败不影响其他功能

function rebuildLibrary(force = false) {
  const settings = store.read();
  const dirs = settings.musicDirs || [];
  const key = dirs.join('|');
  if (!force && libraryCache.scannedAt && libraryCache.dirs.join('|') === key &&
      Date.now() - libraryCache.scannedAt < 5 * 60 * 1000) {
    return libraryCache;
  }
  const t0 = Date.now();
  const tracks = scanDirs(dirs, { maxFiles: 30000 });
  libraryCache = { tracks, scannedAt: Date.now(), dirs, elapsed: Date.now() - t0 };
  localProvider.setTracks(tracks);
  console.log(`[library] 扫描完成 ${tracks.length} 首，用时 ${libraryCache.elapsed}ms，目录: ${dirs.join(', ') || '(空)'}`);
  return libraryCache;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.lrc': 'text/plain; charset=utf-8'
};

function sendJSON(res, data, status = 200) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    // 个人数据绝不允许被浏览器/代理缓存（writeHead 优先级高于 setHeader，必须写全）
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.end(body);
}

function sendError(res, message, status = 500) {
  sendJSON(res, { error: message }, status);
}

function serveStatic(req, res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch (_) { rel = urlPath; }
  if (rel === '/' || rel === '') rel = '/index.html';
  // 统一成 posix 分隔符，避免 Windows 上 path.normalize 把 / 换成 \ 导致前缀判断失效
  rel = rel.replace(/\\/g, '/');

  const isVendor = rel.startsWith('/vendor/');
  const isCore = rel.startsWith('/core/');
  const root = isVendor ? VENDOR_DIR : (isCore ? CORE_DIR : WEB_DIR);
  const sub = isVendor ? rel.slice('/vendor/'.length)
    : isCore ? rel.slice('/core/'.length)
    : rel.replace(/^\/+/, '');

  const parts = sub.split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..')) {
    res.writeHead(403); return res.end('Forbidden');
  }

  const filePath = path.join(root, ...parts);
  if (!path.resolve(filePath).startsWith(path.resolve(root))) {
    res.writeHead(403); return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';

    // 用 Last-Modified 做协商缓存：改了就立刻生效，没改就走 304
    const lastMod = stat.mtime.toUTCString();
    if (req.headers['if-modified-since'] === lastMod) {
      res.writeHead(304, { 'Last-Modified': lastMod });
      return res.end();
    }

    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Last-Modified': lastMod,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/** 转发一个远程资源到响应（支持 Range） */
function pipeRemote(targetUrl, req, res, extraHeaders = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(targetUrl); } catch (e) { sendError(res, '音源地址无效', 502); return resolve(); }
    const lib = u.protocol === 'https:' ? require('https') : require('http');

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      ...extraHeaders
    };
    if (req.headers.range) headers['Range'] = req.headers.range;

    const upstream = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers
    }, (up) => {
      // 某些 CDN 会 302
      if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location) {
        up.resume();
        const next = new URL(up.headers.location, targetUrl).toString();
        return pipeRemote(next, req, res, extraHeaders).then(resolve);
      }
      const outHeaders = {
        'Content-Type': up.headers['content-type'] || 'application/octet-stream',
        'Accept-Ranges': up.headers['accept-ranges'] || 'bytes',
        'Cache-Control': 'public, max-age=3600'
      };
      if (up.headers['content-length']) outHeaders['Content-Length'] = up.headers['content-length'];
      if (up.headers['content-range']) outHeaders['Content-Range'] = up.headers['content-range'];
      res.writeHead(up.statusCode || 200, outHeaders);
      up.pipe(res);
      up.on('end', resolve);
      up.on('error', () => { try { res.end(); } catch (_) {} resolve(); });
    });

    upstream.on('error', (err) => {
      if (!res.headersSent) sendError(res, '音源请求失败: ' + err.message, 502);
      resolve();
    });
    upstream.setTimeout(20000, () => { upstream.destroy(new Error('超时')); });
    upstream.end();
  });
}

/** 本地音频流（支持 Range） */
function streamLocalFile(filePath, req, res) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendError(res, '文件不存在', 404);
    const total = stat.size;
    const range = req.headers.range;
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'audio/mpeg';

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : total - 1;
        if (isNaN(start)) start = 0;
        if (isNaN(end) || end >= total) end = total - 1;
        if (start > end || start >= total) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` });
          return res.end();
        }
        res.writeHead(206, {
          'Content-Type': mime,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache'
        });
        const stream = fs.createReadStream(filePath, { start, end });
        stream.on('error', () => { try { res.end(); } catch (_) {} });
        return stream.pipe(res);
      }
    }

    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache'
    });
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => { try { res.end(); } catch (_) {} });
    stream.pipe(res);
  });
}

/** 列出目录（供前端选文件夹） */
function listDir(target) {
  // 无路径时返回所有磁盘盘符
  if (!target) {
    const drives = [];
    if (process.platform === 'win32') {
      for (let i = 67; i <= 90; i++) {
        const d = String.fromCharCode(i) + ':\\';
        try { if (fs.existsSync(d)) drives.push({ name: d, path: d, isDrive: true }); } catch (_) {}
      }
      // A / B 盘（软驱，通常不存在）
    } else {
      drives.push({ name: '/', path: '/', isDrive: true });
    }
    const home = os.homedir();
    const quick = [];
    for (const [label, p] of [
      ['桌面', path.join(home, 'Desktop')],
      ['下载', path.join(home, 'Downloads')],
      ['音乐', path.join(home, 'Music')],
      ['文档', path.join(home, 'Documents')]
    ]) {
      try { if (fs.existsSync(p)) quick.push({ name: label, path: p, isQuick: true }); } catch (_) {}
    }
    return { path: '', parent: null, entries: [], drives, quick };
  }

  let st;
  try { st = fs.statSync(target); } catch (_) { throw new Error('路径不存在'); }
  if (!st.isDirectory()) throw new Error('不是文件夹');

  const entries = [];
  let names = [];
  try { names = fs.readdirSync(target, { withFileTypes: true }); } catch (e) { throw new Error('无法读取该文件夹（权限不足）'); }

  for (const e of names) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('$') || e.name.startsWith('.')) continue;
    const full = path.join(target, e.name);
    let count = 0;
    try {
      const sub = fs.readdirSync(full, { withFileTypes: true });
      count = sub.filter(x => x.isFile() && isAudio(x.name)).length;
      if (count === 0) {
        // 只统计一层子目录中是否有音频
        let deeper = 0;
        for (const s of sub) {
          if (s.isDirectory()) {
            try {
              deeper += fs.readdirSync(path.join(full, s.name)).filter(n => isAudio(String(n))).length;
            } catch (_) {}
            if (deeper > 0) break;
          }
        }
        count = deeper;
      }
    } catch (_) {}
    entries.push({ name: e.name, path: full, audioCount: count });
  }
  entries.sort((a, b) => (b.audioCount - a.audioCount) || a.name.localeCompare(b.name, 'zh'));

  const parent = path.dirname(target) === target ? null : path.dirname(target);
  return { path: target, parent, entries };
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  // ★ 所有 API 响应禁止任何层级的缓存（浏览器/代理都可能把 A 的个人数据吐给 B）
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const p = url.pathname;
  const q = url.searchParams;

  /* ---- 客户端凭证透传 ----
     凭证已由 http 入口写进 AsyncLocalStorage（每请求隔离），
     provider 在任意 await 深度读 ctxCredential() 取"自己这次请求"的值。
     这里绝不能再写进单例实例字段 —— 那是并发串号事故的根源。 */
  const clientNcm = String(req.headers['x-ncm-cookie'] || '').trim();
  const clientQq = String(req.headers['x-qq-session'] || '').trim();

  /* ---- 设置 ---- */
  if (p === '/api/settings' && req.method === 'GET') {
    const s = store.read();
    // 无状态服务器：本地 settings.json 里残留的 cookie 不算"已设置"（未登录就是未登录）
    const hasCookie = accounts.describe('netease').stateless
      ? false
      : !!(s.neteaseCookie || accounts.getActive('netease'));
    return sendJSON(res, {
      ...s,
      neteaseCookie: hasCookie ? '已设置' : '',
      accounts: {
        netease: accounts.describe('netease'),
        qq: accounts.describe('qq')
      },
      providers: {
        local: { available: localProvider.isAvailable(), count: localProvider.tracks.length },
        netease: { available: providers.netease.isAvailable(), capabilities: providers.netease.capabilities },
        qq: { available: !!(providers.qq && providers.qq.isAvailable()), capabilities: providers.qq ? providers.qq.capabilities : null }
      }
    });
  }

  if (p === '/api/settings' && req.method === 'POST') {
    const body = await readBody(req);
    let patch;
    try { patch = JSON.parse(body || '{}'); } catch (_) { return sendError(res, '参数错误', 400); }
    // 前端传 "已设置" 表示不修改 cookie
    if (patch.neteaseCookie === '已设置') delete patch.neteaseCookie;
    // 无状态服务器：任何形式的 cookie 都不接收、不落盘
    if (accounts.describe('netease').stateless) {
      delete patch.neteaseCookie;
    } else if (typeof patch.neteaseCookie === 'string' && patch.neteaseCookie.trim()) {
      // 桌面端：手动粘贴的 cookie 也走加密存储，绝不明文写 settings.json
      accounts.save('netease', patch.neteaseCookie.trim(), null);
      delete patch.neteaseCookie;
    }
    store.write(patch);
    refreshProviders();
    if (patch.musicDirs) rebuildLibrary(true);
    const s = store.read();
    const hasCookie = !!(s.neteaseCookie || accounts.getActive('netease'));
    return sendJSON(res, { ok: true, settings: { ...s, neteaseCookie: hasCookie ? '已设置' : '' } });
  }

  /* ---- 本地曲库 ---- */
  if (p === '/api/library') {
    const lib = rebuildLibrary(q.get('refresh') === '1');
    const withLyric = lib.tracks.reduce((n, t) => n + (t.hasLyric ? 1 : 0), 0);
    const withCover = lib.tracks.reduce((n, t) => n + (t.hasCover ? 1 : 0), 0);
    return sendJSON(res, {
      total: lib.tracks.length,
      withLyric,
      withCover,
      dirs: lib.dirs,
      scannedAt: lib.scannedAt,
      elapsed: lib.elapsed,
      tracks: lib.tracks.map(({ filePath, ...rest }) => rest)
    });
  }

  if (p === '/api/library/scan' && req.method === 'POST') {
    const lib = rebuildLibrary(true);
    return sendJSON(res, { ok: true, total: lib.tracks.length, elapsed: lib.elapsed });
  }

  /* ---- 目录浏览 ---- */
  if (p === '/api/fs/list') {
    try {
      return sendJSON(res, listDir(q.get('path') || ''));
    } catch (err) {
      return sendError(res, err.message, 400);
    }
  }

  /* ---- 搜索 ---- */
  if (p === '/api/search') {
    const keywords = (q.get('q') || '').trim();
    const providerId = q.get('provider') || 'local';
    const provider = providers[providerId];
    if (!provider) return sendError(res, '未知音源', 400);
    if (!provider.isAvailable()) {
      return sendError(res, providerId === 'netease'
        ? '网易云音源未配置，请在设置中填写 API 服务地址'
        : '本地曲库为空，请先添加音乐文件夹', 400);
    }
    try {
      const list = await provider.search(keywords, Number(q.get('limit') || 50));
      return sendJSON(res, { provider: providerId, total: list.length, tracks: list });
    } catch (err) {
      return sendError(res, err.message, 502);
    }
  }

  /* ---- 音频流 ---- */
  if (p.startsWith('/api/stream/')) {
    const [, , , providerId, id] = p.split('/');
    const provider = providers[providerId];
    if (!provider) return sendError(res, '未知音源', 404);

    const track = providerId === 'local'
      ? localProvider.getTrack(id)
      : await resolveOnlineTrack(providerId, id, q);
    if (!track) return sendError(res, '曲目不存在', 404);

    try {
      // quality/preview 可由前端按需指定（QQ：128/320/flac + 试听预览）
      const src = await provider.getStream(track, {
        quality: q.get('quality') || undefined,
        preview: q.get('preview') || undefined
      });
      if (src.filePath) return streamLocalFile(src.filePath, req, res);
      if (src.url) {
        // ★ 直连 CDN 模式（省流量 + 提速，v3.1）：拿到真实播放地址后 302 给客户端，
        //   音频字节不再经服务器转发。VIP 保障：getStream 在请求上下文里已携带
        //   用户的 Cookie/Token（x-ncm-cookie / x-qq-session），取到的链接自带鉴权。
        //   回退开关：settings.directStream = false（服务器级）或 ?proxy=1（单次请求）
        //   → 走旧的 pipe 代理。ExoPlayer 侧自定义 Referer/UA 头会随 302 一起带到 CDN。
        const wantProxy = q.get('proxy') === '1' || store.read().directStream === false;
        if (!wantProxy && providerId !== 'local') {
          res.writeHead(302, {
            Location: src.url,
            'Cache-Control': 'no-store'
          });
          return res.end();
        }
        const extra = {};
        if (providerId === 'netease') {
          extra['Referer'] = 'https://music.163.com/';
          extra['Origin'] = 'https://music.163.com';
        }
        return pipeRemote(src.url, req, res, extra);
      }
      return sendError(res, '该音源未返回可播放地址', 502);
    } catch (err) {
      return sendError(res, err.message, 502);
    }
  }

  /* ---- 封面 ---- */
  if (p.startsWith('/api/cover/')) {
    const [, , , providerId, id] = p.split('/');
    const track = await resolveOnlineTrack(providerId, id, q);
    if (!track) return sendError(res, '曲目不存在', 404);

    const cacheKey = `${providerId}:${id}`;
    const cached = coverCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 30 * 60 * 1000) {
      res.writeHead(200, {
        'Content-Type': cached.mime,
        'Content-Length': cached.data.length,
        'Cache-Control': 'public, max-age=1800'
      });
      return res.end(cached.data);
    }

    try {
      const provider = providers[providerId];
      const cover = await provider.getCover(track);
      if (!cover) {
        // 兜底：生成一张占位图（深色渐变色块）
        const svg = placeholderCover(track);
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=600' });
        return res.end(svg);
      }
      if (cover.redirect) {
        return pipeRemote(cover.redirect, req, res, { Referer: 'https://music.163.com/' });
      }
      if (coverCache.size > COVER_CACHE_MAX) coverCache.clear();
      coverCache.set(cacheKey, { mime: cover.mime, data: cover.data, ts: Date.now() });
      res.writeHead(200, {
        'Content-Type': cover.mime,
        'Content-Length': cover.data.length,
        'Cache-Control': 'public, max-age=1800'
      });
      return res.end(cover.data);
    } catch (err) {
      const svg = placeholderCover(track);
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
      return res.end(svg);
    }
  }

  /* ---- 歌词 ---- */
  if (p.startsWith('/api/lyric/')) {
    const [, , , providerId, id] = p.split('/');
    const track = await resolveOnlineTrack(providerId, id, q);
    if (!track) return sendError(res, '曲目不存在', 404);
    try {
      const lyric = await providers[providerId].getLyric(track);
      return sendJSON(res, lyric || { lrc: '', source: '无' });
    } catch (err) {
      return sendJSON(res, { lrc: '', source: '获取失败: ' + err.message });
    }
  }

  /* ---- 网易云：服务状态 ---- */
  if (p === '/api/netease/status') {
    const service = neteaseApi.status();
    const st = await neteaseProvider.status();
    return sendJSON(res, { ...st, service });
  }

  /* ---- 网易云：扫码登录（统一走 AccountManager，保留旧接口形状） ---- */
  if (p === '/api/netease/login/qr') {
    try {
      const qr = await accounts.startLogin('netease');
      return sendJSON(res, { key: qr.key, qrimg: qr.qrimg, qrurl: '' });
    } catch (err) {
      return sendError(res, '生成二维码失败：' + err.message, 502);
    }
  }

  if (p === '/api/netease/login/check') {
    return sendJSON(res, accounts.checkLogin('netease', q.get('key')));
  }

  /* ---- 网易云：退出登录 ---- */
  if (p === '/api/netease/logout' && req.method === 'POST') {
    accounts.clear('netease');
    refreshProviders();
    return sendJSON(res, { ok: true });
  }

  /* ---- 网易云：手动重启内置服务 ---- */
  if (p === '/api/netease/restart' && req.method === 'POST') {
    const res2 = await bootstrapEmbeddedApi();
    return sendJSON(res, { ...res2, service: neteaseApi.status() });
  }

  /* ==================================================================
     统一账号接口（AccountManager）：UI 只对接这三个动作
     ================================================================== */
  const accountMatch = p.match(/^\/api\/account\/(netease|qq|kugou)\/(status|login\/qr|login\/check|logout)$/);
  if (accountMatch) {
    const [, platform, action] = accountMatch;

    if (action === 'status') {
      const desc = accounts.describe(platform);
      // 平台实时状态优先（QQ 凭证在包内会话仓库，不走 AccountManager 存储）
      if (providers[platform] && providers[platform].platformApi && providers[platform].platformApi.status) {
        try {
          const st = await providers[platform].platformApi.status();
          desc.loggedIn = !!st.loggedIn;
          desc.user = st.loggedIn
            ? { nickname: st.nickname, avatarUrl: st.avatarUrl, userId: st.userId, vipType: st.vipType }
            : null;
          if (!st.loggedIn && desc.loggedIn) desc.reason = '凭证已失效，请重新登录';
        } catch (err) {
          desc.checkFailed = true;
          desc.reason = err.message;
        }
      }
      return sendJSON(res, desc);
    }

    if (action === 'login/qr') {
      try {
        // x-client-cred: 1 → 凭证只回给客户端，服务端不保存（手机端强制走这条）
        const clientHeld = String(req.headers['x-client-cred'] || '') === '1';
        return sendJSON(res, await accounts.startLogin(platform, { persist: !clientHeld }));
      } catch (err) {
        return sendError(res, err.message, 502);
      }
    }

    if (action === 'login/check') {
      const st = accounts.checkLogin(platform, q.get('key'));
      // ★ BFF 出口日志：pm2 logs 里直接可见"BFF 给前端回了什么"。
      console.log(`[accounts] check → ${platform} code=${st.code}`
        + ` 凭证=${st.credential ? st.credential.length + '字符' : '无'}`
        + ` user=${(st.user && st.user.nickname) || '-'} saved=${st.saved}`);
      return sendJSON(res, st);
    }

    if (action === 'logout') {
      // 平台自身的登出（QQ 要清包内会话仓库），再清本地存储
      try {
        const papi = providers[platform] && providers[platform].platformApi;
        if (papi && papi.logout) await papi.logout();
      } catch (_) {}
      accounts.clear(platform);
      refreshProviders();
      return sendJSON(res, { ok: true });
    }
  }

  /* ---- 统一歌单接口（PlaylistSession） ---- */
  if (p === '/api/playlists') {
    const platform = q.get('platform') || 'netease';
    // ★ 无凭证闸门：个人歌单绝不允许无 cookie/token 的请求触碰（本地曲库除外）
    if (platform === 'netease' || platform === 'qq') {
      let cred = platform === 'netease'
        ? String(req.headers['x-ncm-cookie'] || '').trim()
        : String(req.headers['x-qq-session'] || '').trim();
      // ★ 桌面单用户模式（非 STATELESS）：凭证在服务端加密会话里，前端从不透传头。
      //   此时回退读 provider 自持凭证再判空——401 硬闸门只拦"真没有任何凭证"的请求。
      //   STATELESS（移动端）维持原闸门：只认透传头，绝不读服务端会话。
      if (!cred && !STATELESS) {
        cred = platform === 'netease'
          ? String((neteaseProvider && neteaseProvider.cookie) || '').trim()
          : String((qqProviderInstance && qqProviderInstance.token) || '').trim();
        if (cred) console.log(`[playlists] ${platform} 无透传头 → 回退服务端本地会话凭证（桌面单用户）`);
      }
      console.log(`[playlists] platform=${platform} 凭证头=${cred ? '有(' + cred.slice(0, 12) + '…)' : '(空)'}`);
      if (!cred) return sendError(res, '未登录，无法获取个人歌单', 401);
    }
    const adapter = providers[platform];
    if (!adapter) return sendError(res, '未知平台', 400);
    if (!adapter.capabilities.playlists) {
      return sendJSON(res, { supported: false, playlists: [] });
    }
    try {
      return sendJSON(res, { supported: true, playlists: await playlistSession.list(adapter) });
    } catch (err) {
      return sendError(res, err.message, 502);
    }
  }

  if (p === '/api/playlist/tracks') {
    const platform = q.get('platform') || 'netease';
    // ★ 同类泄漏面：/playlist/track/all 知道 pid 即可公开拉取，无凭证一律 401
    //   （STATELESS 移动端维持硬闸门；桌面单用户回退服务端会话凭证，同 /api/playlists）
    if (platform === 'netease' || platform === 'qq') {
      let cred = platform === 'netease'
        ? String(req.headers['x-ncm-cookie'] || '').trim()
        : String(req.headers['x-qq-session'] || '').trim();
      if (!cred && !STATELESS) {
        cred = platform === 'netease'
          ? String((neteaseProvider && neteaseProvider.cookie) || '').trim()
          : String((qqProviderInstance && qqProviderInstance.token) || '').trim();
        if (cred) console.log(`[playlist/tracks] ${platform} 无透传头 → 回退服务端本地会话凭证（桌面单用户）`);
      }
      console.log(`[playlist/tracks] platform=${platform} 凭证=${cred ? '有' : '(空)'}`);
      if (!cred) return sendError(res, '未登录，无法获取歌单内容', 401);
    }
    const adapter = providers[platform];
    if (!adapter) return sendError(res, '未知平台', 400);
    try {
      const r = await playlistSession.tracks(adapter, q.get('id') || '', {
        offset: Number(q.get('offset') || 0),
        limit: Math.min(200, Number(q.get('limit') || 50))
      });
      return sendJSON(res, r);
    } catch (err) {
      return sendError(res, err.message, 502);
    }
  }

  /* ---- 动态来源：心动模式 / 私人漫游 / 本地电台 ---- */
  if (p === '/api/dynamic/session' && req.method === 'POST') {
    const body = await readBody(req);
    let data;
    try { data = JSON.parse(body || '{}'); } catch (_) { return sendError(res, '参数错误', 400); }
    const platform = data.platform || 'local';
    const type = data.type || 'localRadio';
    try {
      // seed：心动模式需要 { id: 种子歌曲nid, pid: 歌单id }；本地电台忽略
      const seed = data.seed || (data.seedTrackId ? { id: data.seedTrackId } : null);

      /* 目标 BPM：优先客户端显式传入，否则读 analysis.json 缓存里种子歌曲的 BPM */
      let bpm = Math.round(Number(data.bpm) || 0);
      if (!bpm && seed) {
        const key = String(seed.trackId || seed.id || seed.seedMid || '');
        if (key) bpm = bpmOfTrackId(key);
      }

      const r = playlistSession.createDynamic(platform, type, seed, {
        localTracks: localProvider.tracks,
        bpm
      });
      return sendJSON(res, { ok: true, bpm, ...r });
    } catch (err) {
      return sendError(res, err.message, 400);
    }
  }

  if (p === '/api/dynamic/next') {
    const platform = q.get('platform') || 'local';
    const adapter = platform === 'mix' ? buildMixAdapter() : providers[platform];
    if (!adapter) return sendError(res, '未知平台', 400);
    try {
      const r = await playlistSession.next(adapter, q.get('session') || '', Math.min(10, Number(q.get('n') || 1)));
      return sendJSON(res, r);
    } catch (err) {
      return sendError(res, err.message, 502);
    }
  }

  /* ---- 通用写操作：喜欢 / 加歌 / 建歌单（按 platform 精准路由，跨平台防错） ---- */
  if (p === '/api/track/like' && req.method === 'POST') {
    const body = await readBody(req);
    let d; try { d = JSON.parse(body || '{}'); } catch (_) { return sendError(res, '参数错误', 400); }
    const adapter = providers[d.platform];
    if (!adapter) return sendError(res, '未知平台', 400);
    try {
      return sendJSON(res, await adapter.likeTrack(d.track || {}, !!d.like));
    } catch (err) {
      return sendError(res, err.message, 502);
    }
  }

  if (p === '/api/track/add-to' && req.method === 'POST') {
    const body = await readBody(req);
    let d; try { d = JSON.parse(body || '{}'); } catch (_) { return sendError(res, '参数错误', 400); }
    const adapter = providers[d.platform];
    if (!adapter) return sendError(res, '未知平台', 400);
    try {
      return sendJSON(res, await adapter.addToPlaylist(d.track || {}, d.playlistId));
    } catch (err) {
      return sendError(res, err.message, 502);
    }
  }

  if (p === '/api/playlist/create' && req.method === 'POST') {
    const body = await readBody(req);
    let d; try { d = JSON.parse(body || '{}'); } catch (_) { return sendError(res, '参数错误', 400); }
    const adapter = providers[d.platform];
    if (!adapter) return sendError(res, '未知平台', 400);
    try {
      return sendJSON(res, await adapter.createPlaylist(d.name || ''));
    } catch (err) {
      return sendError(res, err.message, 502);
    }
  }

  /* ---- 自定义背景图（落盘 data/background.img，GET 直接回图） ---- */
  if (p === '/api/background' && req.method === 'POST') {
    const body = await readBody(req);
    let d; try { d = JSON.parse(body || '{}'); } catch (_) { return sendError(res, '参数错误', 400); }
    const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/.exec(d.data || '');
    if (!m) return sendError(res, '仅支持 png/jpg/webp 图片', 400);
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 25 * 1024 * 1024) return sendError(res, '图片超过 25MB，请压缩后重试', 400);
    try {
      if (!fs.existsSync(DATA_DIR2)) fs.mkdirSync(DATA_DIR2, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR2, 'background.img'), buf);
      store.write({ customBg: true });
      return sendJSON(res, { ok: true });
    } catch (err) {
      return sendError(res, '保存失败：' + err.message, 500);
    }
  }

  if (p === '/api/background' && req.method === 'DELETE') {
    try { fs.existsSync(path.join(DATA_DIR2, 'background.img')) && fs.unlinkSync(path.join(DATA_DIR2, 'background.img')); } catch (_) {}
    store.write({ customBg: false });
    return sendJSON(res, { ok: true });
  }

  if (p === '/api/background' && req.method === 'GET') {
    const f = path.join(DATA_DIR2, 'background.img');
    if (!fs.existsSync(f)) return sendError(res, 'no background', 404);
    const buf = fs.readFileSync(f);
    // 简易嗅探格式
    let mime = 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png';
    else if (buf[0] === 0x52 && buf[1] === 0x49) mime = 'image/webp';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    return res.end(buf);
  }

  /* ---- 本地独立歌单（脱离平台，混合存储网易云/QQ 歌曲） ---- */
  if (p === '/api/local-playlists' && req.method === 'GET') {
    return sendJSON(res, { ok: true, playlists: localPl.list(), likedKeys: localPl.likedKeys() });
  }

  if (p === '/api/local-playlists' && req.method === 'POST') {
    const body = await readBody(req);
    let d; try { d = JSON.parse(body || '{}'); } catch (_) { return sendError(res, '参数错误', 400); }
    if (d.action === 'create') return sendJSON(res, localPl.create(d.name));
    if (d.action === 'delete') return sendJSON(res, localPl.remove(d.id));
    if (d.action === 'rename') return sendJSON(res, localPl.rename(d.id, d.name));
    if (d.action === 'add-track') return sendJSON(res, localPl.addTrack(d.id, d.track));
    if (d.action === 'remove-track') return sendJSON(res, localPl.removeTrack(d.id, d.track));
    if (d.action === 'like') return sendJSON(res, localPl.like(d.track, !!d.like));
    return sendError(res, '未知操作', 400);
  }

  if (p === '/api/local-playlists/tracks' && req.method === 'GET') {
    const t = localPl.tracks(q.get('id') || '');
    if (!t) return sendError(res, '歌单不存在', 404);
    return sendJSON(res, { ok: true, ...t });
  }

  /* ---- 自动识别本机音乐软件目录 ---- */
  if (p === '/api/detect') {
    return sendJSON(res, { dirs: detectMusicDirs() });
  }

  /* ---- 歌曲能量分析缓存 ---- */
  if (p.startsWith('/api/analysis/')) {
    const trackId = decodeURIComponent(p.slice('/api/analysis/'.length)).replace(/\.\./g, '');

    if (req.method === 'GET') {
      const data = analysisCache.read(trackId);
      if (!data || !Array.isArray(data.energy) || !data.energy.length) {
        return sendJSON(res, { ok: false });
      }
      return sendJSON(res, { ok: true, data });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); } catch (_) {
        return sendError(res, '无效 JSON', 400);
      }
      if (!parsed || !Array.isArray(parsed.energy) || !parsed.energy.length) {
        return sendError(res, '缺少 energy 数据', 400);
      }
      // 服务端补上落盘时间戳
      parsed.savedAt = Date.now();
      analysisCache.write(trackId, parsed);
      return sendJSON(res, { ok: true });
    }

    return sendError(res, '不支持的请求', 405);
  }

  /* ---- 系统信息 ---- */
  if (p === '/api/health') {
    return sendJSON(res, { ok: true, platform: process.platform, node: process.version });
  }

  return sendError(res, '接口不存在', 404);
}

/** 在线曲目解析：id 可能是纯数字，也可能是带参数的 JSON */
async function resolveOnlineTrack(providerId, id, q) {
  if (providerId === 'local') return localProvider.getTrack(id);
  const adapter = providers[providerId];
  if (!adapter) return null;
  // meta 里带曲目元信息（标题/封面/GD 的 picId/lyricId），免去一次详情请求
  const metaRaw = q.get('meta');
  let meta = {};
  if (metaRaw) {
    try { meta = JSON.parse(Buffer.from(metaRaw, 'base64').toString('utf8')) || {}; } catch (_) {}
  }
  return adapter.buildTrack(decodeURIComponent(id), meta);
}

function placeholderCover(track) {
  const ch = (track && track.title ? track.title[0] : '♪').toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#2b2340"/>
      <stop offset="50%" stop-color="#1a1b2e"/>
      <stop offset="100%" stop-color="#0d1a24"/>
    </linearGradient>
    <radialGradient id="r" cx="35%" cy="30%" r="70%">
      <stop offset="0%" stop-color="#6d5cff" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#6d5cff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="600" height="600" fill="url(#g)"/>
  <rect width="600" height="600" fill="url(#r)"/>
  <text x="300" y="345" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="220"
        fill="#ffffff" fill-opacity="0.14" text-anchor="middle">${escapeXML(ch)}</text>
</svg>`;
}

function escapeXML(s) {
  return String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

/** 自动探测本机常见音乐软件目录 */
function detectMusicDirs() {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Music', 'CloudMusic'),
    path.join(home, 'Music'),
    path.join(home, 'Music', 'QQMusic'),
    path.join(home, 'Desktop', '音乐'),
    'D:\\CloudMusic\\music',
    'D:\\CloudMusic\\Music',
    'D:\\Music',
    'E:\\Music',
    'D:\\CloudMusic',
    path.join(home, 'Documents', 'Tencent Files')
  ];
  const found = [];

  for (const c of candidates) {
    try {
      if (!fs.existsSync(c) || !fs.statSync(c).isDirectory()) continue;

      let audioCount = 0;
      let exeCount = 0;
      const walk = (d, depth) => {
        if (audioCount > 0 || exeCount > 8 || depth > 3) return;
        let list = [];
        try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const e of list) {
          if (audioCount > 0 || exeCount > 8) return;
          if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            walk(path.join(d, e.name), depth + 1);
          } else if (isAudio(e.name)) {
            audioCount++;
          } else if (/\.(exe|dll)$/i.test(e.name)) {
            exeCount++;
          }
        }
      };
      walk(c, 0);

      // 有音频、且不像软件安装目录
      if (audioCount > 0 && exeCount <= 8) found.push(c);
    } catch (_) {}
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* 扫码登录的轮询已统一收敛到 AccountManager（server/lib/accounts.js）， */
/* 这里只保留 cookie 提取工具给平台登录后端使用。                        */
/* ------------------------------------------------------------------ */

/** cookie 属性名，不能当成键值对存下来 */
const COOKIE_ATTRS = new Set([
  'path', 'domain', 'expires', 'max-age', 'httponly', 'secure',
  'samesite', 'priority', 'partitioned', 'version', 'comment'
]);

/** 从网易云接口响应中提取登录 cookie（Set-Cookie 头优先，响应体兜底） */
function extractLoginCookie(r) {
  if (!r) return '';
  const pairs = new Map();

  const add = (raw) => {
    if (!raw) return;
    for (const seg of String(raw).split(';')) {
      const s = seg.trim();
      if (!s) continue;
      const eq = s.indexOf('=');
      if (eq <= 0) continue;
      const k = s.slice(0, eq).trim();
      const v = s.slice(eq + 1).trim();
      if (!k || /\s/.test(k)) continue;
      if (COOKIE_ATTRS.has(k.toLowerCase())) continue;
      pairs.set(k, v);
    }
  };

  // 1) Set-Cookie 头：每个元素只取第一段（k=v），后面的都是属性
  const sc = (r.__headers || {})['set-cookie'];
  if (Array.isArray(sc)) {
    for (const c of sc) add(String(c).split(';')[0]);
  } else if (typeof sc === 'string' && sc) {
    add(sc.split(';')[0]);
  }
  // 2) 响应体里的 cookie 字段（可能是多个拼在一起的）
  if (typeof r.cookie === 'string' && r.cookie) add(r.cookie);

  if (!pairs.size) return '';
  return [...pairs.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function readBody(req, maxBytes = 40 * 1024 * 1024) {
  // 默认上限 40MB：主要为了自定义背景图（base64 膨胀约 1.37 倍，25MB 图 ≈ 34MB）
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 允许同源之外的本地调试
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, x-ncm-cookie, x-qq-session, x-client-cred');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (url.pathname.startsWith('/api/')) {
    try {
      // ★ 每请求凭证上下文：透传头只存进 AsyncLocalStorage，
      //   绝不写进 provider 单例 —— 否则并发用户会互相串号（已发生过的安全事故）
      const ctx = {
        ncm: String(req.headers['x-ncm-cookie'] || '').trim(),
        qq: String(req.headers['x-qq-session'] || '').trim()
      };
      await reqCtx.als.run(ctx, () => handleApi(req, res, url));
    } catch (err) {
      console.error('[api]', url.pathname, err.message);
      if (!res.headersSent) sendError(res, err.message || '服务器内部错误', 500);
    }
    return;
  }

  serveStatic(req, res, url.pathname);
});

let bootstrapped = false;

function start(opts = {}) {
  const port = Number(opts.port || PORT);
  const autoOpen = opts.open !== false && !process.argv.includes('--no-open');

  // 端口被占用时 start 会被递归调用，这些初始化只做一次
  if (!bootstrapped) {
    bootstrapped = true;

    // 首次启动自动探测音乐目录；没有任何音乐时接入内置演示曲库
    const settings = store.read();
    const DEMO_DIR = path.join(__dirname, '..', 'demo');
    const hasDemo = fs.existsSync(DEMO_DIR);

    if (!settings.musicDirs || settings.musicDirs.length === 0) {
      const detected = detectMusicDirs();
      const dirs = [];
      if (detected.length) {
        dirs.push(...detected);
        console.log('[init] 自动识别到音乐目录:', detected.join(', '));
      }
      if (hasDemo && !dirs.includes(DEMO_DIR)) {
        dirs.push(DEMO_DIR);
        console.log('[init] 接入内置演示曲库:', DEMO_DIR);
      }
      if (dirs.length) store.write({ musicDirs: dirs });
    } else {
      // 已有配置：确认这些目录里还真的有音频（文件夹可能被移动或删除了）
      let hasAny = false;
      for (const d of settings.musicDirs) {
        try {
          if (!fs.existsSync(d)) continue;
          const stack = [d];
          let depth = 0;
          while (stack.length && !hasAny && depth < 600) {
            const cur = stack.pop();
            let list = [];
            try { list = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { continue; }
            for (const e of list) {
              if (e.isFile() && isAudio(e.name)) { hasAny = true; break; }
              if (e.isDirectory() && !e.name.startsWith('.')) stack.push(path.join(cur, e.name));
            }
            depth++;
          }
        } catch (_) {}
        if (hasAny) break;
      }

      if (!hasAny) {
        const dirs = [];
        if (hasDemo) {
          dirs.push(DEMO_DIR);
          console.log('[init] 配置的目录里没有找到音频，重新接入内置演示曲库');
        }
        for (const d of detectMusicDirs()) {
          if (!dirs.includes(d)) dirs.push(d);
        }
        if (dirs.length) store.write({ musicDirs: dirs });
      }
    }

    rebuildLibrary(true);

    // 后台拉起内置网易云音源，不阻塞主服务
    bootstrapEmbeddedApi();
  }

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE') {
        // 端口被占用时自动换一个，不影响已有实例
        if (port < 7799) {
          console.warn(`[init] 端口 ${port} 被占用，尝试 ${port + 1}`);
          server.removeListener('error', onError);
          start({ ...opts, port: port + 1 }).then(resolve, reject);
          return;
        }
        reject(new Error(`端口 ${port} 及后续端口均被占用`));
        return;
      }
      reject(err);
    };

    server.once('error', onError);
    server.listen(port, HOST, () => {
      server.removeListener('error', onError);
      const url = `http://${HOST}:${port}/`;
      console.log('');
      console.log('  ╭──────────────────────────────────────────╮');
      console.log('  │   Aurora 极光音乐播放器  v1.0            │');
      console.log('  ├──────────────────────────────────────────┤');
      console.log(`  │   服务已启动: ${url.padEnd(28)}│`);
      console.log('  │   按 Ctrl+C 停止服务                     │');
      console.log('  ╰──────────────────────────────────────────╯');
      console.log('');

      if (autoOpen) {
        const { exec } = require('child_process');
        const cmd = process.platform === 'win32' ? `start "" "${url}"`
          : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
        exec(cmd, () => {});
      }
      resolve({ port, url });
    });
  });
}

process.on('SIGINT', () => {
  console.log('\n正在关闭播放器...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});

// 直接运行（node server/index.js）时自动启动；被 Electron 主进程 require 时只导出
if (require.main === module) {
  start().catch((err) => {
    console.error('服务启动失败:', err.message);
    process.exit(1);
  });
}

module.exports = { start, server };
