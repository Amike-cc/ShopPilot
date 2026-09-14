/** 真实广场：详情元素 与 其中心点遮挡者 的祖先关系（判断 rowOf 是否相等） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const ENUM_DECL = 'function ENUM_ALL(){var o=[];var w=function(r){var els=r.querySelectorAll("*");for(var i=0;i<els.length;i++){var e=els[i];o.push(e);if(e.shadowRoot)w(e.shadowRoot)}};w(document);return o}'
const PROBE = [
  'var all=ENUM_ALL()',
  'var own=function(e){var s="";for(var i=0;i<e.childNodes.length;i++){var n=e.childNodes[i];if(n.nodeType===3)s+=n.textContent}return s.trim()}',
  'var deepAt=function(x,y){var el=document.elementFromPoint(x,y);while(el&&el.shadowRoot){var inner=el.shadowRoot.elementFromPoint(x,y);if(!inner||inner===el)break;el=inner}return el}',
  'var chain=function(e){var out=[];var n=e;for(var i=0;i<7&&n;i++,n=n.parentElement){out.push(n.tagName+"."+String(n.className||"").split(" ").slice(0,2).join(".")+"#"+(n.getAttribute&&n.getAttribute("data-row-key")||""))}return out}',
  'var hits=[]',
  'for(var i=0;i<all.length;i++){var el=all[i];if(own(el)!=="\\u8be6\\u60c5")continue;var r=el.getBoundingClientRect();if(!(r.width>0&&r.height>0))continue;hits.push(el);if(hits.length>=3)break}',
  'var out=[]',
  'for(var k=0;k<hits.length;k++){var h=hits[k];var r2=h.getBoundingClientRect();var cx=Math.round(r2.left+r2.width/2),cy=Math.round(r2.top+r2.height/2);var bl=deepAt(cx,cy);out.push({hit:{tag:h.tagName,cls:String(h.className||"").slice(0,40),chain:chain(h)},blocker:bl?{tag:bl.tagName,cls:String(bl.className||"").slice(0,50),own:own(bl).slice(0,20),chain:chain(bl),isInteractive:["A","BUTTON","LABEL"].indexOf(bl.tagName)>=0||bl.getAttribute("role")==="button"}:null})}',
  'return JSON.stringify(out,null,1)'
].join('\n')

async function pickLive(urlPart) {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  for (const t of list.filter(x => x.type === 'page' && x.url.includes(urlPart))) {
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
    let s = 0
    const pend = new Map()
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
    const send = (method, params = {}) => new Promise((ok, err) => {
      const id = ++s
      pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
      ws.send(JSON.stringify({ id, method, params }))
    })
    const r = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
    if (r.result?.value > 0) {
      return { ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value, close: () => ws.close() }
    }
    ws.close()
  }
  return null
}
async function main() {
  const sq = await pickLive('findersquare/find')
  if (!sq) { console.log('没有活跃广场页'); process.exit(0) }
  console.log(await sq.ev(`${ENUM_DECL}\n;(function(){\n${PROBE}\n})()`))
  sq.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
