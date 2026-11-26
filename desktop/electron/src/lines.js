'use strict'

const crypto = require('node:crypto')
const { net } = require('electron')
const { parseTitleInfo, isMovieTitle, matchCmsList, pickCmsStream } = require('./titlematch')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'

const SAMPLE_URL = 'https://www.iqiyi.com/v_b13ju3xx7s.html?lt=2'

const SAMPLE_URLS = {
  iqiyi: SAMPLE_URL,
  qq: 'https://v.qq.com/x/cover/mzc002001w361jz/x4102olnagg.html',
  youku: 'https://v.youku.com/v_show/id_XNjU3MzkyOTA0NA==.html',
  mgtv: 'https://www.mgtv.com/b/817372/24773914.html',
}

// 内置线路：第三方解析服务 + 平台原生解析（芒果TV / 腾讯视频）。
// 第三方服务变动非常频繁，所以程序支持「线路管理 / 在线更新线路」，
// 失效时请换一条线路，或在设置里填入你自己可用的接口。
const DEFAULT_LINES = [
  {
    id: 'builtin-cms-baide',
    name: '白得资源站',
    kind: 'cms',
    url: 'https://api.apibdzy.com/api.php/provide/vod/',
    enabled: true,
    builtin: true,
    note: '按剧名+集数匹配采集源，实测 1080P + 128kbps 音轨（解析站只有 64~70kbps）；匹配不到会自动回落到网页线路',
  },
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
    id: 'builtin-mgtv-native',
    name: '芒果TV 原生解析',
    kind: 'mgtv',
    url: 'mgtv://auto',
    enabled: true,
    builtin: true,
    platform: 'mgtv',
    note: '内置芒果TV 接口，需国内网络；在芒果内置窗口登录会员后可解 VIP',
  },
  {
    id: 'builtin-iqiyi-native',
    name: '爱奇艺 原生解析',
    kind: 'native',
    url: 'native://auto',
    enabled: false,
    builtin: true,
    platform: 'iqiyi',
    note: 'yt-dlp 当前无法解析新版爱奇艺页面（播放地址由 cmd5x 签名接口下发，旧接口已失效），暂不启用；失败会自动用第三方线路',
  },
  {
    id: 'builtin-qq-native',
    name: '腾讯视频 原生解析',
    kind: 'native',
    url: 'native://auto',
    enabled: true,
    builtin: true,
    platform: 'qq',
    note: '备用线路：第三方线路都失败后才尝试。腾讯视频官方接口（按 yt-dlp 流程），电影 / 电视剧 / 动漫通用；免费内容 720P，付费电影通常只给试听',
  },
  {
    id: 'builtin-youku-native',
    name: '优酷 原生解析',
    kind: 'native',
    url: 'native://auto',
    enabled: false,
    builtin: true,
    platform: 'youku',
    note: 'yt-dlp 的 ups.youku.com 接口对匿名设备返回 -6004（限制播放），暂不启用；失败会自动用第三方线路',
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

// ---------------------------------------------------------------------------
// 流时长测量：用来识别「只拿到试看」的情况
//
// 平台对 付费 / 云影院 影片只下发几十秒到 5 分钟的试看流，第三方线路拿到后
// 也会原样返回。这里把 m3u8 的分片时长加起来，判断它是不是完整正片。
// ---------------------------------------------------------------------------

const PREVIEW_MAX_SECONDS = 600

function pickBestVariant(text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/)
  let best = ''
  let bestBandwidth = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue
    const bandwidth = Number((line.match(/BANDWIDTH=(\d+)/i) || [])[1]) || 0
    let next = ''
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor].trim()
      if (!candidate || candidate.startsWith('#')) continue
      next = candidate
      break
    }
    if (!next || bandwidth < bestBandwidth) continue
    bestBandwidth = bandwidth
    try {
      best = new URL(next, baseUrl).href
    } catch {
      best = next
    }
  }
  return best
}

