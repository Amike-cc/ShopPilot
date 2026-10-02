/**
 * 发布页"看一眼"：截图 + 元素坐标清单（**只读，不点任何东西**）
 *
 * 前三轮我都在盲猜上传区的坐标，一次没猜中。这一步改成：**把页面截下来，亲眼看**。
 * 同时输出一份"可见元素 + 坐标"清单，好在图上对照。
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.join(__dirname, '..', '..')
const PORT = Number(process.argv[2] || 9293)
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const DB_PATH = path.join(process.env.APPDATA || '', 'shopilot', 'shopilot.db')
const OUT_DIR = path.join(ROOT, 'artifacts', 'product-probe')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(...a)

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map()
    this.listeners = new Map()
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); return }
      if (m.method && this.listeners.has(m.method)) for (const cb of this.listeners.get(m.method)) { try { cb(m.params) } catch { /* ignore */ } }
    }
  }
  on(method, handler) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(handler) }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, m => m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 120))) : res(m.result))
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
      if (await cdp.eval('!!(window.shopilot && window.shopilot.products)', 5000).catch(() => false)) return cdp
    }
    if (Date.now() >= deadline) throw new Error('等不到主窗口')
    await sleep(600)
  }
}

/** 可见元素 + 坐标清单（含 ShadowRoot）。 */
const LAYOUT = `(() => {
  const cap = 8000;
  const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
  const vis = (el) => { try { return el.getClientRects().length > 0 } catch { return false } };
  const own = (el) => { let s = ''; for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent; return s.replace(/\\s+/g, ' ').trim() };
  const rows = [];
  const seen = new Set();
  const add = (el, kind) => {
    if (!vis(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return;
    const key = kind + ':' + Math.round(r.x) + ',' + Math.round(r.y) + ',' + Math.round(r.width) + ',' + Math.round(r.height);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ kind, text: own(el).slice(0, 22), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
  };
  for (const r of roots()) {
    for (const el of r.querySelectorAll('button')) add(el, 'button');
    for (const el of r.querySelectorAll('input,textarea')) add(el, 'input');
    for (const el of r.querySelectorAll('img')) add(el, 'img');
    for (const el of r.querySelectorAll('div,span,label')) { if (el.children.length <= 1) add(el, 'box') }
  }
  // 只保留视口内的，按 y 再按 x 排序（好和截图对照）
  const inView = rows.filter(r => r.y >= 0 && r.y <= 900 && r.x >= 0 && r.x <= 1400);
  inView.sort((a, b) => a.y - b.y || a.x - b.x);
  return JSON.stringify({ vw: innerWidth, vh: innerHeight, count: inView.length, rows: inView.slice(0, 70) });
})()`

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  log('=== 发布页"看一眼"（只读，不点任何东西）===')
  const child = spawn(ELECTRON, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' } })
  let productId = null
  try {
    const ui = await findRenderer()
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const store = db.prepare(`SELECT id, name FROM stores WHERE platform = '微信小店' AND deleted_at IS NULL LIMIT 1`).get()
    const link = db.prepare(`SELECT platform_product_id, store_id FROM product_platform_links WHERE platform = '微信小店' AND product_id IS NULL ORDER BY platform_product_id LIMIT 1`).get()
    db.close()
    if (!store || !link) throw new Error('库里缺微信小店店铺或未归并商品')

    await ui.eval('window.shopilot.browser.open(' + JSON.stringify(store.id) + ')')
    await sleep(7000)

    const stamp = new Date().toISOString().slice(5, 16).replace(/[:T]/g, '')
    const testTitle = '【自动化验收请勿购买】截图 ' + stamp
    const created = JSON.parse(await ui.eval('window.shopilot.products.library.saveAsLocal(' + JSON.stringify({ platform: '微信小店', storeId: link.store_id, platformProductId: link.platform_product_id, mergeLink: false }) + ').then(r => JSON.stringify(r))'))
    productId = created?.data?.productId || null
    if (!productId) throw new Error('另存为失败')
    const got = JSON.parse(await ui.eval('window.shopilot.products.library.get(' + JSON.stringify(productId) + ').then(r => JSON.stringify(r))'))
    await ui.eval('window.shopilot.products.library.save(' + JSON.stringify({ productId, draft: { ...got.data.draft, title: testTitle } }) + ').then(r => JSON.stringify(r))')
    log('测试商品标题：' + testTitle)

    const pre = JSON.parse(await ui.eval('window.shopilot.products.publish.preflight(' + JSON.stringify({ productId, storeIds: [store.id] }) + ').then(r => JSON.stringify(r))'))
    log('预检：' + pre.data?.precheck?.verdict + ' 阻断=' + JSON.stringify((pre.data?.precheck?.blockers || []).map(b => b.message)))
    const opened = JSON.parse(await ui.eval('window.shopilot.products.publish.open(' + JSON.stringify({ itemId: pre.data.itemId, fill: true }) + ').then(r => JSON.stringify(r))'))
    log('打开：' + String(opened.data?.safeMessage || '').slice(0, 100))

    log('\n等页面渲染…')
    await sleep(12000)
    let page = null
    for (const t of await targets()) if (t.type === 'webview' && /goods\/entry/.test(t.url || '')) page = t
    if (!page) throw new Error('没找到发布页 webview')
    const probe = new CDP(page.webSocketDebuggerUrl); await probe.ready

    const layout = JSON.parse(await probe.eval(LAYOUT))
    log('视口 ' + layout.vw + 'x' + layout.vh + '，可见元素 ' + layout.count + ' 个（列前 70）')
    for (const row of layout.rows) log(`  ${String(row.y).padStart(4)},${String(row.x).padStart(4)}  ${row.w}x${row.h}  ${row.kind.padEnd(6)} "${row.text}"`)
    fs.writeFileSync(path.join(OUT_DIR, 'publish-layout.json'), JSON.stringify(layout, null, 2), 'utf8')

    const shot = await probe.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.writeFileSync(path.join(OUT_DIR, 'publish-page.png'), Buffer.from(shot.data, 'base64'))
    log('\n截图已存 artifacts/product-probe/publish-page.png')
    log('元素清单已存 artifacts/product-probe/publish-layout.json')

    // 点「1:1 主图」下面那个带「+」的方框（截图里看得很清楚：约 100×110，中心 ≈(164,301)），
    // 再看弹出的到底是**原生文件选择器**还是微信自己的弹窗 —— 前三轮的失败都源于没搞清这一点。
    const plus = layout.rows.find(row => row.w >= 90 && row.w <= 140 && row.h >= 90 && row.h <= 150)
      || layout.rows.find(row => row.y >= 200 && row.y <= 400 && row.w >= 80 && row.h >= 80)
    if (!plus) { log('\n没在清单里找到「+」上传框，跳过点击'); return }
    const cx = Math.round(plus.x + plus.w / 2)
    const cy = Math.round(plus.y + plus.h / 2)
    log(`\n点「+」上传框：(${cx},${cy})  ${plus.w}x${plus.h}  kind=${plus.kind}`)

    let chooser = null
    probe.on('Page.fileChooserOpened', (params) => { chooser = params; log('   📥 捕获到**原生文件选择器**请求 backendNodeId=' + params.backendNodeId) })
    await probe.send('Page.enable')
    await probe.send('Page.setInterceptFileChooserDialog', { enabled: true })

    await probe.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy })
    await probe.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 })
    await sleep(80)
    await probe.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })
    log('   已点击，等 8 秒看反应…')
    await sleep(8000)

    log('   原生文件选择器被触发了吗？' + (chooser ? '✅ 是' : '❌ 否（说明弹的是页面自己的弹窗）'))

    // **把文件投给平台自己指定的那个节点**（backendNodeId）——这是关键：
    // 前面三种投喂姿势失败，都是因为我在投**我自己找到的** input；
    // 而这里是平台**主动告诉我们**它要用哪个节点。
    if (chooser?.backendNodeId) {
      const mediaRoot = path.join(process.env.APPDATA || '', 'shopilot', 'product-media')
      let useFile = null
      if (fs.existsSync(mediaRoot)) {
        for (const dir of fs.readdirSync(mediaRoot)) {
          const full = path.join(mediaRoot, dir)
          if (!fs.statSync(full).isDirectory()) continue
          for (const n of fs.readdirSync(full)) {
            if (!/\.(jpg|jpeg|png|webp)$/i.test(n)) continue
            if (!useFile || /\.(jpg|jpeg|png)$/i.test(n)) useFile = path.join(full, n)
          }
        }
      }
      if (useFile) {
        log('   投喂文件：…' + useFile.slice(-40))
        try {
          await probe.send('DOM.enable')
          await probe.send('DOM.setFileInputFiles', { files: [useFile], backendNodeId: chooser.backendNodeId })
          log('   ✅ 已投给 backendNodeId=' + chooser.backendNodeId)
        } catch (error) {
          log('   ❌ 投喂失败：' + String(error && error.message || error).slice(0, 140))
        }
        await sleep(20000)
        const state = await probe.eval(`(() => {
          const cap = 8000;
          const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
          let files = 0;
          for (const r of roots()) for (const el of r.querySelectorAll('input[type=file]')) files += (el.files ? el.files.length : 0);
          const imgs = [];
          for (const r of roots()) for (const el of r.querySelectorAll('img')) { if (!el.getClientRects().length) continue; const w = Math.round(el.getBoundingClientRect().width); if (w >= 40) imgs.push(w) }
          const body = String(document.body ? document.body.innerText : '');
          const m = body.match(/\\d+\\s*\\/\\s*9/);
          return JSON.stringify({ filesSelected: files, visibleImgs: imgs.slice(0, 10), 主图计数: m ? m[0] : null });
        })()`)
        log('   投喂后页面状态：' + state)
        const shot3 = await probe.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
        fs.writeFileSync(path.join(OUT_DIR, 'publish-after-upload.png'), Buffer.from(shot3.data, 'base64'))
        log('   截图已存 artifacts/product-probe/publish-after-upload.png')
      } else {
        log('   磁盘上没有可用图片')
      }
    }
    const layout2 = JSON.parse(await probe.eval(LAYOUT))
    const shot2 = await probe.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.writeFileSync(path.join(OUT_DIR, 'publish-after-plus.png'), Buffer.from(shot2.data, 'base64'))
    log('   点击后可见元素 ' + layout2.count + ' 个（之前 ' + layout.count + '）')
    for (const row of layout2.rows.slice(0, 30)) log(`     ${String(row.y).padStart(4)},${String(row.x).padStart(4)}  ${row.w}x${row.h}  ${row.kind.padEnd(6)} "${row.text}"`)
    fs.writeFileSync(path.join(OUT_DIR, 'publish-layout-after-plus.json'), JSON.stringify(layout2, null, 2), 'utf8')
    log('   截图已存 artifacts/product-probe/publish-after-plus.png')
  } finally {
    try {
      const ui = await findRenderer(10000)
      if (productId) { await ui.eval('window.shopilot.products.library.remove(' + JSON.stringify(productId) + ').then(() => 1)'); log('\n↩ 已软删测试商品') }
    } catch { /* ignore */ }
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* gone */ }
    await sleep(1200)
  }
}

main().catch(e => { console.error('失败:', (e && e.message) || e); process.exitCode = 1 })
