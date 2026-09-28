/**
 * 抖店达人邀约——**真机全流程实测**（会真实发送 1 位达人的邀约，谨慎重复运行）。
 *
 * 与本地验收的区别：这里连的是真实抖店（真实登录态、真实达人、真实额度）。
 * 全流程都走真实应用界面：面板配置 → 打开达人广场（读三级类目）→ 开始邀约
 * → 勾选 → 抽屉填表 → 人工确认门禁 → 确认发送 → 校验抽屉关闭与运行收尾。
 *
 * 用法（先确保没有别的实例占用 CDP 端口）：
 *   node tools/acceptance/douyin-invite-real-send.js [每批位数] [三级类目]
 * 环境变量（**中文值别走 env**：cmd 的 set 会按 OEM 码页毁掉中文，用 argv 传）：
 *   SHOPILOT_REAL_CDP_PORT  默认 9251
 *   SHOPILOT_DD_STORE       默认 1111
 *   SHOPILOT_DD_COUNT       每批位数（默认 1）
 *   SHOPILOT_DD_MAIN        主营（默认「个护家清/家清纸品」；空字符串 = 不填）
 *   SHOPILOT_DD_MAX_ROUNDS  本脚本最多放它跑几批（默认 1）——**限流用**：
 *     达人邀约按用户要求不设人工确认门禁，点下即真实发送；这里靠"监听进度事件，
 *     第 1 批一发完立刻取消运行"把真实发送量控制在 1 批（1 位）。
 *     想多批就设大这个数（每批 = count 位真实邀约，谨慎）。
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '../..')
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = process.env.SHOPILOT_REAL_CDP_PORT || '9251'
const STORE_NAME = process.env.SHOPILOT_DD_STORE || '1111'
const COUNT = Number(process.argv[2] || process.env.SHOPILOT_DD_COUNT || 1)
const CAT3 = process.argv[3] || ''
const MAIN = process.env.SHOPILOT_DD_MAIN === undefined ? '个护家清/家清纸品' : process.env.SHOPILOT_DD_MAIN
/** 本脚本最多放它跑几批（限流）：第 N 批一发完就取消运行（无人工门禁后，这里是自己加的闸） */
const MAX_ROUNDS = Math.max(1, Number(process.env.SHOPILOT_DD_MAX_ROUNDS || 1))
const PHONE = '15057937334'
const WECHAT = 'jiaoe988'
const OUT_DIR = path.join(root, 'artifacts', 'real-douyin-send')
const report = { startedAt: new Date().toISOString(), checks: [], notes: [] }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function note(msg) { report.notes.push(`[${new Date().toISOString()}] ${msg}`); console.log('##', msg) }
function check(name, ok, detail = '') {
  report.checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}
function killTree(child) {
  if (!child || child.exitCode !== null) return
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* */ }
}
function freeDebugPort(port) {
  try {
    const out = execSync(`netstat -ano | findstr LISTENING | findstr :${port}`, { encoding: 'utf8' })
    const pids = new Set(out.split(/\r?\n/).map(l => l.trim().split(/\s+/).pop()).filter(p => /^\d+$/.test(p)))
    for (const pid of pids) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) } catch { /* */ } }
  } catch { /* 没有占用 */ }
}
function focusAppWindow(pid) {
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
    try {
      const r = await this.send('Page.captureScreenshot', { format: 'png' })
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
      return file
    } catch (e) { note('截图失败：' + e.message); return null }
  }
  close() { try { this.ws.close() } catch { /* */ } }
}

async function targets() { return (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json() }
async function waitForCDP(timeoutMs = 40000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) return } catch { /* retry */ }
    await sleep(400)
  }
  throw new Error('CDP endpoint not ready')
}
async function connectByUrl(part, timeoutMs = 20000) {
  const t0 = Date.now()
  for (;;) {
    const list = await targets()
    const t = list.find(x => (x.type === 'page' || x.type === 'webview') && x.url.includes(part))
    if (t) { const c = new CDP(t.webSocketDebuggerUrl); await c.ready; return c }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error('未找到页面目标: ' + part + '\n' + list.map(x => x.url.slice(0, 100)).join('\n'))
    }
    await sleep(600)
  }
}

