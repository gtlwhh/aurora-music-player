/**
 * Aurora 极光音乐播放器 · 主控
 */

import { CoverStage } from './visual/stage.js';
import { AudioEngine } from './core/audio.js';
import { api } from './core/api.js';
import { parseLRC, mergeTranslation, findLineIndex, fmtTime } from '/core/lyrics.js';
import { initDesktop } from './ui/desktop.js';
import { createLoginController } from './ui/login.js';
import { LyricFX } from './ui/lyric-fx.js';
import { TrackTransition } from './core/transition.js';
import { AnalysisManager } from './core/analysis.js';
import { Moodbar } from '/core/moodbar.js';
import { PixelBuddy } from '/core/pixel-buddy.js';
import { calibrateLyricOffset } from '/core/lyric-calib.js'
import { relevanceScore, mixedSortCompare, buildSortContext } from '/core/sort.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ==================================================================
   状态
   ================================================================== */
const state = {
  queue: [],
  queueIndex: -1,
  current: null,
  provider: 'all',
  library: { tracks: [], total: 0, dirs: [] },
  results: { tracks: [], query: '', provider: 'local' },
  lyrics: { lines: [], source: '', plain: false },
  lyricIndex: -2,
  autoCalib: null,        // 当前歌的自动校准结果 {offsetMs, confidence, lines, matched}
  repeat: 'off',          // off | all | one
  shuffle: false,
  settings: null,
  loadingTrack: false,
  draggingProgress: false,
  draggingVolume: false,
  neteaseStatus: null,
  drawerTab: 'results',
  viewMode: 'play',          // 'play'=播放页(3D) | 'browse'=浏览页(接管主区域)
  drawerContent: 'queue',    // 右栏内容：'queue' | 'pl'(歌单详情)
  playlists: null,          // { netease: {list, err, fetchedAt}, qq: {...} }
  playlistDetail: null,     // { platform, id, name, tracks, total, offset, hasMore, loading }
  fsCurrent: '',
  pendingDirs: []
};

let stage = null;
let audio = null;
let login = null;
let lyricFx = null;
let transition = null;
let analysis = null;
let moodbar = null;
let buddy = null;
let buddyMoodTimer = 0;
// state.smartCross 不放 state 对象（避免深拷贝/序列化），独立内存开关

let buddyEnergyAvg = 0;

/* ---- 智能过渡状态 ---- */
const autoCross = { prepared: false, started: false, abandoned: false };
function cur2Bpm(track) {
  try {
    const c = track && analysis ? analysis.curveFor(analysis.constructor.stableId(track)) : null;
    return c && c.bpm ? c.bpm : null;
  } catch (_) { return null; }
}
// 交叉完成/预载失败的守卫复位，在 init 内 audio 实例化后再绑定（见 bindAutoCrossGuards）
function bindAutoCrossGuards() {
  try {
    audio.on('swapped', () => { autoCross.prepared = false; autoCross.started = false; });
    audio.on('berror', () => { autoCross.prepared = false; autoCross.started = false; });
  } catch (e) { console.warn('[autoCross] 守卫绑定失败（不影响 UI）:', e.message); }
}

// 歌词偏移：生效值缓存（每帧高亮判定直接读，避免碰 localStorage）
let effOffsetMs = 0;
const AUTO_CONF_MIN = 0.55;   // 自动校准置信度阈值，低于则不套用

// 每帧只计算一次频谱，3D 光效和歌词共用同一份快照
let frameLevels = { bass: 0, energy: 0, mid: 0, treble: 0, spectrum: new Float32Array(48) };

/* ==================================================================
   小工具
   ================================================================== */
function toast(msg, type = '', duration = 2600) {
  const wrap = $('#toastWrap');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 380);
  }, duration);
  // 最多同时显示 3 条
  while (wrap.children.length > 3) wrap.firstElementChild.remove();
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

/* ==================================================================
   初始化
   ================================================================== */
async function init() {
  initDesktop();

  audio = new AudioEngine();
  bindAutoCrossGuards();   // 智能过渡守卫（audio 就绪后再绑，防顶层空引用）

  try {
    stage = new CoverStage($('#coverCanvas'), {
      getLevels: () => frameLevels,
      onPalette: applyPalette
    });
  } catch (err) {
    console.error('[init] 3D 舞台初始化失败（不影响其余 UI 交互）:', err);
  }

  // 歌词特效层：独立 DOM 层，和 3D 画布互不影响
  const lp = readLocalPrefs();
  lyricFx = new LyricFX($('#lyricInner'), {
    charFx: lp.charFx !== false,
    offsetMs: typeof lp.lyricOffset === 'number' ? lp.lyricOffset : 0,
    getScrollEl: () => $('#lyricScroll'),
    // 能量查询（线性插值）：逐字均分前用它裁掉行首/行尾静音段
    getEnergy: (t) => {
      if (!analysis) return null;
      const curve = analysis.curveFor(analysis.currentId);
      if (!curve || !curve.energy || curve.energy.length < 2) return null;
      const x = t * curve.sampleRate;
      let i = Math.floor(x);
      if (i < 0 || i >= curve.energy.length - 1) return null;
      const f = x - i;
      return curve.energy[i] * (1 - f) + curve.energy[i + 1] * f;
    },
    getAccent: () => {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb');
      const p = v.split(',').map(n => parseInt(n, 10) || 0);
      return p.length === 3 ? p : [165, 152, 255];
    },
    onSeek: (t) => {
      seekTo(t);
      if (audio.paused) audio.play();
    }
  });

  // 歌词手动滚动接管：滚轮自己换算成位移（.lyric-scroll 是 overflow:hidden，
  // 原生滚不动）；触摸/按住只暂停自动跟随。4 秒无操作后平滑回弹。
  {
    const sc = $('#lyricScroll');
    if (sc) {
      sc.addEventListener('wheel', lyricOnWheel, { passive: true });
      sc.addEventListener('touchmove', lyricUserTakeover, { passive: true });
      sc.addEventListener('pointerdown', lyricUserTakeover, { passive: true });
    }
    // 排查口：F12 打开控制台后执行 __lyricState() 查看接管状态
    window.__lyricState = () => ({
      hold: lyricHold, baseY: lyricBaseY, manualY: lyricManualY,
      idx: state.lyricIndex, lines: state.lyrics.lines.length,
      rows: lyricFx ? lyricFx.nodes.length : 0
    });
  }

  login = createLoginController({
    toast,
    onLoggedIn: (pf) => {
      if (pf === 'netease') checkNetease();
      renderAccountCards();
    }
  });
  login.bind();

  initTransition();

  initAnalysis();

  bindStageResize();
  bindUI();
  bindAudioEvents();
  await loadSettings();
  applyLocalPrefs();
  checkNetease();          // 启动即检测登录态（联动心动模式/私人漫游入口）
  await loadLibrary();
  startUITick();

  // 提示拖动
  setTimeout(() => $('#dragHint').classList.add('show'), 1200);
  setTimeout(() => $('#dragHint').classList.remove('show'), 7000);

  // 支持 ?play=1 直接开始播放（便于做桌面快捷方式 / 开机自启）
  const params = new URLSearchParams(location.search);
  if (params.get('play') === '1' && state.queue.length) {
    playQueue(state.queue, 0);
  }

  // 调试入口（供开发排查 / 自动化测试使用）
  window.__aurora = { state, audio, stage, api, playQueue, lyricFx, transition, seekTo, analysis, moodbar };
}

function bindStageResize() {
  const holder = $('#canvasHolder');
  if (!holder) return;
  const ro = new ResizeObserver(() => { try { stage && stage.resize(); } catch (_) {} });
  ro.observe(holder);
  window.addEventListener('resize', () => { try { stage && stage.resize(); } catch (_) {} });
}

/* ==================================================================
   主题色
   ================================================================== */
function applyPalette(pal) {
  const [r, g, b] = pal.accent;
  const root = document.documentElement;

  // 保证强调色在深色背景上有足够亮度
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const k = lum < 95 ? 95 / Math.max(1, lum) : 1;
  const rr = Math.min(255, Math.round(r * k));
  const gg = Math.min(255, Math.round(g * k));
  const bb = Math.min(255, Math.round(b * k));

  root.style.setProperty('--accent', `rgb(${rr},${gg},${bb})`);
  root.style.setProperty('--accent-rgb', `${rr}, ${gg}, ${bb}`);
  root.style.setProperty('--accent-2', `rgb(${Math.min(255, rr + 40)},${Math.min(255, gg + 30)},${bb})`);

  // 歌词逐字颜色跟着主色走
  if (lyricFx) lyricFx.setAccent([rr, gg, bb]);
}

/* ==================================================================
   设置
   ================================================================== */
async function loadSettings() {
  try {
    state.settings = await api.getSettings();
  } catch (err) {
    state.settings = { musicDirs: [], ui: { glowEnabled: true, volume: 0.8 } };
    toast('无法连接本地服务：' + err.message, 'err');
  }
  return state.settings;
}

function applyLocalPrefs() {
  const s = state.settings || {};
  const ui = s.ui || {};
  const ls = readLocalPrefs();

  const glow = ui.glowEnabled !== false && ls.glow !== false;
  const particles = ls.particles !== false;
  const autoRotate = !!ls.autoRotate;
  const puzzle = ls.puzzle !== false;
  const charFx = ls.charFx !== false;
  const volume = typeof ls.volume === 'number' ? ls.volume : (ui.volume ?? 0.8);

  stage.setGlow(glow);
  stage.setParticles(particles);
  stage.setAutoRotate(autoRotate);
  stage.setPuzzle(puzzle);
  if (lyricFx) lyricFx.applyPrefs({ charFx });
  refreshLyricOffset();

  $('#btnGlow').classList.toggle('off', !glow);
  audio.setVolume(volume);
  $('#volFill').style.width = (volume * 100) + '%';

  // 表单回填
  $('#setGlow').checked = glow;
  $('#setParticles').checked = particles;
  $('#setAutoRotate').checked = autoRotate;
  $('#setPuzzle').checked = puzzle;
  $('#setCharFx').checked = charFx;
  $('#setNeteaseUrl').value = s.neteaseBaseUrl || '';
  $('#setNeteaseCookie').value = s.neteaseCookie || '';
  $('#setNeteaseLevel').value = s.neteaseLevel || 'exhigh';
}

function updateLyricOffsetLabel(ms) {
  const v = Number(ms) || 0;
  const el = $('#lyricOffsetVal');
  if (el) el.textContent = (v > 0 ? '+' : '') + v + 'ms';
}

function readLocalPrefs() {
  try {
    return JSON.parse(localStorage.getItem('aurora.prefs') || '{}');
  } catch (_) { return {}; }
}

function saveLocalPrefs(patch) {
  const cur = readLocalPrefs();
  localStorage.setItem('aurora.prefs', JSON.stringify({ ...cur, ...patch }));
}

/* ==================================================================
   歌词偏移：单曲手动 > 自动高置信 > 全局手动 > 0
   生效偏移统一语义：加到 audio.currentTime 上的补偿值（正值=歌词提前）
   ================================================================== */
function trackOffsetOverrides() {
  const ls = readLocalPrefs();
  return (ls.lyricOverrides && typeof ls.lyricOverrides === 'object') ? ls.lyricOverrides : {};
}

function getLyricOffsetMs() {
  const track = state.current;
  if (track) {
    const ov = trackOffsetOverrides()[AnalysisManager.stableId(track)];
    if (typeof ov === 'number') return ov;
  }
  const ls = readLocalPrefs();
  if (typeof ls.lyricOffset === 'number') return ls.lyricOffset;
  // 自动校准排第三，仅当置信度达标时生效
  const ac = state.autoCalib;
  if (ac && ac.confidence >= AUTO_CONF_MIN) return ac.offsetMs;
  return 0;
}

function refreshLyricOffset() {
  effOffsetMs = getLyricOffsetMs();
  if (lyricFx) lyricFx.applyPrefs({ offsetMs: effOffsetMs });
  updateCalibUI();
}

