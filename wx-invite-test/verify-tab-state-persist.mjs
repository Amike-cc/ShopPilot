/**
 * 关键假设验证：**切到别的标签页再切回来，广场页的页内状态（筛选）还在不在？**
 *
 * 为什么必须量：微信辅助流的整套设计建立在"广场页只开一次、一直留着，分页/筛选是页面内部状态"之上；
 * 而迁移到 DOM <webview> 后只有活动标签页的 webview 挂在文档上 —— 如果切走=卸载 webview=guest 销毁，
 * 那么每轮进详情页再回来，广场就变成**重新加载过的、没有筛选**的页面（多轮邀约会按未筛选名单发）。
 *
 * 用法：node wx-invite-test/verify-tab-state-persist.mjs
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (method, params = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method, params })) })
  const ev = async (expr, timeoutMs = 30000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 超时')), timeoutMs))])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  return { ev, call: async (expr) => JSON.parse(await ev(`(async () => JSON.stringify(await ${expr}))()`)), close: () => ws.close() }
}
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())

const STATE = `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const rowOf = t => { for (const el of all) { if (own(el) !== t) continue; return el.closest('.weui-desktop-form__control-group') } return null }
  const checkedIn = row => row ? [...row.querySelectorAll('label')].filter(el => { const i = el.querySelector('input'); return i && i.checked }).map(el => String(el.innerText || '').replace(/\\s+/g, ' ').trim()) : []
  const tab = all.find(el => el.tagName === 'LI' && /weui-desktop-tab__nav_current/.test(String(el.className || '')))
  return JSON.stringify({
    url: location.href,
    finderType: tab ? String(tab.innerText || '').replace(/\\s+/g, ' ').trim() : null,
    others: checkedIn(rowOf('其他筛选')),
    detailLinks: all.filter(el => own(el) === '详情' && vis(el)).length,
    // 页面是否被重新加载过：用 performance.navigation / 一个写入页面的标记判断
    marker: window.__probeMarker || null
  })
})()`

const MARK_AND_FILTER = `(() => {
  window.__probeMarker = String(Date.now())
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const rowOf = t => { for (const el of all) { if (own(el) !== t) continue; return el.closest('.weui-desktop-form__control-group') } return null }
  const row = rowOf('其他筛选')
  const chip = row ? [...row.querySelectorAll('label')].find(el => String(el.innerText || '').replace(/\\s+/g, ' ').trim() === '有联系方式') : null
  if (chip) (chip.querySelector('span') || chip).click()
  return JSON.stringify({ clicked: !!chip, marker: window.__probeMarker })
})()`

async function readActiveSquare(app) {
  const t = (await targets()).find(x => /findersquare\/find/.test(String(x.url)))
  if (!t) return { error: '没有广场 CDP 目标（该标签页未挂载）' }
  const conn = await connect(t)
  const state = JSON.parse(await conn.ev(STATE))
  conn.close()
  return state
}

async function main() {
  const list = await targets()
  const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  const app = await connect(renderer)
  await app.call(`window.shopilot.browser.display('${STORE}')`)
  await sleep(1500)

  const tabs = await app.call(`window.shopilot.browser.tab.list('${STORE}')`)
  const squareTabs = (tabs?.data?.tabs || []).filter(t => /findersquare\/find$/.test(String(t.url)))
  const otherTab = (tabs?.data?.tabs || []).find(t => /shop\/home$/.test(String(t.url)))
  if (!squareTabs.length) throw new Error('店铺里没有广场标签页')
  const S = squareTabs[squareTabs.length - 1] // 取最后一个（运行创建的那个通常在后）
  console.log('用广场标签页:', S.id, '｜对照标签页:', otherTab && otherTab.id)

  console.log('[1] 激活广场页并打标记 + 勾「有联系方式」')
  await app.call(`window.shopilot.browser.tab.activate('${STORE}', '${S.id}')`)
  await sleep(4000)
  let sq = (await targets()).find(x => /findersquare\/find/.test(String(x.url)))
  let conn = await connect(sq)
  console.log('    标记/筛选:', await conn.ev(MARK_AND_FILTER))
  await sleep(2500)
  console.log('    当前状态:', await conn.ev(STATE))
  conn.close()

  console.log('[2] 切到别的标签页（模拟进详情页）')
  if (otherTab) { await app.call(`window.shopilot.browser.tab.activate('${STORE}', '${otherTab.id}')`); await sleep(4000) }
  console.log('    活跃页:', JSON.stringify(await readActiveSquare(app)))

  console.log('[3] 切回广场页')
  await app.call(`window.shopilot.browser.tab.activate('${STORE}', '${S.id}')`)
  await sleep(4500)
  const after = await readActiveSquare(app)
  console.log('    状态:', JSON.stringify(after))
  console.log(after.marker ? '    → 页内标记还在：**状态保留**（webview 未被销毁）' : '    → 页内标记丢失：**页面被重新加载**（切走即丢筛选/分页）')
  console.log(after.others && after.others.includes('有联系方式') ? '    → 筛选仍在' : '    → 筛选已丢失')

  app.close()
  process.exit(0)
}

main().catch(err => { console.error('ERR', err.stack || err.message); process.exit(1) })
