/**
 * 右侧栏收起/展开 探针
 * 量测：面板宽度、窄轨、中栏（.viewport）宽度、原生视图真实宽度（browser:capture 的 PNG 像素宽）、
 *       持久化（重载后仍收起）、快捷展开并回到指定面板、Ctrl+Shift+B。
 * 用法：node ui-panel.js
 */
const http = require('http')
const path = require('path')
const { spawn } = require('child_process')
const os = require('os')
const fs = require('fs')

const CDP_PORT = 9232
const SITE_PORT = 61600
const ROOT = __dirname
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = rej })
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result)
      }
    }
  }
  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP_TIMEOUT ' + method)) }, timeoutMs)
      this.pending.set(id, { resolve: v => { clearTimeout(t); resolve(v) }, reject: e => { clearTimeout(t); reject(e) } })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(body) {
    await this.ready
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  close() { try { this.ws.close() } catch {} }
}

async function targets() { return (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json() }
async function uiTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const t = await targets()
      const p = t.find(x => x.type === 'page' && (x.url.includes('index.html') || x.url.startsWith('file:')))
      if (p) return p
    } catch {}
    await sleep(400)
  }
  throw new Error('未找到主界面 target')
}

/** PNG 像素宽（IHDR 前 4 字节 big-endian 宽 + 高） */
function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.subarray(1, 4).toString() !== 'PNG') return null
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

function startSite() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>面板探针页</title></head><body><h1 id="t">panel</h1></body></html>')
  })
  return new Promise(r => server.listen(SITE_PORT, '127.0.0.1', () => r(server)))
}

