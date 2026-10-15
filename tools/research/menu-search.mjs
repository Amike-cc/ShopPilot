/**
 * 在店铺后台里用**它自己的菜单搜索**找页面（真机勘察工具）。
 *
 * 为什么单独写：后台的搜索框多是 React 受控输入，`el.value = x` + `input` 事件经常不生效
 * （实测抖店就是这样），必须走 CDP 的 `Input.insertText` 发**真实输入**，React 才认。
 *
 * 只读：只往搜索框里打字并读结果，不点任何提交/导出类按钮。
 *
 * 用法：node tools/research/menu-search.mjs <URL片段> "<关键词>" [CDP端口]
 */
const NEEDLE = process.argv[2] || 'jinritemai'
const KEYWORD = process.argv[3] || '税'
const PORT = process.argv[4] || '9250'
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
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const target = targets.find(t => (t.url || '').includes(NEEDLE))
  if (!target) throw new Error('没找到匹配的页面：' + NEEDLE)
  console.log('TARGET: ' + target.url)
  const cdp = new CDP(target.webSocketDebuggerUrl)

  // 1. 找到并聚焦搜索框
  const box = await cdp.eval(`(() => {
    const el = document.querySelector('.ecom-menu-input') || document.querySelector('input[placeholder*="搜索"]') || document.querySelector('input[type=search]')
    if (!el) return null
    el.focus(); el.click()
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), ph: el.getAttribute('placeholder') || '' }
  })()`)
  if (!box) throw new Error('这个页面没有找到菜单搜索框')
  console.log('搜索框 @' + box.x + ',' + box.y + '  placeholder=' + JSON.stringify(box.ph))

  // 2. 真实鼠标点一下（有些实现要 focus 事件才展开）
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
  await sleep(500)

  // 3. **真实键盘输入**（React 受控输入只认这个）
  await cdp.send('Input.insertText', { text: KEYWORD })
  await sleep(2500)

  // 4. 读结果：输入框下方新出现的短文本
  const result = await cdp.eval(`(() => {
    const out = []
    const seen = new Set()
    for (const el of document.querySelectorAll('*')) {
      const t = (el.textContent || '').replace(/\\s+/g, ' ').trim()
      if (!t || t.length > 30 || el.children.length > 0) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      // 下拉通常紧贴输入框下方、横向也在附近
      if (r.y < 35 || r.y > 520) continue
      if (r.x < 300) continue
      const key = t + '|' + Math.round(r.x) + ',' + Math.round(r.y)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ t, tag: el.tagName, cls: String(el.className || '').slice(0, 50), x: Math.round(r.x), y: Math.round(r.y) })
    }
    return { inputValue: document.querySelector('.ecom-menu-input')?.value || '', hits: out }
  })()`)

  console.log('输入框当前值: ' + JSON.stringify(result.inputValue))
  console.log('--- 输入框附近的可见条目（' + result.hits.length + '）---')
  for (const h of result.hits.slice(0, 40)) console.log(`   「${h.t}」 ${h.tag} @${h.x},${h.y}  ${h.cls}`)

  // 5. 全页再搜一次关键词（含隐藏菜单）
  const pageHits = await cdp.eval(`(() => {
    const kw = ${JSON.stringify(KEYWORD)}
    const out = new Set()
    for (const el of document.querySelectorAll('*')) {
      const t = (el.textContent || '').replace(/\\s+/g, ' ').trim()
      if (!t || t.length > 40 || el.children.length > 0) continue
      if (!t.includes(kw)) continue
      out.add(t)
    }
    return [...out].slice(0, 30)
  })()`)
  console.log('--- 全页含「' + KEYWORD + '」的文本 ---')
  for (const t of pageHits) console.log('   ' + t)

  cdp.close()
}

main().catch(error => { console.error('FAILED: ' + (error?.message || error)); process.exit(1) })
