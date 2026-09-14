/** 列出微信店铺的所有标签页 URL 与当前激活页，并逐个报告其内容特征 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const WX_STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'
async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
  const app = list.find(x => x.title === 'ShopPilot')
  const ws = new WebSocket(app.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const ev = (expr) => new Promise((ok, err) => {
    const id = ++s
    pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error).slice(0, 150))) : ok(m.result?.result?.value))
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true } }))
  })
  console.log('tabs:', await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${WX_STORE}');return JSON.stringify((r.data.tabs||[]).map(t=>({id:t.id,url:String(t.url||'').slice(0,50)})))})()`))
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
