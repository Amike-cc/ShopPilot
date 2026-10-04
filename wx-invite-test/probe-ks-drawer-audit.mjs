/**
 * 快手邀约**抽屉内锚点**真机审计（2026-10-04）。
 *
 * 档案里"抽屉打开之后"才存在的一批锚点（额度文案 / 话术框 / 三个联系方式占位符 /
 * 合作标签 6 项 / 选择商品 / 商品弹窗 / 已选择商品数）在广场页上根本量不到，
 * 必须真的勾 2 位达人 → 点「批量邀约」把抽屉打开。
 *
 * ⚠️ 只开抽屉与商品弹窗，**绝不点「发送邀请」**（那会真实发出邀约、不可撤回）。
 * 审计完把弹窗与抽屉都关掉，并复核确实关掉了。
 *
 * 用法：node wx-invite-test/probe-ks-drawer-audit.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_KS_STORE || 'store_3856e71a3ae8499ebdbec1f4ccbb4394'
const SQUARE = 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, er) => { ws.onopen = ok; ws.onerror = er })
  let s = 0
  const p = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } }
  const send = (me, pa = {}) => new Promise((ok, er) => { const id = ++s; p.set(id, m => m.error ? er(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: me, params: pa })) })
  const ev = async (x, timeoutMs = 25000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 超时')), timeoutMs))])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  return { send, ev, call: async x => JSON.parse(await ev(`(async()=>JSON.stringify(await ${x}))()`)), close: () => ws.close() }
}

const list = await targets()
const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
if (!renderer) { console.error('未找到应用渲染层'); process.exit(1) }
const app = await connect(renderer)
await app.call(`window.shopilot.browser.display('${STORE}')`)
await sleep(2000)
const tabs = (await app.call(`window.shopilot.browser.tab.list('${STORE}')`))?.data?.tabs || []
const square = tabs.find(t => /daren-square|daren-match/.test(String(t.url)))
if (square) await app.call(`window.shopilot.browser.tab.activate('${STORE}', '${square.id}')`)
else await app.call(`window.shopilot.browser.tab.create('${STORE}', '${SQUARE}')`)
await sleep(2000)

/** 等页面目标出现（新建标签页后 webview 要几秒才挂载出 CDP 目标） */
let page = null
for (let i = 0; i < 20 && !page; i++) {
  page = (await targets()).find(t => /daren-square|daren-match/.test(String(t.url)) || /login\.kwaixiaodian/.test(String(t.url)))
  if (!page) await sleep(2000)
}
if (!page) { console.error('没有快手页面目标（等了 40s）'); process.exit(1) }
console.log('页面目标:', String(page.url).slice(0, 90))
const conn = await connect(page)

const ensureSquare = async () => {
  for (let attempt = 1; attempt <= 4; attempt++) {
    // 等页面稳定：可能是 chrome-error（webview 刚挂载时导航还没完成）
    let url = ''
    for (let i = 0; i < 20; i++) {
      url = String(await conn.ev('location.href').catch(() => ''))
      if (/daren-square|login\.kwaixiaodian/.test(url)) break
      await sleep(2000)
    }
    if (/daren-square/.test(url)) return
    console.log(`第 ${attempt} 次：当前 ${url.slice(0, 80)} → 重新导航`)
    await conn.ev(`location.href = ${JSON.stringify(SQUARE)}`).catch(() => null)
    await sleep(15000)
  }
  const finalUrl = String(await conn.ev('location.href').catch(() => ''))
  if (!/daren-square/.test(finalUrl)) { console.error('仍不在广场页：' + finalUrl); process.exit(1) }
}
await ensureSquare()
await sleep(6000)

const REPORT = {}
const audit = async (label, expr) => { REPORT[label] = JSON.parse(await conn.ev(expr)); console.log(`\n--- ${label} ---\n${JSON.stringify(REPORT[label], null, 1)}`) }

// ① 广场页：合作信息行的**全部**选项 + 全页搜索「专属推荐」
await audit('广场-合作信息与专属推荐', `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const rowOf = l => { const el = all.find(e => own(e) === l); if (!el) return null; let u = el; for (let i = 0; i < 2; i++) u = u ? u.parentElement : null; return u }
  const coop = rowOf('合作信息')
  const coopOpts = coop ? [...coop.querySelectorAll('*')].map(own).filter(Boolean) : []
  const anywhere = all.filter(e => own(e).includes('专属推荐')).length
  const body = String(document.body.innerText)
  return JSON.stringify({
    coopRowText: coop ? String(coop.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120) : null,
    coopOwnTexts: [...new Set(coopOpts)].slice(0, 12),
    exclusiveAnywhere: anywhere,
    exclusiveInBody: body.includes('专属推荐'),
    bodyMentions: (body.match(/[^\\n]{0,24}专属推荐[^\\n]{0,24}/) || [null])[0]
  })
})()`)

// ② 勾 2 位达人 → 点「批量邀约」开抽屉（不发送）
const pickRows = await conn.ev(`(() => {
  const cbs = [...document.querySelectorAll('tbody input[type=checkbox]')]
  let n = 0
  for (const b of cbs) { if (b.checked) continue; const t = b.closest('label') || b; try { t.click() } catch {} if (++n >= 2) break }
  return JSON.stringify({ checkboxes: cbs.length, clicked: n })
})()`)
console.log('\n勾选达人:', pickRows)
await sleep(2000)
const counter = await conn.ev(`(() => { const b = String(document.body.innerText); return (b.match(/已选[^\\n]{0,16}/) || [null])[0] })()`)
console.log('计数文案:', counter)

