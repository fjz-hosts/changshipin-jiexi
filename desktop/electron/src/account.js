'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { safeStorage } = require('electron')

const REQUEST_TIMEOUT = 12000
const HEARTBEAT_MS = 60 * 1000
const FLUSH_MS = 60 * 1000
const GRACE_DAYS = 7
const MAX_QUEUE = 500

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch (error) {
    console.error('[account] 写入失败', file, error?.message || error)
  }
}

class AccountManager {
  constructor({ userDataDir, apiBase, version }) {
    this.dir = userDataDir
    this.apiBase = String(apiBase || '').replace(/\/+$/, '')
    this.version = String(version || '')
    this.osLabel = `${process.platform} ${os.release()}`.slice(0, 64)
    this.file = path.join(userDataDir, 'account.json')
    this.telemetryFile = path.join(userDataDir, 'telemetry.json')
    this.token = ''
    this.user = null
    this.savedAt = 0
    this.online = false
    this.unread = 0
    this.lastError = ''
    this.telemetry = readJson(this.telemetryFile, {})
    if (!this.telemetry.installId) this.telemetry.installId = crypto.randomUUID()
    if (!Array.isArray(this.telemetry.queue)) this.telemetry.queue = []
    this.telemetry.enabled = this.telemetry.enabled !== false
    this.timers = []
    this._load()
  }

  _load() {
    const data = readJson(this.file, null)
    if (!data) return
    try {
      if (data.token && data.tokenEncrypted && safeStorage.isEncryptionAvailable()) {
        this.token = safeStorage.decryptString(Buffer.from(data.token, 'base64'))
      } else if (data.token && !data.tokenEncrypted) {
        this.token = Buffer.from(data.token, 'base64').toString('utf8')
      }
      this.user = data.user || null
      this.savedAt = Number(data.savedAt) || 0
    } catch (error) {
      console.error('[account] 读取登录态失败', error?.message || error)
    }
  }

  _save() {
    const encrypted = this.token && safeStorage.isEncryptionAvailable()
    let token = ''
    if (this.token) {
      token = encrypted
        ? safeStorage.encryptString(this.token).toString('base64')
        : Buffer.from(this.token, 'utf8').toString('base64')
    }
    writeJson(this.file, {
      token,
      tokenEncrypted: Boolean(encrypted),
      user: this.user,
      savedAt: this.savedAt,
    })
  }

  _saveTelemetry() {
    if (this.telemetry.queue.length > MAX_QUEUE) {
      this.telemetry.queue = this.telemetry.queue.slice(-MAX_QUEUE)
    }
    writeJson(this.telemetryFile, this.telemetry)
  }

