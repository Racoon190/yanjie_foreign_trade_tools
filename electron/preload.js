'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('desktop', {
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
  close: () => ipcRenderer.send('win:close'),
  isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  toggleFullscreen: () => ipcRenderer.invoke('win:toggle-fullscreen'),
  getInfo: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  showItemInFolder: (filePath) => ipcRenderer.invoke('app:show-item', filePath),
  getFxRates: () => ipcRenderer.invoke('fx:rates'),
  exportQuotePdf: (payload) => ipcRenderer.invoke('quote:export-pdf', payload),
  exportQuoteExcel: (payload) => ipcRenderer.invoke('quote:export-excel', payload),
  showWebviewMenu: (params) => ipcRenderer.send('menu:webview', params),
  onWindowState: (callback) => subscribe('window:state', callback),
  onShortcut: (callback) => subscribe('app:shortcut', callback),
  onDownloadComplete: (callback) => subscribe('app:download-complete', callback),
});

contextBridge.exposeInMainWorld('deepseekApi', {
  getConfig: () => ipcRenderer.invoke('deepseek:config'),
  saveConfig: (payload) => ipcRenderer.invoke('deepseek:save-config', payload),
  testConnection: () => ipcRenderer.invoke('deepseek:test'),
  chat: (payload) => ipcRenderer.send('deepseek:chat', payload),
  abort: (requestId) => ipcRenderer.send('deepseek:abort', requestId),
  onEvent: (callback) => subscribe('deepseek:event', callback),
});
