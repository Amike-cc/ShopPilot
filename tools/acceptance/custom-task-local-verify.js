/**
 * 自定义任务（步骤编排）本地端到端验收。
 *
 * 为什么用 CDP 而不是像素点击：本功能的界面是"表单 + 小按钮"，像素坐标在缩放/滚动下极易点偏，
 * 而验收要断言的是**行为**（门禁拦不拦、创建出来的步骤对不对），不是"我点没点中"。
 * 与仓库既有的 douyin-invite-local-verify.js 同一套路：独立临时 userData + remote-debugging-port，
 * 在真实渲染层里派发原生事件驱动 Vue，再用应用自己的 IPC 核对结果。
 *
 * 使用独立临时 userData，不碰用户真实数据。
 *
 * 覆盖：
 *   ① 新建任务对话框里有「自定义任务」且可选（初始不被误标成"不可用"）；
 *   ② 空编排 → 报错且创建按钮置灰（不能建出空任务）；
 *   ③ 从目录加步骤、填参数、上移/下移排序；
 *   ④ **标记"提交动作"但没有前置门禁 → 报错 + 创建按钮置灰**（本功能最关键的安全约束）；
 *   ⑤ 补上门禁并排到它前面 → 报错消失、按钮恢复；
 *   ⑥ 创建成功，且落库的步骤类型/参数与编排一致；
 *   ⑦ 目录之外的步骤类型塞不进去（白名单没被绕过）。
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.resolve(__dirname, '../..')
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = process.env.SHOPILOT_CUSTOM_CDP_PORT || '9271'
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

// ---------- 在渲染层里驱动界面的小工具（都走原生事件，Vue 才认） ----------

const DOM = `
const q = (sel) => document.querySelector(sel);
const byText = (sel, text) => Array.from(document.querySelectorAll(sel)).find(e => (e.textContent || '').includes(text));
const setNativeValue = (el, value) => {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
const setSelect = (el, value) => {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
const setCheck = (el, on) => {
  if (el.checked !== on) el.click();
};
const waitFor = async (fn, ms = 6000) => {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await new Promise(r => setTimeout(r, 80));
  }
};
`

async function main() {
  const userData = path.join(os.tmpdir(), 'shopilot-custom-task-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  freeDebugPort(CDP_PORT)

  let app = null
  let ui = null
  try {
    app = spawn(electronExe, [
      '.',
      `--remote-debugging-port=${CDP_PORT}`,
      '--user-data-dir=' + userData,
      '--no-sandbox'
    ], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'production', ELECTRON_ENABLE_LOGGING: '1', SHOPILOT_DISABLE_CDP_FP: '1' },
      stdio: 'ignore'
    })

    await waitForCDP()
    ui = await connectUi()

    // 准备：建一个店铺并打开（自定义任务要求已打开店铺）
    const storeId = await ui.eval(`
      const r = await window.shopilot.store.create({ name: '自定义任务验收店', platform: '抖音小店', adminUrl: 'https://fxg.jinritemai.com/' });
      if (!r.ok) throw new Error('store.create failed: ' + JSON.stringify(r.error));
      return r.data.id;
    `)
    check('准备：创建并打开一个店铺', !!storeId, storeId)

    await sleep(1000)

    // 通过 IPC 建的店铺不会自动进渲染层的列表，重载一次让界面按真实启动路径加载
    // （reload 会把当前文档导航掉，所以不 await 结果，只把它发出去）
    try { await ui.eval(`void location.reload()`, false) } catch { /* 导航中连接可能断开，属正常 */ }
    await sleep(3000)
    ui = await connectUi()

    // 走界面打开店铺：点卡片上的「打开浏览器」按钮（.store-action）。
    // 不能只用 IPC 打开——渲染层的 openStoreIds 也要跟着更新，右侧面板才认这个店铺。
    await ui.eval(`${DOM}
      const card = await waitFor(() => byText('[data-test="store-card"]', '自定义任务验收店'), 10000);
      if (!card) throw new Error('店铺卡片没渲染出来');
      const action = card.querySelector('.store-action');
      if (!action) throw new Error('店铺卡片上没有「打开浏览器」按钮');
      action.click();
      return true;
    `)
    await sleep(2500)

    // ① 打开新建任务对话框（「新建任务」按钮在右侧「任务」面板里，先把面板切过去）
    const panelDiag = await ui.eval(`${DOM}
      return {
        hasRightPanel: !!q('[data-test="right-panel"]'),
        ptabs: Array.from(document.querySelectorAll('.ptab')).map(e => e.textContent.trim()),
        rails: Array.from(document.querySelectorAll('.rail-btn')).map(e => e.textContent.trim()),
        storeCards: document.querySelectorAll('[data-test="store-card"]').length
      };
    `)
    console.log('   [诊断] 右侧面板状态:', JSON.stringify(panelDiag))

    await ui.eval(`${DOM}
      const tab = await waitFor(() => byText('.ptab', '任务') || byText('.rail-btn', '任务'));
      if (!tab) throw new Error('找不到右侧「任务」面板页签');
      tab.click();
      return true;
    `)
    await sleep(400)

    await ui.eval(`${DOM}
      const btn = await waitFor(() => q('[data-test="task-new"]'));
      if (!btn) throw new Error('找不到「新建任务」按钮');
      btn.click();
      return true;
    `)
    const hasDialog = await ui.eval(`${DOM} return !!(await waitFor(() => q('[data-test="task-dialog"]')));`)
    check('① 新建任务对话框可打开', hasDialog)

    // ① 自定义任务选项存在且未被标成"不可用"
    const optionText = await ui.eval(`${DOM}
      const sel = q('[data-test="task-flow"]');
      const opt = Array.from(sel.options).find(o => o.value === 'custom');
      return opt ? opt.textContent.trim() : null;
    `)
    check('① 任务类型里有「自定义任务」', !!optionText, String(optionText))
    check('① 店铺已打开时不被误标为"不可用"', optionText && !optionText.includes('不可用'), String(optionText))

    // 切到自定义任务
    await ui.eval(`${DOM} setSelect(q('[data-test="task-flow"]'), 'custom'); return true;`)
    await sleep(300)

    const editorUp = await ui.eval(`${DOM} return !!(await waitFor(() => q('[data-test="custom-editor"]')));`)
    check('① 自定义编排器渲染出来', editorUp)

    // ② 空编排 → 报错 + 创建按钮置灰
    const emptyState = await ui.eval(`${DOM}
      const issues = (q('[data-test="custom-issues"]')?.textContent || '').trim();
      return { issues, disabled: q('[data-test="task-submit"]').disabled, count: q('[data-test="custom-step-count"]').textContent.trim() };
    `)
    check('② 空编排时报"至少要有一个步骤"', emptyState.issues.includes('至少要有一个步骤'), emptyState.issues.slice(0, 60))
    check('② 空编排时创建按钮置灰', emptyState.disabled === true)

    // ③ 加一步「打开网址」并填网址
    await ui.eval(`${DOM} setSelect(q('[data-test="custom-add-type"]'), 'navigate'); return true;`)
    await ui.eval(`${DOM} q('[data-test="custom-add"]').click(); return true;`)
    await sleep(250)
    await ui.eval(`${DOM}
      const input = await waitFor(() => q('[data-test="custom-f-0-url"]'));
      if (!input) throw new Error('navigate 的 url 字段没渲染出来');
      setNativeValue(input, 'https://store.weixin.qq.com/shop/brandAndCat/qualification/home');
      return true;
    `)
    const afterNav = await ui.eval(`${DOM}
      return { count: q('[data-test="custom-step-count"]').textContent.trim(), disabled: q('[data-test="task-submit"]').disabled,
               issues: (q('[data-test="custom-issues"]')?.textContent || '').trim() };
    `)
    check('③ 加步骤后步数正确', afterNav.count.includes('1'), afterNav.count)
    check('③ 只有导航步骤时可创建（无阻断错误）', afterNav.disabled === false, afterNav.issues.slice(0, 80))

    // ④ 加一步「按文案点击」、填文案、标记为提交动作 → 必须报错且置灰
    await ui.eval(`${DOM} setSelect(q('[data-test="custom-add-type"]'), 'clickByText'); return true;`)
    await ui.eval(`${DOM} q('[data-test="custom-add"]').click(); return true;`)
    await sleep(250)
    await ui.eval(`${DOM}
      const t = await waitFor(() => q('[data-test="custom-f-1-text"]'));
      if (!t) throw new Error('clickByText 的 text 字段没渲染出来');
      setNativeValue(t, '确认发送');
      return true;
    `)
    const submitBox = await ui.eval(`${DOM} return !!q('[data-test="custom-submit-1"]');`)
    check('④ 副作用步骤出现「提交动作」勾选框', submitBox)

    await ui.eval(`${DOM} setCheck(q('[data-test="custom-submit-1"]'), true); return true;`)
    await sleep(300)
    const noGate = await ui.eval(`${DOM}
      return { disabled: q('[data-test="task-submit"]').disabled,
               issues: (q('[data-test="custom-issues"]')?.textContent || '').trim() };
    `)
    check('④ 标了提交动作但无门禁 → 创建按钮置灰', noGate.disabled === true)
    check('④ 且明确说明缺前置门禁', noGate.issues.includes('门禁'), noGate.issues.slice(0, 100))

    // ⑤ 加「人工确认门禁」并移到提交动作之前
    await ui.eval(`${DOM} setSelect(q('[data-test="custom-add-type"]'), 'waitForUserConfirmation'); return true;`)
    await ui.eval(`${DOM} q('[data-test="custom-add"]').click(); return true;`)
    await sleep(250)
    await ui.eval(`${DOM}
      const m = await waitFor(() => q('[data-test="custom-f-2-message"]'));
      if (!m) throw new Error('waitForUserConfirmation 的 message 字段没渲染出来');
      setNativeValue(m, '确认在资质页执行自定义操作？');
      return true;
    `)
    const stillBlocked = await ui.eval(`${DOM} return q('[data-test="task-submit"]').disabled;`)
    check('⑤ 门禁加在提交动作之后仍被拦（顺序必须对）', stillBlocked === true)

    // 把门禁上移一位（步骤 3 → 步骤 2）
    await ui.eval(`${DOM} q('[data-test="custom-up-2"]').click(); return true;`)
    await sleep(300)
    const afterReorder = await ui.eval(`${DOM}
      // 只取步骤容器（div.ct-step），别把「共 N 步」那个计数元素也算进来
      const labels = Array.from(document.querySelectorAll('div.ct-step[data-test^="custom-step-"]'))
        .map(e => e.querySelector('.ct-label')?.textContent?.trim());
      return { labels, disabled: q('[data-test="task-submit"]').disabled,
               issues: (q('[data-test="custom-issues"]')?.textContent || '').trim() };
    `)
    check('⑤ 上移后门禁排在提交动作之前', afterReorder.labels[1] === '人工确认门禁', JSON.stringify(afterReorder.labels))
    check('⑤ 顺序正确后创建按钮恢复可点', afterReorder.disabled === false, afterReorder.issues.slice(0, 100))

    // ⑦ 目录之外的步骤类型塞不进去
    const bannedRejected = await ui.eval(`${DOM}
      const sel = q('[data-test="custom-add-type"]');
      const values = Array.from(sel.options).map(o => o.value).filter(Boolean);
      return { hasLoop: values.includes('loop'), hasEnsure: values.some(v => v.startsWith('ensureRows')), hasAi: values.includes('aiGenerate') };
    `)
    check('⑦ 目录里不含 loop/ensureRows/aiGenerate 等高风险步骤',
      !bannedRejected.hasLoop && !bannedRejected.hasEnsure && !bannedRejected.hasAi, JSON.stringify(bannedRejected))

    // ⑥ 填任务名并创建
    await ui.eval(`${DOM} setNativeValue(q('[data-test="custom-name"]'), '自定义任务验收 · 资质页巡检'); return true;`)
    await ui.eval(`${DOM} q('[data-test="task-submit"]').click(); return true;`)
    await sleep(2000)

    const created = await ui.eval(`
      const r = await window.shopilot.task.list();
      const tasks = r.ok ? (r.data.tasks || r.data) : [];
      const t = tasks.find(x => x.name === '自定义任务验收 · 资质页巡检');
      return t ? { id: t.id, name: t.name, storeScope: t.storeScope, steps: t.steps.map(s => ({ type: s.type, input: s.input })) } : null;
    `)
    check('⑥ 自定义任务创建成功并出现在任务列表', !!created, created ? created.id : '未找到')

    if (created) {
      const types = created.steps.map(s => s.type)
      check('⑥ 落库的步骤类型与编排一致',
        JSON.stringify(types) === JSON.stringify(['navigate', 'waitForUserConfirmation', 'clickByText']),
        JSON.stringify(types))
      const urlStep = created.steps[0].input || {}
      check('⑥ 导航参数如实落库', urlStep.url === 'https://store.weixin.qq.com/shop/brandAndCat/qualification/home', JSON.stringify(urlStep))
      const gateStep = created.steps[1].input || {}
      check('⑥ 门禁提示语如实落库', gateStep.message === '确认在资质页执行自定义操作？', JSON.stringify(gateStep))
      const clickStep = created.steps[2].input || {}
      check('⑥ 点击文案如实落库', clickStep.text === '确认发送', JSON.stringify(clickStep))
      check('⑥ 编排器元数据（submit）没有混进引擎步骤', !('submit' in clickStep), JSON.stringify(clickStep))
      check('⑥ 任务绑定了店铺', created.storeScope === storeId, String(created.storeScope))

      // 清理：删掉验收建的任务与店铺
      await ui.eval(`await window.shopilot.task.delete(${JSON.stringify(created.id)}); return true;`)
    }
  } catch (e) {
    check('验收过程未抛异常', false, String(e && e.message || e))
  } finally {
    try { if (ui) ui.close() } catch { /* ignore */ }
    killTree(app)
    await sleep(800)
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* 临时目录交给系统回收 */ }
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n===== 自定义任务验收：${results.length - failed.length}/${results.length} 通过 =====`)
  if (failed.length) {
    console.log('失败项：')
    for (const f of failed) console.log(` - ${f.name}${f.detail ? ' :: ' + f.detail : ''}`)
    process.exit(1)
  }
}

main()