/** 设置面板回显：滑杆位置 + 自动校准状态 */
function updateCalibUI() {
  const ls = readLocalPrefs();
  const g = typeof ls.lyricOffset === 'number' ? ls.lyricOffset : 0;
  $('#setLyricOffset').value = g;
  updateLyricOffsetLabel(g);

  const track = state.current;
  const id = track ? AnalysisManager.stableId(track) : '';
  const ov = id ? trackOffsetOverrides()[id] : undefined;
  const slider = $('#setTrackOffset');
  if (slider) {
    slider.disabled = !track;
    slider.value = typeof ov === 'number' ? ov : 0;
  }
  const tv = $('#trackOffsetVal');
  if (tv) tv.textContent = (ov > 0 ? '+' : '') + (ov || 0) + 'ms';

  const st = $('#calibStatus');
  if (!st) return;
  const ac = state.autoCalib;
  if (!track || !ac) {
    st.textContent = '未校准';
    st.className = 'calib-status';
    return;
  }
  const sign = ac.offsetMs > 0 ? '+' : '';
  if (ac.confidence >= AUTO_CONF_MIN) {
    st.textContent = `自动 ${sign}${ac.offsetMs}ms · 置信 ${ac.confidence}（已套用）`;
    st.className = 'calib-status ok';
  } else {
    st.textContent = `自动 ${sign}${ac.offsetMs}ms · 置信 ${ac.confidence}（过低未套用）`;
    st.className = 'calib-status low';
  }
}

/**
 * 歌词与曲线都就绪时做一次自动校准（每首歌只做一次）。
 * 缓存里已有结果的直接采用；否则现算并写回 analysis JSON。
 */
function tryCalibrate() {
  const track = state.current;
  if (!track || state.autoCalib) return;
  const lines = state.lyrics.lines;
  if (!lines.length || state.lyrics.plain) return;
  const lineTimes = lines.filter(l => l.time >= 0).map(l => l.time);
  if (lineTimes.length < 5) return;

  const id = AnalysisManager.stableId(track);
  const curve = analysis && analysis.curveFor(id);
  if (!curve || !curve.flux || curve.flux.length < 50) return;

  let res;
  if (curve.lyricCalib && typeof curve.lyricCalib.offsetMs === 'number') {
    res = curve.lyricCalib;                       // 上次算过，直接采用
  } else {
    res = calibrateLyricOffset(curve.flux, curve.fluxRate || 25, lineTimes);
    analysis.patchCalib(id, {
      offsetMs: res.offsetMs, confidence: res.confidence,
      lines: res.lines, matched: res.matched, createdAt: Date.now()
    });
  }
  state.autoCalib = res;
  refreshLyricOffset();
  // 曲线可能刚就绪：重渲一次让逐字均分用上静音裁剪
  renderLyricLines();
}

/* ==================================================================
   曲库
   ================================================================== */
async function loadLibrary(refresh = false) {
  try {
    const lib = await api.library(refresh);
    state.library = lib;
    if (lib.total === 0) {
      $('#drawerFoot').textContent = '曲库为空 · 请在设置中添加音乐文件夹';
    } else {
      $('#drawerFoot').textContent =
        `共 ${lib.total} 首 · 含歌词 ${lib.withLyric} · 含封面 ${lib.withCover}`;
    }
    renderMain();
    if (lib.dirs && lib.dirs.length) {
      state.pendingDirs = lib.dirs.slice();
      renderDirList();
    }
    // 曲库加载完，若队列为空则填充
    if (state.queue.length === 0 && state.library.tracks.length) {
      state.queue = state.library.tracks.slice();
      renderMain();
    }
    return lib;
  } catch (err) {
    toast('曲库加载失败：' + err.message, 'err');
    return null;
  }
}

/* ==================================================================
   播放
   ================================================================== */

/** 设置播放队列并播放指定索引 */
function playQueue(tracks, index) {
  if (!tracks || !tracks.length) return;
  if (dynamic) saveLocalPrefs({ dynamicSession: null });
  dynamic = null;               // 手动播放普通队列 = 退出动态模式
  updateDynamicBar();
  state.queue = tracks.slice();
  state.queueIndex = Math.max(0, Math.min(index, tracks.length - 1));
  renderMain();
  playCurrent();
}

/* ==================================================================
   动态队列（心动模式 / 私人漫游）
   缓冲在服务端（剩 <3 首自动异步补货），前端只在队列快见底时追加
   ================================================================== */
let dynamic = null;   // { id, platform, type, extending }

function isNeteaseLoggedIn() {
  return !!(state.neteaseStatus && state.neteaseStatus.loggedIn);
}

let _qqLoggedIn = null;
function isQqLoggedIn() {
  return _qqLoggedIn === true;
}
async function refreshQqLoginState() {
  try {
    const st = await api.accountStatus('qq');
    _qqLoggedIn = !!st.loggedIn;
  } catch (_) { _qqLoggedIn = false; }
  return _qqLoggedIn;
}

function updateDynamicBar() {
  // 状态灯：只在心动模式 / 私人漫游进行中点亮，退出立刻熄灭且不占位
  const sts = $$('#dynamicState');
  if (!sts.length) return;
  sts.forEach(st => {
    if (dynamic) {
      const label = dynamic.label || (dynamic.type === 'heartmix' ? '心动模式' : '私人漫游');
      const icon = (dynamic.label || dynamic.type) === '心动模式' || dynamic.type === 'heartmix' ? '✨' : '📶';
      const sides = dynamic.sides || [];
      const mixTxt = sides.length === 2 ? ' · 双平台混合'
        : sides.length === 1 ? ` · ${sides[0] === 'netease' ? '网易云' : 'QQ'}` : '';
      st.textContent = `${icon} ${label}${mixTxt}`;
      st.title = '点击退出' + label;
      st.className = 'dyn-chip on';
    } else {
      st.textContent = '';
      st.title = '';
      st.className = 'dyn-chip';
    }
  });
}

/** 退出心动 / 漫游：清会话、灭状态灯、回普通队列（队列本身的歌继续放完） */
function exitDynamic(silent) {
  if (!dynamic) return;
  const label = dynamic.label || (dynamic.type === 'heartmix' ? '心动模式' : '私人漫游');
  dynamic = null;
  saveLocalPrefs({ dynamicSession: null });
  updateDynamicBar();
  if (!silent) toast('已退出' + label);
}

/** 重启后恢复动态队列上下文（服务端会话含缓冲，恢复后队列继续按需追加） */
function restoreDynamicSession() {
  const ls = readLocalPrefs();
  const saved = ls.dynamicSession;
  if (!saved || !saved.id) return;
  // 旧版本残留的单平台混合会话：直接作废（服务端 SESSION_VER 门也会拦一层）
  if ((saved.type === 'heartmix' || saved.type === 'fmix') && saved.platform !== 'mix') {
    saveLocalPrefs({ dynamicSession: null });
    return;
  }
  if (!isNeteaseLoggedIn() && !isQqLoggedIn()) return;
  dynamic = { id: saved.id, platform: saved.platform, type: saved.type, extending: false };
  // 服务端会话可能已过期（12h TTL）：取一次歌验证，失败则放弃
  api.dynamicNext(dynamic.platform, dynamic.id, 1)
    .then((r) => {
      if (!r.tracks.length && r.exhausted) { dynamic = null; }
      updateDynamicBar();
    })
    .catch(() => { dynamic = null; updateDynamicBar(); });
  updateDynamicBar();
}

async function startDynamic(type) {
  // 网易云逻辑：不需要任何前置条件 —— 没在播歌也能直接开（无种子走全局推荐）
  let seed = null;
  const cur = state.current;
  if (cur && cur.provider !== 'local' && (cur.nid || cur.gid || cur.id)) {
    seed = { trackId: cur.id };            // 服务端据此读 analysis.json 里的 BPM
    if (cur.provider === 'netease' && cur.nid) {
      let pid = cur.nid;
      try {
        const pls = await api.playlists('netease');
        const liked = (pls.playlists || []).find(p => p.special === 'like');
        if (liked) pid = liked.id;
      } catch (_) {}
      seed.id = cur.nid;
      seed.pid = pid;
    } else if (cur.gid) {
      seed.seedMid = cur.gid;
    }
  }

  // 心动模式在没有种子歌时无法做"相似"，按全局推荐发起（与网易云一致）
  const useType = (type === 'heartmix' && !seed) ? 'personalfm' : type;

  try {
    const r = await api.dynamicSession('mix', useType, seed);
    dynamic = {
      id: r.sessionId,
      platform: 'mix',
      type: useType,
      label: type === 'heartmix' ? '心动模式' : '私人漫游',   // 用户点的那个名字
      extending: false
    };
    saveLocalPrefs({ dynamicSession: { id: r.sessionId, platform: 'mix', type: useType } });
    updateDynamicBar();

    const first = await api.dynamicNext('mix', r.sessionId, 4);
    if (!first.tracks.length) {
      toast('推荐队列暂时为空，稍后再试', 'err');
      dynamic = null;
      updateDynamicBar();
      return;
    }
    dynamic.sides = [...new Set(first.tracks.map(t => t.provider))].filter(p => p === 'netease' || p === 'qq');
    // 直接把推回来的歌塞进队列，并立刻开始播
    state.queue = first.tracks.slice();
    state.queueIndex = 0;
    renderMain();
    playCurrent();
    const typeName = dynamic.label;
    if (dynamic.sides.length === 2) toast(`${typeName}已开启 · 双平台混合（网易云 + QQ）`, 'ok', 3200);
    else if (dynamic.sides.length === 1) toast(`${typeName}已开启（仅 ${dynamic.sides[0] === 'netease' ? '网易云' : 'QQ'}：另一平台未登录或暂不可用）`, '', 3600);
    else toast(`${typeName}已开启`, 'ok');
    updateDynamicBar();
  } catch (err) {
    dynamic = null;
    updateDynamicBar();
    toast('开启失败：' + err.message, 'err');
  }
}

/** 队列快见底时追加下一批（每次切歌都会检查） */
async function extendDynamicQueue() {
  if (!dynamic || dynamic.extending) return;
  const remaining = state.queue.length - state.queueIndex - 1;
  if (remaining > 2) return;
  dynamic.extending = true;
  try {
    const r = await api.dynamicNext(dynamic.platform, dynamic.id, 2);
    if (r.tracks.length) {
      state.queue.push(...r.tracks);
      renderMain();
    } else if (r.exhausted) {
      toast('推荐已到尽头，动模式结束');
      saveLocalPrefs({ dynamicSession: null });
      dynamic = null;
      updateDynamicBar();
    }
  } catch (_) {}
  finally { dynamic.extending = false; }
}

async function playCurrent() {
  const track = state.queue[state.queueIndex];
  if (!track) return;
  extendDynamicQueue();          // 切歌即检查是否需要追加
  await playTrack(track);
}

/**
 * 切歌状态机 —— 整个项目里唯一决定"何时开始转场"的地方。
 * playTrack 只负责把请求交进来，音频/视觉的先后与竞争都在这里处理。
 */
function initTransition() {
  transition = new TrackTransition({
    // 音频先切
    onAudio: async (track, gen) => {
      setPlayLoading(true);
      try {
        await audio.ensureContext();
        if (!transition.isCurrent(gen)) return;   // 已被新的切歌取代，丢弃
        await audio.load(api.streamUrl(track), { autoplay: true });
        if (!transition.isCurrent(gen)) return;
        saveLocalPrefs({ lastTrackId: track.id, lastProvider: track.provider });
      } catch (err) {
        if (transition.isCurrent(gen)) toast('播放失败：' + err.message, 'err');
      } finally {
        if (transition.isCurrent(gen)) setTimeout(() => setPlayLoading(false), 240);
      }
    },

    // 视觉跟进，时长由 stage 的碎片动画决定
    onVisual: async (track, gen) => {
      const cover = api.coverUrl(track);
      // 拼图关闭时降级为「平滑切入切出」（旧封面淡出放大 → 新封面淡入），不再是硬切
      const mode = stage.puzzleEnabled ? 'animate' : 'fade';
      try {
        await stage.setCover(cover, {
          mode,
          // 纹理加载完时可能已经切到下一首了，交给 stage 决定是否应用
          isCurrent: () => transition.isCurrent(gen)
        });
      } catch (_) {}
      if (!transition.isCurrent(gen)) return;
      setBackground(cover);
    },

    onSettle: () => {
      setPlayLoading(false);
    },

    onSupersede: (oldTrack) => {
      // 旧转场的异步结果会被 generation 检查丢弃，这里只留个观察点
    }
  });
}

