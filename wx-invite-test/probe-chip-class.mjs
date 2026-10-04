const PORT='9250'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(t => /store\.weixin\.qq\.com/.test(String(t.url)))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok,err)=>{ws.onopen=ok;ws.onerror=err})
let s=0; const pend=new Map()
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}}
const send=(method,params={})=>new Promise((ok,err)=>{const id=++s;pend.set(id,m=>m.error?err(new Error(JSON.stringify(m.error))):ok(m.result));ws.send(JSON.stringify({id,method,params}))})
const ev=async expr=>{const r=await send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true,userGesture:true}); if(r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0,300)); return r.result.value}
const dump = `(() => {
  const out=[];const walk=r=>{for(const e of r.querySelectorAll('*')){out.push(e);if(e.shadowRoot)walk(e.shadowRoot)};if(r.shadowRoot)walk(r.shadowRoot)};walk(document)
  const own=e=>[...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim()
  const row=(()=>{for(const el of out){if(own(el)!=='带货类目')continue;return el.closest('.weui-desktop-form__control-group')}return null})()
  const chips=row?[...row.querySelectorAll('label')].slice(1,4).map(el=>{const i=el.querySelector('input');return {t:String(el.innerText||'').replace(/\\s+/g,' ').trim(),labelCls:String(el.className),iCls:String((el.querySelector('i')||{}).className||''),checked:i?i.checked:null,html:String(el.outerHTML).replace(/\\s+/g,' ').slice(0,260)}}):[]
  return JSON.stringify(chips,null,1)
})()`
console.log(await ev(dump))
// 点一个未选中的类目，再看类名变化
console.log(await ev(`(() => {
  const out=[];const walk=r=>{for(const e of r.querySelectorAll('*')){out.push(e);if(e.shadowRoot)walk(e.shadowRoot)};if(r.shadowRoot)walk(r.shadowRoot)};walk(document)
  const own=e=>[...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim()
  const row=(()=>{for(const el of out){if(own(el)!=='带货类目')continue;return el.closest('.weui-desktop-form__control-group')}return null})()
  const chip=[...row.querySelectorAll('label')].find(el=>String(el.innerText||'').replace(/\\s+/g,' ').trim()==='家纺')
  chip.click()
  return JSON.stringify({labelCls:String(chip.className), iCls:String((chip.querySelector('i')||{}).className||''), checked:chip.querySelector('input').checked})
})()`))
await new Promise(r=>setTimeout(r,1500))
console.log(await ev(dump))
ws.close(); process.exit(0)
