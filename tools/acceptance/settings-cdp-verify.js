/**
 * 设置中心全功能验收：启动隔离 Electron，使用本地 HTTP fixture 验证设置页的
 * 平台入口（平台首页 + 达人广场合并）、三套 AI 配置、应用锁（安全）、
 * 数据与维护（采集开关 / 备份恢复 / 内存快照）、更新偏好和横向布局。
 * 不访问真实供应商，不执行付费生图或安装更新。
 */
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')

const ROOT = path.resolve(__dirname, '../..')
const APP = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = Number(process.env.SHOPILOT_SETTINGS_CDP_PORT || 9238)
const USER_DATA = path.join(os.tmpdir(), `shopilot-settings-${Date.now()}`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function killTree(child) {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch {}
}

async function waitFor(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return } catch {}
    await sleep(250)
  }
  throw new Error(`等待 ${url} 超时`)
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data)
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    }
  }
  async eval(body, timeoutMs = 20000) {
    await this.ready
    const expression = `(async()=>{${body}})()`
    const id = ++this.id
    const response = await Promise.race([
      new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject })
        this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('页面求值超时')), timeoutMs))
    ])
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    return response.result?.value
  }
  close() { try { this.ws.close() } catch {} }
}

function fixtureServer() {
  let chatRequests = 0
  let modelsRequests = 0
  let failChatRequests = false
  const server = http.createServer((req, res) => {
    const url = String(req.url || '')
    if (req.method === 'GET' && /\/models(?:\?|$)/.test(url)) {
      modelsRequests += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'fixture-chat' }, { id: 'fixture-image' }, { id: 'fixture-chat' }] }))
      return
    }
    if (req.method === 'POST' && /\/chat\/completions$/.test(url)) {
      chatRequests += 1
      req.setEncoding('utf8')
      req.on('data', () => {})
      req.on('end', () => {
        if (failChatRequests) {
          res.writeHead(402, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'Insufficient Balance' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ model: 'fixture-chat', choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }))
      })
      return
    }
    if (req.method === 'POST' && /\/images\/generations$/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ created: Date.now(), data: [{ b64_json: 'iVBORw0KGgo=', revised_prompt: 'fixture' }] }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'fixture route not found' }))
  })
  return { server, stats: () => ({ chatRequests, modelsRequests }), setChatFailure: value => { failChatRequests = value } }
}

