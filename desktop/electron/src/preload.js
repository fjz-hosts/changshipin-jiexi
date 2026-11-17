'use strict'

const { contextBridge, ipcRenderer } = require('electron')

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('desktop', {
  info: () => ipcRenderer.invoke('app:info'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveLines: (lines, defaultLineId) => ipcRenderer.invoke('lines:save', { lines, defaultLineId }),
  resetLines: () => ipcRenderer.invoke('lines:reset'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  addHistory: (entry) => ipcRenderer.invoke('history:add', entry),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  parse: (payload) => ipcRenderer.invoke('parse:run', payload),
  testLines: (payload) => ipcRenderer.invoke('lines:test', payload),
  updateLinesOnline: () => ipcRenderer.invoke('lines:online'),
  openPlatform: (key) => ipcRenderer.invoke('platform:open', key),
  openPlatformSite: (key) => ipcRenderer.invoke('platform:open-site', key),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  openUserData: () => ipcRenderer.invoke('app:open-userdata'),
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  about: () => ipcRenderer.invoke('app:about'),
  toggleFullscreen: () => ipcRenderer.invoke('app:toggle-fullscreen'),
  quit: () => ipcRenderer.invoke('app:quit'),
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateState: (callback) => on('update:state', callback),
  onReady: (callback) => on('app:ready', callback),
  onPasteParse: (callback) => on('app:paste-parse', callback),
  onNextLine: (callback) => on('app:next-line', callback),
  onReload: (callback) => on('app:reload', callback),
  onOpenExternal: (callback) => on('app:open-external', callback),
  onExternalParse: (callback) => on('app:external-parse', callback),
  onFullscreen: (callback) => on('window:fullscreen', callback),
})
