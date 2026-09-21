/**
 * 新建任务（自定义任务）——**真实桌面窗口点击**验收。
 *
 * 【与 custom-task-local-verify.js 的区别，为什么还要单独一个】
 * 那个脚本用渲染层的合成事件（`el.click()` / `dispatchEvent`）驱动界面。它能证明
 * "逻辑对不对"，但**证明不了"点得到"**——合成事件绕过了浏览器命中测试，哪怕按钮被
 * 浮层盖住、被挤出可视区、坐标算错，`el.click()` 照样成功。真机上用户点不到，
 * 脚本却是绿的。实测就踩过：三栏改版时「创建任务」按钮被挤出视野。
 *
 * 这个脚本走**真实鼠标输入**：Windows SendInput → 光标真的移动 → 真的按下抬起。
 * 坐标从渲染层实测的 `getBoundingClientRect()` 换算（client 区原点 + CSS 像素），
 * 所以点击落点由 Chromium 自己命中测试，点偏了就是失败。
 *
 * 【怎么确认"确实用的是真实输入"】
 * 每类点击都顺带断言事件的 `isTrusted === true`。合成事件是 false——这是区分
 * 两条路径的硬证据，不靠脚本自述。
 *
 * 【隔离】
 * 独立临时 userData + 独立调试端口，不碰用户真实数据。
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.resolve(__dirname, '../..')
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const winInput = path.join(root, 'tools', 'acceptance', 'win-input.ps1')
const CDP_PORT = process.env.SHOPILOT_REALCLICK_CDP_PORT || '9281'
const results = []

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch { /* 可能已退出 */ }
}

function freeDebugPort(port) {
  if (process.platform !== 'win32') return
  try {
    const out = execSync(`netstat -ano | findstr LISTENING | findstr :${port}`, { encoding: 'utf8' })
    const pids = new Set(out.split(/\r?\n/).map(l => l.trim().split(/\s+/).pop()).filter(p => /^\d+$/.test(p)))
    for (const pid of pids) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) } catch { /* ignore */ } }
  } catch { /* 没有占用 */ }
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    this.ws.onmessage = e => {
      const msg = JSON.parse(e.data)
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result)
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
      awaitPromise, returnByValue: true
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function fetchJson(url) { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }

async function waitForCDP(timeoutMs = 40000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) return } catch { /* retry */ }
    await sleep(400)
  }
  throw new Error('CDP endpoint not ready')
}

async function connectUi() {
  const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json`)
  const target = targets.find(t => t.type === 'page' && t.url.includes('/renderer/index.html'))
  if (!target) throw new Error('ShopPilot UI target not found')
  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.eval(`const until = Date.now() + 20000; while (!window.shopilot && Date.now() < until) await new Promise(r => setTimeout(r, 100)); return !!window.shopilot;`)
  return cdp
}

// ---------- 真实输入（Windows SendInput） ----------

/**
 * 调 win-input.ps1。
 *
 * 批量步骤传 base64：原始 JSON 作为命令行参数会被 cmd/PowerShell 剥掉内层引号
 * （实测 ConvertFrom-Json 报 "unterminated string"）。base64 不含任何会被 shell
 * 改写的字符，中文也能原样送达。
 */
function runWinInput(args) {
  const quoted = args.map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(' ')
  const out = execSync(
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${winInput}" ${quoted}`,
    { encoding: 'utf8', timeout: 60000 }
  )
  return out.trim()
}

function getForeground() {
  return JSON.parse(runWinInput(['-Action', 'foreground']))
}

function focusWindow(pid) {
  return JSON.parse(runWinInput(['-Action', 'focus', '-TargetPid', String(pid)]))
}

/**
 * 周期性把验收窗口拉回前台。
 *
 * 为什么必需：这台开发机上有别的应用会随时抢焦点（实测 `videoflow-studio` 反复
 * 抢占），而 win-input.ps1 的点击带"前台必须是目标进程"的保护——那是防止误点
 * 到别人窗口的安全阀，不能因为测试方便就撤掉。所以正确的做法是持续把窗口维持
 * 在前台，而不是放宽保护。与 m3-runner.js 的 keepAppForeground 同一处理。
 *
 * 只影响本验收运行；产品行为与启动参数不变。
 */
