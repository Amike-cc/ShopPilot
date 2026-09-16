/**
 * UI 截图（含顶部区域放大），用于人工核对视觉一致性
 * 用法：node tools/ui/ui-snap.js [输出前缀]
 */
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const os = require('os')

const CDP_PORT = 9233
const ROOT = path.resolve(__dirname, '../..')
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', 'ui')
fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PREFIX = process.argv[2] || 'ui-top'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  const userData = path.join(os.tmpdir(), 'shopilot-snap-' + Date.now())
  const app = spawn(ELECTRON, ['.', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`], { cwd: ROOT, stdio: 'ignore' })
  const kill = () => { try { spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
  try {
    let target = null
    for (let i = 0; i < 40 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
        target = list.find(t => t.type === 'page' && (t.url.includes('index.html') || t.url.startsWith('file:')))
      } catch {}
      if (!target) await sleep(400)
    }
    if (!target) throw new Error('未找到主界面 target')
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    let id = 0
    const pending = new Map()
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) }
    }
    const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
      return r.result.value
    }
    await evaluate(`const d=Date.now()+20000; while(!window.shopilot && Date.now()<d) await new Promise(r=>setTimeout(r,100)); return true;`)

    // 建店并进入工作台（顶部/侧栏/右栏都有内容才看得出风格）
    await evaluate(`
      const list = await window.shopilot.store.list();
      let s = (list.data || []).find(x => x.name === '视觉核对店');
      if (!s) s = (await window.shopilot.store.create({ name: '视觉核对店', platform: '抖店' })).data;
      await window.shopilot.browser.open(s.id);
      await new Promise(r => setTimeout(r, 2000));
      return true;
    `)
    await evaluate(`location.reload(); return true;`)
    await sleep(3500)
    await evaluate(`
      const card = [...document.querySelectorAll('.store-card')].find(c => c.textContent.includes('视觉核对店'));
      if (card && !document.querySelector('.viewport')) { card.querySelector('.store-action').click(); await new Promise(r => setTimeout(r, 3000)); }
      return true;
    `)

    // 主要元素的几何与配色（把"不匹配"量化）
    const metrics = await evaluate(`
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          sel,
          text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 30),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          bg: cs.backgroundColor, color: cs.color, font: cs.fontSize + '/' + cs.fontWeight,
          border: cs.borderBottomWidth + ' ' + cs.borderBottomColor, pad: cs.padding, align: cs.alignItems
        };
      };
      return {
        titlebar: pick('.titlebar') || pick('.topbar') || pick('header'),
        sidebarH: pick('.sidebar-header') || pick('.left-col header') || pick('.brand'),
        panelTabs: pick('.panel-tabs'),
        tabbar: pick('.tabbar') || pick('.tab-bar'),
        appRects: [...document.querySelectorAll('body > div, body > div > div')].slice(0, 4).map(e => e.className)
      };
    `)
    console.log(JSON.stringify(metrics, null, 1))

    const shot = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(ARTIFACT_DIR, PREFIX + '-full.png'), Buffer.from(shot.data, 'base64'))
    // 顶部 120px 放大截图
    const layout = await send('Page.getLayoutMetrics')
    const shot2 = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: layout.cssLayoutViewport.clientWidth, height: 120, scale: 2 }
    })
    fs.writeFileSync(path.join(ARTIFACT_DIR, PREFIX + '-top.png'), Buffer.from(shot2.data, 'base64'))
    console.log('已保存', PREFIX + '-full.png', PREFIX + '-top.png')
    ws.close()
  } finally { kill() }
}

main().catch(e => { console.error('SNAP_CRASH', e); process.exit(1) })
