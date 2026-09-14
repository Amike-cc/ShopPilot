/**
 * 在平台后台里真实点开一级菜单，把二级项全列出来（找发票入口）。
 * 只做只读浏览（点击导航菜单），不做任何资金/发票操作。
 * 用法：node probe-menu-tree.mjs <店铺名关键字>
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const kw = process.argv[2] || ''

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 260) : r.result?.value
}
const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const st = stores.find(x => x.name.includes(kw) || x.platform.includes(kw))
if (!st) { console.log('没找到店铺:', kw); process.exit(1) }
console.log(`店铺 ${st.name}（${st.platform}）`)

// 先打开该店铺并把它带到前台，再按 hostname 精确挑页面（否则会连到别的店铺的标签页）
await ev(`(async()=>{await window.shopilot.browser.open('${st.id}');await window.shopilot.browser.display('${st.id}');return 1})()`)
await sleep(5000)
const tabs = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${st.id}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,u:String(t.url||'')})))})()`))
console.log('该店铺标签页:', JSON.stringify(tabs.map(t => t.u.slice(0, 60))))
const host = tabs.map(t => { try { return new URL(t.u).hostname } catch { return '' } }).find(h => h && h !== 'about:blank')
const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.startsWith('http') && !x.url.includes('127.0.0.1') && !x.url.includes('out/renderer'))
const target = pages.find(x => host && x.url.includes(host)) || pages[0]
if (!target) { console.log('没有平台页面（先打开该店铺后台）'); process.exit(1) }
console.log('页面:', String(target.url).slice(0, 80))
const w2 = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((ok, err) => { w2.onopen = ok; w2.onerror = err })
let s2 = 0; const p2 = new Map()
w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id) } }
const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; p2.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); w2.send(JSON.stringify({ id, method: m2, params: pp })) })
const q2 = async (expr) => (await snd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value

/** 通用：找文案为 text 的可见元素坐标（穿 ShadowRoot） */
const FIND = (text, exact) => `(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  for (const el of all) {
    const t = own(el)
    if (${exact} ? t !== ${JSON.stringify(text)} : !t.includes(${JSON.stringify(text)})) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName, cls: String(el.className || '').slice(0, 40) })
  }
  return 'null'
})()`

async function clickText(text, exact = true) {
  const p = JSON.parse(await q2(FIND(text, exact)))
  if (!p) return false
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await snd('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
    await sleep(70)
  }
  return true
}

const candidates = ['资金', '结算', '财务', '账户中心']
for (const c of candidates) {
  const ok = await clickText(c, true)
  if (!ok) continue
  await sleep(2500)
  const subs = await q2(`(() => {
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const out = []
    for (const el of all) {
      const t = own(el)
      if (!t || t.length > 16) continue
      const r = el.getBoundingClientRect()
      if (!(r.width > 0 && r.height > 0)) continue
      if (r.left > 240) continue
      out.push({ t, href: (() => { const a = el.closest('a'); return a ? String(a.getAttribute('href') || '') : null })() })
    }
    const seen = new Set(); const uniq = []
    for (const o of out) { if (seen.has(o.t)) continue; seen.add(o.t); uniq.push(o) }
    return JSON.stringify(uniq.slice(0, 40))
  })()`)
  console.log(`\n点击「${c}」后的左侧菜单项:`)
  console.log(subs)
  const hasInvoice = await q2(`(() => { const t = String(document.body ? document.body.innerText : ''); return JSON.stringify({ 含发票: /发票/.test(t), 片段: (t.replace(/\\s+/g,' ').match(/发票[^ ]{0,30}/) || [null])[0] }) })()`)
  console.log('页面是否出现「发票」:', hasInvoice)
  const found = JSON.parse(subs || '[]').find(o => /发票/.test(o.t))
  if (found) {
    console.log('→ 找到发票入口:', JSON.stringify(found))
    break
  }
}
w2.close()
ws.close()
setTimeout(() => process.exit(0), 300)
