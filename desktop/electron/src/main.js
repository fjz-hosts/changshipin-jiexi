'use strict'

/**
 * 长视频解析 · Electron 主进程
 *
 * 职责：窗口 / 菜单 / 托盘 / 单实例、内置官网浏览器、解析调度、
 * 本地取流代理、配置与历史、自动更新。
 */

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  clipboard,
  nativeImage,
  net,
  screen,
  session,
  shell,
  webContents,
} = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const { Store } = require('./store')
const { StreamProxy } = require('./proxy')
const { CastManager } = require('./cast')
const { UpdateManager } = require('./updater')
const {
  DEFAULT_LINES,
  UA,
  parseWithLine,
  testLine,
  fetchOnlineLines,
  normalizeUrlText,
  isHttpUrl,
  measureStream,
  PREVIEW_MAX_SECONDS,
  SAMPLE_URL,
} = require('./lines')
const { resolveSeries } = require('./series')
const { DownloadManager } = require('./download')
const { PLATFORMS, detectPlatformByUrl, platformByKey } = require('./platforms')
const { SHORT_PLATFORMS, resolveShort, detectShortPlatform } = require('./shortvideo')

const APP_ID = 'com.fjzhosts.changshipin'
const APP_NAME = '视频解析'
const APP_SUBTITLE = '长视频 · 短视频链接解析'
const OLD_APP_NAME = '长视频解析'
const REPO_URL = 'https://github.com/fjz-hosts/changshipin-jiexi'
const IS_SMOKE = process.argv.includes('--smoke-test')
// 长视频 + 短视频的平台清单：内置窗口 / 登录弹窗 / 快捷键都要按分区识别
const ALL_PLATFORMS = [...PLATFORMS, ...SHORT_PLATFORMS]

app.setAppUserModelId(APP_ID)
app.setName(APP_NAME)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// 统一成普通 Edge UA：不少视频站会直接拦截带 Electron 标识的 UA
app.userAgentFallback = UA

const userDataDir =
  process.env.CHANGSPIN_USERDATA || path.join(app.getPath('appData'), APP_NAME)
// 改名后沿用旧版本的配置 / 历史 / 登录态，避免升级后设置全丢
try {
  if (!process.env.CHANGSPIN_USERDATA) {
    const oldDir = path.join(app.getPath('appData'), OLD_APP_NAME)
    if (!fs.existsSync(path.join(userDataDir, 'config.json')) && fs.existsSync(oldDir)) {
      fs.cpSync(oldDir, userDataDir, { recursive: true, force: false })
    }
  }
} catch {
  /* 迁移失败不影响启动 */
}
app.setPath('userData', userDataDir)

const LOG_DIR = path.join(userDataDir, 'logs')
const LOG_FILE = path.join(LOG_DIR, 'desktop.log')

function prepareLog() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    const stat = fs.statSync(LOG_FILE, { throwIfNoEntry: false })
    if (stat && stat.size > 5 * 1024 * 1024) fs.truncateSync(LOG_FILE, 0)
  } catch {
    /* 日志不可用不影响启动 */
  }
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8')
  } catch {
    /* ignore */
  }
  if (!app.isPackaged) console.log(line)
}

prepareLog()

// 运行期兜底：窗口在播放/关闭过程中抛出的未捕获异常只写日志，
// 不再弹出「A JavaScript error occurred in the main process」。
process.on('uncaughtException', (error) => {
  log(`[未捕获异常] ${error?.stack || error}`)
})
process.on('unhandledRejection', (reason) => {
  log(`[未处理的 Promise] ${reason?.stack || reason}`)
})

let mainWindow = null
let tray = null
let store = null
let proxy = null
let caster = null
let updater = null
let downloader = null
let lastStream = null
let quitting = false
let trayNoticeShown = false
let isSmoke = IS_SMOKE
// 网页里的 video 进入 HTML 全屏时，Esc 应该先退出视频全屏，而不是退出软件影院模式
let htmlFullScreen = false

function iconPath() {
  const packaged = path.join(process.resourcesPath, 'icon.ico')
  if (app.isPackaged && fs.existsSync(packaged)) return packaged
  const dev = path.join(__dirname, '..', 'build', 'icon.ico')
  return fs.existsSync(dev) ? dev : undefined
}

function safeOpenExternal(rawUrl) {
  try {
    const url = new URL(String(rawUrl))
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      shell.openExternal(url.href)
      return true
    }
  } catch {
    /* 非法地址 */
  }
  return false
}

function publicLine(line) {
  return { id: line.id, name: line.name, kind: line.kind, url: line.url, note: line.note || '' }
}

// ---------------------------------------------------------------------------
// 网页解析线路的播放桥
//
// 解析页不是我们写的：有的播放器绑了键盘，有的没绑；有的把播放器放在跨域
// iframe 里。这里在每个 frame 里注入一个极小的桥，主进程就能统一做
// 暂停/快进/音量、拿播放进度、判断这一集是不是播完了（自动连播要用）。
// ---------------------------------------------------------------------------

const PARSE_PARTITION = 'persist:parse'
const PLAYER_ACTIONS = ['toggle', 'back', 'forward', 'volume-up', 'volume-down', 'mute', 'ack-ended']

const PLAYER_BRIDGE_JS = `(() => {
  if (window.__cspVideoBridge) { window.__cspVideoBridge.refresh(); return 'ok' }
  var bridge = {
    endedAt: 0,
    pick: function () {
      var list = Array.prototype.slice.call(document.querySelectorAll('video'));
      var visible = list.filter(function (v) {
        try {
          if (v === document.fullscreenElement) return true;
          var r = v.getBoundingClientRect();
          return r.width > 40 && r.height > 40 && (v.readyState > 0 || v.currentSrc || v.src);
        } catch (e) { return false }
      });
      visible.sort(function (a, b) {
        try {
          var ra = a.getBoundingClientRect();
          var rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        } catch (e) { return 0 }
      });
      return visible[0] || null;
    },
    bind: function (v) {
      if (!v || v.__cspBound) return;
      v.__cspBound = true;
      v.addEventListener('ended', function () {
        try {
          if (!(v.duration >= 60)) return;
          bridge.endedAt = Date.now();
        } catch (e) {}
      });
      v.addEventListener('play', function () { bridge.endedAt = 0 });
    },
    refresh: function () {
      var nodes = Array.prototype.slice.call(document.querySelectorAll('video'));
      for (var i = 0; i < nodes.length; i += 1) bridge.bind(nodes[i]);
      return bridge.pick();
    },
    cmd: function (action) {
      var v = bridge.refresh();
      if (!v) return 'no-video';
      try {
        if (action === 'toggle') {
          if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}) } else { v.pause() }
        } else if (action === 'back') {
          v.currentTime = Math.max(0, (Number(v.currentTime) || 0) - 10);
        } else if (action === 'forward') {
          var d = Number(v.duration);
          var target = (Number(v.currentTime) || 0) + 10;
          v.currentTime = d > 0 ? Math.min(d - 0.5, target) : target;
        } else if (action === 'volume-up') {
          v.muted = false;
          v.volume = Math.min(1, (Number(v.volume) || 0) + 0.1);
        } else if (action === 'volume-down') {
          v.muted = false;
          v.volume = Math.max(0, (Number(v.volume) || 1) - 0.1);
        } else if (action === 'mute') {
          v.muted = !v.muted;
        } else if (action === 'ack-ended') {
          bridge.endedAt = 0;
        } else {
          return 'unknown';
        }
        return 'ok';
      } catch (e) { return 'error' }
    },
    snapshot: function () {
      var v = bridge.refresh();
      if (!v) return null;
      return {
        t: Number(v.currentTime) || 0,
        d: Number(v.duration) || 0,
        paused: Boolean(v.paused),
        volume: Number(v.volume) || 0,
        muted: Boolean(v.muted),
        ended: Boolean(bridge.endedAt && Date.now() - bridge.endedAt < 12000 && (v.paused || v.ended))
      };
    }
  };
  window.__cspVideoBridge = bridge;
  bridge.refresh();
  return 'ok';
})()`

