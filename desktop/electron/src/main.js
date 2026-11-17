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
  screen,
  session,
  shell,
} = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const { Store } = require('./store')
const { StreamProxy } = require('./proxy')
const { UpdateManager } = require('./updater')
const {
  DEFAULT_LINES,
  UA,
  parseWithLine,
  testLine,
  fetchOnlineLines,
  normalizeUrlText,
  isHttpUrl,
  SAMPLE_URL,
} = require('./lines')
const { PLATFORMS, detectPlatformByUrl, platformByKey } = require('./platforms')

const APP_ID = 'com.fjzhosts.changshipin'
const APP_NAME = '长视频解析'
const APP_SUBTITLE = '四平台链接解析播放'
const REPO_URL = 'https://github.com/fjz-hosts/changshipin-jiexi'
const IS_SMOKE = process.argv.includes('--smoke-test')

app.setAppUserModelId(APP_ID)
app.setName(APP_NAME)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// 统一成普通 Edge UA：不少视频站会直接拦截带 Electron 标识的 UA
app.userAgentFallback = UA

const userDataDir =
  process.env.CHANGSPIN_USERDATA || path.join(app.getPath('appData'), APP_NAME)
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
let updater = null
let quitting = false
let trayNoticeShown = false
let isSmoke = IS_SMOKE

const platformWindows = new Map()

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
    sendCommand('window:fullscreen', true)
  })
  mainWindow.webContents.on('leave-html-full-screen', () => {
    sendCommand('window:fullscreen', false)
  })
  mainWindow.on('enter-full-screen', () => sendCommand('window:fullscreen', true))
  mainWindow.on('leave-full-screen', () => sendCommand('window:fullscreen', false))
}

function createPlatformWindow(key, options = {}) {
  const platform = platformByKey(key)
  if (!platform) return null
  const existing = [...platformWindows.values()].find((item) => item.key === key && item.win && !item.win.isDestroyed())
  if (existing) {
    if (options.search && !existing.win.isDestroyed()) {
      existing.win.webContents.send('platform:search', options.search)
    }
    existing.win.show()
    existing.win.focus()
    return existing.win
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    show: false,
    title: `${platform.name} · 内置浏览器`,
    backgroundColor: '#070b12',
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'platform-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      spellcheck: false,
    },
  })
  win.setMenuBarVisibility(false)
  win.loadFile(path.join(__dirname, 'renderer', 'platform.html'), {
    query: { key, q: options.search || '', u: options.url || '' },
  })
  // 必须在 closed 之前把 id 存下来：closed 触发时 webContents 已经销毁，
  // 再去读 win.webContents.id 就会抛 "Object has been destroyed"。
  const winId = win.webContents.id
  platformWindows.set(winId, { win, key })
  win.on('closed', () => {
    platformWindows.delete(winId)
  })
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    if (!/^https?:\/\//i.test(params.src || '')) event.preventDefault()
  })
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })
  return win
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
      const entry = [...platformWindows.values()].find((item) => item.win === parentWindow)
      if (entry && /^https?:\/\//i.test(url)) {
        // 平台内部的「新窗口打开播放页」直接在当前内置浏览器里打开，
        // 这样地址栏、复制链接、自动解析都能跟着走，不会停留在首页。
        if (isPlatformUrl(url, entry.key) && looksLikeVideoUrl(url, entry.key)) {
          try {
            contents.loadURL(url)
          } catch {
            /* 忽略 */
          }
          return { action: 'deny' }
        }
        // 搜索结果里的「外站播放」：如果是其它平台的剧集页，切到那个平台的内置窗口
        const targetPlatform = detectPlatformByUrl(url)
        if (targetPlatform && looksLikeVideoUrl(url, targetPlatform.key)) {
          createPlatformWindow(targetPlatform.key, { url })
          return { action: 'deny' }
        }
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
              partition: `persist:platform-${entry.key}`,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
            },
          },
        }
      }
      if (/^https?:\/\//i.test(url)) log(`[解析页弹窗已拦截] ${url}`)
      return { action: 'deny' }
    } catch (error) {
      log(`[弹窗处理失败] ${error?.message || error}`)
      return { action: 'deny' }
    }
  })
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
        { label: '关于长视频解析', click: () => showAbout() },
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

function showAbout() {
  const options = {
    type: 'info',
    title: '关于长视频解析',
    message: `长视频解析 v${app.getVersion()}`,
    detail:
      '把爱奇艺、腾讯视频、优酷、芒果TV 的链接粘贴进来，选择解析线路后直接在内置播放器里播放。\n\n' +
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
    return store.addHistory({ ...entry, platform: platform?.name || entry.platform || '其他' })
  })

  ipcMain.handle('history:clear', () => store.clearHistory())

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
      const result = await parseWithLine({ videoUrl: url, line })
      if (result.kind === 'page') {
        log(`解析 ${line.name} → 页面 ${result.url}`)
        return { ok: true, kind: 'page', url: result.url, line: publicLine(line), platform: detectPlatformByUrl(url)?.name || '未知' }
      }
      if (result.kind === 'stream') {
        const platform = detectPlatformByUrl(url)
        const referer = result.referer || platform?.home || url
        const playUrl = proxy.resourceUrl(result.streamUrl, referer)
        log(`解析 ${line.name} → 流地址 ${result.streamUrl}`)
        return {
          ok: true,
          kind: 'stream',
          playUrl,
          original: result.streamUrl,
          line: publicLine(line),
          platform: platform?.name || '未知',
        }
      }
      return { ok: false, error: result.error || '线路没有返回可播放的地址' }
    } catch (error) {
      log(`解析失败 ${line.name}：${error?.message || error}`)
      return { ok: false, error: String(error?.message || error).slice(0, 160) }
    }
  })

  ipcMain.handle('lines:test', async (_event, payload = {}) => {
    const sample = isHttpUrl(payload.url) ? normalizeUrlText(payload.url) : SAMPLE_URL
    if (payload.draft && typeof payload.draft === 'object') {
      const draft = {
        id: 'draft',
        name: String(payload.draft.name || '临时线路'),
        kind: ['page', 'api', 'direct'].includes(payload.draft.kind) ? payload.draft.kind : 'page',
        url: String(payload.draft.url || ''),
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
    createPlatformWindow(String(key))
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
    createPlatformWindow(key, { search: query })
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
    sendCommand('app:external-parse', { url, auto: Boolean(payload.auto), focus })
    return { ok: true }
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
  updater?.dispose()
  proxy?.stop()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
})

app.whenReady().then(async () => {
  store = new Store(userDataDir)
  // 解析页 / 官网窗口都使用普通浏览器 UA
  try {
    session.fromPartition('persist:parse').setUserAgent(UA)
    for (const platform of PLATFORMS) session.fromPartition(platform.partition).setUserAgent(UA)
  } catch (error) {
    log(`设置 UA 失败：${error?.message || error}`)
  }
  proxy = await new StreamProxy().start()
  log(`本地取流代理已启动：${proxy.base}`)

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
