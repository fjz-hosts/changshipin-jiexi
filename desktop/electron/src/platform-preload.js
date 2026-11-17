'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('platformApi', {
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  sendToParse: (url, auto = true) => ipcRenderer.invoke('platform:send-to-parse', { url, auto }),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
})
