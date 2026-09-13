/**
 * 采集主推类目树 v5（最稳）：每个 chip 独立一轮——刷新页面 → JS 点该 chip →
 * 页面上唯一的级联弹层即它的子类列表。弹层懒创建、一页一弹层，绝无匹配歧义。
 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const fs = require('fs')

async function connectLive() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  for (const t of list.filter(x => x.type === 'page' && x.url.includes('daren-square'))) {
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err })
    let s = 0
    const pend = new Map()
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
    const send = (method, params = {}) => new Promise((ok, err) => {
      const id = ++s
      pend.set(id, m => m.error ? err(new Error(JSON.stringify(m.error))) : ok(m.result))
      ws.send(JSON.stringify({ id, method, params }))
    })
    const r = await send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
    if (r.result?.value > 0) return { send }
    ws.close()
  }
  throw new Error('没有活跃的达人广场页面')
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const { send } = await connectLive()
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 250))
    return r.result.value
  }
  // 先拿 22 个一级名（刷新前的 DOM 就够）
  const names = JSON.parse(await ev(`(() => {
    const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    const row = [...document.querySelectorAll('label,div,span')].find(e => own(e) === '\u4e3b\u63a8\u7c7b\u76ee')
    const item = row && row.closest('.auxo-form-item-row')
    return JSON.stringify([...item.querySelectorAll('.quick-filter-button-enums a.auxo-btn')].map(a => own(a.querySelector('.auxo-space-item span') || a)))
  })()`))
  console.log('categories:', names.length)

  const tree = []
  for (const name of names) {
    await ev('location.reload();1')
    let ready = false
    for (let i = 0; i < 30; i++) { await sleep(1000); ready = await ev(`document.querySelectorAll('tbody tr[data-row-key]').length > 0`).catch(() => false); if (ready) break }
    await sleep(1200)
    const read = JSON.parse(await ev(`(async () => {
      const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
      const text = el => String(el.innerText || '').replace(/\\s+/g, ' ').trim()
      const row = [...document.querySelectorAll('label,div,span')].find(e => own(e) === '\u4e3b\u63a8\u7c7b\u76ee')
      const item = row && row.closest('.auxo-form-item-row')
      const a = [...item.querySelectorAll('.quick-filter-button-enums a.auxo-btn')].find(x => own(x.querySelector('.auxo-space-item span') || x) === ${JSON.stringify(name)})
      if (!a) return JSON.stringify({ err: 'no-chip' })
      a.click()
      await new Promise(r2 => setTimeout(r2, 1400))
      const pops = [...document.querySelectorAll('.quick-filter-cascader-popover')]
      const menu = pops[0] && pops[0].querySelector('.auxo-cascader-menu')
      const items = menu ? [...menu.querySelectorAll('li.auxo-cascader-menu-item')].map(li => ({
        name: text(li), expand: /expand/.test(String(li.className))
      })) : []
      return JSON.stringify({ popCount: pops.length, items })
    })()`))
    tree.push({ name, children: read.items || [] })
    console.log(name, '->', (read.items || []).map(i => i.name + (i.expand ? '*' : '')).join(' / ') || '(暂无数据)', `[pops=${read.popCount}]`)
  }
  fs.writeFileSync('wx-invite-test/category-tree.json', JSON.stringify({ count: tree.length, tree }, null, 1))
  console.log('saved category-tree.json')
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
