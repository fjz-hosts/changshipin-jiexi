'use strict'

const { contextBridge, ipcRenderer } = require('electron')

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('platformApi', {
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  sendToParse: (url, auto = true, focus = false) =>
    ipcRenderer.invoke('platform:send-to-parse', { url, auto, focus }),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  focusMain: () => ipcRenderer.invoke('app:focus-main'),
  onSearch: (callback) => on('platform:search', callback),
  onLoad: (callback) => on('platform:load', callback),
})
