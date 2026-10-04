/**
 * 诊断（续）：点「批量邀约」后选择被清空、抽屉不开 —— 到底差什么条件？
 *
 * 逐项试：不同行的达人（前 2 行 / 中间行 / 5 行）、选择栏上到底有哪些按钮、
 * 选中的达人是否本身"不可邀约"、点击前后页面文案变化。
 *
 * 只开抽屉、不发送。用法：node wx-invite-test/diag-ks-drawer-condition.mjs
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_KS_STORE || 'store_3856e71a3ae8499ebdbec1f4ccbb4394'
const SQUARE = 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, er) => { ws.onopen = ok; ws.onerror = er })
  let s = 0
  const p = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } }
  const send = (me, pa = {}) => new Promise((ok, er) => { const id = ++s; p.set(id, m => m.error ? er(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: me, params: pa })) })
  const ev = async (x, timeoutMs = 25000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 超时')), timeoutMs))])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  return { send, ev, call: async x => JSON.parse(await ev(`(async()=>JSON.stringify(await ${x}))()`)), close: () => ws.close() }
}

/** 选择栏：批量邀约按钮附近那一块的全部文案与按钮 */
const BAR = `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const btn = all.find(e => own(e) === '批量邀约' && vis(e))
  let bar = btn
  for (let i = 0; i < 4 && bar; i++) bar = bar.parentElement
  const buttons = [...new Set(all.filter(e => vis(e) && own(e) && own(e).length <= 8 && (e.tagName === 'BUTTON' || e.tagName === 'A')).map(own))]
  return JSON.stringify({
    barText: bar ? String(bar.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160) : null,
    barClass: bar ? String(bar.className || '').slice(0, 80) : null,
    buttons,
    counter: (String(document.body.innerText).match(/已选[^\\n]{0,16}/) || [null])[0],
    textarea: document.querySelectorAll('textarea').length
  })
})()`

/** 表格前 8 行：复选框状态 + 行文案（看达人是否有"不可邀约"标记） */
const ROWS = `(() => {
  const rows = [...document.querySelectorAll('tbody tr')]
  return JSON.stringify(rows.slice(0, 9).map((tr, i) => {
    const cb = tr.querySelector('input[type=checkbox]')
    return { i, checked: cb ? cb.checked : null, disabled: cb ? cb.disabled : null, text: String(tr.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 90) }
  }))
})()`

const list = await targets()
const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
const app = await connect(renderer)
await app.call(`window.shopilot.browser.display('${STORE}')`)
await sleep(1500)
const tabs = (await app.call(`window.shopilot.browser.tab.list('${STORE}')`))?.data?.tabs || []
const square = tabs.find(t => /daren-square|daren-match/.test(String(t.url)))
if (square) await app.call(`window.shopilot.browser.tab.activate('${STORE}', '${square.id}')`)
let page = null
for (let i = 0; i < 20 && !page; i++) { page = (await targets()).find(t => /daren-square/.test(String(t.url))); if (!page) await sleep(2000) }
if (!page) { console.error('没有广场页目标'); process.exit(1) }
const conn = await connect(page)
for (let i = 0; i < 20; i++) {
  const st = JSON.parse(await conn.ev(BAR).catch(() => '{}'))
  if (st.buttons && st.buttons.includes('批量邀约')) break
  const url = String(await conn.ev('location.href'))
  if (!/daren-square/.test(url)) { await conn.ev(`location.href = ${JSON.stringify(SQUARE)}`).catch(() => null); await sleep(12000) }
  else await sleep(2500)
}

const clearAll = () => conn.ev(`(() => { const cbs=[...document.querySelectorAll('tbody input[type=checkbox]')]; let n=0; for (const b of cbs){ if(b.checked){ (b.closest('label')||b).click(); n++ } } return n })()`)
const selectRows = idxs => conn.ev(`(() => {
  const cbs = [...document.querySelectorAll('tbody input[type=checkbox]')]
  const idx = ${JSON.stringify(idxs)}
  let n = 0
  for (const i of idx) { const b = cbs[i]; if (!b) continue; if (b.checked) continue; (b.closest('label')||b).click(); n++ }
  return JSON.stringify({ total: cbs.length, clicked: n })
})()`)
const clickBatch = () => conn.ev(`(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const el = all.find(e => own(e) === '批量邀约' && e.getBoundingClientRect().width > 0)
  if (!el) return 'not-found'
  ;(el.closest('button') || el).click()
  return 'clicked'
})()`)

console.log('=== 表格前 9 行 ===')
console.log(await conn.ev(ROWS))
console.log('\n=== 选择栏（未选）===')
console.log(await conn.ev(BAR))

for (const scenario of [{ name: '第 0、1 行（列表最前两位）', idx: [0, 1] }, { name: '第 4、5 行（中间）', idx: [4, 5] }, { name: '前 5 行', idx: [0, 1, 2, 3, 4] }]) {
  await clearAll(); await sleep(800)
  const sel = JSON.parse(await selectRows(scenario.idx)); await sleep(1200)
  const bar = JSON.parse(await conn.ev(BAR))
  console.log(`\n=== 场景：${scenario.name} ===`)
  console.log('  勾选:', JSON.stringify(sel), '｜计数:', bar.counter, '｜按钮:', JSON.stringify(bar.buttons))
  const r = await clickBatch()
  let opened = false
  for (let i = 0; i < 6; i++) {
    await sleep(2500)
    const st = JSON.parse(await conn.ev(BAR))
    if (i === 0 || st.textarea > 0) console.log(`  +${(i + 1) * 2.5}s 点击=${r} 计数=${st.counter} textarea=${st.textarea} 栏=${String(st.barText || '').slice(0, 80)}`)
    if (st.textarea > 0) { opened = true; break }
  }
  console.log('  抽屉是否打开:', opened)
  if (opened) break
}
conn.close(); app.close(); process.exit(0)
