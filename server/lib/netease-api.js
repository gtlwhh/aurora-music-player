'use strict';
/**
 * 内置网易云 API 服务
 *
 * 基于 NeteaseCloudMusicApi（MIT）在本地拉起一个 API 进程，
 * 让播放器开箱即用，不需要用户自己去部署。
 * 它只负责代理网易云的公开接口，不修改、不破解任何内容。
 */

let serveNcmApi = null;
let apiApp = null;
let apiPort = 0;
let starting = null;
let lastError = '';

const fs = require('fs');
const path = require('path');

/**
 * NeteaseCloudMusicApi 会在 os.tmpdir() 下读写 anonymous_token。
 * 统一指到项目的 data/tmp，避免污染系统临时目录，也规避某些受限环境。
 */
function prepareTmpDir() {
  try {
    const dir = require('./paths').fileInData('tmp');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    process.env.TEMP = dir;
    process.env.TMP = dir;
    process.env.TMPDIR = dir;
    // 预先建好，NeteaseCloudMusicApi 加载时会检查这个文件
    const tokenPath = path.join(dir, 'anonymous_token');
    if (!fs.existsSync(tokenPath)) {
      fs.writeFileSync(tokenPath, '', 'utf-8');
    }
    return dir;
  } catch (err) {
    console.warn('[netease] 临时目录准备失败:', err.message);
    return null;
  }
}

/** 懒加载，避免没装依赖时整个服务起不来 */
function loadModule() {
  if (serveNcmApi !== null) return true;
  try {
    prepareTmpDir();
    const mod = require('NeteaseCloudMusicApi/server');
    serveNcmApi = mod.serveNcmApi;
    return true;
  } catch (err) {
    lastError = err.code === 'MODULE_NOT_FOUND'
      ? '未安装网易云 API 依赖'
      : err.message;
    return false;
  }
}

/** 探测端口是否可用（serveNcmApi 内部 listen 失败会抛未捕获异常，必须先探） */
function isPortFree(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    try { srv.listen(port, '127.0.0.1'); } catch (_) { resolve(false); }
  });
}

/**
 * 启动内置 API（幂等，多次调用返回同一个实例）
 * @param {number} preferredPort
 * @returns {Promise<{ok:boolean, port?:number, baseUrl?:string, error?:string}>}
 */
async function ensureStarted(preferredPort = 3000) {
  if (apiApp) return { ok: true, port: apiPort, baseUrl: `http://127.0.0.1:${apiPort}` };
  if (starting) return starting;

  starting = (async () => {
    if (!loadModule()) {
      return { ok: false, error: lastError || '网易云 API 不可用' };
    }

    for (let port = preferredPort; port < preferredPort + 10; port++) {
      const free = await isPortFree(port);
      if (!free) {
        // 有可能上一步的实例还在监听，直接当成就绪
        if (port === preferredPort) {
          try {
            const probe = await fetch(`http://127.0.0.1:${port}/search?keywords=test&limit=1`,
              { signal: AbortSignal.timeout(2500) });
            if (probe.ok) {
              apiPort = port;
              apiApp = { reused: true };
              console.log(`[netease] 复用已运行的音源服务: http://127.0.0.1:${port}`);
              return { ok: true, port, baseUrl: `http://127.0.0.1:${port}`, reused: true };
            }
          } catch (_) {}
        }
        continue;
      }

      try {
        const app = await serveNcmApi({
          port,
          host: '127.0.0.1',
          checkVersion: false
        });
        apiApp = app;
        apiPort = port;
        console.log(`[netease] 内置音源服务已启动: http://127.0.0.1:${port}`);
        return { ok: true, port, baseUrl: `http://127.0.0.1:${port}` };
      } catch (err) {
        lastError = err ? err.message : '未知错误';
        console.error('[netease] 启动失败:', lastError);
      }
    }
    return { ok: false, error: lastError || '端口都被占用' };
  })();

  const result = await starting;
  starting = null;
  if (!result.ok) apiApp = null;
  return result;
}

function status() {
  return {
    running: !!apiApp,
    port: apiPort,
    baseUrl: apiApp ? `http://127.0.0.1:${apiPort}` : '',
    error: lastError
  };
}

module.exports = { ensureStarted, status };
