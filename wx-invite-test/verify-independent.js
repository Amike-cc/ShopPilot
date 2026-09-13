/**
 * 验证「达人邀约是独立功能」：
 *  - 邀约运行不出现在「任务列表」
 *  - 出现在邀约面板的「邀约记录」里
 *  - 门禁确认条在任何面板都可见，拒绝后记录显示已取消
 * 端口 9251（临时验证实例）
 */
const PORT = '9251'
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
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const c = await connect((await targets()).find(x => x.title === 'ShopPilot'))
  // 1) 显示仿真店
  await c.ev(`(() => { const card = [...document.querySelectorAll('.store-card')].find(x => x.textContent.includes('微信仿真店')); if (card) card.querySelector('button').click(); return !!card })()`)
  for (let i = 0; i < 12; i++) {
    await sleep(500)
    if (await c.ev(`(() => { const el = document.querySelector('.viewport'); const r = el && el.getBoundingClientRect(); return !!(r && r.width > 300 && r.height > 300) })()`)) break
  }
  // 2) 邀约面板填表并开始
  await c.ev(`(() => { const t = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '任务'); if (t) t.click(); return 1 })()`)
  await sleep(500)
  await c.ev(`(() => { const inv = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '达人邀约'); if (inv) inv.click(); return 1 })()`)
  await sleep(700)
  const started = await c.ev(`(() => {
    const set = (el, v) => { const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
    const q = s => document.querySelector('[data-test=' + s + ']')
    if (!q('invite-start')) return 'no-panel'
    set(q('invite-contact'), '验收联系人'); set(q('invite-wechat'), 'mock_wx001')
    set(q('invite-script'), '您好，我们是仿真验收店铺，诚邀您合作带货，佣金与选品都可协商，期待您的回复！')
    return new Promise(r => setTimeout(() => { const s = q('invite-start'); if (s.disabled) { r('disabled'); return } s.click(); r('started') }, 300))
  })()`)
  console.log('启动邀约:', started)
  if (started !== 'started') throw new Error(started)

  // 3) 等门禁出现（确认条全局可见）
  let confirmVisible = false
  for (let i = 0; i < 30; i++) {
    await sleep(700)
    confirmVisible = await c.ev(`!!document.querySelector('[data-test=task-confirm]')`)
    if (confirmVisible) break
  }
  console.log('门禁确认条可见:', confirmVisible)

  // 4) 检查邀约记录 vs 任务列表
  const invPanel = await c.ev(`(() => {
    const inv = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '达人邀约')
    if (inv) inv.click()
    return 1
  })()`)
  await sleep(700)
  const recordState = await c.ev(`(() => {
    const cards = [...document.querySelectorAll('[data-test=invite-history-card]')]
    return JSON.stringify({ count: cards.length, texts: cards.map(x => x.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60)) })
  })()`)
  console.log('邀约记录:', recordState)

  const listState = await c.ev(`(() => {
    const t = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '任务列表')
    if (t) t.click()
    return 1
  })()`)
  await sleep(700)
  const taskListState = await c.ev(`(() => {
    const cards = [...document.querySelectorAll('.task-card')].filter(x => !x.hasAttribute('data-test'))
    const named = cards.map(x => x.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40))
    return JSON.stringify({ count: cards.length, hasInvite: named.some(t => t.includes('达人邀约')), texts: named.slice(0, 5) })
  })()`)
  console.log('任务列表:', taskListState)

  // 5) 拒绝门禁 → 记录变已取消
  const denied = await c.ev(`(() => { const b = document.querySelector('[data-test=confirm-deny]'); if (!b) return 'no-deny-btn'; b.click(); return 'denied' })()`)
  console.log('门禁拒绝:', denied)
  let finalStatus = null
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    finalStatus = await c.ev(`(async () => {
      const tasks = await window.shopilot.task.list()
      const list = tasks.data.tasks || tasks.data
      const t = list.find(x => x.name.startsWith('达人邀约 ·'))
      return t && t.latestRun ? t.latestRun.status : 'none'
    })()`)
    if (['cancelled', 'failed', 'succeeded'].includes(finalStatus)) break
  }
  console.log('运行终态:', finalStatus)
  c.close()

  const record = JSON.parse(recordState)
  const taskList = JSON.parse(taskListState)
  const fails = []
  if (!confirmVisible) fails.push('门禁确认条不可见')
  if (record.count < 1) fails.push('邀约记录为空')
  if (taskList.hasInvite) fails.push('任务列表里出现了邀约记录')
  if (denied !== 'denied') fails.push('门禁拒绝按钮不可用')
  if (finalStatus !== 'cancelled') fails.push('拒绝后未取消: ' + finalStatus)
  if (fails.length) throw new Error(fails.join('; '))
  console.log('INDEPENDENT-VERIFY: PASS')
}
main().catch(e => { console.error('INDEPENDENT-FAIL:', e.message); process.exit(1) })
