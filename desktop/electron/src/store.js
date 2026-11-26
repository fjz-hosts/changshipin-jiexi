'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { DEFAULT_LINES } = require('./lines')
const { PLATFORMS, detectPlatformByUrl } = require('./platforms')

const MAX_HISTORY = 40
const MAX_SHORT_HISTORY = 120
const MAX_MUSIC_HISTORY = 120
const MAX_MUSIC_FAVORITES = 300
// 短视频 / 音乐下载记录：重启后还要能看到，才能点开文件夹或删除（删记录时文件一起删）
const MAX_SHORT_DOWNLOADS = 200
const MAX_MUSIC_DOWNLOADS = 200
const CONFIG_VERSION = 1

// 音乐平台登录态只用于主进程请求官方接口，不暴露给渲染进程。
const MUSIC_COOKIE_KEYS = {
  netease: ['MUSIC_U'],
  qq: ['qm_keyst', 'qqmusic_key', 'p_skey'],
  kugou: ['userid', 'KugouID', 'token'],
  kuwo: ['userid', 'token'],
  qishui: ['sessionid'],
}

// 「第 12 集 / 第12期 / EP12 / S01E02」：历史记录按「一部剧一条」合并，
// 剧名去掉集数后就是这部剧的名字。
const EPISODE_TEXT_RE = /(第\s*[0-9一二三四五六七八九十百千零两]+\s*[集期话回]|EP?\s*\d{1,4}|S\d{1,2}\s*E\d{1,3})/i

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function cleanText(value, max = 300) {
  return String(value == null ? '' : value).replace(/[\r\n\t]/g, ' ').trim().slice(0, max)
}

function episodeText(raw) {
  const match = String(raw || '').match(EPISODE_TEXT_RE)
  return match ? match[0].replace(/\s+/g, '') : ''
}

// 「今天是太阳雨 第5集」→「今天是太阳雨」
function seriesBaseTitle(raw) {
  const text = cleanText(raw, 150)
  if (!text) return ''
  const match = text.match(EPISODE_TEXT_RE)
  if (match && match.index > 0) {
    return text.slice(0, match.index).replace(/[\s\-_|·:：]+$/, '').trim()
  }
  return text.replace(/[\s\-_|]+$/, '').trim()
}

function normalizePlatformKey(value, url) {
  const raw = cleanText(value, 20)
  if (raw) {
    const byKey = PLATFORMS.find((item) => item.key === raw)
    if (byKey) return byKey.key
    const byName = PLATFORMS.find((item) => item.name === raw)
    if (byName) return byName.key
  }
  return detectPlatformByUrl(url)?.key || ''
}

function historySeriesKey(item) {
  const base = seriesBaseTitle(item.title)
  if (!base) return `url::${String(item.url || '')}`
  return `${normalizePlatformKey(item.platform, item.url)}::${base.toLowerCase()}`
}

function normalizeLine(raw, index) {
  if (!raw || typeof raw !== 'object') return null
  const kind = ['page', 'api', 'mgtv', 'direct', 'native', 'cms'].includes(raw.kind) ? raw.kind : 'page'
  const url = cleanText(raw.url, 600)
  if (!url) return null
  const id = cleanText(raw.id, 80) || `line-${Date.now()}-${index}`
  return {
    id,
    name: cleanText(raw.name, 40) || `线路 ${index + 1}`,
    kind,
    url,
    enabled: raw.enabled !== false,
    builtin: Boolean(raw.builtin),
    note: cleanText(raw.note, 120),
    platform: cleanText(raw.platform, 20),
    createdAt: Number(raw.createdAt) || Date.now(),
  }
}

function normalizeHealth(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [id, value] of Object.entries(raw).slice(0, 300)) {
    if (!id || !value || typeof value !== 'object') continue
    out[String(id).slice(0, 80)] = {
      ok: Boolean(value.ok),
      ms: Math.max(0, Number(value.ms) || 0),
      note: cleanText(value.note, 120),
      at: Number(value.at) || Date.now(),
    }
  }
  return out
}

