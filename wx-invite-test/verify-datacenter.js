/**
 * 数据中心验证（独立临时实例，端口 9253）：
 *  1. 造数据：建 2 家店铺；跑一个 readText 指标任务（产生 store_snapshots）；跑一条邀约运行
 *  2. 从右栏底部入口打开数据中心，断言：集群概览/平台分布/指标快照/邀约运行/任务运行都有真数据
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const PORT = '9253'
const USER_DATA = path.join(os.tmpdir(), 'shopilot-dc-verify')
const ROOT = path.resolve(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function j(p) { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); return r.json() }
async function targets() { const l = await j('/json/list'); return l.filter(t => t.type === 'page') }
function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  return new Promise((ok, err) => {
    ws.onopen = () => {
      let seq = 0
      const pend = new Map()
      const send = (method, params = {}) => new Promise((ok2, err2) => { const id = ++seq; pend.set(id, m => m.error ? err2(new Error(JSON.stringify(m.error))) : ok2(m.result)); ws.send(JSON.stringify({ id, method, params })) })
      ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
      ok({
        ev: async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value },
        close: () => { try { ws.close() } catch { /* */ } }
      })
    }
    ws.onerror = err
  })
}

async function main() {
  fs.rmSync(USER_DATA, { recursive: true, force: true })
  const app = spawn(ELECTRON, ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + USER_DATA,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
    { cwd: ROOT, stdio: 'ignore' })
  const fails = []
  try {
    for (let i = 0; i < 40; i++) { try { await j('/json/version'); break } catch { await sleep(500) } }
    await sleep(2000)
    let c = await connect((await targets()).find(t => t.title === 'ShopPilot'))
    // ---- 造数据 ----
    const seeded = await c.ev(`(async () => {
      const out = {}
      const mk = async (name, platform, adminUrl) => {
        const r = await window.shopilot.store.create({ name, platform, adminUrl })
        return r.ok ? r.data.id : null
      }
      const wx = await mk('数据中心-微信店', '微信小店', 'http://127.0.0.1:8765')
      const dd = await mk('数据中心-抖店', '抖店', 'https://fxg.jinritemai.com')
      out.stores = [wx, dd].filter(Boolean).length
      // 指标任务：读仿真页的「今日剩余N次」写入快照
      await window.shopilot.browser.open(wx)
      await window.shopilot.browser.tab.create(wx, 'http://127.0.0.1:8765/wx-mock/initiate-invite?finderUsername=dc@finder')
      await new Promise(r => setTimeout(r, 2500))
      const t = await window.shopilot.task.create({
        name: '指标采集验证', storeScope: wx,
        steps: [
          { type: 'navigate', input: { url: 'http://127.0.0.1:8765/wx-mock/initiate-invite?finderUsername=dc@finder' }, timeoutMs: 20000 },
          { type: 'waitForPage', input: { urlIncludes: '8765' }, timeoutMs: 15000 },
          { type: 'waitForSelector', input: { selector: '#quota', deep: true }, timeoutMs: 15000 },
          { type: 'readText', input: { selector: '#quota', deep: true, metric: 'invite.quota' }, timeoutMs: 15000 }
        ]
      })
      if (!t.ok) { out.taskErr = JSON.stringify(t.error); return JSON.stringify(out) }
      await window.shopilot.task.run(t.data.id)
      await new Promise(r => setTimeout(r, 7000))
      // 邀约运行记录（名称前缀触发「邀约运行」统计）
      const inv = await window.shopilot.task.create({
        name: '达人邀约 · 微信小店 · 数据中心验证', storeScope: wx,
        steps: [{ type: 'waitForPage', input: { urlIncludes: '8765' }, timeoutMs: 10000 }]
      })
      if (inv.ok) { await window.shopilot.task.run(inv.data.id); await new Promise(r => setTimeout(r, 5000)) }
      const dc = await window.shopilot.overview.datacenter()
      out.apiOk = dc.ok
      if (dc.ok) {
        out.totals = dc.data.totals
        out.platforms = dc.data.byPlatform
        out.snapshots = dc.data.snapshots.length
        out.inviteByStatus = dc.data.invite.byStatus.length
        out.runsByStatus = dc.data.runs.byStatus.length
      }
      return JSON.stringify(out)
    })()`)
    console.log('造数据结果:', seeded)
    c.close()
    const seed = JSON.parse(seeded)
    if (seed.stores < 2) fails.push('店铺未建成: ' + seeded)
    if (!seed.apiOk) fails.push('overview:datacenter 调用失败')
    if (!seed.snapshots) fails.push('没有产生指标快照（readText metric 链路）')

    // ---- 界面入口 + 弹窗渲染 ----
    c = await connect((await targets()).find(t => t.title === 'ShopPilot'))
    await c.ev(`location.reload();1`)
    await sleep(3000)
    c.close()
    c = await connect((await targets()).find(t => t.title === 'ShopPilot'))
    await c.ev(`(() => { const card = [...document.querySelectorAll('.store-card')].find(x => x.textContent.includes('数据中心-微信店')); if (card) card.querySelector('button').click(); return !!card })()`)
    for (let i = 0; i < 12; i++) {
      await sleep(500)
      if (await c.ev(`!!document.querySelector('.viewport')`)) break
    }
    const entry = await c.ev(`(() => {
      const row = document.querySelector('[data-test=datacenter-open]')
      if (!row) return 'NO-ENTRY'
      const r = row.getBoundingClientRect()
      const panel = document.querySelector('[data-test=right-panel]').getBoundingClientRect()
      return JSON.stringify({ text: row.textContent.replace(/\\s+/g, ' ').trim(), bottomGap: Math.round(panel.bottom - r.bottom), fullWidth: Math.round(r.width) + '/' + Math.round(panel.width) })
    })()`)
    console.log('入口行:', entry)
    if (entry === 'NO-ENTRY') { fails.push('右栏底部没有数据中心入口行'); throw new Error(fails.join('; ')) }

    await c.ev(`document.querySelector('[data-test=datacenter-open]').click();1`)
    await sleep(2000)
    const modal = await c.ev(`(() => {
      const m = document.querySelector('[data-test=datacenter-modal]')
      if (!m) return 'NO-MODAL'
      const nums = [...m.querySelectorAll('.dc-num')].map(e => e.textContent.trim())
      const chips = [...m.querySelectorAll('.dc-chip')].map(e => e.textContent.trim())
      const rows = [...m.querySelectorAll('.dc-table tbody tr')].map(r => r.textContent.replace(/\\s+/g, ' ').trim().slice(0, 70))
      const heads = [...m.querySelectorAll('.env-h')].map(e => e.textContent.replace(/\\s+/g, ' ').trim().slice(0, 24))
      const empties = [...m.querySelectorAll('.empty-hint')].map(e => e.textContent.trim().slice(0, 30))
      return JSON.stringify({ nums, heads, chips, rowCount: rows.length, rows: rows.slice(0, 6), empties })
    })()`)
    console.log('数据中心弹窗:', modal)
    if (modal === 'NO-MODAL') { fails.push('数据中心弹窗没打开'); throw new Error(fails.join('; ')) }
    const mm = JSON.parse(modal)
    if (!mm.heads.some(h => h.includes('指标快照'))) fails.push('弹窗缺「指标快照」区块')
    if (!mm.rows.some(r => r.includes('invite.quota') || r.includes('指标'))) fails.push('指标快照表里没有数据行')
    if (!mm.chips.length) fails.push('平台/状态分布 chips 为空')
    await c.ev(`document.querySelector('[data-test=datacenter-close]').click();1`)
    await sleep(500)
    const closed = await c.ev(`!document.querySelector('[data-test=datacenter-modal]')`)
    if (!closed) fails.push('弹窗关不掉')
    c.close()
  } finally {
    try { app.kill() } catch { /* */ }
  }
  if (fails.length) { console.error('DATACENTER-FAIL:', fails.join(' | ')); process.exit(1) }
  console.log('DATACENTER-VERIFY: PASS')
}
main().catch(e => { console.error('DATACENTER-ERROR:', e.message); process.exit(1) })
