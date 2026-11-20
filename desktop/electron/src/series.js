'use strict'

/**
 * 选集（分集列表）解析。
 *
 * 各平台都没有统一的「选集」入口，这里按平台各取一份官方/页面公开数据：
 *  - 爱奇艺：页面里的 tvid → playervideoinfo（拿 albumId）→ avlistinfo（拿各集 playUrl）
 *  - 腾讯视频：cover id → PageServer/GetPageData（vsite_episode_list，明文 JSON）
 *  - 优酷：播放页 HTML 里内嵌的 __INITIAL_DATA__ 选集组件
 *  - 芒果TV：episode/list 接口
 *
 * 拿到的每一集统一成 { label, title, url, index, vip }，交给渲染层在播放器下面画选集条。
 */

const { BrowserWindow, session } = require('electron')
const { UA } = require('./lines')
const { detectPlatformByUrl } = require('./platforms')

const PAGE_TIMEOUT = 15000
const CACHE_TTL = 10 * 60 * 1000
const cache = new Map()
const pending = new Map()

const clean = (value, max = 200) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max)

function absUrl(raw, base) {
  try {
    return new URL(String(raw || ''), base).href
  } catch {
    return ''
  }
}

async function getCookieHeader(platform) {
  try {
    const host = platform?.hosts?.[0] || ''
    if (!host) return ''
    const cookies = await session.fromPartition(platform.partition).cookies.get({ domain: host })
    return cookies.map((item) => `${item.name}=${item.value}`).join('; ')
  } catch {
    return ''
  }
}

async function fetchJson(target, { headers = {}, method = 'GET', body = null, timeout = 15000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(target, {
      method,
      body,
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6', ...headers },
    })
    const text = await response.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON */
    }
    return { ok: response.ok, status: response.status, text, json }
  } finally {
    clearTimeout(timer)
  }
}

