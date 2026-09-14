/** 点开始邀约并抓取结果：任务数变化 + 页面上的 toast 文案（用于看创建失败原因） */
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
  const count = async () => JSON.parse(await ev(`(async()=>{const r=await window.shopilot.task.list();return JSON.stringify({n:(Array.isArray(r.data)?r.data:[]).length})})()`))
  const before = await count()
  console.log('任务数(前):', JSON.stringify(before))
  console.log('按钮:', await ev(`(()=>{const b=document.querySelector('[data-test=invite-start]');return b?JSON.stringify({disabled:b.disabled}):'no-btn'})()`))
  console.log('click:', await ev(`(()=>{const b=document.querySelector('[data-test=invite-start]');if(!b)return 'no-btn';b.click();return 'clicked'})()`))
  for (let i = 1; i <= 5; i++) {
    await sleep(1200)
    const after = await count()
    const toast = await ev(`(()=>{const els=[...document.querySelectorAll('div,span')].filter(e=>{const t=String(e.innerText||'').trim();return t.length>4&&t.length<180&&/失败|错误|不合法|无效|拒绝|Error/i.test(t)});return JSON.stringify(els.slice(0,3).map(e=>String(e.innerText||'').replace(/\\s+/g,' ').slice(0,160)))})()`)
    console.log(i * 1.2 + 's → 任务数:', JSON.stringify(after), '| 提示:', toast)
    if (after.n !== before.n) break
  }
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
