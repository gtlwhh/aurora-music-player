/** 状态机验收：正常切歌 / 快速连点 / 中途 seek / 英文分词 */
const puppeteer = require('puppeteer-core');
(async () => {
  const v = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  const b = await puppeteer.connect({ browserWSEndpoint: v.webSocketDebuggerUrl, defaultViewport: null });
  const p = (await b.pages()).find(x => x.url().includes('127.0.0.1'));
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  await new Promise(r => setTimeout(r, 800));

  // 0. 状态机是否存在
  const has = await p.evaluate(() => ({
    fsm: !!window.__aurora.transition,
    phase: window.__aurora.transition?.phase,
    queue: window.__aurora.state.queue.length
  }));
  console.log('① 初始化:', JSON.stringify(has));

  // 1. 正常切歌
  await p.evaluate(() => {
    const a = window.__aurora;
    a.playQueue(a.state.library.tracks, 0);
  });
  await new Promise(r => setTimeout(r, 3500));
  let s = await p.evaluate(() => {
    const a = window.__aurora;
    return { phase: a.transition.phase, title: a.state.current?.title, paused: a.audio.paused,
             fsmTrack: a.transition.track?.title };
  });
  console.log('② 正常切歌后:', JSON.stringify(s));

  // 2. 快速连点：100ms 内连切 5 次
  const before = await p.evaluate(() => window.__aurora.state.queueIndex);
  await p.evaluate(() => {
    const a = window.__aurora;
    for (let i = 0; i < 5; i++) {
      const idx = Math.min(a.state.queueIndex + 1, a.state.queue.length - 1);
      a.playQueue(a.state.queue, idx);
    }
  });
  await new Promise(r => setTimeout(r, 500));
  const during = await p.evaluate(() => ({
    phase: window.__aurora.transition.phase,
    supersede: window.__aurora.transition.supersedeCount,
    title: window.__aurora.state.current?.title
  }));
  console.log('③ 连点期间:', JSON.stringify(during));

  await new Promise(r => setTimeout(r, 4000));
  const after = await p.evaluate(() => {
    const a = window.__aurora;
    const stageTexOk = a.stage.currentTex && a.stage.currentTex !== a.stage.placeholderTex;
    return {
      phase: a.transition.phase,
      supersede: a.transition.supersedeCount,
      title: a.state.current?.title,
      fsmTrack: a.transition.track?.title,
      paused: a.audio.paused,
      audioSrc: a.audio.audio.src.slice(-40),
      bgUrl: (document.querySelector('#miniCover').style.backgroundImage || '').slice(-40),
      stageTexOk
    };
  });
  console.log('④ 连点稳定后:', JSON.stringify(after, null, 1));

  // 3. 切歌中途 seek
  await p.evaluate(() => {
    const a = window.__aurora;
    a.playQueue(a.state.queue, 0);   // 重新切歌，制造转场
  });
  await new Promise(r => setTimeout(r, 120));
  const midSeek = await p.evaluate(() => {
    const a = window.__aurora;
    const beforePhase = a.transition.phase;
    // 模拟拖动进度条
    const dur = a.audio.duration || 30;
    a.seekTo ? a.seekTo(dur * 0.5) : a.audio.seek(dur * 0.5);
    return { beforePhase, afterPhase: a.transition.phase, hasTransition: !!a.stage.transition };
  });
  console.log('⑤ 中途 seek:', JSON.stringify(midSeek));

  await new Promise(r => setTimeout(r, 1200));
  const settled = await p.evaluate(() => ({
    phase: window.__aurora.transition.phase,
    stageTransition: !!window.__aurora.stage.transition,
    t: +window.__aurora.audio.currentTime.toFixed(1)
  }));
  console.log('⑥ seek 后:', JSON.stringify(settled));

  // 4. 英文分词
  const tok = await p.evaluate(async () => {
    const m = await import('/js/ui/lyric-fx.js');
    return {
      en: m.tokenize("I don't wanna miss a thing"),
      mixed: m.tokenize('和你一起 sing in the rain'),
      cn: m.tokenize('午夜三点')
    };
  });
  console.log('⑦ 分词:', JSON.stringify(tok));

  console.log('\n错误:', errs.length ? [...new Set(errs)].slice(0, 5).join(' | ') : '（无）');
  b.disconnect();
})().catch(e => console.error('ERR', e.message));