const PAGE_STATE = `return (() => {
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
  const norm = el => String(el.innerText || '').replace(/\\s+/g, ' ').trim();
  const box = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
  const checks = [...document.querySelectorAll('tbody input[type=checkbox]')];
  const counter = document.querySelector('.select_peoples_message');
  const drawer = document.querySelector('.auxo-drawer-open');
  const filtered = [...document.querySelectorAll('*')].find(e => own(e) === '已筛选');
  const drawerText = drawer ? norm(drawer) : '';
  const goodsAdded = (drawerText.match(/已添加\\s*(\\d+)\\/(\\d+)/) || [])[0] || null;
  const preview = drawer ? ((drawerText.match(/效果预览[\\s\\S]{0,200}/) || [])[0] || null) : null;
  return {
    url: location.href,
    filteredText: filtered ? norm(filtered.parentElement).slice(0, 160) : null,
    counter: counter ? norm(counter) : null,
    rowChecks: checks.length,
    rowChecked: checks.filter(c => c.checked).length,
    rowDisabled: checks.filter(c => c.disabled).length,
    drawerOpen: !!drawer,
    drawerText: drawerText.slice(0, 260),
    goodsAdded,
    preview,
    drawerInputs: drawer ? [...drawer.querySelectorAll('input:not([type=checkbox])')].map(e => ({ id: e.id, value: e.value })) : [],
    drawerChecked: drawer ? [...drawer.querySelectorAll('input[type=checkbox]')].filter(c => c.checked).map(c => (c.closest('label') ? norm(c.closest('label')) : '')) : [],
    switchOn: drawer ? /auxo-switch-checked/.test(String((drawer.querySelector('.auxo-switch') || {}).className || '')) : null,
    mainTrigger: drawer ? (() => { const w = drawer.querySelector('.auxo-cascader-multiple-wrapper'); return w ? norm(w) : null })() : null,
    confirmSendDisabled: (() => {
      const b = [...document.querySelectorAll('button,.auxo-btn')].find(e => norm(e) === '确认发送');
      return b ? (!!b.disabled || /disabled/.test(String(b.className))) : null;
    })(),
    visibleCascaderItems: [...document.querySelectorAll('li.auxo-cascader-menu-item')].filter(e => e.getBoundingClientRect().width > 0).map(norm).slice(0, 12)
  };
})()`

