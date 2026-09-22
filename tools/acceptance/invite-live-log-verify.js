/**
 * 达人邀约实时日志面板验收（替代已删除的邀约记录列表）。
 * 独立临时 userData，不碰用户真实数据。用 CDP 驱动真实渲染层（表单界面像素点击易点偏）。
 *
 * 覆盖：
 *  ① 达人邀约页签里是「达人邀约实时日志」，没有邀约记录列表/卡片；
 *  ② 无运行时显示空态指引；
 *  ③ 有邀约运行时：卡点行（状态+第几步+消息）可见，步骤行带状态图标，日志框存在；
 *  ④ 日志框随新日志自动滚到底（卡住时最后几行可见）。
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.resolve(__dirname, '../..')
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = process.env.SHOPILOT_INVITELOG_CDP_PORT || '9275'
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
  } catch { /* ignore */ }
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
  async eval(expression, awaitPromise = true) {
    await this.ready
    const id = ++this.id
    const result = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
        expression: awaitPromise ? `(async () => { ${expression} })()` : expression,
        awaitPromise,
        returnByValue: true,
        userGesture: true
      } }))
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function waitForCDP(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (r.ok) return
    } catch { /* retry */ }
    await sleep(400)
  }
  throw new Error('CDP endpoint not ready')
}
async function connectUi() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
  const target = targets.find(t => t.type === 'page' && String(t.url || '').includes('/renderer/index.html'))
  if (!target) throw new Error('ShopPilot UI target not found')
  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.eval(`(async () => { const until = Date.now() + 15000; while (!window.shopilot && Date.now() < until) await new Promise(r => setTimeout(r, 100)); return !!window.shopilot; })()`)
  return cdp
}

