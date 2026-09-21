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
const http = require('http')
const crypto = require('crypto')
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

/**
 * 本地仿真页面：只提供"自定义任务真的跑起来"所需要的最小确定行为。
 *
 * 为什么必须真跑而不是只断言落库：创建与执行是两套代码（渲染层校验 + 主进程引擎），
 * 落库正确不代表引擎认得这条步骤。这里用确定性的页面把每一步的**结果**钉住。
 */
function startSite() {
  const state = { clicked: 0 }
  const page = () => `<!doctype html><html><head><meta charset="utf-8"><title>自定义任务仿真页</title>
    <style>body{font:14px sans-serif;margin:20px}.hidden{display:none}</style></head><body>
    <h1 id="heading">自定义任务仿真页</h1>
    <div id="metric">待巡检指标：<b>42</b></div>
    <button id="do-click">执行动作</button>
    <div id="done" class="hidden">动作已执行</div>
    <table id="rows"><tbody>
      <tr data-row-key="r1"><td><input type="checkbox" id="row1-check"></td><td>达人甲</td><td>粉丝 1 万</td></tr>
    </tbody></table>
    <script>
      document.getElementById('do-click').addEventListener('click', () => {
        fetch('/__click', { method: 'POST' });
        document.getElementById('done').classList.remove('hidden');
      });
    </script></body></html>`

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/inspect')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page())
      return
    }
    if (req.method === 'POST' && req.url === '/__click') {
      state.clicked += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(404)
    res.end('not found')
  })

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        base: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise(r => server.close(r))
      })
    })
  })
}

/** 轮询运行结果直到谓词满足（与 douyin 验收同一套路） */
async function pollRun(api, runId, predicate, timeoutMs) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    const result = await api.taskResults(runId)
    if (result.ok) {
      last = result.data
      if (predicate(result.data)) return result.data
    }
    await sleep(400)
  }
  return last
}

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

/**
 * 连到**店铺页面本身**（不是渲染层界面）。
 *
 * 拾取验收必须从页面这一侧发真实鼠标事件：脚本里的遮罩是靠"接管指针事件"来保证
 * 不误触平台动作的，而合成事件（dispatchEvent）会绕过命中测试——那样连"遮罩到底在不在"
 * 都证明不了。CDP 的 Input.dispatchMouseEvent 走 Chromium 自己的命中测试，
 * 落到的是最上层元素（也就是我们的遮罩），这才算真在验收。
 */
