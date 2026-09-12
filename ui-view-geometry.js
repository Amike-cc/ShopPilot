/**
 * 原生视图几何自查：左栏/右栏收起组合下，内嵌浏览器（WebContentsView）的真实尺寸。
 *
 * 度量口径说明（踩过的坑）：
 *   WebContentsView 不是独立 OS 窗口，店铺页里的 window.screenX/screenY/outerWidth/outerHeight
 *   返回的是**宿主窗口**的几何（实测 260,66,1400×900，恒等于主窗口），用它推"视图位置"是错的。
 *   可信的是 innerWidth/innerHeight —— 它就是视图的 CSS 视口尺寸，即原生视图真实尺寸。
 *   视图的**位置**（左缘是否跟着左栏左移）无法从 JS 读到，改用桌面截图目视核对：
 *   设 SHOPILOT_HOLD=1 会让应用停在中栏页面上开着，便于截图比对页面上缘/左缘。
 *
 * 用法：node ui-view-geometry.js
 *      set SHOPILOT_HOLD=1 && node ui-view-geometry.js   （结束后保留窗口，供截图核对）
 */
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')

const root = __dirname
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9232
const SITE_PORT = 61601
const userData = path.join(os.tmpdir(), 'shopilot-viewgeom-' + Date.now())
const HOLD = process.env.SHOPILOT_HOLD === '1'
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 结束应用进程树。只 kill 主进程在 Windows 上会留下渲染进程僵尸（实测残留 90MB renderer） */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch { /* 进程可能已自行退出 */ }
}

class CDP {
  constructor(wsUrl) {
    this.id = 0
    this.pending = new Map()
    this.console = []
    this.ws = new WebSocket(wsUrl)
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res()
      this.ws.onerror = () => rej(new Error('ws error'))
    })
    this.ws.onmessage = evt => {
      const m = JSON.parse(evt.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) reject(new Error(m.error.message))
        else resolve(m.result)
        return
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.console.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300))
      }
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error')
    return r.result.value
  }
  close() { try { this.ws.close() } catch {} }
}

async function waitCDP(timeout = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return true } catch {}
    await sleep(400)
  }
  return false
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log((ok ? 'PASS - ' : 'FAIL - ') + name + (detail !== undefined ? ' :: ' + detail : ''))
}

