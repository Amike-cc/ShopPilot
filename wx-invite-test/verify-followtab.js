/**
 * 真机验证 followTab（跟随新标签页）+「同文本副本」遮挡处理（不碰真实店铺）：
 *   仿真广场（表格 1640px + 右侧固定列镜像）→ 点「详情」（被镜像压住）→
 *   平台 window.open 新标签页 → 引擎跟随 → 详情页 → 点「邀请带货」→ 再跟随 → 表单页
 * 期望：run 成功；两次 readText 都读到同一个达人序号；结束后**没有**堆积标签页。
 * 用法：node verify-followtab.js
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_TEST_STORE || 'store_3b4c2823d4d9cf6d0bdea96882ce38cc'
const MOCK = 'http://127.0.0.1:8895'

const STEPS = [
  { type: 'navigate', input: { url: MOCK + '/mock-square' }, timeoutMs: 30000 },
  { type: 'waitForPage', input: { urlIncludes: 'mock-square' }, timeoutMs: 30000 },
  { type: 'waitForText', input: { text: '详情', deep: true }, timeoutMs: 30000 },
  // 第一跳：列表页自身不跳转，靠 window.open 开新标签页
  { type: 'clickByText', input: { text: '详情', deep: true, mode: 'real', followTab: { urlIncludes: 'finder-detail' } }, timeoutMs: 30000 },
  { type: 'waitForPage', input: { urlIncludes: 'finder-detail' }, timeoutMs: 30000 },
  { type: 'readText', input: { selector: '#row', metric: 'detail.row', deep: true }, timeoutMs: 15000 },
  // 第二跳：详情页的「邀请带货」也是 window.open
  { type: 'clickByText', input: { text: '邀请带货', deep: true, mode: 'real', followTab: { urlIncludes: 'initiate-invite' } }, timeoutMs: 30000 },
  { type: 'waitForPage', input: { urlIncludes: 'initiate-invite' }, timeoutMs: 30000 },
  { type: 'readText', input: { selector: '#row', metric: 'invite.row', deep: true }, timeoutMs: 15000 },
  { type: 'screenshot', input: {}, timeoutMs: 20000 }
]

async function connect() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
  const t = list.find(x => x.url.includes('out/renderer/index.html'))
  if (!t) throw new Error('没有找到应用主窗口页面')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let seq = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (method, params = {}) => new Promise((ok, err) => {
    const id = ++seq
    pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  return { ev }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const TITLE = '仿真 · followTab 新标签页跟随'

async function main() {
  await fetch(MOCK + '/reset').catch(() => {})
  const app = await connect()
  console.log('打开店铺窗口:', await app.ev(`(async()=>{const r=await window.shopilot.browser.open('${STORE}');return r.ok})()`))
  await sleep(2500)
  await app.ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1380,height:840});return 1})()`)
  await sleep(1200)

  // 清掉同名旧任务（重复跑不混淆）
  const old = JSON.parse(await app.ev(`(async()=>{const r=await window.shopilot.task.list();return JSON.stringify((Array.isArray(r.data)?r.data:[]).filter(t=>t.name==='${TITLE}').map(t=>t.id))})()`))
  for (const id of old) await app.ev(`(async()=>{await window.shopilot.task.delete('${id}');return 1})()`).catch(() => {})

  const tabsBefore = JSON.parse(await app.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>t.id))})()`))
  console.log('运行前标签页数:', tabsBefore.length)

  const created = JSON.parse(await app.ev(`(async () => {
    const r = await window.shopilot.task.create({ name: '${TITLE}', storeScope: '${STORE}', steps: ${JSON.stringify(STEPS)} })
    return JSON.stringify({ ok: r.ok, taskId: r.data && r.data.id, err: r.error && r.error.message })
  })()`))
  console.log('create:', JSON.stringify(created))
  if (!created.ok) process.exit(1)

  console.log('run:', await app.ev(`(async()=>{const r=await window.shopilot.task.run('${created.taskId}');return JSON.stringify({ok:r.ok,waiting:r.data&&r.data.waitingForStore,err:r.error&&r.error.message})})()`))

  let runId = null
  for (let i = 0; i < 40; i++) {
    await sleep(2500)
    const st = JSON.parse(await app.ev(`(async () => {
      const r = await window.shopilot.task.list()
      const t = (Array.isArray(r.data) ? r.data : []).find(x => x.id === '${created.taskId}')
      if (!t) return JSON.stringify({ gone: true })
      const run = t.latestRun || (t.runs || [])[0] || {}
      return JSON.stringify({ status: run.status, code: run.errorCode, msg: run.errorMessage, runId: run.id, step: run.currentStep })
    })()`))
    if (st.runId) runId = st.runId
    console.log(new Date().toLocaleTimeString(), JSON.stringify(st))
    if (['succeeded', 'failed', 'cancelled'].includes(st.status)) {
      const detail = await app.ev(`(async () => {
        const res = await window.shopilot.task.results('${st.runId}')
        const norm = s => (typeof s.payload === 'string' ? (() => { try { return JSON.parse(s.payload) } catch { return {} } })() : (s.payload || {}))
        return JSON.stringify((res.data.results || []).map(norm))
      })()`)
      console.log('PAYLOADS:', detail)
      break
    }
  }

  const tabsAfter = JSON.parse(await app.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>String(t.url||'')))})()`))
  console.log('运行后标签页:', JSON.stringify(tabsAfter, null, 1))
  console.log('标签页数 前/后:', tabsBefore.length, '/', tabsAfter.length)
  console.log('MOCK 服务端记录:', await (await fetch(MOCK + '/state')).text())
  const urls = JSON.parse(await app.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>String(t.url||'')))})()`))
  console.log('最终运行标签页地址:', urls.find(u => u.includes('initiate-invite')) || '(没有 initiate-invite 标签页)')
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
