/**
 * 验证 waitForGone（发送后校验）：
 *  A. 正面：打开弹窗 → 点取消（弹窗隐藏）→ waitForGone 应通过
 *  B. 反面：打开弹窗不动 → waitForGone 应超时失败（如实报错）
 * 独立临时实例（端口 9254），不影响正在使用的实例。
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const PORT = '9254'
const USER_DATA = path.join(os.tmpdir(), 'shopilot-gone-verify')
const ROOT = path.resolve(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MOCK = 'http://127.0.0.1:8765/wx-mock/initiate-invite?finderUsername=gone@finder'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function j(p) { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); return r.json() }
async function targets() { const l = await j('/json/list'); return l.filter(t => t.type === 'page') }
function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  return new Promise((ok, err) => {
    ws.onopen = () => {
      let seq = 0
      const pend = new Map()
      const send = (method, params = {}) => new Promise((ok2, err2) => { const id = ++seq; pend.set(id, m => m.error ? err2(new Error(JSON.stringify(m.error))) : ok2(m.result)); ws.send(JSON.stringify({ id, method, params })) })
      ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
      ok({
        ev: async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 250)); return r.result.value },
        close: () => { try { ws.close() } catch { /* */ } }
      })
    }
    ws.onerror = err
  })
}

async function main() {
  fs.rmSync(USER_DATA, { recursive: true, force: true })
  const app = spawn(ELECTRON, ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + USER_DATA,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'],
    { cwd: ROOT, stdio: 'ignore' })
  const fails = []
  try {
    for (let i = 0; i < 40; i++) { try { await j('/json/version'); break } catch { await sleep(500) } }
    await sleep(2500)
    const c = await connect((await targets()).find(t => t.title === 'ShopPilot'))
    const created = await c.ev(`(async () => {
      const s = await window.shopilot.store.create({ name: 'waitForGone店', platform: '微信小店', adminUrl: 'http://127.0.0.1:8765' })
      if (!s.ok) return JSON.stringify(s)
      await window.shopilot.browser.open(s.data.id)
      await window.shopilot.browser.display(s.data.id)
      const dl = document.querySelector('[class*=dialog]')
      // A: 打开弹窗 → 取消 → waitForGone 通过
      const a = await window.shopilot.task.create({ name: 'goneA', storeScope: s.data.id, steps: [
        { type: 'navigate', input: { url: '${MOCK}' }, timeoutMs: 20000 },
        { type: 'waitForPage', input: { urlIncludes: '8765' }, timeoutMs: 15000 },
        { type: 'clickByText', input: { text: '添加商品', deep: true, mode: 'real' }, timeoutMs: 15000 },
        { type: 'waitForText', input: { text: '已选商品数量', deep: true }, timeoutMs: 15000 },
        { type: 'clickByText', input: { text: '确认', deep: true, mode: 'real' }, timeoutMs: 15000 },
        { type: 'waitForGone', input: { selector: 'tbody label.weui-desktop-form__check-label', deep: true }, timeoutMs: 15000 }
      ]})
      if (!a.ok) return 'A-CREATE-ERR:' + JSON.stringify(a.error)
      await window.shopilot.task.run(a.data.id)
      // B: 打开弹窗后不动 → waitForGone 应失败
      const b = await window.shopilot.task.create({ name: 'goneB', storeScope: s.data.id, steps: [
        { type: 'clickByText', input: { text: '添加商品', deep: true, mode: 'real' }, timeoutMs: 15000 },
        { type: 'waitForText', input: { text: '已选商品数量', deep: true }, timeoutMs: 15000 },
        { type: 'waitForGone', input: { selector: 'tbody label.weui-desktop-form__check-label', deep: true }, timeoutMs: 6000 }
      ]})
      if (!b.ok) return 'B-CREATE-ERR:' + JSON.stringify(b.error)
      await window.shopilot.task.run(b.data.id)
      // 等两条都到终态
      const deadline = Date.now() + 90000
      let ra = null, rb = null
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000))
        const t = await window.shopilot.task.list()
        const list = t.data.tasks || t.data
        ra = list.find(x => x.name === 'goneA')
        rb = list.find(x => x.name === 'goneB')
        const sa = ra && ra.latestRun ? ra.latestRun.status : null
        const sb = rb && rb.latestRun ? rb.latestRun.status : null
        if (sa && sb && ['succeeded','failed','cancelled'].includes(sa) && ['succeeded','failed','cancelled'].includes(sb)) break
      }
      const dump = async (task) => {
        if (!task || !task.latestRun) return null
        const res = await window.shopilot.task.results(task.latestRun.id)
        return { st: task.latestRun.status, err: task.latestRun.errorCode, msg: String(task.latestRun.errorMessage || '').slice(0, 120),
                 steps: res.data.results.map(s => s.stepIndex + ':' + s.kind) }
      }
      return JSON.stringify({ a: await dump(ra), b: await dump(rb) })
    })()`)
    console.log('结果:', created)
    const r = JSON.parse(created)
    if (r.a && r.a.st !== 'succeeded') fails.push('A 应通过但为 ' + JSON.stringify(r.a))
    if (r.b && r.b.st !== 'failed') fails.push('B 应失败但为 ' + JSON.stringify(r.b))
    if (!r.a || !r.b) fails.push('任务未跑完: ' + created)
    c.close()
  } finally {
    try { app.kill() } catch { /* */ }
  }
  if (fails.length) { console.error('WAITGONE-FAIL:', fails.join(' | ')); process.exit(1) }
  console.log('WAITGONE-VERIFY: PASS')
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
