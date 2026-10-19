/**
 * 列出发票中心当前渲染的**开票方向**（名字 + 条数 + 金额 + 状态徽标）。
 * 用法：node tools/research/dump-invoice-directions.mjs [CDP端口]
 */
const PORT = process.argv[2] || '9250'

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    this.ws.onmessage = event => {
      const msg = JSON.parse(event.data)
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(msg.error.message))
      else pending.resolve(msg.result)
    }
  }
  async send(method, params = {}) {
    await this.ready
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

const main = async () => {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const target = targets.find(t => t.type === 'page' && t.url.includes('/renderer/index.html'))
  if (!target) throw new Error('没找到应用窗口')
  const cdp = new CDP(target.webSocketDebuggerUrl)
  const out = await cdp.eval(`
    const nav = [...document.querySelectorAll('.dashboard-nav-item')].find(i => (i.textContent || '').includes('发票中心'))
    if (nav) nav.click()
    await new Promise(r => setTimeout(r, 3500))
    const norm = s => (s || '').replace(/\\s+/g, ' ').trim()
    // 方向卡片：名字在 .inv-sec-name，徽标在 .inv-sec-badge，条数在 .inv-sec-num
    const cards = []
    for (const sec of document.querySelectorAll('[data-test="invoice-section"]')) {
      cards.push({
        store: (sec.closest('[data-test="invoice-row"]')?.querySelector('b')?.textContent || '').trim(),
        name: (sec.querySelector('.inv-sec-name')?.textContent || '').trim(),
        badge: (sec.querySelector('.inv-sec-badge')?.textContent || '').trim(),
        num: (sec.querySelector('.inv-sec-num')?.textContent || '').replace(/\\s+/g, ''),
        amt: (sec.querySelector('.inv-sec-amt')?.textContent || '').replace(/\\s+/g, ' ').trim()
      })
    }
    // 兜底：把发票区里的所有 data-test 元素名列出来
    const hooks = [...document.querySelectorAll('[data-test]')]
      .map(e => e.getAttribute('data-test'))
      .filter(t => t && t.startsWith('invoice-'))
    return { cards, hooks: [...new Set(hooks)].slice(0, 40) }
  `)
  console.log('--- 方向卡片 ---')
  for (const c of out.cards) console.log(`  ${c.store} | ${c.name} | [${c.badge}] ${c.num} ${c.amt}`)
  console.log('--- data-test 钩子 ---')
  console.log('  ' + out.hooks.join('\n  '))
  cdp.close()
}

main().catch(error => { console.error('FAILED: ' + (error?.message || error)); process.exit(1) })
