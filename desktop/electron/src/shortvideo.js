'use strict'

/**
 * 短视频解析（抖音 / 哔哩哔哩 / AcFun / 红果短剧 / 快手）。
 *
 * 与长视频完全分开：长视频靠第三方解析线路，短视频这里直接用平台公开页面
 * 或公开接口拿「标题 + 封面 + 多清晰度直链」，再交给下载器保存成 mp4。
 *
 * 解析顺序统一为：
 *   1. 接口 / 页面内嵌 JSON（快，不打开窗口）
 *   2. 隐藏窗口嗅探（平台有反爬时兜底，能拿到播放器真实请求的 mp4 / m3u8）
 */

const crypto = require('node:crypto')
const { BrowserWindow, session } = require('electron')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const SHORT_PLATFORMS = [
  {
    key: 'douyin',
    name: '抖音',
    home: 'https://www.douyin.com/',
    hosts: ['douyin.com', 'iesdouyin.com'],
    color: '#ff2d55',
    partition: 'persist:short-douyin',
    hint: 'v.douyin.com/xxx 或 douyin.com/video/xxx',
  },
  {
    key: 'bilibili',
    name: '哔哩哔哩',
    home: 'https://www.bilibili.com/',
    hosts: ['bilibili.com', 'b23.tv', 'bili2233.cn'],
    color: '#fb7299',
    partition: 'persist:short-bilibili',
    hint: 'b23.tv/xxx 或 BV 号',
  },
  {
    key: 'acfun',
    name: 'AcFun',
    home: 'https://www.acfun.cn/',
    hosts: ['acfun.cn', 'aixifan.com'],
    color: '#fd4c5d',
    partition: 'persist:short-acfun',
    hint: 'acfun.cn/v/acxxxxx',
  },
  {
    key: 'hongguo',
    name: '红果短剧',
    home: 'https://hongguoduanju.com/',
    hosts: ['hongguoduanju.com', 'novelquickapp.com'],
    color: '#ff6a3d',
    partition: 'persist:short-hongguo',
    hint: 'hongguoduanju.com/detail?series_id=xxx',
  },
  {
    key: 'kuaishou',
    name: '快手',
    home: 'https://www.kuaishou.com/',
    hosts: ['kuaishou.com', 'kuaishouapp.com', 'gifshow.com'],
    color: '#ff7700',
    partition: 'persist:short-kuaishou',
    hint: 'v.kuaishou.com/xxx',
  },
]

const clean = (value, max = 200) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max)

function detectShortPlatform(rawUrl) {
  let host = ''
  try {
    host = new URL(String(rawUrl)).hostname.toLowerCase()
  } catch {
    return null
  }
  return (
    SHORT_PLATFORMS.find((platform) =>
      platform.hosts.some((item) => host === item || host.endsWith(`.${item}`)),
    ) || null
  )
}

function shortPlatformByKey(key) {
  return SHORT_PLATFORMS.find((platform) => platform.key === key) || null
}

function isShortPlatformUrl(rawUrl) {
  return Boolean(detectShortPlatform(rawUrl))
}

// 分享短链（v.douyin.com / b23.tv / v.kuaishou.com）必须先跟随跳转拿到真实地址
async function resolveFinalUrl(rawUrl, headers = {}) {
  try {
    const response = await fetch(rawUrl, {
      redirect: 'follow',
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9', ...headers },
      signal: AbortSignal.timeout(15000),
    })
    try {
      await response.body?.cancel()
    } catch {
      /* 忽略 */
    }
    return response.url || rawUrl
  } catch {
    return rawUrl
  }
}

async function fetchText(target, { headers = {}, timeout = 20000, ua = UA } = {}) {
  const response = await fetch(target, {
    redirect: 'follow',
    headers: { 'user-agent': ua, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6', ...headers },
    signal: AbortSignal.timeout(timeout),
  })
  return { ok: response.ok, status: response.status, url: response.url, text: await response.text() }
}

async function fetchJson(target, { headers = {}, timeout = 20000, ua = UA } = {}) {
  const result = await fetchText(target, { headers, timeout, ua })
  let json = null
  try {
    json = JSON.parse(result.text)
  } catch {
    /* 非 JSON */
  }
  return { ...result, json }
}

// 从 `marker = {` 开始做括号配对，避免 JSON 里带 `</script>` 或转义引号时正则截断
function sliceJsonObject(text, startIndex) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(startIndex, index + 1)
    }
  }
  return ''
}

