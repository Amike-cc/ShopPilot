/**
 * 设置弹窗 + 任务面板二级页签 视觉自查（带截图）。
 * 用法：node tools/ui/ui-settings.js
 * 临时 userData，不碰真实数据；输出各界面横向溢出度量与 PNG 截图。
 */
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '../..')
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', 'ui')
fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
const PORT = 9243
const userData = path.join(os.tmpdir(), 'shopilot-ui-settings-' + Date.now())
const sleep = ms => new Promise(r => setTimeout(r, ms))

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch { /* 已退出 */ }
}

class CDP {
  constructor(wsUrl) {
    this.id = 0; this.pending = new Map(); this.ws = new WebSocket(wsUrl)
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws')) })
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) }
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })) })
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

async function main() {
  fs.mkdirSync(userData, { recursive: true })
  const app = spawn(path.join(ROOT, 'node_modules/electron/dist/electron.exe'),
    [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + userData],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production' } })
  let log = ''
  app.stdout.on('data', d => { log += d.toString() })
  app.stderr.on('data', d => { log += d.toString() })

  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break } catch {} await sleep(400) }
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    const ui = list.find(t => t.type === 'page' && t.url.includes('index.html'))
    const cdp = new CDP(ui.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Page.enable').catch(() => {})
    await cdp.evaluate(`const d=Date.now()+15000; while(!window.shopilot && Date.now()<d) await new Promise(r=>setTimeout(r,100)); return 1;`)
    await sleep(1200)

    // 播种一家店铺并显示（任务面板/地址栏需要）
    await cdp.evaluate(`
      const c = await window.shopilot.store.create({ name: '探针店铺', platform: '拼多多', adminUrl: 'https://mms.pinduoduo.com' });
      await window.shopilot.browser.open(c.data.id);
      await new Promise(r => setTimeout(r, 1500));
      return 1;
    `)
    await cdp.evaluate(`location.reload(); return 1;`)
    await sleep(3800)
    await cdp.evaluate(`
      let card = null;
      for (let i = 0; i < 4; i++) {
        if (document.querySelector('.viewport')) break;
        card = [...document.querySelectorAll('.store-card')].find(c => c.textContent.includes('探针店铺'));
        if (!card) break;
        card.querySelector('.store-action').click();
        await new Promise(r => setTimeout(r, 3000));
      }
      return 1;
    `)

    const measure = () => cdp.evaluate(`
      const m = document.querySelector('.modal');
      const panel = document.querySelector('.right-panel');
      const body = document.querySelector('.panel-body');
      const ow = el => el ? el.scrollWidth > el.clientWidth + 2 : null;
      // 逐元素找越界者（相对 .modal 内容盒右缘）
      let bad = [];
      if (m) {
        const mr = m.getBoundingClientRect();
        const cs = getComputedStyle(m);
        const innerRight = mr.right - parseFloat(cs.paddingRight);
        for (const el of m.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > innerRight + 1) {
            bad.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 34), w: Math.round(r.width), over: Math.round(r.right - innerRight), text: (el.textContent || '').slice(0, 22) });
            if (bad.length >= 6) break;
          }
        }
      }
      return {
        modal: m ? { w: Math.round(m.getBoundingClientRect().width), overflowX: ow(m) } : null,
        metrics: m ? {
          scrollW: m.scrollWidth, clientW: m.clientWidth,
          scrollH: m.scrollHeight, clientH: m.clientHeight,
          children: [...m.children].map(c => ({ tag: c.tagName.toLowerCase(), cls: String(c.className).slice(0, 28), sw: c.scrollWidth, cw: c.clientWidth, ow: Math.round(c.getBoundingClientRect().width) })),
          // 直接列出 right 最大的若干元素（含 pseudo 无法取，先看真实元素）
          widest: [...m.querySelectorAll('*')].map(e => ({ e, r: e.getBoundingClientRect() }))
            .sort((a, b) => b.r.right - a.r.right).slice(0, 8)
            .map(({ e, r }) => ({ tag: e.tagName.toLowerCase(), cls: String(e.className).slice(0, 26), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) })),
          modalRect: (() => { const r = m.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right) } })()
        } : null,
        rightPanel: panel ? { w: Math.round(panel.getBoundingClientRect().width), overflowX: ow(panel) } : null,
        panelBodyOverflowX: ow(body),
        docOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        overflowing: bad
      };
    `)

    // 1) 设置 → 配置
    await cdp.evaluate(`document.querySelector('[data-test="settings-open-btn"]').click(); await new Promise(r=>setTimeout(r,700)); return 1;`)
    const configM = await measure()
    await cdp.shot(path.join(ARTIFACT_DIR, 'ui-settings-config.png'))
    console.log('配置页:', JSON.stringify(configM))

    // 2) 设置 → 关于软件
    await cdp.evaluate(`document.querySelector('[data-test="settings-tab-about"]').click(); await new Promise(r=>setTimeout(r,800)); return 1;`)
    const aboutM = await measure()
    await cdp.shot(path.join(ARTIFACT_DIR, 'ui-settings-about.png'))
    console.log('关于软件页:', JSON.stringify(aboutM))

    // 关闭设置
    await cdp.evaluate(`
      const btns = [...document.querySelectorAll('[data-test="settings-dialog"] .modal-actions button')];
      const close = btns[btns.length - 1];
      if (close) close.click();
      await new Promise(r=>setTimeout(r,500));
      return 1;
    `)

    // 3) 右栏 → 任务 → 达人邀约页签
    await cdp.evaluate(`
      const t = [...document.querySelectorAll('.ptab')].find(b => b.textContent.trim() === '任务');
      if (t) t.click();
      await new Promise(r=>setTimeout(r,800));
      const inv = document.querySelector('[data-test="task-tab-invite"]');
      if (inv) inv.click();
      await new Promise(r=>setTimeout(r,500));
      return 1;
    `)
    const inviteM = await measure()
    await cdp.shot(path.join(ARTIFACT_DIR, 'ui-task-invite.png'))
    console.log('达人邀约占位:', JSON.stringify(inviteM))

    console.log('\n判定:')
    console.log('  设置弹窗无横向溢出:', configM.modal && configM.modal.overflowX === false && aboutM.modal && aboutM.modal.overflowX === false)
    console.log('  右栏无横向溢出:', inviteM.rightPanel && inviteM.rightPanel.overflowX === false)
    console.log('  页面无横向滚动:', configM.docOverflowX === false && inviteM.docOverflowX === false)
    console.log('\n截图: artifacts/ui/ui-settings-config.png / artifacts/ui/ui-settings-about.png / artifacts/ui/ui-task-invite.png')
    cdp.close()
  } catch (e) {
    console.log('UI_SETTINGS_ERROR ' + e.message)
    if (log) console.log(log.slice(-600))
  } finally {
    killTree(app)
    await sleep(800)
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
  }
}
main()
