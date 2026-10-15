/**
 * 在页面的**前端 JS 包里搜路由/文案**（真机勘察工具）。
 *
 * 用途：后台导航只渲染有权限的入口，翻不到不等于平台没有该页。
 *  · 接口流量（find-menu-entry.mjs）能看出"当前这一页会请求什么"；
 *  · 前端路由表能看出"这个后台**一共有哪些页**"——SPA 的路由都打包在 JS 里。
 * 两个都查过还说没有，才算真的没有。
 *
 * 只读：fetch 同源 JS 包并在内存里做正则，不改任何数据。
 *
 * 用法：node tools/research/search-bundles.mjs <URL片段> <正则> [CDP端口]
 *   node tools/research/search-bundles.mjs store.weixin.qq.com "/shop[-a-zA-Z0-9_/]*tax[a-zA-Z0-9_/-]*"
 *   node tools/research/search-bundles.mjs mms.pinduoduo.com "涉税"
 */
const NEEDLE = process.argv[2] || ''
// 命令行传中文会被 PowerShell 的编码搞坏 → 约定用 \uXXXX 转义传参（正则里 \uXXXX 本来就合法，
// 顺手也支持纯 ASCII 的正则）
const PATTERN = process.argv[3] || 'tax'
const PORT = process.argv[4] || '9250'
const MAX_BYTES = 8_000_000

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
  const target = targets.find(t => (t.url || '').includes(NEEDLE))
  if (!target) throw new Error('没找到匹配的页面：' + NEEDLE)
  console.log('TARGET: ' + target.url)
  const cdp = new CDP(target.webSocketDebuggerUrl)
  const out = await cdp.eval(`
    const re = new RegExp(${JSON.stringify(PATTERN)}, 'gi')
    const urls = [...new Set(performance.getEntriesByType('resource').map(r => r.name).filter(n => /\\.js(\\?|$)/.test(n)))]
    const hits = []
    const skipped = []
    for (const u of urls) {
      let txt = ''
      try {
        const res = await fetch(u)
        txt = await res.text()
      } catch (e) { skipped.push(u.slice(-60) + ' (fetch失败)'); continue }
      if (txt.length > ${MAX_BYTES}) { skipped.push(u.slice(-60) + ' (' + Math.round(txt.length / 1024) + 'KB 太大)'); continue }
      const found = [...new Set(txt.match(re) || [])]
      if (found.length) {
        // 把每处命中的**上下文**也带回来：只看一个词（如 TaxByQuarter）判断不了它是路由、组件名还是接口
        const context = []
        const rx = new RegExp(${JSON.stringify(PATTERN)}, 'gi')
        let m
        while ((m = rx.exec(txt)) && context.length < 8) {
          context.push(txt.slice(Math.max(0, m.index - 120), m.index + 160).replace(/\\s+/g, ' '))
          if (m.index === rx.lastIndex) rx.lastIndex++
        }
        hits.push({ script: u.slice(-70), matches: found.slice(0, 12), total: found.length, context })
      }
    }
    return { scripts: urls.length, skipped, hits }
  `)
  console.log(`加载的 JS 包 ${out.scripts} 个；命中 ${out.hits.length} 个`)
  for (const h of out.hits) {
    console.log(`\n=== …${h.script}  (${h.total} 处命中) ===`)
    for (const m of h.matches) console.log('   ' + m.slice(0, 160))
    for (const c of h.context || []) console.log('   …' + c.slice(0, 260) + '…')
  }
  if (out.skipped.length) {
    console.log('\n--- 跳过的包 ---')
    for (const s of out.skipped.slice(0, 10)) console.log('   ' + s)
  }
  if (!out.hits.length) console.log(`\n⚠ 加载到的 JS 包里没有一处匹配 ${PATTERN}（注意：懒加载的包不在这一批里）`)
  cdp.close()
}

main().catch(error => { console.error('FAILED: ' + (error?.message || error)); process.exit(1) })