function parseWebviewContents() {
  try {
    const parseSession = session.fromPartition(PARSE_PARTITION)
    return (
      webContents.getAllWebContents().find((item) => {
        try {
          return item.getType() === 'webview' && item.session === parseSession && !item.isDestroyed()
        } catch {
          return false
        }
      }) || null
    )
  } catch (error) {
    log(`[player] 查找解析页失败：${error?.message || error}`)
    return null
  }
}

function parseFrames(contents) {
  try {
    return contents.mainFrame.framesInSubtree.filter(Boolean).slice(0, 8)
  } catch {
    try {
      return [contents.mainFrame]
    } catch {
      return []
    }
  }
}

async function runInParseFrames(contents, expression, timeout = 2000) {
  const frames = parseFrames(contents)
  return Promise.all(
    frames.map(async (frame) => {
      try {
        const value = await Promise.race([
          frame.executeJavaScript(`${PLAYER_BRIDGE_JS}; (${expression})`, false),
          new Promise((resolve) => setTimeout(() => resolve('__timeout__'), timeout)),
        ])
        return { frame, url: frame.url, value }
      } catch (error) {
        return { frame, url: frame.url, error: String(error?.message || error).slice(0, 120) }
      }
    }),
  )
}

// 解析页里可能同时有正片和广告 / 浮动小窗的 video：按时长挑最像正片的那一个，
// 只对那一帧执行暂停/快进/音量，避免把广告和正片一起控制。
async function scanPlayerFrame(contents) {
  const results = await runInParseFrames(contents, 'JSON.stringify(window.__cspVideoBridge.snapshot())')
  let best = null
  for (const item of results) {
    if (typeof item.value !== 'string' || item.value.charAt(0) !== '{') continue
    let snapshot = null
    try {
      snapshot = JSON.parse(item.value)
    } catch {
      continue
    }
    if (!snapshot || !(Number(snapshot.d) > 5)) continue
    if (!best || Number(snapshot.d) > Number(best.snapshot.d)) best = { frame: item.frame, snapshot }
  }
  return best
}

async function dispatchPlayerAction(action) {
  const contents = parseWebviewContents()
  if (!contents) return { ok: false, error: 'no-webview' }
  const target = await scanPlayerFrame(contents)
  if (!target) {
    contents.__cspHasVideo = false
    return { ok: false, error: 'no-video' }
  }
  try {
    const value = await target.frame.executeJavaScript(
      `${PLAYER_BRIDGE_JS}; window.__cspVideoBridge.cmd(${JSON.stringify(action)})`,
      false,
    )
    contents.__cspHasVideo = true
    return { ok: value === 'ok' }
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 120) }
  }
}

async function readPlayerSnapshot() {
  const contents = parseWebviewContents()
  if (!contents) return { ok: false }
  const target = await scanPlayerFrame(contents)
  contents.__cspHasVideo = Boolean(target)
  return { ok: Boolean(target), video: target ? target.snapshot : null }
}

// 解析页自己进了视频全屏时，Esc 需要真正把它的全屏退掉；
// Chromium 对 webview 里的 HTML 全屏不一定会自己处理 Esc。
async function exitParseFullscreen(contents) {
  try {
    const frames = parseFrames(contents)
    await Promise.all(
      frames.map((frame) =>
        frame
          .executeJavaScript('(() => { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); return true })()', false)
          .catch(() => {}),
      ),
    )
  } catch {
    /* 忽略 */
  }
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function createMainWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize
  const width = Math.min(1380, Math.max(1040, area.width - 80))
  const height = Math.min(920, Math.max(700, area.height - 100))
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 1024,
    minHeight: 660,
    show: false,
    title: `${APP_NAME} · ${APP_SUBTITLE}`,
    backgroundColor: '#070b12',
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: true,
      backgroundThrottling: false,
    },
  })
  mainWindow.setMenuBarVisibility(false)
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  mainWindow.on('close', (event) => {
    if (quitting) return
    const minimize = store?.get('closeToTray') === true
    if (!minimize) {
      quitting = true
      return
    }
    event.preventDefault()
    mainWindow.hide()
    if (!trayNoticeShown) {
      trayNoticeShown = true
      try {
        tray?.displayBalloon({
          title: APP_NAME,
          content: '窗口已隐藏到托盘，双击托盘图标可以重新打开。',
        })
      } catch {
        /* 部分系统不支持气泡 */
      }
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith('file://')) safeOpenExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) safeOpenExternal(url)
    }
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`渲染进程退出：${JSON.stringify(details)}`)
  })

  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    log(`主页面加载失败 ${code} ${description} ${url}`)
  })

  // 把 webview 的能力收紧到最小：不允许 preload / Node
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    if (!/^https?:\/\//i.test(params.src || '')) event.preventDefault()
  })

  mainWindow.webContents.on('did-finish-load', () => {
    sendCommand('app:ready')
    const startupUrl = pickUrlFromArgv(process.argv)
    if (startupUrl) sendCommand('app:external-parse', { url: startupUrl })
  })

  mainWindow.once('ready-to-show', () => {
    if (!isSmoke) mainWindow.show()
  })

  mainWindow.webContents.on('enter-html-full-screen', () => {
    htmlFullScreen = true
    sendCommand('window:fullscreen', true)
  })
  mainWindow.webContents.on('leave-html-full-screen', () => {
    // 视频退出网页全屏后，窗口可能还停在应用自己的全屏里；以窗口真实状态回填，
    // 避免工具栏已经恢复、画面却还按影院模式显示。
    htmlFullScreen = false
    setTimeout(() => {
      sendCommand('window:fullscreen', Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()))
    }, 120)
  })
  mainWindow.on('enter-full-screen', () => sendCommand('window:fullscreen', true))
  mainWindow.on('leave-full-screen', () => sendCommand('window:fullscreen', false))
}

