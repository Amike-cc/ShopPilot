/**
 * 发布向导侦察（已授权；**本步仍不点提交**）
 *
 * 上一轮的盲点：按钮匹配只覆盖 提交/发布/保存/上架/确认/完成，漏了向导按钮。
 * 这一轮**枚举所有可见可点元素**，搞清"新增商品"这个分步向导怎么往下走。
 *
 * 另外：这次的商品用 `mergeLink: false` 建（**不链接到任何店铺**），
 * 这样"该店铺已经有这个商品的平台记录"那条阻断不会出现 —— 才能看到真实的预检结果。
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.join(__dirname, '..', '..')
const PORT = Number(process.argv[2] || 9292)
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const DB_PATH = path.join(process.env.APPDATA || '', 'shopilot', 'shopilot.db')
const OUT_DIR = path.join(ROOT, 'artifacts', 'product-probe')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(...a)

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map()
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
    this.listeners = new Map()
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); return }
      // 事件（如 Page.fileChooserOpened）——官方那条"让平台告诉我用哪个节点"的路要靠它
      if (m.method && this.listeners.has(m.method)) for (const cb of this.listeners.get(m.method)) { try { cb(m.params) } catch { /* ignore */ } }
    }
  }
  on(method, handler) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(handler) }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, m => m.error ? rej(new Error(method)) : res(m.result))
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

