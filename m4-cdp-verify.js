/**
 * M4 验收（在打包产物内运行，CDP 驱动）
 * M4_PHASE=packaged  解包版：核心功能 + 主进程对话真实交互（确认+口令）+ 诊断包/审计导出 + 日志
 * M4_PHASE=installed 安装版：安装后可运行冒烟
 * M4_PHASE=upgraded  升级后：数据保留（同名店铺仍在）
 */
const http = require('http')
const fs = require('fs')
const path = require('path')

const CDP_PORT = process.env.M4_CDP_PORT || '9227'
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`
const PHASE = process.env.M4_PHASE || 'packaged'
const USERDATA = process.env.M4_USERDATA || ''

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

class CDPSession {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.closed = false
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = () => resolve(); this.ws.onerror = reject })
    // 目标窗口可能因为"点确定后立即关闭"而消失：此时 CDP 响应不会再来，
    // 必须显式拒绝挂起的调用，否则脚本会永久等待（曾导致 M4 卡死）。
    this.ws.onclose = () => {
      this.closed = true
      for (const { reject } of this.pending.values()) reject(new Error('TARGET_CLOSED'))
      this.pending.clear()
    }
    this.ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result)
      }
    }
  }
  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('TARGET_CLOSED')); return }
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP_TIMEOUT: ' + method)) }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) }
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(fnBody) {
    await this.ready
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${fnBody} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  close() { try { this.ws.close() } catch {} }
}

async function targets() { return (await fetch(CDP_BASE + '/json')).json() }
async function uiSession() {
  const t = await targets()
  const page = t.find(x => x.type === 'page' && (x.url.includes('index.html') || x.url.startsWith('file:')))
  if (!page) throw new Error('未找到主界面 target')
  return new CDPSession(page.webSocketDebuggerUrl)
}
async function waitTarget(substr, timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const t = await targets()
    const hit = t.find(x => x.type === 'page' && x.url.includes(substr))
    if (hit) return hit
    await sleep(250)
  }
  return null
}

async function waitTargetGone(substr, timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const t = await targets()
    if (!t.some(x => x.type === 'page' && x.url.includes(substr))) return true
    await sleep(200)
  }
  return false
}

/**
 * 对话框窗口就绪判定：等 readyState=complete（保证页面尾部脚本已挂事件）
 * 且 contextBridge 桥（__pwDone）已注入；未就绪即显式失败，不静默继续。
 */
/**
 * 等待对话框文档真正就绪：新建窗口会先存在一个空白文档（readyState=complete、preload 已注入，
 * 但没有 #title），随后才导航到 index.html，而导航会销毁执行上下文。
 * 因此这里必须等到 #title 出现；失败则重新取目标重连重试。
 */
async function attachReady(target, tries = 3) {
  for (let i = 0; i < tries; i++) {
    let cur = target
    if (i > 0) {
      const t = await waitTarget('pw-dialog', 5000)
      if (!t) throw new Error('对话框窗口已消失（第 ' + (i + 1) + ' 次尝试）')
      cur = t
      await sleep(200)
    }
    const d = new CDPSession(cur.webSocketDebuggerUrl)
    try {
      const state = await d.evaluate(`
        const t0 = Date.now();
        while ((document.readyState !== 'complete' || typeof window.__pwDone !== 'function' || !document.getElementById('title')) && Date.now() - t0 < 8000) {
          await new Promise(r => setTimeout(r, 50));
        }
        return {
          href: location.href.slice(-40),
          readyState: document.readyState,
          bridge: typeof window.__pwDone,
          hasTitle: !!document.getElementById('title'),
          title: document.getElementById('title') ? document.getElementById('title').textContent : null,
          bodyLen: document.body ? document.body.innerHTML.length : -1
        };
      `)
      if (state?.readyState === 'complete' && state?.bridge === 'function' && state?.hasTitle) return d
      d.close()
      lastDialogState = state
    } catch (e) {
      d.close()
      lastDialogState = { error: e.message }
      if (!/Execution context was destroyed|TARGET_CLOSED|Cannot find context|CDP_TIMEOUT/.test(e.message)) throw e
    }
    await sleep(400)
  }
  throw new Error('对话框未就绪（重试 ' + tries + ' 次）：' + JSON.stringify(lastDialogState))
}
let lastDialogState = null

function startSite() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/setcookie')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': ['M4SESSION=' + 'T'.repeat(40) + '; Path=/; Max-Age=86400', 'M4HTTP=marker-token; Path=/; HttpOnly']
      })
      res.end('<!doctype html><html><head><title>M4种Cookie</title></head><body><h1 id="t">M4</h1></body></html>')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>M4页</title></head><body><h1 id="t2">ok</h1></body></html>')
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

async function main() {
  // 看门狗：任何一步挂住都必须以明确失败收场，绝不允许静默卡死（曾因 CDP 无超时挂住整轮验收）
  const watchdog = setTimeout(() => {
    console.error('M4_VERIFY_TIMEOUT: 验收脚本超时未结束（某一步被挂起），按失败处理')
    process.exit(3)
  }, 8 * 60 * 1000)
  const results = []
  const check = (name, ok, extra = '') => {
    results.push({ name, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
  }

  const { server, port: SITE_PORT } = await startSite()
  const BASE = `http://127.0.0.1:${SITE_PORT}`
  const cdp = await uiSession()
  await cdp.evaluate(`const d=Date.now()+20000; while(!window.shopilot && Date.now()<d) await new Promise(r=>setTimeout(r,100)); return !!window.shopilot;`)
  const call = (expr) => cdp.evaluate(`return await (${expr});`)

  const storeName = process.env.M4_STORE_NAME || `M4店铺_${PHASE}_${Date.now()}`
  const created = await call(`window.shopilot.store.create(${JSON.stringify({ name: storeName, platform: '抖店', adminUrl: BASE + '/setcookie' })})`)
  check(`[${PHASE}] 打包态可建店（better-sqlite3 原生模块加载正常）`, created.ok, created.error?.message)
  const sid = created.data?.id
  const list1 = await call('window.shopilot.store.list()')
  check(`[${PHASE}] 店铺列表可读`, list1.ok && (list1.data || []).some(s => s.name === storeName))

  if (PHASE === 'upgraded') {
    const prev = process.env.M4_PREV_STORE
    const kept = (list1.data || []).some(s => s.name === prev)
    check('升级安装后既有店铺数据保留（迁移未丢数据）', kept, 'prev=' + prev + ' / now=' + (list1.data || []).map(s => s.name).join(','))
    const schemaOk = await call(`window.shopilot.audit.query({ limit: 1 })`)
    check('升级后审计表可读（schema 迁移至当前版本）', schemaOk.ok)
    // 清理
    await call(`window.shopilot.store.deletePermanent(${JSON.stringify(sid)})`)
    const tr1 = await call('window.shopilot.store.trashList()')
    for (const t of (tr1.data || [])) await call(`window.shopilot.store.purge(${JSON.stringify(t.id)})`)
    cdp.close(); server.close()
    return finish(results)
  }

  // 打开浏览器 + 种 Cookie（分区 + 会话）
  await call(`window.shopilot.browser.open(${JSON.stringify(sid)})`)
  await call(`window.shopilot.browser.tab.create(${JSON.stringify(sid)}, ${JSON.stringify(BASE + '/setcookie')})`)
  await sleep(1800)
  const ck = await call(`window.shopilot.session.cookies(${JSON.stringify(sid)})`)
  check(`[${PHASE}] 会话/Cookie 可读（分区持久化正常）`, ck.ok && (ck.data?.items || []).length >= 2, 'total=' + ck.data?.total)

  if (PHASE === 'installed') {
    // 安装版只做冒烟 + 留一个店铺给升级阶段核对
    console.log('M4_STORE_FOR_UPGRADE=' + storeName)
    cdp.close(); server.close()
    return finish(results)
  }

  // ---------- 打包态：主进程对话真实交互（确认框 + 口令框，均不经过 Renderer/IPC） ----------
  const outPath = path.join(process.env.TEMP || '/tmp', `m4-session-${Date.now()}.shopilot`)
  await cdp.evaluate(`window.__m4exp = window.shopilot.session.export(${JSON.stringify(sid)}, ${JSON.stringify(outPath)}); return true;`)

  const confirmT = await waitTarget('pw-dialog')
  check('导出弹出主进程托管确认框（独立窗口）', !!confirmT, confirmT ? confirmT.url.split('?')[1]?.slice(0, 60) : '未出现')
  let confirmTitle = ''
  if (confirmT) {
    const d = await attachReady(confirmT)
    confirmTitle = await d.evaluate(`return document.getElementById('title').textContent`)
    // 点"确定"会立刻关闭该窗口：CDP 响应可能来不及回来（TARGET_CLOSED），
    // 这本身正是点击生效的表现，以"窗口是否消失"为准。
    await d.evaluate(`document.getElementById('ok').click(); return true;`).catch((e) => { if (!/TARGET_CLOSED|CDP_TIMEOUT/.test(e.message)) throw e })
    d.close()
    let gone = await waitTargetGone('mode=confirm', 8000)
    if (!gone) {
      // 窗口还在说明点击没生效：补一次点击（并如实记录）
      const d2 = new CDPSession(confirmT.webSocketDebuggerUrl)
      await d2.evaluate(`document.getElementById('ok').click(); return true;`).catch(() => {})
      d2.close()
      gone = await waitTargetGone('mode=confirm', 5000)
      check('确认框首次点击即生效（无需补点）', false, gone ? '补点后才关闭' : '补点也未关闭')
    }
  }
  check('确认框标题如实描述危险操作', /导出|确认/.test(confirmTitle), confirmTitle)

  const pwT = await waitTarget('mode=password')
  check('确认后弹出独立口令采集窗（不经过 Renderer）', !!pwT, pwT ? pwT.url.split('?')[1]?.slice(0, 40) : '未出现')
  if (pwT) {
    const d = await attachReady(pwT)
    const hasConfirm2 = await d.evaluate(`return getComputedStyle(document.getElementById('pw2')).display !== 'none'`)
    check('导出沿用二次输入确认（防止口令手误）', hasConfirm2)
    const tooShort = await d.evaluate(`
      document.getElementById('pw1').value = 'short';
      document.getElementById('ok').click();
      return document.getElementById('hint').textContent;
    `)
    check('口令强度校验拦截（<8 位不提交）', /至少 8 位/.test(tooShort), tooShort)
    await d.evaluate(`
      document.getElementById('pw1').value = 'm4-pass-12345';
      document.getElementById('pw2').value = 'm4-pass-12345';
      document.getElementById('ok').click();
      return true;
    `).catch((e) => { if (!/TARGET_CLOSED|CDP_TIMEOUT/.test(e.message)) throw e })
    d.close()
  }
  const exlRes = await call('await window.__m4exp')
  const pkg = exlRes.ok && fs.existsSync(outPath) ? fs.readFileSync(outPath) : null
  check('真实对话链路完成加密导出（落盘带魔数）', !!pkg && pkg.subarray(0, 4).toString('ascii') === 'SHSP', exlRes.error?.message || (pkg ? pkg.length + 'B' : 'NO_FILE'))
  check('导出包不含 Cookie 明文', !!pkg && !pkg.includes(Buffer.from('marker-token')))

  // 取消路径（真实点击取消）
  const out2 = outPath + '.cancel'
  await cdp.evaluate(`window.__m4exp2 = window.shopilot.session.export(${JSON.stringify(sid)}, ${JSON.stringify(out2)}); return true;`)
  const cT = await waitTarget('pw-dialog')
  let clickCancel = 'not-found'
  if (cT) {
    try {
      const d = await attachReady(cT)
      await d.evaluate(`document.getElementById('cancel').click(); return true;`).catch((e) => { if (!/TARGET_CLOSED|CDP_TIMEOUT/.test(e.message)) throw e })
      d.close()
      clickCancel = 'clicked'
      await waitTargetGone('mode=confirm', 5000)
    } catch (e) { clickCancel = 'attach-failed: ' + String(e.message).slice(0, 60) }
  }
  const cancelRes = await call('await window.__m4exp2')
  check('取消对话 → 导出中止且给出 SESSION_CANCELLED', !cancelRes.ok && cancelRes.error?.code === 'SESSION_CANCELLED', `${cancelRes.error?.code} / ${clickCancel}`)
  check('取消后不产生包文件', !fs.existsSync(out2))

  // ---------- 诊断包 / 审计导出（§6.7 / §22） ----------
  const diagPath = path.join(process.env.TEMP || '/tmp', `m4-diag-${Date.now()}.zip`)
  const diag = await call(`window.shopilot.diagnostics.export(${JSON.stringify(diagPath)})`)
  let zipEntries = []
  let diagBuf = null
  if (diag.ok && fs.existsSync(diagPath)) {
    diagBuf = fs.readFileSync(diagPath)
    let i = 0
    while (i + 4 <= diagBuf.length && diagBuf.readUInt32LE(i) === 0x04034b50) {
      const nameLen = diagBuf.readUInt16LE(i + 26), extraLen = diagBuf.readUInt16LE(i + 28), size = diagBuf.readUInt32LE(i + 18)
      zipEntries.push(diagBuf.subarray(i + 30, i + 30 + nameLen).toString('utf8'))
      i += 30 + nameLen + extraLen + size
    }
  }
  check('诊断包可导出且为合法 ZIP', diag.ok && zipEntries.length === 7, diag.error?.message || zipEntries.join(','))
  check('诊断包含版本/系统/迁移/代理/设置/审计/日志七件',
    ['version.json', 'system.json', 'database.json', 'proxies.json', 'settings.json', 'audit-recent.jsonl', 'app.log'].every(n => zipEntries.includes(n)))
  const versions = (() => { try { return JSON.parse(diagBuf.subarray(diagBuf.indexOf(Buffer.from('version.json')) + 30).toString('utf8')) } catch { return null } })()
  void versions

  // 红线：诊断包不得含会话明文/密码
  const leak = diagBuf ? ['marker-token', 'm4-pass-12345', 'M4HTTP='].filter(s => diagBuf.includes(Buffer.from(s))) : ['NO_BUF']
  check('诊断包脱敏：不含会话 Cookie 值与口令', leak.length === 0, leak.join(','))

  const auditPath = path.join(process.env.TEMP || '/tmp', `m4-audit-${Date.now()}.jsonl`)
  const aud = await call(`window.shopilot.audit.export({ limit: 1000 }, ${JSON.stringify(auditPath)})`)
  const audRows = aud.ok && fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean) : []
  check('审计日志可导出（JSONL 非空）', aud.ok && audRows.length > 0, 'rows=' + audRows.length)
  check('审计含 diagnostics.export 记录', audRows.some(l => l.includes('diagnostics.export')))

  // 崩溃/运行日志落盘（§22 按天保留 14 天）
  if (USERDATA) {
    const logsDir = path.join(USERDATA, 'logs')
    const logFiles = fs.existsSync(logsDir) ? fs.readdirSync(logsDir).filter(f => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(f)) : []
    const logTxt = logFiles.length ? fs.readFileSync(path.join(logsDir, logFiles.sort().reverse()[0]), 'utf8') : ''
    check('运行日志按天落盘 userData/logs/app-YYYY-MM-DD.log 且含启动记录', logTxt.includes('启动 version='), logFiles.join(',') || 'NO_LOG')
    check('日志无明文口令（脱敏生效）', !logTxt.includes('m4-pass-12345'))
  }

  // 清理
  await call(`window.shopilot.browser.close(${JSON.stringify(sid)})`)
  await call(`window.shopilot.store.deletePermanent(${JSON.stringify(sid)})`)
  const tr = await call('window.shopilot.store.trashList()')
  for (const t of (tr.data || [])) await call(`window.shopilot.store.purge(${JSON.stringify(t.id)})`)
  try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath) } catch {}
  try { if (fs.existsSync(diagPath)) fs.unlinkSync(diagPath) } catch {}
  try { if (fs.existsSync(auditPath)) fs.unlinkSync(auditPath) } catch {}

  cdp.close(); server.close()
  return finish(results)
}

function finish(results) {
  if (typeof watchdog !== 'undefined') clearTimeout(watchdog)
  const passed = results.filter(r => r.ok).length
  console.log(`\n通过 ${passed}/${results.length}`)
  if (passed < results.length) {
    console.log('失败项: ' + results.filter(r => !r.ok).map(r => r.name).join('; '))
    process.exitCode = 1
  } else console.log('M4_PHASE_PASSED')
  setTimeout(() => process.exit(process.exitCode || 0), 300)
}

main().catch(err => { console.error('VERIFY_CRASH', err); process.exit(2) })
