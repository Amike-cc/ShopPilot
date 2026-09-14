/**
 * 验证「详情页微应用不挂载」是否由 URL 缺 talentAppid 引起：
 * 同一个达人，分别用 (a) 广场点进来的 URL（无 talentAppid）、(b) 补上 talentAppid 的 URL 打开，
 * 对比 micro-app 是否挂载。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'

const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const app = list.find(x => x.type === 'page' && x.url.includes('out/renderer/index.html'))
const ws = new WebSocket(app.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0
const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 从当前详情页取 finderUsername + 是否有 talentAppid
const det = list.filter(x => x.type === 'page' && x.url.includes('finder-detail')).pop()
console.log('现有详情页 URL:', det ? String(det.url).slice(0, 170) : '(无)')
const m = det && /finderUsername=([^&]+)/.exec(det.url)
const finder = m ? m[1] : null
console.log('finderUsername:', finder ? finder.slice(0, 45) + '…' : '(无)')
if (!finder) process.exit(0)
// 从历史邀约页里找一个 talentAppid 参考值
const hist = list.find(x => x.type === 'page' && x.url.includes('talentAppid'))
const appid = hist ? (/talentAppid=([^&]+)/.exec(hist.url) || [])[1] : null
console.log('参考 talentAppid:', appid || '(未找到)')

const raw = await ev(`(async()=>{const r=await window.shopilot.browser.tab.list('${STORE}');return JSON.stringify({active:r.data&&r.data.activeTabId,tabs:((r.data&&r.data.tabs)||[]).map(t=>({id:t.id,url:String(t.url||'').slice(0,50)}))})})()`)
const p = JSON.parse(raw)
const tabId = (p.tabs[0] || {}).id
if (!tabId) { console.log('没有标签页'); process.exit(1) }
console.log('用标签页:', tabId, JSON.stringify(p.tabs))

async function probe(url, tag) {
  await ev(`(async()=>{await window.shopilot.browser.navigate('${STORE}','${tabId}',${JSON.stringify(url)});return 1})()`)
  await sleep(13000)
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page' && x.url.includes('finder-detail'))
  const pg = pages.pop()
  if (!pg) { console.log(`[${tag}] 详情页没出来`); return }
  const w = new WebSocket(pg.webSocketDebuggerUrl)
  await new Promise((ok, err) => { w.onopen = ok; w.onerror = err })
  let s2 = 0; const q = new Map()
  w.onmessage = e => { const mm = JSON.parse(e.data); if (mm.id && q.has(mm.id)) { q.get(mm.id)(mm); q.delete(mm.id) } }
  const snd = (m2, pp = {}) => new Promise((ok, err) => { const id = ++s2; q.set(id, mm => mm.error ? err(new Error(JSON.stringify(mm.error))) : ok(mm.result)); w.send(JSON.stringify({ id, method: m2, params: pp })) })
  const r = await snd('Runtime.evaluate', {
    expression: `(() => {
      const all = []
      const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
      walk(document)
      const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
      return JSON.stringify({
        url: location.href.slice(0, 110),
        microApp: document.querySelectorAll('micro-app').length,
        邀请带货: all.some(el => own(el) === '邀请带货'),
        正文长度: String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').length
      })
    })()`, returnByValue: true
  })
  console.log(`[${tag}] ${r.result?.value}`)
  w.close()
}

const base = `https://store.weixin.qq.com/shop/findersquare/finder-detail?from=1&fromTab=all&finderUsername=${finder}`
await probe(base, 'a 无 talentAppid')
if (appid) await probe(`${base}&talentAppid=${appid}`, 'b 补 talentAppid')
setTimeout(() => process.exit(0), 300)
