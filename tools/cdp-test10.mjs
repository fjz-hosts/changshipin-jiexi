// 下载记录回归：短视频 / 音乐记录能跨重启保留，界面上能单条删除，删记录时文件一起删掉。
// 启动：electron . --remote-debugging-port=9345 --no-sandbox --disable-gpu
// 运行：node tools/cdp-test10.mjs
import fs from 'node:fs'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const EP = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9345'
const list = async () => await (await fetch(EP + '/json/list')).json()

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let id = 1
    const pending = new Map()
    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          const i = id++
          ws.send(JSON.stringify({ id: i, method, params }))
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('timeout')), 40000)
            pending.set(i, (m) => {
              clearTimeout(t)
              res(m)
            })
          })
        },
        close: () => ws.close(),
      }),
    )
    ws.addEventListener('error', reject)
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m)
        pending.delete(m.id)
      }
    })
  })
}

async function ev(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  return r.result?.result?.value
}

const report = []
const check = (name, ok, detail = '') => {
  report.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

async function waitForApp(c, timeout = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await ev(c, 'Boolean(window.__app && window.desktop && document.querySelector("#short-queue-list"))')) return true
    await sleep(250)
  }
  return false
}

const targets = await list()
const mainT = targets.find((t) => t.type === 'page' && String(t.url).includes('index.html'))
if (!mainT) throw new Error('没有找到主窗口页面')
const main = await connect(mainT.webSocketDebuggerUrl)
if (!(await waitForApp(main))) throw new Error('渲染进程没有初始化')

const info = JSON.parse(await ev(main, '(async () => JSON.stringify(await window.desktop.info()))()'))
check('app:info 暴露下载目录', Boolean(info.downloadDir && info.musicDir), `${info.downloadDir} | ${info.musicDir}`)

const shortDir = path.join(info.downloadDir, 'CDP下载记录测试剧')
const shortFile = path.join(shortDir, '第1集.mp4')
fs.mkdirSync(shortDir, { recursive: true })
fs.writeFileSync(shortFile, 'demo')
const musicDir = path.join(info.musicDir, '网易云音乐')
const musicFile = path.join(musicDir, 'CDP测试 - 歌手.mp3')
const lyricFile = path.join(musicDir, 'CDP测试 - 歌手.lrc')
fs.mkdirSync(musicDir, { recursive: true })
fs.writeFileSync(musicFile, 'demo')
fs.writeFileSync(lyricFile, 'demo')

// ---- 1. 短视频下载记录：界面渲染 + 单条删除（文件一起删） ----
const shortRender = await ev(
  main,
  `(async () => {
    await window.desktop.shortDownloadRecord({
      id: 'cdp-short-1', title: 'CDP下载记录测试剧 第1集', platform: '抖音',
      status: 'done', percent: 100, savedPath: ${JSON.stringify(shortFile)}, at: Date.now(),
    });
    const s = window.__app.getState();
    s.shortQueue = [{
      key: 'q-cdp-1', id: 'cdp-short-1', title: 'CDP下载记录测试剧 第1集', platform: '抖音',
      status: 'done', percent: 100, savedPath: ${JSON.stringify(shortFile)}, at: Date.now(),
    }];
    window.__app.switchMode('short', { force: true });
    window.__app.renderShortQueue();
    const row = document.querySelector('#short-queue-list .short-queue-item');
    return JSON.stringify({
      rows: document.querySelectorAll('#short-queue-list .short-queue-item').length,
      hasReveal: Boolean(row && row.querySelector('[data-qaction="reveal"]')),
      hasDelete: Boolean(row && row.querySelector('[data-qaction="remove"]')),
      state: row ? row.querySelector('.q-state').textContent : '',
    });
  })()`,
)
const sr = JSON.parse(shortRender)
check(
  '短视频下载记录：列表显示记录和「定位 / 删除」按钮',
  sr.rows === 1 && sr.hasReveal && sr.hasDelete && sr.state.includes('已完成'),
  shortRender,
)