// 观看历史：同一部剧只保留一条，记录「最近看到第几集 + 这一集的进度」。
// 旧版本是一集一条，升级时在这里合并掉（按时间排序，较新的记录覆盖集数与进度）。
function normalizeHistory(raw) {
  if (!Array.isArray(raw)) return []
  const items = raw
    .filter((item) => item && typeof item === 'object' && /^https?:\/\//i.test(String(item.url || '')))
    .map((item) => {
      const title = cleanText(item.title, 150)
      return {
        url: String(item.url),
        platform: normalizePlatformKey(item.platform, item.url),
        lineId: cleanText(item.lineId, 80),
        lineName: cleanText(item.lineName, 40),
        title: seriesBaseTitle(title) || title,
        episode: cleanText(item.episode, 30) || episodeText(title),
        cover: cleanText(item.cover, 1200),
        progress: Math.max(0, Number(item.progress) || 0),
        duration: Math.max(0, Number(item.duration) || 0),
        at: Number(item.at) || Date.now(),
      }
    })
    .sort((left, right) => left.at - right.at)

  const merged = new Map()
  for (const item of items) {
    const key = historySeriesKey(item)
    const previous = merged.get(key)
    if (!previous) {
      merged.set(key, item)
      continue
    }
    // 较新的记录代表「最近一次观看」，只保留它的链接、集数和进度
    merged.set(key, {
      ...previous,
      url: item.url,
      platform: item.platform || previous.platform,
      lineId: item.lineId || previous.lineId,
      lineName: item.lineName || previous.lineName,
      title: item.title || previous.title,
      episode: item.episode || previous.episode,
      cover: item.cover || previous.cover,
      progress: item.progress,
      duration: item.duration,
      at: item.at,
    })
  }
  return [...merged.values()]
    .sort((left, right) => right.at - left.at)
    .slice(0, MAX_HISTORY)
    .map((item) => ({ ...item, seriesKey: historySeriesKey(item) }))
}

// 短视频历史：和长视频分开存，只记「解析过哪条视频」，点一下可以重新解析。
function normalizeShortHistory(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const url = cleanText(item.url, 2000)
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url)
    out.push({
      url,
      platform: cleanText(item.platform, 20),
      platformName: cleanText(item.platformName, 30),
      title: cleanText(item.title, 150),
      author: cleanText(item.author, 80),
      cover: cleanText(item.cover, 1000),
      duration: Math.max(0, Number(item.duration) || 0),
      at: Number(item.at) || Date.now(),
    })
  }
  return out.sort((left, right) => right.at - left.at).slice(0, MAX_SHORT_HISTORY)
}

function normalizeMusicItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const platform = cleanText(raw.platform, 20)
  const id = cleanText(raw.id, 120)
  const title = cleanText(raw.title, 150)
  if (!platform || !id || !title) return null
  return {
    key: `${platform}:${id}`,
    platform,
    platformName: cleanText(raw.platformName, 30),
    id,
    url: cleanText(raw.url, 2000),
    title,
    artist: cleanText(raw.artist, 120),
    album: cleanText(raw.album, 120),
    cover: cleanText(raw.cover, 1000),
    duration: Math.max(0, Number(raw.duration) || 0),
    vip: Boolean(raw.vip),
    at: Number(raw.at) || Date.now(),
  }
}

function normalizeMusicList(raw, max) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const normalized = normalizeMusicItem(item)
    if (!normalized || seen.has(normalized.key)) continue
    seen.add(normalized.key)
    out.push(normalized)
  }
  return out.sort((left, right) => right.at - left.at).slice(0, max)
}

