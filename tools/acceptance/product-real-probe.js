/**
 * 商品管理 · 真机勘察探针（对应 docs/product-management-plan.md §17 的 15 项未知）。
 *
 * 运行方式（Windows，**先关掉你自己开着的 ShopPilot**——单实例锁会让新进程直接退出）：
 *   node tools/acceptance/product-real-probe.js [平台1,平台2] [CDP端口]
 *   例：node tools/acceptance/product-real-probe.js 抖店,微信小店 9271
 *
 * 它做什么：用**真实 userData**（真实登录态）启动应用，逐个平台打开店铺浏览器，然后
 *   ① 在页面里找「商品」入口（优先读 href，不盲点）
 *   ② 导航到商品列表页，dump 真实结构：URL / 表头 / 行数 / 分页 / 总数 / 是否字体反爬 / 是否 ShadowRoot
 *   ③ 找「发布商品」入口并导航过去，dump 表单结构：字段、必填标记、控件类型、类目控件形态、图片上传入口、
 *      以及**已填字段能否回读**（这是"越用越自动"的前提）
 *
 * 只读语义（红线）：
 *   · **绝不点击任何提交/发布/保存/删除/确认类按钮**，绝不提交任何表单；
 *   · 点击白名单只有页内导航文案（商品 / 商品管理 / 商品列表 …）；其余一律只读 href、不点；
 *   · 不写任何商品数据（本轮还没有商品表）；结束前把每个店铺标签页**导航回进入时的地址**（用完即还原）。
 *
 * 它**不是**自证成功的脚本：每一节只打印"实测到了什么"，判定必须由人看这份输出。
 * 第 12/13/14 项（提交后成功判据 / 重复提交拦截 / 发布后状态）**无法在不真实发布的前提下实测**，
 * 脚本明确标注 SKIPPED 并说明原因，绝不用推测填坑。
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.join(__dirname, '..', '..')
const PORT = Number(process.argv[3] || process.env.SHOPILOT_PRODUCT_PROBE_PORT || 9271)
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const DB_PATH = path.join(process.env.APPDATA || '', 'shopilot', 'shopilot.db')
const OUT_DIR = path.join(ROOT, 'artifacts', 'product-probe')
const PLATFORMS = (process.argv[2] || process.env.SHOPILOT_PRODUCT_PLATFORMS || '抖店,微信小店,拼多多,快手小店')
  .split(',').map(s => s.trim()).filter(Boolean)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(...a)

function storesFor(platforms) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  try {
    const rows = db.prepare('SELECT id, name, platform, admin_url, status FROM stores WHERE deleted_at IS NULL ORDER BY name').all()
    return platforms.map(p => rows.find(r => r.platform === p)).filter(Boolean)
  } finally { db.close() }
}

// ---------------------------------------------------------------- CDP

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id) }
    }
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
      .then(r => {
        if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
        return r.result?.value
      })
    // 页面很重时 Runtime.evaluate 可能长时间不返回；加超时，避免整个勘察卡死
    return Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error(`页面内执行超时(${timeoutMs}ms)`)), timeoutMs))])
  }
  async evalJson(body) {
    const v = await this.eval(`(() => { ${body} })()`)
    try { return JSON.parse(v) } catch { return v }
  }
}

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`).catch(() => null)
  if (!res || !res.ok) return []
  return await res.json()
}

async function findRenderer(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const page = (await listTargets()).find(t => t.type === 'page' && /index\.html/.test(t.url || ''))
    if (page?.webSocketDebuggerUrl) {
      const cdp = new CDP(page.webSocketDebuggerUrl)
      await cdp.ready
      if (await cdp.eval('!!(window.shopilot && window.shopilot.browser)').catch(() => false)) return cdp
    }
    if (Date.now() >= deadline) throw new Error('等不到主窗口渲染层（带 preload 的 index.html）')
    await sleep(600)
  }
}

// ---------------------------------------------------------------- 页面内公共 JS

/**
 * 页面内公共工具。性能纪律（重要）：
 *   · 先按**文本**过滤（廉价），**最后**才做可见性判断（getClientRects 会触发布局，很贵）；
 *   · 遍历有上限（__cap），避免在几万元素的 SPA 上把 RadiRuntime 拖死；
 *   · 表单控件用原生 `querySelectorAll('input,textarea,select')`，逐根（含 shadowRoot）查询。
 */
