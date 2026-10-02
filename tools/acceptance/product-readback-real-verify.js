/**
 * M4 真机验收：回读闭环（方案 §7.5）
 *
 * 验四件事：
 *   ① 回读**只读**：读页面产出建议，但**落库前 `product_platform_defaults` 一行都不许变**；
 *   ② 用户确认一条 `suggest_default` → 落库，`source=human_readback`；
 *   ③ **闭环**：下次预检的"用上次选择"能真的用上这条默认值（这是"越用越自动"的关键）；
 *   ④ 全程不点提交、不改页面。
 *
 * 用完即还原：软删测试商品 + 删掉本次写的默认值（否则会污染下次验收）。
 */
const { spawn, execSync } = require('child_process')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.join(__dirname, '..', '..')
const PORT = Number(process.argv[2] || 9284)
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
      if (await cdp.eval('!!(window.shopilot && window.shopilot.products && window.shopilot.products.publish && window.shopilot.products.publish.readback)', 5000).catch(() => false)) return cdp
    }
    if (Date.now() >= deadline) throw new Error('等不到主窗口（publish.readback 没挂上？）')
    await sleep(600)
  }
}

function killTree(child) { if (!child || child.exitCode === null) { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* gone */ } } }

async function call(ui, expr) {
  const raw = await ui.eval(`Promise.resolve(${expr}).then(r => JSON.stringify(r))`)
  try { return JSON.parse(raw) } catch { return raw }
}

function countDefaults() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  const row = db.prepare('SELECT COUNT(*) AS c FROM product_platform_defaults').get()
  db.close()
  return Number(row.c)
}

