(() => {
  const CAT = '\u4e2a\u62a4\u5bb6\u6e05'   // 个护家清
  const LABEL = '\u4e3b\u63a8\u7c7b\u76ee' // 主推类目
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const text = el => String(el.innerText || '').replace(/\s+/g, ' ').trim()
  const rect = el => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }

  const labelEl = [...document.querySelectorAll('label,div,span')].find(e => own(e) === LABEL)
  if (!labelEl) return JSON.stringify({ err: 'NO_LABEL' })
  // 找到 label 所在表单项容器
  let item = labelEl
  for (let i = 0; i < 6 && item.parentElement; i++) {
    item = item.parentElement
    if (/auxo-form-item-row|auxo-row/.test(String(item.className))) break
  }
  const dump = []
  const walk = (el, depth) => {
    if (depth > 6 || dump.length > 60) return
    const t = own(el)
    const cls = String(el.className || '')
    dump.push({
      d: depth, tag: el.tagName, cls: cls.slice(0, 44),
      own: t.slice(0, 24) || null,
      inner: t ? null : text(el).slice(0, 30),
      rect: rect(el),
      hit: t.includes(CAT)
    })
    for (const c of el.children) walk(c, depth + 1)
  }
  walk(item, 0)

  // 所有 own 含 个护家清 的元素（不限可见）
  const hits = []
  for (const el of document.querySelectorAll('*')) {
    const t = own(el)
    if (!t.includes(CAT)) continue
    const chain = []
    let p = el
    for (let i = 0; i < 5 && p; i++, p = p.parentElement) chain.push(p.tagName + '.' + String(p.className || '').split(' ')[0].slice(0, 26))
    hits.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 40), own: t.slice(0, 20), rect: rect(el), chain })
  }
  return JSON.stringify({ itemCls: String(item.className).slice(0, 60), dump, hits }, null, 1)
})()
