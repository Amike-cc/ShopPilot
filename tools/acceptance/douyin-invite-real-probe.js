/**
 * 抖店达人邀约——真实平台探测（只读，不点邀约/不发送）。
 *
 * 用真实 userData 启动应用，通过 UI 打开抖店「1111」店铺与达人广场，
 * 然后对真实页面取证：登录态、类目筛选接口、级联弹层结构、行复选框、
 * 权威计数、等级下拉、搜索按钮、批量邀约按钮、抽屉结构。
 *
 * 用法：node tools/acceptance/douyin-invite-real-probe.js
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '../..')
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = process.env.SHOPILOT_REAL_CDP_PORT || '9251'
const STORE_NAME = process.env.SHOPILOT_DD_STORE || '1111'
const OUT = path.join(root, 'artifacts', 'real-douyin-probe.json')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function freeDebugPort(port) {
  if (process.platform !== 'win32') return
  try {
    const out = execSync(`netstat -ano | findstr LISTENING | findstr :${port}`, { encoding: 'utf8' })
    const pids = new Set(out.split(/\r?\n/).map(l => l.trim().split(/\s+/).pop()).filter(p => /^\d+$/.test(p)))
    for (const pid of pids) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) } catch { /* */ } }
  } catch { /* 没有占用 */ }
}

function focusAppWindow(pid) {
  if (process.platform !== 'win32' || !pid) return
  try {
    execSync(
      `powershell -NoProfile -Command "$w = New-Object -ComObject WScript.Shell; ` +
      `for ($i = 0; $i -lt 20; $i++) { if ($w.AppActivate(${pid})) { break }; Start-Sleep -Milliseconds 300 }"`,
      { stdio: 'ignore', timeout: 20000 }
    )
  } catch { /* */ }
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((ok, err) => { this.ws.onopen = ok; this.ws.onerror = err })
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data)
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result)
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression, awaitPromise = true) {
    await this.ready
    const r = await this.send('Runtime.evaluate', {
      expression: awaitPromise ? `(async () => { ${expression} })()` : expression,
      awaitPromise, returnByValue: true, userGesture: true
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  async shot(file) {
    await this.ready
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    return file
  }
  close() { try { this.ws.close() } catch { /* */ } }
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  return res.json()
}

async function waitForCDP(timeoutMs = 40000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) return } catch { /* retry */ }
    await sleep(400)
  }
  throw new Error('CDP endpoint not ready')
}

async function connectByUrl(part) {
  const list = await targets()
  const t = list.find(x => (x.type === 'page' || x.type === 'webview') && x.url.includes(part))
  if (!t) throw new Error('未找到页面目标: ' + part + '\n' + list.map(x => x.url.slice(0, 110)).join('\n'))
  const c = new CDP(t.webSocketDebuggerUrl)
  await c.ready
  return c
}

