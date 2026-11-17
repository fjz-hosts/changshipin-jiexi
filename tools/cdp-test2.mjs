// 第二轮 CDP 验证：全屏 / 找剧搜索 / 复制本集校验 / 自动解析
import fs from 'node:fs'

const ENDPOINT = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targets() {
  return (await fetch(`${ENDPOINT}/json/list`)).json()
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const pending = new Map()
    let nextId = 1
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++
          ws.send(JSON.stringify({ id, method, params }))
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error(`timeout ${method}`)), 30000)
            pending.set(id, (msg) => {
              clearTimeout(timer)
              if (msg.error) rej(new Error(JSON.stringify(msg.error)))
              else res(msg.result)
            })
          })
        },
        close: () => ws.close(),
      })
    })
    ws.addEventListener('error', reject)
    ws.addEventListener('message', (event) => {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    })
  })
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 400))
  return result.result?.value
}

const report = []
const check = (name, ok, detail = '') => {
  report.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
}

const list = await targets()
const mainTarget = list.find((item) => item.type === 'page' && item.url.includes('index.html'))
if (!mainTarget) {
  console.error('找不到主界面 target', list.map((i) => i.url))
  process.exit(1)
}
const main = await connect(mainTarget.webSocketDebuggerUrl)

async function shot(client, file) {
  const data = await client.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(file, Buffer.from(data.data, 'base64'))
}
await shot(main, 'tools/v102-main.png')

// 1. 全屏
const fsState = await evaluate(
  main,
  `(async () => {
    await window.__app.toggleFullscreen()
    await new Promise((r) => setTimeout(r, 800))
    const on = { cinema: document.body.classList.contains('cinema'), fs: await window.desktop.getFullscreenState(), w: window.innerWidth, h: window.innerHeight }
    await window.__app.toggleFullscreen()
    await new Promise((r) => setTimeout(r, 800))
    const off = { cinema: document.body.classList.contains('cinema'), fs: await window.desktop.getFullscreenState() }
    return JSON.stringify({ on, off })
  })()`,
)
const fsResult = JSON.parse(fsState)
check('全屏进入影院模式并铺满窗口', fsResult.on.cinema === true && fsResult.on.fs === true, JSON.stringify(fsResult.on))
check('退出全屏恢复工具栏', fsResult.off.cinema === false && fsResult.off.fs === false, JSON.stringify(fsResult.off))

// 2. 找剧搜索（只选爱奇艺，降低开销）
await evaluate(main, `document.querySelector('#btn-search').click()`)
await sleep(400)
const modalOpen = await evaluate(main, `!document.querySelector('#search-modal').hidden`)

await shot(main, 'tools/v102-search.png')
check('找剧弹窗打开', modalOpen === true)
await evaluate(
  main,
  `(() => {
    const picks = [...document.querySelectorAll('#platform-picks .pick')]
    picks.forEach((pick, index) => { pick.querySelector('input').checked = index === 0 })
    document.querySelector('#search-input').value = '庆余年'
    document.querySelector('#search-submit').click()
    return true
  })()`,
)
await sleep(9000)
const afterSearch = await targets()
const platformTarget = afterSearch.find((item) => item.type === 'page' && item.url.includes('platform.html'))
check('搜索后打开平台内置窗口', Boolean(platformTarget), platformTarget?.url?.slice(0, 120) || '')
let platform = null
let platformInfo = null
if (platformTarget) {
  platform = await connect(platformTarget.webSocketDebuggerUrl)
  const raw = await evaluate(platform, `document.querySelector('#page').getURL()`)
  platformInfo = String(raw || '')
  check(
    '平台窗口打开的是搜索页',
    /iqiyi\.com/.test(platformInfo) && /(\/so\/|so\.iqiyi\.com)/.test(platformInfo),
    platformInfo.slice(0, 140),
  )

  // 3. 非剧集页复制链接应被拦住
  await evaluate(platform, `document.querySelector('#btn-copy').click()`)
  await sleep(400)
  const copyHint = await evaluate(platform, `document.querySelector('#hint p').textContent`)

  await shot(platform, 'tools/v102-platform.png')
  check('非剧集页复制被拦截', String(copyHint).includes('请先点开'), String(copyHint))

  // 4. 自动解析：直接把 webview 导航到具体某一集
  const videoUrl = 'https://www.iqiyi.com/v_b13ju3xx7s.html?lt=2'
  await evaluate(platform, `document.querySelector('#page').src = ${JSON.stringify(videoUrl)}`)
  await sleep(7000)
  const sent = await evaluate(main, `document.querySelector('#url-input').value`)
  check('点击剧集自动送到主界面解析', String(sent).includes('v_b13ju3xx7s'), String(sent))

  // 5. 播放页以 window.open 打开时，应留在当前内置浏览器，不能停在旧页面
  await evaluate(
    platform,
    `document.querySelector('#page').executeJavaScript("window.open('https://www.iqiyi.com/v_b13ju3xx7s.html?lt=4')")`,
  )
  await sleep(5000)
  const afterPopup = await evaluate(platform, `document.querySelector('#page').getURL()`)
  const platformCount = (await targets()).filter((item) => item.type === 'page' && item.url.includes('platform.html')).length
  check(
    '播放页弹窗改为当前窗口打开',
    String(afterPopup).includes('v_b13ju3xx7s') && platformCount === 1,
    `${afterPopup} windows=${platformCount}`,
  )
}

main.close()
platform?.close()

const failed = report.filter((item) => !item.ok).length
console.log(`\n结果：${report.length - failed}/${report.length} 通过`)
process.exit(failed ? 1 : 0)
