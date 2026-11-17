'use strict'

/**
 * 本地下载（离线观看）。
 *
 * 只处理内置播放器能拿到的原生流：
 *  - HLS（m3u8）：拉取播放列表 → 分片逐个下载 → AES-128 解密 → 合并成一个 .ts / .mp4
 *  - mp4：直接流式落盘
 * 分片下载不需要 ffmpeg，合并出来的 .ts 用 PotPlayer / VLC 就能播；
 * 有 DRM（Widevine / SAMPLE-AES）的流会在开始阶段明确报错，不浪费流量。
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'

const MAX_PLAYLIST_BYTES = 6 * 1024 * 1024
const STATE_THROTTLE = 350

function sanitizeFileName(raw, fallback = '视频') {
  const cleaned = String(raw || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80)
  return cleaned || fallback
}

function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, `${base}${ext}`)
  let index = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${index})${ext}`)
    index += 1
  }
  return candidate
}

function parseAttributes(text) {
  const out = {}
  const regex = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g
  let match
  while ((match = regex.exec(text)) !== null) {
    out[match[1]] = match[2].replace(/^"|"$/g, '')
  }
  return out
}

function parsePlaylist(text, baseUrl) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const result = {
    isMaster: lines.some((line) => line.startsWith('#EXT-X-STREAM-INF')),
    variants: [],
    segments: [],
    map: '',
    key: null,
    mediaSequence: 0,
    encryptedUnsupported: '',
  }
  let pendingVariant = null
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const attrs = parseAttributes(line.slice(line.indexOf(':') + 1))
      pendingVariant = { bandwidth: Number(attrs.BANDWIDTH) || 0, uri: '' }
      continue
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      result.mediaSequence = Number(line.split(':')[1]) || 0
      continue
    }
    if (line.startsWith('#EXT-X-KEY')) {
      const attrs = parseAttributes(line.slice(line.indexOf(':') + 1))
      const method = String(attrs.METHOD || 'NONE').toUpperCase()
      if (method !== 'NONE' && method !== 'AES-128') {
        result.encryptedUnsupported = method
      } else if (method === 'AES-128' && attrs.URI) {
        result.key = {
          uri: new URL(attrs.URI, baseUrl).href,
          iv: attrs.IV || '',
        }
      }
      continue
    }
    if (line.startsWith('#EXT-X-MAP')) {
      const attrs = parseAttributes(line.slice(line.indexOf(':') + 1))
      if (attrs.URI) result.map = new URL(attrs.URI, baseUrl).href
      continue
    }
    if (line.startsWith('#')) continue
    const absolute = new URL(line, baseUrl).href
    if (pendingVariant) {
      pendingVariant.uri = absolute
      result.variants.push(pendingVariant)
      pendingVariant = null
    } else {
      result.segments.push(absolute)
    }
  }
  return result
}

function sequenceIv(sequence) {
  const buffer = Buffer.alloc(16)
  let value = BigInt(Math.max(0, sequence))
  for (let index = 15; index >= 0; index -= 1) {
    buffer[index] = Number(value & 0xffn)
    value >>= 8n
  }
  return buffer
}

function ivFromHex(raw) {
  const hex = String(raw || '').replace(/^0x/i, '')
  if (!/^[0-9a-f]+$/i.test(hex) || !hex.length) return null
  const buffer = Buffer.from(hex.padStart(32, '0').slice(-32), 'hex')
  return buffer.length === 16 ? buffer : null
}

async function readText(response) {
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > MAX_PLAYLIST_BYTES) throw new Error('播放列表过大')
  return buffer.toString('utf8')
}

class DownloadManager {
  constructor({ log, dir, onState, proxify }) {
    this.log = log
    this.dir = dir
    this.onState = onState || (() => {})
    this.proxify = typeof proxify === 'function' ? proxify : null
    this.jobs = new Map()
    this.counter = 0
    this.lastSavedPath = ''
  }

  get folder() {
    return this.dir
  }

  snapshot(id) {
    const job = this.jobs.get(id)
    return job ? { ...job.state } : null
  }

  emit(job, patch = {}) {
    Object.assign(job.state, patch)
    job.state.updatedAt = Date.now()
    if (job.state.status === 'running') {
      const now = Date.now()
      if (now - (job.lastEmit || 0) < STATE_THROTTLE) return
      job.lastEmit = now
    }
    this.onState({ ...job.state })
    this.log(`[下载] ${job.state.status} ${job.state.percent}% ${job.state.title} ${job.state.error || ''}`)
  }

  start({ url, referer = '', cookie = '', title = '', platform = '', lineName = '' }) {
    const target = String(url || '')
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: '当前画面没有可下载的流地址' }
    const id = `dl-${Date.now()}-${++this.counter}`
    const headers = {
      'user-agent': UA,
      referer: referer || target,
      accept: '*/*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
      ...(cookie ? { cookie } : {}),
    }
    const baseName = sanitizeFileName(
      `${platform ? `${platform} ` : ''}${title || '视频'}${lineName ? ` ${lineName}` : ''}`,
      '视频',
    )
    const job = {
      id,
      controller: new AbortController(),
      cancelled: false,
      lastEmit: 0,
      headers,
      target,
      baseName,
      referer: referer || target,
      cookie,
      state: {
        id,
        status: 'running',
        title: title || baseName,
        percent: 0,
        bytes: 0,
        totalBytes: 0,
        segments: 0,
        totalSegments: 0,
        speed: 0,
        savedPath: '',
        dir: this.dir,
        error: '',
        kind: '',
      },
    }
    this.jobs.set(id, job)
    this.emit(job)
    this._run(job).catch((error) => this.log(`[下载] 未捕获失败：${error?.stack || error}`))
    return { ok: true, id }
  }

  async _run(job) {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const looksHls = /\.m3u8([?#]|$)/i.test(job.target) || /\/m3u8\//i.test(job.target)
      if (looksHls) await this._downloadHls(job, job.baseName)
      else await this._downloadFile(job, job.baseName)
      if (!job.cancelled) {
        job.state.status = 'done'
        this.emit(job)
      }
    } catch (error) {
      const cancelled = job.cancelled
      if (job.partPath) {
        try {
          fs.rmSync(job.partPath, { force: true })
        } catch {
          /* 忽略 */
        }
      }
      job.state.status = cancelled ? 'cancelled' : 'failed'
      job.state.error = cancelled ? '' : String(error?.message || error).slice(0, 200)
      this.emit(job)
      if (!cancelled) this.log(`[下载] 失败：${error?.stack || error}`)
    } finally {
      job.controller = null
      const finished = [...this.jobs.values()].filter((item) => item.state.status !== 'running')
      if (finished.length > 20) {
        for (const item of finished.slice(0, finished.length - 20)) this.jobs.delete(item.id)
      }
    }
  }

  cancel(id) {
    const job = this.jobs.get(id)
    if (!job || job.state.status !== 'running') return false
    job.cancelled = true
    try {
      job.controller?.abort()
    } catch {
      /* 忽略 */
    }
    job.state.status = 'cancelled'
    this.emit(job)
    return true
  }

  cancelAll() {
    for (const id of this.jobs.keys()) this.cancel(id)
  }

  async _fetch(job, url, timeoutMs = 30000, viaProxy = false) {
    const target = viaProxy && this.proxify ? this.proxify(url, job) : url
    const timeout = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : null
    const signal =
      job.controller?.signal && timeout && AbortSignal.any
        ? AbortSignal.any([job.controller.signal, timeout])
        : job.controller?.signal || timeout || undefined
    return fetch(target, {
      headers: job.headers,
      redirect: 'follow',
      signal,
    })
  }

  async _downloadFile(job, baseName) {
    const response = await this._fetch(job, job.target, 30000, true)
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length')) || 0
    const ext = /\.mp4([?#]|$)/i.test(job.target) ? '.mp4' : '.ts'
    const filePath = uniquePath(this.dir, baseName, ext)
    const partPath = `${filePath}.part`
    job.partPath = partPath
    const stream = fs.createWriteStream(partPath)
    let bytes = 0
    const started = Date.now()
    try {
      for await (const chunk of response.body) {
        if (job.cancelled) break
        bytes += chunk.length
        await new Promise((resolve, reject) => {
          stream.write(chunk, (error) => (error ? reject(error) : resolve()))
        })
        const speed = bytes / Math.max(0.3, (Date.now() - started) / 1000)
        this.emit(job, {
          percent: total ? Math.min(99, Math.round((bytes / total) * 100)) : 0,
          bytes,
          totalBytes: total,
          speed,
          kind: ext === '.mp4' ? 'mp4' : 'flv/ts',
        })
      }
    } finally {
      await new Promise((resolve) => stream.end(resolve))
    }
    if (job.cancelled) {
      fs.rmSync(partPath, { force: true })
      return
    }
    fs.renameSync(partPath, filePath)
    job.state.savedPath = filePath
    job.state.percent = 100
    this.lastSavedPath = filePath
    this.emit(job)
  }

  async _downloadHls(job, baseName) {
        const topResponse = await this._fetch(job, job.target, 150000)
    if (!topResponse.ok) throw new Error(`播放列表请求失败：HTTP ${topResponse.status}`)
    let playlist = parsePlaylist(await readText(topResponse), job.target)
    if (playlist.isMaster) {
      const best = [...playlist.variants].sort((left, right) => right.bandwidth - left.bandwidth)[0]
      if (!best?.uri) throw new Error('播放列表里没有可用的清晰度')
      const response = await this._fetch(job, best.uri, 150000)
      if (!response.ok) throw new Error(`清晰度播放列表请求失败：HTTP ${response.status}`)
      playlist = parsePlaylist(await readText(response), best.uri)
    }
    if (playlist.encryptedUnsupported) {
      throw new Error(`该视频使用 ${playlist.encryptedUnsupported} 加密（DRM），暂不支持下载`)
    }
    if (!playlist.segments.length) throw new Error('播放列表里没有分片')
    const isFmp4 = Boolean(playlist.map) || /\.m4s([?#]|$)/i.test(playlist.segments[0])
    const ext = isFmp4 ? '.mp4' : '.ts'
    const filePath = uniquePath(this.dir, baseName, ext)
    const partPath = `${filePath}.part`
    job.partPath = partPath
    const stream = fs.createWriteStream(partPath)
    const total = playlist.segments.length
    let bytes = 0
    const started = Date.now()
    const write = (buffer) =>
      new Promise((resolve, reject) => {
        stream.write(buffer, (error) => (error ? reject(error) : resolve()))
      })
    try {
      if (playlist.map) {
        const mapResponse = await this._fetch(job, playlist.map, 30000, true)
        if (mapResponse.ok) {
          const buffer = Buffer.from(await mapResponse.arrayBuffer())
          bytes += buffer.length
          await write(buffer)
        }
      }
      let keyBuffer = null
      if (playlist.key) {
        const keyResponse = await this._fetch(job, playlist.key.uri, 30000, true)
        if (!keyResponse.ok) throw new Error('解密密钥获取失败')
        keyBuffer = Buffer.from(await keyResponse.arrayBuffer())
        if (keyBuffer.length !== 16) throw new Error('解密密钥长度异常')
      }
      for (let index = 0; index < total; index += 1) {
        if (job.cancelled) break
        const segmentUrl = playlist.segments[index]
        const response = await this._fetch(job, segmentUrl, 30000, true)
        if (!response.ok) throw new Error(`分片 ${index + 1} 下载失败：HTTP ${response.status}`)
        let buffer = Buffer.from(await response.arrayBuffer())
        if (keyBuffer) {
          const iv = ivFromHex(playlist.key?.iv) || sequenceIv(playlist.mediaSequence + index)
          const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuffer, iv)
          buffer = Buffer.concat([decipher.update(buffer), decipher.final()])
        }
        bytes += buffer.length
        await write(buffer)
        const speed = bytes / Math.max(0.3, (Date.now() - started) / 1000)
        this.emit(job, {
          percent: Math.min(99, Math.round(((index + 1) / total) * 100)),
          bytes,
          segments: index + 1,
          totalSegments: total,
          speed,
          kind: isFmp4 ? 'HLS/fMP4' : 'HLS/TS',
        })
      }
    } finally {
      await new Promise((resolve) => stream.end(resolve))
    }
    if (job.cancelled) {
      fs.rmSync(partPath, { force: true })
      return
    }
    fs.renameSync(partPath, filePath)
    job.state.savedPath = filePath
    job.state.percent = 100
    this.lastSavedPath = filePath
    this.emit(job)
  }
}

module.exports = { DownloadManager, sanitizeFileName, parsePlaylist }
