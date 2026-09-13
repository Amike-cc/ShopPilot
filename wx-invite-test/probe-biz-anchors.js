/**
 * 经营指标锚点测量：在指定店铺的页面里找「指标标签 + 对应数值」的候选锚点。
 * 用法：node probe-biz-anchors.js <平台关键词/店铺名> <页面URL>
 * 输出：每个候选（标签文本 / 数值 / 元素 class 链 / 建议 selector），供人工确认真实锚点后写进平台档案。
 * 只读：只导航与读取，不改页面。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const storeKey = process.argv[2] || '微信小店'
const pageUrl = process.argv[3] || 'https://store.weixin.qq.com/shop/home'
const LABELS = ['销量', '订单', '销售额', '成交金额', '退款金额', '退款订单', '成交订单', '成交件数', '支付订单', '支付金额', '成交退款金额', '退款单数']

async function j(p) { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); return r.json() }
async function targets() { const l = await j('/json/list'); return l.filter(t => t.type === 'page') }
function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  return new Promise((ok, err) => {
    ws.onopen = () => {
      let seq = 0
      const pend = new Map()
      const send = (method, params = {}) => new Promise((ok2, err2) => { const id = ++seq; pend.set(id, m => m.error ? err2(new Error(JSON.stringify(m.error))) : ok2(m.result)); ws.send(JSON.stringify({ id, method, params })) })
      ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
      ok({
        ev: async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 250)); return r.result.value },
        close: () => { try { ws.close() } catch { /* */ } }
      })
    }
    ws.onerror = err
  })
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  // 用主窗口 API 打开店铺并导航到目标页
  const main = await connect((await targets()).find(t => t.title === 'ShopPilot'))
  const nav = await main.ev(`(async () => {
    const r = await window.shopilot.store.list()
    const stores = r.data.stores || r.data
    const s = stores.find(x => x.name.includes(${JSON.stringify(storeKey)}))
    if (!s) return 'no-store:' + stores.map(x => x.name).join(',')
    await window.shopilot.browser.open(s.id)
    await window.shopilot.browser.display(s.id)
    const tl = await window.shopilot.browser.tab.list(s.id)
    const tabs = tl.data.tabs || tl.data
    const t = await window.shopilot.browser.tab.create(s.id, ${JSON.stringify(pageUrl)})
    return JSON.stringify({ store: s.id, tab: t.ok, tabs: tabs.length })
  })()`)
  main.close()
  console.log('导航:', nav)
  await sleep(8000)
  const page = (await targets()).find(t => t.url.includes(new URL(pageUrl).hostname) || t.url.includes('shop/home') || t.url.includes('store.weixin'))
  if (!page) throw new Error('目标页未出现')
  const c = await connect(page)
  const out = await c.ev(`(() => {
    const clean = s => String(s || '').replace(/\\s+/g, ' ').trim()
    const LABELS = ${JSON.stringify(LABELS)}
    const roots = [document]
    for (const el of document.querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot)
    const found = []
    for (const root of roots) {
      for (const el of root.querySelectorAll('*')) {
        if (el.childElementCount > 0) continue
        const t = clean(el.textContent)
        if (!t || t.length > 20) continue
        if (!LABELS.some(L => t === L || t.startsWith(L))) continue
        // 找同容器里相邻的数值（兄弟/父的文本里去掉标签后的数字）
        let box = el.parentElement
        let value = ''
        for (let i = 0; i < 4 && box && !value; i++, box = box.parentElement) {
          const texts = [...box.querySelectorAll('*')].filter(x => x.childElementCount === 0).map(x => clean(x.textContent))
          const nums = texts.filter(x => x && x !== t && /[0-9]/.test(x) && x.length < 24 && !LABELS.includes(x))
          if (nums.length) value = nums[0]
        }
        const cls = String(el.className || '').slice(0, 60)
        found.push({ label: t, value, cls, tag: el.tagName })
      }
    }
    const uniq = [...new Map(found.map(f => [f.label + '|' + f.value, f])).values()]
    return JSON.stringify({ url: location.href.slice(0, 80), count: uniq.length, candidates: uniq.slice(0, 40) }, null, 1)
  })()`)
  console.log(out)
  c.close()
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
