'use strict';
const { STATELESS } = require('../lib/accounts');
/**
 * 网易云音乐音源适配器
 *
 * 通过可配置的 API 服务地址接入（兼容 NeteaseCloudMusicApi 及其各类分支/自建服务）。
 * 播放器本身不做任何破解：音频直链、音质档位、歌词、封面全部由所接入的服务决定，
 * 播什么音质就播什么音质，播放器只负责渲染与交互。
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

function request(url, { headers = {}, method = 'GET', timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('URL 非法: ' + url)); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(new Error('请求超时')); });
    req.end();
  });
}

async function getJSON(url, opt) {
  const res = await request(url, opt);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const text = res.body.toString('utf8');
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error('接口返回的不是 JSON，请检查 API 服务地址是否正确');
  }
  // 把响应头挂上去（不可枚举，不影响 JSON 序列化）——
  // 登录 cookie 只在 Set-Cookie 头里，响应体中往往拿不到
  if (json && typeof json === 'object') {
    Object.defineProperty(json, '__headers', { value: res.headers, enumerable: false });
  }
  return json;
}

/** 从响应头或响应体里尽力提取登录 cookie */
function pickCookie(json) {
  if (!json) return '';
  if (typeof json.cookie === 'string' && json.cookie.trim()) return json.cookie.trim();

  const h = json.__headers || {};
  const sc = h['set-cookie'];
  if (Array.isArray(sc) && sc.length) {
    return sc.map(c => String(c).split(';')[0]).filter(Boolean).join('; ');
  }
  if (typeof sc === 'string' && sc) {
    return sc.split(';')[0];
  }
  return '';
}

class NeteaseProvider {
  constructor(settings, fallbackBaseUrl = '') {
    this.id = 'netease';
    this.name = '网易云音乐';
    this.settings = settings || {};
    this.fallbackBaseUrl = fallbackBaseUrl || '';
  }

  /** 客户端凭证透传：每个请求进来时注入，服务端不落盘 */
  get baseUrl() {
    // 用户自己填的优先，其次用播放器内置拉起的本地服务
    const raw = this.settings.neteaseBaseUrl || this.fallbackBaseUrl || '';
    return raw.replace(/\/+$/, '');
  }

  get cookie() {
    // ① 每请求上下文（AsyncLocalStorage）：并发用户的凭证互相隔离，杜绝串号
    // ② 桌面端单用户回退：运行时注入 / 本地加密存储（行为不变）
    const { ctxCredential } = require('../lib/req-context');
    // 唯一来源：当前请求上下文（手机）或本地加密存储（桌面单用户）。实例上零凭证状态
    // 无状态（ECS/纯 Node）：只认请求头透传，绝不回退 settings.json 的历史残留。
    // （这正是"设置显示未登录却拉到个人歌单"的漏洞根源）
    // 桌面端（Electron 单用户）：保留本地加密存储回退。
    if (STATELESS) return ctxCredential('ncm');
    return ctxCredential('ncm') || this.settings.neteaseCookie || '';
  }

  get level() {
    return this.settings.neteaseLevel || 'exhigh';
  }

  isAvailable() {
    return !!this.baseUrl;
  }

