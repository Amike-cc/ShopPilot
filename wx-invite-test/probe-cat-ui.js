(async () => {
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const text = el => String(el.innerText || '').replace(/\s+/g, ' ').trim()
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const visible = el => {
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) return false
    const s = getComputedStyle(el)
    return s.display !== 'none' && s.visibility !== 'hidden'
  }
  const popups = () => {
    const out = []
    for (const el of document.querySelectorAll('[class*=dropdown],[class*=popover],[class*=popup],[class*=modal],[class*=overlay],[class*=panel]')) {
      if (!visible(el)) continue
      const t = text(el)
      if (!t || t.length > 400) continue
      out.push({ cls: String(el.className).slice(0, 50), rect: (() => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] })(), t: t.slice(0, 110) })
    }
    return out.slice(0, 8)
  }
  const labelRow = () => {
    const lbl = [...document.querySelectorAll('label,div,span')].find(e => own(e) === '\u4e3b\u63a8\u7c7b\u76ee')
    return lbl ? (lbl.closest('.auxo-form-item-row') || lbl.parentElement) : null
  }
  const out = { startPopups: popups() }

  // 1) 点"展开"
  const row = labelRow()
  const expand = row ? [...row.querySelectorAll('*')].find(e => own(e) === '\u5c55\u5f00') : null
  out.expandFound = !!expand
  if (expand) { (expand.closest('[class*=btn]') || expand).click(); await sleep(1500) }
  out.afterExpand = {
    chips: row ? [...row.querySelectorAll('a.auxo-btn')].map(a => own(a.querySelector('.auxo-space-item span') || a).slice(0, 12)) : [],
    popups: popups()
  }

  // 2) 点"主推类目"标签本身
  const lbl = [...document.querySelectorAll('label,div,span')].find(e => own(e) === '\u4e3b\u63a8\u7c7b\u76ee')
  if (lbl) { lbl.click(); await sleep(1500) }
  out.afterLabelClick = popups()

  // 3) 找有没有带 checkbox 的类目面板
  const boxes = []
  for (const el of document.querySelectorAll('input[type=checkbox],li,[class*=option]')) {
    if (!visible(el)) continue
    const t = text(el)
    if (/^(不限|个人护理|家清纸品|美妆|个护家清|食品饮料|生鲜)$/.test(t)) boxes.push({ tag: el.tagName, cls: String(el.className).slice(0, 40), t, checked: el.checked })
  }
  out.categoryOptionCandidates = boxes.slice(0, 12)
  return JSON.stringify(out, null, 1)
})()