async function fetchText(target, { headers = {}, timeout = 15000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(target, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6', ...headers },
    })
    return { ok: response.ok, status: response.status, text: await response.text(), url: response.url || target }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function episodeLabel(rawTitle, fallbackIndex, rawLabel) {
  const source = clean(rawLabel || rawTitle, 60)
  const match = source.match(/第\s*(\d{1,4})\s*([集期话回])/)
  if (match) return `第${Number(match[1])}${match[2]}`
  if (/^\d{1,4}$/.test(source)) return `第${Number(source)}集`
  const numbered = source.match(/(?:^|[^\d])(\d{1,4})\s*(集|期|话)(?:$|[^\d])/)
  if (numbered) return `第${Number(numbered[1])}${numbered[2]}`
  if (/^(先导片|预告|花絮|特辑|番外|彩蛋)/.test(source)) return source.slice(0, 12)
  if (/^\d{1,4}$/.test(clean(rawTitle, 20))) return `第${Number(clean(rawTitle, 20))}集`
  return source ? source.slice(0, 12) : fallbackIndex ? `第${fallbackIndex}集` : '正片'
}

function episodeIndex(rawTitle, rawIndex, fallback) {
  const fromIndex = Number(rawIndex)
  if (Number.isFinite(fromIndex) && fromIndex > 0) return fromIndex
  const match = String(rawTitle || '').match(/第\s*(\d{1,4})\s*[集期话回]/) || String(rawTitle || '').match(/(?:^|[^\d])(\d{1,4})\s*(?:集|期|话)/)
  if (match) return Number(match[1])
  const pure = String(rawTitle || '').trim().match(/^(\d{1,4})$/)
  if (pure) return Number(pure[1])
  return fallback || 0
}

function dedupeEpisodes(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (!item || !/^https?:\/\//i.test(item.url)) continue
    const key = item.url.split('#')[0]
    if (seen.has(key)) continue
    // 同一集可能同时出现正片和看点（芒果），优先保留带集数的正片
    seen.add(key)
    out.push(item)
  }
  out.sort((a, b) => {
    const ai = a.index || 0
    const bi = b.index || 0
    if (ai && bi && ai !== bi) return ai - bi
    if (ai && !bi) return -1
    if (!ai && bi) return 1
    return 0
  })
  return out
}

function seriesTitleOf(pageTitle, episodes) {
  const platformOnly = /^(腾讯视频|爱奇艺|优酷|芒果TV|芒果tv|在线观看)$/i
  let title = clean(pageTitle, 100)
  if (!title || platformOnly.test(title)) title = ''
  if (!title) {
    const named = episodes.map((item) => String(item.title || '')).find((text) => /^.+?第\s*\d+\s*[集期话回]/.test(text))
    if (named) {
      title = named.replace(/第\s*\d+\s*[集期话回].*$/, '')
    } else {
      const first = episodes.find((item) => item.title)?.title || ''
      title = first
    }
  }
  title = title
    .replace(/^【[^】]*】\s*/, '')
    .replace(/[_-]\s*(电视剧|电影|综艺|动漫|纪录片|少儿|体育|高清完整版|在线观看).*$/i, '')
    .replace(/\s*[-_|]\s*(爱奇艺|腾讯视频|优酷|芒果TV|芒果tv).*$/i, '')
    .replace(/[_|]\d{1,4}(?:_|$).*$/, '')
    .replace(/[_-]\s*(全集|全\d+集|完整版).*$/i, '')
    .replace(/\s*(第\s*\d+\s*[集期话回]|EP?\s*\d+|S\d+E\d+).*$/i, '')
    .replace(/\s*(先导片|预告|花絮|特辑|番外|彩蛋).*$/i, '')
    .trim()
  return title.slice(0, 60)
}

// ---------------------------------------------------------------------------
// 爱奇艺
// ---------------------------------------------------------------------------

function iqiyiShortId(url) {
  const match = String(url).match(/\/v_([A-Za-z0-9]+)\.html/)
  return match ? match[1] : ''
}

async function readIqiyiTvidByPage(url) {
  return new Promise((resolve) => {
    let win = null
    let settled = false
    let timer = null
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        win?.destroy()
      } catch {
        /* 忽略 */
      }
      resolve(value)
    }
    timer = setTimeout(() => finish(''), PAGE_TIMEOUT)
    try {
      win = new BrowserWindow({
        show: false,
        skipTaskbar: true,
        width: 1120,
        height: 760,
        webPreferences: {
          partition: 'persist:platform-iqiyi',
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      })
      win.webContents.on('did-finish-load', () => {
        setTimeout(async () => {
          try {
            const value = await win?.webContents.executeJavaScript(
              `(() => {
                const status = window.playbackPageStageStatus || {}
                if (status._tvid) return String(status._tvid)
                if (status.playInfo && status.playInfo.tvid) return String(status.playInfo.tvid)
                const m = document.documentElement.innerHTML.match(/"tvid"\\s*:\\s*"?(\\d{6,})/)
                return m ? m[1] : ''
              })()`,
            )
            finish(value ? String(value) : '')
          } catch {
            finish('')
          }
        }, 2600)
      })
      win.webContents.on('did-fail-load', () => finish(''))
      win.loadURL(url).catch(() => finish(''))
    } catch {
      finish('')
    }
  })
}

