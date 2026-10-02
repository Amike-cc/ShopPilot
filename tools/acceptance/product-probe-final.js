/**
 * 商品管理 · 勘察收尾：两个还没结论的点（只读，绝不提交；结束前还原标签页）
 *   ① 拼多多价格是否**字体反爬** —— 截图 + 同屏文本一起取，交给人眼比对（这是唯一能定论的证据）
 *   ② 快手的商品「管理/发布」在哪 —— syt 的"商品列表"实测是数据列表，去商家后台 s.kwaixiaodian.com 找
 *
 * 用法：node tools/acceptance/product-probe-final.js [CDP端口]
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.join(__dirname, '..', '..')
const PORT = Number(process.argv[2] || '9273')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const DB_PATH = path.join(process.env.APPDATA || '', 'shopilot', 'shopilot.db')
const OUT_DIR = path.join(ROOT, 'artifacts', 'product-probe')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(...a)

function storeOf(platform) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  try { return db.prepare('SELECT id, name, platform FROM stores WHERE platform = ? AND deleted_at IS NULL ORDER BY name LIMIT 1').get(platform) }
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
  async eval(expr, timeoutMs = 40000) {
    const run = this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      .then(r => { if (r.exceptionDetails) throw new Error('页面内异常'); return r.result?.value })
    return Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error('执行超时')), timeoutMs))])
  }
  async json(body) { const v = await this.eval(`(() => { ${body} })()`); try { return JSON.parse(v) } catch { return v } }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    return file
  }
}

const HELPERS = `
  const __roots = () => { const rs = [document]; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot) } return rs };
  const __q = (sel) => { const out = []; for (const r of __roots()) { try { for (const el of r.querySelectorAll(sel)) out.push(el) } catch {} } return out };
  const __clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const __cut = (s, n) => { const t = __clean(s); return t.length > n ? t.slice(0, n) + '…' : t };
  const __vis = (el) => { try { return el.getClientRects().length > 0 } catch { return false } };
`

async function targets() { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`).catch(() => null); return r && r.ok ? await r.json() : [] }

async function findRenderer(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const page = (await targets()).find(t => t.type === 'page' && /index\.html/.test(t.url || ''))
    if (page?.webSocketDebuggerUrl) {
      const cdp = new CDP(page.webSocketDebuggerUrl); await cdp.ready
      if (await cdp.eval('!!(window.shopilot && window.shopilot.browser)').catch(() => false)) return cdp
    }
    if (Date.now() >= deadline) throw new Error('等不到主窗口渲染层')
    await sleep(600)
  }
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
  const out = {}
  const restore = []
  try {
    const ui = await findRenderer()
    log('已连上主窗口渲染层\n')

    // ① 拼多多：截图 + 同屏价格文本
    log('──────── ① 拼多多：价格字体反爬判定（截图 + 同屏文本）────────')
    const pdd = storeOf('拼多多')
    const a = await openStore(ui, pdd)
    restore.push({ storeId: pdd.id, tabId: a.tabId, url: a.url })
    await ui.eval(`window.shopilot.browser.navigate(${JSON.stringify(pdd.id)}, ${JSON.stringify(a.tabId)}, 'https://mms.pinduoduo.com/goods/goods_list')`)
    await sleep(12000)
    const priceText = await a.page.json(`
      ${HELPERS}
      const rows = [];
      for (const t of __q('table')) {
        for (const tr of [...t.querySelectorAll('tbody tr')]) {
          const cells = [...tr.children].map(c => __clean(c.innerText));
          if (cells.join('').length < 10) continue;
          rows.push(cells.slice(0, 5));
          if (rows.length >= 4) break;
        }
        if (rows.length >= 4) break;
      }
      const bt = String(document.body.innerText || '');
      return JSON.stringify({ url: location.href, title: document.title, bodyLen: bt.length,
                             总数文案: (bt.match(/共\\s*\\d+\\s*[条件个]/g) || []).slice(0, 3), rows });
    `)
    log('  同屏文本:', JSON.stringify(priceText, null, 1).slice(0, 1400))
    const png = await a.page.shot(path.join(OUT_DIR, 'pdd-goods-list.png'))
    log('  截图:', png)
    out.pdd = { text: priceText, screenshot: png }

    // ② 快手：去商家后台找商品管理/发布入口
    log('\n──────── ② 快手：商家后台（s.kwaixiaodian.com）的商品入口 ────────')
    const ks = storeOf('快手小店')
    const b = await openStore(ui, ks)
    restore.push({ storeId: ks.id, tabId: b.tabId, url: b.url })
    await ui.eval(`window.shopilot.browser.navigate(${JSON.stringify(ks.id)}, ${JSON.stringify(b.tabId)}, 'https://s.kwaixiaodian.com/zone/home')`)
    await sleep(12000)
    const ksNav = await b.page.json(`
      ${HELPERS}
      const hits = [];
      for (const el of __q('a,span,div,li')) {
        if (el.children.length > 2) continue;
        const t = __clean(el.textContent);
        if (!t || t.length > 16 || !/商品|货品/.test(t)) continue;
        let href = null;
        try { const a = el.closest('a'); href = a ? a.getAttribute('href') : null } catch {}
        hits.push({ text: t, tag: el.tagName, href });
        if (hits.length >= 45) break;
      }
      const bt = String(document.body.innerText || '');
      return JSON.stringify({ url: location.href, title: document.title, bodyLen: bt.length, hits, head: __cut(bt, 260) });
    `)
    log('  URL:', ksNav.url, '| 标题:', ksNav.title, '| 正文', ksNav.bodyLen, '字')
    log('  含"商品"的入口:', JSON.stringify(ksNav.hits, null, 1).slice(0, 2000))
    out.kuaishouAdmin = ksNav

    fs.writeFileSync(path.join(OUT_DIR, 'final.json'), JSON.stringify(out, null, 2), 'utf8')
    log('\n收尾勘察结束；证据已存', OUT_DIR)
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

main().catch(e => { console.error('\n收尾勘察失败:', (e && e.message) || e); process.exitCode = 1 })
