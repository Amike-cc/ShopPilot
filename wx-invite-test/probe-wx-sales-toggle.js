/**
 * 「带货销售总额」下拉的开关语义（决定任务步骤怎么写才能稳定点到区间）
 *   ① 点 DT 是否开菜单；② 点一个区间后菜单是否自动收起；③ 再点 DT 是否重新开；
 *   ④ Escape 是否能收起（引擎已有 pressKey Escape 这一步）。
 *
 * 用法：node wx-invite-test/probe-wx-sales-toggle.js
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'
const ENUM_ALL = `function ENUM_ALL(){const o=[];const w=r=>{for(const e of r.querySelectorAll('*')){o.push(e);if(e.shadowRoot)w(e.shadowRoot)};if(r.shadowRoot)w(r.shadowRoot)};w(document);return o}`

const sleep = ms => new Promise(r => setTimeout(r, ms))

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
  const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时`)), ms))])
  const ev = async (expr, timeoutMs = 20000) => {
    const r = await withTimeout(send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }), timeoutMs, 'CDP 求值')
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  const key = async (name, code) => {
    await withTimeout(send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }), 6000, 'keyDown')
    await withTimeout(send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }), 6000, 'keyUp')
  }
  return { send, ev, key, close: () => ws.close() }
}

const deep = body => `(() => { ${ENUM_ALL}\n${body} })()`
const H = `
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const dl = () => { for (const el of ENUM_ALL()) { if (el.tagName === 'DT' && own(el).includes('带货销售总额')) return el.parentElement } return null }
  const menuOpen = () => { const d = dl(); if (!d) return null; const m = d.querySelector('.weui-desktop-dropdown-menu'); return m ? !String(m.getAttribute('style') || '').includes('display: none') && !String(m.getAttribute('style') || '').includes('display:none') : null }
  const checkedTiers = () => { const d = dl(); if (!d) return []; return [...d.querySelectorAll('.talent-filter-dropdown-item')].filter(el => { const i = el.querySelector('input'); return i && i.checked }).map(el => String(el.innerText || '').replace(/\\s+/g, ' ').trim()) }
  const itemVisible = tier => { const d = dl(); if (!d) return null; const it = [...d.querySelectorAll('.talent-filter-dropdown-item')].find(el => String(el.innerText || '').replace(/\\s+/g, ' ').trim() === tier); if (!it) return null; const r = it.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
`
const SNAP = tier => deep(`${H}\nreturn JSON.stringify({ open: menuOpen(), checked: checkedTiers(), itemVisible: ${tier ? `itemVisible(${JSON.stringify(tier)})` : 'null'} })`)

const clickDt = deep(`${H}\nconst d = dl(); if (!d) return JSON.stringify({ok:false}); d.querySelector('dt').click(); return JSON.stringify({ok:true})`)
const clickItem = tier => deep(`${H}\nconst d = dl(); if (!d) return JSON.stringify({ok:false}); const it = [...d.querySelectorAll('.talent-filter-dropdown-item')].find(el => String(el.innerText || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(tier)}); if (!it) return JSON.stringify({ok:false}); it.querySelector('input').click(); return JSON.stringify({ok:true})`)

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  const app = await connect(renderer)
  await app.ev(`(async () => JSON.stringify(await window.shopilot.browser.display(${JSON.stringify(STORE)})))()`)
  await app.ev(`(async () => JSON.stringify(await window.shopilot.browser.prepareInviteSquare(${JSON.stringify(STORE)}, { url: ${JSON.stringify(SQUARE)} })))()`)
  await sleep(7000)
  app.close()

  const after = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const wx = await connect(after.find(t => /store\.weixin\.qq\.com/.test(String(t.url))))

  const TIER = '￥10万-20万'
  console.log('[0] 初始:', await wx.ev(SNAP(TIER)))
  console.log('[1] 点 DT:', await wx.ev(clickDt))
  await sleep(1000)
  console.log('    →', await wx.ev(SNAP(TIER)))
  console.log('[2] 点区间:', await wx.ev(clickItem(TIER)))
  await sleep(2000)
  console.log('    →', await wx.ev(SNAP(TIER)))
  console.log('[3] 再点 DT:', await wx.ev(clickDt))
  await sleep(1000)
  console.log('    →', await wx.ev(SNAP(TIER)))
  console.log('[4] Escape:')
  await wx.key('Escape', 27)
  await sleep(900)
  console.log('    →', await wx.ev(SNAP(TIER)))
  console.log('[5] Escape 时的查勾选（应保留）:', await wx.ev(SNAP(TIER)))
  console.log('[6] 再点 DT 打开:', await wx.ev(clickDt))
  await sleep(1000)
  console.log('    →', await wx.ev(SNAP(TIER)))
  console.log('[7] 打开状态下再 Escape:')
  await wx.key('Escape', 27)
  await sleep(900)
  console.log('    →', await wx.ev(SNAP(TIER)))

  wx.close()
  process.exit(0)
}

main().catch(err => { console.error('ERR', err.stack || err.message); process.exit(1) })
