/**
 * 界面自查（带截图）：起一次带调试端口的实例，切到指定面板，输出布局度量并截图。
 * 用法：node ui-shot.js [面板名(env|bookmarks|downloads|tasks|open|ctx|trash)] [--real]
 *
 * 数据隔离：默认使用 os.tmpdir() 下的临时 userData，并在库里没有店铺时自动播种 3 家探针店铺
 * （后台地址指向脚本自起的本地站点，保证离线可跑、页面能真正加载），**绝不触碰真实数据**。
 * 这不是洁癖——本脚本的 ctx 模式会重命名店铺、复制环境配置，原先沿用真实数据目录时跑一次
 * 就会改用户真实的店铺名与环境指纹（实测真实库 248 个文件的大小/mtime 全部被改）。
 * 确需复现"用户实际看到的样子"时显式加 --real（--real 下不播种、不自起站点，但 ctx 模式
 * 仍会改真实数据，请自行确认后再用）。
 */
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')

const root = __dirname
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9230
const SITE_PORT = 61611
const argv = process.argv.slice(2)
const REAL = argv.includes('--real')
const panel = (argv.find(a => !a.startsWith('--')) || 'env').trim()
const userData = REAL ? null : path.join(os.tmpdir(), 'shopilot-ui-shot-' + Date.now())
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 结束应用进程树。只 kill 主进程在 Windows 上会留下渲染进程僵尸（实测残留 84MB renderer） */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch { /* 进程可能已自行退出 */ }
}

/**
 * 清理上次运行遗留的临时库。被强杀（如任务管理器 / kill -9）时收尾钩子不会执行，
 * 目录会一直留在 %TEMP%；启动时顺手剪掉，避免反复跑越堆越多。
 */
function pruneStaleProfiles() {
  const tdir = os.tmpdir()
  let names = []
  try { names = fs.readdirSync(tdir) } catch { return }
  for (const n of names) {
    if (!n.startsWith('shopilot-ui-shot-')) continue
    const full = path.join(tdir, n)
    if (full === userData) continue
    try { fs.rmSync(full, { recursive: true, force: true }) } catch { /* 仍在被占用就留着 */ }
  }
}

let cleaned = false
let appRef = null
let siteServer = null
function cleanup() {
  if (cleaned) return
  cleaned = true
  killTree(appRef)
  if (siteServer) { try { siteServer.close() } catch { /* ignore */ } }
  if (userData) { try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* 文件仍被占用则留待系统清理 */ } }
}
process.on('SIGINT', () => { cleanup(); process.exit(0) })
process.on('SIGTERM', () => { cleanup(); process.exit(0) })

async function targets() { return (await fetch(`http://127.0.0.1:${PORT}/json`)).json() }

async function waitCDP(timeout = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return true } catch {}
    await sleep(400)
  }
  return false
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
      // 事件：记录渲染层报错（排查"点了没反应"最直接的证据）
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

