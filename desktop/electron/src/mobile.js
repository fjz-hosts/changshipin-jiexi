'use strict'

/**
 * 手机版下载 · 局域网直传 + 镜像缓存
 *
 * 桌面端先从国内镜像把手机版安装包下载到 userData/mobile 缓存，
 * 再在同一 Wi-Fi 下用临时 HTTP 服务把文件直传给手机；手机也可以扫码
 * 打开云端镜像落地页。服务只暴露下面这几个只读路由，不做任意代理。
 */

const http = require('node:http')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const REPO = 'https://github.com/fjz-hosts/changshipin-jiexi'

let cachedIconDataUrl = null

/** 手机落地页/下载页统一用应用图标（和桌面端、手机桌面图标同一张图）。 */
function appIconDataUrl() {
  if (cachedIconDataUrl !== null) return cachedIconDataUrl
  try {
    const iconPath = path.join(__dirname, 'renderer', 'assets', 'app-icon.png')
    cachedIconDataUrl = `data:image/png;base64,${fs.readFileSync(iconPath).toString('base64')}`
  } catch {
    cachedIconDataUrl = ''
  }
  return cachedIconDataUrl
}

const MIRRORS = [
  'https://gh.monlor.com/https://github.com/fjz-hosts/changshipin-jiexi',
  'https://gh-proxy.com/https://github.com/fjz-hosts/changshipin-jiexi',
  'https://ghfile.geekertao.top/https://github.com/fjz-hosts/changshipin-jiexi',
  'https://hk.gh-proxy.com/https://github.com/fjz-hosts/changshipin-jiexi',
  REPO,
]

// 发布产物固定文件名；latest-mobile.json 是可选的，不存在也不影响下载。
const FILES = {
  android: { name: 'changshipin-android.apk', label: 'Android APK' },
  ios: { name: 'changshipin-ios-unsigned.ipa', label: 'iOS 免签名 IPA' },
}
const PLATFORMS = ['android', 'ios']
const DOWNLOAD_TIMEOUT = 10 * 60 * 1000
const DOWNLOAD_UA = 'changshipin-desktop-mobile-fetcher/1.0'

// 虚拟网卡 / 回环网卡不参与「局域网 IP」挑选，否则二维码可能指向 docker / WSL 地址。
const VIRTUAL_NAME = /veth|vethernet|virtual|vmware|virtualbox|vbox|hyper-v|docker|virbr|br-|tap|tun|tailscale|zerotier|wsl|loopback|bluetooth|npcap|hamachi|radmin/i

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

function ipScore(address) {
  if (/^192\.168\./.test(address)) return 0
  if (/^10\./.test(address)) return 1
  const m = /^172\.(\d{1,2})\./.exec(address)
  if (m) {
    const second = Number(m[1])
    if (second >= 16 && second <= 31) return 2
  }
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return 5
  return 3
}

function pickLanIPv4() {
  const candidates = []
  let interfaces = {}
  try {
    interfaces = os.networkInterfaces()
  } catch {
    return ''
  }
  for (const [name, list] of Object.entries(interfaces)) {
    for (const item of list || []) {
      if (!item) continue
      if (item.family !== 'IPv4' && item.family !== 4) continue
      if (item.internal) continue
      const address = String(item.address || '')
      if (!address || /^127\.|^169\.254\.|^0\.0\.0\.0$/.test(address)) continue
      const virtual = VIRTUAL_NAME.test(String(name || ''))
      candidates.push({ address, score: ipScore(address) + (virtual ? 10 : 0) })
    }
  }
  candidates.sort((a, b) => a.score - b.score)
  return candidates[0]?.address || ''
}

function detectUaPlatform(ua) {
  const text = String(ua || '')
  if (/iphone|ipad|ipod/i.test(text)) return 'ios'
  if (/android/i.test(text)) return 'android'
  return ''
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value <= 0) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim())
  if (!match) return null
  let start = match[1] ? Number(match[1]) : NaN
  let end = match[2] ? Number(match[2]) : NaN
  if (Number.isNaN(start) && Number.isNaN(end)) return null
  if (Number.isNaN(start)) {
    start = size - end
    end = size - 1
  } else if (Number.isNaN(end)) {
    end = size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start < 0 || start >= size || end < start) return null
  if (end >= size) end = size - 1
  return { start, end }
}

