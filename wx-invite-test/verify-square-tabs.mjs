/**
 * 复核 fix#2：本次运行用的那个广场标签页是否**带着筛选**活了下来（不能被切到用户那个没筛选的广场页）
 * 做法：列出店铺全部标签页 → 逐个激活 → 读该页的筛选态（页签 + 已勾选项）
 * 用法：node wx-invite-test/verify-square-tabs.mjs
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (method, params = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method, params })) })
  const ev = async (expr, timeoutMs = 30000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 求值超时')), timeoutMs))])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  return { ev, call: async (expr) => JSON.parse(await ev(`(async () => JSON.stringify(await ${expr}))()`)), close: () => ws.close() }
}
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())

const STATE = `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const rowOf = t => { for (const el of all) { if (own(el) !== t) continue; return el.closest('.weui-desktop-form__control-group') } return null }
  const checkedIn = row => row ? [...row.querySelectorAll('label')].filter(el => { const i = el.querySelector('input'); return i && i.checked }).map(el => String(el.innerText || '').replace(/\\s+/g, ' ').trim()) : []
  const tab = all.find(el => el.tagName === 'LI' && /weui-desktop-tab__nav_current/.test(String(el.className || '')))
  return JSON.stringify({
    path: location.pathname,
    finderType: tab ? String(tab.innerText || '').replace(/\\s+/g, ' ').trim() : null,
    others: checkedIn(rowOf('其他筛选')),
    categories: checkedIn(rowOf('带货类目')),
    detailLinks: all.filter(el => own(el) === '详情' && vis(el)).length
  })
})()`

async function main() {
  const list = await targets()
  const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  const app = await connect(renderer)
  await app.call(`window.shopilot.browser.display('${STORE}')`)
  await sleep(1200)
  const tabs = await app.call(`window.shopilot.browser.tab.list('${STORE}')`)
  const all = (tabs?.data?.tabs || [])
  const squareTabs = all.filter(t => /findersquare\/find$/.test(String(t.url)))
  console.log('标签页总数:', all.length, '｜广场页标签数:', squareTabs.length)
  console.log('active =', tabs?.data?.activeTabId)
  for (const tab of squareTabs) {
    await app.call(`window.shopilot.browser.tab.activate('${STORE}', '${tab.id}')`).catch(() => null)
    await sleep(3200)
    const page = (await targets()).find(t => /findersquare\/find/.test(String(t.url)))
    if (!page) { console.log(`${tab.id} → 无 CDP 目标（后台标签，未挂载）`); continue }
    const conn = await connect(page)
    const state = await conn.ev(STATE)
    console.log(`${tab.id} → ${state}`)
    conn.close()
  }
  app.close()
  process.exit(0)
}

main().catch(err => { console.error('ERR', err.stack || err.message); process.exit(1) })
