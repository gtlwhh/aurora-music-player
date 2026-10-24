/**
 * 音频分析 Worker
 *
 * 主线程把解码后的 PCM（Float32Array）transfer 进来，这里算：
 *   - energy：100ms 窗口 RMS，供情绪曲线
 *   - onset：20ms 窗口 RMS 的正差分，供 BPM 检测（要足够精细）
 *   - flux：40ms 起音通量（0-255 量化），供歌词自动校准做互相关
 * 不碰 DOM，不碰 UI，不卡主线程。
 */

self.onmessage = (e) => {
  const { samples, sampleRate, duration } = e.data || {};
  if (!samples) { self.postMessage({ error: 'no samples' }); return; }

  const data = new Float32Array(samples);

  /* ---- 100ms 能量曲线 ---- */
  const step = 0.1;
  const window = Math.max(1, Math.floor(sampleRate * step));
  const n = Math.max(1, Math.ceil(duration / step));
  const energy = new Float32Array(n);
  let max = 0;
  let offset = 0;
  for (let i = 0; i < n && offset < data.length; i++) {
    const end = Math.min(offset + window, data.length);
    let sum = 0;
    for (let j = offset; j < end; j++) { const v = data[j]; sum += v * v; }
    const rms = Math.sqrt(sum / Math.max(1, end - offset));
    energy[i] = rms;
    if (rms > max) max = rms;
    offset = end;
  }
  if (max > 0) {
    for (let k = 0; k < n; k++) energy[k] = Math.min(1, energy[k] / max);
  }

  /* ---- 20ms 精细 RMS + onset 差分（BPM 用） ---- */
  const stepFine = 0.02;
  const winFine = Math.max(1, Math.floor(sampleRate * stepFine));
  const nFine = Math.max(1, Math.ceil(duration / stepFine));
  const fine = new Float32Array(nFine);
  offset = 0;
  for (let i = 0; i < nFine && offset < data.length; i++) {
    const end = Math.min(offset + winFine, data.length);
    let sum = 0;
    for (let j = offset; j < end; j++) { const v = data[j]; sum += v * v; }
    fine[i] = Math.sqrt(sum / Math.max(1, end - offset));
    offset = end;
  }
  const onset = new Float32Array(Math.max(0, nFine - 1));
  for (let i = 1; i < nFine; i++) {
    onset[i - 1] = Math.max(0, fine[i] - fine[i - 1]);
  }

  /* ---- 40ms 起音通量（歌词校准用） ----
     三点平滑压噪声后取正差分，按 40ms 帧求和，全局归一化量化 0-255。
     互相关时行首落在"能量陡增"处才有高分，密集鼓点不会稀释区分度。 */
  const flux = [];
  if (nFine > 3) {
    const sm = new Float32Array(nFine);
    for (let i = 0; i < nFine; i++) {
      const a = fine[i > 0 ? i - 1 : 0];
      const b = fine[i];
      const c = fine[i < nFine - 1 ? i + 1 : nFine - 1];
      sm[i] = (a + 2 * b + c) / 4;
    }
    const stepFlux = 0.04;
    const nFlux = Math.max(1, Math.ceil(duration / stepFlux));
    const raw = new Float32Array(nFlux);
    for (let i = 1; i < nFine; i++) {
      const d = Math.max(0, sm[i] - sm[i - 1]);
      const fi = Math.min(nFlux - 1, Math.floor((i * stepFine) / stepFlux));
      raw[fi] += d;
    }
    let fMax = 0;
    for (let i = 0; i < nFlux; i++) if (raw[i] > fMax) fMax = raw[i];
    // p98 鲁棒归一化：全局最大值常被观众欢呼/爆炸音一类的孤立尖峰撑爆，
    // 会把真正的行首通量压到几十/255。按 98 分位归一并截断，保留分辨率。
    const sortedRaw = Float64Array.from(raw).sort();
    let norm = sortedRaw[Math.floor(nFlux * 0.98)];
    if (norm <= 0) norm = fMax;
    for (let i = 0; i < nFlux; i++) {
      flux.push(norm > 0 ? Math.min(255, Math.round((raw[i] / norm) * 255)) : 0);
    }
  }

  self.postMessage(
    { energy: energy.buffer, onset: onset.buffer, flux },
    [energy.buffer, onset.buffer]
  );
};
