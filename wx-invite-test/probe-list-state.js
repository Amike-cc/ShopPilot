(async () => {
  const text = (el) => String(el.innerText || '').replace(/\s+/g, ' ').trim()
  // 关键词框当前值
  const inp = document.querySelector('input.auxo-input[type=search], input.auxo-input')
  // 页面上的总数类文案
  const counts = []
  for (const el of document.querySelectorAll('div,span,p,b,strong')) {
    const t = text(el)
    if (t.length > 60 || !t) continue
    if (/共\s*\d+\s*(位|个|条)|找到\s*\d+|合计\s*\d+|\d+\s*位达人/.test(t)) counts.push(t)
  }
  // 筛选区当前选中项
  const chips = []
  for (const el of document.querySelectorAll('[class*=select],[class*=chip],[class*=tag],[class*=filter]')) {
    const t = text(el)
    if (!t || t.length > 30) continue
    if (/on|active|selected|checked/i.test(String(el.className))) chips.push(t.slice(0, 24))
  }
  const sc = document.querySelector('.auxo-table-body')
  return JSON.stringify({
    keyword: inp ? inp.value : null,
    counts: [...new Set(counts)].slice(0, 8),
    activeChips: [...new Set(chips)].slice(0, 12),
    scrollHeight: sc ? sc.scrollHeight : null,
    renderedRows: document.querySelectorAll('tbody tr[data-row-key]').length
  }, null, 1)
})()
