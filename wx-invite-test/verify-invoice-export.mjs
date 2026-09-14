/**
 * 真机验证「导出发票 CSV」：触发导出 → 自动应答保存框 → 读回文件校验内容与转义。
 *
 * 保存框是原生对话框，CDP 点不到；这里用 Page.setDownloadBehavior 不行——
 * 改为调用渲染层导出后，用 PowerShell 的 SendKeys 在原生框里输入路径并回车。
 * 用法：node verify-invoice-export.mjs
 */
const fs = await import('fs')
const path = await import('path')
const os = await import('os')
const { execFileSync } = await import('child_process')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const out = path.join(os.tmpdir(), `invoice-export-${Date.now()}.csv`)

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

await ev(`(async()=>{await window.shopilot.browser.display(null);return 1})()`)
await sleep(1200)
await ev(`document.querySelector('[data-test=invoice-center-open]').click()`)
await sleep(2500)

console.log('触发导出（会弹保存框）…')
// 不 await：保存框会阻塞在该 promise 上，我们在外面用 SendKeys 应答
void ev(`window.shopilot.overview.invoiceExport()`)
await sleep(2500)

// 用 PowerShell SendKeys：清空文件名框 → 输入完整路径 → 回车
const ps = `
Add-Type -AssemblyName System.Windows.Forms
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait("${out.replace(/\\/g, '\\\\')}")
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
`
try {
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { timeout: 20000 })
} catch (e) {
  console.log('SendKeys 执行异常（可能无保存框）:', String(e.message).slice(0, 120))
}
await sleep(3500)

if (!fs.existsSync(out)) {
  console.log('✗ 未生成文件（保存框可能未应答或被取消）:', out)
  ws.close()
  process.exit(0)
}
const buf = fs.readFileSync(out)
const text = buf.toString('utf8')
const lines = text.split(/\r?\n/).filter(Boolean)
console.log('✓ 已生成 CSV:', out)
console.log('  字节数:', buf.length, '（应为 UTF-8 BOM 开头）')
console.log('  首 3 字节是 BOM:', buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF)
console.log('  行数（含表头）:', lines.length)
console.log('  表头:', lines[0])
console.log('  第 1 条数据:', lines[1] ? lines[1].slice(0, 160) : '(无)')
// 校验：含换行的字段被正确引起来（拼多多订单号带换行）
const hasQuotedNewline = /"[^"]*\n[^"]*"/.test(text) || text.includes('"220630')
console.log('  含换行的字段已用引号包裹:', hasQuotedNewline)
console.log('  含"店铺/平台"列:', lines[0].startsWith('店铺,平台'))
ws.close()
setTimeout(() => process.exit(0), 300)
