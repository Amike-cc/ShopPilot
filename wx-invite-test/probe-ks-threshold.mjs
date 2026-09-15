/**
 * 快手「批量邀约」触发条件验证：分别用 1 行、2 行、3 行测试抽屉是否打开。
 * 不点「发送邀请」。每次测试后关抽屉、清勾选。
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
const COUNTER = `(() => { const re=/已选(?:择)?\\s*(\\d+)/; for (const el of document.querySelectorAll('div,span,p,b,strong,em')) { const t=String(el.innerText||'').replace(/\\s+/g,' ').trim(); if (t.length>40) continue; const m=re.exec(t); if (m) return m[0] } return null })()`
const DRAWER = `(() => {
  const dr = [...document.querySelectorAll('[class*=drawer]')].filter(e => { const cs=getComputedStyle(e); const r=e.getBoundingClientRect(); return cs.position==='fixed' && r.width>400 && r.height>200 })
  return dr.length ? 'OPEN' : null
})()`
const clear = async () => {
  for (let i = 0; i < 2; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(700)
  }
  await q(`(() => { const bs=[...document.querySelectorAll('tbody input[type=checkbox]')].filter(b=>b.checked); for (const b of bs) (b.closest('label')||b).click(); return 1 })()`)
  await sleep(1500)
}
const openDrawer = async () => {
  const loc = await q(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => String(x.innerText||'').replace(/\\s+/g,'').trim() === '批量邀约')
    if (!b) return null
    b.scrollIntoView({ block: 'center' })
    const r = b.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) })
  })()`)
  if (!loc) return 'no-button'
  const { x, y } = JSON.parse(loc)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
  await sleep(120)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  return 'clicked'
}

for (const n of [1, 2, 3]) {
  await clear()
  console.log(`\n===== 勾 ${n} 行 =====`)
  console.log(await q(`(() => {
    const bs = [...document.querySelectorAll('tbody input[type=checkbox]')].filter(b=>!b.checked)
    for (const b of bs.slice(0, ${n})) (b.closest('label')||b).click()
    return 1
  })()`))
  await sleep(2000)
  console.log('计数:', await q(COUNTER))
  console.log('点批量邀约:', await openDrawer())
  await sleep(5000)
  const opened = await q(DRAWER)
  console.log('抽屉:', opened)
  if (opened === 'OPEN') {
    console.log('抽屉标题/关键文案:', await q(`(() => {
      const d = [...document.querySelectorAll('[class*=drawer]')].filter(e => { const cs=getComputedStyle(e); const r=e.getBoundingClientRect(); return cs.position==='fixed' && r.width>400 && r.height>200 })[0]
      const t = String(d.innerText||'').replace(/\\s+/g,' ').trim()
      return t.slice(0, 200)
    })()`))
    console.log('  已选条数文案:', await q(COUNTER))
  }
}
await clear()
console.log('\n收尾计数:', await q(COUNTER), '抽屉:', await q(DRAWER))
ws.close()
setTimeout(() => process.exit(0), 200)
