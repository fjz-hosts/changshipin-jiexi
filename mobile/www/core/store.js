/* 手机端配置 / 线路 / 历史（与桌面端 store.js 同一套数据结构，存储改为 localStorage）。 */
;(function () {
  'use strict'

  const { DEFAULT_LINES } = window.CSPLines
  const { PLATFORMS, detectPlatformByUrl } = window.CSPPlatforms

  const STORAGE_KEY = 'csp.config.v1'
  const MAX_HISTORY = 40
  const CONFIG_VERSION = 1
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

  function normalizeLine(raw, index = 0) {
    if (!raw || typeof raw !== 'object') return null
    const kind = ['page', 'api', 'mgtv', 'direct', 'native'].includes(raw.kind) ? raw.kind : 'page'
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
      merged.set(key, {
        ...previous,
        url: item.url,
        platform: item.platform || previous.platform,
        lineId: item.lineId || previous.lineId,
        lineName: item.lineName || previous.lineName,
        title: item.title || previous.title,
        episode: item.episode || previous.episode,
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

  class Store {
    constructor() {
      this.data = this._load()
      this._timer = 0
    }

    _defaults() {
      return {
        version: CONFIG_VERSION,
        lines: DEFAULT_LINES.map((line, index) => normalizeLine(line, index)),
        defaultLineId: DEFAULT_LINES[0]?.id || '',
        history: [],
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
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return defaults
        const data = JSON.parse(raw)
        const lines = Array.isArray(data.lines) ? data.lines.map(normalizeLine).filter(Boolean) : []
        for (const line of lines) {
          if (line.id === 'builtin-mgtv-native') {
            line.kind = 'mgtv'
            line.url = 'mgtv://auto'
            line.platform = 'mgtv'
          }
        }
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
          lines: lines.length ? lines : defaults.lines,
          history: normalizeHistory(data.history),
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
      clearTimeout(this._timer)
      this._timer = setTimeout(() => {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data))
        } catch (error) {
          console.warn('[store] 保存配置失败', error)
        }
      }, 30)
    }

    snapshot() {
      return clone(this.data)
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
        progress: Math.max(0, Number(entry.progress) || 0),
        duration: Math.max(0, Number(entry.duration) || 0),
        at: Date.now(),
      }
      item.seriesKey = historySeriesKey(item)

      const previous =
        this.data.history.find((old) => old.seriesKey === item.seriesKey) ||
        this.data.history.find((old) => old.url === url) ||
        null
      if (previous) {
        const hadTitle = Boolean(item.title)
        if (!item.title) item.title = previous.title
        if (!item.episode) item.episode = previous.episode
        if (!item.platform) item.platform = previous.platform
        if (!item.lineId) item.lineId = previous.lineId
        if (!item.lineName) item.lineName = previous.lineName
        if (!hadTitle && previous.seriesKey) item.seriesKey = previous.seriesKey
        if (previous.url === url) {
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

  window.CSPStore = { Store, normalizeLine, normalizeHistory, seriesBaseTitle, episodeText }
})()
