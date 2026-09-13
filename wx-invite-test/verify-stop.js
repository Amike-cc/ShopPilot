/** 验证「停止邀约」：填表 → 开始 → 面板出现停止按钮 → 点停止 → 运行取消且面板回到可开始 */
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
  // 1) 点店铺卡片，等工作台视口
  await c.ev(`(() => { const card = [...document.querySelectorAll('.store-card')].find(x => x.textContent.includes('微信仿真店')); if (card) card.querySelector('button').click(); return !!card })()`)
  for (let i = 0; i < 12; i++) {
    await sleep(500)
    if (await c.ev(`(() => { const el = document.querySelector('.viewport'); const r = el && el.getBoundingClientRect(); return !!(r && r.width > 300 && r.height > 300) })()`)) break
  }
  // 2) 打开邀约面板并填表
  await c.ev(`(() => { const t = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '任务'); if (t) t.click(); return 1 })()`)
  await sleep(500)
  await c.ev(`(() => { const inv = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '达人邀约'); if (inv) inv.click(); return 1 })()`)
  await sleep(700)
  const filled = await c.ev(`(() => {
    const set = (el, v) => { const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
    const q = s => document.querySelector('[data-test=' + s + ']')
    if (!q('invite-start')) return 'no-panel'
    set(q('invite-contact'), '验收联系人')
    set(q('invite-wechat'), 'mock_wx001')
    set(q('invite-script'), '您好，我们是仿真验收店铺，诚邀您合作带货，佣金与选品都可协商，期待您的回复！')
    return 'filled'
  })()`)
  console.log('填表:', filled)
  // 3) 开始
  const started = await c.ev(`(() => { const s = document.querySelector('[data-test=invite-start]'); if (!s) return 'no-start'; if (s.disabled) return 'start-disabled'; s.click(); return 'started' })()`)
  console.log('启动:', started)
  if (started !== 'started') { c.close(); throw new Error(started) }
  // 4) 等停止按钮出现
  let stopShown = false
  for (let i = 0; i < 24; i++) {
    await sleep(500)
    stopShown = await c.ev(`!!document.querySelector('[data-test=invite-stop]')`)
    if (stopShown) break
  }
  console.log('停止按钮出现:', stopShown)
  if (!stopShown) { c.close(); throw new Error('stop button never shown') }
  // 5) 点停止
  await c.ev(`document.querySelector('[data-test=invite-stop]').click();'stop-clicked'`)
  let final = null
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    final = await c.ev(`(async () => {
      const tasks = await window.shopilot.task.list()
      const list = tasks.data.tasks || tasks.data
      const t = list.find(x => x.name.includes('辅助填单'))
      return t && t.latestRun ? t.latestRun.status : 'none'
    })()`)
    if (['cancelled', 'failed', 'succeeded'].includes(final)) break
  }
  const backToStart = await c.ev(`!!document.querySelector('[data-test=invite-start]') && !document.querySelector('[data-test=invite-stop]')`)
  console.log('终态:', final, '| 面板回到可开始:', backToStart)
  c.close()
  if (final !== 'cancelled') throw new Error('expected cancelled, got ' + final)
  if (!backToStart) throw new Error('panel did not return to start state')
  console.log('STOP-VERIFY: PASS')
}
main().catch(e => { console.error('STOP-FAIL:', e.message); process.exit(1) })
