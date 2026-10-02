/**
 * 商品管理 · 勘察补测（三个定点问题；只读，绝不提交；结束前还原标签页）
 *
 * 第一轮勘察（product-real-probe.js）暴露了三个必须补测的点：
 *   ① 快手：「商品总览」是**数据页**不是商品列表（表头是"流量来源/商品曝光人数…"）→ 要找到真正的「商品列表」入口
 *   ② 抖店：商品表格的 <tbody> <tr> innerText 全空，但页面显示"共 2 件商品"→ 要看清行内容到底渲染在哪
 *   ③ 拼多多：出现了 `pdd-digit` / `mms-digit` 专用数字字体 → 要判定价格是否是**字体反爬**
 *
 * 用法：node tools/acceptance/product-probe-followup.js [CDP端口]
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.join(__dirname, '..', '..')
const PORT = Number(process.argv[2] || process.env.SHOPILOT_PRODUCT_PROBE_PORT || 9272)
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const DB_PATH = path.join(process.env.APPDATA || '', 'shopilot', 'shopilot.db')
const OUT_DIR = path.join(ROOT, 'artifacts', 'product-probe')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(...a)

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
      .then(r => { if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result?.value })
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
      if (await cdp.eval('!!(window.shopilot && window.shopilot.browser)').catch(() => false)) return cdp
    }
    if (Date.now() >= deadline) throw new Error('等不到主窗口渲染层')
    await sleep(600)
  }
}

const HELPERS = `
  const __roots = () => { const rs = [document]; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot) } return rs };
  const __q = (sel) => { const out = []; for (const r of __roots()) { try { for (const el of r.querySelectorAll(sel)) out.push(el) } catch {} } return out };
  const __clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const __cut = (s, n) => { const t = __clean(s); return t.length > n ? t.slice(0, n) + '…' : t };
  const __vis = (el) => { try { return el.getClientRects().length > 0 } catch { return false } };
`

/** ① 全部导航项（文本 + href），用来找真正的「商品列表」 */
const DUMP_NAV = `
  ${HELPERS}
  const out = [];
  for (const el of __q('a,span,div,li,p')) {
    if (el.children.length > 2) continue;
    const t = __clean(el.textContent);
    if (!t || t.length > 18) continue;
    if (!/商品|货品|宝贝/.test(t)) continue;
    let a = null; try { a = el.closest('a') } catch {}
    out.push({ text: t, tag: el.tagName, href: a ? a.getAttribute('href') : null, cls: __cut(String(el.className || ''), 40) });
    if (out.length >= 60) break;
  }
  return JSON.stringify(out);
`

/** ② 表格行的真实渲染位置 */
const DUMP_ROWS_DEEP = `
  ${HELPERS}
  const t = __q('table').filter(x => __vis(x))[0];
  if (!t) return JSON.stringify({ error: 'no table' });
  const trs = [...t.querySelectorAll('tbody tr')];
  const info = trs.slice(0, 3).map(tr => {
    const cells = [...tr.children];
    return {
      cellCount: cells.length,
      cellTxtLens: cells.map(c => (c.innerText || '').length),
      cellTextContentLens: cells.map(c => (c.textContent || '').length),
      firstCellHTML: __cut(String(cells[1] ? cells[1].innerHTML : ''), 400),
      rowHTMLHead: __cut(String(tr.innerHTML), 300)
    };
  });
  // 表格外层的容器类名（便于写选择器）
  let p = t, chain = [];
  for (let i = 0; i < 4 && p; i++) { chain.push(__cut(String(p.className || ''), 50)); p = p.parentElement }
  return JSON.stringify({ rowCount: trs.length, info, containerChain: chain });
`

/** ③ 字体反爬判定：价格单元格的字形字体 + textContent 是否等于肉眼所见 */
const DUMP_FONT_CHECK = `
  ${HELPERS}
  const cands = [];
  for (const el of __q('div,span,td')) {
    if (el.children.length > 1) continue;
    const t = __clean(el.textContent);
    if (!t || t.length > 14) continue;
    if (!/^[¥￥]?\\s*\\d+(\\.\\d+)?(\\s*[~～-]\\s*[¥￥]?\\s*\\d+(\\.\\d+)?)?$/.test(t)) continue;
    if (!__vis(el)) continue;
    const cs = getComputedStyle(el);
    cands.push({ text: t, fontFamily: cs.fontFamily, fontVariant: cs.fontVariantNumeric, cls: __cut(String(el.className || ''), 40) });
    if (cands.length >= 8) break;
  }
  // 页面加载的自定义数字字体，逐一列出它的字形是否覆盖私用区（sycm 做法：把数字映射到私用区字形）
  const fontInfo = [];
  for (const f of document.fonts) {
    if (!/digit|num|pdd|mms|din/i.test(f.family)) continue;
    fontInfo.push({ family: __cut(f.family, 30), status: f.status, weight: f.weight });
  }
  return JSON.stringify({ priceCandidates: cands, numberFonts: fontInfo });
`

