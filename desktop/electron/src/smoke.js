'use strict'

/**
 * 打包前的自检（node 端）：`electron . --smoke-test`
 * 验证渲染进程能加载、preload 暴露正常、平台识别正确，
 * 并用本地测试服务器验证取流代理的播放列表改写与 Referer 透传。
 */

const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const { net, webContents } = require('electron')

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

async function waitFor(check, timeout = 8000, interval = 100) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  return null
}

async function runSmoke({ app, window, proxy, store }) {
  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok), detail })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  }

  // ---- 1. 渲染进程 ----
  if (window.webContents.isLoading()) {
    await new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
  }
  const ready = await waitFor(() => window.webContents.executeJavaScript('Boolean(window.__app && window.desktop)'))
  check('渲染进程初始化（window.desktop + window.__app）', ready)

  const title = await window.webContents.executeJavaScript('document.title')
  check('窗口标题', String(title).includes('长视频解析'), title)

  const cards = await window.webContents.executeJavaScript('document.querySelectorAll(".platform-card[data-platform]").length')
  check('四个平台快捷入口', cards === 4, String(cards))
  const picks = await window.webContents.executeJavaScript('document.querySelectorAll("#platform-picks .pick").length')
  check('找剧支持四个平台', picks === 4, String(picks))

  const detect = await window.webContents.executeJavaScript(`(() => {
    const cases = [
      ['https://www.iqiyi.com/v_b13ju3xx7s.html?lt=2', 'iqiyi'],
      ['https://v.qq.com/x/cover/mzc002001w361jz/x4102olnagg.html', 'qq'],
      ['https://v.youku.com/v_show/id_XNjU3MzkyOTA0NA==.html?spm=a2hkl', 'youku'],
      ['https://www.mgtv.com/b/817372/24769759.html?no_wakeup=1', 'mgtv'],
      ['https://example.com/video.mp4', null],
    ]
    return cases.map(([url, expected]) => ({ url, expected, actual: window.__app.detectPlatform(url) }))
  })()`)
  for (const item of detect) {
    check(`识别平台 ${item.expected || '未知'}`, item.actual === item.expected, `${item.actual}`)
  }

  const shell = await window.webContents.executeJavaScript(
    'document.querySelector("#url-input") !== null && document.querySelector("#btn-parse") !== null',
  )
  check('解析输入框与按钮', shell)

  // ---- 2. 取流代理 ----
  const received = { referer: '', ranges: [] }
  let segmentCounter = 0
  const testServer = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/test.m3u8') {
      const body = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
        '#EXTINF:4.0,',
        'seg1.ts',
        '#EXTINF:4.0,',
        `http://127.0.0.1:${testServer.address().port}/seg2.ts`,
        '#EXT-X-ENDLIST',
      ].join('\n')
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      response.end(body)
      return
    }
    if (url.pathname === '/seg1.ts' || url.pathname === '/seg2.ts') {
      segmentCounter += 1
      received.referer = String(request.headers.referer || '')
      received.ranges.push(String(request.headers.range || ''))
      response.writeHead(200, { 'content-type': 'video/mp2t' })
      response.end(`SEGMENT-${url.pathname}`)
      return
    }
    if (url.pathname === '/key.bin') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(Buffer.alloc(16, 7))
      return
    }
    if (url.pathname === '/video.mp4') {
      response.writeHead(200, { 'content-type': 'video/mp4' })
      response.end('MP4-DATA')
      return
    }
    response.writeHead(404)
    response.end('nope')
  })
  const testPort = await listen(testServer)
  const upstreamPlaylist = `http://127.0.0.1:${testPort}/test.m3u8`

  try {
    const proxied = proxy.resourceUrl(upstreamPlaylist, 'https://www.iqiyi.com/')
    const playlistResponse = await net.fetch(proxied)
    const playlistText = await playlistResponse.text()
    check('代理播放列表 200', playlistResponse.status === 200, `${playlistResponse.status} ${playlistText.slice(0, 120)}`)
    check('播放列表被改写为代理地址', playlistText.includes(`${proxy.base}/stream?t=`))
    check('播放列表不含原始相对地址', !/^seg1\.ts$/m.test(playlistText))
    check('密钥地址被改写', /#EXT-X-KEY:.*URI="http:\/\/127\.0\.0\.1:\d+\/stream\?/.test(playlistText))
    check('绝对分片地址被改写', !playlistText.includes(`127.0.0.1:${testPort}/seg2.ts`), '应只剩代理地址')

    const segmentUrl = playlistText
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith(proxy.base))
    if (!segmentUrl) {
      check('代理分片可播放', false, '播放列表里没有代理分片地址')
    } else {
      const segmentResponse = await net.fetch(segmentUrl)
      const segmentBody = await segmentResponse.text()
      check('代理分片可播放', segmentResponse.status === 200 && segmentBody.startsWith('SEGMENT-'), segmentBody)
      check('分片 Referer 透传', received.referer === upstreamPlaylist, received.referer)
    }

    const mp4 = await net.fetch(proxy.resourceUrl(`http://127.0.0.1:${testPort}/video.mp4`, 'https://v.qq.com/'))
    const mp4Body = await mp4.text()
    check('代理 mp4 透传', mp4.status === 200 && mp4Body === 'MP4-DATA')

    const denied = await net.fetch(proxy.resourceUrl(`http://127.0.0.1:${testPort}/video.mp4`).replace(/t=[a-f0-9]+/, 't=bad'))
    check('代理令牌校验', denied.status === 403, String(denied.status))
  } finally {
    testServer.close()
  }

  // ---- 3. 配置 ----
  const config = store.snapshot()
  check('配置含内置线路', Array.isArray(config.lines) && config.lines.length >= 5, `${config.lines.length} 条`)
  check('平台数配置一致', config.lines.filter((line) => line.enabled).length >= 1)

  // ---- 3.5 在线解析链路（可选，需要外网）----
  if (process.env.CHANGSPIN_SMOKE_ONLINE === '1') {
    const sample = 'https://www.iqiyi.com/v_b13ju3xx7s.html?lt=2'
    const parsed = await window.webContents.executeJavaScript(
      `window.desktop.parse({ url: ${JSON.stringify(sample)}, lineId: 'builtin-77flv' })`,
    )
    check('在线线路返回解析页', parsed?.ok === true && parsed.kind === 'page', JSON.stringify(parsed).slice(0, 180))
    if (parsed?.ok) {
      const loaded = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const wv = document.querySelector('#parse-view')
        const timer = setTimeout(() => resolve({ ok: false, error: '30s timeout' }), 30000)
        const done = () => { clearTimeout(timer); resolve({ ok: true, url: wv.getURL() }) }
        const fail = (event) => {
          if (!event.isMainFrame || event.errorCode === -3) return
          clearTimeout(timer)
          resolve({ ok: false, error: event.errorDescription || String(event.errorCode) })
        }
        wv.addEventListener('did-finish-load', done, { once: true })
        wv.addEventListener('did-fail-load', fail)
        wv.src = ${JSON.stringify(parsed.url)}
      })`)
      check('解析页在内置浏览器中打开', loaded?.ok === true, JSON.stringify(loaded).slice(0, 180))
      if (process.env.CHANGSPIN_SMOKE_SHOT) {
        window.showInactive()
        await window.webContents.executeJavaScript(
          "['empty','loading','error','video'].forEach((id) => { document.querySelector('#view-' + id).hidden = true }); document.querySelector('#view-webview').hidden = false",
        )
        await new Promise((resolve) => setTimeout(resolve, 4000))
        const pageInfo = await window.webContents.executeJavaScript(`(async () => {
          const wv = document.querySelector('#parse-view')
          const info = { url: '', title: '', text: '', frames: 0 }
          try { info.url = wv.getURL() } catch {}
          try { info.title = wv.getTitle() } catch {}
          try { info.ua = await wv.executeJavaScript('navigator.userAgent') } catch (e) { info.ua = 'ERR ' + e.message }
          try { info.frames = wv.getWebContentsId ? (wv.isLoading() ? -1 : 0) : 0 } catch {}
          try { info.text = String(await wv.executeJavaScript('document.body ? document.body.innerText.slice(0, 300) : "(no body)"')) } catch (e) { info.text = 'ERR ' + e.message }
          try {
            info.dom = await wv.executeJavaScript("({ htmlLen: document.documentElement.innerHTML.length, videos: [...document.querySelectorAll('video')].map(function (v) { return v.src || '' }), iframes: [...document.querySelectorAll('iframe')].map(function (f) { return f.src || '' }) })")
          } catch (e) { info.dom = { error: String(e.message) } }
          return info
        })()`)
        const domOk = Boolean(
          pageInfo.dom &&
            (pageInfo.dom.htmlLen > 800 ||
              (Array.isArray(pageInfo.dom.videos) && pageInfo.dom.videos.length) ||
              (Array.isArray(pageInfo.dom.iframes) && pageInfo.dom.iframes.length)),
        )
        check('解析页 DOM 正常', domOk, JSON.stringify(pageInfo.dom).slice(0, 300))
        check('解析页使用普通浏览器 UA', /Edg\//.test(String(pageInfo.ua || '')) && !/Electron/i.test(String(pageInfo.ua || '')), String(pageInfo.ua).slice(0, 80))
        try {
          const wvId = await window.webContents.executeJavaScript("document.querySelector('#parse-view').getWebContentsId()")
          const wvContents = webContents.fromId(wvId)
          const frames = wvContents.mainFrame.framesInSubtree
          const reports = []
          for (const frame of frames.slice(1)) {
            try {
              const result = await frame.executeJavaScript(
                '({ title: document.title, hasVideo: Boolean(document.querySelector("video")), textLen: document.body ? document.body.innerText.length : 0 })',
              )
              reports.push({ url: frame.url, ...result })
            } catch (error) {
              reports.push({ url: frame.url, error: String(error?.message || error).slice(0, 80) })
            }
          }
          check('解析页内嵌播放器已加载', reports.some((item) => item.hasVideo || item.textLen > 0), JSON.stringify(reports).slice(0, 400))
        } catch (error) {
          check('解析页内嵌播放器已加载', false, String(error?.message || error).slice(0, 160))
        }
        try {
          const image = await window.webContents.capturePage()
          const parseShot = process.env.CHANGSPIN_SMOKE_SHOT.replace(/\.png$/i, '-parse.png')
          fs.writeFileSync(parseShot, image.toPNG())
          check('解析页截图已保存', true, parseShot)
        } catch (error) {
          check('解析页截图已保存', false, String(error?.message || error))
        }
        try {
          const inner = await window.webContents.executeJavaScript(
            "(async () => { const wv = document.querySelector('#parse-view'); const img = await wv.capturePage(); return img.toDataURL() })()",
          )
          const base64 = String(inner || '').replace(/^data:image\/png;base64,/, '')
          const innerShot = process.env.CHANGSPIN_SMOKE_SHOT.replace(/\.png$/i, '-webview.png')
          fs.writeFileSync(innerShot, Buffer.from(base64, 'base64'))
          check('webview 自身截图已保存', true, innerShot)
        } catch (error) {
          check('webview 自身截图已保存', false, String(error?.message || error))
        }
      }
      try {
        window.webContents.executeJavaScript("document.querySelector('#parse-view').stop()")
      } catch {
        /* 忽略 */
      }
    }
  }

  // ---- 4. 截图（可选） ----
  const shotPath = process.env.CHANGSPIN_SMOKE_SHOT
  if (shotPath) {
    window.showInactive()
    await new Promise((resolve) => setTimeout(resolve, 900))
    try {
      const image = await window.webContents.capturePage()
      fs.mkdirSync(path.dirname(shotPath), { recursive: true })
      fs.writeFileSync(shotPath, image.toPNG())
      check('界面截图已保存', true, shotPath)
    } catch (error) {
      check('界面截图已保存', false, String(error?.message || error))
    }
  }

  const failed = checks.filter((item) => !item.ok).length
  return { checks, failed, passed: checks.length - failed }
}

module.exports = { runSmoke }
