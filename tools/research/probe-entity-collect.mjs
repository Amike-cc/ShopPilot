/**
 * 点「获取主体营业执照」并观察结果（排查用）。
 * 用法：node tools/research/probe-entity-collect.mjs [CDP端口]
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

  const open = await cdp.eval(`
    const nav = [...document.querySelectorAll('.dashboard-nav-item')].find(i => (i.textContent || '').includes('发票中心'))
    if (nav) nav.click()
    await new Promise(r => setTimeout(r, 3000))
    const btn = document.querySelector('[data-test="invoice-entity-collect"]')
    return btn ? { found: true, disabled: btn.disabled, text: btn.textContent.trim(), title: btn.getAttribute('title') } : { found: false }
  `)
  console.log('按钮：' + JSON.stringify(open))
  if (!open.found) { cdp.close(); return }

  const click = await cdp.eval(`
    const btn = document.querySelector('[data-test="invoice-entity-collect"]')
    btn.click()
    await new Promise(r => setTimeout(r, 1500))
    return { disabled: btn.disabled, text: btn.textContent.trim() }
  `)
  console.log('点击后 1.5 秒：' + JSON.stringify(click))

  await new Promise(r => setTimeout(r, 12000))
  const after = await cdp.eval(`
    const btn = document.querySelector('[data-test="invoice-entity-collect"]')
    const toasts = [...document.querySelectorAll('[class*=toast],[class*=Toast],[class*=message]')]
      .map(e => (e.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 4)
    const txt = document.body.innerText || ''
    const resultBlock = txt.includes('获取主体营业执照 · 结果')
    const rows = [...document.querySelectorAll('[class*=inv-entity]')]
      .map(e => (e.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 8)
    return {
      disabled: btn ? btn.disabled : null,
      text: btn ? btn.textContent.trim() : null,
      toasts,
      resultBlock,
      rows,
      entityHints: [...document.querySelectorAll('.inv-entity-hint')].map(e => (e.textContent || '').replace(/\\s+/g, ' ').trim()).slice(0, 6)
    }
  `)
  console.log(JSON.stringify(after, null, 2))
  cdp.close()
}

main().catch(error => { console.error('FAILED: ' + (error?.message || error)); process.exit(1) })
