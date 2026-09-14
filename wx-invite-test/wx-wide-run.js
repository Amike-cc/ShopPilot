/** 把店铺视口拉宽后再跑整批（微信平台在窄视口下布局会重叠） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'
const W = Number(process.argv[2] || 1380)
const H = Number(process.argv[3] || 840)
const MAX_MINUTES = Number(process.argv[4] || 35)

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
      return {
        ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value,
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
  console.log('视口:', await app.ev(`(async()=>{const r=await window.shopilot.browser.setViewport({x:0,y:0,width:${W},height:${H}});return JSON.stringify(r.ok)})()`))
  await sleep(2500)
  const sqInfo = await app.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify((r.data.tabs||[]).map(x=>String(x.url||'').slice(0,60)))})()`)
  console.log('标签页:', sqInfo)
  const startAt = Date.now()
  const beforeIds = JSON.parse(await app.ev(`(async()=>{const r=await window.shopilot.task.list();return JSON.stringify((Array.isArray(r.data)?r.data:[]).map(t=>t.id))})()`))
  console.log('start:', await app.ev(`(()=>{const b=document.querySelector('[data-test=invite-start]');if(!b)return 'no-btn';if(b.disabled)return 'disabled';b.click();return 'clicked'})()`))
  let taskId = null
  for (let i = 0; i < 20 && !taskId; i++) {
    await sleep(1000)
    const ids = JSON.parse(await app.ev(`(async()=>{const r=await window.shopilot.task.list();return JSON.stringify((Array.isArray(r.data)?r.data:[]).map(t=>t.id))})()`))
    taskId = ids.find(x => !beforeIds.includes(x)) || null
  }
  console.log('taskId:', taskId)
  if (!taskId) process.exit(1)
  const seen = []
  let lastStatus = ''
  let runId = null
  while (Date.now() - startAt < MAX_MINUTES * 60000) {
    await sleep(2500)
    const st = JSON.parse(await app.ev(`(async () => {
      const r = await window.shopilot.task.list()
      const all = Array.isArray(r.data) ? r.data : []
      const t = all.find(x => x.id === '${taskId}')
      const run = t && (t.latestRun || (t.runs || [])[0] || {})
      return JSON.stringify({ status: run.status, code: run.errorCode, msg: run.errorMessage ? String(run.errorMessage).slice(0, 170) : null, runId: run.id, step: run.currentStep })
    })()`))
    if (st.runId) runId = st.runId
    const urls = JSON.parse(await app.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify((r.data.tabs||[]).map(x=>String(x.url||'')))})()`))
    const det = urls.find(u => u.includes('finderUsername='))
    if (det) {
      const m = /finderUsername=([A-Za-z0-9_\-]+)/.exec(det)
      if (m && (seen.length === 0 || seen[seen.length - 1].u !== m[1])) {
        seen.push({ u: m[1], at: new Date().toLocaleTimeString() })
        console.log(`  [第 ${seen.length} 位] ${m[1].slice(0, 20)}…  用时 ${Math.round((Date.now() - startAt) / 1000)}s`)
      }
    }
    if (st.status !== lastStatus) {
      console.log(new Date().toLocaleTimeString(), JSON.stringify({ status: st.status, code: st.code, msg: st.msg, step: st.step }))
      lastStatus = st.status
    }
    if (seen.length >= 2 && seen[seen.length - 1].u === seen[seen.length - 2].u) {
      console.log('⚠ 连续两轮同一达人 → 立即停止')
      await app.ev(`(async()=>{await window.shopilot.task.cancel('${runId}');return 1})()`)
      break
    }
    if (['succeeded', 'failed', 'cancelled'].includes(st.status)) {
      console.log('loop 汇总:', await app.ev(`(async () => {
        const res = await window.shopilot.task.results('${runId}')
        const steps = res.data.results || []
        const norm = s => (typeof s.payload === 'string' ? (() => { try { return JSON.parse(s.payload) } catch { return {} } })() : (s.payload || {}))
        return JSON.stringify(steps.map(norm).find(p => p.action === 'loop') || {})
      })()`))
      break
    }
  }
  console.log('触及达人个数:', seen.length, '| 最终状态:', lastStatus)
  app.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
