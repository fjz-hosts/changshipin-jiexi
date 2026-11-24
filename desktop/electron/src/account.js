'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { safeStorage, nativeImage, dialog } = require('electron')

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
    this.avatarFile = path.join(userDataDir, 'avatar.png')
    this.avatarMetaFile = path.join(userDataDir, 'avatar.json')
    this.avatarMeta = readJson(this.avatarMetaFile, { email: '', source: '' })
    this.avatarCache = { mtime: 0, dataUrl: '' }
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

  // ---------- 头像 ----------
  // 规则：QQ 邮箱（纯数字@qq.com）用 QQ 头像；失败或非 QQ 邮箱由界面显示内置默认头像；
  // 用户自己上传过的头像优先于这两者（头像文件 + avatar.json 里的邮箱 / 来源）。
  _avatarEmail() {
    return String(this.user?.email || '').trim().toLowerCase()
  }

  _saveAvatarMeta(meta) {
    this.avatarMeta = { email: this._avatarEmail(), source: 'default', ...meta }
    writeJson(this.avatarMetaFile, this.avatarMeta)
  }

  _dropAvatar() {
    try {
      fs.rmSync(this.avatarFile, { force: true })
    } catch {
      /* 忽略 */
    }
    this.avatarCache = { mtime: 0, dataUrl: '' }
  }

  avatarDataUrl() {
    try {
      const stat = fs.statSync(this.avatarFile)
      if (!stat.size) return ''
      if (this.avatarCache.mtime === stat.mtimeMs && this.avatarCache.dataUrl) return this.avatarCache.dataUrl
      const dataUrl = `data:image/png;base64,${fs.readFileSync(this.avatarFile).toString('base64')}`
      this.avatarCache = { mtime: stat.mtimeMs, dataUrl }
      return dataUrl
    } catch {
      return ''
    }
  }

  _squarePng(source) {
    let image = Buffer.isBuffer(source) ? nativeImage.createFromBuffer(source) : nativeImage.createFromPath(String(source))
    if (!image || image.isEmpty()) throw new Error('图片格式不支持或文件已损坏')
    const { width, height } = image.getSize()
    if (!width || !height) throw new Error('读不出图片尺寸')
    const side = Math.min(width, height)
    if (side > 256) {
      image = image.resize({ width: 256, height: 256, quality: 'best' })
    } else if (width !== height) {
      image = image.crop({
        x: Math.floor((width - side) / 2),
        y: Math.floor((height - side) / 2),
        width: side,
        height: side,
      })
    }
    return image.toPNG()
  }

  _writeAvatar(png) {
    fs.mkdirSync(path.dirname(this.avatarFile), { recursive: true })
    const tmp = `${this.avatarFile}.tmp`
    fs.writeFileSync(tmp, png)
    fs.renameSync(tmp, this.avatarFile)
    this.avatarCache = { mtime: 0, dataUrl: '' }
  }

  // 拉 QQ 头像：q1.qlogo.cn 对不存在的号码也会返回一张默认头像，所以只要有图就接受。
  async _fetchQqAvatar() {
    const email = this._avatarEmail()
    const matched = /^(\d{5,12})@qq\.com$/.exec(email)
    if (!matched) return false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch(`https://q1.qlogo.cn/g?b=qq&nk=${matched[1]}&s=100`, {
        signal: controller.signal,
        headers: { Accept: 'image/*' },
      })
      if (!response.ok) return false
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length < 256) return false
      this._writeAvatar(this._squarePng(buffer))
      return true
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  // 登录 / 校验登录态后调用：同一邮箱非 QQ 头像每 6 小时最多尝试一次，避免每次刷新都去拉网络。
  async ensureAvatar({ force = false } = {}) {
    const email = this._avatarEmail()
    if (!email) return { ok: false }
    if (this.avatarMeta.email !== email) this._dropAvatar()
    const source = this.avatarMeta.source || ''
    const triedAt = Number(this.avatarMeta.triedAt) || 0
    const hasFile = fs.existsSync(this.avatarFile)
    if (!force && this.avatarMeta.email === email && hasFile) {
      if (source === 'custom' || source === 'qq') return { ok: true, source }
      if (source === 'default' && Date.now() - triedAt < 6 * 3600 * 1000) return { ok: true, source }
    }
    if (await this._fetchQqAvatar()) {
      this._saveAvatarMeta({ email, source: 'qq', triedAt: Date.now() })
      return { ok: true, source: 'qq' }
    }
    this._saveAvatarMeta({ email, source: 'default', triedAt: Date.now() })
    return { ok: true, source: 'default' }
  }

  async pickAvatar() {
    const result = await dialog.showOpenDialog({
      title: '选择头像图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
    })
    const file = !result.canceled && result.filePaths?.[0]
    if (!file) return { ok: true, canceled: true }
    const stat = fs.statSync(file)
    if (stat.size > 12 * 1024 * 1024) return { ok: false, error: '图片太大（超过 12MB），换一张小一点的' }
    try {
      this._writeAvatar(this._squarePng(file))
      this._saveAvatarMeta({ source: 'custom' })
      return { ok: true, state: this.getState() }
    } catch (error) {
      return { ok: false, error: String(error?.message || error).slice(0, 120) }
    }
  }

  async resetAvatar() {
    this._dropAvatar()
    this._saveAvatarMeta({ email: '', source: 'default' })
    await this.ensureAvatar({ force: true })
    return { ok: true, state: this.getState() }
  }

  async avatarState() {
    await this.ensureAvatar().catch(() => {})
    return { ok: true, avatar: this.avatarDataUrl(), avatarSource: this.avatarMeta.source || '' }
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
      avatar: this.avatarDataUrl(),
      avatarSource: this.avatarMeta.email === this._avatarEmail() ? this.avatarMeta.source || '' : '',
    }
  }

  _applySession(token, user) {
    this.token = token
    this.user = user || null
    this.savedAt = Date.now()
    this.online = true
    this.lastError = ''
    this._save()
    this.ensureAvatar().catch(() => {})
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
      this.ensureAvatar().catch(() => {})
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
      this.ensureAvatar().catch(() => {})
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
