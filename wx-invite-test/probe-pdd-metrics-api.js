/**
 * 拼多多数据中心：抓取页面自身发出的接口，找"经营指标明文 JSON"
 * 只读：监听网络，不改请求/响应。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function j(p) { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); return r.json() }
async function targets() { const l = await j('/json/list'); return l.filter(t => t.type === 'page') }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const KEYS = /payAmount|pay_?amount|orderNum|order_?num|orderCount|order_?count|refundAmount|refund_?amount|refundNum|refund_?num|refundCount|refund_?count|goodsNum|goods_?num|saleNum|sale_?num|quantity|gmv|turnover|tradeAmount|trade_?amount/i

async function main() {
  const page = (await targets()).find(t => t.url.includes('mms.pinduoduo'))
  if (!page) throw new Error('拼多多页面未打开')
  console.log('当前页面:', page.url.slice(0, 80))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let seq = 0
  const pend = new Map()
  const hits = []
  const all = []
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return }
    if (m.method === 'Network.responseReceived') {
      const r = m.params.response
      if (/\.(js|css|png|jpe?g|svg|gif|woff2?|ttf)($|\?)/i.test(r.url)) return
      if (r.mimeType && !/json/i.test(r.mimeType)) return
      all.push({ requestId: m.params.requestId, url: r.url })
    }
  }
  const send = (method, params = {}) => new Promise((ok, err) => { const id = ++seq; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method, params })) })
  await send('Network.enable')
  // 打开数据中心经营总览（触发它的数据请求）
  await send('Page.navigate', { url: 'https://mms.pinduoduo.com/sycm/evaluation/overview' })
  await sleep(18000)
  console.log('JSON 响应数:', all.length)
  for (const s of all) {
    try {
      const r = await send('Network.getResponseBody', { requestId: s.requestId })
      const text = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body
      if (!text || text.length < 30) continue
      if (!KEYS.test(text)) continue
      const keys = [...new Set((text.match(/"[a-zA-Z_]*[Aa]mount[a-zA-Z_]*"|"[a-zA-Z_]*[Nn]um[a-zA-Z_]*"|"[a-zA-Z_]*[Cc]ount[a-zA-Z_]*"|"[a-zA-Z_]*[Qq]uantity[a-zA-Z_]*"/g) || []))].slice(0, 24)
      hits.push({ url: s.url.slice(0, 110), len: text.length, keys, head: text.slice(0, 400).replace(/\s+/g, ' ') })
    } catch { /* 取不到响应体 */ }
  }
  console.log('命中明文指标接口数:', hits.length)
  console.log(JSON.stringify(hits.slice(0, 5), null, 1))
  ws.close()
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
