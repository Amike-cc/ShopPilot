/** 把店铺浏览器视口调宽后，再点「发送邀约」看确认弹窗是否正常出现 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'
const ENUM_DECL = 'function ENUM_ALL(){var o=[];var w=function(r){var els=r.querySelectorAll("*");for(var i=0;i<els.length;i++){var e=els[i];o.push(e);if(e.shadowRoot)w(e.shadowRoot)}};w(document);return o}'

const SCAN = [
  'var all=ENUM_ALL()',
  'var text=function(e){return String(e.innerText||"").replace(/\\s+/g," ").trim()}',
  'var wrp=null',
  'for(var i=0;i<all.length;i++){var el=all[i];var t=text(el);if(t.indexOf("\\u786e\\u8ba4\\u53d1\\u9001\\u9080\\u7ea6")>=0&&String(el.className||"").indexOf("dialog")>=0){var r=el.getBoundingClientRect();if(r.width>100){wrp={cls:String(el.className||"").slice(0,50),rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)],t:t.slice(0,60)}}}}',
  'var btn=null',
  'for(var j=0;j<all.length;j++){var e2=all[j];if(text(e2).trim()==="\\u53d1\\u9001\\u9080\\u7ea6")continue;var s="";for(var k=0;k<e2.childNodes.length;k++){var n=e2.childNodes[k];if(n.nodeType===3)s+=n.textContent}if(s.trim()==="\\u53d1\\u9001\\u9080\\u7ea6"&&e2.getBoundingClientRect().width>0){btn={tag:e2.tagName,rect:(function(){var r=e2.getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]})()};break}}',
  'return JSON.stringify({w:window.innerWidth,dialog:wrp,sendBtn:btn})'
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
  const app = await pickLive('index.html')
  // 视口调宽（尽量大，但不超过窗口）
  console.log('setViewport:', await app.ev(`(async()=>{const r=await window.shopilot.browser.setViewport({x:0,y:0,width:1380,height:840});return JSON.stringify(r.ok)})()`))
  app.close()
  await sleep(3000)
  const p = await pickLive('initiate-invite')
  if (!p) { console.log('没有表单页'); process.exit(0) }
  console.log('调宽后:', await p.ev(`${ENUM_DECL}\n;(function(){\n${SCAN}\n})()`))
  // 真实点击 发送邀约
  await p.ev(`(function(){var all=ENUM_ALL();for(var i=0;i<all.length;i++){var el=all[i];var s='';for(var k=0;k<el.childNodes.length;k++){var n=el.childNodes[k];if(n.nodeType===3)s+=n.textContent}if(s.trim()==='\\u53d1\\u9001\\u9080\\u7ea6'&&el.getBoundingClientRect().width>0){el.click();return 'clicked'}}return 'not-found'})()`)
  await sleep(3000)
  console.log('点击后:', await p.ev(`${ENUM_DECL}\n;(function(){\n${SCAN}\n})()`))
  p.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
