/**
 * M2 收尾验收：详情页采集 → 另存为 → 图片本地化（**这次应该真的本地化成功**）
 *
 * 为什么单独一份：列表页的缩略图实测是 SVG（会被如实拒绝），详情页才是 WebP 真图。
 * 这份脚本验的就是"换了图片来源之后，本地化这条路是否真的通了"。
 * 用完即还原：结束时软删测试商品。
 */
const { spawn, execSync } = require('child_process')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.join(__dirname, '..', '..')
const PORT = Number(process.argv[2] || 9280)
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const DB_PATH = path.join(process.env.APPDATA || '', 'shopilot', 'shopilot.db')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(...a)

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map()
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
    this.ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id) } }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, m => m.error ? rej(new Error(method)) : res(m.result))
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expr, timeoutMs = 240000) {
    const run = this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      .then(r => { if (r.exceptionDetails) throw new Error('页面内异常'); return r.result?.value })
    return Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), timeoutMs))])
  }
}

async function targets() { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`).catch(() => null); return r && r.ok ? await r.json() : [] }

async function findRenderer(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const page = (await targets()).find(t => t.type === 'page' && /index\.html/.test(t.url || ''))
    if (page?.webSocketDebuggerUrl) {
      const cdp = new CDP(page.webSocketDebuggerUrl); await cdp.ready
      if (await cdp.eval('!!(window.shopilot && window.shopilot.products && window.shopilot.products.detail)', 5000).catch(() => false)) return cdp
    }
    if (Date.now() >= deadline) throw new Error('等不到主窗口（products.detail 没挂上？）')
    await sleep(600)
  }
}

function killTree(child) { if (!child || child.exitCode === null) { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* gone */ } } }

async function call(ui, expr) {
  const raw = await ui.eval(`Promise.resolve(${expr}).then(r => JSON.stringify(r))`)
  try { return JSON.parse(raw) } catch { return raw }
}

async function main() {
  log('=== M2 收尾验收：详情页采集 → 另存为 → 图片本地化 ===')
  const child = spawn(ELECTRON, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' } })

  let productId = null
  try {
    const ui = await findRenderer()
    log('已连上主窗口\n')

    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const store = db.prepare(`SELECT id, name FROM stores WHERE platform = '微信小店' AND deleted_at IS NULL LIMIT 1`).get()
    const link = db.prepare(`SELECT platform_product_id, platform_title FROM product_platform_links WHERE platform = '微信小店' AND product_id IS NULL ORDER BY platform_product_id LIMIT 1`).get()
    db.close()
    if (!store || !link) throw new Error('库里缺微信小店店铺或未归并商品')

    await call(ui, `window.shopilot.browser.open(${JSON.stringify(store.id)})`)
    await sleep(7000)
    log(`测试对象：${String(link.platform_title).slice(0, 26)}（ID ${link.platform_product_id}）\n`)

    log('① 拉取详情（去详情页读商品图 + 规格）')
    const detail = await call(ui, `window.shopilot.products.detail.collect(${JSON.stringify({ storeId: store.id, platformProductId: link.platform_product_id })})`)
    const d = detail?.data || {}
    log(`   状态=${d.status} 原因码=${d.reasonCode}`)
    log(`   原话：${d.safeMessage}`)
    log(`   图 ${d.imageCount} 张、规格 ${d.skuCount} 个：${JSON.stringify(d.specNames)}`)
    if ((d.fields || []).length) log(`   详情页其它字段：${JSON.stringify(d.fields.slice(0, 4))}`)

    const db2 = new DatabaseSync(DB_PATH, { readOnly: true })
    const after = db2.prepare(`SELECT platform_image_urls_json FROM product_platform_links WHERE platform = '微信小店' AND platform_product_id = ?`).get(link.platform_product_id)
    db2.close()
    let urls = []
    try { urls = JSON.parse(after?.platform_image_urls_json || '[]') } catch { /* ignore */ }
    log(`   库里现在的图片地址 ${urls.length} 条，第一条：${String(urls[0] || '').slice(0, 100)}`)

    log('\n② 另存为本地商品（带上详情页的真图）')
    const created = await call(ui, `window.shopilot.products.library.saveAsLocal(${JSON.stringify({ platform: '微信小店', storeId: store.id, platformProductId: link.platform_product_id })})`)
    productId = created?.data?.productId || null
    log(`   ok=${created?.ok} productId=${productId ? productId.slice(0, 8) + '…' : '(无)'}`)
    const got = await call(ui, `window.shopilot.products.library.get(${JSON.stringify(productId)})`)
    log(`   草稿图片：${JSON.stringify((got?.data?.draft?.media || []).map(m => ({ role: m.role, state: m.state, url: String(m.remoteUrl || '').slice(0, 70) })))}`)

    log('\n③ 图片本地化（关键：详情页是 WebP，这次应该真的成功）')
    const localized = await call(ui, `window.shopilot.products.library.localizeMedia(${JSON.stringify(productId)})`)
    const l = localized?.data || {}
    log(`   共 ${l.total} 张：本地化 ${l.localized}、重复 ${l.deduped}、失败 ${l.failed}、拒绝 ${l.blocked}`)
    for (const item of (l.details || [])) log(`     · ${String(item.remoteUrl || '').slice(0, 60)} → ${item.state}${item.reason ? ' (' + item.reason + ')' : ''}`)

    log('\n④ 再本地化一次（同图 sha256 去重）')
    const again = await call(ui, `window.shopilot.products.library.localizeMedia(${JSON.stringify(productId)})`)
    log(`   共 ${again?.data?.total} 张：本地化 ${again?.data?.localized}、重复 ${again?.data?.deduped}、失败 ${again?.data?.failed}、拒绝 ${again?.data?.blocked}`)

    log('\n=== 看"本地化"这一列是否 > 0：> 0 就说明图片来源换成详情页之后，本地化这条路通了 ===')
  } finally {
    if (productId) {
      try {
        const ui = await findRenderer(10000)
        await call(ui, `window.shopilot.products.library.remove(${JSON.stringify(productId)})`)
        log(`\n↩ 已清理测试数据：本地商品 ${productId.slice(0, 8)}… 已软删`)
      } catch (e) { log('\n清理失败（可手动删）：', String(e && e.message || e)) }
    }
    killTree(child)
    await sleep(1200)
  }
}

main().catch(e => { console.error('\n验收失败:', (e && e.message) || e); process.exitCode = 1 })
