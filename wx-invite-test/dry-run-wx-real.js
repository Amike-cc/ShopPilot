/**
 * 真实广场「干跑」：把微信邀约流程走到**发送之前**就停（不点发送、不点确认，绝不真实邀约）。
 * 目的：在真实站点上验证新机制——开头导航+筛选 → useTab 回广场 → nth:'unvisited' 取人 →
 * followTab 跟详情 → 邀请带货 → 表单页 → 读今日剩余额度 → 填联系人/微信/手机/话术 → 按商品ID加商品。
 * 顺便报出今日真实剩余邀请机会，作为真实批量的依据。
 * 用法：node dry-run-wx-real.js
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'
const WECHAT = 'https://store.weixin.qq.com/shop/findersquare/find'

// 与 buildAssistSteps 一致，但**在发送前截断**（不含 发送邀约 / 确认 / waitForGone）
const ROUND = [
  { type: 'useTab', input: { path: '/shop/findersquare/find' }, timeoutMs: 30000 },
  { type: 'waitForText', input: { text: '详情', deep: true }, timeoutMs: 30000 },
  { type: 'clickByText', input: { text: '详情', deep: true, mode: 'real', nth: 'unvisited', missingCode: 'TASK_PAGE_EXHAUSTED', followTab: { urlIncludes: 'finder-detail', closeOld: false } }, timeoutMs: 40000 },
  { type: 'waitForPage', input: { urlIncludes: 'finder-detail' }, timeoutMs: 45000 },
  { type: 'waitForText', input: { text: '邀请带货', deep: true }, timeoutMs: 30000 },
  { type: 'waitMs', input: { ms: 5000 }, timeoutMs: 20000 },
  // 实测：详情页的「邀请带货」是普通 BUTTON，点击后**同标签页 pushState** 到 initiate-invite
  // （不是 window.open）——所以这里不能配 followTab，否则会白等 40s 新标签页
  { type: 'clickByText', input: { text: '邀请带货', deep: true, mode: 'real' }, timeoutMs: 30000 },
  { type: 'waitMs', input: { ms: 4000 }, timeoutMs: 15000 },
  { type: 'screenshot', input: {}, timeoutMs: 20000 },
  { type: 'readText', input: { selector: 'body', metric: 'diag.body', deep: false }, timeoutMs: 15000 },
  { type: 'waitForPage', input: { urlIncludes: 'initiate-invite' }, timeoutMs: 45000 },
  { type: 'requireQuota', input: { textIncludes: '今日剩余', min: 1, metric: 'invite.quota', deep: true }, timeoutMs: 30000 },
  { type: 'typeText', input: { selector: 'input[placeholder*="邀约联系人"]', text: '干跑不发送', deep: true }, timeoutMs: 30000 },
  { type: 'typeText', input: { selector: 'input[placeholder*="微信号"]', text: 'dry_run_wx', deep: true }, timeoutMs: 30000 },
  { type: 'typeText', input: { selector: 'input[placeholder*="手机号码"]', text: '13800000000', deep: true }, timeoutMs: 30000 },
  { type: 'typeText', input: { selector: 'textarea[placeholder*="合作说明"]', text: '干跑验证话术，不发出去', deep: true }, timeoutMs: 30000 },
  { type: 'ensureRowsById', input: { rowsSelector: 'tbody tr', checkboxSelector: 'tbody label.weui-desktop-form__check-label', addText: '添加商品', confirmText: '确认', productIds: ['10000687986563'], deep: true }, timeoutMs: 120000 },
  { type: 'screenshot', input: {}, timeoutMs: 20000 }
]

const STEPS = [
  { type: 'navigate', input: { url: SQUARE }, timeoutMs: 45000 },
  { type: 'waitForPage', input: { urlIncludes: 'findersquare/find' }, timeoutMs: 45000 },
  { type: 'clickByText', input: { text: '直播带货者', deep: true, mode: 'real' }, timeoutMs: 25000 },
  { type: 'clickByText', input: { text: '母婴', deep: true, mode: 'real', missingCode: 'TASK_SELECTION_SHORTFALL' }, timeoutMs: 25000 },
  { type: 'clickByText', input: { text: '有联系方式', deep: true, mode: 'real' }, timeoutMs: 25000 },
  { type: 'loop', input: { label: '干跑（发送前截断）', maxRounds: 1, stopOn: ['TASK_QUOTA_EXCEEDED', 'TASK_SELECTION_SHORTFALL'], onCode: [{ code: 'TASK_PAGE_EXHAUSTED', limit: 10, steps: [{ type: 'clickByText', input: { text: '下一页', deep: true, mode: 'real', missingCode: 'TASK_SELECTION_SHORTFALL', disabledCode: 'TASK_SELECTION_SHORTFALL' }, timeoutMs: 20000 }, { type: 'waitMs', input: { ms: 2500 }, timeoutMs: 15000 }] }], steps: ROUND } }
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
  const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++seq; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400))
    return r.result.value
  }
  return { ev }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const TITLE = '微信干跑 · 发送前截断（不真实邀约）'

async function main() {
  const app = await connect()
  console.log('打开店铺窗口:', await app.ev(`(async()=>{const r=await window.shopilot.browser.open('${STORE}');return r.ok})()`))
  await sleep(3000)
  await app.ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1380,height:840});return 1})()`)
  await sleep(1500)
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
    await sleep(3000)
    const st = JSON.parse(await app.ev(`(async () => {
      const r = await window.shopilot.task.list()
      const t = (Array.isArray(r.data) ? r.data : []).find(x => x.id === '${created.taskId}')
      if (!t) return JSON.stringify({ gone: true })
      const run = t.latestRun || (t.runs || [])[0] || {}
      return JSON.stringify({ status: run.status, code: run.errorCode, msg: run.errorMessage ? String(run.errorMessage).slice(0, 240) : null, runId: run.id, step: run.currentStep })
    })()`))
    console.log(new Date().toLocaleTimeString(), JSON.stringify(st))
    if (['succeeded', 'failed', 'cancelled'].includes(st.status)) {
      console.log('结果:', await app.ev(`(async () => {
        const res = await window.shopilot.task.results('${st.runId}')
        const norm = s => (typeof s.payload === 'string' ? (() => { try { return JSON.parse(s.payload) } catch { return {} } })() : (s.payload || {}))
        const all = (res.data.results || []).map(norm)
        return JSON.stringify({
          额度: all.filter(p => p.metric === 'invite.quota').map(p => p.value),
          诊断正文: all.filter(p => p.metric === 'diag.body').map(p => String(p.text || '').replace(/\s+/g, ' ').slice(0, 220)),
          商品步骤: all.filter(p => p.action === 'ensureRowsById'),
          loop: (all.find(p => p.action === 'loop') || {})
        }, null, 1)
      })()`))
      break
    }
  }
  console.log('—— 干跑结束（未发送任何邀约）——')
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
