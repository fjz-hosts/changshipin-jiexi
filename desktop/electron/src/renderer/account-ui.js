(() => {
  'use strict'

  const $ = (selector) => document.querySelector(selector)
  const $$ = (selector) => Array.from(document.querySelectorAll(selector))

  const state = {
    account: null,
    gatePromise: null,
    gateResolve: null,
    bound: false,
    busy: false,
    profileLoadedAt: 0,
  }

  const API = () => window.desktop

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function timeText(value) {
    if (!value) return '—'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return '—'
    return date.toLocaleString('zh-CN', { hour12: false })
  }

  function setMsg(text, kind = '') {
    const el = $('#gate-msg')
    if (!el) return
    el.textContent = text || ''
    el.className = `gate-msg${kind ? ` ${kind}` : ''}`
  }

  function switchGateTab(tab) {
    $$('#gate-tabs button').forEach((button) => {
      button.classList.toggle('active', button.dataset.gateTab === tab)
    })
    $$('.gate-pane').forEach((pane) => {
      pane.hidden = pane.dataset.gatePane !== tab
    })
    setMsg('')
    const first = $(`.gate-pane[data-gate-pane="${tab}"] input`)
    first?.focus()
  }

  function showGate(reason) {
    const gate = $('#account-gate')
    if (!gate) return
    gate.hidden = false
    if (reason === 'expired') setMsg('登录已过期，请重新登录', 'error')
    if (reason === 'offline-expired') setMsg('离线状态超过 7 天，请联网后重新登录', 'error')
    if (state.account && state.account.configured === false) {
      setMsg('客户端还没有配置账号服务地址，请更新到最新版本后再登录', 'error')
    }
    $('#gate-account')?.focus()
  }

  function hideGate() {
    const gate = $('#account-gate')
    if (gate) gate.hidden = true
  }

  function showOffline(days) {
    const banner = $('#offline-banner')
    if (!banner) return
    $('#offline-text').textContent = `当前处于离线模式：网络不可用，解析仍可使用；反馈和统计会在恢复后同步${
      days ? `（宽限期还剩 ${days} 天）` : ''
    }`
    banner.hidden = false
  }

  function renderBadge() {
    const account = state.account || {}
    const settings = $('#btn-settings')
    if (settings) settings.classList.toggle('has-unread', Number(account.unread) > 0)
    const api = $('#gate-api')
    if (api) api.textContent = account.configured ? account.apiBase : '未配置（请更新客户端）'
  }

  async function refreshAccount() {
    try {
      state.account = await API().accountState()
      renderBadge()
    } catch {
      /* 主进程还没就绪 */
    }
    return state.account
  }

  function finishLogin() {
    hideGate()
    const banner = $('#offline-banner')
    if (banner) banner.hidden = true
    refreshAccount().then(() => {
      loadAccountTab()
      loadFeedbackTab()
      if (state.gateResolve) {
        const resolve = state.gateResolve
        state.gateResolve = null
        resolve({ ok: true })
      }
    })
  }

  // 启动闸门：登录成功 / 有有效登录态才 resolve，app.js 的初始化会等在这里
  function ensure() {
    if (!state.gatePromise) {
      state.gatePromise = new Promise((resolve) => {
        state.gateResolve = resolve
      })
    }
    if (state.gatePromise.done) return Promise.resolve({ ok: true })
    ;(async () => {
      try {
        const result = await API().accountBootstrap()
        state.account = await API().accountState()
        renderBadge()
        if (result.ok) {
          hideGate()
          if (result.offline) showOffline(result.graceDaysLeft)
          if (state.gateResolve) {
            const resolve = state.gateResolve
            state.gateResolve = null
            state.gatePromise.done = true
            resolve({ ok: true, offline: Boolean(result.offline) })
          }
          loadAccountTab()
          loadFeedbackTab()
        } else {
          showGate(result.reason)
        }
      } catch (error) {
        showGate('')
        setMsg(String(error?.message || error), 'error')
      }
    })()
    return state.gatePromise
  }

  // ---------- 验证码倒计时 ----------
  function startCountdown(button, seconds = 60) {
    const original = button.dataset.original || button.textContent
    button.dataset.original = original
    button.disabled = true
    let left = seconds
    button.textContent = `${left}s 后重发`
    const timer = setInterval(() => {
      left -= 1
      if (left <= 0) {
        clearInterval(timer)
        button.disabled = false
        button.textContent = original
        return
      }
      button.textContent = `${left}s 后重发`
    }, 1000)
  }

  async function sendCode(button, purpose, input) {
    const email = String(input?.value || '').trim()
    if (!email) {
      setMsg('请先填写邮箱', 'error')
      input?.focus()
      return
    }
    button.disabled = true
    const original = button.textContent
    button.textContent = '发送中…'
    const result = await API().accountSendCode(purpose, email)
    if (!result?.ok) {
      button.disabled = false
      button.textContent = original
      setMsg(result?.error || '验证码发送失败', 'error')
      return
    }
    setMsg('验证码已发送，请查收邮箱（10 分钟内有效）', 'ok')
    startCountdown(button)
  }

  async function withBusy(button, task) {
    if (state.busy) return
    state.busy = true
    const original = button.textContent
    button.disabled = true
    button.textContent = '请稍候…'
    try {
      await task()
    } finally {
      state.busy = false
      button.disabled = false
      button.textContent = original
    }
  }

  // ---------- 账号页签 ----------
  async function loadAccountTab() {
    const account = state.account || (await refreshAccount())
    const box = $('#acct-summary')
    if (!box) return
    const user = account?.user
    if (!user) {
      box.innerHTML = '<div class="row"><span>登录状态</span><b>未登录</b></div>'
      return
    }
    box.innerHTML = `
      <div class="row"><span>邮箱</span><b>${esc(user.email)}</b></div>
      <div class="row"><span>用户名</span><b>${esc(user.username)}</b></div>
      <div class="row"><span>账号类型</span><b>${user.role === 'admin' ? '管理员' : '普通用户'}</b></div>
      <div class="row"><span>反馈回复</span><b>${Number(account.unread) > 0 ? `${account.unread} 条未读` : '已全部读过'}</b></div>
      <div class="row"><span>登录状态</span><b>${account.online ? '在线' : '离线（7 天宽限期）'}</b></div>`
    const telemetry = $('#set-telemetry')
    if (telemetry) telemetry.checked = account.telemetryEnabled !== false
    const admin = $('#btn-open-admin')
    if (admin) {
      admin.hidden = !(user.role === 'admin' && account.apiBase)
      admin.onclick = () => API().openExternal(`${account.apiBase}/admin/`)
    }
    $('#acct-hint').textContent = account.online ? '' : '当前离线：反馈会在联网后自动同步。'
  }

  async function loadFeedbackTab() {
    const box = $('#fb-mine')
    if (!box) return
    let result
    try {
      result = await API().feedbackMine()
    } catch (error) {
      box.innerHTML = `<p class="muted small">${esc(String(error?.message || error))}</p>`
      return
    }
    if (!result?.ok) {
      box.innerHTML = `<p class="muted small">${esc(result?.error || '读取失败')}</p>`
      return
    }
    const items = result.items || []
    if (!items.length) {
      box.innerHTML = '<p class="muted small">还没有提交过反馈。</p>'
      return
    }
    const statusMap = {
      0: ['pending', '待处理'],
      1: ['pending', '处理中'],
      2: ['replied', '已回复'],
      3: ['', '已关闭'],
    }
    const typeMap = { bug: '故障', feature: '功能建议', experience: '体验问题', other: '其它' }
    box.innerHTML = items
      .map((item) => {
        const [cls, text] = statusMap[item.status] || ['', '未知']
        const replies = (item.replies || [])
          .map(
            (reply) =>
              `<div class="reply"><b>${reply.author === 'admin' ? '作者回复' : '我'}</b> · ${esc(
                timeText(reply.createdAt),
              )}<br>${esc(reply.content)}</div>`,
          )
          .join('')
        return `<div class="fb-item">
          <header>
            <span class="fb-tag ${cls}">${text}</span>
            <span class="fb-tag">${esc(typeMap[item.type] || '其它')}</span>
            ${item.rating ? `<span>★ ${Number(item.rating)}</span>` : ''}
            <span>${esc(timeText(item.created_at))}</span>
          </header>
          <div class="content">${esc(item.content)}</div>
          ${replies}
        </div>`
      })
      .join('')
    const unseen = items.filter((item) => (item.replies || []).some((reply) => reply.author === 'admin' && !reply.seen))
    if (unseen.length) {
      API()
        .feedbackSeen(unseen.map((item) => item.id))
        .then(() => refreshAccount())
        .catch(() => {})
    }
  }

  function bind() {
    if (state.bound) return
    state.bound = true

    $('#gate-tabs')?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-gate-tab]')
      if (button) switchGateTab(button.dataset.gateTab)
    })

    $('#gate-password-form')?.addEventListener('submit', (event) => {
      event.preventDefault()
      const submit = event.target.querySelector('button[type="submit"]')
      withBusy(submit, async () => {
        const result = await API().accountLogin({
          account: $('#gate-account').value.trim(),
          password: $('#gate-password').value,
        })
        if (!result?.ok) return setMsg(result?.error || '登录失败', 'error')
        setMsg('登录成功', 'ok')
        finishLogin()
      })
    })

    $('#gate-code-send')?.addEventListener('click', (event) =>
      sendCode(event.currentTarget, 'login', $('#gate-code-email')),
    )
    $('#gate-code-form')?.addEventListener('submit', (event) => {
      event.preventDefault()
      const submit = event.target.querySelector('button[type="submit"]')
      withBusy(submit, async () => {
        const result = await API().accountLoginCode({
          email: $('#gate-code-email').value.trim(),
          code: $('#gate-code-value').value.trim(),
        })
        if (!result?.ok) return setMsg(result?.error || '登录失败', 'error')
        setMsg('登录成功', 'ok')
        finishLogin()
      })
    })

    $('#gate-reg-send')?.addEventListener('click', (event) =>
      sendCode(event.currentTarget, 'register', $('#gate-reg-email')),
    )
    $('#gate-register-form')?.addEventListener('submit', (event) => {
      event.preventDefault()
      const submit = event.target.querySelector('button[type="submit"]')
      withBusy(submit, async () => {
        const result = await API().accountRegister({
          email: $('#gate-reg-email').value.trim(),
          code: $('#gate-reg-code').value.trim(),
          username: $('#gate-reg-name').value.trim(),
          password: $('#gate-reg-password').value,
        })
        if (!result?.ok) return setMsg(result?.error || '注册失败', 'error')
        setMsg('注册成功，已自动登录', 'ok')
        finishLogin()
      })
    })

    $('#gate-reset-send')?.addEventListener('click', (event) =>
      sendCode(event.currentTarget, 'reset', $('#gate-reset-email')),
    )
    $('#gate-reset-form')?.addEventListener('submit', (event) => {
      event.preventDefault()
      const submit = event.target.querySelector('button[type="submit"]')
      withBusy(submit, async () => {
        const email = $('#gate-reset-email').value.trim()
        const result = await API().accountResetPassword({
          email,
          code: $('#gate-reset-code').value.trim(),
          password: $('#gate-reset-password').value,
        })
        if (!result?.ok) return setMsg(result?.error || '重置失败', 'error')
        switchGateTab('password')
        $('#gate-account').value = email
        setMsg('密码已重置，请用新密码登录', 'ok')
      })
    })

    $('#offline-close')?.addEventListener('click', () => {
      $('#offline-banner').hidden = true
    })

    // 设置弹窗切到「账号 / 反馈」时刷新数据
    $('#modal-tabs')?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-tab]')
      if (!button) return
      if (button.dataset.tab === 'account') refreshAccount().then(loadAccountTab)
      if (button.dataset.tab === 'feedback') {
        refreshAccount().then(loadFeedbackTab)
      }
    })

    $('#set-telemetry')?.addEventListener('change', async (event) => {
      const result = await API().accountTelemetry(event.target.checked)
      $('#acct-hint').textContent = result?.ok
        ? event.target.checked
          ? '已开启匿名使用统计'
          : '已关闭，之后不再上报任何使用数据'
        : result?.error || '保存失败'
      await refreshAccount()
    })

    $('#acct-password-form')?.addEventListener('submit', async (event) => {
      event.preventDefault()
      const result = await API().accountChangePassword({
        oldPassword: $('#acct-old-pass').value,
        newPassword: $('#acct-new-pass').value,
      })
      $('#acct-hint').textContent = result?.ok ? '密码已更新' : result?.error || '修改失败'
      if (result?.ok) {
        $('#acct-old-pass').value = ''
        $('#acct-new-pass').value = ''
      }
    })

    $('#btn-account-logout')?.addEventListener('click', async () => {
      const ok = window.confirm('退出登录后需要重新登录才能继续使用，确定退出？')
      if (!ok) return
      await API().accountLogout()
      window.location.reload()
    })

    $('#fb-form')?.addEventListener('submit', async (event) => {
      event.preventDefault()
      const content = $('#fb-content').value.trim()
      const hint = $('#fb-hint')
      if (content.length < 5) {
        hint.textContent = '反馈内容至少 5 个字'
        return
      }
      const rating = Number($('#fb-rating').value) || 0
      const result = await API().feedbackSubmit({
        type: $('#fb-type').value,
        rating: rating >= 1 && rating <= 5 ? rating : null,
        contact: $('#fb-contact').value.trim(),
        content,
      })
      if (!result?.ok) {
        hint.textContent = result?.error || '提交失败，请稍后再试'
        return
      }
      event.target.reset()
      hint.textContent = '反馈已提交，作者回复后会显示在下面的列表里'
      loadFeedbackTab()
    })

    setInterval(() => {
      if (document.hidden) return
      refreshAccount()
    }, 5 * 60 * 1000)
  }

  async function init() {
    bind()
    await refreshAccount()
    const account = state.account || {}
    if (account.configured === false) {
      setMsg('客户端还没有配置账号服务地址，请更新到最新版本后再登录', 'error')
    }
  }

  window.AccountUI = {
    init,
    ensure,
    refreshAccount,
    loadAccountTab,
    loadFeedbackTab,
    getState: () => state.account,
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