await ev(main, 'window.confirm = () => true; true')
await ev(main, `document.querySelector('#short-queue-list [data-qaction="remove"]').click(); true`)
await sleep(1200)
const shortAfter = JSON.parse(
  await ev(
    main,
    `(async () => {
      const config = await window.desktop.getConfig();
      return JSON.stringify({
        queue: window.__app.getState().shortQueue.length,
        records: (config.shortDownloads || []).filter((item) => item.id === 'cdp-short-1').length,
        empty: document.querySelector('#short-queue-list').textContent.trim(),
      });
    })()`,
  ),
)
check(
  '短视频下载记录：点 × 删除记录',
  shortAfter.queue === 0 && shortAfter.records === 0,
  JSON.stringify(shortAfter),
)
check('短视频下载记录：对应视频文件和空的剧名文件夹一起删掉', !fs.existsSync(shortFile) && !fs.existsSync(shortDir))

// ---- 2. 音乐下载记录：写进配置，页面重载后还在 ----
await ev(
  main,
  `(async () => {
    await window.desktop.musicDownloadRecord({
      id: 'cdp-music-1', title: 'CDP测试 - 歌手', platformName: '网易云音乐', platform: 'netease',
      format: 'mp3', status: 'done', percent: 100,
      savedPath: ${JSON.stringify(musicFile)}, lyricPath: ${JSON.stringify(lyricFile)}, at: Date.now(),
    });
    return true;
  })()`,
)
await main.send('Page.reload', { ignoreCache: false })
await sleep(1500)
if (!(await waitForApp(main))) throw new Error('重载后渲染进程没有初始化')
await ev(main, 'window.confirm = () => true; true')
const musicRender = JSON.parse(
  await ev(
    main,
    `(async () => {
      window.__app.switchMode('music', { force: true });
      for (let i = 0; i < 40; i += 1) {
        if (window.MusicUI && window.MusicUI.state.inited && window.MusicUI.state.downloads.length) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const tab = Array.from(document.querySelectorAll('#music-tabs button')).find((b) => b.dataset.mtab === 'downloads');
      tab.click();
      await new Promise((r) => setTimeout(r, 300));
      const row = document.querySelector('.music-download-row');
      return JSON.stringify({
        loaded: window.MusicUI.state.downloads.length,
        rows: document.querySelectorAll('.music-download-row').length,
        hasDelete: Boolean(row && row.querySelector('[data-action="delete"]')),
        hasReveal: Boolean(row && row.querySelector('[data-action="reveal"]')),
        title: row ? row.querySelector('b').textContent : '',
      });
    })()`,
  ),
)
check(
  '音乐下载记录：退出重进（重载）后仍在，列表显示删除 / 定位按钮',
  musicRender.loaded === 1 && musicRender.rows === 1 && musicRender.hasDelete && musicRender.hasReveal && musicRender.title === 'CDP测试 - 歌手',
  JSON.stringify(musicRender),
)

await ev(main, `document.querySelector('.music-download-row [data-action="delete"]').click(); true`)
await sleep(1200)
const musicAfter = JSON.parse(
  await ev(
    main,
    `(async () => {
      const config = await window.desktop.getConfig();
      return JSON.stringify({
        loaded: window.MusicUI.state.downloads.length,
        records: (config.musicDownloads || []).filter((item) => item.id === 'cdp-music-1').length,
      });
    })()`,
  ),
)
check('音乐下载记录：点 × 删除记录', musicAfter.loaded === 0 && musicAfter.records === 0, JSON.stringify(musicAfter))
check('音乐下载记录：音频和 .lrc 歌词一起删掉', !fs.existsSync(musicFile) && !fs.existsSync(lyricFile))

