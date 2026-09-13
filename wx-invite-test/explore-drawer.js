/**
 * 抖店达人广场：选 1 行 → 打开批量邀约抽屉 → 转储抽屉内文本结构（找额度展示）。
 * 只读探查，不点抽屉里的发送。
 */
const PORT = '9250'
async function targets() {
  const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  return l.filter(t => t.type === 'page' && t.url.includes('daren-square'))
}
function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  return new Promise((ok, err) => {
    ws.onopen = () => {
      let seq = 0
      const pend = new Map()
      const send = (method, params = {}) => new Promise((ok2, err2) => {
        const id = ++seq
        pend.set(id, m => m.error ? err2(new Error(method + ' ' + JSON.stringify(m.error))) : ok2(m.result))
        ws.send(JSON.stringify({ id, method, params }))
      })
      ws.onmessage = e => {
        const m = JSON.parse(e.data)
        if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
      }
      ok({
        ev: async (expr) => {
          const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
          if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
          return r.result.value
        },
        close: () => { try { ws.close() } catch { /* */ } }
      })
    }
    ws.onerror = err
  })
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const list = await targets()
  const c = await connect(list[0])
  // 1) 勾第一行未禁用的复选框
  const r1 = await c.ev(`(() => {
    const boxes = [...document.querySelectorAll('tbody input[type=checkbox]')].filter(b => {
      const r = b.getBoundingClientRect()
      if (!(r.width > 0 && r.height > 0)) return false
      let dis = b.disabled
      let p = b.parentElement
      for (let i = 0; i < 3 && p && !dis; i++, p = p.parentElement) if (/disabled/i.test(String(p.className || ''))) dis = true
      return !dis
    })
    if (!boxes.length) return 'no-box'
    boxes[0].click()
    return 'checked-' + boxes.length
  })()`)
  console.log('step1', r1)
  await sleep(800)
  // 2) 点「批量邀约带货」
  const r2 = await c.ev(`(() => {
    const clean = s => String(s || '').replace(/\\s+/g, ' ').trim()
    const cands = [...document.querySelectorAll('*')].filter(e => {
      const own = [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
      if (!own.includes('批量邀约')) return false
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
    if (!cands.length) return 'no-btn'
    cands.sort((a, b) => own0(a) - own0(b))
    function own0(e) { return [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim().length }
    const hit = cands[0]
    const target = hit.closest('button, [class*="btn"], [role=button]') || hit
    const r = target.getBoundingClientRect()
    const info = { text: String(target.textContent).replace(/\\s+/g, ' ').slice(0, 30), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    return JSON.stringify(info)
  })()`)
  console.log('step2', r2)
  const p2 = JSON.parse(r2)
  // 用真实鼠标点（风控页面对合成点击不友好）
  const wsRaw = c
  await wsRaw.ev('1')
  // 直接发 CDP Input 事件需要单独会话——这里退回 element.click()（抽屉按钮实测可接受）
  await c.ev(`(() => {
    const clean = s => String(s || '').replace(/\\s+/g, ' ').trim()
    const cands = [...document.querySelectorAll('*')].filter(e => {
      const own = [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
      if (!own.includes('批量邀约')) return false
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
    cands.sort((a, b) => own0(a) - own0(b))
    function own0(e) { return [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim().length }
    const hit = cands[0]
    ;(hit.closest('button, [class*="btn"], [role=button]') || hit).click()
    return 'clicked'
  })()`)
  await sleep(2000)
  // 3) 转储浮层文本（固定定位大浮层 = 抽屉）
  const r3 = await c.ev(`(() => {
    const clean = s => String(s || '').replace(/\\s+/g, ' ').trim()
    const drawers = [...document.querySelectorAll('div')].filter(d => {
      const cs = getComputedStyle(d)
      if (cs.position !== 'fixed') return false
      const r = d.getBoundingClientRect()
      return r.width >= innerWidth * 0.3 && r.height >= innerHeight * 0.3 && clean(d.textContent).length > 50
    })
    const dr = drawers[drawers.length - 1]
    if (!dr) return 'no-drawer'
    const quota = [...dr.querySelectorAll('*')].filter(e => e.childElementCount === 0 && /额度|剩余|今日|次数|可邀约/.test(clean(e.textContent))).map(e => clean(e.textContent))
    return JSON.stringify({ text: clean(dr.textContent).slice(0, 900), quotaTexts: [...new Set(quota)].slice(0, 12) })
  })()`)
  console.log('step3', r3)
  c.close()
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
