/**
 * 后端接口封装
 */

async function getJSON(url, opt) {
  const res = await fetch(url, opt);
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    throw new Error((data && data.error) || `请求失败 (${res.status})`);
  }
  return data;
}

function postJSON(url, body) {
  return getJSON(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

/** UTF-8 安全的 base64 */
function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** 把曲目关键信息塞进 query，让后端无需再查一次详情 */
function metaParam(track) {
  if (!track || track.provider === 'local') return '';
  const payload = {
    t: track.title || '',
    a: track.artist || '',
    b: track.album || '',
    p: track.picUrl || ''
  };
  // GD 音源的取图/歌词第二 key（网易云等平台源没有这两个字段）
  if (track.picId) payload.picId = track.picId;
  if (track.lyricId) payload.lyricId = track.lyricId;
  try {
    // 注意这里带的是 ? 不是 &，否则 id 会和 meta 粘在一起变成非法路径
    return '?meta=' + encodeURIComponent(b64(JSON.stringify(payload)));
  } catch (_) {
    return '';
  }
}

/** 曲目在后端路由里用的 key（本地=hash id，在线=nid / 通用 gid） */
function trackKey(track) {
  if (!track) return '';
  if (track.provider === 'local') return track.id;
  return track.nid || track.gid || String(track.sourceId || '').split(':')[1] || '';
}

export const api = {
  health: () => getJSON('/api/health'),

  getSettings: () => getJSON('/api/settings'),
  saveSettings: (patch) => postJSON('/api/settings', patch),

  library: (refresh) => getJSON('/api/library' + (refresh ? '?refresh=1' : '')),
  rescan: () => postJSON('/api/library/scan', {}),

  search: (q, provider = 'local', limit = 60) =>
    getJSON(`/api/search?q=${encodeURIComponent(q)}&provider=${provider}&limit=${limit}`),

  listDir: (p) => getJSON('/api/fs/list' + (p ? `?path=${encodeURIComponent(p)}` : '')),
  detect: () => getJSON('/api/detect'),
  neteaseStatus: () => getJSON('/api/netease/status'),

  // 能量分析缓存
  getAnalysis: (trackId) => getJSON('/api/analysis/' + encodeURIComponent(trackId)),
  saveAnalysis: (trackId, data) => postJSON('/api/analysis/' + encodeURIComponent(trackId), data),

  // 扫码登录（旧接口，兼容保留）
  neteaseQr: () => getJSON('/api/netease/login/qr'),
  neteaseQrCheck: (key) => getJSON('/api/netease/login/check?key=' + encodeURIComponent(key)),
  neteaseLogout: () => postJSON('/api/netease/logout', {}),
  neteaseRestart: () => postJSON('/api/netease/restart', {}),

  // 统一账号接口（多平台）
  accountStatus: (platform) => getJSON(`/api/account/${platform}/status`),
  accountQr: (platform) => getJSON(`/api/account/${platform}/login/qr`),
  accountQrCheck: (platform, key) => getJSON(`/api/account/${platform}/login/check?key=` + encodeURIComponent(key)),
  accountLogout: (platform) => postJSON(`/api/account/${platform}/logout`, {}),

  // 动态队列（心动模式 / 私人漫游 / 本地电台）
  playlists: (platform) => getJSON('/api/playlists?platform=' + encodeURIComponent(platform)),
  dynamicSession: (platform, type, seed) =>
    postJSON('/api/dynamic/session', { platform, type, seed }),
  dynamicNext: (platform, session, n = 1) =>
    getJSON(`/api/dynamic/next?platform=${encodeURIComponent(platform)}&session=${encodeURIComponent(session)}&n=${n}`),

  streamUrl(track) {
    return `/api/stream/${track.provider}/${encodeURIComponent(trackKey(track))}${metaParam(track)}`;
  },
  coverUrl(track) {
    return `/api/cover/${track.provider}/${encodeURIComponent(trackKey(track))}${metaParam(track)}`;
  },
  lyricUrl(track) {
    return `/api/lyric/${track.provider}/${encodeURIComponent(trackKey(track))}${metaParam(track)}`;
  },
  getLyric: (track) => getJSON(api.lyricUrl(track))
};
