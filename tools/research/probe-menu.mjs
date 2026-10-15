/**
 * 用**真实鼠标事件**悬停/点击后台导航，并把随后出现的菜单项列出来（真机勘察工具）。
 *
 * 为什么不能用 JS 的 `el.click()`：后台导航多是 React 组件，展开二级菜单靠的是
 * `mouseenter` 这类**受信任事件**；JS 造的合成事件经常不触发（实测微信小店、
 * 抖店都这样），于是"点了没反应"其实是工具的问题，不是页面没有那个入口。
 *
 * 只读：只悬停/点开导航，不点任何提交、导出、删除类按钮。
 *
 * 用法：node tools/research/probe-menu.mjs <URL片段> <导航项文案的Unicode转义> [CDP端口]
 *   node tools/research/probe-menu.mjs store.weixin.qq.com '\u8d44\u91d1\u7ed3\u7b97'
 */
const NEEDLE = process.argv[2] || ''
const LABEL_ESC = process.argv[3] || ''
const PORT = process.argv[4] || '9250'
// 命令行传中文会被 PowerShell 的编码搞坏，所以用 \uXXXX 转义传，这里还原
const LABEL = LABEL_ESC.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
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

const main = async () => {
  if (!LABEL) throw new Error('要给出导航项文案')
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const target = targets.find(t => (t.url || '').includes(NEEDLE))
  if (!target) throw new Error('没找到匹配的页面：' + NEEDLE)
  console.log('TARGET: ' + target.url)
  const cdp = new CDP(target.webSocketDebuggerUrl)

  const box = await cdp.eval(`(() => {
    const label = ${JSON.stringify(LABEL)}
    const els = [...document.querySelectorAll('a,li,div,span')].filter(e => (e.textContent || '').trim() === label)
    // 取**可见**的那个（同一个文案常常有隐藏副本，rect 全 0）
    const el = els.map(e => ({ e, r: e.getBoundingClientRect() })).find(x => x.r.width > 0 && x.r.height > 0)
    if (!el) return { found: false, count: els.length }
    return { found: true, count: els.length, x: Math.round(el.r.x + el.r.width / 2), y: Math.round(el.r.y + el.r.height / 2), w: Math.round(el.r.width) }
  })()`)
  console.log('导航项: ' + JSON.stringify(box))
  if (!box.found) throw new Error('页面上找不到可见的「' + LABEL + '」')

  const before = await cdp.eval(`document.body.innerText.length`)
  // 真实鼠标移过去（带动画帧，模拟人手移动）
  for (const step of [0, 0.5, 1]) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: box.x, y: Math.round(box.y - 10 + 20 * step), buttons: 0
    })
    await sleep(250)
  }
  await sleep(1500)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await sleep(200)
  }
  await sleep(2500)

  const after = await cdp.eval(`(() => {
    const out = []
    const seen = new Set()
    for (const el of document.querySelectorAll('a,li,div,span')) {
      const t = (el.textContent || '').replace(/\\s+/g, ' ').trim()
      if (!t || t.length > 16 || el.children.length > 0) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.x > 460) continue
      if (seen.has(t)) continue
      seen.add(t)
      out.push(t + ' @' + Math.round(r.x) + ',' + Math.round(r.y))
    }
    return { url: location.href, textLen: document.body.innerText.length, items: out }
  })()`)
  console.log('URL: ' + after.url + '  文本长度 ' + before + ' → ' + after.textLen)
  console.log('--- 左侧可见条目 ---')
  for (const it of after.items.slice(0, 60)) console.log('   ' + it)
  cdp.close()
}

main().catch(error => { console.error('FAILED: ' + (error?.message || error)); process.exit(1) })
