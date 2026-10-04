/**
 * 快手小店（快分销达人广场）**逐锚点真机审计**（2026-10-04）。
 *
 * 为什么要这个：快手批量邀约流程是 2026-09-15 量出来的，**至今从未在真机跑过一次**
 * （库里没有快手邀约任务、日志里只有销量采集）。档案里写了几十个文案/选择器，
 * 只要有一个改版失效，整批就会在对应步骤上失败——而失败点在哪、平台现在长什么样，
 * 只有上真机逐个对一遍才知道。
 *
 * 本脚本只**读**页面（外加点一次类目 chip 验证级联弹层与生效标记），不点「批量邀约」、
 * 不打开邀约抽屉、不发送任何邀约。
 *
 * 用法：node wx-invite-test/probe-ks-audit-2026-10-04.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_KS_STORE || 'store_3856e71a3ae8499ebdbec1f4ccbb4394'
const SQUARE = 'https://cps.kwaixiaodian.com/zone/daren-match/daren-square-pro'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, er) => { ws.onopen = ok; ws.onerror = er })
  let s = 0
  const p = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } }
  const send = (me, pa = {}) => new Promise((ok, er) => { const id = ++s; p.set(id, m => m.error ? er(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: me, params: pa })) })
  const ev = async (x, timeoutMs = 25000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 超时')), timeoutMs))])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  return { send, ev, call: async x => JSON.parse(await ev(`(async()=>JSON.stringify(await ${x}))()`)), close: () => ws.close() }
}

const CATS = ['零食饮料', '家居百货', '女装女鞋', '美妆护肤', '个护家清', '营养健康', '母婴玩具', '生鲜食品', '男装男鞋', '运动户外', '数码家电', '珠宝文玩', '茶叶酒水', '箱包配饰', '图书学习', '花宠园艺', '童装童鞋', '内衣裤袜']
const TAGS = ['三农', '美妆', '美食', '亲子', '其他']
const COOPS = ['有联系方式', '无坑位费', '招商中达人', '专属推荐']
const BENEFITS = ['免费申样', '可聊高佣', '素材支持', '支持投流', '24h发货', '可破价']

/** 页面体检：档案里每个锚点是否还在，逐条量出来 */
const AUDIT = `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const has = t => all.some(e => own(e).includes(t))
  const visHas = t => all.some(e => own(e).includes(t) && vis(e))
  const q = s => { try { return document.querySelectorAll(s).length } catch { return -1 } }
  const body = String(document.body ? document.body.innerText : '')
  const rowOf = label => { const el = all.find(e => own(e) === label); if (!el) return null; let u = el; for (let i = 0; i < 2; i++) u = u ? u.parentElement : null; return u }

  const rowLabels = ['内容标签', '带货类目', '带货数据', '合作信息']
  const rows = rowLabels.map(label => {
    const el = all.find(e => own(e) === label)
    const up2 = rowOf(label)
    return {
      label,
      found: !!el,
      up2Class: up2 ? String(up2.className || '').slice(0, 60) : null,
      up2ChildCount: up2 ? up2.children.length : 0,
      up2Text: up2 ? String(up2.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 70) : null
    }
  })

  const catRow = rowOf('带货类目')
  const inRowOf = (row, list) => list.filter(t => row && [...row.querySelectorAll('*')].some(e => own(e) === t))
  const catInRow = inRowOf(catRow, ${JSON.stringify(CATS)})
  const tagRow = rowOf('内容标签')
  const coopRow = rowOf('合作信息')

  return JSON.stringify({
    url: location.href,
    title: document.title,
    loginish: /扫码登录|登录后/.test(body.slice(0, 500)),
    rows,
    categories: { inRow: catInRow.length, of: ${CATS.length}, missingInRow: ${JSON.stringify(CATS)}.filter(c => !catInRow.includes(c)) },
    tagsInRow: inRowOf(tagRow, ${JSON.stringify(TAGS)}),
    coopsInRow: inRowOf(coopRow, ${JSON.stringify(COOPS)}),
    selectors: {
      categoryPopover: q('.kwaishop-cps-daren-match-pc-select-dropdown'),
      filteredScope: q('.kwaishop-cps-daren-match-pc-pro-tagForm-result'),
      rowCheckbox_tbody: q('tbody input[type=checkbox]'),
      allCheckbox: q('input[type=checkbox]'),
      tbody: q('tbody'),
      textarea: q('textarea'),
      rowClass: q('[class*="kwaishop-cps-daren-match-pc-row"]'),
      modalBody: q('.kwaishop-cps-daren-match-pc-modal-body')
    },
    texts: {
      batchInvite: visHas('批量邀约'),
      quotaToday: has('今日剩余'),
      quotaSample: (body.match(/今日剩余[^\\n]{0,30}/) || [null])[0],
      counterSample: (body.match(/已选[^\\n]{0,20}/) || [null])[0],
      chooseGoods: visHas('选择商品'),
      contactPlaceholder: q('input[placeholder*="常用联系人称呼"]'),
      phonePlaceholder: q('input[placeholder*="常用11位手机号"]'),
      wechatPlaceholder: q('input[placeholder*="常用微信号"]'),
      cooperationTag: visHas('合作标签'),
      benefitsPresent: ${JSON.stringify(BENEFITS)}.filter(t => has(t)),
      searchButton: visHas('搜索'),
      levelTrigger: has('达人等级')
    },
    tables: [...document.querySelectorAll('tbody')].map(tb => {
      const trs = [...tb.querySelectorAll('tr')]
      return { rows: trs.length, checkboxes: tb.querySelectorAll('input[type=checkbox]').length, firstRow: trs[0] ? String(trs[0].innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 50) : '' }
    }).slice(0, 4),
    bodyHead: body.replace(/\\s+/g, ' ').trim().slice(0, 200)
  })
})()`