// ---------------------------------------------------------------------------
// 下载记录（短视频队列 / 音乐下载记录）
//
// 以前这两份记录只放在渲染进程内存里，退出重进就没了；现在落到 config.json，
// 每条记录带 savedPath，删除记录时主进程会把对应文件一起删掉。
// ---------------------------------------------------------------------------
const DOWNLOAD_STATUSES = new Set(['queued', 'running', 'done', 'failed', 'cancelled', 'interrupted'])

function normalizeDownloadStatus(raw, fallback = 'failed') {
  const value = cleanText(raw, 20)
  return DOWNLOAD_STATUSES.has(value) ? value : fallback
}

function normalizeDownloadRecord(raw, kind = 'short') {
  if (!raw || typeof raw !== 'object') return null
  const id = cleanText(raw.id, 80)
  if (!id) return null
  const item = {
    id,
    title: cleanText(raw.title, 150) || (kind === 'music' ? '歌曲' : '视频'),
    platform: cleanText(raw.platform, 40),
    format: cleanText(raw.format, 12),
    status: normalizeDownloadStatus(raw.status),
    percent: Math.max(0, Math.min(100, Number(raw.percent) || 0)),
    savedPath: cleanText(raw.savedPath, 1000),
    error: cleanText(raw.error, 200),
    existed: Boolean(raw.existed),
    at: Number(raw.at) || Date.now(),
  }
  if (kind === 'music') {
    item.platformName = cleanText(raw.platformName, 30)
    item.quality = cleanText(raw.quality, 12)
    item.lyricPath = cleanText(raw.lyricPath, 1000)
  }
  return item
}

function normalizeDownloadList(raw, kind, max = MAX_SHORT_DOWNLOADS) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const normalized = normalizeDownloadRecord(item, kind)
    if (!normalized || seen.has(normalized.id)) continue
    seen.add(normalized.id)
    out.push(normalized)
  }
  return out.slice(0, max)
}

// 上次没下完的任务在重启后已经没有了下载进程，标记成「已中断」而不是一直显示「下载中」
function markDownloadsInterrupted(list) {
  return list.map((item) =>
    item.status === 'queued' || item.status === 'running'
      ? { ...item, status: 'interrupted', error: item.error || '程序重启后已中断' }
      : item,
  )
}

function normalizeMusicCookies(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const key of Object.keys(MUSIC_COOKIE_KEYS)) {
    const value = cleanText(raw[key], 20000)
    if (value) out[key] = value
  }
  return out
}

function musicLoginFromCookies(cookies) {
  const status = {}
  for (const [key, loginNames] of Object.entries(MUSIC_COOKIE_KEYS)) {
    const cookie = String(cookies[key] || '')
    status[key] = Boolean(cookie && loginNames.some((name) => new RegExp(`(?:^|;\\s*)${name}=`).test(cookie)))
  }
  return status
}

class Store {
  constructor(userDataDir) {
    this.dir = userDataDir
    this.file = path.join(userDataDir, 'config.json')
    this.data = this._load()
  }

  _defaults() {
    return {
      version: CONFIG_VERSION,
      nativeParseVersion: 2,
      lines: DEFAULT_LINES.map((line, index) => normalizeLine(line, index)),
      defaultLineId: DEFAULT_LINES[0]?.id || '',
      history: [],
      shortHistory: [],
      shortDownloads: [],
      musicHistory: [],
      musicFavorites: [],
      musicDownloads: [],
      musicCookies: {},
      lineHealth: {},
      autoLineTest: true,
      autoUpdate: true,
      autoFallback: true,
      closeToTray: false,
      lastUrl: '',
    }
  }

