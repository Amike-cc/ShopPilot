(async () => {
  const CAT = '\u4e2a\u62a4\u5bb6\u6e05'
  const LABEL = '\u4e3b\u63a8\u7c7b\u76ee'
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const text = el => String(el.innerText || '').replace(/\s+/g, ' ').trim()
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const rowsDump = () => {
    const lbl = [...document.querySelectorAll('label,div,span')].find(e => own(e) === LABEL)
    const item = lbl && lbl.closest('.auxo-form-item-row')
    const anchors = item ? [...item.querySelectorAll('a.auxo-btn')] : []
    return anchors.map(a => ({
      t: own(a.querySelector('.auxo-space-item span') || a).slice(0, 12),
      cls: String(a.className).replace('auxo-btn ', '').slice(0, 34)
    }))
  }
  const filtered = () => {
    const f = [...document.querySelectorAll('*')].find(e => own(e) === '\u5df2\u7b5b\u9009')
    return f ? text(f.parentElement).slice(0, 140) : null
  }
  const listSig = () => {
    const rows = [...document.querySelectorAll('tbody tr[data-row-key]')]
    return { rows: rows.length, first: rows[0] ? text(rows[0]).slice(0, 46) : null }
  }
  const out = { initial: { chips: rowsDump(), filtered: filtered(), list: listSig() } }

  const clickChip = (name) => {
    const lbl = [...document.querySelectorAll('label,div,span')].find(e => own(e) === LABEL)
    const item = lbl && lbl.closest('.auxo-form-item-row')
    const target = [...item.querySelectorAll('a.auxo-btn')].find(a => own(a.querySelector('.auxo-space-item span') || a) === name)
    if (!target) return false
    target.click()
    return true
  }
  out.clickedCat = clickChip(CAT)
  await sleep(2000)
  out.afterCatClick = { chips: rowsDump(), filtered: filtered(), list: listSig() }

  // 点"搜索"
  const btn = [...document.querySelectorAll('button')].find(b => text(b).replace(/\s+/g, '') === '\u641c\u7d22')
  if (btn) btn.click()
  await sleep(5000)
  out.afterSearch = { chips: rowsDump(), filtered: filtered(), list: listSig(), url: location.href.slice(0, 120) }

  // 再点一次类目（看是否 toggle 回去）
  out.clickedCatAgain = clickChip(CAT)
  await sleep(1500)
  out.afterSecondCatClick = { chips: rowsDump(), filtered: filtered(), list: listSig() }
  return JSON.stringify(out, null, 1)
})()
