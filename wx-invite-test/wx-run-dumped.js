/**
 * 真机执行导出的微信邀约步骤（真实发送，无门禁）：
 *  - 创建任务并运行
 *  - 逐轮记录目标达人（finderUsername），发现连续重复立即停止
 *  - 运行结束打印 loop 汇总（轮数/停止原因）
 */
const fs = require('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'
const STEPS = JSON.parse(fs.readFileSync('wx-invite-test/wx-steps.json', 'utf8'))

async function pickLive(urlPart) {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  for (const t of list.filter(x => x.type === 'page' && x.url.includes(urlPart))) {
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
    let s = 0
    const pend = new Map()
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
    const r = await (new Promise((ok, err) => {
      const id = ++s
      pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: 'window.innerWidth', returnByValue: true } }))
    }))
    if (r.result?.value > 0) {
      return {
        ev: async (expr) => (await new Promise((ok, err) => {
          const id = ++s
          pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result?.result?.value))
          ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true } }))
        })),
        close: () => ws.close()
      }
    }
    ws.close()
  }
  return null
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const app = await pickLive('index.html')
  if (!app) throw new Error('no app')
  const created = JSON.parse(await app.ev(`(async () => {
    const r = await window.shopilot.task.create({ name: '达人邀约 · 微信小店 · 逐个邀约（真机批次）', storeScope: '${STORE}', steps: ${JSON.stringify(STEPS)} })
    return JSON.stringify({ ok: r.ok, taskId: r.data && r.data.id, err: r.error && r.error.message })
  })()`))
  console.log('create:', JSON.stringify(created))
  if (!created.ok) process.exit(1)
  console.log('run:', await app.ev(`(async()=>{const r=await window.shopilot.task.run('${created.taskId}');return JSON.stringify({ok:r.ok,err:r.error&&r.error.message,waiting:r.data&&r.data.waitingForStore})})()`))

  const seen = []
  const t0 = Date.now()
  let lastStatus = ''
  while (Date.now() - t0 < 30 * 60000) {
    await sleep(2500)
    const st = JSON.parse(await app.ev(`(async () => {
      const r = await window.shopilot.task.list()
      const all = Array.isArray(r.data) ? r.data : []
      const t = all.find(x => x.id === '${created.taskId}')
      const run = t && (t.latestRun || (t.runs || [])[0] || {})
      return JSON.stringify({ status: run.status, code: run.errorCode, msg: run.errorMessage ? String(run.errorMessage).slice(0, 160) : null, runId: run.id, currentStep: run.currentStep })
    })()`))
    const urls = JSON.parse(await app.ev(`(async()=>{const r=await window.shopilot.tab?1:1;const t=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify((t.data.tabs||[]).map(x=>String(x.url||'')))})()`))
    const det = urls.find(u => u.includes('finderUsername='))
    if (det) {
      const m = /finderUsername=([A-Za-z0-9_\-]+)/.exec(det)
      if (m && (seen.length === 0 || seen[seen.length - 1].u !== m[1])) {
        seen.push({ u: m[1], at: new Date().toLocaleTimeString() })
        console.log(`  [第 ${seen.length} 位] ${m[1].slice(0, 22)}… @ ${new Date().toLocaleTimeString()}`)
      }
    }
    if (st.status !== lastStatus) { console.log(new Date().toLocaleTimeString(), JSON.stringify({ status: st.status, code: st.code, msg: st.msg, step: st.currentStep })); lastStatus = st.status }
    // 连续两轮同一达人 → 立刻停
    if (seen.length >= 2 && seen[seen.length - 1].u === seen[seen.length - 2].u) {
      console.log('⚠ 连续两轮同一达人，立即停止')
      await app.ev(`(async()=>{await window.shopilot.task.cancel('${st.runId}');return 1})()`)
      break
    }
    if (['succeeded', 'failed', 'cancelled'].includes(st.status)) {
      console.log('loop 汇总:', await app.ev(`(async () => {
        const res = await window.shopilot.task.results('${st.runId}')
        const steps = res.data.results || []
        const norm = s => (typeof s.payload === 'string' ? (() => { try { return JSON.parse(s.payload) } catch { return {} } })() : (s.payload || {}))
        return JSON.stringify(steps.map(norm).find(p => p.action === 'loop') || {})
      })()`))
      break
    }
  }
  console.log('触及达人轮数:', seen.length)
  app.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