class MobileManager {
  constructor({ userDataDir, log, onState } = {}) {
    this.userDataDir = String(userDataDir || '')
    this.cacheDir = path.join(this.userDataDir, 'mobile')
    this.log = typeof log === 'function' ? log : () => {}
    this.onState = typeof onState === 'function' ? onState : null
    this.states = {}
    this.jobs = new Map()
    this.server = null
    this.lanInfo = null
    this.startPromise = null
    for (const platform of PLATFORMS) {
      this.states[platform] = { status: 'idle', percent: 0, bytes: 0, total: 0, mirror: '', error: '' }
    }
    this._ensureCacheDir()
  }

  _ensureCacheDir() {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true })
      return true
    } catch (error) {
      this.log(`[手机版] 创建缓存目录失败：${error?.message || error}`)
      return false
    }
  }

  _emit(payload) {
    if (!this.onState) return
    try {
      this.onState(payload)
    } catch (error) {
      this.log(`[手机版] 状态回调失败：${error?.message || error}`)
    }
  }

  _fileInfo(platform) {
    const meta = FILES[platform]
    const filePath = path.join(this.cacheDir, meta.name)
    let exists = false
    let size = 0
    try {
      const stat = fs.statSync(filePath)
      exists = stat.isFile() && stat.size > 0
      size = exists ? stat.size : 0
    } catch {
      exists = false
      size = 0
    }
    return { name: meta.name, exists, size, path: filePath }
  }

  info() {
    this._ensureCacheDir()
    return {
      android: this._fileInfo('android'),
      ios: this._fileInfo('ios'),
      cacheDir: this.cacheDir,
      mirrors: MIRRORS.slice(),
    }
  }

  status() {
    const result = {}
    for (const platform of PLATFORMS) {
      const file = this._fileInfo(platform)
      const state = this.states[platform] || {}
      const running = state.status === 'running'
      result[platform] = {
        exists: file.exists,
        size: file.size,
        percent: file.exists ? 100 : running ? Number(state.percent) || 0 : 0,
        status: file.exists ? 'done' : state.status || 'idle',
        error: file.exists ? '' : state.error || '',
        mirror: file.exists ? '' : state.mirror || '',
      }
    }
    return result
  }

  _setState(platform, patch) {
    this.states[platform] = { ...(this.states[platform] || {}), ...patch }
    return this.states[platform]
  }

  _mirrorOrder(preferred) {
    const wanted = String(preferred || '').trim().replace(/\/+$/, '')
    if (!wanted) return MIRRORS.slice()
    const index = MIRRORS.findIndex((mirror) => mirror.replace(/\/+$/, '') === wanted)
    if (index <= 0) return MIRRORS.slice()
    return [MIRRORS[index], ...MIRRORS.filter((_, i) => i !== index)]
  }

  fileUrl(platform, mirror) {
    const meta = FILES[platform]
    if (!meta) throw new Error(`不支持的平台：${platform}`)
    const base = String(mirror || MIRRORS[0]).replace(/\/+$/, '')
    return `${base}/releases/latest/download/${encodeURIComponent(meta.name)}`
  }

  /**
   * 从镜像下载安装包到缓存。同一平台并发调用会复用同一个任务。
   * 返回 Promise<{ok, status, platform, path, size, mirror, error}>。
   */
  prepare(payload = {}) {
    const platform = String(payload.platform || '').toLowerCase()
    if (!FILES[platform]) {
      return Promise.resolve({ ok: false, status: 'failed', error: `不支持的平台：${payload.platform || '(空)'}` })
    }
    const file = this._fileInfo(platform)
    if (file.exists) {
      this._setState(platform, { status: 'done', percent: 100, bytes: file.size, total: file.size, mirror: '', error: '' })
      return Promise.resolve({
        ok: true,
        status: 'done',
        platform,
        path: file.path,
        size: file.size,
        mirror: '',
      })
    }
    const running = this.jobs.get(platform)
    if (running) return running
    const job = this._download(platform, payload.mirror)
      .catch((error) => {
        const message = String(error?.message || error).slice(0, 200)
        this._setState(platform, { status: 'failed', percent: 0, error: message })
        this._emit({ type: 'download', platform, status: 'failed', percent: 0, bytes: 0, total: 0, mirror: '', error: message })
        return { ok: false, status: 'failed', platform, error: message }
      })
      .finally(() => {
        this.jobs.delete(platform)
      })
    this.jobs.set(platform, job)
    return job
  }

  async _download(platform, preferredMirror) {
    const meta = FILES[platform]
    if (!this._ensureCacheDir()) {
      return { ok: false, status: 'failed', platform, error: '无法创建手机版缓存目录' }
    }
    const destPath = path.join(this.cacheDir, meta.name)
    const partPath = path.join(this.cacheDir, `${meta.name}.part`)
    const mirrors = this._mirrorOrder(preferredMirror)
    let lastError = ''
    this._setState(platform, { status: 'running', percent: 0, bytes: 0, total: 0, mirror: mirrors[0] || '', error: '' })
    this._emit({ type: 'download', platform, status: 'running', percent: 0, bytes: 0, total: 0, mirror: mirrors[0] || '', error: '' })

    for (const mirror of mirrors) {
      const url = this.fileUrl(platform, mirror)
      this._setState(platform, { mirror, error: '' })
      this._emit({ type: 'download', platform, status: 'running', percent: 0, bytes: 0, total: 0, mirror, error: '' })
      this.log(`[手机版] 开始下载 ${meta.name}：${url}`)
      let lastEmitAt = 0
      let lastPercent = -1
      try {
        const result = await this._fetchToFile(url, partPath, (bytes, total) => {
          const percent = total > 0 ? Math.min(99, Math.floor((bytes / total) * 100)) : 0
          const now = Date.now()
          if (now - lastEmitAt < 200 && percent === lastPercent) return
          lastEmitAt = now
          lastPercent = percent
          this._setState(platform, { status: 'running', percent, bytes, total, mirror, error: '' })
          this._emit({ type: 'download', platform, status: 'running', percent, bytes, total, mirror, error: '' })
        })
        try {
          fs.rmSync(destPath, { force: true })
        } catch {
          /* 旧文件删不掉时下面的 rename 会失败，再走 copy */
        }
        try {
          fs.renameSync(partPath, destPath)
        } catch {
          fs.copyFileSync(partPath, destPath)
          fs.rmSync(partPath, { force: true })
        }
        const size = Number(result.bytes) || this._fileInfo(platform).size
        this._setState(platform, { status: 'done', percent: 100, bytes: size, total: size, mirror, error: '' })
        this._emit({ type: 'download', platform, status: 'done', percent: 100, bytes: size, total: size, mirror, error: '' })
        this.log(`[手机版] 下载完成 ${meta.name}（${formatBytes(size)}，${mirror}）`)
        return { ok: true, status: 'done', platform, path: destPath, size, mirror }
      } catch (error) {
        lastError = String(error?.message || error).slice(0, 200)
        this.log(`[手机版] 镜像失败 ${mirror}：${lastError}`)
        try {
          fs.rmSync(partPath, { force: true })
        } catch {
          /* 忽略 */
        }
        // 换下一个镜像时继续发 running 事件，页面上能显示「这个镜像不可用」。
        this._setState(platform, { status: 'running', percent: 0, bytes: 0, total: 0, mirror, error: lastError })
        this._emit({ type: 'download', platform, status: 'running', percent: 0, bytes: 0, total: 0, mirror, error: lastError })
      }
    }

    const message = lastError || '所有镜像都下载失败'
    this._setState(platform, { status: 'failed', percent: 0, bytes: 0, total: 0, mirror: '', error: message })
    this._emit({ type: 'download', platform, status: 'failed', percent: 0, bytes: 0, total: 0, mirror: '', error: message })
    return { ok: false, status: 'failed', platform, error: message }
  }

  async _fetchToFile(url, destPath, onProgress) {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      try {
        controller.abort(new Error('下载超时（10 分钟）'))
      } catch {
        /* 忽略 */
      }
    }, DOWNLOAD_TIMEOUT)
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'user-agent': DOWNLOAD_UA,
          accept: 'application/octet-stream,application/vnd.android.package-archive,*/*',
        },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`)
      if (!response.body) throw new Error('镜像没有返回文件内容')
      const total = Number(response.headers.get('content-length')) || 0
      let bytes = 0
      const source = Readable.fromWeb(response.body)
      source.on('data', (chunk) => {
        bytes += chunk.length
        onProgress(bytes, total)
      })
      await pipeline(source, fs.createWriteStream(destPath))
      if (bytes <= 0) throw new Error('下载到的文件是空的')
      onProgress(bytes, total || bytes)
      return { bytes, total }
    } finally {
      clearTimeout(timer)
    }
  }

  // -------------------------------------------------------------------------
  // 局域网 HTTP 服务
  // -------------------------------------------------------------------------

  async startLanServer() {
    if (this.server && this.lanInfo?.ok) {
      return {
        ...this.lanInfo,
        android: this._fileInfo('android').exists,
        ios: this._fileInfo('ios').exists,
      }
    }
    if (this.startPromise) return this.startPromise
    this.startPromise = this._startLanServer().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  _startLanServer() {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      let server = null
      try {
        server = http.createServer((request, response) => this._handleRequest(request, response))
      } catch (error) {
        finish({ ok: false, error: `无法创建局域网服务：${error?.message || error}` })
        return
      }
      server.on('clientError', (error, socket) => {
        try {
          socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        } catch {
          /* 忽略 */
        }
      })
      const onListenError = (error) => {
        clearTimeout(timeout)
        this.log(`[手机版] 局域网服务启动失败：${error?.message || error}`)
        try {
          server.close()
        } catch {
          /* 忽略 */
        }
        this.server = null
        this.lanInfo = null
        finish({ ok: false, error: `无法启动局域网服务：${error?.message || error}` })
      }
      server.once('error', onListenError)
      const timeout = setTimeout(() => {
        server.removeListener('error', onListenError)
        onListenError(new Error('启动超时'))
      }, 10000)
      server.listen(0, '0.0.0.0', () => {
        clearTimeout(timeout)
        server.removeListener('error', onListenError)
        if (settled) {
          try {
            server.close()
          } catch {
            /* 忽略 */
          }
          return
        }
        server.on('error', (error) => this.log(`[手机版] 局域网服务错误：${error?.message || error}`))
        const port = server.address().port
        const ip = pickLanIPv4()
        const url = ip ? `http://${ip}:${port}` : `http://127.0.0.1:${port}`
        this.server = server
        this.lanInfo = { ok: true, url, ip: ip || '127.0.0.1', port }
        this.log(`[手机版] 局域网下载页已启动：${url}`)
        finish({
          ok: true,
          url,
          ip: ip || '127.0.0.1',
          port,
          android: this._fileInfo('android').exists,
          ios: this._fileInfo('ios').exists,
        })
      })
    })
  }

  async stopLanServer() {
    const server = this.server
    this.server = null
    this.lanInfo = null
    if (!server) return true
    return new Promise((resolve) => {
      try {
        server.close(() => resolve(true))
        // 别让已经建立的 keep-alive 连接把关闭拖住
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
        setTimeout(() => resolve(true), 1500)
      } catch {
        resolve(true)
      }
    })
  }

  _sendJson(request, response, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
    })
    if (request.method === 'HEAD') response.end()
    else response.end(body)
  }

  _sendHtml(request, response, status, html) {
    const body = Buffer.from(html, 'utf8')
    response.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
    })
    if (request.method === 'HEAD') response.end()
    else response.end(body)
  }

  _sendFile(request, response, platform) {
    const file = this._fileInfo(platform)
    if (!file.exists) {
      this._sendJson(request, response, 404, {
        ok: false,
        error: '电脑上还没有这个安装包，请先在电脑端下载',
        platform,
      })
      return
    }
    const meta = FILES[platform]
    const headers = {
      'Content-Type': platform === 'android' ? 'application/vnd.android.package-archive' : 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${file.name}"`,
      'Accept-Ranges': 'bytes',
      'Content-Length': file.size,
    }
    const range = parseRange(request.headers.range, file.size)
    if (range) {
      headers['Content-Length'] = range.end - range.start + 1
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.size}`
      response.writeHead(206, headers)
      if (request.method === 'HEAD') {
        response.end()
        return
      }
      fs.createReadStream(file.path, { start: range.start, end: range.end })
        .on('error', () => {
          try {
            response.destroy()
          } catch {
            /* 忽略 */
          }
        })
        .pipe(response)
      return
    }
    response.writeHead(200, headers)
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    this.log(`[手机版] 局域网直传 ${meta.label}（${formatBytes(file.size)}）`)
    fs.createReadStream(file.path)
      .on('error', () => {
        try {
          response.destroy()
        } catch {
          /* 忽略 */
        }
      })
      .pipe(response)
  }

  _handleRequest(request, response) {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    response.setHeader('Access-Control-Max-Age', '86400')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }
    Promise.resolve()
      .then(() => this._route(request, response))
      .catch((error) => {
        this.log(`[手机版] 请求处理失败：${error?.stack || error}`)
        if (!response.headersSent) this._sendJson(request, response, 500, { ok: false, error: '服务内部错误' })
        else {
          try {
            response.end()
          } catch {
            /* 忽略 */
          }
        }
      })
  }

  async _route(request, response) {
    const method = request.method === 'HEAD' ? 'GET' : request.method
    let url = null
    try {
      url = new URL(request.url || '/', 'http://127.0.0.1')
    } catch {
      this._sendJson(request, response, 400, { ok: false, error: '请求地址不正确' })
      return
    }
    let pathname = url.pathname
    try {
      pathname = decodeURIComponent(pathname)
    } catch {
      this._sendJson(request, response, 400, { ok: false, error: '请求地址不正确' })
      return
    }

    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      this._sendHtml(request, response, 200, this._landingPage(request, url))
      return
    }
    if (method === 'GET' && pathname === '/health') {
      this._sendJson(request, response, 200, { ok: true, name: 'changshipin-mobile-lan', time: Date.now() })
      return
    }
    if (method === 'GET' && pathname === '/status') {
      this._sendJson(request, response, 200, this.status())
      return
    }
    const downloadMatch = /^\/download\/(android|ios)$/.exec(pathname)
    if (method === 'GET' && downloadMatch) {
      this._sendFile(request, response, downloadMatch[1])
      return
    }
    if (method === 'POST' && pathname === '/prepare') {
      const platform = String(url.searchParams.get('platform') || '').toLowerCase()
      if (!FILES[platform]) {
        this._sendJson(request, response, 400, { ok: false, error: 'platform 只能是 android 或 ios' })
        return
      }
      // 请求体不需要也不读取，直接放掉，避免 keep-alive 连接挂住。
      request.resume()
      const running = this.jobs.has(platform)
      if (!running) {
        // 不 await：接口立即返回 202，页面通过 /status 轮询进度。
        this.prepare({ platform, mirror: url.searchParams.get('mirror') || '' }).catch(() => {})
      }
      this._sendJson(request, response, 202, {
        ok: true,
        status: running ? 'running' : 'accepted',
        platform,
        state: this.status()[platform],
      })
      return
    }
    this._sendJson(request, response, 404, { ok: false, error: '没有这个接口' })
  }

  // -------------------------------------------------------------------------
  // 手机版落地页（内联 HTML，手机浏览器打开）
  // -------------------------------------------------------------------------

  _landingPage(request, url) {
    const uaPlatform = detectUaPlatform(request.headers['user-agent'])
    const queryPlatform = String(url.searchParams.get('platform') || '').toLowerCase()
    const recommended = queryPlatform === 'android' || queryPlatform === 'ios' ? queryPlatform : uaPlatform
    const initial = {
      recommended,
      status: this.status(),
      mirrors: MIRRORS.slice(),
      files: { android: FILES.android.name, ios: FILES.ios.name },
    }
    const mirrorGroups = PLATFORMS.map((platform) => {
      const buttons = MIRRORS.map((mirror, index) => {
        const fileUrl = this.fileUrl(platform, mirror)
        let host = mirror
        try {
          host = new URL(mirror).host
        } catch {
          /* 忽略 */
        }
        return `<a class="mirror" href="${escapeHtml(fileUrl)}" target="_blank" rel="noreferrer noopener">
          <span class="mirror-idx">${index + 1}</span>
          <span class="mirror-name">${escapeHtml(host)}</span>
          <span class="mirror-go">下载 ↗</span>
        </a>`
      }).join('')
      return `<div class="mirror-group">
        <h3>${escapeHtml(FILES[platform].label)}</h3>
        ${buttons}
      </div>`
    }).join('')

    const uaText = recommended === 'ios'
      ? '检测到 iPhone / iPad，推荐 iOS 免签名 IPA'
      : recommended === 'android'
        ? '检测到 Android，推荐 Android APK'
        : '用手机浏览器打开本页，下载速度最快'
    const iconUrl = appIconDataUrl()

    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#070d16" />
<title>长视频解析 · 手机版下载</title>
<style>
  :root {
    --bg: #05080e;
    --panel: rgba(255, 255, 255, 0.05);
    --line: rgba(255, 255, 255, 0.1);
    --text: #e9eef7;
    --muted: rgba(233, 238, 247, 0.6);
    --faint: rgba(233, 238, 247, 0.38);
    --accent: #37e08b;
    --accent-2: #29baff;
    --danger: #ff6470;
    color-scheme: dark;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0;
    min-height: 100vh;
    padding: max(18px, env(safe-area-inset-top)) 16px max(28px, env(safe-area-inset-bottom));
    font-family: 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
    color: var(--text);
    background:
      radial-gradient(760px 420px at 8% -10%, rgba(55, 224, 139, 0.16), transparent 62%),
      radial-gradient(620px 380px at 100% 0%, rgba(41, 186, 255, 0.14), transparent 58%),
      var(--bg);
  }
  .wrap { width: 100%; max-width: 560px; margin: 0 auto; }
  .hero { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
  .logo {
    width: 46px; height: 46px; flex: none; display: grid; place-items: center;
    border-radius: 14px; overflow: hidden; background: rgba(255, 255, 255, 0.04);
    box-shadow: 0 10px 30px -12px rgba(55, 224, 139, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.08);
    font-weight: 800; font-size: 20px; color: #04140c;
  }
  .logo img { width: 100%; height: 100%; display: block; object-fit: cover; }
  h1 { margin: 0; font-size: 18px; letter-spacing: 0.4px; }
  .sub { margin: 3px 0 0; font-size: 11.5px; color: var(--faint); }
  .tip {
    margin: 0 0 12px; padding: 9px 12px; border-radius: 10px;
    border: 1px solid rgba(55, 224, 139, 0.32);
    background: rgba(55, 224, 139, 0.08);
    font-size: 12px; color: #a9f4cb;
  }
  .card {
    margin-bottom: 12px; padding: 14px 16px 16px;
    border: 1px solid var(--line); border-radius: 16px;
    background: var(--panel);
    box-shadow: 0 24px 50px -36px rgba(0, 0, 0, 0.9);
  }
  .card.recommend { border-color: rgba(55, 224, 139, 0.45); }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .card-head h2 { margin: 0; font-size: 15px; }
  .badge {
    flex: none; font-size: 10.5px; padding: 3px 9px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--muted);
  }
  .badge.ok { color: #9bf3c6; border-color: rgba(55, 224, 139, 0.4); background: rgba(55, 224, 139, 0.1); }
  .badge.err { color: #ffa3aa; border-color: rgba(255, 100, 112, 0.4); background: rgba(255, 100, 112, 0.1); }
  .card p { margin: 9px 0 0; font-size: 12px; line-height: 1.75; color: var(--muted); }
  .steps { margin: 8px 0 0; padding-left: 18px; font-size: 12px; line-height: 1.85; color: var(--muted); }
  .steps code { padding: 1px 5px; border-radius: 4px; background: rgba(255, 255, 255, 0.07); color: var(--text); font-size: 11px; }
  .steps a { color: var(--accent); }
  .ios-why {
    margin-top: 10px; padding-top: 9px; border-top: 1px dashed var(--line);
    font-size: 11px; line-height: 1.75; color: var(--muted);
  }
  .ios-why summary { cursor: pointer; color: var(--accent); }
  .ios-why p { margin: 7px 0 0; }
  .ios-why ul { margin: 5px 0 0; padding-left: 16px; }
  .ios-why a { color: var(--accent); }
  .btn {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    width: 100%; min-height: 46px; margin-top: 12px; padding: 0 16px;
    border: 0; border-radius: 12px; cursor: pointer;
    font-size: 14px; font-weight: 700; text-decoration: none;
    background: linear-gradient(135deg, #41eb9a, #28c5ff); color: #04140c;
  }
  .btn[disabled] { opacity: 0.55; cursor: default; }
  .btn.secondary {
    background: rgba(255, 255, 255, 0.06); color: var(--text);
    border: 1px solid var(--line); font-weight: 600;
  }
  .progress { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
  .progress[hidden] { display: none; }
  .bar { flex: 1; height: 8px; border-radius: 999px; overflow: hidden; background: rgba(255, 255, 255, 0.1); }
  .bar i { display: block; width: 0; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #37e08b, #29baff); transition: width 0.25s ease; }
  .pct { flex: none; font-size: 11px; color: var(--muted); min-width: 38px; text-align: right; }
  .mirrors h2 { margin: 0 0 4px; font-size: 15px; }
  .mirror-group h3 { margin: 14px 0 8px; font-size: 12px; color: var(--faint); font-weight: 600; letter-spacing: 0.4px; }
  .mirror {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px; margin-bottom: 7px;
    border: 1px solid var(--line); border-radius: 11px;
    background: rgba(255, 255, 255, 0.035);
    color: var(--text); text-decoration: none; font-size: 12.5px;
  }
  .mirror:active { background: rgba(255, 255, 255, 0.08); }
  .mirror-idx {
    width: 20px; height: 20px; flex: none; display: grid; place-items: center;
    border-radius: 7px; background: rgba(55, 224, 139, 0.14);
    color: #9bf3c6; font-size: 10.5px; font-weight: 700;
  }
  .mirror-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
  .mirror-go { flex: none; color: #9bf3c6; font-size: 11.5px; }
  .foot { margin-top: 18px; text-align: center; font-size: 10.5px; line-height: 1.8; color: var(--faint); }
  .foot a { color: var(--faint); }
</style>
</head>
<body>
<main class="wrap">
  <header class="hero">
    <div class="logo">${iconUrl ? `<img src="${iconUrl}" alt="" />` : '长'}</div>
    <div>
      <h1>长视频解析 · 手机版</h1>
      <p class="sub">电脑直传 · 手机和电脑连同一个 Wi-Fi 最快</p>
    </div>
  </header>
  <div class="tip" id="ua-tip">${escapeHtml(uaText)}</div>

  <section class="card ${recommended === 'android' ? 'recommend' : ''}" id="card-android">
    <div class="card-head"><h2>Android APK</h2><span class="badge" id="badge-android">检测中</span></div>
    <p>下载完成后按下面步骤装到手机；首次安装需要允许「未知来源」。</p>
    <ol class="steps">
      <li>点下面的按钮下载 <code>changshipin-android.apk</code>。</li>
      <li>下载完成后，点手机通知栏的「下载完成」，或打开「文件管理 → 下载 / Download」找到 APK。</li>
      <li>第一次点开 APK 会提示「禁止安装未知应用」：点「设置」→ 允许当前浏览器 / 文件管理器安装应用 → 返回继续。</li>
      <li>点「安装」，完成后在桌面打开「长视频解析」。</li>
      <li>以后升级直接下载新 APK 覆盖安装，不用卸载，配置和历史都保留。</li>
    </ol>
    <div class="progress" id="prog-android" hidden><div class="bar"><i id="fill-android"></i></div><span class="pct" id="pct-android">0%</span></div>
    <button class="btn" id="btn-android" type="button" disabled>检测安装包…</button>
  </section>

  <section class="card ${recommended === 'ios' ? 'recommend' : ''}" id="card-ios">
    <div class="card-head"><h2>iOS 免签名 IPA</h2><span class="badge" id="badge-ios">检测中</span></div>
    <p>iOS 不能像 Android 一样直接装 IPA；免签名版需要一台电脑用 Sideloadly / AltStore 自签一次。</p>
    <ol class="steps">
      <li>点下面的按钮下载 <code>changshipin-ios-unsigned.ipa</code>（Safari 会存到「文件」App → 下载）。</li>
      <li>准备一台 Windows / Mac 电脑和数据线；电脑上安装 <a href="https://sideloadly.io/" target="_blank" rel="noreferrer noopener">Sideloadly</a> 或 AltStore。</li>
      <li>iPhone 连接电脑并点「信任」；把 IPA 拖进 Sideloadly，输入自己的 Apple ID，点 Start。</li>
      <li>手机上「设置 → 通用 → VPN 与设备管理」→ 信任你的开发者证书。</li>
      <li>iOS 16 及以上还要打开「设置 → 隐私与安全性 → 开发者模式」，重启手机一次。</li>
      <li>回桌面打开应用。个人 Apple ID 签名 7 天有效，到期重复第 3 步覆盖安装即可，配置和历史保留。</li>
    </ol>
    <details class="ios-why">
      <summary>为什么 iOS 不能像 Android 一样直接装？有没有更省事的办法？</summary>
      <p>Android 允许自签名 APK + 未知来源；iOS 只运行 Apple 信任证书签名的 App，免签名 IPA 没有证书，系统安装器会直接拒绝。这是 iOS 的机制，不是本程序能绕过的。</p>
      <p><b>更省事的选择：</b></p>
      <ul>
        <li><b>TrollStore</b>：部分 iOS 14.0–17.0 设备支持，装上后永久使用、不用续签；先看 <a href="https://github.com/opa334/TrollStore" target="_blank" rel="noreferrer noopener">官方兼容表</a>。</li>
        <li><b>AltStore + AltServer</b>：首次用电脑，之后同一 Wi-Fi 下自动续签，7 天一次不用反复插线（<a href="https://altstore.io/" target="_blank" rel="noreferrer noopener">altstore.io</a>）。</li>
        <li><b>SideStore</b>：配置一次后可在手机上续签，不用一直开电脑（<a href="https://sidestore.io/" target="_blank" rel="noreferrer noopener">sidestore.io</a>）。</li>
        <li><b>Apple Developer Program</b>：$99/年，签名 1 年；首次仍需电脑安装。</li>
      </ul>
      <p>没有「免费 + 永久 + 完全不用电脑」的通用办法。PWA 网页版虽然免安装，但拿不到本地取流代理、下载、内置浏览器等完整能力，不能替代手机 App。</p>
    </details>
    <div class="progress" id="prog-ios" hidden><div class="bar"><i id="fill-ios"></i></div><span class="pct" id="pct-ios">0%</span></div>
    <button class="btn" id="btn-ios" type="button" disabled>检测安装包…</button>
  </section>

  <section class="card mirrors">
    <h2>国内镜像</h2>
    <p>手机不在电脑同一 Wi-Fi 时，可直接用下面的镜像下载（页面会跳转到 GitHub Release）。</p>
    ${mirrorGroups}
  </section>

  <footer class="foot">
    长视频解析 · MIT License<br />
    电脑直传只在本次打开期间可用，关闭桌面端后连接会断开。
  </footer>
</main>
<script>
(function () {
  var INITIAL = ${safeJson(initial)}
  var status = INITIAL.status || {}
  var preparing = { android: false, ios: false }
  var pollTimer = 0
  var platforms = ['android', 'ios']
  var labels = { android: 'APK', ios: 'IPA' }

  function fmt(bytes) {
    var value = Number(bytes) || 0
    if (value <= 0) return '0 B'
    if (value < 1024) return value + ' B'
    if (value < 1048576) return (value / 1024).toFixed(1) + ' KB'
    if (value < 1073741824) return (value / 1048576).toFixed(1) + ' MB'
    return (value / 1073741824).toFixed(2) + ' GB'
  }

  function $(id) { return document.getElementById(id) }

  function showProgress(platform, visible, percent) {
    var wrap = $('prog-' + platform)
    var fill = $('fill-' + platform)
    var pct = $('pct-' + platform)
    if (!wrap || !fill || !pct) return
    wrap.hidden = !visible
    fill.style.width = Math.max(0, Math.min(100, Number(percent) || 0)) + '%'
    pct.textContent = Math.round(Math.max(0, Math.min(100, Number(percent) || 0))) + '%'
  }

  function setPreparing(platform, value) {
    preparing[platform] = Boolean(value)
    if (value) startPoll()
    render()
  }

  function renderCard(platform) {
    var state = status[platform] || {}
    var badge = $('badge-' + platform)
    var button = $('btn-' + platform)
    if (!badge || !button) return
    var running = state.status === 'running' || preparing[platform]
    var exists = Boolean(state.exists)
    badge.className = 'badge'
    button.onclick = null
    button.disabled = false

    if (exists) {
      badge.textContent = '电脑已有 · ' + fmt(state.size)
      badge.className = 'badge ok'
      button.textContent = '从电脑下载 ' + labels[platform]
      button.onclick = function () { window.location.href = '/download/' + platform }
      showProgress(platform, false, 0)
      return
    }
    if (running) {
      badge.textContent = '正在下载到电脑…'
      badge.className = 'badge'
      button.disabled = true
      button.textContent = '正在从镜像下载到电脑 ' + (Number(state.percent) || 0) + '%'
      showProgress(platform, true, state.percent || 0)
      return
    }
    if (state.status === 'failed') {
      badge.textContent = '上次下载失败'
      badge.className = 'badge err'
      button.textContent = '重试：先从镜像下载到电脑'
    } else {
      badge.textContent = '电脑上还没有'
      button.textContent = '电脑上还没有，先从镜像下载'
    }
    button.onclick = function () { prepare(platform) }
    showProgress(platform, false, 0)
  }

  function render() {
    platforms.forEach(renderCard)
  }

  function prepare(platform) {
    if (preparing[platform]) return
    preparing[platform] = true
    render()
    fetch('/prepare?platform=' + platform, { method: 'POST' })
      .then(function (response) { return response.json().catch(function () { return {} }) })
      .then(function (data) {
        if (data && data.state) status[platform] = data.state
        startPoll()
        render()
      })
      .catch(function () {
        preparing[platform] = false
        var badge = $('badge-' + platform)
        if (badge) { badge.textContent = '无法连接电脑，请检查 Wi-Fi'; badge.className = 'badge err' }
        render()
      })
  }

  function refresh() {
    return fetch('/status', { cache: 'no-store' })
      .then(function (response) { return response.json() })
      .then(function (data) {
        if (data && data.android && data.ios) status = data
        var running = platforms.some(function (platform) {
          return status[platform] && status[platform].status === 'running'
        })
        platforms.forEach(function (platform) {
          if (!running) preparing[platform] = false
        })
        render()
        if (!running) {
          stopPoll()
          var failed = platforms.some(function (platform) { return status[platform] && status[platform].status === 'failed' })
          if (failed) {
            var tip = $('ua-tip')
            if (tip) tip.textContent = '镜像暂时不可用，可以换一个镜像重试，或稍后再试。'
          }
        }
      })
      .catch(function () { stopPoll() })
  }

  function startPoll() {
    if (pollTimer) return
    pollTimer = setInterval(refresh, 1200)
  }

  function stopPoll() {
    if (!pollTimer) return
    clearInterval(pollTimer)
    pollTimer = 0
  }

  render()
  refresh()
  if (INITIAL.recommended) {
    var card = $('card-' + INITIAL.recommended)
    if (card) card.classList.add('recommend')
  }
})()
</script>
</body>
</html>`
  }
}

module.exports = { MobileManager, MIRRORS, FILES }
