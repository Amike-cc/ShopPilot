/** 核对微信广场筛选是否真的生效：目标 checkbox 的 checked 状态 + 已筛选标签 + 列表首屏内容 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const ENUM_DECL = 'function ENUM_ALL(){var o=[];var w=function(r){var els=r.querySelectorAll("*");for(var i=0;i<els.length;i++){var e=els[i];o.push(e);if(e.shadowRoot)w(e.shadowRoot)}};w(document);return o}'

const PROBE = [
  'var all=ENUM_ALL()',
  'var own=function(e){var out="";for(var i=0;i<e.childNodes.length;i++){var n=e.childNodes[i];if(n.nodeType===3)out+=n.textContent}return out.trim()}',
  'var text=function(e){return String(e.innerText||"").replace(/\\s+/g," ").trim()}',
  'var picks=[]',
  'for(var i=0;i<all.length;i++){var el=all[i];if(el.tagName!=="INPUT"||el.type!=="checkbox")continue;var lab=el.closest("label");var t=lab?text(lab).slice(0,30):"";if(!/\\u6bcd\\u5a74|\\u6709\\u8054\\u7cfb\\u65b9\\u5f0f|\\u76f4\\u64ad/.test(t))continue;picks.push({t:t,checked:!!el.checked})}',
  'var tags=[]',
  'for(var j=0;j<all.length;j++){var e2=all[j];var o2=own(e2);if(/\\u5df2\\u7b5b\\u9009|\\u5df2\\u9009\\u6761\\u4ef6/.test(o2)){var pt=e2.parentElement?text(e2.parentElement):"";if(pt)tags.push(pt.slice(0,180))}}',
  'var cards=all.filter(function(e){return e.className&&String(e.className).indexOf("finder")>=0}).slice(0,3).map(function(e){return text(e).slice(0,40)})',
  'return JSON.stringify({picks:picks,tags:tags.slice(0,3),sample:cards},null,1)'
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
    try {
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
    } catch { /* next */ }
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