async function main() {
  fs.mkdirSync(path.join(os.tmpdir(), 'shopilot-panel'), { recursive: true })
  const server = await startSite()
  const userData = path.join(os.tmpdir(), 'shopilot-panel-' + Date.now())
  const app = spawn(ELECTRON, ['.', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`], {
    cwd: ROOT, stdio: 'ignore'
  })
  const kill = () => { try { spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
  try {
    const target = await uiTarget()
    const cdp = new CDP(target.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.evaluate(`const d=Date.now()+20000; while(!window.shopilot && Date.now()<d) await new Promise(r=>setTimeout(r,100)); return !!window.shopilot;`)

    // 建店 + 打开浏览器 + 建标签页导航到本地站点
    const prep = await cdp.evaluate(`
      const list = await window.shopilot.store.list();
      let s = (list.data || []).find(x => x.name === '面板探针店');
      if (!s) s = (await window.shopilot.store.create({ name: '面板探针店', platform: '拼多多', adminUrl: 'http://127.0.0.1:${SITE_PORT}/' })).data;
      await window.shopilot.browser.open(s.id);
      await new Promise(r => setTimeout(r, 2500));
      const t = await window.shopilot.browser.tab.list(s.id);
      let tid = (t.data?.tabs || [])[0]?.id;
      if (!tid) {
        const created = await window.shopilot.browser.tab.create(s.id, 'http://127.0.0.1:${SITE_PORT}/');
        tid = created.data?.tabId;
      } else {
        await window.shopilot.browser.navigate(s.id, tid, 'http://127.0.0.1:${SITE_PORT}/');
      }
      await new Promise(r => setTimeout(r, 2500));
      const after = await window.shopilot.browser.tab.list(s.id);
      return { storeId: s.id, tabId: tid, tabCount: (after.data?.tabs || []).length };
    `)
    console.log('准备:', JSON.stringify(prep))
    await cdp.evaluate(`location.reload(); return true;`)
    await sleep(3500)
    await cdp.evaluate(`
      const card = [...document.querySelectorAll('.store-card')].find(c => c.textContent.includes('面板探针店'));
      if (card && !document.querySelector('.viewport')) { card.querySelector('.store-action').click(); await new Promise(r => setTimeout(r, 3200)); }
      return true;
    `)

    const measure = () => cdp.evaluate(`
      const rp = document.querySelector('[data-test="right-panel"]');
      const vp = document.querySelector('.viewport');
      const rail = document.querySelector('.panel-rail');
      const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) } };
      return {
        panel: rect(rp), viewport: rect(vp), railShown: !!rail,
        panelClass: rp ? rp.className : null,
        collapseBtn: !!document.querySelector('[data-test="panel-collapse"]'),
        saveSetting: (await window.shopilot.settings.get('ui.rightPanelCollapsed')).data.value
      };
    `)

    const capture = async (label) => {
      const res = await cdp.evaluate(`
        const list = await window.shopilot.browser.tab.list(${JSON.stringify(prep.storeId)});
        const tid = (list.data?.tabs || [])[0]?.id;
        if (!tid) return { err: 'NO_TAB' };
        const cap = await window.shopilot.browser.capture(${JSON.stringify(prep.storeId)}, tid, 'png');
        return cap.ok ? { b64: cap.data.data || '' } : { err: cap.error };
      `)
      if (!res.b64) return { label, err: res.err }
      const buf = Buffer.from(res.b64.replace(/^data:image\/png;base64,/, ''), 'base64')
      return { label, bytes: buf.length, ...(pngSize(buf) || {}) }
    }

    // 0) 展开态基线
    const m0 = await measure()
    const c0 = await capture('展开')
    console.log('\n--- 0) 展开态基线 ---')
    console.log('面板:', JSON.stringify(m0.panel), '中栏:', JSON.stringify(m0.viewport), '收起按钮:', m0.collapseBtn)
    console.log('原生视图截图:', JSON.stringify(c0))

    // 1) 点收起
    await cdp.evaluate(`document.querySelector('[data-test="panel-collapse"]').click(); return true;`)
    await sleep(1200)
    const m1 = await measure()
    const c1 = await capture('收起')
    console.log('\n--- 1) 收起后 ---')
    console.log('面板:', JSON.stringify(m1.panel), '中栏:', JSON.stringify(m1.viewport), '窄轨:', m1.railShown, 'class:', m1.panelClass)
    console.log('原生视图截图:', JSON.stringify(c1))
    console.log('面板宽度 320 →', m1.panel?.w, '/ 中栏宽度', m0.viewport?.w, '→', m1.viewport?.w,
      '/ 截图宽度', c0.w, '→', c1.w)

    // 2) 窄轨点"任务"→ 展开并切到任务面板
    await cdp.evaluate(`document.querySelector('[data-test="rail-tasks"]').click(); return true;`)
    await sleep(1000)
    const m2 = await cdp.evaluate(`
      const rp = document.querySelector('[data-test="right-panel"]');
      const on = [...document.querySelectorAll('.ptab')].find(b => b.className.includes('on'));
      return { w: Math.round(rp.getBoundingClientRect().width), activeTab: on ? on.textContent.trim() : null, rail: !!document.querySelector('.panel-rail') };
    `)
    console.log('\n--- 2) 窄轨点"任务"图标 ---')
    console.log(JSON.stringify(m2))

    // 3) Ctrl+Shift+B 收起
    await cdp.evaluate(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'B', ctrlKey: true, shiftKey: true, bubbles: true }));
      return true;
    `)
    await sleep(900)
    const m3 = await cdp.evaluate(`return { collapsed: !!document.querySelector('.panel-rail'), w: Math.round(document.querySelector('[data-test="right-panel"]').getBoundingClientRect().width) };`)
    console.log('\n--- 3) 快捷键 Ctrl+Shift+B ---')
    console.log(JSON.stringify(m3))

    // 4) 持久化：重载后仍是收起
    await cdp.evaluate(`location.reload(); return true;`)
    await sleep(3500)
    await cdp.evaluate(`
      const card = [...document.querySelectorAll('.store-card')].find(c => c.textContent.includes('面板探针店'));
      if (card && !document.querySelector('.viewport')) { card.querySelector('.store-action').click(); await new Promise(r => setTimeout(r, 3200)); }
      return true;
    `)
    const m4 = await measure()
    console.log('\n--- 4) 重载后 ---')
    console.log('窄轨:', m4.railShown, '面板宽度:', m4.panel?.w, '存储值:', m4.saveSetting)

    // 5) 展开并写回设置，恢复干净状态
    await cdp.evaluate(`document.querySelector('[data-test="panel-expand"]').click(); return true;`)
    await sleep(900)
    const m5 = await measure()
    console.log('\n--- 5) 窄轨展开按钮 ---')
    console.log('窄轨:', m5.railShown, '面板宽度:', m5.panel?.w, '存储值:', m5.saveSetting, '中栏:', JSON.stringify(m5.viewport))

    cdp.close()
  } finally {
    kill()
    server.close()
  }
}

main().catch(e => { console.error('PROBE_CRASH', e); process.exit(1) })
