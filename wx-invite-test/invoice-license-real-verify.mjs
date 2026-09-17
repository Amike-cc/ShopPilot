/**
 * 真机实测（**真实店铺数据**）：发票中心「营业执照」在用户自己的库上跑一遍。
 *
 * 为什么单独一份：桌面自动化在这个 Electron 窗口上敲不进字（窗口没有 a11y 树，
 * 键盘事件只到窗口的输入宿主、到不了页面里的 input），所以真机打字这一环要用渲染层脚本走。
 *
 * 这份脚本只做三件事，且**做完会把数据还原**：
 *   1. 给快手小店「福气满满」填营业执照 → 看筛选条是否裂成「该主体」+「未填写」；
 *   2. 点该主体胶囊 → 总览合计应缩成这家店自己的数；
 *   3. 清空营业执照 → 库与界面都回到原样。
 * 用法：node wx-invite-test/invoice-license-real-verify.mjs [CDP端口]
 */
import { spawn, execSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = process.argv[2] || '9264'
const STORE_NAME = '福气满满'
const LIC_NAME = '夏邑县唯衣美服装工作室'

const results = []
const sleep = ms => new Promise(r => setTimeout(r, ms))
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}
function killTree(child) {
  if (!child || child.exitCode !== null) return
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* gone */ }
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data)
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result)
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  async eval(expr) {
    await this.ready
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function waitForCDP(timeoutMs = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return } catch { /* retry */ }
    await sleep(400)
  }
  throw new Error('CDP endpoint not ready')
}

async function connectUi() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const target = targets.find(t => t.type === 'page' && t.url.includes('/renderer/index.html'))
  if (!target) throw new Error('UI target not found')
  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.eval(`const until = Date.now() + 15000; while (!window.shopilot && Date.now() < until) await new Promise(r => setTimeout(r, 100)); return true`)
  return cdp
}

const CHIPS = `[...document.querySelectorAll('[data-test="invoice-license-bar"] .inv-lic-chip')].map(el => el.textContent.replace(/\\s+/g, ' ').trim())`
const TOTALS = `[...document.querySelectorAll('[data-test="invoice-totals"] .dc-num')].map(el => el.textContent.trim())`

function realStoreRow(storeName) {
  const db = new DatabaseSync(path.join(process.env.APPDATA, 'shopilot', 'shopilot.db'))
  try {
    return db.prepare('SELECT name, license_name, license_no FROM stores WHERE name = ? AND deleted_at IS NULL').get(storeName)
  } finally { db.close() }
}

