/**
 * 深入核对「我的邀约」：ShadowRoot 全文、状态页签、分页、总数、每行日期（判断今天有没有新增）
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'

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
    await sleep(1200)
  }
}

const o = await app()
const raw = await o.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify({active:r.data&&r.data.activeTabId,first:((r.data&&r.data.tabs)||[]).map(t=>t.id)})})()`)
const p = JSON.parse(raw)
let tabId = p.active || (p.first && p.first[0])
if (!tabId) {
  const created = JSON.parse(await o.ev(`(async()=>{const r=await window.shopilot.browser.tab.create('${STORE}','about:blank');return JSON.stringify({ok:r.ok,id:r.data&&(r.data.tabId||r.data.id)})})()`))
  console.log('新建标签页:', JSON.stringify(created))
  tabId = created.id
}
console.log('用标签页:', tabId)
await o.ev(`(async()=>{await window.shopilot.browser.navigate('${STORE}','${tabId}','https://store.weixin.qq.com/shop/findersquare/my-invite');return 1})()`)
await sleep(13000)
const mi = await page('my-invite')
if (!mi) { console.log('我的邀约页没出来'); process.exit(1) }
console.log(await mi.ev(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  // ShadowRoot 内的纯文本（body.innerText 读不到微应用内容）
  const deepText = all.map(el => own(el)).filter(Boolean).join(' ')
  const rows = all.filter(e => e.tagName === 'TR').map(e => String(e.innerText || '').replace(/\\s+/g, ' ').trim())
  const dates = (deepText.match(/2026[/-]\\d{1,2}[/-]\\d{1,2}[^ ]{0,6}/g) || [])
  const today = dates.filter(d => /2026[/-]0?9[/-]1[3-5]/.test(d))
  const tabs = all.filter(e => ['全部', '待确认', '已接受', '已拒绝', '已过期'].includes(own(e)) && e.getBoundingClientRect().width > 0)
    .map(e => ({ t: own(e), cls: String(e.className || '').slice(0, 50), parentCls: String((e.parentElement && e.parentElement.className) || '').slice(0, 50) }))
  const quota = /今日剩余\\s*(\\d+)\\s*次邀请机会/.exec(deepText)
  const pager = all.filter(e => ['下一页', '上一页'].includes(own(e))).map(e => own(e))
  const cntTexts = [...new Set((deepText.match(/共\\s*\\d+\\s*[条个位]/g) || []))]
  const totalHint = [...new Set(all.map(e => own(e)).filter(t => /^(全部|待确认|已接受|已拒绝)/.test(t) && /\\d/.test(t)))].slice(0, 8)
  return JSON.stringify({
    url: location.href.slice(0, 80),
    行数: rows.length,
    前2行: rows.slice(0, 2),
    全部日期: dates.slice(0, 20),
    今天的: today,
    含今日剩余: quota ? Number(quota[1]) : null,
    状态页签: tabs,
    翻页: pager,
    计数: cntTexts,
    带数字的页签: totalHint,
    textLen: deepText.length
  }, null, 1)
})()`))
mi.close()
await o.ev(`(async()=>{await window.shopilot.browser.tab.close('${STORE}','${tabId}');return 1})()`).catch(() => {})
process.exit(0)
