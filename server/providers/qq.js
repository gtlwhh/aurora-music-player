'use strict';
const { STATELESS } = require('../lib/accounts');
/**
 * QQ 音乐平台适配器（SourceAdapter 平台补充实现）
 *
 * 搜索、取链、歌词、歌单全部走本地内嵌的 QQ 音乐 API 服务
 * （server/lib/qq-api.js，直连 QQ 官方接口），绝不依赖 GD Studio 取链。
 *
 * trackId 规范：key = songmid（稳定），即 qq--<songmid>。
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

function getJSON(base, pathname, params = {}, timeout = 12000) {
  const u = new URL(base + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.append(k, String(v));
  }
  return new Promise((resolve, reject) => {
    const req = http.request(u, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (_) { reject(new Error('QQ 接口返回不是 JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('QQ 接口请求超时')));
    req.end();
  });
}

/** 专辑封面 CDN 直链（QQ 官方图片 CDN，公开格式） */
function albumPicUrl(albumMid, size = 500) {
  if (!albumMid) return '';
  return `https://y.gtimg.cn/music/photo_new/T002R${size}x${size}M000${albumMid}.jpg`;
}

/** QQ 取链失败的可识别错误：前端据此提示"QQ版权受限"并跳过 */
function restrictedError(detail) {
  const e = new Error('QQ版权受限：' + (detail || '该曲目暂无可播放链接'));
  e.code = 'QQ_RESTRICTED';
  return e;
}

class QqProvider {
  /**
   * @param baseUrl   内嵌 QQ 服务地址
   * @param tokenStore { getToken, setToken }  会话 token 的加密存取（由 qq-api.js 提供）
   */
  constructor(baseUrl, tokenStore = {}) {
    this.id = 'qq';
    this.name = 'QQ音乐';
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this._getToken = tokenStore.getToken || (() => '');
    this._setToken = tokenStore.setToken || (() => {});
  }

  get token() {
    // 唯一来源：当前请求上下文（手机，互相隔离）或加密会话仓库（桌面单用户）。
    // 实例上零凭证状态 —— 并发几百个请求也不可能互通。
    const { ctxCredential } = require('../lib/req-context');
    // 无状态（ECS/纯 Node）：只认请求头透传，绝不读旧会话文件缓存。
    if (STATELESS) return ctxCredential('qq');
    return ctxCredential('qq') || this._getToken() || '';
  }

  isAvailable() { return !!this.baseUrl; }

  /** 接口级统一取用：非 200 code 视为业务失败；自动附带会话 token */
  async api(pathname, params = {}, opt = {}) {
    const u = new URL(this.baseUrl + pathname);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.append(k, String(v));
    }
    const headers = { 'Accept': 'application/json' };
    // 显式传入的令牌优先（扫码刚成功、请求头里还没有凭证时用）
    const authToken = opt.token || this.token;
    if (authToken) headers['x-qq-session'] = authToken;     // 认证调用统一走这个头

