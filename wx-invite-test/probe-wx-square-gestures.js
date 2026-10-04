/**
 * 微信小店带货者广场：确定**每种控件的可用手势**（JS click vs 受信任鼠标）
 *   ① 「展开」：JS click 是否展开（行高 28 → 148）
 *   ② 类目 chip：JS click 是否真的选中（input.checked + 列表条数变化）
 *   ③ 类型页签：JS click 是否切换（li.weui-desktop-tab__nav_current）
 *   ④ 切到「直播带货者」后，近30日带货数据里还有没有「带货销售总额」（后面流程要按 tab 如实处理）
 *
 * 用法：node wx-invite-test/probe-wx-square-gestures.js
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
  const catGroup = () => { for (const el of ENUM_ALL()) { if (own(el) !== '带货类目') continue; return el.closest('.weui-desktop-form__control-group') } return null }
  const rowwOf = t => { for (const el of ENUM_ALL()) { if (own(el) !== t) continue; return el.closest('.weui-desktop-form__control-group') } return null }
`
const SNAP = deep(`
  ${H}
  const g = catGroup()
  const rb = g ? g.getBoundingClientRect() : null
  const chipCheck = g ? [...g.querySelectorAll('label')].slice(1).filter(el => { const i = el.querySelector('input'); return i && i.checked }).map(el => String(el.innerText || '').replace(/\\s+/g, ' ').trim()) : []
  const metrics = []
  const dataRow = rowwOf('近30日带货数据')
  if (dataRow) for (const dt of dataRow.querySelectorAll('dt')) metrics.push(String(dt.innerText || '').replace(/\\s+/g, ' ').trim())
  const tabs = []
  for (const el of ENUM_ALL()) {
    if (el.tagName !== 'LI' || !/weui-desktop-tab__nav/.test(String(el.className || ''))) continue
    tabs.push({ t: String(el.innerText || '').replace(/\\s+/g, ' ').trim(), current: /current/.test(String(el.className || '')) })
  }
  const others = []
  const otherRow = rowwOf('其他筛选')
  if (otherRow) for (const el of otherRow.querySelectorAll('label')) others.push(String(el.innerText || '').replace(/\\s+/g, ' ').trim())
  return JSON.stringify({
    catRowHeight: rb ? Math.round(rb.height) : null,
    catChecked: chipCheck,
    catExpandBtn: g ? [...g.querySelectorAll('*')].map(el => String(el.innerText || '').replace(/\\s+/g, '').trim()).filter(t => /^(展开|收起)$/.test(t)).slice(0, 3) : [],
    metrics,
    tabs,
    others,
    detailLinks: ENUM_ALL().filter(el => own(el) === '详情' && vis(el)).length
  }, null, 1)
`)

const JS_CLICK = (finder) => deep(`
  ${H}
  ${finder}
  if (!target) return JSON.stringify({ ok: false, reason: 'not-found' })
  target.click()
  return JSON.stringify({ ok: true, tag: target.tagName, cls: String(target.className || '').slice(0, 60), text: String(target.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30) })
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

  console.log('[1] 基线：\n' + await wx.ev(SNAP))

  console.log('[2] JS click「展开」→', await wx.ev(JS_CLICK(`
    const g = catGroup()
    let target = g ? [...g.querySelectorAll('*')].find(el => String(el.innerText || '').replace(/\\s+/g, '').trim() === '展开') : null
  `)))
  await sleep(1500)
  console.log('[3] 展开后快照：\n' + await wx.ev(SNAP))

  console.log('[4] JS click 类目「其他」→', await wx.ev(JS_CLICK(`
    const g = catGroup()
    let target = g ? [...g.querySelectorAll('label')].find(el => String(el.innerText || '').replace(/\\s+/g, ' ').trim() === '其他') : null
  `)))
  await sleep(2500)
  console.log('[5] 点类目后快照：\n' + await wx.ev(SNAP))

  console.log('[6] JS click 页签「直播带货者」→', await wx.ev(JS_CLICK(`
    let target = ENUM_ALL().find(el => el.tagName === 'A' && own(el) === '直播带货者' && vis(el))
  `)))
  await sleep(3000)
  console.log('[7] 切页签后快照：\n' + await wx.ev(SNAP))

  fs.writeFileSync(path.join(OUT_DIR, 'square-gestures-snapshot.json'), String(await wx.ev(SNAP)))
  wx.close()
  process.exit(0)
}

main().catch(err => { console.error('ERR', err.stack || err.message); process.exit(1) })
