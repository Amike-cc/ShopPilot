/**
 * 真机锚点勘察：连到**正在运行的**应用里某个店铺页面（CDP target），把它的结构读出来。
 *
 * 用途：本仓库的红线是"锚点必须实测"——登记新平台/新页面之前，先在这个页面上把
 * 真实表头、标签、页签、分页读出来，再据此写 constants 档案。**只读，不改页面状态**
 * （不点击、不提交、不导航，只看当前已经打开的那一页）。
 *
 * 用法：
 *   node tools/research/dump-page-anchors.mjs [URL片段] [CDP端口]
 * 默认：片段 = tax-information-submission，端口 = 9250
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const NEEDLE = process.argv[2] || 'tax-information-submission'
const PORT = process.argv[3] || process.env.SHOPILOT_CDP_PORT || '9250'

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

/** 在页面里跑的结构勘察（纯读） */
const PROBE = `(() => {
  const text = el => (el?.textContent || '').replace(/\\s+/g, ' ').trim()
  const tables = [...document.querySelectorAll('table')].map((t, i) => {
    const heads = [...t.querySelectorAll('thead tr')].map(tr => [...tr.children].map(text))
    const bodyRows = t.querySelectorAll('tbody tr').length
    const firstRow = [...(t.querySelector('tbody tr')?.children || [])].map(text)
    return { i, heads, bodyRows, firstRow }
  })
  // 「标签 + 相邻值」型卡片（发票中心已用过 labels 模式）
  const labelish = []
  const LABEL_RE = /(报送|申报|税款|税额|收入|金额|合计|期间|季度|月份|状态|时间|主体|税号|纳税人|已缴|应缴|代扣|凭证)/
  for (const el of document.querySelectorAll('div,span,td,th,label,p,dt,dd')) {
    if (el.children.length > 0) continue
    const t = text(el)
    if (!t || t.length > 24 || !LABEL_RE.test(t)) continue
    const near = text(el.parentElement)
    if (near && near.length <= 120) labelish.push(t + ' = ' + near.replace(t, '').trim())
    if (labelish.length > 60) break
  }
  const tabs = [...document.querySelectorAll('[role=tab],.ant-tabs-tab,.arco-tabs-tab,[class*=tab]')]
    .map(text).filter(t => t && t.length <= 20)
  const nav = [...document.querySelectorAll('a,[class*=menu] [class*=item],li')]
    .map(text).filter(t => t && t.length <= 16 && /(税务|涉税|发票|资金|账务|报送|申报)/.test(t))
  return {
    url: location.href,
    title: document.title,
    tables,
    labelish: [...new Set(labelish)],
    tabs: [...new Set(tabs)].slice(0, 25),
    nav: [...new Set(nav)].slice(0, 30),
    iframes: [...document.querySelectorAll('iframe')].map(f => f.src).slice(0, 5),
    bodyLen: document.body ? document.body.innerText.length : 0,
    bodyHead: (document.body ? document.body.innerText : '').replace(/\\n{2,}/g, '\\n').slice(0, 1200)
  }
})()`

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const hits = targets.filter(t => (t.url || '').includes(NEEDLE))
  if (!hits.length) {
    console.log('没找到匹配的 target。当前 targets：')
    for (const t of targets) console.log(`  ${t.type}\t${t.url}`)
    process.exit(1)
  }
  const target = hits[0]
  console.log('TARGET: ' + target.type + '  ' + target.url)
  const cdp = new CDP(target.webSocketDebuggerUrl)
  const info = await cdp.eval(PROBE)

  console.log('\n=== URL / TITLE ===')
  console.log(info.url)
  console.log(info.title)

  console.log(`\n=== TABLES (${info.tables.length}) ===`)
  for (const t of info.tables) {
    console.log(`#${t.i}  数据行=${t.bodyRows}`)
    for (const h of t.heads) console.log('   表头: ' + JSON.stringify(h))
    if (t.firstRow.length) console.log('   首行: ' + JSON.stringify(t.firstRow))
  }

  console.log(`\n=== 标签候选 (${info.labelish.length}) ===`)
  for (const l of info.labelish) console.log('   ' + l)

  console.log(`\n=== 页签 ===\n   ` + info.tabs.join(' | '))
  console.log(`\n=== 含"税务/涉税/报送"的导航项 ===\n   ` + info.nav.join(' | '))
  if (info.iframes.length) console.log('\n=== IFRAMES ===\n   ' + info.iframes.join('\n   '))
  console.log(`\n=== 正文前 1200 字（用于确认页面性质） ===\n${info.bodyHead}`)

  // 截图：路径含空格/中文时用绝对路径
  const shotPath = path.join(os.tmpdir(), 'tax-page-anchors.png')
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
  console.log('\nSCREENSHOT: ' + shotPath)
  cdp.close()
}

main().catch(error => { console.error('FAILED: ' + (error?.stack || error)); process.exit(1) })
