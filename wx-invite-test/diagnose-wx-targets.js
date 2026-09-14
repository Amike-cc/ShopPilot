/** 定点诊断：美妆护肤 chip 与 直播带货者 页签——坐标处元素、label/input、点击前后变化 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const ENUM_DECL = 'function ENUM_ALL(){var o=[];var w=function(r){var els=r.querySelectorAll("*");for(var i=0;i<els.length;i++){var e=els[i];o.push(e);if(e.shadowRoot)w(e.shadowRoot)}};w(document);return o}'

const INFO = (needle) => [
  'var all=ENUM_ALL()',
  'var own=function(e){var s="";for(var i=0;i<e.childNodes.length;i++){var n=e.childNodes[i];if(n.nodeType===3)s+=n.textContent}return s.trim()}',
  'var hits=[]',
  'for(var i=0;i<all.length;i++){var el=all[i];if(own(el)!==' + JSON.stringify(needle) + ')continue;var r=el.getBoundingClientRect();var cs=getComputedStyle(el);hits.push({tag:el.tagName,cls:String(el.className||"").slice(0,40),rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)],vis:r.width>0&&r.height>0&&cs.display!=="none"&&cs.visibility!=="hidden",pTag:el.parentElement?el.parentElement.tagName:null,pCls:el.parentElement?String(el.parentElement.className||"").slice(0,40):null,gpCls:el.parentElement&&el.parentElement.parentElement?String(el.parentElement.parentElement.className||"").slice(0,40):null})}',
  'var vis=hits.filter(function(h){return h.vis})',
  'var out={hits:hits.length,vis:vis.slice(0,4)}',
  'if(vis.length){var r0=vis[0].rect;var x=Math.round(r0[0]+r0[2]/2),y=Math.round(r0[1]+r0[3]/2);var deep=document.elementFromPoint(x,y);while(deep&&deep.shadowRoot){var inner=deep.shadowRoot.elementFromPoint(x,y);if(!inner||inner===deep)break;deep=inner}out.point=[x,y];out.deepAt={tag:deep?deep.tagName:null,cls:deep?String(deep.className||"").slice(0,40):null,own:deep?own(deep).slice(0,20):null};var lab=deep?deep.closest("label"):null;out.label=lab?{cls:String(lab.className||"").slice(0,50),text:String(lab.innerText||"").replace(/\\s+/g," ").trim().slice(0,20),hasInput:!!lab.querySelector("input"),inputChecked:lab.querySelector("input")?!!lab.querySelector("input").checked:null}:null}',
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
      return {
        send,
        ev: async (expr) => {
          const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
          if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 250))
          return res.result.value
        },
        close: () => ws.close()
      }
    }
    ws.close()
  }
  return null
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const sq = await pickLive('findersquare/find')
  if (!sq) throw new Error('no live square')
  for (const needle of ['美妆护肤', '直播带货者', '母婴']) {
    console.log('=== ' + needle + ' ===')
    console.log(await sq.ev(`${ENUM_DECL}\n;(function(){\n${INFO(needle)}\n})()`))
  }
  sq.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
