/** 拼多多：列出 sycm/统计类接口的响应原文片段（只读） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function j(p) { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); return r.json() }
async function targets() { const l = await j('/json/list'); return l.filter(t => t.type === 'page') }
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const page = (await targets()).find(t => t.url.includes('mms.pinduoduo'))
  if (!page) throw new Error('拼多多页面未打开')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let seq = 0
  const pend = new Map()
  const all = []
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return }
    if (m.method === 'Network.responseReceived') {
      const r = m.params.response
      if (/\.(js|css|png|jpe?g|svg|gif|woff2?|ttf)($|\?)/i.test(r.url)) return
      all.push({ requestId: m.params.requestId, url: r.url, mime: r.mimeType })
    }
  }
  const send = (method, params = {}) => new Promise((ok, err) => { const id = ++seq; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method, params })) })
  await send('Network.enable')
  await send('Page.navigate', { url: 'https://mms.pinduoduo.com/sycm/evaluation/overview' })
  await sleep(20000)
  const want = all.filter(s => /sycm|statistic|mall|data|overview|trade|order/i.test(s.url) && !/\.(js|css)/i.test(s.url))
  console.log('候选接口:', want.length, '/ 全部:', all.length)
  let n = 0
  for (const s of want) {
    if (n >= 20) break
    try {
      const r = await send('Network.getResponseBody', { requestId: s.requestId })
      const text = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body
      if (!text || text.length < 40) continue
      n++
      console.log(`\n--- [${s.mime}] ${s.url.slice(0, 120)} (len=${text.length})`)
      console.log(text.slice(0, 320).replace(/\s+/g, ' '))
    } catch { /* ignore */ }
  }
  ws.close()
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
