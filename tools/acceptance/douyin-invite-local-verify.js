/**
 * 抖店达人邀约本地端到端验收。
 *
 * 使用独立临时 userData 和本地仿真达人广场，完整走一遍：
 * UI 创建抖店邀约任务 -> 批量勾选 -> 打开邀约抽屉 -> 写话术
 * -> 停在中国式人工确认门禁 -> 确认 -> 仿真平台接收 -> 下一轮额度用尽收尾。
 *
 * 不连接真实抖店，不会向真实达人发送邀约。
 */
const { spawn, execSync } = require('child_process')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.resolve(__dirname, '../..')
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = process.env.SHOPILOT_DOUYIN_CDP_PORT || '9261'
const SCRIPT_TEXT = '本地验收：诚邀达人合作带货，提供专属高佣与素材支持。'
const results = []

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch { /* 进程可能已自行退出 */ }
}

function freeDebugPort(port) {
  if (process.platform !== 'win32') return
  try {
    const out = execSync(`netstat -ano | findstr LISTENING | findstr :${port}`, { encoding: 'utf8' })
    const pids = new Set(out.split(/\r?\n/).map(line => line.trim().split(/\s+/).pop()).filter(p => /^\d+$/.test(p)))
    for (const pid of pids) {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) } catch { /* ignore */ }
    }
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
  } catch { /* 页面可见性断言会如实暴露 */ }
}

function startSite() {
  const state = { sentBatches: 0, sentCount: 0, quotaExhausted: false }

  function page() {
    const disabled = state.quotaExhausted ? 'disabled' : ''
    return `<!doctype html><html><head><meta charset="utf-8"><title>抖店达人广场-本地验收</title>
      <style>
        body { font: 14px sans-serif; margin: 20px; }
        table { border-collapse: collapse; margin: 16px 0; }
        td, th { border: 1px solid #ccc; padding: 8px 14px; }
        #drawer { display:none; position:fixed; right:0; top:0; width:420px; height:100%; padding:20px; box-sizing:border-box; background:#fff; border-left:1px solid #ddd; }
        #drawer.open { display:block; }
        textarea { width:100%; height:100px; box-sizing:border-box; }
        button { padding:8px 14px; }
      </style></head><body>
      <h1>抖店达人广场（本地验收）</h1>
      <div class="quick-filter-button-enums"><button id="category-chip">个护家清</button><button>生鲜</button></div>
      <div class="quick-filter-cascader-popover" style="display:none">
        <button id="category-any">不限</button>
        <button id="category-leaf">家清纸品</button>
        <button id="category-third-leaf" style="display:none">纸品</button>
      </div>
      <div id="filtered-row"><span>已筛选</span><span id="filtered-value"></span></div>
      <div>达人等级 <button>LV0</button><button>LV1</button><button>LV2</button><button>LV3</button></div>
      <div><button>搜索</button></div>
      <div id="selected-count">已选择 <b>0</b> 位达人</div>
      <table><thead><tr><th><input type="checkbox" id="all"></th><th>达人</th></tr></thead><tbody>
        <tr data-row-key="daren-1"><td><label><input type="checkbox" class="daren"></label></td><td>达人A</td></tr>
        <tr data-row-key="daren-2"><td><label><input type="checkbox" class="daren"></label></td><td>达人B</td></tr>
        <tr data-row-key="daren-3"><td><label><input type="checkbox" class="daren"></label></td><td>达人C</td></tr>
      </tbody></table>
      <button id="batch-invite">批量邀约带货</button>
      <div id="drawer">
        <h2>批量邀约</h2>
        <textarea placeholder="请输入邀约话术"></textarea>
        <p><button id="confirm-send" ${disabled}>确认发送</button></p>
        ${state.quotaExhausted ? '<p id="quota-hint">今日邀约额度已用尽</p>' : ''}
      </div>
      <script>
        const state = ${JSON.stringify(state)};
        const checks = [...document.querySelectorAll('tbody input[type=checkbox]')];
        const count = () => checks.filter(x => x.checked).length;
        const counter = document.getElementById('selected-count');
        const redraw = () => { counter.innerHTML = '已选择 <b>' + count() + '</b> 位达人'; };
        for (const c of checks) c.addEventListener('change', redraw);
        document.getElementById('batch-invite').addEventListener('click', () => {
          document.getElementById('drawer').classList.add('open');
        });
        document.getElementById('category-chip').addEventListener('click', () => {
          document.querySelector('.quick-filter-cascader-popover').style.display = 'block';
        });
        document.getElementById('category-any').addEventListener('click', () => {
          document.getElementById('filtered-value').textContent = ' 个护家清';
        });
        document.getElementById('category-leaf').addEventListener('click', () => {
          document.getElementById('filtered-value').textContent = ' 个护家清 家清纸品';
          document.getElementById('category-third-leaf').style.display = 'block';
        });
        document.getElementById('category-third-leaf').addEventListener('click', () => {
          document.getElementById('filtered-value').textContent = ' 个护家清 家清纸品 纸品';
        });
        document.getElementById('confirm-send').addEventListener('click', () => {
          if (${state.quotaExhausted}) return;
          const n = count();
          fetch('/__send', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ count: n }), keepalive: true });
          document.getElementById('drawer').classList.remove('open');
        });
      </script></body></html>`
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><body>本地店铺</body></html>')
      return
    }
    if (req.method === 'GET' && req.url === '/daren-square') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page())
      return
    }
    if (req.method === 'GET' && req.url === '/square_doudian_pc_api/square/filter?type=1&req_scene=1') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        code: 0,
        data: {
          headers: [{
            key: 'main_cate_new',
            title: '主推类目',
            options: [{
              label: '个护家清',
              children: [{
                label: '家清纸品',
                children: [{ label: '纸品' }, { label: '清洁用品' }]
              }]
            }]
          }]
        }
      }))
      return
    }
    if (req.method === 'GET' && req.url === '/__state') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(state))
      return
    }
    if (req.method === 'POST' && req.url === '/__send') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}')
          state.sentBatches += 1
          state.sentCount += Number(parsed.count) || 0
          state.quotaExhausted = true
        } catch { /* 验收会在状态断言里暴露 */ }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
      return
    }
    res.writeHead(404)
    res.end('not found')
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        base: `http://127.0.0.1:${address.port}`,
        state,
        close: () => new Promise(r => server.close(r))
      })
    })
  })
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve
      this.ws.onerror = reject
    })
    this.ws.onmessage = event => {
      const msg = JSON.parse(event.data)
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(msg.error.message))
      else pending.resolve(msg.result)
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
    const result = await this.send('Runtime.evaluate', {
      expression: awaitPromise ? `(async () => { ${expression} })()` : expression,
      awaitPromise,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result.value
  }

  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
  return response.json()
}