async function fetchIqiyiEpisodes(url, { tvid = '', pageTitle = '', cookie = '' } = {}) {
  const shortId = iqiyiShortId(url)
  if (!shortId) return { ok: false, error: '不是爱奇艺剧集链接' }
  const resolvedTvid = String(tvid || '') || (await readIqiyiTvidByPage(url))
  if (!resolvedTvid) return { ok: false, error: '爱奇艺页面没有返回 tvid，无法获取选集' }
  const headers = {
    referer: url,
    accept: 'application/json, text/plain, */*',
    ...(cookie ? { cookie } : {}),
  }
  const info = await fetchJson(`https://mesh.if.iqiyi.com/player/pcw/video/playervideoinfo?id=${encodeURIComponent(resolvedTvid)}&locale=cn_s`, { headers })
  const infoData = info.json?.data || {}
  const albumId = String(infoData.albumId || infoData.aid || '')
  if (!albumId) return { ok: false, error: `爱奇艺没有返回专辑 ID（tvid=${resolvedTvid}）` }

  const episodes = []
  const now = Date.now()
  for (let page = 1; page <= 5; page += 1) {
    const response = await fetchJson(`https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=${encodeURIComponent(albumId)}&page=${page}&size=100`, {
      headers,
    })
    const data = response.json?.data || {}
    const list = Array.isArray(data.epsodelist) ? data.epsodelist : []
    if (!list.length) break
    for (const item of list) {
      const playUrl = absUrl(item.playUrl, 'https://www.iqiyi.com/')
      if (!playUrl) continue
      const index = episodeIndex(item.name, item.order, episodes.length + 1)
      // 还没到播出时间 / 已下线：显示成灰色不可点，避免点进去解析失败
      const issueAt = Number(item.issueTime) || 0
      const notAired = issueAt > now + 2 * 60 * 1000
      const disabled = item.effective === false || notAired
      episodes.push({
        label: episodeLabel(item.name, index, ''),
        title: clean(item.name, 100),
        subtitle: clean(item.subtitle, 60),
        url: playUrl.replace(/^http:\/\//i, 'https://'),
        index,
        vip: Number(item.payMark) > 0,
        disabled,
      })
    }
    if (!data.hasMore) break
  }
  const title = seriesTitleOf(pageTitle || infoData.tvName || infoData.name, episodes)
  return { ok: true, platform: 'iqiyi', seriesKey: `iqiyi:${albumId}`, title, episodes: dedupeEpisodes(episodes), source: 'iqiyi-avlistinfo' }
}

// ---------------------------------------------------------------------------
// 腾讯视频
// ---------------------------------------------------------------------------

function qqCoverId(url) {
  const match = String(url).match(/\/x\/cover\/([A-Za-z0-9]+)\//)
  return match ? match[1] : ''
}

const QQ_PAGE_URL =
  'https://pbaccess.video.qq.com/trpc.universal_backend_service.page_server_rpc.PageServer/GetPageData?video_appid=3000010&vplatform=2&vversion_name=8.2.95'

async function fetchQQEpisodes(url, { pageTitle = '', cookie = '' } = {}) {
  const cid = qqCoverId(url)
  if (!cid) return { ok: false, error: '不是腾讯视频剧集链接（缺少 cover id）' }
  const headers = {
    'content-type': 'application/json',
    referer: `https://v.qq.com/x/cover/${cid}.html`,
    accept: 'application/json, text/plain, */*',
    ...(cookie ? { cookie } : {}),
  }
  const episodes = []
  for (let page = 0; page < 5; page += 1) {
    const body = JSON.stringify({
      page_params: {
        req_from: 'web_vsite',
        page_id: 'vsite_episode_list',
        page_type: 'detail_operation',
        id_type: '1',
        page_size: '100',
        cid,
        vid: '',
        lid: '',
        page_num: String(page),
        page_context: '',
        detail_page_type: '1',
        req_type: '6',
        req_from_second_type: '',
        year: '',
        tab_type: '',
        chapter_name: '',
        is_nocopyright: 'false',
      },
      has_cache: 1,
    })
    const response = await fetchJson(QQ_PAGE_URL, { method: 'POST', headers, body })
    const module = response.json?.data?.module_list_datas?.[0]?.module_datas?.[0] || {}
    const items = module.item_data_lists?.item_datas || []
    if (!items.length) break
    for (const item of items) {
      const params = item.item_params || {}
      const episodeUrl = params.cid && params.vid ? `https://v.qq.com/x/cover/${params.cid}/${params.vid}.html` : ''
      if (!episodeUrl) continue
      const fullTitle = clean(params.play_title || params.union_title || params.title, 100)
      const index = episodeIndex(fullTitle, 0, episodes.length + 1)
      episodes.push({
        label: episodeLabel(fullTitle, index, ''),
        title: fullTitle,
        subtitle: clean(params.video_subtitle, 60),
        url: episodeUrl,
        index,
        vip: /vip/i.test(String(params.pay_type || params.pay || '')),
      })
    }
    if (String(module.module_params?.has_next || '') !== 'true') break
  }
  if (!episodes.length) return { ok: false, error: '腾讯视频没有返回分集列表' }
  return { ok: true, platform: 'qq', seriesKey: `qq:${cid}`, title: seriesTitleOf(pageTitle, episodes), episodes: dedupeEpisodes(episodes), source: 'qq-vsite_episode_list' }
}

// ---------------------------------------------------------------------------
// 优酷（页面 HTML 内嵌 __INITIAL_DATA__）
// ---------------------------------------------------------------------------

// 从文本里截出第 start 个 '{' 开始的完整 JSON 对象（字符串里的花括号不算）
function sliceJsonObject(text, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return ''
}

function findYoukuEpisodeItems(root) {
  const found = []
  const stack = [root]
  const seen = new Set()
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object' || seen.has(node)) continue
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item)
      continue
    }
    const itemList = node.itemList
    if (
      Array.isArray(itemList) &&
      itemList.length &&
      itemList.some((item) => item && item.action && item.action.value && (item.stage || item.rank)) &&
      (/选集/.test(String(node.title || '')) || Number(node.type) === 10013 || /选集/.test(String(node.typeName || '')))
    ) {
      found.push(node)
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') stack.push(value)
    }
  }
  return found
}

