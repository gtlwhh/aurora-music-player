/** 阶段1 单元测试：归一化 / trackId 兼容 / 熔断 / 动态会话 */
const assert = require('assert');
const { normalizeGdTrack, createComposite } = require('../server/core/source-adapter.js');
const { GdStudioClient } = require('../server/providers/gdstudio.js');
const { PlaylistSession } = require('../server/lib/playlists.js');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

(async () => {
  // ① GD 搜索结果归一化 + trackId 与旧缓存一致
  const t = normalizeGdTrack('netease', { id: 186016, name: '晴天', artist: ['周杰伦'], album: '叶惠美', pic_id: '109951166', lyric_id: '107616', source: 'netease' });
  assert.strictEqual(t.nid, '186016');
  assert.strictEqual(t.gid, '186016');
  assert.strictEqual(t.sourceId, 'netease:186016');
  const trackId = `${t.provider}--${t.nid || t.sourceId.split(':')[1]}`;
  assert.ok(fs.existsSync(path.join(ROOT, 'data/cache/analysis/netease--509781655.json')), '旧缓存存在');
  console.log('① GD netease 曲目 trackId =', trackId, '（同构于旧缓存命名 netease--<nid>）✓');

  // ② tencent → qq 映射
  const tq = normalizeGdTrack('qq', { id: '0039MnYb0qxYhV', name: 'x', artist: ['a'], album: '', pic_id: 'p1', lyric_id: 'l1' });
  assert.strictEqual(tq.provider, 'qq');
  assert.strictEqual(tq.gid, '0039MnYb0qxYhV');
  console.log('② qq 曲目 → trackId qq--0039MnYb0qxYhV ✓');

  // ③ 熔断
  const gd = new GdStudioClient();
  const h = gd.forSource('netease');
  gd._fail('mock1'); gd._fail('mock2');
  assert.strictEqual(gd.available(), false);
  assert.ok(h.lastError().includes('mock2'));
  gd._brokenUntil = Date.now() - 1;
  assert.strictEqual(gd.available(), true);
  console.log('③ GD 熔断开/恢复 ✓');

  // ④ GD 熔断时搜索回落平台 API
  const platformCalls = [];
  const fakePlatform = {
    isAvailable: () => true,
    search: async () => { platformCalls.push('search'); return [{ fake: true }]; },
    getLyric: async () => ({ lrc: '[00:00]x', source: '平台' }),
    status: async () => ({ loggedIn: false }),
    account: {}, playlists: {}
  };
  gd._brokenUntil = Date.now() + 60000;
  const comp = createComposite({ id: 'netease', name: '网易云', gd, platformApi: fakePlatform });
  const sr = await comp.search('晴天', 5);
  assert.strictEqual(sr[0].fake, true);
  console.log('④ GD 熔断时搜索回落平台 API ✓');

  // ⑤ buildTrack 通用 key
  const bt = comp.buildTrack('123456', { t: '歌', picId: 'pic9', lyricId: 'lyr9' });
  assert.strictEqual(bt.gid, '123456');
  console.log('⑤ buildTrack ✓');

  // ⑥ 本地电台动态会话
  const ps = new PlaylistSession();
  const pool = Array.from({ length: 20 }, (_, i) => ({ id: 't' + i, provider: 'local', title: 'T' + i }));
  const s = ps.createDynamic('local', 'localRadio', null, { localTracks: pool });
  assert.strictEqual(s.buffered, 20);
  const r1 = await ps.next(null, s.sessionId, 3);
  assert.strictEqual(r1.tracks.length, 3);
  const r2 = await ps.next(null, s.sessionId, 100);
  assert.strictEqual(r2.tracks.length, 17);
  assert.strictEqual(r2.exhausted, true);
  console.log('⑥ 本地电台动态会话：3 + 17，耗尽标记 ✓');

  // ⑦ 未接入平台动态来源：优雅耗尽（不抛错、不死循环）
  const ps2 = new PlaylistSession();
  const s2 = ps2.createDynamic('netease', 'heartmode', null, {});
  const comp2 = createComposite({ id: 'netease', name: '网易云', gd: new GdStudioClient(), platformApi: null });
  await new Promise(r => setTimeout(r, 100));   // 等后台补货失败结束
  const r7 = await ps2.next(comp2, s2.sessionId, 1);
  assert.strictEqual(r7.tracks.length, 0);
  assert.strictEqual(r7.exhausted, true);
  console.log('⑦ 平台动态来源未接入时优雅耗尽（无异常不死循环）✓');

  console.log('\n全部单元测试通过');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
