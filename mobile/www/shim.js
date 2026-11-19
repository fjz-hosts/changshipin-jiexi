/* 手机端 Electron 兼容层：把桌面端渲染层用到的 window.desktop / <webview> 映射到原生能力。 */
;(function () {
  'use strict'

  const N = window.CSPNative
  const { PLATFORMS, detectPlatformByUrl, platformByKey } = window.CSPPlatforms
  const L = window.CSPLines
  const S = window.CSPSeries
  const { Store } = window.CSPStore
  const { DownloadManager } = window.CSPDownload
  const { MobileUpdater } = window.CSPUpdater

  const store = new Store()
  const listeners = {
    downloadState: new Set(),
    updateState: new Set(),
    openBrowser: new Set(),
    externalParse: new Set(),
    pasteParse: new Set(),
    nextLine: new Set(),
    reload: new Set(),
    openExternal: new Set(),
    fullscreen: new Set(),
    fullscreenToggle: new Set(),
    ready: new Set(),
  }
  let lastStream = null
  let fullscreen = false
  let toastBridge = (message) => console.info('[长视频解析]', message)

  function emit(setName, payload) {
    for (const handler of listeners[setName]) {
      try {
        handler(payload)
      } catch (error) {
        console.warn(`[shim] ${setName} 回调失败`, error)
      }
    }
  }

  function on(setName, callback) {
    if (typeof callback !== 'function') return () => {}
    listeners[setName].add(callback)
    return () => listeners[setName].delete(callback)
  }

  function notify(message) {
    try {
      toastBridge(message)
    } catch {
      /* 忽略 */
    }
  }

  const downloader = new DownloadManager({
    onState: (state) => emit('downloadState', state),
    log: (message) => console.log(message),
  })

  const updater = new MobileUpdater({
    getAutoUpdate: () => store.get('autoUpdate') !== false,
    onState: (state) => emit('updateState', state),
  })

  function publicLine(line) {
    return { id: line.id, name: line.name, kind: line.kind, url: line.url, note: line.note || '' }
  }

  function platformInfo(key) {
    return platformByKey(key)
  }

  function activeParseWebview() {
    return document.querySelector('#parse-view')
  }

  function evalPlayer(script) {
    const webview = activeParseWebview()
    if (!webview || typeof webview.executeJavaScript !== 'function') return Promise.resolve(null)
    try {
      const visible = !document.querySelector('#view-webview')?.hidden
      if (!visible) return Promise.resolve(null)
      return webview.executeJavaScript(script).catch(() => null)
    } catch {
      return Promise.resolve(null)
    }
  }

  async function playerState() {
    const script = `(() => {
      const videos = Array.from(document.querySelectorAll('video')).filter((v) => v && (v.duration || 0) > 0)
      videos.sort((a, b) => (b.duration || 0) - (a.duration || 0))
      const v = videos[0]
      if (!v) return null
      return { t: Number(v.currentTime) || 0, d: Number(v.duration) || 0, paused: Boolean(v.paused), ended: Boolean(v.ended) }
    })()`
    const value = await evalPlayer(script)
    if (!value) return { video: null }
    if (typeof value === 'object') return { video: value }
    try {
      return { video: JSON.parse(value) }
    } catch {
      return { video: null }
    }
  }

  function playerCommand(payload = {}) {
    const action = String(payload.action || '')
    if (!action || action === 'ack-ended') return Promise.resolve(null)
    const script = `(() => {
      const videos = Array.from(document.querySelectorAll('video')).filter((v) => v && (v.duration || 0) > 0)
      videos.sort((a, b) => (b.duration || 0) - (a.duration || 0))
      const v = videos[0]
      if (!v) return false
      const action = ${JSON.stringify(action)}
      if (action === 'toggle') { if (v.paused) v.play().catch(() => {}); else v.pause() }
      else if (action === 'back') v.currentTime = Math.max(0, (v.currentTime || 0) - 10)
      else if (action === 'forward') { const d = Number(v.duration) || 0; const t = (v.currentTime || 0) + 10; v.currentTime = d > 0 ? Math.min(d - 0.5, t) : t }
      else if (action === 'volume-up') { v.muted = false; v.volume = Math.min(1, (v.volume || 0) + 0.1) }
      else if (action === 'volume-down') { v.muted = false; v.volume = Math.max(0, (v.volume || 1) - 0.1) }
      else if (action === 'mute') v.muted = !v.muted
      return true
    })()`
    return evalPlayer(script)
  }

  async function parseVideo({ url, lineId } = {}) {
    const target = L.normalizeUrlText(url)
    if (!L.isHttpUrl(target)) return { ok: false, error: '链接格式不正确，请粘贴完整的 http(s) 视频链接' }
    const lines = store.get('lines') || []
    const line = lines.find((item) => item.id === lineId) || lines.find((item) => item.enabled)
    if (!line) return { ok: false, error: '没有可用的解析线路，请先在「线路管理」里启用一条线路' }
    try {
      let cookieHeader = ''
      if (line.kind === 'mgtv') {
        try {
          cookieHeader = await N.getCookies('https://www.mgtv.com/')
        } catch {
          /* 没有登录也能试 */
        }
      }
      const result = await L.parseWithLine({ videoUrl: target, line, cookieHeader })
      const platform = detectPlatformByUrl(target)
      if (result.kind === 'page') {
        return {
          ok: true,
          kind: 'page',
          url: result.url,
          line: publicLine(line),
          platform: platform?.name || '未知',
        }
      }
      if (result.kind === 'stream') {
        const referer = result.referer || platform?.home || target
        const cookie = result.cookie || cookieHeader
        const playUrl = N.resourceUrl(result.streamUrl, referer, cookie)
        lastStream = {
          url: result.streamUrl,
          referer,
          cookie,
          title: result.title || '',
          platform: platform?.name || '',
          lineName: line.name,
          videoUrl: target,
        }
        return {
          ok: true,
          kind: 'stream',
          playUrl,
          original: result.streamUrl,
          title: result.title || '',
          line: publicLine(line),
          platform: platform?.name || '未知',
        }
      }
      return { ok: false, error: result.error || '线路没有返回可播放的地址' }
    } catch (error) {
      return { ok: false, error: String(error?.message || error).slice(0, 160) }
    }
  }

  async function testLines(payload = {}) {
    if (payload.draft && typeof payload.draft === 'object') {
      const draft = {
        id: 'draft',
        name: String(payload.draft.name || '临时线路'),
        kind: ['page', 'api', 'mgtv', 'direct', 'native'].includes(payload.draft.kind) ? payload.draft.kind : 'page',
        url: String(payload.draft.url || ''),
        platform: String(payload.draft.platform || ''),
        enabled: true,
      }
      return { draft: await L.testLine(draft, L.isHttpUrl(payload.url) ? L.normalizeUrlText(payload.url) : L.SAMPLE_URL) }
    }
    const sample = L.isHttpUrl(payload.url) ? L.normalizeUrlText(payload.url) : L.SAMPLE_URL
    const ids = Array.isArray(payload.ids) ? payload.ids : null
    const lines = (store.get('lines') || []).filter((line) => !ids || ids.includes(line.id))
    const results = {}
    const queue = lines.slice()
    const worker = async () => {
      while (queue.length) {
        const line = queue.shift()
        results[line.id] = await L.testLine(line, sample)
      }
    }
    await Promise.all([worker(), worker(), worker()])
    return results
  }

  const desktop = {
    info: async () => {
      const info = await N.getAppInfo()
      return {
        ...info,
        feeds: updater.snapshot().feeds,
        mobile: true,
      }
    },
    getConfig: () => store.snapshot(),
    saveLines: (lines, defaultLineId) => store.setLines(lines, defaultLineId),
    resetLines: () => store.setLines(L.DEFAULT_LINES, L.DEFAULT_LINES[0]?.id || ''),
    saveSettings: (patch) => store.saveSettings(patch),
    addHistory: (entry = {}) =>
      store.addHistory({
        ...entry,
        platform: detectPlatformByUrl(entry.url)?.key || entry.platform || '',
      }),
    updateHistory: (entry) => store.updateHistory(entry),
    removeHistory: (url) => store.removeHistory(url),
    clearHistory: () => store.clearHistory(),

    playerCommand,
    playerState,
    pageTitle: (url) => N.pageTitle(url),
    resolveSeries: ({ url, hint } = {}) => S.resolveSeries({ url, hint }),
    downloadCurrent: ({ title } = {}) => {
      if (!lastStream) return { ok: false, error: '当前不是内置播放器，无法下载（网页解析线路不支持下载）' }
      return downloader.start({
        url: lastStream.url,
        referer: lastStream.referer,
        cookie: lastStream.cookie,
        title: String(title || lastStream.title || '').trim() || lastStream.platform || '视频',
        platform: lastStream.platform,
        lineName: lastStream.lineName,
      })
    },
    cancelDownload: (id) => downloader.cancel(String(id || '')),
    openDownloadFolder: async () => {
      const ok = await N.openDownloadsFolder()
      if (!ok) notify('下载文件在「文件」App → 我的 iPhone → 长视频解析 里；也可以在下载完成提示里点“分享”导出。')
      return ok
    },
    revealDownload: async () => {
      if (!downloader.lastSavedPath) return false
      const uri = await N.fs.uri(downloader.lastSavedPath, 'CACHE').catch(() => '')
      return uri ? N.openDownload(uri) : false
    },
    onDownloadState: (callback) => on('downloadState', callback),

    readClipboard: () => N.readText(),
    copyText: (text) => N.copyText(text),
    parse: (payload) => parseVideo(payload),
    testLines,
    updateLinesOnline: async () => {
      const result = await L.fetchOnlineLines()
      if (!result.ok) return { ok: false, error: '所有线路源都取不到清单', detail: result.errors }
      const applied = store.applyRemoteLines(result.lines)
      return {
        ok: true,
        applied: applied.applied,
        feed: result.feed,
        updatedAt: result.updatedAt,
        config: store.snapshot(),
      }
    },

    openPlatform: (key) => {
      emit('openBrowser', { key: String(key) })
      return true
    },
    searchPlatform: (key, query) => {
      emit('openBrowser', { key: String(key), query: String(query || '') })
      return true
    },
    openPlatformSite: (key) => {
      const platform = platformInfo(String(key))
      if (!platform) return false
      N.openExternal(platform.home)
      return true
    },
    openExternal: (url) => N.openExternal(url),
    openUserData: () => {
      notify('手机端配置和历史保存在应用私有目录，自动随应用保存，无需手动管理。')
      return true
    },
    openLogs: () => {
      notify('手机端没有单独的日志目录；遇到问题可以在「关于」里查看版本信息。')
      return true
    },
    createShortcut: () => ({ ok: false, error: '手机端无需创建桌面快捷方式' }),
    about: () => {
      notify(`长视频解析 手机版 v${window.CSP_VERSION} · ${N.platform === 'ios' ? 'iOS' : 'Android'}`)
      return true
    },
    focusMain: () => true,
    setFullscreen: async (flag) => {
      fullscreen = Boolean(flag)
      await N.setFullscreen(fullscreen)
      return fullscreen
    },
    getFullscreenState: () => fullscreen,
    toggleFullscreen: async () => {
      fullscreen = !fullscreen
      await N.setFullscreen(fullscreen)
      return fullscreen
    },
    quit: () => N.exitApp(),

    getUpdateState: () => updater.snapshot(),
    checkUpdate: () => updater.check({ manual: true }),
    installUpdate: () => updater.install(),
    onUpdateState: (callback) => on('updateState', callback),

    onReady: (callback) => on('ready', callback),
    onPasteParse: (callback) => on('pasteParse', callback),
    onNextLine: (callback) => on('nextLine', callback),
    onReload: (callback) => on('reload', callback),
    onOpenExternal: (callback) => on('openExternal', callback),
    onExternalParse: (callback) => on('externalParse', callback),
    onOpenBrowser: (callback) => on('openBrowser', callback),
    onCloseBrowser: () => () => {},
    onCloseBrowserTab: () => () => {},
    onFullscreen: (callback) => on('fullscreen', callback),
    onFullscreenToggle: (callback) => on('fullscreenToggle', callback),
  }

  window.desktop = desktop
  window.__cspNotify = notify
  window.__cspShim = {
    store,
    updater,
    downloader,
    parseVideo,
    getLastStream: () => lastStream,
    notify,
    emit,
    setToastBridge: (fn) => {
      if (typeof fn === 'function') toastBridge = fn
    },
    getFullscreen: () => fullscreen,
  }

  // -------------------------------------------------------------------------
  // <webview> 兼容元素：映射到原生 WebView 覆盖层
  // -------------------------------------------------------------------------
  let webviewSeq = 0
  const webviewRegistry = new Set()

  class MobileWebview extends HTMLElement {
    constructor() {
      super()
      this.__nativeId = `wv-${Date.now()}-${++webviewSeq}`
      this.__created = false
      this.__destroyed = false
      this.__lastFrame = ''
      this.__state = { url: '', title: '', canGoBack: false, canGoForward: false, loading: false }
      this.__unsubscribe = null
    }

    static get observedAttributes() {
      return ['src']
    }

    connectedCallback() {
      webviewRegistry.add(this)
      if (!this.__unsubscribe) {
        this.__unsubscribe = N.onWebviewEvent((payload) => this.__onNativeEvent(payload))
      }
      this.__ensureCreated()
    }

    disconnectedCallback() {
      // 不立刻销毁：Electron 的 <webview> 在切换显示时也可能被移动。
      // 真正的销毁由 remove() / 页面卸载负责。
    }

    attributeChangedCallback(name, _old, value) {
      if (name !== 'src') return
      const url = String(value || '')
      if (!url) return
      this.__state.url = url
      if (!this.isConnected) return
      this.__ensureCreated()
      if (this.__created) {
        N.webviews.mute(this.__nativeId, false)
        N.webviews.load(this.__nativeId, url)
      }
    }

    get src() {
      return this.getAttribute('src') || ''
    }

    set src(value) {
      const url = String(value || '')
      if (!url) return
      this.setAttribute('src', url)
    }

    __ensureCreated() {
      if (this.__created || this.__destroyed) return
      this.__created = true
      N.webviews.create({
        id: this.__nativeId,
        src: this.__state.url || this.getAttribute('src') || '',
        partition: this.getAttribute('partition') || 'persist:platform',
      })
      setTimeout(async () => {
        const result = await N.webviews.state(this.__nativeId)
        if (result) this.__applyState(result)
      }, 500)
    }

    __applyState(result) {
      if (!result) return
      if (result.url) this.__state.url = String(result.url)
      if (result.title) this.__state.title = String(result.title)
      this.__state.canGoBack = Boolean(result.canGoBack)
      this.__state.canGoForward = Boolean(result.canGoForward)
      this.__state.loading = Boolean(result.loading)
    }

    __onNativeEvent(payload) {
      if (!payload || payload.id !== this.__nativeId) return
      const type = String(payload.type || '')
      if (payload.url) this.__state.url = String(payload.url)
      if (payload.title) this.__state.title = String(payload.title)
      if (typeof payload.canGoBack === 'boolean') this.__state.canGoBack = payload.canGoBack
      if (typeof payload.canGoForward === 'boolean') this.__state.canGoForward = payload.canGoForward
      if (typeof payload.loading === 'boolean') this.__state.loading = payload.loading
      const event = new Event(type)
      Object.assign(event, {
        url: payload.url,
        title: payload.title,
        isMainFrame: payload.isMainFrame !== false,
        errorCode: payload.errorCode || 0,
        errorDescription: payload.errorDescription || '',
        canGoBack: this.__state.canGoBack,
        canGoForward: this.__state.canGoForward,
      })
      this.dispatchEvent(event)
    }

    getURL() {
      return this.__state.url || this.src || ''
    }

    getTitle() {
      return this.__state.title || ''
    }

    canGoBack() {
      return Boolean(this.__state.canGoBack)
    }

    canGoForward() {
      return Boolean(this.__state.canGoForward)
    }

    loadURL(url) {
      this.src = url
      return Promise.resolve()
    }

    reload() {
      if (this.__created) N.webviews.reload(this.__nativeId)
    }

    stop() {
      // 网页解析线路切走时先把页面里的声音停掉，避免后台继续播。
      if (this.__created) {
        N.webviews.mute(this.__nativeId, true)
        N.webviews.stop(this.__nativeId)
      }
    }

    goBack() {
      if (this.__created) N.webviews.back(this.__nativeId)
    }

    goForward() {
      if (this.__created) N.webviews.forward(this.__nativeId)
    }

    executeJavaScript(script) {
      if (!this.__created) return Promise.resolve(null)
      return N.webviews.eval(this.__nativeId, String(script || '')).then((result) => {
        if (result && typeof result === 'object' && 'value' in result) return result.value
        return result
      })
    }

    setAudioMuted(muted) {
      if (this.__created) N.webviews.mute(this.__nativeId, Boolean(muted))
    }

    remove() {
      this.__destroyed = true
      webviewRegistry.delete(this)
      if (this.__unsubscribe) {
        try {
          this.__unsubscribe()
        } catch {
          /* 忽略 */
        }
        this.__unsubscribe = null
      }
      if (this.__created) N.webviews.destroy(this.__nativeId)
      this.__created = false
      super.remove()
    }
  }

  if (!customElements.get('webview')) {
    try {
      customElements.define('webview', MobileWebview)
    } catch (error) {
      console.warn('[shim] <webview> 注册失败', error)
    }
  }

  // -------------------------------------------------------------------------
  // 原生覆盖层位置同步
  // -------------------------------------------------------------------------
  function anyModalOpen() {
    for (const selector of ['#modal', '#search-modal', '#guide-modal']) {
      const node = document.querySelector(selector)
      if (node && !node.hidden) return true
    }
    return false
  }

  function frameOf(element) {
    if (!element.isConnected || element.__destroyed) return null
    if (document.visibilityState !== 'visible') return null
    if (anyModalOpen()) return null
    if (document.body.classList.contains('csp-app-hidden')) return null
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return null
    const rect = element.getBoundingClientRect()
    if (rect.width < 8 || rect.height < 8) return null
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) return null
    return {
      x: Math.max(0, rect.left),
      y: Math.max(0, rect.top),
      width: Math.min(rect.width, window.innerWidth - Math.max(0, rect.left)),
      height: Math.min(rect.height, window.innerHeight - Math.max(0, rect.top)),
      visible: true,
    }
  }

  let frameBusy = false
  async function syncFrames() {
    if (frameBusy) return
    frameBusy = true
    try {
      for (const element of webviewRegistry) {
        if (!element.__created) continue
        const frame = frameOf(element)
        const signature = frame ? `${Math.round(frame.x)},${Math.round(frame.y)},${Math.round(frame.width)},${Math.round(frame.height)},1` : '0'
        if (signature === element.__lastFrame) continue
        element.__lastFrame = signature
        if (frame) {
          await N.webviews.frame({ id: element.__nativeId, ...frame })
        } else {
          await N.webviews.frame({ id: element.__nativeId, x: 0, y: 0, width: 1, height: 1, visible: false })
        }
      }
    } finally {
      frameBusy = false
    }
  }

  setInterval(syncFrames, 120)
  window.addEventListener('resize', syncFrames)
  window.addEventListener('orientationchange', () => setTimeout(syncFrames, 300))
  document.addEventListener('visibilitychange', syncFrames)

  // 保持可见 WebView 的 URL / 前进后退状态新鲜（SPA 和重定向兜底）
  setInterval(async () => {
    for (const element of webviewRegistry) {
      if (!element.__created || !element.__lastFrame || element.__lastFrame === '0') continue
      const state = await N.webviews.state(element.__nativeId)
      if (!state) continue
      const previousUrl = element.__state.url
      element.__applyState(state)
      if (state.url && state.url !== previousUrl) {
        const event = new Event('did-navigate-in-page')
        Object.assign(event, { url: state.url, isMainFrame: true })
        element.dispatchEvent(event)
      }
    }
  }, 2500)

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      N.hideSplash()
      emit('ready', { version: window.CSP_VERSION })
    }, 120)
    if (store.get('autoUpdate') !== false) {
      setTimeout(() => updater.check({ manual: false }).catch(() => {}), 8000)
    }
  })

  // 安卓返回键：先退全屏 / 关弹窗，再走浏览器后退，最后才退出应用
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    // 旧的 Capacitor.Plugins 直接访问方式不可靠，这里通过 registerPlugin 已注册的 App 插件处理
  }
  try {
    const AppPlugin = window.Capacitor?.registerPlugin?.('App')
    if (AppPlugin) {
      AppPlugin.addListener('backButton', () => {
        const guide = document.querySelector('#guide-modal')
        const modal = document.querySelector('#modal')
        const search = document.querySelector('#search-modal')
        if (guide && !guide.hidden) {
          guide.hidden = true
          return
        }
        if (search && !search.hidden) {
          search.hidden = true
          return
        }
        if (modal && !modal.hidden) {
          modal.hidden = true
          return
        }
        if (fullscreen) {
          document.querySelector('#btn-fullscreen')?.click()
          return
        }
        const browser = document.querySelector('#browser-panel')
        if (browser && !browser.hidden) {
          const record = window.__app?.getState?.().browsers?.get(window.__app?.getState?.().browserKey)
          if (record && record.webview.canGoBack()) {
            record.webview.goBack()
            return
          }
          document.querySelector('#browser-close')?.click()
          return
        }
        N.exitApp()
      })
    }
  } catch {
    /* 忽略 */
  }

  // 供 mobile.js / 调试使用
  window.__cspDesktop = desktop
})()
