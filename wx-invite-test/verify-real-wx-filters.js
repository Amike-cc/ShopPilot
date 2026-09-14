/** 真实微信广场验证：应用筛选（类型/类目/其他）→ 读回勾选态与「已筛选」标签 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'
const URL_FIND = 'https://store.weixin.qq.com/shop/findersquare/find'

const ENUM_DECL = 'function ENUM_ALL(){var o=[];var w=function(r){var els=r.querySelectorAll("*");for(var i=0;i<els.length;i++){var e=els[i];o.push(e);if(e.shadowRoot)w(e.shadowRoot)}};w(document);return o}'
const READ = [
  'var all=ENUM_ALL()',
  'var own=function(e){var out="";for(var i=0;i<e.childNodes.length;i++){var n=e.childNodes[i];if(n.nodeType===3)out+=n.textContent}return out.trim()}',
  'var text=function(e){return String(e.innerText||"").replace(/\\s+/g," ").trim()}',
  'var cat={},oth={}',
  'for(var i=0;i<all.length;i++){var el=all[i];if(el.tagName!=="INPUT"||el.type!=="checkbox")continue;var lab=el.closest("label");if(!lab)continue;var t=text(lab);if(t==="\\u6bcd\\u5a74")cat.muying=!!el.checked;if(t==="\\u7f8e\\u5986\\u62a4\\u80a4")cat.meizhuang=!!el.checked;if(t==="\\u6709\\u8054\\u7cfb\\u65b9\\u5f0f")oth.contact=!!el.checked}',
  'var tags=[]',
  'for(var j=0;j<all.length;j++){var e2=all[j];var o2=own(e2);if(o2.indexOf("\\u5df2\\u7b5b\\u9009")>=0&&o2.length<40){var pt=e2.parentElement?text(e2.parentElement):"";if(pt)tags.push(pt.slice(0,200))}}',
  'var cards=[].map.call(document.querySelectorAll("*"),function(e){return String(e.className||"")}).filter(function(c){return c.indexOf("finder")>=0}).slice(0,3)',
  'return JSON.stringify({cat:cat,others:oth,tags:tags.slice(0,3),sample:cards},null,1)'
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
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const app = await pickLive('index.html')
  if (!app) throw new Error('no app page')
  // 先确保店铺窗口/标签页存在（prepareInviteSquare 作用于当前标签页）
  await app.ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
  await sleep(3500)
  const tabsRaw = await app.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(r.data.tabs||[])})()`)
  const tabs = JSON.parse(tabsRaw)
  console.log('tabs:', tabs.length)
  if (!tabs.length) {
    const created = await app.ev(`(async()=>{const r=await window.shopilot.browser.tab.create('${STORE}','${URL_FIND}');return JSON.stringify(r)})()`)
    console.log('create tab:', created.slice(0, 120))
    await sleep(4000)
  }
  const res = await app.ev(`(async () => {
    const r = await window.shopilot.browser.prepareInviteSquare('${STORE}', {
      url: ${JSON.stringify(URL_FIND)},
      finderType: '直播带货者',
      categories: ['母婴', '美妆护肤'],
      otherFilters: ['有联系方式']
    })
    return JSON.stringify(r)
  })()`)
  console.log('IPC:', res)
  app.close()
  await sleep(2500)

  const sq = await pickLive('findersquare/find')
  if (!sq) { console.log('no live square'); process.exit(1) }
  console.log(await sq.ev(`${ENUM_DECL}\n;(function(){\n${READ}\n})()`))
  sq.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
