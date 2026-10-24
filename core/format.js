/**
 * core/format.js · 曲目/时间格式化纯函数（双端共享）
 */

/** 毫秒 → m:ss（无效输入返回 --:--） */
export function fmtTime(ms) {
  if (!isFinite(ms) || ms <= 0) return '--:--';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** 秒 → m:ss */
export function fmtTimeSec(sec) {
  if (!isFinite(sec) || sec <= 0) return '--:--';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** 艺术家/专辑拼副标题 */
export function trackSubtitle(track) {
  const t = track || {};
  return [t.artist, t.album].filter(Boolean).join(' · ') || '未知艺术家';
}

/** 平台显示名 */
export const PROVIDER_BADGE = { netease: '网易云', qq: 'QQ', local: '本地', kugou: '酷狗' };

export function providerLabel(provider) {
  return PROVIDER_BADGE[provider] || provider || '';
}

/** 曲目唯一键（与歌单存储一致：provider--gid） */
export function trackKeyOf(track) {
  const t = track || {};
  return t.provider + '--' + (t.gid || t.nid || t.id);
}
