/**
 * AI 商品分析「成功路径」端到端验收（本地 OpenAI 兼容桩）—— 2026-10-18
 *
 * 为什么需要它：`ai:imageText:analyze` 此前只被验过「未配置 → 如实报错」这条路径
 * （见 `renderer-entries-cdp-verify.js` 第 2 节）。**配置好了能用**这条主路径从没有
 * 自动化证据——而它恰恰是设置中心那个「生图文本 API」配置块存在的唯一理由。
 *
 * 做法：起一个只监听 127.0.0.1 的本地 OpenAI 兼容桩（本次进程内，用完即关），
 * 通过渲染层能调到的配置接口把「生图文本 API」指向它，然后走真实用户路径
 * （经营总览 → 快捷操作「AI 生成商品图」→ 图片工作台 → 填商品名 → ✦ AI 分析商品），
 * 断言：桩真的收到了请求、界面没有 error、提示词框被写入了桩的哨兵文案、note 如实报读图 0 张。
 *
 * 零费用：桩是本机 http 服务，不发任何外网请求，不需要真实 API Key。
 *
 * 反向验证（证明断言不是恒真）：
 *   SHOPILOT_ANALYSIS_NEGATIVE=1 node tools/acceptance/image-analysis-cdp-verify.js
 * 该模式下**不启动桩**（endpoint 指向一个没人监听的端口），四条断言必须全部转红、exit 1。
 *
 * 前置：打包产物（release/win-unpacked/ShopPilot.exe）或 SHOPILOT_ACCEPTANCE_SOURCE=1 走源码 Electron。
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')
const { resolveApp, appArgs, childEnv } = require('./app-launch')
const { waitForMainWindow, createChecker, sleep } = require('./cdp-client')

const ROOT = path.resolve(__dirname, '../..')
const CDP_PORT = Number(process.env.SHOPILOT_ANALYSIS_CDP_PORT || 9394)
const STUB_PORT = Number(process.env.SHOPILOT_ANALYSIS_STUB_PORT || 9392)
/** 反向验证模式：不启动桩，endpoint 指向没人监听的端口，断言必须转红 */
const NEGATIVE = process.env.SHOPILOT_ANALYSIS_NEGATIVE === '1'

/** 哨兵文案：能被正则唯一识别，且不会出现在应用的任何静态文案里 */
const SENTINEL = '【桩】卖点：可折叠；场景：露营；人群：通勤'
const STUB_MODEL = 'stub-chat'
/** `ai:imageText:key:set` 要求长度 ≥ 8，否则判 AI_BAD_INPUT */
const STUB_KEY = 'stub-key-not-a-real-credential'
const PRODUCT_NAME = '桩验收-便携折叠露营椅'
/** 配置里填**基础地址**：主进程 normalizeAiEndpoint 会补成 <ENDPOINT>/chat/completions */
const ENDPOINT = `http://127.0.0.1:${STUB_PORT}/v1`
const CHAT_PATH = '/v1/chat/completions'
/** 图片工作台在两处都会出现的锚点 */
const PAGE = '[data-test="unified-image-studio-page"]'

/**
 * 本地 OpenAI 兼容桩。
 *   POST <任意前缀>/chat/completions → OpenAI 兼容响应，content 为哨兵文案
 *   GET  <任意前缀>/models           → { data: [{ id: 'stub-chat' }] }
 * 每次命中都记录 method/url/model/messages/authorization，供断言与报告打印——防止
 * 「界面绿了但其实根本没发请求」这种假通过。
 */
function startStub() {
  const received = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const url = String(req.url || '')
      if (req.method === 'POST' && /\/chat\/completions$/.test(url)) {
        let parsed = null
        try { parsed = JSON.parse(body) } catch { parsed = null }
        received.push({
          method: req.method,
          url,
          model: parsed?.model ?? null,
          messages: Array.isArray(parsed?.messages) ? parsed.messages : [],
          maxTokens: parsed?.max_tokens ?? null,
          stream: parsed?.stream ?? null,
          authorization: String(req.headers.authorization || ''),
          contentType: String(req.headers['content-type'] || ''),
          bytes: Buffer.byteLength(body, 'utf8')
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'chatcmpl-stub',
          object: 'chat.completion',
          model: STUB_MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: SENTINEL }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 31, completion_tokens: 17, total_tokens: 48 }
        }))
        return
      }
      if (req.method === 'GET' && /\/models$/.test(url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: STUB_MODEL, object: 'model' }] }))
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'stub: unexpected request ' + req.method + ' ' + url } }))
    })
  })
  return { server, received }
}

