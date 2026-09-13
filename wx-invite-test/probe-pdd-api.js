/** 拼多多：列出数据中心页自身发出的接口与响应片段（只读） */
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
  const seen = []
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return }
    if (m.method === 'Network.responseReceived') {
      const url = String(m.params.response.url || '')
      if (/\.(js|css|png|jpe?g|svg|woff2?|gif)($|\?)/i.test(url)) return
      if (!/api|sycm|query|data|statistic|overview/i.test(url)) return
      seen.push({ requestId: m.params.requestId, url, status: m.params.response.status, mime: m.params.response.mimeType })
    }
  }
  const send = (method, params = {}) => new Promise((ok, err) => { const id = ++seq; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method, params })) })
  await send('Network.enable')
  await send('Page.reload')
  await sleep(16000)
  console.log('候选接口数:', seen.length)
  let i = 0
  for (const s of seen) {
    if (i >= 18) break
    try {
      const r = await send('Network.getResponseBody', { requestId: s.requestId })
      const text = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body
      if (!text || text.length < 20) continue
      i++
      const numeric = (text.match(/\d+(\.\d+)?/g) || []).length
      console.log(`\n--- [${s.status}] ${s.url.slice(0, 110)} | len=${text.length} 数字token=${numeric}`)
      console.log(text.slice(0, 260).replace(/\s+/g, ' '))
    } catch (e) { console.log(`--- ${s.url.slice(0, 90)} 取不到响应体: ${String(e.message).slice(0, 60)}`) }
  }
  ws.close()
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
