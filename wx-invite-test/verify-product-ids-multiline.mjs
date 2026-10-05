/**
 * 真机验证：商品ID 改成**多行框**后
 *   ① 是 textarea（不是单行 input）；
 *   ② 已保存的 ID 一行一个显示；
 *   ③ 多行粘贴（换行分隔）能存进配置、换行不丢；
 *   ④ 真正进任务载荷时被拆成**多个商品ID**（ensureRowsById 的 productIds 数组）。
 * 验完还原原值。
 *
 * 用法：node wx-invite-test/verify-product-ids-multiline.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const WX = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
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
  return { ev, call: async x => JSON.parse(await ev(`(async()=>JSON.stringify(await ${x}))()`)), close: () => ws.close() }
}

ensureBundle()
const { buildInviteTaskPayload, normalizeInviteTaskConfig, inviteProfileFor } = await import('./.tmp/probe-entry.mjs')

const list = await targets()
const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
if (!renderer) { console.error('未找到渲染层'); process.exit(1) }
const app = await connect(renderer)

const openPanel = async (storeId) => {
  await app.call(`window.shopilot.browser.display(${JSON.stringify(storeId)})`)
  await sleep(2500)
  await app.ev(`(() => { const el = [...document.querySelectorAll('button,a,[role="tab"],div')].find(e => String(e.textContent||'').trim() === '达人邀约' && e.getBoundingClientRect().width > 0); if (el) (el.closest('button,a,[role="tab"]')||el).click(); return !!el })()`)
  await sleep(2500)
}

await openPanel(WX)
const shape = await app.ev(`(() => {
  const el = document.querySelector('[data-test="invite-product-ids"]')
  if (!el) return JSON.stringify({ exists: false })
  return JSON.stringify({ exists: true, tag: el.tagName, rows: el.getAttribute('rows'), value: String(el.value), valueHasNewline: String(el.value).includes('\\n') })
})()`)
console.log('① 字段形态:', shape)

const key = `invite.config.store.${WX}`
const before = await app.call(`window.shopilot.settings.get(${JSON.stringify(key)})`)
const beforeIds = String(before?.ok ? before.data?.value?.productIds || '' : '')
console.log('原值:', JSON.stringify(beforeIds))

// ② 多行粘贴（模拟从表格整列复制：换行分隔）
const multi = '10000687986563\n10000687986564\n10000687986565'
await app.ev(`(() => { const el = document.querySelector('[data-test="invite-product-ids"]'); el.focus(); el.value = ${JSON.stringify(multi)}; el.dispatchEvent(new Event('input', { bubbles: true })); return el.value })()`)
await sleep(600)
const typed = await app.ev(`document.querySelector('[data-test="invite-product-ids"]').value`)
console.log('② 输入框里的值:', JSON.stringify(typed))
await app.ev(`(() => { const b = document.querySelector('[data-test="invite-save-config"]'); if (b) b.click(); return !!b })()`)
await sleep(2500)
const after = await app.call(`window.shopilot.settings.get(${JSON.stringify(key)})`)
const savedIds = String(after?.ok ? after.data?.value?.productIds || '' : '')
console.log('③ 保存后配置里的值:', JSON.stringify(savedIds), '｜换行保留:', savedIds.includes('\n'))

// ④ 载荷：应拆成 3 个商品ID
const profile = inviteProfileFor('微信小店')
const config = normalizeInviteTaskConfig('assist-form', after.data.value)
const payload = buildInviteTaskPayload({ profile, storeId: WX, squareUrl: profile.pageUrl, config })
const byId = payload?.steps?.[0]?.input?.steps?.find(s => s.type === 'ensureRowsById')
console.log('④ 载荷 ensureRowsById.productIds:', JSON.stringify(byId?.input?.productIds))

// 还原
await app.ev(`(() => { const el = document.querySelector('[data-test="invite-product-ids"]'); el.value = ${JSON.stringify(beforeIds)}; el.dispatchEvent(new Event('input', { bubbles: true })); return el.value })()`)
await sleep(600)
await app.ev(`(() => { const b = document.querySelector('[data-test="invite-save-config"]'); if (b) b.click(); return !!b })()`)
await sleep(2000)
const restored = await app.call(`window.shopilot.settings.get(${JSON.stringify(key)})`)
console.log('还原后:', JSON.stringify(String(restored?.ok ? restored.data?.value?.productIds : '')))
const pass = JSON.parse(shape).tag === 'TEXTAREA' && savedIds.includes('\n') && (byId?.input?.productIds || []).length === 3
console.log(pass ? '✅ 多行商品ID 全链路可用（textarea → 配置 → 载荷 3 个 ID）' : '❌ 有环节未通过')
app.close()
process.exit(0)
