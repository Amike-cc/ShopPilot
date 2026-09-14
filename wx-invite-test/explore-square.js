/**
 * 摸带货者广场（micro-app shadow root 内）的列表页结构。
 * 输出：页签、筛选区、达人行结构（前 3 行的完整文本与「详情」按钮链路）。
 */
const expr = `(() => {
  const sr = document.querySelector('micro-app').shadowRoot
  const clean = s => String(s || '').replace(/\\s+/g, ' ').trim()
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()

  // 1) 顶层页签（推荐/找带货者/带货者招商/我的邀约/邀约模板）
  const tabCands = [...sr.querySelectorAll('*')].filter(e => visible(e) && ['推荐','找带货者','带货者招商','我的邀约','邀约模板'].includes(clean(own(e))))
  const tabs = tabCands.slice(0, 12).map(e => ({ text: clean(own(e)), tag: e.tagName, cls: String(e.className).slice(0, 50), clickableAncestor: !!e.closest('[class*=tab],[role=tab],li,a') }))

  // 2) 「详情」按钮：链路与所在行
  const detailBtns = [...sr.querySelectorAll('*')].filter(e => clean(own(e)) === '详情' && visible(e))
  const rows = detailBtns.slice(0, 3).map(btn => {
    // 向上找行容器：含达人昵称的较大块
    let row = btn
    for (let i = 0; i < 12 && row; i++) {
      row = row.parentElement
      if (row && row.textContent.includes('粉丝数')) break
    }
    const chain = []
    let p = btn
    for (let i = 0; i < 8 && p; i++) {
      const r = p.getBoundingClientRect()
      chain.push(p.tagName + (p.className && typeof p.className === 'string' ? '.' + String(p.className).split(' ').slice(0,2).join('.') : '') + '[' + Math.round(r.width) + 'x' + Math.round(r.height) + ']')
      p = p.parentElement
    }
    return { rowText: row ? clean(row.textContent).slice(0, 220) : null, chain }
  })

  // 3) 筛选区概览：类目 chips、展开、下拉触发器
  const filterTexts = {}
  for (const label of ['带货类目','近30日带货数据','带货者画像','其他筛选','全部带货者','直播带货者','短视频带货者','公众号带货者','展开']) {
    const hit = [...sr.querySelectorAll('*')].find(e => visible(e) && clean(own(e)) === label)
    if (hit) {
      const box = hit.closest('div')
      let area = hit
      for (let i = 0; i < 4 && area && area.textContent.length < 60; i++) area = area.parentElement
      filterTexts[label] = clean((area ? area.textContent : '').slice(0, 200))
    }
  }

  // 4) 行复选框：有没有批量勾选的能力（对照抖店批量邀约）
  const checkboxes = [...sr.querySelectorAll('input[type=checkbox]')].length

  // 5) 当前微应用路由
  const micro = document.querySelector('micro-app')
  return JSON.stringify({
    tabs, rows, filterTexts, checkboxes,
    microAttrs: micro ? [...micro.attributes].map(a => a.name + '=' + String(a.value).slice(0, 60)) : [],
    bodyUrl: location.href
  }, null, 1)
})()`
require('child_process').execFileSync(
  'node', ['wx-invite-test/cdp.js', 'exec', '0', expr], { stdio: 'inherit', cwd: __dirname + '/..' }
)
