'use strict';
/**
 * SourceAdapter · 音源适配层契约与组合工厂
 *
 * 目标：不给每个平台写硬编码分支。每个平台一个 adapter，
 * 由「GD Studio 默认实现（搜索/取链/歌词/封面）」+「平台独立 API（只补登录、歌单、推荐）」组成。
 *
 * 统一曲目形状（所有 adapter 必须返回）：
 *   {
 *     id:        `${provider}_${key}`      展示用 id
 *     provider:  'netease'|'qq'|'kugou'|'local'
 *     sourceId:  `${provider}:${key}`
 *     nid:       网易云曲目专有（历史兼容，等于 key）
 *     gid:       通用 key（任何平台都有，= sourceId 冒号后段）
 *     title / artist / album / albumId / picUrl / duration
 *     picId / lyricId                      GD 取图/歌词用的第二 key（可空）
 *     hasCover / hasLyric
 *   }
 *
 * trackId 规则（前端 AnalysisManager.stableId）：`provider--key`。
 * GD 的 netease 源返回的 id 就是网易云歌曲 id，因此 provider--key 与
 * 既有缓存完全一致，情绪曲线 / 歌词校准跨 adapter 命中。
 */

const SOURCES = ['local', 'netease', 'qq', 'kugou'];

/** GD 音乐源名 ↔ 播放器 provider 名 */
const GD_SOURCE_OF = { netease: 'netease', qq: 'tencent', kugou: 'kugou' };

/** 归一化 GD 一条搜索结果 */
function normalizeGdTrack(provider, raw) {
  const key = String(raw.id);
  const artist = Array.isArray(raw.artist) ? raw.artist.join(' / ')
    : (typeof raw.artist === 'string' ? raw.artist : '未知艺术家');
  return {
    id: `${provider}_${key}`,
    provider,
    sourceId: `${provider}:${key}`,
    nid: provider === 'netease' ? key : undefined,
    gid: key,
    title: raw.name || '未知曲目',
    artist,
    album: raw.album || '',
    albumId: raw.album_id || '',
    picUrl: '',
    duration: 0,                                  // GD 搜索不返回时长，音频加载后由 <audio> 补
    picId: raw.pic_id ? String(raw.pic_id) : '',
    lyricId: raw.lyric_id ? String(raw.lyric_id) : '',
    hasCover: !!raw.pic_id,
    hasLyric: !!raw.lyric_id
  };
}

/**
 * 组合出一个平台 adapter：
 *   gd            GdStudioClient（必填，搜索/取链默认实现）
 *   platformApi   平台独立 API（可空；登录/歌单/推荐能力来源）
 *   overrides     平台增强覆盖（如 netease 用自家接口取高音质直链）
 */
