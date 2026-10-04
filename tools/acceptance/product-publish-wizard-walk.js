/**
 * 发布向导：传 3 张主图 → 点「下一步」→ 看第二屏（**仍然不点提交**）
 *
 * 上一轮验证通的链路（四轮失败换来的）：
 *   点「+」(需 mouseMoved 前置 + 80ms 间隔)
 *     → Page.setInterceptFileChooserDialog 捕获 Page.fileChooserOpened
 *     → 拿到**平台自己指定的** backendNodeId
 *     → DOM.setFileInputFiles({ files, backendNodeId })
 *     → 图片出现在页面上
 *
 * 本步目标：把第一步填满（主图 ≥3 张），让「下一步」变成可点，进入第二屏。
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.join(__dirname, '..', '..')
const PORT = Number(process.argv[2] || 9294)
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const DB_PATH = path.join(process.env.APPDATA || '', 'shopilot', 'shopilot.db')
const MEDIA_ROOT = path.join(process.env.APPDATA || '', 'shopilot', 'product-media')
const OUT_DIR = path.join(ROOT, 'artifacts', 'product-probe')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(...a)

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.listeners = new Map()
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); return }
      if (m.method && this.listeners.has(m.method)) for (const cb of this.listeners.get(m.method)) { try { cb(m.params) } catch { /* ignore */ } }
    }
  }
  on(method, handler) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(handler) }
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id
    return new Promise((res, rej) => {
      // ⚠️ **必须有超时**（2026-10-01 实测踩到）：webview 目标被销毁后 WebSocket 关闭，
      // 挂起的 Promise 永远不 settle，事件循环随之空转 —— Node 会**以 exit 0 静默退出**，
      // 日志戛然而止、后面的阶段一个都跑不到（上一轮"⑦ 段没跑到"就是这么来的）。
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rej(new Error(method + ': 超时（目标可能已销毁）'))
      }, timeoutMs)
      this.pending.set(id, m => {
        clearTimeout(timer)
        if (m.error) rej(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 110)))
        else res(m.result)
      })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        rej(error)
      }
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

/** 找「+」上传位：122×122 的方框里**最靠右**的那个（上传后新空位在右边）。 */
const FIND_SLOT = `(() => {
  const cap = 8000;
  const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
  const vis = (el) => { try { return el.getClientRects().length > 0 } catch { return false } };
  const cands = [];
  for (const r of roots()) {
    for (const el of r.querySelectorAll('div,span')) {
      if (el.children.length > 3) continue;
      if (!vis(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 100 || rect.width > 150 || rect.height < 100 || rect.height > 150) continue;
      cands.push({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), w: Math.round(rect.width), h: Math.round(rect.height) });
    }
  }
  if (!cands.length) return JSON.stringify({ found: false });
  cands.sort((a, b) => b.x - a.x);
  return JSON.stringify({ found: true, slot: cands[0], total: cands.length });
})()`

