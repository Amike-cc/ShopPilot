/**
 * 快手「带货类目」级联：逐个点每个一级 chip，dump 下拉里的子项。
 * 一级点完立刻点「全部」收口（避免累积筛选影响后续读取），最后刷新页面恢复。
 * 只读筛选，不涉及邀约发送。
 */
const fs = await import('fs')
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pg = list.filter(x => x.type === 'page' && x.url.includes('daren')).pop()
const ws = new WebSocket(pg.webSocketDebuggerUrl)
await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
let s = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m2, p2 = {}) => new Promise((ok, err) => { const id = ++s; pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: m2, params: p2 })) })
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
  return r.exceptionDetails ? 'THREW ' + JSON.stringify(r.exceptionDetails).slice(0, 260) : r.result?.value
}
const CATS = ['零食饮料', '家居百货', '女装女鞋', '美妆护肤', '个护家清', '营养健康', '母婴玩具', '生鲜食品',
  '男装男鞋', '运动户外', '数码家电', '珠宝文玩', '茶叶酒水', '箱包配饰', '图书学习', '花宠园艺', '童装童鞋', '内衣裤袜']

/** 在「带货类目」那一行里点文案（限定行容器，避免命中别处同名） */
const clickInCategoryRow = (text) => q(`(() => {
  const all = [...document.querySelectorAll('*')]
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const narrow = x => String(x).replace(/\\s+/g,'')
  // 找「带货类目」label → 上溯到 .row
  const lab = all.find(el => own(el) === '带货类目' && el.getBoundingClientRect().width > 0)
  if (!lab) return 'no-label'
  let row = lab.parentElement
  for (let i = 0; i < 4 && row; i++) { if (String(row.className||'').includes('pc-row')) break; row = row.parentElement }
  if (!row) return 'no-row'
  const cands = [...row.querySelectorAll('*')].filter(el => narrow(own(el)) === narrow(${JSON.stringify(text)}) && el.getBoundingClientRect().width > 0)
  if (!cands.length) return 'no-el'
  let n = cands[0]; const done = []
  for (let i = 0; i < 3 && n && n !== row; i++, n = n.parentElement) { try { n.click(); done.push(n.tagName) } catch { done.push('err') } }
  return JSON.stringify({ chain: done })
})()`)
/** 点下拉里的叶子项 */
const clickLeaf = (text) => q(`(() => {
  const d = [...document.querySelectorAll('[class*=select-dropdown]')].filter(e => e.getBoundingClientRect().height > 30).pop()
  if (!d) return 'no-dropdown'
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const narrow = x => String(x).replace(/\\s+/g,'')
  const items = [...d.querySelectorAll('*')].filter(el => narrow(own(el)) === narrow(${JSON.stringify(text)}))
  if (!items.length) return 'no-item'
  let n = items[0]; const done = []
  for (let i = 0; i < 3 && n && n !== d; i++, n = n.parentElement) { try { n.click(); done.push(n.tagName) } catch { done.push('err') } }
  return JSON.stringify(done)
})()`)
const dropText = () => q(`(() => {
  const d = [...document.querySelectorAll('[class*=select-dropdown]')].filter(e => e.getBoundingClientRect().height > 30).pop()
  return d ? String(d.innerText||'').replace(/\\s+/g,' ').trim() : null
})()`)

const tree = {}
for (const c of CATS) {
  console.log('\n--- ' + c + ' ---')
  const open = await clickInCategoryRow(c)
  await sleep(2600)
  const items = await dropText()
  console.log('  下拉:', items)
  tree[c] = items ? items.split(' ').filter(Boolean) : []
  // 收口：点「全部」（不限子类），让筛选不残留
  const leaf = await clickLeaf('全部')
  await sleep(2600)
  console.log('  收口:', leaf)
}
fs.writeFileSync('wx-invite-test/ks-category-tree.json', JSON.stringify(tree, null, 1), 'utf8')
console.log('\n已存 wx-invite-test/ks-category-tree.json')
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('wx-invite-test/ui-ks-cat-tree.png', Buffer.from(shot.data, 'base64'))

await send('Page.navigate', { url: 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro' })
await sleep(11000)
console.log('已刷新恢复')
ws.close()
setTimeout(() => process.exit(0), 200)
