'use strict'

/**
 * 本地流媒体代理。
 *
 * 第三方解析接口给出的 m3u8 / mp4 地址通常校验 Referer 和 UA，
 * 直接丢给 <video> 会因为跨域和防盗链播不出来。这里在 127.0.0.1 上开一个
 * 只带随机令牌的小服务，由主进程带正确的请求头取流；HLS 播放列表里的
 * 分片、密钥、子列表地址都会被改写成代理地址，因此播放器只需要面对本机。
 */

const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { net, session } = require('electron')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024
const STREAM_PATHS = new Set(['/stream', '/stream.m3u8', '/stream.mp4'])

class StreamProxy {
  constructor() {
    this.server = null
    this.port = 0
    this.token = crypto.randomBytes(9).toString('hex')
    this.session = null
    this.hlsBody = null
  }

  get base() {
    return `http://127.0.0.1:${this.port}`
  }

  async start() {
    this.session = session.fromPartition('persist:parse')
    // Chromium 的 net 模块不允许直接 setHeader('Referer')（会被 ERR_BLOCKED_BY_CLIENT 拦掉），
    // 所以先用自定义头把 Referer 带进去，再在 webRequest 层替换成真正的 Referer。
    this.session.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = details.requestHeaders
      const referer = headers['X-Proxy-Referer'] || headers['x-proxy-referer']
      if (referer) {
        headers.Referer = referer
        delete headers['X-Proxy-Referer']
        delete headers['x-proxy-referer']
      }
      const cookie = headers['X-Proxy-Cookie'] || headers['x-proxy-cookie']
      if (cookie) {
        headers.Cookie = cookie
        delete headers['X-Proxy-Cookie']
        delete headers['x-proxy-cookie']
      }
      callback({ requestHeaders: headers })
    })
    await new Promise((resolve, reject) => {
      this.server = http.createServer((request, response) => {
        this._handle(request, response).catch((error) => {
          console.error('[proxy] 请求失败', request.url, error)
          this._fail(response, 502, String(error?.message || error))
        })
      })
      this.server.once('error', reject)
      // 监听 0.0.0.0 是为了投屏：电视要能直接访问这个代理。
      // 令牌是随机的，本机播放仍然用 127.0.0.1。
      this.server.listen(0, '0.0.0.0', () => {
        this.port = this.server.address().port
        resolve(this)
      })
    })
    return this
  }

  stop() {
    try {
      this.server?.close()
    } catch {
      /* 忽略 */
    }
    this.server = null
  }

  resourceUrl(target, referer = '', cookie = '', host = '') {
    const search = new URLSearchParams()
    search.set('t', this.token)
    search.set('u', Buffer.from(String(target), 'utf8').toString('base64url'))
    if (referer) search.set('r', Buffer.from(String(referer), 'utf8').toString('base64url'))
    if (cookie) search.set('c', Buffer.from(String(cookie), 'utf8').toString('base64url'))
    const origin = host ? `http://${host}` : this.base
    return `${origin}/stream?${search.toString()}`
  }

  async _handle(request, response) {
    const url = new URL(request.url, this.base)
    if (url.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok')
      return
    }
    if (url.pathname === '/mirror') {
      if (url.searchParams.get('t') !== this.token) {
        this._fail(response, 403, 'forbidden')
        return
      }
      this._serveMirror(response, url)
      return
    }
    if (url.pathname === '/hls.min.js') {
      this._serveHls(response)
      return
    }
    if (!STREAM_PATHS.has(url.pathname)) {
      this._fail(response, 404, 'not found')
      return
    }
    if (url.searchParams.get('t') !== this.token) {
      this._fail(response, 403, 'forbidden')
      return
    }
    const target = this._decode(url.searchParams.get('u'))
    if (!/^https?:\/\//i.test(target)) {
      this._fail(response, 400, 'bad target')
      return
    }
    const referer = this._decode(url.searchParams.get('r')) || ''
    const cookie = this._decode(url.searchParams.get('c')) || ''
    // 播放列表里的相对地址要改回「请求者看到的地址」：本机播放是 127.0.0.1，
    // 电视投屏是这个局域网地址，这样才能各自拉到分片。
    const origin = this._originOf(request)
    await this._pipe(request, response, target, referer, cookie, origin)
  }

  _originOf(request) {
    const host = String(request.headers.host || '').trim()
    if (/^[A-Za-z0-9.\-:[\]]{1,80}$/.test(host)) return host
    return `127.0.0.1:${this.port}`
  }

  _serveHls(response) {
    if (!this.hlsBody) {
      try {
        this.hlsBody = fs.readFileSync(path.join(__dirname, 'renderer', 'vendor', 'hls.min.js'))
      } catch {
        this.hlsBody = null
      }
    }
    if (!this.hlsBody) {
      this._fail(response, 404, 'hls.js not found')
      return
    }
    response.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'content-length': this.hlsBody.length,
      'cache-control': 'no-cache',
    })
    response.end(this.hlsBody)
  }

  /**
   * 给电视 / 平板 / 笔记本的浏览器用的播放页：打开就能播当前画面。
   * 页面里的地址都是相对路径，所以只要设备能打开这个 IP，就能自己拉流。
   */
  _serveMirror(response, url) {
    const rawTitle = String(url.searchParams.get('n') || '').slice(0, 120)
    const title = rawTitle || '视频解析投屏'
    const isHls = url.searchParams.get('ty') === 'hls'
    const html = mirrorPageHtml(title, isHls)
    const buffer = Buffer.from(html, 'utf8')
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': buffer.length,
      'cache-control': 'no-store',
    })
    response.end(buffer)
  }


  _decode(value) {
    if (!value) return ''
    try {
      return Buffer.from(value, 'base64url').toString('utf8')
    } catch {
      return ''
    }
  }

  _fail(response, status, message) {
    if (response.headersSent) {
      response.destroy()
      return
    }
    response.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'access-control-allow-origin': '*',
    })
    response.end(message)
  }

  _request(target, headers, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const request = net.request({
        method: 'GET',
        url: target,
        redirect: 'follow',
        session: this.session,
      })
      for (const [key, value] of Object.entries(headers)) {
        try {
          request.setHeader(key, value)
        } catch {
          /* 个别头 Chromium 不接受，忽略 */
        }
      }
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          request.abort()
        } catch {
          /* 忽略 */
        }
        reject(new Error('上游取流超时'))
      }, timeoutMs)
      request.on('response', (upstream) => {
        clearTimeout(timer)
        if (settled) {
          upstream.destroy?.()
          return
        }
        settled = true
        resolve(upstream)
      })
      request.on('error', (error) => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        reject(error)
      })
      request.end()
    })
  }

  _rewritePlaylist(text, baseUrl, cookie = '', referer = '', origin = '') {
    const proxy = this
    const rewrite = (relative) => {
      try {
        const absolute = new URL(relative, baseUrl).href
        return proxy.resourceUrl(absolute, referer || baseUrl, cookie, origin)
      } catch {
        return relative
      }
    }
    return text
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim()
        if (!trimmed) return line
        if (trimmed.startsWith('#')) {
          return trimmed.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${rewrite(uri)}"`)
        }
        return rewrite(trimmed)
      })
      .join('\n')
  }

  async _pipe(request, response, target, referer, cookie = '', origin = '') {
    const headers = {
      'user-agent': UA,
      accept: '*/*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
      'accept-encoding': 'identity',
    }
    if (referer) headers['X-Proxy-Referer'] = referer.replace(/[^\x20-\x7e]/g, '')
    if (cookie) headers['X-Proxy-Cookie'] = cookie.replace(/[\r\n]/g, '')
    if (request.headers.range) headers.range = request.headers.range

    const upstream = await this._request(target, headers, /m3u8/i.test(target) ? 90000 : 30000)
    const status = upstream.statusCode || 200
    const contentType = String(upstream.headers['content-type'] || '')
    const isPlaylist = /mpegurl/i.test(contentType) || /\.m3u8/i.test(target) || /\/m3u8\//i.test(target)

    const outHeaders = {
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges',
      'access-control-allow-headers': '*',
    }
    for (const key of ['content-type', 'content-range', 'accept-ranges', 'content-length', 'etag', 'last-modified']) {
      if (upstream.headers[key]) outHeaders[key] = upstream.headers[key]
    }

    if (isPlaylist) {
      const chunks = []
      let total = 0
      try {
        await new Promise((resolve, reject) => {
          upstream.on('data', (chunk) => {
            total += chunk.length
            if (total > MAX_PLAYLIST_BYTES) {
              reject(new Error('播放列表过大'))
              return
            }
            chunks.push(chunk)
          })
          upstream.on('end', resolve)
          upstream.on('error', reject)
        })
      } catch (error) {
        this._fail(response, 502, String(error?.message || error))
        return
      }
      const body = Buffer.concat(chunks).toString('utf8')
      const rewritten = body.trimStart().startsWith('#EXTM3U')
        ? this._rewritePlaylist(body, target, cookie, referer, origin)
        : body
      const buffer = Buffer.from(rewritten, 'utf8')
      delete outHeaders['content-length']
      delete outHeaders['accept-ranges']
      outHeaders['content-length'] = buffer.length
      if (!outHeaders['content-type']) outHeaders['content-type'] = 'application/vnd.apple.mpegurl'
      response.writeHead(status, outHeaders)
      response.end(buffer)
      return
    }

    response.writeHead(status, outHeaders)
    upstream.on('error', () => {
      response.destroy()
    })
    upstream.pipe(response)
  }
}

