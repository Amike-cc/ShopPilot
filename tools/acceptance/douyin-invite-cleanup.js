/**
 * 清理本次真机实测创建的抖店邀约任务（只删今天由验收脚本建的那几个），
 * 顺带截图面板最终形态。
 * 用法：node tools/acceptance/douyin-invite-cleanup.js
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '../..')
const PORT = '9251'
const sleep = ms => new Promise(r => setTimeout(r, ms))

function freePort(p) {
  try {
    const out = execSync(`netstat -ano | findstr LISTENING | findstr :${p}`, { encoding: 'utf8' })
    const pids = new Set(out.split(/\r?\n/).map(l => l.trim().split(/\s+/).pop()).filter(x => /^\d+$/.test(x)))
    for (const pid of pids) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) } catch { /* */ } }
  } catch { /* */ }
}
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map()
    this.ready = new Promise((ok, err) => { this.ws.onopen = ok; this.ws.onerror = err })
    this.ws.onmessage = e => { const m = JSON.parse(e.data); const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expr) {
    await this.ready
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  async shot(f) { const r = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); return f }
  close() { try { this.ws.close() } catch { /* */ } }
}
async function connect(part) {
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const t = list.find(x => x.type === 'page' && x.url.includes(part))
    if (t) { const c = new CDP(t.webSocketDebuggerUrl); await c.ready; return c }
    await sleep(700)
  }
  throw new Error('no target ' + part)
}

;(async () => {
  freePort(PORT)
  const app = spawn(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox'], { cwd: root, stdio: 'ignore', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } })
  try {
    for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch { /* */ } await sleep(400) }
    await sleep(2500)
    const ui = await connect('/renderer/index.html')
    await ui.eval(`const until = Date.now() + 20000; while (!window.shopilot && Date.now() < until) await new Promise(r => setTimeout(r, 100)); return !!window.shopilot`)
    const listed = await ui.eval(`
      const r = await window.shopilot.task.list();
      const today = 1790070000000;
      return (r.data || [])
        .filter(t => String(t.name).startsWith('达人邀约 · 抖店 · 个护家清/家清纸品') && (t.createdAt || 0) > today)
        .map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt, run: t.latestRun ? t.latestRun.status : null }));
    `)
    console.log('待清理的实测任务：', JSON.stringify(listed, null, 1))
    for (const t of listed) {
      const del = await ui.eval(`return await window.shopilot.task.delete(${JSON.stringify(t.id)});`)
      console.log(`${del && del.ok ? 'OK  ' : 'FAIL'} 删除 ${t.name} (${t.id})`, del && del.error ? JSON.stringify(del.error) : '')
    }
    const after = await ui.eval(`
      const r = await window.shopilot.task.list();
      const today = 1790070000000;
      const mine = (r.data || []).filter(t => String(t.name).startsWith('达人邀约 · 抖店 · 个护家清/家清纸品') && (t.createdAt || 0) > today);
      return { left: mine.length, totalInvite: (r.data || []).filter(t => String(t.name).startsWith('达人邀约')).length };
    `)
    console.log('清理后：', JSON.stringify(after))
    ui.close()
  } finally {
    try { execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: 'ignore' }) } catch { /* */ }
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
