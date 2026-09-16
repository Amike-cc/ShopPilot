/**
 * 左栏收起/展开自查（带截图）：起一次临时 userData 实例，量展开/收起两态并截图。
 * 为什么单独跑：m1 断言证明了宽度与原生视图同步，但量不出"布局有没有崩"（品牌行溢出、窄轨按钮跑位）。
 * 用法：node tools/ui/ui-leftbar.js
 */
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const root = path.resolve(__dirname, '../..')
const ARTIFACT_DIR = path.join(root, 'artifacts', 'ui')
fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9231
const userData = path.join(os.tmpdir(), 'shopilot-leftbar-' + Date.now())
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 结束应用进程树。只 kill 主进程在 Windows 上会留下渲染进程僵尸（实测残留 90MB renderer） */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch { /* 进程可能已自行退出 */ }
}

class CDP {
  constructor(wsUrl) {
    this.id = 0
    this.pending = new Map()
    this.console = []
    this.ws = new WebSocket(wsUrl)
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res()
      this.ws.onerror = () => rej(new Error('ws error'))
    })
    this.ws.onmessage = evt => {
      const m = JSON.parse(evt.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) reject(new Error(m.error.message))
        else resolve(m.result)
        return
      }
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
        this.console.push(`[console.${m.params.type}] ` + m.params.args.map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 300))
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.console.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300))
      }
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error')
    return r.result.value
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  }
  close() { try { this.ws.close() } catch {} }
}

async function waitCDP(timeout = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return true } catch {}
    await sleep(400)
  }
  return false
}

const MEASURE = `
  const sb = document.querySelector('[data-test="sidebar"]');
  const rail = document.querySelector('.sidebar-rail');
  const brand = document.querySelector('.brand');
  const vp = document.querySelector('.viewport');
  const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) } };
  const railBtns = [...document.querySelectorAll('.sidebar-rail .rail-btn')].map(b => {
    const r = b.getBoundingClientRect();
    return { t: b.textContent.trim().slice(0, 2) || b.title, x: Math.round(r.x), w: Math.round(r.width), inside: r.left >= -0.5 && r.right <= (sb ? sb.getBoundingClientRect().right + 0.5 : 1e9) };
  });
  return {
    sidebar: rect(sb), rail: rect(rail), viewport: rect(vp),
    collapsed: sb ? sb.className.includes('collapsed') : null,
    brandOverflow: brand ? brand.scrollWidth > brand.clientWidth + 1 : null,
    brandScrollW: brand ? brand.scrollWidth : null,
    brandClientW: brand ? brand.clientWidth : null,
    docHScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    railBtns,
    setting: (await window.shopilot.settings.get('ui.leftSidebarCollapsed')).data.value
  };
`

async function main() {
  fs.mkdirSync(userData, { recursive: true })
  const app = spawn(electronExe, [root, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + userData], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production' }
  })
  let procLog = ''
  app.stdout.on('data', d => { procLog += d.toString() })
  app.stderr.on('data', d => { procLog += d.toString() })

  try {
    if (!await waitCDP()) { console.log('CDP 未就绪\n' + procLog.slice(-1500)); return }
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    const ui = list.find(t => t.type === 'page' && (t.url.includes('index.html') || t.url.startsWith('file:')))
    if (!ui) { console.log('找不到主窗口 target：' + JSON.stringify(list.map(t => t.url).slice(0, 6))); return }
    const cdp = new CDP(ui.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Page.enable').catch(() => {})
    await cdp.send('Runtime.enable').catch(() => {})
    await cdp.evaluate(`const d=Date.now()+15000; while(!window.shopilot && Date.now()<d) await new Promise(r=>setTimeout(r,100)); return !!window.shopilot;`)
    await sleep(1500)

    const expanded = await cdp.evaluate(MEASURE)
    await cdp.shot(path.join(ARTIFACT_DIR, 'ui-leftbar-expanded.png'))
    console.log('\n--- 展开态 ---\n' + JSON.stringify(expanded, null, 2))

    await cdp.evaluate(`document.querySelector('[data-test="sidebar-collapse"]').click(); return true;`)
    await sleep(1000)
    const collapsed = await cdp.evaluate(MEASURE)
    await cdp.shot(path.join(ARTIFACT_DIR, 'ui-leftbar-collapsed.png'))
    console.log('\n--- 收起态 ---\n' + JSON.stringify(collapsed, null, 2))

    await cdp.evaluate(`document.querySelector('[data-test="sidebar-expand"]').click(); return true;`)
    await sleep(1000)
    const back = await cdp.evaluate(MEASURE)
    console.log('\n--- 再展开 ---\n' + JSON.stringify({ sidebar: back.sidebar, collapsed: back.collapsed, setting: back.setting }))

    console.log('\n判定:')
    console.log('  收起=44px 且 展开=304px:', collapsed.sidebar?.w === 44 && expanded.sidebar?.w === 304 && back.sidebar?.w === 304)
    console.log('  品牌行无溢出:', expanded.brandOverflow === false)
    console.log('  窄轨按钮全部落在栏内:', collapsed.railBtns.length === 4 && collapsed.railBtns.every(b => b.inside))
    console.log('  页面无横向滚动:', expanded.docHScroll === false && collapsed.docHScroll === false)
    if (cdp.console.length) console.log('\n=== 渲染层报错 ===\n' + cdp.console.slice(-8).join('\n'))
    console.log('\n截图: artifacts/ui/ui-leftbar-expanded.png / artifacts/ui/ui-leftbar-collapsed.png')
    cdp.close()
  } catch (e) {
    console.log('UI_LEFTBAR_ERROR ' + e.message)
    if (procLog) console.log(procLog.slice(-800))
  } finally {
    killTree(app)
    await sleep(800)
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
  }
}

main()