const DOM = `
const q = s => document.querySelector(s);
const byText = (sel, text) => [...document.querySelectorAll(sel)].find(e => String(e.textContent || '').includes(text));
const waitFor = async (fn, ms = 8000) => {
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
  const userData = path.join(os.tmpdir(), 'shopilot-invitelog-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  freeDebugPort(CDP_PORT)
  let app = null
  let ui = null
  try {
    app = spawn(electronExe, ['.', `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + userData, '--no-sandbox'], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'production', ELECTRON_ENABLE_LOGGING: '1', SHOPILOT_DISABLE_CDP_FP: '1' },
      stdio: 'ignore'
    })
    await waitForCDP()
    await sleep(1200)
    ui = await connectUi()

    // 准备：建一个抖店并打开（邀约面板按平台匹配档案）
    const storeId = await ui.eval(`
      const r = await window.shopilot.store.create({ name: '实时日志验收店', platform: '抖店', adminUrl: 'https://fxg.jinritemai.com/' });
      if (!r.ok) throw new Error('store.create failed: ' + JSON.stringify(r.error));
      return r.data.id;
    `)
    check('准备：创建抖店验收店铺', !!storeId, String(storeId))
    try { await ui.eval(`void location.reload()`, false) } catch { /* 导航中连接断开属正常 */ }
    await sleep(3000)
    ui = await connectUi()
    await ui.eval(`${DOM}
      const card = await waitFor(() => byText('[data-test="store-card"]', '实时日志验收店'), 10000);
      if (!card) throw new Error('店铺卡片没渲染出来');
      (card.querySelector('.store-action') || card).click();
      return true;
    `)
    await sleep(2500)

    // 打开任务面板 → 达人邀约页签
    await ui.eval(`${DOM}
      const tab = await waitFor(() => byText('.ptab', '任务') || byText('.rail-btn', '任务'));
      if (!tab) throw new Error('找不到右侧「任务」面板页签');
      tab.click();
      return true;
    `)
    await sleep(400)
    await ui.eval(`${DOM}
      const inv = await waitFor(() => document.querySelector('[data-test="task-tab-invite"]'));
      if (!inv) throw new Error('找不到达人邀约页签');
      inv.click();
      return true;
    `)
    await sleep(600)

    // ① 实时日志标题存在，旧邀约记录/卡片不存在
    const panelShape = await ui.eval(`${DOM} return {
      liveTitle: [...document.querySelectorAll('[data-test="invite-panel"] .env-h')].some(e => String(e.textContent || '').includes('达人邀约实时日志')),
      liveLog: !!document.querySelector('[data-test="invite-live-log"]'),
      stuck: !!document.querySelector('[data-test="invite-live-stuck"]'),
      empty: !!document.querySelector('[data-test="invite-live-empty"]'),
      noHistoryCards: document.querySelectorAll('[data-test="invite-history-card"]').length,
      bodyText: document.querySelector('[data-test="invite-panel"]') ? document.querySelector('[data-test="invite-panel"]').innerText : ''
    };`)
    check('① 标题是「达人邀约实时日志」', panelShape.liveTitle, JSON.stringify({ liveTitle: panelShape.liveTitle }))
    // 无运行时：日志框/卡点行本来就不渲染（v-else 分支），只要求空态在、旧卡片不在
    check('① 无运行时只有空态、无旧卡片', panelShape.empty === true && panelShape.noHistoryCards === 0)
    check('① 面板文案不再提「邀约记录」', !String(panelShape.bodyText).includes('邀约记录'), String(panelShape.bodyText).slice(0, 80))
    check('② 无运行时显示空态指引', panelShape.empty === true)

    // ③ 造一个邀约运行（直接建任务+启动，不依赖平台页面；步骤用 waitMs 做可观测的"卡住"过程）。
    // task.run 返回 { runId, storeId, waitingForStore }；渲染层靠 refreshTasks 拉到新任务，
    // 所以建完后主动等任务列表出现该任务再断言面板。
    const created = await ui.eval(`
      const r = await window.shopilot.task.create({
        name: '达人邀约 · 抖店 · 实时日志验收',
        storeScope: ${JSON.stringify(storeId)},
        steps: [
          { type: 'waitMs', input: { ms: 300 }, timeoutMs: 10000 },
          { type: 'waitMs', input: { ms: 120000 }, timeoutMs: 180000 }
        ]
      });
      if (!r.ok) throw new Error('task.create failed: ' + JSON.stringify(r.error));
      const run = await window.shopilot.task.run(r.data.id);
      if (!run.ok) throw new Error('task.run failed: ' + JSON.stringify(run.error));
      return { taskId: r.data.id, runId: run.data.runId, waitingForStore: run.data.waitingForStore };
    `)
    check('③ 邀约运行已启动', !!created?.runId && created?.waitingForStore !== true, JSON.stringify(created))
    // IPC 直建的任务渲染层要拉一次任务列表才可见：走真实用户路径——点右栏「任务」主面板
    // （switchPanel('tasks') 会调 refreshTasks），再点回「达人邀约」页签
    await ui.eval(`${DOM}
      const ptab = byText('.ptab', '任务');
      if (ptab) ptab.click();
      await new Promise(r => setTimeout(r, 1200));
      const tasks = document.querySelector('[data-test="task-tab-tasks"]');
      if (tasks) tasks.click();
      await new Promise(r => setTimeout(r, 1200));
      const inv = document.querySelector('[data-test="task-tab-invite"]');
      if (inv) inv.click();
      return true;
    `)
    // 等渲染层拉到新任务（refreshTasks 是事件/轮询驱动，这里轮询等面板出现卡点行）
    let liveReady = false
    for (let i = 0; i < 30 && !liveReady; i++) {
      await sleep(500)
      liveReady = await ui.eval(`return !!document.querySelector('[data-test="invite-live-stuck"]');`)
    }
    check('③ 面板跟上最新一次邀约运行', liveReady === true)
    await sleep(2500)

    const liveState = await ui.eval(`${DOM} return {
      emptyGone: !document.querySelector('[data-test="invite-live-empty"]'),
      stuckText: document.querySelector('[data-test="invite-live-stuck"]') ? document.querySelector('[data-test="invite-live-stuck"]').innerText : null,
      stepRows: [...document.querySelectorAll('[data-test="invite-live-log"]')].length ? document.querySelector('[data-test="invite-panel"]').querySelectorAll('.step-row').length : -1,
      icons: [...document.querySelectorAll('[data-test="invite-panel"] .step-row .s-ico')].map(e => e.textContent.trim()),
      logLines: [...document.querySelectorAll('[data-test="invite-live-log"] .log-line')].map(e => e.textContent.trim()).slice(-6),
      stopBtn: !!document.querySelector('[data-test="invite-live-stop"]')
    };`)
    check('③ 有运行后空态消失', liveState.emptyGone === true)
    check('③ 卡点行写清"第几步"（如 卡在第 2/2 步）', /卡在第 2\/2 步/.test(String(liveState.stuckText)), String(liveState.stuckText))
    check('③ 步骤行带状态图标（第1步✅/第2步⏳）', JSON.stringify(liveState.icons) === JSON.stringify(['✅', '⏳']), JSON.stringify(liveState.icons))
    check('③ 实时日志有运行输出', liveState.logLines.length > 1, JSON.stringify(liveState.logLines))
    check('③ 运行中可就地停止', liveState.stopBtn === true)

    // ④ 日志框自动滚到底
    const scrolled = await ui.eval(`${DOM}
      const box = document.querySelector('[data-test="invite-live-log"]');
      if (!box) return { error: 'no-box' };
      return { atBottom: box.scrollHeight - box.scrollTop - box.clientHeight < 40, scrollHeight: box.scrollHeight, clientHeight: box.clientHeight };
    `)
    check('④ 日志框自动滚到底（最后几行可见）', scrolled.atBottom === true, JSON.stringify(scrolled))

    // 收尾：停掉验收运行并删除任务
    await ui.eval(`await window.shopilot.task.cancel(${JSON.stringify(created.runId)}); return true;`)
    await sleep(800)
    await ui.eval(`await window.shopilot.task.delete(${JSON.stringify(created.taskId)}); return true;`)
    check('收尾：验收运行已停止并删除', true)
  } catch (error) {
    check('验收执行未中断', false, String(error?.stack || error))
  } finally {
    try { if (ui) ui.close() } catch { /* ignore */ }
    killTree(app)
  }
  const failed = results.filter(r => !r.ok)
  console.log(`\n==== 达人邀约实时日志验收：${results.length - failed.length}/${results.length} 通过 ====`)
  if (failed.length) { console.log('失败项:'); for (const f of failed) console.log(` - ${f.name} :: ${f.detail}`); process.exit(1) }
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
