/**
 * 真机实测（**真实店铺库 + 真实登录态**）：在发票中心点「获取主体营业执照」，
 * 软件自己去平台后台把本店主体（营业执照）读回来并写进店铺。
 *
 * 为什么必须在真实 userData 上跑：主体信息页要**登录态**，隔离的临时 userData 必然落到登录页。
 * 采集是只读步骤（navigate + readLabelValue）；写回只改 stores 的 license_name/license_no 两列。
 * 证据输出把统一社会信用代码**打码**（只留前 4 后 4），避免把证件号写进仓库文件。
 *
 * 用法：node wx-invite-test/entity-collect-real-verify.mjs [CDP端口]
 */
import { spawn, execSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const PORT = process.argv[2] || '9250'
const DB = path.join(process.env.APPDATA, 'shopilot', 'shopilot.db')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const mask = v => (v && v.length > 8 ? v.slice(0, 4) + '*'.repeat(v.length - 8) + v.slice(-4) : (v || ''))

const say = m => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${m}\n`)
// 证据文件要进仓库 → 统一社会信用代码一律打码后再打印（含 check 的 detail）
const dmask = s => String(s ?? '').replace(/[0-9A-Z]{18}/g, m => mask(m))
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + dmask(detail) : ''}`)
}
function stores() {
  const db = new DatabaseSync(DB)
  try { return db.prepare('SELECT id,name,platform,license_name,license_no FROM stores WHERE deleted_at IS NULL ORDER BY platform').all() }
  finally { db.close() }
}

