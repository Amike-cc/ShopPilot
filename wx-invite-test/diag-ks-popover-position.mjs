/**
 * 对比：打开快手类目级联弹层时，**合成 click** 与**受信任鼠标**点击，弹层最终落在哪。
 *
 * 背景：档案里记录"弹层停在 -9999,-9999"，而步骤里 chip 用的是默认 JS 点击、
 * 叶子用 mode:'real' —— 若定位依赖真实手势，合成点击就会让弹层永远留在屏幕外，
 * 叶子步骤必然 TASK_TARGET_OUT_OF_VIEWPORT（真机彩排就是这么挂的）。
 *
 * 只点筛选，不发邀约。用法：node wx-invite-test/diag-ks-popover-position.mjs
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

const POPOVER = `(() => {
  const dd = document.querySelector('.kwaishop-cps-daren-match-pc-select-dropdown')
  if (!dd) return JSON.stringify({ exists: false })
  const r = dd.getBoundingClientRect()
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const leaf = [...dd.querySelectorAll('*')].find(e => own(e) === '纸品湿巾')
  const lr = leaf ? leaf.getBoundingClientRect() : null
  return JSON.stringify({
    exists: true,
    popover: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    leaf: lr ? [Math.round(lr.left), Math.round(lr.top), Math.round(lr.width), Math.round(lr.height)] : null,
    leafVisible: !!(lr && lr.width > 0 && lr.height > 0),
    offscreen: Math.round(r.left) < -1000 || Math.round(r.top) < -1000
  })
})()`

const chipPos = () => `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const cat = all.find(e => own(e) === '带货类目')
  let row = cat; for (let i = 0; i < 2 && row; i++) row = row.parentElement
  const el = row ? [...row.querySelectorAll('*')].find(e => own(e) === '个护家清') : null
  if (!el) return JSON.stringify({ ok: false })
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return JSON.stringify({ ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
})()`

const list = await targets()
const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
const app = await connect(renderer)
await app.call(`window.shopilot.browser.display('${STORE}')`)
await sleep(3000)
const tabs = (await app.call(`window.shopilot.browser.tab.list('${STORE}')`))?.data?.tabs || []
const sq = tabs.find(t => /daren-square/.test(String(t.url)))
if (sq) await app.call(`window.shopilot.browser.tab.activate('${STORE}', '${sq.id}')`)
let page = null
for (let i = 0; i < 20 && !page; i++) { page = (await targets()).find(t => /daren-square/.test(String(t.url))); if (!page) await sleep(2000) }
if (!page) { console.error('没有广场页'); process.exit(1) }
const conn = await connect(page)
for (let i = 0; i < 20; i++) {
  const ok = JSON.parse(await conn.ev(chipPos()).catch(() => '{"ok":false}'))
  if (ok.ok) break
  const url = String(await conn.ev('location.href'))
  if (!/daren-square/.test(url)) { await conn.ev(`location.href = ${JSON.stringify(SQUARE)}`).catch(() => null); await sleep(12000) }
  else await sleep(2500)
}

const clickTrusted = async (x, y) => {
  await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
const pressEscape = () => conn.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).then(() => conn.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }))

// ① 合成点击
let pos = JSON.parse(await conn.ev(chipPos()))
console.log('chip 坐标:', JSON.stringify(pos))
await conn.ev(`(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const cat = all.find(e => own(e) === '带货类目')
  let row = cat; for (let i = 0; i < 2 && row; i++) row = row.parentElement
  const el = row ? [...row.querySelectorAll('*')].find(e => own(e) === '个护家清') : null
  if (el) el.click()
  return !!el
})()`)
await sleep(2500)
console.log('① 合成点击后:', await conn.ev(POPOVER))
await pressEscape(); await sleep(1500)

// ② 受信任鼠标点击
pos = JSON.parse(await conn.ev(chipPos()))
console.log('\nchip 坐标(重取):', JSON.stringify(pos))
if (pos.ok) await clickTrusted(pos.x, pos.y)
await sleep(2500)
console.log('② 受信任点击后:', await conn.ev(POPOVER))
conn.close(); app.close(); process.exit(0)
