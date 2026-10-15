/**
 * 读「获取主体营业执照」的当前状态与结果面板（排查用）。
 * 用法：node tools/research/read-entity-state.mjs [CDP端口]
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
  const state = await cdp.eval(`
    const btn = document.querySelector('[data-test="invoice-entity-collect"]')
    const toasts = [...document.querySelectorAll('[class*=toast],[class*=Toast]')]
      .map(e => (e.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 3)
    const txt = document.body.innerText || ''
    const m = txt.match(/获取主体营业执照 · 结果[\\s\\S]{0,600}/)
    return {
      disabled: btn ? btn.disabled : null,
      text: btn ? btn.textContent.trim() : null,
      toasts,
      resultPanel: m ? m[0].replace(/\\s+/g, ' ').slice(0, 600) : null
    }
  `)
  console.log(JSON.stringify(state, null, 2))

  // 顺便看这两家店的主体采集任务到底什么状态
  const tasks = await cdp.eval(`
    const list = await window.shopilot.task.list()
    const all = (list.ok ? list.data : []) || []
    return all.filter(t => String(t.name || '').startsWith('主体信息采集'))
      .map(t => ({
        name: t.name,
        latestRun: t.latestRun ? { id: String(t.latestRun.id).slice(0, 8), status: t.latestRun.status, at: t.latestRun.startedAt ? new Date(t.latestRun.startedAt).toLocaleTimeString('zh-CN') : null } : null,
        // 失败时把整条 run 原样打出来：错误字段的形状不确定，只取 error.message 会漏掉真正的原因
        rawRun: t.latestRun && t.latestRun.status === 'failed' ? JSON.stringify(t.latestRun).slice(0, 900) : null,
        err: t.latestRun && t.latestRun.error ? String(t.latestRun.error.message || JSON.stringify(t.latestRun.error)).slice(0, 200) : null
      }))
  `)
  console.log(JSON.stringify(tasks, null, 2))
  cdp.close()
}

main().catch(error => { console.error('FAILED: ' + (error?.message || error)); process.exit(1) })