function playTrack(track) {
  setViewMode('play');   // 点歌播放 → 主区域切回 3D 播放页
  if (buddy) buddy.reactSwitch();   // 像素伴侣：切歌被晃一下
  if (!track) return;

  // 元信息、歌词、高亮立即更新（歌词层与视觉层完全独立）
  state.current = track;
  updateTrackMeta(track);
  updatePlayingHighlight();
  loadLyric(track);

  // 交给状态机，之后的音频/视觉顺序由它仲裁
  if (analysis) analysis.onTrackChange(track);
  transition.begin(track);
}

/** 所有 seek 都走这里，保证中途拖动进度条时视觉不会落后于声音 */
function seekTo(t) {
  const wasTransitioning = transition && transition.notifySeek();
  if (wasTransitioning && stage) stage.finishPuzzle();
  audio.seek(t);

  // seek 后立刻按新时间重算歌词高亮：逐字律动的旧状态不能卡死
  if (lyricFx && state.lyrics.lines.length && !state.lyrics.plain) {
    const idx = findLineIndex(state.lyrics.lines, Math.max(0, t + effOffsetMs / 1000));
    state.lyricIndex = idx;
    lyricFx.setIndex(idx);
    // seek = 用户明确要求跳转：取消预览保持，歌词立即回到新位置
    lyricHold = false;
    clearTimeout(lyricHoldTimer);
    lyricManualY = 0;
    lyricBaseY = lyricAutoTarget(Math.max(0, idx));
    if (idx >= 0) lyricApplyTy(lyricBaseY);
  }
}

/** 情绪曲线：分析管理器 + 进度条上的曲线 UI */
function initAnalysis() {
  const getAccent = () => {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb');
    const p = v.split(',').map(n => parseInt(n, 10) || 0);
    return p.length === 3 ? p : [165, 152, 255];
  };

  moodbar = new Moodbar($('#moodCanvas'), {
    playback: () => ({ t: audio.currentTime, dur: audio.duration }),
    getAccent,
    progressEl: $('#moodProgress'),
    fillEl: $('#progFill'),
    tagEl: $('#moodTag')
  });

  // 像素伴侣（可开关，默认开）
  buddy = new PixelBuddy($('#buddyHost'), {
    getLevels: () => frameLevels,
    isPlaying: () => !audio.paused
  });
  buddy.setEnabled(readLocalPrefs().buddy !== false);
  // 智能过渡开关（默认开；关闭 = 纯硬切）
  state.smartCross = readLocalPrefs().smartCross !== false;
  const crossChk = $('#setSmartCross');
  if (crossChk) {
    crossChk.checked = state.smartCross;
    crossChk.addEventListener('change', () => {
      state.smartCross = crossChk.checked;
      saveLocalPrefs({ smartCross: crossChk.checked });
      if (!crossChk.checked) {
        audio.clearPrepared();          // 立即丢弃预载，彻底回到硬切
        autoCross.prepared = false;
        autoCross.started = false;
        autoCross.abandoned = false;
      }
      toast(crossChk.checked ? '智能过渡已开启' : '智能过渡已关闭（纯硬切）');
    });
  }

  const buddyChk = $('#setBuddy');
  if (buddyChk) {
    buddyChk.checked = buddy.enabled;
    buddyChk.addEventListener('change', () => {
      buddy.setEnabled(buddyChk.checked);
      saveLocalPrefs({ buddy: buddyChk.checked });
      toast(buddyChk.checked ? '像素伴侣已上线' : '像素伴侣已休息');
    });
  }

  analysis = new AnalysisManager({
    onCurve: (curve) => {
      if (moodbar) moodbar.setCurve(curve);
      tryCalibrate();   // 曲线就绪时若歌词已加载，立即校准
    }
  });

  // canvas 尺寸跟随进度条宽度与 DPR
  const ro = new ResizeObserver(() => moodbar && moodbar.resize());
  ro.observe($('#progressBar'));
  window.addEventListener('resize', () => moodbar && moodbar.resize());
  requestAnimationFrame(() => moodbar && moodbar.resize());
}

function setPlayLoading(on) {
  $('#btnPlay').classList.toggle('busy', on);
}

function updateTrackMeta(track) {
  $('#trackTitle').textContent = track.title || '未知曲目';
  const sub = [track.artist, track.album].filter(Boolean).join(' · ');
  $('#trackArtist').textContent = sub || '未知艺术家';

  $('#miniTitle').textContent = track.title || '—';
  $('#miniArtist').textContent = track.artist || '—';

  // 标签
  const tags = $('#metaTags');
  tags.innerHTML = '';
  const add = (text, hl) => {
    if (!text) return;
    const s = el('span', hl ? 'hl' : '', text);
    tags.appendChild(s);
  };
  if (track.provider === 'netease') add('网易云音源', true);
  else add('本地音源');
  if (track.provider === 'local') {
    if (track.hasCover) add('内嵌封面');
    if (track.hasLyric) add('LRC 歌词');
  }
  if (track.year) add(track.year);

  // 迷你封面
  const mc = $('#miniCover');
  mc.style.backgroundImage = `url("${api.coverUrl(track)}")`;
  mc.innerHTML = '';
}

function setBackground(url) {
  const bg = $('#bgBlur');
  const img = new Image();
  img.onload = () => {
    bg.style.backgroundImage = `url("${url}")`;
    bg.classList.add('on');
  };
  img.onerror = () => bg.classList.remove('on');
  img.src = url;
}

/* ---------------- 上一首 / 下一首 ---------------- */
function nextTrack(auto = false) {
  if (!state.queue.length) return;

  if (state.repeat === 'one' && auto) {
    seekTo(0);
    audio.play();
    return;
  }

  let idx;
  if (state.shuffle && state.queue.length > 1) {
    do { idx = Math.floor(Math.random() * state.queue.length); }
    while (idx === state.queueIndex);
  } else {
    idx = state.queueIndex + 1;
    if (idx >= state.queue.length) {
      if (state.repeat === 'all' || !auto) idx = 0;
      else { // 顺序播放到末尾
        audio.pause();
        return;
      }
    }
  }
  state.queueIndex = idx;
  playCurrent();
  updatePlayingHighlight();
}

function prevTrack() {
  if (!state.queue.length) return;
  // 纯粹切歌：不再"超过 4 秒就重播当前曲"（那个逻辑导致要点两次才能回上一首）
  let idx = state.queueIndex - 1;
  if (idx < 0) idx = state.repeat === 'all' ? state.queue.length - 1 : 0;
  state.queueIndex = idx;
  playCurrent();
  updatePlayingHighlight();
}

/* ==================================================================
   歌词
   ================================================================== */
let lyricReqId = 0;              // 歌词请求令牌：防旧请求回来说新请求

async function loadLyric(track) {
  const reqId = ++lyricReqId;
  // ① 切歌瞬间立刻清掉上一首的词，并给出占位提示（不等网络）
  clearLyric();
  showLyricEmpty('歌词加载中…', `${track.title || ''} · ${track.artist || ''}`.trim());
  state.autoCalib = null;          // 换歌了，旧校准作废
  refreshLyricOffset();
  $('#lyricSource').textContent = '加载中…';

  let data;
  try {
    data = await api.getLyric(track);
  } catch (err) {
    if (reqId !== lyricReqId || state.current !== track) return;   // 已切歌，丢弃
    $('#lyricSource').textContent = '获取失败';
    showLyricEmpty('歌词获取失败', err.message);
    return;
  }

  // ② 竞态保护：加载过程中又切歌了（令牌 + 当前曲目双重校验）
  if (reqId !== lyricReqId || state.current !== track) return;

  const raw = (data && data.lrc) || '';
  const trans = (data && data.translated) || '';

  if (!raw.trim()) {
    $('#lyricSource').textContent = '暂无歌词';
    showLyricEmpty('这首歌还没有歌词', track.provider === 'local'
      ? '把同名 .lrc 文件放到歌曲旁边就能自动识别'
      : '可以换一个音源试试');
    return;
  }

  const parsed = trans ? mergeTranslation(raw, trans) : parseLRC(raw);
  state.lyrics = {
    lines: parsed.lines,
    source: (data.source || '') + (parsed.plain ? ' · 纯文本' : ''),
    plain: parsed.plain
  };
  state.lyricIndex = -2;

  $('#lyricSource').textContent = state.lyrics.source;
  // ③ 时间校准：不默认从第 0 行开始，按当前播放进度直接定位并滚动到位
  const offsetSec = effOffsetMs / 1000;
  const curIdx = findLineIndex(state.lyrics.lines, Math.max(0, audio.currentTime + offsetSec));
  state.lyricIndex = curIdx;
  renderLyricLines();
  if (curIdx >= 0 && lyricFx) lyricFx.scrollTo(curIdx);
  tryCalibrate();   // 曲线可能已在内存里，歌词一到就校准
}

function clearLyric() {
  if (lyricFx) lyricFx.clear();
  const inner = $('#lyricInner');
  inner.innerHTML = '';
  inner.style.transform = 'translateY(0)';
  state.lyrics = { lines: [], source: '', plain: false };
  state.lyricIndex = -2;
}