async function getTargets() { return fetchJson(`http://127.0.0.1:${CDP_PORT}/json`) }

async function waitForCDP(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (response.ok) return
    } catch { /* retry */ }
    await sleep(400)
  }
  throw new Error('CDP endpoint not ready')
}

async function connectUi() {
  const targets = await getTargets()
  const target = targets.find(t => t.type === 'page' && t.url.includes('/renderer/index.html'))
  if (!target) throw new Error('ShopPilot UI target not found')
  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.eval(`const until = Date.now() + 15000; while (!window.shopilot && Date.now() < until) await new Promise(r => setTimeout(r, 100)); return !!window.shopilot;`)
  return cdp
}

async function connectPage(urlPart) {
  const targets = await getTargets()
  const target = targets.find(t => t.type === 'page' && t.url.includes(urlPart))
  if (!target) throw new Error(`page target not found: ${urlPart}`)
  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.ready
  return cdp
}

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

async function main() {
  console.log('=== 抖店达人邀约本地端到端验收 ===')
  const site = await startSite()
  const userData = path.join(os.tmpdir(), 'shopilot-douyin-invite-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  freeDebugPort(CDP_PORT)
  let app = null
  let ui = null

  try {
    app = spawn(electronExe, [
      root,
      '--no-sandbox',
      `--remote-debugging-port=${CDP_PORT}`,
      '--user-data-dir=' + userData,
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows'
    ], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, NODE_ENV: 'production', ELECTRON_ENABLE_LOGGING: '1', SHOPILOT_DISABLE_CDP_FP: '1' }
    })

    await waitForCDP()
    focusAppWindow(app.pid)
    await sleep(1200)
    ui = await connectUi()

    const api = {
      taskList: () => ui.eval(`return await window.shopilot.task.list();`),
      taskResults: runId => ui.eval(`return await window.shopilot.task.results(${JSON.stringify(runId)});`),
      taskConfirm: (runId, approved) => ui.eval(`return await window.shopilot.task.confirm(${JSON.stringify(runId)}, ${approved});`),
      taskDelete: taskId => ui.eval(`return await window.shopilot.task.delete(${JSON.stringify(taskId)});`),
      settingsSet: (key, value) => ui.eval(`return await window.shopilot.settings.set(${JSON.stringify(key)}, ${JSON.stringify(value)});`),
      storeCreate: input => ui.eval(`return await window.shopilot.store.create(${JSON.stringify(input)});`)
    }

    const settings = await api.settingsSet('invite.squareUrls', { '抖店': site.base + '/daren-square' })
    check('本地达人广场地址可通过现有设置注入', settings.ok, JSON.stringify(settings.error || settings.data))

    const createdStore = await api.storeCreate({
      name: '抖店邀约本地验收',
      platform: '抖店',
      adminUrl: site.base + '/'
    })
    check('创建抖店本地验收店铺', createdStore.ok && !!createdStore.data?.id, JSON.stringify(createdStore.error || createdStore.data))
    if (!createdStore.ok) throw new Error('store create failed')
    const storeId = createdStore.data.id

    await ui.eval(`location.reload(); return true;`)
    await sleep(3500)
    focusAppWindow(app.pid)
    ui = await connectUi()

    const opened = await ui.eval(`
      const cards = [...document.querySelectorAll('.store-card')];
      const card = cards.find(x => x.textContent.includes('抖店邀约本地验收'));
      if (!card) return false;
      (card.querySelector('.store-action') || card).click();
      return true;
    `)
    check('通过 UI 打开抖店验收店铺', opened)
    await sleep(2200)

    const panelReady = await ui.eval(`
      const taskTab = [...document.querySelectorAll('.ptab')].find(x => x.textContent.trim() === '任务');
      if (!taskTab) return false;
      taskTab.click();
      await new Promise(r => setTimeout(r, 500));
      const inviteTab = document.querySelector('[data-test="task-tab-invite"]');
      if (!inviteTab) return false;
      inviteTab.click();
      await new Promise(r => setTimeout(r, 600));
      return !!document.querySelector('[data-test="invite-panel"]');
    `)
    check('抖店达人邀约面板可打开', panelReady)

    const configured = await ui.eval(`
      const openPage = document.querySelector('[data-test="invite-open-page"]');
      if (!openPage) return { error: 'missing-open-page' };
      openPage.click();
      await new Promise(r => setTimeout(r, 4200));
      const level = document.querySelector('[data-test="invite-level-LV0"]');
      const category = document.querySelector('[data-test="invite-category"]');
      const subcategory = document.querySelector('[data-test="invite-subcategory"]');
      const category3 = document.querySelector('[data-test="invite-category3"]');
      const count = document.querySelector('[data-test="invite-count"]');
      const script = document.querySelector('[data-test="invite-script"]');
      if (!level || !category || !subcategory || !category3 || !count || !script) return { error: 'missing-controls' };
      if (!level.checked) level.click();
      const setValue = (el, value) => {
        const proto = el.tagName === 'TEXTAREA'
          ? HTMLTextAreaElement.prototype
          : el.tagName === 'SELECT'
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setValue(category, '个护家清');
      await new Promise(r => setTimeout(r, 300));
      setValue(subcategory, '家清纸品');
      await new Promise(r => setTimeout(r, 300));
      setValue(category3, '纸品');
      setValue(count, '2');
      setValue(script, ${JSON.stringify(SCRIPT_TEXT)});
      await new Promise(r => setTimeout(r, 700));
      const start = document.querySelector('[data-test="invite-start"]');
      return {
        level: level.checked,
        category: category.value,
        subcategory: subcategory.value,
        category3: category3.value,
        category3Options: [...category3.options].map(x => x.value),
        count: count.value,
        script: script.value,
        startDisabled: start ? start.disabled : null
      };
    `)
    check('面板读取真实三级类目并配置可用（个护家清/家清纸品/纸品、LV0、每批 2 位、手填话术）',
      configured.level === true &&
      configured.category === '个护家清' &&
      configured.subcategory === '家清纸品' &&
      configured.category3 === '纸品' &&
      configured.category3Options.includes('纸品') &&
      configured.count === '2' &&
      configured.script === SCRIPT_TEXT &&
      configured.startDisabled === false,
      JSON.stringify(configured))

    const clicked = await ui.eval(`
      const start = document.querySelector('[data-test="invite-start"]');
      if (!start || start.disabled) return false;
      start.click();
      await new Promise(r => setTimeout(r, 1000));
      return true;
    `)
    check('通过 UI「开始邀约」创建并启动任务', clicked)

    let task = null
    for (let i = 0; i < 30 && !task; i++) {
      const listed = await api.taskList()
      if (listed.ok) task = (listed.data || []).find(t => t.storeScope === storeId && String(t.name).startsWith('达人邀约 · 抖店'))
      if (!task) await sleep(300)
    }
    check('任务列表出现抖店邀约任务', !!task, task ? `${task.name} / ${task.latestRun?.status}` : 'not found')
    if (!task?.latestRun?.id) throw new Error('invite task not created')
    const runId = task.latestRun.id

    const atGate = await pollRun(api, runId, data => data.run.status === 'waiting_confirmation', 90000)
    check('完整执行到发送前人工确认门禁', atGate?.run.status === 'waiting_confirmation',
      atGate ? `${atGate.run.status} / step=${atGate.run.currentStep}` : 'no run data')

    const page = await connectPage('/daren-square')
    const pageState = await page.eval(`
      const checked = document.querySelectorAll('tbody input[type=checkbox]:checked').length;
      const drawer = document.getElementById('drawer');
      const script = document.querySelector('textarea');
      return {
        checked,
        counter: document.getElementById('selected-count')?.innerText || '',
        filtered: document.getElementById('filtered-value')?.innerText || '',
        script: script?.value || '',
        drawerOpen: !!drawer && getComputedStyle(drawer).display !== 'none'
      };
    `)
    check('仿真广场真实勾满 2 位且页面计数同步',
      pageState.checked === 2 && /已选择\s*2\s*位达人/.test(pageState.counter),
      JSON.stringify(pageState))
    check('邀约抽屉打开且话术写入正确',
      pageState.drawerOpen && pageState.script === SCRIPT_TEXT,
      JSON.stringify({ drawerOpen: pageState.drawerOpen, scriptLength: pageState.script.length }))
    check('仿真平台三级类目筛选真实生效',
      /个护家清/.test(pageState.filtered) && /家清纸品/.test(pageState.filtered) && /纸品/.test(pageState.filtered),
      JSON.stringify({ filtered: pageState.filtered }))

    const gateVisible = await ui.eval(`return !!document.querySelector('[data-test="task-confirm"]');`)
    check('UI 确认门禁可见', gateVisible)

    const clickAllDefinition = atGate?.steps?.[0]?.input?.steps?.find(s => s.type === 'clickAll')
    check('邀约任务包含抖店批量勾选步骤（最多 2 位、允许滚动续选）',
      clickAllDefinition?.input?.selector === 'tbody input[type=checkbox]' &&
      clickAllDefinition?.input?.max === 2 &&
      clickAllDefinition?.input?.scroll === true,
      JSON.stringify(clickAllDefinition?.input || null))
    const innerSteps = atGate?.steps?.[0]?.input?.steps || []
    const categoryClicks = innerSteps
      .filter(s => s.type === 'clickByText')
      .map(s => String(s.input?.text || ''))
    check('邀约任务按一级 → 二级 → 三级顺序点击',
      categoryClicks.indexOf('个护家清') >= 0 &&
      categoryClicks.indexOf('家清纸品') > categoryClicks.indexOf('个护家清') &&
      categoryClicks.indexOf('纸品') > categoryClicks.indexOf('家清纸品'),
      JSON.stringify(categoryClicks))

    const confirmed = await api.taskConfirm(runId, true)
    check('人工确认放行', confirmed.ok, JSON.stringify(confirmed.error || confirmed.data))

    const terminal = await pollRun(api, runId, data => ['succeeded', 'failed', 'cancelled'].includes(data.run.status), 90000)
    check('仿真发送后任务成功收尾', terminal?.run.status === 'succeeded',
      terminal ? `${terminal.run.status} / ${terminal.run.errorMessage || terminal.run.statusReason || ''}` : 'no run data')

    await sleep(1000)
    check('仿真平台仅收到 1 批、共 2 位，不重复发送',
      site.state.sentBatches === 1 && site.state.sentCount === 2,
      JSON.stringify(site.state))
    check('发送后下一轮额度用尽并触发正常停止',
      site.state.quotaExhausted === true,
      JSON.stringify(site.state))

    const loopResult = terminal?.results?.find(r => r.kind === 'executed' && r.payload?.action === 'loop')
    check('循环结果记录额度用尽停止原因',
      loopResult?.payload?.stopReason === 'TASK_QUOTA_EXCEEDED',
      JSON.stringify(loopResult?.payload ? {
        completedRounds: loopResult.payload.completedRounds,
        stopReason: loopResult.payload.stopReason
      } : null))

    check('发送后截图留档并落盘',
      !!loopResult?.artifactPath && fs.existsSync(loopResult.artifactPath),
      loopResult ? JSON.stringify({ path: loopResult.artifactPath, sha256: loopResult.artifactSha256?.slice(0, 12) }) : 'no screenshot')

    const deleted = await api.taskDelete(task.id)
    check('验收任务可删除（级联清理运行记录）', deleted.ok)
    page.close()
  } catch (error) {
    check('验收执行未中断', false, String(error?.stack || error))
  } finally {
    ui?.close()
    killTree(app)
    await sleep(1000)
    await site.close()
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* 临时目录由系统回收 */ }
  }

  const passed = results.filter(r => r.ok).length
  console.log(`\n通过 ${passed}/${results.length}`)
  if (passed !== results.length) process.exit(1)
  console.log('ALL_DOUYIN_INVITE_LOCAL_ACCEPTANCE_PASSED')
}

main().catch(error => {
  console.error('RUNNER_ERROR', error)
  process.exit(1)
})
