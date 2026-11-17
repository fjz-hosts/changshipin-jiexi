const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
const list=await (await fetch('http://127.0.0.1:9226/json/list')).json()
const main=list.find(t=>t.type==='page'&&t.url.includes('index.html'))
const ws=new WebSocket(main.webSocketDebuggerUrl)
let id=1; const pending=new Map()
ws.addEventListener('message',e=>{const m=JSON.parse(e.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m); pending.delete(m.id)}})
await new Promise(r=>ws.addEventListener('open',r))
function send(method,params={}){const i=id++; ws.send(JSON.stringify({id:i,method,params})); return new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('timeout')),30000); pending.set(i,m=>{clearTimeout(t); res(m)})})}
async function ev(expr){const r=await send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true}); return r.result?.result?.value}
await ev(`window.__app.startParse({url:'https://www.mgtv.com/b/817372/24773914.html?fpa=12946&fpos=2&lastp=ch_home', lineId:'builtin-789', chain:true})`)
let info=''
for (let i=0;i<8;i++) {
  await sleep(2500)
  info=await ev(`JSON.stringify((()=>{const v=document.querySelector('#video');return {viewVideo:!document.querySelector('#view-video').hidden, loading:!document.querySelector('#view-loading').hidden, error:!document.querySelector('#view-error').hidden, line:document.querySelector('#stage-line').textContent, status:document.querySelector('#status-text').textContent, src:(v.currentSrc||'').slice(0,90), duration:Number.isFinite(v.duration)?Math.round(v.duration):null, ready:v.readyState, paused:v.paused, w:v.videoWidth, h:v.videoHeight, errText:document.querySelector('#error-detail').textContent.slice(0,120)}})())`)
  console.log(i, info)
  const p=JSON.parse(info)
  if (p.viewVideo && (p.ready>=2 || p.w>0 || p.duration)) break
}
const p=JSON.parse(info)
const ok=p.viewVideo && (p.ready>=2 || p.w>0)
console.log(ok?'MANGO PLAYBACK: PASS':'MANGO PLAYBACK: FAIL')
process.exit(ok?0:1)
