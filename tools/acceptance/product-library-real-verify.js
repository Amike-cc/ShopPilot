/**
 * M2 真机验收：本地商品库端到端（另存为 → 编辑 → 图片本地化）
 *
 * 运行：node tools/acceptance/product-library-real-verify.js [CDP端口]
 * 前置：关掉自己开着的 ShopPilot（单实例锁）；不要继承 ELECTRON_RUN_AS_NODE。
 *
 * 全程走应用自己的 IPC（和用户点界面完全同一条路径），并**用完即还原**：
 * 验收结束后把这次建出来的本地商品删掉（软删），不给用户留下测试数据。
 */
const { spawn, execSync } = require('child_process')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.join(__dirname, '..', '..')
const PORT = Number(process.argv[2] || 9277)
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
      this.pending.set(id, m => m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result))
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expr, timeoutMs = 180000) {
    const run = this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      .then(r => { if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result?.value })
    return Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error('执行超时')), timeoutMs))])
  }
}

async function targets() { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`).catch(() => null); return r && r.ok ? await r.json() : [] }

async function findRenderer(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const page = (await targets()).find(t => t.type === 'page' && /index\.html/.test(t.url || ''))
    if (page?.webSocketDebuggerUrl) {
      const cdp = new CDP(page.webSocketDebuggerUrl); await cdp.ready
      if (await cdp.eval('!!(window.shopilot && window.shopilot.products && window.shopilot.products.library)', 5000).catch(() => false)) return cdp
    }
    if (Date.now() >= deadline) throw new Error('等不到主窗口（window.shopilot.products.library 没挂上？）')
    await sleep(600)
  }
}

function killTree(child) { if (!child || child.exitCode === null) { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* gone */ } } }

async function call(ui, expr) {
  const raw = await ui.eval(`Promise.resolve(${expr}).then(r => JSON.stringify(r))`)
  try { return JSON.parse(raw) } catch { return raw }
}

async function main() {
  log('=== M2 真机验收：本地商品库 ===')

  const child = spawn(ELECTRON, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' } })

  let createdProductId = null
  try {
    // 先启动应用：它会跑迁移（v20 补的 platform_image_urls_json 列要等这一步之后才存在）
    const ui = await findRenderer()
    log('已连上主窗口（迁移已执行）\n')

    // 先同步一家店：v20 之前同步的行没有图片地址列，需要一次新同步把 URL 填上
    const db0 = new DatabaseSync(DB_PATH, { readOnly: true })
    const store = db0.prepare(`SELECT id, name, platform FROM stores WHERE platform = '微信小店' AND deleted_at IS NULL LIMIT 1`).get()
      ?? db0.prepare('SELECT id, name, platform FROM stores WHERE deleted_at IS NULL LIMIT 1').get()
    db0.close()
    if (!store) throw new Error('库里没有店铺')
    log(`先同步一次以填充图片地址：${store.name}（${store.platform}）`)
    // 先打开店铺再同步：冷启动直接同步时页面还没渲染好（实测会拿到 PAGE_CHANGED）
    await call(ui, `window.shopilot.browser.open(${JSON.stringify(store.id)})`)
    await sleep(7000)
    const sync = await call(ui, `window.shopilot.products.sync({ storeId: ${JSON.stringify(store.id)}, trigger: 'manual' })`)
    log(`   同步：${sync?.data?.status} 拉到=${sync?.data?.fetchedCount} 更新=${sync?.data?.updatedCount} 跳过=${sync?.data?.skippedCount}`)
    log(`   原话：${sync?.data?.safeMessage}\n`)

    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const links = db.prepare(`
      SELECT l.platform, l.store_id, l.platform_product_id, l.platform_title, l.platform_image_urls_json
      FROM product_platform_links l WHERE l.product_id IS NULL ORDER BY l.platform LIMIT 40
    `).all()
    db.close()

    // 挑一条**带图片地址**的平台商品（图片本地化要有输入）
    const withImage = links.find(row => {
      try { return JSON.parse(row.platform_image_urls_json || '[]').length > 0 } catch { return false }
    })
    if (!withImage) throw new Error('库里没有带图片地址的未归并平台商品，先跑一次商品同步')
    log(`测试对象：${withImage.platform} / ${String(withImage.platform_title).slice(0, 26)}（ID ${withImage.platform_product_id}）`)
    log(`图片地址数：${JSON.parse(withImage.platform_image_urls_json || '[]').length}\n`)

    // 打开该店铺：图片下载要用它的 Session（Cookie/代理）
    log('① 打开店铺（图片下载要用它的 Session）')
    await call(ui, `window.shopilot.browser.open(${JSON.stringify(withImage.store_id)})`)
    await sleep(7000)

    log('\n② 另存为本地商品（用户点的那条路径）')
    const created = await call(ui, `window.shopilot.products.library.saveAsLocal(${JSON.stringify({
      platform: withImage.platform, storeId: withImage.store_id, platformProductId: withImage.platform_product_id
    })})`)
    createdProductId = created?.data?.productId || null
    log(`   结果：ok=${created?.ok} productId=${createdProductId ? createdProductId.slice(0, 8) + '…' : '(无)'}`)
    log(`   草稿指纹：${created?.data?.draftHash}`)
    log(`   分级校验：${JSON.stringify((created?.data?.issues || []).map(i => `${i.level}:${i.field}`))}`)
    if (!createdProductId) throw new Error('另存为失败：' + JSON.stringify(created).slice(0, 300))

    log('\n③ 读回草稿（看归并后的内容）')
    const got = await call(ui, `window.shopilot.products.library.get(${JSON.stringify(createdProductId)})`)
    const draft = got?.data?.draft
    log(`   标题：${draft?.title}`)
    log(`   规格：${JSON.stringify(draft?.variants)}`)
    log(`   图片：${JSON.stringify((draft?.media || []).map(m => ({ role: m.role, state: m.state, url: String(m.remoteUrl || '').slice(0, 60) })))}`)
    log(`   已挂平台商品数：${got?.data?.linkedCount}`)

    log('\n④ 编辑并保存（改标题 + 改价格库存）')
    const beforeHash = got?.data?.draftHash
    const edited = {
      ...draft,
      title: `${draft.title}（本地已编辑）`,
      variants: (draft.variants || []).map(v => ({ ...v, priceMinor: (v.priceMinor ?? 0) + 100, stock: 42 }))
    }
    const saved = await call(ui, `window.shopilot.products.library.save(${JSON.stringify({ productId: createdProductId, platform: withImage.platform, draft: edited })})`)
    log(`   保存结果：ok=${saved?.ok} 新指纹=${saved?.data?.draftHash}`)
    log(`   指纹变化：${beforeHash !== saved?.data?.draftHash ? '已变化（正确：内容变了）' : '没变（错误！）'}`)
    log(`   校验：${JSON.stringify((saved?.data?.issues || []).map(i => `${i.level}:${i.field}`))}`)

    log('\n⑤ 图片本地化（走店铺 Session 下载 + 校验 + 去重）')
    const localized = await call(ui, `window.shopilot.products.library.localizeMedia(${JSON.stringify(createdProductId)})`)
    const d = localized?.data || {}
    log(`   共 ${d.total} 张：本地化 ${d.localized}、重复 ${d.deduped}、失败 ${d.failed}、拒绝 ${d.blocked}`)
    for (const detail of (d.details || [])) {
      log(`     · ${String(detail.remoteUrl || '').slice(0, 56)} → ${detail.state}${detail.reason ? ' (' + detail.reason + ')' : ''}`)
    }

    log('\n⑥ 再本地化一次（同一张图应走 sha256 去重，不再重复下载/落盘）')
    const again = await call(ui, `window.shopilot.products.library.localizeMedia(${JSON.stringify(createdProductId)})`)
    log(`   共 ${again?.data?.total} 张：本地化 ${again?.data?.localized}、重复 ${again?.data?.deduped}、失败 ${again?.data?.failed}、拒绝 ${again?.data?.blocked}`)

    log('\n⑦ 本地商品列表')
    const list = await call(ui, `window.shopilot.products.library.list({ limit: 20 })`)
    log(`   总数=${list?.data?.total}`)
    for (const row of (list?.data?.rows || []).slice(0, 5)) {
      log(`     · ${row.title} | 规格 ${row.variantCount} | 主图 ${row.coverState || '无'} | 已挂 ${row.linkCount}`)
    }

    log('\n=== 验收数据如上：指纹是否变化、图片本地化是否成功/去重，看上面的数字 ===')
  } finally {
    // 用完即还原：把这次建出来的测试商品软删掉
    if (createdProductId) {
      try {
        const ui = await findRenderer(10000)
        await call(ui, `window.shopilot.products.library.remove(${JSON.stringify(createdProductId)})`)
        log(`\n↩ 已清理测试数据：本地商品 ${createdProductId.slice(0, 8)}… 已软删`)
      } catch (e) { log('\n清理测试数据失败（可手动删）：', String(e && e.message || e)) }
    }
    killTree(child)
    await sleep(1200)
  }
}

main().catch(e => { console.error('\n验收失败:', (e && e.message) || e); process.exitCode = 1 })
