// 界面回归：播放器下方选集条 / 观看历史分组与搜索 / 下载按钮初始状态
// 启动：electron . --remote-debugging-port=9345 --no-sandbox --disable-gpu
// 运行：node tools/cdp-test9.mjs
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

const targets = await list()
const mainT = targets.find((t) => t.type === 'page' && String(t.url).includes('index.html'))
const main = await connect(mainT.webSocketDebuggerUrl)
for (let i = 0; i < 80; i += 1) {
  if (await ev(main, 'Boolean(window.__app && window.__app.getState)')) break
  await sleep(250)
}

// 1. 选集条
const series = await ev(
  main,
  `(() => {
    const fake = {
      platform: 'mgtv', title: '回归测试剧', seriesKey: 'test:series',
      episodes: [1,2,3,4,5].map((n) => ({ label: '第' + n + '集', title: '回归测试剧 第' + n + '集', url: 'https://www.mgtv.com/b/1/' + n + '.html', index: n })),
    }
    window.__app.getState().currentVideoUrl = 'https://www.mgtv.com/b/1/3.html'
    window.__app.showSeries(fake)
    const bar = document.querySelector('#episode-bar')
    const active = document.querySelector('#episode-list .episode-item.active')
    return JSON.stringify({
      hidden: bar.hidden,
      count: document.querySelectorAll('#episode-list .episode-item').length,
      active: active ? active.textContent.trim() : '',
      name: document.querySelector('#episode-series-name').textContent,
      countText: document.querySelector('#episode-count').textContent,
    })
  })()`,
)
const s = JSON.parse(series)
check('选集条显示在播放器下方', s.hidden === false)
check('选集条集数正确', s.count === 5 && s.countText.includes('5'))
check('当前集高亮', s.active.includes('第3集'), s.active)

// 2. 倒序
const order = await ev(
  main,
  `(() => {
    document.querySelector('#episode-order').click()
    const first = document.querySelector('#episode-list .episode-item')?.textContent.trim()
    const btn = document.querySelector('#episode-order').textContent
    document.querySelector('#episode-order').click()
    return JSON.stringify({ first, btn })
  })()`,
)
const o = JSON.parse(order)
check('选集支持倒序', o.first.includes('第5集') && o.btn === '正序', order)

// 3. 收起/展开
const collapse = await ev(
  main,
  `(() => {
    document.querySelector('#episode-toggle').click()
    const collapsed = document.querySelector('#episode-bar').classList.contains('collapsed')
    const label = document.querySelector('#episode-toggle').textContent
    document.querySelector('#episode-toggle').click()
    return JSON.stringify({ collapsed, label })
  })()`,
)
const c = JSON.parse(collapse)
check('选集可收起/展开', c.collapsed === true && c.label === '展开', collapse)

// 4. 历史分组 + 搜索
const historyResult = await ev(
  main,
  `(async () => {
    const base = 'https://www.iqiyi.com/v_cdp9_'
    await window.desktop.addHistory({ url: base + '1.html', title: '回归历史剧A 第1集', episode: '第1集' })
    const list = await window.desktop.addHistory({ url: base + '2.html', title: '回归历史剧B 第1集', episode: '第1集' })
    window.__app.getState().config.history = list
    const sort = document.querySelector('#history-sort')
    sort.value = 'grouped'
    sort.dispatchEvent(new Event('change'))
    const groups = document.querySelectorAll('#history-list .history-group').length
    const items = document.querySelectorAll('#history-list .history-item').length
    const input = document.querySelector('#history-search-input')
    input.value = 'zzz-nothing'
    input.dispatchEvent(new Event('input'))
    const empty = document.querySelector('#history-list .empty-row')?.textContent || ''
    input.value = ''
    input.dispatchEvent(new Event('input'))
    sort.value = 'recent'
    sort.dispatchEvent(new Event('change'))
    await window.desktop.removeHistory(base + '1.html')
    await window.desktop.removeHistory(base + '2.html')
    return JSON.stringify({ groups, items, empty })
  })()`,
)
const h = JSON.parse(historyResult)
check('观看历史按平台分组', h.groups === 1 && h.items >= 2, historyResult)
check('观看历史搜索无结果提示', h.empty.includes('没有匹配'), h.empty)

// 5. 下载按钮初始禁用（没有 stream 结果时不能下载）
const download = await ev(
  main,
  `(() => {
    window.__app.getState().lastResult = null
    window.__app.setDownloadButton()
    return JSON.stringify({ text: document.querySelector('#btn-download').textContent, disabled: document.querySelector('#btn-download').disabled })
  })()`,
)
const d = JSON.parse(download)
check('下载按钮在没有内置播放结果时禁用', d.disabled === true, download)

// 6. 清理注入的选集状态
await ev(main, `window.__app.showSeries(null); window.__app.getState().currentVideoUrl = ''`)
const cleaned = await ev(main, `document.querySelector('#episode-bar').hidden`)
check('清空后选集条隐藏', cleaned === true)

main.close()
const failed = report.filter((item) => !item.ok).length
console.log(`\n结果：${report.length - failed}/${report.length} 通过`)
process.exit(failed ? 1 : 0)
