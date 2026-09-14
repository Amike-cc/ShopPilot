/** 真机验证 ensureRowsById：指定商品ID → 弹窗里只勾中该行 → 确认后页面出现该商品 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'
const MOCK = `http://127.0.0.1:8897/?v=${Date.now()}`
const TARGET_ID = '10000687986402'

const STEPS = [
  { type: 'navigate', input: { url: MOCK }, timeoutMs: 30000 },
  { type: 'waitForPage', input: { urlIncludes: '127.0.0.1:8897' }, timeoutMs: 20000 },
  { type: 'waitForText', input: { text: '邀约商品', deep: true }, timeoutMs: 20000 },
  {
    type: 'ensureRowsById',
    input: {
      rowsSelector: '#picked tr',
      checkboxSelector: '#rows label.weui-desktop-form__check-label',
      addText: '添加商品',
      confirmText: '确认',
      productIds: [TARGET_ID],
      deep: true
    },
    timeoutMs: 60000
  },
  { type: 'readText', input: { selector: '#cnt', metric: 'invite.mock.count' }, timeoutMs: 15000 }
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
    try {
      const r = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
      if (r.result?.value > 0) {
        return {
          ev: async (expr) => {
            const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
            if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 250))
            return res.result.value
          },
          close: () => ws.close()
        }
      }
    } catch { /* next */ }
    ws.close()
  }
  return null
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const app = await pickLive('index.html')
  if (!app) throw new Error('no app page')
  await app.ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
  await sleep(3000)
  const created = JSON.parse(await app.ev(`(async () => {
    const r = await window.shopilot.task.create({ name: '验证 · 指定商品ID', storeScope: '${STORE}', steps: ${JSON.stringify(STEPS)} })
    return JSON.stringify({ ok: r.ok, taskId: r.data && r.data.id, err: r.error && r.error.message })
  })()`))
  console.log('create:', JSON.stringify(created))
  if (!created.ok) process.exit(1)
  await app.ev(`(async()=>{await window.shopilot.task.run('${created.taskId}');return 1})()`)

  for (let i = 0; i < 40; i++) {
    await sleep(3000)
    const st = JSON.parse(await app.ev(`(async () => {
      const r = await window.shopilot.task.list()
      const all = Array.isArray(r.data) ? r.data : []
      const t = all.find(x => x.id === '${created.taskId}')
      if (!t) return JSON.stringify({ gone: true })
      const run = t.latestRun || (t.runs || [])[0] || {}
      return JSON.stringify({ status: run.status, code: run.errorCode, msg: run.errorMessage ? String(run.errorMessage).slice(0, 140) : null, runId: run.id })
    })()`))
    console.log(new Date().toLocaleTimeString(), JSON.stringify(st))
    if (['succeeded', 'failed', 'cancelled'].includes(st.status)) {
      if (st.runId) {
        console.log('PAYLOAD:', await app.ev(`(async () => {
          const res = await window.shopilot.task.results('${st.runId}')
          const steps = res.data.results || []
          const norm = s => (typeof s.payload === 'string' ? (() => { try { return JSON.parse(s.payload) } catch { return {} } })() : (s.payload || {}))
          return JSON.stringify(steps.map(norm).filter(p => p.action))
        })()`))
      }
      break
    }
  }
  app.close()
  await sleep(1000)
  const mock = await pickLive('127.0.0.1:8897')
  if (mock) {
    const st = await mock.ev(`(function(){
      var picked=[].map.call(document.querySelectorAll('#picked tr'),function(tr){return tr.getAttribute('data-row-key')})
      var checked=[].map.call(document.querySelectorAll('#rows input:checked'),function(cb){return cb.getAttribute('data-id')})
      var dlgOpen=document.getElementById('dlg').classList.contains('open')
      var cnt=String(document.getElementById('cnt').textContent)
      return JSON.stringify({pickedRows:picked,checkedInDialog:checked,dlgOpen:dlgOpen,cnt:cnt})})()`)
    console.log('mock form state:', st)
    const s = JSON.parse(st)
    const pass = s.pickedRows.includes(TARGET_ID) && !s.dlgOpen
    console.log(pass ? 'PRODUCT BY ID OK' : 'PRODUCT BY ID FAILED')
    mock.close()
    process.exit(pass ? 0 : 1)
  }
  process.exit(1)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
