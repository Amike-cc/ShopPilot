/** 直接调 task.create，用与微信 builder 相同的 loop 步骤，打印主进程校验错误 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'
const loopStep = {
  type: 'loop',
  input: {
    label: '诊断',
    maxRounds: 3,
    stopOn: ['TASK_QUOTA_EXCEEDED', 'TASK_SELECTION_SHORTFALL'],
    steps: [
      { type: 'navigate', input: { url: 'https://store.weixin.qq.com/shop/findersquare/find' }, timeoutMs: 45000 },
      { type: 'waitForPage', input: { urlIncludes: 'find' }, timeoutMs: 45000 },
      { type: 'clickByText', input: { text: '直播带货者', deep: true, mode: 'real' }, timeoutMs: 25000 },
      { type: 'clickByText', input: { text: '母婴', deep: true, mode: 'real', missingCode: 'TASK_SELECTION_SHORTFALL' }, timeoutMs: 25000 },
      { type: 'waitForText', input: { text: '详情', deep: true }, timeoutMs: 30000 },
      { type: 'clickByText', input: { text: '详情', deep: true, mode: 'real', missingCode: 'TASK_SELECTION_SHORTFALL' }, timeoutMs: 30000 },
      { type: 'requireQuota', input: { textIncludes: '今日剩余', min: 1, metric: 'invite.quota', deep: true }, timeoutMs: 30000 }
    ]
  }
}
async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
  const app = list.find(x => x.title === 'ShopPilot')
  const ws = new WebSocket(app.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const ev = (expr) => new Promise((ok, err) => {
    const id = ++s
    pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error).slice(0, 300))) : ok(m.result?.result?.value))
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true } }))
  })
  const out = await ev(`(async () => {
    const r = await window.shopilot.task.create({
      name: '诊断 · loop 校验',
      storeScope: '${STORE}',
      steps: ${JSON.stringify([loopStep])}
    })
    return JSON.stringify(r)
  })()`)
  console.log('create 结果:', out)
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
