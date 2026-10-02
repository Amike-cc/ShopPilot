/**
 * 定性实验：渲染进程崩溃到底是"探针挂长时 eval"造成的，还是"批量下载本身"造成的？
 *
 * 做法（关键差别）：
 *   · 触发 `queueRun` 时 **不 await**（`awaitPromise: false`）—— 渲染进程上**不挂任何长时求值**；
 *   · 进度**从数据库侧轮询**（Node 直连 SQLite），不经过渲染进程；
 *   · 跑完检查主进程日志里有没有 `renderer gone`。
 *
 * 对照：之前崩的那次，探针在渲染进程上挂了约 4 分钟的 `awaitPromise`。
 *
 * 用完即还原：软删测试商品。
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.join(__dirname, '..', '..')
const PORT = Number(process.argv[2] || 9289)
const TARGET = Number(process.argv[3] || 50)
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const DB_PATH = path.join(process.env.APPDATA || '', 'shopilot', 'shopilot.db')
const LOG_PATH = path.join(process.env.APPDATA || '', 'shopilot', 'logs', 'app-2026-09-30.log')
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
  /** 等结果的求值（只用于**短**调用：建商品、清理）。 */
  async eval(expr, timeoutMs = 60000) {
    const run = this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      .then(r => { if (r.exceptionDetails) throw new Error('页面内异常'); return r.result?.value })
    return Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), timeoutMs))])
  }
  /** **不等结果**地触发（渲染进程上不挂长时求值 —— 这就是本次实验的关键）。 */
  fire(expr) {
    return this.send('Runtime.evaluate', { expression: expr, returnByValue: false, awaitPromise: false })
  }
}

async function targets() { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`).catch(() => null); return r && r.ok ? await r.json() : [] }

function mediaStats() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  const rows = db.prepare('SELECT state, COUNT(*) AS c FROM product_media GROUP BY state').all()
  db.close()
  const out = {}
  for (const row of rows) out[row.state] = row.c
  return out
}

function rendererCrashedSince(marker) {
  try {
    const text = fs.readFileSync(LOG_PATH, 'utf8')
    const tail = text.slice(marker)
    return /renderer gone reason=crashed/.test(tail)
  } catch { return null }
}

async function main() {
  log(`=== 定性实验：${TARGET} 张批量下载，渲染进程上不挂长时 eval ===`)
  const child = spawn(ELECTRON, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' } })
  const created = []
  try {
    let page = null
    for (let i = 0; i < 60 && !page; i++) {
      page = (await targets()).find(t => t.type === 'page' && /index\.html/.test(t.url || '')) || null
      if (!page) await sleep(700)
    }
    if (!page) throw new Error('等不到主窗口')
    const ui = new CDP(page.webSocketDebuggerUrl); await ui.ready
    await sleep(4000)

    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const link = db.prepare(`SELECT platform_product_id, store_id FROM product_platform_links WHERE platform = '微信小店' AND product_id IS NULL ORDER BY platform_product_id LIMIT 1`).get()
    db.close()
    if (!link) throw new Error('没有未归并的微信小店商品')

    // 每个商品带 22 张待本地化图；建够 TARGET 张
    const need = Math.ceil(TARGET / 22)
    log(`\n① 建 ${need} 个本地商品（每个带 22 张待本地化图）`)
    for (let i = 0; i < need; i++) {
      const payload = JSON.stringify({ platform: '微信小店', storeId: link.store_id, platformProductId: link.platform_product_id, mergeLink: i === 0 })
      const raw = await ui.eval('window.shopilot.products.library.saveAsLocal(' + payload + ').then(r => JSON.stringify(r))')
      const id = JSON.parse(raw)?.data?.productId
      if (id) created.push(id)
    }
    log('   已建 ' + created.length + ' 个商品')

    const before = mediaStats()
    log('   跑之前的媒体状态：' + JSON.stringify(before))
    const pendingBefore = before.pending ?? 0
    const logSize = fs.existsSync(LOG_PATH) ? fs.statSync(LOG_PATH).size : 0

    log(`\n② 触发队列（maxItems=${TARGET}）—— **不等结果**，渲染进程不挂长时求值`)
    await ui.fire('window.shopilot.products.library.queueRun({ maxItems: ' + TARGET + ' })')
    log('   已触发（fire-and-forget）')

    log('\n③ 从数据库侧轮询进度（不经过渲染进程）')
    const started = Date.now()
    let last = ''
    for (let i = 0; i < 60; i++) {
      await sleep(5000)
      const stats = mediaStats()
      const pending = stats.pending ?? 0
      const done = pendingBefore - pending
      const line = `   +${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s  已处理 ${done}/${Math.min(TARGET, pendingBefore)}  状态=${JSON.stringify(stats)}`
      if (line !== last) { log(line); last = line }
      if (done >= Math.min(TARGET, pendingBefore)) break
      if (Date.now() - started > 280_000) { log('   （到 280 秒上限，停止观察）'); break }
    }

    log('\n④ 渲染进程崩了吗？（查主进程日志新增部分）')
    const crashed = rendererCrashedSince(logSize)
    log('   renderer gone reason=crashed 出现？' + (crashed === null ? '（日志读不到）' : crashed ? '❌ 崩了' : '✅ 没崩'))
    log('   渲染进程还活着吗？' + (await ui.eval('1+1', 8000).then(() => '✅ 活着').catch(() => '❌ 已死')))

    log('\n=== 结论：如果没崩，说明之前的崩溃是"探针挂 4 分钟 eval"造成的，不是批量下载本身 ===')
  } finally {
    try {
      const page = (await targets()).find(t => t.type === 'page' && /index\.html/.test(t.url || ''))
      if (page && created.length) {
        const ui = new CDP(page.webSocketDebuggerUrl); await ui.ready
        for (const id of created) await ui.eval('window.shopilot.products.library.remove(' + JSON.stringify(id) + ').then(() => 1)', 15000).catch(() => null)
        log('\n↩ 已软删 ' + created.length + ' 个测试商品')
      }
    } catch { /* ignore */ }
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* gone */ }
    await sleep(1000)
  }
}

main().catch(e => { console.error('\n实验失败:', (e && e.message) || e); process.exitCode = 1 })
