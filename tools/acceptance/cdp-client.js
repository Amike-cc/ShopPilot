/**
 * 验收脚本共用的最小 CDP 客户端。
 *
 * 职责单一：连上主窗口的 CDP target → 求值 → 关闭。启动应用、清理进程、断言输出
 * 都留在各验收脚本里（`tabs-batch-close-cdp-verify.js` 里那份内联实现是 2026-10-17
 * 的旧版，尚未收敛到这里；新脚本一律用本模块）。
 *
 * 只依赖 Node 内置的 fetch / WebSocket（Electron 44 / Node 22+）。
 */
const DEFAULT_EVAL_TIMEOUT_MS = 25000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

class CdpClient {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve()
      this.ws.onerror = error => reject(error instanceof Error ? error : new Error('CDP 连接失败'))
    })
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data)
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    }
  }

  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  /** 在页面里跑一段 async 函数体，返回其返回值（按值传递）。 */
  async eval(body, timeoutMs = DEFAULT_EVAL_TIMEOUT_MS) {
    const result = await Promise.race([
      this.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true }),
      sleep(timeoutMs).then(() => ({ timeout: true }))
    ])
    if (result.timeout) throw new Error(`页面求值超时：${String(body).replace(/\s+/g, ' ').slice(0, 120)}`)
    if (result.exceptionDetails) {
      throw new Error('页面异常：' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text))
    }
    return result.result.value
  }

  close() { try { this.ws.close() } catch { /* 已断开 */ } }
}

/** 轮询 CDP /json 列表，直到主窗口（index.html）出现；超时返回 null。 */
async function waitForMainWindow(port, { urlIncludes = 'index.html', timeoutMs = 60000, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const target = list.find(item => item.type === 'page' && String(item.url || '').includes(urlIncludes))
      if (target) {
        const client = new CdpClient(target.webSocketDebuggerUrl)
        await client.ready
        return client
      }
    } catch { /* 应用还没起，继续等 */ }
    await sleep(pollMs)
  }
  return null
}

/** 断言收集器：`check` 立即打印 PASS/FAIL，`summary` 给出总数与失败清单。 */
function createChecker() {
  const checks = []
  function check(name, pass, detail = '') {
    checks.push({ name, pass: !!pass, detail })
    console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
  }
  function summary(title) {
    const passed = checks.filter(item => item.pass).length
    console.log(`\n${title}：${passed}/${checks.length} 通过`)
    if (passed !== checks.length) {
      console.log('失败项：')
      for (const item of checks.filter(entry => !entry.pass)) console.log(`  - ${item.name} :: ${item.detail}`)
    }
    return passed === checks.length
  }
  return { check, summary, results: () => checks.slice() }
}

module.exports = { CdpClient, waitForMainWindow, createChecker, sleep }