function showLyricEmpty(title, sub) {
  if (lyricFx) lyricFx.clear();
  const inner = $('#lyricInner');
  inner.innerHTML = '';
  const box = el('div', 'lyric-empty');
  box.innerHTML = `
    <div class="vinyl-spin">
      <svg viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".35"/>
        <circle cx="50" cy="50" r="30" fill="none" stroke="currentColor" stroke-width="1" opacity=".25"/>
        <circle cx="50" cy="50" r="12" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".5"/>
        <circle cx="50" cy="50" r="3.5" fill="currentColor" opacity=".7"/>
      </svg>
    </div>
    <p>${escapeHtml(title)}<br><small>${escapeHtml(sub || '')}</small></p>`;
  inner.appendChild(box);
  inner.style.transform = 'translateY(0)';
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderLyricLines() {
  if (!lyricFx) return;
  lyricFx.render(state.lyrics);
  $('#lyricInner').style.transform = 'translateY(0)';
  // 重渲后保持当前高亮位置（校准就绪重渲时不能跳回开头）
  if (state.lyricIndex >= 0) {
    lyricFx.setIndex(state.lyricIndex);
    lyricFx.scrollTo(state.lyricIndex);
    if (!lyricHold) {
      lyricBaseY = lyricAutoTarget(state.lyricIndex);
      lyricManualY = 0;
    }
  }
}

/* ---------------- 歌词滚动控制（桌面端 .lyric-scroll 是 overflow:hidden，
   滚动完全由 #lyricInner 的 transform 驱动，滚轮增量必须自己换算成位移） ---------------- */
let lyricHold = false;          // 用户手动滚动接管中
let lyricHoldTimer = null;
let lyricTweenId = 0;           // 回弹动画令牌
let lyricBaseY = 0;             // 当前自动定位的 translateY（负值）
let lyricManualY = 0;           // 用户手动滚出的偏移（相对自动定位）

function lyricApplyTy(ty) {
  const el = $('#lyricInner');
  if (el) el.style.transform = `translateY(${ty}px)`;
}

/** 某行高亮时 #lyricInner 应该处于的 translateY */
function lyricAutoTarget(idx) {
  const sc = $('#lyricScroll');
  const node = lyricFx && lyricFx.nodes ? lyricFx.nodes[idx] : null;
  if (!node || !sc) return 0;
  return -Math.max(0, node.offsetTop + node.offsetHeight / 2 - sc.clientHeight * 0.42);
}

function lyricMaxUp() {
  const inner = $('#lyricInner'), sc = $('#lyricScroll');
  if (!inner || !sc) return 0;
  return Math.max(0, inner.scrollHeight - sc.clientHeight + 60);
}

function lyricUserTakeover() {
  if (!lyricHold) console.log('[lyric] 手动接管：暂停自动跟随');
  lyricHold = true;
  lyricTweenId++;                            // 取消进行中的回弹
  clearTimeout(lyricHoldTimer);
  lyricHoldTimer = setTimeout(() => {
    lyricHold = false;
    console.log('[lyric] 4 秒无操作，回弹到当前句');
    bounceLyricBack();
  }, 4000);
}

/** 滚轮 → 位移（桌面端没有原生滚动，只能自己换算） */
function lyricOnWheel(e) {
  lyricUserTakeover();
  let ty = lyricBaseY + lyricManualY - (e.deltaY || 0) * 0.55;
  ty = Math.max(-lyricMaxUp(), Math.min(0, ty));
  lyricManualY = ty - lyricBaseY;
  lyricApplyTy(ty);
}

/** 回弹：从当前视觉位置平滑滑回当前高亮行的自动定位 */
function bounceLyricBack() {
  const idx = state.lyricIndex;
  if (idx == null || idx < 0 || !lyricFx) { lyricManualY = 0; return; }
  const newBase = lyricAutoTarget(idx);
  const fromTy = lyricBaseY + lyricManualY;
  if (Math.abs(fromTy - newBase) < 1) {
    lyricBaseY = newBase; lyricManualY = 0; lyricApplyTy(newBase);
    return;
  }
  const id = ++lyricTweenId;
  const start = performance.now(), dur = 640;
  const step = (now) => {
    if (id !== lyricTweenId || lyricHold) return;   // 用户又动了，交还控制权
    const p = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    lyricApplyTy(fromTy + (newBase - fromTy) * e);
    if (p < 1) requestAnimationFrame(step);
    else { lyricBaseY = newBase; lyricManualY = 0; }
  };
  requestAnimationFrame(step);
}

function updateLyricHighlight() {
  if (!state.lyrics.lines.length || state.lyrics.plain) return;
  // 生效偏移直接加在判定时间上，链上不叠任何额外延迟
  const t = audio.currentTime + effOffsetMs / 1000;
  const idx = findLineIndex(state.lyrics.lines, t);
  if (idx === state.lyricIndex) return;

  state.lyricIndex = idx;
  if (!lyricFx) return;

  lyricFx.setIndex(idx);
  // 手动预览期间只更新高亮，不抢滚动；松手后由回弹逻辑归位
  if (idx >= 0 && !lyricHold) {
    lyricFx.scrollTo(idx);
    lyricBaseY = lyricAutoTarget(idx);
    lyricManualY = 0;
  }
}

function scrollToLyric(idx) {
  if (!lyricFx) return;
  lyricFx.scrollTo(idx);
}

/* ==================================================================
   UI 循环
   ================================================================== */
function startUITick() {
  const loop = () => {
    // 每帧只取一次频谱快照，3D 光效与歌词共用
    frameLevels = audio.getLevels();

    if (!audio.paused) {
      updateProgressUI();
      updateLyricHighlight();
      if (lyricFx) lyricFx.tick(audio.currentTime, frameLevels);
    }

    // 情绪曲线每帧刷新（曲线数据没变时内部只更新游标与填充色，不重绘 canvas）
    if (moodbar) moodbar.tick();
    // ---- 智能过渡自动驾驶：剩余 30s 预载 / 剩余 4.5s 触发交叉（开关关闭时整段跳过=纯硬切） ----
    if (state.smartCross !== false && !audio.paused && audio.duration > 0 && state.queue.length > state.queueIndex + 1 && !state.loadingTrack && !autoCross.abandoned) {
      const remain = audio.duration - audio.currentTime;
      const nextT = state.queue[state.queueIndex + 1];
      if (remain > 0 && nextT) {
        if (remain <= 30 && !autoCross.prepared && !autoCross.started) {
          autoCross.prepared = true;
          console.log(`[智能过渡] 剩余 ${remain.toFixed(0)}s，开始预载下一首「${nextT.title}」进 B 轨`);
          audio.prepareNext(api.streamUrl(nextT)).catch(() => { autoCross.prepared = false; });
        }
        if (remain <= 4.5 && !autoCross.started && audio.crossfadeReady) {
          // BPM 对齐检查：双方缓存都有 bpm 且差 > 6 → 放弃交叉（硬切由 ended 自然发生）
          let bpmBlock = false;
          try {
            const bpmCur = cur2Bpm(state.current);
            const bpmNext = cur2Bpm(nextT);
            if (bpmCur && bpmNext && Math.abs(bpmCur - bpmNext) > 6) {
              console.log(`[智能过渡] BPM 差值过大 (${bpmCur} vs ${bpmNext})，降级为硬切`);
              bpmBlock = true;
            } else if (bpmCur && bpmNext) {
              console.log(`[智能过渡] BPM 对齐通过 (${bpmCur} vs ${bpmNext})，启用交叉`);
            } else {
              console.log('[智能过渡] 无 BPM 缓存，默认启用交叉');
            }
          } catch (_) {}
          if (bpmBlock) {
            autoCross.started = false;
            autoCross.prepared = false;
            autoCross.abandoned = true;   // BPM 不合：本曲放弃交叉，降级硬切
          } else {
            autoCross.started = true;      // 守卫：绝不重复触发
            console.log(`[智能过渡] 剩余 ${remain.toFixed(1)}s，启动交叉淡化切换`);
          }
        }
        if (autoCross.started && audio.crossfadeReady) {
          nextTrack(true);               // → playTrack → audio.load 命中预载 URL → 交叉淡化
        }
      }
    }

    if (buddy && buddy.enabled) {
      buddy.tick();
      // 曲风性格：每 45 帧算一次，数据源 = analysis 缓存的 bpm/能量曲线 + 实时能量滑窗
      buddyMoodTimer++;
      if (buddyMoodTimer >= 45) {
        buddyMoodTimer = 0;
        const cur = state.current;
        let mode = 'normal';
        try {
          const curve = cur && analysis ? analysis.curveFor(analysis.constructor.stableId(cur)) : null;
          if (curve && curve.bpm) {
            if (curve.bpm > 125) mode = 'hype';
            else if (curve.bpm < 80) mode = 'calm';
            else if (Array.isArray(curve.energy) && curve.energy.length) {
              const avg = curve.energy.reduce((a, b) => a + b, 0) / curve.energy.length;
              mode = avg > 0.4 ? 'hype' : (avg < 0.15 ? 'calm' : 'normal');
            }
          } else if (!audio.paused && audio.currentTime > 8) {
            // 冷启动无缓存：8 秒后用实时能量滑窗兜底
            buddyEnergyAvg = buddyEnergyAvg * 0.95 + (frameLevels.energy || 0) * 0.05;
            mode = buddyEnergyAvg > 0.4 ? 'hype' : (buddyEnergyAvg < 0.12 ? 'calm' : 'normal');
          }
        } catch (_) { mode = 'normal'; }
        buddy.setPersonality(mode);
      }
    }
    // 兜底实时采样（有完整缓存时分析管理器内部会忽略）
    if (analysis) analysis.sample(audio.currentTime, frameLevels.energy);

    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function updateProgressUI() {
  const dur = audio.duration;
  const cur = audio.currentTime;
  if (dur > 0 && isFinite(dur)) {
    const pct = Math.min(100, (cur / dur) * 100);
    if (!state.draggingProgress) {
      $('#progFill').style.width = pct + '%';
      $('#timeNow').textContent = fmtTime(cur);
    }
    $('#timeTotal').textContent = fmtTime(dur);
    const buf = audio.buffered;
    if (buf > 0) $('#progBuffer').style.width = Math.min(100, (buf / dur) * 100) + '%';
  }
}

/* ==================================================================
   音频事件
   ================================================================== */
function bindAudioEvents() {
  audio.on('play', () => {
    $('#btnPlay').classList.add('playing');
    document.body.classList.add('is-playing');
  });

  audio.on('pause', () => {
    $('#btnPlay').classList.remove('playing');
    document.body.classList.remove('is-playing');
    if (lyricFx) lyricFx.settle();
  });

  audio.on('duration', (d) => {
    if (d && isFinite(d)) {
      $('#timeTotal').textContent = fmtTime(d);
    }
  });

  audio.on('ended', () => nextTrack(true));

  // 连续取链失败计数：自动跳过但绝不死循环
  let streamFailStreak = 0;
  let fallbackBusy = false;

  /** 跨平台音源兜底：在另一个平台搜"歌名+歌手"，返回首个标题匹配的曲目 */
  async function findCrossPlatformMatch(track) {
    if (!track || track.provider === 'local' || track._noFallback) return null;
    const other = track.provider === 'netease' ? 'qq' : 'netease';
    const q = [track.title, (track.artist || '').split(' / ')[0]].filter(Boolean).join(' ');
    try {
      const r = await api.search(q, other, 8);
      const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, '');
      const tt = norm(track.title);
      return ((r.tracks || []).find(t => {
        const nt = norm(t.title);
        return nt && (nt.includes(tt) || tt.includes(nt));
      })) || null;
    } catch (_) {
      return null;
    }
  }

  audio.on('error', async (msg) => {
    // 拿服务端的具体错误（如"QQ版权受限：xxx"），比 <audio> 的通用码更有用
    let final = msg;
    const track = state.current;
    if (track && track.provider !== 'local') {
      try {
        const r = await fetch(api.streamUrl(track), { headers: { Range: 'bytes=0-1' } });
        if (!r.ok) {
          const j = await r.json().catch(() => null);
          if (j && j.error) final = j.error;
        }
      } catch (_) {}
    }
    toast(final, 'err', 4200);
    $('#btnPlay').classList.remove('playing');

    // 跨平台热切：另一平台搜到同名歌 → 插队并直接播
    if (track && !fallbackBusy) {
      fallbackBusy = true;
      try {
        const matched = await findCrossPlatformMatch(track);
        if (matched) {
          matched._noFallback = true;   // 只兜一跳，防 A↔B 来回打
          const label = matched.provider === 'netease' ? '网易云' : 'QQ';
          toast(`当前音源受限，已为您自动匹配 ${label} 音乐源`, 'ok', 3600);
          state.queue.splice(state.queueIndex + 1, 0, matched);
          state.queueIndex += 1;
          renderMain();
          playCurrent();
          return;
        }
      } finally {
        fallbackBusy = false;
      }
    }

    if (streamFailStreak < 3 && state.queue.length > 1) {
      streamFailStreak++;
      toast('自动跳到下一首', '', 1600);
      setTimeout(() => nextTrack(true), 800);
    }
  });

  audio.on('playing', () => {
    streamFailStreak = 0;
    setPlayLoading(false);
    // 新歌起播：智能过渡守卫复位（恢复暂停时清掉预载标记也无害，会自动重新预载）
    autoCross.started = false;
    autoCross.abandoned = false;
  });
  audio.on('waiting', () => setPlayLoading(true));
  audio.on('canplay', () => setPlayLoading(false));
}

/* ==================================================================
   UI 事件绑定
   ================================================================== */
function bindUI() {
  /* ---- 播放控制 ---- */
  $('#btnPlay').addEventListener('click', async () => {
    if (!state.current) {
      if (state.queue.length) { playQueue(state.queue, 0); }
      else { setViewMode('browse'); state.drawerTab = 'library'; renderBrowse(); toast('曲库为空，先到设置里添加音乐文件夹吧'); }
      return;
    }
    if (audio.paused) await audio.play();
    else audio.pause();
  });

  $('#btnPrev').addEventListener('click', prevTrack);
  $('#btnNext').addEventListener('click', () => nextTrack(false));

  $('#btnShuffle').addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    $('#btnShuffle').classList.toggle('active', state.shuffle);
    toast(state.shuffle ? '随机播放：开' : '随机播放：关');
  });

  const updateRepeatUI = () => {
    const btn = $('#btnRepeat');
    btn.classList.toggle('active', state.repeat !== 'off');
    btn.classList.toggle('mode-one', state.repeat === 'one');
    btn.title = state.repeat === 'off' ? '顺序播放' : state.repeat === 'all' ? '列表循环' : '单曲循环';
  };
  $('#btnRepeat').addEventListener('click', () => {
    state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
    updateRepeatUI();
    toast(state.repeat === 'off' ? '顺序播放' : state.repeat === 'all' ? '列表循环' : '单曲循环');
  });
  updateRepeatUI();

  /* ---- 进度条 ---- */
  const progressBar = $('#progressBar');
  const seekFromEvent = (e) => {
    const rect = progressBar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const dur = audio.duration;
    if (!dur || !isFinite(dur)) return;
    $('#progFill').style.width = (pct * 100) + '%';
    $('#timeNow').textContent = fmtTime(pct * dur);
  };
  progressBar.addEventListener('pointerdown', (e) => {
    if (!state.current) return;
    state.draggingProgress = true;
    progressBar.setPointerCapture(e.pointerId);
    seekFromEvent(e);
  });
  progressBar.addEventListener('pointermove', (e) => {
    if (state.draggingProgress) seekFromEvent(e);
  });
  progressBar.addEventListener('pointerup', (e) => {
    if (!state.draggingProgress) return;
    state.draggingProgress = false;
    const rect = progressBar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const dur = audio.duration;
    if (dur && isFinite(dur)) {
      seekTo(pct * dur);
      state.lyricIndex = -2; // 强制刷新歌词高亮
    }
  });

  /* ---- 音量 ---- */
  const volBar = $('#volumeBar');
  const volFromEvent = (e) => {
    const rect = volBar.getBoundingClientRect();
    const v = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.setVolume(v);
    audio.setMuted(false);
    $('#volFill').style.width = (v * 100) + '%';
    saveLocalPrefs({ volume: v });
    updateMuteIcon();
  };
  volBar.addEventListener('pointerdown', (e) => {
    state.draggingVolume = true;
    volBar.setPointerCapture(e.pointerId);
    volFromEvent(e);
  });
  volBar.addEventListener('pointermove', (e) => { if (state.draggingVolume) volFromEvent(e); });
  volBar.addEventListener('pointerup', () => { state.draggingVolume = false; });

  $('#btnMute').addEventListener('click', () => {
    audio.setMuted(!audio.muted);
    updateMuteIcon();
  });

  function updateMuteIcon() {
    const muted = audio.muted || audio.volume === 0;
    $('#btnMute').querySelector('.vol-x').style.display = muted ? '' : 'none';
    $('#volFill').style.width = (muted ? 0 : audio.volume * 100) + '%';
  }
  updateMuteIcon();

  /* ---- 光效开关 ---- */
  $('#btnGlow').addEventListener('click', () => {
    const next = !stage.glowEnabled;
    stage.setGlow(next);
    $('#btnGlow').classList.toggle('off', !next);
    $('#setGlow').checked = next;
    saveLocalPrefs({ glow: next });
    toast(next ? '律动光效：开' : '律动光效：关');
  });

  /* ---- 搜索（聚合 = 并发全平台 + 相关度合并；单平台 = 原逻辑） ---- */
  const doSearch = debounce(async (q) => {
    const provider = state.provider;
    if (!q.trim()) {
      state.results = { tracks: [], query: '', provider };
      if (state.viewMode === 'browse' && state.drawerTab === 'results') renderMain();
      return;
    }

    // 聚合：并发请求所有在线平台，allSettled 防单点故障
    if (provider === 'all') {
      setViewMode('browse');
      state.results = { tracks: [], query: q, provider, loading: true };
      renderMain();
      const settled = await Promise.allSettled([
        api.search(q, 'netease', 30),
        api.search(q, 'qq', 30)
      ]);
      let merged = [];
      const errs = [];
      settled.forEach((r, i) => {
        const pf = i === 0 ? 'netease' : 'qq';
        if (r.status === 'fulfilled') merged.push(...(r.value.tracks || []));
        else errs.push(PROVIDER_BADGE[pf] + '：' + (r.reason && r.reason.message || '失败'));
      });
      // 同平台去重 + 四档强制排序（原唱 > 歌手 > 歌名 > 伴奏/翻唱垫底），共用 core/sort.js
      const seen = new Set();
      const dedup = merged.filter(t => {
        const k = t.provider + ':' + (t.gid || t.nid);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      // 先从结果集里推断原唱歌手（翻唱标题常带「原唱：xxx」），再排序
      const sortCtx = buildSortContext(dedup, q);
      merged = dedup.sort((a, b) => mixedSortCompare(a, b, q, sortCtx));
      state.results = { tracks: merged, query: q, provider, errors: errs };
      renderMain();
      return;
    }

    try {
      const data = await api.search(q, provider, 60);
      state.results = { tracks: data.tracks || [], query: q, provider };
      setViewMode('browse');
      renderMain();
    } catch (err) {
      toast(err.message, 'err');
      state.results = { tracks: [], query: q, provider };
      setViewMode('browse');
      renderMain();
    }
  }, 420);

  $('#searchInput').addEventListener('input', (e) => doSearch(e.target.value));
  $('#searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch(e.target.value);
  });

  /* ---- 音源固定为聚合搜索（单搜索栏，无平台切换） ---- */
  state.provider = 'all';

  /* ---- 右栏（队列）呼出/收起 ---- */
  $('#btnPlaylist').addEventListener('click', () => toggleQueueDrawer());
  // 底栏小封面：任何页面点它直接回"正在播放"主页面
  const miniCover = $('#miniCover');
  if (miniCover) {
    miniCover.style.cursor = 'pointer';
    miniCover.title = '返回正在播放';
    miniCover.addEventListener('click', () => setViewMode('play'));
  }
  $('#btnDrawerClose').addEventListener('click', () => closeDrawer());

  // 左侧导航：浏览页项接管主区域；播放队列只呼出右栏
  $$('.side-item[data-tab]').forEach(t => {
    t.addEventListener('click', () => {
      const tab = t.dataset.tab;
      if (tab === 'queue') {
        state.drawerContent = 'queue';
        state.playlistDetail = state.playlistDetail && state.playlistDetail.keepOpen ? state.playlistDetail : state.playlistDetail;
        openDrawer();
      } else {
        state.drawerTab = tab;
        setViewMode('browse');
        renderBrowse();
      }
      $$('.side-item').forEach(x => x.classList.toggle('active', x === t));
    });
  });

  /* ---- 设置弹窗 ---- */
  $('#btnSettings').addEventListener('click', () => openModal());
  $('#btnModalClose').addEventListener('click', closeModal);
  $('#modalMask').addEventListener('click', (e) => { if (e.target === $('#modalMask')) closeModal(); });

  $('#btnSaveSettings').addEventListener('click', saveSettings);
  $('#btnResetAngle').addEventListener('click', () => { stage.resetAngle(); toast('封面角度已重置'); });

  $('#btnAddDir').addEventListener('click', () => openFsPicker(''));
  $('#btnFsClose').addEventListener('click', () => $('#fsMask').classList.remove('show'));
  $('#btnFsUp').addEventListener('click', () => {
    if (state.fsParent) openFsPicker(state.fsParent);
  });
  $('#btnFsPick').addEventListener('click', () => {
    if (!state.fsCurrent) { toast('请先进入一个文件夹'); return; }
    if (!state.pendingDirs.includes(state.fsCurrent)) {
      state.pendingDirs.push(state.fsCurrent);
      renderDirList();
      toast('已添加，记得点击「保存设置」', 'ok');
    } else {
      toast('该文件夹已在列表中');
    }
    $('#fsMask').classList.remove('show');
  });

  // 视觉开关即时生效
  $('#setGlow').addEventListener('change', (e) => {
    stage.setGlow(e.target.checked);
    $('#btnGlow').classList.toggle('off', !e.target.checked);
    saveLocalPrefs({ glow: e.target.checked });
  });
  $('#setParticles').addEventListener('change', (e) => {
    stage.setParticles(e.target.checked);
    saveLocalPrefs({ particles: e.target.checked });
  });
  $('#setAutoRotate').addEventListener('change', (e) => {
    stage.setAutoRotate(e.target.checked);
    saveLocalPrefs({ autoRotate: e.target.checked });
  });
  $('#setPuzzle').addEventListener('change', (e) => {
    stage.setPuzzle(e.target.checked);
    saveLocalPrefs({ puzzle: e.target.checked });
  });

  /* ---- 歌词逐字（即时生效，不用点保存） ---- */
  $('#setCharFx').addEventListener('change', (e) => {
    if (lyricFx) lyricFx.applyPrefs({ charFx: e.target.checked });
    saveLocalPrefs({ charFx: e.target.checked });
  });
  /* ---- 全局校准滑杆（兜底，优先级低于单曲覆盖与高置信自动值） ---- */
  $('#setLyricOffset').addEventListener('input', (e) => {
    saveLocalPrefs({ lyricOffset: Number(e.target.value) || 0 });
    refreshLyricOffset();
  });
  /* ---- 单曲校准覆盖（只影响当前歌） ---- */
  $('#setTrackOffset').addEventListener('input', (e) => {
    const v = Number(e.target.value) || 0;
    $('#trackOffsetVal').textContent = (v > 0 ? '+' : '') + v + 'ms';
    const track = state.current;
    if (!track) return;
    const ov = trackOffsetOverrides();
    ov[AnalysisManager.stableId(track)] = v;
    saveLocalPrefs({ lyricOverrides: ov });
    refreshLyricOffset();
  });
  $('#btnClearTrackOffset').addEventListener('click', () => {
    const track = state.current;
    if (!track) return;
    const ov = trackOffsetOverrides();
    delete ov[AnalysisManager.stableId(track)];
    saveLocalPrefs({ lyricOverrides: ov });
    refreshLyricOffset();
    toast('已清除这首歌的校准覆盖');
  });

  /* ---- 动态队列（心动模式 / 私人漫游）：跨平台混合（网易云 + QQ） ---- */
  // 心动/私人漫游入口统一在左侧导航
  $('#sideHeartMode').addEventListener('click', () => startDynamic('heartmix'));
  $('#sidePersonalFm').addEventListener('click', () => startDynamic('fmix'));

  // 状态灯点击 = 退出当前心动 / 漫游
  const dynChip = $('#dynamicState');
  if (dynChip) dynChip.addEventListener('click', () => exitDynamic());
  updateDynamicBar();   // 初始未拿到登录态时先置灰
  loadLikedKeys();      // 本地红心初始化
  refreshQqLoginState().then(() => updateDynamicBar());
  bindBackgroundSettings();

  // 极简模式：双侧栏全隐，播放条悬浮
  const minimalBtn = document.createElement('button');
  minimalBtn.className = 'side-item';
  minimalBtn.id = 'sideMinimal';
  minimalBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg><span>极简模式</span>';
  $('#sidenav').appendChild(minimalBtn);
  minimalBtn.addEventListener('click', () => {
    document.body.classList.toggle('minimal');
    setViewMode('play');
    toast(document.body.classList.contains('minimal') ? '极简模式：双击封面或按 Esc 退出' : '已退出极简模式');
  });
  const exitMinimal = document.createElement('button');
  exitMinimal.id = 'minimalExit';
  exitMinimal.textContent = '✕ 退出极简';
  exitMinimal.addEventListener('click', () => {
    document.body.classList.remove('minimal');
    toast('已退出极简模式');
  });
  document.body.appendChild(exitMinimal);
  document.addEventListener('dblclick', (e) => {
    if (document.body.classList.contains('minimal') && !e.target.closest('.playerbar')) {
      document.body.classList.remove('minimal');
      toast('已退出极简模式');
    }
  });

  /* ---- 键盘 ---- */
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        $('#btnPlay').click();
        break;
      case 'ArrowRight':
        e.preventDefault();
        seekTo(audio.currentTime + 5);
        state.lyricIndex = -2;
        break;
      case 'ArrowLeft':
        e.preventDefault();
        seekTo(audio.currentTime - 5);
        state.lyricIndex = -2;
        break;
      case 'ArrowUp':
        e.preventDefault();
        audio.setVolume(Math.min(1, audio.volume + 0.05));
        $('#volFill').style.width = (audio.volume * 100) + '%';
        saveLocalPrefs({ volume: audio.volume });
        break;
      case 'ArrowDown':
        e.preventDefault();
        audio.setVolume(Math.max(0, audio.volume - 0.05));
        $('#volFill').style.width = (audio.volume * 100) + '%';
        saveLocalPrefs({ volume: audio.volume });
        break;
      case 'n': case 'N':
        nextTrack(false);
        break;
      case 'p': case 'P':
        prevTrack();
        break;
      case 'Escape':
        if (document.body.classList.contains('minimal')) {
          document.body.classList.remove('minimal');   // 极简模式：Esc 直接退出
          toast('已退出极简模式');
        }
        closeDrawer();
        closeModal();
        $('#fsMask').classList.remove('show');
        break;
    }
  });
}