async function main() {
  fs.mkdirSync(userData, { recursive: true })

  // 页面左侧给一条醒目的红条 + 白底：截图里一眼能看出视图左缘落在哪里
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    const n = (req.url || '/').replace(/[^a-z0-9]/gi, '') || 'root'
    res.end(`<!doctype html><html><head><title>view-${n}</title></head><body style="margin:0;background:#fff">
      <div style="border-left:16px solid #ff0000;height:100vh;box-sizing:border-box;padding:8px 16px;font:20px sans-serif">VIEW-${n}</div>
    </body></html>`)
  })
  await new Promise(r => site.listen(SITE_PORT, '127.0.0.1', r))
  const siteUrl = `http://127.0.0.1:${SITE_PORT}/`

  const app = spawn(electronExe, [root, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + userData], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production' }
  })
  let procLog = ''
  app.stdout.on('data', d => { procLog += d.toString() })
  app.stderr.on('data', d => { procLog += d.toString() })

  try {
    if (!await waitCDP()) { console.log('CDP 未就绪\n' + procLog.slice(-1500)); return }
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    const ui = list.find(t => t.type === 'page' && (t.url.includes('index.html') || t.url.startsWith('file:')))
    if (!ui) { console.log('找不到主窗口 target'); return }
    const cdp = new CDP(ui.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Runtime.enable').catch(() => {})
    await cdp.evaluate(`const d=Date.now()+15000; while(!window.shopilot && Date.now()<d) await new Promise(r=>setTimeout(r,100)); return !!window.shopilot;`)

    // 直接走 IPC 建店不会刷新渲染层列表；reload 后点 .store-action 直到中栏视口挂上
    const prep = await cdp.evaluate(`
      const created = await window.shopilot.store.create({ name: '视图几何店', platform: '拼多多', adminUrl: ${JSON.stringify(siteUrl)} });
      const sid = created.data.id;
      await window.shopilot.browser.open(sid);
      await new Promise(r => setTimeout(r, 2000));
      const tab = await window.shopilot.browser.tab.create(sid, ${JSON.stringify(siteUrl)});
      await new Promise(r => setTimeout(r, 1500));
      return { sid, tabId: tab.data?.tabId };
    `)
    await cdp.evaluate(`location.reload(); return true;`)
    await sleep(4000)
    const prep2 = await cdp.evaluate(`
      const d = Date.now() + 12000;
      while (Date.now() < d && !document.querySelector('.store-card')) await new Promise(r => setTimeout(r, 200));
      let card = null, tries = 0;
      for (; tries < 4; tries++) {
        if (document.querySelector('.viewport')) break;
        card = [...document.querySelectorAll('.store-card')].find(c => c.textContent.includes('视图几何店'));
        if (!card) break;
        card.querySelector('.store-action')?.click();
        await new Promise(r => setTimeout(r, 3200));
      }
      return { found: !!card, tries, displayed: !!document.querySelector('.store-card.displayed'), viewport: !!document.querySelector('.viewport') };
    `)
    check('前置：本地站点店铺已打开并挂载中栏视口', prep2.found && prep2.displayed && prep2.viewport, JSON.stringify({ ...prep, ...prep2 }))
    if (!prep2.viewport) {
      console.log('\n前置不满足，后续断言无意义，终止。')
      cdp.close()
      process.exitCode = 1
      return
    }

    const htmlGeom = () => cdp.evaluate(`
      const r = el => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } };
      return {
        contentW: document.documentElement.clientWidth,
        contentH: document.documentElement.clientHeight,
        sidebarW: Math.round(document.querySelector('[data-test="sidebar"]')?.getBoundingClientRect().width || 0),
        rightPanelW: Math.round(document.querySelector('[data-test="right-panel"]')?.getBoundingClientRect().width || 0),
        viewport: r(document.querySelector('.viewport')),
        leftCollapsed: !!document.querySelector('.sidebar.collapsed'),
        rightCollapsed: !!document.querySelector('.panel-rail')
      };
    `)

    const storeGeom = async () => {
      const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json())
        .find(x => x.type === 'page' && x.url.includes(`127.0.0.1:${SITE_PORT}`))
      if (!t) return null
      const d = new CDP(t.webSocketDebuggerUrl)
      await d.ready
      const g = await d.evaluate(`return {
        innerW: window.innerWidth, innerH: window.innerHeight,
        title: document.title, href: location.href.slice(-24)
      };`)
      d.close()
      return g
    }

    // 中栏宽度 = 内容区宽 - 左栏 - 右栏（算术独立核算，不依赖 DOM 上报）
    const expectViewportW = h => h.contentW - h.sidebarW - h.rightPanelW

    // ---- 1) 展开态 ----
    const h0 = await htmlGeom()
    const g0 = await storeGeom()
    console.log('\n--- 1) 展开态 ---')
    console.log('主窗口:', JSON.stringify(h0))
    console.log('店铺页视口:', JSON.stringify(g0))
    check('展开态：原生视图宽高 == 中栏宽高', g0 && g0.innerW === h0.viewport.w && g0.innerH === h0.viewport.h,
      JSON.stringify({ view: g0 && [g0.innerW, g0.innerH], viewport: [h0.viewport.w, h0.viewport.h] }))
    check('展开态：中栏宽度 == 内容区 − 左栏 − 右栏', h0.viewport.w === expectViewportW(h0),
      JSON.stringify({ viewport: h0.viewport.w, expect: expectViewportW(h0), content: h0.contentW, l: h0.sidebarW, r: h0.rightPanelW }))

    // ---- 2) 收起左栏 ----
    await cdp.evaluate(`document.querySelector('[data-test="sidebar-collapse"]').click(); return true;`)
    await sleep(1200)
    const h1 = await htmlGeom()
    const g1 = await storeGeom()
    console.log('\n--- 2) 左栏收起 ---')
    console.log('主窗口:', JSON.stringify(h1))
    console.log('店铺页视口:', JSON.stringify(g1))
    check('收起左栏：原生视图宽度 +260 且仍等于中栏宽度', g1 && (g1.innerW - g0.innerW) === 260 && g1.innerW === h1.viewport.w,
      JSON.stringify({ before: g0.innerW, after: g1.innerW, viewport: h1.viewport.w }))
    check('收起左栏：原生视图高度不变（只横向变化）', g1 && g1.innerH === g0.innerH, JSON.stringify({ before: g0.innerH, after: g1.innerH }))

    // ---- 3) 左栏收起状态下浏览器仍可用 ----
    const nav = await cdp.evaluate(`
      const sid = ${JSON.stringify(prep.sid)};
      const list = await window.shopilot.browser.tab.list(sid);
      const tid = (list.data?.tabs || [])[0]?.id;
      if (!tid) return { err: 'NO_TAB' };
      const r = await window.shopilot.browser.navigate(sid, tid, ${JSON.stringify(siteUrl)} + 'page2');
      await new Promise(r => setTimeout(r, 2600));
      const cap = await window.shopilot.browser.capture(sid, tid, 'png');
      const after = await window.shopilot.browser.tab.list(sid);
      return { navOk: r.ok, title: after.data?.tabs?.[0]?.title, capOk: cap.ok, capLen: cap.ok ? (cap.data.data || '').length : 0 };
    `)
    const g2 = await storeGeom()
    console.log('\n--- 3) 左栏收起状态下导航/截图 ---')
    console.log(JSON.stringify(nav))
    check('左栏收起状态下导航生效（标题变 view-page2）', nav.navOk === true && g2?.title === 'view-page2', JSON.stringify({ nav, title: g2?.title }))
    check('左栏收起状态下截图返回有效 PNG', nav.capOk === true && nav.capLen > 1000, 'len=' + nav.capLen)

    // ---- 4) 左右栏同时收起 ----
    await cdp.evaluate(`document.querySelector('[data-test="panel-collapse"]').click(); return true;`)
    await sleep(1200)
    const h3 = await htmlGeom()
    const g3 = await storeGeom()
    console.log('\n--- 4) 左右栏同时收起 ---')
    console.log('主窗口:', JSON.stringify(h3))
    console.log('店铺页视口:', JSON.stringify(g3))
    check('左右栏同时收起：原生视图宽 == 中栏宽 == 内容区 − 44 − 44', h3.leftCollapsed && h3.rightCollapsed && g3 && g3.innerW === h3.viewport.w && h3.viewport.w === expectViewportW(h3),
      JSON.stringify({ view: g3?.innerW, viewport: h3.viewport.w, expect: expectViewportW(h3) }))

    // ---- 5) 展开回基线 ----
    await cdp.evaluate(`
      document.querySelector('[data-test="sidebar-expand"]').click();
      await new Promise(r => setTimeout(r, 900));
      document.querySelector('[data-test="panel-expand"]').click();
      return true;
    `)
    await sleep(1600)
    const h4 = await htmlGeom()
    const g4 = await storeGeom()
    console.log('\n--- 5) 恢复展开 ---')
    console.log('店铺页视口:', JSON.stringify(g4))
    check('两栏展开后原生视图尺寸回到基线', g4 && g0 && g4.innerW === g0.innerW && g4.innerH === g0.innerH && g4.innerW === h4.viewport.w,
      JSON.stringify({ baseline: g0 && [g0.innerW, g0.innerH], now: g4 && [g4.innerW, g4.innerH] }))

    if (cdp.console.length) console.log('\n渲染层异常:\n' + cdp.console.slice(-6).join('\n'))

    const passed = results.filter(r => r.ok).length
    console.log(`\n===== 原生视图几何自查 =====\n通过 ${passed}/${results.length}`)
    if (passed !== results.length) process.exitCode = 1

    if (HOLD) {
      // 停在"左栏收起"状态供桌面截图核对左缘位置（JS 读不到视图偏移，只能目视）
      await cdp.evaluate(`document.querySelector('[data-test="sidebar-collapse"]').click(); return true;`)
      await sleep(1200)
      console.log('\n[HOLD] 已收起左栏并保留窗口，供截图核对（Ctrl+C 结束）')
      console.log('[HOLD] 预期：页面上缘紧贴地址栏下方；页面左缘紧贴 44px 窄轨右侧')
      await new Promise(() => {})
    }

    await cdp.evaluate(`return await window.shopilot.browser.close(${JSON.stringify(prep.sid)});`)
    await cdp.evaluate(`return await window.shopilot.store.deletePermanent(${JSON.stringify(prep.sid)});`)
    await cdp.evaluate(`return await window.shopilot.store.purge(${JSON.stringify(prep.sid)});`)
    cdp.close()
  } catch (e) {
    console.log('VIEW_GEOM_ERROR ' + e.message)
    if (procLog) console.log(procLog.slice(-800))
    process.exitCode = 1
  } finally {
    if (!HOLD) {
      killTree(app)
      site.close()
      await sleep(800)
      try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
    } else {
      app.on('exit', () => { try { site.close() } catch {} })
    }
  }
}

main()
