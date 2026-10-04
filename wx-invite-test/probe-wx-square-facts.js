/**
 * 微信小店带货者广场：最后四个待定事实
 *   ① 带货销售总额的下拉项：JS click 能不能真的应用（列表条数变化）？多选是否允许？「不限」的行为？
 *   ② 四个带货者类型页签各自提供哪些指标（带货销售总额是否只在「全部带货者」下存在）？
 *   ③ 其他筛选 chip：JS click 是否真的选中？
 *
 * 用法：node wx-invite-test/probe-wx-square-facts.js
 */
import fs from 'node:fs'
import path from 'node:path'

const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'
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
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400))
    return r.result.value
  }
  return { send, ev, close: () => ws.close() }
}

const deep = body => `(() => { ${ENUM_ALL}\n${body} })()`
const H = `
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const rowOf = t => { for (const el of ENUM_ALL()) { if (own(el) !== t) continue; return el.closest('.weui-desktop-form__control-group') } return null }
  const salesDl = () => { for (const el of ENUM_ALL()) { if (el.tagName === 'DT' && own(el).includes('带货销售总额')) return el.parentElement } return null }
`
const SNAP = deep(`
  ${H}
  const dl = salesDl()
  const dataRow = rowOf('近30日带货数据')
  const metrics = dataRow ? [...dataRow.querySelectorAll('dt')].map(d => String(d.innerText || '').replace(/\\s+/g, ' ').trim()) : []
  const tabs = []
  for (const el of ENUM_ALL()) {
    if (el.tagName !== 'LI' || !/weui-desktop-tab__nav/.test(String(el.className || ''))) continue
    tabs.push({ t: String(el.innerText || '').replace(/\\s+/g, ' ').trim(), current: /current/.test(String(el.className || '')) })
  }
  const otherRow = rowOf('其他筛选')
  const othersChecked = otherRow ? [...otherRow.querySelectorAll('label')].filter(el => { const i = el.querySelector('input'); return i && i.checked }).map(el => String(el.innerText || '').replace(/\\s+/g, ' ').trim()) : []
  return JSON.stringify({
    metrics,
    tabs,
    sales: {
      present: !!dl,
      menuStyle: dl ? String(dl.querySelector('.weui-desktop-dropdown-menu').getAttribute('style') || '') : null,
      checkedVals: dl ? [...dl.querySelectorAll('input[type=checkbox]')].filter(i => i.checked).map(i => i.value) : [],
      checkedText: dl ? [...dl.querySelectorAll('.talent-filter-dropdown-item')].filter(el => { const i = el.querySelector('input'); return i && i.checked }).map(el => String(el.innerText || '').replace(/\\s+/g, ' ').trim()) : []
    },
    othersChecked,
    detailLinks: ENUM_ALL().filter(el => own(el) === '详情' && vis(el)).length
  }, null, 1)
`)

const openSales = deep(`
  ${H}
  const dl = salesDl()
  if (!dl) return JSON.stringify({ ok: false })
  const dt = dl.querySelector('dt')
  const menu = dl.querySelector('.weui-desktop-dropdown-menu')
  if (String(menu.getAttribute('style') || '').includes('display: none')) dt.click()
  return JSON.stringify({ ok: true })
`)
const jsClickTier = (text) => deep(`
  ${H}
  const dl = salesDl()
  if (!dl) return JSON.stringify({ ok: false })
  const item = [...dl.querySelectorAll('.talent-filter-dropdown-item')].find(el => String(el.innerText || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)})
  if (!item) return JSON.stringify({ ok: false, reason: 'no-item' })
  const inp = item.querySelector('input')
  inp.click()
  return JSON.stringify({ ok: true, value: inp.value, checked: inp.checked })
`)
const jsClickTab = (text) => deep(`
  ${H}
  const a = ENUM_ALL().find(el => el.tagName === 'A' && own(el) === ${JSON.stringify(text)} && vis(el))
  if (!a) return JSON.stringify({ ok: false })
  a.click()
  return JSON.stringify({ ok: true })
`)
const jsClickOther = (text) => deep(`
  ${H}
  const row = rowOf('其他筛选')
  if (!row) return JSON.stringify({ ok: false })
  const label = [...row.querySelectorAll('label')].find(el => String(el.innerText || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)})
  if (!label) return JSON.stringify({ ok: false, reason: 'no-label' })
  label.click()
  return JSON.stringify({ ok: true })
`)

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const renderer = targets.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  if (renderer) {
    const app = await connect(renderer)
    await app.ev(`(async () => JSON.stringify(await window.shopilot.browser.display(${JSON.stringify(STORE)})))()`)
    await app.ev(`(async () => JSON.stringify(await window.shopilot.browser.prepareInviteSquare(${JSON.stringify(STORE)}, { url: ${JSON.stringify(SQUARE)} })))()`)
    await sleep(7000)
    app.close()
  }
  const after = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const wx = await connect(after.find(t => /store\.weixin\.qq\.com/.test(String(t.url))))

  const base = JSON.parse(await wx.ev(SNAP))
  console.log('[0] 基线：metrics =', base.metrics.join('/'), '| 列表条数 =', base.detailLinks)

  // ① JS click 一个区间
  console.log('[1] 打开销售总额下拉:', await wx.ev(openSales))
  await sleep(800)
  console.log('[2] JS click ￥1万-5万:', await wx.ev(jsClickTier('￥1万-5万')))
  await sleep(3000)
  let s = JSON.parse(await wx.ev(SNAP))
  console.log('[3] 之后：checked =', JSON.stringify(s.sales.checkedText), '| 列表条数 =', s.detailLinks, '| 菜单 =', s.sales.menuStyle)

  // 多选：再点一个区间
  console.log('[4] JS click ￥5万-10万:', await wx.ev(jsClickTier('￥5万-10万')))
  await sleep(2500)
  s = JSON.parse(await wx.ev(SNAP))
  console.log('[5] 多选后：checked =', JSON.stringify(s.sales.checkedText), '| 列表条数 =', s.detailLinks)

  // 不限的行为
  console.log('[6] JS click 不限:', await wx.ev(jsClickTier('不限')))
  await sleep(2500)
  s = JSON.parse(await wx.ev(SNAP))
  console.log('[7] 点不限后：checked =', JSON.stringify(s.sales.checkedText), '| 列表条数 =', s.detailLinks)

  // ③ 其他筛选
  console.log('[8] JS click 其他筛选「有联系方式」:', await wx.ev(jsClickOther('有联系方式')))
  await sleep(2500)
  s = JSON.parse(await wx.ev(SNAP))
  console.log('[9] 之后：othersChecked =', JSON.stringify(s.othersChecked), '| 列表条数 =', s.detailLinks)

  // ② 每个页签的指标
  for (const tab of ['直播带货者', '短视频带货者', '公众号带货者', '全部带货者']) {
    console.log(`[tab] ${tab}:`, await wx.ev(jsClickTab(tab)))
    await sleep(2200)
    s = JSON.parse(await wx.ev(SNAP))
    console.log(`       current=${(s.tabs.find(t => t.current) || {}).t} metrics=${s.metrics.join('/') || '(无)'} salesPresent=${s.sales.present} 列表=${s.detailLinks}`)
  }

  fs.writeFileSync(path.join(OUT_DIR, 'square-facts-final.json'), JSON.stringify(JSON.parse(await wx.ev(SNAP)), null, 1))
  wx.close()
  process.exit(0)
}

main().catch(err => { console.error('ERR', err.stack || err.message); process.exit(1) })
