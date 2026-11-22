// 播放中切换平台 / 模式的回归：长视频（内置播放器 / 网页线路）和短视频都要先暂停，回来还能继续。
// 启动：electron . --remote-debugging-port=9345 --no-sandbox --disable-gpu
// 运行：node tools/cdp-test11.mjs
//
// 需要 .tmp/guide/www/poster.mp4（跑过 tools/guide/make_poster.py 或 capture.py 就有）；
// 没有这个演示视频时脚本会直接跳过，不算失败。
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const EP = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9345'
const WWW = path.join(process.cwd(), '.tmp', 'guide', 'www')
const POSTER = path.join(WWW, 'poster.mp4')

if (!fs.existsSync(POSTER)) {
  console.log(`SKIP  没有找到演示视频 ${POSTER}（先跑 python tools/guide/capture.py）`)
  process.exit(0)
}
fs.writeFileSync(
  path.join(WWW, 'media.html'),
  '<!doctype html><html><head><meta charset="utf-8"></head><body style="background:#111">' +
    '<video id="v" src="poster.mp4" autoplay muted loop playsinline style="width:100%"></video></body></html>',
  'utf8',
)

const types = { '.mp4': 'video/mp4', '.html': 'text/html; charset=utf-8' }
const server = http.createServer((request, response) => {
  const name = String(request.url || '/').split('?')[0].replace(/^\//, '') || 'media.html'
  const file = path.join(WWW, path.basename(name))
  if (!fs.existsSync(file)) {
    response.writeHead(404)
    response.end()
    return
  }
  const stat = fs.statSync(file)
  response.writeHead(200, {
    'content-type': types[path.extname(file)] || 'application/octet-stream',
    'content-length': stat.size,
    'accept-ranges': 'bytes',
  })
  fs.createReadStream(file).pipe(response)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

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

const targets = await list()
const mainT = targets.find((t) => t.type === 'page' && String(t.url).includes('index.html'))
if (!mainT) throw new Error('没有找到主窗口页面')
const main = await connect(mainT.webSocketDebuggerUrl)
for (let i = 0; i < 60; i += 1) {
  if (await ev(main, 'Boolean(window.__app && window.desktop)')) break
  await sleep(250)
}

const result = JSON.parse(
  await ev(
    main,
    `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const out = {};

      // 1. 内置播放器播放中，点另一个平台卡片
      window.__app.switchMode('long', { force: true });
      const video = document.querySelector('#video');
      video.muted = true;
      video.src = ${JSON.stringify(base + '/poster.mp4')};
      video.load();
      try { await video.play(); } catch (e) {}
      await sleep(900);
      out.longPlayingBefore = !video.paused;
      window.__app.openBrowser('qq');
      await sleep(1100);
      out.longPausedOnPlatform = video.paused;
      out.longSrcKept = Boolean(video.getAttribute('src'));
      window.__app.hideBrowser();
      await sleep(500);
      try { await video.play(); } catch (e) {}
      await sleep(600);
      out.longResumed = !video.paused;
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) {}

      // 2. 网页线路（webview 里的视频）播放中切到音乐模式
      const view = document.querySelector('#parse-view');
      document.querySelector('#view-video').hidden = true;
      document.querySelector('#view-webview').hidden = false;
      view.src = ${JSON.stringify(base + '/media.html')};
      await sleep(2200);
      out.webviewPlayingBefore = await view.executeJavaScript('(() => { const el = document.querySelector("video"); return el ? !el.paused : false })()');
      window.__app.switchMode('music', { force: true });
      await sleep(1300);
      out.webviewPausedOnMode = await view.executeJavaScript('(() => { const el = document.querySelector("video"); return el ? el.paused : true })()');
      const mutedWhileAway = view.getAudioMuted ? view.getAudioMuted() : view.isAudioMuted();
      window.__app.switchMode('long', { force: true });
      await sleep(600);
      const mutedBack = view.getAudioMuted ? view.getAudioMuted() : view.isAudioMuted();
      await view.executeJavaScript('(() => { const el = document.querySelector("video"); if (el) el.play().catch(() => {}); return true })()');
      await sleep(600);
      out.webviewPlayableAgain = await view.executeJavaScript('(() => { const el = document.querySelector("video"); return el ? !el.paused : false })()');
      out.webviewMuteRoundTrip = mutedWhileAway === true && mutedBack === false;

      // 3. 短视频播放中，点短视频平台卡片
      window.__app.switchMode('short', { force: true });
      const shortVideo = document.querySelector('#short-video');
      shortVideo.muted = true;
      shortVideo.src = ${JSON.stringify(base + '/poster.mp4')};
      shortVideo.load();
      try { await shortVideo.play(); } catch (e) {}
      await sleep(800);
      window.__app.openBrowser('bilibili');
      await sleep(1100);
      out.shortPausedOnPlatform = shortVideo.paused;
      window.__app.hideBrowser();
      try { shortVideo.pause(); shortVideo.removeAttribute('src'); shortVideo.load(); } catch (e) {}
      window.__app.switchMode('long', { force: true });
      return JSON.stringify(out);
    })()`,
  ),
)

check('长视频：播放中点别的平台会暂停（进度保留）', result.longPlayingBefore === true && result.longPausedOnPlatform === true && result.longSrcKept === true, JSON.stringify(result))
check('长视频：从平台页回来还能接着播', result.longResumed === true, String(result.longResumed))
check('网页线路：播放中切到音乐模式会暂停', result.webviewPlayingBefore === true && result.webviewPausedOnMode === true, JSON.stringify(result))
check('网页线路：切走时静音，切回来恢复声音并能继续播', result.webviewMuteRoundTrip === true && result.webviewPlayableAgain === true, `${result.webviewMuteRoundTrip}/${result.webviewPlayableAgain}`)
check('短视频：播放中点平台卡片会暂停', result.shortPausedOnPlatform === true, String(result.shortPausedOnPlatform))

const failed = report.filter((item) => !item.ok)
console.log(`\n切换暂停回归：${report.length - failed.length}/${report.length} 通过`)
main.close()
server.close()
try {
  fs.rmSync(path.join(WWW, 'media.html'), { force: true })
} catch {
  /* 忽略 */
}
process.exit(failed.length ? 1 : 0)
