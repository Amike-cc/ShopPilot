/** 抖店广场：列出页面上所有"已选择 N 位达人"计数 + 渲染窗口内复选框状态 + 抽屉状态 */
(async () => {
  const out = []
  for (const el of document.querySelectorAll('div,span,p,b,strong,em')) {
    const t = String(el.innerText || '').replace(/\s+/g, ' ').trim()
    const m = /已选择\s*(\d+)\s*位达人/.exec(t)
    if (m && t.length < 40) {
      const r = el.getBoundingClientRect()
      out.push({
        n: Number(m[1]), text: t,
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        cls: String(el.className).slice(0, 40),
        display: getComputedStyle(el).display,
        vis: getComputedStyle(el).visibility
      })
    }
  }
  const cbs = [...document.querySelectorAll('tbody input[type=checkbox]')]
  let checked = 0, disabled = 0, visible = 0
  for (const c of cbs) {
    const r = c.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) visible++
    if (c.checked) checked++
    if (c.disabled) disabled++
  }
  const ta = document.querySelector('textarea')
  const sc = document.querySelector('.auxo-table-body')
  return JSON.stringify({
    counters: out,
    window: { rendered: cbs.length, visible, checked, disabled },
    drawer: { textarea: !!ta, scriptLen: ta ? String(ta.value || '').length : null },
    scroller: sc ? { scrollTop: Math.round(sc.scrollTop), scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight } : null
  }, null, 1)
})()
