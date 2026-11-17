'use strict'

/**
 * 开发用探针：把候选解析线路逐个放进 webview，检查最终的播放器 iframe 里
 * 是否真的出现了 <video>。用来挑选内置线路，不参与打包。
 *
 * 运行：electron tools/webview-probe（需要图形环境与外网）
 */

const { app, BrowserWindow, session, webContents } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { UA, DEFAULT_LINES, buildLineUrl } = require('../../desktop/electron/src/lines')

const VIDEO_URL = process.env.PROBE_VIDEO || 'https://www.iqiyi.com/v_b13ju3xx7s.html?lt=2'
const WAIT_AFTER_LOAD = Number(process.env.PROBE_WAIT || 9000)
const OUTPUT = path.join(__dirname, 'probe-result.json')
const SHOTS = path.join(__dirname, 'shots')

const only = process.env.PROBE_LINES ? new Set(process.env.PROBE_LINES.split(',')) : null
const lines = DEFAULT_LINES.filter((line) => line.kind !== 'direct' && (!only || only.has(line.id)))

app.userAgentFallback = UA
app.on('certificate-error', (event, contents, url, error, certificate, callback) => {
  event.preventDefault()
  callback(true)
})
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []

app.whenReady().then(async () => {
  fs.mkdirSync(SHOTS, { recursive: true })
  session.fromPartition('persist:parse').setUserAgent(UA)
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  await win.loadFile(path.join(__dirname, 'page.html'))
  await sleep(1200)

  for (const line of lines) {
    const target = buildLineUrl(line.url, VIDEO_URL)
    const started = Date.now()
    const record = { id: line.id, name: line.name, target, ok: false, error: '', frames: [], videos: [], titles: [] }
    try {
      const loadJson = await win.webContents.executeJavaScript(`(async () => {
        const wv = document.querySelector('#wv')
        return await new Promise((resolve) => {
          let done = false
          const finish = (value) => { if (done) return; done = true; clearTimeout(timer); resolve(JSON.stringify(value)) }
          const timer = setTimeout(() => finish({ ok: false, error: '25s timeout' }), 25000)
          wv.addEventListener('did-finish-load', () => finish({ ok: true }), { once: true })
          wv.addEventListener('did-fail-load', (event) => {
            if (event.isMainFrame && event.errorCode !== -3) finish({ ok: false, error: event.errorDescription || String(event.errorCode) })
          })
          wv.src = ${JSON.stringify(target)}
        })
      })()`)
      record.load = JSON.parse(loadJson)
      await sleep(WAIT_AFTER_LOAD)

      const snapJson = await win.webContents.executeJavaScript(`(() => {
        const wv = document.querySelector('#wv')
        return JSON.stringify({ wvId: wv.getWebContentsId(), title: wv.getTitle(), current: wv.getURL() })
      })()`)
      const snapshot = JSON.parse(snapJson)
      record.title = snapshot.title
      record.current = snapshot.current
      const contents = webContents.fromId(snapshot.wvId)
      const frames = contents.mainFrame.framesInSubtree
      record.frameCount = frames.length
      for (const frame of frames) {
        const item = { url: String(frame.url).slice(0, 220) }
        try {
          const infoJson = await frame.executeJavaScript(`JSON.stringify((() => {
            const videos = [...document.querySelectorAll('video')].map((v) => ({
              src: (v.currentSrc || v.src || '').slice(0, 160),
              readyState: v.readyState,
              duration: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
              paused: v.paused,
              w: v.videoWidth,
              h: v.videoHeight
            }))
            return { title: document.title, text: (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 160), videos, iframes: [...document.querySelectorAll('iframe')].map((f) => f.src).slice(0, 4) }
          })())`)
          Object.assign(item, JSON.parse(infoJson))
        } catch (error) {
          item.error = String(error?.message || error).slice(0, 100)
        }
        record.frames.push(item)
        record.videos.push(...(item.videos || []).map((v) => ({ frame: item.url.slice(0, 80), ...v })))
        if (item.title) record.titles.push(item.title)
      }
      record.ok = record.videos.length > 0
      try {
        const dataUrl = await win.webContents.executeJavaScript(
          "(async () => { const wv = document.querySelector('#wv'); const img = await wv.capturePage(); return img.toDataURL() })()",
        )
        const file = path.join(SHOTS, `${line.id}.png`)
        fs.writeFileSync(file, Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64'))
        record.screenshot = file
      } catch (error) {
        record.screenshotError = String(error?.message || error)
      }
    } catch (error) {
      record.error = String(error?.message || error).slice(0, 200)
    }
    record.ms = Date.now() - started
    results.push(record)
    console.log(`\n[${line.name}] ok=${record.ok} frames=${record.frameCount || 0} videos=${record.videos.length} title=${record.title} ${record.error || ''} ${record.load ? JSON.stringify(record.load) : ''}`)
    for (const frame of record.frames) {
      console.log('   frame:', frame.url, '|', frame.title || '', '| videos:', (frame.videos || []).length, '| text:', (frame.text || '').slice(0, 60))
    }
    try {
      await win.webContents.executeJavaScript("document.querySelector('#wv').stop()")
    } catch {
      /* 忽略 */
    }
    fs.writeFileSync(OUTPUT, JSON.stringify(results, null, 2))
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(results, null, 2))
  console.log('\nRESULT FILE:', OUTPUT)
  app.exit(0)
})
