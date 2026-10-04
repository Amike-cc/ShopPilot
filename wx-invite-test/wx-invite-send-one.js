/**
 * 微信小店达人邀约：**完整闭环真机验证（真发 1 位）**
 *
 * 走的就是面板/智能体的同一条链路，只有一处刻意的收窄：
 *   · 配置：读店铺自己那份 `invite.config.store.<storeId>`（面板保存的）
 *   · 任务：`buildInviteTaskPayload`（shared 单一构造器）生成 → 只把末尾 loop 的 maxRounds 钉成 1，
 *     即"只发 1 位达人"；其余步骤一字不改（筛选 → 详情 → 邀请带货 → 表单 → AI 话术 → 商品 → 发送）
 *   · 执行：renderer 的 `task.create` + `task.run`（与面板「开始邀约」同一条 IPC）
 *
 * 复核（不靠任务自述）：
 *   · 任务侧：逐步骤结果（含 aiGenerate 摘要、requireQuota 读到的额度、发送后的 waitForGone）
 *   · 平台侧：`/shop/findersquare/my-invite`（我的达人）在发送前后的行数/页签/首行对比
 *
 * 用法：node wx-invite-test/wx-invite-send-one.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'
const MY_INVITE = 'https://store.weixin.qq.com/shop/findersquare/my-invite'
const OUT_DIR = path.resolve('wx-invite-test/evidence')

const sleep = ms => new Promise(r => setTimeout(r, ms))

function ensureProbeBundle() {
  const out = path.resolve('wx-invite-test/.tmp/probe-entry.mjs')
  const entry = path.resolve('wx-invite-test/probe-entry.ts')
  /**
   * **每次都重新打包**（原来是"存在就跳过"）：改了 `packages/shared` 之后忘记删缓存，
   * 验证跑的就是旧步骤集——2026-10-03 实测踩到一次（新加的双判据没进载荷，步数仍是 26）。
   * esbuild 打包只要几十毫秒，不值得为省这点时间冒"验证了旧代码"的风险。
   */
  const esbuildDir = fs.readdirSync(path.resolve('node_modules/.pnpm')).find(name => name.startsWith('esbuild@'))
  if (!esbuildDir) throw new Error('找不到 esbuild（vite 依赖自带）')
  const bin = path.resolve('node_modules/.pnpm', esbuildDir, 'node_modules/esbuild/bin/esbuild')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const res = spawnSync(process.execPath, [bin, entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${out}`], { stdio: 'inherit' })
  if (res.status !== 0 || !fs.existsSync(out)) throw new Error('打包 shared/invite-task 失败')
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let seq = 0
  const pending = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params = {}) => new Promise((ok, err) => {
    const id = ++seq
    pending.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const ev = async (expr, timeoutMs = 30000) => {
    const call = send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    const r = await Promise.race([call, new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 求值超时')), timeoutMs))])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  return { send, ev, call: async (expr) => JSON.parse(await ev(`(async () => JSON.stringify(await ${expr}))()`)), close: () => ws.close() }
}

const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())

/** 读「我的达人」页（整页在 ShadowRoot 里，body.innerText 读不到） */
const MY_INVITE_READ = `(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const deepText = all.map(el => own(el)).filter(Boolean).join(' ')
  const rows = all.filter(e => e.tagName === 'TR' && vis(e)).map(e => String(e.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean)
  const tabs = [...new Set(all.filter(e => vis(e) && /^(全部|待确认|已接受|已拒绝|已过期|邀约中)$/.test(own(e))).map(e => own(e)))]
  const quota = /今日剩余\\s*(\\d+)\\s*次邀请机会/.exec(deepText)
  const counts = [...new Set((deepText.match(/共\\s*\\d+\\s*[条个位]/g) || []))]
  const login = /登录超时|请重新\\s*登录|扫码进入我的小店/.test(deepText)
  return JSON.stringify({ url: location.href, login, rowCount: rows.length, firstRows: rows.slice(0, 3), tabs, counts, quota: quota ? Number(quota[1]) : null })
})()`

async function readMyInvite(page) {
  return JSON.parse(await page.ev(MY_INVITE_READ, 30000))
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  ensureProbeBundle()
  const { buildInviteTaskPayload, inviteTaskIssues, normalizeInviteTaskConfig, inviteProfileFor } = await import('./.tmp/probe-entry.mjs')

  const list = await targets()
  const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  if (!renderer) throw new Error('未找到应用渲染层（探针实例需带 --remote-debugging-port 启动）')
  const app = await connect(renderer)
  const report = { startedAt: new Date().toISOString(), store: STORE, steps: [] }

  // ---------- 1. 店铺配置 ----------
  const storeCfg = await app.call(`window.shopilot.settings.get('invite.config.store.${STORE}')`)
  const legacyCfg = await app.call(`window.shopilot.settings.get('invite.config.微信小店')`)
  const raw = (storeCfg?.ok && storeCfg.data?.value) ? storeCfg.data.value : ((legacyCfg?.ok && legacyCfg.data?.value) ? legacyCfg.data.value : {})
  const profile = inviteProfileFor('微信小店')
  const config = normalizeInviteTaskConfig('assist-form', raw)
  /**
   * 话术模式允许用环境变量覆盖（默认按店铺配置走）。
   * 用途：本次真机实测发现**该网关的文本模型是推理型**——把 max_tokens 全花在
   * `reasoning_content` 上、正文为空（见 diag-ai-generate），AI 模式必然卡在「AI 生成话术」。
   * 为了把「邀约功能本身」的闭环测完，临时用配置里已存的手填话术跑一遍；
   * 不改店铺配置（只在本次任务的载荷里覆盖）。
   */
  if (process.env.WX_SCRIPT_MODE === 'manual') config.scriptMode = 'manual'
  const issues = inviteTaskIssues({ profile, config })
  report.config = {
    contact: config.contact, wechat: config.wechat, phone: config.phone,
    scriptMode: config.scriptMode, productIds: config.productIds,
    finderType: config.finderType, categories: config.finderCategories,
    salesTiers: config.finderSalesTiers, others: config.finderOtherFilters
  }
  console.log('=== 1. 店铺配置 ===')
  console.log(JSON.stringify(report.config))
  if (issues.length) {
    console.log('❌ 配置不完整，终止：', issues.join('；'))
    process.exit(1)
  }

  // ---------- 2. 载荷（连续发送：默认 1 位，SEND_ROUNDS=n 连发 n 位） ----------
  const payload = buildInviteTaskPayload({ profile, storeId: STORE, squareUrl: SQUARE, config })
  if (!payload) throw new Error('构造器返回 null（配置不完整）')
  const loop = payload.steps[payload.steps.length - 1]
  if (loop?.type !== 'loop') throw new Error('载荷末尾不是 loop，拒绝继续（怕误发多轮）')
  /**
   * 连发轮数：默认 1。**必须显式给 SEND_ROUNDS** 才会连发（防止手滑发出去一批），
   * 并夹在 [1, 5] —— 真机验证用，不做大批量投放。
   */
  const rounds = Math.min(5, Math.max(1, Number(process.env.SEND_ROUNDS || 1) || 1))
  if (rounds > 1 && !process.env.SEND_ROUNDS) throw new Error('连发必须显式设置 SEND_ROUNDS')
  loop.input.maxRounds = rounds
  payload.name = `${payload.name} · ${rounds > 1 ? `连发 ${rounds} 位` : '单发'}验证`.slice(0, 80)
  report.taskName = payload.name
  report.stepTypes = payload.steps.map(s => s.type)
  report.roundStepTypes = loop.input.steps.map(s => s.type)
  report.rounds = rounds
  console.log('=== 2. 任务载荷 ===')
  console.log('顶层步骤:', report.stepTypes.join(' → '))
  console.log('单轮步骤:', report.roundStepTypes.join(' → '))
  console.log('单轮步骤数:', report.roundStepTypes.length, `｜maxRounds = ${rounds}`)

  // ---------- 3. 发送前：平台侧基线 ----------
  const displayed = await app.call(`window.shopilot.browser.display(${JSON.stringify(STORE)})`)
  report.display = displayed?.data || null
  await sleep(2000)
  /**
   * 先把**店铺里已存在的那个标签页**导航到广场——这正是面板「打开达人广场」的效果，
   * 也是本次实测要覆盖的真实前置状态：此时店铺里已经有一个广场页，引擎再新建运行标签页后，
   * 首轮 useTab 必须在"用户那个广场页"和"本次运行（已应用筛选）的标签页"之间做对选择。
   */
  const tabsBefore = await app.call(`window.shopilot.browser.tab.list(${JSON.stringify(STORE)})`)
  const firstTabId = tabsBefore?.data?.activeTabId || (tabsBefore?.data?.tabs || [])[0]?.id
  report.preexistingSquareTab = firstTabId || null
  if (firstTabId) {
    await app.call(`window.shopilot.browser.navigate(${JSON.stringify(STORE)}, ${JSON.stringify(firstTabId)}, ${JSON.stringify(SQUARE)})`).catch(() => null)
    await sleep(6000)
  }
  const created = await app.call(`window.shopilot.browser.tab.create(${JSON.stringify(STORE)}, ${JSON.stringify(MY_INVITE)})`)
  const myTabId = created?.data?.tabId || created?.data?.id
  report.myInviteTab = myTabId || null
  await sleep(9000)
  const afterCreate = await targets()
  const myPage = afterCreate.find(t => /findersquare\/my-invite/.test(String(t.url)))
  let before = null
  if (myPage) {
    const page = await connect(myPage)
    before = await readMyInvite(page)
    report.beforeMyInvite = before
    console.log('=== 3. 发送前「我的达人」 ===')
    console.log(JSON.stringify(before))
    page.close()
  } else {
    console.log('⚠ 没能打开「我的达人」页，发送前后对比将缺失')
  }

  // ---------- 4. 创建并执行任务 ----------
  console.log('=== 4. 创建并执行邀约任务（真实发送） ===')
  const taskCreated = await app.call(`window.shopilot.task.create(${JSON.stringify({ name: payload.name, storeScope: STORE, steps: payload.steps })})`)
  if (!taskCreated?.ok) throw new Error('任务创建失败：' + JSON.stringify(taskCreated?.error))
  const taskId = taskCreated.data.id
  report.taskId = taskId
  console.log('任务已创建:', taskId)
  const started = await app.call(`window.shopilot.task.run(${JSON.stringify(taskId)})`)
  if (!started?.ok) throw new Error('任务启动失败：' + JSON.stringify(started?.error))
  console.log('任务已启动，轮询中…')

  // ---------- 5. 轮询：任务状态 + 逐步结果 ----------
  const seen = new Set()
  let run = null
  const deadline = Date.now() + 15 * 60 * 1000
  while (Date.now() < deadline) {
    await sleep(3000)
    const tasks = await app.call(`window.shopilot.task.list()`)
    run = (tasks?.data || []).find(t => t.id === taskId)?.latestRun || null
    if (run?.id) {
      const detail = await app.call(`window.shopilot.task.results(${JSON.stringify(run.id)})`)
      for (const row of (detail?.data?.results || [])) {
        const key = `${row.stepIndex}|${row.summary}`
        if (seen.has(key)) continue
        seen.add(key)
        const line = `  第${row.stepIndex + 1}步 ${row.kind} ${String(row.summary).slice(0, 110)}`
        console.log(line)
        report.steps.push({ index: row.stepIndex, kind: row.kind, summary: row.summary, payload: row.payload, artifactPath: row.artifactPath })
      }
    }
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) break
  }
  report.run = run
  console.log('=== 5. 任务结果 ===')
  console.log(`状态=${run?.status} 错误码=${run?.errorCode || '-'} 说明=${String(run?.errorMessage || '-').slice(0, 300)}`)

  // 关键步骤摘要
  const payloadOf = (fragment) => (report.steps.find(s => String(s.summary).includes(fragment)) || {}).payload
  const quota = payloadOf('requireQuota') || payloadOf('额度')
  const ai = payloadOf('aiGenerate') || payloadOf('AI')
  const byId = payloadOf('ensureRowsById') || payloadOf('商品')
  report.keyEvidence = {
    filterSteps: report.steps.filter(s => /母婴|有联系方式|直播带货者|带货销售总额/.test(String(s.summary))).length,
    aiGenerate: ai || null,
    goods: byId || null,
    quota: quota || null,
    screenshot: (report.steps.find(s => s.kind === 'screenshot') || {}).artifactPath || null
  }

  // ---------- 6. 发送后：平台侧复核 ----------
  console.log('=== 6. 发送后「我的达人」复核 ===')
  await sleep(4000)
  if (myTabId) {
    await app.call(`window.shopilot.browser.tab.activate(${JSON.stringify(STORE)}, ${JSON.stringify(myTabId)})`).catch(() => null)
    await app.call(`window.shopilot.browser.navigate(${JSON.stringify(STORE)}, ${JSON.stringify(myTabId)}, ${JSON.stringify(MY_INVITE)})`).catch(() => null)
    await sleep(11000)
    const afterList = await targets()
    const page = afterList.find(t => /findersquare\/my-invite/.test(String(t.url)))
    if (page) {
      const conn = await connect(page)
      const after = await readMyInvite(conn)
      report.afterMyInvite = after
      console.log(JSON.stringify(after))
      try {
        const shot = await conn.send('Page.captureScreenshot', { format: 'png' })
        const shotPath = path.join(OUT_DIR, 'my-invite-after-send.png')
        fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
        report.myInviteScreenshot = shotPath
        console.log('截图:', shotPath)
      } catch (err) { console.log('截图失败:', err.message) }
      conn.close()
    }
    await app.call(`window.shopilot.browser.tab.close(${JSON.stringify(STORE)}, ${JSON.stringify(myTabId)})`).catch(() => null)
  }

  // 广场侧：本次运行用的那个广场标签页是否**保住了筛选**（不能因为切页把带筛选的页面丢掉）
  const tabsAfter = await app.call(`window.shopilot.browser.tab.list(${JSON.stringify(STORE)})`)
  report.tabsAfter = (tabsAfter?.data?.tabs || []).map(t => ({ id: t.id, url: t.url }))
  const squareTargets = await targets()
  const squareTabs = squareTargets.filter(t => /findersquare\/find/.test(String(t.url)))
  report.squareTabsAfter = squareTabs.map(t => t.url)
  if (squareTabs.length) {
    const conn = await connect(squareTabs[0])
    const squareState = JSON.parse(await conn.ev(`(() => {
      const all = []
      const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
      walk(document)
      const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
      const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
      const rowOf = t => { for (const el of all) { if (own(el) !== t) continue; return el.closest('.weui-desktop-form__control-group') } return null }
      const checkedIn = row => row ? [...row.querySelectorAll('label')].filter(el => { const i = el.querySelector('input'); return i && i.checked }).map(el => String(el.innerText || '').replace(/\\s+/g, ' ').trim()) : []
      const tab = all.find(el => el.tagName === 'LI' && /weui-desktop-tab__nav_current/.test(String(el.className || '')))
      const text = all.map(el => own(el)).filter(Boolean).join(' ')
      const invited = (text.match(/已邀请/g) || []).length
      return JSON.stringify({
        url: location.href,
        finderType: tab ? String(tab.innerText || '').replace(/\\s+/g, ' ').trim() : null,
        others: checkedIn(rowOf('其他筛选')),
        categories: checkedIn(rowOf('带货类目')),
        invitedMarks: invited,
        detailLinks: all.filter(el => own(el) === '详情' && vis(el)).length
      })
    })()`))
    report.squareAfter = squareState
    console.log('广场侧（本次运行用的那个标签页）:', JSON.stringify(squareState))
    conn.close()
  }

  fs.writeFileSync(path.join(OUT_DIR, 'wx-invite-send-one.json'), JSON.stringify(report, null, 1))
  console.log('留档: wx-invite-test/evidence/wx-invite-send-one.json')
  app.close()
  process.exit(run?.status === 'succeeded' ? 0 : 1)
}

main().catch(err => { console.error('ERR', err.stack || err.message); process.exit(1) })
