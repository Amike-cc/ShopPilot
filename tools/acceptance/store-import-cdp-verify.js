/**
 * 店铺清单导入验收（2026-11-10 / 0.9.18）
 *
 * 1) 预置 CSV（1 可新增 / 1 重复 / 1 不合法）；
 * 2) 商城「导入清单」预览计数正确；
 * 3) 只导入选中行，新店落库且分组/标签/执照正确；
 * 4) 重复行不会重复创建。
 *
 * 运行：node tools/acceptance/store-import-cdp-verify.js
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { childEnv } = require('./app-launch')

const ROOT = path.resolve(__dirname, '../..')
const PORT = Number(process.env.SHOPILOT_IMPORT_CDP_PORT || 9424)
const RUNTIME = process.env.SHOPILOT_RUNTIME_EXE || 'D:\\ShopPilot-runtime\\electron.exe'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data)
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  async eval(body, timeoutMs = 20000) {
    const result = await Promise.race([
      this.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true }),
      sleep(timeoutMs).then(() => ({ timeout: true }))
    ])
    if (result.timeout) throw new Error(`页面求值超时：${String(body).replace(/\s+/g, ' ').slice(0, 100)}`)
    if (result.exceptionDetails) throw new Error('页面异常：' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text))
    return result.result.value
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

const checks = []
function check(name, pass, detail = '') {
  checks.push({ name, pass: !!pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}

async function findUi(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const target = list.find(item => item.type === 'page' && item.url.includes('index.html'))
      if (target) {
        const cdp = new CDP(target.webSocketDebuggerUrl)
        await cdp.ready
        return cdp
      }
    } catch { /* retry */ }
    await sleep(400)
  }
  throw new Error('主窗口 CDP 未就绪')
}

async function click(ui, selector) {
  return ui.eval(`
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return { ok: false, reason: 'not found' }
    el.click()
    return { ok: true }
  `)
}

async function main() {
  const userData = path.join(os.tmpdir(), 'shopilot-store-import-' + Date.now())
  const csvPath = path.join(userData, 'import.csv')
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(csvPath, [
    '店铺名称,平台,后台地址,分组,标签,负责人,地区,外部编码,营业执照主体名称,统一社会信用代码,备注',
    '"导入甲店",抖店,https://fxg.jinritemai.com,导入组,"重点, 售后",李四,杭州,IMP-1,杭州某某公司,91330100MA2ABCDE12,"导入备注"',
    '已有店,拼多多,https://mms.pinduoduo.com,,,王五,上海,,,,' ,
    ',抖店,https://fxg.jinritemai.com,,, , ,,,,,'
  ].join('\r\n'), 'utf8')
  if (!fs.existsSync(RUNTIME)) throw new Error(`找不到验收运行时：${RUNTIME}`)
  const packaged = process.env.SHOPILOT_ACCEPTANCE_PACKAGED === '1'
  const args = [...(packaged ? [] : [ROOT]), '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`]
  const child = spawn(RUNTIME, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv({
      NODE_ENV: 'production', SHOPILOT_ACCEPTANCE: '1', SHOPILOT_DISABLE_CDP_FP: '1',
      SHOPILOT_TEST_STORE_IMPORT_CSV: csvPath
    })
  })
  let appLog = ''
  child.stdout.on('data', chunk => { appLog += chunk.toString() })
  child.stderr.on('data', chunk => { appLog += chunk.toString() })

  let ui = null
  try {
    ui = await findUi()
    await sleep(900)
    const existing = await ui.eval(`return await window.shopilot.store.create({ name: '已有店', platform: '拼多多', adminUrl: 'https://mms.pinduoduo.com' })`)
    if (!existing.ok) throw new Error('创建已有店失败：' + JSON.stringify(existing.error))
    await click(ui, '[data-test="nav-stores"]')
    await sleep(700)
    const opened = await click(ui, '[data-test="store-import-csv"]')
    await sleep(900)
    const summary = await ui.eval(`return document.querySelector('[data-test="store-import-summary"]')?.textContent || ''`)
    check('导入预览正确分类（可新增/重复/不合法）', opened.ok && summary.includes('可新增 1') && summary.includes('重复 1') && summary.includes('不合法 1'), summary)
    check('预览表格可新增行默认勾选', await ui.eval(`return document.querySelector('[data-test="store-import-row-2"]')?.checked === true`))
    await click(ui, '[data-test="store-import-apply"]')
    await sleep(1500)
    const list = await ui.eval(`return await window.shopilot.store.list()`)
    const imported = list.ok ? list.data.find(item => item.name === '导入甲店') : null
    const duplicates = list.ok ? list.data.filter(item => item.name === '已有店') : []
    check('导入后新店落库且元数据完整', imported?.platform === '抖店' && imported?.groupName === '导入组'
      && imported?.owner === '李四' && imported?.region === '杭州' && imported?.externalCode === 'IMP-1'
      && imported?.licenseName === '杭州某某公司' && imported?.notes === '导入备注',
      JSON.stringify({ imported }))
    check('重复行没有重复创建', duplicates.length === 1 && list.ok && list.data.filter(item => item.name === '导入甲店').length === 1,
      JSON.stringify({ existingCount: duplicates.length, importedCount: list.data?.filter(item => item.name === '导入甲店').length }))
  } finally {
    if (ui) ui.close()
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
  }

  const failed = checks.filter(item => !item.pass)
  console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`)
  if (failed.length) {
    console.log('失败项：' + failed.map(item => item.name).join('；'))
    if (appLog) console.log('应用日志尾部：\n' + appLog.slice(-2000))
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error('验收异常：', error?.stack || error)
  process.exitCode = 1
})
