/**
 * 抓某个接口的**完整响应体**（真机勘察工具）。
 *
 * 与 find-menu-entry.mjs 的分工：那个是"关键词命中了才打印上下文"，
 * 适合找"哪个接口提到了某个词"；这个是"我知道是哪个接口了，把它的数据形状整个看一遍"。
 *
 * 为什么需要：涉税报送这类接口的响应体里**只有数据、没有中文标签**
 * （实测微信小店 listQuarterTax 的响应里一个「税」字都没有，标签全在前端），
 * 用关键词搜会漏掉它，必须按 URL 精确取。
 *
 * 只读：只刷新页面 + 读响应体。
 *
 * 用法：node tools/research/dump-api.mjs <页面URL片段> <接口URL子串> [CDP端口]
 *   node tools/research/dump-api.mjs moneyManage listQuarterTax
 */
const NEEDLE = process.argv[2] || ''
const API = process.argv[3] || ''
const PORT = process.argv[4] || '9250'
// 第 4 个参数：reload 后等多久再收网（毫秒）。慢页面（实测抖店发票微前端要 30s+）必须调大，
// 否则抓到的是"还没发请求"的空档。
const WAIT_MS = Number(process.argv[5] || 16000)
const MAX_PRINT = 6000
const sleep = ms => new Promise(r => setTimeout(r, ms))

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.responses = []
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    this.ws.onmessage = event => {
      const msg = JSON.parse(event.data)
      if (msg.method === 'Network.responseReceived') {
        const r = msg.params.response
        if ((r.url || '').includes(API)) this.responses.push({ requestId: msg.params.requestId, url: r.url, status: r.status })
      }
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
  const target = targets.find(t => (t.url || '').includes(NEEDLE))
  if (!target) throw new Error('没找到匹配的页面：' + NEEDLE)
  console.log('TARGET: ' + target.url)
  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.send('Network.enable')
  console.log(`开始抓「${API}」…`)
  await cdp.eval('(setTimeout(() => location.reload(), 50), true)')
  await sleep(WAIT_MS)

  if (!cdp.responses.length) {
    console.log(`⚠ 这一轮没抓到含「${API}」的接口（可能它只在切换页签时才请求）`)
    cdp.close()
    return
  }
  for (const r of cdp.responses) {
    console.log(`\n=== ${r.status}  ${r.url.slice(0, 160)} ===`)
    try {
      const res = await cdp.send('Network.getResponseBody', { requestId: r.requestId })
      const body = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body
      console.log(`长度 ${body.length}`)
      // 尽力美化：是 JSON 就格式化打印，否则原样
      try { console.log(JSON.stringify(JSON.parse(body), null, 2).slice(0, MAX_PRINT)) }
      catch { console.log(body.slice(0, MAX_PRINT)) }
    } catch (error) {
      console.log('取响应体失败: ' + (error?.message || error))
    }
  }
  cdp.close()
}

main().catch(error => { console.error('FAILED: ' + (error?.message || error)); process.exit(1) })
