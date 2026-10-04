/**
 * 真机验证「带货销售总额」下拉的**状态无关**修复。
 *
 * 事故（2026-10-04 用户连发）：跑到第 13 轮时 `TASK_SELECTOR_CHANGED: 页面上找不到「不限」`，
 * 已发出 12 位的整批当场中止。原因是旧步骤"先点开 → 点档位 → 再点收"**假设开局一定是收起**，
 * 而那一轮开局面板已开，"先点开"反而把它点收了。
 *
 * 现在验证两种前置状态都能正确工作（步骤**直接取自真实构造器**，不是手写复制）：
 *   ① 面板**已开**：档位应被立刻找到并勾上（不会误点成"收"），收尾步骤把面板收起；
 *   ② 面板**已收**：档位步骤的 openVia 先点开，再勾上，最后收起。
 *
 * 用法：node wx-invite-test/verify-dropdown-state-independent.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'
const METRIC = '带货销售总额'
const TIER = process.env.TIER || '￥10万-20万'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())

function ensureBundle() {
  const out = path.resolve('wx-invite-test/.tmp/probe-entry.mjs')
  const entry = path.resolve('wx-invite-test/probe-entry.ts')
  const dir = fs.readdirSync(path.resolve('node_modules/.pnpm')).find(n => n.startsWith('esbuild@'))
  const bin = path.resolve('node_modules/.pnpm', dir, 'node_modules/esbuild/bin/esbuild')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const res = spawnSync(process.execPath, [bin, entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${out}`], { stdio: 'ignore' })
  if (res.status !== 0) throw new Error('打包失败')
}

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, er) => { ws.onopen = ok; ws.onerror = er })
  let s = 0
  const p = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } }
  const send = (me, pa = {}) => new Promise((ok, er) => { const id = ++s; p.set(id, m => m.error ? er(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: me, params: pa })) })
  const ev = async (x, timeoutMs = 20000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 超时')), timeoutMs))])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200))
    return r.result.value
  }
  return { send, ev, call: async x => JSON.parse(await ev(`(async()=>JSON.stringify(await ${x}))()`)), close: () => ws.close() }
}

/** 面板是否开着 + 档位勾选态（限定在该指标的 dl 内，与步骤同一套判据） */
const PANEL_STATE = `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const dt = all.find(e => own(e) === ${JSON.stringify(METRIC)} && vis(e))
  const dl = dt ? (dt.closest('dl') || dt.parentElement) : null
  const scope = dl ? [...dl.querySelectorAll('*')] : []
  const tier = scope.find(e => own(e) === ${JSON.stringify(TIER)})
  const cb = tier ? (tier.querySelector('input[type=checkbox]') || (tier.closest('label') ? tier.closest('label').querySelector('input[type=checkbox]') : null)) : null
  return JSON.stringify({ hasDt: !!dt, hasDl: !!dl, tierPresent: !!tier, tierVisible: !!(tier && vis(tier)), tierChecked: cb ? cb.checked : null })
})()`

async function pageConn() {
  const t = (await targets()).find(x => /findersquare\/find/.test(String(x.url)))
  if (!t) return null
  return connect(t)
}

async function clickDt(app, tabId) {
  // 用受信任鼠标点 DT（与页面真实操作一致）；DT 在筛选区，坐标可从页面取
  const p = await pageConn()
  if (!p) throw new Error('没有广场页')
  const pos = JSON.parse(await p.ev(`(() => {
    const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
    const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const dt = all.find(e => own(e) === ${JSON.stringify(METRIC)} && vis(e))
    if (!dt) return JSON.stringify({ ok: false })
    dt.scrollIntoView({ block: 'center' })
    const r = dt.getBoundingClientRect()
    return JSON.stringify({ ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`))
  if (!pos.ok) { p.close(); throw new Error('找不到 DT') }
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y })
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
  p.close()
  await sleep(1500)
}

