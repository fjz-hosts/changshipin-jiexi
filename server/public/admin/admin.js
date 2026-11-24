(() => {
  'use strict'

  const TOKEN_KEY = 'csp.admin.token'
  const state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    user: null,
    page: 'overview',
    days: 30,
    feedback: { page: 1, pageSize: 20, status: '', q: '', total: 0, current: null },
    timer: 0,
  }

  const $ = (selector, root = document) => root.querySelector(selector)
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector))

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function fmt(value) {
    const num = Number(value)
    if (!Number.isFinite(num)) return '—'
    return num.toLocaleString('zh-CN')
  }

  function pct(part, total) {
    if (!total) return '—'
    return `${((part / total) * 100).toFixed(1)}%`
  }

  function shortDay(day) {
    return String(day || '').slice(5)
  }

  function timeText(value) {
    if (!value) return '—'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return '—'
    return date.toLocaleString('zh-CN', { hour12: false })
  }

  function toast(text) {
    const el = $('#toast')
    el.textContent = text
    el.classList.add('show')
    clearTimeout(toast.timer)
    toast.timer = setTimeout(() => el.classList.remove('show'), 2200)
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    if (state.token) headers.Authorization = `Bearer ${state.token}`
    const response = await fetch(path, {
      ...options,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    let data = null
    try {
      data = await response.json()
    } catch {
      /* 非 JSON */
    }
    if (response.status === 401) {
      logout(true)
      throw new Error(data?.error || '登录已过期')
    }
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.error || `请求失败（${response.status}）`)
    }
    return data
  }

  // ---------- 图表 ----------
  const CHART_COLORS = ['#4cc2ff', '#3ddc97', '#ffb454', '#a78bfa', '#ff6b6b', '#5eead4']

  function lineChart(container, labels, series, options = {}) {
    const width = Math.max(320, container.clientWidth || 720)
    const height = options.height || 230
    const pad = { l: 42, r: 16, t: 14, b: 28 }
    const innerW = width - pad.l - pad.r
    const innerH = height - pad.t - pad.b
    const values = series.flatMap((item) => item.values.map((v) => Number(v) || 0))
    let max = Math.max(1, ...values)
    max = max <= 5 ? 5 : Math.ceil(max / 5) * 5
    const stepX = labels.length > 1 ? innerW / (labels.length - 1) : innerW
    const y = (value) => pad.t + innerH - (Math.max(0, Number(value) || 0) / max) * innerH
    const x = (index) => pad.l + (labels.length > 1 ? stepX * index : innerW / 2)

    const grid = []
    for (let i = 0; i <= 4; i += 1) {
      const value = (max / 4) * i
      const gy = y(value)
      grid.push(
        `<line x1="${pad.l}" y1="${gy}" x2="${width - pad.r}" y2="${gy}" stroke="#1e2839" stroke-width="1"/>` +
          `<text x="${pad.l - 8}" y="${gy + 4}" fill="#7f8ba3" font-size="10" text-anchor="end">${fmt(Math.round(value))}</text>`,
      )
    }

    const labelStep = Math.max(1, Math.ceil(labels.length / 8))
    const xLabels = labels
      .map((label, index) => {
        if (index % labelStep !== 0 && index !== labels.length - 1) return ''
        return `<text x="${x(index)}" y="${height - 8}" fill="#7f8ba3" font-size="10" text-anchor="middle">${esc(
          shortDay(label),
        )}</text>`
      })
      .join('')

    const paths = series
      .map((item, index) => {
        const color = item.color || CHART_COLORS[index % CHART_COLORS.length]
        const points = item.values.map((value, i) => `${x(i)},${y(value)}`).join(' ')
        const area = `M ${x(0)},${pad.t + innerH} L ${points.replace(/ /g, ' L ')} L ${x(
          item.values.length - 1,
        )},${pad.t + innerH} Z`
        return (
          `<path d="${area}" fill="${color}" opacity="0.07"/>` +
          `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
        )
      })
      .join('')

    container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img">${grid.join(
      '',
    )}${paths}${xLabels}</svg>`
  }

  function barList(container, rows, options = {}) {
    if (!rows.length) {
      container.innerHTML = '<div class="empty">暂无数据</div>'
      return
    }
    const max = Math.max(1, ...rows.map((row) => Number(row.value) || 0))
    container.innerHTML = rows
      .map((row) => {
        const value = Number(row.value) || 0
        const width = Math.max(2, (value / max) * 100)
        return `<div class="bar-row">
          <span class="name" title="${esc(row.name)}">${esc(row.name)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${width}%${
            row.color ? `;background:${row.color}` : ''
          }"></div></div>
          <span class="val">${esc(row.text ?? fmt(value))}</span>
        </div>`
      })
      .join('')
  }

  function donut(container, items) {
    const total = items.reduce((sum, item) => sum + (Number(item.value) || 0), 0)
    if (!total) {
      container.innerHTML = '<div class="empty">暂无数据</div>'
      return
    }
    const radius = 52
    const circumference = 2 * Math.PI * radius
    let offset = 0
    const circles = items
      .map((item, index) => {
        const value = Number(item.value) || 0
        const length = (value / total) * circumference
        const color = item.color || CHART_COLORS[index % CHART_COLORS.length]
        const circle =
          `<circle cx="70" cy="70" r="${radius}" fill="none" stroke="${color}" stroke-width="16" ` +
          `stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}" ` +
          `transform="rotate(-90 70 70)"/>`
        offset += length
        return circle
      })
      .join('')
    const legend = items
      .map(
        (item, index) =>
          `<div class="kv-row"><span><i style="display:inline-block;width:8px;height:8px;border-radius:3px;margin-right:7px;background:${
            item.color || CHART_COLORS[index % CHART_COLORS.length]
          }"></i>${esc(item.name)}</span><b>${fmt(item.value)} · ${pct(item.value, total)}</b></div>`,
      )
      .join('')
    container.innerHTML = `<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
      <svg width="140" height="140" viewBox="0 0 140 140">${circles}
        <text x="70" y="66" fill="#e6ecf7" font-size="20" font-weight="700" text-anchor="middle">${fmt(total)}</text>
        <text x="70" y="86" fill="#7f8ba3" font-size="11" text-anchor="middle">设备</text>
      </svg>
      <div style="flex:1;min-width:180px">${legend}</div>
    </div>`
  }

  function table(container, columns, rows, emptyText = '暂无数据') {
    if (!rows.length) {
      container.innerHTML = `<div class="empty">${esc(emptyText)}</div>`
      return
    }
    const head = columns.map((col) => `<th class="${col.num ? 'num' : ''}">${esc(col.title)}</th>`).join('')
    const body = rows
      .map(
        (row) =>
          `<tr>${columns
            .map((col) => `<td class="${col.num ? 'num' : ''}">${col.render ? col.render(row) : esc(row[col.key])}</td>`)
            .join('')}</tr>`,
      )
      .join('')
    container.innerHTML = `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
  }

  // ---------- 概览 ----------
  async function loadOverview() {
    const { data } = await api('/api/admin/overview')
    const cards = [
      { k: '在线设备（5 分钟）', v: data.online, s: `近 7 天设备 ${fmt(data.totalDevices)}`, cls: 'accent' },
      { k: '今日活跃设备', v: data.dau, s: `今日启动事件 ${fmt(data.today.parse ? data.logins : data.logins)}`, cls: '' },
      { k: '今日解析', v: data.parses, s: `成功率 ${data.parseRate === null ? '—' : data.parseRate + '%'}`, cls: 'green' },
      { k: '今日下载', v: data.downloads, s: `短视频 ${fmt(data.today.short)} · 音乐 ${fmt(data.today.music)}`, cls: '' },
      { k: '今日新增注册', v: data.newUsers, s: `今日登录 ${fmt(data.logins)} 次`, cls: 'orange' },
      { k: '待处理反馈', v: data.feedbackPending, s: `今日新增 ${fmt(data.feedbackToday)} 条`, cls: data.feedbackPending ? 'red' : '' },
    ]
    $('#ov-cards').innerHTML = cards
      .map(
        (card) =>
          `<div class="card ${card.cls}"><div class="k">${esc(card.k)}</div><div class="v">${fmt(
            card.v,
          )}</div><div class="s">${esc(card.s)}</div></div>`,
      )
      .join('')

    barList(
      $('#ov-events'),
      [
        { name: '长视频解析', value: data.today.parse },
        { name: '短视频解析', value: data.today.short },
        { name: '音乐解析', value: data.today.music },
        { name: '下载', value: data.today.download },
        { name: '错误上报', value: data.today.error },
      ],
      {},
    )

    donut(
      $('#ov-versions'),
      (data.versions || []).map((row, index) => ({
        name: `v${row.version}`,
        value: row.count,
        color: CHART_COLORS[index % CHART_COLORS.length],
      })),
    )

    const trend = await api('/api/admin/trend?days=7')
    $('#ov-spark-legend').innerHTML =
      '<span><i style="background:#4cc2ff"></i>活跃设备</span><span><i style="background:#3ddc97"></i>解析次数</span>'
    lineChart(
      $('#ov-spark'),
      trend.data.map((row) => row.day),
      [
        { name: '活跃设备', values: trend.data.map((row) => row.dau), color: '#4cc2ff' },
        { name: '解析次数', values: trend.data.map((row) => row.parses), color: '#3ddc97' },
      ],
      { height: 190 },
    )
  }

  // ---------- 趋势 ----------
  async function loadTrend() {
    const { data } = await api(`/api/admin/trend?days=${state.days}`)
    $('#trend-legend').innerHTML =
      '<span><i style="background:#4cc2ff"></i>活跃设备</span>' +
      '<span><i style="background:#3ddc97"></i>解析次数</span>' +
      '<span><i style="background:#ffb454"></i>下载</span>' +
      '<span><i style="background:#a78bfa"></i>新增注册</span>'
    lineChart(
      $('#trend-chart'),
      data.map((row) => row.day),
      [
        { values: data.map((row) => row.dau), color: '#4cc2ff' },
        { values: data.map((row) => row.parses), color: '#3ddc97' },
        { values: data.map((row) => row.downloads), color: '#ffb454' },
        { values: data.map((row) => row.signups), color: '#a78bfa' },
      ],
      { height: 300 },
    )
    table(
      $('#trend-table'),
      [
        { title: '日期', key: 'day' },
        { title: '活跃设备', key: 'dau', num: true, render: (row) => fmt(row.dau) },
        { title: '解析', key: 'parses', num: true, render: (row) => fmt(row.parses) },
        { title: '成功', key: 'parse_ok', num: true, render: (row) => `${fmt(row.parse_ok)}（${pct(row.parse_ok, row.parses)}）` },
        { title: '下载', key: 'downloads', num: true, render: (row) => fmt(row.downloads) },
        { title: '错误', key: 'errors', num: true, render: (row) => fmt(row.errors) },
        { title: '平均耗时', key: 'avg_ms', num: true, render: (row) => (row.avg_ms ? `${row.avg_ms} ms` : '—') },
      ],
      data,
    )
  }

  // ---------- 平台 ----------
  async function loadPlatforms() {
    const { data } = await api(`/api/admin/platforms?days=${state.days}`)
    const group = new Map()
    for (const row of data) {
      const key = row.platform || row.sub_platform || row.event
      const label = `${eventLabel(row.event)} · ${key || '未知'}`
      const item = group.get(label) || { name: label, value: 0, ok: 0 }
      item.value += row.total
      item.ok += row.ok
      group.set(label, item)
    }
    const rows = Array.from(group.values()).sort((a, b) => b.value - a.value).slice(0, 14)
    barList($('#plat-bars'), rows)
    table(
      $('#plat-table'),
      [
        { title: '事件', key: 'event', render: (row) => esc(eventLabel(row.event)) },
        { title: '平台', key: 'platform', render: (row) => esc(row.platform || row.sub_platform || '—') },
        { title: '次数', key: 'total', num: true, render: (row) => fmt(row.total) },
        { title: '成功', key: 'ok', num: true, render: (row) => `${fmt(row.ok)}（${pct(row.ok, row.total)}）` },
        { title: '平均耗时', key: 'avg_ms', num: true, render: (row) => (row.avg_ms ? `${row.avg_ms} ms` : '—') },
      ],
      data,
    )
  }

  function eventLabel(event) {
    return (
      {
        parse: '长视频解析',
        short_resolve: '短视频解析',
        music_resolve: '音乐解析',
        music_search: '音乐搜索',
        download: '视频下载',
        short_download: '短视频下载',
        music_download: '音乐下载',
        launch: '启动',
        error: '错误',
        cast: '投屏',
      }[event] || event
    )
  }

  // ---------- 内容 ----------
  async function loadContent() {
    const { data } = await api(`/api/admin/content?days=${state.days}`)
    table(
      $('#content-hosts'),
      [
        { title: '域名', key: 'host' },
        { title: '次数', key: 'count', num: true, render: (row) => fmt(row.count) },
      ],
      data.hosts,
    )
    table(
      $('#content-titles'),
      [
        { title: '标题', key: 'title', render: (row) => esc(row.title) },
        { title: '平台', key: 'platform', render: (row) => esc(row.platform || '—') },
        { title: '次数', key: 'count', num: true, render: (row) => fmt(row.count) },
      ],
      data.titles,
    )
    table(
      $('#content-keywords'),
      [
        { title: '搜索词', key: 'keyword', render: (row) => esc(row.keyword) },
        { title: '次数', key: 'count', num: true, render: (row) => fmt(row.count) },
      ],
      data.keywords,
    )
  }

  // ---------- 用户 ----------
  async function loadUsers() {
    const { data } = await api(`/api/admin/users?days=${state.days}`)
    const funnel = data.funnel || {}
    const retention = data.retention || {}
    const cards = [
      { k: '注册验证码发送', v: funnel.codes, cls: '' },
      { k: '注册成功', v: funnel.registered, cls: 'green', s: `转化率 ${pct(funnel.registered, funnel.codes)}` },
      { k: '登录用户', v: funnel.logged, cls: 'accent' },
      { k: '提交过反馈', v: funnel.feedback_users, cls: 'orange', s: `占登录 ${pct(funnel.feedback_users, funnel.logged)}` },
      { k: '次日留存', v: retention.d1 ?? 0, cls: '', s: `样本 ${fmt(retention.cohort)} 人 · ${pct(retention.d1, retention.cohort)}` },
      { k: '7 日留存', v: retention.d7 ?? 0, cls: '', s: `样本 ${fmt(retention.cohort)} 人 · ${pct(retention.d7, retention.cohort)}` },
    ]
    $('#user-cards').innerHTML = cards
      .map(
        (card) =>
          `<div class="card ${card.cls}"><div class="k">${esc(card.k)}</div><div class="v">${fmt(
            card.v,
          )}</div><div class="s">${esc(card.s || '')}</div></div>`,
      )
      .join('')

    barList(
      $('#user-funnel'),
      [
        { name: '发验证码', value: funnel.codes },
        { name: '注册成功', value: funnel.registered },
        { name: '登录过', value: funnel.logged },
        { name: '提过反馈', value: funnel.feedback_users },
      ],
      { color: '#4cc2ff' },
    )
    lineChart(
      $('#user-signups'),
      (data.registrations || []).map((row) => row.day),
      [{ values: (data.registrations || []).map((row) => row.count), color: '#a78bfa' }],
      { height: 200 },
    )
    barList(
      $('#user-activity'),
      (data.activity || []).map((row) => ({ name: row.bucket, value: row.users })),
    )
    table(
      $('#user-top'),
      [
        { title: '用户', key: 'username', render: (row) => esc(row.username) },
        { title: '邮箱', key: 'email', render: (row) => esc(row.email) },
        { title: '事件数', key: 'events', num: true, render: (row) => fmt(row.events) },
      ],
      data.topUsers,
    )
  }

  // ---------- 反馈 ----------
  async function loadFeedbackStats() {
    const { data } = await api(`/api/admin/feedback/stats?days=${state.days}`)
    const summary = data.summary || {}
    const cards = [
      { k: '反馈总数', v: summary.total, cls: '' },
      { k: '待处理', v: summary.pending, cls: 'orange' },
      { k: '处理中', v: summary.processing, cls: 'accent' },
      { k: '已回复', v: summary.replied, cls: 'green' },
      { k: '平均评分', v: summary.avg_rating === null ? '—' : `${summary.avg_rating} / 5`, cls: '' },
      { k: 'NPS 均值', v: summary.avg_nps === null ? '—' : `${summary.avg_nps} / 10`, cls: '' },
    ]
    $('#fb-cards').innerHTML = cards
      .map(
        (card) =>
          `<div class="card ${card.cls}"><div class="k">${esc(card.k)}</div><div class="v">${fmt(card.v)}</div></div>`,
      )
      .join('')
    barList(
      $('#fb-types'),
      (data.types || []).map((row) => ({ name: typeLabel(row.type), value: row.count })),
    )
    lineChart(
      $('#fb-trend'),
      (data.daily || []).map((row) => row.day),
      [{ values: (data.daily || []).map((row) => row.count), color: '#ffb454' }],
      { height: 180 },
    )
  }

  function typeLabel(type) {
    return { bug: '故障 / BUG', feature: '功能建议', experience: '体验问题', other: '其它' }[type] || type || '其它'
  }

  function statusTag(status) {
    const map = {
      0: ['pending', '待处理'],
      1: ['processing', '处理中'],
      2: ['replied', '已回复'],
      3: ['closed', '已关闭'],
    }
    const [cls, text] = map[status] || ['closed', '未知']
    return `<span class="tag ${cls}">${text}</span>`
  }

  async function loadFeedback() {
    const params = new URLSearchParams({
      page: String(state.feedback.page),
      pageSize: String(state.feedback.pageSize),
      status: state.feedback.status,
      q: state.feedback.q,
    })
    const { data } = await api(`/api/admin/feedback?${params.toString()}`)
    state.feedback.total = data.total
    const list = $('#fb-list')
    if (!data.items.length) {
      list.innerHTML = '<div class="empty">没有符合条件的反馈</div>'
    } else {
      list.innerHTML = data.items
        .map(
          (item) => `<div class="feedback-item" data-id="${item.id}">
            <header>
              ${statusTag(item.status)}
              <span class="tag">${esc(typeLabel(item.type))}</span>
              ${item.rating ? `<span>★ ${item.rating}</span>` : ''}
              ${item.nps ? `<span>NPS ${item.nps}</span>` : ''}
              <span>${esc(item.email || '')}</span>
              <span>${esc(item.version ? 'v' + item.version : '')}</span>
              <span>${esc(timeText(item.created_at))}</span>
            </header>
            <div class="content">${esc(item.content.slice(0, 240))}${item.content.length > 240 ? '…' : ''}</div>
            ${item.admin_reply ? `<div class="reply">管理员回复：${esc(item.admin_reply)}</div>` : ''}
            <div class="ops">
              <button data-act="detail" data-id="${item.id}">查看 / 回复</button>
              ${item.status !== 1 ? `<button data-act="processing" data-id="${item.id}">标记处理中</button>` : ''}
              ${item.status !== 3 ? `<button data-act="close" data-id="${item.id}">关闭</button>` : ''}
            </div>
          </div>`,
        )
        .join('')
    }
    const totalPages = Math.max(1, Math.ceil(data.total / state.feedback.pageSize))
    $('#fb-page').textContent = `第 ${state.feedback.page} / ${totalPages} 页 · 共 ${fmt(data.total)} 条`
    $('#fb-prev').disabled = state.feedback.page <= 1
    $('#fb-next').disabled = state.feedback.page >= totalPages
  }

  async function openFeedback(id) {
    const { data } = await api(`/api/admin/feedback/${id}`)
    state.feedback.current = data
    $('#fb-modal-title').textContent = `反馈详情 · ${typeLabel(data.type)}`
    $('#fb-modal-meta').innerHTML = [
      statusTag(data.status),
      `<span>${esc(data.email || '')}</span>`,
      `<span>${esc(data.username || '')}</span>`,
      data.rating ? `<span>★ ${data.rating}</span>` : '',
      data.nps ? `<span>NPS ${data.nps}</span>` : '',
      `<span>v${esc(data.version || '—')}</span>`,
      `<span>${esc(data.os || '')}</span>`,
      `<span>${esc(timeText(data.created_at))}</span>`,
    ]
      .filter(Boolean)
      .join('')
    $('#fb-modal-body').textContent = data.content
    $('#fb-modal-replies').innerHTML = (data.replies || [])
      .map(
        (reply) =>
          `<div class="reply"><b>${reply.author === 'admin' ? '管理员' : '用户'}</b> · ${esc(
            timeText(reply.created_at),
          )}<br>${esc(reply.content)}</div>`,
      )
      .join('')
    $('#fb-reply').value = ''
    $('#fb-modal').hidden = false
  }

  async function replyCurrent() {
    const content = $('#fb-reply').value.trim()
    if (!content) return toast('请填写回复内容')
    await api(`/api/admin/feedback/${state.feedback.current.id}/reply`, { method: 'POST', body: { content } })
    toast('回复已发送')
    $('#fb-modal').hidden = true
    await Promise.all([loadFeedback(), loadFeedbackStats()])
  }

  async function setStatus(id, status) {
    await api(`/api/admin/feedback/${id}/status`, { method: 'POST', body: { status } })
    toast('状态已更新')
    await Promise.all([loadFeedback(), loadFeedbackStats()])
  }

  // ---------- 质量 ----------
  async function loadQuality() {
    const { data } = await api(`/api/admin/quality?days=${state.days}`)
    table(
      $('#qa-lines'),
      [
        { title: '线路类型', key: 'line_kind' },
        { title: '次数', key: 'total', num: true, render: (row) => fmt(row.total) },
        { title: '成功', key: 'ok', num: true, render: (row) => `${fmt(row.ok)}（${pct(row.ok, row.total)}）` },
        { title: '失败', key: 'fail', num: true, render: (row) => fmt(row.fail) },
        { title: '平均耗时', key: 'avg_ms', num: true, render: (row) => (row.avg_ms ? `${row.avg_ms} ms` : '—') },
      ],
      data.lines,
    )
    table(
      $('#qa-errors'),
      [
        { title: '错误', key: 'error_code', render: (row) => esc(row.error_code) },
        { title: '平台', key: 'platform', render: (row) => esc(row.platform || '—') },
        { title: '事件', key: 'event', render: (row) => esc(eventLabel(row.event)) },
        { title: '次数', key: 'count', num: true, render: (row) => fmt(row.count) },
      ],
      data.errors,
    )
  }

  // ---------- 路由 ----------
  const PAGES = {
    overview: { title: '实时概览', load: loadOverview },
    trend: { title: '趋势分析', load: loadTrend },
    platforms: { title: '平台分布', load: loadPlatforms },
    content: { title: '解析内容', load: loadContent },
    users: { title: '用户分析', load: loadUsers },
    feedback: {
      title: '反馈中心',
      load: async () => {
        await Promise.all([loadFeedbackStats(), loadFeedback()])
      },
    },
    quality: { title: '解析质量与错误', load: loadQuality },
  }

  async function showPage(page) {
    state.page = page
    $$('#nav button').forEach((button) => button.classList.toggle('active', button.dataset.page === page))
    $$('.page').forEach((section) => {
      section.hidden = section.id !== `page-${page}`
    })
    $('#page-title').textContent = PAGES[page].title
    $('#page-sub').textContent = page === 'overview' ? '每 30 秒自动刷新' : `统计窗口：最近 ${state.days} 天`
    $('#days-group').hidden = page === 'overview'
    try {
      await PAGES[page].load()
    } catch (error) {
      toast(error.message)
    }
  }

  function startAutoRefresh() {
    clearInterval(state.timer)
    state.timer = setInterval(() => {
      if (state.page === 'overview' && !document.hidden) {
        loadOverview().catch(() => {})
      }
    }, 30_000)
  }

  // ---------- 登录 ----------
  function showLogin() {
    $('#login-view').hidden = false
    $('#app-view').hidden = true
    window.scrollTo(0, 0)
    $('#login-password').value = ''
    $('#login-account')?.focus()
  }

  function showApp() {
    $('#login-view').hidden = true
    $('#app-view').hidden = false
    $('#admin-name').textContent = state.user?.username || state.user?.email || ''
    window.scrollTo(0, 0)
    startAutoRefresh()
  }

  function logout(silent = false) {
    state.token = ''
    state.user = null
    localStorage.removeItem(TOKEN_KEY)
    clearInterval(state.timer)
    showLogin()
    if (!silent) toast('已退出登录')
  }

  async function boot() {
    $('#login-form').addEventListener('submit', async (event) => {
      event.preventDefault()
      $('#login-error').textContent = ''
      const account = $('#login-account').value.trim()
      const password = $('#login-password').value
      try {
        const data = await api('/api/auth/login', { method: 'POST', body: { account, password } })
        if (data.user?.role !== 'admin') {
          $('#login-error').textContent = '该账号不是管理员'
          return
        }
        state.token = data.token
        state.user = data.user
        localStorage.setItem(TOKEN_KEY, state.token)
        showApp()
        await showPage('overview')
      } catch (error) {
        $('#login-error').textContent = error.message
      }
    })

    $('#btn-logout').addEventListener('click', () => logout())
    $$('#nav button').forEach((button) => {
      button.addEventListener('click', () => showPage(button.dataset.page))
    })
    $$('#days-group button').forEach((button) => {
      button.addEventListener('click', async () => {
        state.days = Number(button.dataset.days)
        $$('#days-group button').forEach((item) => item.classList.toggle('active', item === button))
        $('#page-sub').textContent = `统计窗口：最近 ${state.days} 天`
        try {
          await PAGES[state.page].load()
        } catch (error) {
          toast(error.message)
        }
      })
    })
    $('#btn-refresh').addEventListener('click', async () => {
      try {
        await PAGES[state.page].load()
        toast('已刷新')
      } catch (error) {
        toast(error.message)
      }
    })

    $('#fb-list').addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-act]')
      if (!button) return
      const { act, id } = button.dataset
      try {
        if (act === 'detail') return openFeedback(id)
        if (act === 'processing') return setStatus(id, 1)
        if (act === 'close') return setStatus(id, 3)
      } catch (error) {
        toast(error.message)
      }
    })
    $('#fb-search').addEventListener('input', (event) => {
      clearTimeout($('#fb-search').timer)
      $('#fb-search').timer = setTimeout(async () => {
        state.feedback.q = event.target.value.trim()
        state.feedback.page = 1
        await loadFeedback()
      }, 350)
    })
    $('#fb-status').addEventListener('change', async (event) => {
      state.feedback.status = event.target.value
      state.feedback.page = 1
      await loadFeedback()
    })
    $('#fb-prev').addEventListener('click', async () => {
      state.feedback.page = Math.max(1, state.feedback.page - 1)
      await loadFeedback()
    })
    $('#fb-next').addEventListener('click', async () => {
      state.feedback.page += 1
      await loadFeedback()
    })
    $('#fb-modal-close').addEventListener('click', () => {
      $('#fb-modal').hidden = true
    })
    $('#fb-send').addEventListener('click', async () => {
      try {
        await replyCurrent()
      } catch (error) {
        toast(error.message)
      }
    })
    $('#fb-modal').addEventListener('click', (event) => {
      if (event.target === $('#fb-modal')) $('#fb-modal').hidden = true
    })

    let resizeTimer = 0
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        PAGES[state.page]?.load().catch(() => {})
      }, 260)
    })

    if (!state.token) return showLogin()
    try {
      const { user } = await api('/api/admin/me')
      state.user = user
      showApp()
      await showPage('overview')
    } catch {
      showLogin()
    }
  }

  document.addEventListener('DOMContentLoaded', boot)
})()
