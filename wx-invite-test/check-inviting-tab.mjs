/**
 * 点进「我的邀约 → 邀请中」看这一条到底是谁、什么时候发的（发送后的平台侧铁证）
 * 用法：node wx-invite-test/check-inviting-tab.mjs
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const MY_INVITE = 'https://store.weixin.qq.com/shop/findersquare/my-invite'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (method, params = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method, params })) })
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value }
  return { send, ev, call: async (expr) => JSON.parse(await ev(`(async () => JSON.stringify(await ${expr}))()`)), close: () => ws.close() }
}
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())

const ROWS = `(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const tabs = all.filter(e => vis(e) && /^(已接受|邀请中|已失效|全部|待确认)\\(\\d+\\)$/.test(own(e))).map(e => own(e))
  const rows = all.filter(e => e.tagName === 'TR' && vis(e)).map(e => String(e.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean)
  return JSON.stringify({ tabs, rowCount: rows.length, rows })
})()`

async function main() {
  const list = await targets()
  const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  const app = await connect(renderer)
  await app.call(`window.shopilot.browser.display('${STORE}')`)
  await sleep(1200)
  const created = await app.call(`window.shopilot.browser.tab.create('${STORE}', '${MY_INVITE}')`)
  const tabId = created?.data?.tabId || created?.data?.id
  await sleep(12000)
  const page = (await targets()).find(t => /findersquare\/my-invite/.test(String(t.url)))
  if (!page) { console.log('没打开 my-invite'); process.exit(1) }
  const conn = await connect(page)
  console.log('进入页面:', await conn.ev(ROWS))

  const clicked = await conn.ev(`(() => {
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const el = all.find(e => /^邀请中\\(\\d+\\)$/.test(own(e)) && e.getBoundingClientRect().width > 0)
    if (!el) return 'null'
    ;(el.closest('a,li,button,div') || el).click()
    return 'clicked:' + own(el)
  })()`)
  console.log('点「邀请中」:', clicked)
  await sleep(5000)
  console.log('邀请中列表:', await conn.ev(ROWS))

  try {
    const shot = await conn.send('Page.captureScreenshot', { format: 'png' })
    const fs = await import('node:fs')
    const path = await import('node:path')
    const out = path.resolve('wx-invite-test/evidence/my-invite-inviting.png')
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
    console.log('截图:', out)
  } catch (e) { console.log('截图失败:', e.message) }

  if (tabId) await app.call(`window.shopilot.browser.tab.close('${STORE}', '${tabId}')`).catch(() => null)
  conn.close()
  app.close()
  process.exit(0)
}

main().catch(err => { console.error('ERR', err.stack || err.message); process.exit(1) })
