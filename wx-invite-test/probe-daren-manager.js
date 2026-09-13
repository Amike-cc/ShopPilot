(async () => {
  const text = (el) => String(el.innerText || '').replace(/\s+/g, ' ').trim()
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  await sleep(1200)
  const headers = [...document.querySelectorAll('thead th')].map(th => text(th)).filter(Boolean)
  const counts = []
  for (const el of document.querySelectorAll('div,span,p,b,strong')) {
    const t = text(el)
    if (!t || t.length > 40) continue
    if (/共\s*\d+|\d+\s*(位|个|条)|合计/.test(t)) counts.push(t)
  }
  const tabs = [...document.querySelectorAll('[class*=tab],[class*=radio],[role=tab]')].map(e => text(e)).filter(t => t && t.length < 16)
  // 表格滚动容器（若也是虚拟滚动）
  const sc = document.querySelector('.auxo-table-body')
  const rows = [...document.querySelectorAll('tbody tr[data-row-key]')]
  const first = rows.slice(0, 5).map(tr => text(tr).slice(0, 90))
  let scrollInfo = null
  if (sc) scrollInfo = { scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight }
  return JSON.stringify({
    url: location.href, title: document.title,
    headers, counts: [...new Set(counts)].slice(0, 10), tabs: [...new Set(tabs)].slice(0, 12),
    renderedRows: rows.length, firstRows: first, scrollInfo
  }, null, 1)
})()
