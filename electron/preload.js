'use strict';
/**
 * 预加载脚本：把安全的桌面能力暴露给页面
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('auroraDesktop', {
  isDesktop: true,
  platform: process.platform,

  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
  close: () => ipcRenderer.send('win:close'),
  isMaximized: () => ipcRenderer.invoke('win:is-maximized'),

  getInfo: () => ipcRenderer.invoke('app:info'),

  onMaxState: (fn) => {
    const handler = (_e, v) => fn(v);
    ipcRenderer.on('win:max-state', handler);
    return () => ipcRenderer.removeListener('win:max-state', handler);
  },
  onServerError: (fn) => {
    const handler = (_e, msg) => fn(msg);
    ipcRenderer.on('app:server-error', handler);
    return () => ipcRenderer.removeListener('app:server-error', handler);
  }
});