async function main() {
  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: !!ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ` :: ${detail}` : ''}`)
  }
  let app = null
  let appLog = ''
  let cdp = null
  let fixture = null
  try {
    fixture = fixtureServer()
    await new Promise(resolve => fixture.server.listen(0, '127.0.0.1', resolve))
    const fixtureBase = `http://127.0.0.1:${fixture.server.address().port}`
    fs.mkdirSync(USER_DATA, { recursive: true })
    app = spawn(APP, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`, '--disable-features=CalculateNativeWinOcclusion'], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production', SHOPPILOT_TEST_AUTOCONFIRM: '1' }
    })
    app.stdout.on('data', chunk => { appLog += chunk.toString() })
    app.stderr.on('data', chunk => { appLog += chunk.toString() })
    await waitFor(`http://127.0.0.1:${PORT}/json/version`)
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    const target = targets.find(item => item.type === 'page' && (item.url.includes('index.html') || item.url.startsWith('file:')))
    if (!target) throw new Error('未找到应用主窗口 target')
    cdp = new CDP(target.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.eval(`const d=Date.now()+15000; while(!window.shopilot && Date.now()<d) await new Promise(r=>setTimeout(r,100)); if(!window.shopilot) throw new Error('window.shopilot 未注入'); return true`)

    await cdp.eval(`
      await window.shopilot.settings.set('platform.homeUrls', {});
      await window.shopilot.settings.set('invite.squareUrls', {});
      await window.shopilot.ai.clearKey(); await window.shopilot.ai.clearImageKey(); await window.shopilot.ai.clearImageTextKey();
      return true
    `)

    const openSettings = async tab => cdp.eval(`
      if (!document.querySelector('[data-test="settings-dialog"]')) document.querySelector('[data-test="settings-open-btn"]')?.click();
      await new Promise(r=>setTimeout(r,500));
      ${tab ? `document.querySelector('[data-test="settings-tab-${tab}"]')?.click(); await new Promise(r=>setTimeout(r,500));` : ''}
      return !!document.querySelector('[data-test="settings-dialog"]')
    `)
    const setInput = (selector, value) => cdp.eval(`
      const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('找不到 '+${JSON.stringify(selector)});
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(el,${JSON.stringify(value)});
      el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); await new Promise(r=>setTimeout(r,80)); return el.value
    `)
    const clickAndWait = (selector, waitForSelector = null) => cdp.eval(`
      document.querySelector(${JSON.stringify(selector)})?.click(); await new Promise(r=>setTimeout(r,650));
      return ${waitForSelector ? `!!document.querySelector(${JSON.stringify(waitForSelector)})` : 'true'}
    `)
    await openSettings('entry')
    const entryShape = await cdp.eval(`return {rows:document.querySelectorAll('[data-test="platform-home-row"]').length, squareRows:document.querySelectorAll('[data-test="square-url-row"]').length, groups:[!!document.querySelector('[data-test="settings-entry-platform"]'),!!document.querySelector('[data-test="settings-entry-square"]')], names:[...document.querySelectorAll('[data-test="platform-home-row"] .plat-name')].map(x=>x.textContent.trim()), disabled:[...document.querySelectorAll('[data-test="platform-home-row"] input')].some(x=>x.disabled)}`)
    check('平台入口页同屏两组地址：四个平台首页 + 三个达人广场、输入可用', entryShape.rows === 4 && entryShape.squareRows === 3 && entryShape.groups[0] && entryShape.groups[1] && entryShape.names.join(',') === '拼多多,微信小店,快手小店,抖店' && !entryShape.disabled, JSON.stringify(entryShape))
    await setInput('[data-test="home-url-拼多多"]', 'not-a-url')
    await clickAndWait('[data-test="settings-entry"] [data-test="settings-save"]')
    const invalidConfig = await cdp.eval(`return {open:!!document.querySelector('[data-test="settings-dialog"]'), error:document.querySelector('[data-test="settings-entry"] .settings-note.error')?.textContent||''}`)
    check('平台入口拒绝不完整 URL 且保留编辑内容', invalidConfig.open && /格式无效/.test(invalidConfig.error), JSON.stringify(invalidConfig))
    await setInput('[data-test="home-url-拼多多"]', `${fixtureBase}/home`)
    await clickAndWait('[data-test="settings-entry"] [data-test="settings-save"]')
    const homeSaved = await cdp.eval(`return (await window.shopilot.settings.get('platform.homeUrls')).data?.value||{}`)
    const afterEntrySave = await cdp.eval(`return {open:!!document.querySelector('[data-test="settings-dialog"]'), saved:(document.querySelector('.settings-save-state')?.textContent||'').replace(/\\s+/g,' ').trim()}`)
    check('平台入口保存平台首页并持久化（保存后停留在设置中心）', homeSaved['拼多多'] === `${fixtureBase}/home` && afterEntrySave.open === true && /已保存/.test(afterEntrySave.saved), JSON.stringify({ homeSaved, afterEntrySave }))
    // 未保存反馈：有草稿 → 徽标 + 放弃更改可用、保存按钮可用；放弃后 → 草稿还原、徽标消失、保存回到禁用
    await setInput('[data-test="home-url-拼多多"]', `${fixtureBase}/home-draft`)
    const dirtyState = await cdp.eval(`return {unsaved:!!document.querySelector('[data-test="settings-entry-unsaved"]'), discardEnabled:document.querySelector('[data-test="settings-entry-discard"]')?.disabled === false, saveEnabled:document.querySelector('[data-test="settings-save"]')?.disabled === false}`)
    await clickAndWait('[data-test="settings-entry-discard"]')
    const discarded = await cdp.eval(`return {value:document.querySelector('[data-test="home-url-拼多多"]')?.value||'', unsaved:!!document.querySelector('[data-test="settings-entry-unsaved"]'), saveDisabled:document.querySelector('[data-test="settings-save"]')?.disabled === true}`)
    check('未保存修改有徽标与放弃更改；放弃后草稿还原到已保存值且保存按钮回到禁用', dirtyState.unsaved && dirtyState.discardEnabled && dirtyState.saveEnabled && discarded.value === `${fixtureBase}/home` && discarded.unsaved === false && discarded.saveDisabled === true, JSON.stringify({ dirtyState, discarded }))
    await openSettings('entry')
    const restoredConfigValue = await cdp.eval(`return document.querySelector('[data-test="home-url-拼多多"]')?.value||''`)
    await cdp.eval(`document.querySelector('[data-test="home-url-拼多多"]')?.parentElement?.parentElement?.querySelector('button')?.click(); return true`)
    const clearedConfigValue = await cdp.eval(`return document.querySelector('[data-test="home-url-拼多多"]')?.value||''`)
    check('平台入口再次进入回显并可恢复默认', restoredConfigValue === `${fixtureBase}/home` && clearedConfigValue === '', JSON.stringify({ restoredConfigValue, clearedConfigValue }))
    await clickAndWait('[data-test="settings-entry"] [data-test="settings-save"]')
    check('平台入口恢复默认后清除覆盖值', Object.keys((await cdp.eval(`return (await window.shopilot.settings.get('platform.homeUrls')).data?.value||{}`))).length === 0)

    const squareShape = await cdp.eval(`return {rows:document.querySelectorAll('[data-test="square-url-row"]').length, names:[...document.querySelectorAll('[data-test="square-url-row"] .plat-name')].map(x=>x.textContent.trim())}`)
    check('平台入口的达人广场组仅展示三个实测平台', squareShape.rows === 3 && squareShape.names.join(',') === '抖店,微信小店,快手小店', JSON.stringify(squareShape))
    await setInput('[data-test="square-url-抖店"]', 'ftp://invalid')
    await clickAndWait('[data-test="settings-entry"] [data-test="settings-save"]')
    const invalidSquare = await cdp.eval(`return {open:!!document.querySelector('[data-test="settings-dialog"]'), error:document.querySelector('[data-test="settings-entry"] .settings-note.error')?.textContent||''}`)
    check('达人广场拒绝非 HTTP(S) 地址', invalidSquare.open && /格式无效/.test(invalidSquare.error), JSON.stringify(invalidSquare))
    await setInput('[data-test="square-url-抖店"]', `${fixtureBase}/square`)
    await clickAndWait('[data-test="settings-entry"] [data-test="settings-save"]')
    const squareSaved = await cdp.eval(`return (await window.shopilot.settings.get('invite.squareUrls')).data?.value||{}`)
    check('达人广场地址保存并持久化', squareSaved['抖店'] === `${fixtureBase}/square`, JSON.stringify(squareSaved))
    await cdp.eval(`document.querySelector('[data-test="square-url-抖店"]')?.parentElement?.parentElement?.querySelector('button')?.click(); return true`)
    await clickAndWait('[data-test="settings-entry"] [data-test="settings-save"]')
    check('达人广场恢复默认后清除覆盖值', Object.keys((await cdp.eval(`return (await window.shopilot.settings.get('invite.squareUrls')).data?.value||{}`))).length === 0)

    await openSettings('ai')
    const aiShape = await cdp.eval(`return {cards:[...document.querySelectorAll('.ai-config-card')].map(x=>x.dataset.test), endpoint:document.querySelector('[data-test="ai-endpoint"]')?.value, keyType:document.querySelector('[data-test="ai-key"]')?.type, overflow:document.querySelector('[data-test="settings-ai"]')?.scrollWidth>document.querySelector('[data-test="settings-ai"]')?.clientWidth+1}`)
    check('AI 配置页以三张独立卡片加载', aiShape.cards.join(',') === 'text-ai-config,image-ai-config,image-text-ai-config' && aiShape.keyType === 'password' && aiShape.overflow === false, JSON.stringify(aiShape))

    const textEndpoint = `${fixtureBase}/v1`
    await setInput('[data-test="ai-endpoint"]', textEndpoint)
    await setInput('[data-test="ai-model"]', 'fixture-chat')
    await setInput('[data-test="ai-key"]', 'fixture-text-key')
    await clickAndWait('[data-test="text-ai-config"] [data-test="settings-save"]')
    const textConfig = await cdp.eval(`return await window.shopilot.ai.configGet()`)
    const textDom = await cdp.eval(`return {key:document.querySelector('[data-test="ai-key"]')?.value, placeholder:document.querySelector('[data-test="ai-key"]')?.placeholder, leak:document.documentElement.outerHTML.includes('fixture-text-key')}`)
    check('文本 AI 保存配置与 Key 后不回显密文', textConfig.ok && textConfig.data.endpoint === textEndpoint && textConfig.data.hasKey === true && textDom.key === '' && /已配置/.test(textDom.placeholder) && !textDom.leak, JSON.stringify({ textConfig, textDom }))
    await setInput('[data-test="ai-endpoint"]', 'http://example.com/v1')
    const insecureAi = await cdp.eval(`return {ready:document.querySelector('[data-test="text-ai-config"] .ai-status')?.classList.contains('ok'), label:document.querySelector('[data-test="text-ai-config"] .ai-status')?.textContent.trim()}`)
    await clickAndWait('[data-test="text-ai-config"] [data-test="settings-save"]')
    const rejectedInsecureAi = await cdp.eval(`return {message:document.querySelector('[data-test="ai-msg"]')?.textContent||'', endpoint:(await window.shopilot.ai.configGet()).data.endpoint}`)
    check('公网 HTTP 文本端点不显示就绪且保存前拦截', insecureAi.ready === false && rejectedInsecureAi.endpoint === textEndpoint && /必须使用 HTTPS/.test(rejectedInsecureAi.message), JSON.stringify({ insecureAi, rejectedInsecureAi }))
    await setInput('[data-test="ai-endpoint"]', textEndpoint)
    await clickAndWait('[data-test="text-ai-config"] [data-test="settings-save"]')
    await clickAndWait('[data-test="ai-models-btn"]')
    const textModels = await cdp.eval(`return {picker:!!document.querySelector('[data-test="ai-model-pick"]'), options:[...document.querySelectorAll('[data-test="ai-model-pick"] option')].map(x=>x.value), msg:document.querySelector('[data-test="ai-msg"]')?.textContent||''}`)
    check('文本 AI 获取模型列表并可选模型', textModels.picker && textModels.options.includes('fixture-chat') && /已获取/.test(textModels.msg), JSON.stringify(textModels))
    await clickAndWait('[data-test="ai-test"]')
    const textTest = await cdp.eval(`return document.querySelector('[data-test="ai-msg"]')?.textContent||''`)
    check('文本 AI 测试连接成功', /连接成功/.test(textTest), textTest)
    fixture.setChatFailure(true)
    await clickAndWait('[data-test="ai-test"]')
    const failedTextTest = await cdp.eval(`return {message:document.querySelector('[data-test="ai-msg"]')?.textContent||'',summary:document.querySelector('[data-test="ai-config-summary"] strong')?.textContent.trim()||'',textStatus:document.querySelector('[data-test="ai-config-summary"] .ai-summary-status em')?.textContent.trim()||''}`)
    check('文本接口失败时摘要只表示配置完整度', /连接失败/.test(failedTextTest.message) && failedTextTest.summary === '已完成 1/3 套 AI 配置' && failedTextTest.textStatus === '已配置', JSON.stringify(failedTextTest))
    fixture.setChatFailure(false)
    await cdp.eval(`window.confirm=()=>true; document.querySelector('[data-test="ai-key-clear"]')?.click(); await new Promise(r=>setTimeout(r,500)); return true`)
    const textCleared = await cdp.eval(`return (await window.shopilot.ai.configGet()).data.hasKey`)
    check('文本 AI Key 可确认清除', textCleared === false, String(textCleared))
    await clickAndWait('[data-test="ai-test"]')
    const noKeyTest = await cdp.eval(`return {message:document.querySelector('[data-test="ai-msg"]')?.textContent||'', ok:document.querySelector('[data-test="ai-msg"]')?.classList.contains('ok')}`)
    check('文本 AI 未配置 Key 时测试如实失败', !noKeyTest.ok && /Key|密钥/.test(noKeyTest.message), JSON.stringify(noKeyTest))
    await setInput('[data-test="ai-key"]', 'fixture-text-key')
    await setInput('[data-test="text-ai-config"] input[type="number"]', '1')
    await clickAndWait('[data-test="text-ai-config"] [data-test="settings-save"]')
    const badTimeout = await cdp.eval(`return document.querySelector('[data-test="ai-msg"]')?.textContent||''`)
    check('文本 AI 拒绝超时范围错误并不发起保存', /超时值无效/.test(badTimeout), badTimeout)

    await setInput('[data-test="image-ai-endpoint"]', `${fixtureBase}/v1/images/generations`)
    await setInput('[data-test="image-ai-model"]', 'fixture-image')
    await setInput('[data-test="image-ai-config"] input[type="number"]', '60000')
    await setInput('[data-test="image-ai-config"] input[type="password"]', 'fixture-image-key')
    await clickAndWait('[data-test="image-ai-config"] .settings-actions .primary')
    const imageConfig = await cdp.eval(`return await window.shopilot.ai.configGet()`)
    check('生图 AI 独立保存端点、模型和 Key', imageConfig.ok && imageConfig.data.imageEndpoint === `${fixtureBase}/v1/images/generations` && imageConfig.data.hasImageKey === true && imageConfig.data.endpoint === textEndpoint, JSON.stringify(imageConfig.data))
    await clickAndWait('[data-test="image-ai-config"] .settings-actions button:nth-child(2)')
    const imageModels = await cdp.eval(`return {options:[...document.querySelectorAll('[data-test="image-ai-config"] .image-model-picker option')].map(x=>x.value), msg:document.querySelector('[data-test="image-ai-config"] .settings-note.ok')?.textContent||''}`)
    check('生图 AI 获取模型列表', imageModels.options.includes('fixture-image') && /已获取/.test(imageModels.msg), JSON.stringify(imageModels))
    await clickAndWait('[data-test="image-ai-config"] .settings-actions button:nth-child(3)')
    const imageMsg = await cdp.eval(`return document.querySelector('[data-test="image-ai-config"] .settings-note.ok')?.textContent||''`)
    check('生图 AI 只读测试连接成功', /生图接口可用/.test(imageMsg), imageMsg)
    await cdp.eval(`window.confirm=()=>true; document.querySelector('[data-test="image-ai-config"] .danger')?.click(); await new Promise(r=>setTimeout(r,450)); return true`)
    check('生图 AI Key 可清除', (await cdp.eval(`return (await window.shopilot.ai.configGet()).data.hasImageKey`)) === false)

    await setInput('[data-test="image-text-ai-endpoint"]', textEndpoint)
    await setInput('[data-test="image-text-ai-model"]', 'fixture-chat')
    await setInput('[data-test="image-text-ai-config"] input[type="number"]', '30000')
    await setInput('[data-test="image-text-ai-config"] input[type="password"]', 'fixture-analysis-key')
    await clickAndWait('[data-test="image-text-ai-config"] .settings-actions .primary')
    const analysisConfig = await cdp.eval(`return await window.shopilot.ai.configGet()`)
    check('生图文本 AI 独立保存且不覆盖文本/生图配置', analysisConfig.ok && analysisConfig.data.imageTextEndpoint === textEndpoint && analysisConfig.data.hasImageTextKey === true && analysisConfig.data.endpoint === textEndpoint && analysisConfig.data.imageEndpoint === `${fixtureBase}/v1/images/generations`, JSON.stringify(analysisConfig.data))
    await clickAndWait('[data-test="image-text-ai-config"] .settings-actions button:nth-child(2)')
    const analysisModels = await cdp.eval(`return {options:[...document.querySelectorAll('[data-test="image-text-ai-config"] .image-model-picker option')].map(x=>x.value), msg:document.querySelector('[data-test="image-text-ai-config"] .settings-note.ok')?.textContent||''}`)
    check('生图文本 AI 获取分析模型', analysisModels.options.includes('fixture-chat') && /已获取/.test(analysisModels.msg), JSON.stringify(analysisModels))
    await clickAndWait('[data-test="image-text-ai-config"] .settings-actions button:nth-child(3)')
    const analysisMsg = await cdp.eval(`return document.querySelector('[data-test="image-text-ai-config"] .settings-note.ok')?.textContent||''`)
    check('生图文本 AI 测试连接成功', /分析接口可用/.test(analysisMsg), analysisMsg)
    await cdp.eval(`window.confirm=()=>true; document.querySelector('[data-test="image-text-ai-config"] .danger')?.click(); await new Promise(r=>setTimeout(r,450)); return true`)
    check('生图文本 AI Key 可清除', (await cdp.eval(`return (await window.shopilot.ai.configGet()).data.hasImageTextKey`)) === false)
    check('AI fixture 请求覆盖模型列表和文本测试', fixture.stats().modelsRequests >= 3 && fixture.stats().chatRequests >= 2, JSON.stringify(fixture.stats()))

    await openSettings('about')
    const about = await cdp.eval(`return {version:document.querySelector('[data-test="about-version"]')?.textContent||'', channel:document.querySelector('[data-test="update-channel"]')?.value, auto:document.querySelector('[data-test="update-autocheck"]')?.checked, message:document.querySelector('[data-test="update-message"]')?.textContent||'', check:!!document.querySelector('[data-test="update-check-btn"]')}`)
    check('关于软件页加载版本、更新偏好和开发环境状态', /^v/.test(about.version) && about.channel === 'stable' && about.auto === false && about.check && /开发环境/.test(about.message), JSON.stringify(about))
    await cdp.eval(`const s=document.querySelector('[data-test="update-channel"]'); s.value='beta'; s.dispatchEvent(new Event('change',{bubbles:true})); await new Promise(r=>setTimeout(r,500)); const a=document.querySelector('[data-test="update-autocheck"]'); a.click(); await new Promise(r=>setTimeout(r,500)); return true`)
    const updatePrefs = await cdp.eval(`return {channel:(await window.shopilot.settings.get('update.channel')).data.value, auto:(await window.shopilot.settings.get('update.autoCheck')).data.value}`)
    check('关于软件页更新通道与自动检查偏好可保存', updatePrefs.channel === 'beta' && updatePrefs.auto === true, JSON.stringify(updatePrefs))
    await cdp.eval(`const s=document.querySelector('[data-test="update-channel"]'); s.value='stable'; s.dispatchEvent(new Event('change',{bubbles:true})); await new Promise(r=>setTimeout(r,350)); const a=document.querySelector('[data-test="update-autocheck"]'); a.click(); await new Promise(r=>setTimeout(r,350)); return true`)
    await cdp.eval(`document.querySelector('[data-test="update-check-btn"]')?.click(); await new Promise(r=>setTimeout(r,850)); return true`)
    const updateStatus = await cdp.eval(`return {message:document.querySelector('[data-test="update-message"]')?.textContent||'', state:(await window.shopilot.update.status()).data?.state}`)
    check('关于软件页检查更新显示真实开发环境结果', /开发环境|已是最新|失败|检查/.test(updateStatus.message), JSON.stringify(updateStatus))

    // ---------- 安全页签：应用锁完整链路（隔离环境内自建、测完自回收） ----------
    await openSettings('security')
    await sleep(600)
    const securityStart = await cdp.eval(`return {state:(document.querySelector('[data-test="security-state"]')?.textContent||'').replace(/\\s+/g,' ').trim(), enabled:document.querySelector('[data-test="security-state"]')?.dataset.enabled, idle:document.querySelector('[data-test="security-idle"]')?.value, setForm:!!document.querySelector('[data-test="security-set-submit"]'), lockBtn:!!document.querySelector('[data-test="security-lock-now"]')}`)
    check('安全页加载应用锁状态（初始未设置主密码、空闲锁定关闭）', securityStart.enabled === '0' && /未设置主密码/.test(securityStart.state) && securityStart.idle === '0' && securityStart.setForm === true && securityStart.lockBtn === false, JSON.stringify(securityStart))

    await setInput('[data-test="security-new-pw"]', 'settings-master-1')
    await setInput('[data-test="security-confirm-pw"]', 'settings-master-1')
    await clickAndWait('[data-test="security-set-submit"]')
    const securitySet = await cdp.eval(`return {enabled:(await window.shopilot.security.status()).data?.enabled, stateEnabled:document.querySelector('[data-test="security-state"]')?.dataset.enabled, lockBtn:!!document.querySelector('[data-test="security-lock-now"]'), changeToggle:!!document.querySelector('[data-test="security-change-toggle"]'), msg:(document.querySelector('[data-test="security-msg"]')?.textContent||'').replace(/\\s+/g,' ').trim()}`)
    check('安全页设置主密码：状态切换为已启用并出现锁定/管理入口', securitySet.enabled === true && securitySet.stateEnabled === '1' && securitySet.lockBtn && securitySet.changeToggle && /已设置/.test(securitySet.msg), JSON.stringify(securitySet))

    await cdp.eval(`const s=document.querySelector('[data-test="security-idle"]'); s.value='15'; s.dispatchEvent(new Event('change',{bubbles:true})); await new Promise(r=>setTimeout(r,700)); return true`)
    const idleSaved = await cdp.eval(`return {stored:(await window.shopilot.settings.get('security.idleMinutes')).data?.value, msg:(document.querySelector('[data-test="security-msg"]')?.textContent||'').replace(/\\s+/g,' ').trim()}`)
    check('安全页空闲自动锁定可保存（15 分钟写入 security.idleMinutes）', idleSaved.stored === 15 && /15 分钟/.test(idleSaved.msg), JSON.stringify(idleSaved))
    await cdp.eval(`const s=document.querySelector('[data-test="security-idle"]'); s.value='0'; s.dispatchEvent(new Event('change',{bubbles:true})); await new Promise(r=>setTimeout(r,700)); return true`)
    check('安全页空闲自动锁定可还原为关闭', (await cdp.eval(`return (await window.shopilot.settings.get('security.idleMinutes')).data?.value`)) === 0)

    await clickAndWait('[data-test="security-change-toggle"]', '[data-test="security-change-panel"]')
    const wrongOld = await cdp.eval(`
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      const set=(sel,v)=>{const el=document.querySelector(sel); setter.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}));};
      set('[data-test="security-old-pw"]','wrong-old');
      set('[data-test="security-change-pw"]','settings-master-2');
      set('[data-test="security-change-confirm"]','settings-master-2');
      await new Promise(r=>setTimeout(r,150));
      document.querySelector('[data-test="security-change-submit"]')?.click();
      await new Promise(r=>setTimeout(r,750));
      return {msg:(document.querySelector('[data-test="security-msg"]')?.textContent||'').replace(/\\s+/g,' ').trim(), enabled:(await window.shopilot.security.status()).data?.enabled}
    `)
    check('安全页更换主密码：旧密码错误时如实失败且原密码仍有效', wrongOld.enabled === true && /旧密码不正确/.test(wrongOld.msg), JSON.stringify(wrongOld))
    await cdp.eval(`
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      const set=(sel,v)=>{const el=document.querySelector(sel); setter.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}));};
      set('[data-test="security-old-pw"]','settings-master-1');
      set('[data-test="security-change-pw"]','settings-master-2');
      set('[data-test="security-change-confirm"]','settings-master-2');
      await new Promise(r=>setTimeout(r,150));
      document.querySelector('[data-test="security-change-submit"]')?.click();
      await new Promise(r=>setTimeout(r,850));
      return true
    `)
    const changedPw = await cdp.eval(`return {enabled:(await window.shopilot.security.status()).data?.enabled, msg:(document.querySelector('[data-test="security-msg"]')?.textContent||'').replace(/\\s+/g,' ').trim(), panel:!!document.querySelector('[data-test="security-change-panel"]')}`)
    check('安全页更换主密码：旧密码正确时更新成功并收起面板', changedPw.enabled === true && /已更新/.test(changedPw.msg) && changedPw.panel === false, JSON.stringify(changedPw))

    await clickAndWait('[data-test="security-remove-toggle"]', '[data-test="security-remove-panel"]')
    const removeWrong = await cdp.eval(`
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      const el=document.querySelector('[data-test="security-remove-pw"]'); setter.call(el,'settings-master-1'); el.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,150));
      document.querySelector('[data-test="security-remove-submit"]')?.click();
      await new Promise(r=>setTimeout(r,750));
      return {msg:(document.querySelector('[data-test="security-msg"]')?.textContent||'').replace(/\\s+/g,' ').trim(), enabled:(await window.shopilot.security.status()).data?.enabled}
    `)
    check('安全页移除主密码：旧密码已被更换失效，如实拒绝', removeWrong.enabled === true && /不正确/.test(removeWrong.msg), JSON.stringify(removeWrong))
    await cdp.eval(`
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      const el=document.querySelector('[data-test="security-remove-pw"]'); setter.call(el,'settings-master-2'); el.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,150));
      document.querySelector('[data-test="security-remove-submit"]')?.click();
      await new Promise(r=>setTimeout(r,850));
      return true
    `)
    const removedPw = await cdp.eval(`return {enabled:(await window.shopilot.security.status()).data?.enabled, stateEnabled:document.querySelector('[data-test="security-state"]')?.dataset.enabled, setForm:!!document.querySelector('[data-test="security-set-submit"]')}`)
    check('安全页移除主密码：新密码验证通过后解除应用锁并回到未设置状态', removedPw.enabled === false && removedPw.stateEnabled === '0' && removedPw.setForm === true, JSON.stringify(removedPw))

    // ---------- 数据与维护页签：采集开关 / 备份恢复 / 内存快照 ----------
    await openSettings('maintenance')
    await sleep(800)
    const maintenanceStart = await cdp.eval(`return {switch:document.querySelector('[data-test="maintenance-auto-collect"]')?.checked, state:(document.querySelector('[data-test="maintenance-auto-collect-state"]')?.textContent||'').trim(), backup:!!document.querySelector('[data-test="maintenance-backup-create"]'), diag:!!document.querySelector('[data-test="maintenance-diagnostics-export"]'), audit:!!document.querySelector('[data-test="maintenance-audit-export"]'), memory:!!document.querySelector('[data-test="maintenance-memory"]'), diagEnabled:!document.querySelector('[data-test="maintenance-diagnostics-export"]')?.disabled}`)
    check('数据与维护页加载采集开关与维护入口（默认关闭）', maintenanceStart.switch === false && /已关闭/.test(maintenanceStart.state) && maintenanceStart.backup && maintenanceStart.diag && maintenanceStart.audit && maintenanceStart.memory && maintenanceStart.diagEnabled, JSON.stringify(maintenanceStart))

    await cdp.eval(`document.querySelector('[data-test="maintenance-auto-collect"]')?.click(); await new Promise(r=>setTimeout(r,750)); return true`)
    const collectOn = await cdp.eval(`return {stored:(await window.shopilot.settings.get('collection.autoEnabled')).data?.value, state:(document.querySelector('[data-test="maintenance-auto-collect-state"]')?.textContent||'').trim()}`)
    check('采集总开关开启并持久化（collection.autoEnabled=true）', collectOn.stored === true && /已开启/.test(collectOn.state), JSON.stringify(collectOn))
    await cdp.eval(`document.querySelector('[data-test="maintenance-auto-collect"]')?.click(); await new Promise(r=>setTimeout(r,750)); return true`)
    const collectOff = await cdp.eval(`return {stored:(await window.shopilot.settings.get('collection.autoEnabled')).data?.value, state:(document.querySelector('[data-test="maintenance-auto-collect-state"]')?.textContent||'').trim()}`)
    check('采集总开关关闭并持久化（collection.autoEnabled=false，fail-closed）', collectOff.stored === false && /已关闭/.test(collectOff.state), JSON.stringify(collectOff))

    await cdp.eval(`document.querySelector('[data-test="maintenance-backup-create"]')?.click(); return true`)
    let backupMade = null
    for (let i = 0; i < 10; i++) {
      await sleep(700)
      backupMade = await cdp.eval(`return {count:((await window.shopilot.backup.list()).data||[]).length, rows:document.querySelectorAll('[data-test="maintenance-backup-row"]').length}`)
      if (backupMade.count >= 1 && backupMade.rows >= 1) break
    }
    check('立即备份：创建备份记录并显示在最近备份列表', backupMade?.count >= 1 && backupMade?.rows >= 1, JSON.stringify(backupMade))

    await clickAndWait('[data-test="maintenance-memory"]')
    const memoryShown = await cdp.eval(`return (document.querySelector('[data-test="maintenance-memory-result"]')?.textContent||'').replace(/\\s+/g,' ').trim()`)
    check('内存快照可读取并如实显示（含内存与店铺/标签计数）', /内存/.test(memoryShown) && memoryShown.includes('店铺') && memoryShown.includes('WebContents'), memoryShown)

    // 恢复：真实执行（隔离库内，备份=当前状态副本）；恢复前自动快照 → 备份列表 +1 且应用保持可用
    await cdp.eval(`window.confirm=()=>true; document.querySelector('[data-test^="maintenance-restore"]')?.click(); return true`)
    let restored = null
    for (let i = 0; i < 15; i++) {
      await sleep(900)
      restored = await cdp.eval(`const list=await window.shopilot.backup.list(); const stores=await window.shopilot.store.list(); return {count:(list.data||[]).length, storeListOk:stores.ok===true, msg:(document.querySelector('[data-test="maintenance-msg"]')?.textContent||'').replace(/\\s+/g,' ').trim()}`)
      if (/已恢复备份/.test(restored.msg)) break
    }
    check('恢复备份：创建安全快照（列表 +1）且应用保持可用', restored?.count >= 2 && restored?.storeListOk === true && /已恢复备份/.test(restored?.msg || ''), JSON.stringify(restored))

    const tabs = ['entry', 'ai', 'security', 'maintenance', 'about']
    const overflows = []
    for (const tab of tabs) {
      await openSettings(tab)
      overflows.push(await cdp.eval(`const e=document.querySelector('.settings-content'); const p=document.querySelector('[data-test="settings-dialog"]'); return {tab:${JSON.stringify(tab)}, content:e?e.scrollWidth>e.clientWidth+1:true, modal:p?p.scrollWidth>p.clientWidth+1:true, doc:document.documentElement.scrollWidth>document.documentElement.clientWidth+1}`))
    }
    check('五个设置页签无横向溢出', overflows.every(x => !x.content && !x.modal && !x.doc), JSON.stringify(overflows))

    const report = { status: checks.every(x => x.ok) ? 'passed' : 'failed', checks, fixture: fixture.stats(), finishedAt: new Date().toISOString() }
    fs.mkdirSync(path.join(ROOT, 'artifacts', 'settings'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, 'artifacts', 'settings', 'settings-cdp-report.json'), JSON.stringify(report, null, 2))
    console.log(`\n设置中心验收结果：${checks.filter(x => x.ok).length}/${checks.length} 通过`)
    process.exitCode = report.status === 'passed' ? 0 : 1
  } catch (error) {
    console.error('SETTINGS_CDP_FAILURE', error?.stack || error)
    process.exitCode = 1
  } finally {
    cdp?.close()
    killTree(app)
    try { fixture?.server.close() } catch {}
    await sleep(500)
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }) } catch {}
  }
  if (checks.some(x => !x.ok) && appLog) console.log('--- Electron log tail ---\n' + appLog.slice(-3000))
}

main()
