/** 真实广场：找出 own 文本为「母婴」「美妆护肤」「带货类目」的所有元素及其结构与坐标 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const ENUM_DECL = 'function ENUM_ALL(){var o=[];var w=function(r){var els=r.querySelectorAll("*");for(var i=0;i<els.length;i++){var e=els[i];o.push(e);if(e.shadowRoot)w(e.shadowRoot)}};w(document);return o}'
const PROBE = [
  'var all=ENUM_ALL()',
  'var own=function(e){var s="";for(var i=0;i<e.childNodes.length;i++){var n=e.childNodes[i];if(n.nodeType===3)s+=n.textContent}return s.trim()}',
  'var out=[]',
  'var want={"\\u6bcd\\u5a74":1,"\\u7f8e\\u5986\\u62a4\\u80a4":1,"\\u5e26\\u8d27\\u7c7b\\u76ee":1}',
  'for(var i=0;i<all.length;i++){var el=all[i];var t=own(el);if(!want[t])continue;var r=el.getBoundingClientRect();var cs=getComputedStyle(el);out.push({t:t,tag:el.tagName,cls:String(el.className||"").slice(0,46),rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)],vis:r.width>0&&r.height>0&&cs.display!=="none"&&cs.visibility!=="hidden",parentTag:el.parentElement?el.parentElement.tagName:null,parentCls:el.parentElement?String(el.parentElement.className||"").slice(0,40):null})}',
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

async function main() {
  const sq = await pickLive('findersquare/find')
  if (!sq) throw new Error('no live square')
  console.log(await sq.ev(`${ENUM_DECL}\n;(function(){\n${PROBE}\n})()`))
  sq.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
