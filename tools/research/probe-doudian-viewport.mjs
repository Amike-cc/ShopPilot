/**
 * 在**抖店发票采集进行时**采样抖店 webview 的视口与可见性（排查"页面渲染不出来"）。
 *
 * 为什么需要：抖店的发票页是独立微前端，实测**手动刷新能出表、采集时出不来**。
 * 差别可能在视口——采集是从发票中心弹层发起的，店铺视图此时可能是 0×0 / hidden，
 * 而微前端在这种状态下走不完初始化（普通表格平台不受影响）。
 *
 * 用法：node tools/research/probe-doudian-viewport.mjs [CDP端口]
 */
const PORT = process.argv[2] || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))

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
  const app = targets.find(t => t.type === 'page' && t.url.includes('/renderer/index.html'))
  if (!app) throw new Error('没找到应用窗口')
  const cdp = new CDP(app.webSocketDebuggerUrl)

  await cdp.eval(`
    const nav = [...document.querySelectorAll('.dashboard-nav-item')].find(i => (i.textContent || '').includes('发票中心'))
    if (nav) nav.click()
    await new Promise(r => setTimeout(r, 3500))
    const btn = document.querySelector('[data-test="invoice-collect"]')
    if (btn) btn.click()
    return true
  `)
  console.log('已触发采集，开始采样抖店 webview…')

  let seen = 0
  for (let i = 0; i < 40; i++) {
    await sleep(2500)
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    const dd = list.find(t => (t.url || '').includes('jinritemai') && (t.url || '').includes('invoice'))
      || list.find(t => (t.url || '').includes('fxg.jinritemai.com'))
    if (!dd) { if (i % 4 === 0) console.log(`  ${i * 2.5}s: 抖店 webview 还不存在`); continue }
    const probe = new CDP(dd.webSocketDebuggerUrl)
    try {
      const info = await probe.eval(`
        return {
          w: window.innerWidth, h: window.innerHeight,
          vis: document.visibilityState, hidden: document.hidden,
          tables: document.querySelectorAll('table').length,
          trs: document.querySelectorAll('tr').length,
          loading: /加载中/.test(document.body.innerText || ''),
          url: location.href.slice(-60)
        }
      `)
      seen++
      console.log(`  ${(i * 2.5).toFixed(0)}s: ${info.w}×${info.h} vis=${info.vis} hidden=${info.hidden} table=${info.tables} tr=${info.trs} 加载中=${info.loading}`)
      if (info.tables > 0) { console.log('  ✅ 表格出现了'); break }
    } catch (e) {
      console.log(`  ${(i * 2.5).toFixed(0)}s: 采样失败 ${String(e).slice(0, 60)}`)
    } finally { probe.close() }
  }
  console.log(`共采样到 ${seen} 次`)
  cdp.close()
}

main().catch(error => { console.error('FAILED: ' + (error?.message || error)); process.exit(1) })
