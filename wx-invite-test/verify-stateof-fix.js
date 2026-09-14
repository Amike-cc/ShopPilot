/**
 * 验证 stateOf 的误判：在**当前活着的广场页**上，用「只看第一个匹配」与「任一匹配即算选中」
 * 两套逻辑分别判定「直播带货者」，对比结果（确认修复有效）。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const sqT = targets.find(x => x.type === 'page' && x.url.includes('findersquare/find'))
if (!sqT) { console.log('没有广场页'); process.exit(0) }
const ws = new WebSocket(sqT.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value

const DEFS = `
  const out = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const RE = /(^|[\\s_-])(on|active|current|checked|selected)([\\s_-]|$)/i
  const isOn = (el) => {
    const label = el.closest('label') || null
    const inp = label && label.querySelector('input')
    if (inp && inp.checked) return true
    let node = el
    for (let i = 0; i < 3 && node; i++, node = node.parentElement) if (RE.test(String(node.className || ''))) return true
    return false
  }
  const matches = (needle) => out.filter(el => {
    if (own(el) !== needle) return false
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) return false
    const cs = getComputedStyle(el)
    return !(cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')
  })
`

console.log('对同一页面、「直播带货者」分别判定：')
console.log(await ev(`(() => {
  ${DEFS}
  const needle = '直播带货者'
  const ms = matches(needle)
  const oldLogic = ms.length ? isOn(ms[0]) : false
  const newLogic = ms.some(isOn)
  return JSON.stringify({
    匹配元素数: ms.length,
    各元素: ms.slice(0, 6).map(el => ({
      tag: el.tagName,
      cls: String(el.className || '').slice(0, 40),
      parentCls: String((el.parentElement && el.parentElement.className) || '').slice(0, 55),
      isOn: isOn(el)
    })),
    旧逻辑_只看第一个: oldLogic,
    新逻辑_任一即算: newLogic,
    结论: oldLogic === newLogic ? '两套一致（本次无差异）' : '新逻辑纠正了误判'
  }, null, 1)
})()`))

// 再对「母婴」「有联系方式」做同样对比
for (const needle of ['母婴', '有联系方式']) {
  console.log(`\n对「${needle}」:`)
  console.log(await ev(`(() => {
    ${DEFS}
    const needle = ${JSON.stringify(needle)}
    const ms = matches(needle)
    return JSON.stringify({ 匹配元素数: ms.length, 旧逻辑: ms.length ? isOn(ms[0]) : false, 新逻辑: ms.some(isOn), 各元素: ms.slice(0,5).map(el => ({ tag: el.tagName, cls: String(el.className||'').slice(0,32), parent: String((el.parentElement&&el.parentElement.className)||'').slice(0,40), on: isOn(el) })) }, null, 1)
  })()`))
}
ws.close()
setTimeout(() => process.exit(0), 300)
