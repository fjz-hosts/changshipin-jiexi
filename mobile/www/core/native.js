/* 手机端原生能力桥：本地取流代理、内嵌 WebView、文件、安装、系统栏。 */
;(function () {
  'use strict'

  const Cap = window.Capacitor || null
  const isNative = Boolean(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform())
  const platform = (Cap && typeof Cap.getPlatform === 'function' && Cap.getPlatform()) || 'web'

  function plugin(name) {
    try {
      if (Cap && typeof Cap.registerPlugin === 'function') return Cap.registerPlugin(name)
    } catch (error) {
      console.warn('[native] 插件不可用', name, error)
    }
    return null
  }

  const Native = plugin('ChangshipinNative')
  const Filesystem = plugin('Filesystem')
  const Share = plugin('Share')
  const Browser = plugin('Browser')
  const Clipboard = plugin('Clipboard')
  const App = plugin('App')
  const StatusBar = plugin('StatusBar')
  const ScreenOrientation = plugin('ScreenOrientation')
  const SplashScreen = plugin('SplashScreen')

  const state = {
    port: 0,
    token: '',
    ready: null,
    proxyStarted: false,
  }

  function b64url(text) {
    const bytes = new TextEncoder().encode(String(text == null ? '' : text))
    let binary = ''
    const chunk = 0x8000
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk))
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  function b64urlDecode(value) {
    try {
      const text = String(value || '').replace(/-/g, '+').replace(/_/g, '/')
      const padded = text + '='.repeat((4 - (text.length % 4)) % 4)
      const binary = atob(padded)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return new TextDecoder().decode(bytes)
    } catch {
      return ''
    }
  }

  function base64FromBytes(bytes) {
    let binary = ''
    const chunk = 0x8000
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk))
    }
    return btoa(binary)
  }

  function bytesFromBase64(value) {
    const binary = atob(String(value || ''))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  }

  async function startProxy() {
    if (!Native) {
      const devBase = String(window.__CSP_PROXY_BASE__ || '').replace(/\/$/, '')
      if (devBase) {
        const parsed = new URL(devBase)
        state.port = Number(parsed.port) || 0
        state.token = parsed.searchParams.get('t') || ''
        state.proxyStarted = true
      }
      return
    }
    try {
      const result = await Native.startProxy()
      state.port = Number(result?.port) || 0
      state.token = String(result?.token || '')
      state.proxyStarted = Boolean(state.port && state.token)
    } catch (error) {
      console.warn('[native] 取流代理启动失败', error)
    }
  }

  state.ready = startProxy()

  function proxyBase() {
    const devBase = String(window.__CSP_PROXY_BASE__ || '').replace(/\/$/, '')
    if (devBase) return devBase
    if (!state.port) return ''
    return `http://127.0.0.1:${state.port}`
  }

  function resourceUrl(target, referer = '', cookie = '') {
    const base = proxyBase()
    if (!base) return target
    const search = new URLSearchParams()
    search.set('t', state.token)
    search.set('u', b64url(target))
    if (referer) search.set('r', b64url(referer))
    if (cookie) search.set('c', b64url(cookie))
    return `${base}/stream?${search.toString()}`
  }

  async function fetchBinary(target, options = {}) {
    await waitReady()
    // 下载 / 分片 / 密钥都走 /stream：本地服务直接流式转发，避免把大文件整个读进内存。
    // （/fetch 用于文本 / JSON，会做状态码和 Set-Cookie 处理。）
    const base = proxyBase()
    const url = base ? resourceUrl(target, options.referer || '', options.cookie || '') : target
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(options.timeout) || 120000))
    try {
      return await fetch(url, {
        method: 'GET',
        headers: Object.assign({}, options.headers || {}),
        redirect: 'follow',
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  function fetchUrl(target, options = {}) {
    const base = proxyBase()
    if (!base) return target
    const search = new URLSearchParams()
    search.set('t', state.token)
    search.set('u', b64url(target))
    if (options.referer) search.set('r', b64url(options.referer))
    if (options.cookie) search.set('c', b64url(options.cookie))
    if (options.method) search.set('m', String(options.method).toUpperCase())
    if (options.setCookie) search.set('sc', '1')
    if (options.binary) search.set('bin', '1')
    return `${base}/fetch?${search.toString()}`
  }

  async function waitReady() {
    try {
      await state.ready
    } catch {
      /* 忽略 */
    }
  }

  async function rawFetch(target, options = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(2000, Number(options.timeout) || 20000))
    const headers = Object.assign({}, options.headers || {})
    try {
      const viaProxy = Boolean(proxyBase())
      const url = viaProxy ? fetchUrl(target, options) : target
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body == null ? undefined : options.body,
        redirect: 'follow',
        signal: controller.signal,
      })
      return response
    } finally {
      clearTimeout(timer)
    }
  }

  async function fetchText(target, options = {}) {
    await waitReady()
    const headers = Object.assign({}, options.headers || {})
    try {
      const response = await rawFetch(target, { ...options, headers })
      const text = await response.text()
      let status = response.status
      if (proxyBase()) {
        const statusHeader = response.headers.get('x-proxy-status')
        if (statusHeader) status = Number(statusHeader) || status
      }
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        /* 非 JSON */
      }
      const setCookies = []
      const setCookieHeader = response.headers.get('x-proxy-set-cookie')
      if (setCookieHeader) {
        try {
          const list = JSON.parse(b64urlDecode(setCookieHeader))
          if (Array.isArray(list)) setCookies.push(...list)
        } catch {
          /* 忽略 */
        }
      }
      return {
        ok: status >= 200 && status < 400,
        status,
        text,
        json,
        setCookies,
        url: response.url || target,
      }
    } catch (error) {
      return {
        ok: false,
        status: 0,
        text: '',
        json: null,
        setCookies: [],
        error: String(error?.message || error),
        url: target,
      }
    }
  }

  async function fetchJson(target, options = {}) {
    return fetchText(target, options)
  }

  async function fetchBytes(target, options = {}) {
    const response = await fetchBinary(target, options)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  }

  function decodeHtml(bytes) {
    const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 4096)))
    const match = head.match(/charset\s*=\s*["']?\s*([\w-]+)/i)
    const charset = (match?.[1] || 'utf-8').toLowerCase()
    try {
      return new TextDecoder(charset).decode(bytes)
    } catch {
      return new TextDecoder('utf-8').decode(bytes)
    }
  }

  async function pageTitle(url) {
    try {
      const bytes = await fetchBytes(url, { referer: url, timeout: 12000 })
      const html = decodeHtml(bytes)
      const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
      if (!match) return ''
      return match[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim()
    } catch {
      return ''
    }
  }

  async function pageEval(url, script, timeoutMs = 18000) {
    if (!Native) return ''
    try {
      const result = await Native.pageEval({ url, script, timeoutMs })
      return result?.value == null ? '' : result.value
    } catch {
      return ''
    }
  }

  async function getCookies(url) {
    if (!Native) return ''
    try {
      const result = await Native.getCookies({ url })
      return String(result?.cookie || '')
    } catch {
      return ''
    }
  }

  // -------------------------------------------------------------------------
  // WebView 管理
  // -------------------------------------------------------------------------
  const webviewHandlers = new Set()
  let webviewListenerStarted = false

  function ensureWebviewListener() {
    if (!Native || webviewListenerStarted) return
    webviewListenerStarted = true
    try {
      Native.addListener('webviewEvent', (payload) => {
        for (const handler of webviewHandlers) {
          try {
            handler(payload)
          } catch (error) {
            console.warn('[native] webview 事件处理失败', error)
          }
        }
      })
    } catch (error) {
      console.warn('[native] webview 事件订阅失败', error)
    }
  }

  function onWebviewEvent(handler) {
    ensureWebviewListener()
    webviewHandlers.add(handler)
    return () => webviewHandlers.delete(handler)
  }

  function callWebview(method, payload) {
    if (!Native) return Promise.resolve(null)
    ensureWebviewListener()
    return Native[method](payload).catch((error) => {
      console.warn(`[native] ${method} 失败`, error)
      return null
    })
  }

  const webviews = {
    create: (payload) => callWebview('createWebview', payload),
    destroy: (id) => callWebview('destroyWebview', { id }),
    frame: (payload) => callWebview('setWebviewFrame', payload),
    load: (id, url) => callWebview('loadWebview', { id, url }),
    reload: (id) => callWebview('reloadWebview', { id }),
    stop: (id) => callWebview('stopWebview', { id }),
    back: (id) => callWebview('webviewBack', { id }),
    forward: (id) => callWebview('webviewForward', { id }),
    eval: (id, script) => callWebview('webviewEval', { id, script }),
    mute: (id, muted) => callWebview('setWebviewMuted', { id, muted: Boolean(muted) }),
    state: (id) => callWebview('webviewState', { id }),
  }

  // -------------------------------------------------------------------------
  // 隐藏页嗅探（原生取流线路）
  // -------------------------------------------------------------------------
  const snifferHandlers = new Map()
  let snifferListenerStarted = false

  function ensureSnifferListener() {
    if (!Native || snifferListenerStarted) return
    snifferListenerStarted = true
    try {
      Native.addListener('snifferMedia', (payload) => {
        const handler = snifferHandlers.get(payload?.id)
        if (handler) {
          try {
            handler(payload)
          } catch {
            /* 忽略 */
          }
        }
      })
    } catch {
      /* 忽略 */
    }
  }

  async function sniff({ url, platform: key, timeout = 18000 } = {}) {
    await waitReady()
    if (!Native) return { candidates: [], title: '' }
    ensureSnifferListener()
    const id = `sniff-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const candidates = []
    let title = ''
    return new Promise((resolve) => {
      let settled = false
      const finish = async () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        snifferHandlers.delete(id)
        try {
          title = String((await Native.snifferState({ id }))?.title || title || '')
        } catch {
          /* 忽略 */
        }
        try {
          await Native.destroySniffer({ id })
        } catch {
          /* 忽略 */
        }
        resolve({ candidates: [...new Set(candidates)], title })
      }
      const timer = setTimeout(finish, Math.max(4000, Number(timeout) || 18000))
      snifferHandlers.set(id, (payload) => {
        if (payload?.url && !candidates.includes(payload.url)) candidates.push(String(payload.url))
        if (candidates.length) setTimeout(finish, 3200)
      })
      Native.createSniffer({ id, url, platform: key || 'iqiyi' }).catch(() => {
        finish()
      })
    })
  }

  // -------------------------------------------------------------------------
  // 文件 / 下载发布
  // -------------------------------------------------------------------------
  const fs = {
    async write(path, dataBase64, directory = 'CACHE') {
      return Filesystem.writeFile({ path, data: dataBase64, directory, recursive: true })
    },
    async append(path, dataBase64, directory = 'CACHE') {
      return Filesystem.appendFile({ path, data: dataBase64, directory })
    },
    async readBase64(path, directory = 'CACHE') {
      const result = await Filesystem.readFile({ path, directory })
      return String(result?.data || '')
    },
    async delete(path, directory = 'CACHE') {
      try {
        await Filesystem.deleteFile({ path, directory })
      } catch {
        /* 文件不存在 */
      }
    },
    async mkdir(path, directory = 'CACHE') {
      try {
        await Filesystem.mkdir({ path, directory, recursive: true })
      } catch {
        /* 已存在 */
      }
    },
    async uri(path, directory = 'CACHE') {
      const result = await Filesystem.getUri({ path, directory })
      return String(result?.uri || '')
    },
    async list(path, directory = 'CACHE') {
      try {
        const result = await Filesystem.readdir({ path, directory })
        return Array.isArray(result?.files) ? result.files : []
      } catch {
        return []
      }
    },
  }

  async function publishDownload({ path, name, mime = 'video/mp2t', directory = 'CACHE' }) {
    if (!Native) {
      // 浏览器调试：让 <a download> 接手
      return { ok: false, error: '当前环境不支持保存文件' }
    }
    const localUri = await fs.uri(path, directory)
    if (!localUri) throw new Error('下载文件不存在')
    const result = await Native.publishDownload({
      path: localUri,
      name,
      mime,
    })
    return result || { ok: false }
  }

  async function openDownload(uri) {
    if (!Native || !uri) return false
    try {
      await Native.openDownload({ uri })
      return true
    } catch {
      return false
    }
  }

  async function shareDownload(uri, name) {
    if (!Native || !uri) return false
    try {
      await Native.shareDownload({ uri, name })
      return true
    } catch {
      return false
    }
  }

  async function openDownloadsFolder() {
    if (!Native) return false
    try {
      await Native.openDownloadsFolder()
      return true
    } catch {
      return false
    }
  }

  async function installApk(path) {
    if (!Native) return { ok: false, error: '当前环境不支持安装' }
    try {
      return await Native.installApk({ path })
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  // -------------------------------------------------------------------------
  // 系统
  // -------------------------------------------------------------------------
  async function copyText(text) {
    try {
      if (Clipboard) {
        await Clipboard.write({ string: String(text || '') })
        return true
      }
    } catch {
      /* 回退 */
    }
    try {
      await navigator.clipboard.writeText(String(text || ''))
      return true
    } catch {
      return false
    }
  }

  async function readText() {
    try {
      if (Clipboard) {
        const result = await Clipboard.read()
        return String(result?.value || '')
      }
    } catch {
      /* 回退 */
    }
    try {
      return await navigator.clipboard.readText()
    } catch {
      return ''
    }
  }

  async function openExternal(url) {
    const target = String(url || '')
    if (!/^https?:\/\//i.test(target)) return false
    try {
      if (Browser) {
        await Browser.open({ url: target })
        return true
      }
    } catch {
      /* 回退 */
    }
    window.open(target, '_blank', 'noopener')
    return true
  }

  async function shareText({ title = '', text = '', url = '' } = {}) {
    try {
      if (Share) {
        await Share.share({ title, text, url: url || undefined, dialogTitle: title || '分享' })
        return true
      }
    } catch {
      /* 忽略 */
    }
    return false
  }

  async function setFullscreen(on) {
    const flag = Boolean(on)
    try {
      if (flag) {
        if (StatusBar) await StatusBar.hide()
        if (ScreenOrientation) {
          try {
            await ScreenOrientation.lock({ orientation: 'landscape' })
          } catch {
            /* 平板 / 分屏可能不支持 */
          }
        }
      } else {
        if (ScreenOrientation) {
          try {
            await ScreenOrientation.unlock()
          } catch {
            /* 忽略 */
          }
        }
        if (StatusBar) await StatusBar.show()
      }
    } catch {
      /* 忽略 */
    }
    return flag
  }

  async function exitApp() {
    try {
      if (App) {
        await App.exitApp()
        return true
      }
    } catch {
      /* 忽略 */
    }
    return false
  }

  async function getAppInfo() {
    let version = window.CSP_VERSION || ''
    let build = window.CSP_BUILD || ''
    try {
      if (App) {
        const info = await App.getInfo()
        if (info?.version) version = info.version
        if (info?.build) build = info.build
      }
    } catch {
      /* 忽略 */
    }
    return {
      version,
      build,
      name: '长视频解析',
      platform,
      isNative,
      repo: 'https://github.com/fjz-hosts/changshipin-jiexi',
    }
  }

  function hideSplash() {
    try {
      if (SplashScreen) SplashScreen.hide()
    } catch {
      /* 忽略 */
    }
  }

  window.CSPNative = {
    platform,
    isNative,
    state,
    b64url,
    b64urlDecode,
    base64FromBytes,
    bytesFromBase64,
    proxyBase,
    resourceUrl,
    fetchText,
    fetchJson,
    fetchBinary,
    fetchBytes,
    pageTitle,
    pageEval,
    getCookies,
    webviews,
    onWebviewEvent,
    sniff,
    fs,
    publishDownload,
    openDownload,
    shareDownload,
    openDownloadsFolder,
    installApk,
    copyText,
    readText,
    openExternal,
    shareText,
    setFullscreen,
    exitApp,
    getAppInfo,
    hideSplash,
  }
})()
