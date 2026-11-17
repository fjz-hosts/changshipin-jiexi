(() => {
  'use strict'

  const META = {
    iqiyi: { name: '爱奇艺', color: '#00d95f', home: 'https://www.iqiyi.com/', glyph: '爱' },
    qq: { name: '腾讯视频', color: '#2b8cff', home: 'https://v.qq.com/', glyph: '腾' },
    youku: { name: '优酷', color: '#35a6ff', home: 'https://www.youku.com/', glyph: '优' },
    mgtv: { name: '芒果TV', color: '#ff8a1f', home: 'https://www.mgtv.com/', glyph: '芒' },
  }

  const params = new URLSearchParams(location.search)
  const key = params.get('key') && META[params.get('key')] ? params.get('key') : 'iqiyi'
  const meta = META[key]

  const $ = (selector) => document.querySelector(selector)
  const address = $('#address')
  const badge = $('#page-badge')
  const hint = $('#hint')
  const progress = $('#progress')

  document.title = `${meta.name} · 内置浏览器`
  $('#brand-logo').textContent = meta.glyph
  $('#brand-logo').style.setProperty('--brand', meta.color)
  $('#brand-name').textContent = meta.name

  const webview = document.createElement('webview')
  webview.id = 'page'
  webview.setAttribute('partition', `persist:platform-${key}`)
  webview.setAttribute('webpreferences', 'contextIsolation=yes, nodeIntegration=no')
  webview.setAttribute('allowpopups', '')
  webview.setAttribute('src', meta.home)
  $('#browser').appendChild(webview)

  let navigating = 0

  function currentUrl() {
    try {
      return webview.getURL() || ''
    } catch {
      return ''
    }
  }

  function isVideoPage(url) {
    if (!url) return false
    try {
      const parsed = new URL(url)
      const host = parsed.hostname.toLowerCase()
      if (!host.endsWith(`${key === 'qq' ? 'v.qq.com' : key === 'iqiyi' ? 'iqiyi.com' : key === 'youku' ? 'youku.com' : 'mgtv.com'}`)) {
        // 腾讯视频的 cover 页在 v.qq.com，爱奇艺偶尔跳到 www.iqiyi.com
        if (!(key === 'iqiyi' && host.endsWith('iqiyi.com'))) return false
      }
      if (key === 'iqiyi') return /\/v_[A-Za-z0-9]+\.html/.test(parsed.pathname) || /\/a_[A-Za-z0-9]+\.html/.test(parsed.pathname)
      if (key === 'qq') return /^\/x\/(cover|page)\//.test(parsed.pathname)
      if (key === 'youku') return /\/v_show\/id_[A-Za-z0-9=]+\.html/.test(parsed.pathname)
      if (key === 'mgtv') return /^\/b\/\d+\/\d+\.html/.test(parsed.pathname)
    } catch {
      return false
    }
    return false
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
  }

  webview.addEventListener('did-start-loading', () => {
    navigating += 1
    progress.hidden = false
    hint.hidden = true
  })
  webview.addEventListener('did-stop-loading', () => {
    navigating = Math.max(0, navigating - 1)
    progress.hidden = true
    refresh()
  })
  webview.addEventListener('did-navigate', () => {
    refresh()
  })
  webview.addEventListener('did-navigate-in-page', () => {
    refresh()
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
  webview.addEventListener('dom-ready', () => {
    hint.hidden = true
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

  $('#btn-copy').addEventListener('click', async () => {
    const url = currentUrl()
    if (!url) return
    await window.platformApi.copyText(url)
    bump('链接已复制')
  })

  $('#btn-parse').addEventListener('click', async () => {
    const url = currentUrl()
    if (!url) {
      bump('页面还没加载出来')
      return
    }
    const result = await window.platformApi.sendToParse(url, true)
    if (result?.ok) bump('已发送到主界面，开始解析')
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

  let bumpTimer = null
  function bump(message) {
    hint.hidden = false
    hint.querySelector('p').textContent = message
    clearTimeout(bumpTimer)
    bumpTimer = setTimeout(() => {
      hint.hidden = true
    }, 2600)
  }

  setTimeout(refresh, 800)
})()
