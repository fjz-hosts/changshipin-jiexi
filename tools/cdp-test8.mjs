const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
const EP='http://127.0.0.1:9345'
const list=async()=>await (await fetch(EP+'/json/list')).json()
function connect(url){return new Promise((resolve,reject)=>{const ws=new WebSocket(url);let id=1;const pending=new Map();ws.addEventListener('open',()=>resolve({send(method,params={}){const i=id++;ws.send(JSON.stringify({id:i,method,params}));return new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('timeout')),40000);pending.set(i,m=>{clearTimeout(t);res(m)})})},close:()=>ws.close()}));ws.addEventListener('error',reject);ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}})})}
async function ev(c,expr){const r=await c.send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});if(r.result?.exceptionDetails)throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0,300));return r.result?.result?.value}
const report=[];const check=(n,ok,d='')=>{report.push({n,ok});console.log((ok?'PASS ':'FAIL ')+n+'  '+d)}
const before=await list();const mainT=before.find(t=>t.type==='page'&&t.url.includes('index.html'));const main=await connect(mainT.webSocketDebuggerUrl)
check('启动时只有一个主窗口',before.filter(t=>t.type==='page').length===1,String(before.length))
await ev(main,"window.__app.openBrowser('iqiyi')")
await sleep(7000)
let ts=await list()
check('点平台后没有新窗口',ts.filter(t=>t.type==='page').length===1,String(ts.filter(t=>t.type==='page').length))
const panel=JSON.parse(await ev(main,`JSON.stringify({hidden:document.querySelector('#browser-panel').hidden, url:(()=>{try{return window.__app.getState().browsers.get('iqiyi').webview.getURL()}catch(e){return ''}})(), parseHidden:document.querySelector('.parse-row').hidden})`))
check('平台网页在主窗口内打开',panel.hidden===false && String(panel.url).includes('iqiyi.com'),JSON.stringify(panel))
// 在主窗口浏览器里跳到芒果剧集页
await ev(main,"window.__app.getState().browsers.get('iqiyi').webview.src='https://www.mgtv.com/b/817372/24773914.html'")
await sleep(9000)
const auto=JSON.parse(await ev(main,`JSON.stringify({panelHidden:document.querySelector('#browser-panel').hidden, current:window.__app.getState().currentVideoUrl, source:document.querySelector('#source-url').textContent, btnDisabled:document.querySelector('#btn-parse').disabled, viewVideo:!document.querySelector('#view-video').hidden, viewLoading:!document.querySelector('#view-loading').hidden, viewError:!document.querySelector('#view-error').hidden})`))
console.log('auto:',JSON.stringify(auto))
check('点开剧集自动解析并回到播放界面',auto.panelHidden===true && String(auto.current).includes('mgtv.com') && auto.btnDisabled===false,JSON.stringify(auto))
await sleep(8000)
const hist=JSON.parse(await ev(main,`(async()=>JSON.stringify((await window.desktop.getConfig()).history.slice(0,1)))()`))
console.log('history:',JSON.stringify(hist))
check('观看历史有剧名/集数',hist.length>0 && !!hist[0].title,String(hist[0]&&hist[0].title))
// 重新打开内置浏览器，应停留在刚才的剧集页，回退应回到爱奇艺
await ev(main,"window.__app.openBrowser('iqiyi')")
await sleep(2000)
const reopen=await ev(main,`window.__app.getState().browsers.get('iqiyi').webview.getURL()`)
check('重新打开仍在剧集页',String(reopen).includes('mgtv.com'),reopen)
await ev(main,"document.querySelector('#browser-back').click()")
await sleep(3000)
const backUrl=await ev(main,`window.__app.getState().browsers.get('iqiyi').webview.getURL()`)
check('回退可回到上一步',String(backUrl).includes('iqiyi.com'),backUrl)
const finalTargets=(await list()).filter(t=>t.type==='page')
check('全程没有多开窗口',finalTargets.length===1,String(finalTargets.length))
main.close()
const failed=report.filter(r=>!r.ok).length
console.log(`\n结果：${report.length-failed}/${report.length} 通过`)
process.exit(failed?1:0)

