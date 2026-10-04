/**
 * 诊断（三）：到底是哪一行达人会被平台丢掉？有没有**可预判的标记**？
 *
 * 已知：勾「前两行」点批量邀约 → 选择被清空、抽屉不开；勾「中间两行」→ 抽屉开。
 * 逐个组合试，并把这些行的可见特征（快捷邀约/在线沟通/收藏 等按钮）一起打出来。
 *
 * 只开抽屉、不发送。用法：node wx-invite-test/diag-ks-which-row-rejected.mjs
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
  const ok = await conn.ev(`document.querySelectorAll('tbody input[type=checkbox]').length`).catch(() => 0)
  if (ok > 0) break
  const url = String(await conn.ev('location.href'))
  if (!/daren-square/.test(url)) { await conn.ev(`location.href = ${JSON.stringify(SQUARE)}`).catch(() => null); await sleep(12000) }
  else await sleep(2500)
}

/** 行特征：名称 + 行内可见按钮文案（快捷邀约/在线沟通/加入收藏…） */
const ROWFEAT = `(() => {
  const rows = [...document.querySelectorAll('tbody tr')]
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  return JSON.stringify(rows.map((tr, i) => {
    const cb = tr.querySelector('input[type=checkbox]')
    const btns = [...tr.querySelectorAll('button, a, span')].filter(e => vis(e) && own(e) && own(e).length <= 8).map(own)
    return {
      i, hasCheckbox: !!cb,
      name: String(tr.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 22),
      rowButtons: [...new Set(btns)].slice(0, 6)
    }
  }).filter(r => r.hasCheckbox).slice(0, 10))
})()`

const clearAll = () => conn.ev(`(() => { const cbs=[...document.querySelectorAll('tbody input[type=checkbox]')]; let n=0; for (const b of cbs){ if(b.checked){ (b.closest('label')||b).click(); n++ } } return n })()`)
const selectRows = idxs => conn.ev(`(() => {
  const cbs = [...document.querySelectorAll('tbody input[type=checkbox]')]
  let n = 0
  for (const i of ${JSON.stringify(idxs)}) { const b = cbs[i]; if (!b || b.checked) continue; (b.closest('label')||b).click(); n++ }
  return n
})()`)
const clickBatch = () => conn.ev(`(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const el = all.find(e => own(e) === '批量邀约' && e.getBoundingClientRect().width > 0)
  if (!el) return 'not-found'
  ;(el.closest('button') || el).click()
  return 'clicked'
})()`)
const state = () => conn.ev(`(() => { const b=String(document.body.innerText); return JSON.stringify({ counter:(b.match(/已选[^\\n]{0,10}/)||[null])[0], textarea: document.querySelectorAll('textarea').length, quota:(b.match(/今日剩余[^\\n]{0,20}/)||[null])[0] }) })()`)

console.log('=== 行特征（前 10 个有复选框的行）===')
console.log(await conn.ev(ROWFEAT))

const scenarios = [[1, 2], [1, 5], [2, 5], [5, 6], [1, 2, 5], [0, 1, 2, 3, 4, 5]]
for (const idx of scenarios) {
  await clearAll(); await sleep(700)
  const n = await selectRows(idx); await sleep(1200)
  const before = JSON.parse(await state())
  const r = await clickBatch()
  let opened = false
  for (let i = 0; i < 5; i++) { await sleep(2500); const st = JSON.parse(await state()); if (st.textarea > 0) { opened = true; break } }
  const after = JSON.parse(await state())
  console.log(`组合 ${JSON.stringify(idx)}：勾中 ${n}｜点击前 ${before.counter}｜点击=${r}｜结果 ${after.counter} textarea=${after.textarea} 额度=${after.quota}｜抽屉=${opened ? '开' : '不开'}`)
  if (opened) {
    // 关掉抽屉，继续下一组
    await conn.ev(`(() => {
      const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
      const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
      const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
      const el = all.find(e => (own(e) === '关 闭' || own(e) === '关闭') && vis(e))
      if (el) { (el.closest('button') || el).click(); return 'closed' }
      return 'no-close'
    })()`)
    await sleep(2500)
  }
}
conn.close(); app.close(); process.exit(0)