async function measureStream(streamUrl, { referer = '', cookie = '', timeout = 8000 } = {}) {
  const result = { duration: 0, segments: 0, drm: false, live: false }
  if (!/\.m3u8([?#]|$)/i.test(streamUrl) && !/\/m3u8\//i.test(streamUrl)) return result
  const headers = {
    'user-agent': UA,
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
  }
  if (referer) headers.referer = referer
  if (cookie) headers.cookie = cookie
  const load = async (target) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      // 用 Node 的 fetch：它允许手动带 Referer（Chromium 的 net 会拦掉）
      const response = await fetch(target, { signal: controller.signal, redirect: 'follow', headers })
      return { ok: response.ok, url: response.url || target, text: await response.text() }
    } catch {
      return { ok: false, url: target, text: '' }
    } finally {
      clearTimeout(timer)
    }
  }
  let playlist = await load(streamUrl)
  if (!playlist.ok || !playlist.text.includes('#EXTM3U')) return result
  if (/#EXT-X-STREAM-INF/i.test(playlist.text)) {
    const variant = pickBestVariant(playlist.text, playlist.url)
    if (variant) {
      const child = await load(variant)
      if (child.ok && child.text.includes('#EXTM3U')) playlist = child
    }
  }
  const total = [...playlist.text.matchAll(/#EXTINF:\s*([\d.]+)/g)].reduce((sum, match) => sum + (Number(match[1]) || 0), 0)
  result.duration = Math.round(total)
  result.segments = (playlist.text.match(/#EXTINF:/g) || []).length
  // 会员流常见 SAMPLE-AES / DRM，内置播放器解不了
  result.drm = /#EXT-X-(?:SESSION-)?KEY:[^\n]*METHOD=(?!NONE|AES-128)/i.test(playlist.text)
  result.live = !/#EXT-X-ENDLIST/i.test(playlist.text) && result.segments > 0 && result.duration < 60
  return result
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

// ---------------------------------------------------------------------------
// 芒果TV 原生解析（按 yt-dlp 的 tk2 / getSource 流程移植）
// 不依赖第三方解析站，但受芒果 TV 的地区限制与会员鉴权影响。
// ---------------------------------------------------------------------------

function mgtvVideoId(videoUrl) {
  const match = String(videoUrl).match(/\/(\d+)\.html/)
  return match ? match[1] : ''
}

function mgtvTk2() {
  const raw = `did=${crypto.randomUUID()}|pno=1030|ver=0.3.0301|clit=${Math.floor(Date.now() / 1000)}`
  const base64 = Buffer.from(raw, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
  return base64.split('').reverse().join('')
}

async function fetchJson(target, headers, timeout = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    // 这里用 Node 的 fetch：Chromium 的 net 模块会拦截手动设置的 Referer/Cookie，
    // 而芒果TV 接口必须带 Referer 与登录 Cookie。
    const response = await fetch(target, {
      signal: controller.signal,
      redirect: 'follow',
      headers,
    })
    const text = await response.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON */
    }
    const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    return { ok: response.ok, status: response.status, json, text, setCookies }
  } finally {
    clearTimeout(timer)
  }
}

// 网络抖动时 fetch 会直接抛 "fetch failed"：芒果接口偶发一次就成功，重试一次更划算
async function fetchJsonRetry(target, headers, timeout = 15000, attempts = 2) {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetchJson(target, headers, timeout)
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }
  throw lastError
}

function mergeCookieHeader(existing, setCookies = []) {
  const jar = new Map()
  for (const part of String(existing || '').split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    jar.set(trimmed.slice(0, index).trim(), trimmed.slice(index + 1).trim())
  }
  for (const raw of setCookies) {
    const first = String(raw || '').split(';')[0]
    const index = first.indexOf('=')
    if (index <= 0) continue
    jar.set(first.slice(0, index).trim(), first.slice(index + 1).trim())
  }
  return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ')
}

async function extractMango(videoUrl, cookieHeader = '') {
  const videoId = mgtvVideoId(videoUrl)
  if (!videoId) return { kind: 'none', error: '无法从链接中识别芒果TV 视频 ID' }
  const tk2 = mgtvTk2()
  let jar = cookieHeader
  const headersFor = (extra = {}) => {
    const headers = {
      'user-agent': UA,
      referer: videoUrl,
      origin: 'https://www.mgtv.com',
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
      ...extra,
    }
    if (jar) headers.cookie = jar
    return headers
  }

  let player
  try {
    player = await fetchJsonRetry(
      `https://pcweb.api.mgtv.com/player/video?tk2=${encodeURIComponent(tk2)}&video_id=${videoId}&type=pch5`,
      headersFor(),
    )
    jar = mergeCookieHeader(jar, player.setCookies)
  } catch (error) {
    return { kind: 'none', error: `芒果TV 接口请求失败：${String(error?.message || error).slice(0, 60)}` }
  }
  const pm2 = player.json?.data?.atc?.pm2
  if (!pm2) {
    const message = player.json?.msg || player.json?.err_msg || ''
    if (/地区|country|region|地域/i.test(message) || player.status === 403) {
      return { kind: 'none', error: '芒果TV 提示地区限制（需要在中国大陆网络下使用）' }
    }
    return {
      kind: 'none',
      error: `芒果TV 没有返回播放参数${message ? `：${message}` : ''}（可能需要登录芒果会员）`,
    }
  }

  let source
  try {
    source = await fetchJsonRetry(
      `https://tinker.glb.mgtv.com/player/getSource?_support=10000000&tk2=${encodeURIComponent(tk2)}&pm2=${encodeURIComponent(pm2)}&video_id=${videoId}&type=pch5&auth_mode=1&cxid=&supportMse=1&src=mgtv&abroad=10&allowedRC=1`,
      headersFor(),
    )
    jar = mergeCookieHeader(jar, source.setCookies)
  } catch (error) {
    return { kind: 'none', error: `芒果TV 取流接口失败（已重试）：${String(error?.message || error).slice(0, 60)}` }
  }
  if (source.json?.code === 40005 || /地区|country|region/i.test(source.json?.msg || '')) {
    return { kind: 'none', error: '芒果TV 提示地区限制（需要在中国大陆网络下使用）' }
  }
  const data = source.json?.data || {}
  const streams = (Array.isArray(data.stream) ? data.stream : []).filter((item) => item && item.url)
  if (!streams.length) {
    const message = source.json?.msg || source.json?.err_msg || ''
    return {
      kind: 'none',
      error: `芒果TV 没有返回可播放流${message ? `：${message}` : ''}（VIP 内容需要在芒果内置窗口登录会员）`,
    }
  }

  const domains = [].concat(data.stream_domain || []).filter(Boolean)
  const domain = domains[0] || 'https://tinker.glb.mgtv.com'
  streams.sort((a, b) => (Number(b.filebitrate) || 0) - (Number(a.filebitrate) || 0))

  for (const stream of streams.slice(0, 6)) {
    try {
      const target = /^https?:/i.test(stream.url) ? stream.url : new URL(stream.url, domain).href
      const info = await fetchJson(target, headersFor({ referer: videoUrl }))
      jar = mergeCookieHeader(jar, info.setCookies)
      const streamUrl = info.json?.info || info.json?.data?.info
      if (typeof streamUrl === 'string' && /^https?:\/\//i.test(streamUrl)) {
        return {
          kind: 'stream',
          streamUrl,
          referer: videoUrl,
          title: player.json?.data?.info?.title || '',
        }
      }
    } catch {
      /* 尝试下一种清晰度 */
    }
  }
  return { kind: 'none', error: '芒果TV 播放地址解析失败（可能需要在芒果内置窗口登录会员）' }
}

// ---------------------------------------------------------------------------
// 资源站（苹果CMS 采集接口）解析：按「剧名 + 集数」匹配直链 m3u8
//
// 为什么需要它：第三方「解析」站基本都把音轨二次压到 64~70 kbps（实测 789 / 盘古
// 同一后端 69 kbps、带宽只有 12.5 kHz），而采集站给的是搬运源，实测 1080P +
// 128 kbps 音轨、带宽 16.5 kHz，音质明显更好。匹配不到时仍然回落到网页线路。
// ---------------------------------------------------------------------------

const USELESS_TITLE = /^(?:electron|video|视频|腾讯视频|爱奇艺|优酷|芒果tv|芒果TV)$/i

async function fetchCmsList(api, name, timeout = 9000) {
  const target = `${api}${api.includes('?') ? '&' : '?'}ac=detail&wd=${encodeURIComponent(name)}`
  let response = null
  let lastError = null
  // 采集站偶尔几秒不回包，重试一次比直接失败更划算
  for (let attempt = 0; attempt < 2 && !response; attempt += 1) {
    try {
      response = await fetchText(target, attempt === 0 ? timeout : timeout + 4000)
    } catch (error) {
      lastError = error
    }
  }
  if (!response) {
    return { ok: false, error: `资源站搜索失败：${String(lastError?.message || lastError).slice(0, 50)}` }
  }
  try {
    const data = JSON.parse(response.text)
    return { ok: true, list: Array.isArray(data?.list) ? data.list : [] }
  } catch (error) {
    return { ok: false, error: `资源站返回内容无法解析：${String(error?.message || error).slice(0, 40)}` }
  }
}

async function extractCms(videoUrl, line, titleHint = '', episodeHint = '') {
  const api = String(line?.url || '').trim()
  if (!api) return { kind: 'none', error: '资源站接口地址为空' }
  let pageTitle = String(titleHint || '').trim()
  const hintEpisode = Number((String(episodeHint || '').match(/(\d+)/) || [])[1]) || 0
  const hinted = parseTitleInfo(pageTitle)
  // 只有「标题信息太少」时才回源抓页面：标题已经能拆出剧名 + 集数就不要再等一次页面请求
  if (!hintEpisode && !hinted.episode && (USELESS_TITLE.test(pageTitle) || hinted.names.length <= 1)) {
    try {
      // 用 Chromium 的 net.fetch：部分采集站的 CDN 对 Node 的 TLS 握手会直接重置连接
      const page = await fetchText(videoUrl, 12000)
      const raw = (page.text.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || [])[1] || ''
      const tag = (page.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''
      const fetched = String(raw || tag || '').trim()
      if (fetched) {
        // 不要丢掉渲染层已经传来的准确标题：拼在后面一起当候选（也用来补集数）
        pageTitle = pageTitle && !USELESS_TITLE.test(pageTitle) ? `${pageTitle}_${fetched}` : fetched
      }
    } catch {
      /* 页面拿不到就用标题提示继续匹配 */
    }
  }
  const info = parseTitleInfo(pageTitle)
  if (!info.names.length) return { kind: 'none', error: '没能从页面标题识别出剧名' }
  const episode = hintEpisode || info.episode
  const movie = isMovieTitle(pageTitle)

  // 平台页面标题的第一段经常是营销标语（如「九年青春，终极一战！_动漫_… 双帝之战」），
  // 依次用候选剧名搜资源站，命中就停，避免拿标语去搜导致「资源站没有」。
  const collected = []
  const seen = new Set()
  let searchError = ''
  const deadline = Date.now() + 20000
  for (const name of info.names.slice(0, 4)) {
    if (Date.now() > deadline) break
    const searched = await fetchCmsList(api, name, 9000)
    if (!searched.ok) {
      searchError = searched.error
      continue
    }
    for (const item of searched.list) {
      const key = `${item?.vod_id || ''}|${item?.vod_name || ''}`
      if (seen.has(key)) continue
      seen.add(key)
      collected.push(item)
    }
    if (matchCmsList(collected, info.names).items.length) break
  }
  if (!collected.length) return { kind: 'none', error: searchError || `资源站没有《${info.name}》` }

  const matched = matchCmsList(collected, info.names)
  if (!matched.items.length) return { kind: 'none', error: `资源站没有《${info.name}》` }
  // 集数最全的那条源优先
  const ordered = [...matched.items].sort(
    (left, right) => String(right?.vod_play_url || '').split('#').length - String(left?.vod_play_url || '').split('#').length,
  )
  for (const item of ordered) {
    const picked = pickCmsStream(item.vod_play_url, episode, { movie })
    if (!picked.url) continue
    let referer = ''
    try {
      referer = `${new URL(picked.url).origin}/`
    } catch {
      /* 没有 referer 也能试 */
    }
    const showName = String(item.vod_name || info.name)
      .replace(/\s+/g, ' ')
      .replace(/[?？]+$/, '')
      .trim()
    return { kind: 'stream', streamUrl: picked.url, referer, title: episode ? `${showName} 第${episode}集` : showName }
  }
  return {
    kind: 'none',
    error: episode
      ? `《${info.name}》没有第 ${episode} 集`
      : `《${info.name}》是剧集，缺少集数（请从选集里点某一集再解析）`,
  }
}

async function parseWithLine({ videoUrl, line, cookieHeader = '', titleHint = '', episodeHint = '' }) {
  if (!videoUrl || !isHttpUrl(videoUrl)) throw new Error('视频链接格式不正确')
  if (!line) throw new Error('没有可用的解析线路')
  if (line.kind === 'direct') return { kind: 'page', url: videoUrl, note: '官网页面模式' }
  if (line.kind === 'cms') return await extractCms(videoUrl, line, titleHint, episodeHint)
  if (line.kind === 'mgtv') return await extractMango(videoUrl, cookieHeader)
  if (line.kind === 'native') {
    const { parseNative } = require('./nativeparse')
    return await parseNative({ url: videoUrl, platform: line.platform, cookie: cookieHeader })
  }
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
  // 平台专属线路用自己的平台样例测，否则“不适用于当前链接”会被误判成失效
  if (line.platform && SAMPLE_URLS[line.platform] && !new RegExp(`${line.platform}\\.com`, 'i').test(sampleUrl)) {
    sampleUrl = SAMPLE_URLS[line.platform]
  }
  if (line.platform && !new RegExp(`${line.platform}\\.com`, 'i').test(sampleUrl)) {
    return { ok: false, ms: 0, note: `仅用于${line.platform}（当前测速链接不是该平台）` }
  }
  const started = Date.now()
  try {
    if (line.kind === 'mgtv') {
      const result = await extractMango(sampleUrl)
      const ms = Date.now() - started
      if (result.kind === 'stream') return { ok: true, ms, note: '已解析出芒果TV 播放地址' }
      return { ok: false, ms, note: result.error || '芒果TV 解析失败' }
    }
    if (line.kind === 'cms') {
      // 资源站要看「剧名 + 集数」才能出结果，体检只验证接口是否可访问，
      // 否则固定样例链接会被误判成失效，把这条线路排到换线链末尾。
      const api = String(line.url || '').trim()
      const url = `${api}${api.includes('?') ? '&' : '?'}ac=detail&wd=${encodeURIComponent('测试')}`
      let response = null
      let lastError = null
      for (let attempt = 0; attempt < 2 && !response; attempt += 1) {
        try {
          response = await fetchText(url, attempt === 0 ? 9000 : 12000)
        } catch (error) {
          lastError = error
        }
      }
      const ms = Date.now() - started
      if (!response) return { ok: false, ms, note: String(lastError?.message || lastError).slice(0, 60) }
      if (!response.ok) return { ok: false, ms, note: `HTTP ${response.status}` }
      if (!/"list"/.test(response.text)) return { ok: false, ms, note: '资源站返回内容不是采集接口格式' }
      return { ok: true, ms, note: '资源站接口可访问（播放时按剧名+集数匹配）' }
    }
    if (line.kind === 'api') {
      const result = await parseWithLine({ videoUrl: sampleUrl, line })
      const ms = Date.now() - started
      if (result.kind === 'stream') return { ok: true, ms, note: '已解析出播放地址' }
      return { ok: false, ms, note: result.error || '没有解析结果' }
    }
    if (line.kind === 'native') {
      const result = await parseWithLine({ videoUrl: sampleUrl, line })
      const ms = Date.now() - started
      if (result.kind === 'stream') return { ok: true, ms, note: `原生解析可用（${result.note || '已解析'}）` }
      return { ok: false, ms, note: result.error || '原生解析失败' }
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
  SAMPLE_URLS,
  DEFAULT_LINES,
  PREVIEW_MAX_SECONDS,
  isHttpUrl,
  normalizeUrlText,
  buildLineUrl,
  extractStream,
  measureStream,
  parseWithLine,
  testLine,
  fetchOnlineLines,
  fetchText,
}
