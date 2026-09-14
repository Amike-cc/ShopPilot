/**
 * 微信小店真实批量邀约（默认 10 位，可指定）——**真实发送，不可撤销**。
 *
 * 用法（必须显式给出真实联系方式，占位值会被拦下）：
 *   node run-wx-real-batch.js --contact="张三" --wechat="abc123" --phone="13800001111" --count=10
 *   node run-wx-real-batch.js --contact="张三" --wechat="abc123" --phone="13800001111" --force  // 允许占位值
 *
 * 与面板 buildAssistSteps 的流程一致（0.4.14 的行为 + 实测修正）：
 *   广场只导航+筛选一次 → loop 逐轮：useTab 回广场 → 取"还没邀约过的第一条"详情（followTab 跟新标签页，
 *   不关广场）→ 详情页等到按钮可点 → 「邀请带货」（同标签页跳转，故不配 followTab）→ 表单页 →
 *   读今日剩余额度 → 代填联系人/微信/手机/话术 → 按商品ID加商品 → 发送邀约 → 确认发送摇 → 复核表单被清空
 *   → 截图 → useTab 回广场（关掉详情/表单页）。本页取尽自动点「下一页」；额度为 0 / 翻不动 → 干净收尾。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'
const SQUARE_PATH = '/shop/findersquare/find'

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)=?(.*)$/.exec(a)
  return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true]
}))
const CONTACT = String(args.contact || '').trim()
const WECHAT = String(args.wechat || '').trim()
const PHONE = String(args.phone || '').trim()
const COUNT = Number(args.count || 10)
const PRODUCT_IDS = String(args.products || '10000687986563').split(/[\s,，;；]+/).filter(Boolean)
const SCRIPT = String(args.script || '您好，我们是店铺方，想邀请您合作带货：专属高佣 + 免费寄样，提供现成素材，发货售后我们全包。')
const FILTER_TYPE = args.finderType === undefined ? '直播带货者' : String(args.finderType)
const FILTER_CATS = String(args.cats || '母婴').split(/[\s,，;；]+/).filter(Boolean)
const FILTER_OTHER = String(args.other || '有联系方式').split(/[\s,，;；]+/).filter(Boolean)

// ---------- 安全阀：占位值不发 ─----------
const PLACEHOLDER = /^(测试联系人|test_wx_001|13800000000|测试|test)$/i
const looksPlaceholder = /测试|test/i.test(CONTACT) || /test/i.test(WECHAT) || /^1(3[0]|4[5-9]|5[0-35-9]|6[2567]|7[0-8]|8[0-9]|9[0-35-9])\d{8}$/.test(PHONE) === false
if (!CONTACT || !WECHAT || !PHONE) {
  console.error('缺少真实联系方式：--contact / --wechat / --phone 都要给（微信与手机号平台都必填）')
  process.exit(2)
}
if (!/^\d{11}$/.test(PHONE)) {
  console.error(`手机号看着不像 11 位：${PHONE}`)
  process.exit(2)
}
if ((PLACEHOLDER.test(CONTACT) || /test/i.test(WECHAT) || /^(1380|13800)000000$/.test(PHONE)) && !args.force) {
  console.error('拒绝用占位联系方式发真实邀约（要强行跑请加 --force）')
  process.exit(2)
}
if (!Number.isFinite(COUNT) || COUNT < 1 || COUNT > 200) {
  console.error(`--count 不合法：${args.count}`)
  process.exit(2)
}

const ROUND = [
  { type: 'useTab', input: { path: SQUARE_PATH }, timeoutMs: 30000 },
  { type: 'waitForText', input: { text: '详情', deep: true }, timeoutMs: 30000 },
  {
    type: 'clickByText',
    input: {
      text: '详情', deep: true, mode: 'real', nth: 'unvisited',
      missingCode: 'TASK_PAGE_EXHAUSTED',
      followTab: { urlIncludes: 'finder-detail', closeOld: false }
    },
    timeoutMs: 40000
  },
  { type: 'waitForPage', input: { urlIncludes: 'finder-detail' }, timeoutMs: 45000 },
  // 详情页刚到时按钮已在 DOM 里但 SPA 可能还没挂事件 → 先等稳定再点（实测点早了会被丢弃）
  { type: 'waitMs', input: { ms: 4000 }, timeoutMs: 20000 },
  { type: 'clickByText', input: { text: '邀请带货', deep: true, mode: 'real' }, timeoutMs: 30000 },
  { type: 'waitForPage', input: { urlIncludes: 'initiate-invite' }, timeoutMs: 45000 },
  { type: 'requireQuota', input: { textIncludes: '今日剩余', min: 1, metric: 'invite.quota', deep: true }, timeoutMs: 30000 },
  { type: 'typeText', input: { selector: 'input[placeholder*="邀约联系人"]', text: CONTACT, deep: true }, timeoutMs: 30000 },
  { type: 'typeText', input: { selector: 'input[placeholder*="微信号"]', text: WECHAT, deep: true }, timeoutMs: 30000 },
  { type: 'typeText', input: { selector: 'input[placeholder*="手机号码"]', text: PHONE, deep: true }, timeoutMs: 30000 },
  { type: 'typeText', input: { selector: 'textarea[placeholder*="合作说明"]', text: SCRIPT, deep: true }, timeoutMs: 30000 },
  { type: 'ensureRowsById', input: { rowsSelector: 'tbody tr', checkboxSelector: 'tbody label.weui-desktop-form__check-label', addText: '添加商品', confirmText: '确认', productIds: PRODUCT_IDS, deep: true }, timeoutMs: 120000 },
  { type: 'clickByText', input: { text: '发送邀约', deep: true, mode: 'real' }, timeoutMs: 20000 },
  { type: 'waitForText', input: { text: '确认发送邀约', deep: true }, timeoutMs: 25000 },
  { type: 'clickByText', input: { text: '确认', deep: true, mode: 'real' }, timeoutMs: 20000 },
  { type: 'waitForGone', input: { selector: 'tbody tr', deep: true }, timeoutMs: 30000 },
  { type: 'screenshot', input: {}, timeoutMs: 20000 },
  { type: 'useTab', input: { path: SQUARE_PATH }, timeoutMs: 30000 }
]

const opening = [
  { type: 'navigate', input: { url: SQUARE }, timeoutMs: 45000 },
  { type: 'waitForPage', input: { urlIncludes: 'findersquare/find' }, timeoutMs: 45000 }
]
if (FILTER_TYPE) opening.push({ type: 'clickByText', input: { text: FILTER_TYPE, deep: true, mode: 'real' }, timeoutMs: 25000 })
for (const c of FILTER_CATS) opening.push({ type: 'clickByText', input: { text: c, deep: true, mode: 'real', missingCode: 'TASK_SELECTION_SHORTFALL' }, timeoutMs: 25000 })
for (const f of FILTER_OTHER) opening.push({ type: 'clickByText', input: { text: f, deep: true, mode: 'real' }, timeoutMs: 25000 })

const STEPS = [
  ...opening,
  {
    type: 'loop',
    input: {
      label: `真实邀约 · ${CONTACT} · 最多 ${COUNT} 位`.slice(0, 60),
      maxRounds: COUNT,
      stopOn: ['TASK_QUOTA_EXCEEDED', 'TASK_SELECTION_SHORTFALL'],
      onCode: [{
        code: 'TASK_PAGE_EXHAUSTED',
        limit: 10,
        steps: [
          {
            type: 'clickByText',
            input: { text: '下一页', deep: true, mode: 'real', missingCode: 'TASK_SELECTION_SHORTFALL', disabledCode: 'TASK_SELECTION_SHORTFALL' },
            timeoutMs: 20000
          },
          { type: 'waitMs', input: { ms: 2500 }, timeoutMs: 15000 }
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
  const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++seq; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400))
    return r.result.value
  }
  return { ev }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const TITLE = `真实邀约 · 微信小店 · ${CONTACT}`

async function main() {
  console.log(`真实邀约即将开始：联系人=${CONTACT} 微信=${WECHAT} 手机=${PHONE} 商品=${PRODUCT_IDS.join(',')}`)
  console.log(`筛选：类型=${FILTER_TYPE || '(不筛)'} 类目=${FILTER_CATS.join('/') || '(不筛)'} 其他=${FILTER_OTHER.join('/') || '(不筛)'}；最多 ${COUNT} 位`)
  const app = await connect()
  console.log('打开店铺窗口:', await app.ev(`(async()=>{const r=await window.shopilot.browser.open('${STORE}');return r.ok})()`))
  await sleep(3000)
  await app.ev(`(async()=>{await window.shopilot.browser.setViewport({x:0,y:0,width:1380,height:840});return 1})()`)
  await sleep(1500)

  // 清掉历史遗留标签页（多个 find 页会让 useTab 切到旧页；详情页堆着也乱）
  const tabs = JSON.parse(await app.ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify(((r.data&&r.data.tabs)||[]).map(t=>t.id))})()`))
  console.log('清理标签页:', tabs.length, '个')
  for (const id of tabs) await app.ev(`(async()=>{await window.shopilot.browser.tab.close('${STORE}','${id}');return 1})()`).catch(() => {})
  await sleep(2000)

  const old = JSON.parse(await app.ev(`(async()=>{const r=await window.shopilot.task.list();return JSON.stringify((Array.isArray(r.data)?r.data:[]).filter(t=>String(t.name).startsWith('真实邀约 · 微信小店')).map(t=>t.id))})()`))
  for (const id of old) await app.ev(`(async()=>{await window.shopilot.task.delete('${id}');return 1})()`).catch(() => {})

  const created = JSON.parse(await app.ev(`(async () => {
    const r = await window.shopilot.task.create({ name: ${JSON.stringify(TITLE)}, storeScope: '${STORE}', steps: ${JSON.stringify(STEPS)} })
    return JSON.stringify({ ok: r.ok, taskId: r.data && r.data.id, err: r.error && r.error.message })
  })()`))
  console.log('create:', JSON.stringify(created))
  if (!created.ok) process.exit(1)
  console.log('run:', await app.ev(`(async()=>{const r=await window.shopilot.task.run('${created.taskId}');return JSON.stringify({ok:r.ok,err:r.error&&r.error.message})})()`))

  const startedAt = Date.now()
  let lastStatus = ''
  let runId = null
  let invited = 0
  while (true) {
    await sleep(4000)
    const st = JSON.parse(await app.ev(`(async () => {
      const r = await window.shopilot.task.list()
      const t = (Array.isArray(r.data) ? r.data : []).find(x => x.id === '${created.taskId}')
      if (!t) return JSON.stringify({ gone: true })
      const run = t.latestRun || (t.runs || [])[0] || {}
      return JSON.stringify({ status: run.status, code: run.errorCode, msg: run.errorMessage ? String(run.errorMessage).slice(0, 240) : null, runId: run.id, step: run.currentStep })
    })()`))
    if (st.runId) runId = st.runId
    // 用额度递减做实时进度（每成功一轮，额度 -1）
    const q = await app.ev(`(async () => {
      const tabs = await window.shopilot.browser.tab.list('${STORE}')
      return null
    })()`).catch(() => null)
    if (st.status !== lastStatus) {
      console.log(new Date().toLocaleTimeString(), JSON.stringify({ status: st.status, code: st.code, msg: st.msg, step: st.step }), `已跑 ${Math.round((Date.now() - startedAt) / 1000)}s`)
      lastStatus = st.status
    } else {
      process.stdout.write(`\r  运行中… ${Math.round((Date.now() - startedAt) / 1000)}s  `)
    }
    if (['succeeded', 'failed', 'cancelled'].includes(st.status)) {
      console.log('\n=== 结束 ===')
      console.log(await app.ev(`(async () => {
        const res = await window.shopilot.task.results('${st.runId}')
        const norm = s => (typeof s.payload === 'string' ? (() => { try { return JSON.parse(s.payload) } catch { return {} } })() : (s.payload || {}))
        const all = (res.data.results || []).map(norm)
        const loop = all.find(p => p.action === 'loop') || {}
        return JSON.stringify({ completedRounds: loop.completedRounds, stopReason: loop.stopReason, rounds: (loop.rounds || []).map(r => ({ round: r.round, ok: r.ok, stop: r.stop || null, ms: r.ms })) }, null, 1)
      })()`))
      break
    }
  }
  console.log('仍未结束（可在面板查看）')
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
