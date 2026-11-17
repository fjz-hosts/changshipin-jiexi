// 线路探测脚本（开发用）：批量请求候选解析接口，报告状态 / 耗时 / 是否含 m3u8。
// 用法：node tools/probe-lines.mjs [视频链接]
const sample = process.argv[2] || 'https://www.iqiyi.com/v_b13ju3xx7s.html?lt=2'
const enc = encodeURIComponent(sample)

const candidates = [
  ['PlayerJY', `https://jx.playerjy.com/?url=${enc}`],
  ['Parwix', `https://jx.parwix.com:4433/player/?url=${enc}`],
  ['XMFLV', `https://jx.xmflv.com/?url=${enc}`],
  ['M1907', `https://im1907.top/?jx=${enc}`],
  ['777', `https://jx.777jiexi.com/player/?url=${enc}`],
  ['Pangu', `https://www.pangujiexi.cc/jiexi.php?url=${enc}`],
  ['2S0', `https://jx.2s0.cn/player/?url=${enc}`],
  ['Yemu', `https://www.yemu.xyz/?url=${enc}`],
  ['BL', `https://vip.bljiex.com/?v=${enc}`],
  ['BBBBBB', `https://api.bbbbbb.me/jx/?url=${enc}`],
  ['OkJX', `https://okjx.cc/?url=${enc}`],
  ['JsonPlayer', `https://jx.jsonplayer.com/player/?url=${enc}`],
  ['JX618', `https://jx.618g.com/?url=${enc}`],
  ['Hongni', `https://jx.hongnijk.com/?url=${enc}`],
  ['Kuaiyun', `https://jx.kuaiyun.me/?url=${enc}`],
]

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'

async function probe(name, url) {
  const started = Date.now()
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    })
    const text = await res.text()
    const title = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''
    return {
      name,
      status: res.status,
      ms: Date.now() - started,
      bytes: text.length,
      m3u8: /\.m3u8/i.test(text),
      title: title.trim().slice(0, 40).replace(/\s+/g, ' '),
    }
  } catch (error) {
    return { name, status: 'ERR', ms: Date.now() - started, bytes: 0, m3u8: false, title: String(error.cause?.code || error.message).slice(0, 60) }
  }
}

const rows = await Promise.all(candidates.map(([name, url]) => probe(name, url)))
rows.sort((a, b) => (String(a.status).padStart(4) > String(b.status).padStart(4) ? 1 : -1))
console.table(rows)
