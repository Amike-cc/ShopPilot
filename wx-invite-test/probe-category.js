(async () => {
  const CAT = '\u4e2a\u62a4\u5bb6\u6e05'          // 个护家清
  const LVTRIG = '\u8fbe\u4eba\u7b49\u7ea7'        // 达人等级
  const SEARCH = '\u641c\u7d22'                    // 搜索
  const FILTERED = '\u5df2\u7b5b\u9009'            // 已筛选

  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const own = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const text = el => String(el.innerText || '').replace(/\s+/g, ' ').trim()
  const visible = el => {
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) return false
    const s = getComputedStyle(el)
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05
  }
  const candsOf = (needle) => {
    const out = []
    for (const el of document.querySelectorAll('*')) {
      const o = own(el)
      if (!o.includes(needle)) continue
      out.push({ el, len: o.length })
    }
    out.sort((a, b) => a.len - b.len)
    return out
  }
  const describe = el => {
    const r = el.getBoundingClientRect()
    return {
      tag: el.tagName, cls: String(el.className).slice(0, 50),
      own: own(el).slice(0, 30),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      vis: visible(el),
      parentCls: String(el.parentElement && el.parentElement.className).slice(0, 40),
      grandCls: String(el.parentElement && el.parentElement.parentElement && el.parentElement.parentElement.className).slice(0, 40)
    }
  }
  const clickText = async (needle) => {
    const all = candsOf(needle)
    const vis = all.filter(c => visible(c.el))
    if (!vis.length) return { needle, ok: false, reason: 'NOT_FOUND', total: all.length }
    const hit = vis[0].el
    const info = describe(hit)
    hit.click()
    return { needle, ok: true, picked: info, candidatesAll: all.length, candidatesVisible: vis.length }
  }

  const out = { steps: [] }
  // 0) 先看筛选区里"主推类目"这一行的结构
  const rowLabel = [...document.querySelectorAll('div,span,label')].find(e => own(e) === '\u4e3b\u63a8\u7c7b\u76ee')
  out.categoryRowLabel = rowLabel ? describe(rowLabel) : null
  if (rowLabel) {
    const row = rowLabel.parentElement
    out.categoryRowChips = [...(row ? row.children : [])].slice(0, 14).map(c => describe(c))
  }

  out.steps.push(await clickText(CAT))
  await sleep(1500)
  out.afterCategory = {
    filteredTags: (() => {
      const t = [...document.querySelectorAll('*')].find(e => own(e) === FILTERED)
      return t ? text(t.parentElement).slice(0, 160) : null
    })(),
    chipState: (() => {
      const c = candsOf(CAT).filter(x => visible(x.el))[0]
      return c ? describe(c.el) : null
    })()
  }

  out.steps.push(await clickText(LVTRIG))
  await sleep(900)
  for (const lv of ['LV0', 'LV1', 'LV2', 'LV3']) {
    out.steps.push(await clickText(lv))
    await sleep(400)
  }
  out.steps.push(await clickText(SEARCH))
  await sleep(5000)

  const rows = [...document.querySelectorAll('tbody tr[data-row-key]')]
  out.result = {
    rows: rows.length,
    filteredTags: (() => {
      const t = [...document.querySelectorAll('*')].find(e => own(e) === FILTERED)
      return t ? text(t.parentElement).slice(0, 200) : null
    })(),
    firstRows: rows.slice(0, 3).map(tr => text(tr).slice(0, 70)),
    rowsWithCategory: rows.filter(tr => text(tr).includes(CAT)).length
  }
  return JSON.stringify(out, null, 1)
})()
