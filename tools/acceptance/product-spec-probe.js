/**
 * 详情页**规格表格**定点勘察（只读，不填写不提交）
 *
 * 上一轮已知：详情页地址可直接拼（`/shop/goods/entry?productId=`），能读到 22 张商品图与 6 个规格名。
 * 本轮要回答：**规格值 + 逐 SKU 的价格/库存**在哪、长什么样、有没有平台的 SKU 标识。
 *
 * 用法：node tools/acceptance/product-spec-probe.js [平台] [CDP端口]
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.join(__dirname, '..', '..')
const PLATFORM = process.argv[2] || '微信小店'
const PORT = Number(process.argv[3] || 9281)
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const DB_PATH = path.join(process.env.APPDATA || '', 'shopilot', 'shopilot.db')
const OUT_DIR = path.join(ROOT, 'artifacts', 'product-probe')
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
  async eval(expr, timeoutMs = 90000) {
    const run = this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      .then(r => { if (r.exceptionDetails) throw new Error('页面内异常'); return r.result?.value })
    return Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), timeoutMs))])
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
    if (Date.now() >= deadline) throw new Error('等不到主窗口')
    await sleep(600)
  }
}

const HELPERS = `
  const __cap = 8000;
  const __roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= __cap) break } return rs };
  const __q = (sel) => { const out = []; for (const r of __roots()) { try { for (const el of r.querySelectorAll(sel)) { out.push(el); if (out.length >= 4000) return out } } catch {} } return out };
  const __own = (el) => { let s = ''; for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent; return s.replace(/\\s+/g, ' ').trim() };
  const __clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const __vis = (el) => { try { return el.getClientRects().length > 0 } catch { return false } };
  const __cut = (s, n) => { const t = __clean(s); return t.length > n ? t.slice(0, n) + '…' : t };
`

/** 规格区专项 dump。 */
const DUMP_SPEC = `
  ${HELPERS}
  // ① 所有可见表格（规格表格通常是 table）
  const tables = [];
  for (const t of __q('table')) {
    if (!__vis(t)) continue;
    const ths = [...t.querySelectorAll('th')].map(x => __cut(x.innerText, 24));
    const rows = [...t.querySelectorAll('tbody tr')].filter(tr => __clean(tr.innerText).length > 0);
    tables.push({ ths, rowCount: rows.length, rows: rows.slice(0, 4).map(tr => [...tr.children].map(c => __cut(c.innerText, 28))) });
    if (tables.length >= 6) break;
  }
  // ② class 里带 spec/sku 的元素（规格值通常是这些）
  const specEls = [];
  let n = 0;
  for (const el of __q('div,span,li,input,button')) {
    if (++n > 6000) break;
    const cls = String(el.className || '');
    if (!/spec|sku|sku-|规格/i.test(cls)) continue;
    if (!__vis(el)) continue;
    const own = __own(el) || __clean(el.value);
    if (!own) continue;
    specEls.push({ cls: __cut(cls, 46), tag: el.tagName, text: __cut(own, 30), kids: el.children.length });
    if (specEls.length >= 40) break;
  }
  // ③ **全部**可见输入框，按 DOM 顺序（用来还原"逐 SKU 一行"的结构）
  const priceInputs = [];
  let m = 0;
  for (const el of __q('input')) {
    if (++m > 4000) break;
    if (!__vis(el)) continue;
    const type = String(el.getAttribute('type') || 'text');
    if (type === 'hidden' || type === 'file' || type === 'checkbox') continue;
    priceInputs.push({ ph: __cut(__clean(el.getAttribute('placeholder')), 22), value: __cut(__clean(el.value), 20) });
    if (priceInputs.length >= 60) break;
  }
  // ③b 规格值胶囊（规格值通常是短文案的 span/div，且成组出现）
  const chips = [];
  let c = 0;
  for (const el of __q('span,div')) {
    if (++c > 8000) break;
    if (el.children.length > 0) continue;
    const own = __own(el);
    if (!own || own.length > 10) continue;
    if (!__vis(el)) continue;
    chips.push(__cut(own, 10));
    if (chips.length >= 60) break;
  }
  // ④ 所有可见输入框的占位符分布（看规格表格里到底有哪些字段）
  const placeholders = {};
  for (const el of __q('input,textarea')) {
    if (!__vis(el)) continue;
    const ph = __clean(el.getAttribute('placeholder'));
    if (!ph) continue;
    placeholders[ph] = (placeholders[ph] || 0) + 1;
  }
  // ⑤ 规格区附近的按钮/文案（如"批量设置"）
  const actions = [];
  let k = 0;
  for (const el of __q('button,span,div')) {
    if (++k > 6000) break;
    if (el.children.length > 2) continue;
    const own = __own(el);
    if (!own || own.length > 16) continue;
    if (!/批量|规格|添加规格|添加规格值|删除/.test(own)) continue;
    if (!__vis(el)) continue;
    actions.push({ text: __cut(own, 16), tag: el.tagName });
    if (actions.length >= 20) break;
  }
  return JSON.stringify({ url: location.href, tables, specEls, priceInputs, chips, placeholders, actions,
                          bodyLen: String(document.body ? document.body.innerText : '').length });
`

