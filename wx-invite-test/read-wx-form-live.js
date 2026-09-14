/** 从"当前停在的邀约表单页"实时读今日剩余额度（只读） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = 'store_4eb9b43cffeee0094041894a9f1f93bf'

async function app() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  const t = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
  let s = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
  return { ev: async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value }
}
const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const form = list.find(x => x.type === 'page' && x.url.includes('initiate-invite'))
console.log('表单页:', form ? form.url.slice(0, 110) : '(无)')
if (!form) process.exit(0)
const ws = new WebSocket(form.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
console.log(await ev(`(() => {
  const all = []
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const txt = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ')
  const m = /今日剩余\\s*(\\d+)\\s*次邀请机会/.exec(txt)
  // 表单当前状态（干跑填进去的值）
  const inputs = all.filter(e => (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') && e.offsetParent !== null)
    .map(e => ({ tag: e.tagName, ph: e.getAttribute('placeholder'), v: String(e.value || '').slice(0, 30) }))
  const rows = all.filter(e => e.tagName === 'TR' && /ID\\s*\\d{6,}/.test(String(e.innerText || ''))).length
  const sendBtn = all.find(e => own(e) === '发送邀约')
  const dis = sendBtn ? /disabled/i.test(String(sendBtn.className || '')) || sendBtn.disabled === true : null
  return JSON.stringify({ 今日剩余: m ? Number(m[1]) : null, 原文: (m || [])[0] || null, 表单输入: inputs, 已选商品行: rows, 发送按钮禁用: dis }, null, 1)
})()`))
ws.close()
process.exit(0)
