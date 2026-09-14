/** 验证 viaBlocker：点「详情」（被同行链接覆盖）应点中覆盖链接而不是失败 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'
const MOCK = `http://127.0.0.1:8896/?v=${Date.now()}`
const STEPS = [
  { type: 'navigate', input: { url: MOCK }, timeoutMs: 30000 },
  { type: 'waitForPage', input: { urlIncludes: '127.0.0.1:8896' }, timeoutMs: 20000 },
  { type: 'waitForText', input: { text: '覆盖按钮仿真', deep: true }, timeoutMs: 15000 },
  { type: 'clickByText', input: { text: '详情', mode: 'real' }, timeoutMs: 20000 }
]
async function pickLive(urlPart) {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  for (const t of list.filter(x => x.type === 'page' && x.url.includes(urlPart))) {
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
    let s = 0
    const pend = new Map()
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
    const send = (method, params = {}) => new Promise((ok, err) => {
      const id = ++s
      pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
      ws.send(JSON.stringify({ id, method, params }))
    })
    const r = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
    if (r.result?.value > 0) {
      return { ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value, close: () => ws.close() }
    }
    ws.close()
  }
  return null
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function main() {
  const app = await pickLive('index.html')
  const created = JSON.parse(await app.ev(`(async()=>{const r=await window.shopilot.task.create({name:'验证 · 覆盖链接点击',storeScope:'${STORE}',steps:${JSON.stringify(STEPS)}});return JSON.stringify({ok:r.ok,taskId:r.data&&r.data.id,err:r.error&&r.error.message})})()`))
  console.log('create:', JSON.stringify(created))
  if (!created.ok) process.exit(1)
  await app.ev(`(async()=>{await window.shopilot.task.run('${created.taskId}');return 1})()`)
  for (let i = 0; i < 20; i++) {
    await sleep(2500)
    const st = JSON.parse(await app.ev(`(async()=>{const r=await window.shopilot.task.list();const t=(Array.isArray(r.data)?r.data:[]).find(x=>x.id==='${created.taskId}');const run=t&&(t.latestRun||(t.runs||[])[0]||{});return JSON.stringify({status:run.status,code:run.errorCode,msg:run.errorMessage?String(run.errorMessage).slice(0,150):null,runId:run.id})})()`))
    if (['succeeded', 'failed', 'cancelled'].includes(st.status)) {
      console.log('status:', JSON.stringify(st))
      if (st.runId) console.log('payload:', await app.ev(`(async()=>{const res=await window.shopilot.task.results('${st.runId}');const norm=s=>(typeof s.payload==='string'?(()=>{try{return JSON.parse(s.payload)}catch{return {}}})():(s.payload||{}));return JSON.stringify((res.data.results||[]).map(norm).filter(p=>p.action))})()`))
      break
    }
  }
  // 页面证据
  const mock = await pickLive('8896')
  if (mock) {
    console.log('页面提示:', await mock.ev(`String(document.getElementById('hit').textContent)`))
    mock.close()
  }
  await app.ev(`(async()=>{await window.shopilot.task.delete('${created.taskId}');return 1})()`)
  app.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
