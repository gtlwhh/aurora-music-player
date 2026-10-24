'use strict';
/**
 * Aurora 极光音乐播放器 · Electron 主进程
 *
 * 职责：
 *  1. 创建无边框窗口，内置拖拽标题栏与窗口按钮
 *  2. 在进程内启动本地 HTTP 服务（复用 server/index.js）
 *  3. 记住窗口大小/位置，单实例运行
 */

const { app, BrowserWindow, ipcMain, shell, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------------ */
/* 数据目录（打包后必须落到用户目录，Program Files 不可写）            */
/* server/index.js 会在被 require 时读取该环境变量                     */
/* ------------------------------------------------------------------ */
process.env.AURORA_DATA_DIR = path.join(app.getPath('userData'), 'data');

/* GPU 兜底：无独显/远程会话下 GPU 进程可能连环崩溃（0xC0000005），
   允许 SwiftShader 软件渲染 WebGL（3D 封面照常，帧率略降）+ 禁 GPU 沙箱 */
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

/* GPU 进程连环崩溃（无 GPU 环境）→ 自动以禁用 GPU 模式重启一次 */
let gpuCrashCount = 0;
let gpuDisabledRelaunch = false;
app.on('gpu-process-crashed', (e, killed) => {
  gpuCrashCount++;
  logLine(`[gpu] GPU 进程崩溃 #${gpuCrashCount} killed=${killed}`);
  if (gpuCrashCount >= 2 && !gpuDisabledRelaunch && !process.argv.includes('--disable-gpu')) {
    gpuDisabledRelaunch = true;
    logLine('[gpu] 以 --disable-gpu 模式重启应用');
    app.relaunch({ args: process.argv.slice(1).concat(['--disable-gpu']) });
    app.exit(0);
  }
});

/* 主进程文件日志（GUI 程序 console 不可见，排查打包问题全靠它） */
const LOG_FILE = path.join(app.getPath('userData'), 'main.log');
function logLine(msg) {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, 'utf8'); } catch (_) {}
  if (process.stdout && process.stdout.writable) console.log(msg);
}
process.on('uncaughtException', (e) => logLine('[uncaught] ' + (e.stack || e.message)));
logLine('--- 启动 ---  isPackaged=' + app.isPackaged + '  dataDir=' + process.env.AURORA_DATA_DIR);

let mainWindow = null;
let serverInfo = null;
let serverError = null;

/* ------------------------------------------------------------------ */
/* 单实例                                                              */
/* ------------------------------------------------------------------ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });
}

/* ------------------------------------------------------------------ */
/* 窗口状态持久化                                                      */
/* ------------------------------------------------------------------ */
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

const DEFAULT_STATE = { width: 1480, height: 920 };

function loadWinState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (s && typeof s === 'object') return s;
    }
  } catch (_) {}
  return { ...DEFAULT_STATE };
}

function saveWinState() {
  if (!mainWindow) return;
  try {
    const isMax = mainWindow.isMaximized();
    const b = isMax ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      width: b.width, height: b.height, x: b.x, y: b.y, maximized: isMax
    }), 'utf8');
  } catch (_) {}
}

/** 确保窗口落在某块屏幕内（拔掉副屏后不至于跑到屏幕外） */
function clampToScreen(state) {
  try {
    const { screen } = require('electron');
    const displays = screen.getAllDisplays();
    if (state.x === undefined || state.y === undefined) return state;
    const visible = displays.some(d => {
      const a = d.workArea;
      return state.x + 80 < a.x + a.width &&
             state.x + state.width - 80 > a.x &&
             state.y + 40 < a.y + a.height &&
             state.y + state.height - 40 > a.y;
    });
    if (!visible) { delete state.x; delete state.y; }
  } catch (_) {}
  return state;
}

/* ------------------------------------------------------------------ */
/* 图标                                                                */
/* ------------------------------------------------------------------ */
function getIcon() {
  // Windows 优先用 ico（任务栏/标题栏效果最好）
  const candidates = [
    path.join(ROOT, 'build', 'icon.ico'),
    path.join(ROOT, 'build', 'icon.png')
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) return img;
      }
    } catch (_) {}
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* 创建窗口                                                            */
/* ------------------------------------------------------------------ */
function createWindow() {
  const state = clampToScreen(loadWinState());

  mainWindow = new BrowserWindow({
    width: state.width || DEFAULT_STATE.width,
    height: state.height || DEFAULT_STATE.height,
    x: state.x,
    y: state.y,
    minWidth: 1040,
    minHeight: 680,
    frame: false,
    backgroundColor: '#06070c',
    title: '极光音乐',
    icon: getIcon(),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  if (state.maximized) mainWindow.maximize();

  // 先显示加载页，服务就绪后再切成播放器
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (state.maximized) mainWindow.maximize();
  });

  // 最大化状态变化通知渲染进程
  const sendMaxState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('win:max-state', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', sendMaxState);
  mainWindow.on('unmaximize', sendMaxState);

  mainWindow.on('close', saveWinState);
  mainWindow.on('closed', () => { mainWindow = null; });

  // 外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    // 只允许停留在本地服务上
    if (serverInfo && url.startsWith(serverInfo.url)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  // F11 全屏 / F12 开发者工具
  mainWindow.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      e.preventDefault();
    } else if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */
ipcMain.on('win:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('win:close', () => mainWindow && mainWindow.close());
ipcMain.on('win:toggle-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.handle('win:is-maximized', () => !!mainWindow && mainWindow.isMaximized());
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  serverUrl: serverInfo ? serverInfo.url : '',
  serverError
}));

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  createWindow();

  // 在 Electron 主进程里直接起本地服务
  try {
    logLine('开始加载 server/index.js ...');
    const { start } = require(path.join(ROOT, 'server', 'index.js'));
    logLine('server 模块加载成功，启动 HTTP 服务...');
    serverInfo = await start({ open: false, port: 7788 });
    logLine('HTTP 服务已就绪: ' + serverInfo.url);

    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(serverInfo.url);

      // 调试用：设置 AURORA_SCREENSHOT=路径 可在启动后自动截图
      if (process.env.AURORA_SCREENSHOT) {
        setTimeout(async () => {
          try {
            const img = await mainWindow.capturePage();
            fs.writeFileSync(process.env.AURORA_SCREENSHOT, img.toPNG());
            console.log('[debug] 截图已保存:', process.env.AURORA_SCREENSHOT);
          } catch (e) {
            console.error('[debug] 截图失败:', e.message);
          }
        }, Number(process.env.AURORA_SCREENSHOT_DELAY || 5000));
      }
    }
  } catch (err) {
    serverError = err && err.message ? err.message : String(err);
    logLine('[electron] 服务启动失败: ' + (err && err.stack || serverError));
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:server-error', serverError);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  saveWinState();
  try {
    const { server } = require(path.join(ROOT, 'server', 'index.js'));
    if (server && server.close) server.close();
  } catch (_) {}
});
