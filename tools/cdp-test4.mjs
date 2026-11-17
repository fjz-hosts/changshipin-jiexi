// 验证：平台内点开的「外站链接」也会用带工具栏的内置浏览器打开；
// 以及芒果TV 原生解析线路已经接入（本机因地区限制会返回明确错误）。
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
  console.error('找不到主界面', list.map((i) => i.url))
  process.exit(1)
}
const main = await connect(mainTarget.webSocketDebuggerUrl)

await evaluate(main, "window.desktop.openPlatform('iqiyi')")
await sleep(6000)
let all = await targets()
const platformTarget = all.find((item) => item.type === 'page' && item.url.includes('platform.html?key=iqiyi'))
if (!platformTarget) {
  console.error('爱奇艺窗口未打开')
  process.exit(2)
}
const platform = await connect(platformTarget.webSocketDebuggerUrl)

// 平台页面里以 window.open 打开一个「外站」音乐站
await evaluate(
  platform,
  `document.querySelector('#page').executeJavaScript("window.open('https://www.kuwo.cn/')")`,
)
await sleep(6000)
all = await targets()
const genericTarget = all.find((item) => item.type === 'page' && item.url.includes('platform.html?key=browser'))
check('外站链接用带工具栏的内置浏览器打开', Boolean(genericTarget), genericTarget?.url?.slice(0, 120) || '')
const bareTarget = all.find((item) => item.type === 'page' && /^https?:\/\/www\.kuwo\.cn/.test(item.url))
check('没有出现无工具栏的裸窗口', !bareTarget, bareTarget?.url || '')
if (genericTarget) {
  const generic = await connect(genericTarget.webSocketDebuggerUrl)
  const info = JSON.parse(
    await evaluate(
      generic,
      `JSON.stringify({
        url: document.querySelector('#page').getURL(),
        hasParse: Boolean(document.querySelector('#btn-parse')),
        hasCopy: Boolean(document.querySelector('#btn-copy')),
        hasAuto: Boolean(document.querySelector('#auto-parse')),
        brand: document.querySelector('#brand-name').textContent
      })`,
    ),
  )
  check('外站窗口有完整解析按钮', info.hasParse && info.hasCopy && info.hasAuto, JSON.stringify(info))
  check('外站窗口加载了目标站点', String(info.url).includes('kuwo.cn'), String(info.url).slice(0, 100))
  generic.close()
}

// 芒果TV 原生解析线路已接入：本机因非中国大陆网络，应返回「地区限制」而不是接口异常
const mangoResult = await evaluate(
  main,
  `window.desktop.parse({ url: 'https://www.mgtv.com/b/817372/24769759.html?no_wakeup=1', lineId: 'builtin-mgtv-native' })`,
)
check(
  '芒果TV 原生解析线路已生效',
  mangoResult && mangoResult.ok === false && String(mangoResult.error || '').includes('芒果TV'),
  JSON.stringify(mangoResult).slice(0, 160),
)

main.close()
platform.close()
const failed = report.filter((item) => !item.ok).length
console.log(`\n结果：${report.length - failed}/${report.length} 通过`)
process.exit(failed ? 1 : 0)
