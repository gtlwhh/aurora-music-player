'use strict';
/**
 * 内置 QQ 音乐 API 服务管理器
 *
 * 基于 @yakult-green-tea/qq-music-api（MIT 授权声明见包内 LICENSE），
 * 在本进程内拉起它的 Koa 服务（与内置网易云 API 同模式），职责：
 *
 *   1. 端口：从 3200 起自动探测空闲端口，不死绑。
 *   2. 生命周期：只绑 127.0.0.1；进程退出（Electron will-quit / exit）时关闭，
 *      不留僵尸监听。
 *   3. 安全：摘除 /user/getCookie、/user/setCookie 两个 cookie 出入口路由
 *      （登录流程不经过它们，直接屏蔽而不是放行）。
 *   4. 登录态持久化：通过包官方的 configureAuthSessionRepository 注入
 *      safeStorage（DPAPI）加密仓库，凭证落 data/qq-auth-session.json，
 *      重启自动恢复，绝不明文落盘。
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const { DATA_DIR } = require('./paths');
const SESSION_FILE = path.join(DATA_DIR, 'qq-auth-session.json');

/** 摘掉 cookie 出入口路由 */
const BLOCKED_ROUTES = [/^\/user\/getCookie$/, /^\/user\/setCookie$/];

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    try { srv.listen(port, '127.0.0.1'); } catch (_) { resolve(false); }
  });
}

/* ---- safeStorage 加密会话仓库（包的官方注入点） ---- */
function createSafeStorageRepository(file) {
  let safeStorage = null;
  try {
    const electron = require('electron');
    if (electron && electron.safeStorage && typeof electron.safeStorage.encryptString === 'function') {
      safeStorage = electron.safeStorage;
    }
  } catch (_) { /* 纯 node 调试模式 */ }

  return {
    kind: 'aurora-safeStorage',
    load() {
      try {
        if (!fs.existsSync(file)) return [];        // 首次启动，不是错误
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw.enc && safeStorage && safeStorage.isEncryptionAvailable()) {
          const json = safeStorage.decryptString(Buffer.from(raw.enc, 'base64')).toString('utf8');
          return JSON.parse(json);
        }
      } catch (err) {
        console.warn('[qq] 会话解密失败，按未登录处理（需重新扫码）:', err.message);
      }
      return [];
    },
    save(sessions) {
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
        console.warn('[qq] safeStorage 不可用，登录会话仅保存在内存（非 Electron 环境）');
        return;
      }
      const enc = safeStorage.encryptString(JSON.stringify(sessions)).toString('base64');
      try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ enc, savedAt: Date.now() }), { encoding: 'utf8', mode: 0o600 });
      } catch (err) {
        console.error('[qq] 会话写入失败:', err.message);
      }
    }
  };
}

const state = {
  started: false,
  port: 0,
  baseUrl: '',
  server: null,       // http.Server（重绑到 127.0.0.1 的那个）
  starting: null,
  lastError: ''
};

/* ---- 会话 token 持久化（扫码成功后包发给我们，调用认证接口时要带上） ---- */
const TOKEN_FILE = path.join(DATA_DIR, 'qq-session-token.json');

function loadSessionToken() {
  try {
    const electron = require('electron');
    if (!electron || !electron.safeStorage || !electron.safeStorage.isEncryptionAvailable()) return '';
    const decrypt = (b64) => electron.safeStorage.decryptString(Buffer.from(b64, 'base64'));

    // 首选 token 文件
    try {
      if (fs.existsSync(TOKEN_FILE)) {
        const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        if (raw.enc) return decrypt(raw.enc);
      }
    } catch (err) {
      console.warn('[qq] token 文件解密失败，尝试从会话仓库恢复:', err.message);
    }

    // 兜底：会话仓库（qq-auth-session.json）里每条 AuthSession 自带 token
    if (fs.existsSync(SESSION_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      if (raw.enc) {
        const sessions = JSON.parse(decrypt(raw.enc));
        const valid = (sessions || [])
          .filter(s => s && s.token && (!s.expiresAt || s.expiresAt > Date.now()))
          .sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0));
        if (valid.length) return valid[0].token;
      }
    }
  } catch (err) {
    console.warn('[qq] token 恢复失败，需重新扫码:', err.message);
  }
  return '';
}

