/**
 * 量：**已邀约过（7 天内）**的达人，其详情页长什么样 —— 「邀请带货」是禁用、还是能点但不动？
 *
 * 背景：真机彩排里，选中一位昨天刚邀过的达人（新东方直播间）后，引擎在「邀请带货」上
 * 4 次点击都没跳到表单页，最后报 TASK_TIMEOUT。而引擎把"已邀约"映射成
 * TASK_DAREN_ALREADY_INVITED（跳过换人）的前提是**按钮呈禁用态**。
 * 所以必须量清楚：平台到底是用禁用、还是用"能点但只弹提示"来表达"7 天内不可再次邀请"。
 *
 * 做法：进「我的邀约 → 邀请中」，点第一行的「详情」→ 读详情页的按钮状态与页面提示文案。
 *
 * 用法：node wx-invite-test/probe-already-invited-detail.mjs
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const MY_INVITE = 'https://store.weixin.qq.com/shop/findersquare/my-invite'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, er) => { ws.onopen = ok; ws.onerror = er })
  let s = 0
  const p = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } }
  const send = (me, pa = {}) => new Promise((ok, er) => { const id = ++s; p.set(id, m => m.error ? er(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: me, params: pa })) })
  const ev = async (x, timeoutMs = 20000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 超时')), timeoutMs))])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200))
    return r.result.value
  }
  return { send, ev, call: async x => JSON.parse(await ev(`(async()=>JSON.stringify(await ${x}))()`)), close: () => ws.close() }
}

/** 详情页状态：邀请带货按钮的禁用/文案 + 页面上与"已邀约/7天"有关的提示 */
const DETAIL_STATE = `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const btn = all.find(e => own(e) === '邀请带货' && vis(e))
  let btnInfo = null
  if (btn) {
    const clickable = btn.closest('button, a, [role="button"]') || btn
    let dis = clickable.disabled === true || clickable.getAttribute('aria-disabled') === 'true'
    let cls = String(clickable.className || '')
    let p = clickable
    for (let i = 0; i < 4 && p && !dis; i++, p = p.parentElement) { if (/disabled/i.test(String(p.className || ''))) { dis = true; cls = String(p.className || '') } }
    btnInfo = { tag: clickable.tagName, disabled: dis, className: cls.slice(0, 90) }
  }
  const hints = [...new Set(all.filter(e => vis(e) && own(e) && /已邀约|已邀请|7\\s*天|不可再次|已发送|等待反馈/.test(own(e))).map(e => own(e)))].slice(0, 10)
  const buttons = [...new Set(all.filter(e => vis(e) && own(e) && own(e).length <= 8 && (e.tagName === 'BUTTON' || e.tagName === 'A')).map(e => own(e)))].slice(0, 14)
  return JSON.stringify({ path: location.pathname, hasInviteBtn: !!btn, btnInfo, hints, buttons })
})()`

const MY_INVITE_ROWS = `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const rows = all.filter(e => e.tagName === 'TR' && vis(e))
  return JSON.stringify(rows.map(tr => String(tr.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80)).filter(t => t && !/带货者 佣金/.test(t)).slice(0, 6))
})()`

async function main() {
  const list = await targets()
  const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  const app = await connect(renderer)
  await app.call(`window.shopilot.browser.display('${STORE}')`)
  await sleep(1500)
  const created = await app.call(`window.shopilot.browser.tab.create('${STORE}', '${MY_INVITE}')`)
  const tabId = created?.data?.tabId || created?.data?.id
  await sleep(11000)

  const myPage = (await targets()).find(t => /my-invite/.test(String(t.url)))
  if (!myPage) { console.log('没打开我的邀约页'); process.exit(1) }
  let conn = await connect(myPage)
  // 默认落在「已接受」页签，先切到「邀请中(n)」（那里才是近 7 天邀过的）
  const tabClicked = await conn.ev(`(() => {
    const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
    const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const el = all.find(e => /^邀请中\\(\\d+\\)$/.test(own(e)) && vis(e))
    if (!el) return 'no-tab'
    ;(el.closest('a,li,button,div') || el).click()
    return 'clicked:' + own(el)
  })()`)
  console.log('切页签:', tabClicked)
  await sleep(4000)
  for (let i = 0; i < 10; i++) {
    const rows = await conn.ev(MY_INVITE_ROWS).catch(() => null)
    if (rows && JSON.parse(rows).length) { console.log('邀请中列表:', rows); break }
    await sleep(2000)
  }
  // 点第一行的「详情」
  const clicked = await conn.ev(`(() => {
    const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
    const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const el = all.find(e => own(e) === '详情' && vis(e))
    if (!el) return 'no-detail-link'
    ;(el.closest('a,button') || el).click()
    return 'clicked'
  })()`)
  console.log('点「详情」:', clicked)
  conn.close()
  for (let i = 0; i < 5; i++) {
    await sleep(3000)
    const all = await targets()
    console.log(`  +${(i + 1) * 3}s 目标:`, JSON.stringify(all.map(t => String(t.url).split('/').pop().slice(0, 26))))
  }

  const detail = (await targets()).find(t => /finder-detail/.test(String(t.url)))
  if (!detail) {
    // 没开详情页：把"我的邀约"当前地址打出来，看看这个「详情」到底跳去哪了
    const my = (await targets()).find(t => /my-invite|findersquare/.test(String(t.url)))
    if (my) { const c = await connect(my); console.log('当前页:', await c.ev(`location.href`)); c.close() }
    console.log('（没打开 finder-detail 目标）')
    if (tabId) await app.call(`window.shopilot.browser.tab.close('${STORE}', '${tabId}')`).catch(() => null)
    app.close()
    process.exit(0)
  }
  conn = await connect(detail)
  for (let i = 0; i < 12; i++) {
    const raw = await conn.ev(DETAIL_STATE).catch(() => null)
    if (raw) { const d = JSON.parse(raw); if (d.hasInviteBtn || d.hints.length) { console.log(JSON.stringify(d, null, 1)); break } }
    await sleep(2000)
  }
  conn.close()
  if (tabId) await app.call(`window.shopilot.browser.tab.close('${STORE}', '${tabId}')`).catch(() => null)
  app.close()
  process.exit(0)
}

main().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1) })
