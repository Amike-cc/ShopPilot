const PORT='9250'
const list=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg=list.find(t=>/daren-square|daren-match/.test(String(t.url))||/login\.kwaixiaodian/.test(String(t.url)))
if(!pg){console.log('无页面目标:',list.map(t=>t.url).slice(0,6));process.exit(0)}
console.log('目标:',pg.url)
const ws=new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok,e)=>{ws.onopen=ok;ws.onerror=e})
let s=0;const p=new Map()
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id)}}
const send=(me,pa={})=>new Promise((ok,er)=>{const id=++s;p.set(id,m=>m.error?er(new Error(JSON.stringify(m.error))):ok(m.result));ws.send(JSON.stringify({id,method:me,params:pa}))})
const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true,userGesture:true});return r.exceptionDetails?'THREW '+JSON.stringify(r.exceptionDetails).slice(0,200):r.result.value}
console.log(await ev(`(() => {
  const all=[...document.querySelectorAll('*')]
  const own=e=>[...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim()
  const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0}
  const hits=all.filter(e=>own(e)==='个护家清')
  const cat=all.find(e=>own(e)==='带货类目')
  let row=cat;for(let i=0;i<2&&row;i++)row=row.parentElement
  return JSON.stringify({
    ownTextHits: hits.length,
    hitsDetail: hits.slice(0,4).map(e=>{const r=e.getBoundingClientRect();return {tag:e.tagName,cls:String(e.className||'').slice(0,40),vis:vis(e),rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]}}),
    catLabelFound: !!cat,
    rowFound: !!row,
    rowClass: row?String(row.className||'').slice(0,60):null,
    rowTextHead: row?String(row.innerText||'').replace(/\s+/g,' ').trim().slice(0,90):null,
    path: location.pathname,
    title: document.title
  })
})()`))
ws.close();process.exit(0)
