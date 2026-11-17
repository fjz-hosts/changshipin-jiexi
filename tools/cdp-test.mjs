// 通过 Chrome DevTools Protocol 验证「平台快捷入口」窗口：
// 打开主界面 → 调用 openPlatform('iqiyi') → 检查内置官网窗口与 webview 真的加载了。
// 用法：先以 --remote-debugging-port=9222 启动应用，再 node tools/cdp-test.mjs
const ENDPOINT = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targets() {
  const res = await fetch(`${ENDPOINT}/json/list`)
  return res.json()
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
            const timer = setTimeout(() => rej(new Error(`timeout ${method}`)), 20000)
            pending.set(id, (msg) => {
              clearTimeout(timer)
              if (msg.error) rej(new Error(JSON.stringify(msg.error)))
              else res(msg.result)
            })
          })
        },
        close() {
          ws.close()
        },
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
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 300))
  return result.result?.value
}

const list = await targets()
const mainTarget = list.find((item) => item.type === 'page' && item.url.includes('index.html'))
if (!mainTarget) {
  console.error('找不到主界面 target：', list.map((i) => i.url))
  process.exit(1)
}
const main = await connect(mainTarget.webSocketDebuggerUrl)
const opened = await evaluate(main, "window.desktop.openPlatform('iqiyi')")
console.log('openPlatform ->', opened)
await sleep(9000)

const list2 = await targets()
const platformTarget = list2.find((item) => item.type === 'page' && item.url.includes('platform.html'))
console.log('platform target:', platformTarget ? platformTarget.url : 'NOT FOUND')
if (!platformTarget) {
  console.error('内置官网窗口没有出现')
  process.exit(2)
}

const platform = await connect(platformTarget.webSocketDebuggerUrl)
const info = await evaluate(
  platform,
  `(() => {
    const wv = document.querySelector('#page')
    return JSON.stringify({
      wrapperTitle: document.title,
      brand: document.querySelector('#brand-name').textContent,
      webviewExists: Boolean(wv),
      webviewUrl: wv ? wv.getURL() : '',
      canBack: wv ? wv.canGoBack() : null,
      address: document.querySelector('#address').value.slice(0, 120),
    })
  })()`,
)
console.log('platform info:', info)
const shot = await platform.send('Page.captureScreenshot', { format: 'png' })
const fs = await import('node:fs')
fs.writeFileSync(process.env.CDP_SHOT || 'tools/platform-window.png', Buffer.from(shot.data, 'base64'))

// 验证「填入解析」把链接送回主界面
const videoUrl = 'https://www.iqiyi.com/v_b13ju3xx7s.html?lt=2'
await evaluate(platform, `window.platformApi.sendToParse(${JSON.stringify(videoUrl)}, false)`)
await sleep(1500)
const mainState = await evaluate(main, `JSON.stringify({ input: document.querySelector('#url-input').value, badge: document.querySelector('#platform-badge').textContent })`)
console.log('main after send:', mainState)

const parsed = JSON.parse(info)
const mainParsed = JSON.parse(mainState)
const ok =
  parsed.webviewExists === true &&
  parsed.webviewUrl.includes('iqiyi.com') &&
  parsed.wrapperTitle.includes('爱奇艺') &&
  mainParsed.input === videoUrl &&
  mainParsed.badge === '爱奇艺'
console.log(ok ? 'PLATFORM TEST: PASS' : 'PLATFORM TEST: FAIL')
main.close()
platform.close()
process.exit(ok ? 0 : 3)