/* ==================================================================
   抽屉渲染
   ================================================================== */
function openDrawer() {
  $('#drawer').classList.add('show');
  renderDrawer();
}

function closeDrawer() {
  $('#drawer').classList.remove('show');
}

/** 呼出/收起播放队列右栏 */
function toggleQueueDrawer() {
  const dr = $('#drawer');
  if (dr.classList.contains('show') && state.drawerContent === 'queue') closeDrawer();
  else {
    state.drawerContent = 'queue';
    openDrawer();
    $$('.side-item').forEach(x => x.classList.toggle('active', x.dataset.tab === 'queue'));
  }
}

/* ---- 右栏渲染：只装 队列 或 歌单详情 ---- */
function renderDrawer() {
  const body = $('#drawerBody');
  const foot = $('#drawerFoot');
  body.innerHTML = '';

  const renderQueue = () => {
    $('#drawerTitle').textContent = '播放队列';
    if (!state.queue.length) {
      body.appendChild(emptyTip('播放队列是空的', '从搜索或歌单里点一首歌开始播放'));
      foot.textContent = '';
      return;
    }
    const frag = document.createDocumentFragment();
    state.queue.forEach((t, i) => frag.appendChild(trackRow(t, i, i === state.queueIndex, () => {
      state.queueIndex = i;
      playCurrent();
      updatePlayingHighlight();
    })));
    body.appendChild(frag);
    foot.textContent = `队列 ${state.queue.length} 首`;
  };

  if (state.drawerContent === 'pl' && state.playlistDetail) {
    $('#drawerTitle').textContent = state.playlistDetail.name;
    renderPlaylistDetail(body, foot);
  } else {
    renderQueue();
  }
}

