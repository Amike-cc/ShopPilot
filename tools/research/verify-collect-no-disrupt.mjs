/**
 * 验证「采集数据时不影响浏览器使用」：采集期间采样**用户视图**（显示中的店铺 / 活动标签页 / 标签栏）
 * 有没有被改动。
 *
 * 背景（2026-10-15 用户要求）：任务式采集（发票/涉税/主体）以前建的是**普通标签页**并在每步开头
 * `activateTab`，于是采集一开始就把用户正在看的页面切走、标签栏还多出一个页。现在改成
 * **采集专用页**（`createTab(..., { activate:false, internal:true })`）：渲染层隐藏挂载，
 * 不进标签栏、不占活动位。
 *
 * 判据（三条全过才算"不影响"）：
 *   ① 显示中的店铺全程不变
 *   ② 活动标签页全程不变
 *   ③ 标签栏里用户在看的那些页数量不增加（采集专用页不进列表）
 *
 * 用法：node tools/research/verify-collect-no-disrupt.mjs [CDP端口]
 */
const PORT = process.argv[2] || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
/** 采样时长：够跑完一轮发票采集（实测抖店约 60s、快手约 71s） */
const SAMPLE_MS = Number(process.argv[3] || 150000)

const main = async () => {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const app = targets.find(t => t.type === 'page' && t.url.includes('/renderer/index.html'))
  if (!app) throw new Error('没找到应用窗口')
  const ws = new WebSocket(app.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 0
  const pending = new Map()
  ws.onmessage = event => {
    const msg = JSON.parse(event.data)
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error.message))
    else p.resolve(msg.result)
  }
  const evalJs = async expression => {
    const n = ++id
    const result = await new Promise((resolve, reject) => {
      pending.set(n, { resolve, reject })
      ws.send(JSON.stringify({
        id: n, method: 'Runtime.evaluate',
        params: { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true }
      }))
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }

  /**
   * 用户视图 = 每店**活动标签页** + 标签栏里**可见页**的集合 + 采集专用页数量。
   *
   * 注意：`store.list()` **没有** open 字段（第一版照它过滤，结果一店都没匹配上 →
   * 全部判据空跑、假通过）。这里改成对每家店都问一次 `browser.tab.list`，
   * 拿不到（没开浏览器）就跳过——判据必须建立在真实存在的页面上，否则等于没测。
   */
  const snapshot = `{
    const res = await window.shopilot.store.list()
    const stores = (res?.data || [])
    const out = { tabs: {}, openStores: [] }
    for (const s of stores) {
      const list = await window.shopilot.browser.tab.list(s.id)
      if (!list?.ok) continue
      const tabs = (list.data?.tabs || [])
      out.openStores.push(s.name)
      out.tabs[s.name] = {
        active: list.data?.activeTabId || null,
        visible: tabs.filter(t => t.internal !== true).map(t => t.id).sort(),
        internal: tabs.filter(t => t.internal === true).length
      }
    }
    return out
  }`

  // 先把界面切到独立发票中心页面（采集入口在那里），并确保有店铺开着
  await evalJs(`
    const nav = [...document.querySelectorAll('.dashboard-nav-item')].find(i => (i.textContent || '').includes('发票中心'))
    if (nav) nav.click()
    await new Promise(r => setTimeout(r, 3500))
    return true
  `)

  const compact = snap => ({
    openStores: snap.openStores,
    tabs: Object.fromEntries(Object.entries(snap.tabs).map(([name, t]) => [
      name, `可见页 ${t.visible.length} 个 · 采集专用页 ${t.internal} 个 · 活动页 ${t.active || '无'}`
    ]))
  })
  const before = await evalJs(snapshot)
  console.log('采集前:', JSON.stringify(compact(before), null, 2))
  if (!before.openStores.length) {
    console.log('\n⚠️ 没有任何店铺开着浏览器——判据无从成立。先打开至少一家店的浏览器再跑这个脚本。')
    ws.close()
    return
  }

  await evalJs(`document.querySelector('[data-test="invoice-collect"]').click(); return true`)
  console.log(`\n已触发采集，采样 ${Math.round(SAMPLE_MS / 1000)} 秒…`)

  const changes = []
  const samples = []
  for (let t = 0; t < SAMPLE_MS; t += 3000) {
    await sleep(3000)
    const now = await evalJs(snapshot)
    for (const name of Object.keys(before.tabs)) {
      const a = before.tabs[name]
      const b = now.tabs[name]
      if (!b) { changes.push(`${name}: 标签页整店消失`); continue }
      if (a.active !== b.active) changes.push(`${Math.round(t / 1000)}s ${name}: 活动标签页 ${a.active} → ${b.active}`)
      if (b.visible.length > a.visible.length) changes.push(`${Math.round(t / 1000)}s ${name}: 标签栏多了 ${b.visible.length - a.visible.length} 个可见页`)
    }
    if (t % 30000 === 0) samples.push(`${Math.round(t / 1000)}s internal=${Object.values(now.tabs).map(x => x.internal).join('/')}`)
  }
  console.log('采样中的采集专用页数量:', samples.join(' | '))

  const after = await evalJs(snapshot)
  console.log('\n采集后:', JSON.stringify(compact(after), null, 2))
  console.log('\n=== 结论 ===')
  if (!changes.length) console.log('✅ 用户视图全程未被改动（显示店铺 / 活动标签页 / 标签栏都没变）')
  else { console.log('❌ 发现视图被改动：'); for (const c of changes.slice(0, 12)) console.log('   - ' + c) }
  ws.close()
}

main().catch(error => { console.error('FAILED: ' + (error?.message || error)); process.exit(1) })