function youkuEpisodesFromData(data) {
  const components = findYoukuEpisodeItems(data)
  const collected = []
  for (const component of components) {
    for (const item of component.itemList || []) {
      const value = item?.action?.value
      if (!value) continue
      const index = episodeIndex(item.title, item.stage, collected.length + 1)
      const stage = Number(item.stage) || index
      collected.push({
        label: episodeLabel(item.title, stage, ''),
        title: clean(item.title, 100),
        subtitle: clean(item.subtitle || item.summary, 60),
        url: `https://v.youku.com/v_show/id_${value}.html`,
        index: stage || index,
        vip: Boolean(item.episodeInfo && item.episodeInfo.benefitType),
        videoType: clean(item.videoType, 12),
        showId: String(item?.action?.extra?.showId || ''),
        videoId: String(value),
      })
    }
  }
  // 播放页的选集组件里可能混进「相关推荐」，用当前视频所属的 showId 过滤掉。
  const currentVideoId = String(data?.pageMap?.extra?.videoId || '')
  const current = collected.find((item) => item.videoId === currentVideoId && item.showId)
  const showId = current?.showId || collected.find((item) => item.showId)?.showId || ''
  const episodes = collected.filter((item) => !showId || item.showId === showId)

  // 同一 stage 有正片和预告时优先正片
  const byStage = new Map()
  for (const item of episodes) {
    const key = `${item.index}`
    const existing = byStage.get(key)
    if (!existing) {
      byStage.set(key, item)
      continue
    }
    if (existing.videoType !== '正片' && item.videoType === '正片') byStage.set(key, item)
  }
  const out = [...byStage.values()].map((item) => {
    const { videoType, showId: _showId, videoId, ...rest } = item
    return rest
  })
  return { episodes: out, showId }
}

async function fetchYoukuEpisodes(url, { pageTitle = '', cookie = '' } = {}) {
  const response = await fetchText(url, { headers: { referer: 'https://www.youku.com/', ...(cookie ? { cookie } : {}) } })
  if (!response.ok) return { ok: false, error: `优酷页面返回 HTTP ${response.status}` }
  const marker = response.text.indexOf('__INITIAL_DATA__')
  if (marker < 0) return { ok: false, error: '优酷页面没有内嵌选集数据' }
  const brace = response.text.indexOf('{', marker)
  if (brace < 0) return { ok: false, error: '优酷选集数据格式异常' }
  const raw = sliceJsonObject(response.text, brace)
  if (!raw) return { ok: false, error: '优酷选集数据不完整' }
  let data = null
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, error: '优酷选集数据解析失败' }
  }
  const { episodes, showId } = youkuEpisodesFromData(data)
  if (!episodes.length) return { ok: false, error: '优酷页面没有找到选集列表' }
  const titleFromPage = (String(response.text).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''
  const title = seriesTitleOf(pageTitle || titleFromPage, episodes)
  for (const item of episodes) {
    if (title && item.label.startsWith(title)) item.label = item.label.slice(title.length).trim() || item.label
  }
  return {
    ok: true,
    platform: 'youku',
    seriesKey: `youku:${showId || 'show'}`,
    title,
    episodes: dedupeEpisodes(episodes),
    source: 'youku-initial-data',
  }
}