const HELPERS = `
  const __cap = 12000;
  const __roots = () => { const rs = [document]; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot) } return rs };
  const __q = (sel) => { const out = []; for (const r of __roots()) { try { for (const el of r.querySelectorAll(sel)) out.push(el) } catch {} } return out };
  const __all = () => { const out = []; const walk = (r) => { for (const el of r.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot); if (out.length >= __cap) return }; }; walk(document); return out };
  const __own = (el) => { let s = ''; for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent; return s.trim() };
  const __clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const __vis = (el) => { try { return el.getClientRects().length > 0 } catch { return false } };
  const __cut = (s, n) => { const t = __clean(s); return t.length > n ? t.slice(0, n) + '…' : t };
  const __hasShadow = () => { for (const el of document.querySelectorAll('*')) if (el.shadowRoot) return true; return false };
`

/** 按白名单文案找页内入口：先文本后可见性；只关心"叶子-ish"节点。 */
function findEntries(allowSource, limit = 40) {
  return `
    ${HELPERS}
    const ALLOW = ${allowSource};
    const hits = [];
    for (const el of __q('a,button,span,div,li,p,h1,h2,h3')) {
      if (el.children.length > 3) continue;            // 廉价预筛：容器节点直接跳过
      const own = __own(el);
      if (!own || own.length > 14) continue;
      if (!ALLOW.test(own)) continue;
      if (!__vis(el)) continue;                        // 文本先过，最后才量布局
      let a = null;
      try { a = el.closest('a') } catch { a = null }
      const r = el.getBoundingClientRect();
      hits.push({ text: own, tag: el.tagName, href: a ? a.getAttribute('href') : null,
                  cls: __cut(String(el.className || ''), 50), x: Math.round(r.left), y: Math.round(r.top) });
      if (hits.length >= ${limit}) break;
    }
    return JSON.stringify(hits);
  `
}

const NAV_ALLOW = '/^(商品|商品管理|商品列表|商品总览|我的商品|在售商品|出售中|全部商品)$/'
const PUB_ALLOW = '/^(发布商品|发布新商品|新增商品|新建商品|创建商品|添加商品)$/'

/**
 * 点击白名单 —— **只允许"打开某个页面"的入口**，绝不允许提交类动作。
 *
 * 为什么必须点击：抖店/微信小店的商品入口都是 SPA 按钮，没有 href 可读（实测 2026-09-30）。
 * 点「商品管理」「新建商品」= 打开页面，不会产生任何提交；而下面 DENY 里的词一个都不点。
 */
const CLICK_ALLOW = ['商品', '商品管理', '商品列表', '商品总览', '我的商品', '在售商品', '出售中', '全部商品',
  '发布商品', '发布新商品', '新增商品', '新建商品', '创建商品', '添加商品']
const CLICK_DENY = /^(提交|发布|保存|确认|确定|上架|立即发布|发布并上架|删除|下架|批量|导出|同步)$/

