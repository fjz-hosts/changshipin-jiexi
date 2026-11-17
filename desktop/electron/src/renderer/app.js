(() => {
  'use strict'

  // 与主进程 platforms.js 保持一致的精简版
  const PLATFORMS = [
    { key: 'iqiyi', name: '爱奇艺', color: '#00d95f', hosts: ['iqiyi.com', 'iq.com'], home: 'https://www.iqiyi.com/', icon: 'assets/platform-iqiyi.png' },
    { key: 'qq', name: '腾讯视频', color: '#2b8cff', hosts: ['v.qq.com', 'qq.com'], home: 'https://v.qq.com/', icon: 'assets/platform-qq.png' },
    { key: 'youku', name: '优酷', color: '#35a6ff', hosts: ['youku.com', 'tudou.com'], home: 'https://www.youku.com/', icon: 'assets/platform-youku.png' },
    { key: 'mgtv', name: '芒果TV', color: '#ff8a1f', hosts: ['mgtv.com'], home: 'https://www.mgtv.com/', icon: 'assets/platform-mgtv.png' },
  ]

  const SEARCH_URLS = {
    iqiyi: (q) => `https://so.iqiyi.com/so/q_${encodeURIComponent(q)}`,
    qq: (q) => `https://v.qq.com/x/search/?q=${encodeURIComponent(q)}`,
    youku: (q) => `https://so.youku.com/search_video/q_${encodeURIComponent(q)}`,
    mgtv: (q) => `https://so.mgtv.com/so?k=${encodeURIComponent(q)}`,
  }

  const icons = {
    play: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M8 5.5v13l11-6.5-11-6.5Z" fill="currentColor"/></svg>',
  }

  const state = {
    info: null,
    config: null,
    currentLineId: '',
    currentVideoUrl: '',
    lastResult: null,
    lineStatus: {},
    running: false,
    runToken: 0,
    hls: null,
    webviewPending: null,
    draftLines: null,
    fullscreen: false,
    pendingTitle: '',
    pendingEpisode: '',
    currentTitle: '',
    currentEpisode: '',
    resumeAt: 0,
    runWatchdog: null,
    browsers: new Map(),
    browserKey: '',
    browserOpen: false,
    browserAutoParse: true,
  }

  const $ = (selector) => document.querySelector(selector)
  const $$ = (selector) => Array.from(document.querySelectorAll(selector))

  // ---------------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------------

  function detectPlatform(rawUrl) {
    let host = ''
    try {
      host = new URL(String(rawUrl).trim()).hostname.toLowerCase()
    } catch {
      return null
    }
    const platform = PLATFORMS.find((item) => item.hosts.some((h) => host === h || host.endsWith(`.${h}`)))
    return platform ? platform.key : null
  }

  function platformInfo(key) {
    return PLATFORMS.find((item) => item.key === key) || null
  }

  function normalizeUrlText(raw) {
    let text = String(raw || '').trim()
    if (!text) return ''
    const match = text.match(/https?:\/\/[^\s"'<>，。、）)】]+/i)
    if (match) text = match[0]
    return text.replace(/[，。、；）)\]】]+$/, '')
  }

  function isHttpUrl(raw) {
    try {
      const url = new URL(String(raw || '').trim())
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, (ch) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    })
  }

  function timeAgo(timestamp) {
    const diff = Date.now() - Number(timestamp || 0)
    if (diff < 60 * 1000) return '刚刚'
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`
    if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`
    const date = new Date(Number(timestamp))
    return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')}`
  }

  function cleanTitle(raw) {
    let text = String(raw || '')
      .replace(/\s+/g, ' ')
      .replace(/^【[^】]*】\s*/, '')
      .trim()
    if (!text) return ''
    text = text
      .replace(/\s*[-_|]\s*(爱奇艺|腾讯视频|优酷|芒果TV|芒果tv|在线观看|高清完整正版视频在线观看).*$/i, '')
      .replace(/\s*[-_|]\s*芒果TV.*$/i, '')
      .trim()
    if (!text || text.length < 2) return ''
    if (/在线视频网站|海量正版|高清完整正版|天生青春|腾讯视频$|爱奇艺$/i.test(text)) return ''
    return text.slice(0, 100)
  }

  function episodeOf(title) {
    const match = String(title || '').match(/(第\s*[0-9一二三四五六七八九十百千]+\s*[集期话回]|EP?\s*\d+|S\d+E\d+)/i)
    return match ? match[0].replace(/\s+/g, '') : ''
  }

  function historyTitle(item) {
    if (item.title) return item.title
    return `${item.platform || '视频'} · ${platformInfo(detectPlatform(item.url))?.name || '未命名'}`
  }

  function setStatus(text) {
    $('#status-text').textContent = text
  }

  function toast(message, kind = 'info', timeout = 3600) {
    const stack = $('#toast-stack')
    const node = document.createElement('div')
    node.className = `toast ${kind}`
    node.textContent = message
    stack.appendChild(node)
    const remove = () => {
      node.style.opacity = '0'
      node.style.transition = 'opacity .2s ease'
      setTimeout(() => node.remove(), 220)
    }
    node.addEventListener('click', remove)
    setTimeout(remove, timeout)
  }

  const updateBadge = () => {
    const url = normalizeUrlText($('#url-input').value)
    const platform = platformInfo(detectPlatform(url))
    const badge = $('#platform-badge')
    badge.textContent = platform ? platform.name : '未识别'
    badge.classList.toggle('known', Boolean(platform))
    if (platform) badge.style.setProperty('--brand', platform.color)
    else badge.style.removeProperty('--brand')
  }

  // ---------------------------------------------------------------------------
  // 主窗口内置浏览器（平台网页不再另开窗口）
  // ---------------------------------------------------------------------------

  function detectVideoPlatform(rawUrl) {
    let parsed
    try {
      parsed = new URL(String(rawUrl || ''))
    } catch {
      return null
    }
    const host = parsed.hostname.toLowerCase()
    const pathname = parsed.pathname
    if (
      (host === 'iqiyi.com' || host.endsWith('.iqiyi.com')) &&
      (/^\/v_[A-Za-z0-9]+\.html$/.test(pathname) || /^\/a_[A-Za-z0-9]+\.html$/.test(pathname))
    ) {
      return 'iqiyi'
    }
    if (host === 'v.qq.com' || host.endsWith('.v.qq.com')) {
      const parts = pathname.split('/').filter(Boolean)
      const last = parts[parts.length - 1] || ''
      if (parts[0] === 'x' && /\.html$/.test(last)) {
        if (parts[1] === 'cover' && parts.length >= 4) return 'qq'
        if (parts[1] === 'page' && parts.length >= 3) return 'qq'
      }
    }
    if ((host === 'youku.com' || host.endsWith('.youku.com')) && /^\/v_show\/id_[A-Za-z0-9=]+\.html$/.test(pathname)) {
      return 'youku'
    }
    if ((host === 'mgtv.com' || host.endsWith('.mgtv.com')) && /^\/b\/\d+\/\d+\.html$/.test(pathname)) {
      return 'mgtv'
    }
    return null
  }

  function browserMeta(key) {
    return PLATFORMS.find((item) => item.key === key) || null
  }

  function webviewTitle(webview) {
    try {
      return cleanTitle(webview.getTitle())
    } catch {
      return ''
    }
  }

  function ensureBrowser(key) {
    const existing = state.browsers.get(key)
    if (existing) return existing
    const meta = browserMeta(key)
    if (!meta) return null
    const webview = document.createElement('webview')
    webview.className = 'browser-webview'
    webview.setAttribute('partition', `persist:platform-${key}`)
    webview.setAttribute('webpreferences', 'contextIsolation=yes, nodeIntegration=no')
    webview.setAttribute('allowpopups', '')
    webview.src = meta.home
    webview.style.display = 'none'
    $('#browser-viewport').appendChild(webview)

    const record = { key, webview, lastAuto: '', timer: null }
    state.browsers.set(key, record)

    webview.addEventListener('did-start-loading', () => {
      if (state.browserKey === key) setStatus(`正在加载 ${meta.name}…`)
    })
    webview.addEventListener('did-stop-loading', () => refreshBrowser(key))
    webview.addEventListener('did-navigate', () => refreshBrowser(key))
    webview.addEventListener('did-navigate-in-page', () => refreshBrowser(key))
    webview.addEventListener('page-title-updated', () => {
      if (state.browserKey === key) refreshBrowser(key)
    })
    webview.addEventListener('did-fail-load', (event) => {
      if (!event.isMainFrame || event.errorCode === -3) return
      if (state.browserKey !== key) return
      toast(`${meta.name} 页面加载失败：${event.errorDescription || event.errorCode}`, 'error')
    })
    return record
  }

  function refreshBrowser(key) {
    if (state.browserKey !== key || !state.browserOpen) return
    const record = state.browsers.get(key)
    if (!record) return
    const meta = browserMeta(key)
    let url = ''
    try {
      url = record.webview.getURL() || ''
    } catch {
      /* 忽略 */
    }
    if (url && document.activeElement !== $('#browser-address')) $('#browser-address').value = url
    $('#browser-icon').src = meta.icon
    $('#browser-name').textContent = meta.name
    try {
      $('#browser-back').disabled = !record.webview.canGoBack()
      $('#browser-forward').disabled = !record.webview.canGoForward()
    } catch {
      /* 忽略 */
    }
    const videoPlatform = detectVideoPlatform(url)
    const badge = $('#browser-badge')
    badge.classList.toggle('video', Boolean(videoPlatform))
    badge.textContent = videoPlatform ? `视频页 · ${browserMeta(videoPlatform)?.name || ''} · 可解析` : '浏览中'
    if (videoPlatform && $('#browser-auto').checked) scheduleBrowserParse(record, url)
  }

  function scheduleBrowserParse(record, url) {
    if (!url || record.lastAuto === url) return
    record.lastAuto = url
    clearTimeout(record.timer)
    record.timer = setTimeout(() => {
      if (!state.browserOpen || state.browserKey !== record.key) return
      const current = (() => {
        try {
          return record.webview.getURL()
        } catch {
          return ''
        }
      })()
      if (!detectVideoPlatform(current)) return
      const title = webviewTitle(record.webview)
      hideBrowser({ mute: true })
      startParse({ url: current, title, episode: episodeOf(title) })
      toast('已自动解析本集；点平台卡片可以回来继续选集', 'ok', 5000)
    }, 1000)
  }

  function openBrowser(key, { url = '', query = '', background = false } = {}) {
    const record = ensureBrowser(key)
    if (!record) return
    const meta = browserMeta(key)
    const target = url || (query ? SEARCH_URLS[key]?.(query) || '' : '')
    if (target) {
      try {
        record.webview.src = target
      } catch {
        /* 忽略 */
      }
    }
    if (background) return
    state.browserKey = key
    state.browserOpen = true
    for (const [itemKey, item] of state.browsers) {
      item.webview.style.display = itemKey === key ? 'flex' : 'none'
      if (itemKey !== key) {
        try {
          item.webview.setAudioMuted(true)
        } catch {
          /* 忽略 */
        }
      }
    }
    try {
      record.webview.setAudioMuted(false)
    } catch {
      /* 忽略 */
    }
    $('#browser-panel').hidden = false
    document.querySelector('.parse-row').hidden = true
    document.querySelector('.workspace').hidden = true
    $$('.platform-card').forEach((card) => card.classList.toggle('active', card.dataset.platform === key))
    $('#browser-icon').src = meta.icon
    $('#browser-name').textContent = meta.name
    $('#browser-badge').textContent = '浏览中'
    $('#browser-badge').classList.remove('video')
    if (!target) {
      try {
        if (!record.webview.getURL()) record.webview.src = meta.home
      } catch {
        /* 忽略 */
      }
    }
    setStatus(`正在浏览 ${meta.name}`)
    refreshBrowser(key)
  }

  function hideBrowser({ mute = true } = {}) {
    if (!state.browserOpen) return
    state.browserOpen = false
    $('#browser-panel').hidden = true
    document.querySelector('.parse-row').hidden = false
    document.querySelector('.workspace').hidden = false
    $$('.platform-card').forEach((card) => card.classList.remove('active'))
    for (const record of state.browsers.values()) {
      if (!mute) continue
      try {
        record.webview.setAudioMuted(true)
      } catch {
        /* 忽略 */
      }
    }
  }

  function currentBrowserUrl() {
    const record = state.browsers.get(state.browserKey)
    try {
      return record ? record.webview.getURL() || '' : ''
    } catch {
      return ''
    }
  }

  function currentBrowserTitle() {
    const record = state.browsers.get(state.browserKey)
    return record ? webviewTitle(record.webview) : ''
  }

  // ---------------------------------------------------------------------------
  // 播放区
  // ---------------------------------------------------------------------------

  function setView(name) {
    for (const id of ['empty', 'loading', 'error', 'video', 'webview']) {
      $(`#view-${id}`).hidden = id !== name
    }
  }

  // ---------------------------------------------------------------------------
  // 全屏（窗口铺满屏幕 + 影院模式隐藏工具栏）
  // ---------------------------------------------------------------------------

  function applyCinema(on) {
    state.fullscreen = Boolean(on)
    document.body.classList.toggle('cinema', state.fullscreen)
    $('#btn-fullscreen').textContent = state.fullscreen ? '退出全屏' : '全屏'
    $('#btn-fullscreen').title = state.fullscreen ? '退出全屏（Esc / F11）' : '全屏（F11）'
  }

  async function toggleFullscreen() {
    const next = !state.fullscreen
    applyCinema(next)
    try {
      await window.desktop.setFullscreen(next)
    } catch {
      /* 忽略 */
    }
  }

  function stopPlayback({ keepWebview = false } = {}) {
    if (state.hls) {
      try {
        state.hls.destroy()
      } catch {
        /* 忽略 */
      }
      state.hls = null
    }
    const video = $('#video')
    try {
      video.pause()
      video.removeAttribute('src')
      video.load()
    } catch {
      /* 忽略 */
    }
    if (!keepWebview) {
      try {
        $('#parse-view').stop()
      } catch {
        /* 忽略 */
      }
    }
    $('#live-dot').classList.remove('playing')
  }

  function showLoading(title, detail) {
    setView('loading')
    $('#loading-title').textContent = title
    $('#loading-detail').textContent = detail || '首次加载可能稍慢，长时间无画面请点击「换线路」。'
    $('#live-dot').classList.remove('playing')
  }

  function showError(title, detail) {
    setView('error')
    $('#error-title').textContent = title
    $('#error-detail').textContent = detail
    $('#live-dot').classList.remove('playing')
    setStatus(`解析失败：${title}`)
  }

  function loadWebview(url) {
    return new Promise((resolve) => {
      const webview = $('#parse-view')
      let settled = false
      const finish = (ok, error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (state.webviewPending && state.webviewPending.finish === finish) state.webviewPending = null
        resolve({ ok, error })
      }
      const timer = setTimeout(() => finish(false, '页面加载超时'), 45000)
      state.webviewPending = { finish }
      setView('loading')
      $('#loading-title').textContent = '正在加载解析页面…'
      $('#loading-detail').textContent = '解析页通常需要几秒钟，如果一直白屏请点击「换线路」。'
      try {
        const current = webview.getAttribute('src') || ''
        if (current && current === url) webview.reload()
        else webview.src = url
      } catch (error) {
        finish(false, String(error?.message || error))
        return
      }
      // 如果页面在 12 秒内没有任何加载事件，也提醒用户，但不直接判失败
      setTimeout(() => {
        if (!settled) $('#loading-detail').textContent = '页面仍在加载，可以再等等，或点击「换线路」。'
      }, 12000)
    })
  }

  function applyResumeAndProgress(video) {
    const resume = Number(state.resumeAt) || 0
    const seek = () => {
      if (resume > 5 && Number.isFinite(video.duration) && resume < video.duration - 5) {
        try {
          video.currentTime = resume
          toast(`已从上次观看位置继续（${Math.floor(resume / 60)} 分 ${Math.floor(resume % 60)} 秒）`, 'ok')
        } catch {
          /* 忽略 */
        }
      }
      state.resumeAt = 0
    }
    video.addEventListener('loadedmetadata', seek, { once: true })
    let lastSaved = 0
    const save = () => {
      if (!state.currentVideoUrl || !Number.isFinite(video.currentTime)) return
      if (!Number.isFinite(video.duration) || video.duration < 5) return
      const now = Date.now()
      if (now - lastSaved < 8000) return
      lastSaved = now
      window.desktop
        .updateHistory({ url: state.currentVideoUrl, progress: video.currentTime, duration: video.duration })
        .then((history) => {
          state.config.history = history
          renderHistory()
        })
        .catch(() => {})
    }
    video.ontimeupdate = save
    video.onpause = save
  }

  function playStream(result) {
    stopPlayback()
    setView('video')
    const video = $('#video')
    const isHls = /\.m3u8([?#]|$)/i.test(result.original || result.playUrl)
    if (isHls && window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        // 打包后 Chromium 的 blob worker 偶尔起不来，导致清单一直不解析；
        // 关掉 worker 用主线程解析，代价很小，但播放稳定得多。
        enableWorker: false,
        lowLatencyMode: false,
        backBufferLength: 30,
      })
      state.hls = hls
      hls.on(window.Hls.Events.ERROR, (_event, data) => {
        if (!data || !data.fatal) return
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          toast('视频流加载失败，正在重试…', 'warn')
          try {
            hls.startLoad()
          } catch {
            showError('视频流断开', '取流失败，请「换线路」或稍后重试。')
          }
        } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
          try {
            hls.recoverMediaError()
          } catch {
            showError('视频解码失败', '浏览器内核无法解码该视频流，可以试试「换线路」。')
          }
        } else {
          showError('视频流无法播放', `${data.details || '未知错误'}，请「换线路」重试。`)
        }
      })
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {})
        $('#live-dot').classList.add('playing')
      })
      hls.attachMedia(video)
      hls.loadSource(result.playUrl)
    } else {
      video.src = result.playUrl
      video.play().catch(() => {})
    }
    $('#live-dot').classList.add('playing')
    video.onerror = () => {
      showError('视频播放失败', '视频流无法被浏览器内核播放，点击「换线路」试试其它解析接口。')
    }
    applyResumeAndProgress(video)
  }

  // ---------------------------------------------------------------------------
  // 解析
  // ---------------------------------------------------------------------------

  function enabledLines() {
    const lines = state.config?.lines || []
    return lines.filter((line) => line.enabled)
  }

  function currentLine() {
    const lines = state.config?.lines || []
    return lines.find((line) => line.id === state.currentLineId) || enabledLines()[0] || lines[0] || null
  }

  function parseChain(primaryId, videoUrl) {
    const all = enabledLines()
    if (!all.length) return []
    const platformKey = detectPlatform(videoUrl)
    const fitting = platformKey ? all.filter((line) => !line.platform || line.platform === platformKey) : all
    const enabled = fitting.length ? fitting : all
    const matching = platformKey ? enabled.filter((line) => line.platform === platformKey) : []
    // 平台专属线路（例如芒果TV 原生解析）优先，避免通用线路“页面能打开但视频是空的”也算成功
    const primary = matching[0] || enabled.find((line) => line.id === primaryId) || enabled[0]
    const chain = [primary, ...enabled.filter((line) => line.id !== primary.id)]
    return state.config?.autoFallback === false ? [primary] : chain
  }

  function clearRunWatchdog() {
    if (state.runWatchdog) clearTimeout(state.runWatchdog)
    state.runWatchdog = null
    $('#btn-parse').classList.remove('busy')
  }

  async function startParse({ lineId, url, chain = true, resume = 0, title = '', episode = '' } = {}) {
    if (state.browserOpen) hideBrowser({ mute: true })
    if (state.running) {
      state.runToken += 1
      stopPlayback()
    }
    state.resumeAt = Number(resume) || 0
    state.currentTitle = cleanTitle(title)
    state.currentEpisode = episode || episodeOf(state.currentTitle)
    const videoUrl = normalizeUrlText(url || $('#url-input').value)
    if (!isHttpUrl(videoUrl)) {
      toast('请先粘贴完整的视频链接（http/https）', 'warn')
      $('#url-input').focus()
      return
    }
    const platform = platformInfo(detectPlatform(videoUrl))
    if (!platform) toast('未识别的平台，仍会尝试用线路解析', 'warn')

    const lines = chain ? parseChain(lineId || state.currentLineId, videoUrl) : (state.config.lines.filter((l) => l.id === lineId))
    if (!lines.length) {
      toast('没有启用的解析线路，请先到「线路管理」里启用或添加', 'error')
      return
    }

    const token = ++state.runToken
    state.running = true
    stopPlayback()
    state.currentVideoUrl = videoUrl
    $('#source-url').textContent = videoUrl
    $('#source-url').title = videoUrl
    $('#stage-title-text').textContent = platform ? `${platform.name} · 准备解析` : '准备解析'
    $('#btn-parse').classList.add('busy')
    clearRunWatchdog()
    state.runWatchdog = setTimeout(() => {
      if (token !== state.runToken) return
      state.running = false
      clearRunWatchdog()
      showError('解析超时', '线路长时间没有响应，可能网络或解析接口卡住了。可以点「重新解析」或「换线路」。')
    }, 90000)
    setStatus('正在解析…')

    const failures = []
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (token !== state.runToken) return
      if (index > 0) {
        toast(`「${lines[index - 1].name}」不可用，自动换到「${line.name}」`, 'warn')
      }
      state.currentLineId = line.id
      $('#stage-line').textContent = line.name
      $('#line-select').value = line.id
      renderLineList()
      showLoading(`正在通过「${line.name}」解析…`, '线路首次加载可能需要几秒，请稍候。')

      let result = null
      try {
        result = await window.desktop.parse({ url: videoUrl, lineId: line.id })
      } catch (error) {
        result = { ok: false, error: String(error?.message || error) }
      }
      if (token !== state.runToken) return

      if (!result || !result.ok) {
        const errorText = String(result?.error || '未知错误')
        failures.push(`${line.name}：${errorText}`)
        // 芒果TV 原生线路的失败通常是地区限制 / 未登录会员，继续换第三方线路
        // 只会得到一个空播放器，不如直接把真实原因告诉用户。
        if (line.platform === 'mgtv' && /地区限制|版权限制|会员|登录|地域/i.test(errorText)) {
          state.running = false
          clearRunWatchdog()
          showError(
            '芒果TV 无法解析',
            `${errorText}\n\n芒果TV 当前把本机网络判定为境外/地区受限。请使用中国大陆网络，或先切换到国内线路后再试；` +
              'VIP 内容请先在芒果TV 内置窗口登录会员，再回到主界面解析。',
          )
          return
        }
        continue
      }

      state.lastResult = result
      if (result.kind === 'stream') {
        playStream(result)
        onParseSuccess(line)
        return
      }

      const loaded = await loadWebview(result.url)
      if (token !== state.runToken) return
      if (!loaded.ok) {
        failures.push(`${line.name}：${loaded.error || '页面加载失败'}`)
        continue
      }
      setView('webview')
      $('#live-dot').classList.add('playing')
      onParseSuccess(line)
      return
    }

    state.running = false
    clearRunWatchdog()
    showError(
      '所有线路都没能解析成功',
      `已按顺序尝试 ${failures.length} 条线路：\n${failures.slice(0, 4).join('\n')}\n\n请检查链接是否有效，或在「线路管理」里更换线路。`,
    )
  }

  async function onParseSuccess(line) {
    state.currentLineId = line.id
    $('#stage-line').textContent = line.name
    const platformName = platformInfo(detectPlatform(state.currentVideoUrl))?.name || '视频'
    const knownTitle = cleanTitle(state.currentTitle) || cleanTitle(state.lastResult?.title)
    const title = knownTitle
    const episode = state.currentEpisode || episodeOf(title)
    state.currentTitle = title
    state.currentEpisode = episode
    $('#stage-title-text').textContent = title ? `${title} · ${line.name}` : `${platformName} · 正在播放`
    setStatus(`解析成功：${line.name}`)
    state.lineStatus[line.id] = { ok: true, ms: null, note: '上次解析成功' }
    renderLineList()
    clearRunWatchdog()
    state.running = false
    try {
      const history = await window.desktop.addHistory({
        url: state.currentVideoUrl,
        lineId: line.id,
        lineName: line.name,
        title,
        episode,
      })
      state.config.history = history
      renderHistory()
    } catch {
      /* 历史记录失败无关紧要 */
    }
    // 手动粘贴的链接没有页面标题：后台补一次，拿到后回填到观看历史
    if (!title) {
      const targetUrl = state.currentVideoUrl
      window.desktop
        .pageTitle(targetUrl)
        .then((raw) => {
          const cleaned = cleanTitle(raw)
          if (!cleaned) return
          const ep = episodeOf(cleaned)
          return window.desktop.updateHistory({ url: targetUrl, title: cleaned, episode: ep }).then((history) => {
            state.config.history = history
            renderHistory()
            if (state.currentVideoUrl === targetUrl) {
              state.currentTitle = cleaned
              state.currentEpisode = ep
              $('#stage-title-text').textContent = `${cleaned} · ${state.currentLineId === line.id ? line.name : ''}`
            }
          })
        })
        .catch(() => {})
    }
    // 记住默认线路
    if (state.config.defaultLineId !== line.id) {
      state.config.defaultLineId = line.id
      window.desktop.saveLines(state.config.lines, line.id).catch(() => {})
    }
  }

  async function nextLine() {
    const enabled = enabledLines()
    if (!enabled.length) {
      toast('没有启用的线路', 'warn')
      return
    }
    const index = enabled.findIndex((line) => line.id === state.currentLineId)
    const next = enabled[(index + 1) % enabled.length]
    toast(`切换到线路「${next.name}」`)
    if (!state.currentVideoUrl) {
      state.currentLineId = next.id
      $('#line-select').value = next.id
      renderLineList()
      return
    }
    await startParse({ lineId: next.id, url: state.currentVideoUrl, chain: false })
  }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  function renderLineSelect() {
    const select = $('#line-select')
    const lines = state.config.lines || []
    const enabled = lines.filter((line) => line.enabled)
    select.innerHTML = ''
    if (!enabled.length) {
      const option = document.createElement('option')
      option.textContent = '没有启用线路'
      select.appendChild(option)
      return
    }
    for (const line of enabled) {
      const option = document.createElement('option')
      option.value = line.id
      option.textContent = line.platform
        ? `${line.name} · ${platformInfo(line.platform)?.name || line.platform}`
        : line.name
      select.appendChild(option)
    }
    const target = enabled.find((line) => line.id === state.currentLineId) || enabled[0]
    state.currentLineId = target.id
    select.value = target.id
    $('#stage-line').textContent = target.name
  }

  function renderLineList() {
    const list = $('#line-list')
    const lines = state.config?.lines || []
    list.innerHTML = ''
    if (!lines.length) {
      list.innerHTML = '<li class="empty-row">还没有线路，点击「线路管理」添加。</li>'
      return
    }
    for (const line of lines) {
      const status = state.lineStatus[line.id]
      const item = document.createElement('li')
      item.className = 'line-item'
      if (line.id === state.currentLineId) item.classList.add('active')
      if (!line.enabled) item.classList.add('disabled')
      item.dataset.id = line.id
      item.innerHTML = `
        <span class="line-state ${status ? (status.ok ? 'ok' : 'fail') : ''}"></span>
        <span class="line-name" title="${escapeHtml(line.url || '')}">${escapeHtml(line.name)}</span>
        <span class="line-ms">${status ? (status.ok ? `${status.ms || ''} ms` : '失效') : ''}</span>
        <button class="line-play ${line.enabled ? '' : 'enable'}" title="${line.enabled ? '用这条线路解析' : '启用这条线路'}">${
          line.enabled ? icons.play : '启用'
        }</button>
      `
      item.addEventListener('click', () => {
        if (!line.enabled) {
          enableLine(line)
          return
        }
        state.currentLineId = line.id
        $('#line-select').value = line.id
        $('#stage-line').textContent = line.name
        renderLineList()
        window.desktop.saveLines(state.config.lines, line.id).catch(() => {})
      })
      item.querySelector('.line-play').addEventListener('click', (event) => {
        event.stopPropagation()
        if (!line.enabled) {
          enableLine(line)
          return
        }
        if (!state.currentVideoUrl) {
          toast('先粘贴一个视频链接再选择线路', 'warn')
          return
        }
        startParse({ lineId: line.id, url: state.currentVideoUrl, chain: false })
      })
      list.appendChild(item)
    }
  }

  function renderHistory() {
    const list = $('#history-list')
    const history = state.config?.history || []
    list.innerHTML = ''
    if (!history.length) {
      list.innerHTML = '<li class="empty-row">还没有观看记录。解析成功后会自动记在这里，像视频平台一样保留剧名、集数和观看进度。</li>'
      return
    }
    for (const item of history) {
      const platform = platformInfo(detectPlatform(item.url))
      const title = cleanTitle(item.title) || ''
      const episode = item.episode || episodeOf(title)
      const percent =
        item.duration > 5 ? Math.max(0, Math.min(100, Math.round((item.progress / item.duration) * 100))) : 0
      const li = document.createElement('li')
      li.className = 'history-item'
      li.innerHTML = `
        <div class="history-top">
          <span class="history-title" title="${escapeHtml(item.url)}">${escapeHtml(
            title || `${platform?.name || '视频'} · 未命名视频`,
          )}</span>
          <span class="history-time">${timeAgo(item.at)}</span>
        </div>
        <div class="history-meta">
          ${platform ? `<span class="history-platform" style="color:${platform.color}">${escapeHtml(item.platform || platform.name)}</span>` : ''}
          ${episode ? `<span class="history-episode">${escapeHtml(episode)}</span>` : ''}
          <span class="history-line">${escapeHtml(item.lineName || '')}</span>
          ${percent ? `<span class="history-percent">已看 ${percent}%</span>` : ''}
        </div>
        ${percent ? `<div class="history-progress"><i style="width:${percent}%"></i></div>` : ''}
        ${title ? '' : `<div class="history-url" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</div>`}
        <button class="history-del" title="删除这条记录">×</button>
      `
      li.addEventListener('click', () => {
        $('#url-input').value = item.url
        updateBadge()
        state.currentLineId = item.lineId || state.currentLineId
        startParse({
          url: item.url,
          lineId: item.lineId,
          resume: item.progress || 0,
          title,
          episode,
        })
      })
      li.querySelector('.history-del').addEventListener('click', async (event) => {
        event.stopPropagation()
        try {
          state.config.history = await window.desktop.removeHistory(item.url)
          renderHistory()
        } catch {
          /* 忽略 */
        }
      })
      list.appendChild(li)
    }
  }

  // 旧版本只存了网址；启动后在后台补一次标题，最多 4 条，避免拖慢启动
  async function backfillHistoryTitles() {
    const history = state.config?.history || []
    const missing = history.filter((item) => !cleanTitle(item.title)).slice(0, 4)
    for (const item of missing) {
      try {
        const raw = await window.desktop.pageTitle(item.url)
        const title = cleanTitle(raw)
        if (!title) continue
        state.config.history = await window.desktop.updateHistory({
          url: item.url,
          title,
          episode: episodeOf(title),
        })
        renderHistory()
      } catch {
        /* 忽略 */
      }
    }
  }

  function renderUpdateState(update) {
    if (!update) return
    const pill = $('#update-pill')
    pill.className = `pill-btn ${update.status || 'idle'}`
    const version = state.info?.version || update.currentVersion || ''
    $('#update-text').textContent =
      update.status === 'downloading' ? `更新 ${update.percent || 0}%` : `v${version}`
    const statusNode = $('#update-status')
    if (statusNode) {
      let text = update.message || '等待检查'
      if (update.status === 'downloaded') text += '，可点击「重启安装」'
      if (update.feed) {
        try {
          text += `\n当前源：${new URL(update.feed).host}`
        } catch {
          /* 忽略 */
        }
      }
      statusNode.textContent = text
    }
    const installButton = $('#btn-install-update')
    if (installButton) installButton.hidden = update.status !== 'downloaded'
  }

  // ---------------------------------------------------------------------------
  // 弹窗 / 线路编辑
  // ---------------------------------------------------------------------------

  function openModal(tab = 'lines') {
    $('#modal').hidden = false
    switchTab(tab)
    if (tab === 'lines') {
      state.draftLines = (state.config.lines || []).map((line) => ({ ...line }))
      renderLineEditor()
    }
    $('#modal-close').focus()
  }

  function closeModal() {
    $('#modal').hidden = true
  }

  function switchTab(tab) {
    $$('#modal-tabs button').forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === tab)
    })
    $$('.tab-pane').forEach((pane) => {
      pane.hidden = pane.dataset.pane !== tab
    })
    if (tab === 'update') {
      window.desktop.getUpdateState().then(renderUpdateState).catch(() => {})
      $('#set-auto-update').checked = state.config.autoUpdate !== false
    }
    if (tab === 'play') {
      $('#set-auto-fallback').checked = state.config.autoFallback !== false
      $('#set-close-tray').checked = state.config.closeToTray === true
    }
    if (tab === 'about') {
      $('#about-version').textContent = state.info?.version || '-'
    }
  }

  const LINE_KINDS = [
    { value: 'page', label: '网页' },
    { value: 'api', label: '接口' },
    { value: 'mgtv', label: '芒果内置' },
    { value: 'direct', label: '直连' },
  ]

  function renderLineEditor() {
    const editor = $('#line-editor')
    editor.innerHTML = ''
    const lines = state.draftLines || []
    if (!lines.length) {
      editor.innerHTML = '<div class="empty-row">还没有线路，点「新增线路」添加。</div>'
      return
    }
    lines.forEach((line, index) => {
      const row = document.createElement('div')
      row.className = 'line-row'
      row.dataset.index = String(index)
      row.innerHTML = `
        <input type="checkbox" class="line-enabled" ${line.enabled !== false ? 'checked' : ''} title="启用" />
        <input type="text" class="line-name" value="${escapeHtml(line.name || '')}" placeholder="线路名称" maxlength="40" />
        <select class="line-kind">
          ${LINE_KINDS.map((kind) => `<option value="${kind.value}" ${line.kind === kind.value ? 'selected' : ''}>${kind.label}</option>`).join('')}
        </select>
        <input type="text" class="line-url" value="${escapeHtml(line.url || '')}" placeholder="https://jx.example.com/?url={url}" spellcheck="false" ${line.kind === 'direct' || line.kind === 'mgtv' ? 'disabled' : ''} />
        <button class="row-btn line-test" title="用示例链接测一下">测试</button>
        <button class="row-btn line-del" title="删除">删除</button>
        <div class="row-note">${escapeHtml(line.note || '')}</div>
      `
      row.querySelector('.line-kind').addEventListener('change', (event) => {
        const kind = event.target.value
        const urlInput = row.querySelector('.line-url')
        if (kind === 'direct' || kind === 'mgtv') {
          urlInput.value = kind === 'direct' ? 'direct://video' : 'mgtv://auto'
          urlInput.disabled = true
        } else {
          urlInput.disabled = false
          if (urlInput.value === 'direct://video' || urlInput.value === 'mgtv://auto') urlInput.value = ''
        }
      })
      row.querySelector('.line-del').addEventListener('click', () => {
        state.draftLines.splice(index, 1)
        renderLineEditor()
      })
      row.querySelector('.line-test').addEventListener('click', async (event) => {
        const button = event.currentTarget
        button.textContent = '测试中'
        button.disabled = true
        try {
          const result = await window.desktop.testLines({
            url: state.currentVideoUrl || '',
            draft: collectEditorLine(row),
          })
          const status = result?.draft
          if (status) {
            row.querySelector('.row-note').textContent = `${status.ok ? '可用' : '不可用'}：${status.note || ''}${
              status.ms ? `（${status.ms} ms）` : ''
            }`
          } else {
            row.querySelector('.row-note').textContent = '没有测试结果'
          }
        } catch (error) {
          row.querySelector('.row-note').textContent = `测试失败：${String(error?.message || error)}`
        } finally {
          button.textContent = '测试'
          button.disabled = false
        }
      })
      editor.appendChild(row)
    })
  }

  function collectEditorLine(row) {
    const index = Number(row.dataset.index)
    const line = state.draftLines[index] || {}
    line.enabled = row.querySelector('.line-enabled').checked
    line.name = row.querySelector('.line-name').value.trim()
    line.kind = row.querySelector('.line-kind').value
    line.url = row.querySelector('.line-url').value.trim()
    if (line.kind === 'direct' && !line.url) line.url = 'direct://video'
    if (line.kind === 'mgtv' && !line.url) line.url = 'mgtv://auto'
    return line
  }

  function collectEditorLines() {
    const rows = $$('#line-editor .line-row')
    return rows.map((row, index) => {
      const line = collectEditorLine(row)
      return {
        ...line,
        id: line.id || state.draftLines[index]?.id || `line-${Date.now()}-${index}`,
      }
    })
  }

  async function saveDraftLines({ silent = false } = {}) {
    const lines = collectEditorLines()
    const invalid = lines.find((line) => !line.name || (line.kind !== 'direct' && !line.url))
    if (invalid) {
      toast('每条线路都需要名称和地址', 'warn')
      return null
    }
    try {
      const config = await window.desktop.saveLines(lines, state.currentLineId || lines[0]?.id)
      state.config = config
      state.draftLines = config.lines.map((line) => ({ ...line }))
      renderLineSelect()
      renderLineList()
      if (!silent) {
        renderLineEditor()
        toast('线路已保存', 'ok')
      }
      return config
    } catch (error) {
      toast(`保存失败：${String(error?.message || error)}`, 'error')
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // 找剧 / 跨平台搜索
  // ---------------------------------------------------------------------------

  function openSearchModal() {
    $('#search-modal').hidden = false
    setTimeout(() => $('#search-input').focus(), 30)
  }

  function closeSearchModal() {
    $('#search-modal').hidden = true
  }

  async function submitSearch() {
    const query = $('#search-input').value.trim()
    if (!query) {
      toast('先输入想看的剧名', 'warn')
      $('#search-input').focus()
      return
    }
    const picked = $$('#platform-picks .pick')
      .filter((item) => item.querySelector('input').checked)
      .map((item) => item.dataset.platform)
    if (!picked.length) {
      toast('至少选择一个平台', 'warn')
      return
    }
    const button = $('#search-submit')
    button.disabled = true
    button.textContent = '打开中…'
    try {
      for (const key of picked) {
        openBrowser(key, { query, background: true })
      }
      openBrowser(picked[0], { query })
      closeSearchModal()
      toast(`已在 ${picked.length} 个平台打开「${query}」的搜索结果`, 'ok')
      setStatus('在当前窗口点开任意剧集或某一集，会自动解析到主界面播放')
    } catch (error) {
      toast(`搜索失败：${String(error?.message || error)}`, 'error')
    } finally {
      button.disabled = false
      button.textContent = '开始搜索'
    }
  }

  async function enableLine(line) {
    try {
      const lines = state.config.lines.map((item) =>
        item.id === line.id ? { ...item, enabled: true } : item,
      )
      state.config = await window.desktop.saveLines(lines, line.id)
      state.currentLineId = line.id
      renderLineSelect()
      renderLineList()
      toast(`已启用线路「${line.name}」`, 'ok')
    } catch (error) {
      toast(`启用失败：${String(error?.message || error)}`, 'error')
    }
  }

  // ---------------------------------------------------------------------------
  // 事件绑定
  // ---------------------------------------------------------------------------

  function bindEvents() {
    $('#url-input').addEventListener('input', updateBadge)
    $('#url-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        startParse({ lineId: $('#line-select').value, url: $('#url-input').value })
      }
    })

    $('#btn-parse').addEventListener('click', () => {
      startParse({ lineId: $('#line-select').value, url: $('#url-input').value })
    })

    $('#btn-paste').addEventListener('click', async () => {
      try {
        const text = await window.desktop.readClipboard()
        const url = normalizeUrlText(text)
        if (!url) {
          toast('剪贴板里没有链接', 'warn')
          return
        }
        $('#url-input').value = url
        updateBadge()
        toast('已粘贴剪贴板链接')
        $('#url-input').focus()
      } catch {
        toast('读取剪贴板失败', 'error')
      }
    })

    $('#btn-clear').addEventListener('click', () => {
      $('#url-input').value = ''
      updateBadge()
      $('#url-input').focus()
    })

    $('#line-select').addEventListener('change', (event) => {
      state.currentLineId = event.target.value
      const line = currentLine()
      if (line) $('#stage-line').textContent = line.name
      renderLineList()
      window.desktop.saveLines(state.config.lines, state.currentLineId).catch(() => {})
    })

    // 平台快捷入口
    $$('.platform-card').forEach((card) => {
      const key = card.dataset.platform
      card.querySelector('.card-main').addEventListener('click', () => {
        openBrowser(key)
      })
      card.querySelector('.card-ext').addEventListener('click', () => {
        window.desktop.openPlatformSite(key)
      })
    })
    // 主窗口内置浏览器工具栏
    $('#browser-back').addEventListener('click', () => {
      try {
        state.browsers.get(state.browserKey)?.webview.goBack()
      } catch {
        /* 忽略 */
      }
    })
    $('#browser-forward').addEventListener('click', () => {
      try {
        state.browsers.get(state.browserKey)?.webview.goForward()
      } catch {
        /* 忽略 */
      }
    })
    $('#browser-reload').addEventListener('click', () => {
      try {
        state.browsers.get(state.browserKey)?.webview.reload()
      } catch {
        /* 忽略 */
      }
    })
    $('#browser-home').addEventListener('click', () => {
      const meta = browserMeta(state.browserKey)
      if (!meta) return
      try {
        state.browsers.get(state.browserKey)?.webview.loadURL(meta.home)?.catch?.(() => {})
      } catch {
        /* 忽略 */
      }
    })
    $('#browser-address').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      let text = $('#browser-address').value.trim()
      if (!text) return
      if (!/^https?:\/\//i.test(text)) text = `https://${text}`
      try {
        state.browsers.get(state.browserKey)?.webview.loadURL(text)?.catch?.(() => {})
      } catch {
        /* 忽略 */
      }
    })
    $('#browser-auto').addEventListener('change', (event) => {
      state.browserAutoParse = event.target.checked
      localStorage.setItem('csp.browserAuto', event.target.checked ? '1' : '0')
      toast(event.target.checked ? '已开启：点开剧集自动解析' : '已关闭自动解析')
    })
    $('#browser-copy').addEventListener('click', async () => {
      const url = currentBrowserUrl()
      if (!detectVideoPlatform(url)) {
        toast('请先点开具体某一集，再复制链接', 'warn')
        return
      }
      await window.desktop.copyText(url)
      toast('已复制本集链接', 'ok')
    })
    $('#browser-parse').addEventListener('click', () => {
      const url = currentBrowserUrl()
      if (!url) {
        toast('页面还没加载出来', 'warn')
        return
      }
      const title = currentBrowserTitle()
      hideBrowser({ mute: true })
      startParse({ url, title, episode: episodeOf(title) })
    })
    $('#browser-external').addEventListener('click', () => {
      const url = currentBrowserUrl()
      if (url) window.desktop.openExternal(url)
    })
    $('#browser-close').addEventListener('click', () => hideBrowser())

    // 舞台工具
    $('#btn-reload').addEventListener('click', () => {
      if (state.lastResult?.kind === 'stream') {
        playStream(state.lastResult)
      } else {
        try {
          $('#parse-view').reload()
        } catch {
          /* 忽略 */
        }
      }
    })

    $('#btn-next-line').addEventListener('click', () => nextLine())
    $('#btn-open-web').addEventListener('click', () => {
      const target = state.currentVideoUrl || $('#url-input').value
      if (isHttpUrl(target)) window.desktop.openExternal(target)
      else toast('还没有可打开的链接', 'warn')
    })
    $('#btn-fullscreen').addEventListener('click', () => toggleFullscreen())

    // 找剧：跨平台搜索
    $('#btn-search').addEventListener('click', openSearchModal)
    $('#search-close').addEventListener('click', closeSearchModal)
    $('#search-modal').addEventListener('click', (event) => {
      if (event.target === $('#search-modal')) closeSearchModal()
    })
    $('#search-submit').addEventListener('click', submitSearch)
    $('#search-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submitSearch()
    })
    $$('.quick-searches button').forEach((button) => {
      button.addEventListener('click', () => {
        $('#search-input').value = button.dataset.q || ''
        submitSearch()
      })
    })

    $('#btn-copy-source').addEventListener('click', async () => {
      const target = state.currentVideoUrl || $('#url-input').value
      if (!target) {
        toast('还没有链接', 'warn')
        return
      }
      await window.desktop.copyText(target)
      toast('链接已复制', 'ok')
    })

    $('#btn-reparse').addEventListener('click', () => {
      startParse({ lineId: state.currentLineId, url: state.currentVideoUrl || $('#url-input').value })
    })

    // 错误态按钮
    $('#btn-error-retry').addEventListener('click', () => {
      startParse({ lineId: state.currentLineId, url: state.currentVideoUrl || $('#url-input').value, chain: false })
    })
    $('#btn-error-next').addEventListener('click', () => nextLine())
    $('#btn-error-lines').addEventListener('click', () => openModal('lines'))

    // 侧栏
    $('#btn-test-all').addEventListener('click', async () => {
      const button = $('#btn-test-all')
      button.disabled = true
      button.textContent = '测速中'
      setStatus('正在测试所有线路…')
      try {
        const result = await window.desktop.testLines({ url: state.currentVideoUrl || '' })
        state.lineStatus = result
        renderLineList()
        const okCount = Object.values(result).filter((item) => item.ok).length
        toast(`测速完成：${okCount} / ${Object.keys(result).length} 条线路可访问`, okCount ? 'ok' : 'warn')
        setStatus('测速完成')
      } catch (error) {
        toast(`测速失败：${String(error?.message || error)}`, 'error')
      } finally {
        button.disabled = false
        button.textContent = '测速'
      }
    })

    $('#btn-clear-history').addEventListener('click', async () => {
      state.config.history = await window.desktop.clearHistory()
      renderHistory()
      toast('已清空解析记录')
    })

    // 弹窗
    $('#btn-lines').addEventListener('click', () => openModal('lines'))
    $('#btn-settings').addEventListener('click', () => {
      state.draftLines = (state.config.lines || []).map((line) => ({ ...line }))
      openModal('play')
    })
    $('#modal-close').addEventListener('click', closeModal)
    $('#modal').addEventListener('click', (event) => {
      if (event.target === $('#modal')) closeModal()
    })
    $('#modal-tabs').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-tab]')
      if (!button) return
      switchTab(button.dataset.tab)
      if (button.dataset.tab === 'lines') renderLineEditor()
    })

    // 线路编辑
    $('#btn-add-line').addEventListener('click', () => {
      if (!state.draftLines) state.draftLines = (state.config.lines || []).map((line) => ({ ...line }))
      state.draftLines.push({
        id: `line-${Date.now()}`,
        name: '新线路',
        kind: 'page',
        url: '',
        enabled: true,
        builtin: false,
        note: '',
      })
      renderLineEditor()
      const rows = $$('#line-editor .line-row')
      rows[rows.length - 1]?.querySelector('.line-name')?.focus()
    })

    $('#btn-save-lines').addEventListener('click', () => saveDraftLines())

    $('#btn-reset-lines').addEventListener('click', async () => {
      try {
        const config = await window.desktop.resetLines()
        state.config = config
        state.draftLines = config.lines.map((line) => ({ ...line }))
        renderLineEditor()
        renderLineSelect()
        renderLineList()
        toast('已恢复内置线路', 'ok')
      } catch (error) {
        toast(`恢复失败：${String(error?.message || error)}`, 'error')
      }
    })

    $('#btn-online-lines').addEventListener('click', async (event) => {
      const button = event.currentTarget
      button.disabled = true
      button.textContent = '更新中'
      try {
        const result = await window.desktop.updateLinesOnline()
        if (!result.ok) {
          toast('在线线路清单获取失败，请检查网络', 'error')
          return
        }
        state.config = result.config
        state.draftLines = result.config.lines.map((line) => ({ ...line }))
        renderLineEditor()
        renderLineSelect()
        renderLineList()
        toast(`已更新 ${result.applied} 条内置线路`, 'ok')
      } catch (error) {
        toast(`更新失败：${String(error?.message || error)}`, 'error')
      } finally {
        button.disabled = false
        button.textContent = '在线更新线路'
      }
    })

    // 播放设置
    $('#set-auto-fallback').addEventListener('change', async (event) => {
      state.config = await window.desktop.saveSettings({ autoFallback: event.target.checked })
      toast(event.target.checked ? '已开启自动换线路' : '已关闭自动换线路')
    })
    $('#set-close-tray').addEventListener('change', async (event) => {
      state.config = await window.desktop.saveSettings({ closeToTray: event.target.checked })
      toast(event.target.checked ? '关闭窗口将最小化到托盘' : '关闭窗口将退出程序')
    })
    $('#set-auto-update').addEventListener('change', async (event) => {
      state.config = await window.desktop.saveSettings({ autoUpdate: event.target.checked })
      toast(event.target.checked ? '已开启启动时自动检查更新' : '已关闭自动检查更新')
    })

    // 更新
    $('#btn-check-update').addEventListener('click', async () => {
      const button = $('#btn-check-update')
      button.disabled = true
      button.textContent = '检查中…'
      try {
        const update = await window.desktop.checkUpdate()
        renderUpdateState(update)
      } finally {
        button.disabled = false
        button.textContent = '立即检查更新'
      }
    })
    $('#btn-install-update').addEventListener('click', () => window.desktop.installUpdate())
    $('#update-pill').addEventListener('click', async () => {
      const update = await window.desktop.checkUpdate()
      renderUpdateState(update)
      openModal('update')
    })

    // 关于
    $('#btn-open-repo').addEventListener('click', () => window.desktop.openExternal(state.info?.repo || 'https://github.com/fjz-hosts/changshipin-jiexi'))
    $('#btn-open-userdata').addEventListener('click', () => window.desktop.openUserData())
    $('#btn-open-logs').addEventListener('click', () => window.desktop.openLogs())
    $('#btn-create-shortcut').addEventListener('click', async () => {
      const result = await window.desktop.createShortcut()
      if (result?.ok) toast('已在桌面重新创建快捷方式', 'ok')
      else toast(`创建失败：${result?.error || '未知错误'}`, 'error')
    })

    // 工具栏快捷键 & 主进程菜单事件
    document.addEventListener('keydown', (event) => {
      if (state.browserOpen) {
        if (event.altKey && event.key === 'ArrowLeft') {
          event.preventDefault()
          $('#browser-back').click()
          return
        }
        if (event.altKey && event.key === 'ArrowRight') {
          event.preventDefault()
          $('#browser-forward').click()
          return
        }
        if (event.key === 'F5') {
          event.preventDefault()
          $('#browser-reload').click()
          return
        }
        if (event.key === 'Escape') {
          hideBrowser()
          return
        }
      }
      if (event.key !== 'Escape') return
      if (!$('#search-modal').hidden) {
        closeSearchModal()
        return
      }
      if (!$('#modal').hidden) {
        closeModal()
        return
      }
      if (state.fullscreen) toggleFullscreen()
    })

    window.desktop.onPasteParse(async () => {
      try {
        const url = normalizeUrlText(await window.desktop.readClipboard())
        if (!url) {
          toast('剪贴板里没有链接', 'warn')
          return
        }
        $('#url-input').value = url
        updateBadge()
        startParse({ lineId: $('#line-select').value, url })
      } catch {
        /* 忽略 */
      }
    })
    window.desktop.onNextLine(() => nextLine())
    window.desktop.onReload(() => $('#btn-reload').click())
    window.desktop.onOpenExternal(() => $('#btn-open-web').click())
    window.desktop.onOpenBrowser?.((payload = {}) => {
      if (!payload || !payload.key) return
      openBrowser(payload.key, { query: payload.query || '', url: payload.url || '' })
    })

    window.desktop.onExternalParse((payload = {}) => {
      if (!payload.url) return
      $('#url-input').value = payload.url
      updateBadge()
      if (payload.auto !== false) {
        if (payload.focus === false) toast('平台窗口自动送来本集，正在解析…', 'ok')
        startParse({
          lineId: state.currentLineId,
          url: payload.url,
          title: payload.title || '',
          episode: payload.episode || '',
        })
      } else {
        toast('链接已填入，点击「解析播放」开始')
      }
    })
    window.desktop.onFullscreen((flag) => {
      applyCinema(flag)
    })
    window.desktop.onFullscreenToggle(() => {
      toggleFullscreen()
    })
    window.desktop.onUpdateState((update) => {
      renderUpdateState(update)
      if (update.status === 'downloaded') toast(`新版本 v${update.version || ''} 已下载，重启后生效`, 'ok', 6000)
    })

    // 拖拽链接
    const urlBox = $('#url-box')
    const stop = (event) => {
      event.preventDefault()
      event.stopPropagation()
    }
    ;['dragenter', 'dragover'].forEach((name) => {
      window.addEventListener(name, (event) => {
        stop(event)
        urlBox.classList.add('dragover')
      })
    })
    window.addEventListener('dragleave', (event) => {
      if (event.clientX <= 0 || event.clientY <= 0) urlBox.classList.remove('dragover')
    })
    window.addEventListener('drop', (event) => {
      stop(event)
      urlBox.classList.remove('dragover')
      const uri = event.dataTransfer?.getData('text/uri-list') || ''
      const text = uri || event.dataTransfer?.getData('text') || ''
      const url = normalizeUrlText(text.split('\n')[0])
      if (url) {
        $('#url-input').value = url
        updateBadge()
        toast('已填入拖入的链接')
      }
    })
  }

  function bindWebviewEvents() {
    const webview = $('#parse-view')
    webview.addEventListener('did-finish-load', () => {
      if (state.webviewPending) state.webviewPending.finish(true)
      if ($('#view-webview').hidden === false) setView('webview')
    })
    webview.addEventListener('did-fail-load', (event) => {
      if (!event.isMainFrame || event.errorCode === -3) return
      if (state.webviewPending) {
        state.webviewPending.finish(false, event.errorDescription || `加载失败 ${event.errorCode}`)
      }
    })
    webview.addEventListener('will-navigate', () => {
      if (!state.webviewPending) showLoading('正在打开解析页面…', '解析页发生跳转，请稍候。')
    })
    webview.addEventListener('did-stop-loading', () => {
      if (state.webviewPending) return
      if (state.lastResult?.kind === 'page') setView('webview')
    })
    webview.addEventListener('render-process-gone', () => {
      toast('解析页内核退出，正在重载…', 'warn')
      try {
        webview.reload()
      } catch {
        /* 忽略 */
      }
    })
  }

  async function init() {
    try {
      state.info = await window.desktop.info()
      state.config = await window.desktop.getConfig()
      $('#version-text').textContent = `v${state.info.version}`
      $('#set-version').textContent = `v${state.info.version}`
      state.currentLineId = state.config.defaultLineId
      $('#browser-auto').checked = localStorage.getItem('csp.browserAuto') !== '0'
      state.browserAutoParse = $('#browser-auto').checked
      bindEvents()
      bindWebviewEvents()
      renderLineSelect()
      renderLineList()
      renderHistory()
      backfillHistoryTitles()
      renderUpdateState(await window.desktop.getUpdateState())
      if (state.config.lastUrl) {
        $('#url-input').value = state.config.lastUrl
        updateBadge()
      }
      const feedList = $('#feed-list')
      const updateState = await window.desktop.getUpdateState()
      feedList.innerHTML = (updateState.feeds || []).map((feed) => `<li>${escapeHtml(feed)}</li>`).join('')
      setStatus(`就绪 · 共 ${state.config.lines.filter((line) => line.enabled).length} 条可用线路`)
      window.__app = {
        detectPlatform,
        platformInfo,
        detectVideoPlatform,
        openBrowser,
        hideBrowser,
        getState: () => state,
        startParse,
        toggleFullscreen,
      }
    } catch (error) {
      console.error(error)
      setStatus('初始化失败')
      showError('程序初始化失败', String(error?.message || error))
      window.__app = { detectPlatform, platformInfo, getState: () => state }
    }
  }

  window.__app = { detectPlatform, platformInfo, getState: () => state }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
