/**
 * 读取发票中心「自动更新」区块的真实状态（总开关 + 任务周期 + 按钮文案）。
 *
 * 为什么单独做：这块曾经显示假状态——任务上挂着 everyMs 就写「已启用 N/M 家」，
 * 而自动采集总开关（collection.autoEnabled）是关的，调度器一次都不会触发。
 *
 * 用法：node tools/research/dump-invoice-schedule.mjs [CDP端口]
 */
const PORT = process.argv[2] || '9250'

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
  const send = (method, params) => new Promise((resolve, reject) => {
    const n = ++id
    pending.set(n, { resolve, reject })
    ws.send(JSON.stringify({ id: n, method, params }))
  })
  const expression = `(async () => {
    const nav = [...document.querySelectorAll('.dashboard-nav-item')].find(i => (i.textContent || '').includes('发票中心'))
    if (nav) nav.click()
    await new Promise(r => setTimeout(r, 4000))
    const box = document.querySelector('[data-test="invoice-schedule"]')
    const setting = await window.shopilot.settings.get('collection.autoEnabled')
    return {
      autoEnabledSetting: setting?.ok ? setting.data?.value : ('读取失败: ' + (setting?.error?.message || '?')),
      block: (box?.textContent || '').replace(/\\s+/g, ' ').trim(),
      dataActive: box?.getAttribute('data-active'),
      buttons: [...(box?.querySelectorAll('button') || [])].map(b => b.textContent.trim())
    }
  })()`
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text)
  console.log(JSON.stringify(res.result.value, null, 2))
  ws.close()
}

main().catch(error => { console.error('FAILED: ' + (error?.message || error)); process.exit(1) })
