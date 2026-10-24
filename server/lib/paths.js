'use strict';
/**
 * 数据目录解析（开发 / 打包环境统一入口）
 *
 * 打包后应用装在 C:\Program Files 等只读目录，程序自身的 __dirname 不可写；
 * 数据（设置、缓存、加密账号、本地歌单）必须落在用户目录：
 *   Electron 生产环境： %APPDATA%/极光音乐/data  （app.getPath('userData')）
 *   开发环境（node / 未打包 electron）： 项目根 data/
 *
 * main.js 会在 require server 之前设置 AURORA_DATA_DIR，这里只读取。
 */

const path = require('path');

const DATA_DIR = process.env.AURORA_DATA_DIR
  ? path.resolve(process.env.AURORA_DATA_DIR)
  : path.join(__dirname, '..', '..', 'data');

function ensureDataDir() {
  try {
    const fs = require('fs');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (_) {}
  return DATA_DIR;
}

function fileInData(...names) {
  return path.join(DATA_DIR, ...names);
}

module.exports = { DATA_DIR, ensureDataDir, fileInData };
