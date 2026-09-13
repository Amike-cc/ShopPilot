(() => {
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const text = el => String(el.innerText || '').replace(/\s+/g, ' ').trim()
  const rect = el => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }
  const visible = el => { const r = el.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return false; const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' }

  const pop = document.querySelector('.quick-filter-cascader-popover, .auxo-cascader-menus')
  const cols = []
  if (pop) {
    for (const menu of pop.querySelectorAll('.auxo-cascader-menu')) {
      cols.push({
        cls: String(menu.className).slice(0, 40),
        rect: rect(menu),
        items: [...menu.querySelectorAll('li')].map(li => ({
          t: text(li).slice(0, 18),
          cls: String(li.className).replace('auxo-cascader-menu-item', '').trim().slice(0, 34),
          rect: rect(li)
        }))
      })
    }
  }
  // 主推类目附近的触发按钮（quick-filter-button，不是 enums 那种）
  const triggers = []
  for (const el of document.querySelectorAll('[class*=quick-filter-button]')) {
    if (/enums/.test(String(el.className))) continue
    if (!visible(el)) continue
    triggers.push({ cls: String(el.className).slice(0, 46), t: text(el).slice(0, 24), rect: rect(el) })
  }
  // 级联选择器的祖先链（谁在弹出它）
  const chain = []
  let p = pop
  for (let i = 0; i < 6 && p; i++, p = p.parentElement) chain.push(p.tagName + '.' + String(p.className || '').split(' ').slice(0, 2).join('.'))
  return JSON.stringify({ popRect: pop ? rect(pop) : null, popCls: pop ? String(pop.className).slice(0, 60) : null, cols, triggers: triggers.slice(0, 10), chain }, null, 1)
})()
