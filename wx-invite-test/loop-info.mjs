/** 只看 loop 负载的关键字段：完成轮数/停止原因/每轮结果/是否含 screenshot。 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const RUN = process.argv[2]
const OUT = process.argv[3] || 'wx-invite-test/loop-info.txt'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? null : r.result?.value
}
const raw = await ev("(async () => { const r = await window.shopilot.task.results(" + JSON.stringify(RUN) + "); return JSON.stringify({ run: r.data.run, results: r.data.results, loop: (r.data.steps && r.data.steps[0] && r.data.steps[0].input) || null }) })()")
const d = JSON.parse(raw)
const lines = []
lines.push(`status=${d.run.status} code=${d.run.errorCode || '-'} reason=${d.run.statusReason}`)
lines.push(`用时 ${d.run.finishedAt - d.run.startedAt} ms`)
if (d.loop) {
  lines.push(`label=${d.loop.label}`)
  lines.push(`maxRounds=${d.loop.maxRounds} stopOn=${JSON.stringify(d.loop.stopOn)}`)
  lines.push(`嵌套步骤数=${(d.loop.steps || []).length} 含screenshot=${(d.loop.steps || []).filter(x => x.type === 'screenshot').length} 含发送=${(d.loop.steps || []).some(x => x.input && x.input.text === '发送邀请')}`)
}
const res = (d.results || []).find(x => String(x.action || '') === 'loop' || x.type === 'loop')
if (res) {
  const p = typeof res.payload === 'string' ? JSON.parse(res.payload) : res.payload
  lines.push(`completedRounds=${p.completedRounds} stopReason=${p.stopReason}`)
  lines.push(`rounds=${JSON.stringify(p.rounds)}`)
} else {
  lines.push('(没找到 loop 的步骤结果)')
  lines.push(JSON.stringify(d.results).slice(0, 800))
}
fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(lines.join('\n').replace(/[^\x20-\x7E\n]/g, '?'))
ws.close()
setTimeout(() => process.exit(0), 200)
