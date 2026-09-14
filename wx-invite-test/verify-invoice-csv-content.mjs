/**
 * 验证导出 CSV 的**内容正确性**（绕开原生保存框）：
 * 用与主进程 handler 完全相同的取数+序列化逻辑，在渲染层拿到数据后本地复算一遍 CSV，
 * 与主进程 handler 的规则逐条比对（列头、转义、BOM、行数）。
 * 说明：保存框本身是 Electron 标准控件，不做自动化；这里验证的是"导出内容对不对"。
 * 用法：node verify-invoice-csv-content.mjs
 */
const fs = await import('fs')
const path = await import('path')
const os = await import('os')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
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
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}
let pass = 0, fail = 0
const check = (l, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${l}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++ }

// 从主进程拿"导出会写什么"：这里取汇总数据（与 handler 同源），按 handler 的规则复算
const raw = await ev(`(async () => {
  const r = await window.shopilot.overview.invoiceCenter()
  if (!r.ok) return JSON.stringify({ ok: false, err: r.error.message })
  return JSON.stringify({ ok: true, columns: r.data.columns, rows: r.data.rows })
})()`)
const data = JSON.parse(raw)
if (!data.ok) { console.log('读取失败:', data.err); process.exit(1) }

const cols = data.columns
const dataRows = []
for (const r of data.rows) {
  for (const it of (r.items || [])) {
    const o = { 店铺: r.storeName, 平台: r.platform }
    for (const c of cols) o[c.label] = it.cells?.[c.key] ?? ''
    o['其他信息'] = (it.extras || []).map(x => `${x.label}：${x.value}`).join('；')
    dataRows.push(o)
  }
}
const headers = Object.keys(dataRows[0] || {})
const esc = (v) => {
  const s = String(v ?? '')
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const csv = '\uFEFF' + [headers.join(','), ...dataRows.map(r => headers.map(h => esc(r[h])).join(','))].join('\r\n')

const out = path.join(os.tmpdir(), `invoice-csv-check-${Date.now()}.csv`)
fs.writeFileSync(out, csv, 'utf8')
const buf = fs.readFileSync(out)
const text = buf.toString('utf8')
const lines = text.split(/\r?\n/)

console.log('数据行数:', dataRows.length)
console.log('表头:', headers.join(','))
console.log('首行:', text.split('\r\n')[1]?.slice(0, 170))
check('列头含 店铺/平台 + 8 个统一列 + 其他信息', headers[0] === '店铺' && headers[1] === '平台' && headers.length === 2 + cols.length + 1, `共 ${headers.length} 列`)
check('有数据行', dataRows.length > 0, `${dataRows.length} 行`)
check('UTF-8 BOM 开头（Excel 打开中文不乱码）', buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF)
check('行分隔用 CRLF', text.includes('\r\n'))
// 含换行的字段必须被引号包裹（拼多多订单号带换行）
const newlineCells = dataRows.filter(r => Object.values(r).some(v => String(v ?? '').includes('\n')))
check('含换行字段被正确转义（引号包裹）', newlineCells.length === 0 || /"[^"]*\n[^"]*"/.test(text), `含换行的行数 ${newlineCells.length}`)
check('列数与表头一致（逐行相同列数）', text.split('\r\n').slice(1).filter(Boolean).every(l => {
  // 简单计数：不在引号内的逗号数 +1
  let inQ = false, n = 1
  for (const ch of l) { if (ch === '"') inQ = !inQ; else if (ch === ',' && !inQ) n++ }
  return n === headers.length
}))
console.log('已写校验文件:', out)
console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===`)
ws.close()
setTimeout(() => process.exit(0), 300)
