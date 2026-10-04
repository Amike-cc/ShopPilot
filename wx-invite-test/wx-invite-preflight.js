/**
 * 微信小店达人邀约功能：**开跑前状态体检**（只读，不发任何东西）
 *   ① 店铺登录态（广场是否可打开、是否落在登录页）
 *   ② 面板里那份按店铺存的邀约配置（联系人/微信/手机/话术/商品ID/广场筛选）
 *   ③ 平台侧额度（「今日剩余N次邀请机会」）
 *   ④ 广场上当前筛选下可邀约的达人名单（前几位 + 是否已达门槛）
 *
 * 用法：node wx-invite-test/wx-invite-preflight.js
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
  const ev = async (expr, timeoutMs = 25000) => {
    const r = await withTimeout(send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }), timeoutMs, 'CDP 求值')
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  return { send, ev, close: () => ws.close() }
}

const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const report = {}
  const list = await targets()
  const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  if (!renderer) throw new Error('未找到应用渲染层（探针实例要用 --remote-debugging-port 启动）')
  const app = await connect(renderer)
  const call = async (expr) => JSON.parse(await app.ev(`(async () => JSON.stringify(await ${expr}))()`))

  // ② 面板配置（按店铺存的键；回退旧的按平台键）
  const storeCfg = await call(`window.shopilot.settings.get('invite.config.store.${STORE}')`)
  const legacyCfg = await call(`window.shopilot.settings.get('invite.config.微信小店')`)
  const squareUrls = await call(`window.shopilot.settings.get('invite.squareUrls')`)
  const cfg = (storeCfg?.ok && storeCfg.data?.value) ? storeCfg.data.value : ((legacyCfg?.ok && legacyCfg.data?.value) ? legacyCfg.data.value : null)
  report.config = cfg
  report.configSource = (storeCfg?.ok && storeCfg.data?.value) ? 'invite.config.store.<storeId>' : (cfg ? 'invite.config.微信小店（旧键）' : '无')
  report.squareUrlOverride = squareUrls?.ok ? squareUrls.data?.value : null
  console.log('=== ② 邀约配置 ===')
  console.log('来源:', report.configSource)
  if (cfg && typeof cfg === 'object') {
    console.log(JSON.stringify({
      contact: cfg.contact, wechat: cfg.wechat, phone: cfg.phone,
      scriptMode: cfg.scriptMode, scriptLen: String(cfg.script || '').length,
      productIds: cfg.productIds, finderType: cfg.finderType,
      categories: cfg.finderCategories, salesTiers: cfg.finderSalesTiers, others: cfg.finderOtherFilters
    }, null, 1))
  } else {
    console.log('（没有配置：面板里还没保存过）')
  }

  // ① + ③ 打开店铺窗口并导航到广场
  console.log('=== ① 店铺登录态 + ③ 额度 ===')
  const displayed = await call(`window.shopilot.browser.display(${JSON.stringify(STORE)})`)
  console.log('店铺窗口:', JSON.stringify(displayed?.data || displayed?.error))
  await sleep(2500)
  const prepared = await call(`window.shopilot.browser.prepareInviteSquare(${JSON.stringify(STORE)}, ${JSON.stringify({ url: SQUARE })})`)
  report.square = { ok: prepared?.ok, error: prepared?.error?.message || null }
  console.log('打开广场:', prepared?.ok ? 'ok' : `失败：${prepared?.error?.message}`)
  await sleep(5000)

  const after = await targets()
  const wxPage = after.find(t => /store\.weixin\.qq\.com/.test(String(t.url)))
  if (!wxPage) throw new Error('未找到微信小店页面')
  const wx = await connect(wxPage)
  const page = JSON.parse(await wx.ev(`(() => { ${ENUM_ALL}
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const text = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ')
    const quota = (text.match(/今日剩余\\s*\\d+\\s*次邀请机会/) || [])[0] || null
    const login = /登录超时|请重新\\s*登录|扫码进入我的小店/.test(text)
    const counts = ENUM_ALL().filter(el => own(el) === '详情' && el.getBoundingClientRect().width > 0).length
    const names = []
    for (const el of ENUM_ALL()) {
      const cls = String(el.className || '')
      if (!/nickname|finder-name|talent-name/i.test(cls)) continue
      const t = String(el.innerText || '').replace(/\\s+/g, ' ').trim()
      if (t && !names.includes(t)) names.push(t.slice(0, 24))
      if (names.length >= 5) break
    }
    return JSON.stringify({ url: location.href, login, quota, detailLinks: counts, names })
  })()`))
  report.page = page
  console.log('页面:', JSON.stringify(page, null, 1))
  console.log('登录态:', page.login ? '❌ 登录已过期（需要人工扫码）' : '✅ 已登录')
  console.log('额度:', page.quota || '（页面上没读到额度文案）')
  console.log('可点「详情」的达人行数:', page.detailLinks)

  fs.writeFileSync(path.join(OUT_DIR, 'preflight.json'), JSON.stringify(report, null, 1))
  console.log('留档: wx-invite-test/evidence/preflight.json')

  wx.close()
  app.close()
  process.exit(0)
}

main().catch(err => { console.error('ERR', err.stack || err.message); process.exit(1) })
