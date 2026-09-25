/**
 * Agent CDP 验收：真实 Electron/Preload/Main/WebContentsView/TaskRunner，
 * 仅将模型 HTTP 端点替换为本地固定 JSON 响应；网页读取结果仍由 TaskRunner 实际执行取得。
 */
const http = require('http')

const CDP_PORT = process.env.SHOPILOT_CDP_PORT || '9226'
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const generatedPlan = JSON.stringify({
  name: '读取当前页面标题',
  steps: [{ type: 'readText', input: { selector: 'title' }, description: '读取当前页面标题' }],
  schedule: null
})

let lastModelPrompt = ''
let flaky429Served = false
async function startSite() {
  const page = `<!doctype html><html><head><title>Agent CDP 页面标题</title></head><body>
    <h1>Agent 页面验收</h1>
    <button id="safe-button">读取订单</button>
    <p>收货地址：北京市朝阳区示例路88号，电话：13800138000</p>
    <table id="statistics"><thead><tr><th>订单数</th><th>成交金额</th></tr></thead>
      <tbody><tr><td>123</td><td>¥456.00</td></tr></tbody></table>
    <table id="private-no-header"><tr><td>收件人：王某某</td><td>地址：北京市朝阳区订单路99号</td><td>电话：13900139000</td></tr></table>
    <label>API Key<input type="password" value="do-not-observe-this-value"></label>
  </body></html>`
  const server = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      let body = ''
      request.on('data', chunk => { body += chunk.toString(); if (body.length > 100000) request.destroy() })
      request.on('end', () => {
        let userPayload = null
        let systemText = ''
        try {
          const parsed = JSON.parse(body)
          systemText = String(parsed?.messages?.find(item => item.role === 'system')?.content || '')
          const userText = String(parsed?.messages?.find(item => item.role === 'user')?.content || '')
          lastModelPrompt = userText
          userPayload = JSON.parse(userText)
        } catch { lastModelPrompt = ''; userPayload = null; systemText = '' }
        // 第一次补全先返回 429，验证 Main 只重试一次网络/429（§27.2）。
        if (!flaky429Served) {
          flaky429Served = true
          response.writeHead(429, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'fixture rate limited' } }))
          return
        }
        const turnMode = systemText.includes('"actions":[]')
        const chatMode = body.includes('直接输出面向用户的中文回复')
        const noStoreChat = body.includes('当前没有打开的店铺')
        const chatContent = noStoreChat
          ? '现在没有打开的店铺；页面任务需要先打开店铺，打开后我会生成计划并派给子 Agent。'
          : '收到。我按软件上下文里的店铺、子 Agent 和 Job 状态回答；页面任务会派给子 Agent 执行。'
        let content = chatMode ? chatContent : generatedPlan
        const goal = String(userPayload?.goal || '')
        const stores = Array.isArray(userPayload?.stores) ? userPayload.stores : []
        const previousResults = Array.isArray(userPayload?.previousResults) ? userPayload.previousResults : []
        if (turnMode && previousResults.length) {
          // 第二轮：基于上一轮执行结果收尾，展示思考并汇总。
          content = JSON.stringify({ thought: '动作已执行，我来基于结果给出结论。', reply: `已执行：${previousResults.join('；')}`, actions: [] })
        } else if (turnMode && /清点团队/.test(goal)) {
          content = JSON.stringify({ thought: '用户要清点团队，先读取子 Agent 列表最直接。', reply: '好的，我看一下。', actions: [{ type: 'listAgents' }] })
        } else if (turnMode && /第二个店/.test(goal)) {
          const target = stores.find(item => String(item.name || '').includes('第二店')) || stores[1]
          if (target) content = JSON.stringify({ thought: '关闭店铺会改变软件状态，需要先让用户确认。', reply: '收到，我来关闭它。', actions: [{ type: 'closeStore', storeId: target.id }] })
        } else if (turnMode && /备份/.test(goal)) {
          content = JSON.stringify({ thought: '备份是只读安全操作，可以直接执行。', reply: '好的，我来创建备份。', actions: [{ type: 'createBackup', label: '验收备份' }] })
        } else if (turnMode && /新建.*店/.test(goal)) {
          content = JSON.stringify({ thought: '创建店铺属于写操作，先给出计划等确认。', reply: '好的，我来创建。', actions: [{ type: 'createStore', name: '验收临时店铺', platform: '测试平台' }] })
        } else if (turnMode && /(彻底删除|永久删除)/.test(goal)) {
          const trash = Array.isArray(userPayload?.trashStores) ? userPayload.trashStores : []
          const target = trash.find(item => String(item.name || '').includes('验收临时店铺')) || trash[0]
          if (target) content = JSON.stringify({ thought: '彻底删除不可恢复，必须先让用户确认。', reply: '这是不可逆操作，我来生成确认计划。', actions: [{ type: 'deleteStorePermanent', storeId: target.id }] })
        } else if (turnMode && /(删掉|删除)/.test(goal) && /验收临时店铺/.test(goal)) {
          const target = stores.find(item => String(item.name || '').includes('验收临时店铺'))
          if (target) content = JSON.stringify({ thought: '删除店铺要移入回收站，先确认再执行。', reply: '好的，我来移入回收站。', actions: [{ type: 'archiveStore', storeId: target.id }] })
        } else if (turnMode && /任务详情/.test(goal)) {
          const target = Array.isArray(userPayload?.recentTasks) ? userPayload.recentTasks[0] : null
          if (target) content = JSON.stringify({ thought: '这是软件查询而不是页面任务，直接读任务详情。', reply: '好的，我来看任务详情。', actions: [{ type: 'getTaskDetail', taskId: target.id }] })
        } else if (turnMode && /发票/.test(goal)) {
          content = JSON.stringify({ thought: '采集是只读功能，但会派多个 Job，先确认再派。', reply: '好的，我来派发采集。', actions: [{ type: 'collectInvoices', storeIds: [] }] })
        } else if (turnMode && /制作.{0,6}技能/.test(goal)) {
          content = JSON.stringify({ thought: '用户要可复用的技能，我用现有工具组合一个声明式技能。', reply: '好的，我来制作技能。', actions: [{ type: 'createSkill', name: '验收巡检技能', description: '只读巡检店铺与 Job', intent: '只读巡检', steps: [{ type: 'listStores', input: {} }, { type: 'listJobs', input: {} }] }] })
        } else if (turnMode && /(打包.{0,6}插件|做成插件|打成插件)/.test(goal)) {
          const skills = Array.isArray(userPayload?.skills) ? userPayload.skills : []
          const target = skills.find(item => String(item.name || '').includes('验收巡检'))
          if (target) content = JSON.stringify({ thought: '用户要插件，把已有技能打包命名。', reply: '好的，我来打包插件。', actions: [{ type: 'createPlugin', name: '验收巡检插件', description: '巡检技能包', skillIds: [target.id] }] })
        } else if (turnMode && /运行.{0,6}技能/.test(goal)) {
          const skills = Array.isArray(userPayload?.skills) ? userPayload.skills : []
          const target = skills.find(item => String(item.name || '').includes('验收巡检'))
          if (target) content = JSON.stringify({ thought: '用户要运行技能，从上下文的 skills 里选目标。', reply: '好的，我来运行技能。', actions: [{ type: 'runSkill', skillId: target.id }] })
        } else if (chatMode && /暗号/.test(goal)) {
          const historyText = Array.isArray(userPayload?.conversationHistory) ? userPayload.conversationHistory.map(turn => String(turn.text || '')).join(' ') : ''
          content = historyText.includes('蓝鲸七号') ? '你刚才说的暗号是：蓝鲸七号。' : '我还没收到暗号。'
        } else if (chatMode && previousResults.length) {
          content = `已执行：${previousResults.join('；')}`
        }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ model: 'local-agent-fixture', choices: [{ message: { content } }] }))
      })
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(page)
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })))
}

