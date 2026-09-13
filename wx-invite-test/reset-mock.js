/**
 * 清理仿真店环境：关浏览器 → 渲染层刷新 → 点卡片重开 → 单标签导航到仿真页。
 * node reset-mock.js
 */
const PORT = '9250'
const STORE_NAME = '微信仿真店'
const MOCK_URL = 'http://127.0.0.1:8765/wx-mock/initiate-invite?finderUsername=v2_mocktoken@finder'

async function j(p) { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); return r.json() }
async function targets() { const l = await j('/json/list'); return l.filter(t => t.type === 'page') }
function pick(list, key) {
  const t = list.find(x => x.url.includes(key) || x.title.includes(key))
  if (!t) throw new Error('no target: ' + key)
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
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const { execSync } = require('child_process')
  try {
    execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='electron.exe'\\" | Where-Object { $_.CommandLine -match 'remote-debugging-port' -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { $w = New-Object -ComObject WScript.Shell; for($i=0;$i -lt 3;$i++){ if($w.AppActivate($_.ProcessId)){break}; Start-Sleep -Milliseconds 250 } }"`, { stdio: 'ignore', timeout: 15000 })
  } catch { /* */ }

  // 1) 渲染层刷新（丢弃脏状态），重置主进程侧浏览器
  let storeId = null
  await connect(pick(await targets(), 'ShopPilot'), )
  const c0 = await connect(pick(await targets(), 'ShopPilot'))
  const reset = await c0.ev(`(async () => {
    const stores = await window.shopilot.store.list()
    const list = stores.data.stores || stores.data
    const mock = list.find(s => s.name === '${STORE_NAME}')
    if (!mock) return 'no-store'
    await window.shopilot.browser.close(mock.id)
    location.reload()
    return mock.id
  })()`)
  c0.close()
  if (reset === 'no-store') throw new Error('mock store missing')
  storeId = reset
  await sleep(2500)

  // 2) 点卡片重开（正常 UI 路径），等视口
  const c1 = await connect(pick(await targets(), 'ShopPilot'))
  const opened = await c1.ev(`(() => {
    const card = [...document.querySelectorAll('.store-card')].find(c => c.textContent.includes('${STORE_NAME}'))
    if (!card) return 'no-card'
    card.querySelector('button').click()
    return 'clicked'
  })()`)
  if (opened !== 'clicked') { c1.close(); throw new Error(opened) }
  let vpOk = false
  for (let i = 0; i < 12; i++) {
    await sleep(500)
    vpOk = await c1.ev(`(() => { const el = document.querySelector('.viewport'); const r = el && el.getBoundingClientRect(); return !!(r && r.width > 300 && r.height > 300) })()`)
    if (vpOk) break
  }
  if (!vpOk) { c1.close(); throw new Error('viewport not ready') }

  // 3) 关掉多余标签只留一个，导航到仿真页
  const nav = await c1.ev(`(async () => {
    const tl = await window.shopilot.browser.tab.list('${storeId}')
    const tabs = tl.data.tabs || tl.data
    for (const t of tabs.slice(1)) await window.shopilot.browser.tab.close('${storeId}', t.id)
    const input = document.querySelector('.url-box input')
    if (!input) return 'no-url-input'
    const proto = window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, '${MOCK_URL}')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return 'nav'
  })()`)
  c1.close()
  if (nav !== 'nav') throw new Error(nav)

  // 4) 等仿真页在可见视口里就绪
  for (let i = 0; i < 20; i++) {
    await sleep(700)
    const list = await targets()
    for (const t of list.filter(x => x.url.includes('initiate-invite'))) {
      try {
        const c = await connect(t)
        const okPage = await c.ev(`(() => {
          const app = document.getElementById('app')
          return !!(app && app.shadowRoot && window.__mockReady && innerWidth > 100 && innerHeight > 100)
        })()`)
        c.close()
        if (okPage) { console.log('RESET-OK'); return }
      } catch { /* next */ }
    }
  }
  throw new Error('mock page never visible-ready')
}
main().then(() => process.exit(0)).catch(e => { console.error('RESET-FAIL:', e.message); process.exit(1) })
