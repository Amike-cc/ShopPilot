/**
 * 通用 CDP 求值器（真机勘察用）：连到正在运行的实例里某个页面/店铺视图，跑一段 JS 并把结果打出来。
 *
 * 存在的理由：登记锚点前要反复"看一眼真实 DOM 长什么样"，每次都写一个脚本太重。
 * **只读**：默认只求值，不点击、不导航；要动页面请自己在表达式里写清楚（并在注释里说明为什么安全）。
 *
 * 用法：
 *   node tools/research/cdp-eval.mjs <URL片段> "<JS 表达式>" [CDP端口]
 *   node tools/research/cdp-eval.mjs --list [CDP端口]
 */
const args = process.argv.slice(2)
const PORT = args.includes('--list') ? (args[2] || '9250') : (args[2] || '9250')

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
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

const main = async () => {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  if (args[0] === '--list' || !args[0]) {
    for (const t of targets) console.log(`${t.type}\t${t.url}`)
    return
  }
  const needle = args[0]
  const expression = args[1]
  if (!expression) throw new Error('缺少 JS 表达式')
  const target = targets.find(t => (t.url || '').includes(needle))
  if (!target) throw new Error('没找到匹配的 target：' + needle)
  const cdp = new CDP(target.webSocketDebuggerUrl)
  const value = await cdp.eval(expression)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  cdp.close()
}

main().catch(error => { console.error('FAILED: ' + (error?.message || error)); process.exit(1) })
