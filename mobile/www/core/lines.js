/* 解析线路（手机端）：与桌面端 lines.js 同一套规则，改用原生取流代理发请求。 */
;(function () {
  'use strict'

  const N = window.CSPNative
  const P = window.CSPPlatforms

  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'

  const SAMPLE_URL = 'https://www.iqiyi.com/v_b13ju3xx7s.html?lt=2'
  const SAMPLE_URLS = {
    iqiyi: SAMPLE_URL,
    qq: 'https://v.qq.com/x/cover/mzc002001w361jz/x4102olnagg.html',
    youku: 'https://v.youku.com/v_show/id_XNjU3MzkyOTA0NA==.html',
    mgtv: 'https://www.mgtv.com/b/817372/24773914.html',
  }

  const DEFAULT_LINES = [
    { id: 'builtin-789', name: '789解析', kind: 'page', url: 'https://jiexi.789jiexi.icu:4433/?url={url}', enabled: true, builtin: true, note: '实测可出画面，四平台通用' },
    { id: 'builtin-playm3u8', name: 'PlayM3U8', kind: 'page', url: 'https://www.playm3u8.cn/jiexi.php?url={url}', enabled: true, builtin: true, note: '实测可出画面' },
    { id: 'builtin-pangu', name: '盘古解析', kind: 'page', url: 'https://www.pangujiexi.com/jiexi/?url={url}', enabled: true, builtin: true, note: '实测可出画面' },
    { id: 'builtin-ck', name: 'CK解析', kind: 'page', url: 'https://www.ckplayer.vip/jiexi/?url={url}', enabled: false, builtin: true, note: '时好时坏，备用' },
    { id: 'builtin-77flv', name: '七七云解析', kind: 'page', url: 'https://jx.77flv.cc/?url={url}', enabled: false, builtin: true, note: '部分视频只返回占位画面' },
    { id: 'builtin-xmflv', name: '虾米解析', kind: 'page', url: 'https://jx.xmflv.com/?url={url}', enabled: false, builtin: true, note: '稳定性一般，默认关闭' },
    { id: 'builtin-2s0', name: '极速解析', kind: 'page', url: 'https://jx.2s0.cn/player/?url={url}', enabled: false, builtin: true, note: '备用' },
    { id: 'builtin-playerjy', name: 'PlayerJY', kind: 'page', url: 'https://jx.playerjy.com/?url={url}', enabled: false, builtin: true, note: '部分地区无法访问' },
    { id: 'builtin-m1907', name: 'M1907', kind: 'page', url: 'https://im1907.top/?jx={url}', enabled: false, builtin: true, note: '演示接口，多数视频无法解析' },
    { id: 'builtin-yemu', name: '夜幕', kind: 'page', url: 'https://www.yemu.xyz/?url={url}', enabled: false, builtin: true, note: '站点已改版，仅作备用' },
    { id: 'builtin-mgtv-native', name: '芒果TV 原生解析', kind: 'mgtv', url: 'mgtv://auto', enabled: true, builtin: true, platform: 'mgtv', note: '内置芒果TV 接口，需国内网络；在芒果内置窗口登录会员后可解 VIP' },
    { id: 'builtin-iqiyi-native', name: '爱奇艺 原生取流（实验）', kind: 'native', url: 'native://auto', enabled: false, builtin: true, platform: 'iqiyi', note: '隐藏页面里让爱奇艺页面自己播放，抓真实 m3u8/mp4；免费内容可用，DRM/会员内容失败会自动换线' },
    { id: 'builtin-qq-native', name: '腾讯视频 原生取流（实验）', kind: 'native', url: 'native://auto', enabled: false, builtin: true, platform: 'qq', note: '隐藏页面里嗅探腾讯视频自己的播放流；免费内容可用，会员/DRM 内容失败会自动换线' },
    { id: 'builtin-youku-native', name: '优酷 原生取流（实验）', kind: 'native', url: 'native://auto', enabled: false, builtin: true, platform: 'youku', note: '隐藏页面里嗅探优酷自己的播放流；免费内容可用，会员/DRM 内容失败会自动换线' },
    { id: 'builtin-direct', name: '官网页面（会员登录）', kind: 'direct', url: 'direct://video', enabled: false, builtin: true, note: '不做解析，直接打开原片页面；适合已登录的会员' },
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
      for (const key of ['url', 'playurl', 'playUrl', 'm3u8', 'm3u8url', 'video', 'src', 'data', 'result']) {
        if (Object.prototype.hasOwnProperty.call(value, key)) deepCollect(value[key], out, depth + 1)
      }
      for (const item of Object.values(value)) {
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

  async function fetchText(target, timeout = 15000, options = {}) {
    const result = await N.fetchText(target, {
      timeout,
      referer: options.referer || '',
      cookie: options.cookie || '',
      method: options.method || 'GET',
      body: options.body || null,
      setCookie: Boolean(options.setCookie),
      headers: Object.assign(
        {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
        },
        options.headers || {},
      ),
    })
    return result
  }

  function mgtvVideoId(videoUrl) {
    const match = String(videoUrl).match(/\/(\d+)\.html/)
    return match ? match[1] : ''
  }

  function mgtvTk2() {
    const uuid =
      (window.crypto && typeof window.crypto.randomUUID === 'function' && window.crypto.randomUUID()) ||
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
        const r = (Math.random() * 16) | 0
        return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16)
      })
    const raw = `did=${uuid}|pno=1030|ver=0.3.0301|clit=${Math.floor(Date.now() / 1000)}`
    return N.b64url(raw).split('').reverse().join('')
  }

  async function fetchJson(target, headers, timeout = 15000) {
    const cookie = headers?.cookie || ''
    const referer = headers?.referer || ''
    const extra = { ...headers }
    delete extra.cookie
    delete extra.referer
    const result = await N.fetchText(target, {
      timeout,
      referer,
      cookie,
      setCookie: true,
      headers: {
        'user-agent': UA,
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
        ...extra,
      },
    })
    return {
      ok: result.ok,
      status: result.status,
      json: result.json,
      text: result.text,
      setCookies: result.setCookies || [],
    }
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
      player = await fetchJson(
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
      source = await fetchJson(
        `https://tinker.glb.mgtv.com/player/getSource?_support=10000000&tk2=${encodeURIComponent(tk2)}&pm2=${encodeURIComponent(pm2)}&video_id=${videoId}&type=pch5&auth_mode=1&cxid=&supportMse=1&src=mgtv&abroad=10&allowedRC=1`,
        headersFor(),
      )
      jar = mergeCookieHeader(jar, source.setCookies)
    } catch (error) {
      return { kind: 'none', error: `芒果TV 取流接口失败：${String(error?.message || error).slice(0, 60)}` }
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
            cookie: jar,
          }
        }
      } catch {
        /* 尝试下一种清晰度 */
      }
    }
    return { kind: 'none', error: '芒果TV 播放地址解析失败（可能需要在芒果内置窗口登录会员）' }
  }

  // ---------------------------------------------------------------------
  // 原生取流（实验）：用隐藏 WebView 嗅探候选，再在 JS 里做评分/可播性校验
  // ---------------------------------------------------------------------
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
    const options = { headers, referer: headers.referer || '', timeout: 9000 }
    if (/\.mp4([?#]|$)/i.test(candidate)) return { score: 1000, kind: 'mp4', duration: 0, drm: false, base: candidate }
    const response = await N.fetchText(candidate, options)
    if (!response.ok || !response.text.includes('#EXTM3U')) return { score: 0, kind: 'm3u8', duration: 0, drm: false, base: candidate }
    let text = response.text
    let base = candidate
    if (isMasterPlaylist(text)) {
      const variant = firstVariant(text, candidate)
      if (variant) {
        const child = await N.fetchText(variant, options)
        if (child.ok && child.text.includes('#EXTM3U')) {
          text = child.text
          base = variant
        }
      }
    }
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

  async function probePlayable(candidate, headers) {
    try {
      const referer = headers.referer || ''
      if (candidate.kind === 'mp4') {
        const response = await N.fetchBinary(candidate.url, {
          headers: { range: 'bytes=0-1023' },
          referer,
          timeout: 10000,
        })
        return { ok: response.status === 200 || response.status === 206, status: response.status }
      }
      const playlist = await N.fetchText(candidate.base || candidate.url, { headers, referer, timeout: 9000 })
      if (!playlist.ok) return { ok: false, status: playlist.status }
      let text = playlist.text
      if (isMasterPlaylist(text)) {
        const variant = firstVariant(text, candidate.base || candidate.url)
        if (!variant) return { ok: false, status: 0 }
        const child = await N.fetchText(variant, { headers, referer, timeout: 9000 })
        if (!child.ok) return { ok: false, status: child.status }
        text = child.text
      }
      const segment = firstSegmentOf(text, candidate.base || candidate.url)
      if (!segment) return { ok: false, status: 0 }
      const response = await N.fetchBinary(segment, {
        headers: { range: 'bytes=0-1023' },
        referer,
        timeout: 10000,
      })
      return { ok: response.status === 200 || response.status === 206, status: response.status }
    } catch {
      return { ok: false, status: 0 }
    }
  }

  async function sniffNative({ url, platform, timeout = 18000 } = {}) {
    const result = await N.sniff({ url, platform, timeout })
    const candidates = Array.isArray(result.candidates) ? result.candidates.slice(-8) : []
    if (!candidates.length) {
      return { kind: 'none', error: '平台页面没有发出可识别的视频流（可能需要登录/会员或 DRM）' }
    }
    const headers = { 'user-agent': UA, referer: url, accept: '*/*' }
    const scored = []
    const evaluated = []
    for (const candidate of candidates) {
      const score = await mediaScore(candidate, headers)
      evaluated.push({ url: candidate, ...score })
      if (score.score > 0) scored.push({ url: candidate, ...score })
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
      title: result.title || '',
      note: `${picked.kind}${picked.duration ? ` · ${Math.round(picked.duration)} 秒` : ''}`,
    }
  }

  async function parseWithLine({ videoUrl, line, cookieHeader = '' }) {
    if (!videoUrl || !isHttpUrl(videoUrl)) throw new Error('视频链接格式不正确')
    if (!line) throw new Error('没有可用的解析线路')
    if (line.kind === 'direct') return { kind: 'page', url: videoUrl, note: '官网页面模式' }
    if (line.kind === 'mgtv') return await extractMango(videoUrl, cookieHeader)
    if (line.kind === 'native') return await sniffNative({ url: videoUrl, platform: line.platform })
    const target = buildLineUrl(line.url, videoUrl)
    if (line.kind === 'page') return { kind: 'page', url: target }
    if (line.kind === 'api') {
      const response = await fetchText(target, 15000)
      if (!response.ok && response.status >= 400) throw new Error(`解析接口返回 HTTP ${response.status}`)
      const streamUrl = extractStream(response.text)
      if (!streamUrl) return { kind: 'none', error: '接口没有返回 m3u8 / mp4 地址' }
      return { kind: 'stream', streamUrl, referer: line.referer || '' }
    }
    throw new Error(`未知的线路类型：${line.kind}`)
  }

  async function testLine(line, sampleUrl = SAMPLE_URL) {
    if (!line) return { ok: false, ms: 0, note: '线路不存在' }
    if (line.kind === 'direct') return { ok: true, ms: 0, note: '本地模式，无需网络' }
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
      if (line.kind === 'api') {
        const result = await parseWithLine({ videoUrl: sampleUrl, line })
        const ms = Date.now() - started
        if (result.kind === 'stream') return { ok: true, ms, note: '已解析出播放地址' }
        return { ok: false, ms, note: result.error || '没有解析结果' }
      }
      if (line.kind === 'native') {
        const result = await parseWithLine({ videoUrl: sampleUrl, line })
        const ms = Date.now() - started
        if (result.kind === 'stream') return { ok: true, ms, note: `原生流可用（${result.note || '已嗅探'}）` }
        return { ok: false, ms, note: result.error || '原生取流失败' }
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

  window.CSPLines = {
    UA,
    SAMPLE_URL,
    SAMPLE_URLS,
    DEFAULT_LINES,
    isHttpUrl,
    normalizeUrlText,
    buildLineUrl,
    extractStream,
    parseWithLine,
    testLine,
    fetchOnlineLines,
    fetchText,
    sniffNative,
    extractMango,
  }
})()