function saveSessionToken(token) {
  try {
    const electron = require('electron');
    if (!electron || !electron.safeStorage || !electron.safeStorage.isEncryptionAvailable()) {
      console.warn('[qq] safeStorage 不可用，token 仅保存在内存');
      return;
    }
    const enc = electron.safeStorage.encryptString(String(token || '')).toString('base64');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ enc, savedAt: Date.now() }), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.error('[qq] token 写入失败:', err.message);
  }
}

async function ensureStarted(preferredPort = 3200) {
  if (state.started) return { ok: true, port: state.port, baseUrl: state.baseUrl };
  if (state.starting) return state.starting;

  state.starting = (async () => {
    // ① 探测空闲端口
    let port = 0;
    for (let p = preferredPort; p < preferredPort + 20; p++) {
      if (await isPortFree(p)) { port = p; break; }
    }
    if (!port) {
      state.lastError = '3200-3219 端口都被占用';
      return { ok: false, error: state.lastError };
    }

    // ② 加载包（require 即启动它自带的监听，随后立刻重绑到 127.0.0.1）
    let mod = null;
    const prevPort = process.env.PORT;
    try {
      process.env.PORT = String(port);
      mod = require('@yakult-green-tea/qq-music-api');
    } catch (err) {
      state.lastError = err.code === 'MODULE_NOT_FOUND' ? '未安装 QQ 音乐 API 依赖' : err.message;
      console.warn('[qq] 加载失败:', state.lastError);
      return { ok: false, error: state.lastError };
    } finally {
      if (prevPort === undefined) delete process.env.PORT; else process.env.PORT = prevPort;
    }

    // ③ 摘除 cookie 出入口路由（登录不经过它们，直接屏蔽）
    //    包的 exports map 不放行深层导入，用文件路径直接取路由单例
    try {
      const routerFile = path.join(path.dirname(require.resolve('@yakult-green-tea/qq-music-api/package.json')), 'dist', 'src', 'node', 'router.js');
      const router = require(routerFile).default;
      if (router && Array.isArray(router.stack)) {
        const before = router.stack.length;
        router.stack = router.stack.filter(layer =>
          !BLOCKED_ROUTES.some(re => re.test(String((layer.opts && layer.opts.path) || layer.path || ''))));
        console.log(`[qq] 已屏蔽敏感路由 ${before - router.stack.length} 个（getCookie/setCookie）`);
      }
    } catch (err) {
      console.warn('[qq] 敏感路由屏蔽失败（不影响主流程）:', err.message);
    }

    // ④ 重绑 127.0.0.1（包默认 listen 所有网卡）
    try {
      if (mod.server && mod.server.close) {
        await new Promise(r => { try { mod.server.close(r); } catch (_) { r(); } });
      }
      state.server = mod.default.listen(port, '127.0.0.1');
    } catch (err) {
      state.lastError = '重绑 127.0.0.1 失败: ' + err.message;
      return { ok: false, error: state.lastError };
    }

    // ⑤ 注入加密会话仓库（safeStorage）
    try {
      mod.configureAuthSessionRepository(createSafeStorageRepository(SESSION_FILE));
      console.log('[qq] 加密会话仓库已注入（safeStorage）');
    } catch (err) {
      console.warn('[qq] 会话仓库注入失败，登录态仅内存:', err.message);
    }

    state.started = true;
    state.port = port;
    state.baseUrl = `http://127.0.0.1:${port}`;
    console.log(`[qq] QQ 音乐服务已启动: ${state.baseUrl}（仅本机）`);
    return { ok: true, port, baseUrl: state.baseUrl };
  })();

  const result = await state.starting;
  state.starting = null;
  if (!result.ok) state.server = null;
  return result;
}

/** 进程退出时关闭监听（Electron will-quit / node exit 都会调） */
function shutdown() {
  if (state.server) {
    try { state.server.close(); } catch (_) {}
    state.server = null;
    state.started = false;
    console.log('[qq] QQ 音乐服务已关闭');
  }
}

function status() {
  return { running: state.started, port: state.port, baseUrl: state.baseUrl, error: state.lastError };
}

module.exports = { ensureStarted, shutdown, status, loadSessionToken, saveSessionToken };
