/**
 * 打印**已采集到的**涉税报送数据（每店：是否支持 / 条数 / 采集时间 / 最近失败原因）。
 * 用途：采集之后界面还是 0 条时，一眼看出是"没采"、"采失败"还是"真没数据"。
 *
 * 用法：node tools/research/dump-tax-status.mjs [CDP端口]
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
  const rows = await cdp.eval(`
    const res = await window.shopilot.overview.taxReport()
    if (!res.ok) return { error: res.error }
    return {
      disclaimer: String(res.data.disclaimer || '').slice(0, 40),
      columns: (res.data.columns || []).map(c => c.key),
      stores: (res.data.rows || []).map(r => ({
        store: r.storeName,
        platform: r.platform,
        supported: r.supported,
        unsupportedReason: r.unsupportedReason ? String(r.unsupportedReason).slice(0, 120) : null,
        count: r.count,
        capturedAt: r.capturedAt ? new Date(r.capturedAt).toLocaleString('zh-CN') : null,
        measuredAt: r.measuredAt,
        lastFail: r.lastFail ? { code: r.lastFail.code, message: String(r.lastFail.message || '').slice(0, 200) } : null,
        sections: (r.sections || []).map(s => ({ name: s.name, items: s.items?.length || 0, emptyNote: s.emptyNote || null, header: s.header })),
        sample: r.sections?.[0]?.items?.[0]?.cells || null,
        // 每一期都列出来：只打第一条时，看不出"第二期是不是被读错位了"
        allPeriods: (r.sections || []).flatMap(s => (s.items || []).map(i => ({
          period: i.cells?.period ?? null,
          netTotal: i.cells?.netTotal ?? null,
          goodsNet: i.cells?.goodsNet ?? null,
          serviceNet: i.cells?.serviceNet ?? null,
          subject: i.cells?.subject ?? null,
          raw: Object.values(i.cells || {}).join(' | ').slice(0, 160)
        })))
      }))
    }
  `)
  console.log(JSON.stringify(rows, null, 2))
  cdp.close()
}

main().catch(error => { console.error('FAILED: ' + (error?.message || error)); process.exit(1) })
