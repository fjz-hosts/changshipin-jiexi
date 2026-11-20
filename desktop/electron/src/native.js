'use strict'

/**
 * 平台原生取流（实验）。
 *
 * 不逆向签名接口：在一个隐藏窗口里用该平台的登录分区打开原片页，
 * 监听页面自己播放器发出的 m3u8 / mp4 请求，挑时长最长的那条（避开贴片广告），
 * 再交给内置播放器 + 本地代理播放。这样免费内容可以绕开第三方解析站，
 * 也能记录观看进度；会员 DRM 内容仍会失败并自动回退到第三方线路。
 */

const { BrowserWindow, session } = require('electron')
const { UA } = require('./lines')

// 复用「内置浏览器」的平台分区：用户在里面登录会员后，隐藏窗口取流也能带上登录态，
// 会员 / 高清内容才有机会拿到正片流（云影院等单片付费内容仍需购买）。
const PARTITION = (key) => `persist:platform-${key}`

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchText(target, headers, timeout = 9000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(target, { signal: controller.signal, headers, redirect: 'follow' })
    const text = await response.text()
    return { ok: response.ok, status: response.status, text }
  } catch {
    return { ok: false, status: 0, text: '' }
  } finally {
    clearTimeout(timer)
  }
}

function playlistDuration(text) {
  let total = 0
  let count = 0
  const regex = /#EXTINF:\s*([\d.]+)/g
  let match
  while ((match = regex.exec(text)) !== null) {
    total += Number(match[1]) || 0
    count += 1
  }
  return { total, count }
}

function isMasterPlaylist(text) {
  return /#EXT-X-STREAM-INF/i.test(text)
}

function firstVariant(text, baseUrl) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('#EXT-X-STREAM-INF')) continue
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]
      if (!line || line.startsWith('#')) continue
      try {
        return new URL(line, baseUrl).href
      } catch {
        return ''
      }
    }
  }
  return ''
}

