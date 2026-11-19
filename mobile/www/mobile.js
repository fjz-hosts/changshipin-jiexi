/* 手机端交互：自定义播放器控件、长按倍速、双击快进、上下滑动音量/亮度、底部导航。 */
;(function () {
  'use strict'

  const N = window.CSPNative
  const $ = (selector) => document.querySelector(selector)
  const $$ = (selector) => Array.from(document.querySelectorAll(selector))
  const isIOS = N.platform === 'ios'

  document.body.classList.add('mobile-app')
  document.documentElement.style.setProperty('--csp-platform', N.platform)

  // -------------------------------------------------------------------------
  // 轻量提示（不依赖 app.js 内部 toast）
  // -------------------------------------------------------------------------
  function showToast(message, kind = 'info', timeout = 3600) {
    const stack = $('#toast-stack')
    if (!stack) return
    const node = document.createElement('div')
    node.className = `toast ${kind}`
    node.textContent = String(message || '')
    stack.appendChild(node)
    const remove = () => {
      node.style.opacity = '0'
      node.style.transition = 'opacity .2s ease'
      setTimeout(() => node.remove(), 220)
    }
    node.addEventListener('click', remove)
    setTimeout(remove, timeout)
  }

  window.__cspShim?.setToastBridge?.(showToast)

  // -------------------------------------------------------------------------
  // 底部导航
  // -------------------------------------------------------------------------
  const tabbar = $('#mobile-tabbar')
  function setTab(name) {
    if (!tabbar) return
    $$('#mobile-tabbar button').forEach((button) => {
      button.classList.toggle('active', button.dataset.mtab === name)
    })
  }

  function closeOverlays() {
    const browser = $('#browser-panel')
    if (browser && !browser.hidden) {
      const close = $('#browser-close')
      if (close) close.click()
      return true
    }
    if (document.body.classList.contains('cinema')) {
      const fullscreen = $('#btn-fullscreen')
      if (fullscreen) fullscreen.click()
      return true
    }
    return false
  }

  if (tabbar) {
    tabbar.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-mtab]')
      if (!button) return
      const tab = button.dataset.mtab
      setTab(tab)
      if (tab !== 'lines' && tab !== 'settings') closeOverlays()
      if (tab === 'home') {
        window.scrollTo({ top: 0, behavior: 'smooth' })
        return
      }
      if (tab === 'lines') {
        $('#btn-lines')?.click()
        return
      }
      if (tab === 'history') {
        const panel = $('.history-panel')
        if (panel) {
          panel.scrollIntoView({ behavior: 'smooth', block: 'start' })
          panel.style.boxShadow = '0 0 0 1px rgba(55, 224, 139, .5), 0 14px 40px -24px rgba(55, 224, 139, .5)'
          setTimeout(() => {
            panel.style.boxShadow = ''
          }, 1400)
        }
        return
      }
      if (tab === 'settings') {
        $('#btn-settings')?.click()
      }
    })
  }

  // 打开内置浏览器时隐藏顶栏 / 底部导航，让出整屏
  const browserPanel = $('#browser-panel')
  if (browserPanel) {
    const sync = () => document.body.classList.toggle('browser-open', !browserPanel.hidden)
    new MutationObserver(sync).observe(browserPanel, { attributes: true, attributeFilter: ['hidden'] })
    sync()
  }

  // -------------------------------------------------------------------------
  // 全屏退出按钮
  // -------------------------------------------------------------------------
  const fsExit = document.createElement('button')
  fsExit.className = 'mobile-fs-exit'
  fsExit.type = 'button'
  fsExit.innerHTML = '✕ 退出全屏'
  fsExit.addEventListener('click', () => $('#btn-fullscreen')?.click())
  document.body.appendChild(fsExit)

  // Esc 在手机外接键盘时也退出
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.classList.contains('cinema')) {
      $('#btn-fullscreen')?.click()
    }
  })

  // -------------------------------------------------------------------------
  // 自定义播放器
  // -------------------------------------------------------------------------
  function formatTime(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0))
    const h = Math.floor(value / 3600)
    const m = Math.floor((value % 3600) / 60)
    const s = value % 60
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  const viewVideo = $('#view-video')
  const video = $('#video')
  if (viewVideo && video) {
    video.removeAttribute('controls')
    video.setAttribute('playsinline', '')
    video.setAttribute('webkit-playsinline', '')
    video.controls = false

    const gesture = document.createElement('div')
    gesture.className = 'video-gesture-layer'

    const hint = document.createElement('div')
    hint.className = 'player-hint'

    const seekLeft = document.createElement('div')
    seekLeft.className = 'player-seek-indicator left'
    const seekRight = document.createElement('div')
    seekRight.className = 'player-seek-indicator right'

    const mask = document.createElement('div')
    mask.className = 'brightness-mask'

    const controls = document.createElement('div')
    controls.className = 'player-controls'
    controls.innerHTML = `
      <div class="pc-row">
        <span class="pc-time" data-pc-current>00:00</span>
        <input class="pc-progress" type="range" min="0" max="1000" value="0" step="1" aria-label="播放进度" />
        <span class="pc-time" data-pc-duration>00:00</span>
      </div>
      <div class="pc-row">
        <button class="pc-btn" data-pc="toggle" title="播放 / 暂停">▶</button>
        <button class="pc-btn wide" data-pc="speed" title="播放速度">1.0x</button>
        <button class="pc-btn wide" data-pc="episodes" title="选集">选集</button>
        <span style="flex:1"></span>
        <button class="pc-btn" data-pc="fullscreen" title="全屏">⛶</button>
      </div>
    `

    viewVideo.appendChild(gesture)
    viewVideo.appendChild(mask)
    viewVideo.appendChild(seekLeft)
    viewVideo.appendChild(seekRight)
    viewVideo.appendChild(hint)
    viewVideo.appendChild(controls)

    const currentLabel = controls.querySelector('[data-pc-current]')
    const durationLabel = controls.querySelector('[data-pc-duration]')
    const progress = controls.querySelector('.pc-progress')
    const speedButton = controls.querySelector('[data-pc="speed"]')
    const toggleButton = controls.querySelector('[data-pc="toggle"]')

    let controlsTimer = 0
    let baseRate = 1
    let longPressTimer = 0
    let longPressing = false
    let pointer = null
    let lastTap = null
    let tapTimer = 0
    let lastHintTimer = 0
    let brightness = 1
    let swipe = null
    let progressDragging = false

    const SPEEDS = [1, 1.25, 1.5, 2, 0.75, 1.5]

    function showHint(text, kind = '', timeout = 700) {
      hint.textContent = text
      hint.className = `player-hint show ${kind}`.trim()
      clearTimeout(lastHintTimer)
      lastHintTimer = setTimeout(() => hint.classList.remove('show'), timeout)
    }

    function updateProgress() {
      const duration = Number(video.duration) || 0
      const current = Number(video.currentTime) || 0
      currentLabel.textContent = formatTime(current)
      durationLabel.textContent = Number.isFinite(duration) && duration > 0 ? formatTime(duration) : '00:00'
      if (!progressDragging) {
        const percent = duration > 0 ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0
        progress.value = String(Math.round(percent * 10))
        progress.style.setProperty('--pc-progress', `${percent}%`)
      }
    }

    function updatePlayButton() {
      toggleButton.textContent = video.paused ? '▶' : '❚❚'
      if (video.paused) showControls(true)
    }

    function showControls(show, autoHide = true) {
      controls.classList.toggle('visible', Boolean(show))
      gesture.classList.toggle('controls-visible', Boolean(show))
      clearTimeout(controlsTimer)
      if (show && autoHide && !video.paused) {
        controlsTimer = setTimeout(() => {
          controls.classList.remove('visible')
          gesture.classList.remove('controls-visible')
        }, 3200)
      }
    }

    function togglePlay() {
      if (video.paused) {
        video.play().catch(() => showHint('点击继续播放'))
      } else {
        video.pause()
      }
      updatePlayButton()
    }

    function seekBy(seconds) {
      const duration = Number(video.duration) || 0
      const target = Math.max(0, Math.min(duration > 0 ? duration - 0.3 : Infinity, (Number(video.currentTime) || 0) + seconds))
      video.currentTime = target
      showHint(`${seconds > 0 ? '+' : ''}${Math.round(seconds)} 秒`, 'speed', 500)
      updateProgress()
    }

    function setBrightness(value) {
      brightness = Math.max(0.35, Math.min(1, value))
      video.style.filter = `brightness(${brightness.toFixed(2)})`
      showHint(`亮度 ${Math.round(brightness * 100)}%`, '', 800)
    }

    function setVolume(value) {
      const next = Math.max(0, Math.min(1, value))
      video.muted = false
      video.volume = next
      showHint(`音量 ${Math.round(next * 100)}%`, '', 800)
    }

    function clearLongPress() {
      clearTimeout(longPressTimer)
      longPressTimer = 0
    }

    function endLongPress() {
      if (!longPressing) return
      longPressing = false
      try {
        video.playbackRate = baseRate
      } catch {
        /* 忽略 */
      }
      hint.classList.remove('show')
      showControls(true)
    }

    function beginLongPress() {
      if (video.paused || video.ended) return
      longPressing = true
      baseRate = Number(video.playbackRate) || 1
      try {
        video.playbackRate = 2
      } catch {
        /* 忽略 */
      }
      showHint('2.0x 倍速播放中', 'speed', 600000)
      if (navigator.vibrate) navigator.vibrate(12)
    }

    gesture.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      if (pointer) return
      pointer = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        startedAt: Date.now(),
        moved: false,
        longPress: false,
      }
      try {
        gesture.setPointerCapture(event.pointerId)
      } catch {
        /* 忽略 */
      }
      clearLongPress()
      longPressTimer = setTimeout(() => {
        if (!pointer || pointer.moved) return
        pointer.longPress = true
        beginLongPress()
      }, 480)
    })

    gesture.addEventListener('pointermove', (event) => {
      if (!pointer || event.pointerId !== pointer.id) return
      const dx = event.clientX - pointer.x
      const dy = event.clientY - pointer.y
      if (!pointer.moved && Math.hypot(dx, dy) > 12) {
        pointer.moved = true
        clearLongPress()
        endLongPress()
        const leftSide = pointer.startX < window.innerWidth * 0.5
        swipe = leftSide ? 'brightness' : 'volume'
      }
      if (!pointer.moved) return
      const totalDy = pointer.startY - event.clientY
      const totalDx = event.clientX - pointer.startX
      if (Math.abs(totalDx) > Math.abs(totalDy) && Math.abs(totalDx) > 24) {
        // 横向滑动：按比例快进 / 快退（不直接改 currentTime，松手才生效）
        const duration = Number(video.duration) || 0
        if (duration > 0) {
          const delta = (totalDx / Math.max(1, viewVideo.clientWidth)) * Math.min(300, duration)
          const target = Math.max(0, Math.min(duration - 0.3, (Number(video.currentTime) || 0) + delta))
          const indicator = delta >= 0 ? seekRight : seekLeft
          indicator.textContent = `${delta >= 0 ? '+' : ''}${Math.round(delta)} 秒`
          indicator.classList.add('show')
          pointer.seekTarget = target
          pointer.delta = delta
        }
      } else if (Math.abs(totalDy) > 16) {
        if (swipe === 'brightness') setBrightness(0.35 + (1 - 0.35) * Math.min(1, Math.max(0, 0.5 + totalDy / (window.innerHeight * 0.5))))
        else if (swipe === 'volume') setVolume(Math.min(1, Math.max(0, 0.5 + totalDy / (window.innerHeight * 0.5))))
      }
    })

    function finishPointer(event) {
      if (!pointer || (event.pointerId != null && event.pointerId !== pointer.id)) return
      const wasLong = pointer.longPress || longPressing
      const wasMoved = pointer.moved
      const seekTarget = pointer.seekTarget
      const totalDx = event.clientX - pointer.startX
      const totalDy = event.clientY - pointer.startY
      clearLongPress()
      endLongPress()
      seekLeft.classList.remove('show')
      seekRight.classList.remove('show')
      if (pointer.seekTarget != null && Math.abs(totalDx) > 24) {
        video.currentTime = pointer.seekTarget
        updateProgress()
      }
      const durationMs = Date.now() - pointer.startedAt
      const tap = !wasLong && !wasMoved && durationMs < 320
      pointer = null
      swipe = null
      if (!tap) return
      const now = Date.now()
      if (lastTap && now - lastTap.at < 320 && Math.abs(event.clientX - lastTap.x) < 60) {
        clearTimeout(tapTimer)
        lastTap = null
        const width = viewVideo.clientWidth || window.innerWidth
        if (event.clientX < width * 0.33) seekBy(-10)
        else if (event.clientX > width * 0.67) seekBy(10)
        else togglePlay()
        return
      }
      lastTap = { at: now, x: event.clientX, y: event.clientY }
      clearTimeout(tapTimer)
      tapTimer = setTimeout(() => {
        lastTap = null
        const visible = controls.classList.contains('visible')
        showControls(!visible)
      }, 300)
    }

    gesture.addEventListener('pointerup', (event) => {
      finishPointer(event)
    })
    gesture.addEventListener('pointercancel', (event) => {
      clearLongPress()
      endLongPress()
      seekLeft.classList.remove('show')
      seekRight.classList.remove('show')
      pointer = null
      swipe = null
    })
    gesture.addEventListener('contextmenu', (event) => event.preventDefault())
    video.addEventListener('contextmenu', (event) => event.preventDefault())

    controls.addEventListener('click', (event) => {
      const button = event.target.closest('[data-pc]')
      if (!button) return
      const action = button.dataset.pc
      if (action === 'toggle') togglePlay()
      else if (action === 'speed') {
        const current = Number(video.playbackRate) || 1
        const index = SPEEDS.findIndex((rate) => Math.abs(rate - current) < 0.01)
        const next = SPEEDS[(index + 1) % SPEEDS.length]
        video.playbackRate = next
        button.textContent = `${next}x`
        showHint(`${next}x 播放`, 'speed', 700)
      } else if (action === 'episodes') {
        if (document.body.classList.contains('cinema')) $('#btn-fullscreen')?.click()
        const bar = $('#episode-bar')
        if (bar && !bar.hidden) bar.scrollIntoView({ behavior: 'smooth', block: 'center' })
        else showToast('当前没有可用的选集列表', 'warn')
      } else if (action === 'fullscreen') {
        $('#btn-fullscreen')?.click()
        setTimeout(() => showControls(true), 300)
      }
      showControls(true)
    })

    progress.addEventListener('input', () => {
      progressDragging = true
      const duration = Number(video.duration) || 0
      const percent = Number(progress.value) / 1000
      currentLabel.textContent = formatTime(duration * percent)
      progress.style.setProperty('--pc-progress', `${percent * 100}%`)
    })
    progress.addEventListener('change', () => {
      const duration = Number(video.duration) || 0
      if (duration > 0) video.currentTime = duration * (Number(progress.value) / 1000)
      progressDragging = false
      showControls(true)
    })

    video.addEventListener('timeupdate', updateProgress)
    video.addEventListener('durationchange', updateProgress)
    video.addEventListener('loadedmetadata', () => {
      updateProgress()
      updatePlayButton()
    })
    video.addEventListener('play', () => {
      updatePlayButton()
      showControls(true)
      setupMediaSession()
    })
    video.addEventListener('pause', () => {
      updatePlayButton()
      showControls(true, false)
    })
    video.addEventListener('ratechange', () => {
      const rate = Number(video.playbackRate) || 1
      speedButton.textContent = `${rate}x`
    })
    video.addEventListener('ended', () => {
      showControls(true, false)
    })

    // 进入全屏后自动隐藏控制条
    new MutationObserver(() => {
      if (document.body.classList.contains('cinema')) {
        showControls(false)
        setTimeout(() => showControls(true), 80)
        setTimeout(() => showControls(false), 3400)
      } else {
        showControls(false)
      }
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] })

    function setupMediaSession() {
      if (!('mediaSession' in navigator)) return
      try {
        const state = window.__app?.getState?.()
        const title = state?.currentTitle || document.title
        navigator.mediaSession.metadata = new MediaMetadata({
          title: String(title || '长视频解析'),
          artist: state?.currentEpisode || '',
          album: '长视频解析',
        })
        navigator.mediaSession.setActionHandler('play', () => video.play().catch(() => {}))
        navigator.mediaSession.setActionHandler('pause', () => video.pause())
        navigator.mediaSession.setActionHandler('seekbackward', () => seekBy(-10))
        navigator.mediaSession.setActionHandler('seekforward', () => seekBy(10))
        navigator.mediaSession.setActionHandler('seekto', (details) => {
          if (Number.isFinite(details.seekTime)) video.currentTime = details.seekTime
        })
      } catch {
        /* 忽略 */
      }
    }

    // 初始隐藏控制条，让画面干净
    showControls(false)
    updateProgress()
  }

  // -------------------------------------------------------------------------
  // 其它细节
  // -------------------------------------------------------------------------
  // 禁用双指缩放 / 下拉刷新
  document.addEventListener(
    'gesturestart',
    (event) => {
      event.preventDefault()
    },
    { passive: false },
  )

  if (isIOS) {
    document.documentElement.classList.add('ios')
  }

  // iOS / Android 返回前台时，如果视频被系统暂停，保持控制条可见
  document.addEventListener('visibilitychange', () => {
    const video = $('#video')
    if (!video) return
    if (document.visibilityState === 'visible') {
      if (!video.paused) video.play().catch(() => {})
    } else if (!video.paused) {
      // 切到后台先暂停，避免锁屏/切应用后还在放声音
      video.pause()
    }
  })

  // 更新按钮文案：iOS 是去下载 IPA，Android 是安装 APK
  const installButton = $('#btn-install-update')
  if (installButton) {
    const syncLabel = () => {
      if (installButton.hidden) return
      installButton.textContent = isIOS ? '前往下载 IPA' : '立即安装'
    }
    new MutationObserver(syncLabel).observe(installButton, { attributes: true, attributeFilter: ['hidden'] })
    syncLabel()
  }

  // 手机端不再显示“Enter / F11”这类桌面快捷键（保留 #version-text，app.js 初始化时还要写版本号）
  const statusMeta = $('.status-meta')
  if (statusMeta) {
    statusMeta.innerHTML = `<span id="version-text">v${window.CSP_VERSION || ''}</span> · 手机端 · 长按画面 2 倍速 · 双击左右快进 10 秒`
  }

  // 设置里的下载说明改成手机端口径
  for (const note of $$('.tab-pane[data-pane="play"] .settings-note')) {
    if (note.textContent.includes('内置播放器的 m3u8')) {
      note.textContent =
        '内置播放器的 m3u8 / mp4 可以下载：Android 保存到系统「下载」目录，iOS 保存到「文件」App → 我的 iPhone → 长视频解析。HLS 会合并成一个 .ts / .mp4 文件，不需要 ffmpeg。第三方网页解析线路（page）拿不到真实流地址，不支持下载。'
    }
  }
  const downloadButton = $('#btn-open-downloads')
  if (downloadButton) downloadButton.textContent = isIOS ? '查看已下载文件' : '打开系统下载'

  // 关于页文字
  const aboutBlock = $('.tab-pane[data-pane="about"] .about-block')
  if (aboutBlock) {
    const first = aboutBlock.querySelector('p')
    if (first) first.textContent = '手机端的四平台链接解析播放工具：粘贴链接，选择线路，直接观看。与电脑端功能一致，界面按手机重新排布。'
  }

  // 教程里的“下载到电脑”改成手机
  const downloadGuideTitle = $('#guide-download h3')
  if (downloadGuideTitle) downloadGuideTitle.innerHTML = '<span class="guide-step">7</span>下载到手机'
  const downloadGuideNav = document.querySelector('#guide-nav button[data-guide="download"]')
  if (downloadGuideNav) downloadGuideNav.textContent = '7 · 下载到手机'

  // 教程里桌端口径改成手机端口径
  const guideIntro = $('#guide-intro p')
  if (guideIntro) {
    guideIntro.textContent =
      '「长视频解析」手机版：把爱奇艺、腾讯视频、优酷、芒果TV 的视频页链接粘进来，选一条解析线路，就能在应用里直接播放。手机端与电脑端功能一致，界面按手机重新排布。'
  }

  // 桌面端的全屏快捷键提示在手机上不适用，换成手势提示
  const toastStack = $('#toast-stack')
  if (toastStack) {
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue
          if (/空格\s*暂停|Esc 退出全屏|F11/.test(node.textContent || '')) {
            node.textContent = '长按画面 2 倍速播放 · 双击左右两侧快退/快进 10 秒'
          }
        }
      }
    }).observe(toastStack, { childList: true })
  }

  // 模拟桌面左键点击，避免 TouchEvent 在个别 viewport 下不触发
  document.addEventListener(
    'dblclick',
    (event) => {
      if (event.target.closest('video')) event.preventDefault()
    },
    { passive: false },
  )
})()
