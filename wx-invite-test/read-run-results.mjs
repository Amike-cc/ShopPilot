/** 读回指定 run 的步骤结果（引擎落库的真实凭据），并清理堆积的快手标签页。 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const RUN = process.argv[2]
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}
if (RUN) {
  console.log('=== run', RUN, '的步骤结果 ===')
  const res = await ev("(async () => { const r = await window.shopilot.task.results(" + JSON.stringify(RUN) + "); return JSON.stringify(r) })()")
  const parsed = (() => { try { return JSON.parse(res) } catch { return null } })()
  if (parsed && parsed.ok) {
    const rows = parsed.data.results || parsed.data
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const p = typeof r.payload === 'string' ? r.payload : JSON.stringify(r.payload)
      console.log(`  [${r.stepIndex}] ${r.kind} ${String(p).slice(0, 220)}`)
    }
    console.log('工件:', JSON.stringify(parsed.data.artifacts || []).slice(0, 400))
  } else {
    console.log(String(res).slice(0, 600))
  }
}

console.log('\n=== 清理堆积的快手标签页（只留一个） ===')
const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const ks = stores.find(x => String(x.platform).includes('快手'))
const tabs = JSON.parse(await ev("(async () => { const r = await window.shopilot.browser.tab.list(" + JSON.stringify(ks.id) + "); const t = (r.data && r.data.tabs) || []; return JSON.stringify(t.map(x => ({ id: x.id, u: String(x.url||'') }))) })()"))
console.log('当前标签页数:', tabs.length)
// 保留最后一个 daren 页 + home 页，其余关掉
const keep = new Set()
const darens = tabs.filter(t => t.u.includes('daren'))
if (darens.length) keep.add(darens[darens.length - 1].id)
for (const t of tabs) {
  if (keep.has(t.id)) continue
  if (!darens.length && t.u.includes('kwaixiaodian') && !keep.size) { keep.add(t.id); continue }
  const r = await ev("(async () => { const r = await window.shopilot.browser.tab.close(" + JSON.stringify(ks.id) + ", " + JSON.stringify(t.id) + "); return JSON.stringify(r) })()")
  console.log('  关闭', t.id.slice(0, 14), String(r).slice(0, 40))
  await sleep(400)
}
const after = JSON.parse(await ev("(async () => { const r = await window.shopilot.browser.tab.list(" + JSON.stringify(ks.id) + "); const t = (r.data && r.data.tabs) || []; return JSON.stringify(t.length) })()"))
console.log('清理后标签页数:', after)
ws.close()
setTimeout(() => process.exit(0), 300)
