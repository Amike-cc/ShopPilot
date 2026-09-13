(async () => {
  const text = (el) => String(el.innerText || '').replace(/\s+/g, ' ').trim()
  const sc = document.querySelector('.auxo-table-body')
  if (!sc) return JSON.stringify({ err: 'NO_SCROLLER' })
  sc.style.scrollBehavior = 'auto'
  const seen = new Map() // rowKey -> {sent, disabled}
  let steps = 0
  const maxTop = () => sc.scrollHeight - sc.clientHeight
  for (let top = 0; top <= maxTop(); top += 300) {
    sc.scrollTop = top
    await new Promise(r => setTimeout(r, 320))
    steps++
    for (const tr of document.querySelectorAll('tbody tr')) {
      const key = tr.getAttribute('data-row-key')
      if (!key) continue
      const cb = tr.querySelector('input[type=checkbox]')
      const t = text(tr)
      const sent = /\u53d1\u8fc7\u6d88\u606f|\u7ee7\u7eed\u6c9f\u901a/.test(t)
      const prev = seen.get(key) || { sent: false, disabled: false }
      seen.set(key, { sent: prev.sent || sent, disabled: prev.disabled || !!(cb && cb.disabled) })
    }
    if (top + 300 > maxTop()) { sc.scrollTop = maxTop(); await new Promise(r => setTimeout(r, 320)) }
  }
  const rows = [...seen.values()]
  const sent = rows.filter(r => r.sent).length
  const disabled = rows.filter(r => r.disabled).length
  const sentAndDisabled = rows.filter(r => r.sent && r.disabled).length
  const available = rows.filter(r => !r.disabled && !r.sent).length
  sc.scrollTop = 0
  return JSON.stringify({
    uniqueRows: rows.length, sentMarked: sent, checkboxDisabled: disabled,
    sentAndDisabled, stillAvailable: available, steps,
    scrollHeight: sc.scrollHeight
  })
})()
