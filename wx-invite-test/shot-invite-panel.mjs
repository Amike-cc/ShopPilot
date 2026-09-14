/**
 * 打开微信邀约面板并截图（用于 UI 优化前后对比）
 * 用法：node shot-invite-panel.mjs [文件名后缀]
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const suffix = process.argv[2] || 'before'
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
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : r.result?.value
}

await ev(`(async()=>{await window.shopilot.browser.open('${STORE}');return 1})()`)
await sleep(2500)
// 显示浏览器视图并点店铺卡片（让 displayedStoreId 生效）
await ev(`(async()=>{await window.shopilot.browser.display('${STORE}');return 1})()`)
await sleep(2000)
await ev(`(() => { const c = [...document.querySelectorAll('.store-card')].find(e => String(e.innerText||'').includes('微信小店测试')); if (c) c.click(); return 1 })()`)
await sleep(3500)
// 窗口拉大一点，保证右栏完整可见
await ev(`(() => { try { window.resizeTo(1600, 1000) } catch {} return 1 })()`)
await sleep(1200)
// 展开右栏（若之前被收起）
await ev(`(() => { const b = document.querySelector('[data-test=right-expand], .rp-expand'); if (b) b.click(); return 1 })()`)
await sleep(800)
// 进「任务 → 达人邀约」
await ev(`(()=>{const t=[...document.querySelectorAll('.ptab')].find(e=>String(e.innerText||'').trim()==='任务');if(t)t.click();return 1})()`)
await sleep(1500)
await ev(`(()=>{const t=[...document.querySelectorAll('.sub-tabs .sub-tab, .sub-tabs > *')].find(e=>String(e.innerText||'').includes('达人邀约'));if(t)t.click();return 1})()`)
await sleep(2500)

console.log('面板可见:', await ev(`(() => { const p = document.querySelector('[data-test=invite-panel]'); return p ? p.getBoundingClientRect().width > 0 : false })()`))
console.log('右栏信息:', await ev(`(() => { const p = document.querySelector('[data-test=invite-panel]'); if (!p) return 'no-panel'; const r = p.getBoundingClientRect(); const host = p.closest('.right-panel, aside, [class*=right]'); return JSON.stringify({ panelW: Math.round(r.width), panelH: Math.round(r.height), hostCls: host ? String(host.className).slice(0,60) : null, hostW: host ? Math.round(host.getBoundingClientRect().width) : null }) })()`))
// 面板滚动到顶部
await ev(`(() => { const p = document.querySelector('[data-test=invite-panel]'); if (p) p.scrollTop = 0; const sc = p.closest('[class*=scroll], .right-panel, aside'); if (sc) sc.scrollTop = 0; return 1 })()`)
await sleep(800)

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(`wx-invite-test/ui-invite-${suffix}.png`, Buffer.from(shot.data, 'base64'))
console.log(`截图已存 wx-invite-test/ui-invite-${suffix}.png`)
ws.close()
setTimeout(() => process.exit(0), 300)
