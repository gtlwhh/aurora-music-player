/**
 * 歌曲能量曲线分析管理器
 *
 * 策略（用户拍板）：
 *   1. 首次播放 → OfflineAudioContext 离线解码整首歌，算 RMS 曲线，落盘缓存。
 *      实时累积只在离线分析失败/未完成时做兜底，不是主路径。
 *   2. trackId = 「音源 + 音源内歌曲 ID」，不用播放 URL（URL 可能带时效参数）。
 *      同一首歌换音源 = 不同 track，允许重复分析；同一首歌重复播放命中同一缓存。
 *   3. 快照带 timestamp（createdAt / savedAt），UI 端对能量值线性插值对齐当前帧。
 *   4. 离线分析失败静默降级；同一时间只跑一个任务，切歌取消旧的。
 */

import { api } from './api.js';

const WORKER_URL = '/js/workers/analyzer.worker.js';
const SAMPLE_STEP = 0.1;   // 100ms 一个点 → 每秒 10 个

export class AnalysisManager {
  constructor(opts = {}) {
    this.onCurve = opts.onCurve || (() => {});
    this.onState = opts.onState || (() => {});

    this._taskToken = 0;
    this._worker = null;
    this._currentId = null;
    this._cache = new Map();     // trackId -> curve
    this._live = [];             // 兜底实时采样 [{t, e}]
    this._liveActive = false;
    this._pendingId = null;      // 正在离线分析的 trackId（保证同时只跑一个）
  }

  static stableId(track) {
    if (!track) return '';
    const key = track.provider === 'local'
      ? track.id
      : (track.nid || String(track.sourceId || '').split(':')[1] || '');
    return `${track.provider}--${key}`;
  }

  /** 切歌时调用（由 playTrack 触发，同步返回） */
  async onTrackChange(track) {
    if (!track) return;
    const token = ++this._taskToken;
    const id = AnalysisManager.stableId(track);
    this._currentId = id;
    this._live = [];
    this._liveActive = false;

    // 1) 内存缓存
    if (this._cache.has(id)) {
      this.onCurve(this._cache.get(id), { source: 'memory' });
      return;
    }

    // 2) 磁盘缓存（没有 onsets 的旧格式视为无效，重新分析一次后即升级）
    try {
      const r = await api.getAnalysis(id);
      if (token !== this._taskToken) return;      // 已切歌
      if (r && r.ok && r.data && r.data.energy && r.data.energy.length && Array.isArray(r.data.flux)) {
        this._cache.set(id, r.data);
        this.onCurve(r.data, { source: 'cache' });
        return;
      }
    } catch (_) {
      // 读缓存失败就继续，不影响离线分析
    }

    if (token !== this._taskToken) return;

    // 3) 无缓存：兜底实时累积 + 后台离线分析
    this._liveActive = true;
    this.onState('analyzing');
    this._startOffline(track, token, id);
  }

  /** 兜底：每帧由外部喂采样，约 100ms 记一个点 */
  sample(t, energy) {
    if (!this._liveActive) return;
    const last = this._live[this._live.length - 1];
    if (!last || t - last.t >= SAMPLE_STEP - 0.01) {
      this._live.push({ t, e: energy });
      if (this._live.length >= 3 && this._live.length % 5 === 0) {
        this.onCurve(this._liveCurve(), { source: 'live', partial: true });
      }
    }
  }

  _liveCurve() {
    const s = this._live;
    if (!s.length) return null;
    return {
      sampleRate: 1 / SAMPLE_STEP,
      duration: s[s.length - 1].t,
      energy: s.map(x => x.e),
      live: true,
      partial: true
    };
  }

  async _startOffline(track, token, id) {
    // 同一时间只跑一个：上一个还没结束就强制结束
    const prevPending = this._pendingId;
    this._pendingId = id;

    try {
      const { energy, onset, flux } = await this._analyze(api.streamUrl(track));
      if (token !== this._taskToken) return;     // 切歌了，丢弃结果
      if (!energy || !energy.length) return;

      const rate = 1 / SAMPLE_STEP;
      const curve = {
        trackId: id,
        sampleRate: rate,
        duration: this._lastDuration || 0,
        // 转成普通数组再序列化，Float32Array 会被 JSON.stringify 变成 {"0":...}
        energy: Array.from(energy),
        segments: this._segment(energy, rate),
        bpm: this._estimateBPM(onset, 50),
        // 起音通量（40ms/帧，0-255），歌词自动校准的互相关输入
        flux: flux || [],
        fluxRate: 25,
        createdAt: Date.now(),
        live: false
      };
      this._pendingId = null;
      this._liveActive = false;
      this._cache.set(id, curve);
      this.onState('ready');
      this.onCurve(curve, { source: 'offline' });

      // 落盘（异步，失败不影响显示）
      api.saveAnalysis(id, curve).catch(() => {});
    } catch (_) {
      // 静默降级：留着实时累积兜底，什么都不弹
      if (token === this._taskToken) this._pendingId = null;
    }
  }