async function main() {
  freeDebugPort(CDP_PORT)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  note(`配置：每批 ${COUNT} 位 / 三级「${CAT3 || '(不选)'}」/ 主营「${MAIN || '(不填)'}」/ 最多跑 ${MAX_ROUNDS} 批（第 ${MAX_ROUNDS} 批发完立即取消）`)
  let app = null, ui = null, page = null
  try {
    // 复用已在跑的实例（探测时留下的），没有就自己起一个
    let reused = false
    try { await waitForCDP(1200); reused = true } catch { /* 需要自己起 */ }
    if (!reused) {
      app = spawn(electronExe, [
        '.', `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox',
        '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'
      ], {
        cwd: root, stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
      })
      await waitForCDP()
    }
    note(`实例来源：${reused ? '复用现有' : '本次启动 pid=' + (app && app.pid)}`)
    focusAppWindow(app && app.pid)
    await sleep(2500)

    ui = await connectByUrl('/renderer/index.html')
    await ui.eval(`const until = Date.now() + 20000; while (!window.shopilot && Date.now() < until) await new Promise(r => setTimeout(r, 100)); return !!window.shopilot;`)

    const storeId = await ui.eval(`
      const r = await window.shopilot.store.list();
      const s = (r.data || []).find(x => x.name === ${JSON.stringify(STORE_NAME)});
      return s ? s.id : null;
    `)
    check('找到真实抖店店铺', !!storeId, String(storeId))
    if (!storeId) throw new Error('未找到店铺 ' + STORE_NAME)

    await ui.eval(`await window.shopilot.browser.open(${JSON.stringify(storeId)}); return true;`)
    await sleep(2500)
    // 面板就绪要重试：刚启动时店铺列表可能还没渲染出来（点不到卡片 → 面板不出现）
    let panelReady = false
    for (let i = 0; i < 20 && !panelReady; i++) {
      const st = await ui.eval(`
        const cards = [...document.querySelectorAll('.store-card')];
        const card = cards.find(x => x.textContent.includes(${JSON.stringify(STORE_NAME)}));
        if (card) (card.querySelector('.store-action') || card).click();
        await new Promise(r => setTimeout(r, 900));
        const taskTab = [...document.querySelectorAll('.ptab')].find(x => x.textContent.trim() === '任务');
        if (taskTab) taskTab.click();
        await new Promise(r => setTimeout(r, 500));
        const inviteTab = document.querySelector('[data-test="task-tab-invite"]');
        if (inviteTab) inviteTab.click();
        await new Promise(r => setTimeout(r, 600));
        return {
          cards: cards.length,
          panel: !!document.querySelector('[data-test="invite-panel"]'),
          openPage: !!document.querySelector('[data-test="invite-open-page"]')
        };
      `)
      panelReady = !!(st && st.panel)
      if (!panelReady) { note('面板未就绪，重试：' + JSON.stringify(st)); await sleep(1200) }
    }
    check('抖店邀约面板就绪', panelReady)
    focusAppWindow(app && app.pid)

    // ---------- 1) 面板配置（走真实控件） ----------
    const openRes = await ui.eval(`return (() => { const b = document.querySelector('[data-test="invite-open-page"]'); if (!b) return false; b.click(); return true })()`)
    check('点「打开达人广场」（顺带读三级类目）', openRes)
    await sleep(7000)
    focusAppWindow(app && app.pid)

    const configured = await ui.eval(`
      const setV = (el, v) => {
        const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const q = s => document.querySelector(s);
      const wait = async (fn, ms) => { const t = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > t) return null; await new Promise(r => setTimeout(r, 200)) } };
      // 一级/二级/三级
      setV(q('[data-test="invite-category"]'), '个护家清');
      await new Promise(r => setTimeout(r, 350));
      setV(q('[data-test="invite-subcategory"]'), '家清纸品');
      await new Promise(r => setTimeout(r, 350));
      const c3 = q('[data-test="invite-category3"]');
      const cat3 = ${JSON.stringify(CAT3)};
      if (cat3) { const ok3 = await wait(() => [...c3.options].some(o => o.value === cat3), 3000); if (ok3) setV(c3, cat3) }
      else setV(c3, '');
      // 等级：LV0–LV3（档案里写明本店有额度的是这四档；多选是 OR 关系，宁多勿少）
      for (const t of ['LV0','LV1','LV2','LV3','LV4','LV5','LV6']) {
        const el = q('[data-test="invite-level-' + t + '"]');
        if (!el) continue;
        const want = ['LV0','LV1','LV2','LV3'].includes(t);
        if (el.checked !== want) el.click();
        await new Promise(r => setTimeout(r, 80));
      }
      setV(q('[data-test="invite-count"]'), ${JSON.stringify(String(COUNT))});
      // 主营
      const mc = q('[data-test="invite-main-category"]');
      const main = ${JSON.stringify(MAIN)};
      if (mc) setV(mc, main);
      // 核心优势 3 项 + 权益 2 项
      for (const s of ['源头工厂','品类丰富','售后无忧']) { const el = q('[data-test="invite-strength-' + s + '"]'); if (el && !el.checked) el.click(); await new Promise(r => setTimeout(r, 60)) }
      for (const b of ['专属高佣','免费样品']) { const el = q('[data-test="invite-benefit-' + b + '"]'); if (el && !el.checked) el.click(); await new Promise(r => setTimeout(r, 60)) }
      // 联系方式（必填）
      setV(q('[data-test="invite-batch-phone"]'), ${JSON.stringify(PHONE)});
      setV(q('[data-test="invite-batch-wechat"]'), ${JSON.stringify(WECHAT)});
      await new Promise(r => setTimeout(r, 800));
      const start = q('[data-test="invite-start"]');
      return {
        category: q('[data-test="invite-category"]').value,
        subcategory: q('[data-test="invite-subcategory"]').value,
        category3: c3.value,
        category3Options: [...c3.options].map(o => o.value),
        count: q('[data-test="invite-count"]').value,
        mainCategory: mc ? mc.value : '(无该字段)',
        phone: q('[data-test="invite-batch-phone"]').value,
        wechat: q('[data-test="invite-batch-wechat"]').value,
        strengths: [...document.querySelectorAll('[data-test^="invite-strength-"]')].filter(x => x.checked).map(x => x.getAttribute('data-test').replace('invite-strength-','')),
        benefits: [...document.querySelectorAll('[data-test^="invite-benefit-"]')].filter(x => x.checked).map(x => x.getAttribute('data-test').replace('invite-benefit-','')),
        startDisabled: start ? start.disabled : null
      };
    `)
    check('面板配置就绪（类目/每批位数/主营/核心优势/权益/联系方式）',
      configured.category === '个护家清' && configured.subcategory === '家清纸品' &&
      configured.count === String(COUNT) && configured.startDisabled === false,
      JSON.stringify(configured))

    // ---------- 2) 启动任务 ----------
    const tid = await ui.eval(`
      const b = document.querySelector('[data-test="invite-start"]');
      if (!b || b.disabled) return null;
      b.click();
      // 轮询到**运行**真的起来：任务先创建、latestRun 随后才有（只看任务会出现 runId=null）
      const t = Date.now() + 25000;
      for (;;) {
        const r = await window.shopilot.task.list();
        const mine = (r.data || [])
          .filter(x => x.storeScope === ${JSON.stringify(storeId)} && String(x.name).startsWith('达人邀约 · 抖店'))
          .sort((a, b2) => (b2.createdAt || 0) - (a.createdAt || 0));
        const task = mine[0];
        if (task && task.latestRun && task.latestRun.id) {
          return { taskId: task.id, runId: task.latestRun.id, name: task.name, createdAt: task.createdAt };
        }
        if (Date.now() > t) return task ? { taskId: task.id, runId: null, name: task.name } : null;
        await new Promise(x => setTimeout(x, 400));
      }
    `)
    check('通过面板「开始邀约」创建并启动真实任务', !!tid && !!tid.runId, JSON.stringify(tid))
    if (!tid || !tid.runId) throw new Error('任务未创建')
    note(`任务：${tid.name} / run ${tid.runId}`)
    focusAppWindow(app && app.pid)

    // ---------- 3) 盯运行（无人工门禁：直接真实发送）；按 MAX_ROUNDS 限流 ----------
    const runId = tid.runId
    // 用进度事件数轮次：loop 每跑完一轮会发一条「第 N 轮完成」。
    // 达人邀约按用户要求没有人工确认门禁 —— 发起即真实发送，所以"跑够几批"必须由脚本自己管住。
    await ui.eval(`
      window.__realTest = { rounds: 0, log: [] };
      const onP = e => {
        if (!e) return;
        const msg = String(e.message || '');
        if (/轮完成/.test(msg)) { window.__realTest.rounds += 1; window.__realTest.log.push(msg) }
        else if (/轮/.test(msg) && window.__realTest.log.length < 60) window.__realTest.log.push(msg);
      };
      window.shopilot.on('task:progress', onP);
      return true;
    `)
    let terminal = null
    let cancelledByUs = false
    let pageEvidence = null
    let sawFiltered = null
    let sawDrawer = null
    let lastProbe = 0
    const t0 = Date.now()
    for (;;) {
      const r = await ui.eval(`return await window.shopilot.task.results(${JSON.stringify(runId)});`)
      const run = r && r.ok && r.data ? r.data.run : null
      const prog = await ui.eval(`return { rounds: window.__realTest ? window.__realTest.rounds : 0, tail: window.__realTest ? window.__realTest.log.slice(-3) : [] };`)
      if (run && run.status === 'waiting_confirmation') {
        // 用户要求删掉门禁；真出现就是回归，如实记下来并放行（避免卡住）
        check('运行不应停在人工确认门禁', false, '仍出现了 waiting_confirmation')
        await ui.eval(`return await window.shopilot.task.confirm(${JSON.stringify(runId)}, true);`)
      }
      // 运行中持续抓现场：筛选生效的"已筛选"标记、以及抽屉打开时的表单状态。
      // 为什么要在运行中抓：跑完之后页面会被下一轮 navigate 冲掉（第 1 轮完成的那一刻
      // 第 2 轮就开始了），事后只能看到空白页。
      if (!page) {
        const list = await targets()
        const t = list.find(x => (x.type === 'page' || x.type === 'webview') && /jinritemai\.com/.test(x.url))
        if (t) { page = new CDP(t.webSocketDebuggerUrl); await page.ready }
      }
      if (page && Date.now() - lastProbe > 1800) {
        lastProbe = Date.now()
        const snap = await page.eval(PAGE_STATE).catch(() => null)
        if (snap) {
          if (!sawFiltered && snap.filteredText) sawFiltered = snap.filteredText
          if (!sawDrawer && snap.drawerOpen) {
            sawDrawer = snap
            report.drawerSnapshot = {
              mainTrigger: snap.mainTrigger, goodsAdded: snap.goodsAdded, switchOn: snap.switchOn,
              inputs: snap.drawerInputs, checked: snap.drawerChecked, confirmSendDisabled: snap.confirmSendDisabled,
              counter: snap.counter
            }
            note('抓到抽屉现场：主营=' + snap.mainTrigger + ' / 商品=' + snap.goodsAdded + ' / 开关=' + snap.switchOn)
            note('  联系方式=' + JSON.stringify(snap.drawerInputs) + ' / 已勾选=' + JSON.stringify(snap.drawerChecked))
            await page.shot(path.join(OUT_DIR, '01-drawer-live.png'))
          }
        }
      }
      if (!cancelledByUs && prog.rounds >= MAX_ROUNDS) {
        note(`已跑满 ${prog.rounds} 批，按限流取消运行（真实发送量 = ${prog.rounds} × ${COUNT} 位）`)
        await ui.eval(`return await window.shopilot.task.cancel(${JSON.stringify(runId)});`)
        cancelledByUs = true
      }
      if (run && ['failed', 'succeeded', 'cancelled'].includes(run.status)) { terminal = r.data; break }
      if (Date.now() - t0 > 20 * 60 * 1000) { note('等待超时（20 分钟）'); break }
      await sleep(1000)
    }
    pageEvidence = sawDrawer
    report.sawFiltered = sawFiltered
    report.rounds = await ui.eval(`return window.__realTest ? window.__realTest.rounds : 0`)
    report.progressTail = await ui.eval(`return window.__realTest ? window.__realTest.log.slice(-12) : []`)
    note('进度尾部：' + JSON.stringify(report.progressTail))
    report.runStatus = terminal && terminal.run ? { status: terminal.run.status, errorCode: terminal.run.errorCode, errorMessage: terminal.run.errorMessage, statusReason: terminal.run.statusReason } : null
    note('终态：' + JSON.stringify(report.runStatus))
    // 限流取消属于正常：只要"至少跑满 MAX_ROUNDS 批"且不是 failed 就算通过
    check(`任务直接开跑并真实发送（跑满 ${MAX_ROUNDS} 批后由脚本取消限流）`,
      (terminal?.run.status === 'succeeded' || (cancelledByUs && terminal?.run.status === 'cancelled')) &&
        report.rounds >= MAX_ROUNDS,
      JSON.stringify({ status: terminal?.run?.status, rounds: report.rounds }))
    report.runStatusAtGate = report.runStatus

    // 步骤明细（含 hover 证据）。注意：`steps` 是任务定义，`results` 才是每条步骤的执行结果
    const allResults = (terminal && (terminal.results || [])) || []
    note('results 条数=' + allResults.length +
      (allResults[0] ? ' / 首条键=' + JSON.stringify(Object.keys(allResults[0])) : ''))
    report.resultsSample = allResults.slice(0, 40).map(s => ({
      idx: s.stepIndex, kind: s.kind, stepType: s.stepType, action: s.payload && s.payload.action,
      payload: s.payload && Object.keys(s.payload).length <= 8 ? s.payload : undefined
    }))
    const stepDigest = allResults.filter(s => s.kind === 'executed').map(s => ({ idx: s.stepIndex, payload: s.payload, artifactPath: s.artifactPath }))
    const hoverStep = stepDigest.find(s => s.payload && s.payload.action === 'hover')
    report.hoverEvidence = hoverStep ? hoverStep.payload : null
    const clickAllStep = stepDigest.find(s => s.payload && s.payload.action === 'clickAll')
    report.clickAllEvidence = clickAllStep ? {
      clicked: Array.isArray(clickAllStep.payload.clicked) ? clickAllStep.payload.clicked.length : clickAllStep.payload.clicked,
      pageSelected: clickAllStep.payload.pageSelected,
      skippedDisabled: clickAllStep.payload.skippedDisabled,
      retried: clickAllStep.payload.retried,
      corrected: clickAllStep.payload.corrected
    } : null
    const failedStep = allResults.find(s => s.kind === 'failed')
    if (failedStep) note('失败步骤：' + JSON.stringify({ idx: failedStep.stepIndex, type: failedStep.stepType, error: String(failedStep.errorMessage || '').slice(0, 200) }))

    // ---------- 4) 真机页面取证（运行中抓到的现场） ----------
    check('真机：类目筛选真的生效到「已筛选」标记（一级/二级' + (CAT3 ? '/三级' : '') + '）',
      !!sawFiltered && /个护家清/.test(sawFiltered) && /家清纸品/.test(sawFiltered) && (!CAT3 || sawFiltered.includes(CAT3)),
      JSON.stringify({ filtered: sawFiltered }))
    check('真机：抓到抽屉里的结构化表单现场（改版抽屉：主营/联系方式/已勾选项）',
      !!pageEvidence && !!pageEvidence.mainTrigger && pageEvidence.drawerInputs.length >= 2,
      JSON.stringify(report.drawerSnapshot || null))
    if (page) {
      const ps = await page.eval(PAGE_STATE).catch(() => null)
      report.pageStateFinal = ps
      await page.shot(path.join(OUT_DIR, '04-after-run.png'))
    }
    await ui.shot(path.join(OUT_DIR, '02-panel.png'))

    // ---------- 5) 发送结果取证 ----------
    // 运行已经在第 3 步跑完（无人工门禁，直接真实发送）；这里只做结果核对。
    const loopPayload = terminal && (terminal.results || []).find(r2 => r2.kind === 'executed' && r2.payload && r2.payload.action === 'loop')
    report.loopStop = loopPayload ? { completedRounds: loopPayload.payload.completedRounds, stopReason: loopPayload.payload.stopReason } : null
    note('循环停止原因：' + JSON.stringify(report.loopStop))
    if (loopPayload && loopPayload.artifactPath) {
      note('截图工件：' + loopPayload.artifactPath)
      report.artifact = { path: loopPayload.artifactPath, sha256: loopPayload.artifactSha256 }
    }
    if (page) {
      const after = await page.eval(PAGE_STATE)
      report.pageStateAfter = after
      await page.shot(path.join(OUT_DIR, '04-after-send.png'))
    }
    await ui.shot(path.join(OUT_DIR, '02-panel.png'))
  } catch (err) {
    check('实测执行未中断', false, String(err && err.stack || err))
  } finally {
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
    console.log('\nREPORT ' + path.join(OUT_DIR, 'report.json'))
    ui && ui.close()
    page && page.close()
    // 只关掉本次自己启动的实例；复用的实例留着（探测/后续分析还要用）
    if (app) { killTree(app); await sleep(600) }
  }
  const failed = report.checks.filter(c => !c.ok)
  console.log(`\n通过 ${report.checks.length - failed.length}/${report.checks.length}`)
  if (failed.length) {
    console.log('失败项：' + failed.map(f => f.name).join(' | '))
    process.exitCode = 1
  }
}

main().catch(e => { console.error('RUNNER_ERROR', e); process.exit(1) })
