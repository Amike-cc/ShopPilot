/**
 * 商品管理 · 铺开勘察：把每个平台的**列对齐与完整行内容**测准（只读，绝不提交；结束前还原标签页）
 *
 * 为什么还要一轮：第一轮 product-real-probe.js 的行内容被截断到 22 字，
 * 而登记档案必须知道"表头 N 列 ↔ 数据行 M 格"到底怎么对齐（微信实测 6 列 vs 7 格，就是靠这一条定下来的）。
 * 这一轮把表头与前三行的**每一格原文**（各 120 字）完整打出来。
 *
 * 覆盖：
 *   抖店        → /ffa/g/list（已知有 2 行 0 高度占位行）
 *   拼多多      → /goods/goods_list（已知两张表：第一张只有表头、第二张没 <th>，行只有 5 格 —— 要看清楚）
 *   快手小店    → 商家后台 s.kwaixiaodian.com 的「商品列表」（入口是 SPA 按钮，本轮点击进去）
 *
 * 用法：node tools/acceptance/product-probe-columns.js [平台,平台] [CDP端口]
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.join(__dirname, '..', '..')
const PORT = Number(process.argv[3] || 9276)
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const DB_PATH = path.join(process.env.APPDATA || '', 'shopilot', 'shopilot.db')
const OUT_DIR = path.join(ROOT, 'artifacts', 'product-probe')
const PLATFORMS = (process.argv[2] || '抖店,拼多多,快手小店').split(',').map(s => s.trim()).filter(Boolean)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(...a)

const TARGETS = {
  抖店: { platform: '抖店', url: 'https://fxg.jinritemai.com/ffa/g/list' },
  拼多多: { platform: '拼多多', url: 'https://mms.pinduoduo.com/goods/goods_list' },
  快手小店: { platform: '快手小店', url: 'https://s.kwaixiaodian.com/zone/home', click: '商品列表' }
}

function storeOf(platform) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  try { return db.prepare('SELECT id, name, platform, admin_url FROM stores WHERE platform = ? AND deleted_at IS NULL ORDER BY name LIMIT 1').get(platform) }
  finally { db.close() }
}

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
  async eval(expr, timeoutMs = 45000) {
    const run = this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
      .then(r => { if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 200)); return r.result?.value })
    return Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error('页面内执行超时')), timeoutMs))])
  }
  async json(body) { const v = await this.eval(`(() => { ${body} })()`); try { return JSON.parse(v) } catch { return v } }
}

async function targets() { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`).catch(() => null); return r && r.ok ? await r.json() : [] }

async function findRenderer(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const page = (await targets()).find(t => t.type === 'page' && /index\.html/.test(t.url || ''))
    if (page?.webSocketDebuggerUrl) {
      const cdp = new CDP(page.webSocketDebuggerUrl); await cdp.ready
      if (await cdp.eval('!!(window.shopilot && window.shopilot.browser)', 5000).catch(() => false)) return cdp
    }
    if (Date.now() >= deadline) throw new Error('等不到主窗口渲染层')
    await sleep(600)
  }
}

const HELPERS = `
  const __roots = () => { const rs = [document]; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot) } return rs };
  const __q = (sel) => { const out = []; for (const r of __roots()) { try { for (const el of r.querySelectorAll(sel)) out.push(el) } catch {} } return out };
  const __own = (el) => { let s = ''; for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent; return s.replace(/[\\u200b-\\u200f\\ufeff]/g, '').replace(/\\s+/g, ' ').trim() };
  const __clean = (s) => String(s == null ? '' : s).replace(/[\\u200b-\\u200f\\ufeff]/g, '').replace(/\\s+/g, ' ').trim();
  const __vis = (el) => { try { return el.getClientRects().length > 0 } catch { return false } };
  const __cut = (s, n) => { const t = __clean(s); return t.length > n ? t.slice(0, n) + '…' : t };
`

/** 完整 dump：每张可见表的表头（全量）+ 前 3 行的每一格原文（120 字）+ 格数 + 总数文案。 */
const DUMP_COLUMNS = `
  ${HELPERS}
  const tables = [];
  for (const t of __q('table')) {
    if (!__vis(t)) continue;
    const ths = [...t.querySelectorAll('th')].map(x => __cut(x.innerText, 40));
    const bodyRows = [...t.querySelectorAll('tbody tr')];
    const sample = [];
    for (const tr of bodyRows.slice(0, 3)) {
      const cells = [...tr.children].map(td => ({ txt: __cut(td.innerText, 120), els: td.querySelectorAll('*').length, img: td.querySelectorAll('img').length }));
      if (cells.every(c => !c.txt)) continue;      // 跳过 0 高度占位行
      sample.push({ cellCount: cells.length, cells });
      if (sample.length >= 2) break;
    }
    tables.push({ thCount: ths.length, ths, bodyRows: bodyRows.length, sample });
    if (tables.length >= 5) break;
  }
  // 总数：逐元素看自有文本（微信整页在 shadow 里，body.innerText 取不到）
  let total = null, totalEl = null;
  for (const el of __q('div,span,li,p')) {
    if (el.children.length > 2) continue;
    const own = __own(el);
    if (!own || own.length > 24) continue;
    const m = own.match(/共\\s*([\\d,]+)\\s*[条件个]/);
    if (m) { total = m[1].replace(/,/g, ''); totalEl = __cut(own, 24); break }
  }
  // 分页线索
  const pagers = [];
  for (const el of __q('button,a,div,span,li')) {
    if (el.children.length > 2) continue;
    const own = __own(el);
    if (!own || own.length > 10) continue;
    if (!/^(下一页|下页|上一页|上页|末页|首页)$/.test(own)) continue;
    if (!__vis(el)) continue;
    pagers.push(own);
    if (pagers.length >= 6) break;
  }
  return JSON.stringify({ url: location.href, title: document.title, tables, total, totalEl, pagers,
                          bodyLen: String(document.body ? document.body.innerText : '').length });
`

