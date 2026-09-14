/**
 * 诊断：任务运行标签页"是否真的可见"对取人的影响
 * 分别测三种状态下的「详情」可见数：
 *   A) 店铺窗口未显示微信店铺（display(null) / 显示别的店铺）
 *   B) 店铺窗口显示微信店铺
 * 并打印若干「详情」元素的 rect（判断是否 0 尺寸）
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'

const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
const sleep = ms => new Promise(r => setTimeout(r, ms))

const TABS = `(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,url:String(t.url||'').slice(0,60)})))})()`

/** 直接连到广场页的渲染进程，统计可见的「详情」及其 rect */
async function squareStats(tag) {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
    .filter(x => x.type === 'page' && x.url.includes('findersquare/find') && !x.url.includes('finder-detail'))
  if (!pages.length) { console.log(`  [${tag}] 没有广场页`); return }
  for (const p of pages) {
    const w = new WebSocket(p.webSocketDebuggerUrl)
    await new Promise((ok, err) => { w.onopen = ok; w.onerror = err })
    let s2 = 0; const q = new Map()
    w.onmessage = e => { const m = JSON.parse(e.data); if (m.id && q.has(m.id)) { q.get(m.id)(m); q.delete(m.id) } }
    const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; q.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w.send(JSON.stringify({ id, method: m2, params: pp })) })
    const r = await snd('Runtime.evaluate', {
      expression: `(() => {
        const out = []
        const walk = (root) => { for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
        walk(document)
        const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
        const ds = out.filter(el => own(el) === '详情')
        const vis = ds.filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
        return JSON.stringify({
          innerW: window.innerWidth, innerH: window.innerHeight,
          details: ds.length, visible: vis.length,
          rects: ds.slice(0, 3).map(el => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })
        })
      })()`, returnByValue: true
    })
    console.log(`  [${tag}] url=${String(p.url).slice(0, 50)} → ${r.result?.value}`)
    w.close()
  }
}

console.log('=== A) 不显示任何店铺（display(null)）===')
await ev(`(async()=>{const r=await window.shopilot.browser.display(null);return JSON.stringify(r.ok)})()`)
await sleep(1500)
console.log('  标签页: ' + await ev(TABS))
await squareStats('A 未显示')

console.log('\n=== B) 显示微信店铺 ===')
await ev(`(async()=>{const r=await window.shopilot.browser.display('${STORE}');return JSON.stringify(r.ok)})()`)
await sleep(2500)
await squareStats('B 已显示')

console.log('\n=== C) 显示别的店铺（抖店），微信店铺退到后台 ===')
const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(s=>({id:s.id,name:s.name})))})()`))
const other = stores.find(x => x.id !== STORE)
if (other) {
  await ev(`(async()=>{await window.shopilot.browser.open('${other.id}');return 1})()`)
  await sleep(2500)
  await ev(`(async()=>{const r=await window.shopilot.browser.display('${other.id}');return JSON.stringify(r.ok)})()`)
  await sleep(2500)
  await squareStats('C 显示别的店铺')
}
setTimeout(() => process.exit(0), 300)
