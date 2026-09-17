/**
 * 通用只读探针：在指定平台店铺里打开某页 → 点开某个文案（菜单/悬浮卡）→ dump 落地地址、
 * 「标签 + 值」、表格行、以及形如统一社会信用代码的串（含掩码形态）。
 *
 * 只做导航 + 视图切换点击，不点任何提交/保存类按钮。
 * 用法：SHOPILOT_CDP_PORT=9250 node wx-invite-test/probe-click-text.mjs <平台名> <url> <文案1> [文案2 …]
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const [platform, url, ...texts] = process.argv.slice(2)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const listTargets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())

class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.onmessage = e => { const m = JSON.parse(e.data); const p = this.pend.get(m.id); if (p) { this.pend.delete(m.id); p(m) } } }
  static async attach(u) { const ws = new WebSocket(u); await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err }); return new Page(ws) }
  send(method, params = {}) { return new Promise((ok, err) => { const id = ++this.id; this.pend.set(id, m => (m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async q(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) return 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250); return r.result?.value }
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  nav(u) { return this.send('Page.navigate', { url: u }) }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

const WALK = `const all = []; const walk = r => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }; walk(document);`

const DUMP = `(() => { ${WALK}
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').replace(/\\s+/g,' ').trim()
  const labels = []
  const seen = new Set()
  for (const el of all) {
    const t = own(el)
    if (!t || t.length > 60) continue
    if (!/主体|资质|执照|信用代码|纳税人|商户|经营者|企业名称|公司名称|注册号|证件/.test(t)) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    const sib = el.parentElement ? String(el.parentElement.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 200) : ''
    const k = t + '|' + sib
    if (seen.has(k)) continue
    seen.add(k)
    labels.push(t + '   ⇒   ' + (sib === t ? '(无同级值)' : sib))
  }
  const rows = all.filter(e => e.tagName === 'TR').map(tr => String(tr.innerText || '').replace(/\\s+/g,' ').trim()).filter(Boolean).slice(0, 12)
  const txt = all.map(e => String(e.innerText || '')).join(' \\n ')
  const codes = [...new Set((txt.match(/[0-9A-Z]{15,20}/g) || []))].filter(c => !/^[A-Z]{6,}$/.test(c)).slice(0, 10)
  const masked = [...new Set((txt.match(/[0-9A-Z]{2,6}\\*{3,}[0-9A-Z]{2,6}/g) || []))].slice(0, 10)
  return JSON.stringify({ labels: labels.slice(0, 25), rows, codes, masked }, null, 1)
})()`

const uiT = (await listTargets()).find(t => t.type === 'page' && t.url.includes('/renderer/index.html'))
const ui = await Page.attach(uiT.webSocketDebuggerUrl)
const s = await ui.q(`(async () => (await window.shopilot.store.list()).data.find(x => x.platform === ${JSON.stringify(platform)}))()`)
if (!s) { console.log('没找到该平台店铺:', platform); process.exit(1) }
console.log(`目标店铺: ${s.platform} / ${s.name}`)
await ui.q(`(async () => await window.shopilot.browser.open(${JSON.stringify(s.id)}))()`)
await sleep(4000)
const tabs = await ui.q(`(async () => (await window.shopilot.browser.tab.list(${JSON.stringify(s.id)})).data.tabs)()`)
let page = null
let tab = null
for (const t of tabs) {
  const tg = (await listTargets()).find(x => x.type === 'page' && x.url === t.url)
  if (tg) { page = await Page.attach(tg.webSocketDebuggerUrl); tab = t; break }
}
if (!page) { console.log('拿不到页面目标'); process.exit(1) }

await page.nav(url)
await sleep(10000)
console.log('落地:', await page.q(`location.href`), '|', await page.q(`document.title`))

for (const text of texts) {
  const box = await page.q(`(() => { ${WALK}
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').replace(/\\s+/g,' ').trim()
    const hit = all.find(el => own(el) === ${JSON.stringify(text)} && el.getBoundingClientRect().width > 0)
    if (!hit) return null
    let cur = hit
    for (let i = 0; i < 5 && cur; i++) { if (/cursor-pointer|menu|item|tab|link/i.test(String(cur.className||'')) && cur.getBoundingClientRect().width > 0) break; cur = cur.parentElement }
    const target = cur || hit
    target.scrollIntoView({ block: 'center' })
    const r = target.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), cls: String(target.className || '').slice(0, 70), tag: target.tagName }
  })()`)
  if (!box) { console.log(`\n--- 「${text}」没找到`); continue }
  await page.click(box.x, box.y)
  await sleep(6000)
  console.log(`\n--- 点「${text}」(${box.tag}.${box.cls}) 后：${await page.q(`location.href`)}`)
  console.log(await page.q(DUMP))
}

page.close()
await ui.q(`(async () => await window.shopilot.browser.close(${JSON.stringify(s.id)}))()`)
ui.close()
