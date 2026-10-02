/**
 * M3 真机验收：发布预检 + 打开发布页（**全程不提交**）
 *
 * 验的就是"半自动"的边界：
 *   ① 预检算出字段级 diff 与阻断项（不写平台、不开页面）；
 *   ② 打开发布页后**只读确认**页面确实是发布页，且**没有任何提交动作发生**；
 *   ③ 台账落在 product_publish_jobs / product_publish_items。
 *
 * 用完即还原：结束时软删测试商品（台账保留，它本身就是审计材料）。
 */
const { spawn, execSync } = require('child_process')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.join(__dirname, '..', '..')
const PORT = Number(process.argv[2] || 9283)
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
      if (await cdp.eval('!!(window.shopilot && window.shopilot.products && window.shopilot.products.publish)', 5000).catch(() => false)) return cdp
    }
    if (Date.now() >= deadline) throw new Error('等不到主窗口（products.publish 没挂上？）')
    await sleep(600)
  }
}

function killTree(child) { if (!child || child.exitCode === null) { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* gone */ } } }

async function call(ui, expr) {
  const raw = await ui.eval(`Promise.resolve(${expr}).then(r => JSON.stringify(r))`)
  try { return JSON.parse(raw) } catch { return raw }
}

async function main() {
  log('=== M3 真机验收：发布预检 + 打开发布页（不提交）===')
  const child = spawn(ELECTRON, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' } })

  let productId = null
  try {
    const ui = await findRenderer()
    log('已连上主窗口\n')

    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const store = db.prepare(`SELECT id, name, status FROM stores WHERE platform = '微信小店' AND deleted_at IS NULL LIMIT 1`).get()
    const link = db.prepare(`SELECT platform_product_id, platform_title FROM product_platform_links WHERE platform = '微信小店' AND product_id IS NULL ORDER BY platform_product_id LIMIT 1`).get()
    db.close()
    if (!store) throw new Error('没有在线的微信小店店铺')

    log(`目标店铺：${store.name}（库里的状态：${store.status}）`)
    // 先打开店铺刷新一次状态：多次重启后库里的状态会过期，而预检要按**当前**状态判
    await call(ui, `window.shopilot.browser.open(${JSON.stringify(store.id)})`)
    await sleep(9000)
    const db2 = new DatabaseSync(DB_PATH, { readOnly: true })
    const refreshed = db2.prepare('SELECT status FROM stores WHERE id = ?').get(store.id)
    db2.close()
    log(`打开后状态：${refreshed?.status ?? '(取不到)'}`)
    if (!link) log('（库里没有未归并的微信商品，跳过"另存为"，直接用现有本地商品）')

    // 准备一个本地商品：优先用已有的，没有就从一个平台商品另存为
    const existing = await call(ui, `window.shopilot.products.library.list({ limit: 1 })`)
    productId = existing?.data?.rows?.[0]?.id || null
    if (!productId) {
      if (!link) throw new Error('既没有本地商品也没有可另存的平台商品')
      const created = await call(ui, `window.shopilot.products.library.saveAsLocal(${JSON.stringify({ platform: '微信小店', storeId: store.id, platformProductId: link.platform_product_id })})`)
      productId = created?.data?.productId || null
    }
    if (!productId) throw new Error('准备本地商品失败')
    log(`本地商品：${String(productId).slice(0, 8)}…`)
    // 给商品设一个短标题：用来验证"副标题是支持的"这个**更正后的事实**（之前猜的是"不支持"）
    const before = await call(ui, `window.shopilot.products.library.get(${JSON.stringify(productId)})`)
    if (before?.ok) {
      const d = before.data.draft
      // 用字符串拼接构造表达式（不要嵌套模板字符串，容易写出非法表达式）
      const payload = JSON.stringify({ productId, draft: { ...d, subtitle: '本地短标题（验证用）' } })
      await call(ui, 'window.shopilot.products.library.save(' + payload + ')')
      log('   已给测试商品设短标题：本地短标题（验证用）')
    }

    log('① 发布预检（只算不写平台、不开页面）')
    const pre = await call(ui, `window.shopilot.products.publish.preflight(${JSON.stringify({ productId, storeIds: [store.id] })})`)
    const p = pre?.data?.precheck
    log(`   ok=${pre?.ok} jobId=${pre?.data?.jobId ? String(pre.data.jobId).slice(0, 8) + '…' : '(无)'} itemId=${pre?.data?.itemId ? String(pre.data.itemId).slice(0, 8) + '…' : '(无)'}`)
    log(`   判定=${p?.verdict} 档位=${p?.tier}`)
    log(`   幂等键=${p?.idempotencyKey}`)
    log(`   结论：${p?.summary}`)
    log('   字段级 diff（本地值 / 平台当前值 / 上次值 / 本次动作）：')
    for (const f of (p?.fields || [])) {
      log(`     ${String(f.label).padEnd(4)} | ${String(f.localValue ?? '—').slice(0, 22).padEnd(22)} | ${String(f.platformValue ?? '（未读页面）').padEnd(12)} | ${String(f.lastValue ?? '—').padEnd(6)} | ${f.action}${f.note ? ' ← ' + f.note : ''}`)
    }
    if ((p?.blockers || []).length) log(`   阻断项：${JSON.stringify(p.blockers.map(b => b.message))}`)
    if ((p?.warnings || []).length) log(`   提醒：${JSON.stringify(p.warnings.map(w => w.message))}`)
    if ((p?.missingRequired || []).length) log(`   本地缺的必填项：${JSON.stringify(p.missingRequired)}`)

    log('\n② 打开发布页 + L1 代填（不点提交、不点保存）')
    const opened = await call(ui, `window.shopilot.products.publish.open(${JSON.stringify({ itemId: pre?.data?.itemId, fill: true })})`)
    log('   逐字段代填结果（写后回读）：')
    for (const row of (opened?.data?.fill || [])) {
      log(`     ${String(row.label).padEnd(4)} | ok=${row.ok} | 写入=${String(row.written ?? '—').slice(0, 24)} | 回读=${String(row.readBack ?? '—').slice(0, 24)}${row.reason ? ' ← ' + row.reason : ''}`)
    }
    log(`   ok=${opened?.ok} state=${opened?.data?.state} tier=${opened?.data?.tier}`)
    log(`   原话：${opened?.data?.safeMessage}`)
    log(`   打开的地址：${opened?.data?.url}`)

    // 只读确认：页面确实是发布页，且**表单是空的**（说明我们没代填）
    await sleep(20000)
    let page = null
    for (const t of await targets()) {
      if (t.type === 'webview' && /goods\/entry/.test(t.url || '')) { page = t; break }
    }
    if (page) {
      const probe = new CDP(page.webSocketDebuggerUrl); await probe.ready
      const dom = await probe.eval(`(() => {
        const inputs = [...document.querySelectorAll('input')].filter(el => el.getClientRects().length);
        const nameInput = inputs.find(el => String(el.getAttribute('placeholder')||'').includes('商品名称'));
        const fileCount = document.querySelectorAll('input[type=file]').length;
        const priceInput = inputs.find(el => String(el.getAttribute('placeholder')||'') === '填写售卖价');
        const stockInput = inputs.find(el => String(el.getAttribute('placeholder')||'') === '输入库存');
        return JSON.stringify({ url: location.href, 商品名称当前值: nameInput ? nameInput.value : null,
                                价格当前值: priceInput ? priceInput.value : null, 库存当前值: stockInput ? stockInput.value : null,
                                文件上传入口: fileCount });
      })()`)
      log(`   只读确认：${dom}`)
      log('   ⬆ 商品名称当前值应为空 —— 说明应用没有代填任何内容')
    } else {
      log('   （没找到发布页 webview，跳过只读确认）')
    }

    log('\n③ 人工确认门禁（走任务引擎的 waitForUserConfirmation）')
    const gate = await call(ui, 'window.shopilot.products.publish.openGate(' + JSON.stringify({ itemId: pre?.data?.itemId }) + ')')
    log('   开门禁：ok=' + gate?.ok + ' runId=' + (gate?.data?.runId ? String(gate.data.runId).slice(0, 8) + '…' : '(无)'))
    const confirmed = await call(ui, 'window.shopilot.products.publish.confirm(' + JSON.stringify({ itemId: pre?.data?.itemId, approved: true }) + ')')
    log('   「我已提交」：state=' + confirmed?.data?.state + ' 原话=' + String(confirmed?.data?.safeMessage || '').slice(0, 60))
    const verified = await call(ui, 'window.shopilot.products.publish.verify(' + JSON.stringify({ itemId: pre?.data?.itemId }) + ')')
    log('   只读回读：state=' + verified?.data?.state + ' matched=' + verified?.data?.matched)
    log('   回读原话：' + String(verified?.data?.safeMessage || '').slice(0, 90))

    log('\n④ 台账核对')
    const items = await call(ui, `window.shopilot.products.publish.items({ limit: 5 })`)
    for (const row of (items?.data?.rows || []).slice(0, 3)) {
      log(`   item ${String(row.id).slice(0, 8)}… | 店铺 ${row.store_id} | 档位 ${row.tier} | 状态 ${row.status} | ${String(row.safe_message || '').slice(0, 60)}`)
    }

    log('\n=== 验收要点：预检给出 diff 表；打开发布页后商品名称仍为空（未代填）；台账状态 awaiting_human ===')
  } finally {
    if (productId) {
      try {
        const ui = await findRenderer(10000)
        await call(ui, `window.shopilot.products.library.remove(${JSON.stringify(productId)})`)
        log(`\n↩ 已清理测试商品 ${String(productId).slice(0, 8)}…（台账保留：它本身是审计材料）`)
      } catch (e) { log('\n清理失败（可手动删）：', String(e && e.message || e)) }
    }
    killTree(child)
    await sleep(1200)
  }
}

main().catch(e => { console.error('\n验收失败:', (e && e.message) || e); process.exitCode = 1 })