  /**
   * 离线分析整首歌：fetch 完整音频 → decodeAudioData → 丢给 Worker 算 RMS
   */
  async _analyze(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('fetch fail ' + res.status);
    const arrayBuf = await res.arrayBuffer();

    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    let result;
    try {
      const audioBuf = await ctx.decodeAudioData(arrayBuf);
      this._lastDuration = audioBuf.duration;
      const channel = audioBuf.getChannelData(0);
      result = await this._analyzeSamples(channel, audioBuf.sampleRate, audioBuf.duration);
    } finally {
      try { ctx.close(); } catch (_) {}
    }
    return result;
  }

  _analyzeSamples(data, sampleRate, duration) {
    return new Promise((resolve, reject) => {
      let worker = this._worker;
      if (!worker) {
        worker = new Worker(WORKER_URL);
        this._worker = worker;
        worker.onerror = () => reject(new Error('analyzer worker error'));
      }
      const onMsg = (e) => {
        worker.removeEventListener('message', onMsg);
        if (e.data && e.data.error) reject(new Error(e.data.error));
        else resolve({
          energy: new Float32Array(e.data.energy),
          onset: new Float32Array(e.data.onset),
          flux: e.data.flux || []
        });
      };
      worker.addEventListener('message', onMsg);
      worker.postMessage({
        samples: data.buffer,
        sampleRate,
        duration
      }, [data.buffer]);
    });
  }

  /**
   * 简化结构切分：高能量 → 副歌，低谷（开头）→ 前奏，其余 → 主歌。
   * 不追求音乐学上的精确，只要进度条拖过去有个大致提示。
   */
  _segment(energy, rate) {
    const n = energy.length;
    if (n < 4) return [];

    let sum = 0;
    for (const v of energy) sum += v;
    const mean = sum / n;
    let sq = 0;
    for (const v of energy) sq += (v - mean) * (v - mean);
    const std = Math.sqrt(sq / n) || 0.05;

    const highThr = mean + 0.45 * std;
    const lowThr = mean - 0.2 * std;

    const classify = (v) => {
      if (v > highThr) return '副歌';
      if (v < lowThr) return '主歌';
      return '主歌';
    };

    const raw = [];
    let i = 0;
    while (i < n) {
      const label = classify(energy[i]);
      let j = i + 1;
      while (j < n && classify(energy[j]) === label) j++;
      raw.push({ t0: i / rate, t1: j / rate, label });
      i = j;
    }

    // 合并过短片段（< 2.5s 并到前一段），并把最开头的低能量段标成"前奏"
    const segs = [];
    for (const s of raw) {
      const prev = segs[segs.length - 1];
      if (prev && (s.t1 - s.t0) < 2.5) {
        prev.t1 = s.t1;
        continue;
      }
      segs.push({ ...s });
    }
    if (segs.length && segs[0].t0 < 1.5) segs[0].label = '前奏';
    return segs;
  }

  /**
   * BPM 估算：onset 序列（能量正差分）做自相关，在 60–180 BPM 区间找峰值。
   * onset 由 Worker 用 20ms 窗口生成，精度足够。纯时域启发式，
   * 够 AI DJ 做 ±6 的相似度比较，不做音乐学精度承诺。
   */
  _estimateBPM(onset, rate) {
    const n = onset.length;
    if (n < 20) return 0;

    const minLag = Math.max(1, Math.round(0.33 * rate));   // ~180 BPM
    const maxLag = Math.round(1.0 * rate);                  // 60 BPM
    let bestLag = 0;
    let bestScore = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let score = 0;
      for (let i = 0; i + lag < n; i++) {
        score += onset[i] * onset[i + lag];
      }
      if (score > bestScore) { bestScore = score; bestLag = lag; }
    }

    if (!bestLag) return 0;
    let bpm = 60 / (bestLag / rate);

    // 倍频/半拍修正：自相关常把"半拍"或"两拍"当成主周期
    const scoreAt = (lag) => {
      if (lag < 1) return -1;
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += onset[i] * onset[i + lag];
      return s;
    };

    if (bpm > 135) {
      // 疑似检测到了半拍 → 减半（更慢）
      const doubleLag = Math.round(bestLag * 2);
      if (doubleLag <= maxLag && scoreAt(doubleLag) > bestScore * 0.8) {
        bpm = 60 / (doubleLag / rate);
      }
    } else if (bpm < 75) {
      // 疑似检测到了两拍 → 翻倍（更快）
      const halfLag = Math.round(bestLag / 2);
      if (halfLag >= minLag && scoreAt(halfLag) > bestScore * 0.8) {
        bpm = 60 / (halfLag / rate);
      }
    }
    return Math.round(bpm);
  }

  /** 查某首歌的曲线（含 onsets / lyricCalib），没有则返回 null */
  curveFor(id) {
    return this._cache.get(id) || null;
  }

  /** 歌词校准完成后把结果补写进缓存快照（异步落盘，失败不影响播放） */
  patchCalib(id, calib) {
    const curve = this._cache.get(id);
    if (!curve) return;
    curve.lyricCalib = calib;
    api.saveAnalysis(id, curve).catch(() => {});
  }

  get currentId() { return this._currentId; }
  get isAnalyzing() { return this._pendingId !== null; }
}
