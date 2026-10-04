/**
 * 把"近 7 天已邀"昵称写进**探针副本**的店铺配置（recentlyInvited），
 * 用于验证"点「详情」前跳过已邀达人"这条规则（面板正常是在开跑时临时传，不落配置）。
 *
 * 用法：node wx-invite-test/inject-probe-recent.mjs [昵称...]
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const nicknames = process.argv.slice(2)
if (!nicknames.length) { console.error('用法: inject-probe-recent.mjs <昵称...>'); process.exit(1) }

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
if (!renderer) { console.error('未找到应用渲染层'); process.exit(1) }
const ws = new WebSocket(renderer.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (method, params = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method, params })) })
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200)); return r.result.value }
const call = async expr => JSON.parse(await ev(`(async()=>JSON.stringify(await ${expr}))()`))

const key = `invite.config.store.${STORE}`
const current = await call(`window.shopilot.settings.get(${JSON.stringify(key)})`)
const value = current?.ok ? (current.data?.value || {}) : {}
value.recentlyInvited = nicknames
const saved = await call(`window.shopilot.settings.set(${JSON.stringify(key)}, ${JSON.stringify(value)})`)
console.log(saved?.ok ? `已写入配置 ${key}.recentlyInvited = ${JSON.stringify(nicknames)}` : `写入失败: ${JSON.stringify(saved?.error)}`)
ws.close()
process.exit(0)