function extractAssignedJson(text, marker) {
  const index = text.indexOf(marker)
  if (index < 0) return null
  const brace = text.indexOf('{', index)
  if (brace < 0) return null
  const raw = sliceJsonObject(text, brace)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function collectMediaUrls(text) {
  const found = new Set()
  const regex = /https?:[^\s"'\\<>]+?\.(?:mp4|m3u8|flv)(?:\?[^\s"'\\<>]*)?/gi
  let match
  while ((match = regex.exec(String(text || ''))) !== null) {
    found.add(match[0].replace(/\\u002F/g, '/').replace(/\\\//g, '/'))
  }
  return [...found]
}

function humanQuality(label, fallback = '') {
  const text = clean(label, 30)
  if (!text) return fallback
  return text
    .replace(/^(\d{3,4})p(_\d+)?$/i, '$1P')
    .replace(/^(\d{3,4})P$/i, '$1P')
    .replace(/_/g, ' ')
}

function qualityRank(item) {
  const text = `${item.quality || ''} ${item.label || ''}`
  const match = text.match(/(\d{3,4})/)
  return match ? Number(match[1]) : Number(item.bandwidth) || 0
}

function dedupeQualities(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (!item || !/^https?:\/\//i.test(item.url || '')) continue
    const key = item.url.split('#')[0]
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      label: clean(item.label, 30) || '默认清晰度',
      quality: String(item.quality || ''),
      url: item.url,
      format: item.format || (/\.m3u8(\?|#|$)/i.test(item.url) ? 'hls' : 'mp4'),
      size: Number(item.size) || 0,
      bandwidth: Number(item.bandwidth) || 0,
      headers: item.headers || null,
      note: clean(item.note, 60),
    })
  }
  out.sort((left, right) => qualityRank(right) - qualityRank(left))
  return out
}

// ---------------------------------------------------------------------------
// 抖音
// ---------------------------------------------------------------------------

function douyinIdFromUrl(url) {
  const patterns = [/\/video\/(\d{10,25})/, /\/note\/(\d{10,25})/, /[?&]modal_id=(\d{10,25})/, /\/share\/video\/(\d{10,25})/]
  for (const pattern of patterns) {
    const match = String(url || '').match(pattern)
    if (match) return match[1]
  }
  return ''
}

function findDeep(node, predicate, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null
  if (predicate(node)) return node
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findDeep(item, predicate, depth + 1)
      if (found) return found
    }
    return null
  }
  for (const value of Object.values(node)) {
    const found = findDeep(value, predicate, depth + 1)
    if (found) return found
  }
  return null
}

function collectDeep(node, predicate, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 9) return out
  if (Array.isArray(node)) {
    for (const item of node) collectDeep(item, predicate, out, depth + 1)
    return out
  }
  if (predicate(node)) out.push(node)
  for (const value of Object.values(node)) collectDeep(value, predicate, out, depth + 1)
  return out
}

function douyinQualities(video) {
  const list = []
  const rates = Array.isArray(video?.bit_rate) ? video.bit_rate : []
  for (const rate of rates) {
    const addresses = rate?.play_addr?.url_list || []
    const url = addresses.map((item) => String(item).replace('/playwm/', '/play/')).find((item) => /^https?:\/\//.test(item))
    if (!url) continue
    list.push({
      label: humanQuality(rate.gear_name, `${Math.round((Number(rate.bit_rate) || 0) / 1000)}kbps`),
      quality: String(rate.gear_name || rate.quality_type || ''),
      url,
      format: 'mp4',
      bandwidth: Number(rate.bit_rate) || 0,
    })
  }
  const direct = (video?.play_addr?.url_list || [])
    .map((item) => String(item).replace('/playwm/', '/play/'))
    .find((item) => /^https?:\/\//.test(item))
  if (direct) list.push({ label: '默认', quality: '', url: direct, format: 'mp4' })
  return dedupeQualities(list)
}

function douyinCover(item) {
  const cover = item?.video?.cover || item?.video?.origin_cover || item?.video?.dynamic_cover || {}
  return (cover.url_list || [])[0] || item?.cover || ''
}

async function resolveDouyin(rawUrl, { cookie = '' } = {}) {
  const finalUrl = await resolveFinalUrl(rawUrl, cookie ? { cookie } : {})
  const awemeId = douyinIdFromUrl(finalUrl) || douyinIdFromUrl(rawUrl)
  if (!awemeId) return { ok: false, error: '没有从链接里识别出抖音作品 ID，请复制单个视频的分享链接' }

  const headers = { referer: 'https://www.douyin.com/', ...(cookie ? { cookie } : {}) }
  const pages = [
    `https://www.iesdouyin.com/share/video/${awemeId}`,
    `https://www.douyin.com/video/${awemeId}`,
  ]
  let data = null
  for (const page of pages) {
    try {
      const result = await fetchText(page, { headers, ua: MOBILE_UA, timeout: 20000 })
      if (!result.ok) continue
      data =
        extractAssignedJson(result.text, '_ROUTER_DATA') ||
        extractAssignedJson(result.text, '__INITIAL_STATE__') ||
        extractAssignedJson(result.text, 'RENDER_DATA')
      if (data) break
    } catch {
      /* 尝试下一个页面 */
    }
  }

  let item = data
    ? findDeep(data, (node) => node && (node.aweme_id || (node.video && node.desc != null) || node.awemeId))
    : null
  if (!item) {
    // 公开 iteminfo 接口仍可用时作为补充
    try {
      const api = await fetchJson(
        `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${awemeId}`,
        { headers, ua: MOBILE_UA },
      )
      item = api.json?.item_list?.[0] || null
    } catch {
      /* 忽略 */
    }
  }
  if (!item) return { ok: false, error: '抖音页面没有返回作品信息（可能需要登录或触发了风控），可稍后重试' }

  const video = item.video || {}
  const qualities = douyinQualities(video)
  if (!qualities.length) return { ok: false, error: '没有拿到抖音的 mp4 直链，可在内置窗口里打开该视频后再试' }

  const title = clean(item.desc || item.title || `抖音作品 ${awemeId}`, 120)
  const author = clean(item.author?.nickname || item.nickname || '', 40)
  const duration = Math.round((Number(video.duration) || 0) / 1000)

  return {
    ok: true,
    platform: 'douyin',
    kind: 'video',
    title,
    author,
    cover: douyinCover(item),
    duration,
    pageUrl: `https://www.douyin.com/video/${awemeId}`,
    referer: 'https://www.douyin.com/',
    cookie,
    itemId: awemeId,
    qualities,
    episodes: [
      {
        index: 1,
        label: title,
        title,
        url: `https://www.douyin.com/video/${awemeId}`,
        qualities,
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// 哔哩哔哩
// ---------------------------------------------------------------------------

const BILI_MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14,
  39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56,
  59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

async function biliMixinKey() {
  const result = await fetchJson('https://api.bilibili.com/x/web-interface/nav')
  const imgUrl = result.json?.data?.wbi_img?.img_url || ''
  const subUrl = result.json?.data?.wbi_img?.sub_url || ''
  const pick = (value) => String(value).split('/').pop().split('.')[0]
  const raw = pick(imgUrl) + pick(subUrl)
  return BILI_MIXIN_TAB.map((index) => raw[index] || '').join('').slice(0, 32)
}

async function biliSignedQuery(params) {
  const mixinKey = await biliMixinKey()
  const wts = Math.floor(Date.now() / 1000)
  const merged = { ...params, wts }
  const query = Object.keys(merged)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(merged[key]).replace(/[!'()*]/g, ''))}`)
    .join('&')
  const wRid = crypto.createHash('md5').update(query + mixinKey).digest('hex')
  return `${query}&w_rid=${wRid}`
}

function biliIdFromUrl(url) {
  const text = String(url || '')
  const bv = text.match(/BV[0-9A-Za-z]{10}/)
  if (bv) return { bvid: bv[0] }
  const av = text.match(/\/video\/av(\d+)/i) || text.match(/[?&]aid=(\d+)/)
  if (av) return { aid: av[1] }
  const ep = text.match(/\/bangumi\/play\/ep(\d+)/i)
  if (ep) return { epId: ep[1] }
  const ss = text.match(/\/bangumi\/play\/ss(\d+)/i)
  if (ss) return { seasonId: ss[1] }
  return {}
}

function biliHeaders(cookie = '') {
  return {
    referer: 'https://www.bilibili.com/',
    origin: 'https://www.bilibili.com',
    ...(cookie ? { cookie } : {}),
  }
}

// B 站清晰度编号 → 中文标签（未登录时高编号会被服务端降级到 64/32）
const BILI_QN_LABELS = {
  127: '8K 超高清',
  126: '杜比视界',
  125: 'HDR 真彩',
  120: '4K 超清',
  116: '1080P60',
  112: '1080P+',
  80: '超清 1080P',
  74: '高清 720P60',
  64: '高清 720P',
  32: '清晰 480P',
  16: '流畅 360P',
}

// 接口没给 support_formats 时的兜底尝试顺序（1080P / 720P60 / 720P / 480P / 360P）
const BILI_DEFAULT_QN = [80, 74, 64, 32, 16]

// 请求播放地址：html5 平台参数返回的是可直接用 <video> 播放的 mp4 直链，最高能到 1080P；
// 不带 html5 时 PC 端点默认只发低清 mp4（实测 360P），所以放在第二顺位兜底。
function biliMp4Durl(json) {
  const durl = json?.data?.durl?.[0]
  if (!durl?.url) return false
  return /\.mp4|mime_type=video_mp4/i.test(durl.url) || /\.mp4/i.test(durl.backup_url?.[0] || '')
}

async function biliPlayInfo({ bvid, aid, cid, qn = 80, cookie = '', variant = 'auto' }) {
  const base = { ...(bvid ? { bvid } : { avid: aid }), cid, qn, fnval: 1, fourk: 1 }
  const variants =
    variant === 'pc'
      ? [base]
      : variant === 'dash'
        ? [{ ...base, qn: 0, fnval: 16, fourk: 1 }]
        : [{ ...base, platform: 'html5', high_quality: 1 }, base]
  const headers = biliHeaders(cookie)
  let last = null
  for (const params of variants) {
    const query = new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)]),
    ).toString()
    let result = await fetchJson(`https://api.bilibili.com/x/player/playurl?${query}`, { headers })
    if (!result.json || result.json.code !== 0) {
      // 走 wbi 签名（部分账号 / 地区对未签名请求返回 412）
      try {
        const signed = await biliSignedQuery({ ...params })
        result = await fetchJson(`https://api.bilibili.com/x/player/wbi/playurl?${signed}`, { headers })
      } catch {
        /* 保留原始失败原因 */
      }
    }
    const json = result.json
    if (json?.code === 0) {
      // 只有拿到 mp4 直链（或 DASH）才算成功；FLV 继续换一套参数再试
      if (biliMp4Durl(json) || json?.data?.dash) return json
      last = json
      continue
    }
    last = json
  }
  return last
}

// 用 Cookie 查一次账号，避免把「Cookie 存在但已过期」当成已登录
async function biliAccount(cookie = '') {
  if (!cookie) return { login: false, vip: false, uname: '' }
  try {
    const nav = await fetchJson('https://api.bilibili.com/x/web-interface/nav', { headers: biliHeaders(cookie) })
    const data = nav.json?.data
    if (!data) return { login: true, vip: false, uname: '' }
    return {
      login: data.isLogin === true,
      vip: Number(data.vipStatus) === 1,
      uname: clean(data.uname || '', 40),
    }
  } catch {
    return { login: true, vip: false, uname: '' }
  }
}

// B 站 1080P 及以上基本只走 DASH（音视频分离），下载时用纯 JS 把两路合并成 MP4（不需要 ffmpeg）。

async function resolveBilibili(rawUrl, { cookie = '' } = {}) {
  const finalUrl = await resolveFinalUrl(rawUrl, cookie ? { cookie } : {})
  const ids = biliIdFromUrl(finalUrl) || biliIdFromUrl(rawUrl)
  const headers = biliHeaders(cookie)

  if (ids.epId || ids.seasonId) {
    const query = ids.epId ? `ep_id=${ids.epId}` : `season_id=${ids.seasonId}`
    const season = await fetchJson(`https://api.bilibili.com/pgc/view/web/season?${query}`, { headers })
    const detail = season.json?.result
    if (!detail) return { ok: false, error: '没有取到番剧信息，可能需要在内置窗口登录 B 站' }
    const episodes = (detail.episodes || []).map((episode, index) => ({
      index: index + 1,
      label: `第${index + 1}话`,
      title: clean(episode.long_title || episode.title || detail.season_title, 80),
      url: `https://www.bilibili.com/bangumi/play/ep${episode.id}`,
      bvid: episode.bvid || '',
      cid: Number(episode.cid) || 0,
    }))
    return {
      ok: true,
      platform: 'bilibili',
      kind: 'series',
      title: clean(detail.season_title || detail.title, 120),
      author: clean(detail.up_info?.uname || '', 40),
      cover: detail.cover || '',
      duration: 0,
      pageUrl: finalUrl,
      referer: 'https://www.bilibili.com/',
      cookie,
      qualities: [],
      episodes,
      seriesTitle: clean(detail.season_title || detail.title, 80),
      note: '番剧清晰度需要登录账号（大会员解锁高码率）',
    }
  }

  const query = ids.bvid ? `bvid=${ids.bvid}` : `aid=${ids.aid}`
  const view = await fetchJson(`https://api.bilibili.com/x/web-interface/view?${query}`, { headers })
  const data = view.json?.data
  if (!data) {
    return {
      ok: false,
      error: view.status === 412 ? 'B 站在当前网络触发了风控，请先在内置窗口打开一次 B 站后再解析' : '没有取到 B 站视频信息',
    }
  }
  const bvid = data.bvid || ids.bvid
  const pages = Array.isArray(data.pages) && data.pages.length ? data.pages : [{ cid: data.cid, page: 1, part: data.title }]
  const pageParam = Number(new URL(finalUrl).searchParams.get('p')) || 1
  const current = pages[Math.min(pageParam - 1, pages.length - 1)] || pages[0]
  const cid = Number(current.cid) || Number(data.cid)

  // html5 端点返回的 support_formats 就是当前账号能拿到的 mp4 档位（常见 1080P + 360P）。
  // 先请求最高档拿列表和最高清直链，再按列表逐档补齐。
  const first = await biliPlayInfo({ bvid, aid: data.aid, cid, qn: 127, cookie })
  const formats = Array.isArray(first?.data?.support_formats) ? first.data.support_formats : []
  const labelByQuality = new Map(
    formats.map((format) => [
      Number(format.quality),
      clean(format.new_description || format.description || '', 30),
    ]),
  )
  const ordered = [
    ...new Set([
      ...formats.map((format) => Number(format.quality)),
      ...(Array.isArray(first?.data?.accept_quality) ? first.data.accept_quality.map(Number) : []),
      ...(Array.isArray(data.accept_quality) ? data.accept_quality.map(Number) : []),
    ]),
  ]
    .filter(Boolean)
    .sort((left, right) => right - left)
  const qnList = ordered.length ? ordered.slice(0, 8) : [...BILI_DEFAULT_QN]

  const qualities = []
  const seenQuality = new Set()
  const collectQuality = (play) => {
    const durl = play?.data?.durl?.[0]
    if (!durl?.url) return
    const quality = Number(play.data.quality) || 0
    if (!quality || seenQuality.has(quality)) return
    if (!/\.mp4|mime_type=video_mp4/i.test(durl.url) && !/\.mp4/i.test(durl.backup_url?.[0] || '')) {
      // 非 mp4 容器（多为 FLV），不放进「下载 MP4」列表
      return
    }
    seenQuality.add(quality)
    qualities.push({
      label: labelByQuality.get(quality) || BILI_QN_LABELS[quality] || `${quality}P`,
      quality: String(quality),
      url: durl.url,
      format: 'mp4',
      size: Number(durl.size) || 0,
    })
  }
  collectQuality(first)
  for (const qn of qnList) {
    if (seenQuality.has(qn)) continue
    try {
      const play = await biliPlayInfo({ bvid, aid: data.aid, cid, qn, cookie })
      collectQuality(play)
    } catch {
      /* 单档失败不影响其它清晰度 */
    }
  }
  // html5 端点通常只发 1080P / 360P 两档；登录后再走 PC 端点补一次 720P 等中间档
  if (cookie) {
    for (const qn of [80, 74, 64]) {
      if (seenQuality.has(qn)) continue
      try {
        const play = await biliPlayInfo({ bvid, aid: data.aid, cid, qn, cookie, variant: 'pc' })
        collectQuality(play)
      } catch {
        /* 补档失败无所谓 */
      }
    }
  }
  qualities.sort((left, right) => Number(right.quality) - Number(left.quality))

  // B 站 1080P 及以上基本只走 DASH（音视频分离）：把两路下载到本地后用纯 JS 合并成 MP4，
  // 登录账号就能下到 1080P。合并逻辑在 dashmerge.js，不依赖 ffmpeg。
  // 超长视频（默认 45 分钟以上）合并时内存占用太大，这里不列 DASH 档，避免把别人机器搞崩。
  const durationSec = Number(data.duration) || 0
  const dashTooLong = durationSec > 2700
  const mp4Best = Number(qualities[0]?.quality) || 0
  let videoMax = formats.reduce((max, format) => Math.max(max, Number(format.quality) || 0), 0)
  const dashQualities = []
  try {
    const dashJson = await biliPlayInfo({ bvid, aid: data.aid, cid, qn: 0, cookie, variant: 'dash' })
    const dash = dashJson?.data?.dash
    const dashFormats = Array.isArray(dashJson?.data?.support_formats) ? dashJson.data.support_formats : []
    videoMax = dashFormats.reduce((max, format) => Math.max(max, Number(format.quality) || 0), videoMax)
    if (dash && !dashTooLong) {
      const videos = Array.isArray(dash.video) ? dash.video : []
      const audios = Array.isArray(dash.audio) ? dash.audio : []
      // 合并器只吃 AAC / Opus；优先挑 AAC 音轨，避免拿到杜比（ec-3）音轨合不了
      const aacAudios = audios.filter((item) => /mp4a|aac/i.test(`${item.codecs || ''} ${item.codec || ''} ${item.mimeType || ''}`))
      const audio = [...(aacAudios.length ? aacAudios : audios)].sort(
        (left, right) => (Number(right.bandwidth) || 0) - (Number(left.bandwidth) || 0),
      )[0]
      const audioUrl = audio?.baseUrl || audio?.base_url || ''
      const seen = new Set()
      // 同一清晰度可能同时有 AVC / HEVC 两路，优先 AVC（兼容性最好）
      const byId = new Map()
      for (const video of videos) {
        const qn = Number(video.id) || 0
        if (!qn) continue
        const existing = byId.get(qn)
        if (!existing || (Number(video.codecid) === 7 && Number(existing.codecid) !== 7)) {
          byId.set(qn, video)
        }
      }
      const sortedVideos = [...byId.values()].sort(
        (left, right) => (Number(right.id) || 0) - (Number(left.id) || 0),
      )
      for (const video of sortedVideos) {
        const qn = Number(video.id) || 0
        const videoUrl = video.baseUrl || video.base_url || ''
        if (!qn || !videoUrl || !audioUrl || seen.has(qn) || qn <= mp4Best) continue
        seen.add(qn)
        dashQualities.push({
          label: `${labelByQuality.get(qn) || BILI_QN_LABELS[qn] || `${qn}P`}（音视频合并）`,
          quality: String(qn),
          format: 'dash',
          videoUrl,
          audioUrl,
          size: 0,
        })
      }
      qualities.push(...dashQualities)
      qualities.sort((left, right) => Number(right.quality) - Number(left.quality))
    }
  } catch {
    /* DASH 拿不到就只给 MP4 档位 */
  }

  const bestQuality = Number(qualities[0]?.quality) || 0
  const bestLabel = qualities[0]?.label || `${bestQuality}P`
  let login = Boolean(cookie)
  let qualityNote = ''
  if (dashQualities.length) {
    qualityNote = `${bestLabel} 是 B 站的音视频分离流，下载时会自动合并成一个 MP4（不需要 ffmpeg，在线预览仍用 MP4 档位）。`
  } else if (dashTooLong && videoMax > bestQuality) {
    qualityNote = `视频约 ${Math.round(durationSec / 60)} 分钟，1080P 音视频合并内存占用较大，暂不提供；可以下载 ${bestLabel} 或更短的视频。`
  } else if (bestQuality > 0 && videoMax > bestQuality) {
    const account = await biliAccount(cookie)
    login = account.login
    qualityNote = account.login
      ? `当前账号在 B 站拿不到更高档位，单文件 MP4 最高 ${bestLabel}（1080P 高码率 / 4K 需要大会员）。`
      : cookie
        ? 'B 站没识别到当前登录状态（Cookie 可能已过期），重新登录后再解析可能解锁更高清晰度。'
        : '更高清晰度需要登录 B 站账号：点平台卡片登录后再解析。'
  } else if (videoMax > 0 && bestQuality > 0 && bestQuality <= 64) {
    qualityNote = `该视频在 B 站最高只提供 ${bestLabel}（视频本身的上限，和是否登录无关）。`
  }

  const episodes = pages.map((page, index) => ({
    index: page.page || index + 1,
    label: pages.length > 1 ? `P${page.page || index + 1}` : '正片',
    title: clean(page.part || data.title, 80),
    url: `https://www.bilibili.com/video/${bvid}?p=${page.page || index + 1}`,
    bvid,
    cid: Number(page.cid) || 0,
    qualities: index === pageParam - 1 ? qualities : undefined,
  }))

  if (!qualities.length) {
    return {
      ok: false,
      error: 'B 站没有返回可直接下载的 mp4（高清多为音视频分离的 DASH 流），可在内置窗口登录后重试',
    }
  }

  return {
    ok: true,
    platform: 'bilibili',
    kind: episodes.length > 1 ? 'series' : 'video',
    title: clean(data.title, 120),
    author: clean(data.owner?.name || '', 40),
    cover: data.pic || '',
    duration: Number(data.duration) || 0,
    pageUrl: finalUrl,
    referer: 'https://www.bilibili.com/',
    cookie,
    itemId: bvid,
    qualities,
    episodes,
    seriesTitle: clean(data.title, 80),
    login,
    note: qualityNote,
  }
}

// ---------------------------------------------------------------------------
// AcFun
// ---------------------------------------------------------------------------

async function resolveAcfun(rawUrl, { cookie = '' } = {}) {
  const finalUrl = await resolveFinalUrl(rawUrl, cookie ? { cookie } : {})
  const acId = (String(finalUrl).match(/\/v\/(ac\d+)/i) || String(rawUrl).match(/\/v\/(ac\d+)/i) || [])[1]
  if (!acId) return { ok: false, error: '没有从链接里识别出 AcFun 稿件号（acxxxxx）' }

  const page = await fetchText(`https://www.acfun.cn/v/${acId}`, {
    headers: { referer: 'https://www.acfun.cn/', ...(cookie ? { cookie } : {}) },
  })
  if (!page.ok) return { ok: false, error: `AcFun 页面请求失败（HTTP ${page.status}）` }
  const videoInfo = extractAssignedJson(page.text, 'window.videoInfo')
  if (!videoInfo) {
    return { ok: false, error: 'AcFun 页面结构发生变化，没有找到视频信息；可尝试在内置窗口打开后再解析' }
  }

  const current = videoInfo.currentVideoInfo || {}
  let playJson = current.ksPlayJson
  if (typeof playJson === 'string') {
    try {
      playJson = JSON.parse(playJson)
    } catch {
      playJson = null
    }
  }
  const qualities = []
  const sets = playJson?.adaptationSet || playJson?.adaptationSets || []
  for (const set of sets) {
    for (const representation of set.representation || []) {
      const url = representation.url || representation.backupUrl?.[0] || ''
      if (!url) continue
      qualities.push({
        label: humanQuality(representation.qualityLabel || representation.qualityType, '默认清晰度'),
        quality: String(representation.qualityType || representation.qualityLabel || ''),
        url,
        format: /\.m3u8/i.test(url) ? 'hls' : 'mp4',
        bandwidth: Number(representation.bandwidth) || 0,
      })
    }
  }

  const allQualities = dedupeQualities(
    qualities.length
      ? qualities
      : collectMediaUrls(page.text).map((url) => ({
          label: '默认清晰度',
          url,
          format: /\.m3u8/i.test(url) ? 'hls' : 'mp4',
        })),
  )

  const list = Array.isArray(videoInfo.videoList) ? videoInfo.videoList : Array.isArray(videoInfo.currentVideoInfo?.videoList) ? videoInfo.currentVideoInfo.videoList : []
  const episodes = list.length
    ? list.map((item, index) => ({
        index: index + 1,
        label: `P${index + 1}`,
        title: clean(item.title || item.videoName || `第${index + 1}集`, 80),
        url: `https://www.acfun.cn/v/${item.videoId || item.acId || acId}`,
      }))
    : [
        {
          index: 1,
          label: '正片',
          title: clean(videoInfo.title, 80),
          url: `https://www.acfun.cn/v/${acId}`,
          qualities: allQualities,
        },
      ]

  if (!allQualities.length) return { ok: false, error: 'AcFun 没有返回可用的播放地址' }

  return {
    ok: true,
    platform: 'acfun',
    kind: episodes.length > 1 ? 'series' : 'video',
    title: clean(videoInfo.title, 120),
    author: clean(videoInfo.user?.name || videoInfo.upName || '', 40),
    cover: videoInfo.coverUrl || videoInfo.cover || '',
    duration: Math.round(Number(videoInfo.duration) || 0),
    pageUrl: `https://www.acfun.cn/v/${acId}`,
    referer: 'https://www.acfun.cn/',
    cookie,
    itemId: acId,
    qualities: allQualities,
    episodes,
    seriesTitle: clean(videoInfo.title, 80),
    note: allQualities.some((item) => item.format === 'hls') ? 'AcFun 使用 HLS 分片，下载后为 mp4/ts 容器' : '',
  }
}

// ---------------------------------------------------------------------------
// 红果短剧
// ---------------------------------------------------------------------------

function hongguoIds(rawUrl) {
  const text = String(rawUrl || '')
  const series = text.match(/[?&]series_id=(\d{10,25})/) || text.match(/\/detail\/(\d{10,25})/)
  const player = text.match(/\/player\/(\d{10,25})(?:\/(\d{10,25}))?/)
  return {
    seriesId: series ? series[1] : player ? player[1] : '',
    vid: player ? player[2] || '' : '',
  }
}

async function resolveHongguo(rawUrl, { cookie = '' } = {}) {
  const finalUrl = await resolveFinalUrl(rawUrl, cookie ? { cookie } : {})
  let { seriesId, vid } = hongguoIds(finalUrl)
  if (!seriesId) ({ seriesId, vid } = hongguoIds(rawUrl))
  if (!seriesId) return { ok: false, error: '没有识别出红果短剧 ID，请复制剧集详情页链接' }

  const page = await fetchText(`https://hongguoduanju.com/detail?series_id=${seriesId}`, {
    headers: { referer: 'https://hongguoduanju.com/', ...(cookie ? { cookie } : {}) },
    ua: MOBILE_UA,
  })
  if (!page.ok) return { ok: false, error: `红果短剧页面请求失败（HTTP ${page.status}）` }
  const data = extractAssignedJson(page.text, '_ROUTER_DATA')
  const detail = data?.loaderData?.detail_page?.seriesDetail
  if (!detail) return { ok: false, error: '红果短剧页面没有返回剧集信息' }

  const vids = Array.isArray(detail.vid_list) ? detail.vid_list : []
  if (!vids.length) return { ok: false, error: '这部剧没有可下载的分集' }

  const qualitiesFor = (videoId) => [
    {
      label: '360P',
      quality: '360',
      url: `https://hongguoduanju.com/video/public/${videoId}/360p.mp4`,
      format: 'mp4',
    },
  ]

  const total = Number(detail.episode_cnt) || vids.length
  // 红果网页版只给前 N 集公开 mp4：第 N+1 集起播放页直接 404（登录也不放开）。
  // 之前把 586 集全列出来，点「一键下载全集」会一串 404，所以只列真正能下载的集。
  const accessible = Math.max(
    1,
    Math.min(Number(detail.accessible_episode_cnt) || vids.length, vids.length),
  )
  const wantedIndex = vid ? vids.findIndex((item) => String(item) === String(vid)) : -1
  if (vid && wantedIndex >= accessible) {
    return {
      ok: false,
      error: `第 ${wantedIndex + 1} 集在红果网页版没有开放（网页端只提供前 ${accessible} 集），完整剧集需要用红果 App 观看`,
    }
  }

  let episodes = vids.slice(0, accessible).map((videoId, index) => ({
    index: index + 1,
    label: `第${index + 1}集`,
    title: `第${index + 1}集`,
    url: `https://hongguoduanju.com/player/${seriesId}/${videoId}`,
    vid: String(videoId),
    qualities: qualitiesFor(videoId),
  }))
  if (vid) episodes = episodes.filter((episode) => episode.vid === String(vid))

  const current = episodes[0]
  return {
    ok: true,
    platform: 'hongguo',
    kind: 'series',
    title: clean(detail.series_name, 120),
    author: '',
    cover: detail.series_cover || '',
    duration: 0,
    pageUrl: `https://hongguoduanju.com/detail?series_id=${seriesId}`,
    referer: 'https://hongguoduanju.com/',
    cookie,
    itemId: seriesId,
    qualities: current?.qualities || [],
    episodes,
    seriesTitle: clean(detail.series_name, 80),
    total,
    accessible,
    note:
      accessible < vids.length
        ? `共 ${total} 集，红果网页版当前只开放前 ${accessible} 集（第 ${accessible + 1} 集起平台播放页直接 404）；已只列出能下载的集数，完整剧集需要红果 App。`
        : `共 ${total} 集，全部可下载`,
  }
}

// ---------------------------------------------------------------------------
// 快手
// ---------------------------------------------------------------------------

async function resolveKuaishou(rawUrl, { cookie = '' } = {}) {
  const finalUrl = await resolveFinalUrl(rawUrl, cookie ? { cookie } : {})
  const text = String(finalUrl || rawUrl)
  const photoId =
    (text.match(/\/short-video\/([A-Za-z0-9_-]{6,40})/) ||
      text.match(/\/fw\/photo\/([A-Za-z0-9_-]{6,40})/) ||
      text.match(/[?&]photoId=([A-Za-z0-9_-]{6,40})/) ||
      [])[1] || ''
  if (!photoId) return { ok: false, error: '没有识别出快手作品 ID，请复制单个视频的分享链接' }

  const pageUrl = `https://www.kuaishou.com/short-video/${photoId}`
  let pageText = ''
  try {
    const result = await fetchText(pageUrl, {
      headers: { referer: 'https://www.kuaishou.com/', ...(cookie ? { cookie } : {}) },
    })
    pageText = result.text
  } catch {
    /* 交给嗅探 */
  }
  const apollo = pageText ? extractAssignedJson(pageText, '__APOLLO_STATE__') : null
  const photo =
    (apollo && findDeep(apollo, (node) => node && (node.photoUrl || node.manifest || node.caption))) || null
  const qualities = []
  if (photo) {
    if (photo.photoUrl) qualities.push({ label: '默认', url: photo.photoUrl, format: 'mp4' })
    let manifest = photo.manifest
    if (typeof manifest === 'string') {
      try {
        manifest = JSON.parse(manifest)
      } catch {
        manifest = null
      }
    }
    for (const set of manifest?.adaptationSet || []) {
      for (const representation of set.representation || []) {
        const url = representation.url || representation.backupUrl?.[0]
        if (!url) continue
        qualities.push({
          label: humanQuality(representation.qualityLabel || representation.qualityType, '默认清晰度'),
          quality: String(representation.qualityType || ''),
          url,
          format: /\.m3u8/i.test(url) ? 'hls' : 'mp4',
          bandwidth: Number(representation.bandwidth) || 0,
        })
      }
    }
  }
  const deduped = dedupeQualities(qualities)
  const title = clean(photo?.caption || photo?.title || `快手作品 ${photoId}`, 120)
  return {
    ok: deduped.length > 0,
    platform: 'kuaishou',
    kind: 'video',
    title,
    author: clean(photo?.userName || photo?.user?.name || '', 40),
    cover: photo?.coverUrl || '',
    duration: Math.round((Number(photo?.duration) || 0) / 1000),
    pageUrl,
    referer: 'https://www.kuaishou.com/',
    cookie,
    itemId: photoId,
    qualities: deduped,
    episodes: [{ index: 1, label: '正片', title, url: pageUrl, qualities: deduped }],
    error: deduped.length ? '' : '',
    needsSniff: deduped.length === 0,
  }
}

// ---------------------------------------------------------------------------
// 隐藏窗口嗅探（反爬平台兜底）
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function sniffShort(rawUrl, platformKey, { timeout = 20000 } = {}) {
  const platform = shortPlatformByKey(platformKey)
  const partition = platform?.partition || 'persist:short-douyin'
  const part = session.fromPartition(partition)
  part.setUserAgent(UA)
  const candidates = []
  let win = null
  const started = Date.now()

  const handler = (details, callback) => {
    try {
      const target = String(details.url || '')
      if (!/^https?:\/\//i.test(target)) return callback({})
      if (!/\.(m3u8|mp4|flv)(\?|#|$)/i.test(target) && !/\/m3u8\//i.test(target)) return callback({})
      if (/\.(ts|m4s|jpg|jpeg|png|webp|avif)(\?|#|$)/i.test(target)) return callback({})
      if (!candidates.some((item) => item.url === target)) candidates.push({ url: target, at: Date.now() })
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
    win.loadURL(rawUrl).catch(() => {})

    let firstSeenAt = 0
    while (Date.now() - started < timeout) {
      if (!firstSeenAt && candidates.length) firstSeenAt = Date.now()
      if (firstSeenAt && Date.now() - firstSeenAt > 2500) break
      await sleep(350)
    }

    let meta = { title: '', cover: '', duration: 0 }
    try {
      meta = await win.webContents.executeJavaScript(
        `(() => {
          const video = document.querySelector('video')
          const og = (name) => (document.querySelector('meta[property="' + name + '"]') || {}).content || ''
          return {
            title: document.title || og('og:title'),
            cover: og('og:image') || (video && video.poster) || '',
            duration: (video && Number(video.duration)) || 0
          }
        })()`,
        true,
      )
    } catch {
      /* 忽略 */
    }

    const qualities = dedupeQualities(
      candidates.map((candidate) => ({
        label: /\.m3u8/i.test(candidate.url) ? 'HLS' : '默认',
        url: candidate.url,
        format: /\.m3u8/i.test(candidate.url) ? 'hls' : 'mp4',
      })),
    )
    if (!qualities.length) {
      return { ok: false, error: '平台播放器没有发出可识别的视频流，可能需要在该平台登录后再试' }
    }
    return {
      ok: true,
      platform: platformKey,
      kind: 'video',
      title: clean(meta.title || `${platform?.name || '短视频'}作品`, 120),
      author: '',
      cover: meta.cover || '',
      duration: Math.round(Number(meta.duration) || 0),
      pageUrl: rawUrl,
      referer: platform?.home || rawUrl,
      cookie: '',
      qualities: qualities.slice(0, 6),
      episodes: [],
      note: '通过平台播放器嗅探到直链',
      sniffed: true,
    }
  } catch (error) {
    return { ok: false, error: `嗅探失败：${String(error?.message || error).slice(0, 120)}` }
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

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

async function resolveShort({ url, cookie = '', platform = '' }) {
  const detected = platform ? shortPlatformByKey(platform) : detectShortPlatform(url)
  if (!detected) return { ok: false, error: '不是受支持的短视频平台链接' }
  let result = null
  try {
    if (detected.key === 'douyin') result = await resolveDouyin(url, { cookie })
    else if (detected.key === 'bilibili') result = await resolveBilibili(url, { cookie })
    else if (detected.key === 'acfun') result = await resolveAcfun(url, { cookie })
    else if (detected.key === 'hongguo') result = await resolveHongguo(url, { cookie })
    else if (detected.key === 'kuaishou') result = await resolveKuaishou(url, { cookie })
  } catch (error) {
    result = { ok: false, error: String(error?.message || error).slice(0, 160) }
  }
  if (!result) result = { ok: false, error: '暂不支持该平台' }
  // 接口 / 页面内嵌数据失败时，用隐藏窗口嗅探兜底（红果网页结构稳定，失败通常是链接问题）
  if (!result.ok && detected.key !== 'hongguo') {
    const sniffed = await sniffShort(url, detected.key)
    if (sniffed.ok) result = sniffed
  }
  return { ...result, platformName: detected.name, platformKey: detected.key }
}

module.exports = {
  SHORT_PLATFORMS,
  detectShortPlatform,
  shortPlatformByKey,
  isShortPlatformUrl,
  resolveShort,
  sniffShort,
  extractAssignedJson,
}
