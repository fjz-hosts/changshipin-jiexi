(() => {
  'use strict'

  const $ = (selector) => document.querySelector(selector)
  const state = { bound: false, loadedUrl: '' }

  async function apiBase() {
    try {
      const account = await window.desktop.accountState()
      return String(account?.apiBase || '').replace(/\/+$/, '')
    } catch {
      return ''
    }
  }

  function showFallback(show) {
    const fallback = $('#admin-fallback')
    if (fallback) fallback.hidden = !show
    const view = $('#admin-view')
    if (view) view.style.visibility = show ? 'hidden' : 'visible'
  }

  async function open() {
    const modal = $('#admin-modal')
    const view = $('#admin-view')
    if (!modal || !view) return
    // 从设置弹窗里点进来时先把设置收起来，避免两层遮罩叠在一起
    const settings = $('#modal')
    if (settings) settings.hidden = true
    modal.hidden = false
    const base = await apiBase()
    const sub = $('#admin-modal-sub')
    if (sub) {
      sub.textContent = base
        ? `需要管理员账号密码登录后查看 · ${base.replace(/^https?:\/\//, '')}`
        : '账号服务地址未配置'
    }
    if (!base) {
      showFallback(true)
      return
    }
    const url = `${base}/admin/`
    if (state.loadedUrl !== url) {
      state.loadedUrl = url
      showFallback(false)
      view.src = url
    }
  }

  function close() {
    const modal = $('#admin-modal')
    if (modal) modal.hidden = true
  }

  function bind() {
    if (state.bound) return
    state.bound = true
    $('#btn-admin-panel')?.addEventListener('click', open)
    $('#admin-close')?.addEventListener('click', close)
    $('#admin-retry')?.addEventListener('click', () => {
      const view = $('#admin-view')
      showFallback(false)
      if (view && state.loadedUrl) view.src = state.loadedUrl
    })
    const openBrowser = async () => {
      const base = await apiBase()
      if (base) window.desktop.openExternal(`${base}/admin/`)
    }
    $('#admin-open-browser')?.addEventListener('click', openBrowser)
    $('#admin-open-browser-2')?.addEventListener('click', openBrowser)
    $('#admin-clear-session')?.addEventListener('click', async () => {
      const view = $('#admin-view')
      if (!view) return
      try {
        await view.executeJavaScript("localStorage.removeItem('csp.admin.token'); location.reload(); true")
      } catch {
        /* 面板还没加载好时忽略 */
      }
    })

    const view = $('#admin-view')
    view?.addEventListener('did-finish-load', () => showFallback(false))
    view?.addEventListener('did-fail-load', (event) => {
      if (!event.isMainFrame || event.errorCode === -3) return
      showFallback(true)
    })

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      const modal = $('#admin-modal')
      if (modal && !modal.hidden) close()
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind)
  } else {
    bind()
  }
})()