function clickExact(text) {
  if (CLICK_DENY.test(text) || !CLICK_ALLOW.includes(text)) return `'REFUSED:${text}'`
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

const DUMP_LIST = `
  ${HELPERS}
  const tables = [];
  for (const t of __q('table')) {
    if (!__vis(t)) continue;
    const ths = [...t.querySelectorAll('th')].map(x => __cut(x.innerText, 24)).filter(Boolean);
    const bodyRows = [...t.querySelectorAll('tbody tr')];
    tables.push({
      ths, bodyRows: bodyRows.length,
      前2行: bodyRows.slice(0, 2).map(tr => [...tr.children].map(c => __cut(c.innerText, 22))),
      // 行内结构证据：为什么 innerText 可能是空的（虚拟列表/自定义组件/内容在 shadow 里）
      行内细节: bodyRows.slice(0, 3).map(tr => [...tr.children].slice(0, 8).map(td => ({
        txt: __cut(td.innerText, 40), els: td.querySelectorAll('*').length,
        html: __cut(String(td.innerHTML || ''), 120), img: td.querySelectorAll('img').length
      })))
    });
    if (tables.length >= 6) break;
  }
  const bodyText = String(document.body ? document.body.innerText : '');
  // 字体反爬：私用区码位（拼多多 sycm 先例）。先按 textContent 廉价筛，再判可见。
  const pua = [];
  for (const el of __all()) {
    const t = el.textContent;
    if (!t || !/[\\uE000-\\uF8FF]/.test(t)) continue;
    if (pua.length && pua[pua.length - 1] === __cut(t, 30)) continue;
    pua.push(__cut(t, 30));
    if (pua.length >= 5) break;
  }
  const pagers = [];
  for (const el of __q('span,div,li,button,a')) {
    if (el.children.length > 2) continue;
    const own = __own(el);
    if (!own || own.length > 16) continue;
    if (!(/^(下一页|下页|上一页|上页|末页|首页)$/.test(own) || /^共\\s*\\d+\\s*[条件个]/.test(own) || /^\\d+\\s*\\/\\s*\\d+$/.test(own))) continue;
    if (!__vis(el)) continue;
    pagers.push({ text: own, tag: el.tagName });
    if (pagers.length >= 20) break;
  }
  const imgs = [];
  for (const el of __q('img')) {
    if (!__vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40) continue;                       // 跳过图标，只留商品图
    imgs.push({ src: __cut(el.getAttribute('src'), 90), w: Math.round(r.width), alt: __cut(el.getAttribute('alt'), 24) });
    if (imgs.length >= 6) break;
  }
  return JSON.stringify({
    url: location.href, title: document.title, bodyLen: bodyText.length, hasShadow: __hasShadow(),
    tables, pagers: pagers.slice(0, 12),
    totalText: (bodyText.match(/共\\s*\\d+\\s*[条件个]/g) || []).slice(0, 4),
    puaCount: pua.length, puaSamples: pua,
    fonts: [...document.fonts].map(f => __cut(f.family, 26)).slice(0, 6),
    imgs,
    bodyHead: __cut(bodyText, 700)
  });
`

const DUMP_PUBLISH_FORM = `
  ${HELPERS}
  const fields = [];
  for (const el of __q('input,textarea,select')) {
    const tag = el.tagName;
    const type = String(el.getAttribute('type') || tag.toLowerCase());
    if (type === 'hidden') continue;
    if (!__vis(el)) continue;
    let label = '';
    if (el.id) { try { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) label = __own(l) || __clean(l.innerText) } catch {} }
    if (!label && el.closest) { const p = el.closest('label'); if (p) label = __cut(p.innerText, 40); }
    if (!label && el.parentElement) label = __cut(el.parentElement.innerText, 40);
    const required = el.required === true || el.getAttribute('aria-required') === 'true' ||
      (el.closest ? !!el.closest('.required, [class*=required], [class*=is-required]') : false);
    fields.push({
      tag, type, label: __cut(label, 40),
      placeholder: __cut(el.getAttribute('placeholder'), 30),
      required,
      // 回读能力证据：标准控件才有可读的 value 字符串（内容型编辑器 div 没有）
      valueType: typeof el.value, valueLen: typeof el.value === 'string' ? el.value.length : null,
      readOnly: el.readOnly === true || el.disabled === true,
      cls: __cut(String(el.className || ''), 40)
    });
    if (fields.length >= 60) break;
  }
  const requiredMarks = [];
  for (const el of __q('span,div,label,em,i')) {
    if (el.children.length > 2) continue;
    const own = __own(el);
    if (!own || own.length > 10) continue;
    if (!(own === '*' || own === '＊' || /必填|必选/.test(own))) continue;
    if (requiredMarks.length >= 26) break;
    requiredMarks.push({ mark: __cut(own, 12), near: el.parentElement ? __cut(el.parentElement.innerText, 46) : '' });
  }
  const fileInputs = __q('input[type=file]').map(el => ({
    accept: __cut(el.getAttribute('accept'), 40), multiple: el.multiple === true, cls: __cut(String(el.className || ''), 40)
  }));
  const categoryHints = [];
  for (const el of __q('div,span,label,input,button')) {
    if (el.children.length > 2) continue;
    const own = __own(el) || __clean(el.getAttribute('placeholder'));
    if (!own || own.length > 46 || !/类目|分类|category/i.test(own)) continue;
    categoryHints.push({ text: __cut(own, 44), tag: el.tagName, role: __cut(el.getAttribute('role'), 20),
                         cls: __cut(String(el.className || ''), 50) });
    if (categoryHints.length >= 15) break;
  }
  const bodyText = String(document.body ? document.body.innerText : '');
  return JSON.stringify({
    url: location.href, title: document.title, bodyLen: bodyText.length, hasShadow: __hasShadow(),
    fieldCount: fields.length, fields: fields.slice(0, 40),
    requiredMarks: requiredMarks.slice(0, 20), fileInputs, categoryHints,
    bodyHead: __cut(bodyText, 900)
  });
`

// ---------------------------------------------------------------- 主流程

function killTree(child) {
  if (!child || child.exitCode !== null) return
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* gone */ }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  if (!fs.existsSync(DB_PATH)) throw new Error('找不到应用数据库：' + DB_PATH)
  const stores = storesFor(PLATFORMS)
  if (!stores.length) throw new Error('库里没有这些平台的店铺：' + PLATFORMS.join(','))

  log('=== 商品管理真机勘察（只读；绝不提交任何表单；结束前还原标签页）===')
  log('数据库:', DB_PATH, '| CDP 端口:', PORT)
  for (const s of stores) log(`  · ${s.name}（${s.platform}）status=${s.status}`)
  log('')

  try {
    const running = execSync('tasklist /FI "IMAGENAME eq electron.exe" /FO CSV', { encoding: 'utf8' })
    const count = (running.match(/electron\.exe/gi) || []).length
    if (count > 0) log(`⚠ 已有 ${count} 个 electron.exe 在跑；单实例锁会让本次启动直接退出。\n`)
  } catch { /* ignore */ }

  const child = spawn(ELECTRON, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' } })

  const report = { probedAt: new Date().toISOString(), port: PORT, platforms: {} }
  const restore = []   // [{ storeId, tabId, url }]

  try {
    const ui = await findRenderer()
    log('已连上主窗口渲染层\n')

    for (const store of stores) {
      const out = { storeName: store.name, platform: store.platform, storeId: store.id }
      const section = (t) => log(`\n──────── ${store.platform}（${store.name}）· ${t} ────────`)
      const knownBefore = new Set((await listTargets()).map(t => t.id))

      section('① 打开店铺')
      await ui.eval(`window.shopilot.browser.open(${JSON.stringify(store.id)})`)
      await sleep(6000)

      const tabs = JSON.parse(await ui.eval(`window.shopilot.browser.tab.list(${JSON.stringify(store.id)}).then(r => JSON.stringify((r.data && r.data.tabs) || []))`))
      const tab = tabs[0]
      out.initialUrl = tab?.url || null
      log('  当前标签:', out.initialUrl)
      if (tab?.url && /^https?:/.test(tab.url)) restore.push({ storeId: store.id, tabId: tab.id, url: tab.url })

      // 只挑**本次新出现**的 webview，避免多店时抓错页面
      let target = null
      for (let i = 0; i < 30 && !target; i++) {
        const list = await listTargets()
        target = list.find(t => t.type === 'webview' && !knownBefore.has(t.id) && /^https?:/.test(t.url || '')) || null
        if (!target) await sleep(500)
      }
      if (!target) { log('  ✗ 没等到新店铺页 webview，跳过该平台'); report.platforms[store.platform] = { ...out, error: 'no-webview-target' }; continue }
      const page = new CDP(target.webSocketDebuggerUrl)
      await page.ready
      log('  店铺页 target:', target.id.slice(0, 8), '|', target.url)

      // ② 商品入口（两段式：先点分组，展开后再点具体页）
      section('② 找「商品」入口（只读 href；无 href 才在白名单内点击）')
      let list = null
      for (let round = 1; round <= 3 && !list; round++) {
        const entries = await page.evalJson(findEntries(NAV_ALLOW))
        if (round === 1) { out.productEntries = entries; log('  候选:', JSON.stringify(entries).slice(0, 900)) }
        if (!entries.length) { log(`  第 ${round} 轮：没有候选入口`); break }

        // 第 1 轮偏好分组入口（商品管理），后续轮偏好具体页（商品列表）
        const prefer = round === 1
          ? (entries.find(e => e.href && /list|goods|product|item/i.test(e.href)) || entries.find(e => e.href) || entries[0])
          : (entries.find(e => /商品列表|全部商品|在售商品|商品总览/.test(e.text)) || entries[0])
        log(`  第 ${round} 轮选定:`, JSON.stringify(prefer))
        if (prefer.href) {
          const abs = prefer.href.startsWith('http') ? prefer.href : new URL(prefer.href, out.initialUrl).href
          log('   → 读 href 直接导航:', abs)
          await ui.eval(`window.shopilot.browser.navigate(${JSON.stringify(store.id)}, ${JSON.stringify(tab.id)}, ${JSON.stringify(abs)})`)
        } else {
          log('   → 无 href（SPA 按钮）→ 白名单内点击打开页面（不是提交）')
          log('   点击结果:', await page.eval(clickExact(prefer.text)))
        }
        await sleep(8000)
        out.afterNavUrl = await page.eval('location.href')
        log('   现在 URL:', out.afterNavUrl)
        const probe = await page.evalJson(DUMP_LIST)
        // 判定"进到商品列表了"：有商品表格，或正文里有"共 N 件商品/条"
        if (probe.tables.length > 0 || probe.totalText.length > 0) { list = probe; log('   ✓ 已进入商品列表页') }
        else log(`   第 ${round} 轮还没到列表页（表格 ${probe.tables.length} 个，正文 ${probe.bodyLen} 字）`)
        if (round === 1) out.firstAfterNav = { url: probe.url, bodyLen: probe.bodyLen, tables: probe.tables.length }
      }
      if (!list) list = await page.evalJson(DUMP_LIST)

      // ③ 列表页结构
      section('③ 商品列表页结构')
      out.list = list
      log('  URL:', list.url, '| 标题:', list.title)
      log('  正文长度:', list.bodyLen, '| ShadowRoot:', list.hasShadow, '| 表格数:', list.tables.length)
      for (const t of list.tables) {
        log('   · 表头:', JSON.stringify(t.ths))
        log('     数据行:', t.bodyRows, '| 前2行:', JSON.stringify(t.前2行))
        log('     行内细节:', JSON.stringify(t.行内细节).slice(0, 700))
      }
      log('  分页/总数控件:', JSON.stringify(list.pagers))
      log('  正文里的"共 N 条":', JSON.stringify(list.totalText))
      log('  字体反爬: 私用区码位', list.puaCount, list.puaSamples.length ? JSON.stringify(list.puaSamples) : '', '| 字体:', JSON.stringify(list.fonts))
      log('  页面图片样本:', JSON.stringify(list.imgs).slice(0, 500))
      log('  正文前 300 字:', list.bodyHead.slice(0, 300))

      // ④ 发布入口
      section('④ 找「发布商品」入口（只读 href，绝不点击提交类按钮）')
      const pubEntries = await page.evalJson(findEntries(PUB_ALLOW, 20))
      out.publishEntries = pubEntries
      log('  候选:', JSON.stringify(pubEntries).slice(0, 900))

      if (pubEntries.length) {
        const p = pubEntries.find(e => e.href) || pubEntries[0]
        if (p.href) {
          const abs = p.href.startsWith('http') ? p.href : new URL(p.href, list.url).href
          log('  按 href 导航到发布页:', abs, '（只打开表单，绝不提交）')
          await ui.eval(`window.shopilot.browser.navigate(${JSON.stringify(store.id)}, ${JSON.stringify(tab.id)}, ${JSON.stringify(abs)})`)
        } else {
          log('  无 href（SPA 按钮）→ 白名单内点击打开表单（「新建商品/发布商品」= 打开页面，不是提交）')
          log('  点击结果:', await page.eval(clickExact(p.text)))
        }
        await sleep(8000)
        section('⑤ 发布页表单结构（只读，绝不提交）')
        // 表单是渐进渲染的（微信小店实测：9s 时只抓到 2 个字段 + 一个帮助浮层），所以轮询取"信息最多"的那次
        let form = null
        for (let i = 1; i <= 3; i++) {
          const f = await page.evalJson(DUMP_PUBLISH_FORM)
          log(`  第 ${i} 次探测：URL=${f.url} 正文 ${f.bodyLen} 字 / 可见字段 ${f.fieldCount} 个 / file input ${f.fileInputs.length} 个`)
          if (!form || f.fieldCount > form.fieldCount || f.fileInputs.length > form.fileInputs.length) form = f
          if (f.fieldCount >= 8 && f.bodyLen >= 600) break
          await sleep(7000)
        }
        out.publishForm = form
        log('  URL:', form.url, '| 标题:', form.title, '| 正文长度:', form.bodyLen, '| ShadowRoot:', form.hasShadow)
        log('  可见字段数:', form.fieldCount)
        for (const f of form.fields.slice(0, 25)) {
          log(`   · <${f.tag} ${f.type}> label="${f.label}" req=${f.required} valueLen=${f.valueLen} valueType=${f.valueType} ro=${f.readOnly} ph="${f.placeholder}"`)
        }
        log('  必填/提示标记:', JSON.stringify(form.requiredMarks).slice(0, 700))
        log('  文件上传入口:', JSON.stringify(form.fileInputs))
        log('  类目控件线索:', JSON.stringify(form.categoryHints).slice(0, 600))
        log('  正文前 400 字:', form.bodyHead.slice(0, 400))
      } else {
        log('  ⚠ 列表页上没找到发布入口（可能叫别的名字，或在通用导航里）')
      }

      section('⑥ 无法在不真实发布前提下实测的项')
      log('  SKIPPED 提交后成功判据（§17-12）—— 需要真实提交一个测试商品')
      log('  SKIPPED 重复提交是否被拦（§17-13）—— 同上')
      log('  SKIPPED 发布后是"直接上架"还是"审核中"（§17-14）—— 同上')
      log('  → 需用户明确授权"发布一个测试商品"后才能测；在此之前按方案标注为待实测，不用推测填坑。')

      report.platforms[store.platform] = out
      fs.writeFileSync(path.join(OUT_DIR, `${store.platform}.json`), JSON.stringify(out, null, 2), 'utf8')
    }
  } finally {
    // 用完即还原：把每个店铺标签页导航回进入时的地址
    try {
      const ui = await findRenderer(8000)
      for (const r of restore) {
        log(`↩ 还原标签页：${r.storeId.slice(0, 14)}… → ${r.url.slice(0, 80)}`)
        await ui.eval(`window.shopilot.browser.navigate(${JSON.stringify(r.storeId)}, ${JSON.stringify(r.tabId)}, ${JSON.stringify(r.url)})`)
        await sleep(1500)
      }
    } catch (e) { log('还原标签页失败（不影响勘察结论）:', String(e && e.message || e)) }

    fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
    log(`\n=== 勘察结束；原始证据已存 ${OUT_DIR} ===`)
    killTree(child)
    await sleep(1200)
  }
}

main().catch(err => { console.error('\n勘察失败:', (err && err.message) || err); process.exitCode = 1 })
