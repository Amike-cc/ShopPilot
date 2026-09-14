/** 逐个微信页面看状态：url/readyState/是否渲染出筛选区/目标勾选态 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const PROBE = [
  '(function(){',
  'function ENUM_ALL(){var o=[];var w=function(r){var els=r.querySelectorAll("*");for(var i=0;i<els.length;i++){var e=els[i];o.push(e);if(e.shadowRoot)w(e.shadowRoot)}};w(document);return o}',
  'var all=ENUM_ALL()',
  'var own=function(e){var out="";for(var i=0;i<e.childNodes.length;i++){var n=e.childNodes[i];if(n.nodeType===3)out+=n.textContent}return out.trim()}',
  'var hasType=false,hasMuying=false,checkedMuying=null,hasContact=false,checkedContact=null',
  'for(var i=0;i<all.length;i++){var el=all[i];var t=own(el);if(t==="\\u5168\\u90e8\\u5e26\\u8d27\\u8005")hasType=true;if(t==="\\u6bcd\\u5a74"){hasMuying=true;var lab=el.closest("label");var inp=lab?lab.querySelector("input"):null;if(inp)checkedMuying=!!inp.checked}if(t==="\\u6709\\u8054\\u7cfb\\u65b9\\u5f0f"){hasContact=true;var lab2=el.closest("label");var inp2=lab2?lab2.querySelector("input"):null;if(inp2)checkedContact=!!inp2.checked}}',
  'var txt=String(document.body?document.body.innerText:"").replace(/\\s+/g," ").slice(0,120)',
  'return JSON.stringify({url:location.href.slice(0,70),ready:document.readyState,elements:all.length,hasTypeTab:hasType,hasMuying:hasMuying,checkedMuying:checkedMuying,hasContactOption:hasContact,checkedContact:checkedContact,body:txt})',
  '})()'
].join('\n')

async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  for (const t of list.filter(x => x.type === 'page' && x.url.includes('store.weixin.qq.com'))) {
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
      const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true, awaitPromise: true, userGesture: true })
      console.log(r.result?.value || JSON.stringify(r.exceptionDetails).slice(0, 150))
    } catch (e) {
      console.log('ERR', e.message.slice(0, 120))
    }
    ws.close()
  }
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
