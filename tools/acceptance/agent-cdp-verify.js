/* Visible Agent acceptance for the root-ceo-only architecture.
 * The runner supplies a throwaway Electron profile and CDP port. This script
 * checks the UI, software context and a local model chat without creating a
 * child Agent or asserting any multi-agent workflow.
 */
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
  let cdp, server
  try {
    server = http.createServer((req, res) => {
      if (req.method === 'POST' && String(req.url).includes('/v1/chat/completions')) {
        req.resume()
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ model: 'single-agent-fixture', choices: [{ message: { content: '你好，我是 root-ceo 主 Agent，会直接负责规划、执行和审核。' } }], usage: { prompt_tokens: 5, completion_tokens: 12 } }))
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
    check('Preload 暴露 root-ceo Agent API', await cdp.eval('return !!window.shopilot?.agent && !!window.shopilot?.agentDomain'))

    const org = await cdp.eval('return await window.shopilot.agentDomain.orgList({limit:200})')
    const agents = org.ok ? org.data.items || [] : []
    check('Agent 设置只展示 root-ceo', org.ok && agents.length === 1 && agents[0]?.id === 'root-ceo', JSON.stringify(agents.map(item => item.id)))
    const context = await cdp.eval('return await window.shopilot.agent.softwareContext()')
    check('软件上下文只含一个执行主体', context.ok && context.data.agents?.length === 1 && context.data.agents[0].id === 'root-ceo', JSON.stringify(context.data?.agents || []))

    const settings = await cdp.eval(`const button=[...document.querySelectorAll('.dashboard-nav-item')].find(node=>node.textContent?.includes('设置')); button?.click(); await new Promise(r=>setTimeout(r,300)); return {page:!!document.querySelector('[data-test="unified-settings-page"]'),tabs:[...document.querySelectorAll('.settings-nav button')].map(node=>node.textContent?.trim())}`)
    check('设置导航使用 Agent 设置名称', settings.page && settings.tabs.some(label => label.includes('Agent 设置')) && !settings.tabs.some(label => label.includes('Agent 团队')), JSON.stringify(settings))
    const team = await cdp.eval(`const button=[...document.querySelectorAll('.settings-nav button')].find(node=>node.textContent?.includes('Agent')); button?.click(); await new Promise(r=>setTimeout(r,250)); return {root:!!document.querySelector('[data-test="agent-card-root-ceo"]'), text:document.querySelector('[data-test="agent-org-panel"]')?.innerText||'', cards:document.querySelectorAll('[data-test^="agent-card-"]').length}`)
    check('Agent 设置卡片只渲染 root-ceo', team.root && team.cards === 1 && team.text.includes('不创建子 Agent'), JSON.stringify(team))

    const config = await cdp.eval(`return await window.shopilot.ai.configSet({endpoint:${JSON.stringify(`http://127.0.0.1:${server.address().port}/v1`)},model:'single-agent-fixture',timeoutMs:5000})`)
    const key = await cdp.eval(`return await window.shopilot.ai.setKey('single-agent-test-key')`)
    const chat = config.ok && key.ok ? await cdp.eval(`return await window.shopilot.agent.generatePlan('你好，请介绍你的执行边界')`) : null
    check('root-ceo 可直接完成对话回合', config.ok && key.ok && chat?.ok && chat.data.kind === 'chat' && String(chat.data.text).includes('root-ceo'), chat?.error?.code || JSON.stringify(chat?.data || {}))
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