    const res = await new Promise((resolve, reject) => {
      const req = http.request(u, { method: 'GET', headers }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.setTimeout(opt.timeout || 12000, () => req.destroy(new Error('QQ 接口请求超时')));
      req.end();
    });

    let data;
    try { data = JSON.parse(res.body); }
    catch (_) { throw new Error('QQ 接口返回不是 JSON'); }

    // 扫码成功（803）：从 Set-Cookie / 响应体的 cookie 字段捕获会话 token，加密落盘
    if (pathname === '/login/qr/check' && data && data.code === 803) {
      let token = '';
      const setCookie = res.headers['set-cookie'];
      if (Array.isArray(setCookie)) {
        for (const c of setCookie) {
          const m = /qqmusic_session=([^;]+)/.exec(String(c));
          if (m && m[1]) { token = m[1]; break; }
        }
      }
      if (!token && typeof data.cookie === 'string') {
        const m = /qqmusic_session=([^;]+)/.exec(data.cookie);
        if (m && m[1]) token = m[1];
      }
      if (token) {
        this._setToken(token);
        // 令牌属于本次登录请求：写进请求上下文带回（ALS 可用时），
        // ★ 同时挂到返回值上 —— AccountManager 的轮询 tick 跑在定时器上下文里
        //   （ALS store 为 undefined），靠返回值传递才能拿到令牌（网易云同理靠响应头）。
        try {
          const { als } = require('../lib/req-context');
          const st = als.getStore();
          if (st) st.qqLoginToken = token;
        } catch (_) {}
        try { data.__qqToken = token; } catch (_) {}
      }
    }

    // ★ 扫码轮询接口 /login/qr/check 用 800/801/802/803 表达「状态」而非「错误」：
    //   801=等待扫码 802=已扫码待确认 803=确认成功。此前这里的通用门禁把它们全当
    //   业务失败 throw 掉，803 的令牌随异常一起蒸发，服务端 tick 的 catch 再把
    //   异常吞掉 → 前端永远只看到 801（已扫码/已确认全都"不存在"）。
    //   该路径必须原样放行，状态判断交给上层（server/index.js 的 qrCheck）。
    if (pathname !== '/login/qr/check' && data && data.code && data.code !== 200) {
      const err = new Error(data.message || data.error || ('QQ 接口错误 code=' + data.code));
      err.code = data.errorKey || ('QQ_CODE_' + data.code);
      err.retryable = !!data.retryable;
      throw err;
    }
    return data;
  }

  /** 搜索结果 → 统一曲目 */
  mapSong(item) {
    const mid = item.mid || item.songmid;
    const singers = (item.singer || item.singers || []).map(s => s.name).join(' / ') || '未知艺术家';
    const album = item.album || {};
    return {
      id: `qq_${mid}`,
      provider: 'qq',
      sourceId: `qq:${mid}`,
      gid: String(mid),
      songId: item.id,                              // 数字 id（写操作要用，如点喜欢）
      title: item.name || item.songname || item.title || '未知曲目',
      artist: singers,
      album: album.name || album.title || item.albumname || '',
      albumId: album.mid || item.albummid || '',
      picUrl: albumPicUrl(album.mid || item.albummid),
      duration: (item.interval || 0) * 1000,        // QQ 是秒，统一成毫秒
      hasCover: !!album.mid,
      hasLyric: true
    };
  }

  /** POST（QQ 写操作全走 POST + x-qq-session token） */
  async post(pathname, body = {}) {
    const u = new URL(this.baseUrl + pathname);
    const token = this.token;
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request(u, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(token ? { 'x-qq-session': token } : {})
        }
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (_) { reject(new Error('QQ 接口返回不是 JSON')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(12000, () => req.destroy(new Error('QQ 接口请求超时')));
      req.end(payload);
    });
  }

  /** 点喜欢 / 取消喜欢（QQ 需要 数字 id + mid） */
  async likeTrack(track, like) {
    const mid = track.gid || String(track.sourceId || '').split(':')[1];
    const songId = Number(track.songId);
    if (!mid || !songId) throw new Error('缺少歌曲信息，无法收藏');
    const data = await this.post('/user/song/like', {
      song: { id: songId, mid, type: 0 },
      liked: !!like
    });
    if (data && data.code && data.code !== 200) {
      throw new Error(data.message || ('收藏失败 code=' + data.code));
    }
    return { ok: true };
  }

  /** 加入自建歌单（tid 必须是自建歌单，系统目录会被官方拒绝） */
  async addToPlaylist(track, playlistId) {
    const mid = track.gid || String(track.sourceId || '').split(':')[1];
    const songId = Number(track.songId);
    const tid = Number(playlistId);
    if (!mid || !songId || !tid) throw new Error('缺少歌曲或歌单信息');
    const data = await this.post('/user/playlist/tracks', {
      tid,
      op: 'add',
      songs: [{ id: songId, type: 0 }]
    });
    if (data && data.code && data.code !== 200) {
      throw new Error(data.message || ('添加失败 code=' + data.code));
    }
    return { ok: true };
  }

