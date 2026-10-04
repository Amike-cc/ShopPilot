const PORT='9250'
const list=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg=list.find(t=>/daren-square/.test(String(t.url)))
if(!pg){console.log('无广场页目标');process.exit(0)}
const ws=new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok,e)=>{ws.onopen=ok;ws.onerror=e})
let s=0;const p=new Map()
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id)}}
const send=(me,pa={})=>new Promise((ok,er)=>{const id=++s;p.set(id,m=>m.error?er(new Error(JSON.stringify(m.error))):ok(m.result));ws.send(JSON.stringify({id,method:me,params:pa}))})
const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true,userGesture:true});return r.exceptionDetails?'THREW '+JSON.stringify(r.exceptionDetails).slice(0,200):r.result.value}
console.log(await ev(`(() => {
  const b=String(document.body?document.body.innerText:'').replace(/\s+/g,' ').trim()
  return JSON.stringify({ url: location.href, readyState: document.readyState, bodyLen: b.length, head: b.slice(0,300), iframes: document.querySelectorAll('iframe').length, hasLoginWord: /登录|扫码|请先登录/.test(b) })
})()`))
ws.close();process.exit(0)
