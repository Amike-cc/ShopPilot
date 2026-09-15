/**
 * 快手达人广场结构探查（只读）：
 *  - 页面地址/标题/正文片段
 *  - 疑似筛选区与页签（自有文本短文案）
 *  - 表格/列表结构与复选框
 *  - 分页控件
 *  - 邀约入口按钮
 * 目的是把"实测锚点"找出来，绝不猜。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const cands = list.filter(x => x.type === 'page' && x.url.includes('kwaixiaodian') && !x.url.includes('login.'))
console.log('候选标签页:')
for (const c of cands) console.log('  -', c.url.slice(0, 130))
const pg = cands.find(c => c.url.includes('daren')) || cands[0]
if (!pg) { console.log('没有已登录的快手标签页'); process.exit(1) }
console.log('\n探查目标:', pg.url)

const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}

console.log('\n=== 概况 ===')
console.log('标题:', await q(`document.title`))
console.log('视口:', await q(`innerWidth + 'x' + innerHeight + ' vis=' + document.visibilityState`))
console.log('正文片段:', String(await q(`String(document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 700)`)))

console.log('\n=== iframe / shadow ===')
console.log(await q(`(() => {
  const ifr = [...document.querySelectorAll('iframe')].map(f => String(f.src||'').slice(0,80))
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const shadows = all.filter(e => e.shadowRoot).map(e => e.tagName).slice(0, 8)
  return JSON.stringify({ iframes: ifr, shadowHosts: shadows })
})()`))

console.log('\n=== 表格 ===')
console.log(await q(`(() => {
  const tables = [...document.querySelectorAll('table')]
  return JSON.stringify(tables.map((t, i) => ({
    第几张: i, 行数: t.querySelectorAll('tbody tr').length,
    表头: [...t.querySelectorAll('th')].map(x => String(x.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean).slice(0, 14),
    首行: (t.querySelector('tbody tr') ? [...t.querySelector('tbody tr').children].map(c => String(c.innerText||'').replace(/\\s+/g,' ').trim().slice(0,24)) : [])
  })), null, 1)
})()`))

console.log('\n=== 复选框 ===')
console.log(await q(`(() => {
  const out = []
  for (const sel of ['input[type=checkbox]', 'tbody input[type=checkbox]', '[class*=checkbox] input', '[class*=Checkbox]']) {
    const n = document.querySelectorAll(sel).length
    if (n) out.push(sel + ' × ' + n)
  }
  return out.join(' | ') || '(无复选框)'
})()`))

console.log('\n=== 疑似按钮/筛选（自身文本 2-12 字）===')
console.log(await q(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const seen = new Set(); const out = []
  for (const el of all) {
    const t = own(el)
    if (!t || t.length < 2 || t.length > 12) continue
    if (!/邀约|邀请|达人|筛选|分类|类目|等级|带货|搜索|下一页|批量|全部|确认|发送|粉丝|销量/.test(t)) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    const tag = el.tagName + '.' + String(el.className||'').slice(0, 34)
    if (seen.has(t + tag)) continue
    seen.add(t + tag)
    out.push(t + '  <' + tag + '> ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' y=' + Math.round(r.top))
  }
  return out.slice(0, 70).join('\\n')
})()`))

console.log('\n=== 分页/页脚 ===')
console.log(await q(`(() => {
  const out = []
  for (const sel of ['[class*=pagination]', '[class*=Pagination]', '[class*=pager]', '[class*=Pager]']) {
    const els = document.querySelectorAll(sel)
    if (els.length) out.push(sel + ' × ' + els.length + ' :: ' + String(els[0].innerText||'').replace(/\\s+/g,' ').trim().slice(0,100))
  }
  return out.join('\\n') || '(无分页容器)'
})()`))

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-ks-square.png', Buffer.from(shot.data, 'base64'))
console.log('\n截图已存 wx-invite-test/ui-ks-square.png')
ws.close()
setTimeout(() => process.exit(0), 200)
