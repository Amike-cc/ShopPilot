/**
 * 图片本地化队列与保留策略的真机验收
 *
 * 验四件事：
 *   ① 队列扫描：按**主图优先**排序，并如实说明哪些"不该再试"；
 *   ② 保留策略的**宽限期真的生效**：刚写盘的文件不会被判成孤儿；
 *   ③ 真孤儿会被判出来并**删掉**（用一个把 mtime 改到 2 天前的假文件验）；
 *   ④ 清理只碰 `product-media` 目录里的东西。
 *
 * 用完即还原：软删测试商品 + 删掉假文件。
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.join(__dirname, '..', '..')
const PORT = Number(process.argv[2] || 9287)
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const DB_PATH = path.join(process.env.APPDATA || '', 'shopilot', 'shopilot.db')
const MEDIA_ROOT = path.join(process.env.APPDATA || '', 'shopilot', 'product-media')
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
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('页面内异常')
    return r.result?.value
  }
}

async function targets() { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`).catch(() => null); return r && r.ok ? await r.json() : [] }

function countFiles() {
  if (!fs.existsSync(MEDIA_ROOT)) return 0
  let n = 0
  for (const dir of fs.readdirSync(MEDIA_ROOT)) {
    const p = path.join(MEDIA_ROOT, dir)
    if (fs.statSync(p).isDirectory()) n += fs.readdirSync(p).length
  }
  return n
}

async function main() {
  log('=== 图片本地化队列 + 保留策略验收 ===')
  const child = spawn(ELECTRON, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' } })
  let productId = null
  let fakeFile = null
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

    log('\n① 建一个本地商品（带 22 张待本地化的图）')
    const created = JSON.parse(await ui.eval('window.shopilot.products.library.saveAsLocal(' + JSON.stringify({ platform: '微信小店', storeId: link.store_id, platformProductId: link.platform_product_id }) + ').then(r => JSON.stringify(r))'))
    productId = created?.data?.productId || null
    if (!productId) throw new Error('另存为失败')
    log('   本地商品 ' + productId.slice(0, 8) + '…')

    log('\n② 队列扫描（应按主图优先排序）')
    const scan = JSON.parse(await ui.eval('window.shopilot.products.library.queueScan({ maxItems: 50 }).then(r => JSON.stringify(r))'))
    const d = scan?.data || {}
    log('   候选总数=' + d.candidates + ' 队列=' + (d.items?.length || 0) + ' 跳过=' + d.skipped)
    log('   原话：' + d.summary)
    log('   前 4 项（角色/是否下载）：' + JSON.stringify((d.items || []).slice(0, 4).map(i => ({ role: i.role, attempt: i.shouldAttempt }))))
    const firstCover = (d.items || []).findIndex(i => i.role === 'cover')
    log('   主图在队列位置=' + firstCover + '（应是 0：主图优先）')

    log('\n②b **真跑一次队列**（小批 6 张：避免在渲染进程上挂长时 eval —— 上次跑 22 张时崩过一次）')
    const filesBeforeRun = countFiles()
    const run = JSON.parse(await ui.eval('window.shopilot.products.library.queueRun({ maxItems: 6 }).then(r => JSON.stringify(r))'))
    log('   结果：' + JSON.stringify(run?.data))
    const filesAfterRun = countFiles()
    log('   磁盘文件数：' + filesBeforeRun + ' → ' + filesAfterRun + '（应增加：真的下载落盘了）')
    const db2 = new DatabaseSync(DB_PATH, { readOnly: true })
    const states = db2.prepare('SELECT state, COUNT(*) AS c FROM product_media GROUP BY state').all()
    const attempts = db2.prepare('SELECT attempts, COUNT(*) AS c FROM product_media GROUP BY attempts').all()
    db2.close()
    log('   媒体状态分布：' + JSON.stringify(states))
    log('   重试计数分布：' + JSON.stringify(attempts))

    log('\n③ 保留策略：宽限期生效（刚写盘的不会被判成孤儿）')
    const orphansBefore = JSON.parse(await ui.eval('window.shopilot.products.library.orphans().then(r => JSON.stringify(r))'))
    log('   现在判出的孤儿数=' + (orphansBefore?.data?.orphans?.length ?? '?') + ' 保留=' + orphansBefore?.data?.keepCount)
    log('   原话：' + orphansBefore?.data?.summary)

    log('\n④ 造一个"2 天前"的假文件，验证真孤儿会被判出来并删掉')
    const filesBefore = countFiles()
    const sub = path.join(MEDIA_ROOT, 'zz')
    fs.mkdirSync(sub, { recursive: true })
    fakeFile = path.join(sub, 'zz-fake-orphan.webp')
    fs.writeFileSync(fakeFile, Buffer.alloc(4096, 1))
    const old = Date.now() / 1000 - 2 * 24 * 3600
    fs.utimesSync(fakeFile, old, old)
    log('   已造：' + fakeFile + '（mtime 改到 2 天前）')

    const orphansAfter = JSON.parse(await ui.eval('window.shopilot.products.library.orphans().then(r => JSON.stringify(r))'))
    log('   判出的孤儿数=' + orphansAfter?.data?.orphans?.length + ' 原话：' + orphansAfter?.data?.summary)
    log('   判据：' + JSON.stringify((orphansAfter?.data?.orphans || [])[0]?.reason || null))

    const cleaned = JSON.parse(await ui.eval('window.shopilot.products.library.cleanupOrphans().then(r => JSON.stringify(r))'))
    log('   清理结果：' + JSON.stringify(cleaned?.data))
    log('   假文件还在吗？' + (fs.existsSync(fakeFile) ? '❌ 还在（清理没生效）' : '✅ 已删'))
    log('   磁盘文件数：' + filesBefore + ' → ' + countFiles())

    log('\n=== 验收要点：主图排第一；宽限期内不判孤儿；真孤儿被判出并删除；文件数相应减少 ===')
  } finally {
    try {
      const page = (await targets()).find(t => t.type === 'page' && /index\.html/.test(t.url || ''))
      if (page && productId) {
        const ui = new CDP(page.webSocketDebuggerUrl); await ui.ready
        await ui.eval('window.shopilot.products.library.remove(' + JSON.stringify(productId) + ').then(() => 1)')
        log('\n↩ 已软删测试商品')
      }
    } catch { /* ignore */ }
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* gone */ }
    await sleep(1000)
    // 收尾：删掉假文件所在目录（如果清理没删掉它）
    try {
      const sub = path.join(MEDIA_ROOT, 'zz')
      if (fs.existsSync(sub)) { fs.rmSync(sub, { recursive: true, force: true }); log('↩ 已清掉临时目录 zz/') }
    } catch { /* ignore */ }
  }
}

main().catch(e => { console.error('\n验收失败:', (e && e.message) || e); process.exitCode = 1 })
