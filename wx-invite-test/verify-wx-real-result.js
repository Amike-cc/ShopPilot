/**
 * 核对真实批量结果（只读）：
 *  ① 打开一个邀约表单页读「今日剩余N次邀请机会」（应从 199 降到 189）
 *  ② 打开「我的邀约」页看今天发出的邀约条数与达人
 * 用完把探测标签页关掉。
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
      if (r.result?.value > 0) return { url: t.url, ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value, close: () => ws.close(), ws }
      ws.close()
    }
    if (Date.now() > deadline) return null
    await sleep(1200)
  }
}
function tabInfo(list, part) { return list.find(x => x.type === 'page' && x.url.includes(part)) }

const o = await app()
const raw = await o.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify({active:r.data&&r.data.activeTabId,first:((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,url:String(t.url||'').slice(0,70)}))})})()`)
const p = JSON.parse(raw)
console.log('当前标签页:', JSON.stringify(p.first))
const tabId = p.active || (p.first && p.first[0].id)
console.log('用标签页:', tabId)

// ① 读额度：找一个历史邀约表单 URL 做模板
let list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const prevForm = list.find(x => x.type === 'page' && x.url.includes('initiate-invite'))
const finder = prevForm ? (/finderUsername=([A-Za-z0-9_]+)/.exec(prevForm.url) || [])[1] : null
if (finder) {
  await o.ev(`(async()=>{await window.shopilot.browser.navigate('${STORE}','${tabId}','https://store.weixin.qq.com/shop/findersquare/initiate-invite?finderUsername=${finder}');return 1})()`)
  await sleep(10000)
  const f = await page('initiate-invite')
  if (f) {
    console.log('① 额度：', await f.ev(`(() => {
      const all = []
      const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
      walk(document)
      const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
      const txt = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ')
      const m = /今日剩余\\s*(\\d+)\\s*次邀请机会/.exec(txt)
      const rows = all.filter(e => e.tagName === 'TR' && /ID\\s*\\d{6,}/.test(String(e.innerText || ''))).length
      const sendBtn = all.find(e => own(e) === '发送邀约')
      return JSON.stringify({ 今日剩余: m ? Number(m[1]) : null, 现有商品行: rows, 发送按钮禁用: sendBtn ? /disabled/i.test(String(sendBtn.className||'')) : null })
    })()`))
    f.close()
  }
} else { console.log('① 没有可用的 finderUsername 模板，跳过额度读取') }

// ② 我的邀约
await o.ev(`(async()=>{await window.shopilot.browser.navigate('${STORE}','${tabId}','https://store.weixin.qq.com/shop/findersquare/my-invite');return 1})()`)
await sleep(12000)
const mi = await page('my-invite', 40000)
if (mi) {
  console.log('② 我的邀约：', await mi.ev(`(() => {
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const txt = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ')
    const rows = all.filter(e => e.tagName === 'TR').length
    const cnt = (txt.match(/(共|总计|合计)\\s*(\\d+)\\s*条/) || [])[0] || null
    const pending = (txt.match(/待确认|已邀请|邀约中|已接受|已拒绝/g) || []).reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {})
    const names = all.filter(e => e.tagName === 'TR').map(e => String(e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40)).filter(Boolean).slice(0, 14)
    return JSON.stringify({ tr数: rows, 计数文案: cnt, 状态词频: pending, 前若干行: names, 片段: txt.slice(0, 200) }, null, 1)
  })()`))
  mi.close()
} else { console.log('② 我的邀约页没出来') }

// 收尾：关掉探测标签页
await o.ev(`(async()=>{await window.shopilot.browser.tab.close('${STORE}','${tabId}');return 1})()`).catch(() => {})
list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
console.log('剩余标签页:', list.filter(t => t.type === 'page' && t.url.includes('weixin.qq.com')).map(t => String(t.url).slice(0, 70)))
process.exit(0)
