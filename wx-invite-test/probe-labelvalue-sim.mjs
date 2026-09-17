/**
 * 只读预演：在真实页面上按 readLabelValue 的**同一套算法**（自有文本含 label → 向上找
 * "文本比 label 只多一小段"的最近祖先 → 多出来的那段即值）模拟读取，确认锚点可用。
 * 可选先 hover / click 某文案（悬浮卡场景）。
 *
 * 用法：SHOPILOT_CDP_PORT=9250 node wx-invite-test/probe-labelvalue-sim.mjs <平台> <url> <--hover|--click 文案> <label1> [label2…]
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const argv = process.argv.slice(2)
const platform = argv[0]
const url = argv[1]
const rest = argv.slice(2)
const action = rest[0] === '--hover' || rest[0] === '--click' ? rest.shift() : null
const actionText = action ? rest.shift() : null
const labels = rest
const sleep = ms => new Promise(r => setTimeout(r, ms))
const listTargets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())

class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.onmessage = e => { const m = JSON.parse(e.data); const p = this.pend.get(m.id); if (p) { this.pend.delete(m.id); p(m) } } }
  static async attach(u) { const ws = new WebSocket(u); await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err }); return new Page(ws) }
  send(method, params = {}) { return new Promise((ok, err) => { const id = ++this.id; this.pend.set(id, m => (m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async q(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) return 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250); return r.result?.value }
  async move(x, y) { await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }) }
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  nav(u) { return this.send('Page.navigate', { url: u }) }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

// 与 task-runner readLabelValue 完全同构的算法（deep 时穿透 ShadowRoot）
const SIM = (label, max = 40) => `(() => {
  const all = []
  const walk = r => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const cands = []
  for (const el of all) {
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    if (!own.includes(${JSON.stringify(label)})) continue
    if (!vis(el)) continue
    cands.push({ el, len: own.length })
  }
  if (!cands.length) return JSON.stringify({ ok: false, reason: 'NOT_FOUND' })
  cands.sort((a, b) => a.len - b.len)
  let node = cands[0].el
  for (let i = 0; i < 6 && node && node !== document.body; i++) {
    const txt = String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim()
    if (txt.length > ${JSON.stringify(label)}.length) {
      const value = txt.replace(${JSON.stringify(label)}, '').trim()
      if (value && value.length <= ${max}) return JSON.stringify({ ok: true, value, cardText: txt.slice(0, 80) })
      if (value && value.length > ${max}) return JSON.stringify({ ok: false, reason: 'VALUE_TOO_LONG', cardText: txt.slice(0, 120) })
    }
    node = node.parentElement
  }
  return JSON.stringify({ ok: false, reason: 'NO_VALUE_SIBLING' })
})()`

const uiT = (await listTargets()).find(t => t.type === 'page' && t.url.includes('/renderer/index.html'))
const ui = await Page.attach(uiT.webSocketDebuggerUrl)
const s = await ui.q(`(async () => (await window.shopilot.store.list()).data.find(x => x.platform === ${JSON.stringify(platform)}))()`)
console.log(`目标店铺: ${s.platform} / ${s.name}`)
await ui.q(`(async () => await window.shopilot.browser.open(${JSON.stringify(s.id)}))()`)
await sleep(4000)
const tabs = await ui.q(`(async () => (await window.shopilot.browser.tab.list(${JSON.stringify(s.id)})).data.tabs)()`)
let page = null
for (const t of tabs) {
  const tg = (await listTargets()).find(x => x.type === 'page' && x.url === t.url)
  if (tg) { page = await Page.attach(tg.webSocketDebuggerUrl); break }
}
await page.nav(url)
await sleep(10000)
console.log('落地:', await page.q(`location.href`), '|', await page.q(`document.title`))

if (action) {
  const box = await page.q(`(() => {
    const all = []; const walk = r => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }; walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').replace(/\\s+/g,' ').trim()
    const hit = all.find(el => own(el) === ${JSON.stringify(actionText)} && el.getBoundingClientRect().width > 0)
    if (!hit) return null
    let cur = hit
    for (let i = 0; i < 5 && cur; i++) { if (/cursor-pointer|hover|popover__target|item|menu/i.test(String(cur.className||'')) && cur.getBoundingClientRect().width > 0) break; cur = cur.parentElement }
    const t = cur || hit
    t.scrollIntoView({ block: 'center' })
    const r = t.getBoundingClientRect()
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), cls: String(t.className||'').slice(0,60) }
  })()`)
  console.log(`${action} 「${actionText}」于`, JSON.stringify(box))
  if (box && box.x) {
    if (action === '--hover') for (let i = 0; i < 6; i++) { await page.move(box.x, box.y); await sleep(400) }
    else await page.click(box.x, box.y)
    await sleep(2500)
  }
}

for (const label of labels) {
  console.log(`\n[readLabelValue 模拟] label=「${label}」`)
  console.log('  ', await page.q(SIM(label)))
}

// 悬浮卡可见性快照（判断 popover 是否真被打开）
console.log('\n--- 相关元素可见性 ---')
console.log(await page.q(`(() => {
  const all = []; const walk = r => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }; walk(document)
  const out = []
  for (const el of all) {
    const t = String(el.innerText || '').replace(/\\s+/g,' ').trim()
    if (!t || t.length > 200) continue
    if (!/商户名称|统一社会信用代码|注册号/.test(t)) continue
    const r = el.getBoundingClientRect()
    out.push('[' + el.tagName + '.' + String(el.className||'').slice(0,40) + '] vis=' + (r.width>0&&r.height>0) + ' :: ' + t.slice(0,120))
  }
  return out.slice(0, 10).join('\\n')
})()`))

page.close()
await ui.q(`(async () => await window.shopilot.browser.close(${JSON.stringify(s.id)}))()`)
ui.close()
