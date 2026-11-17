import process from 'node:process'

const EP = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9345'
const WANT = process.argv[2] || 'https://www.iqiyi.com/v_b13ju3xx7s.html'
const EXPR = process.argv[3] || 'document.title'

const list = await (await fetch(`${EP}/json/list`)).json()
const wanted = new URL(WANT)
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
  console.log(JSON.stringify(list.map((t) => [t.type, String(t.url).slice(0, 140)]), null, 2))
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 1
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const i = id++
    ws.send(JSON.stringify({ id: i, method, params }))
    const t = setTimeout(() => reject(new Error('timeout')), 180000)
    pending.set(i, (m) => {
      clearTimeout(t)
      resolve(m)
    })
  })
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})
const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true })
if (r.result?.exceptionDetails) console.log('ERR', JSON.stringify(r.result.exceptionDetails).slice(0, 800))
else console.log(JSON.stringify(r.result?.result?.value, null, 2))
ws.close()
process.exit(0)
