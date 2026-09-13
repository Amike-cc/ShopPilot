(async () => {
  const text = (el) => String(el.innerText || '').replace(/\s+/g, ' ').trim()
  // 1) 列表里的「发过消息」标记数（可见窗口）
  let sentBadges = 0
  const badgeSamples = []
  for (const el of document.querySelectorAll('span,div,td,button')) {
    const t = text(el)
    if (t === '\u53d1\u8fc7\u6d88\u606f' || t === '\u7ee7\u7eed\u6c9f\u901a') {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) { sentBadges++; if (badgeSamples.length < 4) badgeSamples.push(t) }
    }
  }
  // 2) 渲染窗口内复选框的启用/禁用
  const cbs = [...document.querySelectorAll('tbody input[type=checkbox]')]
  let checked = 0, disabled = 0, enabledUnchecked = 0
  for (const c of cbs) {
    if (c.checked) checked++
    if (c.disabled) disabled++
    else if (!c.checked) enabledUnchecked++
  }
  // 3) 页面「已选择 N 位达人」还在不在
  let counter = null
  const msg = document.querySelector('.select_peoples_message')
  if (msg) { const m = /\u5df2\u9009\u62e9\s*(\d+)/.exec(text(msg)); if (m) counter = Number(m[1]) }
  // 4) 抽屉是否还开着
  const drawerTextarea = !!document.querySelector('textarea')
  const drawerTitles = [...document.querySelectorAll('div,span,h3')].filter(e => /^\u6279\u91cf\u6c9f\u901a$|^\u6279\u91cf\u9080\u7ea6/.test(text(e))).length
  return JSON.stringify({
    sentBadges, badgeSamples, checked, disabled, enabledUnchecked, rendered: cbs.length,
    counter, drawerTextarea, drawerTitles,
    scrollTop: (() => { const s = document.querySelector('.auxo-table-body'); return s ? Math.round(s.scrollTop) : null })()
  })
})()
