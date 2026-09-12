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

const CDP_PORT = process.env.SHOPILOT_CDP_PORT || '9225'
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
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
  async evaluate(fnBody) {
    await this.ready
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${fnBody} })()`, awaitPromise: true, returnByValue: true
    })
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
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (req.url.startsWith('/orders')) res.end(ORDERS)
    else if (req.url.startsWith('/blank')) res.end(BLANK)
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
  check('推进至确认门禁 waiting_confirmation（含 1.5s 迟到元素等待）', !!done1 && done1.run.status === 'waiting_confirmation', done1?.run.status)

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

  // ---------- 10. 清理 ----------
  const all = (await api.taskList()).data || []
  for (const t of all) await api.taskDelete(t.id)
  for (const sid of [sid1, sid2]) {
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