/** 页面上的状态：主图计数、校验提示、下一步是否可点。 */
const STATE = `(() => {
  const cap = 8000;
  const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
  const vis = (el) => { try { return el.getClientRects().length > 0 } catch { return false } };
  // ⚠️ **必须穿透 ShadowRoot 读文本**（2026-10-01 实测踩到）：document.body.innerText
  // 读不到 ShadowRoot 内容，而微信整页在 ShadowRoot 里 —— 之前这里恒为 null，
  // 我据此误判过"主图计数读不到"。这是文档 §12.7 记的那条坑，这里是我自己代码里漏掉的一处。
  let text = '';
  for (const r of roots()) { try { text += ' ' + String(r.textContent || '') } catch { /* ignore */ } }
  const body = text.split(/[\s\u3000]+/).join(' ');
  // 不用正则解析「1:1 主图 N/9」——嵌套模板字面量里的正则需要两层转义（踩过一次）。
  let count = null;
  const mi = body.indexOf('主图');
  if (mi >= 0) {
    const seg = body.slice(mi, mi + 26);
    const slash = seg.indexOf('/');
    if (slash > 0) {
      let left = '';
      for (let k = slash - 1; k >= 0; k--) { const c = seg[k]; if (c >= '0' && c <= '9') left = c + left; else break }
      let right = '';
      for (const c of seg.slice(slash + 1)) { if (c >= '0' && c <= '9') right += c; else if (right) break }
      if (left && right) count = left + '/' + right;
    }
  }
  const errors = [];
  for (const m of body.matchAll(/(错误|建议)\\s*([^]{0,40}?)(?=错误|建议|商品标题|$)/g)) errors.push(m[1] + ': ' + m[2].trim());
  let nextDisabled = null;
  for (const r of roots()) for (const el of r.querySelectorAll('button')) {
    if (!vis(el)) continue;
    if (String(el.innerText || '').replace(/\\s+/g, '') !== '下一步') continue;
    const cls = String(el.className || '');
    nextDisabled = el.disabled === true || /disabled|weui-desktop-btn_disabled/i.test(cls);
  }
  return JSON.stringify({ 主图计数: count ? count[1] + '/9' : null, 提示: errors.slice(0, 4), 下一步禁用: nextDisabled });
})()`

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  log('=== 传 3 张主图 → 点「下一步」（不点提交）===')
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

    // 收集本地已本地化的图（优先 jpg/png）
    const images = []
    if (fs.existsSync(MEDIA_ROOT)) {
      for (const dir of fs.readdirSync(MEDIA_ROOT)) {
        const full = path.join(MEDIA_ROOT, dir)
        if (!fs.statSync(full).isDirectory()) continue
        for (const n of fs.readdirSync(full)) if (/\.(jpg|jpeg|png|webp)$/i.test(n)) images.push(path.join(full, n))
      }
    }
    images.sort((a, b) => (/\.(jpg|jpeg|png)$/i.test(a) ? -1 : 1) - (/\.(jpg|jpeg|png)$/i.test(b) ? -1 : 1))
    if (images.length < 3) throw new Error('本地化图片不足 3 张：' + images.length)

    await ui.eval('window.shopilot.browser.open(' + JSON.stringify(store.id) + ')')
    await sleep(7000)

    const stamp = new Date().toISOString().slice(5, 16).replace(/[:T]/g, '')
    const testTitle = '【自动化验收请勿购买】三图 ' + stamp
    const created = JSON.parse(await ui.eval('window.shopilot.products.library.saveAsLocal(' + JSON.stringify({ platform: '微信小店', storeId: link.store_id, platformProductId: link.platform_product_id, mergeLink: false }) + ').then(r => JSON.stringify(r))'))
    productId = created?.data?.productId || null
    if (!productId) throw new Error('另存为失败')
    const got = JSON.parse(await ui.eval('window.shopilot.products.library.get(' + JSON.stringify(productId) + ').then(r => JSON.stringify(r))'))
    await ui.eval('window.shopilot.products.library.save(' + JSON.stringify({ productId, draft: { ...got.data.draft, title: testTitle } }) + ').then(r => JSON.stringify(r))')
    log('标题：' + testTitle)

    const pre = JSON.parse(await ui.eval('window.shopilot.products.publish.preflight(' + JSON.stringify({ productId, storeIds: [store.id] }) + ').then(r => JSON.stringify(r))'))
    log('预检：' + pre.data?.precheck?.verdict + ' 阻断=' + JSON.stringify((pre.data?.precheck?.blockers || []).map(b => b.message)))
    await ui.eval('window.shopilot.products.publish.open(' + JSON.stringify({ itemId: pre.data.itemId, fill: true }) + ').then(r => JSON.stringify(r))')

    // ⚠️ **轮询等 webview，不要"固定等 12 秒 + 只查一次"**（2026-10-02 修）：
    // 原写法在 12 秒后查一次，查不到就抛 `没找到发布页 webview` ——
    // 打开页面偶尔需要更久（或 URL 还没跳到 /goods/entry），于是**整轮白跑**。
    // 这是本项目最贵的不确定性：每失败一次就损失一整轮（真机跑一次约 10 分钟）。
    let page = null
    for (let i = 1; i <= 30; i++) {
      for (const t of await targets()) if (t.type === 'webview' && /goods\/entry/.test(t.url || '')) page = t
      if (page) { log(`   ✅ 发布页 webview 就绪（等了约 ${i * 2} 秒）`); break }
      if (i % 5 === 0) log(`   还在等发布页 webview…（${i * 2} 秒）`)
      await sleep(2000)
    }
    if (!page) {
      const all = (await targets()).filter(t => t.type === 'webview').map(t => (t.url || '').slice(0, 70))
      throw new Error('没找到发布页 webview（等了 60 秒；当前 webview：' + (all.length ? all.join(' | ') : '无') + '）')
    }
    const probe = new CDP(page.webSocketDebuggerUrl); await probe.ready
    await probe.send('Page.enable')
    await probe.send('DOM.enable')
    // ⚠️ **把视口调宽**（2026-10-02 修，这是"关不掉弹窗"的真正解法）：
    // 截图证明**弹窗比视口宽**——778 宽的视口里，弹窗的右侧（含那个 ✕）**在屏幕之外**，
    // 所以怎么点都点不到（点的是弹窗主体）。多轮"found 时有时无"也源于此：
    // 视口宽 1054 的那几轮 ✕ 可见（x=957），窄的那几轮在屏外。
    // 用 CDP 直接把视口设宽，不必去改窗口大小。
    await probe.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => null)
    await sleep(1500)

    let chooser = null
    probe.on('Page.fileChooserOpened', (params) => { chooser = params })
    await probe.send('Page.setInterceptFileChooserDialog', { enabled: true })

    log('\n① 连传 3 张主图')
    for (let i = 0; i < 3; i++) {
      const found = JSON.parse(await probe.eval(FIND_SLOT))
      if (!found.found) { log(`   第 ${i + 1} 张：找不到上传位`); break }
      const { x, y, w, h } = found.slot
      chooser = null
      await probe.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await probe.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await sleep(80)
      await probe.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      await sleep(3500)
      if (!chooser?.backendNodeId) { log(`   第 ${i + 1} 张：点 (${x},${y}) ${w}x${h} 没触发选择器`); continue }
      const file = images[i]
      try {
        await probe.send('DOM.setFileInputFiles', { files: [file], backendNodeId: chooser.backendNodeId })
        log(`   第 ${i + 1} 张：点 (${x},${y}) → backendNodeId=${chooser.backendNodeId} → 投喂 …${file.slice(-26)}`)
      } catch (error) {
        log(`   第 ${i + 1} 张：投喂失败 ` + String(error && error.message || error).slice(0, 90))
      }
      await sleep(9000)
      await sleep(10000)
      // ⚠️ **不要重试**（2026-10-01 实测踩到）：上一版用 `主图计数 === null` 当"没生效"的判据，
      // 而那个值恒为 null → 把"成功"误判成"失败" → 重试 → **同一张图被上传 6 次** →
      // 触发平台的「主图重复」错误 → 「下一步」一直禁用。
      // 真相：**每一次投喂都真的上传成功了**。判据要换成**平台的提示文字**：
      //   提示从「请上传至少3张商品主图」变成「主图重复：第1、2张」就说明张数在增加。
      const state = JSON.parse(await probe.eval(STATE))
      log(`      第 ${i + 1} 张投喂后：` + JSON.stringify(state))
    }

    const shotA = await probe.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT_DIR, 'publish-3images.png'), Buffer.from(shotA.data, 'base64'))
    log('   截图已存 artifacts/product-probe/publish-3images.png')

    log('\n② 点「下一步」')
    const before = JSON.parse(await probe.eval(STATE))
    log('   点击前：' + JSON.stringify(before))
    const clicked = await probe.eval(`(() => {
      const cap = 8000;
      const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
      for (const r of roots()) for (const el of r.querySelectorAll('button')) {
        if (String(el.innerText || '').replace(/\\s+/g, '') !== '下一步') continue;
        if (!el.getClientRects().length) continue;
        el.click(); return JSON.stringify({ clicked: true, cls: String(el.className || '').slice(0, 60) });
      }
      return JSON.stringify({ clicked: false });
    })()`)
    log('   点击：' + clicked)
    await sleep(12000)

    const after = JSON.parse(await probe.eval(STATE))
    log('   点击后：' + JSON.stringify(after))
    const buttons = await probe.eval(`(() => {
      const cap = 8000;
      const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
      const out = [];
      for (const r of roots()) for (const el of r.querySelectorAll('button')) { if (!el.getClientRects().length) continue; out.push(String(el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 14)) }
      return JSON.stringify(out.slice(0, 12));
    })()`)
    log('   页面按钮：' + buttons)
    const ph = await probe.eval(`(() => {
      const cap = 8000;
      const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
      const out = {};
      for (const r of roots()) for (const el of r.querySelectorAll('input,textarea')) { if (!el.getClientRects().length) continue; const p = String(el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim(); if (p) out[p] = (out[p] || 0) + 1 }
      return JSON.stringify(out);
    })()`)
    log('   输入框占位符：' + ph)
    const shotB = await probe.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT_DIR, 'publish-step2.png'), Buffer.from(shotB.data, 'base64'))
    log('   截图已存 artifacts/product-probe/publish-step2.png')

    log('\n③ 滚到第二屏下方（价格/库存/规格应该在这儿）')
    for (let i = 0; i < 5; i++) {
      await probe.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 520, y: 400, deltaX: 0, deltaY: 520 })
      await sleep(1200)
    }
    await sleep(2500)

    // 把"看得见的表单结构"读出来：标签 + 输入框 + 下拉 + 按钮
    const formDump = await probe.eval(`(() => {
      const cap = 8000;
      const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
      const vis = (el) => { try { return el.getClientRects().length > 0 } catch { return false } };
      const own = (el) => { let s = ''; for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent; return s.replace(/\\s+/g, ' ').trim() };
      const labels = [];
      for (const r of roots()) for (const el of r.querySelectorAll('label,div,span')) {
        if (el.children.length > 1) continue;
        const t = own(el);
        if (!t || t.length > 16) continue;
        if (!vis(el)) continue;
        if (!/价格|库存|规格|重量|尺寸|运费|发货|上架|下架|限购|编号|条码|单位/.test(t)) continue;
        const rect = el.getBoundingClientRect();
        labels.push({ t: t.slice(0, 16), y: Math.round(rect.y), x: Math.round(rect.x) });
      }
      labels.sort((a, b) => a.y - b.y || a.x - b.x);
      const inputs = [];
      for (const r of roots()) for (const el of r.querySelectorAll('input,textarea')) {
        if (!vis(el)) continue;
        const rect = el.getBoundingClientRect();
        inputs.push({ ph: String(el.getAttribute('placeholder') || '').slice(0, 24), y: Math.round(rect.y), x: Math.round(rect.x), w: Math.round(rect.width) });
      }
      inputs.sort((a, b) => a.y - b.y || a.x - b.x);
      const btns = [];
      for (const r of roots()) for (const el of r.querySelectorAll('button')) {
        if (!vis(el)) continue;
        btns.push(String(el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 12));
      }
      return JSON.stringify({ labels: labels.slice(0, 24), inputs: inputs.slice(0, 20), btns: btns.slice(0, 10) });
    })()`)
    const dump = JSON.parse(formDump)
    log('   标签（含"价格/库存/规格"等关键词）：')
    for (const l of dump.labels) log(`     y=${String(l.y).padStart(4)} x=${String(l.x).padStart(4)}  "${l.t}"`)
    log('   输入框：')
    for (const i of dump.inputs) log(`     y=${String(i.y).padStart(4)} x=${String(i.x).padStart(4)} w=${i.w}  ph="${i.ph}"`)
    log('   按钮：' + JSON.stringify(dump.btns))
    const shotC = await probe.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT_DIR, 'publish-step2-scrolled.png'), Buffer.from(shotC.data, 'base64'))
    log('   截图已存 artifacts/product-probe/publish-step2-scrolled.png')

    log('\n④ 填价格 + 库存（用 React/Vue 认的方式：原生 setter + input/change 事件）')
    const filled = await probe.eval(`(() => {
      const cap = 8000;
      const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const fill = (ph, value) => {
        for (const r of roots()) for (const el of r.querySelectorAll('input')) {
          if (String(el.getAttribute('placeholder') || '').trim() !== ph) continue;
          if (!el.getClientRects().length) continue;
          el.focus();
          setter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.blur();
          return el.value;
        }
        return null;
      };
      return JSON.stringify({ 价格: fill('输入售卖价格', '0.01'), 库存: fill('输入库存', '1') });
    })()`)
    log('   填入结果：' + filled)
    await sleep(4000)
    log('   回读：' + await probe.eval(`(() => {
      const cap = 8000;
      const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
      const out = {};
      for (const r of roots()) for (const el of r.querySelectorAll('input')) {
        const ph = String(el.getAttribute('placeholder') || '').trim();
        if (ph === '输入售卖价格' || ph === '输入库存') out[ph] = el.value;
      }
      return JSON.stringify(out);
    })()`))

    log('\n⑤ 滚到底部，找「上架」并**点一次**（这是第一次真正的提交）')
    for (let i = 0; i < 12; i++) {
      await probe.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 520, y: 400, deltaX: 0, deltaY: 700 })
      await sleep(700)
    }
    await sleep(2500)
    const beforeSubmit = await probe.eval(`(() => {
      const cap = 8000;
      const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
      const btns = [];
      for (const r of roots()) for (const el of r.querySelectorAll('button')) {
        if (!el.getClientRects().length) continue;
        btns.push({ t: String(el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 12), disabled: el.disabled === true, cls: String(el.className || '').slice(0, 70) });
      }
      const body = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ');
      const errs = [];
      for (const m of body.matchAll(/(错误|必填|请选择|请填写|请上传)[^]{0,34}/g)) errs.push(m[0].trim());
      return JSON.stringify({ url: location.href, btns: btns.slice(0, 12), errs: [...new Set(errs)].slice(0, 8) });
    })()`)
    log('   提交前：' + beforeSubmit)

    const submitResult = await probe.eval(`(() => {
      const cap = 8000;
      const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
      for (const r of roots()) for (const el of r.querySelectorAll('button')) {
        const t = String(el.innerText || '').replace(/\\s+/g, '').trim();
        if (t !== '上架') continue;
        if (!el.getClientRects().length) continue;
        el.click();
        return JSON.stringify({ clicked: true, cls: String(el.className || '').slice(0, 70) });
      }
      return JSON.stringify({ clicked: false });
    })()`)
    log('   ⚠️ 已点击「上架」：' + submitResult)

    // **立刻抓弹窗**（2026-10-02 补）：弹窗只在点「上架」后极短的一瞬出现 ——
    // 原来等 20 秒才去看，那时它早就不在了（§12.13）。这里每 400ms 抓一次、最多 10 秒。
    // 判据用**可靠的**那套：可见 + elementFromPoint 命中（§12.13 的第三版判据）。
    // 读出来的**当次清单**才是要填的东西 —— 不能写死（§12.12：清单每次不同）。
    const readModal = async () => JSON.parse(await probe.eval(`(() => {
      const cap = 12000;
      const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
      const vis = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 } catch { return false } };
      const hits = (el) => { const rect = el.getBoundingClientRect(); const cx = Math.round(rect.x + rect.width / 2), cy = Math.round(rect.y + rect.height / 2); const top = document.elementFromPoint(cx, cy); let n = el, hop = 0; while (n && hop++ < 40) { if (n === top) return true; const root = n.getRootNode && n.getRootNode(); n = (root && root.host) ? root.host : n.parentElement } return false };
      for (const r of roots()) {
        let els; try { els = r.querySelectorAll('div,section') } catch { continue }
        for (const el of els) {
          if (el.children.length > 6) continue;
          if (!String(el.textContent || '').includes('商品信息待调整')) continue;
          if (!vis(el)) continue;
          if (!hits(el)) continue;
          const flat = String(el.textContent || '').replace(/\\s+/g, ' ').trim();
          return JSON.stringify({ open: true, 全文: flat.slice(0, 600) });
        }
      }
      return JSON.stringify({ open: false });
    })()`).catch(() => ({ open: false })))
    let modalSeen = { open: false }, pollAt = 0
    for (let i = 0; i < 25; i++) {
      const m = await readModal()
      if (m.open) { modalSeen = m; pollAt = i * 400; break }
      await sleep(400)
    }
    if (modalSeen.open) {
      log(`   ✅ +${pollAt}ms 抓到弹窗，当次必填清单（**要照这个填，不能写死**）：`)
      log('      ' + String(modalSeen.全文 || '').slice(0, 560))
      const shotM = await probe.send('Page.captureScreenshot', { format: 'png' }, 15000).catch(() => null)
      if (shotM) { fs.writeFileSync(path.join(OUT_DIR, 'publish-modal-immediate.png'), Buffer.from(shotM.data, 'base64')); log('      截图已存 artifacts/product-probe/publish-modal-immediate.png') }
      // **在窗口内立刻点 ✕**（2026-10-02 补）：弹窗约 9.6 秒出现、20 秒前就没了（§12.13 之后的实测）。
      // 原来 step ⑦ 等 20 秒才去找 ✕，那时弹窗早没了 —— 判据报"否"其实是**对的**。
      // 所以把"点 ✕"压进这个窗口：抓到就立刻点，点完再查一次。
      {
        // **动态取 ✕ 的坐标**（2026-10-02 修）：原来硬编码 (957,64)，那是**另一轮**（视口宽 1054）测到的；
        // 这一轮视口只有 778 宽，✕ 在约 x=720 —— 点在视口外，什么都没点到。
        // **视口宽度每轮都变，坐标绝不能硬编码。**
        const closeHit = JSON.parse(await probe.eval(`(() => {
          const cap = 12000;
          const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
          const vis = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth } catch { return false } };
          for (const r of roots()) {
            let els; try { els = r.querySelectorAll('[class*="dialog-close"], [class*="icon-close"]') } catch { continue }
            for (const el of els) {
              if (!vis(el)) continue;
              const rect = el.getBoundingClientRect();
              const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : (el.className || ''));
              return JSON.stringify({ found: true, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), cls: cls.slice(0, 44), w: Math.round(rect.width), h: Math.round(rect.height), vw: innerWidth });
            }
          }
          return JSON.stringify({ found: false, vw: innerWidth });
        })()`))
        log('      动态找关闭按钮：' + JSON.stringify(closeHit))
        // 类名匹配不到时**按截图实测的相对位置兜底**（2026-10-02）：
        // `publish-modal-immediate.png` 是 778x757（与视口 1:1），里面的 ✕ 在约 (720, 79)
        // → **距右边缘约 58px、距顶约 79px**。用视口宽度推算，就不怕视口宽度变化了。
        const bx = closeHit.found ? closeHit.x : (closeHit.vw || 778) - 58
        const by = closeHit.found ? closeHit.y : 79
        if (!closeHit.found) log(`      类名没匹配到，用相对位置兜底：(${bx}, ${by})（视口宽 ${closeHit.vw}）`)
        await probe.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bx, y: by })
        await sleep(80)
        await probe.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bx, y: by, button: 'left', clickCount: 1 })
        await sleep(80)
        await probe.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bx, y: by, button: 'left', clickCount: 1 })
        await sleep(1200)
        const after = await readModal()
        log('      窗口内点 ✕ 之后：弹窗还在吗？' + (after.open ? '**还在**' : '✅ 已关掉'))
        const shotC = await probe.send('Page.captureScreenshot', { format: 'png' }, 15000).catch(() => null)
        if (shotC) { fs.writeFileSync(path.join(OUT_DIR, 'publish-modal-after-close.png'), Buffer.from(shotC.data, 'base64')); log('      截图已存 artifacts/product-probe/publish-modal-after-close.png') }
      }
    } else {
      log(`   （10 秒内没抓到弹窗 —— 可能提交过了，或弹窗更短）`)
    }

    log('\n⑥ 观察平台返回（等 20 秒，看 URL / 提示 / 报错）')
    await sleep(20000)
    const afterSubmit = await probe.eval(`(() => {
      const body = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ');
      return JSON.stringify({ url: location.href, title: document.title, bodyHead: body.slice(0, 300) });
    })()`).catch(() => null)
    log('   提交后页面：' + afterSubmit)
    const shotD = await probe.send('Page.captureScreenshot', { format: 'png' }, 15000).catch(() => null)
    if (shotD) {
      fs.writeFileSync(path.join(OUT_DIR, 'publish-after-submit.png'), Buffer.from(shotD.data, 'base64'))
      log('   截图已存 artifacts/product-probe/publish-after-submit.png')
    }

    // ---------------------------------------------------------------- ⑦ 补类目属性
    //
    // 平台弹窗给了 12 项「商品参数…为必填项」。它们都是「请选择」下拉，
    // 弹层结构我没见过 —— 用**通用策略**：找到下一个「请选择」→ 点开 → 点弹层里第一个可选项。
    // 先关掉那个"商品信息待调整"弹窗。
    log('\n⑦ 关掉提示弹窗（上一轮我用"取消/关闭"文案找按钮没找到，弹窗一直开着、遮罩把点击全吞了）')

    // 这个弹窗的关闭按钮是**右上角的 ✕**（截图实测约 (975,80)）。
    // 点完**必须用截图确认真的关了** —— 不看截图就不知道关没关（这一课已经上过两次）。
    // ⚠️ **必须穿透 ShadowRoot 读**（2026-10-01 实测踩到）：
    // 上一版用 `document.body.innerText.includes('商品信息待调整')` 判断，返回 false，
    // 而截图里弹窗明明还开着 —— 因为**微信整页在 ShadowRoot 里，innerText 读不到**。
    // 后果：我以为弹窗关了，去点下拉，结果点在遮罩层上（"点了没反应且不报错"）。
    // 这是本项目第三次栽在 ShadowRoot 边界上（前两次：querySelectorAll 找不到 file input、
    // 等 31 秒"表单没渲染"）。规律：**任何 DOM 读取都必须穿透 ShadowRoot，否则"空结果"是假的**。
    const ALL_TEXT = `(() => {
      const cap = 12000;
      const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
      let text = '';
      for (const r of roots()) { try { text += ' ' + String(r.textContent || '') } catch { /* ignore */ } }
      return text.replace(/\s+/g, ' ');
    })()`
    // ⚠️ **判据改成"可见的"文本**（2026-10-02 实测修正）：
    // 原来是把**所有** shadow 的 `textContent` 拼起来找"商品信息待调整"。但那段文字
    // **一直存在于 DOM 里**（隐藏的 dialog 容器/预渲染），所以它**永远报 open: true** ——
    // 截图证明页面上根本没有弹窗时，它照样说"还开着"。
    // 结果：下面那些"关弹窗"的尝试全都在点一个**隐藏的** `dialog-close`，当然没反应。
    // 现在只累加**可见**元素的文本，它才能如实反映弹窗在不在。
    const modalOpen = async () => JSON.parse(await probe.eval(`(() => {
      const cap = 12000;
      const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
      const vis = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 } catch { return false } };
      // 注意：本段代码整体位于一个**模板字符串**里，所以注释里**不能出现反引号**（会提前截断）。
      // getBoundingClientRect 宽高非零 != 用户看得见（2026-10-02 实测抓到）：
      // 元素可能被父级裁剪、被完全遮挡、或在视口外 —— rect 照样有值。
      // 可靠判据是 elementFromPoint：问"这个点上用户真正能点到的是什么"。
      // 元素在 micro-app 的 shadow 里时 document.elementFromPoint 只返回**宿主**，
      // 所以要把 el 的**祖先链**（跨 shadow 用 getRootNode().host 上溯）收集起来比对。
      const domPath = (el) => { const path = []; let n = el, hop = 0; while (n && hop++ < 40) { path.push(n); const root = n.getRootNode && n.getRootNode(); n = (root && root.host) ? root.host : n.parentElement } return path };
      let hit = '', proof = '';
      for (const r of roots()) {
        let els; try { els = r.querySelectorAll('div,section,h1,h2,h3,span,p') } catch { continue }
        for (const el of els) {
          // ⚠️ 形状要与下面的 readModal **一致**（2026-10-02 实测）：
          // readModal 用 children.length > 6 跳过，挑到的是**小容器**，覆盖检查能通过 → 能抓到弹窗；
          // 而这里曾经用 > 3（更严），后来又放开成不过滤（挑到 html/body 这类**大祖先**）——
          // 两种都导致覆盖检查失败、**报"未开"（假阴性）**，而截图证明弹窗明明开着。
          // 同一个判据在工具里有两份不一致的实现，这本身就是个坑。
          if (el.children.length > 6) continue;
          if (!vis(el)) continue;
          if (!String(el.textContent || '').includes('商品信息待调整')) continue;
          const rect = el.getBoundingClientRect();
          const cx = Math.round(rect.x + rect.width / 2), cy = Math.round(rect.y + rect.height / 2);
          const top = document.elementFromPoint(cx, cy);
          const covered = !!(top && (domPath(el).includes(top) || domPath(top).includes(el)));
          proof = '中心(' + cx + ',' + cy + ')处=' + (top ? (top.tagName + '.' + String(top.className || '').slice(0, 26)) : 'null') + ' 命中=' + covered;
          if (covered) hit = el.tagName + '.' + String(el.className || '').slice(0, 40);
          else proof += ' → **被遮挡/不在视口，判为未开**';
          break;
        }
        if (hit) break
      }
      return JSON.stringify({ open: !!hit, where: hit, proof, vh: innerHeight, vw: innerWidth });
    })()`))
    void ALL_TEXT
    let state0 = await modalOpen()
    log('   弹窗还开着吗？' + (state0.open ? '是 → 开始尝试关闭' : '否（无需关闭）'))
    if (state0.open) {
      // 路 1：Esc（模态弹窗通常支持）
      await probe.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
      await probe.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
      await sleep(2500)
      state0 = await modalOpen()
      log('   按 Esc 后还开着吗？' + (state0.open ? '还开着' : '✅ 已关闭（Esc 有效）'))

      // 路 2：程序化找关闭按钮（**穿透 ShadowRoot**，不按坐标点 —— 坐标点过一次没生效）
      if (state0.open) {
        const closed = await probe.eval(`(() => {
          const cap = 12000;
          const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
          const vis = (el) => { try { return el.getClientRects().length > 0 } catch { return false } };
          const cands = [];
          for (const r of roots()) {
            for (const el of r.querySelectorAll('i,span,div,button,svg')) {
              if (!vis(el)) continue;
              const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : (el.className || ''));
              const t = String(el.textContent || '').replace(/\s+/g, '').trim();
              const isClose = /close|icon-close|btn-close/i.test(cls) || t === '✕' || t === '×' || t === '✖';
              if (!isClose) continue;
              const rect = el.getBoundingClientRect();
              if (rect.width < 6 || rect.height < 6 || rect.width > 80 || rect.height > 80) continue;
              // **它属于哪个 dialog？**（2026-10-02 补）往上找最近的含 dialog/modal 的祖先，取它的文本前 20 字。
              // 页面上至少有 3 个 dialog 容器（dialog / specail_msg_dialog / feedback-form-modal），
              // 不确认归属就点，很可能一直在点**别的对话框的 ✕**。
              let dlg = '(没找到 dialog 祖先)';
              for (let p = el.parentElement, hop = 0; p && hop < 24; p = p.parentElement, hop++) {
                const pcls = String(p.className || '');
                if (/dialog|modal|popover|drawer/i.test(pcls)) {
                  dlg = String(p.textContent || '').replace(/\s+/g, '').slice(0, 20) + ' [' + pcls.slice(0, 26) + ']';
                  break;
                }
              }
              cands.push({ el, cls: cls.slice(0, 40), t, x: Math.round(rect.x), y: Math.round(rect.y), dlg });
            }
          }
          if (!cands.length) return JSON.stringify({ found: 0 });
          // 取最靠右上角的那个
          cands.sort((a, b) => (b.x + b.y) - (a.x + a.y));
          const target = cands[cands.length - 1];
          target.el.click();
          return JSON.stringify({ found: cands.length, clicked: { cls: target.cls, t: target.t, x: target.x, y: target.y, dlg: target.dlg }, 全部候选: cands.slice(0, 6).map(c => c.x + ',' + c.y + ' ' + c.cls.slice(0, 30) + ' → ' + c.dlg) });
        })()`)
        log('   程序化找关闭按钮：' + closed)
        // ⚠️ **`el.click()` 不生效，必须发真实鼠标事件**（2026-10-02 实测）：
        // 上面确实找到了 ✕（`dialog-close icon-[weui--xmark-regular]` @ 957,64），但 `el.click()` 点完弹窗仍开着。
        // 这与 §12.7 记录的是**同一个坑**（"Click on (164,298) did nothing; (169,303) worked"）：
        // 需要 **`mouseMoved` 前置 + 80ms 的 press→release 间隔**。
        try {
          const info = JSON.parse(closed)
          if (info.clicked && typeof info.clicked.x === 'number') {
            const cx = info.clicked.x + 8, cy = info.clicked.y + 8   // 元素左上角往内挪一点，确保落在 ✕ 上
            await probe.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy })
            await sleep(80)
            await probe.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 })
            await sleep(80)
            await probe.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })
            log(`   真实鼠标事件点击：已点 (${cx}, ${cy})`)
          } else {
            log('   真实鼠标事件点击：没找到可点的关闭按钮')
          }
        } catch (e) { log('   真实鼠标事件点击：解析失败 ' + e.message) }

        // ⚠️ 上面两种点击都没关掉弹窗，而且诊断里**没有**那个 `dialog-close` —— 两者冲突。
        // 别再猜"怎么点"，**直接问浏览器：这个坐标上到底是什么元素**（2026-10-02 补）。
        // `document.elementFromPoint` 不穿 shadow，所以要**逐层往下钻**（拿到元素 → 它有 shadowRoot 就再问一次）。
        try {
          const atPoint = await probe.eval(`(() => {
          const probeAt = (x, y) => {
            let root = document, el = null, chain = [];
            for (let i = 0; i < 12; i++) {
              el = root.elementFromPoint(x, y);
              if (!el) break;
              const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : (el.className || ''));
              chain.push(el.tagName + '.' + cls.slice(0, 44) + (el.textContent ? '|' + String(el.textContent).replace(/\\s+/g,'').trim().slice(0,10) : ''));
              if (!el.shadowRoot) break;
              root = el.shadowRoot;
            }
            return chain;
          };
          const pts = [[965, 72], [957, 64], [974, 79], [970, 70]];
          const out = {};
          for (const [x, y] of pts) out[x + ',' + y] = probeAt(x, y);
          // 顺带：当前有几个 dialog 容器、各自可见吗
          const cap = 12000; const roots = [document]; let n = 0;
          for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) roots.push(el.shadowRoot); if (++n >= cap) break }
          const dialogs = [];
          for (const r of roots()) for (const d of r.querySelectorAll('[class*="dialog"],[role="dialog"],[class*="modal"],[class*="weui-desktop-dialog"]')) {
            let rect; try { rect = d.getBoundingClientRect() } catch { continue }
            if (!rect || rect.width < 50) continue;
            const cls = String(d.className && d.className.baseVal !== undefined ? d.className.baseVal : (d.className || ''));
            const cs = getComputedStyle(d);
            dialogs.push({ cls: cls.slice(0, 50), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height), z: cs.zIndex, disp: cs.display, vis: cs.visibility, txt: String(d.textContent||'').replace(/\\s+/g,'').slice(0, 16) });
          }
          return JSON.stringify({ 坐标上的元素: out, dialog数: dialogs.length, dialogs: dialogs.slice(0, 5) });
        })()`)
        log('   elementFromPoint 诊断：' + atPoint)
        } catch (e) { log('   elementFromPoint 诊断失败（不影响后续）：' + (e && e.message ? e.message : String(e))) }

        // 最小版诊断（2026-10-02 补，替代上面那段"页面内异常"的复杂版）：
        // 只回答两个问题 —— ① (965,72) 在主文档里是什么元素；② 主文档里有哪些 dialog 容器。
        // **不遍历 shadow、页内自带 try/catch**，保证不会把脚本带崩。
        try {
          const simple = await probe.eval(`(() => {
            try {
              const at = document.elementFromPoint(965, 72);
              const dialogs = [];
              for (const el of document.querySelectorAll('div,section,aside')) {
                const cls = String(el.className || '');
                if (!/dialog|modal|mask|overlay/i.test(cls)) continue;
                const r = el.getBoundingClientRect();
                if (r.width < 40) continue;
                dialogs.push(cls.slice(0, 42) + ' @' + Math.round(r.x) + ',' + Math.round(r.y) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
              }
              return JSON.stringify({
                坐标上: at ? (at.tagName + '.' + String(at.className || '').slice(0, 42) + '|' + String(at.textContent || '').replace(/\\s+/g, '').slice(0, 12)) : 'null（主文档里没有元素 → 弹窗在 shadow 里）',
                dialog数: dialogs.length,
                dialogs: dialogs.slice(0, 6)
              });
            } catch (err) { return JSON.stringify({ err: String((err && err.message) || err) }) }
          })()`)
          log('   最小诊断：' + simple)
        } catch (e) { log('   最小诊断失败：' + (e && e.message ? e.message : String(e))) }
        // 诊断（2026-10-02 补）：上面按 class/文案找是 `found: 0`，说明那个 ✕ 既没有 close 类名、
        // 也没有 ✕/× 文本。**别再猜它长什么样** —— 把**右上角那块所有可点元素**原样打出来，
        // 看它到底是什么 tag/class。截图显示 ✕ 大约在 (974, 79)。
        const topRight = await probe.eval(`(() => {
          const cap = 12000;
          const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
          const out = [];
          for (const r of roots()) {
            for (const el of r.querySelectorAll('*')) {
              let rect; try { rect = el.getBoundingClientRect() } catch { continue }
              if (!rect || rect.width < 6 || rect.height < 6) continue;
              // 只看**右上角**那一片（弹窗 ✕ 的位置）
              if (rect.x < 880 || rect.y > 200) continue;
              const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : (el.className || ''));
              const t = String(el.textContent || '').replace(/\\s+/g, '').trim().slice(0, 14);
              out.push(el.tagName + '|' + cls.slice(0, 46) + '|' + t + '|' + Math.round(rect.x) + ',' + Math.round(rect.y) + '|' + Math.round(rect.width) + 'x' + Math.round(rect.height));
            }
          }
          return JSON.stringify({ n: out.length, list: out.slice(0, 24) });
        })()`)
        log('   右上角可点元素（诊断）：' + topRight)
        await sleep(2500)
        state0 = await modalOpen()
        log('   点完还开着吗？' + (state0.open ? '❌ 还开着' : '✅ 已关闭'))
      }
      const shotClose = await probe.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(OUT_DIR, 'publish-modal-closed.png'), Buffer.from(shotClose.data, 'base64'))
      log('   截图已存 artifacts/product-probe/publish-modal-closed.png')
    }
    const FIND_SELECT = `(() => {
      const cap = 8000;
      const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
      const vis = (el) => { try { return el.getClientRects().length > 0 } catch { return false } };
      for (const r of roots()) for (const el of r.querySelectorAll('div,span,input')) {
        if (el.children.length > 1) continue;
        const t = String(el.getAttribute('placeholder') || el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!/^请选择/.test(t)) continue;
        if (!vis(el)) continue;
        // ⚠️ **必须先滚进视口再读坐标**（2026-10-01 实测踩到）：
        // getBoundingClientRect 返回的是**相对视口**的坐标，元素在屏幕外时它是越界的
        // （实测 y=863 而视口只有 704px）。而 Input.dispatchMouseEvent 只往视口内投递 ——
        // 点在视口外**等于没点，且不报错**。上一轮"16 次都卡在同一项"就是这么来的：
        // 不是选错选项，是下拉压根没被点开。
        el.scrollIntoView({ block: 'center' });
        const rect = el.getBoundingClientRect();
        if (rect.width < 60) continue;
        const cx = Math.round(rect.x + rect.width / 2);
        const cy = Math.round(rect.y + rect.height / 2);
        // 滚完还是不在视口里就跳过（宁可不点，也不要往视口外瞎点）
        if (cy < 4 || cy > innerHeight - 4 || cx < 4 || cx > innerWidth - 4) continue;
        return JSON.stringify({ found: true, label: t.slice(0, 16), x: cx, y: cy, vh: innerHeight });
      }
      return JSON.stringify({ found: false });
    })()`

    // **先看一眼**（上一轮我又在猜弹层结构，16 次全卡在同一项）。
    // 这次：点开**一个**「请选择」→ 截图 → 把弹层里的元素坐标 dump 出来 → 停手。
    const found = JSON.parse(await probe.eval(FIND_SELECT))
    log('   第一个「请选择」：' + JSON.stringify(found))
    if (found.found) {
      await probe.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: found.x, y: found.y })
      // ⚠️ **`mouseMoved` 与 `mousePressed` 之间也要留间隔**（2026-10-02 补）：
      // 工具头上记的姿势是"mouseMoved **前置** + 80ms 的 press→release 间隔"，
      // 但原来的代码在 mouseMoved 之后**立刻**就 press —— 少了这个前置间隔。
      // 这正是"点开「请选择」但弹层没出现"的可疑原因（弹层候选里全是页面行，不是一个浮层）。
      await sleep(80)
      await probe.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: found.x, y: found.y, button: 'left', clickCount: 1 })
      await sleep(80)
      await probe.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: found.x, y: found.y, button: 'left', clickCount: 1 })
      log('   已点开「' + found.label + '」，等弹层…')
      await sleep(3500)
      // 弹层通常是新出现的浮层：把**视口内所有小尺寸可点文本**按 y 排出来，看哪一片是弹层
      const popup = await probe.eval(`(() => {
        const cap = 8000;
        const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
        const vis = (el) => { try { return el.getClientRects().length > 0 } catch { return false } };
        const own = (el) => { let s = ''; for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent; return s.replace(/\\s+/g, ' ').trim() };
        const rows = [];
        const seen = new Set();
        for (const r of roots()) for (const el of r.querySelectorAll('li,div,span,p,a')) {
          if (el.children.length > 1) continue;
          const t = own(el);
          if (!t || t.length > 24) continue;
          if (!vis(el)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 16 || rect.height < 12 || rect.width > 700) continue;
          if (rect.y < 0 || rect.y > 704 || rect.x < 0 || rect.x > 1054) continue;
          const key = Math.round(rect.x) + ',' + Math.round(rect.y) + ',' + t;
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push({ t: t.slice(0, 22), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
        }
        rows.sort((a, b) => a.y - b.y || a.x - b.x);
        // 弹层特征：一堆 y 接近、x 相同的短文本 —— 找出"同一列里连续 3 行以上"的那一片
        const groups = [];
        for (const row of rows) {
          const g = groups.find(g => Math.abs(g.x - row.x) < 30 && row.y - g.lastY < 60);
          if (g) { g.items.push(row); g.lastY = row.y } else groups.push({ x: row.x, lastY: row.y, items: [row] });
        }
        const listLike = groups.filter(g => g.items.length >= 3).sort((a, b) => b.items.length - a.items.length).slice(0, 3);
        return JSON.stringify({ total: rows.length, listLike: listLike.map(g => ({ x: g.x, n: g.items.length, sample: g.items.slice(0, 8).map(i => i.t + '@' + i.y) })) });
      })()`)
      log('   弹层候选（同一列连续 ≥3 行的文本片）：' + popup)
      const shotF = await probe.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(OUT_DIR, 'publish-dropdown-open.png'), Buffer.from(shotF.data, 'base64'))
      log('   截图已存 artifacts/product-probe/publish-dropdown-open.png')
    }
    log('   截图已存 artifacts/product-probe/publish-attributes.png')
    
    // ⚠️ **按当次清单填参数**（2026-10-02 补）：机制已验证（视口调宽 → 点「请选择」→ 弹层开 → 点选项）。
    // 这里把"填一个"推广成"填所有"：反复执行「找下一个还写着『请选择…』的控件 → 点开 → 点弹层里第一个选项」。
    // **不写死字段名**（§12.12：清单每次不同，三次分别 12/10/11 项），只按"控件当前显示『请选择…』"来判。
    log('\n⑧ 按当次清单填参数（每个都选弹层里的第一项）')
    const FIND_NEXT_SELECT = `(() => {
      const cap = 12000;
      const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
      // ⚠️ **「请选择」有两种形态，必须都覆盖**（2026-10-02 修，这是"找到 0 个控件"的原因）：
      //   形态 A：有文本的（如「请选择品牌」）—— 工具原有的 FIND_SELECT 只覆盖了这一种；
      //   形态 B：**input[placeholder^="请选择"]** —— 11 项必填参数里**多数是这个**，
      //           它的 textContent 是**空的**，所以按文本找**一个都匹配不到**。（本段在模板字符串里，注释不能用反引号）
      // 先扫 input，再扫有文本的。
      // 我原来加了 width>40 / height>14 / children<=2 这些额外约束，结果**一个控件都匹配不到**，
      // 而工具原有那套同一场景下能找到（found:true）。**同一个判据不要写两份不同的实现。**
      const vis = (el) => { try { return el.getClientRects().length > 0 } catch { return false } };
      for (const r of roots()) {
        let ins; try { ins = r.querySelectorAll('input[placeholder]') } catch { ins = [] }
        for (const el of ins) {
          const ph = String(el.getAttribute('placeholder') || '').replace(/\\s+/g, '');
          if (!/^请选择/.test(ph)) continue;
          if (!vis(el)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 20) continue;
          return JSON.stringify({ found: true, kind: 'input', x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), label: ph.slice(0, 12) });
        }
        let els; try { els = r.querySelectorAll('div,span') } catch { continue }
        for (const el of els) {
          const t = String(el.textContent || '').replace(/\\s+/g, '');
          if (!/^请选择/.test(t)) continue;
          if (!vis(el)) continue;
          const rect = el.getBoundingClientRect();
          return JSON.stringify({ found: true, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), label: t.slice(0, 12) });
        }
      }
      return JSON.stringify({ found: false });
    })()`
    // ⚠️ 选项要**限定在点击点下方的弹层区域**（2026-10-02 修）：
    // 原来筛 `li,div` 全页找、取最靠上的 —— 拿到的是**页面顶部的字段标签**「商品类目」，
    // 候选数 144/149 个（正常弹层只有几个）。必须按**位置**限定，不能按标签名全页找。
    const firstOptionAt = (cx, cy) => `(() => {
      const LO = ${cy} + 5, HI = ${cy} + 340, XW = 280;
      const cap = 12000;
      const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
      const vis = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 12 } catch { return false } };
      const cands = [];
      for (const r of roots()) {
        let els; try { els = r.querySelectorAll('li,div,span') } catch { continue }
        for (const el of els) {
          const t = String(el.textContent || '').replace(/\\s+/g, '');
          if (!t || t.length > 12) continue;
          if (el.children.length > 0) continue;
          if (!vis(el)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.y < LO || rect.y > HI) continue;
          if (Math.abs((rect.x + rect.width / 2) - ${cx}) > XW) continue;
          cands.push({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), t });
        }
      }
      cands.sort((a, b) => a.y - b.y);
      return JSON.stringify({ n: cands.length, first: cands[0] || null });
    })()`
    const _UNUSED_FIRST_OPTION = `(() => {
      const cap = 12000;
      const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
      const vis = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 12 } catch { return false } };
      const cands = [];
      for (const r of roots()) {
        let els; try { els = r.querySelectorAll('li,div') } catch { continue }
        for (const el of els) {
          const t = String(el.textContent || '').replace(/\\s+/g, '');
          if (!t || t.length > 10) continue;
          if (el.children.length > 1) continue;
          if (!vis(el)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.y < 60) continue;
          cands.push({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), t });
        }
      }
      cands.sort((a, b) => a.y - b.y);
      return JSON.stringify({ n: cands.length, first: cands[0] || null });
    })()`
    const clickAtPoint = async (x, y) => {
      await probe.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await sleep(80)
      await probe.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await sleep(80)
      await probe.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    }
    let filledCount = 0
    for (let i = 1; i <= 14; i++) {
      // **每轮开头先关掉弹窗**（2026-10-02 补，这是"填不上"的根因）：
      // 点表单控件会让平台**重新校验 → 弹窗再次出现**，盖住控件，之后所有点击都打在弹窗上
      // （Round 117 的截图证实）。三个零件都是现成的：可靠判据 + 动态取关闭按钮坐标 + 视口已调宽。
      for (let k = 0; k < 3; k++) {
        // **不检测，直接点**（2026-10-02 定案）：检测器（readModal/modalOpen）有**假阴性** ——
        // 截图明明有弹窗、它报"不在"（Round 119）；于是"先检测再动作"变成了"永远不动作"。
        // 而 ✕ 在视口调宽后位置稳定（约 innerWidth-58, 79），弹窗不在时点那里也无副作用。
        const hit = JSON.parse(await probe.eval(`(() => {
          const cap = 12000;
          const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
          const vis = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 } catch { return false } };
          for (const r of roots()) {
            let els; try { els = r.querySelectorAll('[class*="dialog-close"], [class*="icon-close"]') } catch { continue }
            for (const el of els) {
              if (!vis(el)) continue;
              const rect = el.getBoundingClientRect();
              if (rect.x < innerWidth * 0.5) continue;
              return JSON.stringify({ found: true, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
            }
          }
          return JSON.stringify({ found: false });
        })()`).catch(() => ({ found: false })))
        if (!hit.found) { hit.x = 0; hit.y = 79 }
        if (!hit.x) { const vw = await probe.eval('innerWidth').catch(() => 1440); hit.x = Number(vw) - 58 }
        await clickAtPoint(hit.x, hit.y)
        await sleep(1200)
      }
      const ctl = JSON.parse(await probe.eval(FIND_NEXT_SELECT).catch(() => '{"found":false}'))
      if (!ctl.found) { log('   没有更多「请选择」控件了（共填 ' + filledCount + ' 项）'); break }
      await clickAtPoint(ctl.x, ctl.y)
      await sleep(1500)
      // **点开之后立刻截图**（2026-10-02 补，照搬"立即抓弹窗"那套）：
      // 用来看清"点了「请选择」之后弹层到底开没开" —— 这一张图就能把问题分成两半：
      //   弹层开了 → 问题在"选选项"；没开 → 问题在"点击"（时序/坐标/需要 hover）。
      if (i === 1) {
        const shotDd = await probe.send('Page.captureScreenshot', { format: 'png' }, 15000).catch(() => null)
        if (shotDd) { fs.writeFileSync(path.join(OUT_DIR, 'publish-select-after-click.png'), Buffer.from(shotDd.data, 'base64')); log('      已截图：publish-select-after-click.png') }
        // **判定实验**（2026-10-02）：点一次控件后弹窗是否出现？关掉后再点一次，它还会出现吗？
        //   - 只在第一次出现 → 可绕开（点后检测+关闭+重试）
        //   - 每次都出现   → 程序化填充走不通（平台在阻止），这条链路的边界就在这里
        const mo1 = await readModal()
        log('      第 1 次点击后：弹窗' + (mo1.open ? '**在**' : '不在'))
        if (mo1.open) {
          const h1 = JSON.parse(await probe.eval(`(() => {
            const cap = 12000;
            const roots = () => { const rs = [document]; let n = 0; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) rs.push(el.shadowRoot); if (++n >= cap) break } return rs };
            const vis = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 } catch { return false } };
            for (const r of roots()) {
              let els; try { els = r.querySelectorAll('[class*="dialog-close"], [class*="icon-close"]') } catch { continue }
              for (const el of els) {
                if (!vis(el)) continue;
                const rect = el.getBoundingClientRect();
                if (rect.x < innerWidth * 0.5) continue;
                return JSON.stringify({ found: true, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
              }
            }
            return JSON.stringify({ found: false });
          })()`).catch(() => ({ found: false })))
          if (h1.found) { await clickAtPoint(h1.x, h1.y); await sleep(1200) }
          const mo2 = await readModal()
          log('      关掉后：弹窗' + (mo2.open ? '**还在**' : '已关掉'))
          await clickAtPoint(ctl.x, ctl.y)
          await sleep(1500)
          const mo3 = await readModal()
          log('      **第 2 次点击后：弹窗' + (mo3.open ? '又出现了（→ 每次点击都弹，程序化填充走不通）' : '没出现（→ 可绕开，加"点后检测+关闭+重试"即可）') + '**')
          const shotR = await probe.send('Page.captureScreenshot', { format: 'png' }, 15000).catch(() => null)
          if (shotR) { fs.writeFileSync(path.join(OUT_DIR, 'publish-select-after-reclick.png'), Buffer.from(shotR.data, 'base64')); log('      已截图：publish-select-after-reclick.png') }
        }
      }
      const opt = JSON.parse(await probe.eval(firstOptionAt(ctl.x, ctl.y)).catch(() => '{"n":0,"first":null}'))
      if (!opt.first) { log(`   「${ctl.label}」弹层里没找到选项，跳过`); continue }
      await clickAtPoint(opt.first.x, opt.first.y)
      await sleep(1200)
      // **进度检查**（2026-10-02 补）：填完再看一眼 —— 如果**同一位置**的控件还写着「请选择…」，
      // 说明这一项**没填上**。此时**中止并如实报数**，而不是继续空转。
      // 没有这个检查时，14 轮全在同一个控件上打转，还报了"共填了 14 项"（假成功 —— 实际 0 项）。
      {
        const still = JSON.parse(await probe.eval(FIND_NEXT_SELECT).catch(() => '{"found":false}'))
        if (still.found && Math.abs(still.x - ctl.x) < 6 && Math.abs(still.y - ctl.y) < 6) {
          log('   ⚠️ 这一项**没填上**（同一位置仍是「请选择…」）→ 中止，不再空转')
          log('   **实际填上的项数：' + filledCount + '（不是 ' + i + '）**')
          break
        }
      }
      filledCount++
      log(`   第 ${i} 项：「${ctl.label}」→ 选了「${opt.first.t}」（候选 ${opt.n} 个）`)
    }
    log('   共填了 ' + filledCount + ' 项')
    const shotF = await probe.send('Page.captureScreenshot', { format: 'png' }, 15000).catch(() => null)
    if (shotF) { fs.writeFileSync(path.join(OUT_DIR, 'publish-attributes-filled.png'), Buffer.from(shotF.data, 'base64')); log('   截图已存 artifacts/product-probe/publish-attributes-filled.png') }

log('\n=== 注意：只点了「下一步」（向导导航），**没有点提交** ===')
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
