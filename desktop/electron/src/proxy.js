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
const crypto = require('node:crypto')
const { net, session } = require('electron')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024

class StreamProxy {
  constructor() {
    this.server = null
    this.port = 0
    this.token = crypto.randomBytes(9).toString('hex')
    this.session = null
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
      this.server.listen(0, '127.0.0.1', () => {
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

  resourceUrl(target, referer = '', cookie = '') {
    const search = new URLSearchParams()
    search.set('t', this.token)
    search.set('u', Buffer.from(String(target), 'utf8').toString('base64url'))
    if (referer) search.set('r', Buffer.from(String(referer), 'utf8').toString('base64url'))
    if (cookie) search.set('c', Buffer.from(String(cookie), 'utf8').toString('base64url'))
    return `${this.base}/stream?${search.toString()}`
  }

  async _handle(request, response) {
    const url = new URL(request.url, this.base)
    if (url.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok')
      return
    }
    if (url.pathname !== '/stream') {
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
    await this._pipe(request, response, target, referer, cookie)
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

  _request(target, headers) {
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
      }, 30000)
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

  _rewritePlaylist(text, baseUrl, cookie = '', referer = '') {
    const proxy = this
    const rewrite = (relative) => {
      try {
        const absolute = new URL(relative, baseUrl).href
        return proxy.resourceUrl(absolute, referer || baseUrl, cookie)
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

  async _pipe(request, response, target, referer, cookie = '') {
    const headers = {
      'user-agent': UA,
      accept: '*/*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
      'accept-encoding': 'identity',
    }
    if (referer) headers['X-Proxy-Referer'] = referer.replace(/[^\x20-\x7e]/g, '')
    if (cookie) headers['X-Proxy-Cookie'] = cookie.replace(/[\r\n]/g, '')
    if (request.headers.range) headers.range = request.headers.range

    const upstream = await this._request(target, headers)
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
      const rewritten = body.trimStart().startsWith('#EXTM3U') ? this._rewritePlaylist(body, target, cookie, referer) : body
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

module.exports = { StreamProxy }