function createComposite({ id, name, gd, platformApi = null, overrides = {}, streamFallbackGd = true }) {
  const gdForMe = gd.forSource(id);

  const adapter = {
    id,
    name,
    gdSource: GD_SOURCE_OF[id],
    platformApi,

    // 能力矩阵（阶段 4 的账号面板与音源切换读这里）
    capabilities: {
      search: true,
      stream: true,
      lyric: true,
      cover: true,
      login: !!(platformApi && platformApi.account),
      playlists: !!(platformApi && platformApi.playlists),
      recommend: !!(platformApi && platformApi.recommend),
      like: !!(platformApi && platformApi.likeTrack),
      addToPlaylist: !!(platformApi && platformApi.addToPlaylist),
      createPlaylist: !!(platformApi && platformApi.createPlaylist)
    },

    isAvailable() {
      return gdForMe.available() || (platformApi && platformApi.isAvailable && platformApi.isAvailable());
    },

    /** 搜索：平台 API 优先，GD 只作补充通道（平台失败时才试，绝不让它拖慢主路径） */
    async search(keywords, limit = 30, page = 1) {
      if (platformApi && platformApi.search) {
        return platformApi.search(keywords, limit);
      }
      // 无平台 API 的平台（如刚接入的 qq/kugou 取链初期）：GD 是唯一搜索通道
      const err1 = gdForMe.lastError();
      try {
        return await gdForMe.search(keywords, limit, page);
      } catch (e) {
        throw new Error('搜索失败' + (err1 ? `（${err1}）` : `（${e.message}）`));
      }
    },

    /**
     * 取链：平台增强 → 平台 API → GD。
     * streamFallbackGd=false 的平台（如 QQ，硬要求独立取链）失败时不落 GD，
     * 把带标识的错误抛给前端提示"版权受限"并跳过。
     */
    async getStream(track, opts = {}) {
      if (overrides.getStream) {
        try {
          return await overrides.getStream(track, opts);
        } catch (e) {
          console.warn(`[${id}] 平台取链失败，${streamFallbackGd ? '回落 GD' : '不回落 GD'}:`, e.message);
          if (!streamFallbackGd) throw e;
        }
      }
      if (platformApi && platformApi.getStream) {
        try {
          return await platformApi.getStream(track, opts);
        } catch (e) {
          console.warn(`[${id}] 平台 API 取链失败，${streamFallbackGd ? '回落 GD' : '不回落 GD'}:`, e.message);
          if (!streamFallbackGd) throw e;
        }
      }
      return gdForMe.getUrl(track, opts.br || 999);
    },

    /** 歌词：平台 API 优先（带翻译），否则 GD */
    async getLyric(track) {
      if (platformApi && platformApi.getLyric && (track.nid || adapter.hasPlatformKey(track))) {
        try { return await platformApi.getLyric(track); } catch (_) {}
      }
      return gdForMe.getLyric(track);
    },

    /** 封面：track 自带 picUrl → 平台 API → GD pic 接口 */
    async getCover(track) {
      if (track.picUrl && /^https?:/.test(track.picUrl)) {
        return { redirect: track.picUrl };
      }
      if (platformApi && platformApi.getCover && (track.nid || adapter.hasPlatformKey(track))) {
        try { return await platformApi.getCover(track); } catch (_) {}
      }
      return gdForMe.getPic(track);
    },

    /** 由路由里的 id + meta 参数构建统一曲目（stream/cover/lyric 共用） */
    buildTrack(key, meta = {}) {
      return {
        id: `${id}_${key}`,
        provider: id,
        sourceId: `${id}:${key}`,
        nid: id === 'netease' ? String(key) : undefined,
        gid: String(key),
        title: meta.t || '',
        artist: meta.a || '',
        album: meta.b || '',
        picUrl: meta.p || '',
        picId: meta.picId || '',
        lyricId: meta.lyricId || '',
        hasCover: !!meta.picId,
        hasLyric: !!meta.lyricId
      };
    },

    /** 该曲目是否带平台 API 可用的 key（netease = 有 nid；其余 = 有 gid） */
    hasPlatformKey(track) {
      return id === 'netease' ? !!track.nid : !!track.gid;
    },

    /* ---- 账号 / 歌单能力透传（无 platformApi 时明确报"未接入"） ---- */
    async accountStatus() {
      if (!platformApi || !platformApi.account) return { supported: false, loggedIn: false };
      return platformApi.account.status();
    },
    async listPlaylists() {
      if (!platformApi || !platformApi.playlists) throw new Error(`${name} 歌单能力未接入`);
      return platformApi.playlists.list();
    },
    async playlistTracks(playlistId, { offset = 0, limit = 50 } = {}) {
      if (!platformApi || !platformApi.playlists) throw new Error(`${name} 歌单能力未接入`);
      return platformApi.playlists.tracks(playlistId, { offset, limit });
    },
    async dynamicNext(type, cursor) {
      if (!platformApi || !platformApi.recommend) throw new Error(`${name} 推荐能力未接入`);
      return platformApi.recommend.next(type, cursor);
    },

    /* ---- 通用写操作（喜欢 / 加歌 / 建歌单），按平台精准路由 ---- */
    async likeTrack(track, like) {
      if (!platformApi || !platformApi.likeTrack) throw new Error(`${name} 收藏能力未接入`);
      return platformApi.likeTrack(track, like);
    },
    async addToPlaylist(track, playlistId) {
      if (!platformApi || !platformApi.addToPlaylist) throw new Error(`${name} 加歌能力未接入`);
      return platformApi.addToPlaylist(track, playlistId);
    },
    async createPlaylist(name) {
      if (!platformApi || !platformApi.createPlaylist) throw new Error(`${name} 建歌单能力未接入`);
      return platformApi.createPlaylist(name);
    },
    async logout() {
      if (platformApi && platformApi.logout) return platformApi.logout();
    }
  };

  return adapter;
}

module.exports = { SOURCES, GD_SOURCE_OF, normalizeGdTrack, createComposite };
