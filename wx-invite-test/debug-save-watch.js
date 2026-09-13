/** 对照实验：真实点击等级 chip，轮询 invite.config.抖店 是否被写入 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
  const t = list.find(x => x.title === 'ShopPilot')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let seq = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const ev = (expr) => new Promise((ok, err) => {
    const id = ++seq
    pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error).slice(0, 200))) : ok(m.result?.result?.value))
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true } }))
  })
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  // 真实点击 LV6 chip（当前未勾选）
  console.log('click LV6:', await ev(`(()=>{const c=document.querySelector('[data-test=invite-level-LV6]');if(!c)return 'no-chip';c.click();return 'clicked'})()`))
  for (let i = 0; i < 8; i++) {
    await sleep(700)
    const v = await ev(`(async()=>{const r=await window.shopilot.settings.get('invite.config.\\u6296\\u5e97');return JSON.stringify(r.data && r.data.value)})()`)
    console.log((i + 1) * 0.7 + 's:', v)
    if (v && v !== 'null') break
  }
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