function sendCommand(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function isPlatformUrl(rawUrl, key) {
  const platform = platformByKey(key)
  if (!platform) return false
  try {
    const host = new URL(rawUrl).hostname.toLowerCase()
    return platform.hosts.some((item) => host === item || host.endsWith(`.${item}`))
  } catch {
    return false
  }
}

// 登录 / 支付 / 授权类弹窗仍用独立小窗，避免打断 OAuth 流程；
// 其它链接一律用带工具栏的内置浏览器打开。
function isAuthUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase()
    return /(^|\.)(passport|login|sso|oauth|accounts)\./.test(host) ||
      host === 'graph.qq.com' ||
      host === 'open.weixin.qq.com' ||
      host === 'pay.qq.com' ||
      host.endsWith('passport.mgtv.com')
  } catch {
    return false
  }
}

// 平台里「在新窗口打开」的目标如果本身就是某一集，直接在当前内置浏览器里打开；
// 登录 / 授权弹窗仍然允许单独弹出，避免把登录流程打断。
function looksLikeVideoUrl(rawUrl, key) {
  try {
    const url = new URL(rawUrl)
    const host = url.hostname.toLowerCase()
    const pathname = url.pathname
    if (key === 'iqiyi') {
      return host.endsWith('iqiyi.com') && (/^\/v_[A-Za-z0-9]+\.html$/.test(pathname) || /^\/a_[A-Za-z0-9]+\.html$/.test(pathname))
    }
    if (key === 'qq') {
      if (!host.endsWith('v.qq.com')) return false
      return /^\/x\/(cover|page)\/.+\.html$/.test(pathname)
    }
    if (key === 'youku') {
      return host.endsWith('youku.com') && /^\/v_show\/id_[A-Za-z0-9=]+\.html$/.test(pathname)
    }
    if (key === 'mgtv') {
      return host.endsWith('mgtv.com') && /^\/b\/\d+\/\d+\.html$/.test(pathname)
    }
  } catch {
    return false
  }
  return false
}

function pickUrlFromArgv(argv) {
  for (const arg of argv) {
    const normalized = normalizeUrlText(arg)
    if (isHttpUrl(normalized)) return normalized
  }
  return ''
}

// webview 弹窗策略：内置官网里的登录弹窗允许开新窗口，解析页的广告弹窗一律拦掉
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return
  contents.setWindowOpenHandler(({ url }) => {
    try {
      if (contents.isDestroyed()) return { action: 'deny' }
      const host = contents.hostWebContents
      if (!host || host.isDestroyed()) return { action: 'deny' }
      const parentWindow = BrowserWindow.fromWebContents(host)
      if (!parentWindow || parentWindow.isDestroyed()) return { action: 'deny' }
      // 主窗口里的内置浏览器：登录弹窗单独开，其余链接留在当前 webview 内
      const webviewPlatform = ALL_PLATFORMS.find(
        (item) => session.fromPartition(item.partition) === contents.session,
      )
      if (parentWindow === mainWindow && webviewPlatform && /^https?:\/\//i.test(url)) {
        if (isAuthUrl(url)) {
          return {
            action: 'allow',
            overrideBrowserWindowOptions: {
              width: 1020,
              height: 780,
              autoHideMenuBar: true,
              title: '登录',
              icon: iconPath(),
              backgroundColor: '#070b12',
              webPreferences: {
                partition: webviewPlatform.partition,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
              },
            },
          }
        }
        try {
          contents.loadURL(url)
        } catch {
          /* 忽略 */
        }
        return { action: 'deny' }
      }
      if (/^https?:\/\//i.test(url)) log(`[解析页弹窗已拦截] ${url}`)
      return { action: 'deny' }
    } catch (error) {
      log(`[弹窗处理失败] ${error?.message || error}`)
      return { action: 'deny' }
    }
  })
  // 解析页（网页线路）里的键盘：播放器是第三方的，有的只在鼠标聚焦时响应，
  // 有的干脆没绑快捷键。这里统一拦截，效果和内置播放器保持一致。
  if (contents.session === session.fromPartition(PARSE_PARTITION)) {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const key = String(input.key || '')
      if (input.control || input.alt || input.meta) return
      if (key === 'F11') {
        event.preventDefault()
        if (htmlFullScreen || contents.__cspHtmlFullscreen) {
          contents.__cspHtmlFullscreen = false
          exitParseFullscreen(contents).catch(() => {})
        } else {
          sendCommand('app:fullscreen-toggle')
        }
        return
      }
      if (key === 'Escape') {
        // 页面自己在全屏（视频全屏）时先退出视频全屏；否则按 Esc 退出软件影院模式。
        if (htmlFullScreen || contents.__cspHtmlFullscreen) {
          event.preventDefault()
          contents.__cspHtmlFullscreen = false
          exitParseFullscreen(contents).catch(() => {})
          return
        }
        if (mainWindow && mainWindow.isFullScreen()) {
          event.preventDefault()
          sendCommand('app:fullscreen-toggle')
        }
        return
      }
      if (contents.__cspHasVideo !== true) return
      const space = key === ' ' || key === 'Spacebar' || key === 'Space' || input.code === 'Space'
      const action = space
        ? 'toggle'
        : key === 'ArrowLeft'
          ? 'back'
          : key === 'ArrowRight'
            ? 'forward'
            : key === 'ArrowUp'
              ? 'volume-up'
              : key === 'ArrowDown'
                ? 'volume-down'
                : key === 'm' || key === 'M'
                  ? 'mute'
                  : ''
      if (!action) return
      event.preventDefault()
      dispatchPlayerAction(action).catch(() => {})
    })
    contents.on('enter-html-full-screen', () => {
      contents.__cspHtmlFullscreen = true
      sendCommand('window:fullscreen', true)
    })
    contents.on('leave-html-full-screen', () => {
      contents.__cspHtmlFullscreen = false
      setTimeout(() => {
        sendCommand('window:fullscreen', Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()))
      }, 120)
    })
  }

  // 平台 webview 里也有键盘：Alt+←/→ 后退/前进、Esc 返回主界面、Ctrl+W 关闭当前标签页。
  // 主窗口的 document keydown 拿不到 webview 内的按键，所以必须在主进程拦截。
  const platformForContents = ALL_PLATFORMS.find((item) => session.fromPartition(item.partition) === contents.session)
  if (platformForContents) {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const key = String(input.key || '')
      if (input.alt && key === 'ArrowLeft') {
        event.preventDefault()
        try {
          if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
        } catch {
          /* 忽略 */
        }
        return
      }
      if (input.alt && key === 'ArrowRight') {
        event.preventDefault()
        try {
          if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
        } catch {
          /* 忽略 */
        }
        return
      }
      if (key === 'Escape') {
        event.preventDefault()
        sendCommand('app:close-browser')
        return
      }
      if (input.control && key.toLowerCase() === 'w') {
        event.preventDefault()
        sendCommand('app:close-browser-tab', { key: platformForContents.key })
      }
    })
  }

  contents.on('will-navigate', (event, url) => {
    if (!/^https?:\/\//i.test(url)) event.preventDefault()
  })
})

