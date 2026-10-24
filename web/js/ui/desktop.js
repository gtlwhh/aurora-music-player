/**
 * 桌面窗口集成：窗口控制按钮 + 拖拽区域
 * 只在 Electron 环境下生效，浏览器打开时静默跳过。
 */

export function initDesktop() {
  const d = window.auroraDesktop;
  if (!d || !d.isDesktop) return false;

  document.body.classList.add('desktop');

  const controls = document.getElementById('winControls');
  if (!controls) return true;
  controls.hidden = false;

  const btnMax = document.getElementById('winMax');

  const setMaxIcon = (maxed) => {
    btnMax.classList.toggle('maxed', !!maxed);
    btnMax.title = maxed ? '还原' : '最大化';
  };

  document.getElementById('winMin').addEventListener('click', () => d.minimize());
  btnMax.addEventListener('click', () => d.toggleMaximize());
  document.getElementById('winClose').addEventListener('click', () => d.close());

  // 双击顶栏空白处最大化 / 还原
  const topbar = document.querySelector('.topbar');
  topbar.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input, .search-wrap, .source-tabs, .win-controls')) return;
    d.toggleMaximize();
  });

  if (d.onMaxState) d.onMaxState(setMaxIcon);
  if (d.isMaximized) d.isMaximized().then(setMaxIcon).catch(() => {});

  return true;
}
