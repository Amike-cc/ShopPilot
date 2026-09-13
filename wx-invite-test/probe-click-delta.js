(async () => {
  const read = () => {
    const el = document.querySelector('.select_peoples_message')
    const m = el ? /\u5df2\u9009\u62e9\s*(\d+)/.exec(String(el.innerText || '')) : null
    return m ? Number(m[1]) : null
  }
  const sc = document.querySelector('.auxo-table-body')
  if (!sc) return JSON.stringify({ err: 'NO_SCROLLER' })
  sc.style.scrollBehavior = 'auto'
  const log = []
  log.push({ step: 'start', count: read(), top: Math.round(sc.scrollTop) })
  let clicks = 0
  const maxTop = sc.scrollHeight - sc.clientHeight
  for (let round = 0; round < 14 && clicks < 12; round++) {
    const rows = [...document.querySelectorAll('tbody tr')]
    for (const tr of rows) {
      if (clicks >= 12) break
      const cb = tr.querySelector('input[type=checkbox]')
      if (!cb || cb.disabled || cb.checked) continue
      const r = cb.getBoundingClientRect()
      if (!(r.width > 0 && r.height > 0)) continue
      const name = String(tr.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 12)
      const before = read()
      const label = cb.closest('label') || cb
      label.click()
      await new Promise(x => setTimeout(x, 400))
      log.push({ name, via: label.tagName, checkedAfter: cb.checked, before, after: read() })
      clicks++
    }
    if (read() >= 40) break
    const target = Math.min(maxTop, Math.round(sc.scrollTop) + Math.floor(sc.clientHeight * 0.95))
    sc.scrollTop = target
    await new Promise(x => setTimeout(x, 600))
  }
  return JSON.stringify({ clicks, finalCount: read(), maxTop: Math.round(sc.scrollHeight - sc.clientHeight), log }, null, 1)
})()
