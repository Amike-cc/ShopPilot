/**
 * 微信小店带货者广场筛选：**真机端到端**验证（不发邀约）
 *
 * 验证三件事（全部对真实登录态的店铺页面执行）：
 *   ① IPC `browser.prepareInviteSquare`：类型/带货类目/带货销售总额/其他筛选逐项应用，
 *      并回读勾选态（返回 { applied, categories[], salesTiers[], otherFilters[] }）；
 *   ② 任务引擎：把「广场筛选」那几步（navigate + clickByText(skipIfChecked/verifyChecked)）真正
 *      建成任务并执行一遍——**不含任何发送步骤**，只验证筛选点得上、回读通过；
 *   ③ 负路径：文案不存在时 verifyChecked 必须**如实失败**（TASK_FILTER_NOT_APPLIED），
 *      不能把"点过了"当成"筛上了"。
 *
 * 用法：node wx-invite-test/verify-wx-square-filters.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * 现场把 shared 的邀约构造器打成 ESM 包（脚本是纯 node，吃不了 .ts）。
 * 用仓库里 vite 依赖自带的 esbuild，不联网、不装包。
 */
function ensureProbeBundle() {
  const out = path.resolve('wx-invite-test/.tmp/probe-entry.mjs')
  const entry = path.resolve('wx-invite-test/probe-entry.ts')
  const esbuildDir = fs.readdirSync(path.resolve('node_modules/.pnpm')).find(name => name.startsWith('esbuild@'))
  if (!esbuildDir) throw new Error('找不到 esbuild（vite 依赖自带）；请先 pnpm install')
  const bin = path.resolve('node_modules/.pnpm', esbuildDir, 'node_modules/esbuild/bin/esbuild')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const res = spawnSync(process.execPath, [bin, entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${out}`], { stdio: 'inherit' })
  if (res.status !== 0 || !fs.existsSync(out)) throw new Error('打包 shared/invite-task 失败')
}

const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'
const OUT_DIR = path.resolve('wx-invite-test/evidence')
const CATEGORY = process.env.VERIFY_CATEGORY || '母婴'
const TIER = process.env.VERIFY_TIER || '￥10万-20万'
const OTHER = process.env.VERIFY_OTHER || '有认证'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const ENUM_ALL = `function ENUM_ALL(){const o=[];const w=r=>{for(const e of r.querySelectorAll('*')){o.push(e);if(e.shadowRoot)w(e.shadowRoot)};if(r.shadowRoot)w(r.shadowRoot)};w(document);return o}`

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
  return { send, ev, close: () => ws.close() }
}

const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())

const STATE = `(() => { ${ENUM_ALL}
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const rowOf = t => { for (const el of ENUM_ALL()) { if (own(el) !== t) continue; return el.closest('.weui-desktop-form__control-group') } return null }
  const dlOf = () => { for (const el of ENUM_ALL()) { if (el.tagName === 'DT' && own(el).includes('带货销售总额')) return el.parentElement } return null }
  const catRow = rowOf('带货类目')
  const otherRow = rowOf('其他筛选')
  const dl = dlOf()
  const checked = row => row ? [...row.querySelectorAll('label')].filter(el => { const i = el.querySelector('input'); return i && i.checked }).map(el => String(el.innerText || '').replace(/\\s+/g, ' ').trim()) : []
  const salesChecked = dl ? [...dl.querySelectorAll('.talent-filter-dropdown-item')].filter(el => { const i = el.querySelector('input'); return i && i.checked }).map(el => String(el.innerText || '').replace(/\\s+/g, ' ').trim()) : []
  const tab = ENUM_ALL().find(el => el.tagName === 'LI' && /weui-desktop-tab__nav_current/.test(String(el.className || '')))
  return JSON.stringify({
    tab: tab ? String(tab.innerText || '').replace(/\\s+/g, ' ').trim() : null,
    categories: checked(catRow),
    sales: salesChecked,
    salesPresent: !!dl,
    others: checked(otherRow),
    detailLinks: ENUM_ALL().filter(el => own(el) === '详情' && el.getBoundingClientRect().width > 0).length
  })
})()`

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const list = await targets()
  const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  if (!renderer) throw new Error('未找到应用渲染层（应用需带 --remote-debugging-port 启动）')
  const app = await connect(renderer)
  const call = async (expr) => JSON.parse(await app.ev(`(async () => JSON.stringify(await ${expr}))()`))

  // ① IPC 应用筛选
  console.log('=== ① IPC prepareInviteSquare（类型 + 三类筛选） ===')
  const displayed = await call(`window.shopilot.browser.display(${JSON.stringify(STORE)})`)
  check('店铺窗口已打开', !!displayed?.ok, displayed?.data?.displayedStoreId || '')
  await sleep(2500)
  const prepared = await call(`window.shopilot.browser.prepareInviteSquare(${JSON.stringify(STORE)}, ${JSON.stringify({
    url: SQUARE, finderType: '全部带货者', categories: [CATEGORY], salesTiers: [TIER], otherFilters: [OTHER]
  })})`)
  const data = prepared?.data || {}
  check('IPC 返回 applied=true', data.applied === true, JSON.stringify({ applied: data.applied, finderType: data.finderType, categories: data.categories, salesTiers: data.salesTiers, otherFilters: data.otherFilters }).slice(0, 400))

  await sleep(1500)
  const wxList = await targets()
  const wxPage = wxList.find(t => /store\.weixin\.qq\.com/.test(String(t.url)))
  const wx = await connect(wxPage)
  const state = JSON.parse(await wx.ev(STATE))
  check(`类型已切到「全部带货者」`, state.tab === '全部带货者', String(state.tab))
  check(`带货类目「${CATEGORY}」已勾选`, state.categories.includes(CATEGORY), JSON.stringify(state.categories))
  check(`带货销售总额「${TIER}」已勾选`, state.sales.includes(TIER), JSON.stringify(state.sales))
  check(`其他筛选「${OTHER}」已勾选`, state.others.includes(OTHER), JSON.stringify(state.others))

  // ② 任务引擎跑"只有筛选"的任务（不含任何发送步骤）
  // ⚠ 这一步用的是**真实构造器生成的步骤**（esbuild 现场打包 packages/shared/src/invite-task.ts），
  //    只把最后的 loop（逐个邀约、会真的发出去）去掉——验证的就是面板/智能体实际会跑的那串筛选步骤。
  console.log('=== ② 任务引擎：跑真实生成的筛选步骤（已剔除发送 loop） ===')
  ensureProbeBundle()
  const { buildInviteTaskPayload, inviteProfileFor } = await import('./.tmp/probe-entry.mjs')
  const payload = buildInviteTaskPayload({
    profile: inviteProfileFor('微信小店'),
    storeId: STORE,
    squareUrl: SQUARE,
    config: {
      script: '验证用话术（不会发送）', scriptMode: 'manual', contact: '验证联系人', wechat: 'verify_wx', phone: '13800000000',
      finderType: '全部带货者', finderCategories: [CATEGORY], finderSalesTiers: [TIER], finderOtherFilters: [OTHER]
    }
  })
  check('真实构造器生成了邀约载荷', !!payload, payload ? payload.name : '')
  const openingSteps = (payload?.steps || []).filter((s) => s.type !== 'loop')
  check('载荷里的筛选步骤已剔除发送 loop', openingSteps.length > 0 && !openingSteps.some((s) => s.type === 'loop'), `筛选步骤 ${openingSteps.length} 条`)
  const created = await call(`window.shopilot.task.create(${JSON.stringify({ name: '筛选验证（不发邀约）', storeScope: STORE, steps: openingSteps })})`)
  check('筛选验证任务创建成功', !!created?.ok, created?.error?.message || created?.data?.id || '')
  let runId = ''
  if (created?.ok) {
    const started = await call(`window.shopilot.task.run(${JSON.stringify(created.data.id)})`)
    check('筛选验证任务已启动', !!started?.ok, started?.error?.message || '')
    let run = null
    for (let i = 0; i < 40; i++) {
      await sleep(1500)
      const tasks = await call(`window.shopilot.task.list()`)
      const task = (tasks?.data || []).find(t => t.id === created.data.id)
      run = task?.latestRun || null
      if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) break
    }
    check('筛选步骤执行成功（引擎回读勾选态通过）', run?.status === 'succeeded', `${run?.status} ${run?.errorCode || ''} ${String(run?.errorMessage || '').slice(0, 200)}`)
    // task.results 收的是 **runId**（不是 taskId）
    const detail = await call(`window.shopilot.task.results(${JSON.stringify(run?.id || '')})`)
    const payloads = (detail?.data?.results || []).map(r => JSON.stringify(r.payload)).join(' | ')
    check('步骤结果记录了 verifiedChecked', /verifiedChecked/.test(payloads), payloads.slice(0, 300))
    await call(`window.shopilot.task.delete(${JSON.stringify(created.data.id)})`).catch(() => null)
  }

  // ③ 负路径：档位文案不存在时必须如实失败（不能把"点过了"当成"筛上了"）
  console.log('=== ③ 负路径：不存在的档位必须如实失败 ===')
  const badSteps = openingSteps.map((step) => {
    if (step.type === 'clickByText' && step.input?.text === TIER) return { ...step, input: { ...step.input, text: '￥9999万以上（不存在）' } }
    return step
  })
  const badCreated = await call(`window.shopilot.task.create(${JSON.stringify({ name: '筛选负路径验证（不发邀约）', storeScope: STORE, steps: badSteps })})`)
  if (badCreated?.ok) {
    await call(`window.shopilot.task.run(${JSON.stringify(badCreated.data.id)})`)
    let badRun = null
    for (let i = 0; i < 40; i++) {
      await sleep(1500)
      const tasks = await call(`window.shopilot.task.list()`)
      badRun = (tasks?.data || []).find(t => t.id === badCreated.data.id)?.latestRun || null
      if (badRun && ['succeeded', 'failed', 'cancelled'].includes(badRun.status)) break
    }
    check('不存在的档位 → 任务如实失败', badRun?.status === 'failed', `${badRun?.status} ${badRun?.errorCode || ''}`)
    await call(`window.shopilot.task.delete(${JSON.stringify(badCreated.data.id)})`).catch(() => null)
  } else {
    check('负路径任务创建成功', false, badCreated?.error?.message || '')
  }

  // ④ 面板 UI：三组筛选都渲染出来（真实渲染层 DOM）
  console.log('=== ④ 面板 UI：三组广场筛选 ===')
  const ui = JSON.parse(await app.ev(`(() => {
    const inviteTab = document.querySelector('[data-test="task-tab-invite"]')
    if (inviteTab) inviteTab.click()
    return JSON.stringify({ clicked: !!inviteTab })
  })()`))
  await sleep(1200)
  const panel = JSON.parse(await app.ev(`(() => {
    const q = (sel) => document.querySelectorAll(sel).length
    const sales = [...document.querySelectorAll('[data-test^="invite-finder-sales-"]')].map(el => el.getAttribute('data-test').replace('invite-finder-sales-', ''))
    return JSON.stringify({
      panel: q('[data-test="invite-panel"]'),
      typeSelect: q('[data-test="invite-finder-type"]'),
      categories: q('[data-test^="invite-finder-category-"]'),
      sales,
      others: q('[data-test^="invite-finder-other-"]'),
      catsToggle: q('[data-test="invite-finder-cats-toggle"]')
    })
  })()`))
  check('达人邀约面板已渲染', panel.panel > 0, JSON.stringify(panel))
  check('带货者类型下拉存在', panel.typeSelect === 1, '')
  check('带货类目 chips 已渲染（默认展开一屏 16 项）', panel.categories > 0, `${panel.categories} 项可见`)
  check('带货销售总额 16 档全部渲染', panel.sales.length === 16, panel.sales.join('/'))
  check('其他筛选 7 项全部渲染', panel.others === 7, `${panel.others} 项`)
  check('类目展开/收起按钮存在', panel.catsToggle === 1, '')

  let finalState = null
  try { finalState = JSON.parse(await wx.ev(STATE, 15000)) } catch (err) { finalState = { error: String(err.message) } }
  console.log('最终页面状态:', JSON.stringify(finalState))
  fs.writeFileSync(path.join(OUT_DIR, 'verify-square-filters.json'), JSON.stringify({ results, finalState, panel }, null, 1))

  wx.close()
  app.close()
  const failed = results.filter(r => !r.ok)
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => { console.error('ERR', err.stack || err.message); process.exit(1) })
