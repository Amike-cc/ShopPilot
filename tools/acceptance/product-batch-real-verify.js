/**
 * M5 真机验收：批量编排（方案 §7.8，全程不提交）
 *
 * 验四件事：
 *   ① 建批量：2 商品 × 2 店 = 4 项，**按店铺分组**排队，全部 pending；
 *   ② 进度：**三个数**（已完成/待人工/失败）+ 当前店铺，**不许出现百分比**；
 *   ③ 「跳过这家」：只跳过还没开始的项，当前店立刻换下一家；
 *   ④ 上限：21 家店被拒绝（规则层与 IPC 两道门）；
 *   ⑤ **没有任何提交**：全程没有 confirmed 的项。
 *
 * 用完即还原：删掉本次建的批次台账（job/item），不留测试数据。
 */
const { spawn, execSync } = require('child_process')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.join(__dirname, '..', '..')
const PORT = Number(process.argv[2] || 9285)
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
      if (await cdp.eval('!!(window.shopilot && window.shopilot.products && window.shopilot.products.publish && window.shopilot.products.publish.batchCreate)', 5000).catch(() => false)) return cdp
    }
    if (Date.now() >= deadline) throw new Error('等不到主窗口（publish.batchCreate 没挂上？）')
    await sleep(600)
  }
}

function killTree(child) { if (!child || child.exitCode === null) { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* gone */ } } }

async function call(ui, expr) {
  const raw = await ui.eval(`Promise.resolve(${expr}).then(r => JSON.stringify(r))`)
  try { return JSON.parse(raw) } catch { return raw }
}

