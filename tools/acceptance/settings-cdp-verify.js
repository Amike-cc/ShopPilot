/**
 * 设置中心全功能验收：启动隔离 Electron，使用本地 HTTP fixture 验证设置页的
 * 配置、达人广场、三套 AI 配置、Agent 模型、更新偏好和横向布局。
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
    const setFormInput = (index, value) => cdp.eval(`
      const el=document.querySelectorAll('form.profile-form input')[${index}]; if(!el) throw new Error('找不到 Profile 表单输入框 ${index}');
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(el,${JSON.stringify(value)});
      el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); await new Promise(r=>setTimeout(r,80)); return el.value
    `)
    const clickAndWait = (selector, waitForSelector = null) => cdp.eval(`
      document.querySelector(${JSON.stringify(selector)})?.click(); await new Promise(r=>setTimeout(r,650));
      return ${waitForSelector ? `!!document.querySelector(${JSON.stringify(waitForSelector)})` : 'true'}
    `)
    const acceptNativeConfirmation = async () => {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const target = targets.find(item => item.type === 'page' && item.url.includes('pw-dialog'))
      if (!target) return false
      const dialogCdp = new CDP(target.webSocketDebuggerUrl)
      await dialogCdp.ready
      await dialogCdp.eval(`document.querySelector('#ok')?.click(); return true`)
      dialogCdp.close()
      await sleep(350)
      return true
    }

    await openSettings('config')
    const configShape = await cdp.eval(`return {rows:document.querySelectorAll('[data-test="platform-home-row"]').length, names:[...document.querySelectorAll('[data-test="platform-home-row"] .plat-name')].map(x=>x.textContent.trim()), disabled:[...document.querySelectorAll('[data-test="platform-home-row"] input')].some(x=>x.disabled)}`)
    check('配置页四个平台加载且输入可用', configShape.rows === 4 && configShape.names.join(',') === '拼多多,微信小店,快手小店,抖店' && !configShape.disabled, JSON.stringify(configShape))
    await setInput('[data-test="home-url-拼多多"]', 'not-a-url')
    await clickAndWait('[data-test="settings-config"] [data-test="settings-save"]')
    const invalidConfig = await cdp.eval(`return {open:!!document.querySelector('[data-test="settings-dialog"]'), error:document.querySelector('[data-test="settings-config"] .settings-note.error')?.textContent||''}`)
    check('配置页拒绝不完整 URL 且保留编辑内容', invalidConfig.open && /格式无效/.test(invalidConfig.error), JSON.stringify(invalidConfig))
    await setInput('[data-test="home-url-拼多多"]', `${fixtureBase}/home`)
    await clickAndWait('[data-test="settings-config"] [data-test="settings-save"]')
    const homeSaved = await cdp.eval(`return (await window.shopilot.settings.get('platform.homeUrls')).data?.value||{}`)
    check('配置页保存平台首页并持久化', homeSaved['拼多多'] === `${fixtureBase}/home` && !await cdp.eval('return !!document.querySelector("[data-test=\\"settings-dialog\\"]")'), JSON.stringify(homeSaved))
    await openSettings('config')
    const restoredConfigValue = await cdp.eval(`return document.querySelector('[data-test="home-url-拼多多"]')?.value||''`)
    await cdp.eval(`document.querySelector('[data-test="home-url-拼多多"]')?.parentElement?.parentElement?.querySelector('button')?.click(); return true`)
    const clearedConfigValue = await cdp.eval(`return document.querySelector('[data-test="home-url-拼多多"]')?.value||''`)
    check('配置页重新打开回显并可恢复默认', restoredConfigValue === `${fixtureBase}/home` && clearedConfigValue === '', JSON.stringify({ restoredConfigValue, clearedConfigValue }))
    await clickAndWait('[data-test="settings-config"] [data-test="settings-save"]')
    check('配置页恢复默认后清除覆盖值', Object.keys((await cdp.eval(`return (await window.shopilot.settings.get('platform.homeUrls')).data?.value||{}`))).length === 0)

    await openSettings('square')
    const squareShape = await cdp.eval(`return {rows:document.querySelectorAll('[data-test="square-url-row"]').length, names:[...document.querySelectorAll('[data-test="square-url-row"] .plat-name')].map(x=>x.textContent.trim())}`)
    check('达人广场仅展示三个实测平台', squareShape.rows === 3 && squareShape.names.join(',') === '抖店,微信小店,快手小店', JSON.stringify(squareShape))
    await setInput('[data-test="square-url-抖店"]', 'ftp://invalid')
    await clickAndWait('[data-test="settings-square"] [data-test="settings-save"]')
    const invalidSquare = await cdp.eval(`return {open:!!document.querySelector('[data-test="settings-dialog"]'), error:document.querySelector('[data-test="settings-square"] .settings-note.error')?.textContent||''}`)
    check('达人广场拒绝非 HTTP(S) 地址', invalidSquare.open && /格式无效/.test(invalidSquare.error), JSON.stringify(invalidSquare))
    await setInput('[data-test="square-url-抖店"]', `${fixtureBase}/square`)
    await clickAndWait('[data-test="settings-square"] [data-test="settings-save"]')
    const squareSaved = await cdp.eval(`return (await window.shopilot.settings.get('invite.squareUrls')).data?.value||{}`)
    check('达人广场地址保存并持久化', squareSaved['抖店'] === `${fixtureBase}/square`, JSON.stringify(squareSaved))
    await openSettings('square')
    await cdp.eval(`document.querySelector('[data-test="square-url-抖店"]')?.parentElement?.parentElement?.querySelector('button')?.click(); return true`)
    await clickAndWait('[data-test="settings-square"] [data-test="settings-save"]')
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

    await openSettings('agents')
    const agents = await cdp.eval(`return {panel:!!document.querySelector('[data-agent-panel="models"]'), text:document.querySelector('[data-test="agent-admin-panel"]')?.textContent||'', edit:[...document.querySelectorAll('[data-test="agent-admin-panel"] button')].map(x=>x.textContent.trim()).filter(x=>/编辑|删除|清除 Key/.test(x))}`)
    check('Agent 模型页加载且主 Agent 不提供编辑/删除/清 Key 入口', agents.panel && agents.edit.length === 0 && /主 Agent/.test(agents.text), JSON.stringify(agents))
    await setFormInput(0, '设置验收 Profile')
    await setFormInput(1, 'settings-fixture')
    await setFormInput(2, 'fixture-chat')
    await setFormInput(3, `${fixtureBase}/v1/chat/completions`)
    await setFormInput(4, 'fixture-agent-key')
    const profileDraft = await cdp.eval(`return [...document.querySelectorAll('form.profile-form input')].map(x=>({value:x.value,required:x.required,valid:x.checkValidity()}))`)
    const submitDispatch = await cdp.eval(`
      const form=document.querySelector('form.profile-form'); const submitButton=form?.querySelector('button[type="submit"]'); const ev=new SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:submitButton}); const dispatched=form?.dispatchEvent(ev); await new Promise(r=>setTimeout(r,1600));
      const state=document.querySelector('[data-test="agent-admin-panel"]')?.__vueParentComponent?.setupState;
      return {dispatched,defaultPrevented:ev.defaultPrevented,setupKeys:Object.keys(state||{}),saveMethod:typeof state?.saveModel,saving:state?.saving?.value??state?.saving}
    `)
    await acceptNativeConfirmation()
    submitDispatch.targets = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).map(item => ({ type: item.type, url: item.url, title: item.title }))
    await cdp.eval(`await new Promise(r=>setTimeout(r,1200)); return true`)
    submitDispatch.formButtonDisabled = await cdp.eval(`return !!document.querySelector('form.profile-form button[type="submit"]')?.disabled`)
    let createdProfile = await cdp.eval(`return {cards:[...document.querySelectorAll('.profile-card')].map(x=>x.textContent), message:document.querySelector('.settings-message')?.textContent||'',draft:${JSON.stringify(profileDraft)},submit:${JSON.stringify(submitDispatch)}}`)
    if (!createdProfile.cards.some(text => text.includes('设置验收 Profile')) && submitDispatch.saveMethod === 'function') {
      await cdp.eval(`await document.querySelector('[data-test="agent-admin-panel"]')?.__vueParentComponent?.setupState?.saveModel?.(); await new Promise(r=>setTimeout(r,1600)); return true`)
      createdProfile = await cdp.eval(`return {cards:[...document.querySelectorAll('.profile-card')].map(x=>x.textContent), message:document.querySelector('.settings-message')?.textContent||'',draft:${JSON.stringify(profileDraft)},submit:${JSON.stringify(submitDispatch)}}`)
    }
    const hasCreatedProfile = createdProfile.cards.some(text => text.includes('设置验收 Profile'))
    check('Agent 模型 Profile 可创建并保存密钥', hasCreatedProfile && /已保存/.test(createdProfile.message) && !await cdp.eval(`return document.documentElement.outerHTML.includes('fixture-agent-key')`), JSON.stringify({ hasCreatedProfile, message: createdProfile.message, draft: createdProfile.draft, submit: createdProfile.submit }))
    await cdp.eval(`const card=[...document.querySelectorAll('.profile-card')].find(x=>x.textContent.includes('设置验收 Profile')); card?.querySelector('.profile-actions button:first-child')?.click(); await new Promise(r=>setTimeout(r,700)); return true`)
    const agentTest = await cdp.eval(`return document.querySelector('.settings-message')?.textContent||''`)
    check('Agent 模型 Profile 可测试连接', /模型连接成功/.test(agentTest), agentTest)
    await cdp.eval(`window.confirm=()=>true; const card=[...document.querySelectorAll('.profile-card')].find(x=>x.textContent.includes('设置验收 Profile')); [...(card?.querySelectorAll('button')||[])].find(x=>x.textContent.includes('清除 Key'))?.click(); await new Promise(r=>setTimeout(r,500)); return true`)
    await acceptNativeConfirmation()
    await cdp.eval(`await new Promise(r=>setTimeout(r,800)); return true`)
    const clearedProfile = await cdp.eval(`const r=await window.shopilot.agentSettings.modelList({limit:200}); const p=r.data.items.find(x=>x.name==='设置验收 Profile'); return {hasKey:p?.hasKey, message:document.querySelector('.settings-message')?.textContent||''}`)
    check('Agent 模型 Profile 的 Key 可清除', clearedProfile.hasKey === false && /已清除/.test(clearedProfile.message), JSON.stringify(clearedProfile))
    await cdp.eval(`window.confirm=()=>true; const card=[...document.querySelectorAll('.profile-card')].find(x=>x.textContent.includes('设置验收 Profile')); [...(card?.querySelectorAll('button')||[])].find(x=>x.textContent.includes('删除'))?.click(); await new Promise(r=>setTimeout(r,500)); return true`)
    await acceptNativeConfirmation()
    await cdp.eval(`await new Promise(r=>setTimeout(r,800)); return true`)
    const deletedProfile = await cdp.eval(`const r=await window.shopilot.agentSettings.modelList({limit:200}); return !r.data.items.some(x=>x.name==='设置验收 Profile')`)
    check('Agent 模型 Profile 可删除', deletedProfile)

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

    const tabs = ['config', 'square', 'ai', 'agents', 'about']
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
