/**
 * TrackTransition —— 切歌转场的唯一仲裁者
 *
 * 谁来决定"什么时候开始转场"：只有这里。
 * stage / 歌词 / 播放条都只是响应者，不再自己判断。
 *
 * 三个阶段：
 *   idle      没在切歌
 *   loading   已经发起，音频和封面都在路上
 *   animating 视觉正在播（封面翻块）
 *
 * 两类竞争：
 *   1) 快速连点切歌：每次 begin 递增 generation，旧的异步回调回来时
 *      发现 gen 不是当前的，直接丢弃结果，不会覆盖新状态。
 *   2) 切歌中途 seek：notifySeek() 把视觉标记为"已收尾"，调用方配合
 *      stage.finishPuzzle() 立即把碎片落位，避免画面落后于声音。
 */

export const Phase = {
  IDLE: 'idle',
  LOADING: 'loading',
  ANIMATING: 'animating'
};

export class TrackTransition {
  /**
   * @param {object} opts
   * @param {(track, gen) => Promise} opts.onAudio  切换音频
   * @param {(track, gen) => Promise} opts.onVisual 切换视觉（封面/碎片）
   * @param {(track, gen, meta) => void} opts.onSettle 两边都完成
   * @param {(track, gen) => void} opts.onSupersede 上一次被新请求取代
   */
  constructor(opts = {}) {
    this.onAudio = opts.onAudio || (async () => {});
    this.onVisual = opts.onVisual || (async () => {});
    this.onSettle = opts.onSettle || (() => {});
    this.onSupersede = opts.onSupersede || (() => {});

    this._gen = 0;
    this._phase = Phase.IDLE;
    this._track = null;
    this._audioDone = false;
    this._visualDone = false;
    this._startedAt = 0;
    this._lastDuration = 0;
    this._supersedeCount = 0;
  }

  get phase() { return this._phase; }
  get track() { return this._track; }
  get generation() { return this._gen; }
  get isBusy() { return this._phase !== Phase.IDLE; }
  get lastDuration() { return this._lastDuration; }
  get supersedeCount() { return this._supersedeCount; }

  /** 这个 gen 还是当前有效的吗（异步回调必须用它判断） */
  isCurrent(gen) { return gen === this._gen; }

  /**
   * 发起一次切歌
   * @param {object} track
   * @param {object} opts { instantVisual:boolean }
   * @returns {number} generation
   */
  begin(track, opts = {}) {
    const prevGen = this._gen;
    const wasBusy = this._phase !== Phase.IDLE;
    const gen = ++this._gen;

    if (wasBusy) {
      this._supersedeCount++;
      try { this.onSupersede(this._track, prevGen); } catch (_) {}
    }

    this._track = track;
    this._audioDone = false;
    this._visualDone = false;
    this._phase = Phase.LOADING;
    this._startedAt = performance.now();

    // 音频先切，视觉跟进——两者并行，谁先完成都登记一下
    this._run('audio', this.onAudio, gen, track, opts);
    this._run('visual', this.onVisual, gen, track, opts);

    return gen;
  }

  async _run(kind, fn, gen, track, opts) {
    if (kind === 'visual' && this.isCurrent(gen)) {
      this._phase = Phase.ANIMATING;
    }

    try {
      await fn(track, gen, opts);
    } catch (_) {
      // 单个环节失败不阻塞状态推进，避免卡在 loading
    }

    // 关键：回来时如果已经被新请求取代，丢弃结果，不改任何状态
    if (!this.isCurrent(gen)) return;

    if (kind === 'audio') this._audioDone = true;
    else this._visualDone = true;

    this._advance();
  }

  _advance() {
    if (this._phase === Phase.IDLE) return;
    if (!this._audioDone || !this._visualDone) return;

    this._phase = Phase.IDLE;
    this._lastDuration = performance.now() - this._startedAt;
    try {
      this.onSettle(this._track, this._gen, { duration: this._lastDuration });
    } catch (_) {}
  }

  /**
   * 切歌过程中用户 seek。
   * 视觉立刻收尾（调用方负责让 stage 把碎片落位），状态机回到可接收新切歌的状态。
   * @returns {boolean} 当时是否真的处在转场中
   */
  notifySeek() {
    if (this._phase === Phase.IDLE) return false;
    this._visualDone = true;
    this._advance();
    return true;
  }

  /** 音频实际开始播放（用于外部想观察但不必改状态） */
  notifyPlaying() {
    if (this._phase === Phase.LOADING) this._phase = Phase.ANIMATING;
  }
}
