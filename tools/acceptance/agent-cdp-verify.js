/* Visible Electron acceptance for the Agent's plain text conversation mode.
 * The runner supplies a throwaway profile and local model endpoint. */
const http = require('http')
const PORT = process.env.SHOPPILOT_CDP_PORT || '9226'
const BASE = `http://127.0.0.1:${PORT}`

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data)
      if (message.id == null) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    }
  }
  async eval(body) {
    await this.ready
    const id = ++this.id
    const result = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true } }))
    })
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
  let cdp, server, lastModelRequest = null, modelRequestCount = 0
  try {
    server = http.createServer((req, res) => {
      if (req.method === 'POST' && String(req.url).includes('/v1/chat/completions')) {
        let body = ''
        req.setEncoding('utf8')
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          modelRequestCount += 1
          try { lastModelRequest = JSON.parse(body) } catch { lastModelRequest = null }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ model: 'plain-chat-fixture', choices: [{ message: { content: '你好，我可以陪你讨论问题，也可以帮你整理思路。' } }], usage: { prompt_tokens: 5, completion_tokens: 12 } }))
        })
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const targets = await (await fetch(`${BASE}/json`)).json()
    const target = targets.find(item => item.type === 'page' && (item.url.includes('index.html') || item.url.startsWith('file:')))
    if (!target) throw new Error('ShopPilot renderer target not found')
    cdp = new CDP(target.webSocketDebuggerUrl)
    const api = await cdp.eval('return {agent:Object.keys(window.shopilot?.agent||{}).sort(),settings:Object.keys(window.shopilot?.agentSettings||{}).sort(),domain:typeof window.shopilot?.agentDomain,task:{create:typeof window.shopilot?.task?.create,run:typeof window.shopilot?.task?.run}}')
    check('Agent Preload 仅暴露对话与 UI 状态接口', api.agent.join(',') === 'chat,uiGet,uiSet' && api.domain === 'undefined', JSON.stringify(api))
    check('原工作台任务接口保持独立可用', api.task.create === 'function' && api.task.run === 'function', JSON.stringify(api.task))

    const drawer = await cdp.eval(`document.querySelector('.agent-orb')?.click(); await new Promise(r=>setTimeout(r,250)); return {open:!!document.querySelector('[data-test="agent-floating-drawer"]'),mode:document.querySelector('[data-test="agent-chat-only"]')?.textContent?.trim()||'',operationButtons:document.querySelectorAll('.agent-shortcuts button, .agent-plan-card button, .agent-software-plan-card button').length, composer:document.querySelector('.agent-composer textarea')?.getAttribute('placeholder')||''}`)
    check('对话面板没有软件、页面、任务操作入口', drawer.open && drawer.mode.includes('纯对话模式') && drawer.operationButtons === 0 && drawer.composer.includes('想聊'), JSON.stringify(drawer))

    const settings = await cdp.eval(`const button=[...document.querySelectorAll('.dashboard-nav-item')].find(node=>node.textContent?.includes('设置')); button?.click(); await new Promise(r=>setTimeout(r,300)); return {page:!!document.querySelector('[data-test="unified-settings-page"]'),tabs:[...document.querySelectorAll('.settings-nav button')].map(node=>node.textContent?.trim())}`)
    check('设置仅保留 Agent 模型入口', settings.page && settings.tabs.some(label => label.includes('Agent 模型')) && !settings.tabs.some(label => label.includes('技能') || label.includes('插件')), JSON.stringify(settings))
    const models = await cdp.eval(`const button=[...document.querySelectorAll('.settings-nav button')].find(node=>node.textContent?.includes('Agent 模型')); button?.click(); await new Promise(r=>setTimeout(r,250)); return {panel:!!document.querySelector('[data-agent-panel="models"]'), tabs:[...document.querySelectorAll('[data-test="agent-admin-panel"] .admin-tab')].map(node=>node.textContent?.trim()), jobPanel:!!document.querySelector('[data-test="agent-job-panel"]')}`)
    check('Agent 设置只保留模型配置', models.panel && models.tabs.length === 0 && !models.jobPanel, JSON.stringify(models))

    const config = await cdp.eval(`return await window.shopilot.ai.configSet({endpoint:${JSON.stringify(`http://127.0.0.1:${server.address().port}/v1`)},model:'single-agent-fixture',timeoutMs:5000})`)
    const key = await cdp.eval(`return await window.shopilot.ai.setKey('single-agent-test-key')`)
    const chat = config.ok && key.ok ? await cdp.eval(`return await window.shopilot.agent.chat('你好，请介绍一下你自己', [])`) : null
    const requestCheck = lastModelRequest ? (() => {
      const system = lastModelRequest.messages?.find(item => item.role === 'system')?.content || ''
      const user = lastModelRequest.messages?.find(item => item.role === 'user')?.content || ''
      let data = {}
      try { data = JSON.parse(user) } catch {}
      return { noTools: !lastModelRequest.tools && !lastModelRequest.functions, safePrompt: system.includes('普通中文对话助手') && system.includes('没有查看或操作店铺'), userKeys: Object.keys(data), currentMessage: data.currentMessage }
    })() : null
    check('主进程完成纯文本对话且响应不含操作字段', config.ok && key.ok && chat?.ok && chat.data.text.includes('讨论问题') && Object.keys(chat.data).sort().join(',') === 'elapsedMs,model,text', chat?.error?.code || JSON.stringify(chat?.data || {}))
    check('模型请求没有工具目录或软件上下文', requestCheck?.noTools && requestCheck.safePrompt && requestCheck.userKeys.join(',') === 'conversationHistory,currentMessage' && requestCheck.currentMessage.includes('你好'), JSON.stringify(requestCheck))
    const requestsBeforeDeniedCommand = modelRequestCount
    const deniedCommand = await cdp.eval(`return await window.shopilot.agent.chat('帮我查看当前店铺的商品状态', [])`)
    check('直接软件操作请求在 Main 端拦截且不会转发给模型', deniedCommand?.ok && deniedCommand.data.text.includes('只提供文字对话') && modelRequestCount === requestsBeforeDeniedCommand, JSON.stringify({ response: deniedCommand?.data?.text, requestCount: modelRequestCount }))
    check('Agent Job 执行 API 不在 Renderer bridge 上', api.domain === 'undefined' && !Object.keys(api.settings).some(key => /job|memory|skill|plugin/i.test(key)), JSON.stringify({ domain: api.domain, settings: api.settings }))
    check('AI Key 不进入 Renderer DOM', !await cdp.eval('return document.documentElement.outerHTML.includes("single-agent-test-key")'))
    await cdp.eval('return await window.shopilot.ai.clearKey()').catch(() => null)
    const report = { status: results.every(item => item.passed) ? 'passed' : 'failed', checks: results, finishedAt: new Date().toISOString(), note: 'root-ceo-only visible Electron/CDP acceptance' }
    require('fs').mkdirSync(require('path').join(__dirname, '../../artifacts/agent'), { recursive: true })
    require('fs').writeFileSync(require('path').join(__dirname, '../../artifacts/agent/visible-cdp-report.json'), JSON.stringify(report, null, 2))
    process.exitCode = report.status === 'passed' ? 0 : 1
  } catch (error) {
    console.error('AGENT_CDP_FAILURE', error?.stack || error)
    process.exitCode = 1
  } finally {
    cdp?.close()
    if (server) await new Promise(resolve => server.close(resolve))
  }
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1 })
