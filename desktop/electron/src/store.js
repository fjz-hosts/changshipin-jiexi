'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { DEFAULT_LINES } = require('./lines')

const MAX_HISTORY = 40
const CONFIG_VERSION = 1

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function cleanText(value, max = 300) {
  return String(value == null ? '' : value).replace(/[\r\n\t]/g, ' ').trim().slice(0, max)
}

function normalizeLine(raw, index) {
  if (!raw || typeof raw !== 'object') return null
  const kind = ['page', 'api', 'direct'].includes(raw.kind) ? raw.kind : 'page'
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
    createdAt: Number(raw.createdAt) || Date.now(),
  }
}

function normalizeHistory(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item) => item && typeof item === 'object' && /^https?:\/\//i.test(String(item.url || '')))
    .slice(0, MAX_HISTORY)
    .map((item) => ({
      url: String(item.url),
      platform: cleanText(item.platform, 20),
      lineId: cleanText(item.lineId, 80),
      lineName: cleanText(item.lineName, 40),
      at: Number(item.at) || Date.now(),
    }))
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
      lines: DEFAULT_LINES.map((line, index) => normalizeLine(line, index)),
      defaultLineId: DEFAULT_LINES[0]?.id || '',
      history: [],
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
      const merged = {
        ...defaults,
        ...data,
        version: CONFIG_VERSION,
        lines: lines.length ? lines : defaults.lines,
        history: normalizeHistory(data.history),
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
    if (typeof patch.lastUrl === 'string') this.data.lastUrl = cleanText(patch.lastUrl, 2000)
    this._write()
    return this.snapshot()
  }

  addHistory(entry) {
    const url = cleanText(entry?.url, 2000)
    if (!/^https?:\/\//i.test(url)) return this.snapshot().history
    const item = {
      url,
      platform: cleanText(entry.platform, 20),
      lineId: cleanText(entry.lineId, 80),
      lineName: cleanText(entry.lineName, 40),
      at: Date.now(),
    }
    this.data.history = [item, ...this.data.history.filter((old) => old.url !== url)].slice(0, MAX_HISTORY)
    this.data.lastUrl = url
    this._write()
    return this.snapshot().history
  }

  clearHistory() {
    this.data.history = []
    this._write()
    return this.data.history
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
