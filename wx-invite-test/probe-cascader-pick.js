(async () => {
  const CAT = '\u4e2a\u62a4\u5bb6\u6e05'
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const text = el => String(el.innerText || '').replace(/\s+/g, ' ').trim()
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const filtered = () => {
    const f = [...document.querySelectorAll('*')].find(e => own(e) === '\u5df2\u7b5b\u9009')
    return f ? text(f.parentElement).slice(0, 160) : null
  }
  const listSig = () => {
    const rows = [...document.querySelectorAll('tbody tr[data-row-key]')]
    return { rows: rows.length, withCat: rows.filter(tr => text(tr).includes(CAT)).length, first: rows[0] ? text(rows[0]).slice(0, 50) : null }
  }
  const pop = document.querySelector('.quick-filter-cascader-popover')
  const out = { popOpen: !!pop, before: { filtered: filtered(), list: listSig() } }
  if (!pop) return JSON.stringify(out, null, 1)

  // 点级联里的「不限」（子类不限 = 整个主推类目）
  const item = [...pop.querySelectorAll('li.auxo-cascader-menu-item')].find(li => text(li) === '\u4e0d\u9650')
  out.itemFound = !!item
  if (item) item.click()
  await sleep(2500)
  out.afterUnlimited = { filtered: filtered(), list: listSig(), popStillOpen: !!document.querySelector('.quick-filter-cascader-popover') }

  // 若筛选生效，再点搜索刷新列表并复核
  const btn = [...document.querySelectorAll('button,span')].find(b => text(b).replace(/\s+/g, '') === '\u641c\u7d22')
  if (btn) btn.click()
  await sleep(6000)
  out.afterSearch = { filtered: filtered(), list: listSig() }
  return JSON.stringify(out, null, 1)
})()