// 解析页里的播放器经常部署在 IP 地址上、使用自签名证书；只对「解析」会话放行证书错误，
// 平台官网窗口、更新下载仍然走正常的证书校验。
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  try {
    const parseSession = session.fromPartition('persist:parse')
    if (webContents && webContents.session === parseSession) {
      log(`[证书] 解析会话放行证书错误：${url} (${error})`)
      event.preventDefault()
      callback(true)
      return
    }
  } catch {
    /* 忽略 */
  }
  callback(false)
})

// ---------------------------------------------------------------------------
// 菜单 / 托盘
// ---------------------------------------------------------------------------

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '粘贴剪贴板链接并解析',
          accelerator: 'CommandOrControl+Shift+V',
          click: () => sendCommand('app:paste-parse'),
        },
        { type: 'separator' },
        { label: '打开配置目录', click: () => shell.openPath(userDataDir) },
        { label: '打开日志目录', click: () => shell.openPath(LOG_DIR) },
        {
          label: '重新创建桌面快捷方式',
          click: () => {
            const result = createDesktopShortcut()
            if (result.ok) {
              dialog.showMessageBox({ type: 'info', title: '快捷方式', message: `已在桌面重新创建「${APP_NAME}」快捷方式`, buttons: ['好'], noLink: true })
            } else {
              dialog.showMessageBox({ type: 'warning', title: '快捷方式', message: '创建失败', detail: result.error || '', buttons: ['好'], noLink: true })
            }
          },
        },
        { type: 'separator' },
        { label: '退出', accelerator: 'Alt+F4', click: () => quitApp() },
      ],
    },
    {
      label: '播放',
      submenu: [
        { label: '更换线路', accelerator: 'CommandOrControl+Shift+N', click: () => sendCommand('app:next-line') },
        { label: '刷新画面', accelerator: 'F5', click: () => sendCommand('app:reload') },
        { type: 'separator' },
        { label: '全屏', accelerator: 'F11', click: () => sendCommand('app:fullscreen-toggle') },
        { label: '在系统浏览器打开当前链接', click: () => sendCommand('app:open-external') },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载界面', role: 'reload' },
        ...(app.isPackaged ? [] : [{ label: '开发者工具', role: 'toggleDevTools' }]),
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '检查更新…', click: () => updater?.check({ manual: true }) },
        {
          label: '使用说明',
          click: () => {
            const file = app.isPackaged
              ? path.join(process.resourcesPath, '使用说明.txt')
              : path.join(__dirname, '..', '使用说明.txt')
            shell.openPath(file)
          },
        },
        { label: 'GitHub 项目主页', click: () => safeOpenExternal(REPO_URL) },
        { type: 'separator' },
        { label: `关于${APP_NAME}`, click: () => showAbout() },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createTray() {
  const icon = iconPath()
  if (!icon) return
  try {
    tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }))
    tray.setToolTip(`${APP_NAME} · ${APP_SUBTITLE}`)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主界面', click: () => showMainWindow() },
        { label: '检查更新…', click: () => updater?.check({ manual: true }) },
        { type: 'separator' },
        { label: '退出', click: () => quitApp() },
      ]),
    )
    tray.on('double-click', () => showMainWindow())
  } catch (error) {
    log(`托盘创建失败：${error?.message || error}`)
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function toggleFullscreen() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setFullScreen(!mainWindow.isFullScreen())
}

function quitApp() {
  quitting = true
  app.quit()
}

// 默认放「程序安装目录同级的 视频解析下载」：安装包通常装在 D 盘等数据盘，不会像 Downloads 那样把系统盘塞满。
// 不放在 $INSTDIR 里面，是因为 NSIS 更新 / 卸载会 RMDir /r $INSTDIR，那会把用户下载的视频一起删掉。
// 安装目录同级不可写（例如装在 Program Files）或系统拦截写入时，再依次退回「下载\视频解析」等目录。
function pickDownloadDir() {
  const exeDir = path.dirname(app.getPath('exe'))
  const candidates = [
    ...(app.isPackaged ? [path.join(path.dirname(exeDir), `${APP_NAME}下载`)] : []),
    path.join(app.getPath('downloads'), APP_NAME),
    path.join(app.getPath('videos'), APP_NAME),
    path.join(app.getPath('documents'), APP_NAME),
    path.join(userDataDir, 'downloads'),
  ]
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const probe = path.join(dir, `.write-test-${process.pid}`)
      fs.writeFileSync(probe, '1')
      fs.unlinkSync(probe)
      log(`下载目录：${dir}`)
      return dir
    } catch {
      /* 尝试下一个 */
    }
  }
  return path.join(userDataDir, 'downloads')
}

function createDesktopShortcut() {  if (!app.isPackaged) {
    return { ok: false, error: '开发模式下不创建快捷方式' }
  }
  try {
    const shortcutPath = path.join(app.getPath('desktop'), `${APP_NAME}.lnk`)
    const ok = shell.writeShortcutLink(shortcutPath, 'create', {
      target: process.execPath,
      cwd: path.dirname(process.execPath),
      icon: iconPath(),
      iconIndex: 0,
      description: `${APP_NAME} · ${APP_SUBTITLE}`,
    })
    log(`重建桌面快捷方式：${shortcutPath} ok=${ok}`)
    return { ok, path: shortcutPath }
  } catch (error) {
    log(`重建桌面快捷方式失败：${error?.message || error}`)
    return { ok: false, error: String(error?.message || error) }
  }
}