async function storeTarget(urlPart) {
  try {
    const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json`)
    return targets.find(t => t.type === 'page' && t.url.includes(urlPart)) || null
  } catch {
    return null
  }
}

/** 在店铺页面上跑一段脚本（页面还没出现时返回 null，由调用方决定要不要等） */
async function onStorePage(urlPart, expression) {
  const target = await storeTarget(urlPart)
  if (!target) return null
  const cdp = new CDP(target.webSocketDebuggerUrl)
  try {
    return await cdp.eval(expression)
  } catch {
    return null
  } finally {
    cdp.close()
  }
}

/** 轮询店铺页面，直到表达式返回真值（页面导航/重挂载期间 target 会短暂消失） */
async function waitOnStorePage(urlPart, expression, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs
  let last = null
  while (Date.now() < until) {
    last = await onStorePage(urlPart, expression)
    if (last) return last
    await sleep(200)
  }
  return last
}

/**
 * 在店铺页面上发**真实鼠标事件**（CDP Input 走 Chromium 自己的命中测试）。
 *
 * 不能用 dispatchEvent：它会绕过命中测试，直接落到目标元素上——那样遮罩在不在都测不出来，
 * 而"遮罩有没有拦住点击"正是本功能最关键的安全属性。
 */
async function clickOnStorePage(urlPart, expression, { hoverOnly = false } = {}) {
  const target = await storeTarget(urlPart)
  if (!target) throw new Error('店铺页面 target 不在: ' + urlPart)
  const cdp = new CDP(target.webSocketDebuggerUrl)
  try {
    const box = await cdp.eval(expression)
    if (!box) throw new Error('取不到目标元素的坐标')
    const x = Math.round(box.x), y = Math.round(box.y)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
    await sleep(150)
    if (hoverOnly) return { x, y }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    return { x, y }
  } finally {
    cdp.close()
  }
}

/** 在店铺页面上按一个键（Esc 取消拾取要用） */
async function pressKeyOnStorePage(urlPart, key, code, vk) {
  const target = await storeTarget(urlPart)
  if (!target) throw new Error('店铺页面 target 不在: ' + urlPart)
  const cdp = new CDP(target.webSocketDebuggerUrl)
  try {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
    await cdp.ready
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    return true
  } finally {
    cdp.close()
  }
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
  const site = await startSite()
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

    const api = {
      taskList: () => ui.eval(`return await window.shopilot.task.list();`),
      taskResults: runId => ui.eval(`return await window.shopilot.task.results(${JSON.stringify(runId)});`),
      taskRun: taskId => ui.eval(`return await window.shopilot.task.run(${JSON.stringify(taskId)});`),
      taskDelete: taskId => ui.eval(`return await window.shopilot.task.delete(${JSON.stringify(taskId)});`)
    }

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

    // ②b 目录筛选：目录 22 项、栏内装不下（「点击元素」就在折叠线以下），
    //     筛选是"找不到某一步"的出路——实测用户就是这么反馈的（问「点击元素怎么添加」）
    const filterProbe = await ui.eval(`${DOM}
      const col = q('.ct-palette-body');
      const before = q('[data-test="custom-palette-click"]');
      const cr = col.getBoundingClientRect();
      const belowFold = before.getBoundingClientRect().bottom > cr.bottom;
      setNativeValue(q('[data-test="custom-step-filter"]'), '点击');
      await new Promise(r => setTimeout(r, 150));
      const items = Array.from(document.querySelectorAll('[data-test^="custom-palette-"]'));
      const cr2 = q('.ct-palette-body').getBoundingClientRect();
      const labels = items.map(e => e.textContent.trim());
      const allInView = items.every(e => { const r = e.getBoundingClientRect(); return r.top >= cr2.top && r.bottom <= cr2.bottom; });
      setNativeValue(q('[data-test="custom-step-filter"]'), '');
      await new Promise(r => setTimeout(r, 150));
      return { belowFold, labels, allInView };
    `)
    check('②b 「点击元素」可通过目录或筛选找到', filterProbe.belowFold === true || filterProbe.labels.includes('点击元素'), JSON.stringify(filterProbe))
    check('②b 筛选「点击」后只剩点击类步骤', JSON.stringify(filterProbe.labels) === JSON.stringify(['点击元素', '按文案点击']), JSON.stringify(filterProbe.labels))
    check('②b 筛选结果全部落在视野内（无需滚动）', filterProbe.allInView === true)

    // ③ 从左侧目录加一步「打开网址」并填网址
    //    三栏布局下：目录点即添加，添加后自动选中，参数渲染在右栏
    await ui.eval(`${DOM}
      const item = await waitFor(() => q('[data-test="custom-palette-navigate"]'));
      if (!item) throw new Error('左侧目录里没有「打开网址」');
      item.click();
      return true;
    `)
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

    // ③b 网址格式：写错的地址必须在**客户端**就被拦下并说清原因。
    //     修复前这里放行，点创建才被主进程 Zod 拒，用户看到的是引擎味的
    //     TASK_INVALID_STEP: Invalid url——正是"表单填得好好的、点创建被拒"。
    const badUrls = ['wx.qq.com/page', 'javascript:alert(1)', 'ftp://a.com', 'http://']
    const urlFeedback = await ui.eval(`${DOM}
      const input = q('[data-test="custom-f-0-url"]');
      const seen = [];
      for (const bad of ${JSON.stringify(badUrls)}) {
        setNativeValue(input, bad);
        await new Promise(r => setTimeout(r, 120));
        seen.push({
          url: bad,
          disabled: q('[data-test="task-submit"]').disabled,
          issues: (q('[data-test="custom-issues"]')?.textContent || '').trim()
        });
      }
      setNativeValue(input, 'https://store.weixin.qq.com/shop/brandAndCat/qualification/home');
      await new Promise(r => setTimeout(r, 150));
      return { seen, recovered: q('[data-test="task-submit"]').disabled === false };
    `)
    const badUrlBlocked = urlFeedback.seen.every(s => s.disabled === true && s.issues.includes('网址'))
    check('③b 写错的网址在客户端就被拦下且说明是网址问题',
      badUrlBlocked, JSON.stringify(urlFeedback.seen.map(s => ({ url: s.url, disabled: s.disabled }))))
    check('③b 改回合法网址后恢复可创建', urlFeedback.recovered === true)

    // ③c 文本长度：超过主进程上限的值也必须在客户端拦下。
    //     修复前 501 字符的选择器放行，创建时才报 too_big。
    const lenProbe = await ui.eval(`${DOM}
      q('[data-test="custom-palette-click"]').click();
      await new Promise(r => setTimeout(r, 200));
      const input = await waitFor(() => q('[data-test="custom-f-1-selector"]'));
      if (!input) throw new Error('click 的 selector 字段没渲染出来');
      setNativeValue(input, 'x'.repeat(501));
      await new Promise(r => setTimeout(r, 150));
      const over = { disabled: q('[data-test="task-submit"]').disabled, issues: (q('[data-test="custom-issues"]')?.textContent || '').trim() };
      setNativeValue(input, 'button.submit');
      await new Promise(r => setTimeout(r, 150));
      const okLen = { disabled: q('[data-test="task-submit"]').disabled };
      return { over, okLen };
    `)
    check('③c 超长选择器在客户端被拦下并给出上限',
      lenProbe.over.disabled === true && lenProbe.over.issues.includes('最多 500'),
      lenProbe.over.issues.slice(0, 90))
    check('③c 长度合法后恢复可创建', lenProbe.okLen.disabled === false)

    // 清掉 ③c 临时加的那一步，让后面的用例从"1 步导航"继续
    await ui.eval(`${DOM} q('[data-test="custom-del-1"]').click(); return true;`)
    await sleep(200)

    // ④ 加一步「按文案点击」、填文案、标记为提交动作 → 必须报错且置灰
    await ui.eval(`${DOM} q('[data-test="custom-palette-clickByText"]').click(); return true;`)
    await sleep(250)
    await ui.eval(`${DOM}
      const t = await waitFor(() => q('[data-test="custom-f-1-text"]'));
      if (!t) throw new Error('clickByText 的 text 字段没渲染出来（添加后应当自动选中它）');
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
    await ui.eval(`${DOM} q('[data-test="custom-palette-waitForUserConfirmation"]').click(); return true;`)
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
      // 只取中栏的步骤行（div.ct-step），别把「共 N 步」那个计数元素也算进来
      const labels = Array.from(document.querySelectorAll('div.ct-step[data-test^="custom-step-"]'))
        .map(e => e.querySelector('.ct-step-t')?.textContent?.replace('提交', '')?.trim());
      return { labels, disabled: q('[data-test="task-submit"]').disabled,
               issues: (q('[data-test="custom-issues"]')?.textContent || '').trim() };
    `)
    check('⑤ 上移后门禁排在提交动作之前', afterReorder.labels[1] === '人工确认门禁', JSON.stringify(afterReorder.labels))
    check('⑤ 顺序正确后创建按钮恢复可点', afterReorder.disabled === false, afterReorder.issues.slice(0, 100))

    // ⑦ 目录之外的步骤类型塞不进去（左栏按目录渲染，逐个 type 检查）
    const bannedRejected = await ui.eval(`${DOM}
      const types = Array.from(document.querySelectorAll('[data-test^="custom-palette-"]'))
        .map(e => e.getAttribute('data-test').replace('custom-palette-', ''));
      return { types, hasLoop: types.includes('loop'), hasEnsure: types.some(v => v.startsWith('ensureRows')), hasAi: types.includes('aiGenerate') };
    `)
    check('⑦ 目录里不含 loop/ensureRows/aiGenerate 等高风险步骤',
      !bannedRejected.hasLoop && !bannedRejected.hasEnsure && !bannedRejected.hasAi, JSON.stringify(bannedRejected.types))

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

      // 清理：删掉这一步建的任务（后面还要用同一个店铺跑真正的执行验收）
      await ui.eval(`await window.shopilot.task.delete(${JSON.stringify(created.id)}); return true;`)
    }

    // ==================================================================
    // ⑧ 创建 → 真实运行 → 步骤结果
    //
    // 前面 ①–⑦ 证明的是"编得对、落库对"，但创建与执行是两套代码：
    // 落库对不代表引擎认得这条步骤、更不代表结果如实。这一段把创建出来的任务
    // 真的跑在本地仿真页上，逐条断言**运行结果**（读到的值、点击是否真发生、
    // 截图工件是否落盘且哈希对得上），以及失败时是否如实失败。
    // ==================================================================
    const inspectUrl = site.base + '/inspect'

    const openCustomDialog = async () => {
      await ui.eval(`${DOM} q('[data-test="task-new"]').click(); return true;`)
      await ui.eval(`${DOM} await waitFor(() => q('[data-test="task-dialog"]')); return true;`)
      await ui.eval(`${DOM} setSelect(q('[data-test="task-flow"]'), 'custom'); return true;`)
      await ui.eval(`${DOM} await waitFor(() => q('[data-test="custom-editor"]')); return true;`)
    }

    const addStep = async (type, index, fields) => {
      await ui.eval(`${DOM}
        const item = q('[data-test="custom-palette-${type}"]');
        if (!item) throw new Error('目录里没有 ${type}');
        item.click();
        return true;
      `)
      await sleep(180)
      for (const [key, value] of Object.entries(fields)) {
        await ui.eval(`${DOM}
          const input = await waitFor(() => q('[data-test="custom-f-${index}-${key}"]'));
          if (!input) throw new Error('第 ${index} 步的 ${key} 字段没渲染出来');
          setNativeValue(input, ${JSON.stringify(value)});
          return true;
        `)
        await sleep(120)
      }
    }

    // ---------- ⑧-1 一个能跑通的任务：导航 → 等文案 → 读值 → 点击 → 截图 ----------
    await openCustomDialog()
    await ui.eval(`${DOM} setNativeValue(q('[data-test="custom-name"]'), '自定义任务验收 · 仿真巡检'); return true;`)
    await addStep('navigate', 0, { url: inspectUrl })
    await addStep('waitForText', 1, { text: '自定义任务仿真页' })
    await addStep('readText', 2, { selector: '#metric b', metric: 'inspect.metric' })
    await addStep('click', 3, { selector: '#do-click' })
    await addStep('screenshot', 4, {})

    const composed = await ui.eval(`${DOM}
      return {
        count: q('[data-test="custom-step-count"]').textContent.trim(),
        disabled: q('[data-test="task-submit"]').disabled,
        issues: (q('[data-test="custom-issues"]')?.textContent || '').trim()
      };
    `)
    check('⑧ 五步编排完成且可创建', composed.count.includes('5') && composed.disabled === false,
      JSON.stringify(composed).slice(0, 140))

    await ui.eval(`${DOM} q('[data-test="task-submit"]').click(); return true;`)
    await sleep(1800)

    let runTask = null
    for (let i = 0; i < 25 && !runTask; i++) {
      const listed = await api.taskList()
      if (listed.ok) runTask = (listed.data.tasks || listed.data || []).find(t => t.name === '自定义任务验收 · 仿真巡检')
      if (!runTask) await sleep(300)
    }
    check('⑧ 仿真巡检任务创建成功', !!runTask, runTask ? runTask.id : '未找到')

    if (runTask) {
      const started = await api.taskRun(runTask.id)
      check('⑧ 任务可启动（店铺浏览器已打开，不排队等待）',
        started.ok && started.data?.waitingForStore !== true,
        JSON.stringify(started.error || started.data))

      const runId = started.ok ? started.data?.runId : null
      const terminal = runId
        ? await pollRun(api, runId, d => ['succeeded', 'failed', 'cancelled'].includes(d.run.status), 60000)
        : null
      check('⑧ 任务真实执行并成功收尾',
        terminal?.run.status === 'succeeded',
        terminal ? `${terminal.run.status} / ${terminal.run.errorMessage || terminal.run.statusReason || ''}` : 'no run data')

      const results = terminal?.results || []
      const byType = t => results.find(r => r.kind === t)

      // readText 读到的必须是页面上真实的值（42），而不是空串或占位
      const textResult = byType('text')
      check('⑧ 读值步骤读回页面真实数值（42）',
        textResult?.payload?.text === '42' && textResult?.payload?.metric === 'inspect.metric',
        JSON.stringify(textResult?.payload))

      // 点击必须真的落到页面上（仿真页自己计数）
      check('⑧ 点击步骤真的作用到页面（仿真页收到 1 次点击）',
        site.state.clicked === 1, `clicked=${site.state.clicked}`)

      // 截图必须落盘、非空，且哈希与库里记录一致
      const shot = results.find(r => r.artifactPath)
      const artifactOk = (() => {
        if (!shot?.artifactPath) return { ok: false, why: 'no artifact path' }
        if (!fs.existsSync(shot.artifactPath)) return { ok: false, why: 'file missing' }
        const buf = fs.readFileSync(shot.artifactPath)
        const sha = crypto.createHash('sha256').update(buf).digest('hex')
        return { ok: buf.length > 100 && sha === shot.artifactSha256, why: `${buf.length}B sha=${sha.slice(0, 12)}` }
      })()
      check('⑧ 截图工件落盘、非空且哈希与库记录一致', artifactOk.ok, artifactOk.why)

      // 步骤结果要覆盖到每一个执行过的步骤（不是只记最后一条）
      check('⑧ 步骤结果逐条落库（5 步都有记录）',
        new Set(results.map(r => r.stepIndex)).size >= 5,
        `records=${results.length} steps=${[...new Set(results.map(r => r.stepIndex))].length}`)

      const deleted = await api.taskDelete(runTask.id)
      check('⑧ 验收任务可删除（级联清理运行记录）', deleted.ok, JSON.stringify(deleted.error || deleted.data))
    }

    // 拾取使用 Chromium 命中测试，验证遮罩不会触发页面动作。
    await openCustomDialog()
    await addStep('click', 0, { selector: 'x'.repeat(501) })
    const clickCountBeforePick = site.state.clicked
    const targetCenter = `const r = document.querySelector('#do-click').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`
    const startPick = async (testId) => {
      await ui.eval(`${DOM} q('[data-test="${testId}"]').click(); return true;`)
      const ready = await waitOnStorePage(inspectUrl, `return !!document.getElementById('__shopilot_pick_mask__') && !!document.getElementById('__shopilot_pick_banner__');`)
      if (!ready) throw new Error('拾取遮罩未出现: ' + testId)
    }
    const restoredField = async (testId) => ui.eval(`${DOM}
      const field = await waitFor(() => !q('.picker-mode') && q('[data-test="task-dialog"]')?.getBoundingClientRect().width && q('[data-test="${testId}"]'));
      return field ? field.value : null;
    `)
    await startPick('custom-pick-0-selector')
    const pickLayout = await ui.eval(`${DOM} const el=q('[data-test="task-dialog"]'); const r=el?.getBoundingClientRect(); return { width:r?.width||0, display:el?.style.display||'', picker:document.querySelector('.workbench')?.className||'' };`)
    check('⑨ 拾取时任务编排器仍在右侧可见，页面显示遮罩和提示', pickLayout.width > 0, JSON.stringify(pickLayout))
    const geometry = await ui.eval(`${DOM}
      const panel = q('.task-create-modal'), p = panel.getBoundingClientRect();
      const v = q('.viewport').getBoundingClientRect();
      const f = q('[data-test="custom-f-0-selector"]').getBoundingClientRect();
      return { pageWidth:v.width, panelLeft:p.left, pageRight:v.right,
        separate:v.width > 200 && v.right <= p.left + 1,
        noOverflow:panel.scrollWidth <= panel.clientWidth + 1,
        fieldVisible:f.width > 0 && f.left >= p.left && f.right <= p.right && f.bottom <= p.bottom };
    `)
    check('⑨ 浏览器与编排器无重叠，字段可见且面板无横向溢出', geometry.separate && geometry.noOverflow && geometry.fieldVisible, JSON.stringify(geometry))
    const nativeWidth = await onStorePage(inspectUrl, 'return window.innerWidth;')
    check('⑨ 原生浏览器宽度与预留区域一致', Math.abs(nativeWidth - geometry.pageWidth) <= 1, String(nativeWidth))
    await clickOnStorePage(inspectUrl, targetCenter, { hoverOnly: true })
    check('⑨ 悬停高亮目标', await onStorePage(inspectUrl, `return document.getElementById('__shopilot_pick_outline__')?.style.display === 'block';`))
    await clickOnStorePage(inspectUrl, targetCenter)
    const pickedSelector = await restoredField('custom-f-0-selector')
    check('⑨ 拾取后恢复正常布局和编辑', await ui.eval(`${DOM} return !q('.picker-mode') && q('.ct-palette').getBoundingClientRect().width > 0;`))
    check('⑨ 自动填入可命中目标的选择器并覆盖超长旧值', !!pickedSelector && await onStorePage(inspectUrl,
      `return document.querySelector(${JSON.stringify(pickedSelector)}) === document.querySelector('#do-click');`), String(pickedSelector))
    check('⑨ 拾取没有触发页面按钮', site.state.clicked === clickCountBeforePick)
    await addStep('clickByText', 1, {})
    await startPick('custom-pick-1-text')
    await clickOnStorePage(inspectUrl, targetCenter)
    check('⑨ 文案自动填回且仍选中第二步', await restoredField('custom-f-1-text') === '执行动作')
    await startPick('custom-pick-1-text')
    await pressKeyOnStorePage(inspectUrl, 'Escape', 'Escape', 27)
    check('⑨ Esc 取消保留原字段', await restoredField('custom-f-1-text') === '执行动作')
    check('⑨ 取消提示且清理页面遮罩', await ui.eval(`return document.body.innerText.includes('已取消拾取');`) &&
      await onStorePage(inspectUrl, `return !document.getElementById('__shopilot_pick_mask__');`))
    check('⑨ 所有拾取均未执行页面动作', site.state.clicked === clickCountBeforePick)
    await ui.eval(`${DOM} q('[data-test="custom-del-1"]').click(); return true;`)
    await ui.eval(`${DOM} q('[data-test="custom-del-0"]').click(); return true;`)
    await ui.eval(`${DOM} q('[data-test="task-cancel"]').click(); return true;`)

    // ---------- ⑧-2 一个必然失败的任务：断言"不该出现的文案"确实出现了 ----------
    // 只验证"能成功"是不够的：还要验证失败**如实报出来**，而不是静默记成成功。
    await ui.eval(`${DOM} q('[data-test="task-new"]').click(); return true;`)
    await ui.eval(`${DOM} await waitFor(() => q('[data-test="task-dialog"]')); return true;`)
    await ui.eval(`${DOM} setSelect(q('[data-test="task-flow"]'), 'custom'); return true;`)
    await ui.eval(`${DOM} await waitFor(() => q('[data-test="custom-editor"]')); return true;`)
    await ui.eval(`${DOM} setNativeValue(q('[data-test="custom-name"]'), '自定义任务验收 · 预期失败'); return true;`)
    await addStep('navigate', 0, { url: inspectUrl })
    await addStep('requireTextAbsent', 1, { text: '自定义任务仿真页' })
    await ui.eval(`${DOM} q('[data-test="task-submit"]').click(); return true;`)
    await sleep(1800)

    let failTask = null
    for (let i = 0; i < 25 && !failTask; i++) {
      const listed = await api.taskList()
      if (listed.ok) failTask = (listed.data.tasks || listed.data || []).find(t => t.name === '自定义任务验收 · 预期失败')
      if (!failTask) await sleep(300)
    }
    check('⑧ 预期失败的任务创建成功（说明断言步骤本身是合法编排）', !!failTask, failTask ? failTask.id : '未找到')

    if (failTask) {
      const started = await api.taskRun(failTask.id)
      const runId = started.ok ? started.data?.runId : null
      const terminal = runId
        ? await pollRun(api, runId, d => ['succeeded', 'failed', 'cancelled'].includes(d.run.status), 60000)
        : null
      check('⑧ 断言不成立时任务如实失败（不静默记成功）',
        terminal?.run.status === 'failed',
        terminal ? `${terminal.run.status} / ${terminal.run.errorCode || terminal.run.errorMessage || ''}` : 'no run data')
      // 错误码必须是真实原因，而不是被吞成 INTERNAL_ERROR——
      // 界面直接把 error_code 这一列展示给用户，"内部错误"会让人以为软件坏了。
      check('⑧ 失败错误码是真实原因 TASK_TEXT_PRESENT（不是 INTERNAL_ERROR）',
        terminal?.run.errorCode === 'TASK_TEXT_PRESENT',
        `${terminal?.run.errorCode || ''} ${String(terminal?.run.errorMessage || '').slice(0, 80)}`)

      const deleted = await api.taskDelete(failTask.id)
      check('⑧ 预期失败任务可删除', deleted.ok, JSON.stringify(deleted.error || deleted.data))
    }
  } catch (e) {
    check('验收过程未抛异常', false, String(e && e.message || e))
  } finally {
    try { if (ui) ui.close() } catch { /* ignore */ }
    killTree(app)
    await sleep(800)
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* 临时目录交给系统回收 */ }
    try { await site.close() } catch { /* ignore */ }
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