async function main() {
  const report = { startedAt: new Date().toISOString(), steps: [] }
  const note = (name, value) => { report.steps.push({ name, value }); console.log('##', name, '::', JSON.stringify(value)) }

  freeDebugPort(CDP_PORT)
  let app = null, ui = null, page = null
  try {
    app = spawn(electronExe, [
      '.', `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox',
      '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'
    ], {
      cwd: root, stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', SHOPILOT_DISABLE_CDP_FP: '1' }
    })

    await waitForCDP()
    focusAppWindow(app.pid)
    await sleep(2500)
    ui = await connectByUrl('/renderer/index.html')
    await ui.eval(`const until = Date.now() + 20000; while (!window.shopilot && Date.now() < until) await new Promise(r => setTimeout(r, 100)); return !!window.shopilot;`)

    // 找到抖店店铺 id
    const storeId = await ui.eval(`
      const r = await window.shopilot.store.list();
      const s = (r.data || []).find(x => x.name === ${JSON.stringify(STORE_NAME)});
      return s ? s.id : null;
    `)
    note('storeId', storeId)
    if (!storeId) throw new Error('未找到店铺 ' + STORE_NAME)

    // 打开店铺窗口
    await ui.eval(`await window.shopilot.browser.open(${JSON.stringify(storeId)}); return true;`)
    await sleep(2500)

    // 点开店铺卡片 → 任务页签 → 邀约面板
    await ui.eval(`
      const cards = [...document.querySelectorAll('.store-card')];
      const card = cards.find(x => x.textContent.includes(${JSON.stringify(STORE_NAME)}));
      if (card) (card.querySelector('.store-action') || card).click();
      await new Promise(r => setTimeout(r, 900));
      const taskTab = [...document.querySelectorAll('.ptab')].find(x => x.textContent.trim() === '任务');
      if (taskTab) taskTab.click();
      await new Promise(r => setTimeout(r, 400));
      const inviteTab = document.querySelector('[data-test="task-tab-invite"]');
      if (inviteTab) inviteTab.click();
      await new Promise(r => setTimeout(r, 500));
      return !!document.querySelector('[data-test="invite-panel"]');
    `)
    focusAppWindow(app.pid)

    // 面板信息：可用类目树（来自设置）与平台档案关键锚点
    const panel = await ui.eval(`
      const cat = document.querySelector('[data-test="invite-category"]');
      const tree = await window.shopilot.settings.get('invite.categoryTrees');
      const dd = tree.ok && tree.data && tree.data.value ? tree.data.value['抖店'] : null;
      return {
        categoryOptions: cat ? [...cat.options].map(o => o.value) : [],
        treeRoots: dd ? dd.map(n => n.name) : null,
        treeRootCount: dd ? dd.length : 0,
        grandchildrenCount: dd ? dd.filter(n => (n.grandchildren||[]).length).length : 0,
        panelReady: !!document.querySelector('[data-test="invite-start"]')
      };
    `)
    note('panel', panel)

    // 点「打开达人广场」（会导航 + 读三级类目）
    const openRes = await ui.eval(`
      const b = document.querySelector('[data-test="invite-open-page"]');
      if (!b) return { error: 'missing-open-page' };
      b.click();
      return { clicked: true };
    `)
    note('openPage', openRes)
    await sleep(6000)
    focusAppWindow(app.pid)

    // 等达人广场页面出现
    let pageTarget = null
    for (let i = 0; i < 30; i++) {
      const list = await targets()
      pageTarget = list.find(x => (x.type === 'page' || x.type === 'webview') && /jinritemai\.com/.test(x.url))
      if (pageTarget) break
      await sleep(1000)
    }
    note('squareTarget', pageTarget ? { url: pageTarget.url.slice(0, 160), title: pageTarget.title } : null)
    if (!pageTarget) throw new Error('达人广场页面未打开')

    page = new CDP(pageTarget.webSocketDebuggerUrl)
    await page.ready
    await sleep(2500)

    // ---- 1) 登录态与页面识别 ----
    const login = await page.eval(`
      const text = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ');
      return {
        url: location.href,
        title: document.title,
        loginWall: /请选择您要登录的角色|登录商家工作台|账号未登录|请重新登录/.test(text) || /roles-select|\\/login\\//.test(location.href),
        hasCategoryChip: !!document.querySelector('.quick-filter-button-enums'),
        chipCount: document.querySelectorAll('.quick-filter-button-enums .auxo-btn').length,
        chipNames: [...document.querySelectorAll('.quick-filter-button-enums .auxo-btn')].map(e => String(e.innerText || '').trim()).slice(0, 30),
        checkboxCount: document.querySelectorAll('tbody input[type=checkbox]').length,
        counter: (document.querySelector('.select_peoples_message') || {}).innerText || null,
        tableBody: !!document.querySelector('div.auxo-table-body'),
        rowKeyCount: document.querySelectorAll('[data-row-key]').length,
        levelTrigger: [...document.querySelectorAll('*')].some(e => String(e.innerText||'').trim() === '达人等级'),
        searchBtn: [...document.querySelectorAll('button,.auxo-btn')].some(e => String(e.innerText||'').trim() === '搜索'),
        batchInvite: [...document.querySelectorAll('button,.auxo-btn')].some(e => String(e.innerText||'').trim() === '批量邀约带货'),
        textHead: text.slice(0, 300)
      };
    `)
    note('square.page', login)
    await page.shot(path.join(root, 'artifacts', 'real-probe-square.png')).catch(() => null)

    // ---- 2) 类目筛选接口（应用自己的读取路径，只读） ----
    const api = await page.eval(`
      const pathname = location.pathname || '';
      const currentPrefix = pathname.startsWith('/ffa/buyin') ? '/ffa/buyin' : '';
      const prefixes = [...new Set([currentPrefix, '/ffa/buyin', ''])];
      const suffixes = ['/square_doudian_pc_api/square/filter', '/square_pc_api/square/filter'];
      const attempts = [];
      for (const prefix of prefixes) {
        for (const suffix of suffixes) {
          const url = prefix + suffix + '?type=1&req_scene=1';
          try {
            const res = await fetch(url, { method: 'GET', credentials: 'include', headers: { accept: 'application/json, text/plain, */*' } });
            const text = await res.text();
            let json = null; try { json = JSON.parse(text); } catch {}
            attempts.push({ url, status: res.status, code: json ? json.code : null, bytes: text.length, keys: json && json.data ? Object.keys(json.data) : null });
            if (json && json.code === 0) {
              const headers = (json.data && (json.data.headers || json.data.header)) || [];
              const cat = headers.find(h => /main_cate|主推类目/i.test([h && h.key, h && h.name, h && h.title, h && h.label, h && h.type].filter(Boolean).join(' ')));
              return { ok: true, attempts, headersCount: headers.length, headerKeys: headers.map(h => h && (h.key || h.title || h.name)),
                catHeader: cat ? JSON.parse(JSON.stringify(cat)).toString().length : 0,
                rawCat: cat ? cat : null };
            }
          } catch (err) { attempts.push({ url, error: String(err && err.message || err) }) }
        }
      }
      return { ok: false, attempts };
    `)
    note('square.filterApi', api)
    if (api && api.ok) {
      fs.writeFileSync(path.join(root, 'artifacts', 'real-douyin-filter-api.json'), JSON.stringify(api.rawCat, null, 2), 'utf8')
    }

    // ---- 3) 一级 chip 点击 → 级联弹层结构 ----
    const cascade = await page.eval(`
      const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
      const chips = [...document.querySelectorAll('.quick-filter-button-enums .auxo-btn')];
      const chip = chips.find(e => own(e) === '个护家清') || chips[0];
      if (!chip) return { error: 'no-chip' };
      chip.scrollIntoView({ block: 'center' });
      chip.click();
      await new Promise(r => setTimeout(r, 1200));
      const popovers = [...document.querySelectorAll('.quick-filter-cascader-popover')];
      const visible = popovers.filter(p => { const r = p.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const vis = visible[0] || popovers[0];
      const items = vis ? [...vis.querySelectorAll('li.auxo-cascader-menu-item')].map(li => ({
        text: String(li.innerText || '').replace(/\\s+/g, ' ').trim(),
        own: own(li),
        expand: li.className.includes('expand'),
        hasChildrenUl: !!li.querySelector('ul')
      })) : [];
      return {
        chipText: own(chip),
        popoverCount: popovers.length,
        visiblePopoverCount: visible.length,
        popoverRect: vis ? (r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }))(vis.getBoundingClientRect()) : null,
        itemCount: items.length,
        items: items.slice(0, 40)
      };
    `)
    note('square.cascade', cascade)
    await page.shot(path.join(root, 'artifacts', 'real-probe-cascade.png')).catch(() => null)

    // ---- 4) 二级（有下级的）真实点击后 → 三级列 ----
    const third = await page.eval(`
      const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
      const popovers = [...document.querySelectorAll('.quick-filter-cascader-popover')];
      const vis = popovers.filter(p => { const r = p.getBoundingClientRect(); return r.width > 0 && r.height > 0; })[0];
      if (!vis) return { error: 'no-visible-popover' };
      const target = [...vis.querySelectorAll('li.auxo-cascader-menu-item')].find(li => own(li) === '家清纸品')
        || [...vis.querySelectorAll('li.auxo-cascader-menu-item')].find(li => own(li).includes('纸品'));
      if (!target) return { error: 'no-target', items: [...vis.querySelectorAll('li.auxo-cascader-menu-item')].map(li => own(li)) };
      // 只做 DOM 侧展开观察（真实鼠标点击由引擎负责，此处不替它点击以免误筛选）
      const rect = target.getBoundingClientRect();
      return {
        found: own(target),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        visible: rect.width > 0 && rect.height > 0,
        menus: [...vis.querySelectorAll('ul.auxo-cascader-menu')].length,
        zoom: window.devicePixelRatio,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight
      };
    `)
    note('square.secondLevel', third)

    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
    console.log('\nREPORT_WRITTEN', OUT)
  } catch (err) {
    report.error = String(err && err.stack || err)
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
    console.error('PROBE_ERROR', err && err.message)
    process.exitCode = 1
  } finally {
    if (ui) ui.close()
    if (page) page.close()
    // 探测完关掉本次启动的实例（真实数据已落盘）
    if (app && app.pid) { try { execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: 'ignore' }) } catch { /* */ } }
    await sleep(800)
  }
}

main()
