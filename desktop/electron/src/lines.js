'use strict'

const { net } = require('electron')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'

const SAMPLE_URL = 'https://www.iqiyi.com/v_b13ju3xx7s.html?lt=2'

// 内置线路：全部来自互联网上公开的第三方解析服务。
// 这类服务变动非常频繁，所以程序支持「线路管理 / 在线更新线路」，
// 失效时请换一条线路，或在设置里填入你自己可用的接口。
const DEFAULT_LINES = [
  {
    id: 'builtin-789',
    name: '789解析',
    kind: 'page',
    url: 'https://jiexi.789jiexi.icu:4433/?url={url}',
    enabled: true,
    builtin: true,
    note: '实测可出画面，四平台通用',
  },
  {
    id: 'builtin-playm3u8',
    name: 'PlayM3U8',
    kind: 'page',
    url: 'https://www.playm3u8.cn/jiexi.php?url={url}',
    enabled: true,
    builtin: true,
    note: '实测可出画面',
  },
  {
    id: 'builtin-pangu',
    name: '盘古解析',
    kind: 'page',
    url: 'https://www.pangujiexi.com/jiexi/?url={url}',
    enabled: true,
    builtin: true,
    note: '实测可出画面',
  },
  {
    id: 'builtin-ck',
    name: 'CK解析',
    kind: 'page',
    url: 'https://www.ckplayer.vip/jiexi/?url={url}',
    enabled: false,
    builtin: true,
    note: '时好时坏，备用',
  },
  {
    id: 'builtin-77flv',
    name: '七七云解析',
    kind: 'page',
    url: 'https://jx.77flv.cc/?url={url}',
    enabled: false,
    builtin: true,
    note: '部分视频只返回占位画面',
  },
  {
    id: 'builtin-xmflv',
    name: '虾米解析',
    kind: 'page',
    url: 'https://jx.xmflv.com/?url={url}',
    enabled: false,
    builtin: true,
    note: '稳定性一般，默认关闭',
  },
  {
    id: 'builtin-2s0',
    name: '极速解析',
    kind: 'page',
    url: 'https://jx.2s0.cn/player/?url={url}',
    enabled: false,
    builtin: true,
    note: '备用',
  },
  {
    id: 'builtin-playerjy',
    name: 'PlayerJY',
    kind: 'page',
    url: 'https://jx.playerjy.com/?url={url}',
    enabled: false,
    builtin: true,
    note: '部分地区无法访问',
  },
  {
    id: 'builtin-m1907',
    name: 'M1907',
    kind: 'page',
    url: 'https://im1907.top/?jx={url}',
    enabled: false,
    builtin: true,
    note: '演示接口，多数视频无法解析',
  },
  {
    id: 'builtin-yemu',
    name: '夜幕',
    kind: 'page',
    url: 'https://www.yemu.xyz/?url={url}',
    enabled: false,
    builtin: true,
    note: '站点已改版，仅作备用',
  },
  {
    id: 'builtin-direct',
    name: '官网页面（会员登录）',
    kind: 'direct',
    url: 'direct://video',
    enabled: false,
    builtin: true,
    note: '不做解析，直接打开原片页面；适合已登录的会员',
  },
]

function isHttpUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeUrlText(raw) {
  let text = String(raw || '').trim()
  if (!text) return ''
  // 从「复制这段内容打开...」之类的分享文案里抠出链接
  const match = text.match(/https?:\/\/[^\s"'<>，。、）)】]+/i)
  if (match) text = match[0]
  text = text.replace(/[，。、；）)\]】]+$/, '')
  return text
}

function buildLineUrl(template, videoUrl) {
  const base = String(template || '').trim()
  if (!base) throw new Error('线路地址为空')
  const encoded = encodeURIComponent(videoUrl)
  if (base.includes('{url}')) return base.split('{url}').join(encoded)
  if (base.includes('{urlRaw}')) return base.split('{urlRaw}').join(videoUrl)
  return base + encoded
}

function decodeCandidate(raw) {
  let text = String(raw || '').trim()
  if (!text) return ''
  text = text.replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/\\u002F/gi, '/')
  if (/^https?%3A/i.test(text)) {
    try {
      text = decodeURIComponent(text)
    } catch {
      /* 保持原样 */
    }
  }
  if (!/^https?:\/\//i.test(text)) return ''
  return text
}

function isPlayableStream(url) {
  if (!url) return false
  return /\.(m3u8|mp4|flv|m4v)([?#]|$)/i.test(url) || /\/(m3u8|hls)\//i.test(url)
}

function deepCollect(value, out, depth = 0) {
  if (depth > 8 || value == null) return
  if (typeof value === 'string') {
    const candidate = decodeCandidate(value)
    if (candidate && isPlayableStream(candidate)) out.push(candidate)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) deepCollect(item, out, depth + 1)
    return
  }
  if (typeof value === 'object') {
    // 常见字段优先，其次遍历全部
    for (const key of ['url', 'playurl', 'playUrl', 'm3u8', 'm3u8url', 'video', 'src', 'data', 'result']) {
      if (Object.prototype.hasOwnProperty.call(value, key)) deepCollect(value[key], out, depth + 1)
    }
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' || (item && typeof item === 'object')) deepCollect(item, out, depth + 1)
    }
  }
}

