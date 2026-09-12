/**
 * M3 任务引擎验收（CDP 驱动）：
 * 预定义步骤执行 / 状态机与失败恢复 / 人工确认门禁 / Scheduler /
 * task_step_results 工件 / store_snapshots 指标聚合 / UI 任务面板。
 * 前置：应用已带 --remote-debugging-port 启动（m3-runner.js 负责）。
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')

const CDP_PORT = process.env.SHOPILOT_CDP_PORT || '9225'
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`
const APP_PID = process.env.SHOPILOT_APP_PID

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/**
 * 把被测窗口拉回前台后再做截图类断言。
 * 被其他窗口遮挡时 Chromium 不会继续合成，WebContentsView.capturePage 一直返回空图
 * （报 CAPTURE_EMPTY）。只影响本验收脚本，产品行为不变。
 */
function refocusApp() {
  if (process.platform !== 'win32' || !APP_PID) return
  try {
    execSync(
      `powershell -NoProfile -Command "$w = New-Object -ComObject WScript.Shell; ` +
      `for ($i = 0; $i -lt 20; $i++) { if ($w.AppActivate(${APP_PID})) { break }; Start-Sleep -Milliseconds 300 }"`,
      { stdio: 'ignore', timeout: 20000 }
    )
  } catch { /* 激活失败就照常继续：会在断言里如实暴露 */ }
}

function finishEarly(results) {
  const passed = results.filter(r => r.ok).length
  console.log(`\n通过 ${passed}/${results.length}（主线任务无法启动，提前终止）`)
  process.exit(1)
}

class CDPSession {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve()
      this.ws.onerror = reject
    })
    this.ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
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
  async evaluate(fnBody, timeoutMs = 45000) {
    await this.ready
    // 给每次求值加超时：页面若被弹窗/导航卡住，Promise 会永不 settle，验收脚本会静默挂死
    // （实测踩过：日志停在某一行不动，只能靠人工判断）。超时后如实抛错，定位到具体那一步。
    const r = await Promise.race([
      this.send('Runtime.evaluate', {
        expression: `(async () => { ${fnBody} })()`, awaitPromise: true, returnByValue: true
      }),
      new Promise((_res, rej) => setTimeout(() => rej(new Error(`页面求值超时（${timeoutMs}ms）：${String(fnBody).replace(/\s+/g, ' ').trim().slice(0, 120)}`)), timeoutMs))
    ])
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  close() { try { this.ws.close() } catch {} }
}