function showAbout() {
  const options = {
    type: 'info',
    title: `关于${APP_NAME}`,
    message: `${APP_NAME} v${app.getVersion()}`,
    detail:
      '长视频：把爱奇艺、腾讯视频、优酷、芒果TV 的链接粘贴进来，选择解析线路后直接在内置播放器里播放。\n' +
      '短视频：支持抖音、B站、AcFun、红果短剧、快手，选清晰度下载 MP4，短剧可一键下载全集。\n\n' +
      '解析线路来自互联网公开的第三方接口，程序本身不提供、不存储任何视频内容；' +
      '线路随时可能失效，可在「线路管理」里更换或添加。请只在合法范围内使用。\n\n' +
      `项目地址：${REPO_URL}`,
    buttons: ['好'],
    noLink: true,
  }
  if (mainWindow && !mainWindow.isDestroyed()) dialog.showMessageBox(mainWindow, options)
  else dialog.showMessageBox(options)
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

const titleCache = new Map()

function cleanPageTitle(raw, platformName = '') {
  let text = String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/^【[^】]*】\s*/, '')
    .trim()
  if (!text) return ''
  // 去掉平台后缀，例如「嫁金钗 第1集 - 芒果TV-天生青春」
  text = text
    .replace(/\s*[-_|]\s*(爱奇艺|腾讯视频|优酷|芒果TV|芒果tv|在线观看|高清完整正版视频在线观看).*$/i, '')
    .replace(/\s*[-_|]\s*芒果TV.*$/i, '')
    .trim()
  if (!text || text.length < 2) return ''
  if (/在线视频网站|海量正版|高清完整正版|天生青春|腾讯视频$|爱奇艺$|^优酷$|^芒果TV$|^爱奇艺-在线视频/i.test(text)) return ''
  if (platformName && text === platformName) return ''
  return text.slice(0, 100)
}

async function resolvePageTitle(rawUrl) {
  if (!isHttpUrl(rawUrl)) return ''
  const cached = titleCache.get(rawUrl)
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.title
  const platform = detectPlatformByUrl(rawUrl)
  let cleaned = ''
  try {
    const response = await net.fetch(rawUrl, {
      redirect: 'follow',
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6' },
    })
    const text = await response.text()
    const og = (text.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || [])[1]
    const title = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''
    cleaned = cleanPageTitle(og || title, platform?.name)
  } catch {
    /* 继续尝试隐藏窗口 */
  }
  if (!cleaned && platform) {
    cleaned = await new Promise((resolve) => {
      let win = null
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        let title = ''
        try {
          title = win && !win.isDestroyed() ? win.getTitle() : ''
        } catch {
          /* 忽略 */
        }
        try {
          win?.destroy()
        } catch {
          /* 忽略 */
        }
        resolve(cleanPageTitle(title, platform.name))
      }
      const timer = setTimeout(finish, 12000)
      try {
        win = new BrowserWindow({
          show: false,
          skipTaskbar: true,
          width: 900,
          height: 700,
          webPreferences: {
            partition: platform.partition,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        })
        win.webContents.on('page-title-updated', (_event, title) => {
          if (cleanPageTitle(title, platform.name)) setTimeout(finish, 900)
        })
        win.webContents.on('did-finish-load', () => setTimeout(finish, 2200))
        win.webContents.on('did-fail-load', finish)
        win.loadURL(rawUrl).catch(finish)
      } catch {
        finish()
      }
    })
  }
  if (cleaned) titleCache.set(rawUrl, { title: cleaned, at: Date.now() })
  return cleaned
}

// 短视频平台的内置窗口登录态：解析高清 / 会员内容时需要带上这些 Cookie
async function readPartitionCookie(partition, homeUrl) {
  try {
    const cookies = await session.fromPartition(partition).cookies.get({ url: homeUrl })
    return cookies.map((item) => `${item.name}=${item.value}`).join('; ')
  } catch {
    return ''
  }
}

// 各平台「登录后才会出现」的 Cookie，用来提前告诉用户当前是否已登录。
// 只做提示，不参与解析鉴权；没有可靠 Cookie 的平台返回 null（显示「未知」）。
const LOGIN_COOKIES = {
  iqiyi: ['P00001'],
  qq: ['vqq_vusession', 'vqq_access_token'],
  // 优酷 / 芒果没有可靠的「仅登录后才出现」的 Cookie：不猜，状态返回未知
  youku: [],
  mgtv: [],
  bilibili: ['SESSDATA'],
  douyin: ['sessionid', 'sid_tt'],
  kuaishou: ['kuaishou.web.cp.api_st', 'userId'],
  acfun: ['acPasstoken', 'auth_key'],
  hongguo: ['sessionid', 'sid_tt'],
}

async function readLoginState(platform) {
  try {
    const cookies = await session.fromPartition(platform.partition).cookies.get({})
    const names = new Set(cookies.map((item) => item.name))
    const loginNames = LOGIN_COOKIES[platform.key] || []
    return {
      key: platform.key,
      loggedIn: loginNames.length ? loginNames.some((name) => names.has(name)) : null,
      cookieCount: cookies.length,
    }
  } catch {
    return { key: platform.key, loggedIn: null, cookieCount: 0 }
  }
}

