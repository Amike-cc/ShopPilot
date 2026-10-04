/**
 * 量：广场列表行里怎么稳定取到"达人昵称"（用于本地台账 + 点「详情」前跳过）。
 * 用法：node wx-invite-test/probe-row-nickname.mjs
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
  const ev = async (x, timeoutMs = 20000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 超时')), timeoutMs))])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200))
    return r.result.value
  }
  return { ev, call: async x => JSON.parse(await ev(`(async()=>JSON.stringify(await ${x}))()`)), close: () => ws.close() }
}

const FIRST_CELL = `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const rows = all.filter(e => e.tagName === 'TR' && vis(e))
  const out = []
  for (const tr of rows.slice(1, 4)) {
    const cells = [...tr.querySelectorAll('td')]
    if (!cells.length) continue
    const first = cells[0]
    const inner = first.querySelectorAll('*')
    out.push({
      cellHtml: first.innerHTML.replace(/\\s+/g, ' ').slice(0, 260),
      childTags: [...inner].map(e => e.tagName + (e.className ? '.' + String(e.className).split(' ').slice(0, 2).join('.') : '')).slice(0, 8),
      cellText: String(first.innerText || '').replace(/\\s+/g, ' ').trim(),
      // 候选：第一个 td 的 innerText 第一行 / 里面的 a 或 span 文本
      firstLine: String(first.innerText || '').split('\\n')[0].trim(),
      linkText: (first.querySelector('a') ? String(first.querySelector('a').innerText || '').trim() : null),
      detailBtnText: (() => { const d = [...tr.querySelectorAll('*')].find(e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim() === '详情'); return d ? d.tagName : null })()
    })
  }
  return JSON.stringify({ rows: out })
})()`

async function main() {
  const list = await targets()
  const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  const app = await connect(renderer)
  await app.call(`window.shopilot.browser.display('${STORE}')`)
  await sleep(1500)
  const tabs = (await app.call(`window.shopilot.browser.tab.list('${STORE}')`))?.data?.tabs || []
  const square = tabs.find(t => /findersquare\/find$/.test(String(t.url)))
  if (square) { await app.call(`window.shopilot.browser.tab.activate('${STORE}', '${square.id}')`); await sleep(3500) }
  else { await app.call(`window.shopilot.browser.tab.create('${STORE}', '${SQUARE}')`); await sleep(10000) }
  const page = (await targets()).find(t => /findersquare\/find/.test(String(t.url)))
  if (!page) { console.log('没有广场页目标'); process.exit(1) }
  const conn = await connect(page)
  for (let i = 0; i < 12; i++) {
    const raw = await conn.ev(FIRST_CELL).catch(() => null)
    if (raw) { const d = JSON.parse(raw); if (d.rows.length) { console.log(JSON.stringify(d, null, 1)); break } }
    await sleep(2000)
  }
  conn.close(); app.close(); process.exit(0)
}

main().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1) })
