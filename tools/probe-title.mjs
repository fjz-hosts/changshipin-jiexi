const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'
const urls=[
 'https://www.iqiyi.com/v_b13ju3xx7s.html?lt=2',
 'https://v.qq.com/x/cover/mzc002001w361jz/x4102olnagg.html',
 'https://v.youku.com/v_show/id_XNjU3MzkyOTA0NA==.html',
 'https://www.mgtv.com/b/817372/24769759.html'
]
for (const u of urls) {
  try {
    const r=await fetch(u,{headers:{'user-agent':UA,'accept-language':'zh-CN'},signal:AbortSignal.timeout(15000)})
    const t=await r.text()
    const title=(t.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||''
    const og=(t.match(/property=["']og:title["'][^>]*content=["']([^"']+)/i)||[])[1]||''
    console.log(u,'\n  status',r.status,'len',t.length,'\n  title:',title.trim().slice(0,120),'\n  og:',og.slice(0,120))
  } catch(e){ console.log(u,'ERR',e.cause?.code||e.message) }
}
