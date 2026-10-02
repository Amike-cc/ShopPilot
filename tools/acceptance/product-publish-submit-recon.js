/**
 * 发布侦察（**已获用户授权**）：看清"提交路径还差什么"，**本步不点提交**。
 *
 * 目的：回答三个问题，为真正提交做准备
 *   ① 提交按钮在哪、是不是 disabled（disabled 时页面通常会提示还缺什么）
 *   ② 表单当前哪些必填项是空的（这直接喂给 §7.5 的"平台必填清单"）
 *   ③ 规格/价格/库存/类目/图片各自的入口形态（决定下一轮能不能程序化填完）
 *
 * 只读：只打开页面、只读 DOM、只点**非提交类**的入口（如「创建新规格」这种展开按钮不做，先只观察）。
 * 用完即还原：软删测试商品。
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.join(__dirname, '..', '..')
const PORT = Number(process.argv[2] || 9291)
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
  async eval(expr, timeoutMs = 120000) {
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
    if (Date.now() >= deadline) throw new Error('等不到主窗口')
    await sleep(600)
  }
}

function killTree(child) { if (!child || child.exitCode === null) { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* gone */ } } }

/** 只读侦察：提交按钮 + 必填线索 + 各字段入口形态。 */
const RECON = `(() => {
  const cap = 8000;
  const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
  const q = (sel) => { const out = []; for (const r of roots()) { try { for (const el of r.querySelectorAll(sel)) { out.push(el); if (out.length >= 3000) return out } } catch {} } return out };
  const own = (el) => { let s = ''; for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent; return s.replace(/\\s+/g, ' ').trim() };
  const vis = (el) => { try { return el.getClientRects().length > 0 } catch { return false } };
  const clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();

  // ① 所有按钮/链接里带"提交/发布/保存/上架"的（含 disabled 状态）
  const submitish = [];
  for (const el of q('button,a,div,span')) {
    if (el.children.length > 1) continue;
    const t = own(el);
    if (!t || t.length > 12) continue;
    if (!/提交|发布|保存|上架|确认|完成/.test(t)) continue;
    if (!vis(el)) continue;
    submitish.push({ tag: el.tagName, text: t, disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true', cls: clean(el.className).slice(0, 40) });
    if (submitish.length >= 20) break;
  }

  // ② 页面上"必填"的线索：带 * 的 label / aria-required / 提示语
  const required = [];
  for (const el of q('label,span,div')) {
    if (el.children.length > 2) continue;
    const t = own(el);
    if (!t || t.length > 20) continue;
    if (!/\\*/.test(t) && el.getAttribute('aria-required') !== 'true') continue;
    if (!vis(el)) continue;
    required.push(clean(t).slice(0, 20));
    if (required.length >= 25) break;
  }

  // ③ 各字段入口形态
  const inputs = q('input,textarea').filter(vis);
  const placeholders = {};
  for (const el of inputs) { const ph = clean(el.getAttribute('placeholder')); if (ph) placeholders[ph] = (placeholders[ph] || 0) + 1 }
  const fileInputs = q('input[type=file]').length;
  const selects = q('select').length;
  const specEntries = [];
  for (const el of q('div,span,button')) {
    if (el.children.length > 1) continue;
    const t = own(el);
    if (!t || t.length > 14) continue;
    if (!/创建新规格|添加规格|新增规格|批量设置|选择类目|选择商品类目|上传/.test(t)) continue;
    if (!vis(el)) continue;
    specEntries.push({ tag: el.tagName, text: t });
    if (specEntries.length >= 12) break;
  }

  // ④ 页面上可见的校验提示（红字/错误文案）
  const errors = [];
  for (const el of q('div,span,p')) {
    if (el.children.length > 1) continue;
    const t = own(el);
    if (!t || t.length > 40) continue;
    if (!/必填|不能为空|请选择|请填写|请输入/.test(t)) continue;
    if (!vis(el)) continue;
    errors.push(clean(t).slice(0, 40));
    if (errors.length >= 15) break;
  }

  return JSON.stringify({ url: location.href, submitish, required: [...new Set(required)], placeholders, fileInputs, selects, specEntries, errors: [...new Set(errors)] });
})()`

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  log('=== 发布侦察（已授权；本步不点提交）===')
  const child = spawn(ELECTRON, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' } })
  let productId = null
  try {
    const ui = await findRenderer()
    log('已连上主窗口\n')
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const store = db.prepare(`SELECT id, name FROM stores WHERE platform = '微信小店' AND deleted_at IS NULL LIMIT 1`).get()
    const link = db.prepare(`SELECT platform_product_id, store_id FROM product_platform_links WHERE platform = '微信小店' AND product_id IS NULL ORDER BY platform_product_id LIMIT 1`).get()
    db.close()
    if (!store || !link) throw new Error('库里缺微信小店店铺或未归并商品')

    await ui.eval('window.shopilot.browser.open(' + JSON.stringify(store.id) + ')')
    await sleep(7000)

    const stamp = new Date().toISOString().slice(5, 16).replace(/[:T]/g, '')
    const testTitle = '【自动化验收请勿购买】测试商品 ' + stamp
    log('① 建测试商品（标题一眼可辨，便于事后清理）')
    log('   标题：' + testTitle)
    const created = JSON.parse(await ui.eval('window.shopilot.products.library.saveAsLocal(' + JSON.stringify({ platform: '微信小店', storeId: store.id, platformProductId: link.platform_product_id }) + ').then(r => JSON.stringify(r))'))
    productId = created?.data?.productId || null
    if (!productId) throw new Error('另存为失败：' + JSON.stringify(created).slice(0, 200))
    const got = JSON.parse(await ui.eval('window.shopilot.products.library.get(' + JSON.stringify(productId) + ').then(r => JSON.stringify(r))'))
    const saved = JSON.parse(await ui.eval('window.shopilot.products.library.save(' + JSON.stringify({ productId, draft: { ...got.data.draft, title: testTitle } }) + ').then(r => JSON.stringify(r))'))
    log('   已改标题：ok=' + saved.ok + ' issues=' + JSON.stringify((saved.data?.issues || []).map(i => i.level + ':' + i.field)))

    log('\n② 发布预检')
    const pre = JSON.parse(await ui.eval('window.shopilot.products.publish.preflight(' + JSON.stringify({ productId, storeIds: [store.id] }) + ').then(r => JSON.stringify(r))'))
    log('   判定=' + pre.data?.precheck?.verdict + ' 档位=' + pre.data?.precheck?.tier)
    log('   阻断=' + JSON.stringify((pre.data?.precheck?.blockers || []).map(b => b.message)))

    log('\n③ 打开发布页 + L1 预填（不点提交）')
    const opened = JSON.parse(await ui.eval('window.shopilot.products.publish.open(' + JSON.stringify({ itemId: pre.data.itemId, fill: true }) + ').then(r => JSON.stringify(r))'))
    log('   ' + String(opened.data?.safeMessage || '').slice(0, 160))
    for (const row of (opened.data?.fill || [])) log(`     ${row.label}：ok=${row.ok} 回读=${String(row.readBack ?? '—').slice(0, 24)}${row.reason ? ' ← ' + String(row.reason).slice(0, 60) : ''}`)

    log('\n④ 只读侦察提交路径')
    await sleep(8000)
    let page = null
    for (const t of await targets()) if (t.type === 'webview' && /goods\/entry/.test(t.url || '')) page = t
    if (!page) throw new Error('没找到发布页 webview')
    const probe = new CDP(page.webSocketDebuggerUrl); await probe.ready
    let recon = null
    for (let i = 0; i < 6 && !recon; i++) {
      recon = await probe.eval(RECON).catch(() => null)
      if (!recon) await sleep(4000)
    }
    const r = JSON.parse(recon)
    log('   URL：' + r.url)
    log('   提交类按钮：')
    for (const b of r.submitish) log(`     <${b.tag}> "${b.text}" disabled=${b.disabled} cls=${b.cls}`)
    log('   必填线索：' + JSON.stringify(r.required))
    log('   各字段入口：' + JSON.stringify(r.specEntries))
    log('   文件上传入口数=' + r.fileInputs + ' select 数=' + r.selects)
    log('   输入框占位符分布：' + JSON.stringify(r.placeholders))
    log('   页面上的校验提示：' + JSON.stringify(r.errors))
    fs.writeFileSync(path.join(OUT_DIR, 'publish-submit-recon.json'), JSON.stringify({ testTitle, recon: r }, null, 2), 'utf8')
    log('\n   证据已存 artifacts/product-probe/publish-submit-recon.json')

    log('\n=== 看"提交类按钮 disabled 状态"与"必填线索"：它们决定下一轮能不能真的提交 ===')
  } finally {
    try {
      const ui = await findRenderer(10000)
      if (productId) { await ui.eval('window.shopilot.products.library.remove(' + JSON.stringify(productId) + ').then(() => 1)'); log('\n↩ 已软删测试商品（**平台上没有创建任何东西**：本步没点提交）') }
    } catch (e) { log('\n清理失败：' + String(e && e.message || e)) }
    killTree(child)
    await sleep(1200)
  }
}

main().catch(e => { console.error('\n侦察失败:', (e && e.message) || e); process.exitCode = 1 })