function killTree(child) { if (!child || child.exitCode !== null) return; try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* gone */ } }

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

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const child = spawn(ELECTRON, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' } })
  const result = {}
  const restore = []
  try {
    const ui = await findRenderer()
    log('已连上主窗口渲染层\n')

    // ── ① 快手：找真正的商品列表入口
    log('──────── ① 快手小店：找「商品列表」入口 ────────')
    const ks = storeOf('快手小店')
    const a = await openStore(ui, ks)
    restore.push({ storeId: ks.id, tabId: a.tabId, url: a.url })
    const nav = await a.page.json(DUMP_NAV)
    log('  含"商品"的导航项:', JSON.stringify(nav, null, 1).slice(0, 2000))
    result.kuaishouNav = nav
    const listEntry = (nav || []).find(e => e.href && /goods.*list|list.*goods|product.*list|goodsList/i.test(e.href))
      || (nav || []).find(e => e.text === '商品列表' && e.href)
    if (listEntry) {
      const abs = listEntry.href.startsWith('http') ? listEntry.href : new URL(listEntry.href, a.url).href
      log('  选定商品列表入口:', listEntry.text, '→', abs)
      await ui.eval(`window.shopilot.browser.navigate(${JSON.stringify(ks.id)}, ${JSON.stringify(a.tabId)}, ${JSON.stringify(abs)})`)
      await sleep(9000)
      const dump = await a.page.json(`
        ${HELPERS}
        const tables = [];
        for (const t of __q('table')) { if (!__vis(t)) continue; const trs = [...t.querySelectorAll('tbody tr')];
          tables.push({ ths: [...t.querySelectorAll('th')].map(x => __cut(x.innerText, 24)).filter(Boolean), rows: trs.length,
                        前2行: trs.slice(0, 2).map(tr => [...tr.children].map(c => __cut(c.innerText, 26))) }); if (tables.length >= 4) break }
        const bt = String(document.body.innerText || '');
        return JSON.stringify({ url: location.href, title: document.title, tables, total: (bt.match(/共\\s*\\d+\\s*[条件个]/g) || []).slice(0, 3), bodyLen: bt.length, head: __cut(bt, 400) });
      `)
      log('  商品列表页:', JSON.stringify(dump, null, 1).slice(0, 1800))
      result.kuaishouList = dump
    } else {
      log('  ⚠ 导航项里没有可读 href 的「商品列表」')
      result.kuaishouList = { error: 'no-entry' }
    }

    // ── ② 抖店：表格行为什么是空的
    log('\n──────── ② 抖店：商品表格行的真实渲染位置 ────────')
    const dd = storeOf('抖店')
    const b = await openStore(ui, dd)
    restore.push({ storeId: dd.id, tabId: b.tabId, url: b.url })
    await ui.eval(`window.shopilot.browser.navigate(${JSON.stringify(dd.id)}, ${JSON.stringify(b.tabId)}, 'https://fxg.jinritemai.com/ffa/g/list')`)
    await sleep(9000)
    const rows = await b.page.json(DUMP_ROWS_DEEP)
    log('  ', JSON.stringify(rows, null, 1).slice(0, 1800))
    result.doudianRows = rows

    // ── ③ 拼多多：字体反爬判定
    log('\n──────── ③ 拼多多：价格是否字体反爬 ────────')
    const pdd = storeOf('拼多多')
    const c = await openStore(ui, pdd)
    restore.push({ storeId: pdd.id, tabId: c.tabId, url: c.url })
    const listUrl = 'https://mms.pinduoduo.com/goods/goods_list'
    await ui.eval(`window.shopilot.browser.navigate(${JSON.stringify(pdd.id)}, ${JSON.stringify(c.tabId)}, ${JSON.stringify(listUrl)})`)
    await sleep(9000)
    const fontCheck = await c.page.json(DUMP_FONT_CHECK)
    const pddDump = await c.page.json(`
      ${HELPERS}
      const bt = String(document.body.innerText || '');
      return JSON.stringify({ url: location.href, title: document.title, bodyLen: bt.length,
        total: (bt.match(/共\\s*\\d+\\s*[条件个]/g) || []).slice(0, 3), head: __cut(bt, 300) });
    `)
    log('  列表页:', JSON.stringify(pddDump))
    log('  字体判定:', JSON.stringify(fontCheck, null, 1).slice(0, 1600))
    result.pddFontCheck = fontCheck
    result.pddList = pddDump

    fs.writeFileSync(path.join(OUT_DIR, 'followup.json'), JSON.stringify(result, null, 2), 'utf8')
    log(`\n补测结束；证据已存 ${path.join(OUT_DIR, 'followup.json')}`)
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

main().catch(e => { console.error('\n补测失败:', (e && e.message) || e); process.exitCode = 1 })
