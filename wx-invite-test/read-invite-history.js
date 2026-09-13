/** 展开邀约记录第一张卡（真实 UI），读取步骤结果与运行日志 */
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
  // 任务页签 → 展开第一张邀约记录卡
  await ev(`(()=>{const tab=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='\u4efb\u52a1');if(tab)tab.click();return 1})()`)
  await sleep(800)
  const opened = await ev(`(()=>{const card=document.querySelector('[data-test=invite-history-card] .tc-head');if(!card)return 'no-card';card.click();return 'expanded'})()`)
  await sleep(900)
  const detail = await ev(`(()=>{const card=document.querySelector('[data-test=invite-history-card]');if(!card)return 'no-card';return JSON.stringify({head:String(card.innerText||'').replace(/\s+/g,' ').slice(0,120)})})()`)
  console.log('card:', detail)
  // 逐步结果行
  const steps = await ev(`(()=>{const card=document.querySelector('[data-test=invite-history-card]');const rows=[...card.querySelectorAll('.step-row')].map(r=>String(r.innerText||'').replace(/\s+/g,' ').trim());return JSON.stringify(rows,null,1)})()`)
  console.log('steps:', steps)
  const logs = await ev(`(()=>{const card=document.querySelector('[data-test=invite-history-card]');const box=card.querySelector('.log-box');if(!box)return '[]';return JSON.stringify([...box.querySelectorAll('.log-line')].map(l=>String(l.innerText||'').trim()).slice(-40),null,1)})()`)
  console.log('logs:', logs)
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
