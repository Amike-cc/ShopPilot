/**
 * 并行采样器：每 1.5s 记录一次
 *   · 渲染层 `<webview>` 的 rect / tabId / 有没有隐藏祖先
 *   · 当前 findersquare 页面里「带货类目」在不在、可见不可见、页面路径
 * 用于在真机连发失败的那一刻留下现场（判断"没渲染" vs "渲染了但不可见"）。
 *
 * 用法：node wx-invite-test/sample-visibility.mjs [秒数]
 */
import fs from 'node:fs'
import path from 'node:path'

const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const DURATION = (Number(process.argv[2]) || 300) * 1000
const OUT = path.resolve('wx-invite-test/evidence/visibility-sampler.log')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, er) => { ws.onopen = ok; ws.onerror = er })
  let s = 0
  const p = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } }
  const send = (me, pa = {}) => new Promise((ok, er) => { const id = ++s; p.set(id, m => m.error ? er(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: me, params: pa })) })
  const ev = async (x, timeoutMs = 8000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 超时')), timeoutMs))])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 160))
    return r.result.value
  }
  return { ev, close: () => ws.close() }
}

const HOST = `(() => {
  const wv = document.querySelector('webview')
  if (!wv) return JSON.stringify({ webview: null })
  const r = wv.getBoundingClientRect()
  let el = wv, hidden = null
  while (el && el !== document.documentElement) {
    const cs = getComputedStyle(el); const rr = el.getBoundingClientRect()
    if (cs.display === 'none' || cs.visibility === 'hidden' || rr.width === 0 || rr.height === 0) { hidden = el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : ''); break }
    el = el.parentElement
  }
  return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height), tabId: wv.getAttribute('data-tab-id'), hidden })
})()`

const PAGE = `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const hits = all.filter(e => own(e) === '带货类目')
  const rects = hits.map(e => { const r = e.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height) })
  return JSON.stringify({ path: location.pathname, readyState: document.readyState, hits: hits.length, rects, microApps: all.filter(e => e.tagName === 'MICRO-APP').length })
})()`

async function main() {
  fs.writeFileSync(OUT, '')
  const started = Date.now()
  let rendererConn = null
  while (Date.now() - started < DURATION) {
    const list = await targets()
    if (!rendererConn) {
      const r = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
      if (r) rendererConn = await connect(r)
    }
    let host = 'n/a'
    try { if (rendererConn) host = await rendererConn.ev(HOST) } catch (e) { host = 'ERR ' + e.message.slice(0, 40); try { rendererConn.close() } catch {} rendererConn = null }
    let page = '（无 findersquare 目标）'
    const t = list.find(x => /findersquare/.test(String(x.url)))
    if (t) { try { const c = await connect(t); page = await c.ev(PAGE); c.close() } catch (e) { page = 'ERR ' + e.message.slice(0, 40) } }
    const line = `+${((Date.now() - started) / 1000).toFixed(1)}s host=${host} page=${page}`
    fs.appendFileSync(OUT, line + '\n')
    await sleep(1500)
  }
  try { rendererConn?.close() } catch {}
  console.log('采样结束:', OUT)
  process.exit(0)
}

main().catch(e => { console.error('ERR', e.message); process.exit(1) })
