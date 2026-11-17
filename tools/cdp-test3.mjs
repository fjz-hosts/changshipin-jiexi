// 回归测试：平台窗口在播放/解析时被关闭，主进程不能再抛 "Object has been destroyed"
import fs from 'node:fs'

const ENDPOINT = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222'
const LOG = process.env.CHANGSPIN_LOG || process.env.APPDATA + '\\长视频解析\\logs\\desktop.log'
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
            const timer = setTimeout(() => rej(new Error(`timeout ${method}`)), 20000)
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
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 300))
  return result.result?.value
}

const list = await targets()
const mainTarget = list.find((item) => item.type === 'page' && item.url.includes('index.html'))
if (!mainTarget) {
  console.error('找不到主界面')
  process.exit(1)
}
const main = await connect(mainTarget.webSocketDebuggerUrl)
const before = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0

await evaluate(main, "window.desktop.openPlatform('iqiyi')")
await sleep(7000)
let all = await targets()
const platformTarget = all.find((item) => item.type === 'page' && item.url.includes('platform.html'))
if (!platformTarget) {
  console.error('平台窗口未打开')
  process.exit(2)
}
const platform = await connect(platformTarget.webSocketDebuggerUrl)
await evaluate(platform, `document.querySelector('#page').src = 'https://www.iqiyi.com/v_b13ju3xx7s.html?lt=2'`)
await sleep(6000)

// 关闭平台窗口
const closed = await evaluate(platform, `(window.close(), true)`).catch(() => false)
console.log('window.close ->', closed)
await sleep(3000)

all = await targets()
const stillPlatform = all.some((item) => item.url.includes('platform.html'))
const mainAlive = await evaluate(main, 'document.title').catch(() => 'DEAD')
console.log('platform target gone:', !stillPlatform, '| main alive:', mainAlive)

const logText = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').slice(before) : ''
const hasDestroyedError = /Object has been destroyed|未捕获异常/.test(logText)
console.log('new log:\n' + logText.split('\n').slice(-12).join('\n'))
const ok = !stillPlatform && mainAlive !== 'DEAD' && !hasDestroyedError
console.log(ok ? 'CLOSE TEST: PASS' : 'CLOSE TEST: FAIL')
main.close()
process.exit(ok ? 0 : 3)