// ---------------------------------------------------------------------------
// 芒果TV
// ---------------------------------------------------------------------------

function mgtvVideoId(url) {
  const match = String(url).match(/\/(\d+)\.html/)
  return match ? match[1] : ''
}

async function fetchMgtvEpisodes(url, { pageTitle = '', cookie = '' } = {}) {
  const videoId = mgtvVideoId(url)
  if (!videoId) return { ok: false, error: '无法识别芒果TV 视频 ID' }
  const headers = {
    referer: url,
    accept: 'application/json, text/plain, */*',
    ...(cookie ? { cookie } : {}),
  }
  const response = await fetchJson(`https://pcweb.api.mgtv.com/episode/list?_support=10000000&version=5.5.35&video_id=${videoId}&page=1&size=100`, { headers })
  const data = response.json?.data || {}
  const list = Array.isArray(data.list) ? data.list : []
  const episodes = []
  for (const item of list) {
    // isIntact=1 是完整正片；3 之类是看点/预告，会把选集塞满
    if (String(item.isIntact) !== '1') continue
    // 电视剧是「第N集」，综艺是「第N期」，动漫/少儿常见「第N话」「第N回」，
    // 只认「集」会把综艺和动漫整季都过滤掉。
    if (!/^第\s*\d+\s*[集期话回]/.test(String(item.t4 || '').trim())) continue
    const episodeUrl = absUrl(item.url, 'https://www.mgtv.com/')
    if (!episodeUrl) continue
    const index = episodeIndex(item.t4, item.t1, episodes.length + 1)
    episodes.push({
      label: episodeLabel(item.t4, index, ''),
      title: clean(item.t3 || item.t4, 100),
      subtitle: clean(item.t2, 60),
      url: episodeUrl,
      index,
      vip: String(item.isvip) === '1',
    })
  }
  if (!episodes.length) return { ok: false, error: '芒果TV 没有返回正片选集' }
  const title = clean(data.info?.title, 60) || seriesTitleOf(pageTitle, episodes)
  return { ok: true, platform: 'mgtv', seriesKey: `mgtv:${data.info?.clip_id || videoId}`, title, episodes: dedupeEpisodes(episodes), source: 'mgtv-episode-list' }
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

async function resolveSeries({ url, hint = {}, force = false } = {}) {
  const target = String(url || '').trim()
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: '链接格式不正确' }
  const platform = detectPlatformByUrl(target)
  if (!platform || platform.key === 'browser') return { ok: false, error: '只有在四个平台的视频页才能获取选集' }
  const cacheKey = `${platform.key}:${target.split('#')[0]}`
  const cached = cache.get(cacheKey)
  if (!force && cached && Date.now() - cached.at < CACHE_TTL) return { ...cached.value, cached: true }
  if (pending.has(cacheKey)) return pending.get(cacheKey)

  const task = (async () => {
    const cookie = await getCookieHeader(platform)
    const options = { pageTitle: clean(hint.title || '', 100), cookie, tvid: String(hint.tvid || '') }
    let result
    if (platform.key === 'iqiyi') result = await fetchIqiyiEpisodes(target, options)
    else if (platform.key === 'qq') result = await fetchQQEpisodes(target, options)
    else if (platform.key === 'youku') result = await fetchYoukuEpisodes(target, options)
    else if (platform.key === 'mgtv') result = await fetchMgtvEpisodes(target, options)
    else result = { ok: false, error: '暂不支持该平台' }
    if (result.ok) {
      result.url = target
      result.platformName = platform.name
      result.at = Date.now()
      cache.set(cacheKey, { at: Date.now(), value: result })
    }
    return result
  })()

  pending.set(cacheKey, task)
  try {
    return await task
  } finally {
    pending.delete(cacheKey)
  }
}

module.exports = {
  resolveSeries,
  fetchIqiyiEpisodes,
  fetchQQEpisodes,
  fetchYoukuEpisodes,
  fetchMgtvEpisodes,
  sliceJsonObject,
  youkuEpisodesFromData,
}
