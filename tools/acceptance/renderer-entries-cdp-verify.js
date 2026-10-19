/**
 * 渲染层补齐入口验收 —— 2026-10-18
 *
 * 覆盖本轮补齐的「后端/IPC/类型都齐、渲染层没有入口」缺口里两个可离线验收的项：
 *   1) 店铺分组：卡片「分组」按钮 → 页内浮层 → 保存 → 主进程 store.list 真的落库 → 清除归零
 *      （修复前 `store:setGroup` 有 handler/preload/类型，渲染层零调用，分组只能看不能设）
 *   2) AI 商品分析：AI 创作页「✦ AI 分析商品」→ `ai.analyzeImageProduct`；未配置文本 API 时
 *      必须**行内**如实报中文错误（不是 alert / 不是静默失败），且按钮只在有素材来源时可点
 *      （修复前设置中心可配 Key、主进程有实现，但渲染层零调用，配置空转）
 *
 * 不在本脚本内：平台商品「解除归并」需要先有 platform link 数据（要真平台同步或造库），
 * 其入口由 `tests/unit/product-link-actions.test.ts` 的接线守卫 + vue-tsc 覆盖。
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
const PORT = Number(process.env.SHOPILOT_ENTRIES_CDP_PORT || 9390)
const SITE = Number(process.env.SHOPILOT_ENTRIES_SITE_PORT || 9391)
const STORE_NAME = '入口验收店铺'
const GROUP_NAME = '入口验收分组'

async function main() {
  const userData = process.env.SHOPILOT_ENTRIES_USER_DATA || path.join(os.tmpdir(), 'shopilot-entries-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })

  const site = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><body><h1>entries fixture</h1></body></html>')
  })
  await new Promise(resolve => site.listen(SITE, '127.0.0.1', resolve))

  const appInfo = resolveApp(ROOT)
  const acceptanceLog = process.env.SHOPILOT_ENTRIES_LOG || path.join(userData, 'acceptance-app.log')
  const child = spawn(appInfo.executable, appArgs(ROOT, appInfo, { port: PORT, userData }), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv({
      NODE_ENV: 'production', ELECTRON_ENABLE_LOGGING: '1',
      SHOPILOT_DISABLE_CDP_FP: '1', SHOPILOT_ACCEPTANCE: '1'
    })
  })
  let appLog = ''
  child.on('exit', code => { appLog += `\n[app exit ${code}]\n` })
  child.stdout.on('data', d => { appLog += d.toString() })
  child.stderr.on('data', d => { appLog += d.toString() })

  const { check, summary } = createChecker()
  let ui = null
  try {
    ui = await waitForMainWindow(PORT)
    if (!ui) throw new Error('主窗口 CDP 未就绪')
    await sleep(900)

    const store = await ui.eval(`return await window.shopilot.store.create({ name: ${JSON.stringify(STORE_NAME)}, platform: '抖店', adminUrl: 'http://127.0.0.1:${SITE}/' })`)
    if (!store.ok) throw new Error('创建验收店铺失败：' + JSON.stringify(store.error))

    // ---------- 1) 店铺分组入口 ----------
    const navTo = label => ui.eval(`
      const item = [...document.querySelectorAll('.dashboard-nav-item')]
        .find(el => (el.textContent || '').includes(${JSON.stringify(label)}))
      if (!item) return false
      item.click()
      await new Promise(r => setTimeout(r, 400))
      return true
    `)
    check('侧栏可以进入「店铺管理」页', await navTo('店铺管理'))

    let cardReady = null
    for (let i = 0; i < 40; i++) {
      cardReady = await ui.eval(`
        const card = [...document.querySelectorAll('article.unified-store-card')]
          .find(el => (el.textContent || '').includes(${JSON.stringify(STORE_NAME)}))
        return card ? { card: true, button: !!card.querySelector('[data-test="store-group-open"]') } : { card: false, button: false }
      `)
      if (cardReady.card && cardReady.button) break
      await sleep(250)
    }
    check('店铺卡片出现「分组」入口（修复前该入口不存在）', cardReady.card === true && cardReady.button === true, JSON.stringify(cardReady))

    const openDialog = await ui.eval(`
      const card = [...document.querySelectorAll('article.unified-store-card')]
        .find(el => (el.textContent || '').includes(${JSON.stringify(STORE_NAME)}))
      card.querySelector('[data-test="store-group-open"]').click()
      await new Promise(r => setTimeout(r, 300))
      const input = document.querySelector('[data-test="store-group-input"]')
      input.value = ${JSON.stringify(GROUP_NAME)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 120))
      return { dialog: !!document.querySelector('[data-test="store-group-dialog"]'), save: !!document.querySelector('[data-test="store-group-save"]') }
    `)
    check('点「分组」弹出页内浮层并接受输入（不是 window.prompt）', openDialog.dialog === true && openDialog.save === true, JSON.stringify(openDialog))

    const saved = await ui.eval(`
      document.querySelector('[data-test="store-group-save"]').click()
      await new Promise(r => setTimeout(r, 700))
      const list = await window.shopilot.store.list()
      const row = list.ok ? list.data.find(item => item.name === ${JSON.stringify(STORE_NAME)}) : null
      return { groupName: row?.groupName ?? null, dialogClosed: !document.querySelector('[data-test="store-group-dialog"]') }
    `)
    check('保存分组写进主进程（store.list 的 groupName 一致）且浮层关闭',
      saved.groupName === GROUP_NAME && saved.dialogClosed === true, JSON.stringify(saved))

    const cleared = await ui.eval(`
      const card = [...document.querySelectorAll('article.unified-store-card')]
        .find(el => (el.textContent || '').includes(${JSON.stringify(STORE_NAME)}))
      card.querySelector('[data-test="store-group-open"]').click()
      await new Promise(r => setTimeout(r, 300))
      document.querySelector('[data-test="store-group-clear"]').click()
      await new Promise(r => setTimeout(r, 700))
      const list = await window.shopilot.store.list()
      const row = list.ok ? list.data.find(item => item.name === ${JSON.stringify(STORE_NAME)}) : null
      return { groupName: row?.groupName ?? null }
    `)
    check('清除分组后主进程 groupName 归零', cleared.groupName === null, JSON.stringify(cleared))

    // ---------- 2) 主动检测登录状态（SESSION_EXPIRED 链路） ----------
    // 走用户路径打开店铺工作区，再在环境面板里主动检测一次登录态。本机没有真实平台登录，
    // 因此断言的是"链路通且结论如实上屏"（中文、带 tone、不假装已登录），不是某个具体平台结论。
    const openWorkspace = await ui.eval(`
      const card = [...document.querySelectorAll('article.unified-store-card')]
        .find(el => (el.textContent || '').includes(${JSON.stringify(STORE_NAME)}))
      if (!card) return { card: false }
      const button = [...card.querySelectorAll('button')].find(el => (el.textContent || '').includes('打开工作区'))
      if (!button) return { card: true, button: false }
      button.click()
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        if (document.querySelector('[data-test="dashboard-browser-host"]')) return { card: true, button: true, host: true }
        await new Promise(r => setTimeout(r, 220))
      }
      return { card: true, button: true, host: false }
    `)
    check('从店铺卡片打开工作区（登录态检测的前置）', openWorkspace.host === true, JSON.stringify(openWorkspace))

    const envPanel = await ui.eval(`
      // 面板展开时是「页签行」（.panel-tabs 里的 收藏/下载/环境/任务），收起时才是左侧图标轨
      const expand = document.querySelector('[data-test="panel-expand"]')
      if (expand) { expand.click(); await new Promise(r => setTimeout(r, 300)) }
      const rail = document.querySelector('[data-test="rail-env"]')
      if (rail) { rail.click(); await new Promise(r => setTimeout(r, 300)) }
      const tabs = [...document.querySelectorAll('.panel-tabs button[role="tab"]')]
      const envTab = tabs.find(el => (el.textContent || '').trim().includes('环境'))
      if (envTab) envTab.click()
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        if (document.querySelector('[data-test="session-check-login"]')) return { panel: true }
        await new Promise(r => setTimeout(r, 200))
      }
      return { panel: false, tabs: tabs.map(el => (el.textContent || '').trim()), envTab: !!envTab }
    `)
    check('环境面板出现「检测登录状态」入口（修复前该能力无任何渲染层调用）', envPanel.panel === true, JSON.stringify(envPanel))

    const loginCheck = await ui.eval(`
      const button = document.querySelector('[data-test="session-check-login"]')
      if (!button) return { buttonMissing: true }
      const enabledBefore = button.disabled !== true
      button.click()
      const deadline = Date.now() + 30000
      let result = null
      let note = ''
      while (Date.now() < deadline) {
        const line = document.querySelector('[data-test="session-check-login-result"]')
        note = (document.querySelector('[data-test="session-check-login-note"]')?.textContent || '').trim()
        const text = (line?.textContent || '').trim()
        if (text) { result = { text, tone: String(line.className || '') }; break }
        if (note) break
        await new Promise(r => setTimeout(r, 250))
      }
      return { enabledBefore, result, note, buttonText: (button.textContent || '').trim() }
    `)
    check('点「检测登录状态」后结论如实上屏（中文 + tone，或如实报失败；绝不假装已登录）',
      loginCheck.buttonMissing !== true && loginCheck.enabledBefore === true &&
        ((loginCheck.result && /login-check-(success|warning|error|info)/.test(loginCheck.result.tone) &&
          /[\u4e00-\u9fa5]/.test(loginCheck.result.text)) ||
          /检测失败/.test(loginCheck.note)),
      JSON.stringify(loginCheck))

    // ---------- 3) AI 商品分析入口 ----------
    check('侧栏可以回到「经营总览」', await navTo('经营总览'))

    // 「短视频去重」和「影像级干扰」占位均已删除：快捷操作与 AI 创作页都不该再出现。
    // 两个层次都要断言：① 旧锚点必须消失；② **文本级**（含被 CSS 隐藏的节点）不含该文案——
    // 只查 data-test 的话，改个 key 把占位加回来仍会全绿（2026-10-18 独立复验 F3）。
    const overviewTiles = await ui.eval(`
      return {
        image: !!document.querySelector('[data-test="quick-action-image"]'),
        dedupe: !!document.querySelector('[data-test="quick-action-dedupe"]'),
        interference: !!document.querySelector('[data-test="quick-action-interference"]'),
        dedupeText: (document.body.textContent || '').includes('短视频去重'),
        interferenceText: (document.body.textContent || '').includes('影像级干扰')
      }
    `)
    check('快捷操作不再展示已删除的「短视频去重」或「影像级干扰」占位（锚点 + 文本双层）',
      overviewTiles.image === true && overviewTiles.dedupe === false &&
        overviewTiles.interference === false && overviewTiles.dedupeText === false && overviewTiles.interferenceText === false,
      JSON.stringify(overviewTiles))

    check('侧栏可以进入「AI 创作」页（占位卡片所在页）', await navTo('AI 创作'))
    const appsPage = await ui.eval(`
      // 用 textContent 而不是 innerText：连被 CSS 隐藏的卡片一起算，删除才是真删干净
      const text = document.body.textContent || ''
      return { dedupe: text.includes('短视频去重'), interference: text.includes('影像级干扰') }
    `)
    check('「AI 创作」页不再出现「短视频去重」或「影像级干扰」占位',
      appsPage.dedupe === false && appsPage.interference === false, JSON.stringify(appsPage))
    check('侧栏可以再回到「经营总览」', await navTo('经营总览'))

    const enterStudio = await ui.eval(`
      const tile = document.querySelector('[data-test="quick-action-btn-image"]')
      if (!tile) return { tile: false }
      tile.click()
      const deadline = Date.now() + 12000
      while (Date.now() < deadline) {
        if (document.querySelector('[data-test="unified-image-studio-page"]')) return { tile: true, studio: true }
        await new Promise(r => setTimeout(r, 220))
      }
      return { tile: true, studio: false }
    `)
    check('快捷操作「AI 生成商品图」进入图片工作台', enterStudio.tile === true && enterStudio.studio === true, JSON.stringify(enterStudio))

    const analyzeIdle = await ui.eval(`
      const button = document.querySelector('[data-test="image-prompt-analyze"]')
      return { present: !!button, disabled: button ? button.disabled === true : null }
    `)
    check('「✦ AI 分析商品」按钮存在，且没有商品名/描述/素材时不可点（不产生空请求）',
      analyzeIdle.present === true && analyzeIdle.disabled === true, JSON.stringify(analyzeIdle))

    const analyzeRun = await ui.eval(`
      const name = document.querySelector('[data-test="product-name"]')
      name.value = '入口验收商品'
      name.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 200))
      const button = document.querySelector('[data-test="image-prompt-analyze"]')
      const enabled = button.disabled !== true
      button.click()
      const deadline = Date.now() + 20000
      let error = ''
      let note = ''
      while (Date.now() < deadline) {
        error = (document.querySelector('[data-test="image-prompt-analyze-error"]')?.textContent || '').trim()
        note = (document.querySelector('[data-test="image-prompt-analyze-note"]')?.textContent || '').trim()
        if (error || note) break
        await new Promise(r => setTimeout(r, 250))
      }
      return { enabled, error, note, busy: button.textContent.trim() }
    `)
    // 验收用全新 userData：生图文本 API 与主文本 API 都没配，必须走「如实报错」这条路径。
    check('填了商品名后可点，未配置文本 API 时行内给出中文错误（不静默、不 alert）',
      analyzeRun.enabled === true && /未配置|配置/.test(analyzeRun.error) && analyzeRun.note === '',
      JSON.stringify(analyzeRun))

  } finally {
    try { ui?.close() } catch { /* 已断开 */ }
    try { child.kill('SIGTERM') } catch { /* 已退出 */ }
    await sleep(1000)
    // 只杀自己这棵进程树：全局 taskkill /IM ShopPilot.exe 会把**并发跑着的其它验收套件**连根杀掉
    // （它们用各自的 userData 与端口，本来就互不干扰）。全局兜底留在 run-acceptance.ps1 的 Kill-ShopPilot。
    if (child.exitCode === null && child.signalCode === null) {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 进程已退出 */ }
      await sleep(500)
    }
    try { fs.writeFileSync(acceptanceLog, appLog, 'utf8') } catch { /* 日志只作证据，失败不影响结论 */ }
    site.close()
  }

  if (!summary('渲染层补齐入口验收')) {
    console.log(`--- 应用日志（入口/异常）---\n${appLog.split('\n').filter(line => /store|group|ai|analyze|error|crash/i.test(line)).slice(-25).join('\n')}`)
    process.exit(1)
  }
}

main().catch(error => { console.error('ENTRIES_VERIFY_CRASH', error); process.exit(2) })