/* ---- 浏览页渲染（全宽接管主区域）：搜索 / 本地音乐 / 我的歌单 ---- */
function renderBrowse() {
  const pane = $('#browsePane');
  pane.innerHTML = '';
  // 顶部返回条：浏览页永远有回播放页的出口
  const backBar = el('div', 'browse-back');
  const backBtn = el('button', 'btn ghost sm', '‹ 返回播放页');
  backBtn.addEventListener('click', () => setViewMode('play'));
  backBar.appendChild(backBtn);
  pane.appendChild(backBar);
  const footLike = {
    set textContent(v) { if (v) pane.appendChild(el('div', 'pl-anon', String(v))); },
    appendChild(n) { pane.appendChild(n); }
  };
  const body = pane;
  const foot = footLike;
  const tab = state.drawerTab;

  if (tab === 'results') {
    const { tracks, query, provider } = state.results;
    const head = el('div', 'browse-head', '搜索');
    pane.appendChild(head);
    if (!query) {
      body.appendChild(emptyTip('搜索点什么吧', '在顶部搜索框输入歌名、歌手或专辑'));
      return;
    }
    if (state.results.loading) {
      body.appendChild(emptyTip('正在聚合搜索…', '网易云 + QQ 音乐并发查询'));
      return;
    }
    if (!tracks.length) {
      body.appendChild(emptyTip(`没有找到「${query}」`, provider === 'all'
        ? (state.results.errors && state.results.errors.length ? state.results.errors.join('；') : '两个平台都没有结果')
        : '试试其他关键词'));
      return;
    }
    const frag = document.createDocumentFragment();
    tracks.forEach((t, i) => frag.appendChild(trackRow(t, i, false, () => {
      playQueue(tracks, i);
    })));
    body.appendChild(frag);
    pane.appendChild(el('div', 'browse-foot', (provider === 'all' ? '聚合 · ' : '') + `${tracks.length} 个结果`));
  }

  else if (tab === 'library') {
    const lib = state.library;
    const head = el('div', 'browse-head', '本地音乐');
    pane.appendChild(head);
    if (!lib.tracks.length) {
      body.appendChild(emptyTip('曲库还是空的', '点击右上角设置 → 添加音乐文件夹'));
      return;
    }
    const frag = document.createDocumentFragment();
    lib.tracks.slice(0, 500).forEach((t, i) => {
      const isCur = state.current && state.current.id === t.id && state.current.provider === t.provider;
      frag.appendChild(trackRow(t, i, isCur, () => playQueue(lib.tracks, i)));
    });
    body.appendChild(frag);
    pane.appendChild(el('div', 'browse-foot', lib.tracks.length > 500
      ? `显示前 500 首 / 共 ${lib.tracks.length} 首`
      : `共 ${lib.tracks.length} 首`));
  }

  else if (tab === 'playlists') {
    const head = el('div', 'browse-head', '我的歌单');
    pane.appendChild(head);
    renderPlaylistsView(body, foot);
  }
}

/* ---- 主区域模式切换：播放页(3D) ↔ 浏览页 ---- */
function setViewMode(mode) {
  if (state.viewMode === mode) return;
  state.viewMode = mode;
  const browse = mode === 'browse';
  $('#browsePane').hidden = !browse;
  $('#stagePane').hidden = browse;   // 隐藏/恢复由 ResizeObserver 自动重算 canvas
}

/** 统一重绘：右栏总是重绘；浏览页在浏览模式下重绘 */
function renderMain() {
  renderDrawer();
  if (state.viewMode === 'browse') renderBrowse();
}

/* ==================================================================
   我的歌单：平台分组浏览 → 歌单详情 → 点歌播放
   ================================================================== */

const PLAYLIST_PLATFORMS = [
  { id: 'netease', label: '网易云歌单' },
  { id: 'qq', label: 'QQ 音乐歌单' }
];

/** 拉取两个平台的歌单（force=true 绕过缓存） */
async function loadPlaylists(force = false) {
  const cacheAge = state.playlists ? Date.now() - state.playlists.fetchedAt : Infinity;
  if (!force && state.playlists && cacheAge < 60 * 1000) return state.playlists;

  const results = await Promise.allSettled(PLAYLIST_PLATFORMS.map(p => api.playlists(p.id)));
  const out = { fetchedAt: Date.now() };
  PLAYLIST_PLATFORMS.forEach((p, i) => {
    const r = results[i];
    out[p.id] = r.status === 'fulfilled'
      ? { list: r.value.playlists || [], err: '' }
      : { list: [], err: r.reason && r.reason.message || '获取失败' };
  });
  state.playlists = out;
  return out;
}

function renderPlaylistsView(body, foot) {
  // 详情视图：某个歌单内的歌曲
  if (state.playlistDetail) {
    renderPlaylistDetail(body, foot);
    return;
  }

  const back = el('div', 'pl-toolbar');
  const refresh = el('button', 'btn ghost sm', '⟳ 刷新歌单');
  refresh.addEventListener('click', () => refreshPlaylists());
  back.appendChild(refresh);
  back.appendChild(el('span', 'pl-hint', '本地歌单混合存储双平台歌曲 · 平台歌单在下方'));
  body.appendChild(back);

  // ---- 本地独立歌单（我喜欢 + 自建），混存双平台歌曲 ----
  const localGroup = el('div', 'pl-group');
  const localHead = el('div', 'pl-group-head');
  localHead.appendChild(el('span', '', '我的歌单 · 本地'));
  const plus = el('button', 'pl-create-btn', '＋ 新建歌单');
  plus.addEventListener('click', () => createLocalPlaylistInline(localGroup));
  localHead.appendChild(plus);
  localGroup.appendChild(localHead);

  if (!state.localPlaylists) {
    localGroup.appendChild(el('div', 'pl-anon', '加载中…'));
    body.appendChild(localGroup);
    fetch('/api/local-playlists').then(r => r.json()).then(r => {
      state.localPlaylists = r.playlists || [];
      if (state.drawerTab === 'playlists' && !state.playlistDetail) renderMain();
    }).catch(() => { state.localPlaylists = []; });
  } else {
    state.localPlaylists.forEach(p => {
      localGroup.appendChild(localPlaylistCard(p));
    });
  }
  body.appendChild(localGroup);

  // ---- 平台歌单（网易云 / QQ，保留浏览与刷新） ----
  if (!state.playlists) {
    const g = el('div', 'pl-group');
    g.appendChild(el('div', 'pl-anon', '平台歌单加载中…'));
    body.appendChild(g);
    loadPlaylists().then(() => { if (state.drawerTab === 'playlists' && !state.playlistDetail) renderMain(); });
    return;
  }

  let rendered = 0;
  for (const pf of PLAYLIST_PLATFORMS) {
    const data = state.playlists[pf.id] || { list: [], err: '' };
    const group = el('div', 'pl-group');
    const head = el('div', 'pl-group-head');
    head.appendChild(el('span', '', pf.label + '（平台）'));
    const plus = el('button', 'pl-create-btn', '＋ 新建');
    plus.addEventListener('click', () => createPlaylistInline(group, pf.id));
    head.appendChild(plus);
    group.appendChild(head);

    if (data.err) {
      const anon = /未登录/.test(data.err);
      group.appendChild(el('div', 'pl-anon', anon ? '登录后可用 · 到设置里扫码' : data.err));
      body.appendChild(group);
      continue;
    }

    const list = [...data.list].sort((a, b) =>
      (b.special === 'like') - (a.special === 'like') || (b.count || 0) - (a.count || 0));

    if (!list.length) {
      group.appendChild(el('div', 'pl-anon', '暂无歌单'));
      body.appendChild(group);
      continue;
    }

    list.forEach(p => {
      group.appendChild(platformPlaylistCard(pf.id, p));
      rendered++;
    });
    body.appendChild(group);
  }

  foot.textContent = `本地 ${state.localPlaylists ? state.localPlaylists.length : 0} 个 · 平台 ${rendered} 个`;
}

/** 本地歌单卡片（大热区 + 混合存储标识 + 删除） */
function localPlaylistCard(p) {
  const card = el('div', 'pl-card local');
  const cover = el('div', 'pl-cover');
  const firstCover = (p.covers || [])[0];
  if (firstCover) cover.style.backgroundImage = `url("${firstCover}")`;
  else cover.innerHTML = p.system ? '❤' : '♫';
  card.appendChild(cover);
  const info = el('div', 'pl-info');
  const name = el('div', 'pl-name', (p.system ? '❤ ' : '') + p.name);
  name.title = p.name;
  info.appendChild(name);
  info.appendChild(el('div', 'pl-count', `${p.count} 首 · 本地混合`));
  card.appendChild(info);
  if (!p.system) {
    const del = el('button', 'pl-del', '✕');
    del.title = '删除歌单';
    del.addEventListener('click', async e => {
      e.stopPropagation();
      const r = await fetch('/api/local-playlists', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id: p.id })
      }).then(x => x.json());
      if (r.ok) { toast('已删除「' + p.name + '」'); state.localPlaylists = null; renderMain(); }
      else toast(r.error || '删除失败', 'err');
    });
    card.appendChild(del);
  }
  const arrow = el('div', 'pl-arrow', '›');
  card.appendChild(arrow);
  card.addEventListener('click', () => openPlaylistDetail(p.id, p, 'local'));
  return card;
}

/** 平台歌单卡片 */
function platformPlaylistCard(platform, p) {
  const card = el('div', 'pl-card');
  const cover = el('div', 'pl-cover');
  if (p.cover) cover.style.backgroundImage = `url("${p.cover}")`;
  else cover.innerHTML = '♫';
  card.appendChild(cover);
  const info = el('div', 'pl-info');
  const name = el('div', 'pl-name', (p.special === 'like' ? '❤ ' : '') + p.name);
  name.title = p.name;
  info.appendChild(name);
  info.appendChild(el('div', 'pl-count', `${p.count || 0} 首`));
  card.appendChild(info);
  const arrow = el('div', 'pl-arrow', '›');
  card.appendChild(arrow);
  card.addEventListener('click', () => openPlaylistDetail(platform, p));
  return card;
}

