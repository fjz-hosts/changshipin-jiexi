/* 开发用：用 Electron 的 Chromium 以手机尺寸加载移动端页面并截图。
   用法（在项目根目录）：
     Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
     desktop\electron\node_modules\.bin\electron.cmd mobile\dev\main.js --width 390 --height 844 --out .tmp\mobile-390.png
*/
'use strict'

const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const args = process.argv.slice(2)
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`)
  if (index < 0) return fallback
  return args[index + 1] || fallback
}

const width = Number(arg('width', 390))
const height = Number(arg('height', 844))
const out = path.resolve(arg('out', '.tmp/mobile.png'))
const seed = arg('seed', '')
const action = arg('action', '')
const video = arg('video', '')

app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.setName('changshipin-mobile-dev')
app.setPath('userData', path.resolve('.tmp/mobile-dev-userdata'))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width,
    height,
    show: true,
    backgroundColor: '#05080e',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      backgroundThrottling: false,
    },
  })
  win.setContentSize(width, height)
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
  })
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[preload-error]', preloadPath, error)
  })
  await win.loadFile(path.join(__dirname, '..', 'www', 'index.html'))
  if (seed) {
    await win.webContents.executeJavaScript(`localStorage.setItem('csp.config.v1', ${JSON.stringify(seed)}); location.reload()`)
    await new Promise((resolve) => setTimeout(resolve, 1800))
  }
  await new Promise((resolve) => setTimeout(resolve, 1600))
  if (video) {
    await win.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('.stage-view').forEach((node) => { node.hidden = true })
      document.querySelector('#view-video').hidden = false
      document.querySelector('#stage').classList.add('stage-playing')
      const v = document.querySelector('#video')
      v.src = ${JSON.stringify('file:///' + video.replace(/\\/g, '/'))}
      v.load()
      v.play().catch(() => {})
      return true
    })()`)
    await new Promise((resolve) => setTimeout(resolve, 1400))
  }
  if (action) {
    try {
      await win.webContents.executeJavaScript(action)
      await new Promise((resolve) => setTimeout(resolve, 700))
    } catch (error) {
      console.log('action failed:', error?.message || error)
    }
  }
  if (arg('show-controls', '')) {
    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('.player-controls')?.classList.add('visible')
      document.querySelector('.video-gesture-layer')?.classList.add('controls-visible')
      return true
    })()`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const probe = await win.webContents.executeJavaScript(`JSON.stringify({
    versionText: Boolean(document.querySelector('#version-text')),
    statusText: Boolean(document.querySelector('#status-text')),
    feedList: Boolean(document.querySelector('#feed-list')),
    tabbar: Boolean(document.querySelector('#mobile-tabbar')),
    video: (() => { const v = document.querySelector('#video'); return v ? { readyState: v.readyState, duration: v.duration, paused: v.paused, error: v.error && v.error.code, src: v.currentSrc } : null })(),
    stageClass: document.querySelector('#stage')?.className,
    scripts: Array.from(document.scripts).map((s) => s.src.split('/').slice(-2).join('/')),
    tail: document.body.innerHTML.slice(-300)
  })`)
  console.log('probe:', probe)
  const image = await win.webContents.capturePage()
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, image.toPNG())
  console.log('screenshot:', out, image.getSize())
  app.quit()
})