async function main() {
  console.log('=== 真机实测：真实店铺库上的发票中心营业执照（用完即还原） ===')
  const before = realStoreRow(STORE_NAME)
  if (!before) throw new Error(`真实库里没有店铺「${STORE_NAME}」，先确认环境`)
  check('实测前该店铺没有营业执照（还原基线）', !before.license_name && !before.license_no, JSON.stringify(before))

  const app = spawn(electronExe, [root, '--no-sandbox', `--remote-debugging-port=${PORT}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
  { cwd: root, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' } })

  let ui = null
  try {
    await waitForCDP()
    await sleep(1200)
    ui = await connectUi()
    await ui.eval(`const until = Date.now() + 15000; while (document.querySelectorAll('[data-test="store-card"]').length < 4 && Date.now() < until) await new Promise(r => setTimeout(r, 200)); return true`)
    await ui.eval(`document.querySelector('[data-test="invoice-center-open"]').click(); return true`)
    await ui.eval(`const until = Date.now() + 15000; while (!document.querySelector('[data-test="invoice-license-bar"]') && Date.now() < until) await new Promise(r => setTimeout(r, 200)); return true`)

    const chipsBefore = await ui.eval(`return ${CHIPS}`)
    const totalsBefore = await ui.eval(`return ${TOTALS}`)
    console.log('  实测前：', JSON.stringify(chipsBefore), JSON.stringify(totalsBefore))

    // 1. 行内填营业执照（真实数据，名称取自这家店自己发票行里的收票主体）
    await ui.eval(`
      const id = [...document.querySelectorAll('[data-test="invoice-row"]')]
        .find(el => el.querySelector('.inv-row-head > b')?.textContent.trim() === ${JSON.stringify(STORE_NAME)})
        .querySelector('[data-test^="invoice-store-license-"]').dataset.test.replace('invoice-store-license-', '')
      document.querySelector('[data-test="invoice-store-license-' + id + '"]').click()
      await new Promise(r => setTimeout(r, 200))
      const name = document.querySelector('[data-test="invoice-license-name"]')
      name.value = ${JSON.stringify(LIC_NAME)}
      name.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('[data-test="invoice-license-save"]').click()
      return true
    `)
    await sleep(900)
    const chipsAfter = await ui.eval(`return ${CHIPS}`)
    check('填完后筛选条裂成「该主体 1 家」+「未填写 3 家」',
      chipsAfter.length === 3 && chipsAfter[1].includes(LIC_NAME) && chipsAfter[1].includes('1 家') &&
      chipsAfter[2].includes('未填写营业执照') && chipsAfter[2].includes('3 家'),
      JSON.stringify(chipsAfter))
    check('真实库已写入（主体名称落库）', realStoreRow(STORE_NAME)?.license_name === LIC_NAME, JSON.stringify(realStoreRow(STORE_NAME)))

    // 2. 点该主体胶囊 → 合计缩成这家店自己的数（对比"全部"的数，必须更小）
    await ui.eval(`
      [...document.querySelectorAll('[data-test="invoice-license-bar"] .inv-lic-chip')]
        .find(el => el.textContent.includes(${JSON.stringify(LIC_NAME)})).click()
      return true
    `)
    await sleep(400)
    const totalsFiltered = await ui.eval(`return ${TOTALS}`)
    const storesFiltered = await ui.eval(`return [...document.querySelectorAll('[data-test="invoice-row"] .inv-row-head > b')].map(el => el.textContent.trim())`)
    check('按该主体筛选后只剩这一家店', JSON.stringify(storesFiltered) === JSON.stringify([STORE_NAME]), JSON.stringify(storesFiltered))
    check('筛选后合计变成这家店自己的数（比"全部"小，且条数不为 0）',
      Number(totalsFiltered[0]) > 0 && Number(totalsFiltered[0]) < Number(totalsBefore[0]) && totalsFiltered[1] !== totalsBefore[1],
      `${JSON.stringify(totalsBefore)} → ${JSON.stringify(totalsFiltered)}`)

    // 3. 还原：清空营业执照
    await ui.eval(`
      const id = [...document.querySelectorAll('[data-test="invoice-row"]')]
        .find(el => el.querySelector('.inv-row-head > b')?.textContent.trim() === ${JSON.stringify(STORE_NAME)})
        .querySelector('[data-test^="invoice-store-license-"]').dataset.test.replace('invoice-store-license-', '')
      document.querySelector('[data-test="invoice-store-license-' + id + '"]').click()
      await new Promise(r => setTimeout(r, 200))
      for (const sel of ['[data-test="invoice-license-name"]', '[data-test="invoice-license-no"]']) {
        const el = document.querySelector(sel)
        el.value = ''
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      document.querySelector('[data-test="invoice-license-save"]').click()
      return true
    `)
    await sleep(900)
    const restored = realStoreRow(STORE_NAME)
    check('还原：清空后库里两个字段回到空（没留下测试数据）', !restored.license_name && !restored.license_no, JSON.stringify(restored))
    const chipsRestored = await ui.eval(`return ${CHIPS}`)
    check('界面回到「全部 + 未填写 4 家」', chipsRestored.length === 2 && chipsRestored[1].includes('未填写营业执照 4 家'), JSON.stringify(chipsRestored))
  } finally {
    ui?.close()
    killTree(app)
  }

  const passed = results.filter(r => r.ok).length
  console.log(`\n通过 ${passed}/${results.length}`)
  if (passed !== results.length) process.exit(1)
}

main().catch(err => { console.error(err.stack || err); process.exit(1) })