  /** 带 cookie 的查询串 */
  q(params) {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') u.append(k, String(v));
    }
    if (this.cookie) {
      // 新版接口用 cookie 参数透传，旧版也可以
      u.append('cookie', this.cookie);
    }
    u.append('timestamp', String(Date.now()));
    return u.toString();
  }

  async api(pathname, params = {}) {
    if (!this.baseUrl) throw new Error('尚未配置网易云 API 服务地址');
    const url = `${this.baseUrl}${pathname}?${this.q(params)}`;
    return getJSON(url, {
      headers: this.cookie ? { Cookie: this.cookie } : {}
    });
  }

  /** 连通性检测 + 登录态 */
  async status() {
    if (!this.baseUrl) return { ok: false, reason: '未配置 API 地址' };
    try {
      const data = await this.api('/login/status');
      const d = data.data || {};
      const profile = d.profile || d.account || null;
      const loggedIn = !!(profile && (profile.userId || profile.id));
      return {
        ok: true,
        loggedIn,
        nickname: profile ? (profile.nickname || '') : '',
        userId: profile ? (profile.userId || profile.id || '') : '',
        avatarUrl: profile ? (profile.avatarUrl || '') : '',
        vipType: profile ? profile.vipType : 0
      };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  /** 平台 API 歌曲对象 → 统一曲目形状（搜索与歌单共用） */
  mapSong(s) {
    const artists = (s.artists || s.ar || []).map(a => a.name).join(' / ') || '未知艺术家';
    const album = s.album || s.al || {};
    return {
      id: `netease_${s.id}`,
      provider: 'netease',
      sourceId: `netease:${s.id}`,
      nid: s.id,
      gid: String(s.id),
      title: s.name,
      artist: artists,
      album: album.name || '',
      albumId: album.id || 0,
      picUrl: album.picUrl || (album.picUrl_str || ''),
      duration: s.duration || s.dt || 0,
      fee: s.fee,
      pop: s.pop || s.popularity || 0,     // 热度：供搜索排序区分原唱与冷门翻唱
      hasCover: !!(album.picUrl),
      hasLyric: true
    };
  }

  /** 当前登录用户 uid（缓存） */
  async uid() {
    // ★ 串号直接根因（已铲除）：此前 uid 缓存在 provider 单例上，
    //   A 拉过一次歌单后，B 的无凭证请求会命中缓存拿到 A 的 uid，
    //   而网易云 /user/playlist?uid=X 无需登录态即可按 uid 拉公开歌单 → 串号。
    //   现在每次实打实校验登录态并取当前请求自己的 uid。
    const st = await this.status();
    if (!st.loggedIn || !st.userId) throw new Error('网易云未登录，登录后可用歌单');
    return st.userId;
  }

  /**
   * 歌单能力（SourceAdapter 平台补充项）。
   * list() 返回统一 Playlist 数组；tracks() 分页取曲目，不一次拉完。
   */
  get playlists() {
    const self = this;
    return {
      async list() {
        const uid = await self.uid();
        const data = await self.api('/user/playlist', { uid, limit: 100 });
        const pl = data.playlist || [];
        return pl.map(p => ({
          id: p.id,
          name: p.name,
          cover: p.coverImgUrl || p.picUrl || '',
          count: p.trackCount || 0,
          special: (p.userId === uid && p.specialType === 5) ? 'like' : ''
        }));
      },
      async tracks(pid, { offset = 0, limit = 50 } = {}) {
        // 注意：/playlist/track/all 返回 songs（全量曲目对象），不是 tracks（只有 id）
        const data = await self.api('/playlist/track/all', { id: pid, limit, offset });
        const tracks = (data.songs || data.tracks || []).map(s => self.mapSong(s));
        await self._fillCovers(tracks);   // 歌单接口同样不再返回 picUrl → 批量补全
        if (!tracks.length) {
          console.log('[netease] playlist/track/all 空响应，字段:', Object.keys(data || {}).join(','),
            '| code:', data && data.code, '| msg:', (data && (data.message || data.msg)) || '');
        }
        const total = typeof data.trackCount === 'number' ? data.trackCount : null;
        return {
          tracks,
          total,
          hasMore: total !== null ? offset + tracks.length < total : tracks.length >= limit
        };
      }
    };
  }

  /** 账号能力声明（扫码流程由 AccountManager 的平台后端承担） */
  get account() {
    const self = this;
    return {
      async status() { return self.status(); }
    };
  }

  /**
   * 推荐能力（动态来源）。
   *   heartmode  心动模式：基于种子歌曲 + 歌单（/playmode/intelligence/list）
   *   personalfm 私人漫游：官方 FM 接口轮转供歌（/personal_fm）
   * cursor 在 PlaylistSession 间传递，负责种子与已推记录。
   */
  get recommend() {
    const self = this;
    return {
      async next(type, cursor = {}) {
        if (type === 'heartmode') {
          if (!cursor.seed) throw new Error('心动模式需要种子歌曲');
          // 接口一次返回全部推荐（可能上百条）：只取一页（8 条），
          // cursor.offset 记录进度，缓冲低于阈值时再来取下一页。
          const PAGE = 8;
          const offset = Number(cursor.offset) || 0;
          const data = await self.api('/playmode/intelligence/list', {
            id: cursor.seed,
            pid: cursor.pid || cursor.seed
          });
          const arr = (data && data.data) || [];
          const page = arr.slice(offset, offset + PAGE)
            .map(x => x && x.songInfo ? self.mapSong(x.songInfo) : null)
            .filter(Boolean);
          return {
            tracks: page,
            cursor: { ...cursor, offset: offset + page.length, total: arr.length }
          };
        }
        if (type === 'personalfm') {
          const data = await self.api('/personal_fm');
          const arr = (data && data.data) || [];
          const tracks = arr.map(x => self.mapSong(x)).filter(Boolean);
          return { tracks, cursor };
        }
        throw new Error('未知动态来源: ' + type);
      }
    };
  }

  /** 点喜欢 / 取消喜欢（红心） */
  async likeTrack(track, like) {
    const nid = track.nid || track.gid || String(track.sourceId || '').split(':')[1];
    if (!nid) throw new Error('缺少歌曲信息，无法收藏');
    const data = await this.api('/like', { id: nid, like: like ? 'true' : 'false' });
    if (data && data.code && data.code !== 200 && data.code !== 301) {
      throw new Error(data.message || data.msg || ('收藏失败 code=' + data.code));
    }
    return { ok: true };
  }

  /** 加入歌单（网易云自建/收藏歌单均可） */
  async addToPlaylist(track, playlistId) {
    const nid = track.nid || track.gid || String(track.sourceId || '').split(':')[1];
    if (!nid || !playlistId) throw new Error('缺少歌曲或歌单信息');
    const data = await this.api('/playlist/tracks', { op: 'add', pid: playlistId, tracks: nid });
    if (data && data.body && data.body.code && data.body.code !== 200 && data.body.code !== 502) {
      throw new Error((data.body.message) || ('添加失败 code=' + data.body.code));
    }
    if (data && data.status && data.status.code && data.status.code !== 200) {
      throw new Error('添加失败：' + (data.status.message || data.status.code));
    }
    return { ok: true };
  }

  /** 新建歌单（默认隐私） */
  async createPlaylist(name) {
    const data = await this.api('/playlist/create', { name: String(name || '').slice(0, 40), privacy: '10' });
    if (data && data.code && data.code !== 200) {
      throw new Error(data.message || ('创建失败 code=' + data.code));
    }
    const pl = (data && (data.playlist || data.id)) || null;
    return { ok: true, id: pl && pl.id ? String(pl.id) : '' };
  }

  /** 搜索歌曲 */
  async search(keywords, limit = 30) {
    const data = await this.api('/search', { keywords, limit, type: 1 });
    const songs = (data.result && data.result.songs) || [];
    return this._fillCovers(songs.map(s => this.mapSong(s)));
  }

  /** 歌曲详情（补封面 / 时长） */
  async detail(ids) {
    const data = await this.api('/song/detail', { ids: Array.isArray(ids) ? ids.join(',') : ids });
    const songs = data.songs || [];
    return songs.map(s => ({
      nid: s.id,
      title: s.name,
      artist: (s.ar || s.artists || []).map(a => a.name).join(' / '),
      album: (s.al || s.album || {}).name || '',
      picUrl: (s.al || s.album || {}).picUrl || '',
      duration: s.dt || s.duration || 0
    }));
  }

  /**
   * ★ 网易云搜索/歌单接口已改版：al=null、album 里没有 picUrl（只剩 picId）。
   *   用 song/detail（实测仍带 al.picUrl）批量补全封面，带 350y350 缩放参数。
   *   补不全的字段交给前端渐变兜底，绝不留白。
   */
  async _fillCovers(list) {
    try {
      const missing = (list || []).filter(t => !t.picUrl && (t.nid || t.gid));
      if (!missing.length) return list;
      const ids = [...new Set(missing.map(t => String(t.nid || t.gid)))].slice(0, 200).join(',');
      const data = await this.api('/song/detail', { ids });
      const pic = new Map((data.songs || []).map(s => {
        const al = s.al || s.album || {};
        const u = String(al.picUrl || '').replace(/^http:\/\//, 'https://');
        return [String(s.id), u ? u + '?param=350y350' : ''];
      }));
      for (const t of list) {
        const p = pic.get(String(t.nid || t.gid));
        if (p) { t.picUrl = p; t.hasCover = true; }
      }
    } catch (_) { /* 补不全不影响主流程 */ }
    return list;
  }

  /** 获取播放直链（音质由此决定，播放器不干预） */
  async getStream(track) {
    const nid = track.nid || String(track.sourceId || '').split(':')[1];
    if (!nid) throw new Error('缺少歌曲 ID');

    // 从用户选的档位开始逐级降级——很多歌没有 Hi-Res / 无损，
    // 直接失败会让用户以为"没版权"，其实只是该档位不存在
    const LEVELS = ['hires', 'lossless', 'exhigh', 'higher', 'standard'];
    const startIdx = Math.max(0, LEVELS.indexOf(this.level));
    const tried = [];

    for (let i = startIdx; i < LEVELS.length; i++) {
      const lv = LEVELS[i];
      tried.push(lv);
      let data;
      try {
        data = await this.api('/song/url/v1', { id: nid, level: lv });
      } catch (_) {
        continue;
      }
      const item = (data.data && data.data[0]) || null;
      if (item && item.url) {
        return {
          url: item.url,
          type: item.type,
          level: item.level || lv,
          size: item.size,
          bitrate: item.br,
          trial: !!item.freeTrialInfo,
          downgraded: lv !== this.level
        };
      }
    }

    // 全部档位都拿不到，再试一次旧接口
    try {
      const data = await this.api('/song/url', { id: nid, br: 320000 });
      const item = (data.data && data.data[0]) || null;
      if (item && item.url) {
        return { url: item.url, type: item.type, level: 'standard', bitrate: item.br, downgraded: true };
      }
    } catch (_) {}

    throw new Error(`该曲目暂无可用音源（已尝试 ${tried.join(' / ')}，可能因版权下架）`);
  }

  /** 歌词 */
  async getLyric(track) {
    const nid = track.nid || String(track.sourceId || '').split(':')[1];
    const data = await this.api('/lyric', { id: nid });
    return {
      lrc: (data.lrc && data.lrc.lyric) || '',
      translated: (data.tlyric && data.tlyric.lyric) || '',
      roman: (data.romalrc && data.romalrc.lyric) || '',
      source: '网易云'
    };
  }

  /** 封面：直接把 CDN 地址交给前端（同源代理后加载） */
  async getCover(track) {
    if (track.picUrl) {
      const url = track.picUrl.replace(/^http:\/\//, 'https://') + '?param=800y800';
      return { redirect: url };
    }
    const nid = track.nid || String(track.sourceId || '').split(':')[1];
    const list = await this.detail(nid);
    if (list[0] && list[0].picUrl) {
      return { redirect: list[0].picUrl.replace(/^http:\/\//, 'https://') + '?param=800y800' };
    }
    return null;
  }
}

module.exports = NeteaseProvider;
