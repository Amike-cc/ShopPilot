/**
 * 端到端验证发票中心「自动更新」开关：开启 → 确认两处状态都变 → 关闭 → **还原总开关**。
 *
 * 为什么要还原：`collection.autoEnabled` 是用户 2026-10-04 明确要求关掉的全局开关，
 * 验证脚本不能把它留在打开状态。
 *
 * 用法：node tools/research/verify-invoice-schedule-toggle.mjs [CDP端口]
 */
const PORT = process.argv[2] || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const connect = async () => {
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
      ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true } }))
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  return { evalJs, close: () => ws.close() }
}

const readState = `{
  const box = document.querySelector('[data-test="invoice-schedule"]')
  const st = await window.shopilot.settings.get('collection.autoEnabled')
  return {
    autoEnabled: st?.ok ? st.data?.value : null,
    dataActive: box?.getAttribute('data-active'),
    text: (box?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120)
  }
}`

const main = async () => {
  const cdp = await connect()
  console.log('初始状态:', JSON.stringify(await cdp.evalJs(readState)))

  console.log('\n--- 点「开启每 3 小时自动更新」---')
  await cdp.evalJs(`document.querySelector('[data-test="invoice-schedule-toggle"]').click(); return true`)
  await sleep(6000)
  console.log('开启后:', JSON.stringify(await cdp.evalJs(readState)))

  console.log('\n--- 点「关闭自动更新」---')
  await cdp.evalJs(`document.querySelector('[data-test="invoice-schedule-toggle"]').click(); return true`)
  await sleep(6000)
  console.log('关闭后:', JSON.stringify(await cdp.evalJs(readState)))

  console.log('\n--- 还原：把自动采集总开关显式设回 false（用户 2026-10-04 的要求）---')
  await cdp.evalJs(`await window.shopilot.settings.set('collection.autoEnabled', false); return true`)
  await cdp.evalJs(`location.reload(); return true`)
  await sleep(6000)
  console.log('还原后:', JSON.stringify(await cdp.evalJs(readState)))
  cdp.close()
}

main().catch(error => { console.error('FAILED: ' + (error?.message || error)); process.exit(1) })
