/**
 * 真机验证「下一页」翻页：引擎在 `TASK_PAGE_EXHAUSTED` 时靠它换页取人，
 * 但这一步此前只在单测里覆盖过。这里用**受信任鼠标事件**（与引擎 mode:'real' 同一种手势）
 * 点一次，比较前后两页的达人名单是否真的换了。
 *
 * 用法：node wx-invite-test/verify-paging.mjs
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, er) => { ws.onopen = ok; ws.onerror = er })
  let s = 0
  const p = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } }
  const send = (me, pa = {}) => new Promise((ok, er) => { const id = ++s; p.set(id, m => m.error ? er(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: me, params: pa })) })
  const ev = async (x, timeoutMs = 15000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 超时')), timeoutMs))])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200))
    return r.result.value
  }
  return { send, ev, call: async x => JSON.parse(await ev(`(async()=>JSON.stringify(await ${x}))()`)), close: () => ws.close() }
}

/** 取表格里的达人名字（第一列），以及「下一页」按钮的坐标 */
const PAGE_INFO = `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const rows = all.filter(e => e.tagName === 'TR' && vis(e))
  const names = []
  for (const tr of rows) {
    const cells = [...tr.querySelectorAll('td')]
    if (cells.length) { const t = String(cells[0].innerText || '').replace(/\\s+/g, ' ').trim(); if (t) names.push(t.slice(0, 24)) }
  }
  const next = all.find(e => own(e) === '下一页' && vis(e))
  let nextInfo = null
  if (next) {
    const r = next.getBoundingClientRect()
    const cs = getComputedStyle(next)
    nextInfo = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), disabled: next.disabled === true || cs.pointerEvents === 'none' || String(next.className).includes('disabled') }
  }
  const pager = all.filter(e => /^\\d+$/.test(own(e)) && vis(e)).map(e => own(e)).slice(0, 12)
  return JSON.stringify({ path: location.pathname, names: names.slice(0, 6), rowCount: names.length, nextInfo, pager })
})()`

async function main() {
  const list = await targets()
  const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  const app = await connect(renderer)
  await app.call(`window.shopilot.browser.display('${STORE}')`)
  await sleep(1500)

  const tabs = (await app.call(`window.shopilot.browser.tab.list('${STORE}')`))?.data?.tabs || []
  const square = tabs.find(t => /findersquare\/find$/.test(String(t.url)))
  if (!square) { console.log('店铺里没有广场标签页，先打开一个'); await app.call(`window.shopilot.browser.tab.create('${STORE}', '${SQUARE}')`); await sleep(9000) }
  else { await app.call(`window.shopilot.browser.tab.activate('${STORE}', '${square.id}')`); await sleep(4000) }

  const page = (await targets()).find(t => /findersquare\/find/.test(String(t.url)))
  if (!page) { console.log('没有广场 CDP 目标'); process.exit(1) }
  const conn = await connect(page)

  const before = JSON.parse(await conn.ev(PAGE_INFO))
  console.log('第 1 页:', JSON.stringify({ rowCount: before.rowCount, names: before.names, pager: before.pager, next: before.nextInfo }))
  if (!before.nextInfo) { console.log('❌ 页面上找不到可见的「下一页」按钮'); process.exit(1) }
  if (before.nextInfo.disabled) { console.log('⚠ 「下一页」是禁用态（可能已在最后一页）'); process.exit(0) }

  // 「下一页」在长列表底部（实测 y≈2528，视口只有 757）→ 必须先滚进视口，
  // 否则受信任鼠标的坐标落在视口外，点了等于没点（这一步我第一次就踩到了）。
  const scrolled = JSON.parse(await conn.ev(`(() => {
    const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
    const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const el = all.find(e => own(e) === '下一页' && e.getBoundingClientRect().width > 0)
    if (!el) return JSON.stringify({ ok: false })
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    return JSON.stringify({ ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), vw: innerWidth, vh: innerHeight })
  })()`))
  console.log('滚动后坐标:', JSON.stringify(scrolled))
  if (!scrolled.ok) { console.log('❌ 找不到「下一页」'); process.exit(1) }
  await sleep(1200)
  const again = JSON.parse(await conn.ev(PAGE_INFO))
  if (!again.nextInfo) { console.log('❌ 滚动后「下一页」不可见'); process.exit(1) }

  // 受信任鼠标（与引擎 mode:'real' 同一手势）
  const { x, y } = again.nextInfo
  await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  console.log(`已用受信任鼠标点击「下一页」(${x},${y})`)
  await sleep(4000)

  const after = JSON.parse(await conn.ev(PAGE_INFO))
  const overlap = after.names.filter(n => before.names.includes(n)).length
  console.log('第 2 页:', JSON.stringify({ rowCount: after.rowCount, names: after.names, pager: after.pager }))
  console.log(overlap === 0 ? '✅ 名单整页换掉了：翻页生效' : `⚠ 与第 1 页有 ${overlap} 个重名（可能只是列表洗牌，需人工确认）`)
  console.log('页码指示:', before.pager.join('/') , '→', after.pager.join('/'))
  conn.close()
  app.close()
  process.exit(0)
}

main().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1) })
