const PORT='9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())
async function connect(t){const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise((ok,er)=>{ws.onopen=ok;ws.onerror=er});let s=0;const p=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id)}};const send=(me,pa={})=>new Promise((ok,er)=>{const id=++s;p.set(id,m=>m.error?er(new Error(JSON.stringify(m.error))):ok(m.result));ws.send(JSON.stringify({id,method:me,params:pa}))});const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails).slice(0,200));return r.result.value};return{ev,call:async x=>JSON.parse(await ev(`(async()=>JSON.stringify(await ${x}))()`)),close:()=>ws.close()}}
const STATE=`(() => { const all=[];const walk=r=>{for(const e of r.querySelectorAll('*')){all.push(e);if(e.shadowRoot)walk(e.shadowRoot)}};walk(document)
  const own=e=>[...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim()
  const text=all.map(e=>own(e)).filter(Boolean).join(' ').replace(/\\s+/g,' ')
  return JSON.stringify({ url: location.href, readyState: document.readyState, typeTabs: all.filter(e=>/^(全部带货者|直播带货者|短视频带货者|公众号带货者)$/.test(own(e))).length, hasCat: all.some(e=>own(e)==='带货类目'), head: text.slice(0,140) }) })()`
const list = await targets()
const renderer = list.find(t => t.type==='page' && String(t.url).includes('out/renderer/index.html'))
const app = await connect(renderer)
const tabs = await app.call(`window.shopilot.browser.tab.list('store_4eb9b43cffeee0094041894a9f1f93bf')`)
const squares = (tabs?.data?.tabs||[]).filter(t=>/findersquare\/find$/.test(String(t.url)))
for (const t of squares) {
  await app.call(`window.shopilot.browser.tab.activate('store_4eb9b43cffeee0094041894a9f1f93bf','${t.id}')`).catch(()=>null)
  await sleep(3500)
  const page = (await targets()).find(x=>/findersquare\/find/.test(String(x.url)))
  if (!page) { console.log(t.id, '→ 未挂载'); continue }
  const c = await connect(page)
  console.log(t.id, '→', await c.ev(STATE))
  c.close()
}
app.close(); process.exit(0)
