/**
 * 商品**详情页**勘察（只读，绝不提交；结束前还原标签页）
 *
 * 为什么需要：列表页的缩略图实测是 SVG（本地化会如实拒绝），真正的商品图与 SKU 都在详情页。
 * 本轮回答三件事：
 *   ① 详情页 URL 形态（能不能从列表直接拼出来，还是必须点「编辑」）
 *   ② 详情页里的商品图地址（**是不是 JPEG/PNG**，以及有几张）
 *   ③ SKU 结构（规格名/规格值/价格/库存能不能读出来）
 *
 * 用法：node tools/acceptance/product-detail-probe.js [平台] [CDP端口]
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.join(__dirname, '..', '..')
const PLATFORM = process.argv[2] || '微信小店'
const PORT = Number(process.argv[3] || 9279)
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const DB_PATH = path.join(process.env.APPDATA || '', 'shopilot', 'shopilot.db')
const OUT_DIR = path.join(ROOT, 'artifacts', 'product-probe')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(...a)

/** 每个平台的列表页与「编辑」入口文案（编辑=打开详情页，不是提交）。 */
const TARGETS = {
  微信小店: { listUrl: 'https://store.weixin.qq.com/shop/goods/list', editTexts: ['编辑'] },
  抖店: { listUrl: 'https://fxg.jinritemai.com/ffa/g/list', editTexts: ['编辑'] },
  拼多多: { listUrl: 'https://mms.pinduoduo.com/goods/goods_list', editTexts: ['编辑'] },
  快手小店: { listUrl: 'https://s.kwaixiaodian.com/zone/goods/v1/list', editTexts: ['编辑', '免审编辑'] }
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
  async eval(expr, timeoutMs = 90000) {
    const run = this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
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

/** 点「编辑」（白名单：这是**打开详情页**，不是提交）。 */
function clickEdit(texts) {
  return `(() => { ${HELPERS}
    const want = ${JSON.stringify(texts)};
    for (const el of __q('a,button,span,div,li')) {
      if (el.children.length > 2) continue;
      const own = __own(el);
      if (!want.includes(own)) continue;
      if (!__vis(el)) continue;
      el.click();
      return JSON.stringify({ clicked: own, tag: el.tagName });
    }
    return JSON.stringify({ clicked: null });
  })()`
}

/** 详情页 dump：URL / 商品图（含字节头猜类型）/ SKU 结构线索。 */
const DUMP_DETAIL = `
  ${HELPERS}
  const imgs = [];
  for (const el of __q('img')) {
    if (!__vis(el)) continue;
    const r = el.getBoundingClientRect();
    const src = el.getAttribute('src') || el.getAttribute('data-src') || '';
    if (!src) continue;
    imgs.push({ w: Math.round(r.width), h: Math.round(r.height), src: src.startsWith('//') ? 'https:' + src : __cut(src, 160) });
    if (imgs.length >= 25) break;
  }
  // SKU 线索：规格名/规格值/价格/库存这些字样附近的结构
  const specHints = [];
  let examined = 0;
  for (const el of __q('div,span,label,th,td')) {
    if (++examined > 6000) break;
    if (el.children.length > 2) continue;
    const own = __own(el);
    if (!own || own.length > 24) continue;
    if (!/规格|SKU|sku|销售价|价格|库存|颜色|尺码|重量|条形码/.test(own)) continue;
    specHints.push({ text: __cut(own, 24), tag: el.tagName, cls: __cut(String(el.className || ''), 40) });
    if (specHints.length >= 25) break;
  }
  const inputs = [];
  for (const el of __q('input,textarea,select')) {
    if (!__vis(el)) continue;
    const type = String(el.getAttribute('type') || el.tagName.toLowerCase());
    if (type === 'hidden') continue;
    inputs.push({ tag: el.tagName, type, value: __cut(el.value, 30), ph: __cut(el.getAttribute('placeholder'), 30) });
    if (inputs.length >= 25) break;
  }
  const tables = [];
  for (const t of __q('table')) {
    if (!__vis(t)) continue;
    const ths = [...t.querySelectorAll('th')].map(x => __cut(x.innerText, 20));
    const rows = [...t.querySelectorAll('tbody tr')].filter(tr => __clean(tr.innerText).length > 0);
    tables.push({ ths, rowCount: rows.length, first: rows[0] ? [...rows[0].children].map(c => __cut(c.innerText, 24)) : [] });
    if (tables.length >= 4) break;
  }
  const bt = String(document.body ? document.body.innerText : '');
  return JSON.stringify({ url: location.href, title: document.title, bodyLen: bt.length, imgs, specHints, inputs, tables,
                          head: __cut(bt, 400) });
`

function killTree(child) { if (!child || child.exitCode !== null) return; try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* gone */ } }

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const target = TARGETS[PLATFORM]
  if (!target) throw new Error('未知平台：' + PLATFORM)
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  const store = db.prepare('SELECT id, name FROM stores WHERE platform = ? AND deleted_at IS NULL ORDER BY name LIMIT 1').get(PLATFORM)
  db.close()
  if (!store) throw new Error('库里没有该平台店铺')

  const child = spawn(ELECTRON, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' } })
  let restore = null
  try {
    const ui = await findRenderer()
    log(`=== 详情页勘察：${PLATFORM}（${store.name}）===`)
    const before = new Set((await targets()).map(t => t.id))
    await ui.eval(`window.shopilot.browser.open(${JSON.stringify(store.id)})`)
    await sleep(7000)
    const tabs = JSON.parse(await ui.eval(`window.shopilot.browser.tab.list(${JSON.stringify(store.id)}).then(r => JSON.stringify((r.data && r.data.tabs) || []))`))
    const tabId = tabs[0]?.id
    restore = { storeId: store.id, tabId, url: tabs[0]?.url }

    let t = null
    for (let i = 0; i < 30 && !t; i++) { t = (await targets()).find(x => x.type === 'webview' && !before.has(x.id) && /^https?:/.test(x.url || '')) || null; if (!t) await sleep(500) }
    if (!t) throw new Error('没等到店铺页 webview')
    const page = new CDP(t.webSocketDebuggerUrl); await page.ready

    log('① 导航到商品列表页')
    await ui.eval(`window.shopilot.browser.navigate(${JSON.stringify(store.id)}, ${JSON.stringify(tabId)}, ${JSON.stringify(target.listUrl)})`)
    await sleep(11000)
    log('   列表页 URL:', await page.eval('location.href'))

    log('② 点「编辑」打开详情页（打开页面，不是提交）')
    log('   点击结果:', await page.eval(clickEdit(target.editTexts)))
    await sleep(9000)

    // 点击后原 webview 的 CDP 会话会失效（实测：location.href 都取不到），必须**重新按 URL 取目标**。
    // 不能只找"新 target"：实测没有新标签页，是同一个 webview 换了 target。
    let detailPage = null
    for (let i = 0; i < 30 && !detailPage; i++) {
      const host = new URL(target.listUrl).hostname
      const cand = (await targets()).filter(x => x.type === 'webview' && String(x.url || '').includes(host))
      if (cand.length) {
        const pick = cand[cand.length - 1]
        const probe = new CDP(pick.webSocketDebuggerUrl)
        try {
          await probe.ready
          const url = await probe.eval('location.href', 8000)
          if (typeof url === 'string' && url) { detailPage = probe; log('   重新连上 target:', String(url).slice(0, 90)) }
        } catch { /* 再等 */ }
      }
      if (!detailPage) await sleep(800)
    }
    if (!detailPage) { detailPage = page; log('   ⚠ 没能重新连上详情页 target，继续用原页面（可能超时）') }
    await sleep(4000)

    let detail = await detailPage.json(DUMP_DETAIL)
    for (let i = 0; i < 2 && (detail.imgs || []).length === 0; i++) { await sleep(6000); detail = await detailPage.json(DUMP_DETAIL) }
    log('   URL:', detail.url)
    log('   标题:', detail.title, '| 正文', detail.bodyLen, '字')
    log('   图片（按尺寸降序）:')
    for (const img of (detail.imgs || []).sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 10)) {
      log(`     ${String(img.w).padStart(4)}x${String(img.h).padEnd(4)} ${img.src}`)
    }
    log('   规格/SKU 线索:', JSON.stringify((detail.specHints || []).slice(0, 14)))
    log('   表格:', JSON.stringify((detail.tables || []).slice(0, 3)))
    log('   输入框:', JSON.stringify((detail.inputs || []).slice(0, 12)))
    log('   正文前 300 字:', String(detail.head).slice(0, 300))

    fs.writeFileSync(path.join(OUT_DIR, `detail-${PLATFORM}.json`), JSON.stringify(detail, null, 2), 'utf8')
    log(`\n证据已存 ${OUT_DIR}/detail-${PLATFORM}.json`)
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