function killTree(child) { if (!child || child.exitCode !== null) return; try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* gone */ } }

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  const store = db.prepare('SELECT id, name FROM stores WHERE platform = ? AND deleted_at IS NULL ORDER BY name LIMIT 1').get(PLATFORM)
  const link = db.prepare('SELECT platform_product_id, platform_title FROM product_platform_links WHERE platform = ? ORDER BY platform_product_id LIMIT 1').get(PLATFORM)
  db.close()
  if (!store || !link) throw new Error('库里缺该平台店铺或商品')

  const TEMPLATES = { 微信小店: 'https://store.weixin.qq.com/shop/goods/entry?productId={id}' }
  const template = TEMPLATES[PLATFORM]
  if (!template) throw new Error('该平台还没实测详情页地址模板：' + PLATFORM)
  const url = template.replace('{id}', link.platform_product_id)

  const child = spawn(ELECTRON, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' } })
  let restore = null
  try {
    const ui = await findRenderer()
    log(`=== 规格表格勘察：${PLATFORM}（${store.name}）===`)
    log(`商品：${String(link.platform_title).slice(0, 30)}`)
    log(`详情页（直接拼，不点编辑）：${url}\n`)
    const before = new Set((await targets()).map(t => t.id))
    await ui.eval(`window.shopilot.browser.open(${JSON.stringify(store.id)})`)
    await sleep(7000)
    const tabs = JSON.parse(await ui.eval(`window.shopilot.browser.tab.list(${JSON.stringify(store.id)}).then(r => JSON.stringify((r.data && r.data.tabs) || []))`))
    const tabId = tabs[0]?.id
    restore = { storeId: store.id, tabId, url: tabs[0]?.url }

    await ui.eval(`window.shopilot.browser.navigate(${JSON.stringify(store.id)}, ${JSON.stringify(tabId)}, ${JSON.stringify(url)})`)
    await sleep(12000)

    // 规格表格是懒渲染的 → 轮询到出现表格或规格元素为止
    const spec = await (async () => {
      let t = null
      for (let i = 0; i < 30 && !t; i++) {
        t = (await targets()).find(x => x.type === 'webview' && !before.has(x.id) && /^https?:/.test(x.url || '')) || null
        if (!t) await sleep(500)
      }
      if (!t) throw new Error('没等到店铺页 webview')
      const page = new CDP(t.webSocketDebuggerUrl); await page.ready
      let dump = await page.json(DUMP_SPEC)
      for (let i = 0; i < 5 && (dump.tables || []).length === 0 && (dump.specEls || []).length === 0; i++) {
        await sleep(5000)
        dump = await page.json(DUMP_SPEC)
      }
      return dump
    })()

    log('URL:', spec.url, '| 正文', spec.bodyLen, '字')
    log(`\n① 表格（${(spec.tables || []).length} 张）:`)
    for (const [i, t] of (spec.tables || []).entries()) {
      log(`  表${i + 1}: 表头 ${JSON.stringify(t.ths)} / ${t.rowCount} 行`)
      for (const row of t.rows) log(`     ${JSON.stringify(row)}`)
    }
    log(`\n② 规格相关元素（${(spec.specEls || []).length} 个，前 18）:`)
    for (const el of (spec.specEls || []).slice(0, 18)) log(`  <${el.tag}> kids=${el.kids} cls="${el.cls}" text="${el.text}"`)
    log(`\n③ 价格/库存输入框（${(spec.priceInputs || []).length} 个，前 16）:`)
    for (const el of (spec.priceInputs || []).slice(0, 16)) log(`  ph="${el.ph}" value="${el.value}" cls="${el.cls}"`)
    log(`\n④ 可见输入框占位符分布:`)
    for (const [ph, count] of Object.entries(spec.placeholders || {}).sort((a, b) => b[1] - a[1]).slice(0, 18)) log(`  ${count}× "${ph}"`)
    log(`\n⑤ 规格区动作文案: ${JSON.stringify((spec.actions || []).slice(0, 14))}`)

    fs.writeFileSync(path.join(OUT_DIR, `spec-${PLATFORM}.json`), JSON.stringify(spec, null, 2), 'utf8')
    log(`\n证据已存 ${OUT_DIR}/spec-${PLATFORM}.json`)
  } finally {
    try {
      const ui = await findRenderer(8000)
      if (restore) {
        log(`↩ 还原：→ ${String(restore.url).slice(0, 70)}`)
        await ui.eval(`window.shopilot.browser.navigate(${JSON.stringify(restore.storeId)}, ${JSON.stringify(restore.tabId)}, ${JSON.stringify(restore.url)})`)
        await sleep(1200)
      }
    } catch (e) { log('还原失败（不影响结论）:', String(e && e.message || e)) }
    killTree(child)
    await sleep(1000)
  }
}

main().catch(e => { console.error('\n勘察失败:', (e && e.message) || e); process.exitCode = 1 })
