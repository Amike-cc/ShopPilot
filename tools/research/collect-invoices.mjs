/**
 * 点「采集发票数据」并等采集跑完（排查用）。
 * 用法：node tools/research/collect-invoices.mjs [CDP端口]
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
  const cdp = new CDP(target.webSocketDebuggerUrl)
  const t0 = Date.now()
  const started = await cdp.eval(`
    // 先把界面切到独立发票中心页面（应用刚重启时不在这一页）
    const nav = [...document.querySelectorAll('.dashboard-nav-item')].find(i => (i.textContent || '').includes('发票中心'))
    if (nav) nav.click()
    await new Promise(r => setTimeout(r, 3500))
    const btn = document.querySelector('[data-test="invoice-collect"]')
    if (!btn) throw new Error('采集按钮不在屏上（先切到发票中心）')
    btn.click()
    await new Promise(r => setTimeout(r, 2000))
    const toasts = [...document.querySelectorAll('[class*=toast],[class*=Toast]')].map(e => (e.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean)
    return { busy: btn.disabled, text: btn.textContent.trim(), toasts }
  `)
  console.log('点击后：' + JSON.stringify(started))
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 3000))
    const state = await cdp.eval(`
      const btn = document.querySelector('[data-test="invoice-collect"]')
      const toasts = [...document.querySelectorAll('[class*=toast],[class*=Toast]')].map(e => (e.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean)
      return { busy: btn ? btn.disabled : false, toasts }
    `)
    if (!state.busy) {
      console.log(`结束，耗时 ${Math.round((Date.now() - t0) / 1000)} 秒；toast: ${JSON.stringify(state.toasts)}`)
      break
    }
    if (i % 10 === 0) console.log(`  …已等 ${Math.round((Date.now() - t0) / 1000)} 秒`)
  }
  // 采完再列一次方向
  await new Promise(r => setTimeout(r, 4000))
  const cards = await cdp.eval(`
    const out = []
    for (const sec of document.querySelectorAll('[data-test="invoice-section"]')) {
      out.push({
        store: (sec.closest('[data-test="invoice-row"]')?.querySelector('b')?.textContent || '').trim(),
        name: (sec.querySelector('.inv-sec-name')?.textContent || '').trim(),
        badge: (sec.querySelector('.inv-sec-badge')?.textContent || '').trim(),
        num: (sec.querySelector('.inv-sec-num')?.textContent || '').replace(/\\s+/g, ''),
        note: (sec.querySelector('.inv-sec-badge')?.getAttribute('title') || '').slice(0, 80)
      })
    }
    return out
  `)
  console.log('--- 采集后的方向 ---')
  for (const c of cards) console.log(`  ${c.store} | ${c.name} | [${c.badge}] ${c.num}${c.note ? '  ← ' + c.note : ''}`)
  cdp.close()
}

main().catch(error => { console.error('FAILED: ' + (error?.message || error)); process.exit(1) })
