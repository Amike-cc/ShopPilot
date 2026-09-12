/**
 * 任务功能探针（用户实报"任务功能不正确"）：
 * 起本地测试站点 → 起应用 → 界面路径驱动 新建任务对话框（模板）→ 运行 → 观察状态/步骤图标/结果明细/确认门禁。
 * 只做观测与打印，不修改任何数据以外的状态；输出用于定位缺陷。
 */
const { spawn } = require('child_process')
const http = require('http')
const path = require('path')
const fs = require('fs')

const ROOT = __dirname
const PORT = 61500
const CDP_PORT = 9230
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

class CDP {
  constructor(wsUrl) {
    this.id = 0
    this.pending = new Map()
    this.console = []
    this.ws = new WebSocket(wsUrl)
    this.ready = new Promise((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error('ws error')) })
    this.ws.onmessage = (evt) => {
      const m = JSON.parse(evt.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result)
        return
      }
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
        this.console.push(`[console.${m.params.type}] ` + m.params.args.map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 240))
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.console.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 240))
      }
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  async evaluate(body) {
    await this.ready
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  close() { try { this.ws.close() } catch {} }
}

function startSite() {
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/orders')) { res.writeHead(404); res.end('nope'); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><title>订单页</title></head><body>
      <h1 id="h">订单</h1>
      <div id="unread">未读 3</div>
      <table><tbody>
        <tr><td>1001</td><td>待处理</td></tr>
        <tr><td>1002</td><td>待处理</td></tr>
        <tr><td>1003</td><td>已发货</td></tr>
        <tr><td>1004</td><td>待处理</td></tr>
      </tbody></table>
      <textarea id="title"></textarea>
    </body></html>`)
  })
  return new Promise(res => server.listen(PORT, '127.0.0.1', () => res(server)))
}

async function main() {
  const server = await startSite()
  const userData = path.join(process.env.TEMP || '/tmp', 'shopilot-uitask-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })

  const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const app = spawn(exe, ['.', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`], {
    cwd: ROOT, env: { ...process.env, NODE_ENV: 'production', SHOPILOT_CDP_PORT: String(CDP_PORT) }, stdio: 'ignore'
  })

  const kill = () => { try { spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
  process.on('exit', kill)

  // 等 CDP
  let ui = null
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(CDP_BASE + '/json/list')).json()
      const t = list.find(x => x.type === 'page' && x.url.includes('index.html'))
      if (t) { ui = t; break }
    } catch {}
    await sleep(700)
  }
  if (!ui) { console.log('未等到界面 CDP'); kill(); server.close(); return }

  const cdp = new CDP(ui.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable').catch(() => {})
  for (let i = 0; i < 40; i++) {
    const ok = await cdp.evaluate(`return typeof window.shopilot === 'object'`).catch(() => false)
    if (ok) break
    await sleep(500)
  }

  // ---------- 准备：建店 + 打开 + 导航 ----------
  const prep = await cdp.evaluate(`
    const list = await window.shopilot.store.list();
    let s = (list.data || [])[0];
    if (!s) s = (await window.shopilot.store.create({ name: '任务探针店', platform: '拼多多', adminUrl: 'http://127.0.0.1:${PORT}/orders' })).data;
    await window.shopilot.browser.open(s.id);
    const tabs = await window.shopilot.browser.tab.list(s.id);
    const tab = (tabs.data?.tabs || [])[0];
    if (tab) await window.shopilot.browser.navigate(s.id, tab.id, 'http://127.0.0.1:${PORT}/orders');
    await window.shopilot.browser.display(s.id);
    await new Promise(r => setTimeout(r, 2500));
    return { storeId: s.id, name: s.name, tabs: (tabs.data?.tabs || []).length };
  `)
  console.log('准备:', JSON.stringify(prep))
  await cdp.evaluate(`location.reload(); return true;`)
  await sleep(3500)
  // 刷新后渲染层回到欢迎页（主进程侧店铺仍开着）：重新点开店铺，右侧面板才会出现
  const reopened = await cdp.evaluate(`
    const card = document.querySelector('.store-card');
    if (card && !document.querySelector('.viewport')) {
      card.querySelector('.store-action')?.click();
      await new Promise(r => setTimeout(r, 3000));
    }
    return { viewport: !!document.querySelector('.viewport'), rightPanel: !!document.querySelector('.right-panel'), ptabs: [...document.querySelectorAll('.ptab')].map(b => b.textContent.trim()) };
  `)
  console.log('刷新后重开:', JSON.stringify(reopened))

  // ---------- 1. 打开任务面板与新建对话框，量界面 ----------
  const dialog = await cdp.evaluate(`
    const panelBtn = [...document.querySelectorAll('.ptab')].find(b => b.textContent.trim() === '任务');
    if (!panelBtn) return { error: '未找到任务面板页签', tabs: [...document.querySelectorAll('.ptab')].map(b => b.textContent.trim()) };
    panelBtn.click();
    await new Promise(r => setTimeout(r, 700));
    const newBtn = [...document.querySelectorAll('.right-panel button')].find(b => (b.textContent || '').includes('新建任务'));
    if (!newBtn) return { error: '未找到新建任务按钮', panelText: document.querySelector('.right-panel')?.textContent.slice(0, 200) };
    newBtn.click();
    await new Promise(r => setTimeout(r, 700));
    const modal = document.querySelector('.modal-wide');
    const r = el => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    const inputs = modal ? [...modal.querySelectorAll('input,select')].map(el => ({ tag: el.tagName, type: el.type || '', ph: el.placeholder || '', value: el.value, w: Math.round(el.getBoundingClientRect().width) })) : [];
    const dRect = modal ? r(modal) : null;
    const row = modal ? modal.querySelector('.tstep') : null;
    const del = modal ? modal.querySelector('.row-del') : null;
    const delRect = del ? r(del) : null;
    const wide = modal ? modal.querySelector('.f-wide') : null;
    return {
      modalShown: !!modal,
      rect: dRect,
      rowRect: row ? r(row) : null,
      rowScrollW: row ? row.scrollWidth : null,
      rowClientW: row ? row.clientWidth : null,
      delRect,
      delInsideDialog: (delRect && dRect) ? (delRect.right <= dRect.right + 1 && delRect.left >= dRect.left - 1) : null,
      delRightVsDialogRight: (delRect && dRect) ? delRect.x + delRect.w - (dRect.x + dRect.w) : null,
      wideRect: wide ? r(wide) : null,
      overflowX: modal ? modal.scrollWidth > modal.clientWidth + 1 : null,
      labels: modal ? [...modal.querySelectorAll('label')].map(l => l.textContent.trim().slice(0, 24)) : [],
      templates: modal ? [...modal.querySelectorAll('.tpl-row button')].map(b => b.textContent.trim()) : [],
      stepTypes: modal ? [...modal.querySelectorAll('.t-type option')].map(o => o.value) : [],
      stepRows: modal ? modal.querySelectorAll('.tstep').length : 0,
      inputs,
      createBtnDisabled: modal ? !!modal.querySelector('.btn-primary')?.disabled : null
    };
  `)
  console.log('\n=== 新建任务对话框 ===\n' + JSON.stringify(dialog, null, 2))

  // ---------- 2. 三个模板应用后的步骤参数 ----------
  const tpl = await cdp.evaluate(`
    const out = {};
    const btns = [...document.querySelectorAll('.tpl-row button')];
    for (const b of btns) {
      b.click();
      await new Promise(r => setTimeout(r, 350));
      out[b.textContent.trim()] = [...document.querySelectorAll('.tstep')].map(row => ({
        type: row.querySelector('.t-type')?.value,
        timeout: row.querySelectorAll('.f-port2')[0]?.value,
        retry: row.querySelectorAll('.f-port2')[1]?.value,
        fields: [...row.querySelectorAll('.f-wide')].map(i => ({ ph: i.placeholder, v: i.value }))
      }));
    }
    return out;
  `)
  console.log('\n=== 模板 → 步骤参数 ===\n' + JSON.stringify(tpl, null, 2))

  // ---------- 3. 页面快照任务：创建 → 运行 → 观察 ----------
  const runFlow = async (templateName, expect) => {
    const created = await cdp.evaluate(`
      // 每个流程都从"打开新建对话框"开始（上一次流程结束时对话框已关闭）
      const tasksTab = [...document.querySelectorAll('.ptab')].find(b => b.textContent.trim() === '任务');
      if (tasksTab) { tasksTab.click(); await new Promise(r => setTimeout(r, 500)); }
      const newBtn = [...document.querySelectorAll('.right-panel button')].find(b => (b.textContent || '').includes('新建任务'));
      newBtn.click();
      await new Promise(r => setTimeout(r, 600));
      const tplBtn = [...document.querySelectorAll('.tpl-row button')].find(b => b.textContent.trim() === ${JSON.stringify(templateName)});
      tplBtn.click();
      await new Promise(r => setTimeout(r, 350));
      const nameInput = document.querySelector('.modal-wide input[placeholder^="例如"]');
      nameInput.value = '探针任务-' + ${JSON.stringify(templateName)} + '-' + Date.now().toString().slice(-4);
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      // 填 URL 与选择器
      for (const row of document.querySelectorAll('.tstep')) {
        for (const inp of row.querySelectorAll('.f-wide')) {
          const ph = inp.placeholder || '';
          let v = '';
          if (ph.includes('页面地址')) v = 'http://127.0.0.1:${PORT}/orders';
          else if (ph.includes('CSS 选择器') || ph.includes('表格')) v = ph.includes('表格') ? 'table' : 'textarea#title';
          else if (ph.includes('指标名')) v = 'pending_orders';
          else if (ph.includes('草稿文本')) v = '探针草稿内容';
          if (v) { inp.value = v; inp.dispatchEvent(new Event('input', { bubbles: true })); }
        }
      }
      // 绑定店铺：选第一项非空
      const sel = document.querySelector('.modal-wide select');
      const opt = [...sel.options].find(o => o.value);
      if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      await new Promise(r => setTimeout(r, 200));
      const btn = document.querySelector('.modal-wide .btn-primary');
      const disabled = btn.disabled;
      btn.click();
      await new Promise(r => setTimeout(r, 1500));
      const tasks = (await window.shopilot.task.list()).data || [];
      const mine = tasks.map(t => ({ id: t.id, name: t.name, steps: (t.steps || []).length })).filter(t => t.name.startsWith('探针任务-'));
      return { disabled, created: mine[0] || null, modalGone: !document.querySelector('.modal-wide'), taskCount: tasks.length };
    `)
    console.log(`\n=== 创建（${templateName}）===\n` + JSON.stringify(created, null, 2))
    if (!created.created) return { created }

    // 界面点 ▶ 运行
    const started = await cdp.evaluate(`
      await (async () => { const r = await window.shopilot.task.list(); return r; })();
      const card = [...document.querySelectorAll('.right-panel .task-card')].find(c => c.textContent.includes(${JSON.stringify(created.created.name)}));
      if (!card) return { error: '任务卡未出现', panel: document.querySelector('.right-panel')?.textContent.slice(0, 300) };
      const btn = [...card.querySelectorAll('button')].find(b => (b.title || '').includes('立即运行') || b.textContent.trim() === '▶');
      if (!btn) return { error: '未找到运行按钮', buttons: [...card.querySelectorAll('button')].map(b => b.textContent.trim() + '|' + (b.title || '')) };
      btn.click();
      await new Promise(r => setTimeout(r, 1200));
      return { clicked: true };
    `)
    console.log(`--- 运行（${templateName}）: ` + JSON.stringify(started))

    // 轮询状态（含确认门禁）
    const trace = []
    for (let i = 0; i < 16; i++) {
      const snap = await cdp.evaluate(`
        const tasks = (await window.shopilot.task.list()).data || [];
        const t = tasks.find(x => x.id === ${JSON.stringify(created.created.id)});
        const run = t?.latestRun;
        let detail = null;
        if (run) {
          const rr = await window.shopilot.task.results(run.id);
          detail = rr.ok ? { results: (rr.data.results || []).map(r => ({ i: r.stepIndex, kind: r.kind, summary: (r.summary || '').slice(0, 70) })) } : { err: rr.error.code };
        }
        // 故意切到"环境"面板观察确认条是否仍然可见（跨面板可见性）
        const barNow = document.querySelector('.confirm-bar');
        return {
          status: run?.status, reason: (run?.statusReason || run?.errorMessage || '').slice(0, 90),
          steps: (t?.steps || []).length,
          confirmBarInTasksPanel: !!barNow,
          detail
        };
      `)
      // 门禁出现时，先切到"环境"面板看确认条是否还看得到，再切回并点允许
      if (snap.status === 'waiting_confirmation') {
        const crossPanel = await cdp.evaluate(`
          const envTab = [...document.querySelectorAll('.ptab')].find(b => b.textContent.trim() === '环境');
          envTab.click();
          await new Promise(r => setTimeout(r, 700));
          const bar = document.querySelector('.confirm-bar');
          const visible = !!bar && bar.getBoundingClientRect().width > 0;
          const tasksTab = [...document.querySelectorAll('.ptab')].find(b => b.textContent.trim() === '任务');
          tasksTab.click();
          await new Promise(r => setTimeout(r, 600));
          return { visibleOnEnvPanel: visible, onTasksPanel: !!document.querySelector('.confirm-bar') };
        `)
        console.log(`   第 ${i} 次: 等待确认 → 环境面板上确认条可见=${crossPanel.visibleOnEnvPanel}（任务面板=${crossPanel.onTasksPanel}）`)
        const clicked = await cdp.evaluate(`
          const bar = document.querySelector('.confirm-bar');
          const ok = bar && [...bar.querySelectorAll('button')].find(b => /允许/.test(b.textContent));
          if (ok) { ok.click(); await new Promise(r => setTimeout(r, 900)); return true }
          return false;
        `)
        console.log(`   → 点"允许"=${clicked}`)
      }
      trace.push(snap)
      if (['succeeded', 'failed', 'cancelled'].includes(snap.status)) break
      await sleep(1000)
    }
    console.log(`--- 状态轨迹（${templateName}）:`)
    trace.forEach((t, i) => console.log(`   ${i}: ${t.status} | ${t.reason || '-'} | 门禁=${t.confirmBar ? 'Y' : 'N'} | 结果=${JSON.stringify(t.detail?.results?.slice(0, 3) || t.detail?.err || null)}`))
    return { created, started, trace, expect }
  }

  const snapshotFlow = await runFlow('页面快照')
  const tableFlow = await runFlow('列表计数读取')
  const draftFlow = await runFlow('草稿填充（带确认门禁）')

  // ---------- 4. 页面实际状态（草稿是否真填入）----------
  const pageState = await cdp.evaluate(`
    const list = await (await fetch('http://127.0.0.1:${CDP_PORT}/json/list')).json();
    return { targets: list.filter(t => t.type === 'page').map(t => t.url.slice(0, 60)) };
  `).catch(() => null)
  console.log('\n=== 目标列表 ===\n' + JSON.stringify(pageState))

  const metrics = await cdp.evaluate(`
    const rr = await window.shopilot.snapshot.list(${JSON.stringify(prep.storeId)});
    return { snapshots: rr.ok ? (rr.data || []).slice(0, 5).map(s => ({ metric: s.metric, value: s.value, at: s.capturedAt })) : rr.error };
  `).catch((e) => ({ error: String(e.message) }))
  console.log('\n=== 指标快照 ===\n' + JSON.stringify(metrics, null, 2))

  if (cdp.console.length) console.log('\n=== 渲染层报错 ===\n' + cdp.console.slice(-10).join('\n'))
  console.log('\n结果汇总: 快照=' + snapshotFlow.trace?.at(-1)?.status + ' 表格=' + tableFlow.trace?.at(-1)?.status + ' 草稿=' + draftFlow.trace?.at(-1)?.status)
  cdp.close()
  kill()
  server.close()
}

main().catch(e => { console.error('PROBE_CRASH', e); process.exit(2) })