  _load() {
    const defaults = this._defaults()
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const data = JSON.parse(raw)
      const lines = Array.isArray(data.lines) ? data.lines.map(normalizeLine).filter(Boolean) : []
      const migrateNative = (Number(data.nativeParseVersion) || 0) < 2
      for (const line of lines) {
        if (line.id === 'builtin-mgtv-native') {
          line.kind = 'mgtv'
          line.url = 'mgtv://auto'
          line.platform = 'mgtv'
        }
        // v1.2.12：原生取流实验改名为「原生解析」。腾讯视频按 yt-dlp 流程接好，
        // 但只作为第三方线路失败后的备用，不再抢 789 的首位；爱奇艺 / 优酷的
        // yt-dlp 解析器目前失效，保持关闭。
        // 只迁移一次：之后用户手动调整启用状态，不会被下一次启动覆盖。
        if (migrateNative && line.kind === 'native') {
          line.url = 'native://auto'
          if (line.id === 'builtin-qq-native') {
            line.name = '腾讯视频 原生解析'
            line.platform = 'qq'
            line.note = '备用线路：第三方线路都失败后才尝试。腾讯视频官方接口（按 yt-dlp 流程），电影 / 电视剧 / 动漫通用；免费内容 720P，付费电影通常只给试听'
            line.enabled = true
          } else if (line.id === 'builtin-iqiyi-native') {
            line.name = '爱奇艺 原生解析'
            line.platform = 'iqiyi'
            line.note = 'yt-dlp 当前无法解析新版爱奇艺页面（播放地址由 cmd5x 签名接口下发，旧接口已失效），暂不启用；失败会自动用第三方线路'
            line.enabled = false
          } else if (line.id === 'builtin-youku-native') {
            line.name = '优酷 原生解析'
            line.platform = 'youku'
            line.note = 'yt-dlp 的 ups.youku.com 接口对匿名设备返回 -6004（限制播放），暂不启用；失败会自动用第三方线路'
            line.enabled = false
          }
        }
      }
      // 升级时把新版本新增的内置线路补进旧配置（例如芒果TV 原生解析），
      // 用户自己删掉/改过的线路保持原样。
      const present = new Set(lines.map((line) => line.id))
      for (const builtin of defaults.lines) {
        if (builtin.builtin && !present.has(builtin.id)) {
          lines.push({ ...builtin })
          present.add(builtin.id)
        }
      }
      const merged = {
        ...defaults,
        ...data,
        version: CONFIG_VERSION,
        nativeParseVersion: 2,
        lines: lines.length ? lines : defaults.lines,
        history: normalizeHistory(data.history),
        shortHistory: normalizeShortHistory(data.shortHistory),
        shortDownloads: markDownloadsInterrupted(normalizeDownloadList(data.shortDownloads, 'short', MAX_SHORT_DOWNLOADS)),
        musicHistory: normalizeMusicList(data.musicHistory, MAX_MUSIC_HISTORY),
        musicFavorites: normalizeMusicList(data.musicFavorites, MAX_MUSIC_FAVORITES),
        musicDownloads: markDownloadsInterrupted(normalizeDownloadList(data.musicDownloads, 'music', MAX_MUSIC_DOWNLOADS)),
        musicCookies: normalizeMusicCookies(data.musicCookies),
        lineHealth: normalizeHealth(data.lineHealth),
        autoLineTest: data.autoLineTest !== false,
        autoUpdate: data.autoUpdate !== false,
        autoFallback: data.autoFallback !== false,
        closeToTray: data.closeToTray === true,
        lastUrl: typeof data.lastUrl === 'string' ? data.lastUrl : '',
      }
      if (!merged.lines.some((line) => line.id === merged.defaultLineId)) {
        merged.defaultLineId = merged.lines[0]?.id || ''
      }
      return merged
    } catch {
      return defaults
    }
  }

  _write() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (error) {
      // 配置写不进去不应该让程序崩掉
      console.error('[store] 保存配置失败', error)
    }
  }

  snapshot() {
    const copy = clone(this.data)
    // 登录 Cookie 只留在主进程；渲染进程只看登录状态。
    delete copy.musicCookies
    copy.musicLogin = musicLoginFromCookies(this.data.musicCookies)
    return copy
  }

  get(key) {
    return this.data[key]
  }

  setLines(lines, defaultLineId) {
    const normalized = (Array.isArray(lines) ? lines : []).map(normalizeLine).filter(Boolean).slice(0, 200)
    if (!normalized.length) throw new Error('至少需要保留一条解析线路')
    this.data.lines = normalized
    this.data.defaultLineId = normalized.some((line) => line.id === defaultLineId)
      ? defaultLineId
      : normalized[0].id
    this._write()
    return this.snapshot()
  }

  saveSettings(patch = {}) {
    if (typeof patch.autoUpdate === 'boolean') this.data.autoUpdate = patch.autoUpdate
    if (typeof patch.autoFallback === 'boolean') this.data.autoFallback = patch.autoFallback
    if (typeof patch.closeToTray === 'boolean') this.data.closeToTray = patch.closeToTray
    if (typeof patch.autoLineTest === 'boolean') this.data.autoLineTest = patch.autoLineTest
    if (patch.lineHealth && typeof patch.lineHealth === 'object') {
      this.data.lineHealth = normalizeHealth(patch.lineHealth)
    }
    if (typeof patch.lastUrl === 'string') this.data.lastUrl = cleanText(patch.lastUrl, 2000)
    this._write()
    return this.snapshot()
  }

  addHistory(entry) {
    const url = cleanText(entry?.url, 2000)
    if (!/^https?:\/\//i.test(url)) return this.snapshot().history
    const rawTitle = cleanText(entry.title, 150)
    const episode = cleanText(entry.episode, 30) || episodeText(rawTitle)
    const title = seriesBaseTitle(rawTitle) || rawTitle
    const item = {
      url,
      platform: normalizePlatformKey(entry.platform, url),
      lineId: cleanText(entry.lineId, 80),
      lineName: cleanText(entry.lineName, 40),
      title,
      episode,
      cover: cleanText(entry.cover, 1200),
      progress: Math.max(0, Number(entry.progress) || 0),
      duration: Math.max(0, Number(entry.duration) || 0),
      at: Date.now(),
    }
    item.seriesKey = historySeriesKey(item)

    // 同一部剧的旧记录（包括旧版本按集分开存的）都要合并成一条
    const previous =
      this.data.history.find((old) => old.seriesKey === item.seriesKey) ||
      this.data.history.find((old) => old.url === url) ||
      null
    if (previous) {
      const hadTitle = Boolean(item.title)
      if (!item.title) item.title = previous.title
      if (!item.episode) item.episode = previous.episode
      if (!item.cover) item.cover = previous.cover
      if (!item.platform) item.platform = previous.platform
      if (!item.lineId) item.lineId = previous.lineId
      if (!item.lineName) item.lineName = previous.lineName
      // 没有标题时沿用旧记录的身份，避免下次又拆成两条
      if (!hadTitle && previous.seriesKey) item.seriesKey = previous.seriesKey
      if (previous.url === url) {
        // 重新解析同一集：别把已经记下的进度清零
        if (!Number(entry.progress)) item.progress = previous.progress
        if (!Number(entry.duration)) item.duration = previous.duration
      }
    }

    this.data.history = [item, ...this.data.history.filter((old) => old !== previous)].slice(0, MAX_HISTORY)
    this.data.lastUrl = url
    this._write()
    return this.snapshot().history
  }

  updateHistory(entry = {}) {
    const url = cleanText(entry.url, 2000)
    const seriesKey = cleanText(entry.seriesKey, 200)
    let item = url ? this.data.history.find((old) => old.url === url) : null
    if (!item && seriesKey) item = this.data.history.find((old) => old.seriesKey === seriesKey)
    if (!item) return this.snapshot().history
    const rawTitle = cleanText(entry.title, 150)
    if (rawTitle) {
      item.title = seriesBaseTitle(rawTitle) || rawTitle
      item.seriesKey = historySeriesKey(item)
    }
    const episode = cleanText(entry.episode, 30)
    if (episode) item.episode = episode
    const cover = cleanText(entry.cover, 1200)
    if (cover) item.cover = cover
    if (Number.isFinite(Number(entry.progress))) item.progress = Math.max(0, Number(entry.progress))
    if (Number.isFinite(Number(entry.duration))) item.duration = Math.max(0, Number(entry.duration))
    this._write()
    return this.snapshot().history
  }

  removeHistory(rawUrl) {
    const url = cleanText(rawUrl, 2000)
    this.data.history = this.data.history.filter((item) => item.url !== url)
    this._write()
    return this.snapshot().history
  }

  clearHistory() {
    this.data.history = []
    this._write()
    return this.data.history
  }

  // -------------------------------------------------------------------------
  // 短视频历史（与长视频观看历史完全独立）
  // -------------------------------------------------------------------------
  addShortHistory(entry = {}) {
    const url = cleanText(entry.url, 2000)
    if (!/^https?:\/\//i.test(url)) return this.snapshot().shortHistory
    const item = {
      url,
      platform: cleanText(entry.platform, 20),
      platformName: cleanText(entry.platformName, 30),
      title: cleanText(entry.title, 150),
      author: cleanText(entry.author, 80),
      cover: cleanText(entry.cover, 1000),
      duration: Math.max(0, Number(entry.duration) || 0),
      at: Date.now(),
    }
    const previous = this.data.shortHistory.find((old) => old.url === url)
    if (previous) {
      if (!item.title) item.title = previous.title
      if (!item.cover) item.cover = previous.cover
      if (!item.author) item.author = previous.author
      if (!item.platformName) item.platformName = previous.platformName
    }
    this.data.shortHistory = [item, ...this.data.shortHistory.filter((old) => old.url !== url)].slice(0, MAX_SHORT_HISTORY)
    this._write()
    return this.snapshot().shortHistory
  }

  removeShortHistory(rawUrl) {
    const url = cleanText(rawUrl, 2000)
    this.data.shortHistory = this.data.shortHistory.filter((item) => item.url !== url)
    this._write()
    return this.snapshot().shortHistory
  }

  clearShortHistory() {
    this.data.shortHistory = []
    this._write()
    return []
  }

  // -------------------------------------------------------------------------
  // 短视频下载记录（队列）：新增记录追加在末尾，和界面里的队列顺序一致
  // -------------------------------------------------------------------------
  saveShortDownload(entry = {}) {
    const item = normalizeDownloadRecord(entry, 'short')
    if (!item) return this.snapshot().shortDownloads
    const list = Array.isArray(this.data.shortDownloads) ? this.data.shortDownloads : []
    const index = list.findIndex((old) => old.id === item.id)
    if (index >= 0) list[index] = { ...list[index], ...item }
    else list.push(item)
    if (list.length > MAX_SHORT_DOWNLOADS) list.splice(0, list.length - MAX_SHORT_DOWNLOADS)
    this.data.shortDownloads = list
    this._write()
    return this.snapshot().shortDownloads
  }

  removeShortDownload(id) {
    const target = cleanText(id, 80)
    this.data.shortDownloads = (this.data.shortDownloads || []).filter((item) => item.id !== target)
    this._write()
    return this.snapshot().shortDownloads
  }

  setShortDownloads(list) {
    this.data.shortDownloads = normalizeDownloadList(list, 'short', MAX_SHORT_DOWNLOADS)
    this._write()
    return this.snapshot().shortDownloads
  }

  // -------------------------------------------------------------------------
  // 音乐下载记录：新增记录放最前面，和「下载记录」列表顺序一致
  // -------------------------------------------------------------------------
  saveMusicDownload(entry = {}) {
    const item = normalizeDownloadRecord(entry, 'music')
    if (!item) return this.snapshot().musicDownloads
    const list = Array.isArray(this.data.musicDownloads) ? this.data.musicDownloads : []
    const index = list.findIndex((old) => old.id === item.id)
    if (index >= 0) list[index] = { ...list[index], ...item }
    else list.unshift(item)
    if (list.length > MAX_MUSIC_DOWNLOADS) list.length = MAX_MUSIC_DOWNLOADS
    this.data.musicDownloads = list
    this._write()
    return this.snapshot().musicDownloads
  }

  removeMusicDownload(id) {
    const target = cleanText(id, 80)
    this.data.musicDownloads = (this.data.musicDownloads || []).filter((item) => item.id !== target)
    this._write()
    return this.snapshot().musicDownloads
  }

  setMusicDownloads(list) {
    this.data.musicDownloads = normalizeDownloadList(list, 'music', MAX_MUSIC_DOWNLOADS)
    this._write()
    return this.snapshot().musicDownloads
  }

  // -------------------------------------------------------------------------
  // 音乐：播放记录 / 收藏 / 平台登录 Cookie
  // -------------------------------------------------------------------------
  addMusicHistory(entry = {}) {
    const item = normalizeMusicItem({ ...entry, at: Date.now() })
    if (!item) return this.snapshot().musicHistory
    this.data.musicHistory = [item, ...this.data.musicHistory.filter((old) => old.key !== item.key)].slice(0, MAX_MUSIC_HISTORY)
    this._write()
    return this.snapshot().musicHistory
  }

  removeMusicHistory(key) {
    const target = cleanText(key, 200)
    this.data.musicHistory = this.data.musicHistory.filter((item) => item.key !== target)
    this._write()
    return this.snapshot().musicHistory
  }

  clearMusicHistory() {
    this.data.musicHistory = []
    this._write()
    return []
  }

  addMusicFavorite(entry = {}) {
    const item = normalizeMusicItem({ ...entry, at: Date.now() })
    if (!item) return this.snapshot().musicFavorites
    this.data.musicFavorites = [item, ...this.data.musicFavorites.filter((old) => old.key !== item.key)].slice(0, MAX_MUSIC_FAVORITES)
    this._write()
    return this.snapshot().musicFavorites
  }

  removeMusicFavorite(key) {
    const target = cleanText(key, 200)
    this.data.musicFavorites = this.data.musicFavorites.filter((item) => item.key !== target)
    this._write()
    return this.snapshot().musicFavorites
  }

  clearMusicFavorites() {
    this.data.musicFavorites = []
    this._write()
    return []
  }

  saveMusicCookies(patch = {}) {
    const next = { ...this.data.musicCookies }
    for (const key of Object.keys(MUSIC_COOKIE_KEYS)) {
      if (patch[key] === null) delete next[key]
      else if (typeof patch[key] === 'string' && patch[key].trim()) next[key] = cleanText(patch[key], 20000)
    }
    this.data.musicCookies = normalizeMusicCookies(next)
    this._write()
    return this.snapshot().musicLogin
  }

  getMusicCookie(key) {
    return String(this.data.musicCookies?.[key] || '')
  }

  musicLoginState() {
    return musicLoginFromCookies(this.data.musicCookies || {})
  }

  // 用远端线路清单覆盖内置线路，保留用户自建线路与启用状态
  applyRemoteLines(remoteLines) {
    const incoming = (Array.isArray(remoteLines) ? remoteLines : [])
      .map((line, index) => normalizeLine({ ...line, builtin: true }, index))
      .filter(Boolean)
    if (!incoming.length) return { applied: 0 }
    const enabledState = new Map(this.data.lines.map((line) => [line.id, line.enabled]))
    const custom = this.data.lines.filter((line) => !line.builtin)
    const builtin = incoming.map((line) => ({
      ...line,
      enabled: enabledState.has(line.id) ? enabledState.get(line.id) : line.enabled !== false,
    }))
    this.data.lines = [...builtin, ...custom]
    if (!this.data.lines.some((line) => line.id === this.data.defaultLineId)) {
      this.data.defaultLineId = this.data.lines[0]?.id || ''
    }
    this._write()
    return { applied: builtin.length }
  }
}

module.exports = { Store, normalizeLine }
