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
    fullscreenHinted: false,
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
    series: null,
    seriesOrder: 'asc',
    seriesCollapsed: false,
    seriesLoading: false,
    seriesPending: new Map(),
    autoNext: true,
    autoNextHandledFor: '',
    playerPollTimer: null,
    playerPollBusy: false,
    lastWebviewSave: 0,
    lastWebviewProgress: 0,
    guideNavTimer: 0,
    historySort: 'recent',
    historyQuery: '',
    historyCollapsed: new Set(),
    lineHealth: {},
    hideDeadLines: false,
    lineHealthRunning: false,
    downloadId: '',
    downloadRunning: false,
    downloadPercent: 0,
    finishedDownloads: new Map(),
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

    const record = { key, webview, lastAuto: '', timer: null, scrollY: 0 }
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
    renderBrowserTabs()
    return record
  }

  // ---------------------------------------------------------------------------
  // 内置浏览器：标签栏 / 滚动位置 / 按平台记忆自动解析
  // ---------------------------------------------------------------------------

  function loadAutoMap() {
    try {
      const raw = JSON.parse(localStorage.getItem('csp.browserAutoByPlatform') || '{}')
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  function autoParseEnabled(key) {
    return loadAutoMap()[key] !== false
  }

  function setAutoParseEnabled(key, value) {
    if (!key) return
    const map = loadAutoMap()
    map[key] = Boolean(value)
    try {
      localStorage.setItem('csp.browserAutoByPlatform', JSON.stringify(map))
    } catch {
      /* 忽略 */
    }
    state.browserAutoParse = Boolean(value)
  }

  function renderBrowserTabs() {
    const box = $('#browser-tabs')
    if (!box) return
    box.innerHTML = ''
    for (const [key, record] of state.browsers) {
      const meta = browserMeta(key)
      if (!meta) continue
      const tab = document.createElement('div')
      tab.className = 'browser-tab'
      if (state.browserKey === key && state.browserOpen) tab.classList.add('active')
      tab.title = (() => {
        try {
          return record.webview.getURL() || meta.home
        } catch {
          return meta.home
        }
      })()
      tab.innerHTML = `<img src="${meta.icon}" alt="" /><span>${escapeHtml(meta.name)}</span><button class="tab-close" title="关闭这个标签页">×</button>`
      tab.addEventListener('click', () => openBrowser(key))
      tab.querySelector('.tab-close').addEventListener('click', (event) => {
        event.stopPropagation()
        closeBrowserTab(key)
      })
      box.appendChild(tab)
    }
  }

  function closeBrowserTab(key) {
    const record = state.browsers.get(key)
    if (!record) return
    try {
      record.webview.remove()
    } catch {
      /* 忽略 */
    }
    state.browsers.delete(key)
    if (state.browserKey === key) {
      const next = [...state.browsers.keys()][0]
      if (next) openBrowser(next)
      else hideBrowser({ mute: false })
    }
    renderBrowserTabs()
    toast(`已关闭 ${browserMeta(key)?.name || '标签页'}`)
  }

  function saveBrowserScroll(record) {
    if (!record) return
    try {
      record.webview
        .executeJavaScript('window.scrollY || document.documentElement.scrollTop || 0')
        .then((value) => {
          record.scrollY = Number(value) || 0
        })
        .catch(() => {})
    } catch {
      /* 忽略 */
    }
  }

  function restoreBrowserScroll(record) {
    if (!record || !record.scrollY) return
    const target = record.scrollY
    setTimeout(() => {
      try {
        record.webview.executeJavaScript(`window.scrollTo(0, ${Number(target) || 0})`).catch(() => {})
      } catch {
        /* 忽略 */
      }
    }, 320)
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
    if (videoPlatform && autoParseEnabled(key)) scheduleBrowserParse(record, url)
    renderBrowserTabs()
  }

  function scheduleBrowserParse(record, url) {
    if (!url || record.lastAuto === url) return
    if (!autoParseEnabled(record.key)) return
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
      toast('已自动解析本集；播放器下方可以直接切换选集', 'ok', 5000)
      collectSeriesHint(record).then((hint) => requestSeries(current, { title, hint }))
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
    if (state.browserOpen && state.browserKey && state.browserKey !== key) {
      saveBrowserScroll(state.browsers.get(state.browserKey))
    }
    state.browserKey = key
    state.browserOpen = true
    updateLayoutMode()
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
    $('#browser-auto').checked = autoParseEnabled(key)
    state.browserAutoParse = $('#browser-auto').checked
    renderBrowserTabs()
    restoreBrowserScroll(record)
    refreshBrowser(key)
  }

  function hideBrowser({ mute = true } = {}) {
    if (!state.browserOpen) return
    saveBrowserScroll(state.browsers.get(state.browserKey))
    state.browserOpen = false
    updateLayoutMode()
    $('#browser-panel').hidden = true
    document.querySelector('.parse-row').hidden = false
    document.querySelector('.workspace').hidden = false
    $$('.platform-card').forEach((card) => card.classList.remove('active'))
    renderBrowserTabs()
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
  // 选集（播放器下方）
  // ---------------------------------------------------------------------------

  const SERIES_STORE_KEY = 'csp.series.v1'
  const SERIES_STORE_MAX = 12
  const SERIES_MAX_EPISODES = 400

  function sameVideoUrl(a, b) {
    try {
      const left = new URL(String(a || ''))
      const right = new URL(String(b || ''))
      // 同一集的链接可能带不同的跟踪参数，按 host + pathname 判断
      return left.hostname.toLowerCase() === right.hostname.toLowerCase() && left.pathname === right.pathname
    } catch {
      return false
    }
  }

  function loadSeriesStore() {
    try {
      const raw = JSON.parse(localStorage.getItem(SERIES_STORE_KEY) || '{}')
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  function writeSeriesStore(store) {
    try {
      localStorage.setItem(SERIES_STORE_KEY, JSON.stringify(store))
    } catch {
      /* 存储满/禁用时忽略 */
    }
  }

  function findSavedSeries(url) {
    if (!url) return null
    const store = loadSeriesStore()
    for (const series of Object.values(store)) {
      if (!series || !Array.isArray(series.episodes)) continue
      if (series.episodes.some((episode) => sameVideoUrl(episode.url, url))) return series
    }
    return null
  }

  function saveSeries(series) {
    if (!series || !Array.isArray(series.episodes) || !series.episodes.length) return
    const key = series.seriesKey || `${series.platform}:${series.title || series.url || Date.now()}`
    const store = loadSeriesStore()
    store[key] = {
      seriesKey: key,
      platform: series.platform || '',
      title: series.title || '',
      url: series.url || '',
      source: series.source || '',
      at: Date.now(),
      episodes: series.episodes.slice(0, SERIES_MAX_EPISODES),
    }
    const entries = Object.entries(store).sort((left, right) => Number(right[1]?.at || 0) - Number(left[1]?.at || 0))
    writeSeriesStore(Object.fromEntries(entries.slice(0, SERIES_STORE_MAX)))
  }

  function seriesCurrentIndex(series, url) {
    if (!series || !Array.isArray(series.episodes)) return -1
    return series.episodes.findIndex((episode) => sameVideoUrl(episode.url, url))
  }

  function updateEpisodeBarShell() {
    const bar = $('#episode-bar')
    const series = state.series
    if (!series && !state.seriesLoading) {
      bar.hidden = true
      return
    }
    bar.hidden = false
    bar.classList.toggle('collapsed', state.seriesCollapsed)
    $('#episode-toggle').textContent = state.seriesCollapsed ? '展开' : '收起'
    $('#episode-order').textContent = state.seriesOrder === 'asc' ? '倒序' : '正序'
    $('#episode-auto-next').checked = state.autoNext
    if (!series) {
      $('#episode-series-name').textContent = '正在获取选集…'
      $('#episode-count').textContent = ''
      $('#episode-tip').textContent = ''
      $('#episode-list').innerHTML = '<span class="episode-loading">正在向平台获取分集列表…</span>'
      return
    }
    const platform = platformInfo(series.platform)
    $('#episode-series-name').textContent = series.title || `${platform?.name || ''} 选集`
    $('#episode-count').textContent = `${series.episodes.length} 集`
    $('#episode-tip').textContent =
      seriesCurrentIndex(series, state.currentVideoUrl) >= 0
        ? '点任意一集直接切换，不用回平台页'
        : '点任意一集开始播放'
  }

  function renderEpisodeBar() {
    updateEpisodeBarShell()
    const series = state.series
    const list = $('#episode-list')
    if (!series) return
    const currentIndex = seriesCurrentIndex(series, state.currentVideoUrl)
    const ordered = state.seriesOrder === 'asc' ? series.episodes : [...series.episodes].reverse()
    list.innerHTML = ''
    for (const episode of ordered) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'episode-item'
      if (episode.vip) button.classList.add('vip')
      if (sameVideoUrl(episode.url, state.currentVideoUrl)) button.classList.add('active')
      const label = episode.label || `第${episode.index || ''}集`
      button.title = [episode.title || label, episode.subtitle].filter(Boolean).join(' · ') + (episode.vip ? '（VIP）' : '')
      button.innerHTML = `<span>${escapeHtml(label)}</span>${episode.vip ? '<i class="episode-vip">VIP</i>' : ''}`
      button.addEventListener('click', () => switchEpisode(episode))
      list.appendChild(button)
    }
    const active = list.querySelector('.episode-item.active')
    if (active) {
      // 横向列表居中当前集，不滚动整个页面
      list.scrollLeft = Math.max(0, active.offsetLeft - list.clientWidth / 2 + active.clientWidth / 2)
    } else if (currentIndex < 0) {
      list.scrollLeft = 0
    }
  }

  function setSeries(series, { render = true } = {}) {
    state.series = series && Array.isArray(series.episodes) && series.episodes.length ? series : null
    // 平台页标题有时要等页面渲染完才有；拿到选集后顺手把「剧名 + 集数」补进舞台标题和历史
    if (state.series && state.currentVideoUrl) {
      const index = seriesCurrentIndex(state.series, state.currentVideoUrl)
      const episode = index >= 0 ? state.series.episodes[index] : null
      if (episode) {
        const base =
          state.currentTitle && !episodeOf(state.currentTitle)
            ? state.currentTitle
            : state.currentTitle || state.series.title || ''
        const title = episodeOf(base) ? base : `${base} ${episode.label || ''}`.trim()
        if (!state.currentEpisode) state.currentEpisode = episode.label || ''
        if (title && title !== state.currentTitle) {
          state.currentTitle = title
          const lineName = currentLine()?.name || ''
          $('#stage-title-text').textContent = lineName ? `${title} · ${lineName}` : title
          window.desktop
            .updateHistory({ url: state.currentVideoUrl, title, episode: episode.label || '' })
            .then((history) => {
              state.config.history = history
              renderHistory()
            })
            .catch(() => {})
        }
      }
    }
    if (render) renderEpisodeBar()
  }

  function clearSeries() {
    state.series = null
    state.seriesLoading = false
    renderEpisodeBar()
  }

  function switchEpisode(episode) {
    if (!episode || !episode.url) return
    if (sameVideoUrl(episode.url, state.currentVideoUrl) && state.lastResult) {
      toast('已经是这一集了')
      return
    }
    const series = state.series
    const label = episode.label || `第${episode.index || ''}集`
    const title = series?.title ? `${series.title} ${label}` : episode.title || label
    $('#url-input').value = episode.url
    updateBadge()
    toast(`切换到 ${label}`)
    startParse({
      url: episode.url,
      lineId: state.currentLineId,
      title,
      episode: label,
      series,
    })
  }

  function seriesNav(delta) {
    const series = state.series
    if (!series || !series.episodes.length) {
      toast('还没有获取到选集列表', 'warn')
      return
    }
    const index = seriesCurrentIndex(series, state.currentVideoUrl)
    const target = index < 0 ? series.episodes[delta > 0 ? 0 : series.episodes.length - 1] : series.episodes[index + delta]
    if (!target) {
      toast(delta > 0 ? '已经是最后一集了' : '已经是第一集了', 'warn')
      return
    }
    switchEpisode(target)
  }

  async function collectSeriesHint(record) {
    const hint = {}
    if (!record) return hint
    try {
      const title = webviewTitle(record.webview)
      if (title) hint.title = title
    } catch {
      /* 忽略 */
    }
    if (record.key === 'iqiyi') {
      try {
        hint.tvid = await record.webview.executeJavaScript(
          `(() => {
            const status = window.playbackPageStageStatus || {}
            if (status._tvid) return String(status._tvid)
            if (status.playInfo && status.playInfo.tvid) return String(status.playInfo.tvid)
            const m = document.documentElement.innerHTML.match(/"tvid"\\s*:\\s*"?(\\d{6,})/)
            return m ? m[1] : ''
          })()`,
          true,
        )
      } catch {
        /* 页面里拿不到就交给主进程开隐藏页兜底 */
      }
    }
    return hint
  }

  async function requestSeries(url, { title = '', hint = {}, silent = false, force = false } = {}) {
    if (!url || !isHttpUrl(url)) return null
    const saved = force ? null : findSavedSeries(url)
    if (saved) {
      if (state.currentVideoUrl === url && (!state.series || state.series.seriesKey !== saved.seriesKey)) {
        setSeries(saved)
      }
      return saved
    }
    if (state.seriesPending.has(url)) return state.seriesPending.get(url)
    const task = (async () => {
      state.seriesLoading = true
      updateEpisodeBarShell()
      try {
        const result = await window.desktop.resolveSeries({ url, hint: { ...hint, title: hint.title || title } })
        if (!result?.ok) {
          if (!silent) toast(`获取选集失败：${result?.error || '未知原因'}`, 'warn', 5200)
          return null
        }
        saveSeries(result)
        if (state.currentVideoUrl === url) setSeries(result)
        return result
      } catch (error) {
        if (!silent) toast(`获取选集失败：${String(error?.message || error)}`, 'warn', 5200)
        return null
      } finally {
        state.seriesLoading = false
        state.seriesPending.delete(url)
        updateEpisodeBarShell()
      }
    })()
    state.seriesPending.set(url, task)
    return task
  }


  // ---------------------------------------------------------------------------
  // 播放区
  // ---------------------------------------------------------------------------

  function updateLayoutMode() {
    // 播放时让整个页面滚动：顶部的平台入口 / 链接栏会跟着滚走，
    // 不再固定占着高度把视频挡住。
    const playing = !$('#view-video').hidden || !$('#view-webview').hidden
    const enabled = playing && !state.browserOpen && !state.fullscreen
    document.body.classList.toggle('page-scroll', enabled)
  }

  function activePlayerView() {
    if (!$('#view-video').hidden) return 'video'
    if (!$('#view-webview').hidden) return 'webview'
    return ''
  }

  function isTypingTarget(target) {
    if (!target) return false
    const tag = String(target.tagName || '').toUpperCase()
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true
  }

  // 点「全屏」按钮后焦点会留在按钮上：这时按空格会再次触发这个按钮（表现为退出全屏），
  // 方向键也完全没反应。进全屏后主动把焦点从工具栏移走，交给播放器快捷键处理。
  function releaseToolbarFocus() {
    const active = document.activeElement
    if (!active || isTypingTarget(active)) return
    if (active === $('#video') || active === $('#parse-view')) return
    try {
      active.blur()
    } catch {
      /* 忽略 */
    }
  }

  function setView(name) {
    for (const id of ['empty', 'loading', 'error', 'video', 'webview']) {
      $(`#view-${id}`).hidden = id !== name
    }
    // 只有真正在播放时才给播放区留大高度；空/错/加载态不需要撑高
    $('#stage').classList.toggle('stage-playing', name === 'video' || name === 'webview')
    if (name === 'webview') startPlayerPolling()
    else stopPlayerPolling()
    updateLayoutMode()
  }

  // ---------------------------------------------------------------------------
  // 全屏（窗口铺满屏幕 + 影院模式隐藏工具栏）
  // ---------------------------------------------------------------------------

  function applyCinema(on) {
    state.fullscreen = Boolean(on)
    document.body.classList.toggle('cinema', state.fullscreen)
    updateLayoutMode()
    $('#btn-fullscreen').textContent = state.fullscreen ? '退出全屏' : '全屏'
    $('#btn-fullscreen').title = state.fullscreen ? '退出全屏（Esc / F11）' : '全屏（F11）'
    if (state.fullscreen) {
      setTimeout(releaseToolbarFocus, 50)
      setTimeout(releaseToolbarFocus, 320)
      if (!state.fullscreenHinted) {
        state.fullscreenHinted = true
        toast('空格 暂停/播放 · ← → 快退/快进 10 秒 · ↑ ↓ 音量 · Esc 退出全屏', 'info', 5600)
      }
    } else if (document.activeElement && document.activeElement.id === 'btn-fullscreen') {
      releaseToolbarFocus()
    }
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
    setDownloadButton()
    updateNativeButton()
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
    video.onended = () => {
      if (!state.autoNext) return
      if (state.series && seriesCurrentIndex(state.series, state.currentVideoUrl) < state.series.episodes.length - 1) {
        toast('本集播完，自动播放下一集', 'ok')
        seriesNav(1)
      }
    }
    applyResumeAndProgress(video)
  }

  // ---------------------------------------------------------------------------
  // 播放快捷键 / 网页解析页的进度与自动连播
  // ---------------------------------------------------------------------------

  function adjustNativeVideo(action) {
    const video = $('#video')
    if (!video) return false
    try {
      if (action === 'toggle') {
        if (video.paused || video.ended) video.play().catch(() => {})
        else video.pause()
      } else if (action === 'back') {
        video.currentTime = Math.max(0, (Number(video.currentTime) || 0) - 10)
      } else if (action === 'forward') {
        const duration = Number(video.duration)
        const target = (Number(video.currentTime) || 0) + 10
        video.currentTime = Number.isFinite(duration) && duration > 0 ? Math.min(duration - 0.5, target) : target
      } else if (action === 'volume-up') {
        video.muted = false
        video.volume = Math.min(1, (Number(video.volume) || 0) + 0.1)
        setStatus(`音量 ${Math.round(video.volume * 100)}%`)
      } else if (action === 'volume-down') {
        video.muted = false
        video.volume = Math.max(0, (Number(video.volume) || 1) - 0.1)
        setStatus(`音量 ${Math.round(video.volume * 100)}%`)
      } else if (action === 'mute') {
        video.muted = !video.muted
        setStatus(video.muted ? '已静音' : '已取消静音')
      } else {
        return false
      }
      return true
    } catch {
      return false
    }
  }

  function controlWebviewPlayer(action) {
    return window.desktop.playerCommand({ action }).catch(() => null)
  }

  // 网页解析线路把播放器放在 webview 里：焦点在页面里时由主进程拦截按键，
  // 焦点不在页面里时（比如刚点完「全屏」）由这里转发。
  function onPlayerKeydown(event) {
    if (event.defaultPrevented) return
    if (event.ctrlKey || event.altKey || event.metaKey) return
    if (state.browserOpen) return
    if (!$('#modal').hidden || !$('#search-modal').hidden) return
    if (document.querySelector('#guide-modal') && !$('#guide-modal').hidden) return
    if (isTypingTarget(event.target)) return
    const key = event.key
    if (key === 'Escape' || key === 'F11' || key === 'F5' || key === 'Tab') return
    const view = activePlayerView()
    if (!view) return
    let action = ''
    if (key === ' ' || key === 'Spacebar' || event.code === 'Space') action = 'toggle'
    else if (key === 'ArrowLeft') action = 'back'
    else if (key === 'ArrowRight') action = 'forward'
    else if (key === 'ArrowUp') action = 'volume-up'
    else if (key === 'ArrowDown') action = 'volume-down'
    else if (key === 'm' || key === 'M') action = 'mute'
    else return
    if (view === 'video') {
      // 焦点在 <video> 上时 Chromium 原生控件自己会处理这些键，别重复执行
      if (document.activeElement === $('#video')) return
      event.preventDefault()
      adjustNativeVideo(action)
      return
    }
    if (document.activeElement === $('#parse-view')) return
    event.preventDefault()
    controlWebviewPlayer(action)
  }

  function stopPlayerPolling() {
    if (!state.playerPollTimer) return
    clearInterval(state.playerPollTimer)
    state.playerPollTimer = null
  }

  function startPlayerPolling() {
    if (state.playerPollTimer) return
    state.playerPollTimer = setInterval(pollWebviewPlayer, 2500)
    setTimeout(pollWebviewPlayer, 800)
  }

  // 网页解析页的进度和「播完自动下一集」都要靠轮询拿：解析页不受我们控制，
  // 没法直接监听它的 video；主进程会在每一层 iframe 里装一个很小的桥。
  async function pollWebviewPlayer() {
    if (state.playerPollBusy) return
    if (state.browserOpen || $('#view-webview').hidden || !state.currentVideoUrl) return
    state.playerPollBusy = true
    let payload = null
    try {
      payload = await window.desktop.playerState()
    } catch {
      state.playerPollBusy = false
      return
    }
    state.playerPollBusy = false
    const video = payload?.video
    if (!video || !(video.d > 5)) return
    const now = Date.now()
    if (now - state.lastWebviewSave > 8000 && video.t > 3 && (!video.paused || Math.abs(video.t - state.lastWebviewProgress) > 1)) {
      state.lastWebviewSave = now
      state.lastWebviewProgress = video.t
      window.desktop
        .updateHistory({ url: state.currentVideoUrl, progress: video.t, duration: video.d })
        .then((history) => {
          state.config.history = history
          renderHistory()
        })
        .catch(() => {})
    }
    if (!video.ended || !state.autoNext) return
    if (state.autoNextHandledFor === state.currentVideoUrl) return
    const series = state.series
    if (!series || !Array.isArray(series.episodes) || !series.episodes.length) return
    const index = seriesCurrentIndex(series, state.currentVideoUrl)
    if (index < 0 || index >= series.episodes.length - 1) return
    state.autoNextHandledFor = state.currentVideoUrl
    toast('本集播放完毕，自动播放下一集', 'ok')
    // 如果解析页自己正处在网页全屏，先退出来再换集，否则新一集会卡在全屏层里
    try {
      if (document.fullscreenElement) document.exitFullscreen()?.catch?.(() => {})
    } catch {
      /* 忽略 */
    }
    controlWebviewPlayer('ack-ended')
    seriesNav(1)
  }

  // ---------------------------------------------------------------------------
  // 下载（离线观看）
  // ---------------------------------------------------------------------------

  function setDownloadButton() {
    const button = $('#btn-download')
    if (!button) return
    if (state.downloadRunning) {
      button.disabled = false
      button.textContent = `下载 ${state.downloadPercent || 0}%`
      button.title = '点击取消下载'
      return
    }
    const streamReady = state.lastResult?.kind === 'stream'
    button.textContent = '下载'
    button.disabled = !streamReady
    button.title = streamReady ? '下载本集（HLS 会合并成一个文件）' : '当前是网页解析线路，拿不到真实流地址，无法下载'
  }

  async function toggleDownload() {
    if (state.downloadRunning && state.downloadId) {
      await window.desktop.cancelDownload(state.downloadId)
      return
    }
    if (state.lastResult?.kind !== 'stream') {
      toast('当前是网页解析线路（第三方解析页），拿不到真实流地址，无法下载；可换到接口/芒果原生线路再试', 'warn', 5200)
      return
    }
    const title =
      state.currentTitle ||
      (state.series?.title ? `${state.series.title} ${state.currentEpisode || ''}`.trim() : '') ||
      ''
    const result = await window.desktop.downloadCurrent({ title })
    if (!result?.ok) {
      toast(`下载失败：${result?.error || '未知原因'}`, 'error', 5200)
      return
    }
    if (state.finishedDownloads.has(result.id)) {
      // 任务可能在 IPC 返回之前就已经失败/完成（例如目录没权限）
      setDownloadButton()
      return
    }
    state.downloadId = result.id
    state.downloadRunning = true
    state.downloadPercent = 0
    setDownloadButton()
    toast('开始下载，进度会显示在「下载」按钮上，点击按钮可取消', 'ok', 4200)
  }

  function onDownloadState(update) {
    if (!update || (state.downloadId && update.id !== state.downloadId && update.status === 'running')) return
    if (update.id && !state.downloadId && update.status === 'running') state.downloadId = update.id
    if (update.id !== state.downloadId) return
    if (update.status === 'running') {
      state.downloadRunning = true
      state.downloadPercent = Number(update.percent) || 0
      setDownloadButton()
      return
    }
    state.downloadRunning = false
    state.downloadPercent = 0
    state.finishedDownloads.set(update.id, update.status)
    if (state.finishedDownloads.size > 30) {
      const first = state.finishedDownloads.keys().next().value
      state.finishedDownloads.delete(first)
    }
    setDownloadButton()
    if (update.status === 'done') {
      toast(`已下载：${update.savedPath}`, 'ok', 9000)
    } else if (update.status === 'cancelled') {
      toast('已取消下载')
    } else if (update.status === 'failed') {
      toast(`下载失败：${update.error || '未知原因'}`, 'error', 6000)
    }
    state.downloadId = ''
  }

  // ---------------------------------------------------------------------------
  // 平台原生取流（实验）
  // ---------------------------------------------------------------------------

  function nativeLineFor(url) {
    const platform = detectPlatform(url)
    if (!platform) return null
    const natives = (state.config?.lines || []).filter((line) => line.kind === 'native')
    return natives.find((line) => line.platform === platform) || null
  }

  function updateNativeButton() {
    const button = $('#btn-native')
    if (!button) return
    const line = nativeLineFor(state.currentVideoUrl)
    // 实验功能：只有在「线路管理」里启用了原生取流线路才显示按钮，避免普通用户误点
    button.hidden = !line || line.enabled === false
    button.disabled = !line || state.running
    button.title = line
      ? `用「${line.name}」打开平台原片页，抓它自己的播放流；免费内容可用，会员 DRM 内容会自动失败`
      : ''
  }

  async function tryNative() {
    const line = nativeLineFor(state.currentVideoUrl)
    if (!line) {
      toast('这个平台还没有原生取流线路', 'warn')
      return
    }
    toast('正在平台原片页里抓真实播放流，通常需要 5–15 秒…', 'ok', 4200)
    startParse({
      url: state.currentVideoUrl,
      lineId: line.id,
      chain: false,
      title: state.currentTitle,
      series: state.series,
    })
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
    const isDead = (line) => state.lineHealth[line.id]?.ok === false
    // 体检失效的线路不删除，只排到最后：接口可能只是临时抽风，真到那一步还会再试。
    const ordered = [...enabled.filter((line) => !isDead(line)), ...enabled.filter(isDead)]
    const matching = platformKey ? ordered.filter((line) => line.platform === platformKey) : []
    // 平台专属线路（例如芒果TV 原生解析）优先，但尽量别从已失效的那条开始
    const primary = matching[0] || ordered.find((line) => line.id === primaryId) || ordered[0]
    const chain = [primary, ...ordered.filter((line) => line.id !== primary.id)]
    return state.config?.autoFallback === false ? [primary] : chain
  }

  function clearRunWatchdog() {
    if (state.runWatchdog) clearTimeout(state.runWatchdog)
    state.runWatchdog = null
    $('#btn-parse').classList.remove('busy')
  }

  async function startParse({ lineId, url, chain = true, resume = 0, title = '', episode = '', series } = {}) {
    if (state.browserOpen) hideBrowser({ mute: true })
    // 换集 / 换线路前先退出视频自己的网页全屏，避免新画面被全屏层盖住
    try {
      if (document.fullscreenElement) document.exitFullscreen()?.catch?.(() => {})
    } catch {
      /* 忽略 */
    }
    if (state.running) {
      state.runToken += 1
      stopPlayback()
    }
    state.resumeAt = Number(resume) || 0
    state.autoNextHandledFor = ''
    state.lastWebviewSave = 0
    state.lastWebviewProgress = 0
    state.currentTitle = cleanTitle(title)
    state.currentEpisode = episode || episodeOf(state.currentTitle)
    const videoUrl = normalizeUrlText(url || $('#url-input').value)
    if (!isHttpUrl(videoUrl)) {
      toast('请先粘贴完整的视频链接（http/https）', 'warn')
      $('#url-input').focus()
      return
    }
    // 切集时把已知选集带过来；手动换链接则用缓存里对应的那一份。
    state.series = series || findSavedSeries(videoUrl) || null
    renderEpisodeBar()
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
    state.lastResult = null
    setDownloadButton()
    updateNativeButton()
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
    setDownloadButton()
    updateNativeButton()
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
    // 选集条：已有同一部剧的列表就直接高亮当前集；没有就在后台向平台要一份。
    if (state.series && state.series.episodes.some((item) => sameVideoUrl(item.url, state.currentVideoUrl))) {
      renderEpisodeBar()
    } else if (state.series) {
      state.series = null
      renderEpisodeBar()
    }
    if (!state.series) {
      requestSeries(state.currentVideoUrl, { title, silent: true })
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
    const scrollTop = list.scrollTop
    const lines = state.config?.lines || []
    list.innerHTML = ''
    if (!lines.length) {
      list.innerHTML = '<li class="empty-row">还没有线路，点击「线路管理」添加。</li>'
      return
    }
    $('#btn-toggle-dead')?.classList.toggle('active', state.hideDeadLines)
    let hidden = 0
    for (const line of lines) {
      const status = state.lineStatus[line.id]
      const dead = Boolean(status && status.ok === false)
      if (state.hideDeadLines && dead && line.id !== state.currentLineId) {
        hidden += 1
        continue
      }
      const item = document.createElement('li')
      item.className = 'line-item'
      if (line.id === state.currentLineId) item.classList.add('active')
      if (!line.enabled) item.classList.add('disabled')
      if (dead) item.classList.add('dead')
      item.dataset.id = line.id
      item.innerHTML = `
        <span class="line-state ${status ? (status.ok ? 'ok' : 'fail') : ''}"></span>
        <span class="line-name" title="${escapeHtml(`${line.url || ''}${status?.note ? `\n${status.note}` : ''}`)}">${escapeHtml(line.name)}</span>
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
    if (hidden) {
      const note = document.createElement('li')
      note.className = 'empty-row'
      note.textContent = `已隐藏 ${hidden} 条体检失效的线路（点「隐藏失效」可恢复显示）`
      list.appendChild(note)
    }
    list.scrollTop = scrollTop
  }

  async function runLineHealthCheck({ silent = true } = {}) {
    if (state.lineHealthRunning) return
    state.lineHealthRunning = true
    const button = $('#btn-test-all')
    if (!silent) {
      button.disabled = true
      button.textContent = '测速中'
      setStatus('正在体检线路…')
    }
    try {
      const result = await window.desktop.testLines({
        url: state.currentVideoUrl || '',
        platformSamples: true,
        ids: (state.config.lines || []).filter((line) => line.enabled).map((line) => line.id),
      })
      const now = Date.now()
      const merged = { ...state.lineHealth }
      let okCount = 0
      let failCount = 0
      for (const [id, status] of Object.entries(result || {})) {
        if (!status) continue
        if (/仅用于/.test(String(status.note || ''))) continue
        merged[id] = {
          ok: Boolean(status.ok),
          ms: Number(status.ms) || 0,
          note: String(status.note || '').slice(0, 120),
          at: now,
        }
        if (status.ok) okCount += 1
        else failCount += 1
      }
      state.lineHealth = merged
      for (const [id, health] of Object.entries(merged)) {
        state.lineStatus[id] = { ok: health.ok, ms: health.ms, note: health.note, at: health.at }
      }
      renderLineList()
      state.config = await window.desktop.saveSettings({ lineHealth: merged })
      setStatus(`线路体检完成：${okCount} 条可用${failCount ? `，${failCount} 条失效` : ''}`)
      if (!silent) {
        toast(`测速完成：${okCount} 条可用${failCount ? `，${failCount} 条失效` : ''}`, failCount ? 'warn' : 'ok')
      }
    } catch (error) {
      if (!silent) toast(`测速失败：${String(error?.message || error)}`, 'error')
    } finally {
      state.lineHealthRunning = false
      if (!silent) {
        button.disabled = false
        button.textContent = '测速'
      }
    }
  }

  function historyPlatformInfo(item) {
    const byUrl = platformInfo(detectPlatform(item.url))
    if (byUrl) return byUrl
    const key = String(item.platform || '')
    return PLATFORMS.find((platform) => platform.key === key || platform.name === key) || null
  }

  function createHistoryItem(item) {
    const platform = historyPlatformInfo(item)
    const title = cleanTitle(item.title) || ''
    const episode = item.episode || episodeOf(title)
    const percent =
      item.duration > 5 ? Math.max(0, Math.min(100, Math.round((item.progress / item.duration) * 100))) : 0
    const resumable = percent >= 1 && percent < 96
    const li = document.createElement('li')
    li.className = 'history-item'
    if (resumable) li.classList.add('resumable')
    const fallbackName = platform?.name || '视频'
    li.innerHTML = `
      <div class="history-top">
        <span class="history-title" title="${escapeHtml(item.url)}">${escapeHtml(
          title || `${fallbackName} · 未命名视频`,
        )}</span>
        <span class="history-time">${timeAgo(item.at)}</span>
      </div>
      <div class="history-meta">
        ${platform ? `<span class="history-platform" style="color:${platform.color}">${escapeHtml(platform.name)}</span>` : ''}
        ${episode ? `<span class="history-episode">${escapeHtml(episode)}</span>` : ''}
        <span class="history-line">${escapeHtml(item.lineName || '')}</span>
        ${resumable ? '<span class="history-resume">继续</span>' : ''}
        ${percent ? `<span class="history-percent">已看 ${percent}%</span>` : ''}
      </div>
      ${percent ? `<div class="history-progress"><i style="width:${percent}%"></i></div>` : ''}
      ${title ? '' : `<div class="history-url" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</div>`}
      <button class="history-del" title="删除这部作品的记录">×</button>
    `
    li.addEventListener('click', () => {
      $('#url-input').value = item.url
      updateBadge()
      state.currentLineId = item.lineId || state.currentLineId
      startParse({
        url: item.url,
        lineId: item.lineId,
        resume: item.progress || 0,
        title: [title, episode].filter(Boolean).join(' '),
        episode,
        series: findSavedSeries(item.url),
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
    return li
  }

  function renderHistory() {
    const list = $('#history-list')
    if (!list) return
    const scrollTop = list.scrollTop
    const history = state.config?.history || []
    const mode = state.historySort || 'recent'
    const query = String(state.historyQuery || '').trim().toLowerCase()
    const filtered = history.filter((item) => {
      if (!query) return true
      const platform = platformInfo(detectPlatform(item.url))
      const haystack = [item.title, item.episode, item.platform, platform?.name, item.lineName, item.url]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(query)
    })
    list.innerHTML = ''
    const legend = $('#history-legend')
    if (legend) legend.textContent = history.length ? `${filtered.length}/${history.length} 部` : ''
    if ($('#history-sort')) $('#history-sort').value = mode
    if (!history.length) {
      list.innerHTML =
        '<li class="empty-row">还没有观看记录。每部剧只记一条：最近看到第几集、看到百分之多少，点一下就能接着看。</li>'
      return
    }
    if (!filtered.length) {
      list.innerHTML = '<li class="empty-row">没有匹配的历史记录，换个关键词试试。</li>'
      return
    }

    if (mode === 'grouped') {
      // 一部剧只有一条记录，分组按平台更有用
      const groups = new Map()
      for (const item of filtered) {
        const platform = historyPlatformInfo(item)
        const key = platform?.key || 'other'
        if (!groups.has(key)) groups.set(key, { key, name: platform?.name || '其它平台', platform, items: [] })
        groups.get(key).items.push(item)
      }
      const ordered = [...groups.values()].sort(
        (left, right) => Math.max(...right.items.map((item) => item.at || 0)) - Math.max(...left.items.map((item) => item.at || 0)),
      )
      for (const group of ordered) {
        const li = document.createElement('li')
        li.className = 'history-group'
        if (state.historyCollapsed.has(group.key)) li.classList.add('collapsed')
        group.items.sort((left, right) => (right.at || 0) - (left.at || 0))
        const head = document.createElement('div')
        head.className = 'history-group-head'
        head.innerHTML = `<b title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</b><span>${group.items.length} 部</span>`
        head.addEventListener('click', () => {
          if (state.historyCollapsed.has(group.key)) state.historyCollapsed.delete(group.key)
          else state.historyCollapsed.add(group.key)
          localStorage.setItem('csp.historyCollapsed', JSON.stringify([...state.historyCollapsed]))
          renderHistory()
        })
        const box = document.createElement('div')
        box.className = 'history-group-items'
        for (const item of group.items) box.appendChild(createHistoryItem(item))
        li.appendChild(head)
        li.appendChild(box)
        list.appendChild(li)
      }
    } else {
      const items = [...filtered]
      if (mode === 'continue') {
        const isResumable = (item) => {
          const percent = item.duration > 5 ? (item.progress / item.duration) * 100 : 0
          return percent >= 1 && percent < 96
        }
        items.sort((left, right) => {
          const leftResume = isResumable(left) ? 1 : 0
          const rightResume = isResumable(right) ? 1 : 0
          if (leftResume !== rightResume) return rightResume - leftResume
          return (right.at || 0) - (left.at || 0)
        })
      }
      for (const item of items) list.appendChild(createHistoryItem(item))
    }
    list.scrollTop = scrollTop
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

  // ---------------------------------------------------------------------------
  // 图文教程
  // ---------------------------------------------------------------------------

  function openGuide(section = 'intro') {
    const modal = $('#guide-modal')
    if (!modal) return
    modal.hidden = false
    setGuideSection(section)
    setTimeout(() => setGuideSection(section), 40)
    try {
      $('#guide-close').focus()
    } catch {
      /* 忽略 */
    }
  }

  function closeGuide() {
    const modal = $('#guide-modal')
    if (!modal) return
    modal.hidden = true
  }

  function setGuideSection(id) {
    const content = $('#guide-content')
    const target = document.getElementById(`guide-${id}`)
    if (!content || !target) return
    const top = target.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop
    content.scrollTo({ top: Math.max(0, top - 4), behavior: 'smooth' })
    $$('#guide-nav button[data-guide]').forEach((button) => {
      button.classList.toggle('active', button.dataset.guide === id)
    })
  }

  function syncGuideNav() {
    const content = $('#guide-content')
    if (!content) return
    const sections = $$('#guide-content .guide-section')
    if (!sections.length) return
    const marker = content.scrollTop + 48
    let current = sections[0].id.replace(/^guide-/, '')
    for (const section of sections) {
      const top = section.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop
      if (top <= marker) current = section.id.replace(/^guide-/, '')
    }
    $$('#guide-nav button[data-guide]').forEach((button) => {
      button.classList.toggle('active', button.dataset.guide === current)
    })
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
      $('#set-auto-line-test').checked = state.config.autoLineTest !== false
    }
    if (tab === 'about') {
      $('#about-version').textContent = state.info?.version || '-'
    }
  }

  const LINE_KINDS = [
    { value: 'page', label: '网页' },
    { value: 'api', label: '接口' },
    { value: 'mgtv', label: '芒果内置' },
    { value: 'native', label: '原生取流' },
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
        <input type="text" class="line-url" value="${escapeHtml(line.url || '')}" placeholder="https://jx.example.com/?url={url}" spellcheck="false" ${['direct', 'mgtv', 'native'].includes(line.kind) ? 'disabled' : ''} />
        <button class="row-btn line-test" title="用示例链接测一下">测试</button>
        <button class="row-btn line-del" title="删除">删除</button>
        <div class="row-note">${escapeHtml(line.note || '')}</div>
      `
      row.querySelector('.line-kind').addEventListener('change', (event) => {
        const kind = event.target.value
        const urlInput = row.querySelector('.line-url')
        if (['direct', 'mgtv', 'native'].includes(kind)) {
          urlInput.value = kind === 'direct' ? 'direct://video' : kind === 'mgtv' ? 'mgtv://auto' : 'native://auto'
          urlInput.disabled = true
        } else {
          urlInput.disabled = false
          if (['direct://video', 'mgtv://auto', 'native://auto'].includes(urlInput.value)) urlInput.value = ''
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
    if (line.kind === 'native' && !line.url) line.url = 'native://auto'
    if (line.kind === 'native' && !line.platform) {
      const name = `${line.name || ''} ${line.note || ''}`
      const pairs = [
        ['爱奇艺', 'iqiyi'],
        ['腾讯|qq', 'qq'],
        ['优酷|youku', 'youku'],
        ['芒果|mgtv', 'mgtv'],
      ]
      const hit = pairs.find(([pattern]) => new RegExp(pattern, 'i').test(name))
      line.platform = hit ? hit[1] : ''
    }
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

  const SEARCH_LINK_PATTERNS = {
    iqiyi: /^https?:\/\/(www\.)?iqiyi\.com\/(v_|a_)[A-Za-z0-9]+\.html/i,
    qq: /^https?:\/\/v\.qq\.com\/x\/(cover|page)\//i,
    youku: /^https?:\/\/v\.youku\.com\/v_show\/id_[A-Za-z0-9=]+\.html/i,
    mgtv: /^https?:\/\/(www\.)?mgtv\.com\/b\/\d+\//i,
  }

  const SEARCH_PAGE_MATCH = {
    iqiyi: /iqiyi\.com\/(so\/|search)/i,
    qq: /v\.qq\.com\/x\/search/i,
    youku: /(so\.youku\.com\/search|search\.youku\.com)/i,
    mgtv: /so\.mgtv\.com\/so/i,
  }

  function searchScrapeScript(key) {
    return `(() => {
      const pattern = ${SEARCH_LINK_PATTERNS[key] || '/a^/'}
      const out = []
      const seen = new Set()
      const normalize = (href) => {
        try {
          const url = new URL(href, location.href)
          if (/redirect\\.html/i.test(url.pathname)) {
            const inner = url.searchParams.get('url')
            if (inner) return new URL(inner).href
          }
          return url.href
        } catch (error) {
          return ''
        }
      }
      const pickTitle = (anchor) => {
        const card = anchor.closest('li,[class*=item],[class*=card],[class*=result],[class*=Item]') || anchor
        const titleNode = card.querySelector('h1,h2,h3,[class*=title],[class*=Title],[class*=name],[class*=Name]')
        let text = (titleNode && titleNode.innerText || anchor.innerText || anchor.getAttribute('title') || '').replace(/\\s+/g, ' ').trim()
        if (!text) {
          const lines = String(card.innerText || '').split('\\n').map((line) => line.trim()).filter(Boolean)
          text = lines.find((line) => line.length >= 2 && line.length <= 40 && !/^(\\d{4}|\\d+集全|更新至|VIP|会员|预告|花絮|详细|立即播放)/.test(line)) || lines[0] || ''
        }
        return text.replace(/^(更新至|全|共)\\s*\\d+\\s*(集|期|话)?\\s*/, '').trim().slice(0, 60)
      }
      for (const anchor of document.querySelectorAll('a[href]')) {
        const href = normalize(anchor.href)
        if (!href || !pattern.test(href)) continue
        const clean = href.split('#')[0]
        const base = clean.split('?')[0]
        if (seen.has(base)) continue
        seen.add(base)
        const title = pickTitle(anchor)
        if (!title) continue
        out.push({ url: clean, title, base })
        if (out.length >= 12) break
      }
      return { results: out, title: document.title, text: String(document.body ? document.body.innerText : '').slice(0, 200) }
    })()`
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  async function scrapeSearchPlatform(key, query) {
    const record = ensureBrowser(key)
    const meta = browserMeta(key)
    if (!record) return { key, results: [], error: '无法初始化平台页面' }
    const target = SEARCH_URLS[key]?.(query) || ''
    if (!target) return { key, results: [], error: '这个平台暂不支持搜索' }
    let previous = ''
    try {
      previous = record.webview.getURL() || ''
    } catch {
      /* 忽略 */
    }
    let value = null
    try {
      record.webview.src = target
      // 等真正跳到搜索页（平台可能先加载首页并重定向），再给渲染留一点时间
      const matcher = SEARCH_PAGE_MATCH[key]
      const started = Date.now()
      while (Date.now() - started < 12000) {
        let current = ''
        try {
          current = record.webview.getURL() || ''
        } catch {
          /* 忽略 */
        }
        if (current && matcher && matcher.test(current)) break
        await sleep(300)
      }
      await sleep(5000)
      try {
        value = await record.webview.executeJavaScript(searchScrapeScript(key), true)
      } catch {
        value = null
      }
    } catch {
      /* 忽略 */
    }
    // 抓完结果后把平台页面还原，避免用户下次点卡片时莫名其妙停在搜索页
    const active = state.browserOpen && state.browserKey === key
    if (!active && previous && !/^about:blank/i.test(previous)) {
      try {
        record.webview.src = previous
      } catch {
        /* 忽略 */
      }
    }
    let results = Array.isArray(value?.results) ? value.results : []
    let error = ''
    const normalizedQuery = String(query || '').replace(/\s+/g, '')
    if (normalizedQuery && results.length) {
      const relevant = results.filter((item) => {
        const title = String(item.title || '').replace(/\s+/g, '')
        if (!title) return false
        return title.includes(normalizedQuery) || normalizedQuery.includes(title.slice(0, Math.min(4, title.length)))
      })
      if (relevant.length) results = relevant
      else {
        results = []
        error = `没有找到与「${query}」相关的${meta?.name || ''}条目`
      }
    }
    if (!results.length && !error) {
      const text = `${value?.title || ''} ${value?.text || ''}`
      if (/验证|安全验证|captcha|滑动|机器人/i.test(text)) error = '平台要求人机验证，请点「打开平台页」手动搜索'
      else if (/登录|登录后查看/i.test(text)) error = '平台要求登录，请先在平台页登录'
      else error = '没有抓到结果，可能页面结构变了'
    }
    return { key, name: meta?.name || key, queries: { query, pageUrl: target }, results, error }
  }

  function renderSearchResults(groups, query) {
    const box = $('#search-results')
    box.hidden = false
    box.innerHTML = ''
    for (const group of groups) {
      const wrap = document.createElement('div')
      wrap.className = 'search-group'
      const head = document.createElement('div')
      head.className = 'search-group-head'
      const meta = browserMeta(group.key)
      head.innerHTML = `<img src="${meta?.icon || 'assets/app-icon.png'}" alt="" /><b>${escapeHtml(group.name)}</b><span>${
        group.error ? '未获取到' : `${group.results.length} 条`
      }</span>`
      const openButton = document.createElement('button')
      openButton.className = 'search-open-page'
      openButton.textContent = '打开平台页'
      openButton.addEventListener('click', () => {
        closeSearchModal()
        openBrowser(group.key, { url: group.queries.pageUrl })
      })
      head.appendChild(openButton)
      wrap.appendChild(head)
      const items = document.createElement('div')
      items.className = 'search-group-items'
      if (group.error) {
        const error = document.createElement('div')
        error.className = 'search-error'
        error.textContent = group.error
        items.appendChild(error)
      }
      for (const result of group.results) {
        const button = document.createElement('button')
        button.className = 'search-result'
        button.title = result.url
        const isEpisode = Boolean(detectVideoPlatform(result.url))
        button.innerHTML = `${escapeHtml(result.title)}<small>${isEpisode ? '单集 · 点击直接解析' : '剧集页 · 点击打开选集'}</small>`
        button.addEventListener('click', () => {
          closeSearchModal()
          if (isEpisode) {
            $('#url-input').value = result.url
            updateBadge()
            startParse({ url: result.url, title: result.title, episode: episodeOf(result.title) })
            toast(`正在解析「${result.title}」`, 'ok')
          } else {
            openBrowser(group.key, { url: result.url })
            toast('已打开剧集页，点「选集」里的任意一集即可播放', 'ok', 5000)
          }
        })
        items.appendChild(button)
      }
      wrap.appendChild(items)
      box.appendChild(wrap)
    }
    $('#search-status').hidden = false
    const total = groups.reduce((sum, group) => sum + group.results.length, 0)
    $('#search-status').textContent = total
      ? `共找到 ${total} 条结果 · 点击结果直接播放或打开剧集页`
      : '没有聚合结果，可以点各平台标题右侧的「打开平台页」手动搜索'
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
    button.textContent = '搜索中…'
    $('#search-results').hidden = true
    $('#search-results').innerHTML = ''
    $('#search-status').hidden = false
    $('#search-status').textContent = `正在 ${picked.map((key) => browserMeta(key)?.name || key).join('、')} 搜索「${query}」…`
    try {
      const groups = []
      const queue = picked.slice()
      const worker = async () => {
        while (queue.length) {
          const key = queue.shift()
          if (!key) return
          try {
            groups.push(await scrapeSearchPlatform(key, query))
          } catch (error) {
            groups.push({ key, name: browserMeta(key)?.name || key, results: [], error: String(error?.message || error) })
          }
        }
      }
      await Promise.all([worker(), worker()])
      groups.sort((left, right) => picked.indexOf(left.key) - picked.indexOf(right.key))
      renderSearchResults(groups, query)
    } catch (error) {
      toast(`聚合搜索失败：${String(error?.message || error)}`, 'error')
    } finally {
      button.disabled = false
      button.textContent = '聚合搜索'
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
      const value = event.target.checked
      setAutoParseEnabled(state.browserKey, value)
      toast(
        `${browserMeta(state.browserKey)?.name || '当前平台'}：${value ? '已开启点集自动解析' : '已关闭自动解析'}`,
      )
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
      const record = state.browsers.get(state.browserKey)
      hideBrowser({ mute: true })
      startParse({ url, title, episode: episodeOf(title) })
      collectSeriesHint(record).then((hint) => requestSeries(url, { title, hint }))
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
    $('#btn-native').addEventListener('click', () => tryNative())
    $('#btn-download').addEventListener('click', () => toggleDownload())
    $('#btn-open-downloads').addEventListener('click', () => window.desktop.openDownloadFolder())
    $('#btn-open-web').addEventListener('click', () => {
      const target = state.currentVideoUrl || $('#url-input').value
      if (isHttpUrl(target)) window.desktop.openExternal(target)
      else toast('还没有可打开的链接', 'warn')
    })
    $('#btn-fullscreen').addEventListener('click', () => toggleFullscreen())

    // 选集条
    $('#episode-prev').addEventListener('click', () => seriesNav(-1))
    $('#episode-next').addEventListener('click', () => seriesNav(1))
    $('#episode-order').addEventListener('click', () => {
      state.seriesOrder = state.seriesOrder === 'asc' ? 'desc' : 'asc'
      localStorage.setItem('csp.episodeOrder', state.seriesOrder)
      renderEpisodeBar()
    })
    $('#episode-toggle').addEventListener('click', () => {
      state.seriesCollapsed = !state.seriesCollapsed
      localStorage.setItem('csp.episodeCollapsed', state.seriesCollapsed ? '1' : '0')
      renderEpisodeBar()
    })
    $('#episode-auto-next').addEventListener('change', (event) => {
      state.autoNext = event.target.checked
      localStorage.setItem('csp.autoNext', state.autoNext ? '1' : '0')
      toast(state.autoNext ? '已开启：本集播完自动下一集' : '已关闭自动连播')
    })
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
    $('#btn-test-all').addEventListener('click', () => runLineHealthCheck({ silent: false }))
    $('#btn-toggle-dead').addEventListener('click', () => {
      state.hideDeadLines = !state.hideDeadLines
      localStorage.setItem('csp.hideDeadLines', state.hideDeadLines ? '1' : '0')
      renderLineList()
      toast(state.hideDeadLines ? '已隐藏体检失效的线路' : '已显示全部线路')
    })

    $('#btn-clear-history').addEventListener('click', async () => {
      state.config.history = await window.desktop.clearHistory()
      renderHistory()
      toast('已清空解析记录')
    })

    $('#history-sort').addEventListener('change', (event) => {
      state.historySort = ['recent', 'continue', 'grouped'].includes(event.target.value) ? event.target.value : 'recent'
      localStorage.setItem('csp.historySort', state.historySort)
      renderHistory()
    })
    $('#history-search-input').addEventListener('input', (event) => {
      state.historyQuery = event.target.value
      $('#history-search-clear').hidden = !event.target.value
      renderHistory()
    })
    $('#history-search-clear').addEventListener('click', () => {
      state.historyQuery = ''
      $('#history-search-input').value = ''
      $('#history-search-clear').hidden = true
      renderHistory()
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

    // 清理体检失效的线路
    $('#btn-clean-lines').addEventListener('click', async () => {
      const dead = (state.config.lines || []).filter((line) => state.lineHealth[line.id]?.ok === false)
      if (!dead.length) {
        toast('还没有体检失效的线路，先点侧栏「测速」或等启动体检完成', 'warn')
        return
      }
      const names = dead.map((line) => line.name).join('、')
      if (!window.confirm(`确定删除 ${dead.length} 条体检失效的线路吗？\n\n${names}\n\n删错了可以点「恢复内置线路」，自己添加的线路需要重新添加。`)) return
      const keep = (state.config.lines || []).filter((line) => state.lineHealth[line.id]?.ok !== false)
      if (!keep.length) {
        toast('全部线路都被标记失效了，已保留最后一条，请先测速确认', 'warn')
        return
      }
      try {
        state.config = await window.desktop.saveLines(keep, keep.some((line) => line.id === state.currentLineId) ? state.currentLineId : keep[0].id)
        state.draftLines = state.config.lines.map((line) => ({ ...line }))
        renderLineSelect()
        renderLineList()
        renderLineEditor()
        toast(`已清理 ${dead.length} 条失效线路`, 'ok')
      } catch (error) {
        toast(`清理失败：${String(error?.message || error)}`, 'error')
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
    $('#set-auto-line-test').addEventListener('change', async (event) => {
      state.config = await window.desktop.saveSettings({ autoLineTest: event.target.checked })
      toast(event.target.checked ? '已开启启动时线路体检' : '已关闭启动时线路体检')
      if (event.target.checked) runLineHealthCheck({ silent: true })
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
    // 关于 / 图文教程
    $('#btn-guide').addEventListener('click', () => openGuide('intro'))
    $('#btn-empty-guide').addEventListener('click', () => openGuide('intro'))
    $('#btn-about-guide').addEventListener('click', () => {
      closeModal()
      openGuide('intro')
    })
    $('#guide-close').addEventListener('click', closeGuide)
    $('#guide-modal').addEventListener('click', (event) => {
      if (event.target === event.currentTarget) closeGuide()
    })
    $('#guide-nav').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-guide]')
      if (!button) return
      setGuideSection(button.dataset.guide)
    })
    $('#guide-content').addEventListener('scroll', () => {
      if (state.guideNavTimer) return
      state.guideNavTimer = requestAnimationFrame(() => {
        state.guideNavTimer = 0
        syncGuideNav()
      })
    })

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
      // 播放器自己处于网页全屏时，Esc 先退出视频全屏（不直接退出软件影院模式）
      if (event.key === 'Escape' && document.fullscreenElement) {
        event.preventDefault()
        try {
          document.exitFullscreen()?.catch?.(() => {})
        } catch {
          /* 忽略 */
        }
        return
      }
      if (event.key === 'Escape') {
        const guide = document.querySelector('#guide-modal')
        if (guide && !guide.hidden) {
          event.preventDefault()
          closeGuide()
          return
        }
      }
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

    // 播放器快捷键：空格暂停/播放、←/→ 快退快进、↑/↓ 音量、M 静音。
    // 全屏后焦点常常不在播放器上，这里兜底；网页解析线路会转发给主进程处理。
    document.addEventListener('keydown', onPlayerKeydown)

    // 选集快捷键：Ctrl+← / Ctrl+→ 切上一集/下一集，[ ] 同样可用
    document.addEventListener('keydown', (event) => {
      if (!state.series || state.browserOpen) return
      if (!$('#modal').hidden || !$('#search-modal').hidden) return
      const target = event.target
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      const next = (event.ctrlKey && event.key === 'ArrowRight') || (!event.ctrlKey && event.key === ']')
      const prev = (event.ctrlKey && event.key === 'ArrowLeft') || (!event.ctrlKey && event.key === '[')
      if (!next && !prev) return
      event.preventDefault()
      seriesNav(next ? 1 : -1)
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
    window.desktop.onReload(() => {
      if (state.browserOpen) {
        try {
          state.browsers.get(state.browserKey)?.webview.reload()
        } catch {
          /* 忽略 */
        }
        return
      }
      $('#btn-reload').click()
    })
    window.desktop.onCloseBrowser?.(() => hideBrowser())
    window.desktop.onCloseBrowserTab?.((payload = {}) => {
      const key = payload.key || state.browserKey
      if (key && state.browsers.has(key)) closeBrowserTab(key)
    })
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
    window.desktop.onDownloadState?.(onDownloadState)

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
      state.seriesOrder = localStorage.getItem('csp.episodeOrder') === 'desc' ? 'desc' : 'asc'
      state.seriesCollapsed = localStorage.getItem('csp.episodeCollapsed') === '1'
      state.autoNext = localStorage.getItem('csp.autoNext') !== '0'
      $('#episode-auto-next').checked = state.autoNext
      state.historySort = ['recent', 'continue', 'grouped'].includes(localStorage.getItem('csp.historySort'))
        ? localStorage.getItem('csp.historySort')
        : 'recent'
      try {
        const collapsed = JSON.parse(localStorage.getItem('csp.historyCollapsed') || '[]')
        state.historyCollapsed = new Set(Array.isArray(collapsed) ? collapsed.slice(0, 50) : [])
      } catch {
        state.historyCollapsed = new Set()
      }
      state.lineHealth = state.config.lineHealth && typeof state.config.lineHealth === 'object' ? state.config.lineHealth : {}
      for (const [id, health] of Object.entries(state.lineHealth)) {
        if (health && typeof health === 'object') {
          state.lineStatus[id] = { ok: Boolean(health.ok), ms: Number(health.ms) || 0, note: health.note || '', at: health.at || 0 }
        }
      }
      state.hideDeadLines = localStorage.getItem('csp.hideDeadLines') === '1'
      if (state.config.autoLineTest !== false) {
        setTimeout(() => runLineHealthCheck({ silent: true }), 8000)
      }
      bindEvents()
      bindWebviewEvents()
      renderLineSelect()
      renderLineList()
      renderHistory()
      setDownloadButton()
      updateNativeButton()
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
        showSeries: (series) => {
          if (series) saveSeries(series)
          setSeries(series)
        },
        getSeries: () => state.series,
        seriesNav,
        switchEpisode,
        requestSeries,
        setDownloadButton,
        updateNativeButton,
      }
    } catch (error) {
      console.error(error?.stack || error)
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
