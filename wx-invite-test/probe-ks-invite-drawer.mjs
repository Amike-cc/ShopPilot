/**
 * 快手达人广场：筛选区结构 + 「批量邀约」抽屉结构探查。
 * 只读：只勾 1 行、只"打开"抽屉看结构，**绝不点最终确认发送**；结束前关掉抽屉、取消勾选。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg = list.filter(x => x.type === 'page' && x.url.includes('daren')).pop()
if (!pg) { console.log('没有达人广场标签页'); process.exit(1) }
console.log('目标:', pg.url)
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value
}
const jsClick = (text, exact = true) => q(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const cands = all.filter(el => {
    const t = own(el)
    const hit = ${exact} ? t === ${JSON.stringify(text)} : t.includes(${JSON.stringify(text)})
    return hit && el.getBoundingClientRect().width > 0
  })
  if (!cands.length) return 'no-el'
  // 取最短命中（最具体）
  cands.sort((a,b) => own(a).length - own(b).length)
  let n = cands[0]; const done = []
  for (let i = 0; i < 3 && n; i++, n = n.parentElement) { try { n.click(); done.push(n.tagName) } catch { done.push('err') } }
  return JSON.stringify({ clicked: own(cands[0]).slice(0, 30), chain: done })
})()`)

console.log('\n=== ① 筛选区：按 label 分组看每个筛选行 ===')
console.log(await q(`(() => {
  const labels = ['内容标签','带货类目','带货数据','达人信息','合作信息']
  const out = []
  for (const lv of labels) {
    // 找 label 元素，然后看它所在行（父级 climb）
    const all = []
    const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
    walk(document)
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const lab = all.find(el => own(el) === lv && el.getBoundingClientRect().width > 0)
    if (!lab) { out.push(lv + ': 未找到 label'); continue }
    let row = lab.parentElement
    for (let i = 0; i < 3 && row; i++) {
      if (row.querySelectorAll('*').length > 6) break
      row = row.parentElement
    }
    const items = row ? [...row.querySelectorAll('*')].map(e => own(e)).filter(t => t && t.length <= 14) : []
    const uniq = [...new Set(items)].slice(0, 30)
    out.push(lv + ' 容器<' + (row ? row.tagName + '.' + String(row.className||'').slice(0,40) : '?') + '> 项: ' + uniq.join(' / '))
  }
  return out.join('\\n')
})()`))

console.log('\n=== ② 「已选N条」与批量按钮 ===')
console.log(await q(`(() => {
  const body = String(document.body.innerText||'').replace(/\\s+/g,' ')
  const m = body.match(/已选\\s*\\d+\\s*条/)
  const btns = [...document.querySelectorAll('button, [role=button]')].map(b => String(b.innerText||'').replace(/\\s+/g,' ').trim()).filter(t => /批量|邀约|收藏/.test(t)).slice(0, 8)
  return JSON.stringify({ 已选: m ? m[0] : null, 按钮: btns })
})()`))

console.log('\n=== ③ 勾选第一行（tbody 内第一个 checkbox）===')
console.log(await q(`(() => {
  const boxes = [...document.querySelectorAll('tbody input[type=checkbox]')]
  if (!boxes.length) return 'no-checkbox'
  const b = boxes[0]
  if (b.checked) return 'already-checked'
  b.click()
  const label = b.closest('label')
  if (label) label.click()
  return 'clicked; checked=' + b.checked
})()`))
await sleep(2500)
console.log('勾选后:', await q(`(() => {
  const body = String(document.body.innerText||'').replace(/\\s+/g,' ')
  const m = body.match(/已选\\s*\\d+\\s*条/)
  return m ? m[0] : '(没找到已选计数)'
})()`))

console.log('\n=== ④ 点「批量邀约」打开抽屉（只看结构，不确认）===')
console.log(await jsClick('批量邀约'))
await sleep(4000)

console.log('\n=== ⑤ 抽屉结构 ===')
console.log(await q(`(() => {
  // 抽屉/弹层通常 position:fixed 且面积较大
  const all = [...document.querySelectorAll('*')]
  const fixed = all.filter(el => {
    const cs = getComputedStyle(el)
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false
    const r = el.getBoundingClientRect()
    return r.width > 300 && r.height > 200 && r.top < innerHeight && r.bottom > 0
  }).map(el => {
    const r = el.getBoundingClientRect()
    return { tag: el.tagName, cls: String(el.className||'').slice(0, 60), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) }
  }).slice(0, 12)
  const textareas = [...document.querySelectorAll('textarea')].map(t => ({ ph: t.placeholder || '', cls: String(t.className||'').slice(0,40) }))
  const inputs = [...document.querySelectorAll('input')].filter(i => i.type !== 'checkbox' && i.getBoundingClientRect().width > 60).map(i => ({ type: i.type, ph: i.placeholder || '', cls: String(i.className||'').slice(0,40) }))
  return JSON.stringify({ 浮层: fixed, textarea: textareas, 可见input: inputs }, null, 1)
})()`))

console.log('\n=== ⑥ 抽屉里的按钮文案 ===')
console.log(await q(`(() => {
  const out = []
  for (const b of document.querySelectorAll('button, [role=button], span, div')) {
    const t = String(b.innerText||'').replace(/\\s+/g,' ').trim()
    if (!t || t.length > 12) continue
    if (!/确认|发送|取消|关闭|邀约|提交/.test(t)) continue
    const r = b.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    out.push(t + '  <' + b.tagName + '.' + String(b.className||'').slice(0,36) + '> y=' + Math.round(r.top))
  }
  return [...new Set(out)].slice(0, 25).join('\\n')
})()`))

console.log('\n=== ⑦ 抽屉正文片段 ===')
console.log(String(await q(`String(document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 1400)`)))

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-ks-invite-drawer.png', Buffer.from(shot.data, 'base64'))
console.log('\n截图已存 wx-invite-test/ui-ks-invite-drawer.png')
ws.close()
setTimeout(() => process.exit(0), 200)