async function mediaScore(candidate, headers) {
  if (/\.mp4([?#]|$)/i.test(candidate)) return { score: 1000, kind: 'mp4', duration: 0, drm: false, base: candidate }
  const response = await fetchText(candidate, headers)
  if (!response.ok || !response.text.includes('#EXTM3U')) return { score: 0, kind: 'm3u8', duration: 0, drm: false, base: candidate }
  let text = response.text
  let base = candidate
  if (isMasterPlaylist(text)) {
    const variant = firstVariant(text, candidate)
    if (variant) {
      const child = await fetchText(variant, headers)
      if (child.ok && child.text.includes('#EXTM3U')) {
        text = child.text
        base = variant
      }
    }
  }
  // 会员内容常见 SAMPLE-AES / DRM，内置播放器解不了，直接判定这条候选不可用
  const drm = /#EXT-X-(?:SESSION-)?KEY:[^\n]*METHOD=(?!NONE|AES-128)/i.test(text)
  const { total, count } = playlistDuration(text)
  return { score: drm ? 0 : total + count, kind: 'm3u8', duration: total, base, drm }
}

function firstSegmentOf(text, baseUrl) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    try {
      return new URL(trimmed, baseUrl).href
    } catch {
      return ''
    }
  }
  return ''
}

// 真正能播才算数：拉一次分片前 1KB，CDN 常见 405（防盗链/签名不匹配）就在这里暴露
async function probePlayable(candidate, headers) {
  try {
    const signal = AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined
    if (candidate.kind === 'mp4') {
      const response = await fetch(candidate.url, { headers: { ...headers, range: 'bytes=0-1023' }, signal })
      return { ok: response.status === 200 || response.status === 206, status: response.status }
    }
    const playlist = await fetchText(candidate.base || candidate.url, headers)
    if (!playlist.ok) return { ok: false, status: playlist.status }
    let text = playlist.text
    if (isMasterPlaylist(text)) {
      const variant = firstVariant(text, candidate.base || candidate.url)
      if (!variant) return { ok: false, status: 0 }
      const child = await fetchText(variant, headers)
      if (!child.ok) return { ok: false, status: child.status }
      text = child.text
    }
    const segment = firstSegmentOf(text, candidate.base || candidate.url)
    if (!segment) return { ok: false, status: 0 }
    const response = await fetch(segment, { headers: { ...headers, range: 'bytes=0-1023' }, signal })
    return { ok: response.status === 200 || response.status === 206, status: response.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

async function sniffNative({ url, platform, timeout = 18000 } = {}) {
  const key = platform || 'iqiyi'
  const partition = PARTITION(key)
  const part = session.fromPartition(partition)
  part.setUserAgent(UA)
  const candidates = []
  const started = Date.now()
  let win = null
  let firstSeenAt = 0

  const handler = (details, callback) => {
    try {
      const target = String(details.url || '')
      if (!/^https?:\/\//i.test(target)) return callback({})
      if (!/\.(m3u8|mp4|flv)(\?|#|$)/i.test(target) && !/\/m3u8\//i.test(target)) return callback({})
      if (/\.(ts|m4s|jpg|jpeg|png|webp|avif)(\?|#|$)/i.test(target)) return callback({})
      if (!candidates.some((item) => item.url === target)) {
        candidates.push({ url: target, at: Date.now() })
        if (!firstSeenAt) firstSeenAt = Date.now()
      }
    } catch {
      /* 忽略 */
    }
    return callback({})
  }

  try {
    part.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, handler)
    win = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      width: 1280,
      height: 800,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })

    // 页面加载后主动尝试播放，部分平台需要一次 play()
    win.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        win?.webContents
          .executeJavaScript(
            `(() => {
              const video = document.querySelector('video')
              if (video) { video.muted = true; video.play().catch(() => {}) }
              const button = document.querySelector('[class*=play],[aria-label*=播放]')
              if (button && button.click) { try { button.click() } catch (error) {} }
              return true
            })()`,
            true,
          )
          .catch(() => {})
      }, 1200)
    })
    win.loadURL(url).catch(() => {})

    // 等到有候选后多等 3 秒，让贴片广告之后的正片请求也进列表
    while (Date.now() - started < timeout) {
      if (firstSeenAt && Date.now() - firstSeenAt > 3000) break
      if (Date.now() - started > 10000 && candidates.length) break
      await sleep(400)
    }
    if (!candidates.length) return { kind: 'none', error: '平台页面没有发出可识别的视频流（可能需要登录/会员或 DRM）' }

    let title = ''
    try {
      title = String(await win.webContents.executeJavaScript('document.title', true)).slice(0, 80)
    } catch {
      /* 忽略 */
    }
    const headers = { 'user-agent': UA, referer: url, accept: '*/*' }
    const scored = []
    const evaluated = []
    for (const candidate of candidates.slice(-8)) {
      const score = await mediaScore(candidate.url, headers)
      evaluated.push({ ...candidate, ...score })
      if (score.score > 0) scored.push({ ...candidate, ...score })
    }
    scored.sort((left, right) => right.score - left.score)
    let picked = null
    let lastStatus = 0
    for (const candidate of scored) {
      const probe = await probePlayable(candidate, headers)
      if (probe.ok) {
        picked = candidate
        break
      }
      lastStatus = probe.status
    }
    if (!picked) {
      if (evaluated.some((item) => item.drm)) {
        return {
          kind: 'none',
          error: '平台返回的是 DRM 加密流（多为会员内容），内置播放器不支持，请使用第三方线路或官网页面',
        }
      }
      if (scored.length && lastStatus === 405) {
        return { kind: 'none', error: '平台 CDN 拒绝取流（HTTP 405，防盗链/签名不匹配），已无法用原生播放' }
      }
      return { kind: 'none', error: '嗅探到了流地址，但播放列表无法读取' }
    }
    return {
      kind: 'stream',
      streamUrl: picked.url,
      referer: url,
      title,
      note: `${picked.kind}${picked.duration ? ` · ${Math.round(picked.duration)} 秒` : ''}`,
    }
  } catch (error) {
    return { kind: 'none', error: `原生取流失败：${String(error?.message || error).slice(0, 120)}` }
  } finally {
    try {
      part.webRequest.onBeforeRequest(null)
    } catch {
      /* 忽略 */
    }
    try {
      win?.destroy()
    } catch {
      /* 忽略 */
    }
  }
}

module.exports = { sniffNative }