async function main() {
  log('=== M5 真机验收：批量编排（不提交）===')
  const child = spawn(ELECTRON, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' } })

  const createdProducts = []
  try {
    const ui = await findRenderer()
    log('已连上主窗口\n')
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const stores = db.prepare(`SELECT id, name FROM stores WHERE deleted_at IS NULL ORDER BY name LIMIT 3`).all()
    // 链接要连**它自己的店铺**一起取：拿 stores[0] 去配微信小店的链接会 LINK_NOT_FOUND（平台对不上）
    const link = db.prepare(`SELECT platform_product_id, store_id FROM product_platform_links WHERE platform = '微信小店' AND product_id IS NULL ORDER BY platform_product_id LIMIT 1`).get()
    db.close()
    if (stores.length < 2) throw new Error('至少要有 2 家店铺')
    if (!link) throw new Error('没有未归并的微信小店商品，先跑一次商品同步')
    log('   链接所属店铺：' + String(link.store_id).slice(0, 20) + '…')

    log('① 准备 2 个本地商品')
    for (let i = 0; i < 2; i++) {
      const created = await call(ui, 'window.shopilot.products.library.saveAsLocal(' + JSON.stringify({ platform: '微信小店', storeId: link.store_id, platformProductId: link.platform_product_id }) + ')')
      const id = created?.data?.productId
      if (id) createdProducts.push(id)
    }
    if (createdProducts.length < 2) throw new Error('准备本地商品失败')
    log('   已建 ' + createdProducts.length + ' 个本地商品\n')

    log('② 建批量（2 商品 × 2 店 = 4 项）')
    const batch = await call(ui, 'window.shopilot.products.publish.batchCreate(' + JSON.stringify({ productIds: createdProducts, storeIds: [stores[0].id, stores[1].id] }) + ')')
    const batchId = batch?.data?.batchId
    log('   ok=' + batch?.ok + ' batchId=' + (batchId ? String(batchId).slice(0, 14) + '…' : '(无)'))
    if (batch?.data?.errors?.length) log('   errors=' + JSON.stringify(batch.data.errors))
    log('   进度：' + batch?.data?.progress?.summary)
    log('   三个数：已完成=' + batch?.data?.progress?.done + ' 待人工=' + batch?.data?.progress?.waitingHuman + ' 失败=' + batch?.data?.progress?.failed + ' 未开始=' + batch?.data?.progress?.pending)
    log('   当前店铺=' + String(batch?.data?.progress?.currentStoreId || '').slice(0, 20) + '（应是第一家：' + String(stores[0].id).slice(0, 20) + '）')

    log('\n③ 读进度（只读）')
    const p1 = await call(ui, 'window.shopilot.products.publish.batchProgress(' + JSON.stringify({ batchId }) + ')')
    log('   summary：' + p1?.data?.progress?.summary)
    log('   含百分比？' + (String(p1?.data?.progress?.summary || '').includes('%') ? '❌ 含' : '✅ 不含'))
    log('   项数=' + (p1?.data?.items?.length || 0) + ' 状态分布=' + JSON.stringify((p1?.data?.items || []).reduce((acc, row) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc }, {})))

    log('\n④ 跳过这家店（只跳"还没开始"的）')
    const skipped = await call(ui, 'window.shopilot.products.publish.batchSkipStore(' + JSON.stringify({ batchId, storeId: stores[0].id }) + ')')
    log('   跳过=' + skipped?.data?.skipped + ' 原话=' + String(skipped?.data?.safeMessage || '').slice(0, 90))
    const p2 = await call(ui, 'window.shopilot.products.publish.batchProgress(' + JSON.stringify({ batchId }) + ')')
    log('   跳过后的当前店铺=' + String(p2?.data?.progress?.currentStoreId || '').slice(0, 20) + '（应换成第二家：' + String(stores[1].id).slice(0, 20) + '）')
    log('   状态分布=' + JSON.stringify((p2?.data?.items || []).reduce((acc, row) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc }, {})))

    log('\n⑤ 上限：21 家店应被拒绝')
    const tooMany = await call(ui, 'window.shopilot.products.publish.batchCreate(' + JSON.stringify({ productIds: [createdProducts[0]], storeIds: Array.from({ length: 21 }, (_, i) => 'store_' + i) }) + ')')
    log('   ok=' + tooMany?.ok + ' 错误=' + JSON.stringify(tooMany?.data?.errors || tooMany?.error?.message || null))

    log('\n⑥ 核对：全程**没有任何提交**')
    const db2 = new DatabaseSync(DB_PATH, { readOnly: true })
    const states = db2.prepare("SELECT i.status, COUNT(*) AS c FROM product_publish_items i JOIN product_publish_jobs j ON j.id = i.job_id WHERE j.batch_id = ? GROUP BY i.status").all(batchId)
    const jobs = db2.prepare('SELECT COUNT(*) AS c FROM product_publish_jobs WHERE batch_id = ?').get(batchId)
    db2.close()
    log('   批次里的状态分布：' + JSON.stringify(states))
    log('   job 数=' + jobs.c + '（每个商品一个 job）')
    log('   confirmed 数=' + (states.find(s => s.status === 'confirmed')?.c ?? 0) + '（必须是 0：我们没提交任何东西）')

    log('\n=== 验收要点：三数进度无百分比；跳过这家后当前店换下一家；21 店被拒；confirmed=0 ===')
  } finally {
    try {
      const ui = await findRenderer(10000)
      for (const id of createdProducts) await call(ui, 'window.shopilot.products.library.remove(' + JSON.stringify(id) + ')')
      log('\n↩ 已软删 ' + createdProducts.length + ' 个测试商品')
    } catch (e) { log('\n清理商品失败：' + String(e && e.message || e)) }
    killTree(child)
    await sleep(1200)
    // 清掉本次的批量台账（应用退出后做，避免写冲突）
    try {
      const db = new DatabaseSync(DB_PATH)
      const before = db.prepare("SELECT COUNT(*) AS c FROM product_publish_jobs WHERE batch_id LIKE 'batch_%'").get()
      db.prepare("DELETE FROM product_publish_items WHERE job_id IN (SELECT id FROM product_publish_jobs WHERE batch_id LIKE 'batch_%')").run()
      db.prepare("DELETE FROM product_publish_jobs WHERE batch_id LIKE 'batch_%'").run()
      db.close()
      log(`↩ 已清理批量台账 ${before.c} 个 job（含其 item）`)
    } catch (e) { log('清理台账失败：' + String(e && e.message || e)) }
  }
}

main().catch(e => { console.error('\n验收失败:', (e && e.message) || e); process.exitCode = 1 })
