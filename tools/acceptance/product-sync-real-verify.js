/**
 * 商品同步 · 四平台真机验收（商品管理方案 §14-M1 的 DoD，铺开后扩展到四家）
 *
 * 运行：node tools/acceptance/product-sync-real-verify.js [CDP端口]
 * 前置：关掉自己开着的 ShopPilot（单实例锁）；不要继承 ELECTRON_RUN_AS_NODE。
 *
 * 每个平台验四件事（全部打印实测数字，不做"通过/失败"的自证）：
 *   ① 同步能拿到商品；**本地条数与页面上读到的条数**一致（拼多多没有"共N条"，用页面行数核对并如实标注）；
 *   ② 再同步一次 inserted = 0（幂等）；
 *   ③ products.list 能从库里读回来（只读商品页的数据源）；
 *   ④ 抽一条打印解析结果（标题/价格/库存/状态），让人眼看得出字段对不对。
 */
const { spawn, execSync } = require('child_process')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.join(__dirname, '..', '..')
const PORT = Number(process.argv[2] || 9274)
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const DB_PATH = path.join(process.env.APPDATA || '', 'shopilot', 'shopilot.db')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(...a)

/** 每个平台：webview 主机 + 列表页路径（用来在同步后找回那个页面读条数）。 */
const ALL_PLATFORMS = [
  { platform: '微信小店', host: 'store.weixin.qq.com', listPath: '/shop/goods/' },
  { platform: '抖店', host: 'fxg.jinritemai.com', listPath: '/ffa/g/list' },
  { platform: '拼多多', host: 'mms.pinduoduo.com', listPath: '/goods/goods_list' },
  { platform: '快手小店', host: 's.kwaixiaodian.com', listPath: '/zone/goods/' }
]
/** 只跑部分平台（排障用）：SHOPILOT_VERIFY_PLATFORMS=微信小店 */
const ONLY = (process.env.SHOPILOT_VERIFY_PLATFORMS || '').split(',').map(s => s.trim()).filter(Boolean)
const PLATFORMS = ONLY.length ? ALL_PLATFORMS.filter(p => ONLY.includes(p.platform)) : ALL_PLATFORMS

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
  async eval(expr, timeoutMs = 240000) {
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
      if (await cdp.eval('!!(window.shopilot && window.shopilot.products)', 5000).catch(() => false)) return cdp
    }
    if (Date.now() >= deadline) throw new Error('等不到主窗口渲染层（window.shopilot.products 不存在？）')
    await sleep(600)
  }
}

function killTree(child) { if (!child || child.exitCode === null) { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* gone */ } } }

async function call(ui, expr) {
  const raw = await ui.eval(`Promise.resolve(${expr}).then(r => JSON.stringify(r))`)
  try { return JSON.parse(raw) } catch { return raw }
}

/** 在店铺页里读"共 N 条"（穿透 shadowRoot，逐元素看自有文本）。 */
const READ_TOTAL = `(() => {
  const roots = [document]; for (const el of document.querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
  const q = (sel) => { const out = []; for (const r of roots) { try { for (const el of r.querySelectorAll(sel)) out.push(el) } catch {} } return out };
  for (const el of q('div,span,li,p')) {
    if (el.children.length > 2) continue;
    let own = ''; for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
    const m = own.replace(/\\s+/g, '').match(/共([\\d,]+)[条件个]/);
    if (m) return m[1].replace(/,/g, '');
  }
  return null;
})()`

/** 在店铺页里数"当前显示的数据行数"（拼多多没有"共N条"，只能用它）。 */
const COUNT_ROWS = `(() => {
  const roots = [document]; for (const el of document.querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
  const q = (sel) => { const out = []; for (const r of roots) { try { for (const el of r.querySelectorAll(sel)) out.push(el) } catch {} } return out };
  let best = 0;
  for (const t of q('table')) {
    const rows = [...t.querySelectorAll('tbody tr')].filter(tr => String(tr.innerText || '').trim().length > 0);
    if (rows.length > best) best = rows.length;
  }
  return best;
})()`

async function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  const stores = db.prepare('SELECT id, name, platform FROM stores WHERE deleted_at IS NULL ORDER BY name').all()
  db.close()

  log('=== 商品同步 · 四平台真机验收 ===')
  const child = spawn(ELECTRON, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' } })

  try {
    const ui = await findRenderer()
    log('已连上主窗口\n')

    for (const spec of PLATFORMS) {
      const store = stores.find(s => s.platform === spec.platform)
      if (!store) { log(`──────── ${spec.platform}：库里没有该平台店铺，跳过 ────────\n`); continue }
      log(`──────── ${spec.platform}（${store.name}）────────`)

      await call(ui, `window.shopilot.browser.open(${JSON.stringify(store.id)})`)
      await sleep(6000)

      const first = await call(ui, `window.shopilot.products.sync({ storeId: ${JSON.stringify(store.id)}, trigger: 'manual' })`)
      const d = first?.data || {}
      log(`  ① 同步原始结果：${JSON.stringify(first).slice(0, 600)}`)
      log(`  ① 同步：状态=${d.status} 原因码=${d.reasonCode} 拉到=${d.fetchedCount} 新增=${d.insertedCount} 更新=${d.updatedCount} 跳过=${d.skippedCount} 页数=${d.pageCount} 截断=${d.hasMore}`)
      log(`     主进程原话：${d.safeMessage}`)

      // 找到同步后停着的那个列表页，读页面条数核对
      const target = (await targets()).find(t => t.type === 'webview' && String(t.url || '').includes(spec.host) && String(t.url || '').includes(spec.listPath))
      if (target?.webSocketDebuggerUrl) {
        const page = new CDP(target.webSocketDebuggerUrl); await page.ready
        const total = await page.eval(READ_TOTAL, 20000).catch(() => null)
        const rowCount = await page.eval(COUNT_ROWS, 20000).catch(() => 0)
        const reference = total == null ? rowCount : Number(total)
        const same = String(reference) === String(d.fetchedCount)
        log(`  ② 页面核对：共N条=${total == null ? '（该平台没有此文案）' : total} 页面行数=${rowCount} → 参照值=${reference} vs 本地=${d.fetchedCount} → ${same ? '一致' : '不一致'}`)
        log(`     页面地址：${String(target.url).slice(0, 90)}`)
      } else {
        log(`  ② 页面核对：没找到该平台的列表页目标（URL 含 ${spec.host}${spec.listPath}），跳过核对`)
      }

      const second = await call(ui, `window.shopilot.products.sync({ storeId: ${JSON.stringify(store.id)}, trigger: 'manual' })`)
      const s2 = second?.data || {}
      log(`  ③ 幂等：再同步一次 → 新增=${s2.insertedCount} 更新=${s2.updatedCount} 跳过=${s2.skippedCount} 状态=${s2.status}`)

      const listed = await call(ui, `window.shopilot.products.list({ storeId: ${JSON.stringify(store.id)}, limit: 3 })`)
      const rows = listed?.data?.rows || []
      log(`  ④ 库里的数据（总数=${listed?.data?.total}）：`)
      for (const row of rows) {
        log(`     · ${String(row.platformTitle).slice(0, 30)} | 价=${row.platformPriceMinor} 库存=${row.platformStock} 状态=${row.platformStatus} 归属=${row.productTitle || '未归并'}`)
      }
      log('')
    }

    log('=== 验收数据如上：看每行的"参照值 vs 本地"是否一致、幂等是否为 0 新增 ===')
  } finally {
    killTree(child)
    await sleep(1200)
  }
}

main().catch(e => { console.error('\n验收失败:', (e && e.message) || e); process.exitCode = 1 })