/** 请求摘要：只打印"证明它来自被测应用"的字段，不打印 Authorization 的具体值 */
function describeRequest(entry) {
  const messages = (entry.messages || []).map(message => {
    const content = typeof message?.content === 'string'
      ? message.content
      : JSON.stringify(message?.content ?? null)
    return `${message?.role || '?'}: ${String(content).replace(/\s+/g, ' ').slice(0, 160)}`
  })
  return [
    `  ${entry.method} ${entry.url}  model=${entry.model}  max_tokens=${entry.maxTokens}  stream=${entry.stream}  bytes=${entry.bytes}`,
    `    auth=${entry.authorization ? entry.authorization.replace(/^(Bearer\s+).*/i, '$1<redacted>') : '(none)'}  content-type=${entry.contentType}`,
    ...messages.map(line => `    ${line}`)
  ].join('\n')
}

async function main() {
  const userData = process.env.SHOPILOT_ANALYSIS_USER_DATA || path.join(os.tmpdir(), 'shopilot-analysis-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })

  const { server: stub, received } = startStub()
  let stubAddress = null
  if (!NEGATIVE) {
    await new Promise(resolve => stub.listen(STUB_PORT, '127.0.0.1', resolve))
    stubAddress = stub.address()
  }

  const appInfo = resolveApp(ROOT)
  const acceptanceLog = process.env.SHOPILOT_ANALYSIS_LOG || path.join(userData, 'acceptance-app.log')
  const child = spawn(appInfo.executable, appArgs(ROOT, appInfo, { port: CDP_PORT, userData }), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv({
      NODE_ENV: 'production', ELECTRON_ENABLE_LOGGING: '1',
      SHOPILOT_DISABLE_CDP_FP: '1', SHOPILOT_ACCEPTANCE: '1'
    })
  })
  let appLog = ''
  child.on('exit', code => { appLog += `\n[app exit ${code}]\n` })
  child.stdout.on('data', data => { appLog += data.toString() })
  child.stderr.on('data', data => { appLog += data.toString() })

  const { check, summary } = createChecker()
  let ui = null
  try {
    // 桩只监听回环地址（硬约束）：`0.0.0.0` 会把一个假的 OpenAI 接口暴露到局域网。
    check('本地桩只监听 127.0.0.1（不是 0.0.0.0）',
      NEGATIVE ? true : !!(stubAddress && stubAddress.address === '127.0.0.1' && stubAddress.port === STUB_PORT),
      NEGATIVE ? '反向验证模式：桩未启动' : JSON.stringify(stubAddress))

    ui = await waitForMainWindow(CDP_PORT)
    if (!ui) throw new Error('主窗口 CDP 未就绪')
    await sleep(900)

    // ---------- 0) 把「生图文本 API」指向本地桩并回读确认 ----------
    const configured = await ui.eval(`
      const set = await window.shopilot.ai.imageTextConfigSet({
        endpoint: ${JSON.stringify(ENDPOINT)},
        model: ${JSON.stringify(STUB_MODEL)},
        timeoutMs: 20000
      })
      if (!set.ok) return { ok: false, stage: 'configSet', error: set.error }
      const key = await window.shopilot.ai.setImageTextKey(${JSON.stringify(STUB_KEY)})
      if (!key.ok) return { ok: false, stage: 'keySet', error: key.error }
      const back = await window.shopilot.ai.imageTextConfigGet()
      if (!back.ok) return { ok: false, stage: 'configGet', error: back.error }
      const c = back.data || {}
      return {
        ok: true,
        endpoint: c.imageTextEndpoint ?? null,
        resolved: c.resolvedImageTextEndpoint ?? null,
        model: c.imageTextModel ?? null,
        hasKey: c.hasImageTextKey === true,
        timeoutMs: c.imageTextTimeoutMs ?? null
      }
    `)
    check('生图文本 API 指向本地桩并回读一致（endpoint/model/Key 都对得上）',
      configured.ok === true &&
      configured.endpoint === ENDPOINT &&
      configured.resolved === ENDPOINT + '/chat/completions' &&
      configured.model === STUB_MODEL &&
      configured.hasKey === true,
      JSON.stringify(configured))

    // ---------- 1) 走用户路径进入图片工作台 ----------
    const navTo = label => ui.eval(`
      const item = [...document.querySelectorAll('.dashboard-nav-item')]
        .find(el => (el.textContent || '').includes(${JSON.stringify(label)}))
      if (!item) return false
      item.click()
      await new Promise(r => setTimeout(r, 400))
      return true
    `)
    check('侧栏可以进入「经营总览」', await navTo('经营总览'))

    const entered = await ui.eval(`
      const button = document.querySelector('[data-test="quick-action-btn-image"]')
      if (!button) return { tile: false, studio: false, createTab: false }
      button.click()
      const deadline = Date.now() + 12000
      while (Date.now() < deadline) {
        if (document.querySelector(${JSON.stringify(PAGE)})) break
        await new Promise(r => setTimeout(r, 220))
      }
      const studio = !!document.querySelector(${JSON.stringify(PAGE)})
      let createTab = false
      if (studio) {
        const tab = document.querySelector('[data-test="studio-top-nav-create"]')
        if (tab) { tab.click(); await new Promise(r => setTimeout(r, 200)) }
        createTab = !!document.querySelector('[data-test="studio-top-nav-create"].active')
      }
      return { tile: true, studio, createTab }
    `)
    check('快捷操作「AI 生成商品图」进入图片工作台且停在 create 页签',
      entered.tile === true && entered.studio === true && entered.createTab === true,
      JSON.stringify(entered))

    // ---------- 2) 填商品名 → 点「✦ AI 分析商品」→ 等结果写回 ----------
    const analyze = await ui.eval(`
      const name = document.querySelector('[data-test="product-name"]')
      const prompt = document.querySelector('[data-test="image-prompt"]')
      const button = document.querySelector('[data-test="image-prompt-analyze"]')
      if (!name || !prompt || !button) {
        return { present: false, enabled: null, error: '', note: '', promptValue: '', confirmHandled: false }
      }
      // 清空描述，走"直接分析"这条路径（描述非空时会先弹页内覆盖确认）
      prompt.value = ''
      prompt.dispatchEvent(new Event('input', { bubbles: true }))
      name.value = ${JSON.stringify(PRODUCT_NAME)}
      name.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 250))
      const enabled = button.disabled !== true
      button.click()
      let confirmHandled = false
      await new Promise(r => setTimeout(r, 300))
      const confirm = document.querySelector('[data-test="image-prompt-analyze-confirm"]')
      if (confirm) { confirmHandled = true; confirm.click() }
      const deadline = Date.now() + 25000
      let error = ''
      let note = ''
      while (Date.now() < deadline) {
        error = (document.querySelector('[data-test="image-prompt-analyze-error"]')?.textContent || '').trim()
        note = (document.querySelector('[data-test="image-prompt-analyze-note"]')?.textContent || '').trim()
        if (error || note) break
        await new Promise(r => setTimeout(r, 250))
      }
      // 再给界面一拍把 prompt 写回去（note 与写回同一次同步里完成，这里只是稳妥）
      await new Promise(r => setTimeout(r, 300))
      return {
        present: true,
        enabled,
        confirmHandled,
        error,
        note,
        promptValue: document.querySelector('[data-test="image-prompt"]')?.value || ''
      }
    `)

    check('填了商品名后「✦ AI 分析商品」可点（锚点齐全）',
      analyze.present === true && analyze.enabled === true,
      JSON.stringify({ present: analyze.present, enabled: analyze.enabled }))

    // ---------- 3) 四条核心断言 ----------
    const first = received[0] || null
    const userMessage = first ? (first.messages.find(message => message?.role === 'user') || {}) : {}
    const userText = typeof userMessage.content === 'string' ? userMessage.content : JSON.stringify(userMessage.content ?? '')

    check('a) 桩服务收到 ≥1 次 chat/completions 请求',
      received.length >= 1,
      `收到 ${received.length} 次` + (first ? `；首次 ${first.method} ${first.url}` : ''))

    check('a2) 请求体确实来自被测应用（model/路径/商品名都对得上）',
      !!first &&
      first.model === STUB_MODEL &&
      first.url === CHAT_PATH &&
      userText.includes(PRODUCT_NAME),
      first ? `model=${first.model} url=${first.url} user=${userText.replace(/\s+/g, ' ').slice(0, 120)}` : '(没有请求)')

    check('a3) 请求带 Bearer 鉴权头（Key 真的从 Main 发到了接口）',
      !!first && /^Bearer\s+\S+/.test(first.authorization),
      first ? first.authorization.replace(/^(Bearer\s+).*/, '$1<redacted>') : '(没有请求)')

    check('b) 界面没有出现 [image-prompt-analyze-error]',
      analyze.error === '',
      analyze.error ? `error=${analyze.error}` : '无错误行内提示')

    check('c) 提示词框写回了桩的哨兵文案',
      String(analyze.promptValue).includes(SENTINEL),
      `prompt=${String(analyze.promptValue).replace(/\s+/g, ' ').slice(0, 140)}`)

    check('d) note 如实显示来源与读图张数（本轮无素材图 → 未读图）',
      /生图文本模型/.test(analyze.note) && /本次未读图/.test(analyze.note) && !/读了\s*\d+\s*张/.test(analyze.note),
      `note=${analyze.note}`)

  } finally {
    try { ui?.close() } catch { /* 已断开 */ }
    try { child.kill('SIGTERM') } catch { /* 已退出 */ }
    await sleep(1000)
    // 只杀自己 spawn 的这棵进程树：全局 taskkill /IM ShopPilot.exe 会连根杀掉**并发跑着的
    // 其它验收套件**（它们各自用独立 userData 与端口，本来互不干扰）。全局兜底留在 run-acceptance.ps1。
    if (child.exitCode === null && child.signalCode === null) {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 进程已退出 */ }
      await sleep(500)
    }
    try { fs.writeFileSync(acceptanceLog, appLog, 'utf8') } catch { /* 日志只作证据，失败不影响结论 */ }
    try { stub.close() } catch { /* 桩已关 */ }
  }

  const passed = summary(NEGATIVE
    ? 'AI 商品分析成功路径验收（反向验证模式：桩未启动，预期全红）'
    : 'AI 商品分析成功路径验收')

  console.log('\n--- 本地桩收到的请求 ---')
  if (!received.length) console.log('  (0 次：没有任何请求打到桩上)')
  for (const entry of received) console.log(describeRequest(entry))
  console.log(`  endpoint=${ENDPOINT} → 主进程规范化后请求 ${CHAT_PATH}；桩监听=${NEGATIVE ? '未启动（反向验证）' : `127.0.0.1:${STUB_PORT}`}`)

  if (NEGATIVE) {
    // 反向验证：全红才是"对"的。这里显式说明预期，免得把预期中的红误读成脚本坏了。
    console.log(`\n[反向验证] 预期 exit=1 且四条核心断言全红；实际 checks=${passed ? '全绿（说明断言可能是恒真，需排查）' : '有红（符合预期）'}`)
  }

  if (!passed) {
    console.log(`--- 应用日志（ai:image-text / 异常）---\n${appLog.split('\n').filter(line => /ai|image-?text|analyze|error|crash|AI_/i.test(line)).slice(-25).join('\n')}`)
    process.exit(1)
  }
}

main().catch(error => { console.error('IMAGE_ANALYSIS_VERIFY_CRASH', error); process.exit(2) })