// 把短视频直链换成本地代理地址：<video> 没法自己带 Referer / Cookie
function attachProxyUrls(result, cookie) {
  if (!proxy || !result) return result
  const referer = result.referer || ''
  // 抖音的 Cookie 经常很大，塞进本地代理的 X-Proxy-Cookie 会让 CDN 返回 431；
  // 直链本身是签名地址，预览/下载都不需要整份登录 Cookie。
  const proxyCookie = result.platform === 'douyin' ? '' : cookie
  const withProxy = (item) =>
    item && item.url
      ? { ...item, originalUrl: item.url, playUrl: proxy.resourceUrl(item.url, referer, proxyCookie) }
      : item
  return {
    ...result,
    qualities: Array.isArray(result.qualities) ? result.qualities.map(withProxy) : [],
    episodes: Array.isArray(result.episodes)
      ? result.episodes.map((episode) => ({
          ...episode,
          qualities: Array.isArray(episode.qualities) ? episode.qualities.map(withProxy) : episode.qualities,
        }))
      : [],
  }
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    name: APP_NAME,
    isPackaged: app.isPackaged,
    platform: process.platform,
    repo: REPO_URL,
    userData: userDataDir,
    logDir: LOG_DIR,
    sampleUrl: SAMPLE_URL,
  }))

  ipcMain.handle('config:get', () => store.snapshot())

  ipcMain.handle('lines:save', (_event, payload = {}) => {
    return store.setLines(payload.lines, payload.defaultLineId)
  })

  ipcMain.handle('lines:reset', () => {
    return store.setLines(DEFAULT_LINES, DEFAULT_LINES[0]?.id || '')
  })

  ipcMain.handle('settings:save', (_event, patch = {}) => {
    const saved = store.saveSettings(patch)
    if (patch.autoUpdate === false) updater?.dispose()
    return saved
  })

  ipcMain.handle('history:add', (_event, entry = {}) => {
    const platform = detectPlatformByUrl(entry.url)
    return store.addHistory({ ...entry, platform: platform?.key || entry.platform || '' })
  })

  ipcMain.handle('history:clear', () => store.clearHistory())

  ipcMain.handle('history:update', (_event, entry = {}) => store.updateHistory(entry))

  ipcMain.handle('history:remove', (_event, url) => store.removeHistory(url))

  // 网页解析线路的播放控制 / 进度读取（跨域 iframe 也行）
  ipcMain.handle('player:command', (_event, payload = {}) => {
    const action = String(payload.action || '')
    if (!PLAYER_ACTIONS.includes(action)) return { ok: false, error: 'unknown-action' }
    return dispatchPlayerAction(action)
  })
  ipcMain.handle('player:state', () => readPlayerSnapshot())

  ipcMain.handle('page:title', async (_event, url) => resolvePageTitle(normalizeUrlText(url)))

  // 选集：按平台从页面 / 官方接口取分集列表（QQ、芒果、优酷不需要打开页面，爱奇艺会开一个隐藏页读 tvid）
  ipcMain.handle('series:resolve', async (_event, payload = {}) => {
    const url = normalizeUrlText(payload.url)
    try {
      const result = await resolveSeries({ url, hint: payload.hint || {} })
      log(`[选集] ${url} → ${result.ok ? `${result.episodes.length} 集（${result.source}）` : result.error}`)
      return result
    } catch (error) {
      log(`[选集] 解析失败 ${url}：${error?.stack || error}`)
      return { ok: false, error: String(error?.message || error).slice(0, 160) }
    }
  })

  ipcMain.handle('clipboard:read', () => clipboard.readText())

  ipcMain.handle('clipboard:write', (_event, text) => {
    clipboard.writeText(String(text || ''))
    return true
  })

  ipcMain.handle('parse:run', async (_event, payload = {}) => {
    const url = normalizeUrlText(payload.url)
    if (!isHttpUrl(url)) return { ok: false, error: '链接格式不正确，请粘贴完整的 http(s) 视频链接' }
    const lines = store.get('lines') || []
    const line = lines.find((item) => item.id === payload.lineId) || lines.find((item) => item.enabled)
    if (!line) return { ok: false, error: '没有可用的解析线路，请先在「线路管理」里启用一条线路' }
    try {
      let cookieHeader = ''
      if (line.kind === 'mgtv' || line.kind === 'native') {
        const platformKey = line.platform || detectPlatformByUrl(url)?.key || ''
        const cookieDomain = { mgtv: 'mgtv.com', qq: 'qq.com', iqiyi: 'iqiyi.com', youku: 'youku.com' }[platformKey] || ''
        const platformName = { mgtv: '芒果TV', qq: '腾讯视频', iqiyi: '爱奇艺', youku: '优酷' }[platformKey] || platformKey
        if (cookieDomain) {
          try {
            const cookies = await session
              .fromPartition(`persist:platform-${platformKey}`)
              .cookies.get({ domain: cookieDomain })
            cookieHeader = cookies.map((item) => `${item.name}=${item.value}`).join('; ')
            log(`${platformName} 原生解析：携带 ${cookies.length} 条登录 Cookie`)
          } catch {
            /* 没有登录也没关系 */
          }
        }
      }
      const result = await parseWithLine({ videoUrl: url, line, cookieHeader })
      if (result.kind === 'page') {
        log(`解析 ${line.name} → 页面 ${result.url}`)
        return { ok: true, kind: 'page', url: result.url, line: publicLine(line), platform: detectPlatformByUrl(url)?.name || '未知' }
      }
      if (result.kind === 'stream') {
        const platform = detectPlatformByUrl(url)
        const referer = result.referer || platform?.home || url
        // 第三方线路经常把平台的「试看流」原样返回：付费 / 云影院影片只有几十秒到 5 分钟。
        // 先量一下时长，渲染层据此决定是否继续换线，避免用户以为整部电影只有 5 分钟。
        let media = { duration: 0, segments: 0, drm: false, live: false }
        try {
          media = await measureStream(result.streamUrl, { referer, cookie: cookieHeader })
        } catch {
          /* 量不出来不影响播放 */
        }
        const titleText = String(result.title || '')
        const previewText = /试看|预告|花絮|片段|速看|抢先|片花/.test(titleText)
        const trial = previewText || (Number(media.duration) > 0 && Number(media.duration) <= PREVIEW_MAX_SECONDS)
        const playUrl = proxy.resourceUrl(result.streamUrl, referer, cookieHeader)
        lastStream = {
          url: result.streamUrl,
          referer,
          cookie: cookieHeader,
          title: result.title || '',
          platform: platform?.name || '',
          lineName: line.name,
          videoUrl: url,
          duration: Number(media.duration) || 0,
        }
        log(`解析 ${line.name} → 流地址 ${result.streamUrl}（${media.duration || '?'} 秒${trial ? ' · 试看' : ''}）`)
        return {
          ok: true,
          kind: 'stream',
          playUrl,
          original: result.streamUrl,
          title: result.title || '',
          duration: Number(media.duration) || 0,
          segments: Number(media.segments) || 0,
          trial,
          line: publicLine(line),
          platform: platform?.name || '未知',
        }
      }
      if (result.kind === 'none') {
        log(`解析失败 ${line.name}：${result.error || '没有返回可播放地址'}`)
      }
      return { ok: false, error: result.error || '线路没有返回可播放的地址' }
    } catch (error) {
      log(`解析失败 ${line.name}：${error?.message || error}`)
      return { ok: false, error: String(error?.message || error).slice(0, 160) }
    }
  })

  ipcMain.handle('download:start', (_event, payload = {}) => {
    if (!downloader) return { ok: false, error: '下载器还没准备好' }
    if (!lastStream) return { ok: false, error: '当前不是内置播放器，无法下载（网页解析线路不支持下载）' }
    const title = String(payload.title || lastStream.title || '').trim() || lastStream.platform || '视频'
    const result = downloader.start({
      url: lastStream.url,
      referer: lastStream.referer,
      cookie: lastStream.cookie,
      title,
      platform: lastStream.platform,
      lineName: lastStream.lineName,
    })
    if (result.ok) log(`[下载] 开始 ${title}（${lastStream.lineName}）`)
    return result
  })

  ipcMain.handle('download:cancel', (_event, id) => downloader?.cancel(String(id || '')) || false)
  ipcMain.handle('download:snapshot', (_event, id) => downloader?.snapshot(String(id || '')) || null)
  ipcMain.handle('download:folder', () => {
    const folder = downloader?.folder || ''
    if (!folder) return false
    return shell.openPath(folder)
  })
  ipcMain.handle('download:reveal', () => {
    const file = downloader?.lastSavedPath || ''
    if (file && fs.existsSync(file)) {
      shell.showItemInFolder(file)
      return true
    }
    return false
  })

  // -------------------------------------------------------------------------
  // 投屏（DLNA 电视 / 局域网大屏播放页）
  // -------------------------------------------------------------------------
  ipcMain.handle('cast:scan', async () => {
    if (!caster) return { ok: false, error: '投屏模块还没准备好', devices: [] }
    const result = await caster.scan()
    log(`[投屏] 扫描完成：${result.devices?.length || 0} 个可投屏设备${result.error ? `（${result.error}）` : ''}`)
    return result
  })

  ipcMain.handle('cast:state', () => caster?.snapshot() || { ok: false, casting: false, devices: [] })

  // 大屏浏览器播放页：电视上没有 DLNA 时，用这个地址在电视 / 平板的浏览器里打开
  ipcMain.handle('cast:page', (_event, payload = {}) => {
    if (!caster || !proxy) return { ok: false, error: '投屏模块还没准备好' }
    const url = String(payload.url || '')
    if (!url.startsWith(proxy.base)) return { ok: false, error: '当前没有可投屏的视频流' }
    const mime = payload.mime === 'hls' ? 'hls' : 'mp4'
    const pageUrl = caster.pageUrl(url, { mime, title: String(payload.title || '').slice(0, 120) })
    if (!pageUrl) return { ok: false, error: '找不到局域网地址：请确认电脑和电视在同一个 Wi-Fi 下' }
    return { ok: true, pageUrl, host: new URL(pageUrl).host }
  })

  ipcMain.handle('cast:start', async (_event, payload = {}) => {
    if (!caster || !proxy) return { ok: false, error: '投屏模块还没准备好' }
    const url = String(payload.url || '')
    // 只允许推本地代理地址，避免把任意地址丢给电视
    if (!url.startsWith(proxy.base)) return { ok: false, error: '当前画面拿不到可投屏的流地址（网页解析线路不支持投屏）' }
    const result = await caster.start({
      url,
      title: String(payload.title || '').slice(0, 120),
      mime: payload.mime === 'hls' ? 'hls' : 'mp4',
      position: Number(payload.position) || 0,
      deviceId: String(payload.deviceId || ''),
    })
    if (result.ok) log(`[投屏] 已推送到「${result.device?.name || '设备'}」`)
    return result
  })

  ipcMain.handle('cast:control', async (_event, payload = {}) => {
    if (!caster) return { ok: false, error: '投屏模块还没准备好' }
    return caster.control(payload)
  })

  ipcMain.handle('cast:stop', async () => (caster ? caster.stopCasting() : { ok: false }))

  ipcMain.handle('lines:test', async (_event, payload = {}) => {
    const sample = isHttpUrl(payload.url) ? normalizeUrlText(payload.url) : SAMPLE_URL
    if (payload.draft && typeof payload.draft === 'object') {
      const draft = {
        id: 'draft',
        name: String(payload.draft.name || '临时线路'),
        kind: ['page', 'api', 'mgtv', 'direct', 'native'].includes(payload.draft.kind) ? payload.draft.kind : 'page',
        url: String(payload.draft.url || ''),
        platform: String(payload.draft.platform || ''),
        enabled: true,
      }
      return { draft: await testLine(draft, sample) }
    }
    const ids = Array.isArray(payload.ids) ? payload.ids : null
    const lines = (store.get('lines') || []).filter((line) => !ids || ids.includes(line.id))
    const results = {}
    const queue = lines.slice()
    const worker = async () => {
      while (queue.length) {
        const line = queue.shift()
        results[line.id] = await testLine(line, sample)
      }
    }
    await Promise.all([worker(), worker(), worker()])
    return results
  })

  ipcMain.handle('lines:online', async () => {
    const result = await fetchOnlineLines()
    if (!result.ok) return { ok: false, error: '所有线路源都取不到清单', detail: result.errors }
    const applied = store.applyRemoteLines(result.lines)
    return { ok: true, applied: applied.applied, feed: result.feed, updatedAt: result.updatedAt, config: store.snapshot() }
  })

  ipcMain.handle('platform:open', (_event, key) => {
    sendCommand('app:open-browser', { key: String(key) })
    return true
  })

  ipcMain.handle('platform:open-site', (_event, key) => {
    const platform = platformByKey(String(key))
    return platform ? safeOpenExternal(platform.home) : false
  })

  ipcMain.handle('platform:search', (_event, payload = {}) => {
    const key = String(payload.key || '')
    const query = String(payload.query || '').trim().slice(0, 80)
    if (!platformByKey(key) || !query) return false
    sendCommand('app:open-browser', { key, query })
    return true
  })

  // 全屏：主进程把窗口铺满屏幕，渲染进程进入影院模式（隐藏工具栏）
  ipcMain.handle('app:set-fullscreen', (_event, flag) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    const on = Boolean(flag)
    mainWindow.setFullScreen(on)
    return on
  })

  ipcMain.handle('app:fullscreen-state', () =>
    mainWindow && !mainWindow.isDestroyed() ? mainWindow.isFullScreen() : false,
  )

  ipcMain.handle('app:focus-main', () => {
    showMainWindow()
    return true
  })

  ipcMain.handle('shell:open-external', (_event, url) => safeOpenExternal(url))
  ipcMain.handle('app:open-userdata', () => shell.openPath(userDataDir))
  ipcMain.handle('app:open-logs', () => shell.openPath(LOG_DIR))
  ipcMain.handle('app:create-shortcut', () => createDesktopShortcut())
  ipcMain.handle('app:about', () => showAbout())
  ipcMain.handle('app:toggle-fullscreen', () => {
    toggleFullscreen()
    return mainWindow?.isFullScreen() || false
  })
  ipcMain.handle('app:quit', () => quitApp())

  ipcMain.handle('update:state', () => updater?.snapshot() || { status: 'idle' })
  ipcMain.handle('update:check', () => updater?.check({ manual: true }) || { status: 'idle' })
  ipcMain.handle('update:install', () => {
    updater?.install()
    return true
  })

  // 内置官网窗口把当前页面链接交给主界面解析
  ipcMain.handle('platform:send-to-parse', (_event, payload = {}) => {
    const url = normalizeUrlText(payload.url)
    if (!isHttpUrl(url)) return { ok: false, error: '当前页面不是视频链接' }
    const focus = payload.focus !== false
    if (focus) {
      showMainWindow()
    } else {
      // 自动解析时不抢焦点，只闪一下任务栏
      try {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(true)
      } catch {
        /* 忽略 */
      }
    }
    sendCommand('app:external-parse', {
      url,
      auto: Boolean(payload.auto),
      focus,
      title: String(payload.title || ''),
      episode: String(payload.episode || ''),
    })
    return { ok: true }
  })

  // -------------------------------------------------------------------------
  // 短视频（与长视频完全独立）
  // -------------------------------------------------------------------------
  ipcMain.handle('auth:status', async (_event, keys = []) => {
    const wanted = new Set(Array.isArray(keys) ? keys : [])
    const list = ALL_PLATFORMS.filter((item) => item.key !== 'browser')
      .filter((item) => !wanted.size || wanted.has(item.key))
    const entries = await Promise.all(list.map((item) => readLoginState(item)))
    return Object.fromEntries(entries.map((item) => [item.key, item]))
  })

  ipcMain.handle('short:platforms', () =>
    SHORT_PLATFORMS.map((item) => ({
      key: item.key,
      name: item.name,
      home: item.home,
      color: item.color,
      partition: item.partition,
      hint: item.hint,
    })),
  )

  ipcMain.handle('short:resolve', async (_event, payload = {}) => {
    const url = normalizeUrlText(payload.url)
    if (!isHttpUrl(url)) return { ok: false, error: '链接格式不正确，请粘贴完整的 http(s) 短视频链接' }
    const platform = detectShortPlatform(url)
    if (!platform) return { ok: false, error: '不是受支持的短视频平台链接（抖音 / B站 / AcFun / 红果短剧 / 快手）' }
    const started = Date.now()
    try {
      const cookie = String(payload.cookie || '') || (await readPartitionCookie(platform.partition, platform.home))
      const result = await resolveShort({ url, cookie, platform: platform.key })
      if (result.ok) {
        const proxied = attachProxyUrls(result, cookie)
        log(
          `[短视频] ${platform.name} 解析成功：${proxied.title}，${proxied.qualities.length} 个清晰度，` +
            `${proxied.episodes?.length || 0} 集，${Date.now() - started}ms`,
        )
        return proxied
      }
      log(`[短视频] ${platform.name} 解析失败：${result.error || '未知错误'}，${Date.now() - started}ms`)
      return result
    } catch (error) {
      log(`[短视频] ${platform.name} 解析异常：${error?.stack || error}`)
      return { ok: false, error: String(error?.message || error).slice(0, 160) }
    }
  })

  ipcMain.handle('short:download', (_event, payload = {}) => {
    if (!downloader) return { ok: false, error: '下载器还没准备好' }
    const url = String(payload.url || '')
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: '没有可下载的直链' }
    const platform = detectShortPlatform(payload.pageUrl || payload.referer || url)
    // 抖音 CDN 对超大的 Cookie 请求头会直接返回 431；直链已签名，下载时只带 Referer/UA。
    const cookie = platform?.key === 'douyin' ? '' : String(payload.cookie || '')
    const result = downloader.start({
      url,
      referer: String(payload.referer || '') || platform?.home || '',
      cookie,
      title: String(payload.title || '短视频'),
      platform: String(payload.platform || platform?.name || '短视频'),
      subdir: String(payload.subdir || ''),
      extraHeaders: payload.headers && typeof payload.headers === 'object' ? payload.headers : null,
      id: String(payload.id || ''),
      mp4: payload.mp4 !== false,
      dash: payload.dash && typeof payload.dash === 'object' ? payload.dash : null,
    })
    if (result.ok) log(`[短视频下载] 开始 ${payload.title || url}`)
    return result
  })
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    showMainWindow()
    const url = pickUrlFromArgv(argv)
    if (url) sendCommand('app:external-parse', { url })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  quitting = true
  log('[退出] before-quit，开始清理资源')
  // 清理失败绝不能挡住退出：否则更新安装器已经拉起、旧进程却还活着，会占着文件导致首次安装失败
  try {
    updater?.dispose()
  } catch (error) {
    log(`[退出] updater.dispose 失败：${error?.message || error}`)
  }
  try {
    proxy?.stop()
  } catch (error) {
    log(`[退出] proxy.stop 失败：${error?.message || error}`)
  }
  try {
    downloader?.cancelAll()
  } catch (error) {
    log(`[退出] downloader.cancelAll 失败：${error?.message || error}`)
  }
  try {
    caster?.dispose()
  } catch (error) {
    log(`[退出] caster.dispose 失败：${error?.message || error}`)
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
})

