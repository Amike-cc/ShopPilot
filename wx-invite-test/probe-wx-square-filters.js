/**
 * 微信小店「带货者广场」筛选实测探针（只读，不发邀约）
 *
 * 目的：把广场筛选区的**真实结构**量出来——行标签（带货类目 / 带货销售总额 / 其他筛选…）、
 * 每行的交互形态（chip 直接点 / 下拉 / 区间输入）、以及可点选项的准确文案。
 * 项目红线：档案里的每一项都必须来自真机实测，不能猜，所以先量后写代码。
 *
 * 前置：应用带 --remote-debugging-port=<PORT> 启动，且「微信小店」店铺处于登录态。
 * 用法：node wx-invite-test/probe-wx-square-filters.js
 * 产出：控制台 JSON + wx-invite-test/evidence/square-filters-*.json / .png
 */
import fs from 'node:fs'
import path from 'node:path'

const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = process.env.SHOPILOT_WX_SQUARE || 'https://store.weixin.qq.com/shop/findersquare/find'
const OUT_DIR = path.resolve('wx-invite-test/evidence')

const ENUM_ALL = `function ENUM_ALL(){const o=[];const w=r=>{for(const e of r.querySelectorAll('*')){o.push(e);if(e.shadowRoot)w(e.shadowRoot)};if(r.shadowRoot)w(r.shadowRoot)};w(document);return o}`

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function listTargets() {
  return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let seq = 0
  const pending = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params = {}) => new Promise((ok, err) => {
    const id = ++seq
    pending.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true
    })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400))
    return r.result.value
  }
  return { send, ev, close: () => ws.close() }
}

const deepEval = (body) => `(() => { ${ENUM_ALL}\n${body} })()`

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const targets = await listTargets()
  const renderer = targets.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  if (!renderer) throw new Error('未找到应用渲染层页面：应用需要用 --remote-debugging-port 启动')
  const app = await connect(renderer)
  console.log('[1] 渲染层已连接')

  const displayed = await app.ev(`(async () => JSON.stringify(await window.shopilot.browser.display(${JSON.stringify(STORE)})))()`)
  console.log('[2] browser.display:', displayed)
  await app.ev(`(async () => JSON.stringify(await window.shopilot.browser.setViewport({ x: 0, y: 0, width: 1380, height: 840 })))()`)
  await sleep(2500)

  // 不传任何筛选项：先把广场打开（这一步同时暴露登录态是否过期）
  const prepared = await app.ev(`(async () => JSON.stringify(await window.shopilot.browser.prepareInviteSquare(${JSON.stringify(STORE)}, { url: ${JSON.stringify(SQUARE)} })))()`)
  console.log('[3] prepareInviteSquare:', String(prepared).slice(0, 500))
  await sleep(6000)

  const after = await listTargets()
  // 店铺页面是主窗口里的 <webview>：调试目标类型是 **webview**（不是 page），按 URL 匹配即可
  const page = after.find(t => /store\.weixin\.qq\.com/.test(String(t.url)))
  if (!page) {
    console.log('可用 target：\n' + after.map(t => `${t.type} ${t.url}`).join('\n'))
    throw new Error('未找到微信小店页面（可能是店铺窗口没打开或登录页）')
  }
  const wx = await connect(page)
  const href = await wx.ev('location.href')
  console.log('[4] 当前页面:', href)

  const overview = await wx.ev(deepEval(`
    const out = []
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const all = ENUM_ALL()
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    for (const el of all) {
      const o = own(el)
      if (!o || o.length > 30) continue
      if (!/带货类目|带货销售总额|销售总额|带货数据|其他筛选|带货者类型|全部带货者/.test(o)) continue
      if (!vis(el)) continue
      const r = el.getBoundingClientRect()
      let p = el, hops = 0
      while (p && hops < 3 && !(String(p.innerText || '').length > o.length + 4)) { p = p.parentElement; hops++ }
      out.push({
        text: o, tag: el.tagName, cls: String(el.className || '').slice(0, 70),
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        parentText: String((p && p.innerText) || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
        parentTag: p ? p.tagName + '.' + String(p.className || '').slice(0, 60) : null
      })
    }
    return JSON.stringify({ url: location.href, rows: out.slice(0, 40) }, null, 1)
  `))
  console.log('[5] 行标签命中：\n' + overview)
  fs.writeFileSync(path.join(OUT_DIR, 'square-filters-overview.json'), String(overview))

  const controls = await wx.ev(deepEval(`
    const all = ENUM_ALL()
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0 && r.y < 1200 }
    const out = []
    const seen = new Set()
    for (const el of all) {
      if (!['LABEL', 'INPUT', 'BUTTON', 'SELECT', 'LI', 'SPAN', 'DIV'].includes(el.tagName)) continue
      if ((el.tagName === 'INPUT') && !['checkbox', 'radio', 'text'].includes(el.type)) continue
      if (!vis(el)) continue
      const t = String(el.innerText || '').replace(/\\s+/g, ' ').trim()
      if (t.length > 40) continue
      const key = el.tagName + '|' + (el.value || '') + '|' + t
      if (seen.has(key)) continue
      seen.add(key)
      const r = el.getBoundingClientRect()
      out.push({ tag: el.tagName, type: el.type || null, t: t || null, v: el.value || null, cls: String(el.className || '').slice(0, 50), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] })
    }
    return JSON.stringify({ count: out.length, items: out.slice(0, 120) }, null, 1)
  `))
  console.log('[6] 可见控件（截断）：\n' + String(controls).slice(0, 4000))
  fs.writeFileSync(path.join(OUT_DIR, 'square-filter-controls.json'), String(controls))

  const bodyText = await wx.ev(deepEval(`
    const t = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ')
    return JSON.stringify({ len: t.length, head: t.slice(0, 1500) }, null, 1)
  `))
  console.log('[7] 页面文本头部：\n' + bodyText)

  try {
    const shot = await wx.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT_DIR, 'square-filters.png'), Buffer.from(shot.data, 'base64'))
    console.log('[8] 截图已存 wx-invite-test/evidence/square-filters.png')
  } catch (e) {
    console.log('[8] 截图失败:', e.message)
  }

  wx.close()
  app.close()
  process.exit(0)
}

main().catch(err => { console.error('ERR', err.message); process.exit(1) })
