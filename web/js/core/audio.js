/**
 * 音频引擎：播放控制 + Web Audio 频谱分析
 * 频谱数据驱动 3D 光效律动
 */

const FFT_SIZE = 2048;
const BAND_COUNT = 48;

export class AudioEngine {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.crossOrigin = 'anonymous';

    // ---- B 轨（智能过渡：预载下一首 + 交叉淡化） ----
    this.bAudio = new Audio();
    this.bAudio.preload = 'auto';
    this.bAudio.crossOrigin = 'anonymous';
    this.bAudio.volume = 0;              // 未交叉前永远静音（gain 之外的双保险）
    this.bSource = null;
    this.bGain = null;
    this._preparedUrl = '';
    this._crossfading = false;

    this.ctx = null;
    this.source = null;
    this.analyser = null;
    this.gain = null;

    this._freqData = null;
    this._levels = { bass: 0, energy: 0, mid: 0, treble: 0, spectrum: new Float32Array(BAND_COUNT) };
    this._empty = { bass: 0, energy: 0, mid: 0, treble: 0, spectrum: new Float32Array(BAND_COUNT) };

    this._bandEdges = null;
    this._volume = 0.8;
    this.muted = false;

    this._listeners = new Map();
    this._bindAudioEvents(this.audio, false);
    this._bindAudioEvents(this.bAudio, true);
  }

  /** B 轨静默预载失败 → 上层降级硬切 */
  get crossfadeReady() {
    try {
      return !!this._preparedUrl && !!this.bAudio &&
             this.bAudio.readyState >= 2 && !this._crossfading;
    } catch (_) { return false; }
  }

  /** 清除 B 轨预载（关闭智能过渡时调用） */
  clearPrepared() {
    try {
      this.bAudio.pause();
      this.bAudio.removeAttribute('src');
      this.bAudio.load();
    } catch (_) {}
    if (this._preparedUrl) console.log('[智能过渡] 已清除 B 轨预载（开关关闭）');
    this._preparedUrl = '';
  }

  /** 静默预载下一首（剩余 30s 时调用） */
  async prepareNext(url) {
    if (this._crossfading || this._preparedUrl === url) return;
    try {
      await this.ensureContext();
      if (!this.ctx) {
        console.log('[智能过渡] 无 WebAudio 环境，预载跳过（硬切降级）');
        return;
      }
      if (!this.bSource) {
        this.bSource = this.ctx.createMediaElementSource(this.bAudio);
        this.bGain = this.ctx.createGain();
        this.bGain.gain.value = 0;
        this.bSource.connect(this.analyser);
        this.bSource.connect(this.bGain);
        this.bGain.connect(this.ctx.destination);
      }
      if (this._preparedUrl && this.bAudio.src !== url) {
        try { this.bAudio.pause(); } catch (_) {}
      }
      this.bAudio.src = url;
      this.bAudio.load();
      this._preparedUrl = url;
      console.log(`[智能过渡] B 轨预载已启动，等待缓冲 (readyState=${this.bAudio.readyState})`);
    } catch (err) {
      this._preparedUrl = '';                      // 预载失败 → 硬切降级
      console.log('[智能过渡] 预载失败，降级硬切:', err.message);
    }
  }

  /**
   * 交叉淡化切换：A 线性衰减、B 线性增益（默认 4s）。
   * 成功返回 true（音频已无琏续接）；失败返回 false（上层降级硬切）。
   * 完成后 A/B 引用互换，B 轨复位为下一次预载待命。
   */
  async swapToPrepared(fadeSec = 4) {
    if (!this._preparedUrl || this._crossfading) return false;
    if (!this.crossfadeReady) {
      console.log(`[智能过渡] 预载未就绪 (readyState=${this.bAudio ? this.bAudio.readyState : 'N/A'})，降级硬切`);
      return false;
    }
    this._crossfading = true;
    console.log(`[智能过渡] 交叉淡化开始 (${fadeSec}s)：A 轨增益 1→0，B 轨增益 0→1`);
    try {
      await this.ensureContext();
      const A = this.audio, B = this.bAudio;
      const p = B.play();
      if (p && p.catch) p.catch(() => {});
      if (this.gain && this.bGain) {
        const now = this.ctx.currentTime;
        const t1 = now + fadeSec;
        this.gain.gain.cancelScheduledValues(now);
        this.bGain.gain.cancelScheduledValues(now);
        this.gain.gain.setValueAtTime(this.gain.gain.value || 1, now);
        this.bGain.gain.setValueAtTime(this.bGain.gain.value || 0, now);
        this.gain.gain.linearRampToValueAtTime(0.0001, t1);
        this.bGain.gain.linearRampToValueAtTime(1, t1);
      } else {
        this._elFade(A, B, fadeSec);              // 无 WebAudio 的近似交叉
      }
      setTimeout(() => {
        try { A.pause(); } catch (_) {}
        // A/B 引用互换：B 成为主轨，旧 A 复位为预载轨
        const a = this.audio, as = this.source, ag = this.gain;
        this.audio = B; this.bAudio = a;
        this.source = this.bSource; this.bSource = as;
        this.gain = this.bGain; this.bGain = ag;
        this._crossfading = false;
        this._preparedUrl = '';
        console.log('[智能过渡] 交叉淡化完成，B 轨已接棒为主音轨');
        this._emit('swapped');
      }, fadeSec * 1000 + 80);
      return true;
    } catch (err) {
      this._crossfading = false;
      console.log('[智能过渡] 交叉失败，降级硬切:', err.message);
      return false;
    }
  }

  /** 无 WebAudio 时的元素音量近似交叉 */
  _elFade(A, B, sec) {
    const steps = Math.max(10, Math.round(sec * 20));
    let i = 0;
    const base = this.muted ? 0 : this._volume;
    const timer = setInterval(() => {
      i++;
      const k = i / steps;
      try {
        A.volume = Math.max(0, base * (1 - k));
        B.volume = Math.min(1, base * k);
      } catch (_) {}
      if (i >= steps) clearInterval(timer);
    }, (sec * 1000) / steps);
  }

  /* ---------------- 事件 ---------------- */
  on(evt, fn) {
    if (!this._listeners.has(evt)) this._listeners.set(evt, new Set());
    this._listeners.get(evt).add(fn);
    return () => this._listeners.get(evt).delete(fn);
  }

  _emit(evt, data) {
    const set = this._listeners.get(evt);
    if (set) for (const fn of set) { try { fn(data); } catch (e) { console.error(e); } }
  }

  _bindAudioEvents(el, isB) {
    const a = el;
    a.addEventListener('timeupdate', () => this._emit('time', a.currentTime));
    a.addEventListener('durationchange', () => this._emit('duration', a.duration || 0));
    a.addEventListener('loadedmetadata', () => this._emit('duration', a.duration || 0));
    a.addEventListener('progress', () => {
      try {
        if (a.buffered.length) {
          this._emit('buffered', a.buffered.end(a.buffered.length - 1));
        }
      } catch (_) {}
    });
    a.addEventListener('ended', () => this._emit('ended'));
    a.addEventListener('play', () => this._emit('play'));
    a.addEventListener('pause', () => this._emit('pause'));
    a.addEventListener('waiting', () => this._emit('waiting'));
    a.addEventListener('playing', () => this._emit('playing'));
    a.addEventListener('canplay', () => this._emit('canplay'));
    a.addEventListener('error', () => {
      if (isB) {                                   // B 轨失败 → 通知上层降级硬切
        this._preparedUrl = '';
        this._emit('berror');
        return;
      }
      let msg = '音频加载失败';
      const err = a.error;
      if (err) {
        switch (err.code) {
          case 1: msg = '播放被中断'; break;
          case 2: msg = '网络错误，音源无法访问'; break;
          case 3: msg = '音频解码失败（格式不支持）'; break;
          case 4: msg = '音源不可用（可能无版权或需要登录）'; break;
        }
      }
      this._emit('error', msg);
    });
  }

  /* ---------------- Web Audio ---------------- */
  async ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return; // 老浏览器降级为纯播放
      this.ctx = new AC();
      try {
        this.source = this.ctx.createMediaElementSource(this.audio);
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = FFT_SIZE;
        this.analyser.smoothingTimeConstant = 0.8;
        this.analyser.minDecibels = -96;
        this.analyser.maxDecibels = -14;

        this.gain = this.ctx.createGain();
        this.gain.gain.value = 1;

        this.source.connect(this.analyser);
        this.analyser.connect(this.gain);
        this.gain.connect(this.ctx.destination);

        this._freqData = new Uint8Array(this.analyser.frequencyBinCount);
        this._buildBandEdges();
      } catch (err) {
        // 某些情况下重复调用会抛错，忽略即可
        console.warn('[audio] Web Audio 初始化异常:', err.message);
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch (_) {}
    }
  }

  /** 预计算对数频段边界，让低频占更多视觉空间 */
  _buildBandEdges() {
    const nyquist = this.ctx.sampleRate / 2;
    const binCount = this.analyser.frequencyBinCount;
    const hzPerBin = nyquist / binCount;
    // 音乐的能量几乎都在 45Hz–9kHz，超出这个范围划分出来的频段永远是 0，
    // 所以这里直接把 48 个频段铺在这个区间内，视觉上才不会有一半光条是死的。
    const fMin = 45;
    const fMax = Math.min(9000, nyquist * 0.85);
    const edges = [];
    for (let i = 0; i <= BAND_COUNT; i++) {
      const f = fMin * Math.pow(fMax / fMin, i / BAND_COUNT);
      edges.push(Math.max(0, Math.min(binCount - 1, Math.round(f / hzPerBin))));
    }
    this._bandEdges = edges;
  }

  /** 每帧调用，返回归一化的能量与频谱 */
  getLevels() {
    if (!this.analyser || this.audio.paused || !this._freqData) return this._empty;

    this.analyser.getByteFrequencyData(this._freqData);
    const buf = this._freqData;
    const out = this._levels;
    const edges = this._bandEdges;
    if (!edges) return this._empty;

    let sum = 0;
    for (let b = 0; b < BAND_COUNT; b++) {
      const s = edges[b], e = edges[b + 1];
      let v = 0, n = 0;
      for (let i = s; i <= e && i < buf.length; i++) { v += buf[i]; n++; }
      const val = n ? (v / n) / 255 : 0;
      // 轻度提升，让安静的段落也有可看的光条运动
      out.spectrum[b] = Math.min(1, Math.pow(val, 0.78) * 1.35);
      sum += out.spectrum[b];
    }

    // 低频段（32-220Hz）
    let bassSum = 0, bassN = 0;
    const nyquist = this.ctx.sampleRate / 2;
    const hzPerBin = nyquist / buf.length;
    for (let i = Math.floor(32 / hzPerBin); i < Math.ceil(220 / hzPerBin) && i < buf.length; i++) {
      bassSum += buf[i]; bassN++;
    }
    out.bass = bassN ? Math.min(1, Math.pow((bassSum / bassN) / 255, 0.78) * 1.35) : 0;

    // 中频 / 高频
    let midSum = 0, midN = 0, highSum = 0, highN = 0;
    for (let i = Math.floor(250 / hzPerBin); i < Math.ceil(2000 / hzPerBin) && i < buf.length; i++) { midSum += buf[i]; midN++; }
    for (let i = Math.floor(2000 / hzPerBin); i < Math.ceil(8000 / hzPerBin) && i < buf.length; i++) { highSum += buf[i]; highN++; }
    out.mid = midN ? Math.min(1, Math.pow((midSum / midN) / 255, 0.78) * 1.35) : 0;
    out.treble = highN ? Math.min(1, Math.pow((highSum / highN) / 255, 0.78) * 1.35) : 0;

    out.energy = Math.min(1, Math.pow(sum / BAND_COUNT, 0.82) * 1.5);
    return out;
  }

  /* ---------------- 播放控制 ---------------- */
  load(url, { autoplay = true, fadeSec = 4 } = {}) {
    // 智能过渡：URL 与预载一致 → 走交叉淡化（失败自动降级硬切）
    if (this._preparedUrl && this._preparedUrl !== url) {
      console.log('[智能过渡] 预载 URL 与切歌目标不一致（流地址变化），预载作废，硬切');
      this.clearPrepared();
    }
    if (this._preparedUrl === url && this.crossfadeReady) {
      return this.swapToPrepared(fadeSec).then(ok => {
        if (ok) return;
        this.audio.src = url;
        this.audio.load();
        if (autoplay) return this.play();
      });
    }
    this.audio.src = url;
    this.audio.load();
    if (autoplay) return this.play();
    return Promise.resolve();
  }

  async play() {
    await this.ensureContext();
    try {
      await this.audio.play();
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        this._emit('error', '浏览器需要你先点击播放按钮才能开始播放');
      } else if (err.name !== 'AbortError') {
        this._emit('error', '播放失败: ' + err.message);
      }
    }
  }

  pause() { this.audio.pause(); }
  toggle() { this.audio.paused ? this.play() : this.pause(); }

  seek(t) {
    if (!isFinite(t)) return;
    try { this.audio.currentTime = Math.max(0, t); } catch (_) {}
  }

  setVolume(v) {
    this._volume = Math.max(0, Math.min(1, v));
    this.audio.volume = this.muted ? 0 : this._volume;
    try { this.bAudio.volume = this.muted ? 0 : this._volume; } catch (_) {}
  }
  get volume() { return this._volume; }

  setMuted(m) {
    this.muted = m;
    this.audio.volume = m ? 0 : this._volume;
    try { this.bAudio.volume = m ? 0 : this._volume; } catch (_) {}
  }

  get currentTime() { return this.audio.currentTime || 0; }
  get duration() { return this.audio.duration || 0; }
  get paused() { return this.audio.paused; }
  get buffered() {
    try {
      return this.audio.buffered.length ? this.audio.buffered.end(this.audio.buffered.length - 1) : 0;
    } catch (_) { return 0; }
  }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    try {
      this.bAudio.pause();
      this.bAudio.removeAttribute('src');
      this.bAudio.load();
    } catch (_) {}
    this._preparedUrl = '';
  }
}
