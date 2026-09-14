/** 诊断表单页按钮：坐标处深层元素 / 按钮属性 / 合成 click 是否弹窗 / 按钮附近可见文案 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const ENUM_DECL = 'function ENUM_ALL(){var o=[];var w=function(r){var els=r.querySelectorAll("*");for(var i=0;i<els.length;i++){var e=els[i];o.push(e);if(e.shadowRoot)w(e.shadowRoot)}};w(document);return o}'

const PROBE = [
  'var all=ENUM_ALL()',
  'var own=function(e){var s="";for(var i=0;i<e.childNodes.length;i++){var n=e.childNodes[i];if(n.nodeType===3)s+=n.textContent}return s.trim()}',
  'var text=function(e){return String(e.innerText||"").replace(/\\s+/g," ").trim()}',
  'var deepAt=function(x,y){var el=document.elementFromPoint(x,y);while(el&&el.shadowRoot){var inner=el.shadowRoot.elementFromPoint(x,y);if(!inner||inner===el)break;el=inner}return el}',
  'var btn=null',
  'for(var i=0;i<all.length;i++){var el=all[i];if(own(el)!=="\\u53d1\\u9001\\u9080\\u7ea6")continue;var r=el.getBoundingClientRect();if(r.width>0){btn=el;break}}',
  'var out={}',
  'if(btn){var r=btn.getBoundingClientRect();out.btn={tag:btn.tagName,cls:String(btn.className||"").slice(0,60),rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)],disabled:btn.disabled===true,ariaDisabled:btn.getAttribute("aria-disabled"),parentCls:btn.parentElement?String(btn.parentElement.className||"").slice(0,44):null}',
  '  var x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);var hit=deepAt(x,y);out.atCenter={x:x,y:y,hit:hit?{tag:hit.tagName,cls:String(hit.className||"").slice(0,44),own:own(hit).slice(0,20)}:null,isBtnOrChild:!!(hit&&(hit===btn||btn.contains(hit)||hit.contains(btn)))}',
  '  btn.click();out.syntheticClicked=true',
  '}',
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
const sleep = ms => new Promise(r => setTimeout(r, ms))
const DIALOGS = `${ENUM_DECL}
  ;(function(){
    var all=ENUM_ALL()
    var own=function(e){var s="";for(var i=0;i<e.childNodes.length;i++){var n=e.childNodes[i];if(n.nodeType===3)s+=n.textContent}return s.trim()}
    var out=[]
    for(var i=0;i<all.length;i++){var el=all[i];var o=own(el);if(!o||o.length>60)continue;var r=el.getBoundingClientRect();if(r.width<1||r.height<1)continue
      if(/\\u786e\\u8ba4\\u53d1\\u9001|\\u786e\\u8ba4\\u63d0\\u4ea4|\\u53d6\\u6d88/.test(o)){out.push({t:o,cls:String(el.className||"").slice(0,40),rect:[Math.round(r.left),Math.round(r.top)]})}}
    return JSON.stringify(out.slice(0,6))
  })()`

async function main() {
  const p = await pickLive('initiate-invite')
  if (!p) { console.log('没有表单页'); process.exit(0) }
  console.log('诊断:', await p.ev(`${ENUM_DECL}\n;(function(){\n${PROBE}\n})()`))
  await sleep(2500)
  console.log('合成 click 后弹窗类元素:', await p.ev(DIALOGS))
  p.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