function keepForeground(pid) {
  const timer = setInterval(() => {
    try {
      if (getForeground().pid !== pid) focusWindow(pid)
    } catch { /* 窗口还没建出来 / 正在退出，忽略；主流程会自己再聚焦一次 */ }
  }, 1500)
  timer.unref?.()
  return timer
}

/**
 * 一组真实输入操作。
 *
 * 坐标按**客户区相对的 CSS 像素**传（即 getBoundingClientRect 的值），屏幕绝对坐标
 * 由 win-input.ps1 在点击前一刻现算。原因见那里的注释：调用方量完坐标到真正点击
 * 之间窗口可能被移动/还原，用陈旧原点算出的绝对坐标会静默点偏。
 *
 * 缩放比用 clientW / innerWidth 反推，而不是假设 1：显示器可能有非整数缩放（125%）。
 */
function runBatch(pid, steps) {
  // 每批先聚焦目标窗口：从"算出坐标"到"真正点击"之间，别的应用可能已经把焦点
  // 抢走，而 win-input 的保护会直接拒绝点击（这是对的——宁可失败也别点错窗口）。
  const spec = Buffer.from(JSON.stringify([{ type: 'focus' }, ...steps]), 'utf8').toString('base64')
  const out = runWinInput(['-Action', 'batch', '-TargetPid', String(pid), '-SpecB64', spec])
  return JSON.parse(out)
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('本套件只在 Windows 上运行（真实鼠标注入依赖 SendInput）')
    process.exit(1)
  }

  const userData = path.join(os.tmpdir(), 'shopilot-realclick-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  freeDebugPort(CDP_PORT)

  let app = null
  let ui = null
  let keepFocus = null
  try {
    app = spawn(electronExe, [
      '.',
      `--remote-debugging-port=${CDP_PORT}`,
      '--user-data-dir=' + userData,
      '--no-sandbox',
      // 开发机上别的窗口压在上面时，Chromium 会停止合成被遮挡的窗口。
      // 这是测试专用启动参数，产品启动参数不变（与 m3-runner 同一处理）。
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows'
    ], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'production', ELECTRON_ENABLE_LOGGING: '1', SHOPILOT_DISABLE_CDP_FP: '1' },
      stdio: 'ignore'
    })
    const pid = app.pid

    await waitForCDP()
    ui = await connectUi()
    keepFocus = keepForeground(pid)

    // ------------------------------------------------------------------
    // 准备：建一个店铺并真实打开它（自定义任务要求已打开店铺）
    // ------------------------------------------------------------------
    const storeId = await ui.eval(`
      const r = await window.shopilot.store.create({ name: '真实点击验收店', platform: '抖音小店', adminUrl: 'https://fxg.jinritemai.com/' });
      if (!r.ok) throw new Error('store.create failed: ' + JSON.stringify(r.error));
      return r.data.id;
    `)
    check('准备：创建验收店铺', !!storeId, String(storeId))

    try { await ui.eval(`void location.reload()`, false) } catch { /* 导航中断连接属正常 */ }
    await sleep(3000)
    ui = await connectUi()

    // 把窗口拉到前台并量出几何（真实点击必须落在前台窗口上）
    const geo = focusWindow(pid)
    check('准备：验收窗口已置于前台',
      getForeground().pid === pid,
      JSON.stringify({ geo, foreground: getForeground() }))

    // 缩放比与客户区原点：CSS 像素 → 屏幕物理像素
    const metrics = await ui.eval(`
      return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio };
    `)
    const scale = geo.clientW / metrics.innerWidth
    console.log(`   [几何] 客户区 ${geo.clientW}x${geo.clientH} @ ${geo.clientX},${geo.clientY}；渲染层 ${metrics.innerWidth}x${metrics.innerHeight} dpr=${metrics.dpr}；缩放比 ${scale.toFixed(4)}`)

    /** 元素中心 → 客户区相对 CSS 像素（绝对屏幕坐标由 win-input.ps1 现算） */
    const toClientCss = (rect) => ({
      cssX: rect.left + rect.width / 2,
      cssY: rect.top + rect.height / 2,
      scale
    })

    /**
     * 在元素中心做一次**真实**鼠标点击。
     *
     * 返回值里的 trusted 是关键证据：安装一次性捕获监听器，记录真实输入是否被
     * 浏览器判为受信任事件。合成事件会得到 trusted=false，真实 SendInput 得到 true。
     */
    const realClick = async (selector, label) => {
      const rect = await ui.eval(`
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        await new Promise(r => setTimeout(r, 120));
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height,
                 visible: r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight,
                 disabled: !!el.disabled };
      `)
      if (!rect) throw new Error(`找不到元素：${selector}（${label}）`)
      if (!rect.visible) throw new Error(`元素不在可视区内：${selector}（${label}）`)
      if (rect.disabled) throw new Error(`元素是禁用态：${selector}（${label}）`)

      // 装监听器记录下一次真实点击是否受信任。
      // 监听器装在 document（capture）而非目标节点上：Vue 重渲染会替换按钮节点，
      // 装在旧节点上的 once 监听器会被连带丢掉，表现为"落点正确但没触发"。
      // 记录 mousedown→mouseup→click 全序列：只到 mousedown 说明按下被吞，
      // 全都没有说明 OS 级点击根本没进渲染进程（原生视图遮挡）。
      await ui.eval(`
        window.__trustProbe = null;
        window.__trustSeq = [];
        window.__trustSelector = ${JSON.stringify(selector)};
        for (const t of ['mouseover', 'mousemove', 'mousedown', 'mouseup', 'click']) {
          document.addEventListener(t, (ev) => {
            const el = document.querySelector(window.__trustSelector);
            const hit = el && (ev.target === el || el.contains(ev.target));
            window.__trustSeq.push(t + ':' + (ev.isTrusted ? 'T' : 'F') + ':' + (hit ? 'HIT' : 'miss'));
            if (t === 'click' && hit) {
              window.__trustProbe = { trusted: ev.isTrusted, tag: ev.target.tagName, cls: String(ev.target.className || '').slice(0, 40) };
            }
          }, { capture: true });
        }
        return true;
      `)

      const pt = toClientCss(rect)
      runBatch(pid, [{ type: 'click', ...pt }])
      await sleep(220)

      let probe = await ui.eval(`return window.__trustProbe;`)
      if (!probe) {
        // 点击没落到目标上：先 Escape（关可能残留的 OS 级 select 弹层）再重查坐标点一次。
        await sleep(400)
        const retry = await ui.eval(`
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, width: r.width, height: r.height };
        `)
        if (retry) {
          runBatch(pid, [{ type: 'key', key: 'Escape' }, { type: 'sleep', ms: 200 }, { type: 'click', ...toClientCss(retry) }])
          await sleep(220)
          probe = await ui.eval(`return window.__trustProbe;`)
        }
        if (!probe) {
          const seq = await ui.eval(`return (window.__trustSeq || []).join(' ');`).catch(() => 'unknown')
          const hit = await ui.eval(`
            const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
            const x = r.left + r.width / 2, y = r.top + r.height / 2;
            const el = document.elementFromPoint(x, y);
            return (el ? (el.tagName + '.' + String(el.className || '').slice(0, 40)) : 'null')
              + ' @ ' + Math.round(x) + ',' + Math.round(y);
          `).catch(() => 'unknown')
          console.log(`   [诊断] ${label} 落点实际命中: ${hit} | 事件序列: ${seq}`);
        }
      }
      return { probe, point: pt }
    }

    /** 真实输入的类型：中文走 SendInput 的 UNICODE 注入 */
    const realType = async (selector, text) => {
      const rect = await ui.eval(`
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        await new Promise(r => setTimeout(r, 100));
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      `)
      if (!rect) throw new Error(`找不到输入框：${selector}`)
      const pt = toClientCss(rect)
      runBatch(pid, [
        { type: 'click', ...pt },
        { type: 'sleep', ms: 120 },
        { type: 'text', text }
      ])
      await sleep(260)
    }

    const DOM = `
    const q = (sel) => document.querySelector(sel);
    const byText = (sel, text) => Array.from(document.querySelectorAll(sel)).find(e => (e.textContent || '').includes(text));
    const waitFor = async (fn, ms = 8000) => {
      const until = Date.now() + ms;
      for (;;) { const v = fn(); if (v) return v; if (Date.now() > until) return null; await new Promise(r => setTimeout(r, 80)); }
    };
    `

    // ------------------------------------------------------------------
    // ① 真实点击打开店铺卡片上的「打开浏览器」
    // ------------------------------------------------------------------
    const openBtnRect = await ui.eval(`${DOM}
      const card = await waitFor(() => byText('[data-test="store-card"]', '真实点击验收店'));
      if (!card) throw new Error('店铺卡片没渲染出来');
      const action = card.querySelector('.store-action');
      if (!action) throw new Error('卡片上没有「打开浏览器」按钮');
      const r = action.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    `)
    // 卡片 hover 才显示按钮（opacity:0），真实鼠标必须先移上去
    const cardPt = toClientCss(openBtnRect)
    runBatch(pid, [
      { type: 'move', ...cardPt },
      { type: 'sleep', ms: 200 },
      { type: 'click', ...cardPt }
    ])
    await sleep(2500)
    const storeOpened = await ui.eval(`${DOM}
      const r = await window.shopilot.store.list();
      return { displayed: !!q('[data-test="right-panel"]'), storeCount: (r.ok ? (r.data.stores || r.data) : []).length };
    `)
    check('① 真实点击「打开浏览器」后右侧面板出现（店铺已打开）', storeOpened.displayed === true, JSON.stringify(storeOpened))

    // ------------------------------------------------------------------
    // ② 真实点击右侧「任务」页签，再点「+ 新建任务」
    // ------------------------------------------------------------------
    const tabRect = await ui.eval(`${DOM}
      const tab = await waitFor(() => byText('.ptab', '任务') || byText('.rail-btn', '任务'));
      if (!tab) throw new Error('找不到「任务」页签');
      tab.scrollIntoView({ block: 'center' });
      await new Promise(r => setTimeout(r, 120));
      const r = tab.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    `)
    const tabPt = toClientCss(tabRect)
    runBatch(pid, [{ type: 'click', ...tabPt }])
    await sleep(500)
    const tabActive = await ui.eval(`${DOM} return { newBtn: !!q('[data-test="task-new"]'), subtabs: !!q('[data-test="task-subtabs"]') };`)
    check('② 真实点击「任务」页签后出现任务列表区', tabActive.newBtn === true, JSON.stringify(tabActive))

    const newBtnClick = await realClick('[data-test="task-new"]', '新建任务按钮')
    await ui.eval(`${DOM} await waitFor(() => q('[data-test="task-dialog"]')); return true;`)
    const dialogUp = await ui.eval(`${DOM} return !!q('[data-test="task-dialog"]');`)
    check('② 真实点击「+ 新建任务」后对话框打开', dialogUp === true)
    check('② 该点击是真实输入（isTrusted=true，非脚本合成）',
      newBtnClick.probe && newBtnClick.probe.trusted === true,
      JSON.stringify(newBtnClick.probe))

    // ------------------------------------------------------------------
    // ③ 真实点击把任务类型切到「自定义任务」
    //    原生 <select> 的下拉弹层是 OS 级菜单，点不中"选项"——所以用键盘：
    //    真实点击聚焦下拉框，再真实按键选中。这条路径同样经过真实输入管线。
    // ------------------------------------------------------------------
    const selRect = await ui.eval(`${DOM}
      const sel = q('[data-test="task-flow"]');
      sel.scrollIntoView({ block: 'center' });
      await new Promise(r => setTimeout(r, 120));
      const r = sel.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, value: sel.value };
    `)
    const selPt = toClientCss(selRect)
    await ui.eval(`${DOM}
      window.__flowChange = null;
      q('[data-test="task-flow"]').addEventListener('change', (ev) => { window.__flowChange = { trusted: ev.isTrusted, value: ev.target.value }; }, { once: true, capture: true });
      return true;
    `)
    // 键盘：下拉框聚焦后按 Down 选中第二项（invite → custom），再 Enter 确认
    runBatch(pid, [
      { type: 'click', ...selPt },
      { type: 'sleep', ms: 250 },
      { type: 'key', key: 'Down' },
      { type: 'sleep', ms: 200 },
      { type: 'key', key: 'Return' },
      { type: 'sleep', ms: 400 }
    ])
    const flowNow = await ui.eval(`${DOM}
      return { value: q('[data-test="task-flow"]').value, editor: !!q('[data-test="custom-editor"]'), change: window.__flowChange };
    `)
    check('③ 真实键盘操作把任务类型切到「自定义任务」', flowNow.value === 'custom', JSON.stringify(flowNow))
    check('③ 切换后自定义编排器渲染出来', flowNow.editor === true)
    // 原生 select 的下拉弹层是 OS 级菜单：Return 选中值后它可能还开着，一直盖住对话框、
    // 吃掉后续全部 OS 点击（实测第④步事件序列全空、hasFocus=false、焦点还在 SELECT 上）。
    // 按 Escape 确保它关闭，并把焦点还给页面。
    runBatch(pid, [{ type: 'key', key: 'Escape' }, { type: 'sleep', ms: 250 }])
    await ui.eval(`${DOM} if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true;`)
    await sleep(200)

    // ------------------------------------------------------------------
    // ④ 真实点击左侧目录加一步「打开网址」
    //    这一步最接近用户实际遇到的那个问题（"点击元素怎么加不进去"）：
    //    目录栏内可视高度装不下全部条目，必须靠筛选或滚动才能点到目标。
    // ------------------------------------------------------------------
    await sleep(300)
    const paletteProbe = await ui.eval(`${DOM}
      const col = q('.ct-palette-body');
      const item = q('[data-test="custom-palette-navigate"]');
      if (!col || !item) return null;
      const cr = col.getBoundingClientRect(), ir = item.getBoundingClientRect();
      return { inView: ir.top >= cr.top && ir.bottom <= cr.bottom };
    `)
    check('④ 目录里「打开网址」在可视区内（可真实点到）', paletteProbe && paletteProbe.inView === true, JSON.stringify(paletteProbe))

    const navClick = await realClick('[data-test="custom-palette-navigate"]', '目录里的「打开网址」')
    await sleep(300)
    const afterNav = await ui.eval(`${DOM}
      return { count: q('[data-test="custom-step-count"]').textContent.trim(),
               hasUrlField: !!q('[data-test="custom-f-0-url"]'),
               submitDisabled: q('[data-test="task-submit"]').disabled };
    `)
    check('④ 真实点击目录后步数变为 1 步', afterNav.count.includes('1'), afterNav.count)
    check('④ 添加后自动选中它并在右栏渲染参数', afterNav.hasUrlField === true)
    check('④ 该点击是真实输入（isTrusted=true）',
      navClick.probe && navClick.probe.trusted === true, JSON.stringify(navClick.probe))

    // ------------------------------------------------------------------
    // ⑤ 真实键入网址 → 客户端校验放行（真实键盘输入，非 setNativeValue）
    // ------------------------------------------------------------------
    const url = 'https://store.weixin.qq.com/shop/brandAndCat/qualification/home'
    await realType('[data-test="custom-f-0-url"]', url)
    const urlState = await ui.eval(`${DOM}
      return { value: q('[data-test="custom-f-0-url"]').value,
               submitDisabled: q('[data-test="task-submit"]').disabled,
               issues: (q('[data-test="custom-issues"]')?.textContent || '').trim() };
    `)
    check('⑤ 真实键入的网址进入输入框', urlState.value === url, urlState.value)
    check('⑤ 合法网址下校验通过（创建按钮可点）', urlState.submitDisabled === false, urlState.issues.slice(0, 90))

    // ------------------------------------------------------------------
    // ⑥ 真实键入非法网址 → 必须在客户端被拦下（这是本版修的那个"点创建才被拒"）
    // ------------------------------------------------------------------
    await ui.eval(`${DOM} q('[data-test="custom-f-0-url"]').focus(); q('[data-test="custom-f-0-url"]').select(); return true;`)
    runBatch(pid, [{ type: 'key', key: 'Delete' }, { type: 'sleep', ms: 120 }, { type: 'text', text: 'wx.qq.com/page' }])
    await sleep(350)
    const badState = await ui.eval(`${DOM}
      return { value: q('[data-test="custom-f-0-url"]').value,
               submitDisabled: q('[data-test="task-submit"]').disabled,
               issues: (q('[data-test="custom-issues"]')?.textContent || '').trim() };
    `)
    check('⑥ 真实键入的错误网址被客户端拦下', badState.submitDisabled === true, JSON.stringify(badState).slice(0, 140))
    check('⑥ 且给出的是"网址不完整"而不是引擎味错误码',
      badState.issues.includes('网址'), badState.issues.slice(0, 110))

    // 改回合法网址
    await ui.eval(`${DOM} q('[data-test="custom-f-0-url"]').focus(); q('[data-test="custom-f-0-url"]').select(); return true;`)
    runBatch(pid, [{ type: 'key', key: 'Delete' }, { type: 'sleep', ms: 120 }, { type: 'text', text: url }])
    await sleep(350)
    const recovered = await ui.eval(`${DOM} return { value: q('[data-test="custom-f-0-url"]').value, disabled: q('[data-test="task-submit"]').disabled };`)
    check('⑥ 改回合法网址后恢复可创建', recovered.disabled === false && recovered.value === url, JSON.stringify(recovered))

    // ------------------------------------------------------------------
    // ⑦ 真实点击加「按文案点击」，真实键入文案，真实点击「提交动作」勾选框
    //    → 必须报"缺前置门禁"并置灰创建按钮（本功能最关键的安全约束）
    // ------------------------------------------------------------------
    await realClick('[data-test="custom-palette-clickByText"]', '目录里的「按文案点击」')
    await sleep(350)
    await realType('[data-test="custom-f-1-text"]', '确认发送')
    const textFilled = await ui.eval(`${DOM} return q('[data-test="custom-f-1-text"]').value;`)
    check('⑦ 真实键入的点击文案进入输入框', textFilled === '确认发送', textFilled)

    const submitBoxClick = await realClick('[data-test="custom-submit-1"]', '「提交动作」勾选框')
    await sleep(320)
    const noGate = await ui.eval(`${DOM}
      return { checked: q('[data-test="custom-submit-1"]').checked,
               disabled: q('[data-test="task-submit"]').disabled,
               issues: (q('[data-test="custom-issues"]')?.textContent || '').trim() };
    `)
    check('⑦ 真实点击勾上「提交动作」', noGate.checked === true)
    check('⑦ 该点击是真实输入（isTrusted=true）',
      submitBoxClick.probe && submitBoxClick.probe.trusted === true, JSON.stringify(submitBoxClick.probe))
    check('⑦ 标了提交动作但无门禁 → 创建按钮真实置灰', noGate.disabled === true)
    check('⑦ 且明确说明缺前置门禁', noGate.issues.includes('门禁'), noGate.issues.slice(0, 100))

    // ------------------------------------------------------------------
    // ⑧ 加「人工确认门禁」并真实点上移，把门禁排到提交动作之前
    // ------------------------------------------------------------------
    await realClick('[data-test="custom-palette-waitForUserConfirmation"]', '目录里的「人工确认门禁」')
    await sleep(350)
    await realType('[data-test="custom-f-2-message"]', '确认在资质页执行自定义操作？')
    const gateText = await ui.eval(`${DOM} return q('[data-test="custom-f-2-message"]').value;`)
    check('⑧ 真实键入的门禁提示语进入输入框', gateText === '确认在资质页执行自定义操作？', gateText)

    const stillBlocked = await ui.eval(`${DOM} return q('[data-test="task-submit"]').disabled;`)
    check('⑧ 门禁排在提交动作之后仍被拦（顺序必须对）', stillBlocked === true)

    const upClick = await realClick('[data-test="custom-up-2"]', '第 3 步的上移按钮')
    await sleep(400)
    const reordered = await ui.eval(`${DOM}
      const labels = Array.from(document.querySelectorAll('div.ct-step[data-test^="custom-step-"]'))
        .map(e => e.querySelector('.ct-step-t')?.textContent?.replace('提交', '')?.trim());
      return { labels, disabled: q('[data-test="task-submit"]').disabled,
               issues: (q('[data-test="custom-issues"]')?.textContent || '').trim() };
    `)
    check('⑧ 真实点击上移后门禁排在提交动作之前',
      reordered.labels[1] === '人工确认门禁', JSON.stringify(reordered.labels))
    check('⑧ 该点击是真实输入（isTrusted=true）',
      upClick.probe && upClick.probe.trusted === true, JSON.stringify(upClick.probe))
    check('⑧ 顺序正确后创建按钮恢复可点', reordered.disabled === false, reordered.issues.slice(0, 90))

    // ------------------------------------------------------------------
    // ⑨ 真实键入任务名并真实点击「创建任务」
    //    这里刻意用**坐标点击**而不是 realClick 的"先滚动到可视区"：
    //    要验证的正是"按钮真的在视野里点得到"（历史缺陷：按钮被挤出视野）。
    // ------------------------------------------------------------------
    await realType('[data-test="custom-name"]', '真实点击验收 · 资质页巡检')
    const nameValue = await ui.eval(`${DOM} return q('[data-test="custom-name"]').value;`)
    check('⑨ 真实键入的任务名进入输入框', nameValue === '真实点击验收 · 资质页巡检', nameValue)

    const btnGeom = await ui.eval(`${DOM}
      const btn = q('[data-test="task-submit"]');
      const r = btn.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height,
               inViewport: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
               disabled: btn.disabled };
    `)
    check('⑨ 「创建任务」按钮确实在可视区内（历史上被挤出过视野）',
      btnGeom.inViewport === true && btnGeom.disabled === false, JSON.stringify(btnGeom))

    await ui.eval(`${DOM}
      window.__createClick = null;
      q('[data-test="task-submit"]').addEventListener('click', (ev) => { window.__createClick = { trusted: ev.isTrusted }; }, { once: true, capture: true });
      return true;
    `)
    const btnPt = toClientCss(btnGeom)
    runBatch(pid, [{ type: 'click', ...btnPt }])
    await sleep(2200)

    const createProbe = await ui.eval(`${DOM} return window.__createClick;`)
    check('⑨ 该点击是真实输入（isTrusted=true）',
      createProbe && createProbe.trusted === true, JSON.stringify(createProbe))

    // ------------------------------------------------------------------
    // ⑩ 核对：任务真的落库、步骤与参数与编排一致、对话框已关闭
    // ------------------------------------------------------------------
    const created = await ui.eval(`
      const r = await window.shopilot.task.list();
      const tasks = r.ok ? (r.data.tasks || r.data) : [];
      const t = tasks.find(x => x.name === '真实点击验收 · 资质页巡检');
      return t ? { id: t.id, storeScope: t.storeScope, steps: t.steps.map(s => ({ type: s.type, input: s.input })) } : null;
    `)
    check('⑩ 真实点击后任务创建成功并落库', !!created, created ? created.id : '未找到')

    if (created) {
      const types = created.steps.map(s => s.type)
      check('⑩ 落库步骤类型与编排一致',
        JSON.stringify(types) === JSON.stringify(['navigate', 'waitForUserConfirmation', 'clickByText']),
        JSON.stringify(types))
      check('⑩ 真实键入的网址如实落库', created.steps[0].input.url === url, JSON.stringify(created.steps[0].input))
      check('⑩ 真实键入的门禁提示语如实落库',
        created.steps[1].input.message === '确认在资质页执行自定义操作？', JSON.stringify(created.steps[1].input))
      check('⑩ 真实键入的点击文案如实落库',
        created.steps[2].input.text === '确认发送', JSON.stringify(created.steps[2].input))
      check('⑩ 任务绑定到验收店铺', created.storeScope === storeId, String(created.storeScope))
    }

    const dialogClosed = await ui.eval(`${DOM} return !q('[data-test="task-dialog"]');`)
    check('⑩ 创建成功后对话框关闭', dialogClosed === true)

    if (created) {
      await ui.eval(`await window.shopilot.task.delete(${JSON.stringify(created.id)}); return true;`)
    }
  } catch (err) {
    check('执行异常', false, String(err && err.message || err))
  } finally {
    if (keepFocus) clearInterval(keepFocus)
    if (ui) ui.close()
    killTree(app)
    await sleep(1200)
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* 可能仍被占用 */ }
  }

  const passed = results.filter(r => r.ok).length
  console.log(`\n===== 新建任务真实窗口点击验收：${passed}/${results.length} 通过 =====`)
  if (passed !== results.length) {
    console.log('失败项：')
    for (const r of results.filter(x => !x.ok)) console.log(`  - ${r.name} :: ${r.detail}`)
    process.exit(1)
  }
  console.log('ALL_CUSTOM_TASK_REAL_CLICK_PASSED')
}

main().catch(err => { console.error('RUNNER_ERROR', err); process.exit(1) })
