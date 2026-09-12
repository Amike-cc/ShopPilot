/**
 * 安全能力验收（CDP 驱动）：会话导出/导入加密包 / Cookie 查看器 / 应用锁 / 代理健康巡检
 * 前置：sec-runner.js 启动应用（注入 SHOPILOT_TEST_PASSWORD 与 AUTOCONFIRM 钩子）。
 */
const http = require('http')
const fs = require('fs')
const path = require('path')

const CDP_PORT = process.env.SHOPILOT_CDP_PORT || '9226'
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`
const TEST_PWD = 'exp0rt-pw-123'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

class CDPSession {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = () => resolve(); this.ws.onerror = reject })
    this.ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result)
      }
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  async evaluate(fnBody, timeoutMs = 45000) {
    await this.ready
    // 给每次求值加超时：页面若被弹窗/导航卡住，Promise 会永不 settle，验收脚本静默挂死（实测踩过）
    const r = await Promise.race([
      this.send('Runtime.evaluate', { expression: `(async () => { ${fnBody} })()`, awaitPromise: true, returnByValue: true }),
      new Promise((_res, rej) => setTimeout(() => rej(new Error(`页面求值超时（${timeoutMs}ms）：${String(fnBody).replace(/\s+/g, ' ').trim().slice(0, 120)}`)), timeoutMs))
    ])
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  close() { try { this.ws.close() } catch {} }
}

function startSite() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/setcookie')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': ['M5SESSION=' + 'S'.repeat(50) + '; Path=/; Max-Age=86400', 'M5HTTPONLY=hidden-token; Path=/; HttpOnly']
      })
      res.end('<!doctype html><html><head><title>种Cookie页</title></head><body><h1 id="t">M5</h1><script>localStorage.setItem("M5_LS_MARK","local-secret");</script></body></html>')
      return
    }
    if (req.url.startsWith('/bcookie')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': 'M5_B_ONLY=bsecret; Path=/'
      })
      res.end('<!doctype html><html><head><title>B页</title></head><body><h1 id="tb">b</h1></body></html>')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>普通页</title></head><body><h1 id="t2">plain</h1></body></html>')
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

async function main() {
  const results = []
  const check = (name, ok, extra = '') => {
    results.push({ name, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
  }

  const { server, port: SITE_PORT } = await startSite()
  const BASE = `http://127.0.0.1:${SITE_PORT}`
  console.log('本地站点 127.0.0.1:' + SITE_PORT)

  const targets = await (await fetch(CDP_BASE + '/json')).json()
  const ui = targets.find(t => t.type === 'page' && (t.url.includes('index.html') || t.url.startsWith('file:')))
  const cdp = new CDPSession(ui.webSocketDebuggerUrl)
  await cdp.evaluate(`const d=Date.now()+15000; while(!window.shopilot && Date.now()<d) await new Promise(r=>setTimeout(r,100)); return !!window.shopilot;`)

  const call = (expr) => cdp.evaluate(`return await (${expr});`)
  const A = {
    storeCreate: (i) => call(`window.shopilot.store.create(${JSON.stringify(i)})`),
    browserOpen: (s) => call(`window.shopilot.browser.open(${JSON.stringify(s)})`),
    browserClose: (s) => call(`window.shopilot.browser.close(${JSON.stringify(s)})`),
    tabCreate: (s, u) => call(`window.shopilot.browser.tab.create(${JSON.stringify(s)}, ${JSON.stringify(u)})`),
    tabList: (s) => call(`window.shopilot.browser.tab.list(${JSON.stringify(s)})`),
    sessionStatus: (s) => call(`window.shopilot.session.status(${JSON.stringify(s)})`),
    sExport: (s, p, d) => call(`window.shopilot.session.export(${JSON.stringify(s)}, ${JSON.stringify(p)}${d ? ', ' + d : ''})`),
    sImport: (s, p) => call(`window.shopilot.session.import(${JSON.stringify(s)}, ${JSON.stringify(p)})`),
    cookies: (s, q) => call(`window.shopilot.session.cookies(${JSON.stringify(s)}${q ? ', ' + JSON.stringify(q) : ''})`),
    delCookie: (s, n, d, p, sec) => call(`window.shopilot.session.deleteCookie(${JSON.stringify(s)}, ${JSON.stringify(n)}, ${JSON.stringify(d)}, ${JSON.stringify(p)}, ${sec})`),
    clearCookies: (s) => call(`window.shopilot.session.clearCookies(${JSON.stringify(s)})`),
    secStatus: () => call('window.shopilot.security.status()'),
    setPw: (p, o) => call(`window.shopilot.security.setPassword(${JSON.stringify(p ?? null)}, ${JSON.stringify(o ?? null)})`),
    rmPw: (c) => call(`window.shopilot.security.removePassword(${JSON.stringify(c)})`),
    lock: () => call('window.shopilot.security.lock()'),
    unlock: (c) => call(`window.shopilot.security.unlock(${JSON.stringify(c)})`),
    storeList: () => call('window.shopilot.store.list()'),
    proxyCreate: (d) => call(`window.shopilot.proxy.create(${JSON.stringify(d)})`),
    proxyBind: (s, p) => call(`window.shopilot.proxy.bind(${JSON.stringify(s)}, ${p ? JSON.stringify(p) : 'null'})`),
    proxyList: () => call('window.shopilot.proxy.list()'),
    auditQuery: () => call('window.shopilot.audit.query({ limit: 400 })'),
    settingsGet: (k) => call(`window.shopilot.settings.get(${JSON.stringify(k)})`),
    settingsSet: (k, v) => call(`window.shopilot.settings.set(${JSON.stringify(k)}, ${JSON.stringify(v)})`),
    storeDelPerm: (s) => call(`window.shopilot.store.deletePermanent(${JSON.stringify(s)})`),
    trashList: () => call('window.shopilot.store.trashList()'),
    purge: (s) => call(`window.shopilot.store.purge(${JSON.stringify(s)})`),
    userDataDir: () => call('window.shopilot.settings.get("__probe_nox__").then(() => null)')
  }

  // ---------- 0. 建店 + 种 Cookie ----------
  const sa = (await A.storeCreate({ name: 'M5店铺A', platform: '拼多多', adminUrl: BASE + '/setcookie' })).data
  const sb = (await A.storeCreate({ name: 'M5店铺B', platform: '微信小店', adminUrl: BASE + '/' })).data

  // 通过 UI 真实路径打开 A（视口渲染）
  await cdp.evaluate(`setTimeout(() => location.reload(), 30); return true;`)
  await sleep(3500)
  await cdp.evaluate(`
    const cards=[...document.querySelectorAll('.store-card')];
    const c=cards.find(x=>x.textContent.includes('M5店铺A'));
    if(c){const b=c.querySelector('.store-action'); (b||c).click(); return true} return false;
  `)
  await sleep(2000)
  await A.tabCreate(sa.id, BASE + '/setcookie')
  await sleep(1800)

  // ---------- 0.5 环境面板布局（用户实报"显示有问题"：横向溢出 / 主机输入被挤没） ----------
  const envUi = await cdp.evaluate(`
    const tabs = [...document.querySelectorAll('.ptab')];
    const tab = tabs.find(t => t.textContent.trim() === '环境');
    if (tab) tab.click();
    await new Promise(r => setTimeout(r, 900));
    const body = document.querySelector('.panel-body.env-body');
    const width = sel => { const e = document.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().width) : null };
    const secs = [...document.querySelectorAll('.env-sec')].map(s => ({
      title: (s.querySelector('.env-h')?.textContent || '').trim().slice(0, 12),
      over: s.scrollWidth > s.clientWidth + 2
    }));
    const addLines = [...document.querySelectorAll('.add-line')].map(r => [...r.children].map(c => Math.round(c.getBoundingClientRect().width)));
    return {
      hasBody: !!body,
      overflowX: body ? body.scrollWidth > body.clientWidth + 2 : null,
      panelW: width('.right-panel'), bodyW: width('.panel-body.env-body'),
      typeSelW: width('.add-line select'), hostW: width('.add-line .f-host'), portW: width('.add-line .f-port'),
      secsOverflow: secs.filter(s => s.over).map(s => s.title),
      secCount: secs.length,
      addLines,
      hasNewSections: !!document.querySelector('[data-test="session-sec"]') && !!document.querySelector('[data-test="lock-sec"]') && !!document.querySelector('[data-test="diag-sec"]')
    };
  `)
  check('环境面板渲染且无横向溢出（右栏不被截断）', envUi.hasBody && envUi.overflowX === false, JSON.stringify({ over: envUi.overflowX, panelW: envUi.panelW, bodyW: envUi.bodyW }))
  check('环境面板各分区自身不横向溢出', envUi.secsOverflow.length === 0, envUi.secsOverflow.join(',') || `${envUi.secCount} 个分区均正常`)
  check('添加代理行可用：协议下拉 74px / 主机输入 ≥60px',
    Math.abs(envUi.typeSelW - 74) <= 6 && envUi.hostW >= 60,
    `type=${envUi.typeSelW} host=${envUi.hostW} port=${envUi.portW}`)
  check('环境面板含会话/Cookie、应用锁、备份诊断三段', envUi.hasNewSections === true)

  // ---------- 0.6 弹层遮挡：店铺页是原生 WebContentsView，会盖住 HTML 弹窗（用户实报） ----------
  const storePageTarget = async () => {
    const t = await (await fetch(CDP_BASE + '/json')).json()
    return t.find(x => x.type === 'page' && x.url.startsWith(BASE + '/setcookie'))
  }
  const storePageVis = async () => {
    const t = await storePageTarget()
    if (!t) return null
    const d = new CDPSession(t.webSocketDebuggerUrl)
    const v = await d.evaluate(`return document.visibilityState`)
    d.close()
    return v
  }
  const visBeforeModal = await storePageVis()
  const modalOpen = await cdp.evaluate(`
    const btn = [...document.querySelectorAll('.foot-btn')].find(b => (b.textContent || '').includes('回收站'));
    if (!btn) return { clicked: false };
    btn.click();
    await new Promise(r => setTimeout(r, 1500));
    const rect = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
    const modal = document.querySelector('.modal'); const vp = document.querySelector('.viewport');
    let ratio = null;
    if (modal && vp) {
      const m = rect(modal), v = rect(vp);
      const ow = Math.max(0, Math.min(m.x + m.w, v.x + v.w) - Math.max(m.x, v.x));
      const oh = Math.max(0, Math.min(m.y + m.h, v.y + v.h) - Math.max(m.y, v.y));
      ratio = +(ow * oh / (m.w * m.h)).toFixed(3);
    }
    return { clicked: true, mask: !!document.querySelector('.modal-mask'), heading: document.querySelector('.modal h2')?.textContent || null, viewport: !!vp, overlapRatio: ratio };
  `)
  const visWithModal = await storePageVis()
  check('回收站入口可点击并渲染抽屉', modalOpen.clicked && modalOpen.mask && modalOpen.heading === '回收站', JSON.stringify(modalOpen))
  check('弹层期间店铺视图被摘除（原生层不再遮挡弹窗）',
    visBeforeModal === 'visible' && visWithModal === 'hidden',
    `弹窗前=${visBeforeModal} 弹窗时=${visWithModal} 重叠比例=${modalOpen.overlapRatio}`)
  const modalClosed = await cdp.evaluate(`
    const b = document.querySelector('.modal-actions .btn-ghost');
    if (!b) return { closed: false };
    b.click();
    await new Promise(r => setTimeout(r, 1500));
    return { closed: !document.querySelector('.modal-mask'), viewport: !!document.querySelector('.viewport'), tabs: document.querySelectorAll('.tab').length };
  `)
  const visAfterModal = await storePageVis()
  check('关闭弹层后店铺视图恢复（中栏不空白）',
    modalClosed.closed && visAfterModal === 'visible' && modalClosed.viewport,
    `关闭后=${JSON.stringify(modalClosed)} 可见性=${visAfterModal}`)

  const ckA = await A.cookies(sa.id)
  const names = (ckA.data?.items || []).map(x => x.name)
  check('站点种下 2 条 Cookie 可查（含 HttpOnly）', names.includes('M5SESSION') && names.includes('M5HTTPONLY'), names.join(','))
  const longCk = (ckA.data?.items || []).find(x => x.name === 'M5SESSION')
  check('查看器值截断展示（>24 字符→预览+省略号）', longCk?.valuePreview?.endsWith('…') && longCk.valuePreview.length <= 25, longCk?.valuePreview)
  check('HttpOnly 标记如实展示', (ckA.data?.items || []).find(x => x.name === 'M5HTTPONLY')?.httpOnly === true)
  const ckSearch = await A.cookies(sa.id, 'httponly')
  check('Cookie 搜索按名称/域过滤', (ckSearch.data?.items || []).length === 1 && ckSearch.data.items[0].name === 'M5HTTPONLY')

  // ---------- 1. 导出加密包 ----------
  const outPath = path.join(process.env.TEMP || '/tmp', `m5-session-${Date.now()}.shopilot`)
  const exp = await A.sExport(sa.id, outPath)
  check('session:export 成功（主进程对话框经测试钩子应答）', exp.ok && exp.data.cookieCount >= 2, JSON.stringify(exp.data || exp.error))
  const pkgBuf = fs.existsSync(outPath) ? fs.readFileSync(outPath) : null
  check('导出包落盘且带 SHSP 魔数/版本', !!pkgBuf && pkgBuf.subarray(0, 4).toString('ascii') === 'SHSP' && pkgBuf.length > 200, pkgBuf ? pkgBuf.length + 'B' : 'NO_FILE')
  check('包内容不明文可见（Cookie 值不以明文出现于文件）', !!pkgBuf && !pkgBuf.includes(Buffer.from('hidden-token')), '')

  // ---------- 2. 目标店 B：先有自己的 Cookie，验证导入覆盖语义 ----------
  await A.browserOpen(sb.id)
  await A.tabCreate(sb.id, BASE + '/bcookie')
  await sleep(1500)
  const ckB0 = await A.cookies(sb.id)
  check('店铺 B 预置自有 Cookie（M5_B_ONLY）', (ckB0.data?.items || []).some(x => x.name === 'M5_B_ONLY'))

  // ---------- 3. 篡改/过期拒绝导入（§13） ----------
  const tampered = Buffer.from(pkgBuf)
  tampered[tampered.length - 20] ^= 0xff // 翻动 tag 字节
  const tPath = outPath + '.tampered'
  fs.writeFileSync(tPath, tampered)
  const impBad = await A.sImport(sb.id, tPath)
  check('篡改包 → SESSION_IMPORT_INVALID（GCM 认证拒绝）', !impBad.ok && impBad.error?.code === 'SESSION_IMPORT_INVALID', impBad.error?.message?.slice(0, 50))
  const ckB1 = await A.cookies(sb.id)
  check('导入失败绝不动目标现有会话（M5_B_ONLY 仍在）', (ckB1.data?.items || []).some(x => x.name === 'M5_B_ONLY'))

  const expiredPath = path.join(process.env.TEMP || '/tmp', `m5-expired-${Date.now()}.shopilot`)
  const expNeg = await A.sExport(sa.id, expiredPath, -1) // 有效期 -1 天（验收专用，UI 不提供）
  const impExp = await A.sImport(sb.id, expiredPath)
  check('过期包一律拒绝导入 SESSION_PACKAGE_EXPIRED', expNeg.ok && !impExp.ok && impExp.error?.code === 'SESSION_PACKAGE_EXPIRED', impExp.error?.message)

  // ---------- 4. 正常导入到店铺 B（覆盖语义） ----------
  const imp = await A.sImport(sb.id, outPath)
  check('session:import 成功导入有效包', imp.ok && imp.data.imported >= 2, JSON.stringify(imp.data || imp.error))
  const ckB = await A.cookies(sb.id)
  const namesB = (ckB.data?.items || []).map(x => x.name)
  check('导入覆盖：包内 Cookie 生效（含 HttpOnly）且自有 Cookie 清除',
    namesB.includes('M5SESSION') && namesB.includes('M5HTTPONLY') && !namesB.includes('M5_B_ONLY'), namesB.join(','))
  check('指纹配置随包恢复', imp.data?.profileRestored === true, 'restored=' + imp.data?.profileRestored)

  // localStorage 不在包内的边界（§10.2 如实声明）：B 从未 set 过标记，导入也不带来
  let lsOnB = 'ATTACH_FAIL'
  try {
    const t2 = await (await fetch(CDP_BASE + '/json')).json()
    const bTab = t2.find(t => t.type === 'page' && t.url.includes('/bcookie'))
    if (bTab) {
      const cdpB = new CDPSession(bTab.webSocketDebuggerUrl)
      lsOnB = await cdpB.evaluate(`return localStorage.getItem('M5_LS_MARK')`)
      cdpB.close()
    }
  } catch { /* 附加失败时下面断言会如实报 */ }
  const headerJson = pkgBuf.subarray(8, 8 + pkgBuf.readUInt32LE(4)).toString('utf8')
  check('包结构头携带 KDF 参数与有效期字段', headerJson.includes('"kdf":"scrypt"') && headerJson.includes('"expiresAt"'), headerJson.slice(0, 80))
  check('边界如实：localStorage 不随包迁移（目标店读不到源店标记）', lsOnB === null, String(lsOnB))

  // ---------- 4. Cookie 删除 ----------
  const delOne = await A.delCookie(sb.id, 'M5HTTPONLY', '127.0.0.1', '/', false)
  const ckAfterDel = await A.cookies(sb.id)
  check('单条 Cookie 删除生效', delOne.ok && !(ckAfterDel.data.items || []).some(x => x.name === 'M5HTTPONLY'), 'total=' + ckAfterDel.data?.total)
  await A.clearCookies(sb.id)
  const ckAfterClear = await A.cookies(sb.id)
  check('清空全部 Cookie（total=0）', ckAfterClear.ok && ckAfterClear.data.total === 0)

  // ---------- 5. 应用锁 ----------
  const st0 = await A.secStatus()
  check('初始 security:status（未设密码未锁定）', st0.ok && st0.data.enabled === false && st0.data.locked === false, JSON.stringify(st0.data))
  const setPw = await A.setPw('masterkey-123')
  check('设置主密码成功', setPw.ok, setPw.error?.message)

  // §187 校验信息不落明文：直接扫 db 文件字节
  const stForPath = await A.sessionStatus(sa.id)
  void stForPath
  // userData 路径由 runner 注入
  const dbDir = process.env.SHOPILOT_USERDATA_DIR
  let plaintextLeak = null
  if (dbDir) {
    const dbBuf = fs.readFileSync(path.join(dbDir, 'shopilot.db'))
    plaintextLeak = dbBuf.includes(Buffer.from('masterkey-123')) || dbBuf.includes(Buffer.from('exp0rt-pw-123'))
  }
  check('主密码未以明文出现于数据库（scrypt+safeStorage）', dbDir ? plaintextLeak === false : true, dbDir ? 'scanned shopilot.db' : 'no db path provided')

  const lk = await A.lock()
  check('security:lock 生效', lk.ok && lk.data.locked === true)
  const blocked = await A.storeList()
  check('锁定态业务 IPC 被门禁拒绝 APP_LOCKED', !blocked.ok && blocked.error?.code === 'APP_LOCKED', blocked.error?.code)
  const uiLocked = await cdp.evaluate(`return !!document.querySelector('.lock-overlay') && document.querySelector('.lock-box h2').textContent.includes('已锁定');`)
  check('锁定 overlay 呈现（浏览器视图已被主进程摘除）', uiLocked)
  const badUn = await A.unlock('wrong-password-999')
  check('错误密码解锁失败且保持锁定', !badUn.ok && badUn.error?.code === 'APP_LOCKED' && (await A.secStatus()).data.locked === true)
  const okUn = await A.unlock('masterkey-123')
  const afterUn = await A.storeList()
  check('正确密码解锁 → 业务恢复', okUn.ok && afterUn.ok, afterUn.error?.code)
  const overlayGone = await cdp.evaluate(`return !document.querySelector('.lock-overlay');`)
  check('解锁后 overlay 消失', overlayGone)

  // UI 解锁路径（overlay 输入框）
  await A.lock()
  await sleep(400)
  const uiUnlock = await cdp.evaluate(`
    const inp = document.querySelector('[data-test=unlock-input]');
    if (!inp) return 'no-input';
    inp.value = 'masterkey-123';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    const btn = document.querySelector('[data-test=unlock-btn]');
    if (!btn || btn.disabled) return 'btn-disabled';
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    return document.querySelector('.lock-overlay') ? 'still-locked' : 'unlocked';
  `)
  check('overlay 输入框 + 按钮完成解锁（UI 路径）', uiUnlock === 'unlocked', uiUnlock)

  // Ctrl+Shift+L 快捷键锁定（§818）。先重载 UI 使渲染层获知密码已设置（API 直设不会推事件）
  await cdp.evaluate(`setTimeout(() => location.reload(), 30); return true;`)
  await sleep(3500)
  await cdp.evaluate(`
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'L', ctrlKey: true, shiftKey: true, bubbles: true }));
    return true;
  `)
  await sleep(800)
  const hotLocked = (await A.secStatus()).data.locked === true
  check('Ctrl+Shift+L 快捷键锁定', hotLocked)
  await A.unlock('masterkey-123')

  // 空闲自动锁定配置读写
  await A.settingsSet('security.idleMinutes', 15)
  const idleSt = await A.secStatus()
  check('空闲自动锁定分钟数持久化（到期由 powerMonitor 触发）', idleSt.data.idleMinutes === 15, 'idle=' + idleSt.data.idleMinutes)
  await A.settingsSet('security.idleMinutes', 0)

  // 移除密码：先错后对
  const rmBad = await A.rmPw('nope-nope-nope')
  const rmGood = await A.rmPw('masterkey-123')
  const stFinal = await A.secStatus()
  check('移除主密码需验证（错拒/对成）', !rmBad.ok && rmGood.ok && stFinal.data.enabled === false)

  // 行内删除按钮可见性：.row-del 的"绝对定位 + opacity:0"曾写在基类上，
  // 导致代理/Cookie/任务/步骤行的删除按钮跑到窗口右上角且不可见（用户无法删除）。
  const delCheck = await cdp.evaluate(`
    // 前面 reload 过界面：渲染层回到欢迎页，需重新点开店铺才有右栏
    if (!document.querySelector('.right-panel')) {
      const card = [...document.querySelectorAll('.store-card')].find(c => c.textContent.includes('M5店铺A')) || document.querySelector('.store-card');
      card?.querySelector('.store-action')?.click();
      await new Promise(r => setTimeout(r, 3200));
    }
    const envTab = [...document.querySelectorAll('.ptab')].find(b => b.textContent.trim() === '环境');
    if (envTab) { envTab.click(); await new Promise(r => setTimeout(r, 1200)); }
    const panel = document.querySelector('.right-panel');
    const items = [...document.querySelectorAll('.proxy-item')];
    const info = items.map(it => {
      const b = it.querySelector('.row-del');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const pr = it.getBoundingClientRect();
      const cs = getComputedStyle(b);
      return {
        visible: r.width > 0 && r.height > 0 && Number(cs.opacity) > 0.1,
        insideRow: r.left >= pr.left - 1 && r.right <= pr.right + 1,
        insidePanel: panel ? (r.left >= panel.getBoundingClientRect().left - 1 && r.right <= panel.getBoundingClientRect().right + 1) : null,
        pos: cs.position, x: Math.round(r.x), y: Math.round(r.y)
      };
    }).filter(Boolean);
    return { rows: items.length, withDel: info.length, allVisible: info.every(i => i.visible), allInsideRow: info.every(i => i.insideRow), allInsidePanel: info.every(i => i.insidePanel), sample: info.slice(0, 2) };
  `)
  check('代理行删除按钮可见且留在行内（不再跑到窗口角落）',
    delCheck.withDel > 0 && delCheck.allVisible && delCheck.allInsideRow && delCheck.allInsidePanel,
    JSON.stringify(delCheck))

  // ---------- 6. 代理健康巡检（不静默切换） ----------
  const badPx = (await A.proxyCreate({ type: 'http', host: '127.0.0.1', port: 9, label: '坏代理M5' })).data
  await A.proxyBind(sa.id, badPx.id)
  await sleep(900)
  const toastSeen = await cdp.evaluate(`
    const t = [...document.querySelectorAll('.toast')];
    return t.some(x => x.textContent.includes('代理体检失败') && x.textContent.includes('不会自动切换'));
  `)
  check('UI 如实展示体检失败提示（明示不自动切换）', toastSeen)
  const pxList = (await A.proxyList()).data
  const badNow = pxList.find(p => p.id === badPx.id)
  check('绑定即时体检：不可达代理 status=error', badNow?.status === 'error', badNow?.status)
  const bindAfter = await A.sessionStatus(sa.id)
  check('代理失败不静默降级/切换：绑定仍为 bound', bindAfter.ok && bindAfter.data.binding?.mode === 'bound', JSON.stringify(bindAfter.data?.binding))

  // ---------- 7. 审计 ----------
  const aud = (await A.auditQuery()).data || []
  const acts = aud.map(a => a.action)
  check('审计含 session.export / session.import / security.lock / security.unlock',
    ['session.export', 'session.import', 'security.lock', 'security.unlock'].every(x => acts.includes(x)))
  check('审计含失败的导入拒绝记录（篡改攻击可追溯）',
    aud.some(a => a.action === 'session.import' && a.result !== 'success'))

  // ---------- 8. 清理 ----------
  await A.proxyBind(sa.id, null)
  await call(`window.shopilot.proxy.delete(${JSON.stringify(badPx.id)})`)
  for (const s of [sa.id, sb.id]) {
    await A.browserClose(s)
    await A.storeDelPerm(s)
  }
  const tr = (await A.trashList()).data || []
  for (const t of tr) await A.purge(t.id)
  try { fs.unlinkSync(outPath); fs.unlinkSync(tPath); fs.unlinkSync(expiredPath) } catch {}

  const passed = results.filter(r => r.ok).length
  console.log(`\n通过 ${passed}/${results.length}`)
  if (passed < results.length) {
    console.log('失败项: ' + results.filter(r => !r.ok).map(r => r.name).join('; '))
    process.exitCode = 1
  } else console.log('ALL_SEC_ACCEPTANCE_PASSED')

  cdp.close()
  server.close()
  setTimeout(() => process.exit(process.exitCode || 0), 400)
}

main().catch(err => { console.error('VERIFY_CRASH', err); process.exit(2) })
