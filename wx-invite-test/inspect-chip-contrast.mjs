/** 检查主题变量与选中芯片的真实可读性（白字是否有实底），并截取芯片区域放大 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : r.result?.value
}
console.log('主题变量:', await ev(`(() => {
  const cs = getComputedStyle(document.documentElement)
  const v = (n) => cs.getPropertyValue(n).trim()
  return JSON.stringify({
    bg: v('--color-bg'), bgCard: v('--color-bg-secondary'), bgTertiary: v('--color-bg-tertiary'),
    text: v('--color-text-primary'), textSecondary: v('--color-text-secondary'),
    primary: v('--color-primary'), border: v('--color-border')
  }, null, 1)
})()`))
console.log('\n选中芯片的底色链（自身→父级）:', await ev(`(() => {
  const chip = [...document.querySelectorAll('[data-test=invite-panel] .inv-chip')].find(c => c.classList.contains('on'))
  if (!chip) return 'no-selected-chip'
  const chain = []
  let n = chip
  for (let i = 0; i < 5 && n; i++, n = n.parentElement) {
    chain.push({ tag: n.tagName + (n.className ? '.' + String(n.className).split(' ')[0] : ''), bg: getComputedStyle(n).backgroundColor })
  }
  const cs = getComputedStyle(chip)
  return JSON.stringify({ 芯片文字色: cs.color, 芯片底色: cs.backgroundColor, 祖先底色链: chain }, null, 1)
})()`))
setTimeout(() => process.exit(0), 300)
