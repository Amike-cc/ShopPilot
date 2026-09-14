/** 邀约表单页现状：字段值 / 商品行 / 发送邀约按钮状态 / 页面上的提示文案 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const ENUM_DECL = 'function ENUM_ALL(){var o=[];var w=function(r){var els=r.querySelectorAll("*");for(var i=0;i<els.length;i++){var e=els[i];o.push(e);if(e.shadowRoot)w(e.shadowRoot)}};w(document);return o}'
const PROBE = [
  'var all=ENUM_ALL()',
  'var own=function(e){var s="";for(var i=0;i<e.childNodes.length;i++){var n=e.childNodes[i];if(n.nodeType===3)s+=n.textContent}return s.trim()}',
  'var text=function(e){return String(e.innerText||"").replace(/\\s+/g," ").trim()}',
  'var inputs=[]',
  'for(var i=0;i<all.length;i++){var el=all[i];if(el.tagName!=="INPUT"&&el.tagName!=="TEXTAREA")continue;var r=el.getBoundingClientRect();if(!(r.width>0))continue;inputs.push({tag:el.tagName,ph:el.getAttribute("placeholder"),val:String(el.value||"").slice(0,30),rect:[Math.round(r.left),Math.round(r.top)]})}',
  'var rows=[]',
  'for(var j=0;j<all.length;j++){var e2=all[j];if(e2.tagName==="TR"){var r2=e2.getBoundingClientRect();if(r2.width>0&&r2.height>0&&rows.length<8)rows.push(text(e2).slice(0,60))}}',
  'var btn=[]',
  'for(var k=0;k<all.length;k++){var e3=all[k];var o3=own(e3);if(o3!=="\\u53d1\\u9001\\u9080\\u7ea6"&&o3!=="\\u786e\\u8ba4")continue;var r3=e3.getBoundingClientRect();if(!(r3.width>0))continue;btn.push({t:o3,tag:e3.tagName,cls:String(e3.className||"").slice(0,44),rect:[Math.round(r3.left),Math.round(r3.top),Math.round(r3.width),Math.round(r3.height)],disabled:e3.disabled===true})}',
  'var alerts=[]',
  'for(var m=0;m<all.length;m++){var e4=all[m];var o4=own(e4);if(/\\u8bf7\\u586b\\u5199|\\u5fc5\\u586b|\\u9519\\u8bef|\\u5931\\u8d25|\\u4e0d\\u80fd\\u4e3a\\u7a7a|\\u9080\\u8bf7/.test(o4)&&o4.length<60){var r4=e4.getBoundingClientRect();if(r4.width>0&&r4.height>0)alerts.push(o4)}}',
  'return JSON.stringify({url:location.href.slice(0,80),inputs:inputs,rows:rows,buttons:btn,alerts:[...new Set(alerts)].slice(0,8)},null,1)'
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
  const p = await pickLive('initiate-invite')
  if (!p) { console.log('没有打开的邀约表单页'); process.exit(0) }
  console.log(await p.ev(`${ENUM_DECL}\n;(function(){\n${PROBE}\n})()`))
  p.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