  async request(pathname, { method = 'GET', body, auth = true, timeout = REQUEST_TIMEOUT } = {}) {
    if (!this.apiBase) {
      const error = new Error('服务端地址未配置')
      error.network = true
      throw error
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const headers = { Accept: 'application/json' }
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      if (auth && this.token) headers.Authorization = `Bearer ${this.token}`
      const response = await fetch(`${this.apiBase}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        /* 非 JSON */
      }
      if (!response.ok || data?.ok === false) {
        const error = new Error(data?.error || `请求失败（${response.status}）`)
        error.status = response.status
        throw error
      }
      return data || { ok: true }
    } catch (error) {
      if (error.name === 'AbortError') {
        const timeoutError = new Error('连接服务器超时')
        timeoutError.network = true
        throw timeoutError
      }
      if (error.status) throw error
      error.network = true
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  getState() {
    const graceLeft = this.savedAt ? Math.max(0, GRACE_DAYS * 86400000 - (Date.now() - this.savedAt)) : 0
    return {
      apiBase: this.apiBase,
      configured: Boolean(this.apiBase) && !/invalid$/.test(this.apiBase),
      version: this.version,
      user: this.user,
      online: this.online,
      hasSession: Boolean(this.token),
      offlineMode: Boolean(this.token) && !this.online,
      graceDaysLeft: Math.ceil(graceLeft / 86400000),
      unread: this.unread,
      installId: this.telemetry.installId,
      telemetryEnabled: this.telemetry.enabled !== false,
      lastError: this.lastError,
    }
  }

  _applySession(token, user) {
    this.token = token
    this.user = user || null
    this.savedAt = Date.now()
    this.online = true
    this.lastError = ''
    this._save()
  }

  async login({ account, password }) {
    const data = await this.request('/api/auth/login', {
      method: 'POST',
      auth: false,
      body: { account, password, version: this.version, os: this.osLabel },
    })
    this._applySession(data.token, data.user)
    this._startTimers()
    return { ok: true, user: this.user }
  }

  async sendCode(purpose, email) {
    const route =
      purpose === 'register'
        ? '/api/auth/register/send-code'
        : purpose === 'reset'
          ? '/api/auth/password/send-code'
          : '/api/auth/login/send-code'
    await this.request(route, { method: 'POST', auth: false, body: { email } })
    return { ok: true }
  }

  async register({ email, code, username, password }) {
    const data = await this.request('/api/auth/register', {
      method: 'POST',
      auth: false,
      body: { email, code, username, password, version: this.version, os: this.osLabel },
    })
    this._applySession(data.token, data.user)
    this._startTimers()
    return { ok: true, user: this.user }
  }

  async loginWithCode({ email, code }) {
    const data = await this.request('/api/auth/login/code', {
      method: 'POST',
      auth: false,
      body: { email, code, version: this.version, os: this.osLabel },
    })
    this._applySession(data.token, data.user)
    this._startTimers()
    return { ok: true, user: this.user }
  }

  async resetPassword({ email, code, password }) {
    await this.request('/api/auth/password/reset', { method: 'POST', auth: false, body: { email, code, password } })
    return { ok: true }
  }

  async changePassword({ oldPassword, newPassword }) {
    await this.request('/api/auth/password/change', { method: 'POST', body: { oldPassword, newPassword } })
    return { ok: true }
  }

  logout() {
    this.token = ''
    this.user = null
    this.savedAt = 0
    this.online = false
    this.unread = 0
    this._save()
    return { ok: true }
  }

  // 启动时调用：校验本地登录态；网络异常时按 7 天宽限期放行
  async bootstrap() {
    if (!this.token) return { ok: false, reason: 'no-session' }
    try {
      const data = await this.request('/api/auth/me')
      this.user = data.user
      this.unread = data.unread || 0
      this.online = true
      this.savedAt = Date.now()
      this._save()
      this._startTimers()
      return { ok: true, offline: false, user: this.user }
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        this.logout()
        return { ok: false, reason: 'expired' }
      }
      const withinGrace = this.savedAt && Date.now() - this.savedAt < GRACE_DAYS * 86400000
      this.online = false
      this.lastError = error.message
      if (withinGrace) {
        this._startTimers()
        return { ok: true, offline: true, user: this.user, graceDaysLeft: this.getState().graceDaysLeft }
      }
      return { ok: false, reason: 'offline-expired' }
    }
  }

  async refresh() {
    if (!this.token) return { ok: false, reason: 'no-session' }
    try {
      const data = await this.request('/api/auth/me')
      this.user = data.user
      this.unread = data.unread || 0
      this.online = true
      this.lastError = ''
      this.savedAt = Date.now()
      this._save()
      return { ok: true, user: this.user, unread: this.unread }
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        this.logout()
        return { ok: false, reason: 'expired' }
      }
      this.online = false
      this.lastError = error.message
      return { ok: false, reason: 'network', error: error.message }
    }
  }

  async submitFeedback(payload = {}) {
    const data = await this.request('/api/feedback', {
      method: 'POST',
      body: {
        type: payload.type,
        rating: payload.rating,
        nps: payload.nps,
        content: payload.content,
        contact: payload.contact,
        version: this.version,
        os: this.osLabel,
      },
    })
    return data
  }

  async myFeedback() {
    return this.request('/api/feedback/mine')
  }

  async markFeedbackSeen(ids) {
    if (!Array.isArray(ids) || !ids.length) return { ok: true }
    const data = await this.request('/api/feedback/seen', { method: 'POST', body: { ids } })
    this.unread = 0
    return data
  }

  async unreadCount() {
    const data = await this.request('/api/feedback/unread')
    this.unread = data.count || 0
    return data
  }

  // ---------- 埋点 ----------
  track(event, payload = {}) {
    if (!event || this.telemetry.enabled === false) return
    const item = {
      event,
      platform: payload.platform || null,
      subPlatform: payload.subPlatform || null,
      lineKind: payload.lineKind || null,
      result: payload.result || null,
      errorCode: payload.errorCode ? String(payload.errorCode).slice(0, 80) : null,
      durationMs: Number.isFinite(Number(payload.durationMs)) ? Math.round(Number(payload.durationMs)) : null,
      title: payload.title ? String(payload.title).slice(0, 180) : null,
      host: this._hostOf(payload.url) || (payload.host ? String(payload.host).slice(0, 100) : null),
      ts: Date.now(),
    }
    this.telemetry.queue.push(item)
    this._saveTelemetry()
    if (this.telemetry.queue.length >= 20) this.flush().catch(() => {})
  }

  setTelemetryEnabled(enabled) {
    this.telemetry.enabled = Boolean(enabled)
    if (!this.telemetry.enabled) this.telemetry.queue = []
    this._saveTelemetry()
    return { ok: true, enabled: this.telemetry.enabled }
  }

  _hostOf(url) {
    try {
      return new URL(String(url)).hostname.toLowerCase().slice(0, 100)
    } catch {
      return ''
    }
  }

  _startTimers() {
    if (this.timers.length) return
    this.timers.push(
      setInterval(() => {
        this.flush().catch(() => {})
      }, FLUSH_MS),
      setInterval(() => {
        this.heartbeat().catch(() => {})
      }, HEARTBEAT_MS),
    )
    this.timers.forEach((timer) => timer.unref?.())
  }

  async flush() {
    const queue = this.telemetry.queue
    if (!queue.length) return { ok: true, sent: 0 }
    const batch = queue.slice(0, 100)
    await this.request('/api/telemetry/events', {
      method: 'POST',
      body: {
        installId: this.telemetry.installId,
        version: this.version,
        os: this.osLabel,
        events: batch,
      },
      timeout: 15000,
    })
    const sent = new Set(batch)
    this.telemetry.queue = this.telemetry.queue.filter((item) => !sent.has(item))
    this._saveTelemetry()
    return { ok: true, sent: batch.length }
  }

  async heartbeat() {
    if (!this.telemetry.installId) return { ok: false }
    await this.request('/api/telemetry/heartbeat', {
      method: 'POST',
      body: {
        installId: this.telemetry.installId,
        version: this.version,
        os: this.osLabel,
      },
      timeout: 10000,
    })
    return { ok: true }
  }

  dispose() {
    this.timers.forEach((timer) => clearInterval(timer))
    this.timers = []
  }
}

module.exports = { AccountManager }
