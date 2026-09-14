/** 发送后的平台侧证据：成功提示文案 / 表单是否被清空 / 额度是否扣减 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const ENUM_DECL = 'function ENUM_ALL(){var o=[];var w=function(r){var els=r.querySelectorAll("*");for(var i=0;i<els.length;i++){var e=els[i];o.push(e);if(e.shadowRoot)w(e.shadowRoot)}};w(document);return o}'
const PROBE = [
  'var all=ENUM_ALL()',
  'var own=function(e){var s="";for(var i=0;i<e.childNodes.length;i++){var n=e.childNodes[i];if(n.nodeType===3)s+=n.textContent}return s.trim()}',
  'var text=function(e){return String(e.innerText||"").replace(/\\s+/g," ").trim()}',
  'var hits=[]',
  'for(var i=0;i<all.length;i++){var el=all[i];var t=text(el);if(!t||t.length>50)continue;if(/\\u5df2\\u53d1\\u9001|\\u53d1\\u9001\\u6210\\u529f|\\u9080\\u8bf7\\u6210\\u529f|\\u5df2\\u9080\\u8bf7|\\u64cd\\u4f5c\\u6210\\u529f|\\u5df2\\u63d0\\u4ea4/.test(t)){var r=el.getBoundingClientRect();hits.push({t:t,rect:[Math.round(r.left),Math.round(r.top)]})}}',
  'var inputs=[]',
  'for(var j=0;j<all.length;j++){var e2=all[j];if(e2.tagName!=="INPUT"&&e2.tagName!=="TEXTAREA")continue;var r2=e2.getBoundingClientRect();if(r2.width<1)continue;inputs.push({ph:e2.getAttribute("placeholder"),val:String(e2.value||"").slice(0,20)})}',
  'var quota=[]',
  'for(var k=0;k<all.length;k++){var e3=all[k];var o3=own(e3);if(o3.indexOf("\\u4eca\\u65e5\\u5269\\u4f59")>=0&&o3.length<40)quota.push(o3)}',
  'return JSON.stringify({url:location.href.slice(0,80),successHits:[...new Set(hits.map(function(h){return h.t}))].slice(0,6),inputs:inputs.slice(0,5),quota:[...new Set(quota)]},null,1)'
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
          if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 200))
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
  const p = await pickLive('initiate-invite')
  if (!p) { console.log('表单页已关闭（可能已跳转）'); process.exit(0) }
  console.log(await p.ev(`${ENUM_DECL}\n;(function(){\n${PROBE}\n})()`))
  p.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
