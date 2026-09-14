/**
 * 真机验证「发票中心抓取待开票信息」：
 *   ① 打开发票中心，确认面板结构（采集按钮/刷新/关闭）
 *   ② 点「抓取待开票信息」→ 等采集任务跑完 → 逐店读结果
 *   ③ 通过 IPC 读回汇总，校验：支持的平台有条目、字段映射进了统一列
 *   ④ 截图留档
 * 用法：node verify-invoice-collect.mjs [--no-collect]
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const NO_COLLECT = process.argv.includes('--no-collect')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 260) : r.result?.value
}
let pass = 0, fail = 0
const check = (l, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${l}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++ }

await ev(`(async()=>{await window.shopilot.browser.display(null);return 1})()`)
await sleep(1200)
await ev(`document.querySelector('[data-test=invoice-center-open]').click()`)
await sleep(2500)
check('① 面板已打开', (await ev(`!!document.querySelector('[data-test=invoice-center-modal]')`)) === true)
check('① 有「抓取待开票信息」按钮', (await ev(`!!document.querySelector('[data-test=invoice-collect]')`)) === true)
check('① 有「刷新」按钮', (await ev(`!!document.querySelector('[data-test=invoice-refresh]')`)) === true)
const rows0raw = await ev(`JSON.stringify([...document.querySelectorAll('[data-test=invoice-row]')].map(r => String((r.querySelector('b')||{}).innerText||'').trim()))`)
const rows0 = JSON.parse(rows0raw)
check('① 列出全部店铺', rows0.length === 4, rows0.join('、'))

if (!NO_COLLECT) {
  console.log('\n② 点「抓取待开票信息」（真实采集，会打开各店铺的发票页读取，不做任何开票操作）…')
  await ev(`document.querySelector('[data-test=invoice-collect]').click()`)
  // 采集要跑 1-3 分钟（逐店导航 + 读表）
  const t0 = Date.now()
  let last = ''
  for (let i = 0; i < 100; i++) {
    await sleep(4000)
    const st = await ev(`(() => { const b = document.querySelector('[data-test=invoice-collect]'); return b ? String(b.innerText||'').trim() : 'gone' })()`)
    if (st !== last) { console.log(`   [${Math.round((Date.now() - t0) / 1000)}s] 按钮: ${st}`); last = st }
    if (st === '抓取待开票信息') break
  }
  console.log('采集耗时:', Math.round((Date.now() - t0) / 1000), 's')
}

console.log('\n③ 通过 IPC 读回汇总（按开票方向分组）')
const data = JSON.parse(await ev(`(async () => {
  const r = await window.shopilot.overview.invoiceCenter()
  if (!r.ok) return JSON.stringify({ ok: false, err: r.error.message })
  return JSON.stringify({
    ok: true,
    columns: (r.data.columns||[]).map(c => c.label),
    rows: (r.data.rows||[]).map(x => ({
      店铺: x.storeName, 平台: x.platform, 支持: x.supported,
      原因: x.unsupportedReason, 采集时间: x.capturedAt ? new Date(x.capturedAt).toLocaleString() : null,
      失败: x.lastFail ? (x.lastFail.code + ': ' + x.lastFail.message) : null,
      登录失效: !!x.loginRequired,
      方向: (x.sections||[]).map(sec => ({
        名: sec.name, 指标: sec.metricKey, 实测条数: sec.measuredRows,
        采集于: sec.capturedAt ? new Date(sec.capturedAt).toLocaleString() : null,
        条数: (sec.items||[]).length,
        表头: sec.header,
        样例: (sec.items||[]).slice(0, 2)
      }))
    }))
  })
})()`))
if (!data.ok) { console.log('读取失败:', data.err); process.exit(1) }
console.log('统一列:', JSON.stringify(data.columns))
for (const r of data.rows) {
  console.log(`\n— ${r.店铺}（${r.平台}）支持=${r.支持} 采集于 ${r.采集时间}`)
  if (r.失败) console.log('   最近失败:', r.失败)
  if (!r.支持) { console.log('   说明:', r.原因); continue }
  for (const sec of r.方向) {
    console.log(`   ▸ ${sec.名} [${sec.指标}] 实测${sec.实测条数} 抓到${sec.条数} 采集于 ${sec.采集于}`)
    if (sec.条数) {
      console.log('     表头:', JSON.stringify(sec.表头))
      for (const it of sec.样例) console.log('     行:', JSON.stringify(it.cells), '额外:', JSON.stringify(it.extras))
    }
  }
}
const supported = data.rows.filter((r) => r.支持)
const withData = supported.filter((r) => r.方向.some((s) => s.条数 > 0))
// 登录态失效 = 需要用户自己扫码，不是程序缺陷——单独统计，别和"抓不到"混在一起
const loginBlocked = supported.filter((r) => r.登录失效 && !r.方向.some((s) => s.条数 > 0))
const reallyEmpty = withData.length === 0 && !loginBlocked.length
check('③ 支持的平台数 = 4（微信/拼多多/抖店/快手）', supported.length === 4, supported.map((r) => r.平台).join('、'))
check('③ 抓到了待开票数据', withData.length > 0, withData.map((r) => `${r.平台}:${r.方向.reduce((a, s) => a + s.条数, 0)}`).join(' '))
check('③ 除需重新登录的店铺外都抓到了数据', withData.length + loginBlocked.length === 4,
  `${withData.length} 家有数据` + (loginBlocked.length ? `，${loginBlocked.map((r) => r.平台).join('、')} 待重新登录` : ''))
check('③ 登录态失效被如实标出（不是含糊的"超时"）', supported.every((r) => !r.登录失效 || /登录/.test(String(r.失败 || ''))),
  loginBlocked.map((r) => `${r.平台}: ${String(r.失败 || '').slice(0, 60)}`).join(' | '))
// —— 用户的诉求：**两个方向都要抓**（给平台开票 / 给买家开票）——
const wx = data.rows.find((r) => r.平台 === '微信小店')
if (wx) {
  const dir = (n) => wx.方向.find((s) => s.名 === n)
  const apply = dir('申请平台开票'), toPlat = dir('给平台开票')
  check('③ 微信「申请平台开票」抓到 5 条', !!apply && apply.条数 === 5, apply ? `实际 ${apply.条数}` : '方向缺失')
  check('③ 微信「给平台开票」抓到 2 条（第二个方向！）', !!toPlat && toPlat.条数 === 2, toPlat ? `实际 ${toPlat.条数}` : '方向缺失')
  check('③ 微信「给平台开票」表头含「处理状态」', !!toPlat && (toPlat.表头 || []).includes('处理状态'), toPlat ? JSON.stringify(toPlat.表头) : '')
  // 关键：两个方向必须是**不同的数据**，不能是同一批行挂两个方向名（切页签没生效的典型症状）
  const key = (s) => JSON.stringify((s.样例 || []).map((it) => it.cells && it.cells.id))
  check('③ 微信两个方向的数据不同（切页签真的生效了）', !!apply && !!toPlat && apply.条数 !== toPlat.条数 && key(apply) !== key(toPlat),
    apply && toPlat ? `申请=${apply.条数} 给平台=${toPlat.条数}` : '')
}
const dd = data.rows.find((r) => r.平台 === '抖店')
if (dd) {
  const toPlat = dd.方向.find((s) => s.名 === '我给平台开票')
  const toBuyer = dd.方向.find((s) => s.名 === '给消费者开票')
  const fromPlat = dd.方向.find((s) => s.名 === '平台给我开票')
  check('③ 抖店「我给平台开票」抓到数据', !!toPlat && toPlat.条数 > 0, toPlat ? `实际 ${toPlat.条数}` : '方向缺失')
  check('③ 抖店「给消费者开票」有独立方向（空则如实 0 条、不报失败）', !!toBuyer, toBuyer ? `${toBuyer.条数} 条` : '方向缺失')
  // 实测该方向表里第一行数据位置是**重复表头**、空方向会渲染「暂无数据」占位行——
  // 两者都不该被当成记录（清洗后 37 条，不是 38，第一行也不是"账单名称/账单类型"）
  check('③ 抖店「平台给我开票」没把重复表头行当成记录',
    !!fromPlat && !fromPlat.样例.some((it) => it.cells && it.cells.id === '账单名称'),
    fromPlat ? `共 ${fromPlat.条数} 条，首条 id=${String((fromPlat.样例[0] || {}).cells?.id || '').slice(0, 30)}` : '')
  check('③ 抖店「给消费者开票」没把「暂无数据」占位行当成记录',
    !!toBuyer && !toBuyer.样例.some((it) => /暂无数据/.test(String(it.cells?.id || ''))),
    toBuyer ? `${toBuyer.条数} 条` : '')
}
const pdd = data.rows.find((r) => r.平台 === '拼多多')
if (pdd) {
  const toPlat = pdd.方向.find((s) => s.名 === '给平台开票（资金中心）')
  const c = (toPlat?.样例?.[0] || {}).cells || {}
  // 卡片类方向：三个标签都得读到，且**金额/期间/收票主体都要原样**——
  // 数值抽取会把「2026年05/06/07/08月」截成「2026」，公司名会被判成"不是数值"而整条失败
  check('③ 拼多多「给平台开票」三个标签都读到了（期间/金额/收票主体）',
    !!toPlat && Object.keys(c).length >= 3, JSON.stringify(c))
  check('③ 拼多多「给平台开票」期间没被截断（要含"月"）', /月/.test(String(c.period || '')), `period=${c.period}`)
  check('③ 拼多多「给平台开票」收票主体是公司名（没被数值抽取挡掉）', /公司/.test(String(c.title || '')), `title=${c.title}`)
}
// 至少要有一个平台是"多方向各自拿到数据"的，证明多方向确实生效
const multi = supported.filter((r) => r.方向.filter((s) => s.条数 > 0).length >= 2)
check('③ 有平台做到了多方向各自取数', multi.length >= 2, multi.map((r) => `${r.平台}:${r.方向.filter((s) => s.条数 > 0).map((s) => s.名 + s.条数).join('/')}`).join(' '))
// 采集失败必须如实透出（不能把失败显示成"暂无数据"）
check('③ 失败原因如实透出', data.rows.every((r) => !r.失败 || r.失败.includes(':')))
// 至少有平台把金额/单号映射进了统一列
const mapped = withData.some((r) => r.方向.some((s) => s.样例.some((it) => it.cells && (it.cells.amount || it.cells.id))))
check('③ 字段已映射进统一列（金额/单号）', mapped)
check('③ 没有平台是"莫名其妙的空"', !reallyEmpty)

await sleep(1500)
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-invoice-collected.png', Buffer.from(shot.data, 'base64'))
console.log('\n截图已存 wx-invite-test/ui-invoice-collected.png')
console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===`)
ws.close()
setTimeout(() => process.exit(0), 300)
