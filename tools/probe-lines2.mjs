// 线路探测脚本 2：允许自签名证书 + 输出页面特征，用来区分「网络不通」和「证书问题」。
const sample = process.argv[2] || 'https://www.iqiyi.com/v_b13ju3xx7s.html?lt=2'
const enc = encodeURIComponent(sample)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

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
  ['YParse', `https://jx.yparse.com/index.php?url=${enc}`],
  ['PlayM3u8', `https://www.playm3u8.cn/jiexi.php?url=${enc}`],
  ['Aidouer', `https://jx.aidouer.net/?url=${enc}`],
  ['911kan', `https://jx.911kan.com/?url=${enc}`],
  ['Bozrc', `https://jx.bozrc.com/?url=${enc}`],
  ['Ivito', `https://jx.ivito.cn/?url=${enc}`],
  ['M3u8Tv', `https://jx.m3u8.tv/jx.php?url=${enc}`],
  ['Wmkou', `https://jx.wmkou.com/?url=${enc}`],
  ['Liangzi', `https://jx.liangzipic.com/?url=${enc}`],
  ['Zxqly', `https://jx.zxqly.com/?url=${enc}`],
  ['123kan', `https://jx.123kan.cc/?url=${enc}`],
  ['Nxflv', `https://jx.nxflv.com/?url=${enc}`],
]

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'

async function probe(name, url) {
  const started = Date.now()
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    })
    const text = await res.text()
    const title = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''
    return {
      name,
      status: res.status,
      ms: Date.now() - started,
      kb: Math.round(text.length / 1024),
      kind: /\.m3u8/i.test(text) ? 'm3u8' : /<video/i.test(text) ? 'video' : /iframe/i.test(text) ? 'iframe' : 'html',
      title: title.trim().slice(0, 36).replace(/\s+/g, ' '),
    }
  } catch (error) {
    return { name, status: 'ERR', ms: Date.now() - started, kb: 0, kind: '', title: String(error.cause?.code || error.message).slice(0, 50) }
  }
}

const rows = await Promise.all(candidates.map(([name, url]) => probe(name, url)))
rows.sort((a, b) => String(a.status).localeCompare(String(b.status)))
console.table(rows)

// 同时确认四个平台官网可达
for (const [name, url] of [
  ['iqiyi', 'https://www.iqiyi.com/'],
  ['qq', 'https://v.qq.com/'],
  ['youku', 'https://www.youku.com/'],
  ['mgtv', 'https://www.mgtv.com/'],
]) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': UA } })
    console.log(`platform ${name}: ${res.status} ${res.headers.get('content-type')}`)
  } catch (error) {
    console.log(`platform ${name}: ERR ${String(error.cause?.code || error.message).slice(0, 50)}`)
  }
}