class CDPSession {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.nextId = 0
    this.pending = new Map()
    this.consoleErrors = []
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve
      this.ws.onerror = reject
    })
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        this.consoleErrors.push({
          text: (message.params.args || []).map(arg => arg.description || arg.value || '').join(' ').slice(0, 500),
          stack: message.params.stackTrace?.callFrames?.slice(0, 4).map(frame => `${frame.functionName || '<anonymous>'} ${frame.url}:${frame.lineNumber + 1}`)
        })
      }
      if (message.id == null) return
      const waiting = this.pending.get(message.id)
      if (!waiting) return
      this.pending.delete(message.id)
      if (message.error) waiting.reject(new Error(message.error.message))
      else waiting.resolve(message.result)
    }
  }
  async command(method, params = {}, timeoutMs = 30000) {
    await this.ready
    const id = ++this.nextId
    let timer
    try {
      const result = await Promise.race([
        new Promise((resolve, reject) => {
          this.pending.set(id, { resolve, reject })
          this.ws.send(JSON.stringify({ id, method, params }))
        }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`CDP evaluate timed out after ${timeoutMs}ms`)), timeoutMs) })
      ])
      return result
    } finally { clearTimeout(timer); this.pending.delete(id) }
  }
  async evaluate(body, timeoutMs = 30000) {
    const result = await this.command('Runtime.evaluate', {
      expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true
    }, timeoutMs)
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }
  close() { try { this.ws.close() } catch {} }
}

