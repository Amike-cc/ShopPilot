/** 查「确认发送邀约」弹窗节点是否存在（含不可见）、点击后是否显示；并观察 URL 变化 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const ENUM_DECL = 'function ENUM_ALL(){var o=[];var w=function(r){var els=r.querySelectorAll("*");for(var i=0;i<els.length;i++){var e=els[i];o.push(e);if(e.shadowRoot)w(e.shadowRoot)}};w(document);return o}'

const SCAN = [
  'var all=ENUM_ALL()',
  'var own=function(e){var s="";for(var i=0;i<e.childNodes.length;i++){var n=e.childNodes[i];if(n.nodeType===3)s+=n.textContent}return s.trim()}',
  'var text=function(e){return String(e.innerText||"").replace(/\\s+/g," ").trim()}',
  'var hits=[]',
  'for(var i=0;i<all.length;i++){var el=all[i];var t=text(el);if(t.indexOf("\\u786e\\u8ba4\\u53d1\\u9001\\u9080\\u7ea6")<0)continue;var r=el.getBoundingClientRect();var cs=getComputedStyle(el);hits.push({tag:el.tagName,cls:String(el.className||"").slice(0,50),rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)],display:cs.display,vis:cs.visibility,opacity:cs.opacity,len:t.length})}',
  'var dlg=[]',
  'for(var j=0;j<all.length;j++){var e2=all[j];var c=String(e2.className||"");if(c.indexOf("dialog")<0&&c.indexOf("modal")<0&&c.indexOf("popup")<0)continue;var r2=e2.getBoundingClientRect();dlg.push({cls:c.slice(0,46),rect:[Math.round(r2.left),Math.round(r2.top),Math.round(r2.width),Math.round(r2.height)],display:getComputedStyle(e2).display})}',
  'return JSON.stringify({url:location.href.slice(0,80),confirmHits:hits.slice(0,4),dialogNodes:dlg.slice(0,8)},null,1)'
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

async function main() {
  const p = await pickLive('initiate-invite')
  if (!p) { console.log('没有表单页'); process.exit(0) }
  console.log('== 点击前 ==')
  console.log(await p.ev(`${ENUM_DECL}\n;(function(){\n${SCAN}\n})()`))
  await p.ev(`(function(){var all=ENUM_ALL();for(var i=0;i<all.length;i++){var el=all[i];var s='';for(var k=0;k<el.childNodes.length;k++){var n=el.childNodes[k];if(n.nodeType===3)s+=n.textContent}if(s.trim()==='\\u53d1\\u9001\\u9080\\u7ea6'&&el.getBoundingClientRect().width>0){el.click();return 'clicked'}}return 'not-found'})()`)
  await sleep(3000)
  console.log('== 点击后 ==')
  console.log(await p.ev(`${ENUM_DECL}\n;(function(){\n${SCAN}\n})()`))
  p.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
