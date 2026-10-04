/**
 * 快手小店（批量流）**不发送彩排**：用真实构造器生成的步骤，在真机页面上跑到
 * "发送前最后一步"就停——验证筛选 / 勾选（含 7 天台账跳过）/ 开抽屉 / 额度 / 必填 /
 * 选商品整条链路，**绝不点「发送邀请」**。
 *
 * 做法：取步骤 → 砍掉「发送邀请」及其之后的步骤（二次确认、失败文案断言、抽屉关闭、截图），
 * 用真实任务引擎跑一遍，把逐步骤结果打出来；跑完把抽屉关掉。
 *
 * 用法：node wx-invite-test/ks-rehearse-no-send.mjs [每批位数]
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_KS_STORE || 'store_3856e71a3ae8499ebdbec1f4ccbb4394'
const SQUARE = 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro'
const COUNT = Number(process.argv[2] || process.env.KS_COUNT || 2)
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
  const ev = async (x, timeoutMs = 25000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 超时')), timeoutMs))])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  return { send, ev, call: async x => JSON.parse(await ev(`(async()=>JSON.stringify(await ${x}))()`)), close: () => ws.close() }
}

ensureBundle()
const { buildInviteTaskPayload, inviteProfileFor, inviteTaskIssues, normalizeInviteTaskConfig } = await import('./.tmp/probe-entry.mjs')
const profile = inviteProfileFor('快手小店')

const list = await targets()
const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
if (!renderer) { console.error('未找到应用渲染层'); process.exit(1) }
const app = await connect(renderer)

const key = `invite.config.store.${STORE}`
// 先把店铺浏览器打开：任务引擎的排队判据之一是"店铺页可用"，不打开会一直停在 queued（真机踩过）
await app.call(`window.shopilot.browser.display('${STORE}')`)
await sleep(5000)
const saved = await app.call(`window.shopilot.settings.get(${JSON.stringify(key)})`)
const raw = saved?.ok ? (saved.data?.value || {}) : {}
console.log('店铺配置:', JSON.stringify({ category: raw.category, subcategory: raw.subcategory, count: raw.count, scriptMode: raw.scriptMode, benefits: raw.benefits, batchProductCount: raw.batchProductCount, extraFilters: raw.extraFilters }))

// 台账：用「我的达人 → 邀约中」里真实存在的两位昵称，验证勾选阶段确实跳过他们
const LEDGER = (process.env.KS_LEDGER || '小飞鸡,至尊宝＠').split(',').map(s => s.trim()).filter(Boolean)
const config = normalizeInviteTaskConfig('batch-list', { ...raw, count: COUNT, recentlyInvited: LEDGER })
const issues = inviteTaskIssues({ profile, config })
if (issues.length) { console.error('配置缺项，无法构造任务：', issues.join('；')); process.exit(1) }
const payload = buildInviteTaskPayload({ profile, storeId: STORE, squareUrl: SQUARE, config })
if (!payload) { console.error('构造载荷失败'); process.exit(1) }

// 砍掉发送及之后的步骤
const loop = payload.steps[0]
const round = loop.input.steps
const sendIdx = round.findIndex(s => s.type === 'clickByText' && String(s.input.text) === profile.texts.confirmSend)
if (sendIdx < 0) { console.error('没找到发送步骤，拒绝在不确定的步骤集上跑彩排'); process.exit(1) }
const truncated = round.slice(0, sendIdx)
const steps = [{ ...loop, input: { ...loop.input, steps: truncated } }]
console.log(`步骤：共 ${round.length} 步，砍掉发送及之后 ${round.length - sendIdx} 步 → 彩排 ${truncated.length} 步`)
console.log('彩排步骤:', truncated.map(s => `${s.type}${s.input.text ? '(' + String(s.input.text).slice(0, 8) + ')' : ''}`).join(' → '))
const clickAllStep = truncated.find(s => s.type === 'clickAll')
console.log('勾选步骤的 skipTexts:', JSON.stringify(clickAllStep?.input?.skipTexts))

const created = await app.call(`window.shopilot.task.create(${JSON.stringify({ name: `快手彩排-不发送-${COUNT}位`, storeScope: STORE, steps })})`)
if (!created?.ok) { console.error('建任务失败:', JSON.stringify(created?.error)); process.exit(1) }
await app.call(`window.shopilot.task.run(${JSON.stringify(created.data.id)})`)
let run = null
for (let i = 0; i < 300; i++) {
  await sleep(2000)
  const tasks = await app.call(`window.shopilot.task.list()`)
  run = (tasks?.data || []).find(t => t.id === created.data.id)?.latestRun || null
  if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) break
}
console.log('\n彩排结果:', run?.status, run?.errorCode || '-', String(run?.errorMessage || '').slice(0, 220))

// 逐步骤结果（看 clickAll 跳过了几位、抽屉是否打开、额度读到多少）
const detail = await app.call(`window.shopilot.task.get(${JSON.stringify(created.data.id)})`).catch(() => null)
const results = detail?.data?.latestRun?.steps || detail?.data?.steps || []
for (const st of (Array.isArray(results) ? results : [])) {
  const p = st.payload || {}
  const brief = [p.action, p.skipped, p.clicked ? `clicked=${p.clicked.length}` : '', p.skippedInvited != null ? `skippedInvited=${p.skippedInvited}` : '', p.pageSelected != null ? `pageSelected=${p.pageSelected}` : '', p.text || p.value || ''].filter(Boolean).join(' ')
  console.log(`  [${st.status || '?'}] ${st.type} ${String(brief).slice(0, 150)}`)
}

// 收尾：关掉抽屉（不发送）
const page = (await targets()).find(t => /daren-square/.test(String(t.url)))
if (page) {
  const conn = await connect(page)
  const closed = await conn.ev(`(() => {
    const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
    const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    for (const t of ['关 闭', '关闭', '取消']) {
      const el = all.find(e => own(e) === t && vis(e))
      if (el) { (el.closest('button') || el).click(); return 'clicked:' + t }
    }
    return 'no-close'
  })()`)
  console.log('收尾关抽屉:', closed, '｜textarea:', await conn.ev(`document.querySelectorAll('textarea').length`))
  conn.close()
}
await app.call(`window.shopilot.task.delete(${JSON.stringify(created.data.id)})`).catch(() => null)
app.close()
process.exit(0)