  /** 新建自建歌单 */
  async createPlaylist(name) {
    const data = await this.post('/user/playlist/create', { name: String(name || '').slice(0, 40) });
    if (data && data.code && data.code !== 200) {
      throw new Error(data.message || ('创建失败 code=' + data.code));
    }
    const id = data && data.data && (data.data.tid || data.data.id);
    return { ok: true, id: id !== undefined ? String(id) : '' };
  }

  async search(keyword, limit = 30, page = 1) {
    const trace = [];
    // ① 主搜索：内嵌服务（有会话带会话；无会话自带"精简版匿名身份"musicu.fcg）
    try {
      const data = await this.api('/search', { keyword, limit, page });
      const items = (data.items || data.data || []).map(x => this.mapSong(x));
      if (items.length) return items;
      trace.push('主搜索空结果');
    } catch (err) {
      trace.push('主搜索:' + (err.message || err));
    }
    // ② 游客 Cookie 兜底：服务器曾缓存过的真实会话令牌（仅用于搜索，不写账号存储）
    if (!this.token) {
      const gt = this._loadGuestToken();
      if (gt) {
        try {
          const data = await this.api('/search', { keyword, limit, page }, { token: gt });
          const items = (data.items || data.data || []).map(x => this.mapSong(x));
          if (items.length) {
            console.log('[qq] 游客搜索：✓ 缓存令牌兜底成功');
            return items;
          }
          trace.push('游客Cookie空结果');
        } catch (err) {
          trace.push('游客Cookie:' + (err.message || err));
        }
      }
    }
    // ②.5 musicu.fcg 匿名直连（comm 带 tmeLoginType:-1 + 随机 search_id，curl 实测稳定出歌）
    try {
      const lite = await this.searchMusicuLite(keyword, limit);
      if (lite.length) {
        console.log('[qq] 游客搜索：✓ musicu.fcg 匿名直连兜底成功');
        return lite.map(x => this.mapSong(x));
      }
      trace.push('musicuLite空结果');
    } catch (err) {
      trace.push('musicuLite:' + (err.message || err));
    }
    // ③ soso 公共接口（不同主机 c.y.qq.com）
    try {
      const pub = await this.searchPublic(keyword, limit);
      if (pub.length) {
        console.log('[qq] 游客搜索：✓ soso 公共接口兜底成功');
        return pub.map(x => this.mapSong(x));
      }
      trace.push('soso空结果');
    } catch (err) {
      trace.push('soso:' + (err.message || err));
    }
    // ④ GD Studio 公共搜索（仅搜索，绝不用于取链）
    try {
      const gd = await this.searchGD(keyword, limit);
      if (gd.length) {
        console.log('[qq] 游客搜索：✓ GD 公共搜索兜底成功');
        return gd;
      }
      trace.push('GD空结果');
    } catch (err) {
      trace.push('GD:' + (err.message || err));
    }
    throw new Error('QQ 搜索失败（' + trace.join(' | ') + '）');
  }