app.whenReady().then(async () => {
  store = new Store(userDataDir)
  // 解析页 / 官网窗口都使用普通浏览器 UA
  try {
    session.fromPartition('persist:parse').setUserAgent(UA)
    for (const platform of ALL_PLATFORMS) session.fromPartition(platform.partition).setUserAgent(UA)
  } catch (error) {
    log(`设置 UA 失败：${error?.message || error}`)
  }
  // 第三方解析页最近开始挂广告脚本（789 的 o.js 会注入全屏广告并强制跳转到 *.lifestyle / *.coupons）。
  // 只在解析页 session 里拦掉，不影响内置官网和短视频。
  try {
    const parseSession = session.fromPartition(PARSE_PARTITION)
    parseSession.webRequest.onBeforeRequest(
      { urls: ['*://*.trafficmanager.net/o.js*', '*://*.lifestyle/*', '*://*.coupons/*'] },
      (details, callback) => {
        log(`[解析页] 拦截广告脚本：${String(details.url).slice(0, 140)}`)
        callback({ cancel: true })
      },
    )
  } catch (error) {
    log(`[解析页] 广告拦截设置失败：${error?.message || error}`)
  }
  proxy = await new StreamProxy().start()
  log(`本地取流代理已启动：${proxy.base}`)

  caster = new CastManager({
    log,
    proxy,
    onState: (state) => sendCommand('cast:state', state),
  })

  downloader = new DownloadManager({
    log,
    dir: pickDownloadDir(),
    onState: (state) => sendCommand('download:state', state),
    // 分片改走本地代理（Chromium 网络栈），能带上防盗链需要的头，和播放走同一条路
    proxify: (url, job) => proxy.resourceUrl(url, job.referer || '', job.cookie || ''),
  })

  updater = new UpdateManager({
    log,
    onState: (state) => sendCommand('update:state', state),
    getWindow: () => mainWindow,
    beforeInstall: () => {
      proxy?.stop()
    },
  })

  registerIpc()
  createMainWindow()
  buildMenu()
  createTray()

  if (store.get('autoUpdate') !== false) {
    updater.init()
  } else {
    log('自动更新已在设置中关闭')
  }

  if (isSmoke) {
    const { runSmoke } = require('./smoke')
    try {
      const result = await runSmoke({ app, window: mainWindow, proxy, store })
      console.log('\n=== SMOKE RESULT ===')
      console.log(JSON.stringify(result, null, 2))
      isSmoke = false
      app.exit(result.failed ? 1 : 0)
    } catch (error) {
      console.error('SMOKE CRASH', error)
      isSmoke = false
      app.exit(2)
    }
  }
})

module.exports = { APP_NAME }
