/** 测池子：个护家清/不限 + LV0-LV3 下的可选达人数量（只读，不发送、不改勾选） */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
async function main() {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  let c = null
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
    if (r.result?.value > 0) { c = { send }; break }
    ws.close()
  }
  const ev = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 250))
    return r.result.value
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  await ev('location.reload();1')
  for (let i = 0; i < 30; i++) { await sleep(1000); if (await ev(`document.querySelectorAll('tbody tr[data-row-key]').length > 0`).catch(() => false)) break }
  await sleep(1500)
  console.log('chip 个护家清:', await ev(`(()=>{const own=el=>[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();const row=[...document.querySelectorAll('label,div,span')].find(e=>own(e)==='\u4e3b\u63a8\u7c7b\u76ee');const item=row&&row.closest('.auxo-form-item-row');const a=[...item.querySelectorAll('.quick-filter-button-enums a.auxo-btn')].find(x=>own(x.querySelector('.auxo-space-item span')||x)==='\u98df\u54c1\u996e\u6599');a.click();return 'ok'})()`))
  await sleep(1300)
  console.log('子类不限:', await ev(`(()=>{const t=el=>String(el.innerText||'').replace(/\s+/g,'').trim();const li=[...document.querySelector('.quick-filter-cascader-popover').querySelectorAll('li.auxo-cascader-menu-item')].find(x=>t(x)==='\u4e0d\u9650');li.click();return 'ok'})()`))
  await sleep(1200)
  console.log('打开等级下拉:', await ev(`(()=>{const own=el=>[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();const t=[...document.querySelectorAll('span,div,label')].filter(e=>own(e)==='\u8fbe\u4eba\u7b49\u7ea7');t[0].click();return 'ok'})()`))
  await sleep(900)
  for (const lv of ['LV0', 'LV1', 'LV2', 'LV3']) {
    console.log('点', lv, ':', await ev(`(()=>{const t=el=>String(el.innerText||'').trim();const o=[...document.querySelectorAll('.quick-filter-button-select-option')].find(e=>t(e)===${JSON.stringify(lv)});if(!o)return 'not-found';o.click();return 'ok'})()`))
    await sleep(500)
  }
  console.log('搜索:', await ev(`(()=>{const t=el=>String(el.innerText||'').replace(/\s+/g,'').trim();const b=[...document.querySelectorAll('button,span')].find(e=>t(e)==='\u641c\u7d22');b.click();return 'ok'})()`))
  await sleep(5000)
  // 滚动整表统计可选行
  const count = JSON.parse(await ev(`(async () => {
    const sc = document.querySelector('.auxo-table-body')
    if (!sc) return JSON.stringify({ err: 'no-scroller' })
    sc.style.scrollBehavior = 'auto'
    const seen = new Map()
    const maxTop = () => sc.scrollHeight - sc.clientHeight
    for (let top = 0; top <= maxTop() + 300; top += 300) {
      sc.scrollTop = top
      await new Promise(r => setTimeout(r, 320))
      for (const tr of document.querySelectorAll('tbody tr[data-row-key]')) {
        const key = tr.getAttribute('data-row-key')
        const cb = tr.querySelector('input[type=checkbox]')
        if (!cb) continue
        const prev = seen.get(key) || { dis: false }
        seen.set(key, { dis: prev.dis || cb.disabled })
      }
      if (top > maxTop()) break
    }
    sc.scrollTop = 0
    const rows = [...seen.values()]
    return JSON.stringify({ uniqueRows: rows.length, available: rows.filter(x => !x.dis).length, disabled: rows.filter(x => x.dis).length, filtered: (() => { const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim(); const f = [...document.querySelectorAll('*')].find(e => own(e) === '\u5df2\u7b5b\u9009'); return f ? String(f.parentElement.innerText || '').replace(/\s+/g, ' ').slice(0, 120) : null })() })
  })()`))
  console.log('pool:', count)
  process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
