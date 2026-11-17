// 测试芒果TV 原生解析（按 yt-dlp 的 tk2/getSource 流程移植）
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'
const videoUrl = process.argv[2] || 'https://www.mgtv.com/b/817372/24769759.html'
const videoId = (videoUrl.match(/\/(\d+)\.html/) || [])[1]
if (!videoId) throw new Error('无法从链接中提取芒果TV视频 id')

function tk2() {
  const raw = `did=${crypto.randomUUID()}|pno=1030|ver=0.3.0301|clit=${Math.floor(Date.now() / 1000)}`
  const b64 = Buffer.from(raw, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
  return b64.split('').reverse().join('')
}

const headers = {
  'user-agent': UA,
  referer: 'https://www.mgtv.com/',
  origin: 'https://www.mgtv.com',
  accept: 'application/json, text/plain, */*',
}

async function getJson(url) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  console.log('\nGET', url.slice(0, 160))
  console.log('status', res.status, 'len', text.length)
  console.log(text.slice(0, 500))
  return json || { raw: text }
}

const token = tk2()
console.log('videoId', videoId, 'tk2', token)

const api = await getJson(
  `https://pcweb.api.mgtv.com/player/video?tk2=${encodeURIComponent(token)}&video_id=${videoId}&type=pch5`,
)
const pm2 = api?.data?.atc?.pm2
console.log('pm2', pm2)
if (!pm2) process.exit(1)

const source = await getJson(
  `https://tinker.glb.mgtv.com/player/getSource?_support=10000000&tk2=${encodeURIComponent(token)}&pm2=${encodeURIComponent(pm2)}&video_id=${videoId}&type=pch5&auth_mode=1&cxid=&supportMse=1&src=intelmgtv&abroad=10&allowedRC=1`,
)
const data = source?.data
console.log('stream_domain', data?.stream_domain)
console.log('streams', (data?.stream || []).map((s) => ({ name: s.name, url: s.url })))
const domain = (data?.stream_domain || [])[0]
const first = (data?.stream || [])[0]
if (!domain || !first) process.exit(1)
const info = await getJson(new URL(first.url, domain).href)
console.log('info url', info?.info)
