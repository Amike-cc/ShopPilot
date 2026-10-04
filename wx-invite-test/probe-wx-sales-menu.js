/**
 * 微信小店「带货销售总额」下拉：把该指标 dl 的完整标记与选项文案量出来。
 *
 * 实测结构（2026-10-02）：
 *   <dl class="weui-desktop-form__dropdown-label">
 *     <dt class="weui-desktop-form__dropdown__dt …">带货销售总额</dt>
 *     <div class="weui-desktop-dropdown-menu weui-desktop-dropdown-menu_bottom" style="display:none;">
 *       <ul class="weui-desktop-dropdown__list">…选项…</ul>
 *     </div>
 *   </dl>
 * 本脚本：① dump 该 dl 的完整 outerHTML（选项在标记里就能看到）；
 *         ② 用受信任鼠标点开后再 dump 菜单的 display 与可见项；
 *         ③ 检查是否还有「确定 / 重置」这类二次动作按钮。
 *
 * 用法：node wx-invite-test/probe-wx-sales-menu.js
 */
import fs from 'node:fs'
import path from 'node:path'

const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const OUT_DIR = path.resolve('wx-invite-test/evidence')
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
  const click = async (x, y, timeoutMs = 8000) => {
    await withTimeout(send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }), timeoutMs, 'mouseMoved')
    await withTimeout(send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }), timeoutMs, 'mousePressed')
    await withTimeout(send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }), timeoutMs, 'mouseReleased')
  }
  return { send, ev, click, close: () => ws.close() }
}

const deep = body => `(() => { ${ENUM_ALL}\n${body} })()`

const FIND_DL = `
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  let dl = null
  for (const el of ENUM_ALL()) {
    if (el.tagName !== 'DT') continue
    if (!own(el).includes('带货销售总额')) continue
    dl = el.parentElement
    break
  }
`

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find(t => /store\.weixin\.qq\.com/.test(String(t.url)))
  if (!page) throw new Error('未找到微信小店页面')
  const wx = await connect(page)
  console.log('[0] 页面:', await wx.ev('location.href'))

  const markup = await wx.ev(deep(`
    ${FIND_DL}
    if (!dl) return JSON.stringify({ ok: false })
    const dt = dl.querySelector('dt')
    const menu = dl.querySelector('.weui-desktop-dropdown-menu')
    const items = menu ? [...menu.querySelectorAll('li, a, span, div')].map(el => {
      const t = String(el.innerText || '').replace(/\\s+/g, ' ').trim()
      return { tag: el.tagName, cls: String(el.className || '').slice(0, 60), t }
    }).filter(x => x.t) : []
    return JSON.stringify({ ok: true, dtCls: String(dt.className), menuStyle: menu ? String(menu.getAttribute('style') || '') : null, menuCls: menu ? String(menu.className) : null, items, html: String(dl.outerHTML).replace(/\\s+/g, ' ').slice(0, 4000) }, null, 1)
  `))
  console.log('[1] 静态标记（未点开）：\n' + String(markup).slice(0, 2500))
  fs.writeFileSync(path.join(OUT_DIR, 'sales-menu-markup.json'), String(markup))

  const box = await wx.ev(deep(`
    ${FIND_DL}
    if (!dl) return 'null'
    const dt = dl.querySelector('dt')
    const r = dt.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  `))
  console.log('[2] 触发器坐标:', box)
  if (box && box !== 'null') {
    const { x, y } = JSON.parse(box)
    await wx.click(x, y)
    await sleep(1500)
    const opened = await wx.ev(deep(`
      ${FIND_DL}
      if (!dl) return JSON.stringify({ ok: false })
      const menu = dl.querySelector('.weui-desktop-dropdown-menu')
      const menu2 = [...ENUM_ALL()].filter(el => /weui-desktop-dropdown-menu/.test(String(el.className || '')) && String(el.getAttribute('style') || '').indexOf('display: none') < 0 && el.getBoundingClientRect().height > 0)
      const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
      const openMenu = menu2[0] || (menu && vis(menu) ? menu : null)
      const items = openMenu ? [...openMenu.querySelectorAll('li, a, span, div, dt')].map(el => ({ tag: el.tagName, cls: String(el.className || '').slice(0, 60), t: String(el.innerText || '').replace(/\\s+/g, ' ').trim() })).filter(x => x.t && x.t.length <= 40) : []
      return JSON.stringify({ dtCls: String(dl.querySelector('dt').className), menuStyle: menu ? String(menu.getAttribute('style') || '') : null, menuCount: menu2.length, items: items.slice(0, 60), html: openMenu ? String(openMenu.outerHTML).replace(/\\s+/g, ' ').slice(0, 3000) : null }, null, 1)
    `))
    console.log('[3] 点开后：\n' + String(opened).slice(0, 3000))
    fs.writeFileSync(path.join(OUT_DIR, 'sales-menu-open.json'), String(opened))
  }

  wx.close()
  process.exit(0)
}

main().catch(err => { console.error('ERR', err.stack || err.message); process.exit(1) })
