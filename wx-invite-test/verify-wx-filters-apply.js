/** 真机验证：点「打开达人广场」→ 检查微信广场是否应用了 类型/类目/其他筛选 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'

const ENUM_DECL = 'function ENUM_ALL(){var o=[];var w=function(r){var els=r.querySelectorAll("*");for(var i=0;i<els.length;i++){var e=els[i];o.push(e);if(e.shadowRoot)w(e.shadowRoot)}};w(document);return o}'

const PROBE = [
  'var all=ENUM_ALL()',
  'var own=function(e){var out="";for(var i=0;i<e.childNodes.length;i++){var n=e.childNodes[i];if(n.nodeType===3)out+=n.textContent}return out.trim()}',
  'var text=function(e){return String(e.innerText||"").replace(/\\s+/g," ").trim()}',
  'var tabs=[]',
  'for(var i=0;i<all.length;i++){var el=all[i];var o=own(el);if(!/^(\\u5168\\u90e8\\u5e26\\u8d27\\u8005|\\u76f4\\u64ad\\u5e26\\u8d27\\u8005|\\u77ed\\u89c6\\u9891\\u5e26\\u8d27\\u8005|\\u516c\\u4f17\\u53f7\\u5e26\\u8d27\\u8005)$/.test(o))continue;var r=el.getBoundingClientRect();if(!(r.width>0))continue;tabs.push({t:o,cls:String(el.className).slice(0,60),color:getComputedStyle(el).color,bg:getComputedStyle(el).backgroundColor})}',
  'var tags=[]',
  'for(var j=0;j<all.length;j++){var e2=all[j];var o2=own(e2);if(o2==="\\u5df2\\u7b5b\\u9009"||/\\u7b5b\\u9009/.test(o2)&&o2.length<12){tags.push(text(e2.parentElement).slice(0,160))}}',
  'return JSON.stringify({url:location.href.slice(0,60),tabs:tabs,tags:tags.slice(0,4)})'
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
    } catch { /* try next */ }
    ws.close()
  }
  return null
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const app = await pickLive('index.html')
  if (!app) throw new Error('no app page')
  console.log('click 打开达人广场:', await app.ev('(function(){var b=document.querySelector("[data-test=invite-open-page]");if(!b)return "no-btn";b.click();return "clicked"})()'))
  app.close()
  await sleep(10000)

  const sq = await pickLive('findersquare/find')
  if (!sq) { console.log('no live square'); process.exit(1) }
  const out = await sq.ev(`${ENUM_DECL}\n;(function(){\n${PROBE}\n})()`)
  console.log(out)
  sq.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