async function main() {
  if (userData) {
    pruneStaleProfiles()
    fs.mkdirSync(userData, { recursive: true })
    // 自起本地站点：探针店铺的后台地址指向它，页面一定能加载（外网页面会因加载失败/多 target
    // 让 ctx 模式的"店铺页可见性"判据失真——那不是产品问题，是探针取错了 target）
    siteServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><head><title>probe-site</title></head><body><h1 id="probe">probe</h1></body></html>')
    })
    await new Promise((res, rej) => { siteServer.once('error', rej); siteServer.listen(SITE_PORT, '127.0.0.1', res) })
  }
  const args = [root, '--no-sandbox', `--remote-debugging-port=${PORT}`]
  if (userData) args.push('--user-data-dir=' + userData)
  const app = spawn(electronExe, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production' }
  })
  appRef = app
  let procLog = ''
  app.stdout.on('data', d => { procLog += d.toString() })
  app.stderr.on('data', d => { procLog += d.toString() })
  console.log(REAL
    ? '⚠ --real：使用真实数据目录，ctx 模式会重命名真实店铺并复制其环境配置'
    : '数据隔离：临时 userData ' + userData + '（Ctrl+C 结束并清理）')

  try {
    if (!await waitCDP()) { console.log('CDP 未就绪\n' + procLog.slice(-1500)); return }
    const list = await targets()
    const ui = list.find(t => t.type === 'page' && (t.url.includes('index.html') || t.url.startsWith('file:')))
    if (!ui) { console.log('找不到主窗口 target：' + JSON.stringify(list.map(t => t.url).slice(0, 6))); return }
    const cdp = new CDP(ui.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Page.enable').catch(() => {})
    await cdp.send('Runtime.enable').catch(() => {})
    await cdp.evaluate(`const d=Date.now()+15000; while(!window.shopilot && Date.now()<d) await new Promise(r=>setTimeout(r,100)); return !!window.shopilot;`)
    await sleep(1200)

    // 隔离模式下空库自播种：env/open/ctx/trash 各模式都需要店铺，否则探针只能空转。
    // ctx 模式要 ≥2 家（源+目标），故播种 3 家；--real 下绝不播种，避免往真实库里塞假店铺。
    if (userData) {
      const existing = await cdp.evaluate(`return (((await window.shopilot.store.list()).data) || []).length;`)
      if (existing === 0) {
        await cdp.evaluate(`
          const site = ${JSON.stringify(`http://127.0.0.1:${SITE_PORT}/`)};
          const defs = [
            { name: '探针店铺A', platform: '拼多多', adminUrl: site },
            { name: '探针店铺B', platform: '微信小店', adminUrl: site },
            { name: '探针店铺C', platform: '抖店', adminUrl: site }
          ];
          for (const d of defs) await window.shopilot.store.create(d);
          return true;
        `)
        await cdp.evaluate(`setTimeout(() => location.reload(), 30); return true;`)
        await sleep(3500)
        console.log('已播种 3 家探针店铺（临时库）')
      }
    }

    // 选一个店铺 → 打开浏览器（▶）→ 切到目标面板
    const picked = await cdp.evaluate(`
      const cards = [...document.querySelectorAll('.store-card')];
      if (!cards.length) return { stores: 0 };
      cards[0].querySelector('.store-action')?.click();
      await new Promise(r => setTimeout(r, 2500));
      const tabs = [...document.querySelectorAll('.ptab')];
      const tab = tabs.find(t => t.textContent.trim() === ${JSON.stringify(panel === 'env' ? '环境' : panel)});
      if (tab) tab.click();
      await new Promise(r => setTimeout(r, 1200));
      return { stores: cards.length, tabs: tabs.map(t => t.textContent.trim()), clicked: !!tab, displayed: !!document.querySelector('.browser-col .viewport, .browser-col iframe') };
    `)
    console.log('店铺卡数量: ' + picked.stores + ' / 面板页签: ' + (picked.tabs || []).join(',') + ' / 已切到: ' + picked.clicked)
    await sleep(600)

    if (panel === 'open') {
      // 首次点击"打开浏览器"是否生效（探针里出现过第一次点了没反应）
      const r = await cdp.evaluate(`
        const snap = () => ({
          displayed: !!document.querySelector('.store-card.displayed'),
          viewport: !!document.querySelector('.viewport'),
          tabs: document.querySelectorAll('.tab').length,
          toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())
        });
        const cards = [...document.querySelectorAll('.store-card')];
        const before = { cards: cards.length, state: snap(), listLoading: !!document.querySelector('.empty-hint') };
        const btn = cards[0]?.querySelector('.store-action');
        if (!btn) return { error: '无店铺卡', before };
        btn.click();
        const at1 = await new Promise(r => setTimeout(() => r(snap()), 1000));
        const at3 = await new Promise(r => setTimeout(() => r(snap()), 3000));
        const at6 = await new Promise(r => setTimeout(() => r(snap()), 6000));
        return { before, at1, at3, at6 };
      `)
      console.log('\n=== 打开店铺（单次点击）===\n' + JSON.stringify(r, null, 2))
      if (cdp.console.length) console.log('\n=== 渲染层报错 ===\n' + cdp.console.slice(-8).join('\n'))
      const logDir = require('path').join(process.env.APPDATA || '', 'shopilot', 'logs')
      if (require('fs').existsSync(logDir)) {
        const f = require('fs').readdirSync(logDir).filter(x => /^app-.*\.log$/.test(x)).sort().pop()
        const tail = require('fs').readFileSync(require('path').join(logDir, f), 'utf8').split('\n').slice(-12).join('\n')
        console.log('\n=== 主进程日志尾部 ===\n' + tail)
      }
      cdp.close()
      return
    }

    if (panel === 'ctx') {
      // 右键菜单链路：触发 contextmenu → 菜单渲染/遮挡 → 重命名 → 复制环境配置 → Esc 关闭
      const storeTarget = async () => {
        const t = await targets()
        return t.find(x => x.type === 'page' && !x.url.includes('index.html') && !x.url.startsWith('file:') && !x.url.startsWith('devtools'))
      }
      const vis = async () => {
        const st = await storeTarget()
        if (!st) return null
        const d = new CDP(st.webSocketDebuggerUrl); await d.ready
        const v = await d.evaluate(`return document.visibilityState`); d.close(); return v
      }
      const ensureOpen = await cdp.evaluate(`
        const snap = () => ({ displayed: !!document.querySelector('.store-card.displayed'), viewport: !!document.querySelector('.viewport') });
        if (!snap().viewport) {
          const cards = [...document.querySelectorAll('.store-card')];
          cards[0]?.querySelector('.store-action')?.click();
          await new Promise(r => setTimeout(r, 3000));
        }
        return snap();
      `)
      console.log('店铺已打开:', JSON.stringify(ensureOpen))

      const menu = await cdp.evaluate(`
        const cards = [...document.querySelectorAll('.store-card')];
        const c = cards[0];
        const r = c.getBoundingClientRect();
        c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 40), clientY: Math.round(r.top + 20) }));
        await new Promise(r => setTimeout(r, 800));
        const m = document.querySelector('[data-test="store-ctx"]');
        return {
          menuShown: !!m,
          items: m ? [...m.querySelectorAll('.ctx-item')].map(b => ({ t: b.textContent.trim().slice(0, 18), disabled: b.disabled })) : [],
          rect: m ? (() => { const b = m.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } })() : null,
          insideWindow: m ? (() => { const b = m.getBoundingClientRect(); return b.x >= 0 && b.y >= 0 && b.right <= window.innerWidth + 1 && b.bottom <= window.innerHeight + 1 })() : null,
          nativeConfirmUsed: false
        };
      `)
      const visWithMenu = await vis()
      console.log('\n=== 右键菜单 ===\n' + JSON.stringify(menu, null, 2))
      console.log('菜单打开时店铺页可见性:', visWithMenu)

      // 重命名
      const renamed = await cdp.evaluate(`
        document.querySelector('[data-test="ctx-rename"]').click();
        await new Promise(r => setTimeout(r, 700));
        const inp = document.querySelector('[data-test="rename-input"]');
        const hadModal = !!inp;
        if (inp) {
          inp.value = 'PROBE重命名店-' + Date.now().toString().slice(-4);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 200));
          document.querySelector('[data-test="rename-save"]').click();
          await new Promise(r => setTimeout(r, 1200));
        }
        const list = await window.shopilot.store.list();
        const mine = (list.data || []).filter(s => String(s.name).startsWith('PROBE重命名店-'));
        return { hadModal, modalGone: !document.querySelector('[data-test="rename-input"]'), renamedCount: mine.length, newName: mine[0]?.name || null };
      `)
      console.log('\n=== 重命名 ===\n' + JSON.stringify(renamed, null, 2))

      // 复制环境配置（按店铺名精确选源与目标，验证配置真的过去了）
      const copied = await cdp.evaluate(`
        const prof = async (id) => (await window.shopilot.profile.get(id)).data;
        const list = ((await window.shopilot.store.list()).data || []).filter(s => s.name !== '' );
        const src = list[0], dst = list[1];
        if (!src || !dst) return { error: '店铺不足两个', count: list.length };
        const before = await prof(dst.id);
        const srcProf = await prof(src.id);
        const card = [...document.querySelectorAll('.store-card')].find(c => c.textContent.includes(src.name));
        const r = card.getBoundingClientRect();
        card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 40), clientY: Math.round(r.top + 20) }));
        await new Promise(r => setTimeout(r, 700));
        document.querySelector('[data-test="ctx-copycfg"]').click();
        await new Promise(r => setTimeout(r, 700));
        const picks = [...document.querySelectorAll('.store-pick')];
        const want = picks.find(p => p.textContent.includes(dst.name));
        const hadModal = picks.length > 0;
        want?.querySelector('input')?.click();
        await new Promise(r => setTimeout(r, 300));
        const btn = document.querySelector('[data-test="copy-apply"]');
        const btnEnabled = btn ? !btn.disabled : null;
        btn?.click();
        await new Promise(r => setTimeout(r, 1600));
        const after = await prof(dst.id);
        const toast = [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()).join(' | ');
        return {
          hadModal, picks: picks.length, btnEnabled, srcName: src.name, dstName: dst.name, toast,
          srcUa: (srcProf?.userAgent || '').slice(-30), dstUaBefore: (before?.userAgent || '').slice(-30), dstUaAfter: (after?.userAgent || '').slice(-30),
          tzMatch: srcProf?.timezone === after?.timezone, screenMatch: srcProf?.screenWidth === after?.screenWidth,
          modalGone: !document.querySelector('[data-test="copy-apply"]')
        };
      `)
      console.log('\n=== 复制环境配置 ===\n' + JSON.stringify(copied, null, 2))

      // 菜单与视口相交时才摘除视图；落在左栏时不摘（避免中栏白闪）
      const overlap = await cdp.evaluate(`
        const card = document.querySelector('.store-card');
        const r = card.getBoundingClientRect();
        card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 40), clientY: Math.round(r.top + 20) }));
        await new Promise(r => setTimeout(r, 700));
        const sidebarMenu = !!document.querySelector('[data-test="store-ctx"]');
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await new Promise(r => setTimeout(r, 400));
        const vp = document.querySelector('.viewport');
        const vr = vp.getBoundingClientRect();
        card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(vr.left + 200), clientY: Math.round(vr.top + 150) }));
        await new Promise(r => setTimeout(r, 800));
        const m = document.querySelector('[data-test="store-ctx"]');
        const mr = m ? m.getBoundingClientRect() : null;
        return {
          sidebarMenu, closed: !m ? true : false,
          menuAtViewport: !!m,
          menuRect: mr ? { x: Math.round(mr.x), y: Math.round(mr.y), w: Math.round(mr.width), h: Math.round(mr.height) } : null,
          overlapsViewport: mr ? !(mr.right <= vr.left || mr.left >= vr.right || mr.bottom <= vr.top || mr.top >= vr.bottom) : null
        };
      `)
      const visOverlap = await vis()
      console.log('\n=== 菜单位置与遮挡 ===\n' + JSON.stringify(overlap) + '\n  菜单落在视口内时店铺页可见性=' + visOverlap)
      const sidebarVis = await cdp.evaluate(`
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await new Promise(r => setTimeout(r, 500));
        const card = document.querySelector('.store-card');
        const r = card.getBoundingClientRect();
        card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 40), clientY: Math.round(r.top + 20) }));
        await new Promise(r => setTimeout(r, 800));
        return true;
      `)
      const visSidebar = await vis()
      console.log('  菜单落在左栏时店铺页可见性=' + visSidebar + ' （应为 visible，说明没有被无谓摘除）')

      // Esc 关闭
      const esc = await cdp.evaluate(`
        const cards = [...document.querySelectorAll('.store-card')];
        const r = cards[0].getBoundingClientRect();
        cards[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 40), clientY: Math.round(r.top + 20) }));
        await new Promise(r => setTimeout(r, 600));
        const shown = !!document.querySelector('[data-test="store-ctx"]');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise(r => setTimeout(r, 400));
        return { shown, closedByEsc: !document.querySelector('[data-test="store-ctx"]') };
      `)
      const visAfter = await vis()
      console.log('\n=== Esc 关闭 ===\n' + JSON.stringify(esc) + '  关闭后可见性=' + visAfter)
      if (cdp.console.length) console.log('\n=== 渲染层报错 ===\n' + cdp.console.slice(-8).join('\n'))
      cdp.close()
      return
    }

    if (panel === 'trash') {
      // 回收站链路：开店铺（挂载原生 WebContentsView）→ 点回收站 → 量弹层/视口关系 + 店铺页可见性
      const storeTarget = async () => {
        const t = await targets()
        return t.find(x => x.type === 'page' && !x.url.includes('index.html') && !x.url.startsWith('file:') && !x.url.startsWith('devtools'))
      }
      const visibilityOf = async () => {
        const st = await storeTarget()
        if (!st) return { target: null }
        const d = new CDP(st.webSocketDebuggerUrl)
        await d.ready
        const v = await d.evaluate(`return { vis: document.visibilityState, hidden: document.hidden, url: location.href.slice(0, 60) }`)
        d.close()
        return { target: st.url.slice(0, 60), ...v }
      }
      const trash = await cdp.evaluate(`
        const rect = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
        const state = () => ({
          displayed: !!document.querySelector('.store-card.displayed'),
          viewport: !!document.querySelector('.viewport'),
          welcome: !!document.querySelector('.welcome'),
          tabs: document.querySelectorAll('.tab').length,
          rightPanel: !!document.querySelector('.right-panel')
        });
        const cards = [...document.querySelectorAll('.store-card')];
        const openInfo = { cards: cards.length, after1: null, after2: null };
        if (cards.length) {
          cards[0].querySelector('.store-action')?.click();
          await new Promise(r => setTimeout(r, 3000));
          openInfo.after1 = state();
          if (!openInfo.after1.viewport) {
            cards[0].querySelector('.store-action')?.click();
            await new Promise(r => setTimeout(r, 3000));
            openInfo.after2 = state();
          }
        }
        const btn = [...document.querySelectorAll('.foot-btn')].find(b => (b.textContent || '').includes('回收站'));
        if (!btn) return { error: '未找到回收站按钮', openInfo };
        window.__m4TrashProbe = { btn, openedAt: null, closedAt: null };
        return { openInfo, ready: true };
      `)
      if (trash.error) { console.log(JSON.stringify(trash, null, 2)); cdp.close(); return }

      const visBefore = await visibilityOf()
      const afterOpen = await cdp.evaluate(`
        const btn = [...document.querySelectorAll('.foot-btn')].find(b => (b.textContent || '').includes('回收站'));
        btn.click();
        await new Promise(r => setTimeout(r, 1500));
        const rect = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
        const modal = document.querySelector('.modal'); const vp = document.querySelector('.viewport');
        const out = { mask: !!document.querySelector('.modal-mask'), isOpen: !!modal,
          modalRect: modal ? rect(modal) : null, viewportRect: vp ? rect(vp) : null,
          emptyHint: document.querySelector('.modal .empty-hint')?.textContent || null,
          heading: document.querySelector('.modal h2')?.textContent || null };
        if (out.modalRect && out.viewportRect) {
          const m = out.modalRect, v = out.viewportRect;
          const ow = Math.max(0, Math.min(m.x + m.w, v.x + v.w) - Math.max(m.x, v.x));
          const oh = Math.max(0, Math.min(m.y + m.h, v.y + v.h) - Math.max(m.y, v.y));
          out.modalAreaInsideViewport = +(ow * oh / (m.w * m.h)).toFixed(3);
        }
        return out;
      `)
      const visOpen = await visibilityOf()
      await cdp.shot(path.join(root, 'ui-trash-open.png'))
      const afterClose = await cdp.evaluate(`
        const btn = [...document.querySelectorAll('.modal-actions .btn-ghost')][0];
        btn.click();
        await new Promise(r => setTimeout(r, 1500));
        return { maskGone: !document.querySelector('.modal-mask'), viewport: !!document.querySelector('.viewport') };
      `)
      const visClosed = await visibilityOf()
      await cdp.shot(path.join(root, 'ui-trash-closed.png'))
      const logTail = await cdp.evaluate(`return true`)

      console.log('\n=== 回收站链路 ===')
      console.log('打开店铺:', JSON.stringify(trash.openInfo))
      console.log('弹窗(打开后):', JSON.stringify(afterOpen))
      console.log('关闭后:', JSON.stringify(afterClose))
      console.log('\n店铺页可见性（用户实际能不能看到弹窗的判据）:')
      console.log('  打开弹窗前:', JSON.stringify(visBefore))
      console.log('  弹窗打开时:', JSON.stringify(visOpen))
      console.log('  弹窗关闭后:', JSON.stringify(visClosed))
      if (cdp.console.length) console.log('\n=== 渲染层报错 ===\n' + cdp.console.slice(-8).join('\n'))
      console.log('\n截图: ui-trash-open.png / ui-trash-closed.png')
      cdp.close()
      return
    }

    const metrics = await cdp.evaluate(`
      const rp = document.querySelector('.right-panel');
      const out = { rightPanel: !!rp, panelWidth: rp ? Math.round(rp.getBoundingClientRect().width) : 0, rightPanelHeight: rp ? Math.round(rp.getBoundingClientRect().height) : 0 };
      const body = document.querySelector('.panel-body.env-body') || document.querySelector('.panel-body');
      if (body) {
        out.bodyScrollH = body.scrollHeight; out.bodyClientH = body.clientHeight; out.bodyScrollW = body.scrollWidth; out.bodyClientW = body.clientWidth;
        out.overflowY = body.scrollHeight > body.clientHeight + 2;
        out.overflowX = body.scrollWidth > body.clientWidth + 2;
      } else out.noBody = true;
      out.sections = [...document.querySelectorAll('.env-sec')].map(s => {
        const h = s.querySelector('.env-h');
        const r = s.getBoundingClientRect();
        return { title: h ? h.textContent.trim() : '(无标题)', h: Math.round(r.height), w: Math.round(r.width), overflowX: s.scrollWidth > s.clientWidth + 2 };
      });
      // 找出横向溢出自身容器的元素
      const bad = [];
      for (const el of document.querySelectorAll('.env-body *')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.right > (rp ? rp.getBoundingClientRect().right : 1e9) + 1 || r.left < (rp ? rp.getBoundingClientRect().left : -1e9) - 1)) {
          bad.push({ tag: el.tagName.toLowerCase(), cls: el.className, text: (el.textContent || '').slice(0, 24), w: Math.round(r.width) });
          if (bad.length >= 8) break;
        }
      }
      out.overflowing = bad;
      // 逐元素宽度取证（添加代理那一行最容易被我新增的通用选择器影响）
      const w = sel => { const e = document.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().width) : null };
      out.widths = {
        panel: w('.right-panel'), envSec: w('.env-sec'), addLine: w('.add-line'),
        addLineSelect: w('.add-line select'), addLineHost: w('.add-line .f-host'), addLinePort: w('.add-line .f-port'),
        addLineInput: w('.add-line input:not(.f-host):not(.f-port)'),
        bindSelect: w('.bind-row select'), ckSearch: w('.ck-search'),
        lastAddLine: (() => { const ls = document.querySelectorAll('.add-line'); const e = ls[ls.length - 1]; return e ? Math.round(e.getBoundingClientRect().width) : null })()
      };
      out.addLineWraps = (() => {
        const rows = [...document.querySelectorAll('.add-line')];
        return rows.map(r => ({ rowW: Math.round(r.getBoundingClientRect().width), children: [...r.children].map(c => ({ tag: c.tagName.toLowerCase(), cls: c.className, w: Math.round(c.getBoundingClientRect().width) })) }));
      })();
      out.cookieRows = document.querySelectorAll('[data-test="session-sec"] .row-item, [data-test="session-sec"] .ck-row').length;
      out.sessionSecText = (document.querySelector('[data-test="session-sec"]')?.innerText || '').slice(0, 300);
      out.lockSecText = (document.querySelector('[data-test="lock-sec"]')?.innerText || '').slice(0, 260);
      out.diagSecText = (document.querySelector('[data-test="diag-sec"]')?.innerText || '').slice(0, 220);
      out.firstSecText = (document.querySelector('.env-sec')?.innerText || '').slice(0, 200);
      out.docWidth = document.documentElement.clientWidth;
      out.horizontalDocScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth + 2;
      return out;
    `)
    console.log('\n=== 布局度量 ===\n' + JSON.stringify(metrics, null, 2))

    const shot = path.join(root, `ui-${panel}-shot.png`)
    await cdp.shot(shot)
    console.log('\n截图: ' + shot)
    const full = path.join(root, `ui-${panel}-full.png`)
    const m = await cdp.send('Page.getLayoutMetrics').catch(() => null)
    if (m?.cssContentSize) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: Math.round(m.cssContentSize.width), height: Math.round(m.cssContentSize.height), deviceScaleFactor: 1, mobile: false
      }).catch(() => {})
      await cdp.shot(full)
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
      console.log('整页截图: ' + full)
    }
    cdp.close()
  } catch (e) {
    console.log('UI_SHOT_ERROR ' + e.message)
    if (procLog) console.log(procLog.slice(-800))
  } finally {
    // 不退出应用：留给用户继续操作（截图/目视）。Ctrl+C 会结束应用并清掉临时库。
    console.log('\n（应用保持运行，端口 ' + PORT + (userData ? '；临时库 ' + userData + '，Ctrl+C 结束应用并清理' : '；⚠ 真实数据目录') + '）')
  }
}

main()
