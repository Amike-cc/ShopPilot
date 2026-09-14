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

console.log('\n③ 通过 IPC 读回汇总')
const data = JSON.parse(await ev(`(async () => {
  const r = await window.shopilot.overview.invoiceCenter()
  if (!r.ok) return JSON.stringify({ ok: false, err: r.error.message })
  return JSON.stringify({
    ok: true,
    columns: (r.data.columns||[]).map(c => c.label),
    rows: (r.data.rows||[]).map(x => ({
      店铺: x.storeName, 平台: x.platform, 支持: x.supported,
      原因: x.unsupportedReason, 采集时间: x.capturedAt ? new Date(x.capturedAt).toLocaleString() : null,
      条数: (x.items||[]).length,
      表头: x.header,
      样例: (x.items||[]).slice(0, 2)
    }))
  })
})()`))
if (!data.ok) { console.log('读取失败:', data.err); process.exit(1) }
console.log('统一列:', JSON.stringify(data.columns))
for (const r of data.rows) {
  console.log(`\n— ${r.店铺}（${r.平台}）支持=${r.支持} 条数=${r.条数} 采集于 ${r.采集时间}`)
  if (!r.支持) console.log('   说明:', r.原因)
  else {
    console.log('   表头:', JSON.stringify(r.表头))
    for (const it of r.样例) console.log('   行:', JSON.stringify(it.cells), '额外:', JSON.stringify(it.extras))
  }
}
const supported = data.rows.filter((r) => r.支持)
const withData = supported.filter((r) => r.条数 > 0)
check('③ 支持的平台数 = 3（微信/拼多多/抖店）', supported.length === 3, supported.map((r) => r.平台).join('、'))
check('③ 抓到了待开票数据', withData.length > 0, withData.map((r) => `${r.平台}:${r.条数}`).join(' '))
check('③ 快手如实报未支持', data.rows.some((r) => r.平台 === '快手小店' && r.支持 === false))
// 至少有平台把金额/单号映射进了统一列
const mapped = withData.some((r) => r.样例.some((it) => it.cells && (it.cells.amount || it.cells.id)))
check('③ 字段已映射进统一列（金额/单号）', mapped)

await sleep(1500)
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-invoice-collected.png', Buffer.from(shot.data, 'base64'))
console.log('\n截图已存 wx-invite-test/ui-invoice-collected.png')
console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===`)
ws.close()
setTimeout(() => process.exit(0), 300)
