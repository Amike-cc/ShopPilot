/**
 * 工作台「批量发布」入口一致性验收（2026-10-17）
 *
 * 背景：商品管理已落地发布预检 / 批量编排 / 人工确认，但工作台快捷操作与 AI 创作页
 * 仍把「批量发布商品」标成「待接入」「尚无发布页面或发布 API」——功能可用却对用户
 * 宣称不可用。本套件锁住三件事：
 *   1) 工作台快捷操作「批量发布商品」可点击且跳到商品管理页；
 *   2) AI 创作页的发布卡片是真实入口（不是「暂不可用」）；
 *   3) AI 助手文案如实描述「纯文本、不读取/操作店铺与软件数据」。
 *
 * 前置：应用以 `--remote-debugging-port=9250` 启动（SHOPILOT_CDP_PORT 可覆盖）。
 */
const CDP_PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function listTargets() {
  const res = await fetch(CDP_BASE + '/json')
  return res.json()
}

async function getPageWs(predicate) {
  for (let i = 0; i < 40; i++) {
    try {
      const targets = await listTargets()
      const page = targets.find(t => (t.type === 'page' || t.type === 'webview') && t.webSocketDebuggerUrl && predicate(t.url))
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  throw new Error('未找到满足条件的页面 target')
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
    this.ws.onmessage = evt => {
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
  async evaluate(fnBody, timeoutMs = 30000) {
    await this.ready
    const expression = `(async () => { ${fnBody} })()`
    let timer = null
    try {
      const r = await Promise.race([
        this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
        new Promise((_res, rej) => {
          timer = setTimeout(() => rej(new Error(`页面求值超时（${timeoutMs}ms）：${String(fnBody).replace(/\s+/g, ' ').trim().slice(0, 120)}`)), timeoutMs)
        })
      ])
      if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
      return r.result.value
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  close() { try { this.ws.close() } catch {} }
}

const checks = []
function check(name, pass, detail = '') {
  checks.push({ name, pass: !!pass, detail })
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? '  [' + detail + ']' : ''}`)
}
const UI_WAIT = 350

async function main() {
  const wsUrl = await getPageWs(u => u.startsWith('file:') && u.includes('index.html'))
  const cdp = new CDPSession(wsUrl)
  await cdp.ready
  await sleep(800)

  const nav = label => cdp.evaluate(`
    const btn = [...document.querySelectorAll('.dashboard-nav-item')].find(b => (b.textContent || '').trim().includes(${JSON.stringify(label)}))
    if (!btn) return false
    btn.click()
    return true
  `)

  try {
    let ready = false
    for (let i = 0; i < 40; i++) {
      ready = await cdp.evaluate(`
        return [...document.querySelectorAll('.dashboard-nav-item')].some(b => (b.textContent || '').includes('经营总览')) &&
          !!document.querySelector('[data-test="quick-action-publish"]')
      `).catch(() => false)
      if (ready) break
      await sleep(500)
    }
    check('工作台就绪（导航 + 快捷操作区）', ready)
    if (!ready) throw new Error('工作台 20 秒内未就绪')

    // 1) 快捷操作：批量发布商品是可点击入口
    const tile = await cdp.evaluate(`
      const el = document.querySelector('[data-test="quick-action-publish"]')
      if (!el) return null
      const btn = el.querySelector('[data-test="quick-action-btn-publish"]')
      return {
        text: (el.innerText || '').replace(/\\s+/g, ' ').trim(),
        disabled: btn ? btn.disabled : null,
        label: btn ? (btn.innerText || '').replace(/\\s+/g, ' ').trim() : null,
        unavailable: /待接入|暂不可用/.test(el.innerText || '')
      }
    `)
    check('快捷操作「批量发布商品」可点击（不再显示待接入）',
      !!tile && tile.disabled === false && /去发布/.test(tile.label || '') && tile.unavailable === false,
      JSON.stringify(tile))

    await cdp.evaluate(`document.querySelector('[data-test="quick-action-btn-publish"]').click(); return true`)
    await sleep(UI_WAIT + 300)
    const landed = await cdp.evaluate(`return { page: !!document.querySelector('[data-test="unified-products-page"]'), title: document.querySelector('.dashboard-page-title')?.textContent || '' }`)
    check('点击快捷操作 → 商品管理页', landed.page === true, JSON.stringify(landed))

    // 2) AI 创作页：发布卡片是真实入口；助手文案如实（纯文本）
    await nav('AI 创作')
    await sleep(UI_WAIT + 250)
    const ai = await cdp.evaluate(`
      const page = document.querySelector('[data-test="unified-ai-page"]')
      const card = document.querySelector('[data-test="app-publish"]')
      const copy = document.querySelector('[data-test="ai-assistant-copy"]')?.innerText.replace(/\\s+/g, ' ').trim() || ''
      return {
        page: !!page,
        card: !!card,
        actionable: !!card && card.classList.contains('app-card-action') && !/暂不可用|待接入/.test(card.innerText || ''),
        desc: card ? card.innerText.replace(/\\s+/g, ' ').trim() : '',
        copy
      }
    `)
    check('AI 创作页渲染', ai.page === true)
    check('「批量发布商品」卡片是真实入口（非暂不可用）', ai.card && ai.actionable, JSON.stringify({ card: ai.card, actionable: ai.actionable, desc: (ai.desc || '').slice(0, 80) }))
    check('AI 助手文案如实：纯文本、不读取/操作店铺与软件数据',
      /纯文本/.test(ai.copy) && /不会读取或操作/.test(ai.copy) && !/写入操作.*确认/.test(ai.copy),
      ai.copy.slice(0, 120))

    await cdp.evaluate(`document.querySelector('[data-test="app-publish"]').click(); return true`)
    await sleep(UI_WAIT + 300)
    const fromCard = await cdp.evaluate(`return !!document.querySelector('[data-test="unified-products-page"]')`)
    check('点击 AI 创作页发布卡片 → 商品管理页', fromCard === true)

    // 3) 应用中心：设置卡片文案不再宣称已移除的 Agent/技能/插件
    await nav('应用中心')
    await sleep(UI_WAIT + 250)
    const apps = await cdp.evaluate(`
      const page = document.querySelector('[data-test="unified-apps-page"]')
      const text = page ? page.innerText : ''
      return { page: !!page, staleSettings: /Agent.*技能|技能.*插件/.test(text), hasPublish: /批量发布商品/.test(text) }
    `)
    check('应用中心渲染且不再出现已移除的 Agent/技能/插件描述', apps.page === true && apps.staleSettings === false, JSON.stringify(apps))

    // 4) 通知中心：不再是一句「暂未接入独立页面」；空状态如实说明来源，Esc 可关闭
    await nav('经营总览')
    await sleep(UI_WAIT + 250)
    await cdp.evaluate(`document.querySelector('[data-test="notification-bell"]').click(); return true`)
    await sleep(UI_WAIT)
    const panel = await cdp.evaluate(`
      const el = document.querySelector('[data-test="notification-center"]')
      return {
        open: !!el,
        empty: !!document.querySelector('[data-test="notification-empty"]'),
        emptyText: document.querySelector('[data-test="notification-empty"]')?.textContent || '',
        items: document.querySelectorAll('[data-test^="notification-item-"]').length
      }
    `)
    check('通知中心可打开（无通知时如实显示空状态）', panel.open === true && panel.empty === true && panel.items === 0 && /暂无通知/.test(panel.emptyText), JSON.stringify(panel))

    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true`)
    await sleep(UI_WAIT)
    const closed = await cdp.evaluate(`return !document.querySelector('[data-test="notification-center"]')`)
    check('通知中心 Esc 可关闭', closed === true)
  } finally {
    cdp.close()
  }

  const passed = checks.filter(c => c.pass).length
  console.log(`\n==== 工作台入口一致性验收：${passed}/${checks.length} 通过 ====`)
  if (passed !== checks.length) {
    console.log('失败项：')
    for (const c of checks.filter(c => !c.pass)) console.log(`  ✗ ${c.name} ${c.detail || ''}`)
    process.exit(1)
  }
}

main().catch(err => { console.error('VERIFY_CRASH', err); process.exit(2) })