/** 本地新建歌单（内联输入，存我们软件自己的 JSON） */
function createLocalPlaylistInline(group) {
  if (group.querySelector('.pl-create-row')) return;
  const row = el('div', 'pl-create-row');
  const input = el('input', 'pl-create-input');
  input.placeholder = '歌单名称（最长40字）';
  input.maxLength = 40;
  const ok = el('button', 'btn primary sm', '创建');
  const cancel = el('button', 'btn ghost sm', '取消');
  row.appendChild(input);
  row.appendChild(ok);
  row.appendChild(cancel);
  group.appendChild(row);

  const submit = async () => {
    const name = input.value.trim();
    if (!name) { toast('先起个歌单名吧'); return; }
    ok.disabled = true;
    try {
      await fetch('/api/local-playlists', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', name })
      });
      toast(`已创建本地歌单「${name}」`, 'ok');
      state.localPlaylists = null;
      renderMain();
    } catch (err) {
      toast('创建失败：' + err.message, 'err');
    }
  };
  ok.addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  cancel.addEventListener('click', () => row.remove());
  input.focus();
}
/** 强制刷新：绕过缓存重新请求；没有新歌单时给同步延迟提示 */
async function refreshPlaylists() {
  const before = state.playlists
    ? PLAYLIST_PLATFORMS.map(p => (state.playlists[p.id].list || []).map(x => x.id + ':' + x.count).join(','))
    : null;
  state.playlists = null;
  state.playlistDetail = null;
  renderMain();
  await loadPlaylists(true);
  if (state.drawerTab === 'playlists') renderMain();

  const after = PLAYLIST_PLATFORMS.map(p => (state.playlists[p.id].list || []).map(x => x.id + ':' + x.count).join(','));
  if (before !== null && before.join('|') === after.join('|')) {
    toast('若新建歌单未出现，可能是官方接口同步延迟', '', 3600);
  } else {
    toast('歌单已刷新', 'ok');
  }
}

/** 平台内新建歌单：内联输入框 → POST /api/playlist/create → 自动刷新 */
function createPlaylistInline(group, platform) {
  if (group.querySelector('.pl-create-row')) return;
  const row = el('div', 'pl-create-row');
  const input = el('input', 'pl-create-input');
  input.placeholder = '歌单名称（最长40字）';
  input.maxLength = 40;
  const ok = el('button', 'btn primary sm', '创建');
  const cancel = el('button', 'btn ghost sm', '取消');
  row.appendChild(input);
  row.appendChild(ok);
  row.appendChild(cancel);
  group.insertBefore(row, group.querySelector('.pl-card, .pl-anon') || null);

  const submit = async () => {
    const name = input.value.trim();
    if (!name) { toast('先起个歌单名吧'); return; }
    ok.disabled = true;
    try {
      const r = await fetch('/api/playlist/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, name })
      }).then(x => x.json());
      toast(`已创建「${name}」`, 'ok');
      state.playlists = null;
      state.playlistDetail = null;
      renderMain();
      if (r && r.err) toast('若新歌单未出现，可能是官方接口同步延迟', '', 3600);
    } catch (err) {
      const j = err; toast('创建失败：' + (j.message || err.message), 'err', 3600);
    }
  };
  ok.addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  cancel.addEventListener('click', () => row.remove());
  input.focus();
}

/** 进入歌单详情 */
async function openPlaylistDetail(platform, pl, kind) {
  // 本地独立歌单：全量读自己的 JSON
  if (kind === 'local') {
    state.playlistDetail = {
      kind: 'local', id: pl.id, name: pl.name, system: !!pl.system,
      tracks: [], total: pl.count || 0, offset: 0, hasMore: false, loading: true
    };
    state.drawerContent = 'pl';
    openDrawer();
    renderMain();
    try {
      const r = await fetch('/api/local-playlists/tracks?id=' + encodeURIComponent(pl.id)).then(x => x.json());
      state.playlistDetail.tracks = r.tracks || [];
      state.playlistDetail.total = state.playlistDetail.tracks.length;
    } catch (err) {
      toast('歌单加载失败：' + err.message, 'err');
    }
    state.playlistDetail.loading = false;
    if (state.drawerTab === 'playlists') renderMain();
    return;
  }
  state.playlistDetail = {
    kind: 'platform', platform, id: pl.id, name: pl.name,
    tracks: [], total: pl.count || null, offset: 0, hasMore: true, loading: false
  };
  state.drawerContent = 'pl';
  openDrawer();
  renderMain();
  await loadMorePlaylistTracks();
}

async function loadMorePlaylistTracks() {
  const d = state.playlistDetail;
  if (!d || d.loading || !d.hasMore || d.kind === 'local') return;
  d.loading = true;
  try {
    const res = await fetch(`/api/playlist/tracks?platform=${encodeURIComponent(d.platform)}&id=${encodeURIComponent(d.id)}&offset=${d.offset}&limit=50`)
      .then(x => x.json());
    d.tracks.push(...(res.tracks || []));
    d.offset += (res.tracks || []).length;
    d.total = res.total !== null && res.total !== undefined ? res.total : d.total;
    d.hasMore = !!res.hasMore;
  } catch (err) {
    toast('歌单加载失败：' + err.message, 'err');
    d.hasMore = false;
  } finally {
    d.loading = false;
    if (state.drawerTab === 'playlists') renderMain();
  }
}

function renderPlaylistDetail(body, foot) {
  const d = state.playlistDetail;

  const head = el('div', 'pl-toolbar');
  const back = el('button', 'btn ghost sm', '‹ 返回歌单');
  back.addEventListener('click', () => { state.playlistDetail = null; renderMain(); });
  head.appendChild(back);
  head.appendChild(el('span', 'pl-hint', d.name));
  body.appendChild(head);

  if (!d.tracks.length && d.loading) {
    body.appendChild(emptyTip('正在加载歌曲…', ''));
    return;
  }
  if (!d.tracks.length && !d.hasMore) {
    body.appendChild(emptyTip('这里还很安静', '去添加一首喜欢的歌吧'));
    foot.textContent = '';
    return;
  }

  const frag = document.createDocumentFragment();
  const playAll = el('button', 'btn ghost sm', '▶ 播放全部');
  playAll.addEventListener('click', () => playQueue(d.tracks, 0));
  frag.appendChild(playAll);

  d.tracks.forEach((t, i) => {
    const isCur = state.current && state.current.id === t.id && state.current.provider === t.provider;
    const row = trackRow(t, i, isCur, () => playQueue(d.tracks, i));
    // 本地歌单：每行加"移出"按钮
    if (d.kind === 'local') {
      const rm = el('button', 'trk-op', '✕');
      rm.title = '移出歌单';
      rm.addEventListener('click', async e => {
        e.stopPropagation();
        const r = await fetch('/api/local-playlists', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'remove-track', id: d.id, track: t })
        }).then(x => x.json());
        if (r.ok) {
          d.tracks.splice(i, 1);
          d.total = d.tracks.length;
          state.localPlaylists = null;
          renderMain();
        } else toast(r.error || '移出失败', 'err');
      });
      const ops = row.querySelector('.trk-ops');
      if (ops) ops.appendChild(rm); else row.appendChild(rm);
    }
    frag.appendChild(row);
  });
  body.appendChild(frag);

  if (d.loading) body.appendChild(el('div', 'pl-anon', '加载中…'));
  else if (d.hasMore) {
    const more = el('button', 'btn ghost sm pl-more', '加载更多');
    more.addEventListener('click', () => loadMorePlaylistTracks());
    body.appendChild(more);
  }

  foot.textContent = d.total !== null ? `${Math.min(d.offset, d.total)} / ${d.total} 首` : `已加载 ${d.tracks.length} 首`;
}

/* ---- 通用操作：喜欢（本地红心）/ 添加到本地歌单 ---- */
const likedSet = new Set();   // provider--gid → 本地红心
let likedLoaded = false;
const PROVIDER_BADGE = { netease: '网易云', qq: 'QQ', local: '本地' };

function trackKeyOf(t) { return t.provider + '--' + (t.gid || t.nid || t.id); }

async function loadLikedKeys() {
  if (likedLoaded) return;
  try {
    const r = await fetch('/api/local-playlists').then(x => x.json());
    (r.likedKeys || []).forEach(k => likedSet.add(k));
    likedLoaded = true;
  } catch (_) {}
}

function likeTrackUI(track, btn) {
  if (track.provider === 'local') { toast('本地文件无需收藏'); return; }
  const key = trackKeyOf(track);
  const next = !likedSet.has(key);
  likedSet[next ? 'add' : 'delete'](key);
  btn.classList.toggle('on', next);
  btn.textContent = next ? '♥' : '♡';
  fetch('/api/local-playlists', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'like', track, like: next })
  }).then(async r => {
    if (!r.ok) {
      const j = await r.json().catch(() => null);
      throw new Error((j && j.error) || '收藏失败');
    }
    toast(next ? '已加入本地「我喜欢」' : '已移出「我喜欢」', 'ok', 1800);
  }).catch(err => {
    likedSet[next ? 'delete' : 'add'](key);
    btn.classList.toggle('on', !next);
    btn.textContent = next ? '♡' : '♥';
    toast(err.message, 'err');
  });
}

/** 「添加到」菜单：加入队列 / 收藏到本地独立歌单（混合存储，双平台歌曲都能进） */
function showAddToMenu(track, anchorBtn) {
  const mask = document.createElement('div');
  mask.className = 'mini-menu-mask';
  const menu = document.createElement('div');
  menu.className = 'mini-menu';
  menu.innerHTML = `<div class="mini-menu-title">添加到我的歌单（本地）</div>`;
  const addOpt = (label, fn, cls = '') => {
    const it = document.createElement('div');
    it.className = 'mini-menu-item ' + cls;
    it.textContent = label;
    it.addEventListener('click', () => { fn(); mask.remove(); });
    menu.appendChild(it);
  };

  // a. 加入当前播放队列（插到当前歌后面）
  addOpt('▶ 加入当前播放队列', () => {
    if (!state.queue.length) { playQueue([track], 0); return; }
    state.queue.splice(state.queueIndex + 1, 0, track);
    renderMain();
    toast('已加入队列下一首', 'ok', 1600);
  });

  // b. 收藏到本地独立歌单（混合存储：双平台歌曲都能进）
  const sep = document.createElement('div');
  sep.className = 'mini-menu-sep';
  menu.appendChild(sep);
  const sub = document.createElement('div');
  sub.className = 'mini-menu-item loading';
  sub.textContent = '正在获取本地歌单…';
  menu.appendChild(sub);
  mask.appendChild(menu);
  document.body.appendChild(mask);
  mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });

  fetch('/api/local-playlists').then(r => r.json()).then(r => {
    sub.remove();
    const lists = (r.playlists || []);
    if (!lists.length) { addOpt('（先去「我的歌单」新建一个）', () => {}); return; }
    lists.forEach(p => {
      addOpt('♫ ' + (p.system ? '❤ ' : '') + p.name + `（${p.count}首）`, async () => {
        try {
          const res = await fetch('/api/local-playlists', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'add-track', id: p.id, track })
          }).then(x => x.json());
          if (res.dup) { toast('这首已经在歌单里啦'); return; }
          toast('已添加到「' + p.name + '」', 'ok');
        } catch (err) {
          toast('添加失败：' + err.message, 'err');
        }
      });
    });
  }).catch(() => { sub.textContent = '本地歌单获取失败'; });
}