// ---- 起应用（单实例互斥：先清残留、等它彻底退出） ----
try { execSync('taskkill /IM electron.exe /F', { stdio: 'ignore' }) } catch { /* 没有残留 */ }
await sleep(3000)
const app = spawn(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  [root, '--no-sandbox', `--remote-debugging-port=${PORT}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
  { cwd: root, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' } })
say(`应用已启动 pid=${app.pid}`)

let cdpUp = false
for (let i = 0; i < 60 && !cdpUp; i++) {
  try { cdpUp = (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) })).ok } catch { /* retry */ }
  if (!cdpUp) await sleep(500)
}
if (!cdpUp) { console.error('调试端口没起来'); try { execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: 'ignore' }) } catch { /* gone */ } ; process.exit(1) }
say('调试端口就绪')
await sleep(1500)

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) })).json()
const uiTarget = targets.find(t => t.type === 'page' && t.url.includes('/renderer/index.html'))
if (!uiTarget) { console.error('没找到渲染层目标'); process.exit(1) }

const ws = new WebSocket(uiTarget.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = e => err(new Error('ws 连不上 ' + (e?.message || ''))) })
let seq = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); const p = pend.get(m.id); if (p) { pend.delete(m.id); p(m) } }
function q(expr, timeoutMs = 20000) {
  return new Promise((ok, err) => {
    const id = ++seq
    const to = setTimeout(() => { pend.delete(id); err(new Error('评估超时: ' + expr.slice(0, 60))) }, timeoutMs)
    pend.set(id, m => { clearTimeout(to); m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result?.result?.value) })
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true, userGesture: true } }))
  })
}
const CHIPS = `return [...document.querySelectorAll('[data-test="invoice-license-bar"] .inv-lic-chip')].map(el => el.textContent.replace(/\\s+/g, ' ').trim())`
const REPORT = `return document.querySelectorAll('[data-test^="invoice-entity-result-"]').length ? [...document.querySelectorAll('[data-test^="invoice-entity-result-"]')].map(el => el.textContent.replace(/\\s+/g, ' ').trim()) : null`

function cleanup() {
  try { ws.close() } catch { /* ignore */ }
  try { execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: 'ignore' }) } catch { /* gone */ }
}

try {
  say('等店铺列表加载')
  for (let i = 0; i < 30; i++) {
    if (await q(`document.querySelectorAll('[data-test="store-card"]').length`) >= 4) break
    await sleep(500)
  }
  const ksBefore = stores().find(s => s.platform === '快手小店')
  console.log(`=== 真机实测：获取主体营业执照（真实库；快手店=${ksBefore?.name}，实测前主体=${ksBefore?.license_name || '未填写'}） ===`)

  // 1. 打开发票中心（走界面入口）
  await q(`document.querySelector('[data-test="invoice-center-open"]').click(); return true`)
  for (let i = 0; i < 30; i++) {
    if (await q(`!!document.querySelector('[data-test="invoice-license-bar"]')`)) break
    await sleep(500)
  }
  say('发票中心已打开')

  const unsupported = await q(`return [...document.querySelectorAll('[data-test^="invoice-entity-unsupported-"]')].map(el => el.textContent.replace(/\\s+/g, ' ').trim())`)
  check('未实测平台在界面上逐家说明原因（微信＝悬浮卡读不到、抖店＝未登录、拼多多＝登录态过期）',
    unsupported.length === 3 && unsupported.some(l => l.includes('悬浮卡')) &&
    unsupported.some(l => l.includes('未登录')) && unsupported.some(l => l.includes('登录态已过期')),
    JSON.stringify(unsupported.map(l => l.slice(0, 44))))

  // 2. 点「获取主体营业执照」（采集 + 写回，最多等 150 秒）
  say('点「获取主体营业执照」，采集中…')
  await q(`document.querySelector('[data-test="invoice-entity-fetch"]').click(); return true`)
  let report = null
  for (let i = 0; i < 75 && !report; i++) { await sleep(2000); report = await q(REPORT) }
  say('结果已出')
  check('界面给出逐店结果（4 家各一行）', Array.isArray(report) && report.length === 4, JSON.stringify((report || []).map(r => r.slice(0, 56))))

  const ksRow = (report || []).find(r => r.startsWith('福气满满'))
  // 首次跑报「已填入」；若这家之前已经填过（或本次是重跑）则报「与已填一致」——两种都算通
  check('快手店：平台读到的主体已落到店铺营业执照', !!ksRow && (ksRow.includes('已填入') || ksRow.includes('与已填一致')), ksRow || '(没有该行)')
  check('未实测的三家如实报「该平台暂不能自动获取」', (report || []).filter(r => r.includes('该平台暂不能自动获取')).length === 3,
    JSON.stringify((report || []).filter(r => r.includes('暂不能')).map(r => r.slice(0, 26))))

  // 3. 库里真的写上了（读真值，不看界面文案）
  const ks = stores().find(s => s.platform === '快手小店')
  check('真实库：主体名称已写入', !!ks.license_name && ks.license_name.length >= 4, `name=${ks.license_name}`)
  check('真实库：统一社会信用代码已写入且形态正确（18 位字母数字、不是掩码）', /^[0-9A-Z]{18}$/.test(ks.license_no || ''), `no=${mask(ks.license_no)}`)
  check('其余三家一个字都没被误写', stores().filter(s => s.platform !== '快手小店').every(s => !s.license_name && !s.license_no),
    JSON.stringify(stores().filter(s => s.platform !== '快手小店').map(s => [s.platform, s.license_name])))

  // 4. 任务成功 + 两个指标落库（页面上没有「企业名称」这一行时任务不该失败 → absentOk 生效）
  const info = await q(`
    const list = await window.shopilot.task.list()
    const all = list.data.tasks || list.data || []
    const t = all.find(x => String(x.name || '').includes('主体信息采集'))
    const snaps = t ? (await window.shopilot.snapshot.list(t.storeScope, 50)) : null
    return { name: t?.name || null, status: t?.latestRun?.status || null,
      metrics: snaps && snaps.ok ? (snaps.data || []).map(s => ({ metric: s.metric, value: String(s.value).slice(0, 24) })) : [] }
  `)
  check('采集任务成功结束（「企业名称」这一行不存在不算失败——absentOk 生效）', info.status === 'succeeded', JSON.stringify({ name: info.name, status: info.status }))
  const metrics = [...new Map((info.metrics || []).filter(m => m.metric.startsWith('entity.')).map(m => [m.metric, m])).values()]
  check('落库了 entity.name / entity.no 两个指标', metrics.some(m => m.metric === 'entity.name') && metrics.some(m => m.metric === 'entity.no'),
    JSON.stringify(metrics.map(m => [m.metric, m.metric === 'entity.no' ? mask(m.value) : m.value])))

  // 5. 再跑一次：幂等（一致就不动）
  say('再点一次（验证幂等）')
  await q(`document.querySelector('[data-test="invoice-entity-report-close"]')?.click(); return true`)
  await q(`document.querySelector('[data-test="invoice-entity-fetch"]').click(); return true`)
  let report2 = null
  for (let i = 0; i < 75 && !report2; i++) { await sleep(2000); report2 = await q(REPORT) }
  const ksRow2 = (report2 || []).find(r => r.startsWith('福气满满'))
  check('第二次跑报「与已填一致」，没有重复写入', !!ksRow2 && ksRow2.includes('与已填一致'), ksRow2 || '(没有该行)')
  const ks2 = stores().find(s => s.platform === '快手小店')
  check('库里值没变（幂等）', ks2.license_name === ks.license_name && ks2.license_no === ks.license_no)

  // 6. 发票中心按营业执照分账：快手店现在单独成一个主体
  const chips = await q(CHIPS)
  check('筛选条上出现该主体（1 家）+ 未填写（3 家）',
    chips.length === 3 && chips[1].includes(ks.license_name) && chips[1].includes('1 家') &&
    chips[2].includes('未填写营业执照') && chips[2].includes('3 家'), JSON.stringify(chips))

  // 7. 卡片上并排展示"平台读到的主体"，便于与手填值核对
  const lines = await q(`return [...document.querySelectorAll('[data-test^="invoice-platform-entity-"]')].map(x => x.textContent.replace(/\\s+/g, ' ').trim())`)
  check('卡片显示平台读到的主体（可核对）', lines.length === 1 && lines[0].includes(ks.license_name), JSON.stringify(lines.map(l => l.slice(0, 40))))

  console.log('\n证据（统一社会信用代码已打码）：')
  console.log(JSON.stringify({
    store: ks.name, license_name: ks.license_name, license_no: mask(ks.license_no),
    report: (report || []).map(r => r.replace(/[0-9A-Z]{18}/g, m => mask(m))),
    metrics: metrics.map(m => [m.metric, m.metric === 'entity.no' ? mask(m.value) : m.value])
  }, null, 1))
} catch (e) {
  console.error('实测中断：' + (e.stack || e))
  results.push({ name: '实测未跑完', ok: false })
} finally {
  cleanup()
}

const passed = results.filter(r => r.ok).length
console.log(`\n通过 ${passed}/${results.length}`)
process.exit(passed === results.length && results.length ? 0 : 1)
