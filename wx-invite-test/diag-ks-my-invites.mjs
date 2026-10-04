/**
 * 诊断（四）：快手被"静默丢掉"的达人，是不是"近 7 天已邀过"？
 *
 * 做法：打开「我的达人 → 邀约中」，把里面的达人昵称读出来，
 * 与广场里被丢掉的两位（力哥 / 九零后老母亲一拖二的日常）比对。
 * 只读页面，不改任何数据。
 *
 * 用法：node wx-invite-test/diag-ks-my-invites.mjs
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_KS_STORE || 'store_3856e71a3ae8499ebdbec1f4ccbb4394'
const MY = 'https://cps.kwaixiaodian.com/zone/daren-match/my-daren'
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
const mine = tabs.find(t => /my-daren/.test(String(t.url)))
if (mine) await app.call(`window.shopilot.browser.tab.activate('${STORE}', '${mine.id}')`)
else await app.call(`window.shopilot.browser.tab.create('${STORE}', '${MY}')`)
let page = null
for (let i = 0; i < 25 && !page; i++) { page = (await targets()).find(t => /my-daren/.test(String(t.url))); if (!page) await sleep(2000) }
if (!page) { console.error('没打开我的达人页'); process.exit(1) }
const conn = await connect(page)
for (let i = 0; i < 20; i++) {
  const url = String(await conn.ev('location.href'))
  if (!/my-daren/.test(url)) { await conn.ev(`location.href = ${JSON.stringify(MY)}`).catch(() => null); await sleep(12000); continue }
  const tabs2 = await conn.ev(`JSON.stringify([...document.querySelectorAll('*')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }).map(e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()).filter(t => /邀约中|已接受|已拒绝|全部/.test(t)).slice(0, 10))`)
  if (tabs2 && tabs2 !== '[]') break
  await sleep(2500)
}
console.log('页面:', String(await conn.ev('location.href')).slice(0, 80), '｜标题:', await conn.ev('document.title'))
console.log('页签:', await conn.ev(`JSON.stringify([...document.querySelectorAll('*')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }).map(e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()).filter(t => /邀约中|已接受|已拒绝|全部|待处理/.test(t)).slice(0, 12))`))

// 点「邀约中」页签
console.log('点邀约中:', await conn.ev(`(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const el = all.find(e => /邀约中/.test(own(e)) && vis(e) && own(e).length <= 12)
  if (!el) return 'not-found'
  ;(el.closest('a,li,div,button') || el).click()
  return 'clicked:' + own(el)
})()`))
await sleep(4000)

const dump = await conn.ev(`(() => {
  const rows = [...document.querySelectorAll('tbody tr')]
  const names = rows.map(tr => String(tr.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60)).filter(Boolean)
  const body = String(document.body.innerText).replace(/\\s+/g, ' ')
  return JSON.stringify({ rowCount: rows.length, names: names.slice(0, 20), mentions: ['力哥', '九零后老母亲'].map(n => ({ n, found: body.includes(n) })) })
})()`)
console.log('邀约中列表:', dump)
conn.close(); app.close(); process.exit(0)