/** 聚合搜索相关度：标题/歌手命中权重 */
function trackRow(track, index, playing, onClick) {
  const row = el('div', 'trk' + (playing ? ' playing' : ''));
  const idx = el('div', 'trk-idx', String(index + 1).padStart(2, '0'));
  const main = el('div', 'trk-main');
  const title = el('div', 'trk-title', track.title || '未知曲目');
  const sub = el('div', 'trk-sub', [track.artist, track.album].filter(Boolean).join(' · ') || '未知艺术家');
  main.appendChild(title);
  main.appendChild(sub);

  const tags = el('div', 'trk-tags');
  if (track.hasLyric || track.provider === 'netease') tags.appendChild(el('i', 'ly', '词'));
  if (track.hasCover || track.picUrl) tags.appendChild(el('i', 'cv', '图'));

  // 来源徽章（聚合搜索时区分平台）
  if (track.provider && track.provider !== 'local') {
    tags.appendChild(el('i', 'src-badge src-' + track.provider, PROVIDER_BADGE[track.provider] || track.provider));
  }

  // 喜欢 / 添加到
  if (track.provider && track.provider !== 'local') {
    const ops = el('div', 'trk-ops');
    const like = el('button', 'trk-op like' + (likedSet.has(trackKeyOf(track)) ? ' on' : ''), likedSet.has(trackKeyOf(track)) ? '♥' : '♡');
    like.title = '喜欢';
    like.addEventListener('click', e => { e.stopPropagation(); likeTrackUI(track, like); });
    const add = el('button', 'trk-op add', '＋');
    add.title = '添加到';
    add.addEventListener('click', e => { e.stopPropagation(); showAddToMenu(track, add); });
    ops.appendChild(like);
    ops.appendChild(add);
    row.appendChild(ops);
  }

  row.appendChild(idx);
  row.appendChild(main);
  row.appendChild(tags);
  row.addEventListener('click', onClick);
  return row;
}

function emptyTip(title, sub) {
  const d = el('div', 'empty-tip');
  d.innerHTML = `<b>${escapeHtml(title)}</b>${escapeHtml(sub)}`;
  return d;
}

function updatePlayingHighlight() {
  const body = $('#drawerBody');
  Array.from(body.children).forEach((row, i) => {
    if (!row.classList.contains('trk')) return;
    const on = i === state.queueIndex && state.drawerTab === 'queue';
    row.classList.toggle('playing', on);
  });
}

/* ==================================================================
   账号与平台面板（卡片式：网易云 / QQ / 酷狗[维护中]）
   ================================================================== */
const ACCOUNT_PLATFORMS = [
  { id: 'netease', name: '网易云音乐', qr: true },
  { id: 'qq', name: 'QQ 音乐', qr: true },
  { id: 'kugou', name: '酷狗音乐', qr: false, maintenance: true }
];

async function renderAccountCards() {
  const wrap = $('#accountCards');
  if (!wrap) return;
  wrap.innerHTML = '';

  for (const pf of ACCOUNT_PLATFORMS) {
    const card = el('div', 'acct-card' + (pf.maintenance ? ' maintenance' : ''));
    const avatar = el('div', 'acct-avatar');
    const info = el('div', 'acct-info');
    const name = el('b', '', pf.name);
    const desc = el('small', '', '');
    info.appendChild(name);
    info.appendChild(desc);

    if (pf.maintenance) {
      desc.textContent = '维护中 · 暂不可用（无稳定的直连方案，不硬凑第三方代理）';
      card.appendChild(avatar);
      card.appendChild(info);
      wrap.appendChild(card);
      continue;
    }

    let st = null;
    try { st = await api.accountStatus(pf.id); } catch (_) {}
    const loggedIn = !!(st && st.loggedIn);

    if (loggedIn && st.user && st.user.avatarUrl) {
      avatar.style.backgroundImage = `url("${st.user.avatarUrl}")`;
      avatar.innerHTML = '';
    }
    if (loggedIn) {
      desc.textContent = (st.user && st.user.nickname) ? '已登录' + (st.user.vipType ? ' · VIP' : '') : '已登录';
    } else {
      desc.textContent = (st && st.reason) ? '凭证已失效，请重新扫码' : '未登录 · 扫码后可用歌单与收藏';
    }

    const btn = el('button', 'btn sm ' + (loggedIn ? 'ghost' : 'primary'), loggedIn ? '退出登录' : '扫码登录');
    btn.addEventListener('click', async () => {
      if (loggedIn) {
        try {
          await api.accountLogout(pf.id);
          toast(pf.name + '已退出登录');
          renderAccountCards();
          if (pf.id === 'netease') checkNetease();
          if (state.playlists) state.playlists = null;   // 歌单缓存失效
          if (state.drawerTab === 'playlists') renderMain();
        } catch (err) {
          toast('退出失败：' + err.message, 'err');
        }
      } else if (pf.qr) {
        login.openQr(pf.id);
      }
    });

    card.appendChild(avatar);
    card.appendChild(info);
    card.appendChild(btn);
    wrap.appendChild(card);
  }
}

/* ==================================================================
   自定义背景（图片 + 40% 黑色遮罩）
   ================================================================== */
function applyUserBg() {
  fetch('/api/background').then(r => {
    if (!r.ok) throw new Error('none');
    return r.blob();
  }).then(blob => {
    const url = URL.createObjectURL(blob);
    let div = document.getElementById('userBg');
    if (!div) {
      div = document.createElement('div');
      div.id = 'userBg';
      document.body.insertBefore(div, document.body.firstChild);
    }
    div.style.backgroundImage = `url("${url}")`;
    document.body.classList.add('has-user-bg');
    const st = $('#bgState');
    if (st) st.textContent = '已启用';
  }).catch(() => {
    document.body.classList.remove('has-user-bg');
    const st = $('#bgState');
    if (st) st.textContent = '';
  });
}

function bindBackgroundSettings() {
  const file = $('#setBgFile');
  const clear = $('#btnBgClear');
  if (!file) return;
  file.addEventListener('change', () => {
    const f = file.files && file.files[0];
    if (!f) return;
    if (f.size > 25 * 1024 * 1024) { toast('图片超过 25MB，请压缩后重试', 'err'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const r = await fetch('/api/background', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: reader.result })
        });
        if (!r.ok) { const j = await r.json().catch(() => null); throw new Error((j && j.error) || '上传失败'); }
        applyUserBg();
        toast('背景已更新（已自动叠加暗色遮罩）', 'ok');
      } catch (err) {
        toast(err.message, 'err');
      }
      file.value = '';
    };
    reader.readAsDataURL(f);
  });
  clear.addEventListener('click', async () => {
    await fetch('/api/background', { method: 'DELETE' }).catch(() => {});
    document.body.classList.remove('has-user-bg');
    const st = $('#bgState');
    if (st) st.textContent = '';
    toast('已移除自定义背景');
  });
  applyUserBg();
}

/* ==================================================================
   设置弹窗
   ================================================================== */
async function openModal() {
  $('#modalMask').classList.add('show');
  state.pendingDirs = (state.settings.musicDirs || []).slice();
  renderDirList();
  checkNetease();
  renderAccountCards();
}

function closeModal() {
  $('#modalMask').classList.remove('show');
}

function renderDirList() {
  const list = $('#dirList');
  list.innerHTML = '';
  if (!state.pendingDirs.length) {
    list.appendChild(el('div', 'empty-tip', '还没有添加文件夹'));
    return;
  }
  state.pendingDirs.forEach((dir, i) => {
    const item = el('div', 'dir-item');
    item.appendChild(el('span', 'p', dir));
    const btn = el('button');
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
    btn.title = '移除';
    btn.addEventListener('click', () => {
      state.pendingDirs.splice(i, 1);
      renderDirList();
    });
    item.appendChild(btn);
    list.appendChild(item);
  });
}

async function saveSettings() {
  const patch = {
    musicDirs: state.pendingDirs,
    neteaseBaseUrl: $('#setNeteaseUrl').value.trim(),
    neteaseCookie: $('#setNeteaseCookie').value.trim(),
    neteaseLevel: $('#setNeteaseLevel').value
  };
  try {
    const res = await api.saveSettings(patch);
    state.settings = res.settings;
    toast('设置已保存', 'ok');
    closeModal();
    await loadLibrary(true);
    if (patch.neteaseBaseUrl) checkNetease();
  } catch (err) {
    toast('保存失败：' + err.message, 'err');
  }
}

let _neteaseRetryTimer = null;
let _dynamicRestored = false;

async function checkNetease() {
  const box = $('#netStatus');
  box.className = 'net-status';
  box.textContent = '正在检测…';
  try {
    const st = await api.neteaseStatus();
    state.neteaseStatus = st;
    if (_neteaseRetryTimer) { clearTimeout(_neteaseRetryTimer); _neteaseRetryTimer = null; }

    if (!st.ok) {
      box.className = 'net-status err';
      box.textContent = '音源服务未就绪：' + (st.reason || '请检查内置服务或填写 API 地址');
      // 账号卡片由 renderAccountCards 刷新
      return;
    }

    const svc = st.service || {};
    const isBuiltin = !state.settings?.neteaseBaseUrl;
    const where = isBuiltin
      ? `内置音源服务 · 端口 ${svc.port || '—'}`
      : `自定义 API · ${(state.settings?.neteaseBaseUrl || '').replace(/^https?:\/\//, '')}`;

    if (st.loggedIn) {
      box.className = 'net-status ok';
      box.textContent = `${where} · 已登录：${st.nickname || st.userId}${st.vipType ? ' · VIP' : ''}`;
    } else {
      box.className = 'net-status ok';
      box.textContent = `${where} · 未登录（游客模式下部分歌曲无法播放）`;
    }
  } catch (err) {
    // 启动早期服务可能还没就绪：落状态 + 定时重试，别让入口永久置灰
    state.neteaseStatus = { ok: false, loggedIn: false };
    box.className = 'net-status err';
    box.textContent = '检测失败：' + err.message + '（5 秒后重试）';
    // 账号卡片由 renderAccountCards 刷新
    if (_neteaseRetryTimer) clearTimeout(_neteaseRetryTimer);
    _neteaseRetryTimer = setTimeout(() => { checkNetease(); }, 5000);
  }
  updateDynamicBar();   // 登录态变化联动心动模式/私人漫游入口
  // 登录态就绪后恢复上次的动态队列上下文（重启续用，只做一次）
  if (!_dynamicRestored && state.neteaseStatus && state.neteaseStatus.loggedIn) {
    _dynamicRestored = true;
    restoreDynamicSession();
  }
}

/* ==================================================================
   文件夹选择器
   ================================================================== */
async function openFsPicker(path) {
  $('#fsMask').classList.add('show');
  const body = $('#fsBody');
  const pathEl = $('#fsPath');
  body.innerHTML = '<div class="empty-tip">加载中…</div>';

  try {
    const data = await api.listDir(path);
    state.fsCurrent = data.path || '';
    state.fsParent = data.parent;
    pathEl.textContent = data.path || '选择磁盘或位置';

    body.innerHTML = '';

    if (data.drives && data.drives.length) {
      body.appendChild(el('div', 'fs-section-label', '磁盘'));
      data.drives.forEach(d => body.appendChild(fsItem(d.name, d.isDrive, 0, () => openFsPicker(d.path))));
    }
    if (data.quick && data.quick.length) {
      body.appendChild(el('div', 'fs-section-label', '常用位置'));
      data.quick.forEach(d => body.appendChild(fsItem(d.name, false, 0, () => openFsPicker(d.path), true)));
    }
    if (data.entries && data.entries.length) {
      body.appendChild(el('div', 'fs-section-label', '文件夹'));
      data.entries.forEach(e => body.appendChild(
        fsItem(e.name, false, e.audioCount, () => openFsPicker(e.path))
      ));
    }
    if (data.path && (!data.entries || !data.entries.length)) {
      body.appendChild(el('div', 'empty-tip', '这个文件夹下没有子文件夹'));
    }
  } catch (err) {
    body.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
  }
}

function fsItem(name, isDrive, audioCount, onClick, isQuick) {
  const item = el('div', 'fs-item' + (isDrive ? ' drive' : ''));
  const icon = isDrive
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="17" cy="12" r="1.2" fill="currentColor"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
  item.innerHTML = `${icon}<span class="n">${escapeHtml(name)}</span>${audioCount ? `<span class="c">${audioCount} 首</span>` : (isQuick ? '<span class="c">快捷</span>' : '')}`;
  item.addEventListener('click', onClick);
  return item;
}

/* ==================================================================
   启动
   ================================================================== */
init().catch(err => {
  console.error(err);
  toast('初始化失败：' + err.message, 'err', 8000);
});