function extractStream(text) {
  const raw = String(text || '')
  if (!raw.trim()) return ''
  const out = []
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      deepCollect(JSON.parse(trimmed), out)
    } catch {
      /* 不是完整 JSON，继续走正则 */
    }
  }
  const regex = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4|flv)(?:\?[^\s"'<>\\]*)?/gi
  let match
  while ((match = regex.exec(raw)) !== null) {
    const candidate = decodeCandidate(match[0].replace(/[),，。；;]+$/, ''))
    if (candidate) out.push(candidate)
  }
  // 有的接口把地址放在 iframe / player 参数里（?url=https%3A%2F%2F...m3u8）
  const encoded = raw.match(/https?%3A%2F%2F[^\s"'<>]+?(?:m3u8|mp4)[^\s"'<>]*/gi) || []
  for (const item of encoded) {
    const candidate = decodeCandidate(item)
    if (candidate) out.push(candidate)
  }
  const unique = [...new Set(out)].filter(isPlayableStream)
  unique.sort((a, b) => {
    const score = (url) => (/(\.m3u8)([?#]|$)/i.test(url) ? 2 : 0) + (/^https:/i.test(url) ? 1 : 0)
    return score(b) - score(a)
  })
  return unique[0] || ''
}

async function fetchText(target, timeout = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await net.fetch(target, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
      },
    })
    const text = await response.text()
    return { ok: response.ok, status: response.status, text, finalUrl: response.url || target }
  } finally {
    clearTimeout(timer)
  }
}

async function parseWithLine({ videoUrl, line }) {
  if (!videoUrl || !isHttpUrl(videoUrl)) throw new Error('视频链接格式不正确')
  if (!line) throw new Error('没有可用的解析线路')
  if (line.kind === 'direct') return { kind: 'page', url: videoUrl, note: '官网页面模式' }
  const target = buildLineUrl(line.url, videoUrl)
  if (line.kind === 'page') return { kind: 'page', url: target }
  if (line.kind === 'api') {
    const response = await fetchText(target, 15000)
    if (!response.ok && response.status >= 400) {
      throw new Error(`解析接口返回 HTTP ${response.status}`)
    }
    const streamUrl = extractStream(response.text)
    if (!streamUrl) return { kind: 'none', error: '接口没有返回 m3u8 / mp4 地址' }
    return { kind: 'stream', streamUrl, referer: line.referer || '' }
  }
  throw new Error(`未知的线路类型：${line.kind}`)
}

async function testLine(line, sampleUrl = SAMPLE_URL) {
  if (!line) return { ok: false, ms: 0, note: '线路不存在' }
  if (line.kind === 'direct') return { ok: true, ms: 0, note: '本地模式，无需网络' }
  const started = Date.now()
  try {
    if (line.kind === 'api') {
      const result = await parseWithLine({ videoUrl: sampleUrl, line })
      const ms = Date.now() - started
      if (result.kind === 'stream') return { ok: true, ms, note: '已解析出播放地址' }
      return { ok: false, ms, note: result.error || '没有解析结果' }
    }
    const target = buildLineUrl(line.url, sampleUrl)
    const response = await fetchText(target, 12000)
    const ms = Date.now() - started
    if (!response.ok) return { ok: false, ms, note: `HTTP ${response.status}` }
    if (response.text.length < 200) return { ok: false, ms, note: '响应内容过短，可能已失效' }
    return { ok: true, ms, note: '页面可访问（解析效果以实际播放为准）' }
  } catch (error) {
    return { ok: false, ms: Date.now() - started, note: String(error?.message || error).slice(0, 80) }
  }
}

const RAW_LINE_FEEDS = [
  'https://gh.monlor.com/https://raw.githubusercontent.com/fjz-hosts/changshipin-jiexi/main/lines.json',
  'https://gh-proxy.com/https://raw.githubusercontent.com/fjz-hosts/changshipin-jiexi/main/lines.json',
  'https://cdn.jsdelivr.net/gh/fjz-hosts/changshipin-jiexi@main/lines.json',
  'https://raw.githubusercontent.com/fjz-hosts/changshipin-jiexi/main/lines.json',
]

async function fetchOnlineLines() {
  const errors = []
  for (const feed of RAW_LINE_FEEDS) {
    try {
      const response = await fetchText(feed, 12000)
      if (!response.ok) {
        errors.push(`${feed} → HTTP ${response.status}`)
        continue
      }
      const data = JSON.parse(response.text)
      const lines = Array.isArray(data) ? data : data.lines
      if (!Array.isArray(lines) || !lines.length) {
        errors.push(`${feed} → 清单为空`)
        continue
      }
      return { ok: true, lines, updatedAt: data.updatedAt || '', feed }
    } catch (error) {
      errors.push(`${feed} → ${String(error?.message || error).slice(0, 60)}`)
    }
  }
  return { ok: false, errors }
}

module.exports = {
  UA,
  SAMPLE_URL,
  DEFAULT_LINES,
  isHttpUrl,
  normalizeUrlText,
  buildLineUrl,
  extractStream,
  parseWithLine,
  testLine,
  fetchOnlineLines,
  fetchText,
}
