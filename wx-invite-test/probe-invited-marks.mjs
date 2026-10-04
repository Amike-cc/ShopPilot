/**
 * 量：广场列表里"已邀约过"的达人有没有标记 / 能不能拿到稳定标识（finderUsername）。
 *
 * 背景（用户要求）：7 天内邀过的达人不再重复邀约。平台在**详情页**会禁用「邀请带货」并提示
 * "你已经邀请过该达人，7天内不可再次发送带货邀约"（引擎已按 TASK_DAREN_ALREADY_INVITED 跳过），
 * 但那要**先点进详情页**才发现——既慢又吃 onCode 的 advance 次数。
 * 这里量两件事，决定能不能在"点详情之前"就跳过：
 *   ① 列表行里有没有"已邀约/已邀请"之类的标记文案；
 *   ② 行里有没有能拿到 finderUsername 的链接/属性（用于稳定识别，而不是靠昵称）。
 *
 * 用法：node wx-invite-test/probe-invited-marks.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
const STORE = process.env.SHOPILOT_WX_STORE || 'store_4eb9b43cffeee0094041894a9f1f93bf'
const SQUARE = 'https://store.weixin.qq.com/shop/findersquare/find'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, er) => { ws.onopen = ok; ws.onerror = er })
  let s = 0
  const p = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } }
  const send = (me, pa = {}) => new Promise((ok, er) => { const id = ++s; p.set(id, m => m.error ? er(new Error(JSON.stringify(m.error))) : ok(m.result)); ws.send(JSON.stringify({ id, method: me, params: pa })) })
  const ev = async (x, timeoutMs = 20000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 超时')), timeoutMs))])
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200))
    return r.result.value
  }
  return { ev, call: async x => JSON.parse(await ev(`(async()=>JSON.stringify(await ${x}))()`)), close: () => ws.close() }
}

/** 把每一行达人的完整结构 dump 出来（昵称、行内全部自有文本、链接/属性里的 finderUsername） */
const ROWS = `(() => {
  const all = []; const walk = r => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document)
  const own = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const rows = all.filter(e => e.tagName === 'TR' && vis(e))
  const out = []
  for (const tr of rows.slice(0, 12)) {
    const texts = [...new Set(all.filter(e => tr.contains(e) && own(e)).map(e => own(e)))].slice(0, 24)
    const links = [...tr.querySelectorAll('a')].map(a => String(a.getAttribute('href') || a.getAttribute('data-href') || '')).filter(Boolean).slice(0, 4)
    const attrs = []
    for (const el of tr.querySelectorAll('*')) {
      for (const name of ['data-finder-username', 'data-username', 'data-id', 'data-key', 'data-finder-id']) {
        const v = el.getAttribute && el.getAttribute(name)
        if (v) attrs.push(name + '=' + String(v).slice(0, 40))
      }
    }
    // 行里有没有"已邀约/已邀请/已合作"这类标记
    const marks = texts.filter(t => /已邀约|已邀请|已合作|7天|不可再次/.test(t))
    out.push({ texts, links, attrs: [...new Set(attrs)].slice(0, 4), marks })
  }
  const pageMarks = [...new Set(all.filter(e => vis(e) && own(e) && /已邀约|已邀请|已合作|7天/.test(own(e))).map(e => own(e)))].slice(0, 10)
  return JSON.stringify({ rowCount: rows.length, pageMarks, rows: out })
})()`

async function main() {
  const list = await targets()
  const renderer = list.find(t => t.type === 'page' && String(t.url).includes('out/renderer/index.html'))
  const app = await connect(renderer)
  await app.call(`window.shopilot.browser.display('${STORE}')`)
  await sleep(1500)

  const tabs = (await app.call(`window.shopilot.browser.tab.list('${STORE}')`))?.data?.tabs || []
  const square = tabs.find(t => /findersquare\/find$/.test(String(t.url)))
  if (square) { await app.call(`window.shopilot.browser.tab.activate('${STORE}', '${square.id}')`); await sleep(3000) }
  else { await app.call(`window.shopilot.browser.tab.create('${STORE}', '${SQUARE}')`); await sleep(10000) }

  const page = (await targets()).find(t => /findersquare\/find/.test(String(t.url)))
  if (!page) { console.log('没有广场页目标'); process.exit(1) }
  const conn = await connect(page)
  // 微应用挂载要几秒：等表格行真的出来再 dump
  let data = null
  for (let i = 0; i < 20; i++) {
    const path = await conn.ev(`location.pathname`).catch(() => '?')
    const raw = await conn.ev(ROWS).catch(() => null)
    if (raw) { const parsed = JSON.parse(raw); if (parsed.rowCount > 0) { data = parsed; break } }
    if (i % 4 === 0) console.log(`等待列表渲染… path=${path}`)
    await sleep(2000)
  }
  if (!data) { console.log('❌ 20 次轮询后列表仍无行'); process.exit(1) }
  console.log('列表行数:', data.rowCount)
  console.log('页面级标记文案:', JSON.stringify(data.pageMarks))
  console.log('')
  for (const [i, row] of data.rows.entries()) {
    console.log(`行${i + 1}: marks=${JSON.stringify(row.marks)} links=${JSON.stringify(row.links)} attrs=${JSON.stringify(row.attrs)}`)
    console.log(`      文本=${JSON.stringify(row.texts.slice(0, 10))}`)
  }
  fs.mkdirSync('wx-invite-test/evidence', { recursive: true })
  fs.writeFileSync(path.resolve('wx-invite-test/evidence/invited-marks.json'), JSON.stringify(data, null, 1))
  console.log('\n留档: wx-invite-test/evidence/invited-marks.json')
  conn.close()
  app.close()
  process.exit(0)
}

main().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1) })
