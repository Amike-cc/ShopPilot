/**
 * 快手：① 商品弹窗精确选择器 ② 非破坏性确认「发送邀请」是否有二次确认框
 * （在页面自己的 JS bundle 里搜文案，而不是真的点发送）。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg = list.filter(x => x.type === 'page' && x.url.includes('daren')).pop()
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 260) : r.result?.value
}
const click = (t) => q(`(() => {
  const all = [...document.querySelectorAll('*')]
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const narrow = x => String(x).replace(/\\s+/g,'')
  const c = all.filter(el => narrow(own(el)).includes(narrow(${JSON.stringify(t)})) && el.getBoundingClientRect().width > 0)
  if (!c.length) return 'no-el'
  c.sort((a,b) => narrow(own(a)).length - narrow(own(b)).length)
  let n = c[0]; const done = []
  for (let i = 0; i < 3 && n; i++, n = n.parentElement) { try { n.click(); done.push(n.tagName) } catch { done.push('err') } }
  return JSON.stringify(done)
})()`)

console.log('=== ① 开抽屉 → 开商品弹窗，验证精确选择器 ===')
await q(`(() => { const bs=[...document.querySelectorAll('tbody input[type=checkbox]')].filter(b=>!b.checked); for (const b of bs.slice(0,2)) (b.closest('label')||b).click(); return 1 })()`)
await sleep(2000)
await click('批量邀约'); await sleep(4500)
await click('选择商品'); await sleep(5000)
console.log('候选容器里的行/复选框计数:')
console.log(await q(`(() => {
  const sels = ['[class*=modal-body] tbody tr', '[class*=modal-body] tbody input[type=checkbox]', '[class*=modal-wrap] tbody tr', '.kwaishop-cps-daren-match-pc-modal-body tbody input[type=checkbox]']
  return sels.map(x => x + ' → ' + document.querySelectorAll(x).length).join('\\n')
})()`))
console.log('\n弹窗内「确认」按钮的可点祖先判定（引擎逻辑模拟）:')
console.log(await q(`(() => {
  const all = [...document.querySelectorAll('*')]
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  // 找 innerText 为「确 认」的按钮
  const b = [...document.querySelectorAll('button')].find(x => x.innerText.replace(/\\s+/g,'') === '确认' && x.getBoundingClientRect().width > 0)
  if (!b) return 'no-button'
  const chain = []
  let n = b
  for (let i = 0; i < 4 && n; i++, n = n.parentElement) chain.push(n.tagName + '.' + String(n.className||'').split(' ')[0].slice(0,44))
  return JSON.stringify({ 按钮innerText: b.innerText, 自有文本: own(b), 层级: chain }, null, 1)
})()`))

// 关弹窗与抽屉
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await sleep(1500)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await sleep(2000)

console.log('\n=== ② 在页面 JS bundle 里搜「发送邀请」周边文案（非破坏性判断有无二次确认）===')
console.log(await q(`(async () => {
  const urls = [...document.querySelectorAll('script[src]')].map(s => s.src).filter(u => u.startsWith('http'))
  const needles = ['确认发送', '确认邀请', '确认要发送', '是否确认发送', '发送邀请', '确认提交']
  const found = {}
  for (const u of urls.slice(0, 40)) {
    try {
      const t = await (await fetch(u)).text()
      for (const nd of needles) {
        const i = t.indexOf(nd)
        if (i >= 0) {
          const ctx = t.slice(Math.max(0, i - 60), i + 60).replace(/\\s+/g, ' ')
          ;(found[nd] = found[nd] || []).push(ctx)
        }
      }
    } catch {}
  }
  return JSON.stringify({ 扫描脚本数: urls.length, 命中: Object.fromEntries(Object.entries(found).map(([k,v]) => [k, v.slice(0,3)])) }, null, 1)
})()`))

console.log('\n=== ③ 顺手确认：类目筛选后有「已选1个」标记（可作生效判据）===')
console.log(await click('个护家清')); await sleep(3000)
console.log(await click('全部')); await sleep(3500)
console.log(await q(`(() => {
  const b = String(document.body.innerText||'').replace(/\\s+/g,' ')
  const m = b.match(/已选\\d+个[^ ]{0,30}/)
  return m ? m[0] : '(无)'
})()`))
console.log('该标记所在元素:')
console.log(await q(`(() => {
  const all = [...document.querySelectorAll('*')]
  const out = []
  for (const el of all) {
    const t = String(el.innerText||'').replace(/\\s+/g,' ').trim()
    if (!/^已选\\d+个/.test(t) || t.length > 40) continue
    out.push(t + '  <' + el.tagName + '.' + String(el.className||'').slice(0,50) + '>')
  }
  return out.slice(0,4).join('\\n') || '(无)'
})()`))

await send('Page.navigate', { url: 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro' })
await sleep(11000)
console.log('\n收尾计数:', await q(`(() => { const re=/已选(?:择)?\\s*(\\d+)/; for (const el of document.querySelectorAll('div,span,p,b,strong,em')) { const t=String(el.innerText||'').replace(/\\s+/g,' ').trim(); if (t.length>40) continue; const m=re.exec(t); if (m) return m[0] } return null })()`))
ws.close()
setTimeout(() => process.exit(0), 200)
