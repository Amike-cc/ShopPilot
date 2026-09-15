/**
 * 快手邀约「发送前彩排」：把 ks-steps.json（由面板同一份构造逻辑生成）提交给**真实任务引擎**执行，
 * 只把最后一步「发送邀请」换成截图（waitForGone 一并去掉），maxRounds=1。
 *
 * 为什么这样做：邀请会真实发给达人（不可撤回），未获授权不点发送。
 * 其余每一步都是真页面、真点击、真输入：类目级联 + 内容标签 + 合作信息 → 搜索 →
 * 逐个勾选（minSelect=2 下限）→ 批量邀约开抽屉 → 额度预检 → 填写联系方式/话术 →
 * 商品弹窗选择 → 合作标签。跑完把每步结果如实打印，并截图留证。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 400) : r.result?.value
}

// 读取步骤 → 替换发送
const steps = JSON.parse(fs.readFileSync('wx-invite-test/ks-steps.json', 'utf8'))
const loop = steps[0]
const inner = loop.input.steps
const sendIdx = inner.findIndex(x => x.type === 'clickByText' && x.input && x.input.text === '发送邀请')
if (sendIdx < 0) { console.log('步骤里没有发送邀请'); process.exit(1) }
inner.splice(sendIdx, 1)
const goneIdx = inner.findIndex(x => x.type === 'waitForGone')
if (goneIdx >= 0) inner.splice(goneIdx, 1)
inner.push({ type: 'screenshot', input: {}, timeoutMs: 20000 })
loop.input.maxRounds = 1
loop.input.stopOn = []
console.log('彩排步骤数:', inner.length, '（已把「发送邀请」替换为截图）')

const stores = JSON.parse(await ev(`(async()=>{const r=await window.shopilot.store.list();return JSON.stringify((r.data||[]).map(x=>({id:x.id,name:x.name,platform:x.platform})))})()`))
const ks = stores.find(x => String(x.platform).includes('快手'))
await ev(`(async()=>{await window.shopilot.browser.open('${ks.id}');await window.shopilot.browser.display('${ks.id}');return 1})()`)
await sleep(2500)

console.log('\n=== 创建并运行彩排任务 ===')
const created = JSON.parse(await ev(`(async () => {
  const r = await window.shopilot.task.create(${JSON.stringify({ name: '邀约彩排 · 快手小店 · 不发送', storeScope: null, steps })}.storeScope ? ${JSON.stringify({ name: '邀约彩排 · 快手小店 · 不发送', storeScope: null, steps })} : {})
  return JSON.stringify(r)
})()`))
console.log('create 原始返回:', JSON.stringify(created).slice(0, 300))
