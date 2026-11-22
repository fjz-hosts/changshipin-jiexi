(() => {
  'use strict'

  /**
   * 音乐模式 UI（酷我 / 酷狗 / QQ音乐 / 网易云 / 汽水音乐）。
   *
   * 和长视频、短视频完全分开：自己的搜索、自己的播放器、自己的播放记录 /
   * 收藏 / 下载记录。主进程负责取流和下载，这里只负责界面和歌词滚动。
   */

  const FALLBACK_PLATFORMS = [
    { key: 'kuwo', name: '酷我音乐', short: '酷我', color: '#ffcc33', home: 'https://www.kuwo.cn/', searchable: true, hint: '搜索歌曲 / 歌手 / 专辑', loggedIn: false },
    { key: 'kugou', name: '酷狗音乐', short: '酷狗', color: '#2ca2f9', home: 'https://www.kugou.com/', searchable: true, hint: '搜索歌曲 / 歌手 / 专辑', loggedIn: false },
    { key: 'qq', name: 'QQ音乐', short: 'QQ', color: '#31c27c', home: 'https://y.qq.com/', searchable: true, hint: '搜索歌曲 / 歌手 / 专辑', loggedIn: false },
    { key: 'netease', name: '网易云音乐', short: '网易云', color: '#e60026', home: 'https://music.163.com/', searchable: true, hint: '搜索歌曲 / 歌手 / 专辑', loggedIn: false },
    { key: 'qishui', name: '汽水音乐', short: '汽水', color: '#00d6c9', home: 'https://music.douyin.com/qishui/', searchable: false, hint: '粘贴汽水分享链接', loggedIn: false },
  ]

  const MUSIC_ICONS = {
    kuwo: 'assets/platform-kuwo.png',
    kugou: 'assets/platform-kugou.png',
    qq: 'assets/platform-qqmusic.png',
    netease: 'assets/platform-netease.png',
    qishui: 'assets/platform-qishui.png',
  }

  const state = {
    inited: false,
    platforms: [],
    platform: localStorage.getItem('csp.musicPlatform') || 'kuwo',
    keyword: '',
    results: [],
    playlist: [],
    tab: 'results',
    current: null,
    resolved: null,
    pendingSong: null,
    history: [],
    favorites: [],
    downloads: [],
    downloadRunning: false,
    lyricLines: [],
    activeLyric: -1,
    resolveToken: 0,
    searchToken: 0,
    loginBusy: false,
    lastHistoryKey: '',
  }

  const $ = (selector) => document.querySelector(selector)
  const $$ = (selector) => Array.from(document.querySelectorAll(selector))

  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, (ch) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    })
  }

  function hexToRgba(hex, alpha = 0.16) {
    const value = String(hex || '#37e08b').replace('#', '')
    if (!/^[0-9a-f]{6}$/i.test(value)) return `rgba(55, 224, 139, ${alpha})`
    const red = parseInt(value.slice(0, 2), 16)
    const green = parseInt(value.slice(2, 4), 16)
    const blue = parseInt(value.slice(4, 6), 16)
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`
  }

  function formatSeconds(value) {
    const total = Math.max(0, Math.round(Number(value) || 0))
    if (!total) return '--:--'
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  }

  function setStatus(text) {
    const node = $('#status-text')
    if (node) node.textContent = text
  }

  function toast(message, kind = 'info', timeout = 3600) {
    const stack = $('#toast-stack')
    if (!stack) return
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

  function platformInfo(key) {
    return state.platforms.find((item) => item.key === key) || FALLBACK_PLATFORMS.find((item) => item.key === key) || null
  }

  function songKey(song) {
    if (!song) return ''
    return `${song.platform || state.platform}:${song.id || song.url || song.title || ''}`
  }

  function isQishuiUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl))
      return /(^|\.)douyin\.com$/i.test(url.hostname) && /\/qishui\//i.test(url.pathname) && Boolean(url.searchParams.get('track_id'))
    } catch {
      return false
    }
  }

  function musicUrlInfo(rawUrl) {
    let url = null
    try {
      url = new URL(String(rawUrl))
    } catch {
      return null
    }
    const host = url.hostname.toLowerCase()
    if (/(^|\.)douyin\.com$/.test(host) && /\/qishui\//.test(url.pathname)) {
      const id = url.searchParams.get('track_id')
      return id ? { platform: 'qishui', id, url: url.href } : null
    }
    if (/(^|\.)music\.163\.com$/.test(host)) {
      const id = url.searchParams.get('id') || (url.hash.match(/id=(\d+)/) || [])[1]
      return id ? { platform: 'netease', id, url: url.href } : null
    }
    if (/(^|\.)y\.qq\.com$/.test(host)) {
      const id = (url.pathname.match(/songDetail\/([A-Za-z0-9]+)/) || [])[1] || url.searchParams.get('songmid')
      return id ? { platform: 'qq', id, url: url.href } : null
    }
    if (/(^|\.)kugou\.com$/.test(host)) {
      const id = (url.hash.match(/hash=([0-9A-Fa-f]+)/) || [])[1] || url.searchParams.get('hash')
      return id ? { platform: 'kugou', id, url: url.href } : null
    }
    if (/(^|\.)kuwo\.cn$/.test(host)) {
      const id = (url.pathname.match(/play_detail\/(\d+)/) || [])[1] || url.searchParams.get('mid')
      return id ? { platform: 'kuwo', id, url: url.href } : null
    }
    return null
  }

  function showStage(name) {
    for (const id of ['empty', 'loading', 'error', 'player']) {
      const node = $(`#music-${id}`)
      if (node) node.hidden = id !== name
    }
  }

  function setLoading(title, detail) {
    $('#music-loading-title').textContent = title || '正在加载…'
    $('#music-loading-detail').textContent = detail || '请稍候。'
    showStage('loading')
  }

  function showError(title, detail, { loginable = true } = {}) {
    $('#music-error-title').textContent = title || '没有找到可播放的音源'
    $('#music-error-detail').textContent = detail || ''
    $('#music-error-login').hidden = !loginable
    showStage('error')
  }

  // ---------------------------------------------------------------------------
  // 平台卡片
  // ---------------------------------------------------------------------------

  async function refreshPlatforms() {
    try {
      const list = await window.desktop.musicPlatforms()
      if (Array.isArray(list) && list.length) state.platforms = list
    } catch {
      /* 用内置清单兜底 */
    }
    if (!state.platforms.length) state.platforms = FALLBACK_PLATFORMS.map((item) => ({ ...item }))
    if (!platformInfo(state.platform)) state.platform = 'netease'
    renderPlatforms()
    updateBadge()
    updateLoginChips()
  }

  function renderPlatforms() {
    const grid = $('#music-platform-grid')
    if (!grid) return
    grid.innerHTML = state.platforms
      .map(
        (platform) => `
        <div class="music-platform-card${platform.key === state.platform ? ' active' : ''}" data-platform="${platform.key}" style="--brand:${platform.color};--brand-soft:${hexToRgba(platform.color)}">
          <button class="music-card-main" data-action="select" title="${escapeHtml(platform.hint || platform.name)}">
            <span class="music-logo" aria-hidden="true"><img src="${MUSIC_ICONS[platform.key] || 'assets/app-icon.png'}" alt="" /></span>
            <span class="music-card-meta"><b>${escapeHtml(platform.short || platform.name)}</b></span>
            <em class="music-login-chip" data-login-chip="${platform.key}">未登录</em>
          </button>
        </div>`,
      )
      .join('')
    updateLoginChips()
  }

  function updateLoginChips() {
    $$('[data-login-chip]').forEach((chip) => {
      const key = chip.dataset.loginChip
      const platform = platformInfo(key)
      const loggedIn = Boolean(platform?.loggedIn)
      chip.textContent = key === 'qishui' ? '链接解析' : loggedIn ? '已登录' : '未登录'
      chip.classList.toggle('on', loggedIn)
      chip.classList.toggle('off', !loggedIn)
    })
  }

  function updateBadge() {
    const badge = $('#music-platform-badge')
    const platform = platformInfo(state.platform)
    if (!badge || !platform) return
    badge.textContent = platform.short || platform.name
    badge.classList.add('known')
    badge.style.setProperty('--brand', platform.color)
    const input = $('#music-search-input')
    if (input) input.placeholder = platform.searchable === false
      ? '粘贴汽水音乐分享链接（歌曲分享 → 复制链接）'
      : '搜索歌名 / 歌手 / 专辑'
    const button = $('#music-search-btn span')
    if (button) button.textContent = platform.searchable === false ? '解析链接' : '搜索'
    const login = $('#music-login')
    if (login) {
      login.hidden = platform.searchable === false
      login.textContent = platform.loggedIn ? '会员已登录' : '登录会员'
    }
  }

  function selectPlatform(key) {
    if (!platformInfo(key)) return
    if (state.platform !== key) {
      state.platform = key
      state.results = []
      state.playlist = []
      if (state.tab === 'results') renderList()
    }
    try {
      localStorage.setItem('csp.musicPlatform', key)
    } catch {
      /* 忽略 */
    }
    $$('.music-platform-card').forEach((card) => {
      card.classList.toggle('active', card.dataset.platform === key)
    })
    updateBadge()
    const input = $('#music-search-input')
    if (input) input.focus()
  }

  // ---------------------------------------------------------------------------
  // 歌词
  // ---------------------------------------------------------------------------

  const LRC_TIME_RE = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

  function parseLrc(raw) {
    const text = String(raw || '')
    if (!text.trim()) return []
    const rows = []
    for (const line of text.split(/\r?\n/)) {
      const times = []
      LRC_TIME_RE.lastIndex = 0
      let match
      while ((match = LRC_TIME_RE.exec(line)) !== null) {
        const minutes = Number(match[1]) || 0
        const seconds = Number(match[2]) || 0
        const fraction = match[3] ? Number(`0.${match[3]}`) : 0
        times.push(minutes * 60 + seconds + fraction)
      }
      const content = line.replace(LRC_TIME_RE, '').trim()
      if (!content) continue
      for (const time of times) rows.push({ time, text: content })
    }
    return rows.sort((left, right) => left.time - right.time)
  }

  function mergeTranslations(lines, translation) {
    if (!lines.length || !translation) return lines
    const extra = parseLrc(translation)
    if (!extra.length) return lines
    const byTime = new Map(extra.map((line) => [Math.round(line.time * 10) / 10, line.text]))
    return lines.map((line) => ({
      ...line,
      trans: byTime.get(Math.round(line.time * 10) / 10) || '',
    }))
  }

  function renderLyrics(lines) {
    const box = $('#music-lyrics')
    if (!box) return
    state.lyricLines = Array.isArray(lines) ? lines : []
    state.activeLyric = -1
    if (!state.lyricLines.length) {
      box.innerHTML = '<div class="music-lyrics-empty">这首歌暂时没有歌词，或平台没有返回 LRC</div>'
      return
    }
    box.innerHTML = state.lyricLines
      .map(
        (line, index) => `<button class="music-lyric-line" data-index="${index}" data-time="${Number(line.time) || 0}">
          <span>${escapeHtml(line.text)}</span>
          ${line.trans ? `<small>${escapeHtml(line.trans)}</small>` : ''}
        </button>`,
      )
      .join('')
  }

  function updateActiveLyric(time) {
    if (!state.lyricLines.length) return
    let index = -1
    for (let i = 0; i < state.lyricLines.length; i += 1) {
      if (state.lyricLines[i].time <= time + 0.15) index = i
      else break
    }
    if (index === state.activeLyric) return
    state.activeLyric = index
    const box = $('#music-lyrics')
    if (!box) return
    box.querySelectorAll('.music-lyric-line').forEach((node) => {
      const active = Number(node.dataset.index) === index
      node.classList.toggle('active', active)
      node.classList.toggle('near', Math.abs(Number(node.dataset.index) - index) <= 2)
    })
    const activeNode = box.querySelector(`.music-lyric-line[data-index="${index}"]`)
    if (activeNode) {
      // 不能用 scrollIntoView：它会连整个音乐面板 / 页面一起滚动，
      // 把顶部的平台卡片和播放器标题顶出可视区。只滚歌词容器自己。
      const boxRect = box.getBoundingClientRect()
      const lineRect = activeNode.getBoundingClientRect()
      const target = box.scrollTop + lineRect.top - boxRect.top - box.clientHeight / 2 + lineRect.height / 2
      try {
        box.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
      } catch {
        box.scrollTop = Math.max(0, target)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 列表
  // ---------------------------------------------------------------------------

  function currentList() {
    if (state.tab === 'history') return state.history
    if (state.tab === 'favorites') return state.favorites
    return state.results
  }

  function listRow(song, { remove = false } = {}) {
    const platform = platformInfo(song.platform)
    const key = songKey(song)
    const active = songKey(state.current) === key
    const cover = song.cover
      ? `<img class="music-row-cover" src="${escapeHtml(song.cover)}" alt="" loading="lazy" />`
      : `<span class="music-row-cover ph" style="--brand:${platform?.color || '#37e08b'}">♪</span>`
    return `<li class="music-row${active ? ' active' : ''}" data-key="${escapeHtml(key)}">
      <button class="music-row-main" data-action="play" title="播放 ${escapeHtml(song.title || '')}">
        ${cover}
        <span class="music-row-info">
          <b>${escapeHtml(song.title || '未命名歌曲')}${song.vip ? '<i class="music-vip">VIP</i>' : ''}</b>
          <small>${escapeHtml([song.artist, song.album].filter(Boolean).join(' · ') || platform?.name || '')}</small>
        </span>
        <span class="music-row-time">${formatSeconds(song.duration)}</span>
      </button>
      <div class="music-row-actions">
        <button class="music-row-btn" data-action="favorite" title="收藏 / 取消收藏">${isFavorite(song) ? '♥' : '♡'}</button>
        <button class="music-row-btn" data-action="download" title="下载当前歌曲">↓</button>
        ${remove ? '<button class="music-row-btn danger" data-action="remove" title="删除">×</button>' : ''}
      </div>
    </li>`
  }

  function isFavorite(song) {
    return state.favorites.some((item) => songKey(item) === songKey(song))
  }

  function downloadRow(item) {
    const statusText =
      item.status === 'running'
        ? `下载中 ${Number(item.percent) || 0}%`
        : item.status === 'done'
          ? item.existed
            ? '已存在，跳过'
            : '已完成'
          : item.status === 'failed'
            ? `失败${item.error ? `：${escapeHtml(item.error)}` : ''}`
            : item.status === 'cancelled'
              ? '已取消'
              : '等待中'
    return `<li class="music-download-row ${item.status}" data-id="${escapeHtml(item.id)}">
      <span class="music-download-main">
        <b>${escapeHtml(item.title || '歌曲')}</b>
        <small>${escapeHtml(item.platformName || '')} · ${escapeHtml(item.format || 'mp3')} · ${statusText}</small>
        ${item.savedPath ? `<em>${escapeHtml(item.savedPath)}</em>` : ''}
      </span>
      <button class="music-row-btn" data-action="reveal" title="在文件夹中显示"${item.savedPath ? '' : ' hidden'}>↗</button>
    </li>`
  }

  function renderList() {
    const list = $('#music-list')
    const head = $('#music-list-head')
    if (!list || !head) return
    if (state.tab === 'downloads') {
      head.innerHTML = `<span>下载记录 <em>${state.downloads.length}</em></span><button class="mini-btn" data-list-action="clear-downloads">清空已完成</button>`
      list.innerHTML = state.downloads.length
        ? state.downloads.map(downloadRow).join('')
        : '<li class="music-list-empty">还没有下载任务</li>'
      return
    }
    const items = currentList()
    if (state.tab === 'results') {
      const platform = platformInfo(state.platform)
      head.innerHTML = `<span>${platform?.short || platform?.name || '搜索结果'} <em>${items.length ? `${items.length} 首` : ''}</em></span>`
    } else if (state.tab === 'history') {
      head.innerHTML = `<span>播放记录 <em>${items.length}</em></span><button class="mini-btn" data-list-action="clear-history">清空</button>`
    } else {
      head.innerHTML = `<span>我的收藏 <em>${items.length}</em></span><button class="mini-btn" data-list-action="clear-favorites">清空</button>`
    }
    if (!items.length) {
      const empty = state.tab === 'results'
        ? '搜索后结果显示在这里'
        : state.tab === 'history'
          ? '播放过的歌曲会自动记录'
          : '点歌曲旁边的 ♡ 收藏'
      list.innerHTML = `<li class="music-list-empty">${empty}</li>`
      return
    }
    list.innerHTML = items.map((song) => listRow(song, { remove: state.tab !== 'results' })).join('')
  }

  function switchTab(tab) {
    if (!['results', 'history', 'favorites', 'downloads'].includes(tab)) return
    state.tab = tab
    $$('#music-tabs button').forEach((button) => button.classList.toggle('active', button.dataset.mtab === tab))
    renderList()
  }

  // ---------------------------------------------------------------------------
  // 播放
  // ---------------------------------------------------------------------------

  function songPageUrl(song) {
    if (!song) return ''
    if (song.url) return song.url
    const id = encodeURIComponent(song.id || '')
    if (song.platform === 'netease') return `https://music.163.com/#/song?id=${id}`
    if (song.platform === 'qq') return `https://y.qq.com/n/ryqq/songDetail/${id}`
    if (song.platform === 'kugou') return `https://www.kugou.com/song/#hash=${id}`
    if (song.platform === 'kuwo') return `https://www.kuwo.cn/play_detail/${id}`
    return platformInfo(song.platform)?.home || ''
  }

  function normalSong(song) {
    const platform = platformInfo(song.platform) || platformInfo(state.platform)
    return {
      platform: song.platform || state.platform,
      platformName: song.platformName || platform?.name || '',
      id: String(song.id || ''),
      title: song.title || '',
      artist: song.artist || '',
      album: song.album || '',
      cover: song.cover || '',
      duration: Number(song.duration) || 0,
      vip: Boolean(song.vip),
      url: song.url || '',
    }
  }

  async function playSong(rawSong, playlist = null) {
    const song = normalSong(rawSong)
    if (!song.id && !song.url) {
      toast('歌曲信息不完整', 'warn')
      return
    }
    if (Array.isArray(playlist) && playlist.length) state.playlist = playlist
    else if (!state.playlist.some((item) => songKey(item) === songKey(song))) state.playlist = currentList()
    state.current = song
    state.pendingSong = song
    state.resolved = null
    const token = ++state.resolveToken
    setLoading('正在准备播放…', '正在向平台取播放地址，会员歌曲会自动尝试换源。')
    let result = null
    try {
      result = await window.desktop.musicResolve({
        platform: song.platform,
        song,
        quality: '320',
        format: 'mp3',
      })
    } catch (error) {
      result = { ok: false, error: String(error?.message || error) }
    }
    if (token !== state.resolveToken) return
    if (!result?.ok) {
      state.pendingSong = song
      showError(
        result?.error || '没有拿到可播放地址',
        `${result?.error || ''}\n${result?.hint || '可以登录平台会员账号后再试；没有会员时，程序会尝试其它平台的同名单曲。'}`.trim(),
      )
      setStatus(`音乐播放失败：${result?.error || '未知原因'}`)
      return
    }
    applyResolved(result, song)
  }

  function applyResolved(result, song) {
    state.resolved = result
    state.current = { ...song, ...result, platform: song.platform }
    showStage('player')
    const platform = platformInfo(song.platform)
    const title = result.title || song.title || '未命名歌曲'
    const artist = result.artist || song.artist || ''
    const album = result.album || song.album || ''
    const cover = result.cover || song.cover || ''
    $('#music-title').textContent = title
    $('#music-artist').textContent = artist || '未知歌手'
    $('#music-album').textContent = album ? `专辑：${album}` : ''
    $('#music-source').textContent = platform?.short || platform?.name || result.platformName || '音乐'
    $('#music-source').style.setProperty('--brand', platform?.color || '#37e08b')
    const formatLabel = result.format === 'flac' ? 'FLAC · 无损' : String(result.format || 'mp3').toUpperCase()
    const bitrateLabel = result.format === 'flac' ? '' : result.bitrate ? ` · ${Math.round(Number(result.bitrate) / 1000)}K` : ''
    $('#music-quality-tag').textContent = `${formatLabel}${bitrateLabel}`
    const via = $('#music-via')
    via.hidden = !result.via
    via.textContent = result.via ? `换源 · ${result.viaName || '酷我音乐'}` : ''
    const image = $('#music-cover')
    const bg = $('#music-bg')
    if (cover) {
      image.src = cover
      bg.src = cover
      bg.hidden = false
    } else {
      image.src = 'assets/app-icon.png'
      bg.removeAttribute('src')
      bg.hidden = true
    }
    const note = $('#music-note')
    const noteText = result.note || ''
    note.textContent = noteText
    note.title = noteText
    note.hidden = !noteText
    renderQualityOptions(result)
    updateFavoriteButton()
    renderLyrics(mergeTranslations(parseLrc(result.lyric), result.translation))
    const audio = $('#music-audio')
    const target = result.streamUrl || result.playUrl
    try {
      audio.src = target
      audio.load()
      audio.play().catch(() => {})
    } catch {
      /* 忽略 */
    }
    state.lastHistoryKey = ''
    rememberPlayed(state.current)
    setStatus(`正在播放：${title}${artist ? ` - ${artist}` : ''}`)
  }

  function renderQualityOptions(result) {
    const select = $('#music-quality')
    if (!select) return
    const qualities = Array.isArray(result.qualities) ? result.qualities : []
    select.innerHTML = qualities
      .map(
        (quality) =>
          `<option value="${escapeHtml(quality.key)}"${quality.available === false ? ' disabled' : ''}>${escapeHtml(quality.label)}${quality.available === false ? '（不可用）' : ''}</option>`,
      )
      .join('')
    const preferred = qualities.find((item) => item.key === '320' && item.available !== false) || qualities.find((item) => item.available !== false)
    if (preferred) select.value = preferred.key
    const flac = qualities.find((item) => item.key === 'flac')
    const flacButton = $('#music-download-flac')
    if (flacButton) {
      flacButton.disabled = !flac || flac.available === false
      flacButton.title = flacButton.disabled ? '这个平台 / 账号没有可用的无损音源' : '下载无损 FLAC'
    }
  }

  function updateFavoriteButton() {
    const button = $('#music-fav')
    if (!button || !state.current) return
    const on = isFavorite(state.current)
    button.textContent = on ? '♥ 已收藏' : '♡ 收藏'
    button.classList.toggle('on', on)
  }

  async function rememberPlayed(song) {
    const key = songKey(song)
    if (!key || state.lastHistoryKey === key) return
    state.lastHistoryKey = key
    try {
      state.history = await window.desktop.musicHistoryAdd({
        platform: song.platform,
        platformName: song.platformName || platformInfo(song.platform)?.name || '',
        id: song.id,
        url: song.url || '',
        title: song.title,
        artist: song.artist,
        album: song.album,
        cover: song.cover,
        duration: song.duration,
        vip: song.vip,
      })
      if (state.tab === 'history') renderList()
    } catch {
      /* 历史记录失败不影响播放 */
    }
  }

  function togglePlay() {
    const audio = $('#music-audio')
    if (!audio) return
    if (!audio.src) {
      if (state.current) playSong(state.current)
      return
    }
    if (audio.paused) audio.play().catch(() => {})
    else audio.pause()
  }

  function playSibling(delta) {
    const list = state.playlist.length ? state.playlist : state.results
    if (!list.length) return
    const index = list.findIndex((item) => songKey(item) === songKey(state.current))
    const next = list[(index + delta + list.length) % list.length]
    if (next) playSong(next, list)
  }

  async function toggleFavorite(song = null) {
    const target = normalSong(song || state.current)
    if (!target.id) return
    const key = songKey(target)
    const exists = state.favorites.some((item) => songKey(item) === key)
    try {
      state.favorites = exists
        ? await window.desktop.musicFavoriteRemove(key)
        : await window.desktop.musicFavoriteAdd({
            platform: target.platform,
            platformName: target.platformName || platformInfo(target.platform)?.name || '',
            id: target.id,
            url: target.url || '',
            title: target.title,
            artist: target.artist,
            album: target.album,
            cover: target.cover,
            duration: target.duration,
            vip: target.vip,
          })
      updateFavoriteButton()
      renderList()
      toast(exists ? '已取消收藏' : '已收藏到「我的收藏」', 'ok')
    } catch {
      toast('收藏失败', 'error')
    }
  }

  // ---------------------------------------------------------------------------
  // 下载
  // ---------------------------------------------------------------------------

  function currentDownloadFormat() {
    const select = $('#music-quality')
    const key = select?.value || '320'
    return key === 'flac' ? 'flac' : key
  }

  function startDownload(format) {
    if (!state.current || !state.resolved) {
      toast('先播放一首歌再下载', 'warn')
      return
    }
    if (format === 'flac') {
      const option = Array.from($('#music-quality')?.options || []).find((item) => item.value === 'flac')
      if (!option || option.disabled) {
        toast('这个平台 / 当前账号没有可用的无损音源，已保留 MP3 下载', 'warn', 4800)
        return
      }
    }
    const quality = format === 'flac' ? 'flac' : currentDownloadFormat() === 'flac' ? '320' : currentDownloadFormat()
    const item = {
      id: `mq-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
      title: state.current.title,
      platformName: state.current.platformName || platformInfo(state.current.platform)?.name || '',
      format,
      quality,
      song: state.current,
      status: 'queued',
      percent: 0,
      savedPath: '',
      error: '',
    }
    state.downloads.unshift(item)
    switchTab('downloads')
    renderList()
    toast(`已加入下载队列：${item.title}（${format === 'flac' ? 'FLAC' : 'MP3'}）`, 'ok')
    processDownloadQueue()
  }

  async function processDownloadQueue() {
    if (state.downloadRunning) return
    state.downloadRunning = true
    try {
      for (;;) {
        const item = state.downloads.find((entry) => entry.status === 'queued')
        if (!item) break
        item.status = 'running'
        item.percent = 0
        renderList()
        let response = null
        try {
          response = await window.desktop.musicDownload({
            id: item.id,
            platform: item.song.platform,
            song: item.song,
            quality: item.quality,
            format: item.format,
            withLyric: true,
          })
        } catch (error) {
          response = { ok: false, error: String(error?.message || error) }
        }
        if (response?.exists) {
          item.status = 'done'
          item.existed = true
          item.savedPath = response.savedPath || ''
          renderList()
          continue
        }
        if (!response?.ok) {
          item.status = 'failed'
          item.error = response?.error || '启动下载失败'
          renderList()
          continue
        }
        const serverId = response.id || item.id
        item.serverId = serverId
        if (response.format) item.format = response.format
        if (response.via) item.via = response.via
        for (let tick = 0; tick < 240; tick += 1) {
          await new Promise((resolve) => setTimeout(resolve, 700))
          let snapshot = null
          try {
            snapshot = await window.desktop.musicDownloadSnapshot(serverId)
          } catch {
            snapshot = null
          }
          if (!snapshot) continue
          item.percent = Number(snapshot.percent) || item.percent
          if (snapshot.status === 'done') {
            item.status = 'done'
            item.percent = 100
            item.savedPath = snapshot.savedPath || ''
            item.lyricPath = snapshot.lyricPath || ''
            break
          }
          if (snapshot.status === 'failed' || snapshot.status === 'cancelled') {
            item.status = snapshot.status
            item.error = snapshot.error || ''
            break
          }
          renderList()
        }
        if (item.status === 'running') {
          item.status = 'failed'
          item.error = '下载超时'
        }
        renderList()
      }
    } finally {
      state.downloadRunning = false
      renderList()
    }
  }

  async function saveLyric() {
    if (!state.resolved?.lyric) {
      toast('这首歌还没有拿到歌词', 'warn')
      return
    }
    try {
      const result = await window.desktop.musicSaveLyric({
        platformName: state.current?.platformName || platformInfo(state.current?.platform)?.name || '音乐',
        title: state.current?.title || '',
        artist: state.current?.artist || '',
        lyric: state.resolved.lyric,
      })
      if (result?.ok) toast(result.exists ? '歌词文件已存在' : `歌词已保存：${result.path}`, 'ok', 5200)
      else toast(`歌词保存失败：${result?.error || '未知原因'}`, 'error')
    } catch (error) {
      toast(`歌词保存失败：${String(error?.message || error)}`, 'error')
    }
  }

  // ---------------------------------------------------------------------------
  // 搜索 / 登录
  // ---------------------------------------------------------------------------

  async function doSearch() {
    const input = $('#music-search-input')
    const value = String(input?.value || '').trim()
    if (!value) {
      toast('先输入歌名 / 歌手，或粘贴分享链接', 'warn')
      input?.focus()
      return
    }
    if (isQishuiUrl(value)) {
      selectPlatform('qishui')
      await resolveLink(value)
      return
    }
    const platform = platformInfo(state.platform)
    if (platform?.searchable === false) {
      showError(
        '汽水音乐网页版不开放搜索',
        '请在汽水 App 里打开歌曲 → 分享 → 复制链接，再粘贴到上方输入框；也可以点「粘贴」直接读取剪贴板。',
        { loginable: false },
      )
      return
    }
    const token = ++state.searchToken
    state.keyword = value
    state.pendingSong = null
    if (!state.current || $('#music-player').hidden) setLoading('正在搜索…', `正在请求${platform?.name || '平台'}，通常 1–5 秒。`)
    else $('#music-list-head').textContent = '搜索中…'
    let result = null
    try {
      result = await window.desktop.musicSearch({ platform: state.platform, keyword: value })
    } catch (error) {
      result = { ok: false, error: String(error?.message || error) }
    }
    if (token !== state.searchToken) return
    if (!result?.ok) {
      showError('搜索失败', result?.error || '平台没有返回结果', { loginable: false })
      return
    }
    state.results = Array.isArray(result.songs) ? result.songs : []
    state.playlist = state.results
    switchTab('results')
    if (!state.current || $('#music-player').hidden) {
      if (!state.results.length) showError('没有找到歌曲', '换个关键词，或换一个平台试试。', { loginable: false })
      else showStage('empty')
    }
    setStatus(`搜索完成：${state.results.length} 首 · ${platform?.name || ''}`)
    if (!state.results.length) toast('没有找到歌曲，换个关键词试试', 'warn')
  }

  async function resolveLink(url) {
    if (!isQishuiUrl(url)) {
      toast('目前支持粘贴汽水音乐的歌曲分享链接', 'warn')
      return
    }
    const input = $('#music-search-input')
    if (input) input.value = url
    const parsed = musicUrlInfo(url)
    const song = {
      platform: 'qishui',
      platformName: '汽水音乐',
      id: parsed?.id || '',
      title: '汽水音乐',
      artist: '',
      url,
    }
    const token = ++state.resolveToken
    state.pendingSong = song
    setLoading('正在解析汽水音乐分享链接…', '需要打开汽水分享页抓取音频和歌词，通常 8–20 秒。')
    let result = null
    try {
      result = await window.desktop.musicResolve({ platform: 'qishui', song, quality: '320', format: 'mp3' })
    } catch (error) {
      result = { ok: false, error: String(error?.message || error) }
    }
    if (token !== state.resolveToken) return
    if (!result?.ok) {
      showError('汽水链接解析失败', result?.error || '分享页没有返回音频', { loginable: false })
      return
    }
    applyResolved(result, { ...song, ...result, title: result.title || song.title })
    if (result.preview) toast('汽水网页版只给 30 秒试听；完整版会自动尝试换源', 'warn', 6000)
  }

  async function doLogin() {
    if (state.loginBusy) return
    const platform = platformInfo(state.platform)
    if (!platform) return
    if (platform.searchable === false) {
      toast('汽水音乐网页版不支持登录，请直接使用分享链接', 'warn')
      return
    }
    state.loginBusy = true
    const button = $('#music-login')
    if (button) {
      button.disabled = true
      button.textContent = '登录中…'
    }
    toast(`已打开${platform.name}登录窗口：登录完成后关闭该窗口，登录状态会自动保存`, 'ok', 6000)
    try {
      const result = await window.desktop.musicLogin(platform.key)
      if (result?.ok) {
        platform.loggedIn = Boolean(result.loggedIn)
        updateLoginChips()
        updateBadge()
        toast(
          result.loggedIn
            ? `已保存${platform.name}登录状态，再点一次播放即可尝试会员音质`
            : `没有检测到登录 Cookie；请确认已经登录成功后再关闭窗口`,
          result.loggedIn ? 'ok' : 'warn',
          6000,
        )
      } else {
        toast(`登录失败：${result?.error || '未知原因'}`, 'error')
      }
    } catch (error) {
      toast(`登录失败：${String(error?.message || error)}`, 'error')
    } finally {
      state.loginBusy = false
      if (button) {
        button.disabled = false
        updateBadge()
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 事件
  // ---------------------------------------------------------------------------

  function bindEvents() {
    $('#music-platform-grid')?.addEventListener('click', (event) => {
      const card = event.target.closest('.music-platform-card')
      if (!card) return
      if (event.target.closest('[data-action="select"]')) selectPlatform(card.dataset.platform)
    })
    $('#music-search-btn')?.addEventListener('click', doSearch)
    $('#music-search-input')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        doSearch()
      }
    })
    $('#music-paste')?.addEventListener('click', async () => {
      try {
        const text = await window.desktop.readClipboard()
        const raw = String(text || '').trim()
        if (!raw) {
          toast('剪贴板里没有内容', 'warn')
          return
        }
        const match = raw.match(/https?:\/\/[^\s"'<>]+/i)
        const url = (match ? match[0] : raw).replace(/[，。、；）)\]】]+$/, '')
        $('#music-search-input').value = url
        if (isQishuiUrl(url)) {
          selectPlatform('qishui')
          resolveLink(url)
        } else {
          toast('已粘贴到输入框')
          $('#music-search-input').focus()
        }
      } catch {
        toast('读取剪贴板失败', 'error')
      }
    })
    $('#music-clear')?.addEventListener('click', () => {
      $('#music-search-input').value = ''
      $('#music-search-input').focus()
      updateBadge()
    })
    $('#music-login')?.addEventListener('click', doLogin)
    $('#music-error-login')?.addEventListener('click', doLogin)
    $('#music-error-retry')?.addEventListener('click', () => {
      if (state.pendingSong) playSong(state.pendingSong)
      else doSearch()
    })
    $('#music-error-clear')?.addEventListener('click', () => {
      showStage('empty')
      $('#music-search-input')?.focus()
    })
    $('#music-tabs')?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-mtab]')
      if (button) switchTab(button.dataset.mtab)
    })
    $('#music-list')?.addEventListener('click', async (event) => {
      const action = event.target.closest('[data-list-action]')
      if (action) {
        await handleListAction(action.dataset.listAction)
        return
      }
      const row = event.target.closest('.music-row')
      if (row) {
        const song = currentList().find((item) => songKey(item) === row.dataset.key)
        if (!song) return
        const button = event.target.closest('[data-action]')
        if (button?.dataset.action === 'favorite') {
          toggleFavorite(song)
          return
        }
        if (button?.dataset.action === 'download') {
          if (songKey(state.current) !== songKey(song)) await playSong(song, currentList())
          startDownload('mp3')
          return
        }
        if (button?.dataset.action === 'remove') {
          if (state.tab === 'history') {
            state.history = await window.desktop.musicHistoryRemove(row.dataset.key)
          } else if (state.tab === 'favorites') {
            state.favorites = await window.desktop.musicFavoriteRemove(row.dataset.key)
          }
          renderList()
          return
        }
        playSong(song, currentList())
        return
      }
      const download = event.target.closest('.music-download-row')
      if (download) {
        const item = state.downloads.find((entry) => entry.id === download.dataset.id)
        if (item?.savedPath) window.desktop.musicReveal(item.savedPath)
      }
    })
    $('#music-fav')?.addEventListener('click', () => toggleFavorite())
    $('#music-download-mp3')?.addEventListener('click', () => startDownload('mp3'))
    $('#music-download-flac')?.addEventListener('click', () => startDownload('flac'))
    $('#music-download-lrc')?.addEventListener('click', saveLyric)
    $('#music-open')?.addEventListener('click', () => {
      const url = songPageUrl(state.current)
      if (url) window.desktop.openExternal(url)
      else toast('没有可打开的平台页面', 'warn')
    })
    $('#music-toggle')?.addEventListener('click', togglePlay)
    $('#music-prev')?.addEventListener('click', () => playSibling(-1))
    $('#music-next')?.addEventListener('click', () => playSibling(1))
    $('#music-mute')?.addEventListener('click', () => {
      const audio = $('#music-audio')
      if (!audio) return
      audio.muted = !audio.muted
      $('#music-mute').textContent = audio.muted ? '🔇' : '🔊'
    })
    $('#music-volume')?.addEventListener('input', (event) => {
      const audio = $('#music-audio')
      if (!audio) return
      audio.muted = false
      audio.volume = Math.max(0, Math.min(1, Number(event.target.value) / 100))
      try {
        localStorage.setItem('csp.musicVolume', String(event.target.value))
      } catch {
        /* 忽略 */
      }
      $('#music-mute').textContent = audio.volume === 0 ? '🔇' : '🔊'
    })
    $('#music-seek')?.addEventListener('input', (event) => {
      const audio = $('#music-audio')
      if (!audio || !Number.isFinite(audio.duration)) return
      audio.currentTime = (Number(event.target.value) / 1000) * audio.duration
    })
    $('#music-quality')?.addEventListener('change', async () => {
      if (!state.current) return
      const quality = currentDownloadFormat()
      const format = quality === 'flac' ? 'flac' : 'mp3'
      const audio = $('#music-audio')
      const at = audio?.currentTime || 0
      const wasPlaying = audio ? !audio.paused : false
      const token = ++state.resolveToken
      toast(`正在切换音质：${quality === 'flac' ? '无损 FLAC' : `${quality}K`}`, 'info')
      let result = null
      try {
        result = await window.desktop.musicResolve({ platform: state.current.platform, song: state.current, quality, format })
      } catch (error) {
        result = { ok: false, error: String(error?.message || error) }
      }
      if (token !== state.resolveToken) return
      if (!result?.ok) {
        toast(`切换失败：${result?.error || '没有可用音源'}`, 'warn', 5200)
        return
      }
      applyResolved(result, state.current)
      if (audio) {
        audio.currentTime = at
        if (wasPlaying) audio.play().catch(() => {})
      }
    })
    $('#music-lyrics')?.addEventListener('click', (event) => {
      const line = event.target.closest('.music-lyric-line')
      if (!line) return
      const audio = $('#music-audio')
      if (!audio) return
      audio.currentTime = Number(line.dataset.time) || 0
      audio.play().catch(() => {})
    })

    const audio = $('#music-audio')
    if (audio) {
      const savedVolumeText = localStorage.getItem('csp.musicVolume')
      const savedVolume = savedVolumeText == null ? NaN : Number(savedVolumeText)
      if (Number.isFinite(savedVolume) && savedVolume > 0 && savedVolume <= 100) {
        audio.volume = savedVolume / 100
      } else {
        audio.volume = 0.8
      }
      const volumeInput = $('#music-volume')
      if (volumeInput) volumeInput.value = String(Math.round(audio.volume * 100))
      audio.addEventListener('timeupdate', () => {
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) return
        $('#music-pos').textContent = formatSeconds(audio.currentTime)
        $('#music-dur').textContent = formatSeconds(audio.duration)
        $('#music-seek').value = String(Math.round((audio.currentTime / audio.duration) * 1000))
        updateActiveLyric(audio.currentTime)
      })
      audio.addEventListener('loadedmetadata', () => {
        $('#music-dur').textContent = formatSeconds(audio.duration)
        $('#music-seek').value = '0'
        updateActiveLyric(0)
      })
      audio.addEventListener('play', () => {
        $('#music-toggle').textContent = '⏸'
      })
      audio.addEventListener('pause', () => {
        $('#music-toggle').textContent = '▶'
      })
      audio.addEventListener('ended', () => {
        $('#music-toggle').textContent = '▶'
        if (state.playlist.length > 1) playSibling(1)
      })
      audio.addEventListener('error', () => {
        if (!audio.src) return
        toast('音频加载失败：音源可能已过期，点「重试」或换一首歌', 'warn', 5600)
      })
    }
  }

  async function handleListAction(action) {
    if (action === 'clear-downloads') {
      state.downloads = state.downloads.filter((item) => item.status === 'queued' || item.status === 'running')
      renderList()
      return
    }
    if (action === 'clear-history') {
      state.history = await window.desktop.musicHistoryClear()
      renderList()
      toast('已清空播放记录')
      return
    }
    if (action === 'clear-favorites') {
      state.favorites = await window.desktop.musicFavoritesClear()
      renderList()
      toast('已清空收藏')
    }
  }

  // ---------------------------------------------------------------------------
  // 初始化 / 对外接口
  // ---------------------------------------------------------------------------

  async function init() {
    if (state.inited) return
    state.inited = true
    bindEvents()
    try {
      const config = await window.desktop.getConfig()
      state.history = Array.isArray(config?.musicHistory) ? config.musicHistory : []
      state.favorites = Array.isArray(config?.musicFavorites) ? config.musicFavorites : []
    } catch {
      /* 忽略 */
    }
    await refreshPlatforms()
    renderList()
    showStage('empty')
    updateBadge()
    const login = platformInfo(state.platform)
    if (login) selectPlatform(login.key)
  }

  function show() {
    if (!state.inited) init()
    else {
      updateBadge()
      updateLoginChips()
    }
  }

  function pause() {
    const audio = $('#music-audio')
    if (audio && !audio.paused) audio.pause()
  }

  function openLink(url) {
    if (!isQishuiUrl(url)) {
      toast('目前外部链接只支持汽水音乐分享链接', 'warn')
      return
    }
    selectPlatform('qishui')
    resolveLink(url)
  }

  // 图文教程 / 截图用的演示数据：不联网，直接铺一套播放器和列表。
  function renderDemo({ song, result, results = [] }) {
    if (!song || !result) return false
    state.platform = song.platform || state.platform
    state.current = { ...song, ...result, platform: song.platform || state.platform }
    state.resolved = result
    state.results = Array.isArray(results) ? results : []
    state.playlist = state.results.length ? state.results : [state.current]
    switchTab('results')
    applyResolved(result, state.current)
    renderList()
    selectPlatform(state.platform)
    return true
  }

  window.MusicUI = {
    init,
    show,
    pause,
    openLink,
    renderDemo,
    setActiveLyric: (index) => {
      const line = state.lyricLines[Number(index)]
      if (line) updateActiveLyric(Number(line.time) + 0.01)
    },
    isMusicUrl: (url) => Boolean(musicUrlInfo(url)),
    state,
  }
})()
