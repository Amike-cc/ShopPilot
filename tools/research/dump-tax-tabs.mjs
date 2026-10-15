/**
 * 涉税信息报送页 · 第二轮真机勘察（只读 + 只点两个页签）。
 *
 * 第一轮已经拿到主表表头；这一轮补齐三件事：
 *   ① 主表**数据行**的真实读法（第一轮的 firstRow 全空，说明单元格是嵌套结构，要换 innerText）
 *   ② 「汇总数据」页签里到底是什么表（列名）
 *   ③ 「导出记录」页签里到底是什么表（列名）
 *
 * 安全性：只点文案**恰好等于**「汇总数据」/「导出记录」的元素；绝不点「导出…」按钮
 * （那会在平台侧真的生成导出任务）。点完会切回「汇总数据」页签前的状态不做处理——
 * 因为这两个页签都是只读视图，不产生副作用。
 *
 * 用法：node tools/research/dump-tax-tabs.mjs [CDP端口]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const PORT = process.argv[2] || '9250'
const NEEDLE = 'tax-information-submission'
const sleep = ms => new Promise(r => setTimeout(r, ms))

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    this.ws.onmessage = event => {
      const msg = JSON.parse(event.data)
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(msg.error.message))
      else pending.resolve(msg.result)
    }
  }
  async send(method, params = {}) {
    await this.ready
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

/** 读表：单元格用 innerText，避免嵌套结构读出空串 */
const READ_TABLES = `(() => {
  const cell = el => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()
  return [...document.querySelectorAll('table')].map((t, i) => {
    const heads = [...t.querySelectorAll('thead tr')].map(tr => [...tr.children].map(cell))
    const rows = [...t.querySelectorAll('tbody tr')].slice(0, 4).map(tr => [...tr.children].map(cell))
    return { i, heads, bodyRows: t.querySelectorAll('tbody tr').length, rows }
  })
})()`

/** 页签候选：把可能是页签的元素连 class 一起列出来，便于确定选择器 */
const LIST_TABS = `(() => {
  const out = []
  const sel = '[role=tab],[role=tablist] > *,[class*=tabs] [class*=tab],[class*=Tabs] [class*=Tab],[class*=tab-item],[class*=tabItem]'
  for (const el of document.querySelectorAll(sel)) {
    const t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()
    if (!t || t.length > 14) continue
    out.push({ t, tag: el.tagName, cls: String(el.className || '').slice(0, 80), role: el.getAttribute('role') || '' })
  }
  const seen = new Set()
  return out.filter(x => { const k = x.t + '|' + x.cls; if (seen.has(k)) return false; seen.add(k); return true }).slice(0, 30)
})()`

async function clickTab(cdp, label) {
  return cdp.eval(`(() => {
    const want = ${JSON.stringify(label)}
    const cands = [...document.querySelectorAll('button,[role=tab],div,span,li,a')]
      .filter(el => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() === want)
    // 选最深的那个（页签文案通常在叶子节点上）
    const hit = cands.filter(el => el.children.length === 0).pop() || cands.pop()
    if (!hit) return null
    hit.click()
    return { tag: hit.tagName, cls: String(hit.className || '').slice(0, 80) }
  })()`)
}

async function shot(cdp, file) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const p = path.join(os.tmpdir(), file)
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'))
  return p
}

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const target = targets.find(t => (t.url || '').includes(NEEDLE))
  if (!target) throw new Error('涉税信息报送页面不在当前 targets 里（页面被关掉或导航走了？）')
  const cdp = new CDP(target.webSocketDebuggerUrl)

  console.log('=== 页签候选（tag / class / role） ===')
  for (const t of await cdp.eval(LIST_TABS)) console.log(`   「${t.t}」  ${t.tag}  role=${t.role}  class=${t.cls}`)

  console.log('\n=== 当前（汇总数据）表结构 ===')
  let tables = await cdp.eval(READ_TABLES)
  for (const t of tables) {
    console.log(`#${t.i} 数据行=${t.bodyRows}`)
    for (const h of t.heads) console.log('   表头: ' + JSON.stringify(h))
    t.rows.forEach((r, i) => console.log(`   行${i}: ` + JSON.stringify(r)))
  }
  console.log('SHOT: ' + await shot(cdp, 'tax-tab-summary.png'))

  console.log('\n=== 切「导出记录」 ===')
  console.log('   click -> ' + JSON.stringify(await clickTab(cdp, '导出记录')))
  await sleep(2500)
  tables = await cdp.eval(READ_TABLES)
  for (const t of tables) {
    console.log(`#${t.i} 数据行=${t.bodyRows}`)
    for (const h of t.heads) console.log('   表头: ' + JSON.stringify(h))
    t.rows.forEach((r, i) => console.log(`   行${i}: ` + JSON.stringify(r)))
  }
  console.log('SHOT: ' + await shot(cdp, 'tax-tab-export.png'))

  console.log('\n=== 切回「汇总数据」 ===')
  console.log('   click -> ' + JSON.stringify(await clickTab(cdp, '汇总数据')))
  await sleep(2000)

  cdp.close()
}

main().catch(error => { console.error('FAILED: ' + (error?.stack || error)); process.exit(1) })
