/** 点开始邀约 → 列出最新创建的 3 个任务及其最近运行（按 createdAt 倒序） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
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
    pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error).slice(0, 200))) : ok(m.result?.result?.value))
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true } }))
  })
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const newest = () => ev(`(async () => {
    const r = await window.shopilot.task.list()
    const all = Array.isArray(r.data) ? r.data : []
    return JSON.stringify(all.slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,3).map(t=>({
      id:t.id, name:t.name, createdAt:new Date(t.createdAt||0).toLocaleTimeString(),
      stepTypes:(t.steps||[]).map(s2=>s2.type), run: t.latestRun? {status:t.latestRun.status,code:t.latestRun.errorCode,msg:t.latestRun.errorMessage?String(t.latestRun.errorMessage).slice(0,120):null}:null
    })),null,1)
  })()`)
  console.log('点击前最新任务:', await newest())
  console.log('displayedStoreId:', await ev(`(()=>{const el=document.querySelector('.store-card.active,.store-card.displayed');return el?String(el.innerText||'').replace(/\\s+/g,' ').slice(0,20):'none'})()`))
  console.log('click:', await ev(`(()=>{const b=document.querySelector('[data-test=invite-start]');if(!b)return 'no-btn';b.click();return 'clicked'})()`))
  await sleep(4000)
  console.log('点击后最新任务:', await newest())
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
