/**
 * 快速看广场页现在到底是什么状态（只读）：
 *   URL / 是否落在登录页 / 筛选区与类型页签在不在 / 列表行数 / 页面文本头部
 * 用法：node wx-invite-test/check-square-now.mjs
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (method, params = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method, params })) })
  const ev = async (expr, timeoutMs = 20000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 超时')), timeoutMs))])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  return { ev, call: async (expr) => JSON.parse(await ev(`(async () => JSON.stringify(await ${expr}))()`)), close: () => ws.close() }
}

const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())

const STATE = `(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const text = all.map(e => own(e)).filter(Boolean).join(' ').replace(/\\s+/g, ' ')
  const tabs = all.filter(e => /^(全部带货者|直播带货者|短视频带货者|公众号带货者)$/.test(own(e))).length
  const catRow = all.some(e => own(e) === '带货类目')
  const rows = all.filter(e => e.tagName === 'TR' && vis(e)).length
  const login = /登录超时|请重新\\s*登录|扫码登录|账号未登录/.test(text)
  return JSON.stringify({
    url: location.href,
    readyState: document.readyState,
    login,
    typeTabs: tabs,
    hasCategoryRow: catRow,
    tableRows: rows,
    textHead: text.slice(0, 220)
  }, null, 1)
})()`

async function main() {
  const list = await targets()
  console.log('CDP 目标:')
  for (const t of list) console.log('  ', t.type, String(t.url).slice(0, 90))
  const square = list.find(t => /findersquare\/find/.test(String(t.url)))
  if (!square) { console.log('（当前没有广场页目标：该标签页未挂载）'); process.exit(0) }
  const conn = await connect(square)
  console.log(await conn.ev(STATE))
  conn.close()
  const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  const app = await connect(renderer)
  const tabs = await app.call(`window.shopilot.browser.tab.list('${process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'}')`)
  const all = tabs?.data?.tabs || []
  console.log('店铺标签页总数:', all.length, '｜其中广场页:', all.filter(t => /findersquare\/find$/.test(String(t.url))).length)
  console.log('activeTabId:', tabs?.data?.activeTabId)
  app.close()
  process.exit(0)
}

main().catch(err => { console.error('ERR', err.stack || err.message); process.exit(1) })