const list = await targets()
const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
if (!renderer) { console.error('未找到应用渲染层'); process.exit(1) }
const app = await connect(renderer)
await app.call(`window.shopilot.browser.display('${STORE}')`)
await sleep(2000)
const tabs = (await app.call(`window.shopilot.browser.tab.list('${STORE}')`))?.data?.tabs || []
const square = tabs.find(t => /daren-square|daren-match/.test(String(t.url)))
if (square) {
  await app.call(`window.shopilot.browser.tab.activate('${STORE}', '${square.id}')`)
  await app.call(`window.shopilot.browser.navigate('${STORE}', '${square.id}', '${SQUARE}')`).catch(() => null)
} else {
  await app.call(`window.shopilot.browser.tab.create('${STORE}', '${SQUARE}')`)
}
await sleep(15000)

const page = (await targets()).find(t => /daren-square|daren-match/.test(String(t.url)))
if (!page) { console.error('没打开达人广场'); process.exit(1) }
const conn = await connect(page)
let audit = null
for (let i = 0; i < 14; i++) {
  const raw = await conn.ev(AUDIT).catch(() => null)
  if (raw) { audit = JSON.parse(raw); if (audit.rows.some(r => r.found)) break }
  await sleep(2500)
}
if (!audit) { console.error('页面体检失败'); process.exit(1) }
console.log(JSON.stringify(audit, null, 1))
fs.mkdirSync('wx-invite-test/evidence', { recursive: true })
fs.writeFileSync(path.resolve('wx-invite-test/evidence/ks-anchors-2026-10-04.json'), JSON.stringify({ at: new Date().toISOString(), audit }, null, 1))

// 二级验证：点一个类目 chip → 级联弹层 + 叶子项 + 生效标记（不改任何数据）
console.log('\n=== 级联弹层与生效标记（点「个护家清」→ 点「全部」）===')
const findPos = async (t, scopeSel) => conn.ev(`(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const scope = ${scopeSel ? `document.querySelector(${JSON.stringify(scopeSel)})` : 'null'}
  const cands = all.filter(e => own(e) === ${JSON.stringify(t)} && (!scope || scope.contains(e)))
  if (!cands.length) return JSON.stringify({ ok: false })
  const el = cands[0]
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return JSON.stringify({ ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
})()`)
const realClick = async (x, y) => {
  await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

const chip = JSON.parse(await findPos('个护家清'))
console.log('类目 chip:', chip)
if (chip.ok) { await realClick(chip.x, chip.y); await sleep(2500) }
console.log('弹层数量:', await conn.ev(`document.querySelectorAll('.kwaishop-cps-daren-match-pc-select-dropdown').length`))
console.log('弹层内容:', await conn.ev(`(() => {
  const dd = document.querySelector('.kwaishop-cps-daren-match-pc-select-dropdown')
  if (!dd) return 'no-popover'
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const r = dd.getBoundingClientRect()
  const items = [...dd.querySelectorAll('*')].map(own).filter(Boolean)
  return JSON.stringify({ rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }, items: [...new Set(items)].slice(0, 14) })
})()`))
const leaf = JSON.parse(await findPos('全部', '.kwaishop-cps-daren-match-pc-select-dropdown'))
console.log('叶子「全部」:', leaf)
if (leaf.ok) { await realClick(leaf.x, leaf.y); await sleep(3000) }
console.log('生效标记:', await conn.ev(`(() => {
  const el = document.querySelector('.kwaishop-cps-daren-match-pc-pro-tagForm-result')
  return JSON.stringify({ exists: !!el, text: el ? String(el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 90) : null })
})()`))
console.log('页面计数文案:', await conn.ev(`(() => { const b = String(document.body.innerText); return JSON.stringify({ counter: (b.match(/已选[^\\n]{0,24}/) || [null])[0] }) })()`))
conn.close()
app.close()
process.exit(0)
