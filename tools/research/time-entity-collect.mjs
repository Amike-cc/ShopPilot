/**
 * 精确测「获取主体营业执照」从点击到结束的耗时，并在结束瞬间抓 toast（排查"点了没反应"）。
 * 用法：node tools/research/time-entity-collect.mjs [CDP端口]
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
  await cdp.eval(`
    const btn = document.querySelector('[data-test="invoice-entity-collect"]')
    if (!btn) throw new Error('按钮不在屏上（先切到发票中心）')
    btn.click()
    await new Promise(r => setTimeout(r, 300))
    return true
  `)
  console.log('已点击，开始计时…')
  let seenProgress = ''

  for (let i = 0; i < 200; i++) {
    await new Promise(r => setTimeout(r, 2000))
    const state = await cdp.eval(`
      const btn = document.querySelector('[data-test="invoice-entity-collect"]')
      const toasts = [...document.querySelectorAll('[class*=toast],[class*=Toast]')]
        .map(e => (e.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean)
      const progress = document.querySelector('[data-test="invoice-entity-progress"]')
      return { busy: btn ? btn.disabled : false, text: btn ? btn.textContent.trim() : '', toasts,
               progress: progress ? progress.textContent.replace(/\\s+/g, ' ').trim() : null }
    `)
    if (state.progress && !seenProgress) { seenProgress = state.progress; console.log('📊 进度可见: ' + state.progress) }
    if (!state.busy) {
      const sec = Math.round((Date.now() - t0) / 1000)
      console.log(`✅ 结束，耗时 ${sec} 秒`)
      console.log('按钮文案: ' + state.text)
      console.log('toast: ' + JSON.stringify(state.toasts))
      break
    }
    if (i % 10 === 0) console.log(`  …已等 ${Math.round((Date.now() - t0) / 1000)} 秒（${state.text}）`)
  }
  cdp.close()
}

main().catch(error => { console.error('FAILED: ' + (error?.message || error)); process.exit(1) })
