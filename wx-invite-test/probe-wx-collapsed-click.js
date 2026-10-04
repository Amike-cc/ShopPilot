/**
 * 微信小店带货者广场：**折叠态**下用 JS click 点类目 chip 是否生效（决定流程要不要先点「展开」）
 * 用法：node wx-invite-test/probe-wx-collapsed-click.js
 */
import fs from 'node:fs'
import path from 'node:path'

const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'
const OUT_DIR = path.resolve('wx-invite-test/evidence')
const ENUM_ALL = `function ENUM_ALL(){const o=[];const w=r=>{for(const e of r.querySelectorAll('*')){o.push(e);if(e.shadowRoot)w(e.shadowRoot)};if(r.shadowRoot)w(r.shadowRoot)};w(document);return o}`

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let seq = 0
  const pending = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params = {}) => new Promise((ok, err) => {
    const id = ++seq
    pending.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时`)), ms))])
  const ev = async (expr, timeoutMs = 20000) => {
    const r = await withTimeout(send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }), timeoutMs, 'CDP 求值')
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400))
    return r.result.value
  }
  return { send, ev, close: () => ws.close() }
}

const deep = body => `(() => { ${ENUM_ALL}\n${body} })()`
const H = `
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const rowOf = t => { for (const el of ENUM_ALL()) { if (own(el) !== t) continue; return el.closest('.weui-desktop-form__control-group') } return null }
`

/** 模拟引擎 clickByText：找自有文本 === needle 的最短命中元素（含 innerText 兜底），调 .click() */
const engineClick = (needle, scopeExpr) => deep(`
  ${H}
  const needle = ${JSON.stringify(needle)}
  const narrow = s => String(s == null ? '' : s).replace(/\\s+/g, '')
  const roots = ${scopeExpr}
  const inScope = el => !roots || roots.some(r => r.contains(el))
  const pool = []
  if (roots) for (const r of roots) { pool.push(r); for (const c of r.querySelectorAll('*')) pool.push(c) }
  else for (const el of ENUM_ALL()) pool.push(el)
  let cands = pool.filter(el => inScope(el) && own(el).includes(needle) && vis(el))
  if (!cands.length) cands = pool.filter(el => inScope(el) && narrow(el.innerText) === narrow(needle) && vis(el))
  if (!cands.length) return JSON.stringify({ ok: false, reason: 'not-found' })
  cands.sort((a, b) => own(a).length - own(b).length)
  const target = cands[0]
  const before = (() => { const lab = target.closest('label'); const inp = lab ? lab.querySelector('input') : target.querySelector('input'); return inp ? inp.checked : null })()
  target.click()
  const after = (() => { const lab = target.closest('label'); const inp = lab ? lab.querySelector('input') : target.querySelector('input'); return inp ? inp.checked : null })()
  return JSON.stringify({ ok: true, tag: target.tagName, text: own(target).slice(0, 20), before, after })
`)

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const renderer = targets.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  if (renderer) {
    const app = await connect(renderer)
    await app.ev(`(async () => JSON.stringify(await window.shopilot.browser.display(${JSON.stringify(STORE)})))()`)
    await app.ev(`(async () => JSON.stringify(await window.shopilot.browser.prepareInviteSquare(${JSON.stringify(STORE)}, { url: ${JSON.stringify(SQUARE)} })))()`)
    await sleep(7000)
    app.close()
  }
  const after = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const wx = await connect(after.find(t => /store\.weixin\.qq\.com/.test(String(t.url))))

  const state = async (needle) => wx.ev(deep(`
    ${H}
    const row = rowOf('带货类目')
    const chip = row ? [...row.querySelectorAll('label')].find(el => String(el.innerText || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(needle)}) : null
    const inp = chip ? chip.querySelector('input') : null
    const rb = row ? row.getBoundingClientRect() : null
    const cr = chip ? chip.getBoundingClientRect() : null
    return JSON.stringify({ checked: inp ? inp.checked : null, rowHeight: rb ? Math.round(rb.height) : null, chipY: cr ? Math.round(cr.top) : null })
  `))

  console.log('[0] 折叠态「其他」:', await state('其他'))
  console.log('[1] 折叠态下 JS click「其他」:', await wx.ev(engineClick('其他', `(() => { const r = rowOf('带货类目'); return r ? [r] : null })()`)))
  await sleep(2500)
  console.log('[2] 之后:', await state('其他'))

  console.log('[3] 折叠态下 JS click「美妆护肤」:', await wx.ev(engineClick('美妆护肤', `(() => { const r = rowOf('带货类目'); return r ? [r] : null })()`)))
  await sleep(2500)
  console.log('[4] 之后:', await state('美妆护肤'))

  console.log('[5] 其他筛选 JS click「有认证」:', await wx.ev(engineClick('有认证', `(() => { const r = rowOf('其他筛选'); return r ? [r] : null })()`)))
  await sleep(2500)
  const otherState = await wx.ev(deep(`
    ${H}
    const row = rowOf('其他筛选')
    return JSON.stringify({ checked: row ? [...row.querySelectorAll('label')].filter(el => { const i = el.querySelector('input'); return i && i.checked }).map(el => String(el.innerText || '').replace(/\\s+/g, ' ').trim()) : [] })
  `))
  console.log('[6] 其他筛选勾选态:', otherState)

  wx.close()
  process.exit(0)
}

main().catch(err => { console.error('ERR', err.stack || err.message); process.exit(1) })
