/**
 * 诊断：快手广场点「批量邀约」为什么不开抽屉（2026-10-04）。
 * 分别试 JS 点击 与 受信任鼠标点击，并对比点击前后的 DOM/文案变化。
 *
 * 只开抽屉、不发送。用法：node wx-invite-test/diag-ks-open-drawer.mjs
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

const PROBE = `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const cls = all.map(e => String(e.className || '')).join(' ')
  const classes = [...new Set(cls.split(/\\s+/).filter(c => /drawer|dialog|modal|popup|toast|tagForm/i.test(c)))].slice(0, 14)
  const body = String(document.body.innerText)
  return JSON.stringify({
    textarea: document.querySelectorAll('textarea').length,
    quota: (body.match(/今日剩余[^\\n]{0,26}/) || [null])[0],
    classes,
    toastish: [...new Set(all.filter(e => vis(e) && own(e) && /失败|请选择|频繁|错误|异常|不足/.test(own(e))).map(e => own(e)))].slice(0, 6),
    batchInviteButtons: all.filter(e => own(e) === '批量邀约' && vis(e)).map(e => ({ tag: e.tagName, cls: String(e.className || '').slice(0, 40) })),
    counter: (body.match(/已选[^\\n]{0,14}/) || [null])[0],
    url: location.pathname
  })
})()`

const list = await targets()
const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
const app = await connect(renderer)
await app.call(`window.shopilot.browser.display('${STORE}')`)
await sleep(1500)
const tabs = (await app.call(`window.shopilot.browser.tab.list('${STORE}')`))?.data?.tabs || []
const square = tabs.find(t => /daren-square|daren-match/.test(String(t.url)))
if (square) await app.call(`window.shopilot.browser.tab.activate('${STORE}', '${square.id}')`)
else await app.call(`window.shopilot.browser.tab.create('${STORE}', '${SQUARE}')`)
let page = null
for (let i = 0; i < 20 && !page; i++) { page = (await targets()).find(t => /daren-square/.test(String(t.url))); if (!page) await sleep(2000) }
if (!page) { console.error('没有广场页目标'); process.exit(1) }
const conn = await connect(page)
// 确保在广场页且列表已渲染
for (let i = 0; i < 20; i++) {
  const st = JSON.parse(await conn.ev(PROBE).catch(() => '{}'))
  if (st.batchInviteButtons && st.batchInviteButtons.length) break
  const url = String(await conn.ev('location.href'))
  if (!/daren-square/.test(url)) { await conn.ev(`location.href = ${JSON.stringify(SQUARE)}`).catch(() => null); await sleep(12000) }
  else await sleep(2500)
}
console.log('点击前:', await conn.ev(PROBE))

// 勾 2 位
console.log('勾选:', await conn.ev(`(() => { const cbs=[...document.querySelectorAll('tbody input[type=checkbox]')]; let n=0; for (const b of cbs){ if(b.checked) continue; (b.closest('label')||b).click(); if(++n>=2) break } return n })()`))
await sleep(1500)
console.log('勾选后:', await conn.ev(PROBE))

// ① JS 点击
const pos = JSON.parse(await conn.ev(`(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const el = all.find(e => own(e) === '批量邀约' && e.getBoundingClientRect().width > 0)
  if (!el) return JSON.stringify({ ok: false })
  const btn = el.closest('button') || el
  const r = btn.getBoundingClientRect()
  btn.click()
  return JSON.stringify({ ok: true, tag: btn.tagName, cls: String(btn.className || '').slice(0, 60), disabled: btn.disabled === true, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })
})()`))
console.log('JS 点击:', pos)
for (const t of [2000, 4000, 8000, 12000]) {
  await sleep(t === 2000 ? 2000 : 2000)
  const st = JSON.parse(await conn.ev(PROBE))
  console.log(`  +${t}ms:`, JSON.stringify({ textarea: st.textarea, quota: st.quota, counter: st.counter, toastish: st.toastish, classes: st.classes.slice(0, 5) }))
  if (st.textarea > 0) { console.log('抽屉已打开（JS 点击生效）'); break }
}

// ② 若还没开：受信任鼠标点击
const st2 = JSON.parse(await conn.ev(PROBE))
if (st2.textarea === 0) {
  console.log('\n改用受信任鼠标点击…')
  const p2 = JSON.parse(await conn.ev(`(() => {
    const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
    const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const el = all.find(e => own(e) === '批量邀约' && e.getBoundingClientRect().width > 0)
    if (!el) return JSON.stringify({ ok: false })
    const btn = el.closest('button') || el
    btn.scrollIntoView({ block: 'center' })
    const r = btn.getBoundingClientRect()
    return JSON.stringify({ ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`))
  console.log('按钮坐标:', p2)
  if (p2.ok) {
    await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p2.x, y: p2.y })
    await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p2.x, y: p2.y, button: 'left', clickCount: 1 })
    await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p2.x, y: p2.y, button: 'left', clickCount: 1 })
    for (let i = 0; i < 6; i++) {
      await sleep(2500)
      const st = JSON.parse(await conn.ev(PROBE))
      console.log(`  +${(i + 1) * 2.5}s:`, JSON.stringify({ textarea: st.textarea, quota: st.quota, toastish: st.toastish }))
      if (st.textarea > 0) { console.log('抽屉已打开（受信任鼠标生效）'); break }
    }
  }
}
console.log('\n最终:', await conn.ev(PROBE))
conn.close(); app.close(); process.exit(0)
