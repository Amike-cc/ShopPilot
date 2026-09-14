/** 面板滚到底后截图（验证吸底运行条在长面板底部依然可见） */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 回到面板并滚到底
await ev(`(()=>{const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务');if(t)t.click();return 1})()`)
await sleep(1200)
await ev(`(()=>{const t=[...document.querySelectorAll('.sub-tabs .sub-tab, .sub-tabs > *')].find(e=>String(e.innerText||'').includes('达人邀约'));if(t)t.click();return 1})()`)
await sleep(1800)
await ev(`(() => { const body = document.querySelector('[data-test=invite-panel]').closest('.panel-body'); if (body) body.scrollTop = body.scrollHeight; return 1 })()`)
await sleep(1200)
console.log('滚动位置:', await ev(`(() => { const b = document.querySelector('[data-test=invite-panel]').closest('.panel-body'); return JSON.stringify({ scrollTop: Math.round(b.scrollTop), max: b.scrollHeight - b.clientHeight }) })()`))
console.log('运行条可见:', await ev(`(() => { const bar = document.querySelector('[data-test=invite-run-bar]'); const host = bar.closest('.panel-body'); const b = bar.getBoundingClientRect(), h = host.getBoundingClientRect(); return JSON.stringify({ top: Math.round(b.top), hostBottom: Math.round(h.bottom), visible: b.top < h.bottom && b.bottom > h.top }) })()`))
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-invite-bottom.png', Buffer.from(shot.data, 'base64'))
console.log('截图已存 wx-invite-test/ui-invite-bottom.png')
ws.close()
setTimeout(() => process.exit(0), 300)
