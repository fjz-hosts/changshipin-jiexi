const urls = [
  'http://api.mmhhw.cn/huan6/mgtv.php?vid=24769759',
  'https://api.mmhhw.cn/huan6/mgtv.php?vid=24769759',
  'https://pcweb.api.mgtv.com/player/video?video_id=24769759',
  'https://mobile-stream.api.mgtv.com/v1/video/source?video_id=24769759',
]
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'
for (const u of urls) {
  try {
    const r = await fetch(u, { headers: { 'user-agent': UA, referer: 'https://www.mgtv.com/' }, signal: AbortSignal.timeout(15000) })
    const t = await r.text()
    console.log('\n===', u, 'status', r.status, 'len', t.length)
    console.log(t.slice(0, 400))
  } catch (e) { console.log('\n===', u, 'ERR', e.cause?.code || e.message) }
}