/** 枚举所有可见可点元素 + 步骤指示器。 */
const ENUM = `(() => {
  const cap = 8000;
  const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
  const q = (sel) => { const out = []; for (const r of roots()) { try { for (const el of r.querySelectorAll(sel)) { out.push(el); if (out.length >= 4000) return out } } catch {} } return out };
  const own = (el) => { let s = ''; for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent; return s.replace(/\\s+/g, ' ').trim() };
  const vis = (el) => { try { return el.getClientRects().length > 0 } catch { return false } };
  const clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();

  // ① 所有**可见**的 button（原生按钮最可能是向导推进）
  const buttons = [];
  for (const el of q('button')) {
    if (!vis(el)) continue;
    buttons.push({ text: clean(el.innerText || own(el)).slice(0, 24), disabled: el.disabled === true, cls: clean(el.className).slice(0, 50) });
    if (buttons.length >= 40) break;
  }

  // ② 所有可见的 <a>（上一轮发现「编辑」是个 A）
  const links = [];
  for (const el of q('a')) {
    if (!vis(el)) continue;
    const t = clean(el.innerText || own(el));
    if (!t || t.length > 20) continue;
    links.push({ text: t.slice(0, 20), href: clean(el.getAttribute('href')).slice(0, 60) });
    if (links.length >= 40) break;
  }

  // ③ 短文案的可点 div/span（微信后台大量用这类做按钮）
  const clickables = [];
  for (const el of q('div,span')) {
    if (el.children.length > 1) continue;
    const t = own(el);
    if (!t || t.length > 12) continue;
    if (!vis(el)) continue;
    const cls = clean(el.className);
    const style = clean(el.getAttribute('style'));
    const looksClickable = /btn|button|link|action|next|step/i.test(cls) || /cursor:\\s*pointer/.test(style);
    if (!looksClickable) continue;
    clickables.push({ text: t.slice(0, 12), cls: cls.slice(0, 44) });
    if (clickables.length >= 40) break;
  }

  // ④ 步骤指示器 / 分步线索（第 1 步、下一步、共 N 步…）
  const steps = [];
  for (const el of q('div,span,li')) {
    if (el.children.length > 3) continue;
    const t = own(el);
    if (!t || t.length > 30) continue;
    if (!/第\\s*\\d\\s*步|下一步|上一步|共\\s*\\d\\s*步|基本信息|商品信息|价格库存|规格|类目|图片/.test(t)) continue;
    if (!vis(el)) continue;
    steps.push(t.slice(0, 30));
    if (steps.length >= 30) break;
  }

  const body = String(document.body ? document.body.innerText : '');
  return JSON.stringify({ url: location.href, buttons, links, clickables, steps: [...new Set(steps)], bodyLen: body.length, bodyHead: clean(body).slice(0, 200) });
})()`

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  log('=== 发布向导侦察（已授权；不点提交）===')
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
    const testTitle = '【自动化验收请勿购买】向导侦察 ' + stamp
    log('① 建测试商品（**不链接到任何店铺** → 不会被"已经发过了"挡住）')
    const created = JSON.parse(await ui.eval('window.shopilot.products.library.saveAsLocal(' + JSON.stringify({ platform: '微信小店', storeId: link.store_id, platformProductId: link.platform_product_id, mergeLink: false }) + ').then(r => JSON.stringify(r))'))
    productId = created?.data?.productId || null
    if (!productId) throw new Error('另存为失败')
    const got = JSON.parse(await ui.eval('window.shopilot.products.library.get(' + JSON.stringify(productId) + ').then(r => JSON.stringify(r))'))
    await ui.eval('window.shopilot.products.library.save(' + JSON.stringify({ productId, draft: { ...got.data.draft, title: testTitle } }) + ').then(r => JSON.stringify(r))')
    log('   标题：' + testTitle + '  已链接平台商品数=' + got.data.linkedCount)

    log('\n② 发布预检（应不再有阻断）')
    const pre = JSON.parse(await ui.eval('window.shopilot.products.publish.preflight(' + JSON.stringify({ productId, storeIds: [store.id] }) + ').then(r => JSON.stringify(r))'))
    log('   判定=' + pre.data?.precheck?.verdict + ' 档位=' + pre.data?.precheck?.tier)
    log('   阻断=' + JSON.stringify((pre.data?.precheck?.blockers || []).map(b => b.message)))
    log('   提醒=' + JSON.stringify((pre.data?.precheck?.warnings || []).map(w => w.message).slice(0, 2)))

    log('\n③ 打开发布页 + 预填')
    const opened = JSON.parse(await ui.eval('window.shopilot.products.publish.open(' + JSON.stringify({ itemId: pre.data.itemId, fill: true }) + ').then(r => JSON.stringify(r))'))
    log('   ' + String(opened.data?.safeMessage || '').slice(0, 140))

    log('\n④ 枚举所有可点元素（含向导按钮）')
    await sleep(9000)
    let page = null
    for (const t of await targets()) if (t.type === 'webview' && /goods\/entry/.test(t.url || '')) page = t
    if (!page) throw new Error('没找到发布页 webview')
    const probe = new CDP(page.webSocketDebuggerUrl); await probe.ready
    let raw = null
    for (let i = 0; i < 6 && !raw; i++) { raw = await probe.eval(ENUM).catch(() => null); if (!raw) await sleep(4000) }
    const r = JSON.parse(raw)
    log('   URL：' + r.url + '  正文长度=' + r.bodyLen)
    log('   <button>（' + r.buttons.length + '）：')
    for (const b of r.buttons.slice(0, 14)) log(`     "${b.text}" disabled=${b.disabled} cls=${b.cls}`)
    log('   <a>（' + r.links.length + '）：')
    for (const a of r.links.slice(0, 10)) log(`     "${a.text}" href=${a.href}`)
    log('   可点 div/span（' + r.clickables.length + '）：')
    for (const c of r.clickables.slice(0, 14)) log(`     "${c.text}" cls=${c.cls}`)
    log('   分步线索：' + JSON.stringify(r.steps.slice(0, 16)))
    log('   正文开头：' + r.bodyHead)
    fs.writeFileSync(path.join(OUT_DIR, 'publish-wizard-enum.json'), JSON.stringify({ testTitle, recon: r }, null, 2), 'utf8')
    log('\n   证据已存 artifacts/product-probe/publish-wizard-enum.json')

    log('\n⑤ 传一张**已本地化**的图（用 CDP 的 setFileInputFiles），再点「下一步」')
    const mediaRoot = path.join(process.env.APPDATA || '', 'shopilot', 'product-media')
    let imageFile = null
    let jpgFile = null
    if (fs.existsSync(mediaRoot)) {
      for (const dir of fs.readdirSync(mediaRoot)) {
        const full = path.join(mediaRoot, dir)
        if (!fs.statSync(full).isDirectory()) continue
        for (const n of fs.readdirSync(full)) {
          if (!/\.(webp|jpg|png|jpeg|gif)$/i.test(n)) continue
          if (!imageFile) imageFile = path.join(full, n)
          // **优先用 jpg/png**：三个 file input 的 accept 都含 jpg/png，而只有第 2 个含 webp。
          // 用 jpg 能排除"accept 过滤"这个变量（本地化的图里恰好有一张 jpg）。
          if (!jpgFile && /\.(jpg|jpeg|png)$/i.test(n)) jpgFile = path.join(full, n)
        }
      }
    }
    const useFile = jpgFile || imageFile
    if (!useFile) { log('   （磁盘上没有已本地化的图，跳过）'); return }
    log('   用图：' + useFile.slice(-58) + (jpgFile ? '（jpg：三个 input 都接受）' : '（只有 webp 可用）'))

    await probe.send('DOM.enable')
    // ⚠️ 不能用 `DOM.querySelectorAll`：它**不穿透 ShadowRoot**，而微信整页在 ShadowRoot 里
    // （实测：DOM 探针看到 3 个 input[type=file]，DOM.querySelectorAll 返回 0 个）。
    // 正确姿势：先用 Runtime.evaluate（穿透 ShadowRoot）拿到元素对象，再用 `DOM.setFileInputFiles`
    // 直接传 **objectId**（`DOM.requestNode` 实测返回 nodeId=0，拿不到真实节点）。
    //
    // **官方那条路**：不再自己找 input（前面三种姿势都栽在这里），
    // 而是拦截文件选择器 → 点上传区 → 让**平台自己告诉我们它要用哪个节点**（Page.fileChooserOpened 带 backendNodeId）。
    // 好处：不依赖 ShadowRoot 遍历，也绕开了 DOM.requestNode 返回 0 的问题。
    await probe.send('Page.enable')
    await probe.send('DOM.enable')
    let chooserNode = null
    probe.on('Page.fileChooserOpened', (params) => { chooserNode = params; log('   📥 捕获到文件选择器请求：backendNodeId=' + params.backendNodeId + ' mode=' + params.mode) })
    await probe.send('Page.setInterceptFileChooserDialog', { enabled: true })
    log('   已开启文件选择器拦截')

    // **逐个试候选**：上一轮我把"提示文字"当成了上传区，点了没反应。
    // 这次列出所有可能的投放区（可见图片、cursor:pointer 的小方块），**挨个点**，
    // 每点一个就检查有没有捕获到文件选择器请求 —— 让平台自己告诉我哪个是对的。
    const candidates = JSON.parse(await probe.eval(`(() => {
      const cap = 8000;
      const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
      const vis = (el) => { try { return el.getClientRects().length > 0 } catch { return false } };
      const own = (el) => { let s = ''; for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent; return s.replace(/\s+/g, ' ').trim() };
      const out = [];
      const push = (el, why) => {
        if (!vis(el)) return;
        const r = el.getBoundingClientRect();
        if (r.width < 30 || r.height < 30 || r.width > 400 || r.height > 400) return;
        const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
        if (x <= 0 || y <= 0) return;
        if (out.some(c => Math.abs(c.x - x) < 12 && Math.abs(c.y - y) < 12)) return;
        out.push({ why, text: own(el).slice(0, 18), x, y, w: Math.round(r.width), h: Math.round(r.height) });
      };
      // ① 可见的图片（主图上传位通常就是一个 img 或它的容器）
      for (const r of roots()) for (const el of r.querySelectorAll('img')) push(el.parentElement || el, 'img容器');
      // ② cursor:pointer 的小方块
      for (const r of roots()) for (const el of r.querySelectorAll('div,span,label,button')) {
        if (el.children.length > 3) continue;
        const cls = String(el.className || ''), style = String(el.getAttribute('style') || '');
        if (!/cursor:\s*pointer|upload|add|plus|pic|img/i.test(cls + style)) continue;
        push(el, 'cursor:pointer');
      }
      return JSON.stringify(out.slice(0, 12));
    })()`))
    log('   投放区候选（' + candidates.length + ' 个）：')
    for (const c of candidates) log(`     ${c.why} "${c.text}" (${c.x},${c.y}) ${c.w}x${c.h}`)

    for (const c of candidates) {
      chooserNode = null
      await probe.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 })
      await probe.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 })
      await sleep(3500)
      if (chooserNode?.backendNodeId) {
        log(`   ✅ 点 ${c.why} "${c.text}" (${c.x},${c.y}) 捕获到文件选择器 backendNodeId=${chooserNode.backendNodeId}`)
        try {
          await probe.send('DOM.setFileInputFiles', { files: [useFile], backendNodeId: chooserNode.backendNodeId })
          log('   ✅ 已把文件投给平台指定的节点')
        } catch (error) {
          log('   投给 backendNodeId 失败：' + String(error && error.message || error).slice(0, 120))
        }
        break
      } else {
        log(`   · 点 ${c.why} "${c.text}" (${c.x},${c.y}) 没有文件选择器请求`)
      }
    }
    await sleep(15000)
    const uploaded = await probe.eval(`(() => {
      const cap = 8000;
      const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
      let count = 0, files = 0;
      for (const r of roots()) for (const el of r.querySelectorAll('input[type=file]')) { count++; files += (el.files ? el.files.length : 0) }
      const imgs = [];
      for (const r of roots()) for (const el of r.querySelectorAll('img')) { if (!el.getClientRects().length) continue; const w = el.getBoundingClientRect().width; if (w >= 40) imgs.push(Math.round(w)) }
      return JSON.stringify({ fileInputs: count, filesSelected: files, visibleImgs: imgs.slice(0, 8) });
    })()`)
    log('   上传后页面状态：' + uploaded)

    // 点「下一步」（向导导航，不是提交）
    const clicked = await probe.eval(`(() => {
      const cap = 8000;
      const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
      for (const r of roots()) {
        for (const el of r.querySelectorAll('button')) {
          const t = String(el.innerText || '').replace(/\\s+/g, '').trim();
          if (t !== '下一步') continue;
          if (!el.getClientRects().length) continue;
          el.click(); return JSON.stringify({ clicked: t, disabled: el.disabled });
        }
      }
      return JSON.stringify({ clicked: null });
    })()`)
    log('   点击结果：' + clicked)
    await sleep(12000)

    const after = JSON.parse(await probe.eval(ENUM))
    log('   第二屏 URL：' + after.url + '  正文长度=' + after.bodyLen)
    log('   第二屏 <button>：' + JSON.stringify(after.buttons.slice(0, 10).map(b => b.text + (b.disabled ? '(disabled)' : ''))))
    log('   第二屏分步线索：' + JSON.stringify(after.steps.slice(0, 18)))
    log('   第二屏可点 div/span：' + JSON.stringify(after.clickables.slice(0, 12).map(c => c.text)))
    const afterInputs = await probe.eval(`(() => {
      const cap = 8000;
      const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
      const out = {};
      for (const r of roots()) { for (const el of r.querySelectorAll('input,textarea')) { if (!el.getClientRects().length) continue; const ph = String(el.getAttribute('placeholder') || '').replace(/\\s+/g,' ').trim(); if (ph) out[ph] = (out[ph] || 0) + 1 } }
      return JSON.stringify(out);
    })()`)
    log('   第二屏输入框占位符：' + afterInputs)
    fs.writeFileSync(path.join(OUT_DIR, 'publish-wizard-step2.json'), JSON.stringify({ imageFile, after, inputs: afterInputs }, null, 2), 'utf8')
    log('   证据已存 artifacts/product-probe/publish-wizard-step2.json')
    log('\n=== 注意：点的是「下一步」（向导导航），**没有点提交** ===')
  } finally {
    try {
      const ui = await findRenderer(10000)
      if (productId) { await ui.eval('window.shopilot.products.library.remove(' + JSON.stringify(productId) + ').then(() => 1)'); log('\n↩ 已软删测试商品（平台上仍未创建任何东西）') }
    } catch (e) { log('\n清理失败：' + String(e && e.message || e)) }
    killTree(child)
    await sleep(1200)
  }
}

main().catch(e => { console.error('\n侦察失败:', (e && e.message) || e); process.exitCode = 1 })
