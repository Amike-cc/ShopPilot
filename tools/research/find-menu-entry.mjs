/**
 * 抓店铺后台**自己的菜单/路由接口**，回答"这个平台到底有没有某个功能的入口"。
 *
 * 为什么需要它：左侧导航只渲染**有权限**的条目，肉眼翻导航翻不到不等于平台没有该页
 * （可能是权限门槛、也可能藏在二级页）。而菜单树是后端下发的——接口响应里有没有那个功能，
 * 是能直接看出来的事实。
 *
 * 只读：Network.enable + 刷新页面 + 读响应体，不改任何数据。
 *
 * 用法：node tools/research/find-menu-entry.mjs <URL片段> <关键词> [CDP端口]
 *   node tools/research/find-menu-entry.mjs jinritemai 税
 */
const NEEDLE = process.argv[2] || 'jinritemai'
// 命令行传中文会被 PowerShell 的编码搞坏（会变成乱码，于是"搜不到"是假的）→
// 约定用 \uXXXX 转义传参，这里还原。踩过：搜「税」得到 0 命中，其实是关键词本身就是乱的。
const KEYWORD = (process.argv[3] || '\\u7a0e').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
const PORT = process.argv[4] || '9250'
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
      this.events = (this.events || 0) + (msg.method ? 1 : 0)
      if (msg.method === 'Network.responseReceived') {
        const r = msg.params.response
        if (/json/i.test(r.mimeType || '') || /json/i.test(r.url || '')) {
          this.responses.push({ requestId: msg.params.requestId, url: r.url, status: r.status })
        }
      }
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(msg.error.message))
      else pending.resolve(msg.result)
    }
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
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
}

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const target = targets.find(t => (t.url || '').includes(NEEDLE))
  if (!target) throw new Error('没找到匹配的页面：' + NEEDLE)
  console.log('TARGET: ' + target.url)
  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.send('Network.enable')
  await cdp.send('Page.enable')
  console.log('已开始抓包，刷新页面…')
  // 用 location.reload() 而不是 Page.reload —— 店铺视图是 <webview>，
  // Page.reload 在这种 target 上不一定生效（实测发出去但页面没动，于是 0 条请求）
  await cdp.eval('(setTimeout(() => location.reload(), 50), true)')
  await sleep(18000)
  console.log(`（共收到 ${cdp.events || 0} 条 CDP 事件）`)

  console.log(`抓到 JSON 响应 ${cdp.responses.length} 条，逐条找「${KEYWORD}」…\n`)
  const hits = []
  for (const r of cdp.responses) {
    let body = ''
    try {
      const res = await cdp.send('Network.getResponseBody', { requestId: r.requestId })
      body = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body
    } catch { continue }
    if (!body || !body.includes(KEYWORD)) continue
    // 把关键词周围的片段切出来（接口可能很大）
    const around = []
    let idx = body.indexOf(KEYWORD)
    while (idx >= 0 && around.length < 6) {
      around.push(body.slice(Math.max(0, idx - 120), idx + 160).replace(/\s+/g, ' '))
      idx = body.indexOf(KEYWORD, idx + 1)
    }
    hits.push({ url: r.url, status: r.status, size: body.length, around })
  }

  if (!hits.length) {
    console.log(`⚠ 抓到的 ${cdp.responses.length} 条接口响应里，没有一处包含「${KEYWORD}」。`)
    console.log('（这只说明刷新这一轮跑到的接口里没有；不等于平台绝对没有该页——见脚本末尾说明）')
  }
  for (const h of hits) {
    console.log(`\n=== ${h.status}  ${h.url.slice(0, 150)}  (${h.size} 字节) ===`)
    for (const a of h.around) console.log('   …' + a + '…')
  }

  // 顺带：URL 里带 tax 的接口（路由通常与菜单同名）
  const urlHits = cdp.responses.filter(r => /tax|shui|invoice/i.test(r.url))
  console.log('\n--- URL 里带 tax/invoice 的接口 ---')
  for (const r of urlHits.slice(0, 20)) console.log('   ' + r.status + '  ' + r.url.slice(0, 140))

  cdp.close()
}

main().catch(error => { console.error('FAILED: ' + (error?.message || error)); process.exit(1) })