async function main() {
  log('=== M4 真机验收：回读闭环（只读 → 用户确认 → 落库 → 下次预检用上）===')
  const child = spawn(ELECTRON, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' } })

  let productId = null
  const defaultsBefore = countDefaults()
  try {
    const ui = await findRenderer()
    log('已连上主窗口\n')
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const store = db.prepare(`SELECT id, name FROM stores WHERE platform = '微信小店' AND deleted_at IS NULL LIMIT 1`).get()
    const link = db.prepare(`SELECT platform_product_id, platform_title FROM product_platform_links WHERE platform = '微信小店' AND product_id IS NULL ORDER BY platform_product_id LIMIT 1`).get()
    db.close()
    if (!store || !link) throw new Error('库里缺微信小店店铺或未归并商品')

    await call(ui, 'window.shopilot.browser.open(' + JSON.stringify(store.id) + ')')
    await sleep(7000)

    log('① 准备本地商品（含平台商品 ID，回读要读它的编辑页）')
    const created = await call(ui, 'window.shopilot.products.library.saveAsLocal(' + JSON.stringify({ platform: '微信小店', storeId: store.id, platformProductId: link.platform_product_id }) + ')')
    productId = created?.data?.productId || null
    if (!productId) throw new Error('另存为失败：' + JSON.stringify(created).slice(0, 200))
    // 先给本地设一个短标题（编辑页才有该字段，回读才有内容可比）
    const got = await call(ui, 'window.shopilot.products.library.get(' + JSON.stringify(productId) + ')')
    // **把短标题清空**：这样平台上的短标题就成了'本地没有、平台上填了' → suggest_default，
    // 才能验'确认 → 落库 → 下次预检用上'这个闭环
    await call(ui, 'window.shopilot.products.library.save(' + JSON.stringify({ productId, draft: { ...got.data.draft, subtitle: null } }) + ')')
    log('   本地商品 ' + String(productId).slice(0, 8) + '…（短标题=空，用来触发 suggest_default）\n')

    log('② 发布预检（拿到 itemId）')
    const pre = await call(ui, 'window.shopilot.products.publish.preflight(' + JSON.stringify({ productId, storeIds: [store.id] }) + ')')
    const itemId = pre?.data?.itemId
    log('   itemId=' + (itemId ? String(itemId).slice(0, 8) + '…' : '(无)') + ' 判定=' + pre?.data?.precheck?.verdict)
    if (!itemId) throw new Error('预检没给 itemId')

    log('\n③ 回读字段（**只读**：只打开编辑页读 DOM）')
    const readback = await call(ui, 'window.shopilot.products.publish.readback(' + JSON.stringify({ itemId }) + ')')
    const d = readback?.data || {}
    log('   ok=' + d.ok + ' 读到字段=' + JSON.stringify(d.readFields) + ' 缺失=' + JSON.stringify(d.missingFields))
    log('   原话：' + d.safeMessage)
    for (const s of (d.suggestions || [])) {
      log(`     ${String(s.label).padEnd(4)} | 本地=${String(s.localValue ?? '—').slice(0, 20).padEnd(20)} | 平台=${String(s.platformValue ?? '—').slice(0, 20).padEnd(20)} | ${s.kind}`)
    }
    const defaultsAfterRead = countDefaults()
    log(`\n   ⚠️ 落库前核对：product_platform_defaults ${defaultsBefore} → ${defaultsAfterRead}（必须相等：回读不写库）`)

    // 找一条 suggest_default 来验"确认后落库"
    const target = (d.suggestions || []).find(s => s.kind === 'suggest_default')
    if (!target) {
      log('\n   （本次没有 suggest_default 建议，跳过"确认落库"与"闭环"两步）')
    } else {
      log('\n④ 用户确认一条建议 → 落库（source=human_readback）')
      const accepted = await call(ui, 'window.shopilot.products.publish.acceptSuggestion(' + JSON.stringify({ itemId, field: target.field, kind: target.kind }) + ')')
      log('   ok=' + accepted?.ok + ' 原话=' + accepted?.data?.safeMessage)
      const db2 = new DatabaseSync(DB_PATH, { readOnly: true })
      const rows = db2.prepare('SELECT field_key, field_value, source, scope FROM product_platform_defaults').all()
      db2.close()
      log('   库里现在：' + JSON.stringify(rows))

      log('\n⑤ 闭环：下次预检的"用上次选择"能不能用上这条默认值')
      const pre2 = await call(ui, 'window.shopilot.products.publish.preflight(' + JSON.stringify({ productId, storeIds: [store.id] }) + ')')
      const fields = pre2?.data?.precheck?.fields || []
      const hit = fields.find(f => f.field === target.field)
      log(`   字段「${hit?.label}」：action=${hit?.action} lastValue=${hit?.lastValue ?? '(无)'}`)
      log('   ' + (hit?.lastValue ? '✅ 用上了（lastValue 非空）' : '⚠️ 没取到 lastValue'))
    }

    log('\n=== 验收要点：回读前后 defaults 行数相等（只读）；确认后才落库；下次预检 lastValue 非空 ===')
  } finally {
    // 还原：软删测试商品 + 删掉本次新增的默认值
    try {
      const ui = await findRenderer(10000)
      if (productId) await call(ui, 'window.shopilot.products.library.remove(' + JSON.stringify(productId) + ')')
      log('\n↩ 已软删测试商品 ' + String(productId || '').slice(0, 8) + '…')
    } catch (e) { log('\n清理失败：' + String(e && e.message || e)) }
    killTree(child)
    await sleep(1200)
    // 清掉本次写的默认值（在应用退出后做，避免写冲突）
    try {
      const db = new DatabaseSync(DB_PATH)
      const removed = db.prepare("DELETE FROM product_platform_defaults WHERE source = 'human_readback'").run()
      const reqs = db.prepare('SELECT COUNT(*) AS c FROM product_platform_requirements').get()
      db.close()
      log(`↩ 已清理回读写入的默认值 ${removed.changes} 条（必填清单保留 ${reqs.c} 条，它是平台事实）`)
    } catch (e) { log('清理默认值失败：' + String(e && e.message || e)) }
  }
}

main().catch(e => { console.error('\n验收失败:', (e && e.message) || e); process.exitCode = 1 })
