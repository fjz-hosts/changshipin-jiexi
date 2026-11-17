const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
const list=await (await fetch('http://127.0.0.1:9228/json/list')).json()
const main=list.find(t=>t.type==='page'&&t.url.includes('index.html'))
const ws=new WebSocket(main.webSocketDebuggerUrl)
let id=1; const pending=new Map()
ws.addEventListener('message',e=>{const m=JSON.parse(e.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m); pending.delete(m.id)}})
await new Promise(r=>ws.addEventListener('open',r))
function send(method,params={}){const i=id++; ws.send(JSON.stringify({id:i,method,params})); return new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('timeout')),30000); pending.set(i,m=>{clearTimeout(t); res(m)})})}
async function ev(expr){const r=await send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true}); return r.result?.result?.value}
const t0=Date.now()
await ev(`window.__app.startParse({url:'https://www.mgtv.com/b/817372/24773914.html?fpa=12946&fpos=2&lastp=ch_home', lineId:'builtin-789', chain:true})`)
let firstLevel=0, firstReady=0
for (let i=1;i<=60;i++) {
  await sleep(1000)
  const st=JSON.parse(await ev(`JSON.stringify({levels:(window.__app.getState().hls&&window.__app.getState().hls.levels.length)||0, ready:document.querySelector('#video').readyState, dur:document.querySelector('#video').duration||0})`))
  if (!firstLevel && st.levels>0) { firstLevel=Date.now()-t0; console.log('levels at', firstLevel,'ms') }
  if (!firstReady && st.ready>0) { firstReady=Date.now()-t0; console.log('ready',st.ready,'at',firstReady,'ms'); break }
  if (i%5===0) console.log(i+'s',JSON.stringify(st))
}
console.log('RESULT firstLevel='+firstLevel+' firstReady='+firstReady)
process.exit(firstReady?0:1)
