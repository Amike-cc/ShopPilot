/**
 * 微信小店（assist-form）邀约任务端到端验收（对本地仿真页，全程不碰真实平台）：
 *  1. 前台化窗口 → 点店铺卡片 → 确认视口元素出现
 *  2. 地址栏导航当前标签页到仿真邀约页
 *  3. 面板填表 → 开始邀约 → 等门禁 → 校验页面填写状态
 *  4. 批准/拒绝 → 等终态 → 校验仿真页 sent/quota
 * 用法：node accept-flow.js approve   （或 deny）
 */
const PORT = '9250'
const STORE_NAME = '微信仿真店'
const MOCK_URL = 'http://127.0.0.1:8765/wx-mock/initiate-invite?finderUsername=v2_mocktoken@finder'
const MODE = process.argv[2] === 'deny' ? 'deny' : 'approve'

async function j(path, opts) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, opts)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`)
  return res.json()
}
async function targets() {
  const list = await j('/json/list')
  return list.filter(t => t.type === 'page')
}
function pick(list, key) {
  const t = list.find(x => x.url.includes(key) || x.title.includes(key))
  if (!t) throw new Error('no target: ' + key + ' | have: ' + list.map(x => x.title.slice(0, 24)).join(' / '))
  return t
}
function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  return new Promise((ok, err) => {
    ws.onopen = () => {
      let seq = 0
      const pend = new Map()
      const doSend = (method, params = {}) => new Promise((ok2, err2) => {
        const id = ++seq
        pend.set(id, m => m.error ? err2(new Error(method + ' ' + JSON.stringify(m.error))) : ok2(m.result))
        ws.send(JSON.stringify({ id, method, params }))
      })
      ws.onmessage = e => {
        const m = JSON.parse(e.data)
        if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
      }
      ok({
        send: doSend,
        ev: async (expr) => {
          const r = await doSend('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
          if (r.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
          return r.result.value
        },
        close: () => { try { ws.close() } catch { /* */ } }
      })
    }
    ws.onerror = err
  })
}
async function withTarget(key, fn) {
  const c = await connect(pick(await targets(), key))
  try { return await fn(c) } finally { c.close() }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

/** 在所有 initiate-invite 目标里找仿真页并读状态（多标签时只认真正的那一个） */
async function readMockState() {
  const list = await targets()
  for (const t of list.filter(x => x.url.includes('initiate-invite'))) {
    try {
      const c = await connect(t)
      const v = await c.ev(`(() => {
        const app = document.getElementById('app')
        if (!app || !app.shadowRoot || !window.__mockReady) return 'not-mock'
        if (!(innerWidth > 100 && innerHeight > 100)) return 'not-visible'
        const sr = app.shadowRoot
        return JSON.stringify({
          contact: sr.getElementById('contact').value,
          wechat: sr.getElementById('wechat').value,
          scriptLen: sr.getElementById('script').value.length,
          goods: sr.getElementById('goods-body').querySelectorAll('tr').length,
          sent: window.__sentCount || 0,
          quota: sr.getElementById('quota').textContent
        })
      })()`)
      c.close()
      if (typeof v === 'string' && v.startsWith('{')) return JSON.parse(v)
    } catch { /* 试下一个目标 */ }
  }
  return null
}

async function main() {
  // 0) 前台化
  const { execSync } = require('child_process')
  try {
    execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='electron.exe'\\" | Where-Object { $_.CommandLine -match 'remote-debugging-port' -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { $w = New-Object -ComObject WScript.Shell; for($i=0;$i -lt 3;$i++){ if($w.AppActivate($_.ProcessId)){break}; Start-Sleep -Milliseconds 250 } }"`, { stdio: 'ignore', timeout: 15000 })
  } catch { /* 前台化失败不阻塞 */ }

  // 1) 主窗口：视口未就绪才点店铺卡片，等工作台视口出现
  const ui = await withTarget('ShopPilot', async ({ ev }) => {
    for (let i = 0; i < 6; i++) {
      const ok = await ev(`(() => { const el = document.querySelector('.viewport'); const r = el && el.getBoundingClientRect(); return !!(r && r.width > 300 && r.height > 300) })()`)
      if (ok) return 'viewport-already-ready'
      await sleep(400)
    }
    const r1 = await ev(`(() => {
      const card = [...document.querySelectorAll('.store-card')].find(c => c.textContent.includes('${STORE_NAME}'))
      if (!card) return 'no-card'
      card.querySelector('button').click()
      return 'clicked'
    })()`)
    if (r1 !== 'clicked') throw new Error(String(r1))
    for (let i = 0; i < 10; i++) {
      await sleep(500)
      const ok = await ev(`(() => { const el = document.querySelector('.viewport'); const r = el && el.getBoundingClientRect(); return !!(r && r.width > 300 && r.height > 300) })()`)
      if (ok) return 'viewport-ready'
    }
    throw new Error('viewport never ready')
  })
  log('step1', ui)

  // 2) 地址栏导航（对当前激活标签页），等仿真页就绪
  await withTarget('ShopPilot', async ({ ev }) => {
    return ev(`(() => {
      const input = document.querySelector('.url-box input')
      if (!input) return 'no-url-input'
      const proto = window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, '${MOCK_URL}')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return 'nav'
    })()`)
  })
  let mockReady = false
  for (let i = 0; i < 15; i++) {
    await sleep(700)
    const st = await readMockState()
    if (st) { mockReady = true; break }
  }
  if (!mockReady) throw new Error('mock page not ready')
  log('step2 mock-ready')

  // 3) 面板填表 + 开始邀约
  const started = await withTarget('ShopPilot', async ({ ev }) => {
    const opened = await ev(`(() => {
      const t = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '任务')
      if (t) t.click()
      return new Promise(r => setTimeout(() => {
        const inv = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '达人邀约')
        if (inv) inv.click()
        setTimeout(() => r(!!document.querySelector('[data-test=invite-panel]')), 600)
      }, 400))
    })()`)
    if (!opened) throw new Error('invite panel not open')
    return ev(`(() => {
      const set = (el, v) => {
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const q = s => document.querySelector('[data-test=' + s + ']')
      set(q('invite-contact'), '验收联系人')
      set(q('invite-wechat'), 'mock_wx001')
      set(q('invite-script'), '您好，我们是仿真验收店铺，诚邀您合作带货，佣金与选品都可协商，期待您的回复！')
      return new Promise(r => setTimeout(() => {
        const start = q('invite-start')
        if (start.disabled) { r('START-DISABLED'); return }
        start.click()
        r('started')
      }, 300))
    })()`)
  })
  log('step3', started)
  if (started !== 'started') throw new Error('start not clicked: ' + started)

  // 4) 等门禁
  let run = null
  for (let i = 0; i < 40; i++) {
    await sleep(700)
    const st = await withTarget('ShopPilot', ({ ev }) => ev(`(async () => {
      const tasks = await window.shopilot.task.list()
      const list = tasks.data.tasks || tasks.data
      const t = list.find(x => x.name.includes('辅助填单'))
      if (!t || !t.latestRun) return JSON.stringify({ st: 'none' })
      return JSON.stringify({ st: t.latestRun.status, reason: t.latestRun.statusReason, err: t.latestRun.errorCode, runId: t.latestRun.id, taskId: t.id })
    })()`)).then(s => JSON.parse(s))
    if (st.st === 'waiting_confirmation') { run = st; log('step4 GATE:', st.reason.slice(0, 50) + '…'); break }
    if (st.st === 'failed') throw new Error('run failed: ' + st.err + ' ' + st.reason)
    if (st.st === 'succeeded') { run = st; log('step4 finished early'); break }
  }
  if (!run) throw new Error('gate never reached')

  // 5) 校验门禁时的页面填写状态
  if (run.st === 'waiting_confirmation') {
    const fill = await readMockState()
    log('step5 页面状态:', JSON.stringify(fill))
    if (!fill || !fill.contact || !fill.goods) throw new Error('page not filled at gate: ' + JSON.stringify(fill))
  }

  // 6) 批准 / 拒绝
  const confirmed = await withTarget('ShopPilot', ({ ev }) => ev(`window.shopilot.task.confirm('${run.runId}', ${MODE === 'approve' ? 'true' : 'false'}).then(r => JSON.stringify(r.ok))`))
  log('step6 confirm(' + MODE + ')', confirmed)

  // 7) 等终态并校验
  for (let i = 0; i < 30; i++) {
    await sleep(700)
    const st = await withTarget('ShopPilot', ({ ev }) => ev(`(async () => {
      const tasks = await window.shopilot.task.list()
      const list = tasks.data.tasks || tasks.data
      const t = list.find(x => x.id === '${run.taskId}')
      return JSON.stringify({ st: t.latestRun.status, reason: t.latestRun.statusReason, err: t.latestRun.errorCode })
    })()`)).then(s => JSON.parse(s))
    if (['succeeded', 'failed', 'cancelled'].includes(st.st)) {
      log('step7 终态:', JSON.stringify(st))
      const final = await readMockState()
      log('step8 仿真页:', JSON.stringify(final))
      if (MODE === 'approve') {
        if (st.st !== 'succeeded') throw new Error('expected succeeded, got ' + st.st)
        if (!final || final.sent !== 1) throw new Error('expected sent=1, got ' + JSON.stringify(final))
      } else {
        if (st.st !== 'cancelled') throw new Error('expected cancelled, got ' + st.st)
        if (!final || final.sent !== 0) throw new Error('deny 路径不应发送: ' + JSON.stringify(final))
      }
      return
    }
  }
  throw new Error('no terminal state')
}

main().then(() => { console.log('ACCEPT-' + MODE.toUpperCase() + ': PASS'); process.exit(0) }).catch(e => { console.error('ACCEPT-FAIL:', e.message); process.exit(1) })