/** 任务目标测试站点（§11.3：本地 http 站点） */
function startSite() {
  const ORDERS = `<!doctype html><html><head><title>订单中心-M3</title></head><body>
    <h1 id="page-title">订单中心</h1>
    <div id="unread-count">12 条未读</div>
    <table id="orders">
      <tr><th>单号</th><th>状态</th></tr>
      <tr><td>A-1001</td><td>待发货</td></tr>
      <tr><td>A-1002</td><td>已发货</td></tr>
      <tr><td>A-1003</td><td>退款中</td></tr>
    </table>
    <textarea id="draft-box"></textarea>
    <div id="slot"></div>
    <script>setTimeout(() => { const d = document.createElement('div'); d.id = 'late-item'; d.textContent = '迟到元素'; document.getElementById('slot').appendChild(d); }, 1500);</script>
    </body></html>`
  const BLANK = `<!doctype html><html><head><title>空白页-M3</title></head><body><h1 id="hello">你好 M3</h1></body></html>`
  // 副作用步骤（click/clickByText/clickAll/setInput）的验证页：
  // - #echo 只有真正收到 input 事件才更新 → 用于验证 setInput 是否按受控组件方式派发事件
  // - .pick 共 5 个：A/B/C 可用、D 用 disabled 属性禁用、E 用"祖先带 disabled 类"禁用
  //   → 用于验证 clickAll 跳过禁用项而不是硬点
  // - #sent-count 只在点了 #confirm-send 后 +1 → 用于验证门禁拒绝时提交步骤确实没执行
  // - #drawer 用 position:fixed（真实抽屉的形态）→ 用于验证 aiGenerate 在 sourceSelector 留空时
  //   能沿话术框向上找到"固定定位浮层"读商品信息；抽屉未打开（display:none，尺寸为 0）时如实失败
  const INVITE = `<!doctype html><html><head><title>邀约页-M3</title></head><body>
    <h1 id="invite-title">达人邀约</h1>
    <button id="open-drawer">批量邀约带货</button>
    <div id="drawer" style="display:none;position:fixed;top:0;right:0;width:52%;height:100%;background:#fff;overflow:auto">
      <div id="drawer-goods">
        <div>植绒小灯笼串挂饰 新年春节喜庆装饰 到手价 ¥5.8 全部达人佣金 25%</div>
        <div>新款千元通用红包袋 春节创意福利 到手价 ¥4.99 全部达人佣金 25%</div>
      </div>
      <textarea id="script-box"></textarea>
      <div id="echo">空</div>
      <button id="confirm-send">确认发送</button>
    </div>
    <div id="picked-count">0</div>
    <div id="sent-count">0</div>
    <div id="goods">
      <div>植绒小灯笼串挂饰 新年春节喜庆装饰 到手价 ¥5.8 全部达人佣金 25%</div>
      <div>新款千元通用红包袋 春节创意福利 到手价 ¥4.99 全部达人佣金 25%</div>
    </div>
    <div class="row"><input type="checkbox" class="pick"><span>达人A</span></div>
    <div class="row"><input type="checkbox" class="pick"><span>达人B</span></div>
    <div class="row"><input type="checkbox" class="pick"><span>达人C</span></div>
    <div class="row"><input type="checkbox" class="pick" disabled><span>达人D</span></div>
    <div class="row auxo-checkbox-disabled"><input type="checkbox" class="pick"><span>达人E</span></div>
    <script>
      document.getElementById('script-box').addEventListener('input', function (e) {
        document.getElementById('echo').textContent = e.target.value;
      });
      var picks = Array.prototype.slice.call(document.querySelectorAll('.pick'));
      var render = function () {
        document.getElementById('picked-count').textContent = String(picks.filter(function (p) { return p.checked }).length);
      };
      picks.forEach(function (p) { p.addEventListener('change', render) });
      render();
      document.getElementById('open-drawer').addEventListener('click', function () {
        document.getElementById('drawer').style.display = 'block';
      });
      document.getElementById('confirm-send').addEventListener('click', function () {
        var n = document.getElementById('sent-count');
        n.textContent = String(Number(n.textContent) + 1);
      });
    </script>
    </body></html>`
  // AI 生成步骤用的假端点：OpenAI 兼容 /chat/completions，返回固定话术（不发真实网络请求）
  const AI_REPLY = JSON.stringify({
    id: 'chatcmpl-m3fake', object: 'chat.completion', model: 'm3-fake-model',
    choices: [{ index: 0, message: { role: 'assistant', content: '您好，我们是工厂店，主营个护家清，客单 20-50 元、复购稳定，想邀请您合作带货，可给专属高佣与免费寄样。' }, finish_reason: 'stop' }]
  })
  // 「获取可用模型」的假端点：OpenAI 兼容 GET /models
  const AI_MODELS = JSON.stringify({
    object: 'list',
    data: [
      { id: 'm3-fake-model', object: 'model' },
      { id: 'm3-fake-lite', object: 'model' },
      { id: 'm3-fake-pro', object: 'model' }
    ]
  })
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (req.url.startsWith('/orders')) res.end(ORDERS)
    else if (req.url.startsWith('/blank')) res.end(BLANK)
    else if (req.url.startsWith('/ai/chat/completions')) res.end(AI_REPLY)
    else if (req.url.startsWith('/ai/models')) res.end(AI_MODELS)
    else if (req.url.startsWith('/invite')) res.end(INVITE)
    else res.end('<html><body>404</body></html>')
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

async function main() {
  const results = []
  const check = (name, ok, extra = '') => {
    results.push({ name, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
  }

  const { server, port: SITE_PORT } = await startSite()
  const BASE = `http://127.0.0.1:${SITE_PORT}`
  console.log('本地测试站点已监听 127.0.0.1:' + SITE_PORT)

  const targets = await (await fetch(CDP_BASE + '/json')).json()
  const ui = targets.find(t => t.type === 'page' && (t.url.includes('index.html') || t.url.startsWith('file:')))
  const cdp = new CDPSession(ui.webSocketDebuggerUrl)
  await cdp.evaluate(`const d = Date.now() + 15000; while (!window.shopilot && Date.now() < d) await new Promise(r => setTimeout(r, 100)); return !!window.shopilot;`)

  const call = async (expr) => cdp.evaluate(`return await (${expr});`)
  const api = {
    taskCreate: (input) => call(`window.shopilot.task.create(${JSON.stringify(input)})`),
    taskList: () => call('window.shopilot.task.list()'),
    taskRun: (id, sid) => call(`window.shopilot.task.run(${JSON.stringify(id)}${sid ? ', ' + JSON.stringify(sid) : ''})`),
    taskPause: (rid) => call(`window.shopilot.task.pause(${JSON.stringify(rid)})`),
    taskResume: (rid, mode) => call(`window.shopilot.task.resume(${JSON.stringify(rid)}${mode ? ', ' + JSON.stringify(mode) : ''})`),
    taskCancel: (rid) => call(`window.shopilot.task.cancel(${JSON.stringify(rid)})`),
    taskConfirm: (rid, ap) => call(`window.shopilot.task.confirm(${JSON.stringify(rid)}, ${ap})`),
    taskResults: (rid) => call(`window.shopilot.task.results(${JSON.stringify(rid)})`),
    taskDelete: (id) => call(`window.shopilot.task.delete(${JSON.stringify(id)})`),
    taskFire: (id) => call(`window.shopilot.task.fireScheduled(${JSON.stringify(id)})`),
    snapshots: (sid) => call(`window.shopilot.snapshot.list(${JSON.stringify(sid)}, 50)`),
    storeCreate: (input) => call(`window.shopilot.store.create(${JSON.stringify(input)})`),
    browserOpen: (sid) => call(`window.shopilot.browser.open(${JSON.stringify(sid)})`),
    sessionStatus: (sid) => call(`window.shopilot.session.status(${JSON.stringify(sid)})`),
    auditQuery: (limit) => call(`window.shopilot.audit.query({ limit: ${limit || 300} })`),
    aiConfigGet: () => call('window.shopilot.ai.configGet()'),
    aiConfigSet: (input) => call(`window.shopilot.ai.configSet(${JSON.stringify(input)})`),
    aiKeySet: (key) => call(`window.shopilot.ai.setKey(${JSON.stringify(key)})`),
    aiKeyClear: () => call('window.shopilot.ai.clearKey()'),
    aiTest: () => call('window.shopilot.ai.test()'),
    aiListModels: () => call('window.shopilot.ai.listModels()'),
    storeList: () => call('window.shopilot.store.list()'),
    storeDeletePerm: (sid) => call(`window.shopilot.store.deletePermanent(${JSON.stringify(sid)})`),
    storePurge: (sid) => call(`window.shopilot.store.purge(${JSON.stringify(sid)})`),
    trashList: () => call('window.shopilot.store.trashList()')
  }

  const runStatusOf = async (rid) => {
    const r = await api.taskResults(rid)
    return r.ok ? r.data.run.status : 'NOT_FOUND'
  }
  const pollRun = async (rid, pred, timeoutMs = 30000) => {
    const t0 = Date.now()
    for (;;) {
      const r = await api.taskResults(rid)
      if (r.ok && pred(r.data)) return r.data
      if (Date.now() - t0 > timeoutMs) return r.ok ? r.data : null
      await sleep(400)
    }
  }
  const TERMINAL = s => ['succeeded', 'failed', 'cancelled'].includes(s)

  // ---------- 0. preload API ----------
  const apiShape = await cdp.evaluate(`return { task: !!window.shopilot.task, snap: !!window.shopilot.snapshot, keys: window.shopilot.task ? Object.keys(window.shopilot.task).length : 0 };`)
  check('preload task/snapshot API 已注入', apiShape.task && apiShape.snap && apiShape.keys >= 9, JSON.stringify(apiShape))

  // ---------- 1. 前置清理 ----------
  const pre = await api.taskList()
  if (pre.ok) for (const t of pre.data) await api.taskDelete(t.id)

  // ---------- 2. 创建校验（Zod 白名单） ----------
  const badType = await api.taskCreate({ name: 'x', steps: [{ type: 'evalAnyJS', input: {} }] })
  check('未知步骤类型被拒 TASK_INVALID_STEP', !badType.ok && badType.error?.code === 'TASK_INVALID_STEP', badType.error?.code)
  const badUrl = await api.taskCreate({ name: 'x', steps: [{ type: 'navigate', input: { url: 'javascript:alert(1)' } }] })
  check('非 http(s) 导航目标被拒', !badUrl.ok && badUrl.error?.code === 'TASK_INVALID_STEP', badUrl.error?.message?.slice(0, 60))
  const emptySteps = await api.taskCreate({ name: 'x', steps: [] })
  check('空步骤列表被拒', !emptySteps.ok && emptySteps.error?.code === 'TASK_INVALID_STEP')
  const noSelector = await api.taskCreate({ name: 'x', steps: [{ type: 'readText', input: { nope: 1 } }] })
  check('步骤参数缺失/多余被拒（strict schema）', !noSelector.ok && noSelector.error?.code === 'TASK_INVALID_STEP')

  // 步骤超时上限必须覆盖"人工确认门禁"的默认值（1 小时）——曾写死 10 分钟，
  // 导致把门禁 timeoutMs 设成 30 分钟的「达人邀约」任务在创建阶段就被拒（实测 too_big）
  const gate30 = await api.taskCreate({ name: '门禁30分钟', steps: [
    { type: 'waitForUserConfirmation', input: { message: '确认？' }, timeoutMs: 1800000 }
  ]})
  check('门禁 30 分钟超时可创建（上限覆盖确认门禁语义）', gate30.ok, String(gate30.error?.message || '').slice(0, 80))
  if (gate30.ok) await api.taskDelete(gate30.data.id)
  const gateTooLong = await api.taskCreate({ name: '门禁超上限', steps: [
    { type: 'waitForUserConfirmation', input: { message: '确认？' }, timeoutMs: 3600001 }
  ]})
  check('超过 1 小时的步骤超时仍被拒（上限不是无界）',
    !gateTooLong.ok && gateTooLong.error?.code === 'TASK_INVALID_STEP', gateTooLong.error?.code)
  const gateDefault = await api.taskCreate({ name: '门禁默认', steps: [
    { type: 'waitForUserConfirmation', input: { message: '确认？' } }
  ]})
  check('门禁默认超时注入 60 分钟（且落在 schema 上限内）',
    gateDefault.ok && gateDefault.data.steps[0].timeoutMs === 3600000,
    't=' + gateDefault.data?.steps?.[0]?.timeoutMs)
  if (gateDefault.ok) await api.taskDelete(gateDefault.data.id)

  // ---------- 3. 主线读取任务 ----------
  const mainTask = await api.taskCreate({
    name: '订单中心巡检',
    steps: [
      { type: 'navigate', input: { url: BASE + '/orders' } },
      { type: 'waitForSelector', input: { selector: '#late-item' }, timeoutMs: 8000 },
      { type: 'readText', input: { selector: '#unread-count', metric: 'unread_messages' } },
      { type: 'readTable', input: { selector: '#orders', metric: 'pending_orders' } },
      { type: 'screenshot' },
      { type: 'waitForUserConfirmation', input: { message: '巡检完成，允许记录结果？' } }
    ]
  })
  check('task:create 六步主线任务成功', mainTask.ok, mainTask.error?.message)
  const mt = mainTask.data
  check('默认超时注入（navigate 15s / confirm 60min）',
    mt?.steps?.[0]?.timeoutMs === 15000 && mt?.steps?.[5]?.timeoutMs === 3600000,
    `t0=${mt?.steps?.[0]?.timeoutMs} t5=${mt?.steps?.[5]?.timeoutMs}`)

  /** 通过 UI 点击打开店铺（渲染 viewport + displayedStoreId，真实用户路径） */
  async function openStoreViaUI(name) {
    await cdp.evaluate(`setTimeout(() => location.reload(), 30); return true;`)
    await sleep(3500)
    return cdp.evaluate(`
      const cards = [...document.querySelectorAll('.store-card')];
      const c = cards.find(x => x.textContent.includes(${JSON.stringify(name)}));
      if (!c) return false;
      const btn = c.querySelector('.store-action');
      (btn || c).click();
      return true;
    `)
  }

  const s1 = await api.storeCreate({ name: 'M3店铺一', platform: '拼多多', adminUrl: BASE + '/orders' })
  const sid1 = s1.data.id
  refocusApp()
  await sleep(800)
  const opened1 = await openStoreViaUI('M3店铺一')
  check('UI 点击店铺 ▶ 打开（渲染 viewport 真实路径）', opened1)
  await sleep(1500) // viewport 上报 + 默认标签文档提交

  // 先收起右栏（此时无待确认）→ 任务随后撞上确认门禁 → 应自动临时展开，门禁提示不被藏起来
  const collapsedBeforeRun = await cdp.evaluate(`
    const btn = document.querySelector('[data-test="panel-collapse"]');
    if (!btn) return { error: '未找到收起按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 700));
    return { rail: !!document.querySelector('.panel-rail'), width: Math.round(document.querySelector('[data-test="right-panel"]').getBoundingClientRect().width) };
  `)
  check('无待确认时可正常收起右栏', collapsedBeforeRun.rail === true && collapsedBeforeRun.width === 44, JSON.stringify(collapsedBeforeRun))

  const run1 = await api.taskRun(mt.id, sid1)
  check('task:run 运行时选店（未绑定任务）返回 runId', run1.ok && !!run1.data.runId && run1.data.waitingForStore === false, JSON.stringify(run1.data || run1.error))
  if (!run1.ok) finishEarly(results)
  const rid1 = run1.data.runId

  const done1 = await pollRun(rid1, d => d.run.status === 'waiting_confirmation', 30000)
  check('推进至确认门禁 waiting_confirmation（含 1.5s 迟到元素等待）', !!done1 && done1.run.status === 'waiting_confirmation',
    done1?.run.status + (done1?.run.errorCode ? ' / ' + done1.run.errorCode + ': ' + String(done1.run.errorMessage || '').slice(0, 80) : '') + ' / step=' + done1?.run.currentStep)

  const autoExpanded = await cdp.evaluate(`
    await new Promise(r => setTimeout(r, 800));
    const panel = document.querySelector('[data-test="right-panel"]');
    return {
      width: Math.round(panel.getBoundingClientRect().width),
      rail: !!document.querySelector('.panel-rail'),
      bar: !!document.querySelector('[data-test="task-confirm"]'),
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()).filter(t => t.includes('人工确认'))
    };
  `)
  check('收起状态下确认门禁到达 → 自动临时展开并提示（提示永不被藏起来）',
    autoExpanded.rail === false && autoExpanded.width === 320 && autoExpanded.bar === true && autoExpanded.toasts.length > 0,
    JSON.stringify(autoExpanded))

  // 切到任务面板 → UI 确认条 → 点「允许」
  const tabOn = await cdp.evaluate(`
    const tabs = [...document.querySelectorAll('.ptab')];
    const t = tabs.find(b => b.textContent.trim() === '任务');
    if (t) t.click();
    return !!t;
  `)
  await sleep(700)
  const uiCards = await cdp.evaluate(`return document.querySelectorAll('.task-card').length;`)
  check('UI 任务面板渲染（tab 存在 + 任务卡片）', tabOn && uiCards >= 1, 'cards=' + uiCards)

  // 二级页签：任务列表 / 达人邀约——切走再切回，任务列表必须完好
  const subTabs = await cdp.evaluate(`
    const inv = document.querySelector('[data-test="task-tab-invite"]');
    const tl = document.querySelector('[data-test="task-tab-tasks"]');
    if (!inv || !tl) return { error: 'NO_SUB_TABS' };
    const before = document.querySelectorAll('.task-card').length;
    inv.click();
    await new Promise(r => setTimeout(r, 500));
    const panel = document.querySelector('[data-test="invite-panel"]');
    const out = {
      before,
      panel: !!panel,
      startBtn: !!document.querySelector('[data-test="invite-start"]'),
      text: panel ? panel.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120) : null,
      overflowX: panel ? panel.scrollWidth > panel.clientWidth + 2 : null
    };
    tl.click();
    await new Promise(r => setTimeout(r, 400));
    out.after = document.querySelectorAll('.task-card').length;
    out.newTaskBtnBack = !![...document.querySelectorAll('.right-panel button')].find(b => (b.textContent || '').includes('新建任务'));
    return out;
  `)
  check('任务面板有「任务列表 / 达人邀约」二级页签，切走再切回后任务列表完好',
    subTabs.panel === true && subTabs.after === subTabs.before && subTabs.newTaskBtnBack === true,
    JSON.stringify(subTabs))
  // 当前店铺是拼多多 → 面板必须"明确拒绝"而不是猜测式实现
  check('达人邀约：店铺平台未实现时明确拒绝（如实列出已支持平台，且不给「开始邀约」）',
    /暂不支持/.test(subTabs.text || '') && /抖店/.test(subTabs.text || '') && subTabs.startBtn === false,
    JSON.stringify(subTabs.text))

  // 换一个抖店店铺 → 面板应给出完整可配置表单，并守住"空话术不得启动"

  // 新建任务对话框布局：步骤行的超时/重试框曾被 .modal input{width:100%} 撑到 496px，
  // 整行溢出到 ~1100px（删除按钮与参数被挤出可视区）——这里固定量测，防回归。
  const dialogLayout = await cdp.evaluate(`
    const newBtn = [...document.querySelectorAll('.right-panel button')].find(b => (b.textContent || '').includes('新建任务'));
    if (!newBtn) return { error: '未找到新建任务按钮' };
    newBtn.click();
    await new Promise(r => setTimeout(r, 700));
    const modal = document.querySelector('.modal-wide');
    if (!modal) return { error: '对话框未出现' };
    const row = modal.querySelector('.tstep');
    const dRect = modal.getBoundingClientRect();
    const w = sel => { const el = modal.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().width) : null; };
    const del = modal.querySelector('[data-test="step-del"]');
    const delRect = del ? del.getBoundingClientRect() : null;
    const out = {
      overflowX: modal.scrollWidth > modal.clientWidth + 1,
      rowOverflowX: row ? row.scrollWidth > row.clientWidth + 1 : null,
      typeW: w('.t-type'), timeoutW: w('[data-test="step-timeout"]'), retryW: w('[data-test="step-retry"]'), wideW: w('.f-wide'),
      delInsideDialog: !!delRect && delRect.right <= dRect.right + 1 && delRect.left >= dRect.left - 1,
      delVisible: !!delRect && delRect.width > 0 && delRect.height > 0,
      labels: [...modal.querySelectorAll('.mini-lab')].map(s => s.textContent.trim()),
      templates: [...modal.querySelectorAll('.tpl-row button')].map(b => b.textContent.trim())
    };
    const cancel = [...modal.querySelectorAll('.btn-ghost')].find(b => b.textContent.includes('取消'));
    if (cancel) cancel.click();
    await new Promise(r => setTimeout(r, 400));
    out.closed = !document.querySelector('.modal-wide');
    return out;
  `)
  check('新建任务对话框无横向溢出（步骤行不撑爆）',
    dialogLayout.error === undefined && dialogLayout.overflowX === false && dialogLayout.rowOverflowX === false, JSON.stringify(dialogLayout))
  check('步骤行控件宽度合理（超时/重试 ≤ 90px，类型下拉固定宽）',
    dialogLayout.timeoutW !== null && dialogLayout.timeoutW <= 90 && dialogLayout.retryW <= 90 && dialogLayout.typeW >= 120 && dialogLayout.typeW <= 220,
    JSON.stringify({ type: dialogLayout.typeW, timeout: dialogLayout.timeoutW, retry: dialogLayout.retryW, wide: dialogLayout.wideW }))
  check('步骤删除按钮在对话框可视区内且带中文标签',
    dialogLayout.delInsideDialog === true && dialogLayout.delVisible === true && dialogLayout.labels.join(',') === '超时,重试',
    JSON.stringify({ inside: dialogLayout.delInsideDialog, labels: dialogLayout.labels }))
  check('对话框关闭正常（取消按钮生效，不残留遮罩）', dialogLayout.closed === true)

  // 确认门禁必须跨面板可见：曾写在"任务"面板分支内，用户切到其他面板时任务干等（看起来像卡住）
  const crossPanel = await cdp.evaluate(`
    const envTab = [...document.querySelectorAll('.ptab')].find(b => b.textContent.trim() === '环境');
    envTab.click();
    await new Promise(r => setTimeout(r, 700));
    const bar = document.querySelector('.confirm-bar');
    const r = bar ? bar.getBoundingClientRect() : null;
    const visible = !!r && r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight + 1;
    const back = [...document.querySelectorAll('.ptab')].find(b => b.textContent.trim() === '任务');
    back.click();
    await new Promise(r => setTimeout(r, 600));
    return { visibleOnEnv: visible, stillThere: !!document.querySelector('.confirm-bar') };
  `)
  check('确认门禁在非任务面板同样可见（切换面板不丢提示）',
    crossPanel.visibleOnEnv === true && crossPanel.stillThere === true, JSON.stringify(crossPanel))

  // 门禁不被"收起右栏"藏起来：有待确认时点收起应被拒绝并提示
  const collapseGuard = await cdp.evaluate(`
    const btn = document.querySelector('[data-test="panel-collapse"]');
    if (!btn) return { error: '未找到收起按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 700));
    const panel = document.querySelector('[data-test="right-panel"]');
    const toasts = [...document.querySelectorAll('.toast')].map(t => t.textContent.trim());
    return {
      width: Math.round(panel.getBoundingClientRect().width),
      rail: !!document.querySelector('.panel-rail'),
      stillConfirm: !!document.querySelector('[data-test="task-confirm"]'),
      toast: toasts.find(t => t.includes('人工确认')) || null
    };
  `)
  check('有待人工确认时拒绝收起右栏（门禁不会被藏起来）',
    collapseGuard.width === 320 && collapseGuard.rail === false && collapseGuard.stillConfirm === true && !!collapseGuard.toast,
    JSON.stringify(collapseGuard))

  const clickedAllow = await cdp.evaluate(`
    const bar = document.querySelector('[data-test="task-confirm"]') || document.querySelector('.confirm-bar');
    if (!bar || !bar.textContent.includes('巡检完成')) return false;
    const allow = [...bar.querySelectorAll('button')].find(b => b.textContent.includes('允许'));
    if (allow) { allow.click(); return true } return false;
  `)
  if (!clickedAllow) await api.taskConfirm(rid1, true) // 兜底放行，防队列死锁
  check('UI 确认条出现且点击「允许」放行（无则 API 兜底）', clickedAllow)
  const fin1 = await pollRun(rid1, d => d.run.status === 'succeeded', 15000)
  check('run 最终 succeeded', fin1?.run.status === 'succeeded', fin1?.run.status)

  const R = fin1?.results || []
  const byKind = k => R.filter(r => r.kind === k)
  const rText = byKind('text')[0]
  check('readText 结果 = "12 条未读"', rText?.payload?.text === '12 条未读', JSON.stringify(rText?.payload))
  const rTable = byKind('table')[0]
  check('readTable 结果 rowCount=4（含表头）', rTable?.payload?.rowCount === 4, String(rTable?.payload?.rowCount))
  const rConfirm = R.find(r => r.stepIndex === 5)
  check('confirm 结果行 approved=true', rConfirm?.kind === 'confirm' && rConfirm?.payload?.approved === true, JSON.stringify(rConfirm?.payload))
  check('等待/导航步骤有 executed 凭据行', R.some(r => r.stepIndex === 0 && r.kind === 'executed') && R.some(r => r.stepIndex === 1 && r.kind === 'executed'))

  const rShot = byKind('screenshot')[0]
  let shotOk = false, shotExtra = ''
  if (rShot?.artifactPath && fs.existsSync(rShot.artifactPath)) {
    const buf = fs.readFileSync(rShot.artifactPath)
    const sha = crypto.createHash('sha256').update(buf).digest('hex')
    shotOk = sha === rShot.artifactSha256 && buf.length > 1000
    shotExtra = `size=${buf.length} sha=${sha.slice(0, 12)}…`
  } else shotExtra = rShot?.artifactPath || 'NO_ARTIFACT'
  check('截图工件落盘且 SHA-256 匹配', shotOk, shotExtra)
  // 截图步骤载荷为空、信息全在工件字段：摘要曾恒为空串，步骤明细里那一行什么都看不到
  check('截图结果摘要含工件文件名（明细可读）',
    !!rShot?.summary && /截图工件/.test(rShot.summary) && /\.png/.test(rShot.summary),
    JSON.stringify(rShot?.summary || null))

  const snaps = await api.snapshots(sid1)
  const sm = Object.fromEntries((snaps.data || []).map(x => [x.metric, x]))
  check('store_snapshots 聚合 unread_messages=12', sm.unread_messages?.value === 12 && sm.unread_messages?.sourceRunId === rid1, JSON.stringify(sm.unread_messages))
  check('store_snapshots 聚合 pending_orders=4', sm.pending_orders?.value === 4, JSON.stringify(sm.pending_orders))

  const audits = await api.auditQuery(300)
  const acts = (audits.data || []).map(a => a.action)
  check('审计含 task.create / task.run / task.confirm', ['task.create', 'task.run', 'task.confirm'].every(a => acts.includes(a)))
  const confirmAudit = (audits.data || []).find(a => a.action === 'task.confirm')
  check('审计确认记录携带 approved 事实', !!confirmAudit && String(confirmAudit.requestId).includes('"approved":true'), String(confirmAudit?.requestId))

  // ---------- 4. UI 拒绝路径（点 UI 按钮） ----------
  const denyTask = await api.taskCreate({
    name: '拒绝演示', steps: [
      { type: 'navigate', input: { url: BASE + '/blank' } },
      { type: 'waitForUserConfirmation', input: { message: 'UI 点拒绝测试' } }
    ]
  })
  const run2 = await api.taskRun(denyTask.data.id, sid1)
  const rid2 = run2.data.runId
  await pollRun(rid2, d => d.run.status === 'waiting_confirmation', 20000)
  await sleep(600) // 等事件到渲染层
  const barVisible = await cdp.evaluate(`
    const bar = document.querySelector('.confirm-bar');
    return bar ? bar.textContent.includes('UI 点拒绝测试') : false;
  `)
  check('UI 确认条出现且展示门禁文案', barVisible)
  const clicked = await cdp.evaluate(`
    const btns = [...document.querySelectorAll('.confirm-bar button')];
    const deny = btns.find(b => b.textContent.includes('拒绝'));
    if (deny) { deny.click(); return true } return false;
  `)
  if (!clicked) await api.taskConfirm(rid2, false) // 兜底，防死锁
  check('点击 UI「拒绝」按钮（无则 API 兜底）', clicked)
  const fin2 = await pollRun(rid2, d => TERMINAL(d.run.status), 15000)
  check('拒绝 → 门禁拦截 run=cancelled', fin2?.run.status === 'cancelled', fin2?.run.status + ' / ' + fin2?.run.statusReason)
  check('confirm 结果行 approved=false', fin2?.results?.find(r => r.kind === 'confirm')?.payload?.approved === false)

  // ---------- 5. 失败 → 从失败步骤恢复（不重复已成功步骤） ----------
  const failTask = await api.taskCreate({
    name: '失败演示', steps: [
      { type: 'navigate', input: { url: BASE + '/orders' } },
      { type: 'readText', input: { selector: '#page-title' } },
      { type: 'waitForSelector', input: { selector: '#never-exist' }, timeoutMs: 2000, retryLimit: 1 }
    ]
  })
  const run3 = await api.taskRun(failTask.data.id, sid1)
  const rid3 = run3.data.runId
  const fin3a = await pollRun(rid3, d => d.run.status === 'failed', 30000)
  check('失败步骤 → failed + TASK_SELECTOR_CHANGED', fin3a?.run.errorCode === 'TASK_SELECTOR_CHANGED', fin3a?.run.errorCode + ' / ' + fin3a?.run.errorMessage)
  check('currentStep 停在失败步骤 2', fin3a?.run.currentStep === 2, String(fin3a?.run.currentStep))
  const startedBefore = fin3a?.run.startedAt
  const rowsBefore = (fin3a?.results || []).filter(r => r.stepIndex === 0).length

  await api.taskResume(rid3, 'retry')
  const fin3b = await pollRun(rid3, d => d.run.status === 'failed', 30000)
  const step0RowsAfter = (fin3b?.results || []).filter(r => r.stepIndex === 0).length
  check('从失败恢复再次失败（同 run 复用，startedAt 不变）', fin3b?.run.status === 'failed' && fin3b?.run.startedAt === startedBefore)
  check('已成功步骤未被重复执行（step0 结果行仍为 ' + rowsBefore + '）', step0RowsAfter === rowsBefore, 'after=' + step0RowsAfter)

  // ---------- 6. 副作用步骤拒绝恢复 + 填充不存原文 ----------
  const sideTask = await api.taskCreate({
    name: '副作用演示', steps: [
      { type: 'navigate', input: { url: BASE + '/orders' } },
      { type: 'fillDraft', input: { selector: '#draft-box', text: '草稿内容秘密文本' } },
      { type: 'fillDraft', input: { selector: '#missing-box', text: '草稿内容秘密文本' }, timeoutMs: 1500 }
    ]
  })
  const run4 = await api.taskRun(sideTask.data.id, sid1)
  const rid4 = run4.data.runId
  const fin4 = await pollRun(rid4, d => d.run.status === 'failed', 25000)
  check('fillDraft 目标缺失 → failed（step2）', fin4?.run.status === 'failed' && fin4?.run.currentStep === 2, fin4?.run.errorCode + ' / step=' + fin4?.run.currentStep)
  const retrySide = await api.taskResume(rid4, 'retry')
  check('副作用步骤拒绝"从失败恢复"（TASK_BAD_STATE）', !retrySide.ok && retrySide.error?.code === 'TASK_BAD_STATE', retrySide.error?.message?.slice(0, 50))
  const fillR = (await api.taskResults(rid4)).data?.results
  const fillRow = JSON.stringify(fillR)
  check('填充结果落库且 payload 不含表单原文（仅长度摘要）',
    !fillRow.includes('草稿内容秘密文本') && fillRow.includes('"length":8') && fillR.some(r => r.stepIndex === 1 && r.payload?.filled === true),
    JSON.stringify(fillR?.find(x => x.stepIndex === 1)?.payload))

  // ---------- 6b. 副作用步骤：click / clickByText / clickAll / setInput ----------
  // 白名单仍然封闭：接受固定参数、拒绝缺参与多余字段（尤其不许夹带代码）
  const invZod = [
    ['click 正例', { type: 'click', input: { selector: '#open-drawer' } }, true],
    ['click 缺 selector', { type: 'click', input: {} }, false],
    ['clickByText 正例', { type: 'clickByText', input: { text: '批量邀约带货' } }, true],
    ['clickByText 空文本', { type: 'clickByText', input: { text: '' } }, false],
    ['clickAll 正例（selector + max）', { type: 'clickAll', input: { selector: '.pick', max: 10 } }, true],
    ['clickAll 缺 selector/text', { type: 'clickAll', input: { max: 10 } }, false],
    ['clickAll 超出平台单次上限 41', { type: 'clickAll', input: { selector: '.pick', max: 41 } }, false],
    ['setInput 正例', { type: 'setInput', input: { selector: '#script-box', text: '厂家货源' } }, true],
    ['setInput 夹带 js 字段被拒（strict）', { type: 'setInput', input: { selector: '#script-box', text: 'x', js: 'alert(1)' } }, false]
  ]
  for (const [label, step, shouldOk] of invZod) {
    const r = await api.taskCreate({ name: 'zod-' + label, steps: [step] })
    check('新步骤白名单：' + label + (shouldOk ? ' → 通过' : ' → 被拒'),
      r.ok === shouldOk, r.ok ? '' : (r.error?.code + ' ' + String(r.error?.message || '').slice(0, 44)))
    if (r.ok) await api.taskDelete(r.data.id)
  }

  // 行为验证：打开抽屉 → 写入话术 → 批量勾选（跳过禁用）→ 门禁 → 提交
  const invTask = await api.taskCreate({
    name: '邀约副作用演示',
    steps: [
      { type: 'navigate', input: { url: BASE + '/invite' } },
      { type: 'click', input: { selector: '#open-drawer' } },
      { type: 'setInput', input: { selector: '#script-box', text: '厂家货源' } },
      { type: 'readText', input: { selector: '#echo' } },
      { type: 'clickAll', input: { selector: '.pick', max: 10 } },
      { type: 'readText', input: { selector: '#picked-count' } },
      { type: 'waitForUserConfirmation', input: { message: '确认向 3 位达人发送邀约？' } },
      { type: 'click', input: { selector: '#confirm-send' } },
      { type: 'readText', input: { selector: '#sent-count' } }
    ]
  })
  check('clickAll 默认超时注入 120s（批量点击要等框架重渲染）',
    invTask.ok && invTask.data.steps[4].timeoutMs === 120000, 't4=' + invTask.data?.steps?.[4]?.timeoutMs)
  const invRun1 = await api.taskRun(invTask.data.id, sid1)
  const invRid1 = invRun1.data.runId
  await pollRun(invRid1, d => d.run.status === 'waiting_confirmation', 45000)
  const invResA = (await api.taskResults(invRid1)).data
  const invPick = i => (invResA?.results || []).find(r => r.stepIndex === i)?.payload
  check('setInput 触发框架 input 事件（受控输入回显 = 写入文本）',
    invPick(3)?.text === '厂家货源', JSON.stringify(invPick(3)))
  check('clickAll 跳过禁用项：勾选 3 位、跳过 2 位（含 disabled 属性与祖先禁用两种）',
    invPick(4)?.clicked === 3 && invPick(4)?.skippedDisabled === 2,
    JSON.stringify(invPick(4)))
  check('页面上勾选计数确为 3（点击真的生效）', invPick(5)?.text === '3', JSON.stringify(invPick(5)))
  await api.taskConfirm(invRid1, true)
  const invFin1 = await pollRun(invRid1, d => TERMINAL(d.run.status), 30000)
  const invResB = (await api.taskResults(invRid1)).data
  const invPick2 = i => (invResB?.results || []).find(r => r.stepIndex === i)?.payload
  check('门禁通过后提交步骤被执行（页面计数 +1）',
    invFin1?.run.status === 'succeeded' && invPick2(8)?.text === '1',
    invFin1?.run.status + ' / ' + JSON.stringify(invPick2(8)))
  check('click 结果落库为 executed（带点击到的文案）',
    invPick2(7)?.action === 'click' && invPick2(7)?.clickedText === '确认发送', JSON.stringify(invPick2(7)))

  // 门禁拒绝：提交步骤必须"绝不继续"
  const invDenyTask = await api.taskCreate({
    name: '邀约门禁拒绝演示',
    steps: [
      { type: 'navigate', input: { url: BASE + '/invite' } },
      { type: 'click', input: { selector: '#open-drawer' } },
      { type: 'waitForUserConfirmation', input: { message: '确认发送？' } },
      { type: 'click', input: { selector: '#confirm-send' } }
    ]
  })
  const invRun2 = await api.taskRun(invDenyTask.data.id, sid1)
  const invRid2 = invRun2.data.runId
  await pollRun(invRid2, d => d.run.status === 'waiting_confirmation', 45000)
  await api.taskConfirm(invRid2, false)
  const invFin2 = await pollRun(invRid2, d => d.run.status === 'cancelled', 20000)
  const invResC = (await api.taskResults(invRid2)).data
  check('门禁拒绝 → cancelled，且提交步骤没有任何结果行（证明未执行）',
    invFin2?.run.status === 'cancelled' && !(invResC?.results || []).some(r => r.stepIndex === 3),
    invFin2?.run.status + ' / rows=' + JSON.stringify((invResC?.results || []).map(r => r.stepIndex + ':' + r.kind)))

  // 失败路径：目标缺失 / 目标禁用 / 副作用步骤拒绝恢复
  const invFailTask = await api.taskCreate({
    name: '点击目标缺失', steps: [
      { type: 'navigate', input: { url: BASE + '/invite' } },
      { type: 'click', input: { selector: '#missing-btn' }, timeoutMs: 2000 }
    ]
  })
  const invRun3 = await api.taskRun(invFailTask.data.id, sid1)
  const invRid3 = invRun3.data.runId
  const invFin3 = await pollRun(invRid3, d => d.run.status === 'failed', 25000)
  check('点击目标缺失 → failed（TASK_SELECTOR_CHANGED）',
    invFin3?.run.status === 'failed' && invFin3?.run.errorCode === 'TASK_SELECTOR_CHANGED', invFin3?.run.errorCode)
  const invRetry3 = await api.taskResume(invRid3, 'retry')
  check('点击属副作用步骤 → 拒绝"从失败恢复"（TASK_BAD_STATE）',
    !invRetry3.ok && invRetry3.error?.code === 'TASK_BAD_STATE', invRetry3.error?.message?.slice(0, 40))

  const invDisTask = await api.taskCreate({
    name: '点击禁用目标', steps: [
      { type: 'navigate', input: { url: BASE + '/invite' } },
      { type: 'click', input: { selector: '.pick[disabled]' }, timeoutMs: 3000 }
    ]
  })
  const invRun4 = await api.taskRun(invDisTask.data.id, sid1)
  const invRid4 = invRun4.data.runId
  const invFin4 = await pollRun(invRid4, d => d.run.status === 'failed', 25000)
  check('点击禁用元素 → failed（TASK_TARGET_DISABLED，不静默忽略）',
    invFin4?.run.status === 'failed' && invFin4?.run.errorCode === 'TASK_TARGET_DISABLED',
    invFin4?.run.errorCode + ' / ' + String(invFin4?.run.errorMessage || '').slice(0, 40))

  // ---------- 6c. AI 生成步骤（打本地假 AI 端点，不发真实网络请求） ----------
  const invAiZod = [
    ['正例', { type: 'aiGenerate', input: { selector: '#script-box', sourceSelector: '#goods', maxLen: 120 } }, true],
    ['缺 sourceSelector', { type: 'aiGenerate', input: { selector: '#script-box', maxLen: 120 } }, false],
    ['sourceSelector 留空（合法：运行时用抽屉浮层当来源）', { type: 'aiGenerate', input: { selector: '#script-box', sourceSelector: '', maxLen: 120 } }, true],
    ['maxLen 超范围', { type: 'aiGenerate', input: { selector: '#script-box', sourceSelector: '#goods', maxLen: 999 } }, false],
    ['夹带 code 字段（strict）', { type: 'aiGenerate', input: { selector: '#script-box', sourceSelector: '#goods', maxLen: 120, code: 'x' } }, false]
  ]
  for (const [label, step, shouldOk] of invAiZod) {
    const r = await api.taskCreate({ name: 'zod-ai-' + label, steps: [step] })
    check('AI 步骤白名单：' + label + (shouldOk ? ' → 通过' : ' → 被拒'),
      r.ok === shouldOk, r.ok ? '' : String(r.error?.message || '').slice(0, 44))
    if (r.ok) await api.taskDelete(r.data.id)
  }

  // ① 未配置 Key：必须如实失败，绝不写假话术
  const noKeyTask = await api.taskCreate({ name: '未配置AI', steps: [
    { type: 'navigate', input: { url: BASE + '/invite' } },
    { type: 'aiGenerate', input: { selector: '#script-box', sourceSelector: '#goods', maxLen: 120 } }
  ]})
  const runNoKey = await api.taskRun(noKeyTask.data.id, sid1)
  const finNoKey = await pollRun(runNoKey.data.runId, d => d.run.status === 'failed', 25000)
  check('未配置 AI Key 时 aiGenerate 如实失败（AI_NOT_CONFIGURED），不写假话术',
    finNoKey?.run.status === 'failed' && finNoKey?.run.errorCode === 'AI_NOT_CONFIGURED',
    finNoKey?.run.errorCode + ' / ' + String(finNoKey?.run.errorMessage || '').slice(0, 36))

  // ② 配置本地假端点 + Key → 生成并写入；Key 全程不回显
  const aiCfg = await api.aiConfigSet({ endpoint: BASE + '/ai/chat/completions', model: 'm3-fake-model', timeoutMs: 15000 })
  check('AI 配置可保存，且 configGet 只给 hasKey、不含任何 Key 字段',
    aiCfg.ok && aiCfg.data.endpoint === BASE + '/ai/chat/completions' && aiCfg.data.hasKey === false && !('key' in aiCfg.data),
    JSON.stringify({ ep: aiCfg.data?.endpoint, hasKey: aiCfg.data?.hasKey, fields: Object.keys(aiCfg.data || {}).join(',') }))
  const aiKey = await api.aiKeySet('m3-test-key-1234')
  check('保存 Key 后仅 hasKey=true（无明文回显）',
    aiKey.ok && aiKey.data.hasKey === true && !('key' in aiKey.data), JSON.stringify(aiKey.data))
  const aiTest = await api.aiTest()
  check('「测试连接」打本地假端点成功并回报模型名与耗时',
    aiTest.ok && aiTest.data.model === 'm3-fake-model' && typeof aiTest.data.elapsedMs === 'number',
    JSON.stringify(aiTest.data || aiTest.error))

  // ②b. 获取可用模型（只读 GET /models）：如实返回列表；推不出地址时明确报错，不编造候选
  const modelsOk = await api.aiListModels()
  check('「获取可用模型」打本地假端点返回列表（去重排序，不含任何编造项）',
    modelsOk.ok && JSON.stringify(modelsOk.data.models) === JSON.stringify(['m3-fake-lite', 'm3-fake-model', 'm3-fake-pro']),
    JSON.stringify(modelsOk.data || modelsOk.error))
  const modelsBadEp = await api.aiConfigSet({ endpoint: BASE + '/ai/not-a-completions-path', model: 'm3-fake-model', timeoutMs: 15000 })
  const modelsBad = await api.aiListModels()
  check('接口地址推不出 /models 时明确报 AI_BAD_ENDPOINT（不猜地址）',
    modelsBadEp.ok && !modelsBad.ok && modelsBad.error.code === 'AI_BAD_ENDPOINT',
    modelsBad.error?.code + ' / ' + String(modelsBad.error?.message || '').slice(0, 40))
  await api.aiConfigSet({ endpoint: BASE + '/ai/chat/completions', model: 'm3-fake-model', timeoutMs: 15000 })
  // 未配置 Key 时必须如实失败
  const keyBackup = 'm3-test-key-1234'
  await api.aiKeyClear()
  const modelsNoKey = await api.aiListModels()
  check('未配置 Key 时「获取可用模型」如实失败（AI_NOT_CONFIGURED）',
    !modelsNoKey.ok && modelsNoKey.error.code === 'AI_NOT_CONFIGURED', modelsNoKey.error?.code)
  await api.aiKeySet(keyBackup)

  // UI 侧：设置 → AI 配置页的「获取可用模型」按钮 + 下拉选中即填入模型名
  const modelsUi = await cdp.evaluate(`
    document.querySelector('[data-test="settings-open-btn"]').click();
    await new Promise(r => setTimeout(r, 600));
    document.querySelector('[data-test="settings-tab-ai"]').click();
    await new Promise(r => setTimeout(r, 400));
    const btn = document.querySelector('[data-test="ai-models-btn"]');
    const out = { btn: !!btn };
    if (btn) {
      btn.click();
      await new Promise(r => setTimeout(r, 1800));
      const sel = document.querySelector('[data-test="ai-model-pick"]');
      out.options = sel ? [...sel.options].map(o => o.value).filter(Boolean) : null;
      out.msg = (document.querySelector('[data-test="ai-msg"]') || {}).textContent || null;
      if (sel) {
        sel.value = 'm3-fake-pro';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 200));
        out.modelAfterPick = document.querySelector('[data-test="ai-model"]').value;
        // 改接口地址 → 旧候选立即作废，避免误选
        const ep = document.querySelector('[data-test="ai-endpoint"]');
        ep.value = ep.value + 'x';
        ep.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 250));
        out.pickGoneAfterEndpointChange = !document.querySelector('[data-test="ai-model-pick"]');
        ep.value = ep.value.slice(0, -1);
        ep.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const panel = document.querySelector('[data-test="settings-ai"]');
      out.overflowX = panel ? panel.scrollWidth > panel.clientWidth + 2 : null;
    }
    document.querySelector('[data-test="settings-dialog"] .btn-ghost').click();
    await new Promise(r => setTimeout(r, 250));
    out.closed = !document.querySelector('[data-test="settings-dialog"]');
    return out;
  `)
  check('设置 → AI 配置：「获取可用模型」拉回候选并在下拉里可选，选中即填入模型名',
    modelsUi.btn === true && Array.isArray(modelsUi.options) && modelsUi.options.length === 3 &&
    modelsUi.options.includes('m3-fake-pro') && modelsUi.modelAfterPick === 'm3-fake-pro' &&
    modelsUi.pickGoneAfterEndpointChange === true && modelsUi.overflowX === false,
    JSON.stringify(modelsUi))
  check('「获取可用模型」所在页签仍可取消关闭（候选未保存也不落库）',
    modelsUi.closed === true, String(modelsUi.closed))
  const aiAudit2 = await api.auditQuery(300)
  check('获取模型写审计（ai.models success/failure）',
    aiAudit2.ok && (aiAudit2.data || []).some(a => a.action === 'ai.models'),
    'ai.models 行=' + (aiAudit2.data || []).filter(a => a.action === 'ai.models').length)

  const genTask = await api.taskCreate({ name: 'AI生成话术', steps: [
    { type: 'navigate', input: { url: BASE + '/invite' } },
    { type: 'aiGenerate', input: { selector: '#script-box', sourceSelector: '#goods', maxLen: 120 } },
    { type: 'readText', input: { selector: '#script-box' } }
  ]})
  check('aiGenerate 默认超时 90s（要等模型返回）', genTask.ok && genTask.data.steps[1].timeoutMs === 90000, 't1=' + genTask.data?.steps?.[1]?.timeoutMs)
  const runGen = await api.taskRun(genTask.data.id, sid1)
  const finGen = await pollRun(runGen.data.runId, d => TERMINAL(d.run.status), 30000)
  const genRes = (await api.taskResults(runGen.data.runId)).data
  const genPayload = (genRes?.results || []).find(r => r.stepIndex === 1)?.payload
  const genRead = (genRes?.results || []).find(r => r.stepIndex === 2)?.payload
  check('aiGenerate 按商品信息生成话术并写入目标输入框（长度受限）',
    finGen?.run.status === 'succeeded' && typeof genRead?.text === 'string' && genRead.text.length > 10 && genRead.text.length <= 120,
    finGen?.run.status + ' / len=' + (genRead?.text || '').length)
  check('aiGenerate payload 只存摘要（模型/长度/来源字符数/预览），不存全文',
    genPayload?.action === 'aiGenerate' && genPayload?.model === 'm3-fake-model' && genPayload?.sourceChars > 0 &&
    genPayload?.length === genRead?.text.length && !JSON.stringify(genPayload).includes(String(genRead?.text || '@@')),
    JSON.stringify({ model: genPayload?.model, len: genPayload?.length, src: genPayload?.sourceChars, preview: String(genPayload?.preview || '').slice(0, 14) + '…' }))
  const aiAudit = await api.auditQuery(300)
  check('AI 生成写审计（ai.generate success）',
    aiAudit.ok && (aiAudit.data || []).some(a => a.action === 'ai.generate' && a.result === 'success'),
    'ai 审计行=' + (aiAudit.data || []).filter(a => String(a.action).startsWith('ai.')).length)

  // ③ AI 步骤同样是副作用步骤
  const genFail = await api.taskCreate({ name: 'AI生成失败', steps: [
    { type: 'navigate', input: { url: BASE + '/invite' } },
    { type: 'aiGenerate', input: { selector: '#script-box', sourceSelector: '#missing-goods', maxLen: 120 }, timeoutMs: 3000 }
  ]})
  const runGenFail = await api.taskRun(genFail.data.id, sid1)
  const finGenFail = await pollRun(runGenFail.data.runId, d => d.run.status === 'failed', 25000)
  check('aiGenerate 读不到商品来源 → failed（TASK_SELECTOR_CHANGED）',
    finGenFail?.run.status === 'failed' && finGenFail?.run.errorCode === 'TASK_SELECTOR_CHANGED', finGenFail?.run.errorCode)
  const retryGen = await api.taskResume(runGenFail.data.runId, 'retry')
  check('aiGenerate 属副作用步骤 → 拒绝"从失败恢复"（TASK_BAD_STATE）',
    !retryGen.ok && retryGen.error?.code === 'TASK_BAD_STATE', retryGen.error?.message?.slice(0, 36))

  // ④ sourceSelector 留空 → 沿话术框向上找"固定定位浮层"（抽屉）读商品信息
  const drawerTask = await api.taskCreate({ name: 'AI抽屉降级', steps: [
    { type: 'navigate', input: { url: BASE + '/invite' } },
    { type: 'click', input: { selector: '#open-drawer' } },
    { type: 'aiGenerate', input: { selector: '#script-box', sourceSelector: '', maxLen: 120 } },
    { type: 'readText', input: { selector: '#script-box' } }
  ]})
  const runDrawer = await api.taskRun(drawerTask.data.id, sid1)
  const finDrawer = await pollRun(runDrawer.data.runId, d => TERMINAL(d.run.status), 30000)
  const drawerRes = (await api.taskResults(runDrawer.data.runId)).data
  const drawerStep = (drawerRes?.results || []).find(r => r.stepIndex === 2)?.payload
  const drawerRead = (drawerRes?.results || []).find(r => r.stepIndex === 3)?.payload
  check('aiGenerate 留空 sourceSelector → 用抽屉浮层文本生成并写入（payload 如实标注来源）',
    finDrawer?.run.status === 'succeeded' && drawerStep?.sourceHow === 'drawer' && drawerStep?.sourceChars > 0 &&
    typeof drawerRead?.text === 'string' && drawerRead.text.length > 10,
    finDrawer?.run.status + ' / how=' + drawerStep?.sourceHow + ' / src=' + drawerStep?.sourceChars + ' / len=' + (drawerRead?.text || '').length)

  const noDrawerTask = await api.taskCreate({ name: 'AI抽屉未打开', steps: [
    { type: 'navigate', input: { url: BASE + '/invite' } },
    { type: 'aiGenerate', input: { selector: '#script-box', sourceSelector: '', maxLen: 120 }, timeoutMs: 5000 }
  ]})
  const runNoDrawer = noDrawerTask.ok ? await api.taskRun(noDrawerTask.data.id, sid1) : null
  const finNoDrawer = runNoDrawer?.ok ? await pollRun(runNoDrawer.data.runId, d => d.run.status === 'failed', 25000) : null
  check('抽屉未打开（无固定定位浮层）→ 如实失败（AI_EMPTY_OUTPUT），不把整页噪音喂给模型',
    finNoDrawer?.run.status === 'failed' && finNoDrawer?.run.errorCode === 'AI_EMPTY_OUTPUT',
    (finNoDrawer?.run.errorCode || 'null') + ' / ' + String(finNoDrawer?.run.errorMessage || '').slice(0, 44) +
    ' / create=' + (noDrawerTask.ok ? 'ok' : JSON.stringify(noDrawerTask.error)) +
    ' / run=' + (runNoDrawer ? (runNoDrawer.ok ? 'ok' : JSON.stringify(runNoDrawer.error)) : 'skipped'))

  // ⑤ readText 读表单控件取 value：setInput/aiGenerate 写入后留档必须拿到"真正发出去的话术"
  const valueRead = await api.taskCreate({ name: 'AI话术留档', steps: [
    { type: 'navigate', input: { url: BASE + '/invite' } },
    { type: 'setInput', input: { selector: '#script-box', text: '留档验证话术' } },
    { type: 'readText', input: { selector: '#script-box' } }
  ]})
  const runValue = await api.taskRun(valueRead.data.id, sid1)
  await pollRun(runValue.data.runId, d => TERMINAL(d.run.status), 25000)
  const valueRes = (await api.taskResults(runValue.data.runId)).data
  const valueReadPayload = (valueRes?.results || []).find(r => r.stepIndex === 2)?.payload
  check('readText 读 textarea 取的是当前 value（写入后留档不落空）',
    valueReadPayload?.text === '留档验证话术', JSON.stringify(valueReadPayload))

  // ---------- 7. 暂停 / 继续 / 取消 + 非法迁移 ----------
  const slowTask = await api.taskCreate({
    name: '长等待演示', steps: [
      { type: 'navigate', input: { url: BASE + '/orders' } },
      { type: 'waitForPage', input: { urlIncludes: '/__never__' }, timeoutMs: 60000 }
    ]
  })
  const run5 = await api.taskRun(slowTask.data.id, sid1)
  const rid5 = run5.data.runId
  const r5s = await pollRun(rid5, d => d.run.status === 'running' && d.run.currentStep >= 1, 20000)
  check('长等待步骤进入 running@step1', r5s?.run.status === 'running' && r5s?.run.currentStep === 1, r5s?.run.status + ' / ' + r5s?.run.currentStep)
  const pause1 = await api.taskPause(rid5)
  const paused = await pollRun(rid5, d => d.run.status === 'paused', 8000)
  check('运行中暂停 → paused（轮询间隙协作式打断）', pause1.ok && paused?.run.status === 'paused',
    `pause1=${pause1.ok ? 'ok' : JSON.stringify(pause1.error)} last=${paused?.run.status}@step${paused?.run.currentStep}`)
  const r5 = await pollRun(rid5, d => d.run.status === 'paused', 1000)
  check('暂停不丢失进度：currentStep 保持 1', r5?.run.currentStep === 1, String(r5?.run.currentStep))
  await api.taskResume(rid5)
  const resumed = await pollRun(rid5, d => d.run.status === 'running', 10000)
  check('paused → running（继续同一步骤）', resumed?.run.status === 'running', resumed?.run.status)
  const badConf = await api.taskConfirm(rid5, true)
  check('非等待确认时 confirm → TASK_BAD_STATE', !badConf.ok && badConf.error?.code === 'TASK_BAD_STATE')
  await api.taskCancel(rid5)
  const cancelled5 = await pollRun(rid5, d => d.run.status === 'cancelled', 10000)
  check('取消 → cancelled', cancelled5?.run.status === 'cancelled', cancelled5?.run.status)
  const badPause = await api.taskPause(rid1)
  check('对终态 run 暂停 → TASK_BAD_STATE（状态机守卫）', !badPause.ok && badPause.error?.code === 'TASK_BAD_STATE', badPause.error?.message)

  // ---------- 8. Scheduler ----------
  const s2 = await api.storeCreate({ name: 'M3店铺二', platform: '微信小店', adminUrl: BASE + '/blank' })
  const sid2 = s2.data.id
  const schedTask = await api.taskCreate({
    name: '定时巡检二',
    storeScope: sid2,
    steps: [
      { type: 'navigate', input: { url: BASE + '/blank' } },
      { type: 'readText', input: { selector: '#hello' } }
    ],
    schedule: { everyMs: 60000 }
  })
  check('schedule 持久化 everyMs=60000', schedTask.data?.schedule?.everyMs === 60000, JSON.stringify(schedTask.data?.schedule))
  const badSched = await api.taskCreate({ name: 'x', steps: [{ type: 'screenshot' }], schedule: { everyMs: 500 } })
  check('低于 1 分钟的调度被拒（防抖滥）', !badSched.ok && badSched.error?.code === 'TASK_INVALID_STEP', badSched.error?.message?.slice(0, 60))

  const fired = await api.taskFire(schedTask.data.id)
  check('调度触发 → 事件 queuedWaiting=true（店铺未开保持排队）', fired.ok && fired.data.queuedWaiting === true, JSON.stringify(fired.data?.message))
  const rid6 = fired.data.runId
  await sleep(2500)
  check('排队中不静默拉起：run 仍 queued', (await runStatusOf(rid6)) === 'queued', await runStatusOf(rid6))
  const st2 = await api.sessionStatus(sid2)
  check('店铺二浏览器确实未被调度拉起', st2.ok && st2.data.open === false)
  const opened2 = await openStoreViaUI('M3店铺二')
  check('UI 打开店铺二（排队唤醒前提）', opened2)
  const fin6 = await pollRun(rid6, d => d.run.status === 'succeeded', 25000)
  check('打开店铺后排队 run 自动执行至 succeeded', fin6?.run.status === 'succeeded', fin6?.run.status)
  const tl = await api.taskList()
  const t6 = tl.data.find(x => x.id === schedTask.data.id)
  check('lastFiredAt 已记录（调度幂等依据）', !!t6?.lastFiredAt, String(t6?.lastFiredAt))

  // ---------- 9. 删除级联 ----------
  const del = await api.taskDelete(failTask.data.id)
  check('task:delete 成功', del.ok)
  const gone = await api.taskResults(rid3)
  check('runs/结果随任务级联删除', !gone.ok && gone.error?.code === 'TASK_NOT_FOUND')

  // ---------- 9b. 达人邀约（抖店）面板：完整可配置 + 空话术不得启动 ----------
  // 放在这里做（而不是插在主流程中间）：要切店铺/重载页面，避免干扰其他用例的 UI 状态
  const sInvite = await api.storeCreate({ name: 'M3抖店邀约', platform: '抖店', adminUrl: BASE + '/invite' })
  const sidInvite = sInvite.data.id
  await api.aiKeyClear() // 面板的 AI 门禁要可判定：先确保主进程侧就是"未配置"
  console.log('… 9b: 打开抖店店铺并进入「任务 → 达人邀约」（含页面重载）')
  await openStoreViaUI('M3抖店邀约')
  console.log('… 9b: 页面就绪，开始面板断言')
  const invitePanel = await cdp.evaluate(`
    let card = null;
    for (let i = 0; i < 4; i++) {
      if (document.querySelector('.viewport')) break;
      card = [...document.querySelectorAll('.store-card')].find(c => c.textContent.includes('M3抖店邀约'));
      if (!card) break;
      card.querySelector('.store-action').click();
      await new Promise(r => setTimeout(r, 3200));
    }
    // 右栏可能是收起态（只剩窄轨）：先经窄轨的"任务"图标展开，否则没有页签可点
    if (document.querySelector('.panel-rail')) {
      const rail = document.querySelector('[data-test="rail-tasks"]');
      if (rail) rail.click();
      await new Promise(r => setTimeout(r, 800));
    }
    const t = [...document.querySelectorAll('.ptab')].find(b => b.textContent.trim() === '任务');
    if (t) t.click();
    await new Promise(r => setTimeout(r, 700));
    const inv = document.querySelector('[data-test="task-tab-invite"]');
    if (inv) inv.click();
    await new Promise(r => setTimeout(r, 600));
    const panel = document.querySelector('[data-test="invite-panel"]');
    const btn = document.querySelector('[data-test="invite-start"]');
    const out = {
      viewport: !!document.querySelector('.viewport'),
      displayedCard: (document.querySelector('.store-card.displayed') || {}).textContent ? document.querySelector('.store-card.displayed').textContent.replace(/\\s+/g, ' ').trim().slice(0, 30) : null,
      panelText: panel ? panel.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60) : null,
      panel: !!panel,
      categoryOptions: [...document.querySelectorAll('[data-test="invite-category"] option')].length,
      chips: panel ? panel.querySelectorAll('.inv-chip').length : 0,
      countInput: !!document.querySelector('[data-test="invite-count"]'),
      scriptBox: !!document.querySelector('[data-test="invite-script"]'),
      scriptModeManual: !!document.querySelector('[data-test="invite-script-mode-manual"]'),
      scriptModeAi: !!document.querySelector('[data-test="invite-script-mode-ai"]'),
      disabledNoScript: btn ? btn.disabled : null,
      overflowX: panel ? panel.scrollWidth > panel.clientWidth + 2 : null
    };
    if (out.scriptBox) {
      const ta = document.querySelector('[data-test="invite-script"]');
      ta.value = '您好，我们是工厂店，想邀请您合作带货，可给专属高佣与免费寄样。';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      out.enabledAfterScript = !document.querySelector('[data-test="invite-start"]').disabled;
      // AI 模式：话术框只读（由任务运行时写入），此时本机未配 Key → 开始按钮应重新禁用并明确提示
      document.querySelector('[data-test="invite-script-mode-ai"]').click();
      await new Promise(r => setTimeout(r, 300));
      out.aiMode = {
        readonly: ta.readOnly,
        disabled: document.querySelector('[data-test="invite-start"]').disabled,
        hint: panel.textContent.includes('AI 未配置')
      };
      // 配好 Key（走设置页保存的真实路径）→ 回到面板，AI 模式应可用
      await window.shopilot.ai.setKey('m3-test-key-1234');
      if (document.querySelector('.sidebar-rail')) {
        const ex = document.querySelector('[data-test="sidebar-expand"]');
        if (ex) ex.click();
        await new Promise(r => setTimeout(r, 500));
      }
      document.querySelector('[data-test="settings-open-btn"]').click();
      await new Promise(r => setTimeout(r, 700));
      document.querySelector('[data-test="settings-tab-ai"]').click();
      await new Promise(r => setTimeout(r, 500));
      document.querySelector('[data-test="settings-dialog"] .btn-ghost').click();
      await new Promise(r => setTimeout(r, 400));
      document.querySelector('[data-test="invite-script-mode-ai"]').click();
      await new Promise(r => setTimeout(r, 300));
      out.aiModeReady = {
        disabled: document.querySelector('[data-test="invite-start"]').disabled,
        readonly: ta.readOnly,
        hintGone: !panel.textContent.includes('AI 未配置')
      };
      document.querySelector('[data-test="invite-script-mode-manual"]').click();
      await new Promise(r => setTimeout(r, 250));
      await window.shopilot.ai.clearKey();
    }
    return out;
  `)
  console.log('… 9b: 面板断言完成')
  check('达人邀约（抖店）：类目 22 项 + 等级/权益/话术来源 chip 13 个 + 数量/话术齐备、无横向溢出',
    invitePanel.viewport === true && invitePanel.panel === true && invitePanel.categoryOptions === 23 &&
    invitePanel.chips === 13 && invitePanel.countInput === true && invitePanel.scriptBox === true &&
    invitePanel.scriptModeManual === true && invitePanel.scriptModeAi === true &&
    invitePanel.overflowX === false,
    JSON.stringify(invitePanel))
  check('达人邀约：空话术时「开始邀约」禁用，填写话术后才可用（防误发空消息）',
    invitePanel.disabledNoScript === true && invitePanel.enabledAfterScript === true,
    JSON.stringify({ 空话术: invitePanel.disabledNoScript, 填后: invitePanel.enabledAfterScript }))
  check('达人邀约：「AI 生成」模式下话术框只读；未配置 AI 时开始按钮禁用并明确提示',
    invitePanel.aiMode?.readonly === true && invitePanel.aiMode?.disabled === true && invitePanel.aiMode?.hint === true,
    JSON.stringify(invitePanel.aiMode))
  check('达人邀约：配好 Key 后回到面板，AI 模式可用（按钮解禁、提示消失）',
    invitePanel.aiModeReady?.disabled === false && invitePanel.aiModeReady?.readonly === true &&
    invitePanel.aiModeReady?.hintGone === true,
    JSON.stringify(invitePanel.aiModeReady))

  // ---------- 10. 清理 ----------
  const all = (await api.taskList()).data || []
  for (const t of all) await api.taskDelete(t.id)
  for (const sid of [sid1, sid2, sidInvite]) {
    await call(`window.shopilot.browser.close(${JSON.stringify(sid)})`)
    await api.storeDeletePerm(sid)
  }
  const tr = (await api.trashList()).data || []
  for (const t of tr) await api.storePurge(t.id)

  const passed = results.filter(r => r.ok).length
  console.log(`\n通过 ${passed}/${results.length}`)
  if (passed < results.length) {
    console.log('失败项: ' + results.filter(r => !r.ok).map(r => r.name).join('; '))
    process.exitCode = 1
  } else console.log('ALL_M3_ACCEPTANCE_PASSED')

  cdp.close()
  server.close()
  setTimeout(() => process.exit(process.exitCode || 0), 500)
}

main().catch(err => { console.error('VERIFY_CRASH', err); process.exit(2) })
