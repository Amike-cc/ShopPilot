const PORT='9250'
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const targets=()=>fetch(`http://127.0.0.1:${PORT}/json/list`).then(r=>r.json())
async function connect(t){const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise((ok,e)=>{ws.onopen=ok;ws.onerror=e});let s=0;const p=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id)}};const send=(me,pa={})=>new Promise((ok,er)=>{const id=++s;p.set(id,m=>m.error?er(new Error(JSON.stringify(m.error))):ok(m.result));ws.send(JSON.stringify({id,method:me,params:pa}))});const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails).slice(0,200));return r.result.value};return{ev,call:async x=>JSON.parse(await ev(`(async()=>JSON.stringify(await ${x}))()`)),close:()=>ws.close()}}
const list=await targets()
const renderer=list.find(t=>t.type==='page'&&String(t.url).includes('out/renderer/index.html'))
const app=await connect(renderer)
await app.call(`window.shopilot.browser.display('store_4eb9b43cffeee0094041894a9f1f93bf')`)
await sleep(1500)
const tabs=(await app.call(`window.shopilot.browser.tab.list('store_4eb9b43cffeee0094041894a9f1f93bf')`))?.data?.tabs||[]
const sq=tabs.find(t=>/findersquare\/find$/.test(String(t.url)))
if(sq){await app.call(`window.shopilot.browser.tab.activate('store_4eb9b43cffeee0094041894a9f1f93bf',${JSON.stringify(sq.id)})`);await sleep(4000)}
const page=(await targets()).find(t=>/findersquare/.test(String(t.url)))
const c=await connect(page)
// 与 readBlockingNotice 同一段脚本（冒烟：选择器可用、无提示时返回 null）
const out=await c.ev(`(() => {
  const all=[];const walk=r=>{for(const e of r.querySelectorAll('*')){all.push(e);if(e.shadowRoot)walk(e.shadowRoot)}};walk(document)
  const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0}
  const sel='.weui-desktop-toast, .weui-desktop-dialog, [role="alert"], [role="tooltip"], .weui-desktop-popover, [class*="toast"], [class*="message"]'
  const cands=[]
  for(const e of all){if(!e.matches||!vis(e))continue;try{if(!e.matches(sel))continue}catch{continue}
    const t=String(e.innerText||'').replace(/\s+/g,' ').trim();if(t&&t.length<=120)cands.push(t)}
  cands.sort((a,b)=>a.length-b.length)
  return JSON.stringify({ matched:cands.length, first:cands[0]||null })
})()`)
console.log('提示读取冒烟:', out)
c.close(); app.close(); process.exit(0)
