'use strict'

/**
 * 打包前的自检（node 端）：`electron . --smoke-test`
 * 验证渲染进程能加载、preload 暴露正常、平台识别正确，
 * 并用本地测试服务器验证取流代理的播放列表改写与 Referer 透传。
 */

const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const { net, webContents } = require('electron')

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

async function waitFor(check, timeout = 8000, interval = 100) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  return null
}

async function runSmoke({ app, window, proxy, store }) {
  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok), detail })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  }

  // ---- 1. 渲染进程 ----
  if (window.webContents.isLoading()) {
    await new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
  }
  const ready = await waitFor(() => window.webContents.executeJavaScript('Boolean(window.__app && window.desktop)'))
  check('渲染进程初始化（window.desktop + window.__app）', ready)

  const title = await window.webContents.executeJavaScript('document.title')
  check('窗口标题', String(title).includes('长视频解析'), title)

  const cards = await window.webContents.executeJavaScript('document.querySelectorAll(".platform-card[data-platform]").length')
  check('四个平台快捷入口', cards === 4, String(cards))
  const picks = await window.webContents.executeJavaScript('document.querySelectorAll("#platform-picks .pick").length')
  check('找剧支持四个平台', picks === 4, String(picks))

  const detect = await window.webContents.executeJavaScript(`(() => {
    const cases = [
      ['https://www.iqiyi.com/v_b13ju3xx7s.html?lt=2', 'iqiyi'],
      ['https://v.qq.com/x/cover/mzc002001w361jz/x4102olnagg.html', 'qq'],
      ['https://v.youku.com/v_show/id_XNjU3MzkyOTA0NA==.html?spm=a2hkl', 'youku'],
      ['https://www.mgtv.com/b/817372/24769759.html?no_wakeup=1', 'mgtv'],
      ['https://example.com/video.mp4', null],
    ]
    return cases.map(([url, expected]) => ({ url, expected, actual: window.__app.detectPlatform(url) }))
  })()`)
  for (const item of detect) {
    check(`识别平台 ${item.expected || '未知'}`, item.actual === item.expected, `${item.actual}`)
  }

  const shell = await window.webContents.executeJavaScript(
    'document.querySelector("#url-input") !== null && document.querySelector("#btn-parse") !== null',
  )
  check('解析输入框与按钮', shell)

  // ---- 2. 取流代理 ----
  const received = { referer: '', cookie: '', ranges: [] }
  let segmentCounter = 0
  const testServer = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/test.m3u8') {
      const body = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
        '#EXTINF:4.0,',
        'seg1.ts',
        '#EXTINF:4.0,',
        `http://127.0.0.1:${testServer.address().port}/seg2.ts`,
        '#EXT-X-ENDLIST',
      ].join('\n')
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      response.end(body)
      return
    }
    if (url.pathname === '/seg1.ts' || url.pathname === '/seg2.ts') {
      segmentCounter += 1
      received.referer = String(request.headers.referer || '')
      received.cookie = String(request.headers.cookie || '')
      received.ranges.push(String(request.headers.range || ''))
      response.writeHead(200, { 'content-type': 'video/mp2t' })
      response.end(`SEGMENT-${url.pathname}`)
      return
    }
    if (url.pathname === '/key.bin') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(Buffer.alloc(16, 7))
      return
    }
    if (url.pathname === '/video.mp4') {
      response.writeHead(200, { 'content-type': 'video/mp4' })
      response.end('MP4-DATA')
      return
    }
    response.writeHead(404)
    response.end('nope')
  })
  const testPort = await listen(testServer)
  const upstreamPlaylist = `http://127.0.0.1:${testPort}/test.m3u8`

  try {
    const proxied = proxy.resourceUrl(upstreamPlaylist, 'https://www.iqiyi.com/', 'sid=cookie-test')
    const playlistResponse = await net.fetch(proxied)
    const playlistText = await playlistResponse.text()
    check('代理播放列表 200', playlistResponse.status === 200, `${playlistResponse.status} ${playlistText.slice(0, 120)}`)
    check('播放列表被改写为代理地址', playlistText.includes(`${proxy.base}/stream?t=`))
    check('播放列表不含原始相对地址', !/^seg1\.ts$/m.test(playlistText))
    check('密钥地址被改写', /#EXT-X-KEY:.*URI="http:\/\/127\.0\.0\.1:\d+\/stream\?/.test(playlistText))
    check('绝对分片地址被改写', !playlistText.includes(`127.0.0.1:${testPort}/seg2.ts`), '应只剩代理地址')

    const segmentUrl = playlistText
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith(proxy.base))
    if (!segmentUrl) {
      check('代理分片可播放', false, '播放列表里没有代理分片地址')
    } else {
      const segmentResponse = await net.fetch(segmentUrl)
      const segmentBody = await segmentResponse.text()
      check('代理分片可播放', segmentResponse.status === 200 && segmentBody.startsWith('SEGMENT-'), segmentBody)
      check('分片 Referer 透传（沿用原始页面）', received.referer === 'https://www.iqiyi.com/', received.referer)
      check('分片 Cookie 透传', received.cookie === 'sid=cookie-test', received.cookie)
    }

    const mp4 = await net.fetch(proxy.resourceUrl(`http://127.0.0.1:${testPort}/video.mp4`, 'https://v.qq.com/'))
    const mp4Body = await mp4.text()
    check('代理 mp4 透传', mp4.status === 200 && mp4Body === 'MP4-DATA')

    const denied = await net.fetch(proxy.resourceUrl(`http://127.0.0.1:${testPort}/video.mp4`).replace(/t=[a-f0-9]+/, 't=bad'))
    check('代理令牌校验', denied.status === 403, String(denied.status))
  } finally {
    testServer.close()
  }

  // ---- 3. 配置 ----
  const config = store.snapshot()
  check('配置含内置线路', Array.isArray(config.lines) && config.lines.length >= 5, `${config.lines.length} 条`)
  check('平台数配置一致', config.lines.filter((line) => line.enabled).length >= 1)

  // ---- 3.1 观看历史（一部剧一条：最近集数 + 进度） ----
  const historyCheck = await window.webContents.executeJavaScript(`(async () => {
    const first = 'https://www.iqiyi.com/v_smoke_history.html'
    const second = 'https://www.iqiyi.com/v_smoke_history2.html'
    await window.desktop.addHistory({ url: first, lineId: 'builtin-789', lineName: '789解析', title: '烟雾测试剧 第2集', episode: '第2集' })
    await window.desktop.updateHistory({ url: first, progress: 120, duration: 300 })
    const list = await window.desktop.addHistory({ url: second, title: '烟雾测试剧 第3集', episode: '第3集' })
    const merged = list.find((entry) => entry.title === '烟雾测试剧') || {}
    const withProgress = await window.desktop.updateHistory({ url: second, progress: 60, duration: 300 })
    const item = withProgress.find((entry) => entry.url === second) || {}
    const seriesCount = withProgress.filter((entry) => entry.title === '烟雾测试剧').length
    const removed = await window.desktop.removeHistory(second)
    const afterRemove = removed.filter((entry) => entry.title === '烟雾测试剧').length
    return JSON.stringify({
      mergedEpisode: merged.episode,
      seriesCount,
      title: item.title,
      episode: item.episode,
      progress: item.progress,
      duration: item.duration,
      afterRemove,
    })
  })()`)
  const historyItem = JSON.parse(historyCheck)
  check(
    '观看历史：同一部剧只保留一条（最近集数 + 进度）',
    historyItem.mergedEpisode === '第3集' &&
      historyItem.seriesCount === 1 &&
      historyItem.title === '烟雾测试剧' &&
      historyItem.episode === '第3集' &&
      historyItem.progress === 60 &&
      historyItem.duration === 300 &&
      historyItem.afterRemove === 0,
    historyCheck,
  )

  // 旧版本一集一条，升级后应该自动合并成一部剧一条
  const { Store } = require('./store')
  const tempDir = path.join(app.getPath('userData'), `smoke-store-${process.pid}`)
  let migrationCheck = {}
  try {
    fs.rmSync(tempDir, { recursive: true, force: true })
    fs.mkdirSync(tempDir, { recursive: true })
    fs.writeFileSync(
      path.join(tempDir, 'config.json'),
      JSON.stringify({
        history: [
          { url: 'https://www.iqiyi.com/v_old_1.html', title: '旧版测试剧 第1集', episode: '第1集', progress: 100, duration: 300, at: 1000 },
          { url: 'https://www.iqiyi.com/v_old_2.html', title: '旧版测试剧 第2集', episode: '第2集', progress: 50, duration: 300, at: 2000 },
        ],
      }),
      'utf8',
    )
    const history = new Store(tempDir).snapshot().history
    migrationCheck = {
      count: history.length,
      title: history[0] && history[0].title,
      episode: history[0] && history[0].episode,
      progress: history[0] && history[0].progress,
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
  check(
    '观看历史：旧配置按集记录自动合并',
    migrationCheck.count === 1 && migrationCheck.title === '旧版测试剧' && migrationCheck.episode === '第2集' && migrationCheck.progress === 50,
    JSON.stringify(migrationCheck),
  )

  // ---- 3.2 选集 / 下载的纯逻辑 ----
  const series = require('./series')
  const { parsePlaylist, sanitizeFileName } = require('./download')
  const objectText = 'window.__X__ = {"a":{"b":"}{"},"c":[1,2],"d":"x\\"y"} ;tail'
  const parsedObject = JSON.parse(series.sliceJsonObject(objectText, objectText.indexOf('{')))
  check(
    '选集：内嵌 JSON 截取（花括号/转义）',
    parsedObject.a.b === '}{' && parsedObject.d === 'x"y' && parsedObject.c.length === 2,
    JSON.stringify(parsedObject),
  )
  const fakeYouku = {
    pageMap: { extra: { videoId: 'v1' } },
    moduleList: [
      {
        title: '选集',
        type: 10013,
        itemList: [
          { title: '测试剧 第1集', stage: 1, action: { value: 'v1', extra: { showId: 's1' } } },
          { title: '测试剧 第2集', stage: 2, action: { value: 'v2', extra: { showId: 's1' } } },
          { title: '相关推荐剧', stage: 9, action: { value: 'v9', extra: { showId: 's2' } } },
        ],
      },
    ],
  }
  const youku = series.youkuEpisodesFromData(fakeYouku)
  check('选集：优酷过滤相关推荐', youku.episodes.length === 2 && youku.showId === 's1', JSON.stringify(youku))
  const playlist = parsePlaylist(
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.bin",IV=0x000102030405060708090a0b0c0d0e0f\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n#EXT-X-ENDLIST',
    'https://example.test/a.m3u8',
  )
  check(
    '下载：HLS 播放列表解析',
    playlist.segments.length === 2 && playlist.key?.uri === 'https://example.test/k.bin' && !playlist.encryptedUnsupported,
    JSON.stringify({ segments: playlist.segments, key: playlist.key }),
  )
  const badName = sanitizeFileName('剧 第1集 <a>:b?.ts')
  check('下载：文件名清洗', !/[<>:"/\\|?*]/.test(badName), badName)
  const unsupported = await series.resolveSeries({ url: 'https://example.com/not-video' })
  check('选集：不支持的平台返回明确错误', unsupported.ok === false && /平台/.test(unsupported.error || ''), JSON.stringify(unsupported))

  // 渲染层：选集条渲染 / 高亮
  const seriesBar = await window.webContents.executeJavaScript(`(() => {
    const fake = {
      platform: 'mgtv',
      title: '烟雾测试剧',
      seriesKey: 'smoke:series',
      episodes: [1, 2, 3].map((n) => ({ label: '第' + n + '集', title: '烟雾测试剧 第' + n + '集', url: 'https://www.mgtv.com/b/1/' + n + '.html', index: n })),
    }
    window.__app.getState().currentVideoUrl = 'https://www.mgtv.com/b/1/2.html'
    window.__app.showSeries(fake)
    const bar = document.querySelector('#episode-bar')
    const active = document.querySelector('#episode-list .episode-item.active')
    const result = {
      hidden: bar.hidden,
      count: document.querySelectorAll('#episode-list .episode-item').length,
      active: active ? active.textContent : '',
      name: document.querySelector('#episode-series-name').textContent,
    }
    window.__app.showSeries(null)
    window.__app.getState().currentVideoUrl = ''
    return JSON.stringify(result)
  })()`)
  const barState = JSON.parse(seriesBar)
  check(
    '选集条：渲染并高亮当前集',
    barState.hidden === false && barState.count === 3 && barState.active.includes('第2集') && barState.name === '烟雾测试剧',
    seriesBar,
  )

  // 渲染层：历史按平台分组 / 搜索
  const groupedHistory = await window.webContents.executeJavaScript(`(async () => {
    const base = 'https://www.iqiyi.com/v_smoke_group_'
    await window.desktop.addHistory({ url: base + '1.html', title: '分组测试剧A 第1集', episode: '第1集' })
    const list = await window.desktop.addHistory({ url: base + '2.html', title: '分组测试剧B 第1集', episode: '第1集' })
    window.__app.getState().config.history = list
    const sort = document.querySelector('#history-sort')
    sort.value = 'grouped'
    sort.dispatchEvent(new Event('change'))
    const groups = document.querySelectorAll('#history-list .history-group').length
    const items = document.querySelectorAll('#history-list .history-item').length
    const input = document.querySelector('#history-search-input')
    input.value = 'zzz-not-exist'
    input.dispatchEvent(new Event('input'))
    const empty = document.querySelector('#history-list .empty-row')?.textContent || ''
    input.value = ''
    input.dispatchEvent(new Event('input'))
    sort.value = 'recent'
    sort.dispatchEvent(new Event('change'))
    await window.desktop.removeHistory(base + '1.html')
    await window.desktop.removeHistory(base + '2.html')
    return JSON.stringify({ groups, items, empty })
  })()`)
  const grouped = JSON.parse(groupedHistory)
  check(
    '观看历史：按平台分组 + 搜索无结果提示',
    grouped.groups === 1 && grouped.items === 2 && grouped.empty.includes('没有匹配'),
    groupedHistory,
  )

  // 渲染层：图文教程入口 / 章节 / 图片
  const guideCheck = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#btn-guide').click()
    await new Promise((resolve) => setTimeout(resolve, 600))
    const modal = document.querySelector('#guide-modal')
    const open = Boolean(modal) && !modal.hidden
    const sections = document.querySelectorAll('#guide-content .guide-section').length
    const navs = document.querySelectorAll('#guide-nav button[data-guide]').length
    const images = Array.from(document.querySelectorAll('#guide-content img'))
    const loaded = images.filter((img) => img.complete && img.naturalWidth > 0).length
    const missing = images.filter((img) => img.complete && img.naturalWidth === 0).map((img) => img.getAttribute('src'))
    document.querySelector('#guide-close').click()
    return JSON.stringify({ open, sections, navs, images: images.length, loaded, missing })
  })()`)
  const guide = JSON.parse(guideCheck)
  check(
    '图文教程：入口 / 章节 / 配图加载',
    guide.open === true && guide.sections >= 9 && guide.navs >= 10 && guide.images >= 9 && guide.loaded === guide.images,
    guideCheck,
  )

  // ---- 3.5 在线解析链路（可选，需要外网）----
  if (process.env.CHANGSPIN_SMOKE_ONLINE === '1') {
    const sample = 'https://www.iqiyi.com/v_b13ju3xx7s.html?lt=2'
    const parsed = await window.webContents.executeJavaScript(
      `window.desktop.parse({ url: ${JSON.stringify(sample)}, lineId: 'builtin-77flv' })`,
    )
    check('在线线路返回解析页', parsed?.ok === true && parsed.kind === 'page', JSON.stringify(parsed).slice(0, 180))
    if (parsed?.ok) {
      const loaded = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const wv = document.querySelector('#parse-view')
        const timer = setTimeout(() => resolve({ ok: false, error: '30s timeout' }), 30000)
        const done = () => { clearTimeout(timer); resolve({ ok: true, url: wv.getURL() }) }
        const fail = (event) => {
          if (!event.isMainFrame || event.errorCode === -3) return
          clearTimeout(timer)
          resolve({ ok: false, error: event.errorDescription || String(event.errorCode) })
        }
        wv.addEventListener('did-finish-load', done, { once: true })
        wv.addEventListener('did-fail-load', fail)
        wv.src = ${JSON.stringify(parsed.url)}
      })`)
      check('解析页在内置浏览器中打开', loaded?.ok === true, JSON.stringify(loaded).slice(0, 180))
      if (process.env.CHANGSPIN_SMOKE_SHOT) {
        window.showInactive()
        await window.webContents.executeJavaScript(
          "['empty','loading','error','video'].forEach((id) => { document.querySelector('#view-' + id).hidden = true }); document.querySelector('#view-webview').hidden = false",
        )
        await new Promise((resolve) => setTimeout(resolve, 4000))
        const pageInfo = await window.webContents.executeJavaScript(`(async () => {
          const wv = document.querySelector('#parse-view')
          const info = { url: '', title: '', text: '', frames: 0 }
          try { info.url = wv.getURL() } catch {}
          try { info.title = wv.getTitle() } catch {}
          try { info.ua = await wv.executeJavaScript('navigator.userAgent') } catch (e) { info.ua = 'ERR ' + e.message }
          try { info.frames = wv.getWebContentsId ? (wv.isLoading() ? -1 : 0) : 0 } catch {}
          try { info.text = String(await wv.executeJavaScript('document.body ? document.body.innerText.slice(0, 300) : "(no body)"')) } catch (e) { info.text = 'ERR ' + e.message }
          try {
            info.dom = await wv.executeJavaScript("({ htmlLen: document.documentElement.innerHTML.length, videos: [...document.querySelectorAll('video')].map(function (v) { return v.src || '' }), iframes: [...document.querySelectorAll('iframe')].map(function (f) { return f.src || '' }) })")
          } catch (e) { info.dom = { error: String(e.message) } }
          return info
        })()`)
        const domOk = Boolean(
          pageInfo.dom &&
            (pageInfo.dom.htmlLen > 800 ||
              (Array.isArray(pageInfo.dom.videos) && pageInfo.dom.videos.length) ||
              (Array.isArray(pageInfo.dom.iframes) && pageInfo.dom.iframes.length)),
        )
        check('解析页 DOM 正常', domOk, JSON.stringify(pageInfo.dom).slice(0, 300))
        check('解析页使用普通浏览器 UA', /Edg\//.test(String(pageInfo.ua || '')) && !/Electron/i.test(String(pageInfo.ua || '')), String(pageInfo.ua).slice(0, 80))
        try {
          const wvId = await window.webContents.executeJavaScript("document.querySelector('#parse-view').getWebContentsId()")
          const wvContents = webContents.fromId(wvId)
          const frames = wvContents.mainFrame.framesInSubtree
          const reports = []
          for (const frame of frames.slice(1)) {
            try {
              const result = await frame.executeJavaScript(
                '({ title: document.title, hasVideo: Boolean(document.querySelector("video")), textLen: document.body ? document.body.innerText.length : 0 })',
              )
              reports.push({ url: frame.url, ...result })
            } catch (error) {
              reports.push({ url: frame.url, error: String(error?.message || error).slice(0, 80) })
            }
          }
          check('解析页内嵌播放器已加载', reports.some((item) => item.hasVideo || item.textLen > 0), JSON.stringify(reports).slice(0, 400))
        } catch (error) {
          check('解析页内嵌播放器已加载', false, String(error?.message || error).slice(0, 160))
        }
        try {
          const image = await window.webContents.capturePage()
          const parseShot = process.env.CHANGSPIN_SMOKE_SHOT.replace(/\.png$/i, '-parse.png')
          fs.writeFileSync(parseShot, image.toPNG())
          check('解析页截图已保存', true, parseShot)
        } catch (error) {
          check('解析页截图已保存', false, String(error?.message || error))
        }
        try {
          const inner = await window.webContents.executeJavaScript(
            "(async () => { const wv = document.querySelector('#parse-view'); const img = await wv.capturePage(); return img.toDataURL() })()",
          )
          const base64 = String(inner || '').replace(/^data:image\/png;base64,/, '')
          const innerShot = process.env.CHANGSPIN_SMOKE_SHOT.replace(/\.png$/i, '-webview.png')
          fs.writeFileSync(innerShot, Buffer.from(base64, 'base64'))
          check('webview 自身截图已保存', true, innerShot)
        } catch (error) {
          check('webview 自身截图已保存', false, String(error?.message || error))
        }
      }
      try {
        window.webContents.executeJavaScript("document.querySelector('#parse-view').stop()")
      } catch {
        /* 忽略 */
      }
    }
  }

  // ---- 4. 截图（可选） ----
  const shotPath = process.env.CHANGSPIN_SMOKE_SHOT
  if (shotPath) {
    window.showInactive()
    await new Promise((resolve) => setTimeout(resolve, 900))
    try {
      const image = await window.webContents.capturePage()
      fs.mkdirSync(path.dirname(shotPath), { recursive: true })
      fs.writeFileSync(shotPath, image.toPNG())
      check('界面截图已保存', true, shotPath)
    } catch (error) {
      check('界面截图已保存', false, String(error?.message || error))
    }
  }

  const failed = checks.filter((item) => !item.ok).length
  return { checks, failed, passed: checks.length - failed }
}

module.exports = { runSmoke }
