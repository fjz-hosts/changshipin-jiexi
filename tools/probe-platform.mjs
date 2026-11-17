import fs from 'node:fs'

// 打开平台内置浏览器到指定页面，然后在页面里执行表达式（默认列出资源请求）。
// 用法：node tools/probe-platform.mjs <platformKey> <url> [expr] [outFile]

const EP = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9345'
const PLATFORM = process.argv[2] || 'iqiyi'
const VIDEO = process.argv[3] || 'https://www.iqiyi.com/v_b13ju3xx7s.html'
const EXPR =
  process.argv[4] ||
  `JSON.stringify(performance.getEntriesByType('resource').map((e) => e.name).filter((u) => /album|avlist|episode|play|video/i.test(u)).slice(-80), null, 2)`
const OUT = process.argv[5] || ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targets() {
  return await (await fetch(`${EP}/json/list`)).json()
}
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
            const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 40000)
            pending.set(i, (m) => {
              clearTimeout(t)
              res(m)
            })
          })
        },
        close() {
          try {
            ws.close()
          } catch {}
        },
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
async function evaluate(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600))
  return r.result?.result?.value
}

let list = await targets()
const mainT = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'))
const main = await connect(mainT.webSocketDebuggerUrl)
await evaluate(main, `window.__app.openBrowser(${JSON.stringify(PLATFORM)})`)
await sleep(1000)
// 关掉自动解析，避免刚打开就被送到主界面（页面仍在后台正常加载和播放）
await evaluate(main, `(() => { const box = document.querySelector('#browser-auto'); if (box) { box.checked = false; box.dispatchEvent(new Event('change')) } })()`)
await evaluate(main, `window.__app.getState().browsers.get(${JSON.stringify(PLATFORM)}).webview.src=${JSON.stringify(VIDEO)}`)
await sleep(9000)

list = await targets()
const wanted = new URL(VIDEO)
const target = list.find((t) => {
  if (t.type === 'iframe') return false
  try {
    const u = new URL(t.url)
    return u.hostname === wanted.hostname && u.pathname === wanted.pathname
  } catch {
    return false
  }
})
if (!target) {
  console.log(JSON.stringify({ error: 'target missing', targets: list.map((t) => [t.type, String(t.url).slice(0, 140)]) }, null, 2))
  process.exit(1)
}
const guest = await connect(target.webSocketDebuggerUrl)
const value = await evaluate(guest, EXPR)
if (OUT) fs.writeFileSync(OUT, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
guest.close()
main.close()
process.exit(0)
