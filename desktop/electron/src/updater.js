'use strict'

/**
 * 自动更新：启动后静默检查一次，之后每 4 小时再查；发现新版本自动后台下载，
 * 下载完成提示「立即重启安装」。
 *
 * 更新包放在 GitHub Releases，国内直连 github.com 经常超时，所以这里按顺序
 * 尝试多个加速镜像，任意一个可用即可。所有源指向同一份 latest.yml。
 */

const { app, dialog } = require('electron')
const { autoUpdater } = require('electron-updater')

const REPO = 'fjz-hosts/changshipin-jiexi'
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const STARTUP_DELAY_MS = 6000

const UPDATE_FEEDS = [
  `https://gh.monlor.com/https://github.com/${REPO}/releases/latest/download/`,
  `https://gh-proxy.com/https://github.com/${REPO}/releases/latest/download/`,
  `https://ghfile.geekertao.top/https://github.com/${REPO}/releases/latest/download/`,
  `https://hk.gh-proxy.com/https://github.com/${REPO}/releases/latest/download/`,
  `https://github.com/${REPO}/releases/latest/download/`,
]

class UpdateManager {
  constructor(deps) {
    this.deps = deps
    this.timer = null
    this.manual = false
    this.switching = false
    this.feedIndex = 0
    this.started = false
    this.state = { status: 'idle', version: null, percent: 0, message: '等待检查更新', feed: UPDATE_FEEDS[0], at: null }
  }

  snapshot() {
    return { ...this.state, currentVersion: app.getVersion(), feeds: UPDATE_FEEDS.slice() }
  }

  setState(patch) {
    this.state = { ...this.state, ...patch, at: new Date().toISOString() }
    try {
      this.deps.onState(this.snapshot())
    } catch {
      /* 窗口可能已关闭 */
    }
  }

