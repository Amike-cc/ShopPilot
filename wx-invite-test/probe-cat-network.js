/**
 * 抓达人广场的搜索请求：点击类目 chip + 关键词搜索按钮后，看请求体里有没有类目参数。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const CAT = '\u4e2a\u62a4\u5bb6\u6e05'

async function connectLive() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
    .filter(t => t.type === 'page' && t.url.includes('daren-square'))
  for (const t of list) {
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
    let seq = 0
    const pend = new Map()
    const events = []
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return }
      if (m.method) events.push(m)
    }
    const send = (method, params = {}) => new Promise((ok, err) => {
      const id = ++seq
      pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
      ws.send(JSON.stringify({ id, method, params }))
    })
    const r = await send('Runtime.evaluate', { expression: 'window.innerWidth+"x"+window.innerHeight', returnByValue: true })
    if (r.result?.value && r.result.value !== '0x0') {
      return { send, events, close: () => ws.close() }
    }
    ws.close()
  }
  throw new Error('没有活跃的达人广场页面')
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const c = await connectLive()
  await c.send('Network.enable', {})
  c.events.length = 0

  // 1) 点类目 chip（若已是选中态则先点两下确保选中）
  await c.send('Runtime.evaluate', {
    expression: `(() => {
      const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
      const lbl = [...document.querySelectorAll('label,div,span')].find(e => own(e) === '\u4e3b\u63a8\u7c7b\u76ee');
      const item = lbl && lbl.closest('.auxo-form-item-row');
      const a = [...item.querySelectorAll('a.auxo-btn')].find(x => own(x.querySelector('.auxo-space-item span') || x) === ${JSON.stringify(CAT)});
      if (!a) return 'no-chip';
      if (a.className.includes('tertiary')) a.click();
      return String(a.className);
    })()`, returnByValue: true, userGesture: true
  })
  await sleep(1200)
  const afterChip = (await c.send('Runtime.evaluate', {
    expression: `(() => { const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim(); const lbl=[...document.querySelectorAll('label,div,span')].find(e=>own(e)==='\u4e3b\u63a8\u7c7b\u76ee'); const item=lbl&&lbl.closest('.auxo-form-item-row'); const a=[...item.querySelectorAll('a.auxo-btn')].find(x=>own(x.querySelector('.auxo-space-item span')||x)===${JSON.stringify(CAT)}); return a?a.className:'gone' })()`,
    returnByValue: true
  })).result.value
  console.log('chip class after click:', afterChip)

  // 2) 点关键词搜索按钮
  await c.send('Runtime.evaluate', {
    expression: `(() => { const t = el => String(el.innerText||'').replace(/\\s+/g,'').trim(); const b=[...document.querySelectorAll('button,span')].find(e=>t(e)==='\u641c\u7d22'); if(b) b.click(); return !!b })()`,
    returnByValue: true, userGesture: true
  })
  await sleep(6000)

  const reqs = c.events
    .filter(e => e.method === 'Network.requestWillBeSent')
    .map(e => e.params.request)
    .filter(r => /jinritemai\.com/.test(r.url) && !/\.(js|css|png|jpg|svg|woff2?|ico)/.test(r.url))
    .map(r => ({ m: r.method, url: r.url.slice(0, 130), post: r.postData ? r.postData.slice(0, 400) : null }))
  console.log('--- requests after category + 搜索 ---')
  for (const r of reqs) console.log(r.m, r.url, r.post ? '\n   ' + r.post : '')
  c.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
