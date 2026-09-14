/**
 * 用仿真广场验证微信"逐轮换人 + 翻页"的完整语义（不碰真实店铺、不发送）：
 *   广场只加载一次（会洗牌）→ 每轮 useTab 回到广场 → nth:'unvisited' 取一位没邀约过的达人 →
 *   详情 → 邀请带货 → 表单提交 → 回广场；本页取完 → onCode 点「下一页」→ 继续，直到翻不动。
 * 期望：12 位达人各被邀约恰好一次（无重复、无遗漏），loop 以 TASK_SELECTION_SHORTFALL 收工。
 * 用法：node verify-paging-mock.js
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_TEST_STORE || 'store_3b4c2823d4d9cf6d0bdea96882ce38cc'
const MOCK = 'http://127.0.0.1:8895'
const SQUARE = MOCK + '/mock-square'

const ROUND = [
  { type: 'useTab', input: { path: '/mock-square' }, timeoutMs: 30000 },
  { type: 'waitForText', input: { text: '详情', deep: true }, timeoutMs: 25000 },
  {
    type: 'clickByText',
    input: { text: '详情', deep: true, mode: 'real', nth: 'unvisited', missingCode: 'TASK_PAGE_EXHAUSTED', followTab: { urlIncludes: 'finder-detail', closeOld: false } },
    timeoutMs: 30000
  },
  { type: 'waitForPage', input: { urlIncludes: 'finder-detail' }, timeoutMs: 30000 },
  { type: 'readText', input: { selector: '#row', metric: 'detail.row', deep: true }, timeoutMs: 15000 },
  {
    type: 'clickByText',
    input: { text: '邀请带货', deep: true, mode: 'real', followTab: { urlIncludes: 'initiate-invite' } },
    timeoutMs: 30000
  },  { type: 'waitForPage', input: { urlIncludes: 'initiate-invite' }, timeoutMs: 30000 },
  { type: 'requireQuota', input: { textIncludes: '今日剩余', min: 1, metric: 'invite.quota', deep: true }, timeoutMs: 15000 },
  // 联系电话/话术（用 typeText 可以，但仿真页用 setInput 更快；这里只为验证流程骨架）
  { type: 'setInput', input: { selector: 'textarea', text: '仿真邀约话术' }, timeoutMs: 15000 },
  { type: 'clickByText', input: { text: '发送邀约', deep: true, mode: 'real' }, timeoutMs: 20000 },
  { type: 'screenshot', input: {}, timeoutMs: 20000 },
  { type: 'useTab', input: { path: '/mock-square' }, timeoutMs: 30000 }
]

const STEPS = [
  { type: 'navigate', input: { url: SQUARE }, timeoutMs: 30000 },
  { type: 'waitForPage', input: { urlIncludes: 'mock-square' }, timeoutMs: 30000 },
  {
    type: 'loop',
    input: {
      label: '仿真 · 逐轮换人 + 翻页',
      maxRounds: 30,
      stopOn: ['TASK_QUOTA_EXCEEDED', 'TASK_SELECTION_SHORTFALL'],
      onCode: [{
        code: 'TASK_PAGE_EXHAUSTED',
        limit: 10,
        steps: [
          {
            type: 'clickByText',
            input: {
              text: '下一页', deep: true, mode: 'real',
              missingCode: 'TASK_SELECTION_SHORTFALL',
              disabledCode: 'TASK_SELECTION_SHORTFALL'
            },
            timeoutMs: 20000
          },
          { type: 'waitMs', input: { ms: 1200 }, timeoutMs: 15000 }
        ]
      }],
      steps: ROUND
    }
  }
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
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400))
    return r.result.value
  }
  return { ev }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const TITLE = '仿真 · 逐轮换人+翻页'

async function main() {
  await fetch(MOCK + '/reset').catch(() => {})
  const app = await connect()
  console.log('打开店铺窗口:', await app.ev(`(async()=>{const r=await window.shopilot.browser.open('${STORE}');return r.ok})()`))
  await sleep(2500)
  await app.ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1380,height:840});return 1})()`)
  await sleep(1200)
  // 清掉重启后恢复的旧标签页（它们会重新请求 mock 页面，污染服务端统计）
  const staleTabs = JSON.parse(await app.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>t.id))})()`))
  for (const id of staleTabs) await app.ev(`(async()=>{await window.shopilot.browser.tab.close('${STORE}','${id}');return 1})()`).catch(() => {})
  await sleep(1500)
  await fetch(MOCK + '/reset').catch(() => {})
  const old = JSON.parse(await app.ev(`(async()=>{const r=await window.shopilot.task.list();return JSON.stringify((Array.isArray(r.data)?r.data:[]).filter(t=>t.name==='${TITLE}').map(t=>t.id))})()`))
  for (const id of old) await app.ev(`(async()=>{await window.shopilot.task.delete('${id}');return 1})()`).catch(() => {})

  const created = JSON.parse(await app.ev(`(async () => {
    const r = await window.shopilot.task.create({ name: '${TITLE}', storeScope: '${STORE}', steps: ${JSON.stringify(STEPS)} })
    return JSON.stringify({ ok: r.ok, taskId: r.data && r.data.id, err: r.error && r.error.message })
  })()`))
  console.log('create:', JSON.stringify(created))
  if (!created.ok) process.exit(1)
  console.log('run:', await app.ev(`(async()=>{const r=await window.shopilot.task.run('${created.taskId}');return JSON.stringify({ok:r.ok,err:r.error&&r.error.message})})()`))

  for (let i = 0; i < 80; i++) {
    await sleep(2500)
    const st = JSON.parse(await app.ev(`(async () => {
      const r = await window.shopilot.task.list()
      const t = (Array.isArray(r.data) ? r.data : []).find(x => x.id === '${created.taskId}')
      if (!t) return JSON.stringify({ gone: true })
      const run = t.latestRun || (t.runs || [])[0] || {}
      return JSON.stringify({ status: run.status, code: run.errorCode, msg: run.errorMessage ? String(run.errorMessage).slice(0, 220) : null, runId: run.id })
    })()`))
    if (['succeeded', 'failed', 'cancelled'].includes(st.status)) {
      console.log(new Date().toLocaleTimeString(), JSON.stringify(st))
      console.log('loop 汇总:', await app.ev(`(async () => {
        const res = await window.shopilot.task.results('${st.runId}')
        const norm = s => (typeof s.payload === 'string' ? (() => { try { return JSON.parse(s.payload) } catch { return {} } })() : (s.payload || {}))
        const all = (res.data.results || []).map(norm)
        const loop = all.find(p => p.action === 'loop') || {}
        return JSON.stringify({ completedRounds: loop.completedRounds, stopReason: loop.stopReason, onCode: loop.onCode, 每轮取到的第几条: all.filter(p => p.picked).map(p => p.picked), 读到的达人: all.filter(p => p.metric === 'detail.row').map(p => p.text) })
      })()`))
      break
    }
  }
  const state = JSON.parse(await (await fetch(MOCK + '/state')).text())
  const opened = state.detailOpened
  const invited = state.inviteOpened
  const dup = opened.filter((v, i) => opened.indexOf(v) !== i)
  console.log('服务端记录 detailOpened:', JSON.stringify(opened))
  console.log('服务端记录 inviteOpened:', JSON.stringify(invited))
  console.log('去重后详情:', [...new Set(opened)].length, '位；表单:', [...new Set(invited)].length, '位；重复:', JSON.stringify(dup), '；翻页次数:', state.clicks.filter(c => c.action === 'page').length)
  console.log('名单顺序:', JSON.stringify(state.shuffled))
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