function mirrorEscape(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 电视 / 平板 / 笔记本浏览器里的播放页。
 * 只用相对地址（/stream、/hls.min.js），所以页面在任何局域网设备上打开都能自己拉流。
 */
function mirrorPageHtml(title, isHls) {
  const safeTitle = mirrorEscape(title || '视频解析投屏')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle} · 视频解析投屏</title>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; background: #05080e; color: #e9eef7; font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; }
  body { display: flex; flex-direction: column; }
  header { flex: none; display: flex; align-items: center; gap: 10px; padding: 14px 22px; border-bottom: 1px solid rgba(255,255,255,.08); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #37e08b; box-shadow: 0 0 12px #37e08b; }
  .name { font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { margin-left: auto; flex: none; padding: 4px 10px; border-radius: 999px; font-size: 12px; color: #37e08b; border: 1px solid rgba(55,224,139,.42); background: rgba(55,224,139,.08); }
  .player { position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; background: #000; }
  video { width: 100%; height: 100%; object-fit: contain; background: #000; }
  .start { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); padding: 16px 34px; border-radius: 999px; border: 1px solid rgba(255,255,255,.28); background: rgba(10,17,28,.86); color: #fff; font-size: 18px; cursor: pointer; letter-spacing: 1px; }
  .start:hover { border-color: #37e08b; color: #37e08b; }
  .tip { position: absolute; left: 50%; bottom: 26px; transform: translateX(-50%); max-width: 86%; padding: 10px 16px; border-radius: 10px; background: rgba(255,100,112,.14); border: 1px solid rgba(255,100,112,.4); color: #ffb2b8; font-size: 13px; line-height: 1.7; }
  footer { flex: none; padding: 10px 22px 14px; font-size: 12px; color: rgba(233,238,247,.5); }
</style>
</head>
<body>
<header>
  <span class="dot"></span>
  <span class="name">${safeTitle}</span>
  <span class="badge">投屏播放</span>
</header>
<div class="player">
  <video id="video" controls playsinline preload="metadata"></video>
  <button class="start" id="start" type="button">▶ 点击播放</button>
  <div class="tip" id="tip" hidden></div>
</div>
<footer>由电脑上的「视频解析」投屏 · 请保持电脑端程序运行并停留在当前视频，关闭后本页会停止播放</footer>
<script src="/hls.min.js"></script>
<script>
(function () {
  var params = new URLSearchParams(location.search)
  var hlsMode = params.get('ty') === 'hls'
  params.delete('n')
  params.delete('ty')
  var src = '/stream?' + params.toString()
  var video = document.getElementById('video')
  var start = document.getElementById('start')
  var tip = document.getElementById('tip')
  var hls = null
  function showTip(text) { tip.hidden = false; tip.textContent = text }
  function begin() {
    start.hidden = true
    var playing = video.play()
    if (playing && playing.catch) playing.catch(function () { start.hidden = false })
  }
  start.addEventListener('click', begin)
  video.addEventListener('play', function () { start.hidden = true })
  video.addEventListener('error', function () {
    if (hls) return
    showTip('视频加载失败：请确认电脑端还在播放这个视频，并且程序没有退出')
  })
  if (hlsMode && !video.canPlayType('application/vnd.apple.mpegurl')) {
    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({ enableWorker: false, maxBufferLength: 30, backBufferLength: 30 })
      hls.on(window.Hls.Events.ERROR, function (event, data) {
        if (data && data.fatal) showTip('视频流加载失败：' + (data.details || '未知错误'))
      })
      hls.attachMedia(video)
      hls.loadSource(src)
    } else {
      showTip('这个浏览器不支持 HLS 播放，请换用电视自带浏览器或支持 HLS 的设备')
    }
  } else {
    video.src = src
  }
  window.addEventListener('beforeunload', function () { if (hls) hls.destroy() })
})()
</script>
</body>
</html>`
}

module.exports = { StreamProxy, mirrorPageHtml }
