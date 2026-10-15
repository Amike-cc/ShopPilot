/**
 * 读取发票中心「按主体统计」汇总视图的实际渲染结果（表头 + 表体 + 合计行）。
 *
 * 为什么单独做：这个视图的列与合计口径跟店铺视图不同（多了 结算金额 之类的列），
 * 之前两轮审查只看了店铺视图，汇总视图一直没核对过。
 *
 * 用法：node tools/research/dump-invoice-summary.mjs [CDP端口]
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

  // 先切到发票中心，再切到「按主体统计」视图
  await evalJs(`
    const nav = [...document.querySelectorAll('.dashboard-nav-item')].find(i => (i.textContent || '').includes('数据分析'))
    if (nav) nav.click()
    await new Promise(r => setTimeout(r, 1500))
    const tab = [...document.querySelectorAll('.unified-route-tabs button')].find(i => (i.textContent || '').includes('发票中心'))
    if (tab) tab.click()
    await new Promise(r => setTimeout(r, 4000))
    const sub = document.querySelector('[data-test="invoice-view-summary"]')
    if (sub) sub.click()
    await new Promise(r => setTimeout(r, 1500))
    return true
  `)

  const out = await evalJs(`
    const wrap = document.querySelector('[data-test="invoice-summary"]') || document.querySelector('.inv-subject') || document.body
    const tables = [...wrap.querySelectorAll('table')]
    return {
      viewButtons: [...document.querySelectorAll('[data-test^="invoice-view-"]')].map(b => (b.textContent || '').trim() + (b.className.includes('on') ? '[选中]' : '')),
      tableCount: tables.length,
      tables: tables.map(t => ({
        head: [...t.querySelectorAll('thead th')].map(x => (x.textContent || '').replace(/\\s+/g, ' ').trim()),
        rows: [...t.querySelectorAll('tbody tr')].map(tr => [...tr.children].map(td => {
          const bar = td.querySelector('.inv-sum-bar')
          if (bar) {
            const i = bar.querySelector('i')
            return 'BAR width=' + (i ? i.style.width : '?') + ' | ' + (bar.getAttribute('title') || '')
          }
          return (td.textContent || '').replace(/\\s+/g, ' ').trim()
        }))
      })),
      summaryText: (wrap.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 700)
    }
  `)
  console.log(JSON.stringify(out, null, 2))
  ws.close()
}

main().catch(error => { console.error('FAILED: ' + (error?.message || error)); process.exit(1) })
