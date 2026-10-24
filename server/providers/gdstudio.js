'use strict';
/**
 * GD Studio 音乐台 API 客户端
 *
 * 文档：https://music-api.gdstudio.xyz/api.php（Meting 格式，CC BY-NC 4.0，仅学习用途）
 *   搜索 ?types=search&source=X&name=KW&count=N&pages=P
 *   取链 ?types=url&source=X&id=ID&br=BR
 *   歌词 ?types=lyric&source=X&id=ID
 *   封面 ?types=pic&source=X&id=ID&size=S
 *
 * 官方频率限制：5 分钟内不超过 50 次（动态更新）。
 * 本端实现：
 *   - 令牌桶限流（容量 45，留 5 余量），超了排队等而不是硬打；
 *   - 连续失败熔断：连挂 2 次后停用 5 分钟（期间 isAvailable()=false，
 *     上层组合直接走平台 API，用户无感）。
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const BASE = process.env.GD_BASE_URL || 'https://music-api.gdstudio.xyz/api.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TIMEOUT_MS = 2500;          // 硬约束：GD 总耗时必须 <3s，绝不允许拖慢搜索
const TOKEN_WAIT_MS = 1200;       // 令牌不足时最多等这么久，超时直接失败

/* ---- 令牌桶：50 次 / 5 分钟 ---- */
const BUCKET_CAP = 45;
const REFILL_MS = 5 * 60 * 1000 / 50;   // 每 6s 回 1 个令牌
let tokens = BUCKET_CAP;
let lastRefill = Date.now();
let queue = [];

function refill() {
  const now = Date.now();
  const earned = Math.floor((now - lastRefill) / REFILL_MS);
  if (earned > 0) {
    tokens = Math.min(BUCKET_CAP, tokens + earned);
    lastRefill += earned * REFILL_MS;
  }
}

function takeToken() {
  return new Promise((resolve) => {
    queue.push(resolve);
    pump();
  });
}

/** 带上限的令牌等待：拿不到就立刻放弃，不排队干等 */
function takeTokenOrGiveUp() {
  return Promise.race([
    takeToken(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('GD 限流排队超时')), TOKEN_WAIT_MS))
  ]).catch(() => { throw new Error('GD 限流排队超时'); });
}

function pump() {
  refill();
  while (queue.length && tokens > 0) {
    tokens--;
    queue.shift()();
  }
  if (queue.length) {
    const wait = Math.max(50, REFILL_MS - (Date.now() - lastRefill));
    setTimeout(pump, wait);
  }
}

/* ---- HTTP ---- */
function request(url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': UA, 'Referer': 'https://music.gdstudio.xyz/', 'Accept': 'application/json, */*' }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        request(res.headers.location, timeout).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('GD 请求超时')));
    req.end();
  });
}

class GdStudioClient {
  constructor() {
    this._failCount = 0;
    this._brokenUntil = 0;
    this._lastErr = '';
  }

  /** 熔断窗口内不可用 */
  available() {
    return Date.now() >= this._brokenUntil;
  }

  lastError() {
    return this._brokenUntil > Date.now() ? this._lastErr : '';
  }

  forSource(provider) {
    const source = { netease: 'netease', qq: 'tencent', kugou: 'kugou' }[provider] || provider;
    const self = this;

    const call = async (params) => {
      if (!self.available()) throw new Error('GD 源熔断中（' + self._lastErr + '）');
      await takeTokenOrGiveUp();
      const qs = new URLSearchParams({ ...params, source });
      let res;
      try {
        res = await request(`${BASE}?${qs}`, TIMEOUT_MS);
      } catch (e) {
        self._fail(e.message);
        throw e;
      }
      if (res.status !== 200) {
        self._fail('HTTP ' + res.status);
        throw new Error('GD 接口 HTTP ' + res.status);
      }
      const body = res.body.trim();
      if (body.startsWith('<')) {          // Cloudflare 拦截页等
        self._fail('返回了 HTML（可能被风控）');
        throw new Error('GD 接口返回异常内容');
      }
      let json;
      try { json = JSON.parse(body); } catch (_) {
        // pic 接口可能直接返回纯文本 URL
        if (params.types === 'pic' && /^https?:\/\//.test(body)) return body;
        self._fail('返回不是 JSON');
        throw new Error('GD 接口返回不是 JSON');
      }
      self._failCount = 0;                 // 成功一次就复位熔断计数
      return json;
    };

    return {
      available: () => self.available(),
      lastError: () => self.lastError(),

      async search(keywords, limit = 30, page = 1) {
        const list = await call({ types: 'search', name: keywords, count: String(limit), pages: String(page) });
        if (!Array.isArray(list)) return [];
        // 注意：GD 返回的 id 属于对应 source，netease 的 id 即网易云歌曲 id
        return list.map(raw => ({
          id: raw.id,
          name: raw.name,
          artist: raw.artist,
          album: raw.album,
          album_id: raw.album_id,
          pic_id: raw.pic_id,
          lyric_id: raw.lyric_id
        }));
      },

      /** 返回 { url, br, size }；拿不到就 throw */
      async getUrl(track, br = 999) {
        const id = track.gid || track.nid || String(track.sourceId || '').split(':')[1];
        if (!id) throw new Error('缺少曲目 ID');
        const data = await call({ types: 'url', id, br: String(br) });
        const item = Array.isArray(data) ? data.find(x => x && x.url) : (data && data.url ? data : null);
        if (!item || !item.url) throw new Error('GD 未返回可播放地址');
        return {
          url: item.url,
          level: String(item.br || br),
          size: item.size,
          via: 'gdstudio'
        };
      },

      async getLyric(track) {
        const id = track.lyricId || track.gid || track.nid || String(track.sourceId || '').split(':')[1];
        const data = await call({ types: 'lyric', id });
        return {
          lrc: (data && (data.lyric || data.lrc)) || '',
          translated: (data && (data.tlyric || data.trans)) || '',
          source: 'GD音乐台'
        };
      },

      async getPic(track, size = 500) {
        const id = track.picId || track.gid || track.nid || String(track.sourceId || '').split(':')[1];
        if (!track.picId && !track.gid && !track.nid) return null;
        const url = await call({ types: 'pic', id, size: String(size) });
        return url ? { redirect: url } : null;
      }
    };
  }

  _fail(msg) {
    this._failCount++;
    this._lastErr = msg;
    if (this._failCount >= 2) {
      this._brokenUntil = Date.now() + 5 * 60 * 1000;
      this._failCount = 0;
      console.warn('[gdstudio] 连续失败，熔断 5 分钟:', msg);
    }
  }
}

module.exports = { GdStudioClient, BASE };
