/**
 * 只读：用量真实历史邀约页 URL 打开表单，读「今日剩余N次邀请机会」；
 * 并读「我的邀约」页看今天已邀约多少（判断每日上限）。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'

async function app() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  const t = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
  return { ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function page(urlPart, budgetMs = 50000) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
    for (const t of list.filter(x => x.type === 'page' && x.url.includes(urlPart))) {
      const ws = new WebSocket(t.webSocketDebuggerUrl)
      await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
      let s = 0
      const pend = new Map()
      ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
      const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
      const r = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
      if (r.result?.value > 0) return { url: t.url, ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value, close: () => ws.close() }
      ws.close()
    }
    if (Date.now() > deadline) return null
    await sleep(1000)
  }
}

const READ = `(() => {
  const all = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const txt = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ')
  const quota = /今日剩余\\s*(\\d+)\\s*次邀请机会/.exec(txt)
  const rows = all.filter(el => el.tagName === 'TR').length
  return JSON.stringify({
    url: location.href.replace(/finderUsername=[^&]+/, 'finderUsername=…').slice(0, 110),
    textLen: txt.length,
    额度: quota ? Number(quota[1]) : null,
    额度原文: (quota || [])[0] || null,
    含剩余: /剩余/.test(txt),
    tr数: rows,
    片段: txt.replace(/[\\s\\S]{0,0}/, '').slice(0, 260)
  }, null, 1)
})()`

const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const prev = list.find(x => x.type === 'page' && x.url.includes('initiate-invite'))
const full = prev ? prev.url : null
console.log('历史完整 URL:', full ? full.slice(0, 200) : '(无)')
if (!full) process.exit(0)

const o = await app()
const raw = await o.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify({active:r.data&&r.data.activeTabId,first:((r.data&&r.data.tabs)||[]).map(t=>t.id)})})()`)
const p = JSON.parse(raw)
const tabId = p.active || (p.first && p.first[0])
// 开一个独立探测标签页（避免打扰正在用的页面）
const probeTab = JSON.parse(await o.ev(`(async()=>{const r=await window.shopilot.browser.tab.create('${STORE}','about:blank');return JSON.stringify({ok:r.ok,id:r.data&&r.data.id})})()`))
const useTab = (probeTab && probeTab.id) || tabId
console.log('探测标签页:', useTab)
await o.ev(`(async()=>{await window.shopilot.browser.navigate('${STORE}','${useTab}','${full}');return 1})()`)
await sleep(10000)
let pg = await page('initiate-invite')
if (pg) { console.log('邀约表单页:', await pg.ev(READ)); pg.close() }

// 我的邀约
await o.ev(`(async()=>{await window.shopilot.browser.navigate('${STORE}','${useTab}','https://store.weixin.qq.com/shop/findersquare/my-invite');return 1})()`)
await sleep(9000)
pg = await page('my-invite')
if (pg) {
  console.log('我的邀约页:', await pg.ev(`(() => {
    const txt = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ')
    const m = txt.match(/共\\s*(\\d+)\\s*条|已邀约\\s*(\\d+)|总数\\s*(\\d+)/)
    return JSON.stringify({ url: location.href.slice(0, 90), 计数: m ? m[0] : null, 片段: txt.slice(0, 300) })
  })()`))
  pg.close()
}
await o.ev(`(async()=>{await window.shopilot.browser.tab.close('${STORE}','${useTab}');return 1})()`).catch(() => {})
process.exit(0)
