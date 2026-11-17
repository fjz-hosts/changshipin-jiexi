(() => {
  'use strict'

  const META = {
    iqiyi: {
      name: '爱奇艺',
      color: '#00d95f',
      home: 'https://www.iqiyi.com/',
      icon: 'assets/platform-iqiyi.png',
      search: (q) => `https://so.iqiyi.com/so/q_${encodeURIComponent(q)}`,
    },
    qq: {
      name: '腾讯视频',
      color: '#2b8cff',
      home: 'https://v.qq.com/',
      icon: 'assets/platform-qq.png',
      search: (q) => `https://v.qq.com/x/search/?q=${encodeURIComponent(q)}`,
    },
    youku: {
      name: '优酷',
      color: '#35a6ff',
      home: 'https://www.youku.com/',
      icon: 'assets/platform-youku.png',
      search: (q) => `https://so.youku.com/search_video/q_${encodeURIComponent(q)}`,
    },
    mgtv: {
      name: '芒果TV',
      color: '#ff8a1f',
      home: 'https://www.mgtv.com/',
      icon: 'assets/platform-mgtv.png',
      search: (q) => `https://so.mgtv.com/so?k=${encodeURIComponent(q)}`,
    },
  }

  const params = new URLSearchParams(location.search)
  const key = params.get('key') && META[params.get('key')] ? params.get('key') : 'iqiyi'
  const initialQuery = params.get('q') || ''
  const initialUrl = params.get('u') || ''
  const meta = META[key]

  const $ = (selector) => document.querySelector(selector)
  const address = $('#address')
  const badge = $('#page-badge')
  const hint = $('#hint')
  const progress = $('#progress')
  const searchBox = $('#search-box')
  const autoParse = $('#auto-parse')

  document.title = `${meta.name} · 内置浏览器`
  $('#brand-icon').src = meta.icon
  $('#brand-name').textContent = meta.name

  autoParse.checked = localStorage.getItem('csp.autoParse') !== '0'
  autoParse.addEventListener('change', () => {
    localStorage.setItem('csp.autoParse', autoParse.checked ? '1' : '0')
    bump(autoParse.checked ? '已开启：点开剧集自动解析' : '已关闭自动解析')
  })

  const webview = document.createElement('webview')
  webview.id = 'page'
  webview.setAttribute('partition', `persist:platform-${key}`)
  webview.setAttribute('webpreferences', 'contextIsolation=yes, nodeIntegration=no')
  webview.setAttribute('allowpopups', '')
  webview.setAttribute('src', initialUrl || (initialQuery ? meta.search(initialQuery) : meta.home))
  $('#browser').appendChild(webview)

  let lastAutoUrl = ''
  let autoTimer = null

  function currentUrl() {
    try {
      return webview.getURL() || ''
    } catch {
      return ''
    }
  }

  function isVideoPage(rawUrl) {
    if (!rawUrl) return false
    let parsed
    try {
      parsed = new URL(rawUrl)
    } catch {
      return false
    }
    const host = parsed.hostname.toLowerCase()
    const pathname = parsed.pathname
    if (key === 'iqiyi') {
      if (!(host === 'iqiyi.com' || host.endsWith('.iqiyi.com'))) return false
      return /^\/v_[A-Za-z0-9]+\.html$/.test(pathname) || /^\/a_[A-Za-z0-9]+\.html$/.test(pathname)
    }
    if (key === 'qq') {
      if (!(host === 'v.qq.com' || host.endsWith('.v.qq.com'))) return false
      const parts = pathname.split('/').filter(Boolean)
      if (parts[0] !== 'x' || !parts[parts.length - 1]?.endsWith('.html')) return false
      if (parts[1] === 'cover') return parts.length >= 4
      if (parts[1] === 'page') return parts.length >= 3
      return false
    }
    if (key === 'youku') {
      if (!(host === 'youku.com' || host.endsWith('.youku.com'))) return false
      return /^\/v_show\/id_[A-Za-z0-9=]+\.html$/.test(pathname)
    }
    if (key === 'mgtv') {
      if (!(host === 'mgtv.com' || host.endsWith('.mgtv.com'))) return false
      return /^\/b\/\d+\/\d+\.html$/.test(pathname)
    }
    return false
  }

  function sendAutoParse(url) {
    if (!autoParse.checked) return
    if (!isVideoPage(url)) return
    if (url === lastAutoUrl) return
    lastAutoUrl = url
    clearTimeout(autoTimer)
    autoTimer = setTimeout(() => {
      window.platformApi.sendToParse(url, true, false).then((result) => {
        if (result?.ok) {
          bump(`已自动解析本集，在「长视频解析」主界面播放`)
        }
      }).catch(() => {})
    }, 900)
  }

  function refresh() {
    const url = currentUrl()
    if (url && document.activeElement !== address) address.value = url
    const video = isVideoPage(url)
    badge.textContent = video ? '视频页 · 可解析' : '浏览中'
    badge.classList.toggle('video', video)
    try {
      $('#btn-back').disabled = !webview.canGoBack()
      $('#btn-forward').disabled = !webview.canGoForward()
    } catch {
      /* 忽略 */
    }
    if (url && !url.startsWith('http')) return
    if (url) hint.hidden = true
    if (video) sendAutoParse(url)
  }

  const INJECT_CLICK = `(() => {
    if (window.__cspParseHooked) return true
    window.__cspParseHooked = true
    document.addEventListener('click', (event) => {
      const target = event.target
      const anchor = target && target.closest ? target.closest('a[href]') : null
      if (!anchor) return
      const href = anchor.href
      if (!href || !/^https?:/i.test(href)) return
      try { console.log('__CSP_LINK__' + href) } catch (e) {}
    }, true)
    return true
  })()`

  function injectClickHook() {
    try {
      webview.executeJavaScript(INJECT_CLICK).catch(() => {})
    } catch {
      /* 忽略 */
    }
  }

  webview.addEventListener('did-start-loading', () => {
    progress.hidden = false
    hint.hidden = true
  })
  webview.addEventListener('did-stop-loading', () => {
    progress.hidden = true
    refresh()
    injectClickHook()
  })
  webview.addEventListener('did-navigate', () => {
    refresh()
    injectClickHook()
  })
  webview.addEventListener('did-navigate-in-page', () => refresh())
  webview.addEventListener('dom-ready', () => {
    hint.hidden = true
    injectClickHook()
  })
  webview.addEventListener('page-title-updated', (event) => {
    const title = event.title
    if (title) document.title = `${title} · ${meta.name}`
  })
  webview.addEventListener('did-fail-load', (event) => {
    if (!event.isMainFrame || event.errorCode === -3) return
    hint.hidden = false
    hint.querySelector('p').textContent = `页面加载失败：${event.errorDescription || event.errorCode}。检查网络或稍后重试。`
    progress.hidden = true
  })
  webview.addEventListener('console-message', (event) => {
    const message = String(event.message || '')
    if (!message.startsWith('__CSP_LINK__')) return
    const url = message.slice('__CSP_LINK__'.length)
    if (isVideoPage(url)) sendAutoParse(url)
  })

  $('#btn-back').addEventListener('click', () => {
    try {
      webview.goBack()
    } catch {
      /* 忽略 */
    }
  })
  $('#btn-forward').addEventListener('click', () => {
    try {
      webview.goForward()
    } catch {
      /* 忽略 */
    }
  })
  $('#btn-reload').addEventListener('click', () => {
    try {
      webview.reload()
    } catch {
      /* 忽略 */
    }
  })
  $('#btn-home').addEventListener('click', () => {
    try {
      webview.loadURL(meta.home)
    } catch {
      /* 忽略 */
    }
  })

  address.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    let text = address.value.trim()
    if (!text) return
    if (!/^https?:\/\//i.test(text)) text = `https://${text}`
    try {
      webview.loadURL(text)
    } catch {
      /* 忽略 */
    }
  })

  function navigateSearch(query) {
    const q = String(query || '').trim()
    if (!q) return
    searchBox.value = q
    try {
      webview.loadURL(meta.search(q))
    } catch {
      /* 忽略 */
    }
  }

  $('#btn-search').addEventListener('click', () => navigateSearch(searchBox.value))
  searchBox.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') navigateSearch(searchBox.value)
  })

  $('#btn-copy').addEventListener('click', async () => {
    const url = currentUrl()
    if (!url) return
    if (!isVideoPage(url)) {
      bump('请先点开具体某一集，再复制链接')
      return
    }
    await window.platformApi.copyText(url)
    bump('已复制本集链接')
  })

  $('#btn-parse').addEventListener('click', async () => {
    const url = currentUrl()
    if (!url) {
      bump('页面还没加载出来')
      return
    }
    if (!isVideoPage(url)) {
      bump('当前不是具体剧集页，仍会尝试解析…')
    }
    const result = await window.platformApi.sendToParse(url, true, true)
    if (result?.ok) bump('已发送到主界面，开始解析播放')
    else bump(result?.error || '发送失败')
  })

  $('#btn-external').addEventListener('click', () => {
    const url = currentUrl()
    if (url) window.platformApi.openExternal(url)
  })

  document.addEventListener('keydown', (event) => {
    if (event.altKey && event.key === 'ArrowLeft') $('#btn-back').click()
    if (event.altKey && event.key === 'ArrowRight') $('#btn-forward').click()
    if (event.key === 'F5') $('#btn-reload').click()
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault()
      address.focus()
      address.select()
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') $('#btn-parse').click()
  })

  // 已打开同一个平台窗口时，主界面再次「找剧」只需要换搜索词
  if (window.platformApi.onSearch) {
    window.platformApi.onSearch((query) => {
      navigateSearch(query)
    })
  }

  let bumpTimer = null
  function bump(message) {
    hint.hidden = false
    hint.querySelector('p').textContent = message
    clearTimeout(bumpTimer)
    bumpTimer = setTimeout(() => {
      hint.hidden = true
    }, 3000)
  }

  if (initialQuery) {
    setTimeout(() => {
      address.value = currentUrl()
    }, 500)
  }
  setTimeout(refresh, 900)
})()
