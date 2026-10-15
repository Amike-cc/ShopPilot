/**
 * 打印发票采集任务的最近一次运行状态与错误（排查用）。
 * 用法：node tools/research/read-invoice-tasks.mjs [CDP端口]
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
  const rows = await cdp.eval(`
    const list = await window.shopilot.task.list()
    const all = (list.ok ? list.data : []) || []
    return all.filter(t => String(t.name || '').startsWith('发票采集'))
      .map(t => ({
        name: t.name,
        steps: (t.steps || []).map(s => s.type).join('/'),
        // 各步的超时（慢页面靠它撑住；看不出超时就分不清"改没生效"和"还是不够长"）
        timeouts: (t.steps || []).map(s => s.timeoutMs || 0).join(','),
        run: t.latestRun ? {
          status: t.latestRun.status,
          at: t.latestRun.startedAt ? new Date(t.latestRun.startedAt).toLocaleTimeString('zh-CN') : null,
          end: t.latestRun.finishedAt ? new Date(t.latestRun.finishedAt).toLocaleTimeString('zh-CN') : null,
          tookMs: t.latestRun.startedAt && t.latestRun.finishedAt ? t.latestRun.finishedAt - t.latestRun.startedAt : null,
          code: t.latestRun.errorCode || null,
          msg: t.latestRun.errorMessage ? String(t.latestRun.errorMessage).slice(0, 220) : null,
          step: t.latestRun.statusReason || null
        } : null
      }))
  `)
  for (const r of rows) {
    console.log(`${r.name}\n   步骤: ${r.steps}\n   超时: ${r.timeouts}\n   最近运行: ${JSON.stringify(r.run)}`)
  }
  cdp.close()
}

main().catch(error => { console.error('FAILED: ' + (error?.message || error)); process.exit(1) })
