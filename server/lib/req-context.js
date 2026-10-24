'use strict';
/**
 * req-context.js · 每请求凭证上下文（AsyncLocalStorage）
 *
 * 这是"账号串号"灾难的根治方案：
 *   此前客户端透传的 cookie/token 被写进 provider 单例的实例字段
 *   （neteaseProvider._rtCookie / qqProviderInstance._tokenCache）。
 *   两个用户并发请求时，后到的请求会覆盖先到的值，
 *   先到的请求在异步等待期间读到别人的凭证 → 账号串流。
 *
 * 现在凭证只存在于**当前请求的异步上下文**里：
 *   http 入口用 als.run({ ncm, qq }, ...) 包住整个路由处理，
 *   provider 在任意深度 await 之后读 ctxCredential('ncm'|'qq')，
 *   拿到的一定是"自己这次请求"带来的凭证，用完即弃，互不可见。
 *
 * 桌面端（Electron 单用户）不带透传头时 ctx 为空对象，
 * provider 自然回退到本地加密存储，行为不变。
 */

const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();

/** 读取当前请求透传的凭证（'ncm' | 'qq'），不在请求上下文中返回 '' */
function ctxCredential(kind) {
  const store = als.getStore();
  return (store && store[kind]) || '';
}

module.exports = { als, ctxCredential };
