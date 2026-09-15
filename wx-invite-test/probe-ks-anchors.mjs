/**
 * 快手达人广场：剩余锚点一次性摸清（只读/可逆）
 *  A. 筛选行：从 label 到行容器的祖先层级 + 行 class
 *  B. 商品弹窗根容器 class
 *  C. 带货类目 chip → 下拉叶子 的选中效果（是否出现"已选/已筛选"视觉）
 *  D. 合作信息 chip 点击后的状态变化
 * 结束前恢复（再点一次取消 / 刷新页面）。
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
const ownClick = (t) => q(`(() => {
  const all = [...document.querySelectorAll('*')]
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const narrow = (x) => String(x).replace(/\\s+/g, '')
  const c = all.filter(el => narrow(own(el)).includes(narrow(${JSON.stringify(t)})) && el.getBoundingClientRect().width > 0)
  if (!c.length) return 'no-el'
  c.sort((a,b) => narrow(own(a)).length - narrow(own(b)).length)
  let n = c[0]; const done = []
  for (let i = 0; i < 3 && n; i++, n = n.parentElement) { try { n.click(); done.push(n.tagName) } catch { done.push('err') } }
  return JSON.stringify({ own: own(c[0]).slice(0,20), chain: done })
})()`)

console.log('=== A. 筛选行：label → 行的层级 ===')
console.log(await q(`(() => {
  const all = [...document.querySelectorAll('*')]
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const out = []
  for (const lv of ['内容标签','带货类目','合作信息','达人信息']) {
    const lab = all.find(el => own(el) === lv && el.getBoundingClientRect().width > 0)
    if (!lab) { out.push(lv + ': 未找到'); continue }
    let n = lab; const chain = []
    for (let i = 0; i < 7 && n; i++, n = n.parentElement) {
      chain.push(n.tagName + '.' + String(n.className||'').split(' ').slice(0,2).join('.').slice(0,44))
    }
    out.push(lv + ' 层级: ' + chain.join(' → '))
  }
  // 行容器 class 全名
  const rows = [...document.querySelectorAll('[class*=pc-row]')].map(r => String(r.className||'').split(' ')[0])
  out.push('行 class 样本: ' + [...new Set(rows)].slice(0,6).join(' | '))
  return out.join('\\n')
})()`))

console.log('\n=== B. 商品弹窗根容器 class（先勾2行走一遍）===')
await q(`(() => { const bs=[...document.querySelectorAll('tbody input[type=checkbox]')].filter(b=>!b.checked); for (const b of bs.slice(0,2)) (b.closest('label')||b).click(); return 1 })()`)
await sleep(2000)
await ownClick('批量邀约'); await sleep(4500)
await ownClick('选择商品'); await sleep(4500)
console.log(await q(`(() => {
  const fx = [...document.querySelectorAll('div')].filter(e => { const cs=getComputedStyle(e); const r=e.getBoundingClientRect(); return cs.position==='fixed' && r.width>500 && r.height>300 && parseInt(cs.zIndex||'0',10)>=1000 })
  return JSON.stringify(fx.map(e => ({ cls: String(e.className||'').slice(0,90), w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) })).slice(0,8), null, 1)
})()`))
console.log('弹窗内 tbody 复选框数:', await q(`(() => {
  const m = [...document.querySelectorAll('[class*=modal]')].find(e => e.getBoundingClientRect().width > 400 && e.getBoundingClientRect().height > 200)
  return m ? m.querySelectorAll('tbody input[type=checkbox]').length : 'no-modal'
})()`))
console.log('用 [class*=modal] + tbody 统计行数:', await q(`(() => {
  const m = [...document.querySelectorAll('[class*=modal]')].find(e => e.getBoundingClientRect().width > 400 && e.getBoundingClientRect().height > 200)
  return m ? m.querySelectorAll('tbody tr').length : 'no-modal'
})()`))
// 关商品弹窗
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await sleep(1500)
// 关抽屉
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await sleep(2000)

console.log('\n=== C. 带货类目 chip → 下拉叶子 ===')
console.log('点 chip「个护家清」:', await ownClick('个护家清'))
await sleep(3000)
console.log('下拉内容:', await q(`(() => {
  const d = [...document.querySelectorAll('[class*=select-dropdown]')].filter(e => e.getBoundingClientRect().height > 40)
  return d.length ? String(d[0].innerText||'').replace(/\\s+/g,' ').trim().slice(0,200) : '(无下拉)'
})()`))
console.log('点叶子「全部」:', await ownClick('全部'))
await sleep(3500)
console.log('点完后的视觉线索:', await q(`(() => {
  const b = String(document.body.innerText||'').replace(/\\s+/g,' ')
  const m = b.match(/(已选[^。]{0,40}|已筛选[^。]{0,40})/)
  return m ? m[0] : '(没有已选/已筛选文案)'
})()`))
console.log('chip 自身 class 是否变化:', await q(`(() => {
  const all = [...document.querySelectorAll('*')]
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const c = all.filter(el => own(el) === '个护家清').map(el => ({ tag: el.tagName, cls: String(el.className||'').slice(0,70), bg: getComputedStyle(el).backgroundColor }))
  return JSON.stringify(c, null, 1)
})()`))
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-ks-cat-selected.png', Buffer.from(shot.data, 'base64'))
console.log('截图已存 wx-invite-test/ui-ks-cat-selected.png')

console.log('\n=== D. 合作信息 chip「有联系方式」点击前后 ===')
console.log('点:', await ownClick('有联系方式'))
await sleep(3000)
console.log(await q(`(() => {
  const all = [...document.querySelectorAll('*')]
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const c = all.filter(el => own(el) === '有联系方式').map(el => ({ tag: el.tagName, cls: String(el.className||'').slice(0,70), bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }))
  return JSON.stringify(c, null, 1)
})()`))

console.log('\n=== 收尾：刷新页面恢复 ===')
await send('Page.navigate', { url: 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro' })
await sleep(12000)
console.log('收尾计数:', await q(`(() => { const re=/已选(?:择)?\\s*(\\d+)/; for (const el of document.querySelectorAll('div,span,p,b,strong,em')) { const t=String(el.innerText||'').replace(/\\s+/g,' ').trim(); if (t.length>40) continue; const m=re.exec(t); if (m) return m[0] } return null })()`))
ws.close()
setTimeout(() => process.exit(0), 200)