  /** 搜索兜底令牌的存取（data/cache/ 下，仅用于游客搜索，绝不写进账号存储） */
  _guestTokenPath() {
    const { fileInData } = require('../lib/paths');
    return fileInData('cache', 'qq-guest-token.txt');
  }
  saveGuestToken(token) {
    try {
      if (!token) return;
      const fs = require('fs');
      const path = require('path');
      const p = this._guestTokenPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(token), 'utf8');
      console.log('[qq] 已缓存搜索兜底令牌（' + String(token).length + ' 字符，仅用于游客搜索）');
    } catch (_) {}
  }
  _loadGuestToken() {
    try {
      const fs = require('fs');
      return fs.readFileSync(this._guestTokenPath(), 'utf8').trim() || '';
    } catch (_) { return ''; }
  }

  /**
   * 兜底②：musicu.fcg 匿名直连（完整复刻内嵌包精简版客户端，已 curl 实测稳定出歌）。
   * 两个命门：① comm 里必须带 tmeLoginType:-1（只放 Cookie 不够，缺了回 2001 空结果）；
   *          ② search_id 每次随机（重复使用会被限流返回空清单）。
   * 匿名搜歌 search_type 必须送 7（上游已不认 0）。
   */
  searchMusicuLite(keyword, limit = 30) {
    const sid = `${Math.floor(Math.random() * 9 + 1)}${Array.from({ length: 17 }, () => Math.floor(Math.random() * 10)).join('')}`;
    const payload = JSON.stringify({
      comm: {
        ct: 11,
        cv: '1003006',
        v: '1003006',
        tmeAppID: 'qqmusiclight',
        tmeLoginType: -1,
        nettype: 'NETWORK_WIFI',
        uid: '0',
        udid: '0'
      },
      req_0: {
        module: 'music.search.SearchCgiService',
        method: 'DoSearchForQQMusicLite',
        param: {
          search_id: sid,
          remoteplace: 'search.android.keyboard',
          query: String(keyword || ''),
          search_type: 7,
          num_per_page: Math.min(Math.max(limit, 1), 20),
          page_num: 1,
          highlight: 0,
          nqc_flag: 0,
          page_id: 1,
          grp: 1
        }
      }
    });
    const u = new URL('https://u.y.qq.com/cgi-bin/musicu.fcg');
    return new Promise((resolve, reject) => {
      const req = https.request(u, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'tmeLoginType=-1',
          'User-Agent': 'okhttp/3.14.9',
          'Referer': 'https://y.qq.com/'
        }
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const d = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const r = d && d.req_0;
            if (!r || (r.code !== undefined && r.code !== 0)) {
              throw new Error('musicu 内层 code=' + ((r && r.code) || '?'));
            }
            resolve((r.data && r.data.body && r.data.body.item_song) || []);
          } catch (e) { reject(new Error('musicu 匿名搜索解析失败: ' + (e.message || e))); }
        });
      });
      req.on('error', reject);
      req.setTimeout(12000, () => req.destroy(new Error('musicu 匿名搜索超时')));
      req.write(payload);
      req.end();
    });
  }

  /**
   * 兜底③：QQ 经典公共搜索接口（c.y.qq.com soso），无需任何登录态。
   * 字段与 mapSong 兼容（songmid/songname/singer[]/albummid/interval）。
   */
  searchPublic(keyword, limit = 30) {    const u = new URL('https://c.y.qq.com/soso/fcgi-bin/client_search_cp');
    u.searchParams.set('w', String(keyword || ''));
    u.searchParams.set('format', 'json');
    u.searchParams.set('p', '1');
    u.searchParams.set('n', String(Math.min(Math.max(limit, 1), 50)));
    u.searchParams.set('cr', '1');
    u.searchParams.set('loginUin', '0');
    return new Promise((resolve, reject) => {
      const req = https.request(u, {
        method: 'GET',
        headers: {
          'Referer': 'https://y.qq.com/',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
          'Accept': 'application/json'
        }
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            let body = Buffer.concat(chunks).toString('utf8').trim();
            // 兼容 jsonp 包装：剥掉 callback(...) 外壳
            if (!body.startsWith('{')) body = body.replace(/^[\w$.]+\(/, '').replace(/\)\s*;?\s*$/, '');
            const d = JSON.parse(body);
            resolve((d.data && d.data.song && d.data.song.list) || []);
          } catch (e) { reject(new Error('QQ 公共搜索返回解析失败')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(12000, () => req.destroy(new Error('QQ 公共搜索超时')));
      req.end();
    });
  }

  /**
   * 兜底④：GD Studio 公共搜索（Metting 格式，source=qqmusic）。
   * 仅用于"搜出歌"，绝不用于取链；连通性因 IP 而异，失败静默降级。
   */
  searchGD(keyword, limit = 30) {
    const base = process.env.GD_BASE_URL || 'https://music-api.gdstudio.xyz/api.php';
    const u = new URL(base);
    u.searchParams.set('types', 'search');
    u.searchParams.set('source', 'qqmusic');
    u.searchParams.set('name', String(keyword || ''));
    u.searchParams.set('count', String(Math.min(Math.max(limit, 1), 30)));
    u.searchParams.set('pages', '1');
    return new Promise((resolve, reject) => {
      const req = https.request(u, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
          'Accept': 'application/json'
        }
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const d = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const arr = Array.isArray(d) ? d : [];
            // Meting(qqmusic) 字段 → mapSong 形状
            resolve(arr.map(raw => ({
              songmid: raw.id,
              name: raw.name,
              singer: String(raw.artist || '').split('/').filter(Boolean).map(s => ({ name: s.trim() })),
              albumname: raw.album || '',
              albummid: raw.album_id || '',
              interval: 0
            })));
          } catch (e) { reject(new Error('GD 公共搜索返回解析失败')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(12000, () => req.destroy(new Error('GD 公共搜索超时')));
      req.end();
    });
  }

  /**
   * 取链：/getMusicPlay/:songmid?quality=N
   * quality: 128 / 320 / flac（由音质档位偏好映射，拿不到自动降档）
   */
  async getStream(track, opts = {}) {
    const mid = track.gid || String(track.sourceId || '').split(':')[1];
    if (!mid) throw new Error('缺少 QQ 歌曲 songmid');

    const QUALITIES = ['flac', '320', '128'];
    const want = String(opts.quality || '320').toLowerCase();
    const startIdx = Math.max(0, QUALITIES.indexOf(want));

    let lastErr = null;
    for (let i = startIdx; i < QUALITIES.length; i++) {
      try {
        const data = await this.api(`/getMusicPlay/${encodeURIComponent(mid)}`, { quality: QUALITIES[i] });
        const info = data && data.data && data.data.playUrl && data.data.playUrl[mid];
        if (info && info.url) {
          return {
            url: info.url,
            level: QUALITIES[i],
            via: 'qq-official',
            downgraded: i !== startIdx
          };
        }
        // 官方明确返回 restriction / error → 风控或版权，不再降档重试
        const restriction = info && info.restriction;
        lastErr = restrictedError(
          (restriction && (restriction.hint && restriction.hint.message || restriction.key)) ||
          (info && info.error) || '空链接'
        );
        break;
      } catch (err) {
        lastErr = err;
        // 网络/超时类错误才降档重试；明确的业务限制直接抛
        if (err.code === 'QQ_RESTRICTED') break;
      }
    }
    throw lastErr || restrictedError();
  }

  async getLyric(track) {
    const mid = track.gid || String(track.sourceId || '').split(':')[1];
    const data = await this.api('/getLyric', { songmid: mid, trans: 1 });
    const r = (data && data.response) || {};
    const lyric = typeof r.lyric === 'string' ? r.lyric
      : (r.lyric && r.lyric.lyric) || '';
    const translated = typeof r.trans === 'string' ? r.trans
      : (r.trans && r.trans.trans) || '';
    return { lrc: lyric, translated, source: 'QQ音乐' };
  }

  async getCover(track) {
    const url = track.picUrl || albumPicUrl(track.albumId, 500);
    if (url) return { redirect: url };
    return null;
  }

  /** 由路由 id + meta 构建曲目（buildTrack 由组合层提供，这里补 QQ 专属字段映射） */
  async status(opts = {}) {
    if (!this.baseUrl) return { ok: false, reason: 'QQ 服务未启动' };
    try {
      // opts.token：扫码刚成功时显式传入刚换到的会话令牌
      const data = await this.api('/login/status', {}, { token: opts.token });
      const profile = (data && data.data && data.data.profile) || null;
      return {
        ok: true,
        loggedIn: !!profile,
        nickname: (profile && (profile.nickname || profile.nick)) || '',
        userId: (profile && (profile.uin || profile.userId)) || '',
        avatarUrl: (profile && (profile.avatarUrl || profile.avatar)) || ''
      };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  /**
   * 歌单能力：/user/playlist（自建+收藏）、/user/liked-songs（我喜欢）、
   * /getSongListDetail/:disstid（歌单曲目）。
   * 未登录时这些接口会返回业务错误，由上层转成"登录后可用"。
   */
  get playlists() {
    const self = this;
    return {
      async list() {
        const data = await self.api('/user/playlist');
        // 包的 toUserPlaylistBody：{ code, playlist: [...], total, more }
        // 条目原始字段：dirId(201=我喜欢)/dirName/tid/songNum/bigpicUrl/opType(5=喜欢)
        const arr = (data && (data.playlist || data.list)) || [];
        return arr.map((p, i) => ({
          id: String(p.tid || p.disstid || p.dissid || p.dirId || i),
          name: p.dirName || p.dissname || p.name || '未命名歌单',
          cover: p.bigpicUrl || p.imgurl || p.picurl || p.picUrl || '',
          count: p.songNum || p.song_count || p.songcnt || 0,
          special: (p.dirId === 201 || p.opType === 5) ? 'like' : ''
        }));
      },
      async tracks(pid, { offset = 0, limit = 50 } = {}) {
        // 我喜欢走专用接口，其余走歌单详情
        let songs = [];
        let total = null;
        if (String(pid) === 'liked') {
          const data = await self.api('/user/liked-songs', { offset, limit });
          songs = (data && (data.songs || data.data || [])) || [];
        } else {
          const data = await self.api(`/getSongListDetail/${encodeURIComponent(pid)}`);
          // 原始结构：response.cdlist[0] = { songlist: [...], songnum, dissname, ... }
          const body = (data && data.response && Array.isArray(data.response.cdlist)
            ? data.response.cdlist[0]
            : (data && (data.data || data))) || {};
          songs = body.songlist || body.songs || [];
          total = body.songnum || body.total_song_num || body.total || null;
        }
        const tracks = songs.map(x => self.mapSong(x));
        return {
          tracks,
          total: total !== null ? total : (tracks.length < limit ? offset + tracks.length : null),
          hasMore: tracks.length >= limit
        };
      }
    };
  }

  /** 账号能力声明 */
  get account() {
    const self = this;
    return { async status() { return self.status(); } };
  }

  /** 防御式从任意响应里取第一个歌曲数组 */
  _pickArray(d) {
    if (Array.isArray(d)) return d;
    if (!d || typeof d !== 'object') return [];
    for (const k of ['data', 'list', 'songs', 'items', 'songlist']) {
      if (Array.isArray(d[k])) return d[k];
    }
    for (const v of Object.values(d)) {
      if (v && typeof v === 'object') {
        for (const k of ['data', 'list', 'songs', 'items', 'songlist']) {
          if (Array.isArray(v[k])) return v[k];
        }
      }
    }
    return [];
  }

  /** 推荐能力：similar=基于种子相似歌；personalfm=猜你喜欢（登录） */
  get recommend() {
    const self = this;
    return {
      async next(type, cursor = {}) {
        if (type === 'similar') {
          if (!cursor.seedMid) throw new Error('缺少种子歌曲');
          const data = await self.api('/song/similar', { songmid: cursor.seedMid });
          const arr = self._pickArray(data && data.data ? data.data : data);
          return { tracks: arr.map(x => self.mapSong(x)).filter(Boolean), cursor };
        }
        // personalfm：猜你喜欢
        const data = await self.api('/user/guess-you-like');
        const arr = self._pickArray(data);
        return { tracks: arr.map(x => self.mapSong(x)).filter(Boolean), cursor };
      }
    };
  }

  /** 登出：清包内会话仓库中的凭证 + 本地 token */
  async logout() {
    try { await this.api('/logout'); } catch (_) {}
    this._setToken('');
  }
}

module.exports = QqProvider;