/** 按白名单文案点击（只打开页面，绝不点提交类）。 */
function clickExact(text) {
  const ALLOW = ['商品', '商品管理', '商品列表', '商品总览', '全部商品', '在售商品', '新增商品', '发布商品', '新建商品']
  const DENY = /^(提交|发布|保存|确认|确定|上架|删除|下架|批量)$/
  if (DENY.test(text) || !ALLOW.includes(text)) return `'REFUSED:${text}'`
  return `(() => { ${HELPERS}
    const want = ${JSON.stringify(text)};
    for (const el of __q('a,button,span,div,li')) {
      if (el.children.length > 3) continue;
      if (__own(el) !== want) continue;
      if (!__vis(el)) continue;
      el.click();
      return JSON.stringify({ clicked: true, tag: el.tagName });
    }
    return JSON.stringify({ clicked: false });
  })()`
}

async function openStore(ui, store) {
  const before = new Set((await targets()).map(t => t.id))
  await ui.eval(`window.shopilot.browser.open(${JSON.stringify(store.id)})`)
  await sleep(6000)
  const tabs = JSON.parse(await ui.eval(`window.shopilot.browser.tab.list(${JSON.stringify(store.id)}).then(r => JSON.stringify((r.data && r.data.tabs) || []))`))
  let t = null
  for (let i = 0; i < 30 && !t; i++) {
    t = (await targets()).find(x => x.type === 'webview' && !before.has(x.id) && /^https?:/.test(x.url || '')) || null
    if (!t) await sleep(500)
  }
  if (!t) throw new Error('没等到店铺页 webview')
  const page = new CDP(t.webSocketDebuggerUrl); await page.ready
  return { page, tabId: tabs[0]?.id, url: tabs[0]?.url }
}

function killTree(child) { if (!child || child.exitCode !== null) return; try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* gone */ } }

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const child = spawn(ELECTRON, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' } })
  const report = {}
  const restore = []
  try {
    const ui = await findRenderer()
    log('已连上主窗口\n')

    for (const platform of PLATFORMS) {
      const target = TARGETS[platform]
      const store = storeOf(platform)
      if (!target || !store) { log(`跳过 ${platform}（没有店铺或没有目标配置）`); continue }
      log(`──────── ${platform}（${store.name}）────────`)
      const a = await openStore(ui, store)
      restore.push({ storeId: store.id, tabId: a.tabId, url: a.url })

      await ui.eval(`window.shopilot.browser.navigate(${JSON.stringify(store.id)}, ${JSON.stringify(a.tabId)}, ${JSON.stringify(target.url)})`)
      await sleep(11000)

      if (target.click) {
        log(`  点「${target.click}」（白名单内，只打开页面）`)
        log('  点击结果:', await a.page.eval(clickExact(target.click)))
        await sleep(11000)
      }

      let dump = await a.page.json(DUMP_COLUMNS)
      // 表格还没渲染就再等一轮（实测平台都有这个特性）
      for (let i = 0; i < 3 && (!dump.tables || dump.tables.every(t => t.bodyRows === 0)); i++) {
        await sleep(6000)
        dump = await a.page.json(DUMP_COLUMNS)
      }
      report[platform] = dump
      log(`  URL: ${dump.url} | 标题: ${dump.title} | 正文 ${dump.bodyLen} 字`)
      log(`  总数文案: ${dump.totalEl || '（没读到）'}  → total=${dump.total}`)
      log(`  分页控件: ${JSON.stringify(dump.pagers)}`)
      for (const [index, t] of (dump.tables || []).entries()) {
        log(`  表 ${index + 1}: 表头 ${t.thCount} 列 / 数据行 ${t.bodyRows}`)
        log(`    表头: ${JSON.stringify(t.ths)}`)
        for (const row of t.sample || []) {
          log(`    行(${row.cellCount} 格):`)
          row.cells.forEach((cell, i) => log(`      [${i}] els=${cell.els} img=${cell.img} ${JSON.stringify(cell.txt)}`))
        }
      }
      fs.writeFileSync(path.join(OUT_DIR, `columns-${platform}.json`), JSON.stringify(dump, null, 2), 'utf8')
      log('')
    }

    fs.writeFileSync(path.join(OUT_DIR, 'columns-report.json'), JSON.stringify(report, null, 2), 'utf8')
    log(`勘察结束；证据已存 ${OUT_DIR}`)
  } finally {
    try {
      const ui = await findRenderer(8000)
      for (const r of restore) {
        log(`↩ 还原：${r.storeId.slice(0, 14)}… → ${String(r.url).slice(0, 70)}`)
        await ui.eval(`window.shopilot.browser.navigate(${JSON.stringify(r.storeId)}, ${JSON.stringify(r.tabId)}, ${JSON.stringify(r.url)})`)
        await sleep(1200)
      }
    } catch (e) { log('还原失败（不影响结论）:', String(e && e.message || e)) }
    killTree(child)
    await sleep(1000)
  }
}

main().catch(e => { console.error('\n勘察失败:', (e && e.message) || e); process.exitCode = 1 })
