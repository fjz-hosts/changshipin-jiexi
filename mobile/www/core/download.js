/* 手机端下载：HLS 分片 / mp4 → Cache 临时文件 → 发布到系统下载目录（或 iOS 文件 App）。 */
;(function () {
  'use strict'

  const N = window.CSPNative
  const { UA } = window.CSPLines

  const MAX_PLAYLIST_BYTES = 6 * 1024 * 1024
  const STATE_THROTTLE = 350
  const DOWNLOAD_DIR = '长视频解析下载'

  function sanitizeFileName(raw, fallback = '视频') {
    const cleaned = String(raw || '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 80)
    return cleaned || fallback
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
          result.key = { uri: new URL(attrs.URI, baseUrl).href, iv: attrs.IV || '' }
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
    const buffer = new Uint8Array(16)
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
    const padded = hex.padStart(32, '0').slice(-32)
    const out = new Uint8Array(16)
    for (let index = 0; index < 16; index += 1) out[index] = parseInt(padded.slice(index * 2, index * 2 + 2), 16)
    return out
  }

  async function decryptAes128(buffer, keyBytes, iv) {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt'])
    const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, buffer)
    return new Uint8Array(plain)
  }

  function concatBytes(chunks) {
    const total = chunks.reduce((sum, item) => sum + item.length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const item of chunks) {
      out.set(item, offset)
      offset += item.length
    }
    return out
  }

  class DownloadManager {
    constructor({ onState, log } = {}) {
      this.onState = onState || (() => {})
      this.log = log || (() => {})
      this.jobs = new Map()
      this.counter = 0
      this.lastSavedPath = ''
    }

    get folder() {
      return DOWNLOAD_DIR
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
          dir: DOWNLOAD_DIR,
          error: '',
          kind: '',
        },
      }
      this.jobs.set(id, job)
      this.emit(job)
      this._run(job).catch((error) => {
        job.state.status = 'failed'
        job.state.error = String(error?.message || error).slice(0, 200)
        this.emit(job)
      })
      return { ok: true, id }
    }

    async _run(job) {
      let partPath = ''
      try {
        await N.fs.mkdir(DOWNLOAD_DIR, 'CACHE')
        const looksHls = /\.m3u8([?#]|$)/i.test(job.target) || /\/m3u8\//i.test(job.target)
        let saved
        if (looksHls) saved = await this._downloadHls(job)
        else saved = await this._downloadFile(job)
        if (job.cancelled) return
        job.state.status = 'done'
        job.state.percent = 100
        job.state.savedPath = saved.displayPath || saved.name || ''
        this.lastSavedPath = job.state.savedPath
        this.emit(job)
      } catch (error) {
        const cancelled = job.cancelled
        if (partPath) await N.fs.delete(partPath, 'CACHE')
        job.state.status = cancelled ? 'cancelled' : 'failed'
        job.state.error = cancelled ? '' : String(error?.message || error).slice(0, 200)
        this.emit(job)
        if (!cancelled) this.log(`[下载] 失败：${String(error?.stack || error)}`)
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

    _fetchInit(job) {
      return {
        headers: { 'user-agent': UA, accept: '*/*' },
        referer: job.referer,
        cookie: job.cookie,
      }
    }

    async _append(job, path, bytes) {
      const base64 = N.base64FromBytes(bytes)
      if (job.written) {
        await N.fs.append(`${DOWNLOAD_DIR}/${path}`, base64, 'CACHE')
      } else {
        await N.fs.write(`${DOWNLOAD_DIR}/${path}`, base64, 'CACHE')
        job.written = true
      }
    }

    async _downloadFile(job) {
      const target = job.target
      const ext = /\.mp4([?#]|$)/i.test(target) ? '.mp4' : '.ts'
      const name = `${job.baseName}${ext}`
      const partPath = `${name}.part`
      const response = await N.fetchBinary(target, { ...this._fetchInit(job), timeout: 120000 })
      if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
      const total = Number(response.headers.get('content-length')) || 0
      const reader = response.body?.getReader()
      if (!reader) throw new Error('无法读取下载流')
      let bytes = 0
      const started = Date.now()
      job.written = false
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (job.cancelled) {
          try {
            await reader.cancel()
          } catch {
            /* 忽略 */
          }
          break
        }
        bytes += value.length
        await this._append(job, partPath, value)
        this.emit(job, {
          percent: total ? Math.min(99, Math.round((bytes / total) * 100)) : 0,
          bytes,
          totalBytes: total,
          speed: bytes / Math.max(0.3, (Date.now() - started) / 1000),
          kind: ext === '.mp4' ? 'mp4' : 'flv/ts',
        })
      }
      if (job.cancelled) {
        await N.fs.delete(`${DOWNLOAD_DIR}/${partPath}`, 'CACHE')
        return { name: '' }
      }
      const published = await N.publishDownload({
        path: `${DOWNLOAD_DIR}/${partPath}`,
        name,
        mime: ext === '.mp4' ? 'video/mp4' : 'video/mp2t',
        directory: 'CACHE',
      })
      await N.fs.delete(`${DOWNLOAD_DIR}/${partPath}`, 'CACHE')
      return { name, displayPath: published?.displayPath || published?.uri || name }
    }

    async _readText(target, job, timeout = 150000) {
      const response = await N.fetchText(target, { ...this._fetchInit(job), timeout })
      if (!response.ok) throw new Error(`播放列表请求失败：HTTP ${response.status}`)
      if (response.text.length > MAX_PLAYLIST_BYTES) throw new Error('播放列表过大')
      return response.text
    }

    async _downloadHls(job) {
      let playlist = parsePlaylist(await this._readText(job.target, job), job.target)
      if (playlist.isMaster) {
        const best = [...playlist.variants].sort((left, right) => right.bandwidth - left.bandwidth)[0]
        if (!best?.uri) throw new Error('播放列表里没有可用的清晰度')
        playlist = parsePlaylist(await this._readText(best.uri, job), best.uri)
      }
      if (playlist.encryptedUnsupported) {
        throw new Error(`该视频使用 ${playlist.encryptedUnsupported} 加密（DRM），暂不支持下载`)
      }
      if (!playlist.segments.length) throw new Error('播放列表里没有分片')
      const isFmp4 = Boolean(playlist.map) || /\.m4s([?#]|$)/i.test(playlist.segments[0])
      const ext = isFmp4 ? '.mp4' : '.ts'
      const name = `${job.baseName}${ext}`
      const partPath = `${name}.part`
      const total = playlist.segments.length
      let bytes = 0
      const started = Date.now()
      job.written = false
      const init = this._fetchInit(job)

      if (playlist.map) {
        const mapResponse = await N.fetchBinary(playlist.map, { ...init, timeout: 30000 })
        if (mapResponse.ok) {
          const buffer = new Uint8Array(await mapResponse.arrayBuffer())
          bytes += buffer.length
          await this._append(job, partPath, buffer)
        }
      }
      let keyBytes = null
      if (playlist.key) {
        const keyResponse = await N.fetchBinary(playlist.key.uri, { ...init, timeout: 30000 })
        if (!keyResponse.ok) throw new Error('解密密钥获取失败')
        keyBytes = new Uint8Array(await keyResponse.arrayBuffer())
        if (keyBytes.length !== 16) throw new Error('解密密钥长度异常')
      }

      for (let index = 0; index < total; index += 1) {
        if (job.cancelled) break
        const segmentUrl = playlist.segments[index]
        const response = await N.fetchBinary(segmentUrl, { ...init, timeout: 30000 })
        if (!response.ok) throw new Error(`分片 ${index + 1} 下载失败：HTTP ${response.status}`)
        let buffer = new Uint8Array(await response.arrayBuffer())
        if (keyBytes) {
          const iv = ivFromHex(playlist.key?.iv) || sequenceIv(playlist.mediaSequence + index)
          buffer = await decryptAes128(buffer, keyBytes, iv)
        }
        bytes += buffer.length
        await this._append(job, partPath, buffer)
        this.emit(job, {
          percent: Math.min(99, Math.round(((index + 1) / total) * 100)),
          bytes,
          segments: index + 1,
          totalSegments: total,
          speed: bytes / Math.max(0.3, (Date.now() - started) / 1000),
          kind: isFmp4 ? 'HLS/fMP4' : 'HLS/TS',
        })
      }
      if (job.cancelled) {
        await N.fs.delete(`${DOWNLOAD_DIR}/${partPath}`, 'CACHE')
        return { name: '' }
      }
      const published = await N.publishDownload({
        path: `${DOWNLOAD_DIR}/${partPath}`,
        name,
        mime: isFmp4 ? 'video/mp4' : 'video/mp2t',
        directory: 'CACHE',
      })
      await N.fs.delete(`${DOWNLOAD_DIR}/${partPath}`, 'CACHE')
      return { name, displayPath: published?.displayPath || published?.uri || name }
    }
  }

  window.CSPDownload = { DownloadManager, sanitizeFileName, parsePlaylist }
})()
