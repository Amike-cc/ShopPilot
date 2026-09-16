/**
 * 顶部融合标题栏（§17）验证探针：
 * 启动应用 → 断言 windowChrome API / 拖拽区 / WCO 避让 / viewport 几何 → 截图
 * 用法：node tools/ui/ui-titlebar-check.js
 */
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const os = require('os')

const CDP_PORT = 9235
const ROOT = path.resolve(__dirname, '../..')
const LOG_DIR = path.join(ROOT, 'logs')
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', 'ui')
fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  const userData = path.join(os.tmpdir(), 'shopilot-tbcheck-' + Date.now())
  const app = spawn(ELECTRON, ['.', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`], { cwd: ROOT, stdio: 'ignore' })
  const kill = () => { try { spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
  const results = { checks: [], error: null }
  const check = (name, ok, detail) => {
    results.checks.push({ name, ok, detail: detail === undefined ? null : detail })
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail) : ''))
  }
  try {
    let target = null
    for (let i = 0; i < 40 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
        target = list.find(t => t.type === 'page' && (t.url.includes('index.html') || t.url.startsWith('file:')))
      } catch {}
      if (!target) await sleep(400)
    }
    if (!target) throw new Error('未找到主界面 target')
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    let id = 0
    const pending = new Map()
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) }
    }
    const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
      return r.result.value
    }
    await evaluate(`const d=Date.now()+20000; while(!window.shopilot && Date.now()<d) await new Promise(r=>setTimeout(r,100)); return true;`)
    await sleep(800)

    // ── 1. windowChrome API 存在 ──
    const hasApi = await evaluate(`return typeof window.shopilot.windowChrome?.setTitlebarOverlay === 'function'`)
    check('windowChrome.setTitlebarOverlay API', hasApi === true)

    // ── 2. IPC 通道可用（非法输入应被拒，合法输入 ok） ──
    const bad = await evaluate(`return (await window.shopilot.windowChrome.setTitlebarOverlay({ color: 'javascript:alert(1)' })).ok`)
    check('overlay 非法 color 被拒', bad === false)
    const good = await evaluate(`return (await window.shopilot.windowChrome.setTitlebarOverlay({ color: '#242424' })).ok`)
    check('overlay 合法 color 生效', good === true)

    // ── 3. 欢迎页（无店铺）状态：拖拽区 ──
    const welcomeState = await evaluate(`return (() => {
      const cs = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).getPropertyValue('-webkit-app-region').trim() : null }
      return { hasWelcome: !!document.querySelector('.welcome'), brand: cs('.brand'), welcome: cs('.welcome'), welcomeInner: cs('.welcome-inner') }
    })()`)
    check('欢迎页拖拽区', welcomeState.hasWelcome === true && welcomeState.brand === 'drag' && welcomeState.welcome === 'drag' && welcomeState.welcomeInner === 'no-drag', welcomeState)

    // ── 4. 建店 + 走 UI 路径打开浏览器（点店铺卡片 ▶，让渲染层 displayedStoreId 生效） ──
    await evaluate(`
      const list = await window.shopilot.store.list();
      let s = (list.data || []).find(x => x.name === '视觉核对店');
      if (!s) s = (await window.shopilot.store.create({ name: '视觉核对店', platform: '抖店' })).data;
      return s.id;
    `)
    await evaluate(`location.reload(); return true`)
    await sleep(3000)
    const opened = await evaluate(`
      const card = [...document.querySelectorAll('.store-card')].find(c => c.textContent.includes('视觉核对店'));
      if (!card) throw new Error('店铺卡片未找到');
      card.querySelector('.store-action').click();
      await new Promise(r => setTimeout(r, 3000));
      return !!document.querySelector('.tab-strip');
    `)
    check('店铺已打开（工作台渲染）', opened === true)

    const workbench = await evaluate(`return (() => {
      const cs = (sel, prop) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).getPropertyValue(prop).trim() : null }
      const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
      return {
        hasTabStrip: !!document.querySelector('.tab-strip'),
        tabStripClass: document.querySelector('.tab-strip')?.className || '',
        tabStripRegion: cs('.tab-strip', '-webkit-app-region'),
        tabRegion: cs('.tab', '-webkit-app-region'),
        tabAddRegion: cs('.tab-add', '-webkit-app-region'),
        panelTabsRegion: cs('.panel-tabs', '-webkit-app-region'),
        panelTabsPadRight: cs('.panel-tabs', 'padding-right'),
        ptabRegion: cs('.ptab', '-webkit-app-region'),
        panelCollapseRegion: cs('.panel-collapse', '-webkit-app-region'),
        tabStripRect: rect('.tab-strip'),
        viewportRect: rect('.viewport')
      }
    })()`)
    check('标签栏=拖拽区', workbench.hasTabStrip && workbench.tabStripRegion === 'drag', workbench.tabStripRegion)
    check('标签/新建按钮=可点击', workbench.tabRegion === 'no-drag' && workbench.tabAddRegion === 'no-drag', { tab: workbench.tabRegion, add: workbench.tabAddRegion })
    check('面板顶行=拖拽区+WCO避让140px', workbench.panelTabsRegion === 'drag' && workbench.panelTabsPadRight === '140px', { region: workbench.panelTabsRegion, pad: workbench.panelTabsPadRight })
    check('ptab/收起按钮=可点击', workbench.ptabRegion === 'no-drag' && workbench.panelCollapseRegion === 'no-drag', { ptab: workbench.ptabRegion, collapse: workbench.panelCollapseRegion })
    check('viewport 位于标签栏(38)+地址栏(44)之下', workbench.viewportRect && workbench.viewportRect.y === 82, workbench.viewportRect)

    // ── 5. 右栏收起 → 窄轨避让 + 标签栏避让 ──
    await evaluate(`document.querySelector('[data-test="panel-collapse"]').click(); await new Promise(r => setTimeout(r, 400)); return true`)
    const collapsed = await evaluate(`return (() => {
      const cs = (sel, prop) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).getPropertyValue(prop).trim() : null }
      return {
        stripClass: document.querySelector('.tab-strip')?.className || '',
        stripPadRight: cs('.tab-strip', 'padding-right'),
        railPadTop: cs('.panel-rail', 'padding-top'),
        railFirstBtnY: Math.round(document.querySelector('.panel-rail .rail-btn')?.getBoundingClientRect().y ?? -1)
      }
    })()`)
    check('收起态：标签栏避让104px', collapsed.stripClass.includes('wco-avoid') && collapsed.stripPadRight === '104px', collapsed)
    check('收起态：窄轨按钮下移至 WCO(38px) 之下', collapsed.railPadTop === '46px' && collapsed.railFirstBtnY >= 40, collapsed)

    // ── 6. 恢复展开态 ──
    await evaluate(`document.querySelector('[data-test="panel-expand"]').click(); await new Promise(r => setTimeout(r, 400)); return true`)
    const expandedPad = await evaluate(`return getComputedStyle(document.querySelector('.panel-tabs')).getPropertyValue('padding-right').trim()`)
    check('恢复展开态', expandedPad === '140px', expandedPad)

    // ── 截图（供人工核对） ──
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'ui-titlebar-full.png'), Buffer.from(shot.data, 'base64'))
    const layout = await send('Page.getLayoutMetrics')
    const shot2 = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: layout.cssLayoutViewport.clientWidth, height: 120, scale: 2 }
    })
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'ui-titlebar-top.png'), Buffer.from(shot2.data, 'base64'))
    console.log('已保存 artifacts/ui/ui-titlebar-full.png artifacts/ui/ui-titlebar-top.png')

    results.passed = results.checks.every(c => c.ok)
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.writeFileSync(path.join(LOG_DIR, 'ui-titlebar-check.log'), JSON.stringify(results, null, 2))
    ws.close()
    console.log(results.passed ? 'ALL PASS' : 'HAS FAILURES')
  } catch (e) {
    results.error = String(e?.message || e)
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.writeFileSync(path.join(LOG_DIR, 'ui-titlebar-check.log'), JSON.stringify(results, null, 2)) } catch {}
    console.error('CHECK_CRASH', e)
    process.exitCode = 1
  } finally { kill() }
}

main()