async function main() {
  const results = []
  const check = (name, passed, detail = '') => {
    results.push({ name, passed: !!passed })
    console.log(`${passed ? 'PASS' : 'FAIL'} - ${name}${detail ? ` :: ${detail}` : ''}`)
  }
  let server
  let cdp
  try {
    const fixture = await startSite()
    server = fixture.server
    const targets = await (await fetch(`${CDP_BASE}/json`)).json()
    const appTarget = targets.find(target => target.type === 'page' && (target.url.includes('index.html') || target.url.startsWith('file:')))
    if (!appTarget) throw new Error('没有找到 ShopPilot 主窗口 CDP target')
    cdp = new CDPSession(appTarget.webSocketDebuggerUrl)
    const ready = await cdp.evaluate(`const until = Date.now() + 15000; while (!window.shopilot && Date.now() < until) await new Promise(r => setTimeout(r, 100)); return !!window.shopilot;`)
    if (!ready) throw new Error('Preload API 未就绪')
    await cdp.command('Runtime.enable')
    const call = expression => cdp.evaluate(`return await (${expression});`)
    const sendGoal = text => cdp.evaluate(`
      const input = document.querySelector('.agent-composer textarea');
      if (!input) return false;
      input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input',{bubbles:true}));
      return new Promise(resolve => setTimeout(() => { document.querySelector('.agent-send')?.click(); resolve(true) }, 50));
    `)
    const lastAssistant = () => cdp.evaluate(`const nodes=[...document.querySelectorAll('.agent-message.assistant .message-text')]; return nodes.length ? nodes[nodes.length-1].innerText : ''`)
    const waitReply = (previous, timeout = 25000) => poll(() => cdp.evaluate(`const nodes=[...document.querySelectorAll('.agent-message.assistant .message-text')]; const last = nodes.length ? nodes[nodes.length-1].innerText : ''; return last && last !== ${JSON.stringify(previous)} ? last : ''`), timeout)
    const poll = async (fn, timeoutMs = 15000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(200) }
      return null
    }
    const sendAgentGoal = async goal => cdp.evaluate(`
      const input = document.querySelector('.agent-composer textarea');
      if (!input) return false;
      input.value = ${JSON.stringify(goal)}; input.dispatchEvent(new Event('input',{bubbles:true}));
      return new Promise(resolve => setTimeout(() => { document.querySelector('.agent-send')?.click(); resolve(true) }, 50));
    `)

    const created = await call(`window.shopilot.store.create({name:'Agent CDP 临时店',platform:'测试平台',adminUrl:${JSON.stringify(fixture.base + '/agent')}})`)
    check('通过现有店铺 API 创建隔离验收店铺', created.ok, created.error?.message || '')
    if (!created.ok) throw new Error(created.error?.message || 'store.create failed')
    const storeId = created.data.id
    await cdp.evaluate('location.reload(); return true;')
    await sleep(1800)
    const openedFromWorkbench = await cdp.evaluate(`
      const card = [...document.querySelectorAll('.store-card')].find(item => item.textContent.includes('Agent CDP 临时店'));
      if (!card) return false;
      (card.querySelector('.store-action') || card).click();
      return true;
    `)
    check('通过工作台店铺按钮打开浏览器上下文', openedFromWorkbench)
    if (!openedFromWorkbench) throw new Error('store card not found')
    const tabs = await poll(async () => {
      const result = await call(`window.shopilot.browser.tab.list(${JSON.stringify(storeId)})`)
      return result.ok && result.data?.tabs?.length ? result.data.tabs : null
    }, 10000)
    const navigated = !!tabs?.[0]?.id && (await call(`window.shopilot.browser.navigate(${JSON.stringify(storeId)},${JSON.stringify(tabs[0].id)},${JSON.stringify(fixture.base + '/agent')})`)).ok
    check('通过既有标签页导航 API 打开本地验收页', navigated)
    const pageReady = await poll(async () => cdp.evaluate(`return document.querySelector('.tab-strip') && document.querySelector('.tab-title')?.textContent?.includes('Agent CDP')`), 20000)
    check('验收页面在真实 WebContentsView 中加载', !!pageReady)
    await sleep(500)

    const orbPresent = await cdp.evaluate(`return !!document.querySelector('.agent-orb')`)
    check('工作台渲染可键盘聚焦的 Agent 圆球入口', orbPresent)
    await cdp.evaluate(`document.querySelector('.agent-orb')?.click(); return true;`)
    const drawerOpened = await poll(() => cdp.evaluate(`return !!document.querySelector('.agent-drawer')`))
    const floatingDrawer = await cdp.evaluate(`return !!document.querySelector('[data-test="agent-floating-drawer"]') && !document.querySelector('.right-panel .agent-drawer')`)
    check('Agent 圆球打开跟随圆球的浮动抽屉且不占用右侧栏', !!drawerOpened && floatingDrawer)
    await cdp.evaluate(`document.activeElement?.blur(); return true;`)
    await cdp.command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await cdp.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    const drawerClosed = await poll(() => cdp.evaluate(`return !document.querySelector('.agent-drawer')`))
    const escapeDetail = !drawerClosed ? await cdp.evaluate(`return JSON.stringify({drawer:!!document.querySelector('.agent-drawer'),rightPanel:document.querySelector('.right-panel')?.innerText.slice(0,120),orb:!!document.querySelector('.agent-orb')})`) : ''
    check('Escape 可关闭抽屉且不销毁店铺标签页', !!drawerClosed && await cdp.evaluate(`return !!document.querySelector('.tab-strip .tab-title')`), escapeDetail)
    const orbStart = await cdp.evaluate(`const orb=document.querySelector('.agent-orb'),host=document.querySelector('.agent-orb-host'); if(!orb||!host)return null; const r=orb.getBoundingClientRect(),h=host.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,targetX:h.left+r.width/2+12,targetY:h.top+r.height/2+12}`)
    if (orbStart) {
      await cdp.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: orbStart.x, y: orbStart.y })
      await cdp.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: orbStart.x, y: orbStart.y, button: 'left', buttons: 1, clickCount: 1 })
      await cdp.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: orbStart.targetX, y: orbStart.targetY, button: 'left', buttons: 1 })
      await cdp.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: orbStart.targetX, y: orbStart.targetY, button: 'left', buttons: 0, clickCount: 1 })
      await sleep(250)
    }
    const draggedUi = await call('window.shopilot.agent.uiGet()')
    const orbPosition = draggedUi.data?.orbPosition
    const orbOnEdge = !!orbStart && !!orbPosition && (
      orbPosition.x <= 0.05 || orbPosition.x >= 0.95 || orbPosition.y <= 0.05 || orbPosition.y >= 0.95
    )
    const drawerStayedClosed = await cdp.evaluate(`return !document.querySelector('.agent-drawer')`)
    check('圆球真实拖拽后贴边、位置写入 app_settings 且不误开抽屉', orbOnEdge && drawerStayedClosed, JSON.stringify(orbPosition || {}))
    await cdp.evaluate(`document.querySelector('.agent-orb')?.click(); return true;`)
    await poll(() => cdp.evaluate(`return !!document.querySelector('.agent-drawer')`))

    const observed = await call('window.shopilot.agent.observe()')
    check('Main 只观察当前授权店铺的真实页面', observed.ok && observed.data?.pageTitle === 'Agent CDP 页面标题', observed.ok ? observed.data?.pageTitle : observed.error?.code)
    const observationClean = observed.ok &&
      !observed.data.visibleTextSummary.includes('北京市朝阳区') &&
      !observed.data.visibleTextSummary.includes('13800138000') &&
      !JSON.stringify(observed.data.tables).includes('订单路99号') &&
      !JSON.stringify(observed.data.tables).includes('13900139000') &&
      observed.data.inputs.every(item => !Object.prototype.hasOwnProperty.call(item, 'value'))
    check('观察摘要不含普通段落、无表头表格中的地址/手机号或输入框值', observationClean)

    const softwareContext = await call('window.shopilot.agent.softwareContext()')
    check('Agent 可读取软件级店铺、标签页和任务摘要', softwareContext.ok && Array.isArray(softwareContext.data?.stores) && softwareContext.data.stores.some(item => item.id === storeId) && !JSON.stringify(softwareContext.data).includes('webContents'))
    const secondCreated = await call(`window.shopilot.store.create({name:'Agent CDP 第二店',platform:'测试平台',adminUrl:${JSON.stringify(fixture.base + '/agent')}})`)
    const secondStoreId = secondCreated.ok ? secondCreated.data.id : ''
    check('软件级上下文可包含多个授权店铺', secondCreated.ok && !!secondStoreId)
    const sentOpenGoal = await sendAgentGoal('打开店铺 Agent CDP 第二店')
    const softwareCard = await poll(() => cdp.evaluate(`return !!document.querySelector('.agent-software-plan-card')`), 10000)
    check('软件级自然语言请求先展示受控操作计划', !!sentOpenGoal && !!softwareCard, softwareCard ? 'card' : 'no software plan card')
    await cdp.evaluate(`document.querySelector('.agent-software-plan-card .primary')?.click(); return true;`)
    const switchedToSecond = await poll(async () => {
      const context = await call('window.shopilot.agent.softwareContext()')
      return context.ok && context.data.displayedStoreId === secondStoreId ? context : null
    }, 10000)
    check('软件级计划可真实打开并切换到另一家店铺', !!switchedToSecond, switchedToSecond?.data?.activeTab?.storeName || '')
    const sentBackGoal = await sendAgentGoal('切换店铺 Agent CDP 临时店')
    await poll(() => cdp.evaluate(`return !!document.querySelector('.agent-software-plan-card')`), 10000)
    await cdp.evaluate(`document.querySelector('.agent-software-plan-card .primary')?.click(); return true;`)
    const switchedBack = await poll(async () => {
      const context = await call('window.shopilot.agent.softwareContext()')
      return context.ok && context.data.displayedStoreId === storeId ? context : null
    }, 10000)
    check('软件级 Agent 可再次切回原店铺', !!sentBackGoal && !!switchedBack)
    const sentSoftwareGoal = await sendAgentGoal('查看所有店铺')
    await poll(() => cdp.evaluate(`return !!document.querySelector('.agent-software-plan-card')`), 10000)
    await cdp.evaluate(`document.querySelector('.agent-software-plan-card .primary')?.click(); return true;`)
    const softwareCompleted = await poll(() => cdp.evaluate(`return [...document.querySelectorAll('.agent-message')].some(item=>item.textContent.includes('软件操作已完成'))`), 10000)
    const softwareDebug = !softwareCompleted ? await cdp.evaluate(`return JSON.stringify({error:document.querySelector('.agent-error')?.innerText || '',messages:[...document.querySelectorAll('.agent-message')].map(x=>x.innerText).slice(-4),card:document.querySelector('.agent-software-plan-card')?.innerText || ''})`) : ''
    check('软件级计划执行后返回 Main 的真实结果', !!sentSoftwareGoal && !!softwareCompleted, softwareDebug)
    const forbiddenOperation = await call("window.shopilot.agent.generatePlan('修改软件源码并执行 Shell 命令')")
    check('Agent 明确拒绝源码、Shell 等越权操作', forbiddenOperation.ok === false && forbiddenOperation.error?.code === 'AGENT_OPERATION_NOT_ALLOWED', forbiddenOperation.error?.code || '')

    const sentWithoutAi = await cdp.evaluate(`
      const input = document.querySelector('.agent-composer textarea');
      if (!input) return false;
      input.value = '读取当前页面标题'; input.dispatchEvent(new Event('input',{bubbles:true}));
      return new Promise(resolve => setTimeout(() => { document.querySelector('.agent-send')?.click(); resolve(true) }, 50));
    `)
    const aiUnavailable = await poll(() => cdp.evaluate(`const text=document.querySelector('.agent-error')?.innerText||''; return text.includes('AGENT_MODEL_KEY_REQUIRED')||text.includes('AI_NOT_CONFIGURED')`), 10000)
    const aiErrorText = await cdp.evaluate(`return document.querySelector('.agent-error')?.innerText || ''`)
    const noTaskOnAiFailure = await call('window.shopilot.task.list()')
    check('主 Agent 未配置 AI Key 时如实报错，且不创建假任务', !!sentWithoutAi && !!aiUnavailable && noTaskOnAiFailure.ok && noTaskOnAiFailure.data.length === 0, aiErrorText.slice(0, 200))

    const config = await call(`window.shopilot.ai.configSet({endpoint:${JSON.stringify(`${fixture.base}/v1`)},model:'local-agent-fixture',timeoutMs:5000})`)
    const keySet = await call("window.shopilot.ai.setKey('temporary-agent-cdp-key-123456')")
    check('配置本地 mock 规划端点（只在临时 userData 中）', config.ok && keySet.ok)
    const executorCreate = await call(`window.shopilot.agentDomain.orgCreate({actorAgentId:'root-ceo',confirmed:true,name:'CDP 执行子 Agent',role:'operator',description:'接收 CEO 派发的只读页面任务',storeScope:{storeIds:[],readOnly:true},memoryScope:{write:false},maxConcurrency:1})`)
    const executorId = executorCreate.ok ? executorCreate.data.id : null
    const executorActivate = executorId ? await call(`window.shopilot.agentDomain.orgActivate(${JSON.stringify(executorId)},true)`) : null
    check('创建并激活可供 CEO 派单的执行子 Agent', !!executorId && !!executorActivate?.ok, executorCreate.error?.code || executorActivate?.error?.code || '')
    const teamListSent = await sendGoal('查看有哪些子 Agent')
    const teamPlan = await poll(() => cdp.evaluate(`const card=document.querySelector('.agent-software-plan-card'); return card ? card.innerText : ''`), 15000)
    await cdp.evaluate(`document.querySelector('.agent-software-plan-card .plan-actions .primary')?.click(); return true;`)
    const teamContext = await poll(() => cdp.evaluate(`return (document.querySelector('.agent-software-context')?.innerText||'').includes('子 Agent')`), 10000)
    check('主 Agent 能列出子 Agent 团队（软件上下文含岗位与状态）', !!teamListSent && !!teamPlan && teamPlan.includes('子 Agent') && !!teamContext, `plan=${String(teamPlan || '').slice(0, 60)}`)
    const createSent = await sendGoal('创建一个数据分析的子 Agent')
    const createPlan = await poll(() => cdp.evaluate(`const card=document.querySelector('.agent-software-plan-card'); return card ? card.innerText : ''`), 15000)
    await cdp.evaluate(`document.querySelector('.agent-software-plan-card .plan-actions .primary')?.click(); return true;`)
    const createdAnalyst = await poll(async () => { const org = await call('window.shopilot.agentDomain.orgList({limit:200})'); return org.ok ? (org.data.items || []).find(item => item.role === 'analyst' && item.name === '数据分析') || null : null }, 15000)
    check('主 Agent 能在对话里创建 probation 子 Agent（确认后生效）', !!createSent && !!createPlan && createPlan.includes('创建') && !!createdAnalyst && createdAnalyst.status === 'probation', createdAnalyst ? createdAnalyst.id : String(createPlan || '').slice(0, 60))
    const activateSent = await sendGoal('激活数据分析')
    const activatePlan = await poll(() => cdp.evaluate(`const card=document.querySelector('.agent-software-plan-card'); return card ? card.innerText : ''`), 15000)
    await cdp.evaluate(`document.querySelector('.agent-software-plan-card .plan-actions .primary')?.click(); return true;`)
    const activeAnalyst = await poll(async () => { const org = await call('window.shopilot.agentDomain.orgList({limit:200})'); return org.ok ? (org.data.items || []).find(item => item.role === 'analyst' && item.status === 'active') || null : null }, 15000)
    check('主 Agent 能在对话里激活子 Agent（确认后生效）', !!activateSent && !!activatePlan && activatePlan.includes('激活') && !!activeAnalyst, activeAnalyst ? activeAnalyst.id : String(activatePlan || '').slice(0, 60))
    const panelSent = await sendGoal('打开 Agent 团队')
    const panelPlan = await poll(() => cdp.evaluate(`const card=document.querySelector('.agent-software-plan-card'); return card ? card.innerText : ''`), 15000)
    await cdp.evaluate(`document.querySelector('.agent-software-plan-card .plan-actions .primary')?.click(); return true;`)
    const panelOpened = await poll(() => cdp.evaluate(`return !!document.querySelector('[data-test="settings-dialog"]') && !!document.querySelector('[data-test="settings-agents"]')`), 10000)
    await cdp.evaluate(`document.querySelector('[data-test="settings-dialog"] .btn-ghost')?.click(); return true;`)
    check('主 Agent 能打开应用面板（Agent 团队）', !!panelSent && !!panelPlan && panelPlan.includes('Agent 团队') && !!panelOpened, String(panelPlan || '').slice(0, 60))
    const turnBeforeReply = await lastAssistant()
    const turnStarted = await sendGoal('帮我清点团队')
    const turnReply = await waitReply(turnBeforeReply, 25000)
    const thoughtShown = await poll(() => cdp.evaluate(`return [...document.querySelectorAll('.agent-message.thought .message-text')].some(node => node.innerText.includes('先读取子 Agent 列表'))`), 10000)
    check('智能体思考可见：回合展示思考过程', !!thoughtShown)
    const memoryBefore1 = await lastAssistant()
    const memorySent1 = await sendGoal('你好，请记住暗号：蓝鲸七号')
    const memoryReply1 = await waitReply(memoryBefore1)
    const memoryBefore2 = await lastAssistant()
    const memorySent2 = await sendGoal('我刚才说的暗号是什么？')
    const memoryReply2 = await waitReply(memoryBefore2)
    check('对话记忆：后续回合带最近对话与已审核记忆', !!memorySent1 && !!memoryReply1 && !!memorySent2 && !!memoryReply2 && memoryReply2.includes('蓝鲸七号') && lastModelPrompt.includes('蓝鲸七号') && lastModelPrompt.includes('conversationHistory') && lastModelPrompt.includes('approvedMemory'), `r1=${String(memoryReply1 || '').slice(0, 40)} r2=${String(memoryReply2 || '').slice(0, 60)}`)
    const turnNoPlan = await cdp.evaluate(`return !!document.querySelector('.agent-software-plan-card')`)
    check('智能体回合：模型自己决定只读软件操作并立即执行', !!turnStarted && !!turnReply && turnReply.includes('已执行') && turnReply.includes('子 Agent') && !turnNoPlan, `reply=${String(turnReply || '').slice(0, 80)}`)
    const closeSent = await sendGoal('把第二个店关掉')
    const closePlan = await poll(() => cdp.evaluate(`const card=document.querySelector('.agent-software-plan-card'); return card ? card.innerText : ''`), 20000)
    await cdp.evaluate(`document.querySelector('.agent-software-plan-card .plan-actions .primary')?.click(); return true;`)
    const closeDone = await poll(async () => { const r = await call(`window.shopilot.browser.tab.list(${JSON.stringify(secondStoreId)})`); return !r.ok || !(r.data?.tabs?.length) ? 'closed' : null }, 15000)
    check('智能体回合：模型按自然语言选择关闭店铺并等用户确认', !!closeSent && !!closePlan && closePlan.includes('关闭店铺') && closeDone === 'closed', `plan=${String(closePlan || '').slice(0, 60)}`)
    const beforeBackup = await lastAssistant()
    const backupSent = await sendGoal('备份一下')
    const backupReply = await waitReply(beforeBackup)
    check('智能体回合：只读软件动作（创建备份）立即执行', !!backupSent && !!backupReply && backupReply.includes('已执行') && backupReply.includes('备份'), `reply=${String(backupReply || '').slice(0, 80)}`)
    const createStoreSent = await sendGoal('帮我新建一个验收临时店铺')
    const createStorePlan = await poll(() => cdp.evaluate(`const card=document.querySelector('.agent-software-plan-card'); return card && card.innerText.includes('新建店铺') ? card.innerText : ''`), 20000)
    await cdp.evaluate(`document.querySelector('.agent-software-plan-card .plan-actions .primary')?.click(); return true;`)
    const createdStore = await poll(async () => { const list = await call('window.shopilot.store.list()'); return list.ok ? (list.data || []).find(item => item.name === '验收临时店铺') || null : null }, 15000)
    check('智能体回合：对话新建店铺（确认后生效）', !!createStoreSent && !!createStorePlan && createStorePlan.includes('新建店铺') && !!createdStore, createdStore ? createdStore.id : String(createStorePlan || '').slice(0, 60))
    const archiveBefore = await lastAssistant()
    const archiveSent = await sendGoal('把验收临时店铺删掉')
    const archivePlan = await poll(() => cdp.evaluate(`const card=document.querySelector('.agent-software-plan-card'); return card && card.innerText.includes('移入回收站') ? card.innerText : ''`), 20000)
    await cdp.evaluate(`document.querySelector('.agent-software-plan-card .plan-actions .primary')?.click(); return true;`)
    const archiveReply = await waitReply(archiveBefore)
    const archivedStore = await poll(async () => { const trash = await call('window.shopilot.store.trashList()'); return trash.ok && (trash.data || []).some(item => item.name === '验收临时店铺') ? 'archived' : null }, 15000)
    check('智能体回合：对话移入回收站（确认后生效）', !!archiveSent && !!archivePlan && archivePlan.includes('移入回收站') && archivedStore === 'archived', `plan=${String(archivePlan || '').slice(0, 40)} reply=${String(archiveReply || '').slice(0, 80)} archived=${archivedStore}`)
    const purgeSent = await sendGoal('彻底删除验收临时店铺')
    const purgePlan = await poll(() => cdp.evaluate(`const card=document.querySelector('.agent-software-plan-card'); return card && card.innerText.includes('彻底删除') ? card.innerText : ''`), 20000)
    await new Promise(resolve => setTimeout(resolve, 1200))
    const purgeStillInTrash = await (async () => { const trash = await call('window.shopilot.store.trashList()'); return !!(trash.ok && (trash.data || []).some(item => item.name === '验收临时店铺')) })()
    await cdp.evaluate(`document.querySelector('.agent-software-plan-card .plan-actions .primary')?.click(); return true;`)
    const purgeReply = await poll(() => cdp.evaluate(`const nodes=[...document.querySelectorAll('.agent-message.assistant .message-text')]; const last = nodes.length ? nodes[nodes.length-1].innerText : ''; return last.includes('彻底删除') ? last : ''`), 20000)
    const purgeDone = await poll(async () => { const trash = await call('window.shopilot.store.trashList()'); return trash.ok && !(trash.data || []).some(item => item.name === '验收临时店铺') ? 'purged' : null }, 15000)
    check('例外审批：彻底删除店铺未确认前不执行，确认后彻底删除', !!purgeSent && !!purgePlan && purgeStillInTrash && !!purgeReply && purgeDone === 'purged', `plan=${String(purgePlan || '').slice(0, 40)} stillThere=${purgeStillInTrash} purged=${purgeDone}`)
    const beforeCollect = await lastAssistant()
    const collectSent = await sendGoal('采集发票')
    const collectPlan = await poll(() => cdp.evaluate(`const card=document.querySelector('.agent-software-plan-card'); return card && card.innerText.includes('采集发票') ? card.innerText : ''`), 20000)
    await cdp.evaluate(`document.querySelector('.agent-software-plan-card .plan-actions .primary')?.click(); return true;`)
    const collectReply = await waitReply(beforeCollect)
    check('智能体回合：采集类只读动作走派单并如实汇报', !!collectSent && !!collectPlan && !!collectReply && /(未派发|已派发)/.test(collectReply), `reply=${String(collectReply || '').slice(0, 80)}`)
    const toolListSent = await sendGoal('查看工具')
    const toolListPlan = await poll(() => cdp.evaluate(`const card=document.querySelector('.agent-software-plan-card'); return card && card.innerText.includes('工具') ? card.innerText : ''`), 20000)
    const toolListReply = await poll(() => cdp.evaluate(`const nodes=[...document.querySelectorAll('.agent-message.assistant .message-text')]; const last = nodes.length ? nodes[nodes.length-1].innerText : ''; return last.includes('个工具') ? last : ''`), 25000)
    check('工具目录：对话可查看 AI 可调用的全部工具并执行计划', !!toolListSent && !!toolListPlan && !!toolListReply, `plan=${String(toolListPlan || '').slice(0, 40)} reply=${String(toolListReply || '').slice(0, 80)}`)
    const skillCreateSent = await sendGoal('帮我制作一个巡检技能：先看所有店铺状态，然后看最近 Job 的执行情况')
    const skillCreateReply = await poll(() => cdp.evaluate(`const nodes=[...document.querySelectorAll('.agent-message.assistant .message-text')]; const last = nodes.length ? nodes[nodes.length-1].innerText : ''; return last.includes('已制作技能') ? last : ''`), 25000)
    const skillInContext = await poll(async () => { const context = await call('window.shopilot.agent.softwareContext()'); return context.ok && (context.data.skills || []).some(item => item.name === '验收巡检技能') ? context.data.skills : null }, 10000)
    const skillThought = await poll(() => cdp.evaluate(`return [...document.querySelectorAll('.agent-message.thought .message-text')].some(node => node.innerText.includes('组合一个声明式技能'))`), 10000)
    check('技能：智能体用现有工具自己制作技能（思考可见、自动执行、进入上下文）', !!skillCreateSent && !!skillCreateReply && !!skillInContext && !!skillThought, `reply=${String(skillCreateReply || '').slice(0, 100)}`)
    const skillRunSent = await sendGoal('运行技能 验收巡检技能')
    const skillRunReply = await poll(() => cdp.evaluate(`const nodes=[...document.querySelectorAll('.agent-message.assistant .message-text')]; const last = nodes.length ? nodes[nodes.length-1].innerText : ''; return last.includes('执行完成') && last.includes('店铺') ? last : ''`), 25000)
    check('技能：对话运行技能并按步骤回传真实结果', !!skillRunSent && !!skillRunReply && skillRunReply.includes('验收巡检技能'), `reply=${String(skillRunReply || '').slice(0, 120)}`)
    const pluginSent = await sendGoal('把巡检技能打包成插件')
    const pluginReply = await poll(() => cdp.evaluate(`const nodes=[...document.querySelectorAll('.agent-message.assistant .message-text')]; const last = nodes.length ? nodes[nodes.length-1].innerText : ''; return last.includes('已制作插件') ? last : ''`), 25000)
    const pluginListSent = await sendGoal('查看插件')
    const pluginListPlan = await poll(() => cdp.evaluate(`const card=document.querySelector('.agent-software-plan-card'); return card && card.innerText.includes('插件') ? card.innerText : ''`), 20000)
    const pluginListReply = await poll(() => cdp.evaluate(`const nodes=[...document.querySelectorAll('.agent-message.assistant .message-text')]; const last = nodes.length ? nodes[nodes.length-1].innerText : ''; return last.includes('验收巡检插件') ? last : ''`), 25000)
    check('插件：智能体把技能打包成插件并能列出', !!pluginSent && !!pluginReply && !!pluginListSent && !!pluginListPlan && !!pluginListReply, `pack=${String(pluginReply || '').slice(0, 60)} list=${String(pluginListReply || '').slice(0, 80)}`)
    await cdp.evaluate(`document.querySelector('[data-test="settings-open-btn"]')?.click(); return true;`)
    await poll(() => cdp.evaluate(`return !!document.querySelector('[data-test="settings-dialog"]')`), 10000)
    await cdp.evaluate(`document.querySelector('[data-test="settings-tab-agents"]')?.click(); return true;`)
    await poll(() => cdp.evaluate(`return !!document.querySelector('[data-test="agent-admin-panel"]')`), 10000)
    const skillTabClicked = await cdp.evaluate(`const tabs=[...document.querySelectorAll('.admin-tab')]; const tab=tabs.find(node=>node.textContent?.includes('技能与插件')); if(tab) tab.click(); return !!tab`)
    const skillPanelText = await poll(() => cdp.evaluate(`const panel=document.querySelector('[data-test="agent-skill-panel"]'); return panel ? panel.innerText : ''`), 10000)
    check('设置面板：技能与插件页列出已创建的技能', !!skillTabClicked && !!skillPanelText && skillPanelText.includes('验收巡检技能') && skillPanelText.includes('验收巡检插件'), `panel=${String(skillPanelText || '').slice(0, 80)}`)
    await cdp.evaluate(`document.querySelector('[data-test="agent-skill-export-btn"]')?.click(); return true;`)
    const exportText = await poll(() => cdp.evaluate(`const node=document.querySelector('[data-test="agent-skill-export"]'); return node && node.value.includes('shopilot-agent-pack') ? node.value : ''`), 10000)
    check('设置面板：导出 JSON 分享包（含格式标记与技能）', !!exportText && exportText.includes('验收巡检技能') && JSON.parse(exportText).format === 'shopilot-agent-pack', String(exportText || '').slice(0, 80))
    const uiImportPack = JSON.stringify({ format: 'shopilot-agent-pack', version: 1, exportedAt: Date.now(), skills: [{ name: 'UI 导入技能', description: '设置面板导入验收', intent: '导入', steps: [{ type: 'listStores', input: {} }, { type: 'listJobs', input: {} }] }], plugins: [] })
    const importFilled = await cdp.evaluate(`
      const node=document.querySelector('[data-test="agent-skill-import"]');
      if(!node) return false;
      node.value=${JSON.stringify(uiImportPack)}; node.dispatchEvent(new Event('input',{bubbles:true}));
      return true;
    `)
    await cdp.evaluate(`document.querySelector('[data-test="agent-skill-import-btn"]')?.click(); return true;`)
    const importDone = await poll(() => cdp.evaluate(`const node=document.querySelector('[data-test="agent-skill-message"]'); return node && node.innerText.includes('导入完成') ? node.innerText : ''`), 15000)
    const importedSkillVisible = await poll(() => cdp.evaluate(`return !!document.querySelector('[data-test="agent-skill-UI 导入技能"]')`), 10000)
    check('设置面板：导入 JSON 包并出现在技能列表', !!importFilled && !!importDone && !!importedSkillVisible, `note=${String(importDone || '').slice(0, 80)}`)
    await cdp.evaluate(`document.querySelector('[data-test="settings-dialog"] .btn-ghost')?.click(); return true;`)
    await sleep(300)
    const closedFirst = await call(`window.shopilot.browser.close(${JSON.stringify(storeId)})`)
    const closedSecond = await call(`window.shopilot.browser.close(${JSON.stringify(secondStoreId)})`)
    const beforeChat = await lastAssistant()
    const chatSent = await cdp.evaluate(`
      const input = document.querySelector('.agent-composer textarea');
      if (!input) return false;
      input.value = '你好，请用一句话介绍你自己'; input.dispatchEvent(new Event('input',{bubbles:true}));
      return new Promise(resolve => setTimeout(() => { document.querySelector('.agent-send')?.click(); resolve(true) }, 50));
    `)
    const chatReply = await waitReply(beforeChat, 20000)
    const chatNoPlan = await cdp.evaluate(`return JSON.stringify({ plan: !!document.querySelector('.agent-plan-card'), software: !!document.querySelector('.agent-software-plan-card'), error: document.querySelector('.agent-error')?.innerText || '' })`)
    check('不打开店铺也能对话：返回聊天回复，不出现计划或观察错误', !!closedFirst?.ok && !!closedSecond?.ok && !!chatSent && !!chatReply && chatReply.includes('没有打开的店铺') && chatNoPlan.includes('"plan":false') && chatNoPlan.includes('"software":false') && chatNoPlan.includes('"error":""'), `reply=${String(chatReply || '').slice(0, 80)} ${chatNoPlan}`)
    check('模型 429 后按 §27.2 自动重试一次并成功', flaky429Served === true && !!turnReply && turnReply.includes('已执行'))
    const openGoalSent = await cdp.evaluate(`
      const input = document.querySelector('.agent-composer textarea');
      if (!input) return false;
      input.value = '读取 Agent CDP 临时店的页面标题'; input.dispatchEvent(new Event('input',{bubbles:true}));
      return new Promise(resolve => setTimeout(() => { document.querySelector('.agent-send')?.click(); resolve(true) }, 50));
    `)
    const softwarePrereq = await poll(() => cdp.evaluate(`const card=document.querySelector('.agent-software-plan-card'); if (card) return card.innerText; const nodes=[...document.querySelectorAll('.agent-message.assistant .message-text')]; const last=nodes.length?nodes[nodes.length-1].innerText:''; return last.includes('正在打开并继续规划') ? last : ''`), 15000)
    await cdp.evaluate(`document.querySelector('.agent-software-plan-card .plan-actions .primary')?.click(); return true;`)
    const reopenedTab = await poll(async () => { const tabs = await call(`window.shopilot.browser.tab.list(${JSON.stringify(storeId)})`); return tabs.ok && tabs.data?.tabs?.[0] ? tabs.data.tabs[0] : null }, 20000)
    const autoPlan = await poll(() => cdp.evaluate(`const card=document.querySelector('.agent-plan-card'); return card ? JSON.stringify({text:card.innerText, fields:[...card.querySelectorAll('input,textarea')].map(el=>el.value)}) : ''`), 25000)
    check('主 Agent 能自己操作软件：打开目标店铺并自动继续规划页面任务', !!openGoalSent && !!softwarePrereq && softwarePrereq.includes('打开') && !!reopenedTab?.id && !!autoPlan && autoPlan.includes('读取当前页面标题'), `software=${String(softwarePrereq || '').slice(0, 60)} plan=${String(autoPlan || '').slice(0, 120)}`)
    const typedGoal = await cdp.evaluate(`
      const input = document.querySelector('.agent-composer textarea');
      if (!input) return false;
      input.value = '读取当前页面标题'; input.dispatchEvent(new Event('input',{bubbles:true}));
      return new Promise(resolve => setTimeout(() => { document.querySelector('.agent-send')?.click(); resolve(true) }, 50));
    `)
    check('对话框接受自然语言并发起 Main 规划请求', typedGoal)
    const planReady = await poll(() => cdp.evaluate(`return !!document.querySelector('.agent-plan-card')`), 15000)
    const visiblePlan = planReady ? await cdp.evaluate(`const card=document.querySelector('.agent-plan-card'); return JSON.stringify({text:card?.innerText || '',fields:[...card?.querySelectorAll('input,textarea') || []].map(el=>el.value)})`) : ''
    const plannerDebug = !planReady ? await cdp.evaluate(`return JSON.stringify({ error:document.querySelector('.agent-error')?.innerText || '', messages:[...document.querySelectorAll('.agent-message')].map(x=>x.innerText), textarea:document.querySelector('.agent-composer textarea')?.value, sendDisabled:document.querySelector('.agent-send')?.disabled })`) : ''
    check('模型 JSON 经校验后展示真实 readText 计划', !!planReady && visiblePlan.includes('读取当前页面标题') && visiblePlan.includes('title'), planReady ? visiblePlan : plannerDebug)
    const promptWasBounded = lastModelPrompt.length > 0 && !lastModelPrompt.includes('北京市朝阳区') && !lastModelPrompt.includes('13800138000') && !lastModelPrompt.includes('订单路99号') && !lastModelPrompt.includes('13900139000') && !lastModelPrompt.includes('do-not-observe-this-value')
    check('固定 Main 提示词只收到有界安全摘要，不含地址、手机号、表单值或截图', promptWasBounded, `promptChars=${lastModelPrompt.length}`)

    const autoDispatched = await poll(async () => {
      const jobs = await call('window.shopilot.agentDomain.jobList({limit:50})')
      return jobs.ok ? (jobs.data.items || []).find(job => job.assignedAgentId === executorId && job.goal === '读取当前页面标题') : null
    }, 15000)
    const autoCheck = await cdp.evaluate(`return JSON.stringify({ planPrimaryDisabled: !!document.querySelector('.plan-actions .primary')?.disabled, note: [...document.querySelectorAll('.agent-message.assistant .message-text')].slice(-2).map(n=>n.innerText).join(' | ') })`)
    check('自治策略：页面任务生成后自动派给子 Agent（无需审批）', !!autoDispatched && autoCheck.includes('"planPrimaryDisabled":true'), `job=${autoDispatched?.id || ''} ${autoCheck}`)
    await cdp.evaluate(`document.querySelector('.plan-actions .primary')?.click(); return true;`)
    const delegatedJob = await poll(async () => {
      const jobs = await call('window.shopilot.agentDomain.jobList({limit:50})')
      return jobs.ok ? (jobs.data.items || []).find(job => job.assignedAgentId === executorId && job.goal === '读取当前页面标题') : null
    }, 10000)
    const finishedJob = await poll(async () => {
      if (!delegatedJob?.id) return null
      const current = await call(`window.shopilot.agentDomain.jobGet(${JSON.stringify(delegatedJob.id)})`)
      return current.ok && ['succeeded', 'failed', 'cancelled', 'blocked_permission'].includes(current.data.status) ? current.data : null
    }, 20000)
    const jobRunId = finishedJob?.browserRunId
    const runResults = jobRunId ? await call(`window.shopilot.task.results(${JSON.stringify(jobRunId)})`) : null
    const textResult = runResults?.ok ? runResults.data.results.find(row => row.kind === 'text')?.payload?.text : null
    check('CEO 通过 job:delegate 派给子 Agent，主 Agent 不再直接 task:create/task:run', !!delegatedJob && delegatedJob.createdByAgentId === 'root-ceo' && delegatedJob.assignedAgentId === executorId && !!delegatedJob.browserTaskId, JSON.stringify({ job: delegatedJob?.id, assigned: delegatedJob?.assignedAgentId, browserTask: delegatedJob?.browserTaskId }))
    check('TaskRunner 真实读取页面标题并返回结果', finishedJob?.status === 'succeeded' && textResult === 'Agent CDP 页面标题', `${finishedJob?.status || 'no run'} / ${String(textResult || '')} / ${JSON.stringify((finishedJob?.events || []).slice(-1).map(event => event.toStatus + ':' + event.reason))}`)
    check('AI Key 不进入 Job 和 TaskRunner 结果', !JSON.stringify(finishedJob || {}).includes('temporary-agent-cdp-key-123456') && !JSON.stringify(runResults || {}).includes('temporary-agent-cdp-key-123456'))
    const displayedResult = await poll(() => cdp.evaluate(`return [...document.querySelectorAll('.task-result-item')].some(item=>item.textContent.includes('Agent CDP 页面标题'))`), 15000)
    const resultDebug = !displayedResult ? await cdp.evaluate(`return document.querySelector('.agent-task-card')?.innerText || 'no task card'`) : ''
    check('抽屉显示 TaskRunner 返回的标题结果', !!displayedResult, resultDebug)
    const recapPosted = await poll(() => cdp.evaluate(`return [...document.querySelectorAll('.agent-message.assistant .message-text')].some(node => node.innerText.includes('审核结果') && node.innerText.includes('Job '))`), 8000)
    check('Job 完成后主 Agent 自动给出结果摘要与下一步建议', !!recapPosted)
    const awareLastBefore = await cdp.evaluate(`const nodes=[...document.querySelectorAll('.agent-message.assistant .message-text')]; return nodes.length ? nodes[nodes.length-1].innerText : ''`)
    const awareSent = await sendGoal('任务都成功了吗')
    const awareReply = await poll(() => cdp.evaluate(`const nodes=[...document.querySelectorAll('.agent-message.assistant .message-text')]; const last = nodes.length ? nodes[nodes.length-1].innerText : ''; return last && last !== ${JSON.stringify(awareLastBefore)} ? last : ''`), 15000)
    check('主 Agent 能基于 Job 摘要回答问题，不生成页面计划', !!awareSent && !!awareReply && !awareReply.includes('派发前预览') && lastModelPrompt.includes('"jobs"') && lastModelPrompt.includes('"status":"succeeded"'), `reply=${String(awareReply || '').slice(0, 60)}`)
    const beforeDetail = await lastAssistant()
    const detailSent = await sendGoal('读取一下任务详情')
    const detailReply = await waitReply(beforeDetail)
    const detailNoPagePlan = await cdp.evaluate(`return !!document.querySelector('.agent-plan-card')`)
    check('路由修复：软件指令不被当成页面任务（任务详情即时执行）', !!detailSent && !!detailReply && detailReply.includes('已执行') && detailReply.includes('任务「') && !detailNoPagePlan, `reply=${String(detailReply || '').slice(0, 90)}`)
    const businessBefore = await lastAssistant()
    const businessSent = await sendGoal('检查所有店铺订单')
    const businessReply = await waitReply(businessBefore, 40000)
    const businessNoPlan = await cdp.evaluate(`return !!document.querySelector('.agent-plan-card')`)
    check('经营指标检查走已实测采集（订单/销量/销售额），不再读页面标题', !!businessSent && !!businessReply && /(经营数据|未派发|已派发)/.test(businessReply) && !businessReply.includes('按顺序检查') && !businessNoPlan, `reply=${String(businessReply || '').slice(0, 120)}`)
    const multiBefore = await lastAssistant()
    const multiSent = await sendGoal('检查所有店铺页面标题')
    const multiReply = await waitReply(multiBefore, 40000)
    const multiJobs = await poll(async () => { const jobs = await call('window.shopilot.agentDomain.jobList({limit:50})'); return jobs.ok ? (jobs.data.items || []).filter(job => String(job.goal || '').includes('检查所有店铺页面标题')) : [] }, 20000)
    check('多店任务：逐店打开、规划并派给子 Agent（不再误判为店铺列表）', !!multiSent && !!multiReply && multiReply.includes('按顺序检查') && multiReply.includes('已派发') && !multiReply.includes('店铺的摘要') && (multiJobs || []).length >= 2, `reply=${String(multiReply || '').slice(0, 120)} jobs=${(multiJobs || []).length}`)
    const multiDone = await poll(() => cdp.evaluate(`return [...document.querySelectorAll('.agent-message.assistant .message-text')].some(node => node.innerText.includes('多店任务已全部结束'))`), 60000)
    const multiResultText = await cdp.evaluate(`return [...document.querySelectorAll('.agent-message.assistant .message-text')].map(node => node.innerText).filter(text => text.includes('执行完成')).slice(-3).join(' | ')`)
    check('多店任务执行完成后在对话里汇总结果', !!multiDone && multiResultText.includes('执行完成'), String(multiResultText).slice(0, 160))

    const persistedUi = await call('window.shopilot.agent.uiGet()')
    check('orb/drawer/message 摘要由 app_settings 持久化，不含页面截图', persistedUi.ok && !!persistedUi.data?.drawerOpen && !JSON.stringify(persistedUi.data).includes('data:image/png'))
    const keyNotInDom = await cdp.evaluate(`return !document.documentElement.outerHTML.includes('temporary-agent-cdp-key-123456')`)
    check('AI Key 不进入 Renderer DOM', keyNotInDom)
    const password = 'agent-cdp-test-pass'
    const passwordSet = await call(`window.shopilot.security.setPassword(${JSON.stringify(password)})`)
    const lockResult = passwordSet.ok ? await call('window.shopilot.security.lock()') : passwordSet
    const lockedObserve = lockResult.ok ? await call('window.shopilot.agent.observe()') : null
    const unlockResult = lockResult.ok ? await call(`window.shopilot.security.unlock(${JSON.stringify(password)})`) : null
    check('应用锁定时 Agent IPC 返回 APP_LOCKED，解锁后应用恢复', !!passwordSet.ok && !!lockResult.ok && lockedObserve?.ok === false && lockedObserve?.error?.code === 'APP_LOCKED' && !!unlockResult?.ok, lockedObserve?.error?.code || passwordSet.error?.code || '')
    await call('window.shopilot.ai.clearKey()')
    if (secondStoreId) {
      await call(`window.shopilot.browser.close(${JSON.stringify(secondStoreId)})`)
      await call(`window.shopilot.store.deletePermanent(${JSON.stringify(secondStoreId)})`)
    }
    const deleted = await call(`window.shopilot.store.deletePermanent(${JSON.stringify(storeId)})`)
    check('删除临时验收店铺（临时 profile）', deleted.ok, deleted.error?.message || '')
    if (cdp.consoleErrors.length) console.log('Renderer console errors:', JSON.stringify(cdp.consoleErrors.slice(0, 8)))
  } catch (error) {
    console.error('AGENT_CDP_FAILURE', error?.stack || error)
    results.push({ name: '验收流程未完成', passed: false })
  } finally {
    cdp?.close()
    if (server) {
      server.closeAllConnections?.()
      await new Promise(resolve => server.close(resolve))
    }
  }
  const passed = results.filter(result => result.passed).length
  const failed = results.length - passed
  console.log(`\nAgent CDP：通过 ${passed}/${results.length}`)
  if (failed) process.exitCode = 1
}

main().catch(error => { console.error('AGENT_CDP_CRASH', error); process.exit(2) })