// ---- 3. 「清空记录」按钮：记录和文件一起清掉（也验证音乐列表头的监听） ----
const shortDir2 = path.join(info.downloadDir, 'CDP清空测试剧')
const shortFile2 = path.join(shortDir2, '第1集.mp4')
fs.mkdirSync(shortDir2, { recursive: true })
fs.writeFileSync(shortFile2, 'demo')
await ev(
  main,
  `(async () => {
    await window.desktop.shortDownloadRecord({
      id: 'cdp-short-2', title: 'CDP清空测试剧 第1集', platform: '抖音',
      status: 'done', percent: 100, savedPath: ${JSON.stringify(shortFile2)}, at: Date.now(),
    });
    const s = window.__app.getState();
    s.shortQueue = [{ key: 'q-cdp-2', id: 'cdp-short-2', title: 'CDP清空测试剧 第1集', status: 'done', percent: 100, savedPath: ${JSON.stringify(shortFile2)} }];
    window.__app.renderShortQueue();
    return true;
  })()`,
)
await ev(main, `document.querySelector('#short-queue-clear').click(); true`)
await sleep(1200)
const shortClear = JSON.parse(
  await ev(
    main,
    `(async () => {
      const config = await window.desktop.getConfig();
      return JSON.stringify({
        queue: window.__app.getState().shortQueue.length,
        records: (config.shortDownloads || []).length,
      });
    })()`,
  ),
)
check('短视频「清空记录」：记录和视频文件一起清掉', shortClear.queue === 0 && shortClear.records === 0 && !fs.existsSync(shortFile2), JSON.stringify(shortClear))

const musicFile2 = path.join(musicDir, 'CDP清空 - 歌手.mp3')
const lyric2 = path.join(musicDir, 'CDP清空 - 歌手.lrc')
fs.mkdirSync(musicDir, { recursive: true })
fs.writeFileSync(musicFile2, 'demo')
fs.writeFileSync(lyric2, 'demo')
await ev(
  main,
  `(async () => {
    await window.desktop.musicDownloadRecord({
      id: 'cdp-music-2', title: 'CDP清空 - 歌手', platformName: '网易云音乐', format: 'mp3',
      status: 'done', percent: 100, savedPath: ${JSON.stringify(musicFile2)}, lyricPath: ${JSON.stringify(lyric2)}, at: Date.now(),
    });
    return true;
  })()`,
)
await main.send('Page.reload', { ignoreCache: false })
await sleep(1500)
if (!(await waitForApp(main))) throw new Error('重载后渲染进程没有初始化')
await ev(main, 'window.confirm = () => true; true')
const musicClear = JSON.parse(
  await ev(
    main,
    `(async () => {
      window.__app.switchMode('music', { force: true });
      for (let i = 0; i < 40; i += 1) {
        if (window.MusicUI && window.MusicUI.state.inited && window.MusicUI.state.downloads.length) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const tab = Array.from(document.querySelectorAll('#music-tabs button')).find((b) => b.dataset.mtab === 'downloads');
      tab.click();
      await new Promise((r) => setTimeout(r, 300));
      const before = window.MusicUI.state.downloads.length;
      const clearBtn = document.querySelector('#music-list-head [data-list-action="clear-downloads"]');
      if (!clearBtn) return JSON.stringify({ before, clicked: false });
      clearBtn.click();
      await new Promise((r) => setTimeout(r, 1000));
      const config = await window.desktop.getConfig();
      return JSON.stringify({
        before,
        clicked: true,
        left: window.MusicUI.state.downloads.length,
        records: (config.musicDownloads || []).length,
      });
    })()`,
  ),
)
check(
  '音乐「清空记录」：列表头按钮生效，记录和音频 / 歌词一起清掉',
  musicClear.before === 1 && musicClear.clicked && musicClear.left === 0 && musicClear.records === 0 && !fs.existsSync(musicFile2) && !fs.existsSync(lyric2),
  JSON.stringify(musicClear),
)

try {
  fs.rmSync(shortDir, { recursive: true, force: true })
  fs.rmSync(shortDir2, { recursive: true, force: true })
  fs.rmSync(musicDir, { recursive: true, force: true })
} catch {
  /* 忽略 */
}

const failed = report.filter((item) => !item.ok)
console.log(`\n下载记录回归：${report.length - failed.length}/${report.length} 通过`)
main.close()
process.exit(failed.length ? 1 : 0)