async function main() {
  ensureBundle()
  const { buildAssistSteps, inviteProfileFor } = await import('./.tmp/probe-entry.mjs')
  const profile = inviteProfileFor('微信小店')
  // 只带"销售额 1 档"的配置 → 轮内筛选步骤就只有：类型页签 + 档位 + 条件性收起
  const steps = buildAssistSteps(profile, {
    contact: '刘涛', wechat: 'jiaoe988', phone: '15057937334', script: '你好', scriptMode: 'manual', productCount: 1,
    finderType: '全部带货者', finderSalesTiers: [TIER]
  }, SQUARE)
  const round = steps[0].input.steps
  const start = round.findIndex(s => s.type === 'clickByText' && String(s.input.text) === '全部带货者')
  const end = round.findIndex(s => s.type === 'waitForText' && String(s.input.text) === '详情')
  const filterSteps = round.slice(start, end)
  console.log('取自真实构造器的筛选步骤:', filterSteps.map(s => `${s.type}(${s.input.text})${s.retryLimit ? '+retry' : ''}`).join(' → '))

  const list = await targets()
  const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  const app = await connect(renderer)
  await app.call(`window.shopilot.browser.display('${STORE}')`)
  await sleep(1500)
  const tabs = (await app.call(`window.shopilot.browser.tab.list('${STORE}')`))?.data?.tabs || []
  const square = tabs.find(t => /findersquare\/find$/.test(String(t.url)))
  if (square) { await app.call(`window.shopilot.browser.tab.activate('${STORE}', '${square.id}')`); await sleep(3000) }
  else { await app.call(`window.shopilot.browser.tab.create('${STORE}', '${SQUARE}')`); await sleep(10000) }

  for (const scenario of ['panel-open', 'panel-closed']) {
    console.log(`\n=== 场景：${scenario === 'panel-open' ? '进档位步骤前面板已开（就是打挂第 13 轮的那种）' : '进档位步骤前面板已收（常规）'} ===`)
    /**
     * 任务自己导航（引擎复用"自己的运行标签页"，不一定是脚本刚激活的那个），
     * 然后按场景决定是否**先手动点开面板**——用真实构造器里的同一个 DT 点击步骤构造"已开"前置。
     */
    const prelude = [
      { type: 'navigate', input: { url: SQUARE }, timeoutMs: 45000 },
      { type: 'waitForPage', input: { urlIncludes: 'find' }, timeoutMs: 45000 },
      { type: 'waitForText', input: { text: '带货类目', deep: true }, timeoutMs: 40000 }
    ]
    if (scenario === 'panel-open') {
      prelude.push({ type: 'clickByText', input: { text: METRIC, deep: true, exact: true }, timeoutMs: 20000 })
    }
    const taskSteps = [...prelude, ...filterSteps]
    const task = await app.call(`window.shopilot.task.create(${JSON.stringify({ name: `下拉状态无关验证-${scenario}`, storeScope: STORE, steps: taskSteps })})`)
    if (!task?.ok) throw new Error('创建失败: ' + JSON.stringify(task?.error))
    await app.call(`window.shopilot.task.run(${JSON.stringify(task.data.id)})`)
    let run = null
    for (let i = 0; i < 40; i++) {
      await sleep(2000)
      const tasks = await app.call(`window.shopilot.task.list()`)
      run = (tasks?.data || []).find(t => t.id === task.data.id)?.latestRun || null
      if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) break
    }
    console.log('  任务:', run?.status, run?.errorCode || '-', String(run?.errorMessage || '').slice(0, 140))
    const p2 = await pageConn()
    if (p2) { console.log('  结果状态（期望 tierChecked=true、tierVisible=false）:', await p2.ev(PANEL_STATE)); p2.close() }
    await app.call(`window.shopilot.task.delete(${JSON.stringify(task.data.id)})`).catch(() => null)
  }
  app.close()
  process.exit(0)
}

main().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1) })