const openDrawer = await conn.ev(`(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const narrow = s => String(s == null ? '' : s).replace(/\\s+/g, '')
  const el = all.find(e => narrow(own(e)) === '批量邀约' && e.getBoundingClientRect().width > 0)
  if (!el) return 'not-found'
  ;(el.closest('button') || el).click()
  return 'clicked'
})()`)
console.log('点「批量邀约」:', openDrawer)
await sleep(5000)

// ③ 抽屉内锚点
await audit('抽屉内锚点', `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const q = s => { try { return document.querySelectorAll(s).length } catch { return -1 } }
  const body = String(document.body.innerText)
  const has = t => body.includes(t)
  return JSON.stringify({
    url: location.href,
    textarea: q('textarea'),
    scriptPlaceholder: (() => { const t = document.querySelector('textarea'); return t ? String(t.getAttribute('placeholder') || '').slice(0, 60) : null })(),
    quotaText: (body.match(/今日剩余[^\\n]{0,30}/) || [null])[0],
    quotaPresent: has('今日剩余'),
    contactPlaceholder: q('input[placeholder*="常用联系人称呼"]'),
    phonePlaceholder: q('input[placeholder*="常用11位手机号"]'),
    wechatPlaceholder: q('input[placeholder*="常用微信号"]'),
    contactLabel: has('常用联系人'),
    cooperationTag: has('合作标签'),
    benefits: ['免费申样','可聊高佣','素材支持','支持投流','24h发货','可破价'].filter(t => has(t)),
    chooseGoods: has('选择商品'),
    addGoods: has('添加商品'),
    selectedMarker: (body.match(/已选择商品数[^\\n]{0,16}/) || [null])[0],
    sendButton: has('发送邀请'),
    postSendHint: has('邀约提示'),
    allButtons: [...new Set(all.filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && own(e) && own(e).length <= 6 && (e.tagName === 'BUTTON' || e.tagName === 'A') }).map(own))].slice(0, 16)
  })
})()`)

// ④ 打开商品弹窗 → 弹窗内锚点（不点确认外的任何提交）
const openModal = await conn.ev(`(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const el = all.find(e => own(e) === '选择商品' && e.getBoundingClientRect().width > 0)
  if (!el) return 'not-found'
  ;(el.closest('button') || el).click()
  return 'clicked'
})()`)
console.log('\n点「选择商品」:', openModal)
await sleep(4000)
await audit('商品弹窗锚点', `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const q = s => { try { return document.querySelectorAll(s).length } catch { return -1 } }
  const narrow = s => String(s == null ? '' : s).replace(/\\s+/g, '')
  const modal = document.querySelector('.kwaishop-cps-daren-match-pc-modal-body')
  return JSON.stringify({
    modalRoot: q('.kwaishop-cps-daren-match-pc-modal-body'),
    modalTbodyCheckbox: q('.kwaishop-cps-daren-match-pc-modal-body tbody input[type=checkbox]'),
    modalTbodyRows: q('.kwaishop-cps-daren-match-pc-modal-body tbody tr'),
    searchInput: q('.kwaishop-cps-daren-match-pc-modal-body input[placeholder="请输入"]'),
    confirmText: all.some(e => narrow(own(e)) === '确认' && e.getBoundingClientRect().width > 0),
    confirmSpacedText: all.some(e => narrow(own(e)) === '确认' && /确\\s*认/.test(String(e.innerText || ''))),
    resetText: all.some(e => narrow(own(e)) === '重置'),
    queryText: all.some(e => narrow(own(e)) === '查询'),
    firstRows: modal ? [...modal.querySelectorAll('tbody tr')].slice(0, 3).map(tr => String(tr.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 50)) : []
  })
})()`)

// ⑤ 收尾：关弹窗（取消/关闭）→ 关抽屉（不发送）
const cleanup = await conn.ev(`(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const done = []
  for (const t of ['取消', '关 闭', '关闭']) {
    const el = all.find(e => own(e) === t && vis(e))
    if (el) { (el.closest('button') || el).click(); done.push(t); break }
  }
  return JSON.stringify({ closed: done })
})()`)
console.log('\n关闭弹窗:', cleanup)
await sleep(2500)
const closeDrawer = await conn.ev(`(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const el = all.find(e => (own(e) === '关 闭' || own(e) === '关闭' || own(e) === '×') && vis(e))
  if (el) { (el.closest('button') || el).click(); return 'clicked:' + own(el) }
  return 'no-close-button'
})()`)
console.log('关闭抽屉:', closeDrawer)
await sleep(2500)
console.log('收尾状态:', await conn.ev(`(() => JSON.stringify({ textarea: document.querySelectorAll('textarea').length, url: location.pathname }))()`))

fs.mkdirSync('wx-invite-test/evidence', { recursive: true })
fs.writeFileSync(path.resolve('wx-invite-test/evidence/ks-drawer-audit-2026-10-04.json'), JSON.stringify({ at: new Date().toISOString(), report: REPORT }, null, 1))
conn.close()
app.close()
process.exit(0)