  init() {
    if (this.started) return
    this.started = true

    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.disableWebInstaller = true
    // 加速镜像对多段 Range 支持不好，单连接整包下载最稳
    autoUpdater.disableDifferentialDownload = true

    autoUpdater.logger = {
      info: (message) => this.deps.log(`[更新] ${message}`),
      warn: (message) => this.deps.log(`[更新警告] ${message}`),
      error: (message) => this.deps.log(`[更新错误] ${message}`),
      debug: () => {},
    }

    autoUpdater.on('checking-for-update', () => {
      this.setState({ status: 'checking', message: '正在检查更新…' })
    })

    autoUpdater.on('update-available', (info) => {
      const version = info?.version || ''
      this.setState({
        status: 'available',
        version,
        percent: 0,
        message: `发现新版本 v${version}，正在后台下载…`,
      })
      this.deps.log(`[更新] 发现新版本 v${version}`)
      this._progress(0)
    })

    autoUpdater.on('update-not-available', () => {
      this.setState({ status: 'none', message: '已经是最新版本' })
      this._progress(-1)
      if (this.manual) {
        this.manual = false
        this._dialog({
          type: 'info',
          title: '检查更新',
          message: `已经是最新版本 v${app.getVersion()}`,
          buttons: ['好'],
          noLink: true,
        })
      }
    })

    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.max(0, Math.min(100, Math.round(progress?.percent || 0)))
      const mb = ((progress?.transferred || 0) / 1048576).toFixed(1)
      this.setState({
        status: 'downloading',
        percent,
        message: `正在下载新版本… ${percent}%（${mb} MB）`,
      })
      this._progress(Math.max(0.01, percent / 100))
    })

    autoUpdater.on('update-downloaded', (info) => {
      this._progress(-1)
      this.setState({
        status: 'downloaded',
        version: info?.version || this.state.version,
        percent: 100,
        message: `新版本 v${info?.version || ''} 已下载，重启后生效`,
      })
      this._promptInstall(info)
    })

    autoUpdater.on('error', (error) => {
      const message = String(error?.message || error || '未知错误')
      this.deps.log(`[更新] 检查/下载失败：${message}`)
      this._progress(-1)
      if (this.switching) return
      this.setState({ status: 'error', message })
      if (this.manual) {
        this.manual = false
        this._dialog({
          type: 'error',
          title: '检查更新失败',
          message: '暂时连不上更新服务器',
          detail: `${message}\n\n不影响正常使用；之后可以在「设置 → 更新」里重试。`,
          buttons: ['好'],
          noLink: true,
        })
      }
    })

    setTimeout(() => this.check({ manual: false }), STARTUP_DELAY_MS)
    this.timer = setInterval(() => this.check({ manual: false }), CHECK_INTERVAL_MS)
  }

  async check({ manual = false } = {}) {
    if (!this.started) return this.snapshot()
    this.manual = manual
    if (!app.isPackaged) {
      this.manual = false
      if (manual) {
        this._dialog({
          type: 'info',
          title: '检查更新',
          message: '开发模式下不检查更新',
          detail: '打包安装后的程序会在启动时自动检查更新。',
          buttons: ['好'],
          noLink: true,
        })
      }
      return this.snapshot()
    }
    if (this.state.status === 'downloading') {
      this.manual = false
      if (manual) {
        this._dialog({
          type: 'info',
          title: '正在下载更新',
          message: `新版本 v${this.state.version || ''} 正在下载：${this.state.percent || 0}%`,
          detail: '下载完成后会提示重启安装，期间可以正常使用。',
          buttons: ['好'],
          noLink: true,
        })
      }
      return this.snapshot()
    }
    if (this.state.status === 'downloaded') {
      this.manual = false
      if (manual) this._promptInstall({ version: this.state.version })
      return this.snapshot()
    }
    try {
      this.setState({ status: 'checking', message: '正在检查更新…' })
      await this._checkWithFallback(0)
    } catch (error) {
      this.deps.log(`[更新] checkForUpdates 失败：${error?.message || error}`)
    }
    return this.snapshot()
  }

  async _checkWithFallback(index) {
    if (index >= UPDATE_FEEDS.length) throw new Error('所有更新源都不可用')
    const feed = UPDATE_FEEDS[index]
    this.feedIndex = index
    this.switching = index < UPDATE_FEEDS.length - 1
    this.setState({ feed })
    this.deps.log(`[更新] 使用更新源 ${index + 1}/${UPDATE_FEEDS.length}：${feed}`)
    try {
      autoUpdater.setFeedURL({ provider: 'generic', url: feed, useMultipleRangeRequest: false })
      await autoUpdater.checkForUpdates()
      this.switching = false
    } catch (error) {
      if (!this.switching) {
        this.switching = false
        throw error
      }
      this.deps.log(`[更新] 该源不可用，换下一个：${error?.message || error}`)
      return this._checkWithFallback(index + 1)
    }
  }

  install() {
    try {
      this.deps.beforeInstall?.()
    } catch {
      /* 清理失败也继续安装 */
    }
    setImmediate(() => autoUpdater.quitAndInstall(true, true))
  }

  dispose() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  _progress(value) {
    try {
      const window = this.deps.getWindow()
      if (window && !window.isDestroyed()) window.setProgressBar(value)
    } catch {
      /* 忽略 */
    }
  }

  _promptInstall(info) {
    const version = info?.version || this.state.version || ''
    const options = {
      type: 'info',
      title: '发现新版本',
      message: `长视频解析 v${version} 已下载完成`,
      detail: '重启程序即可完成更新。选择「稍后」会在下次退出程序时自动安装。',
      buttons: ['立即重启安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }
    const window = this.deps.getWindow()
    const show = window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)
    show
      .then((result) => {
        if (result.response === 0) this.install()
      })
      .catch(() => {})
  }

  _dialog(options) {
    const window = this.deps.getWindow()
    try {
      return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)
    } catch {
      return Promise.resolve()
    }
  }
}

module.exports = { UpdateManager, UPDATE_FEEDS }
