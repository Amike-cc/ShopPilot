/**
 * 读当前广场页里的**全部达人昵称**，把它们当作"近 7 天已邀"写进探针副本的台账 + 店铺配置。
 *
 * 为什么这么做：广场列表每次加载都重新洗牌，按"上一次看到的昵称"去种必然对不上。
 * 把当前页全部种上之后，无论怎么洗牌，这一页的行都应该被引擎跳过
 * （全被跳过时会翻页继续找 —— 那正是我们想验证的路径）。
 *
 * 用法：node wx-invite-test/probe-seed-current-page.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())

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
  return { ev, call: async x => JSON.parse(await ev(`(async()=>JSON.stringify(await ${x}))()`)), close: () => ws.close() }
}

const NAMES = `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const rows = all.filter(e => e.tagName === 'TR' && vis(e))
  const out = []
  for (const tr of rows) {
    const n = tr.querySelector('td .truncate')
    const name = n ? String(n.innerText || '').replace(/\\s+/g, ' ').trim() : ''
    if (name) out.push(name.slice(0, 120))
  }
  return JSON.stringify([...new Set(out)])
})()`

const list = await targets()
const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
const app = await connect(renderer)
await app.call(`window.shopilot.browser.display('${STORE}')`)
await sleep(1500)
const tabs = (await app.call(`window.shopilot.browser.tab.list('${STORE}')`))?.data?.tabs || []
const square = tabs.find(t => /findersquare\/find$/.test(String(t.url)))
if (square) { await app.call(`window.shopilot.browser.tab.activate('${STORE}', '${square.id}')`); await sleep(3500) }
else { await app.call(`window.shopilot.browser.tab.create('${STORE}', '${SQUARE}')`); await sleep(10000) }

const page = (await targets()).find(t => /findersquare\/find/.test(String(t.url)))
if (!page) { console.error('没有广场页目标'); process.exit(1) }
/**
 * 广场列表每次加载都重新洗牌，单次取样必然对不上下一轮 —— 所以**多加载几次、把看到的昵称全收集起来**，
 * 再一起种进台账。这样新页面里大概率命中若干行，"跳过"才验得出来。
 */
const LOADS = Math.max(1, Number(process.env.COLLECT_LOADS || 8))
const seen = new Set()
for (let round = 0; round < LOADS; round++) {
  if (round > 0) {
    await app.call(`window.shopilot.browser.navigate('${STORE}', ${JSON.stringify(square?.id || '')}, '${SQUARE}')`).catch(() => null)
    await sleep(6000)
  }
  const target = (await targets()).find(t => /findersquare\/find/.test(String(t.url)))
  if (!target) continue
  const conn = await connect(target)
  for (let i = 0; i < 8; i++) {
    const raw = await conn.ev(NAMES).catch(() => null)
    if (raw) { for (const n of JSON.parse(raw)) seen.add(n); if (seen.size) break }
    await sleep(1500)
  }
  conn.close()
  console.log(`  第 ${round + 1}/${LOADS} 次加载：累计 ${seen.size} 位`)
}
const names = [...seen]
if (!names.length) { console.error('没读到任何达人昵称'); process.exit(1) }
console.log(`共收集 ${names.length} 位：${names.slice(0, 5).join(' / ')} …`)

// ① 昵称清单落盘（better-sqlite3 是按 Electron ABI 编译的，普通 node 加载不了 →
//    台账写入交给 seed-probe-ledger.cjs 用 Electron 的 node 跑）
const outFile = path.resolve('wx-invite-test/evidence/seeded-recent-names.json')
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, JSON.stringify({ seededAt: new Date().toISOString(), names }, null, 1))
console.log('昵称清单已落盘:', outFile)

// ② 写店铺配置的 recentlyInvited（面板正常是开跑时临时传，不落配置）
const key = `invite.config.store.${STORE}`
const current = await app.call(`window.shopilot.settings.get(${JSON.stringify(key)})`)
const value = current?.ok ? (current.data?.value || {}) : {}
value.recentlyInvited = names
const saved = await app.call(`window.shopilot.settings.set(${JSON.stringify(key)}, ${JSON.stringify(value)})`)
console.log(saved?.ok ? `配置已写入 recentlyInvited（${names.length} 条）` : `配置写入失败: ${JSON.stringify(saved?.error)}`)
app.close()
process.exit(0)
