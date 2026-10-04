/**
 * 「不发邀约」的完整彩排：跑真实生成的单轮步骤，但**砍掉发送那两步**（发送邀约 / 确认）
 *
 * 验证两件在真机发送时观察到、但发送会掩盖掉的事：
 *   ① 本次运行用的那个广场页是否**保住了筛选**（fix：useTab 记住本次运行的标签页，
 *      而不是按地址挑到用户那个没筛选的老广场页）；
 *   ② 一轮跑完后**没有标签页泄漏**（fix：切回广场时要关掉用完的详情/表单页）。
 * 顺带读回表单页里代填的内容（联系方式/话术）与已添加商品数，确认写真的写进去了。
 *
 * 用法：node wx-invite-test/wx-invite-rehearse-no-send.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'
const OUT_DIR = path.resolve('wx-invite-test/evidence')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function ensureProbeBundle() {
  const out = path.resolve('wx-invite-test/.tmp/probe-entry.mjs')
  const entry = path.resolve('wx-invite-test/probe-entry.ts')
  // 每次都重新打包：避免"改了 shared 却验证旧步骤集"（send-one 里踩过一次）
  const esbuildDir = fs.readdirSync(path.resolve('node_modules/.pnpm')).find(n => n.startsWith('esbuild@'))
  const bin = path.resolve('node_modules/.pnpm', esbuildDir, 'node_modules/esbuild/bin/esbuild')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const res = spawnSync(process.execPath, [bin, entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${out}`], { stdio: 'inherit' })
  if (res.status !== 0) throw new Error('打包失败')
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (method, params = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method, params })) })
  const ev = async (expr, timeoutMs = 30000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 超时')), timeoutMs))])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  return { ev, call: async (expr) => JSON.parse(await ev(`(async () => JSON.stringify(await ${expr}))()`)), close: () => ws.close() }
}
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())

const SQUARE_STATE = `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const rowOf = t => { for (const el of all) { if (own(el) !== t) continue; return el.closest('.weui-desktop-form__control-group') } return null }
  const checkedIn = row => row ? [...row.querySelectorAll('label')].filter(el => { const i = el.querySelector('input'); return i && i.checked }).map(el => String(el.innerText || '').replace(/\\s+/g, ' ').trim()) : []
  const tab = all.find(el => el.tagName === 'LI' && /weui-desktop-tab__nav_current/.test(String(el.className || '')))
  return JSON.stringify({ finderType: tab ? String(tab.innerText || '').replace(/\\s+/g, ' ').trim() : null, others: checkedIn(rowOf('其他筛选')), categories: checkedIn(rowOf('带货类目')) })
})()`

const FORM_STATE = `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(r || document)
  const q = sel => { for (const e of all) { if (e.matches && e.matches(sel)) return e } return null }
  const val = sel => { const el = q(sel); return el ? String(el.value == null ? el.textContent : el.value).slice(0, 30) : null }
  const text = all.map(e => String(e.innerText || '')).join(' ').replace(/\\s+/g, ' ')
  const goods = (text.match(/已添加\\s*\\d+\\/\\d+/) || text.match(/已选商品\\s*\\d+/) || [])[0] || null
  return JSON.stringify({
    url: location.href,
    contact: val('input[placeholder*="邀约联系人"]'),
    wechat: val('input[placeholder*="微信号"]'),
    phone: val('input[placeholder*="手机号码"]'),
    script: val('textarea[placeholder*="合作说明"]'),
    goodsMarker: goods
  })
})()`

async function main() {
  ensureProbeBundle()
  const { buildInviteTaskPayload, inviteProfileFor, normalizeInviteTaskConfig } = await import('./.tmp/probe-entry.mjs')
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const list = await targets()
  const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  const app = await connect(renderer)
  const storeCfg = await app.call(`window.shopilot.settings.get('invite.config.store.${STORE}')`)
  const raw = storeCfg?.ok ? storeCfg.data.value : {}
  const profile = inviteProfileFor('微信小店')
  const config = normalizeInviteTaskConfig('assist-form', raw)
  // 话术模式默认**按店铺配置**（AI 模式就用 AI）；只有显式 WX_SCRIPT_MODE=manual 才覆盖，
  // 用于"AI 不可用时先把邀约闭环跑通"的场景。
  if (process.env.WX_SCRIPT_MODE === 'manual') config.scriptMode = 'manual'
  console.log('话术模式:', config.scriptMode)
  const payload = buildInviteTaskPayload({ profile, storeId: STORE, squareUrl: SQUARE, config })
  if (!payload) throw new Error('载荷构造失败')
  const loop = payload.steps[payload.steps.length - 1]
  const rounds = Math.max(1, Number(process.env.REHEARSE_ROUNDS || 1))
  loop.input.maxRounds = rounds
  const sendIndex = loop.input.steps.findIndex(s => s.type === 'clickByText' && String(s.input.text) === profile.texts.sendInvite)
  const before = sendIndex >= 0 ? loop.input.steps.slice(0, sendIndex) : loop.input.steps
  loop.input.steps = before
  console.log('彩排步骤（已砍掉发送）:', before.map(s => s.type).join(' → '))
  payload.name = `${payload.name} · 彩排不发`.slice(0, 80)

  await app.call(`window.shopilot.browser.display('${STORE}')`)
  await sleep(1500)
  // 清掉上一轮彩排遗留的详情/表单页：引擎会复用"上一轮那个运行标签页"，停在表单页上时
  // 本轮第一步的 navigate 之后若页面渲染慢，筛选点击会白等到超时（探针环境实测）。
  const stale = ((await app.call(`window.shopilot.browser.tab.list('${STORE}')`))?.data?.tabs || [])
    .filter(t => /finder-detail|initiate-invite/.test(String(t.url)))
  for (const t of stale) await app.call(`window.shopilot.browser.tab.close('${STORE}', '${t.id}')`).catch(() => null)
  if (stale.length) { console.log('清理遗留标签页:', stale.length); await sleep(1500) }
  // 造出"用户已打开广场页"的真实前置
  const tabs0 = await app.call(`window.shopilot.browser.tab.list('${STORE}')`)
  const firstTab = tabs0?.data?.activeTabId || (tabs0?.data?.tabs || [])[0]?.id
  if (firstTab) { await app.call(`window.shopilot.browser.navigate('${STORE}', '${firstTab}', '${SQUARE}')`).catch(() => null); await sleep(6000) }
  const countBefore = ((await app.call(`window.shopilot.browser.tab.list('${STORE}')`))?.data?.tabs || []).length
  const idsBefore = new Set(((await app.call(`window.shopilot.browser.tab.list('${STORE}')`))?.data?.tabs || []).map(t => t.id))
  console.log('跑之前标签页数:', countBefore)

  const created = await app.call(`window.shopilot.task.create(${JSON.stringify({ name: payload.name, storeScope: STORE, steps: payload.steps })})`)
  if (!created?.ok) throw new Error('创建失败: ' + JSON.stringify(created?.error))
  await app.call(`window.shopilot.task.run(${JSON.stringify(created.data.id)})`)
  let run = null
  for (let i = 0; i < 100; i++) {
    await sleep(3000)
    const tasks = await app.call(`window.shopilot.task.list()`)
    run = (tasks?.data || []).find(t => t.id === created.data.id)?.latestRun || null
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) break
  }
  console.log('彩排结果:', run?.status, run?.errorCode || '-', String(run?.errorMessage || '').slice(0, 200))
  if (run?.id) {
    const detail = await app.call(`window.shopilot.task.results(${JSON.stringify(run.id)})`)
    const loopRow = (detail?.data?.results || []).find(r => String(JSON.stringify(r.payload)).includes('completedRounds'))
    const p = loopRow ? loopRow.payload : null
    console.log('轮次汇总:', JSON.stringify(p ? { maxRounds: p.maxRounds, completedRounds: p.completedRounds, stopReason: p.stopReason, rounds: p.rounds } : null))
  }

  const countAfter = ((await app.call(`window.shopilot.browser.tab.list('${STORE}')`))?.data?.tabs || []).length
  const tabsNow = (await app.call(`window.shopilot.browser.tab.list('${STORE}')`))?.data?.tabs || []
  const added = tabsNow.filter(t => !idsBefore.has(t.id)).map(t => `${t.id} ${String(t.url).slice(0, 90)}`)
  const removed = [...idsBefore].filter(id => !tabsNow.some(t => t.id === id)).length
  console.log('跑之后标签页数:', countAfter, '（增量', countAfter - countBefore, '｜新增', added.length, '｜关闭', removed, '）')
  for (const a of added) console.log('   +', a)

  // 逐个广场标签页找"带着筛选"的那个
  const tabs = await app.call(`window.shopilot.browser.tab.list('${STORE}')`)
  const squareTabs = (tabs?.data?.tabs || []).filter(t => /findersquare\/find$/.test(String(t.url)))
  console.log('广场标签页数:', squareTabs.length)
  for (const tab of squareTabs) {
    await app.call(`window.shopilot.browser.tab.activate('${STORE}', '${tab.id}')`).catch(() => null)
    await sleep(3200)
    const page = (await targets()).find(t => /findersquare\/find/.test(String(t.url)))
    if (!page) continue
    const conn = await connect(page)
    const text = await conn.ev(SQUARE_STATE)
    conn.close()
    const state = JSON.parse(text)
    if (state.finderType !== '全部带货者' || state.others.length) console.log('★ 带筛选的广场页:', tab.id, text)
  }

  // 表单页：代填内容是否真的写进去了
  const formPage = (await targets()).find(t => /initiate-invite/.test(String(t.url)))
  if (formPage) {
    const conn = await connect(formPage)
    console.log('表单页:', await conn.ev(FORM_STATE))
    conn.close()
  } else {
    console.log('（没找到邀约表单页：可能已被关闭）')
  }

  await app.call(`window.shopilot.task.delete(${JSON.stringify(created.data.id)})`).catch(() => null)
  app.close()
  process.exit(0)
}

main().catch(err => { console.error('ERR', err.stack || err.message); process.exit(1) })
