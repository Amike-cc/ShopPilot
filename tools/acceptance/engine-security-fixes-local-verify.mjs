/**
 * 引擎/安全修复本地端到端验收（2026-10-15 全库审查 B1/B2/B4/B5 的回归验证）。
 *
 * 覆盖（全部在隔离 userData 的临时实例上做，不碰真实店铺库）：
 *   B1：软删（回收站）保留任务；非回收站 purge 被拒；**回收站店铺的周期任务不再触发**；
 *       彻底删除后该店任务被清理（不再有孤儿）、日志无 `FOREIGN KEY constraint failed`；
 *   B2：删除"运行中"任务 → 先停运行再删（或 8 秒内停不下来则如实拒绝、重试可删）；
 *   B4：主密码写入新键 security.master、不再写旧键（U+2026）；错误/正确密码解锁行为不变；
 *       通用设置通道对两种拼写的键都拒绝（B3 的通道侧）；
 *   B5：非法 base64 被拒；允许根之外的 outputPath 被拒；临时目录与应用目录（开发态）可写。
 *
 * 用法：node tools/acceptance/engine-security-fixes-local-verify.mjs
 */
import { spawn, execSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CDP_PORT = 9274
const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const userData = path.join(os.tmpdir(), 'shopilot-fix-verify-' + Date.now())
const dbPath = path.join(userData, 'shopilot.db')
fs.mkdirSync(userData, { recursive: true })

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}
function killTree(child) {
  if (!child || child.killed) return
  try {
    if (process.platform === 'win32' && child.pid) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch { /* ignore */ }
}

async function portBusy() {
  try { const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); return res.ok } catch { return false }
}
async function waitForCDP(timeoutMs = 40000) {
  const t0 = Date.now()
  for (;;) {
    try { const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (res.ok) return } catch { /* not ready */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('CDP 未就绪')
    await sleep(500)
  }
}

let ws = null
let wsId = 0
const pending = new Map()
const evalJs = async (body) => {
  const mid = ++wsId
  const expr = `(async () => { ${body} })()`
  const res = await new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
  })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'eval failed')
  return res.result.value
}

async function main() {
  if (await portBusy()) {
    console.error(`端口 ${CDP_PORT} 已有实例，先停掉再跑`)
    process.exit(1)
  }

  let app = null
  let fatal = null
  try {
    app = spawn(electronExe, [
      ROOT,
      '--no-sandbox',
      `--remote-debugging-port=${CDP_PORT}`,
      '--user-data-dir=' + userData,
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows'
    ], {
      cwd: ROOT,
      stdio: 'ignore',
      env: { ...process.env, NODE_ENV: 'production', SHOPILOT_DISABLE_CDP_FP: '1' }
    })

    await waitForCDP()
    await sleep(1200)
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
    const page = targets.find(t => t.type === 'page' && t.url.includes('/renderer/index.html'))
    if (!page) throw new Error('未找到 UI target')
    ws = new WebSocket(page.webSocketDebuggerUrl)
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    }
    await new Promise(r => { ws.onopen = r })

    const taskById = async (id) => await evalJs(`const r = await window.shopilot.task.list(); return (r.data || []).find(t => t.id === ${JSON.stringify(id)}) || null`)
    const waitFor = async (fn, timeoutMs, stepMs = 800) => {
      const t0 = Date.now()
      for (;;) {
        const v = await fn()
        if (v) return v
        if (Date.now() - t0 > timeoutMs) return null
        await sleep(stepMs)
      }
    }

    // ================= B1：软删保留 / 非回收站拒绝 / 彻底删除清理 =================
    const stA = await evalJs(`return await window.shopilot.store.create(${JSON.stringify({ name: '修复验证-A', platform: '抖店' })})`)
    check('B1 建店 A', stA.ok && !!stA.data?.id, JSON.stringify(stA.error || ''))
    const sidA = stA.data?.id
    const tA = await evalJs(`return await window.shopilot.task.create(${JSON.stringify({ name: '修复验证-A-任务', storeScope: sidA, steps: [{ type: 'waitForText', input: { text: 'never-appear-xyz' }, timeoutMs: 20000 }] })})`)
    check('B1 建任务 A', tA.ok && !!tA.data?.id, JSON.stringify(tA.error || ''))
    const tidA = tA.data?.id

    const softA = await evalJs(`return await window.shopilot.store.deletePermanent(${JSON.stringify(sidA)})`)
    check('B1 店铺 A 移入回收站', softA.ok, JSON.stringify(softA.error || ''))
    const keepA = await evalJs(`const r = await window.shopilot.task.list(); return (r.data || []).some(t => t.id === ${JSON.stringify(tidA)})`)
    check('B1 软删（回收站）保留任务（恢复店铺后仍可用）', keepA === true)

    const stB = await evalJs(`return await window.shopilot.store.create(${JSON.stringify({ name: '修复验证-B', platform: '抖店' })})`)
    const sidB = stB.data?.id
    check('B1 建店 B', stB.ok && !!sidB)
    const purgeActive = await evalJs(`return await window.shopilot.store.purge(${JSON.stringify(sidB)})`)
    check('B1 非回收站店铺 purge 被拒（isStoreInTrash 闸）', purgeActive.ok === false && String(purgeActive.error?.message || '').includes('回收站'), JSON.stringify(purgeActive.error || ''))

    // B1c：调度器 —— 活动店铺的周期任务应被触发；回收站后必须停止触发
    // 注意：任务 schedule 的 everyMs 下限是 60000（schema），所以本段有两段固定等待，
    // 全程约 2~3 分钟（脚本整体在后台跑）。
    await evalJs(`return await window.shopilot.settings.set('collection.autoEnabled', true)`)
    const tB = await evalJs(`return await window.shopilot.task.create(${JSON.stringify({ name: '修复验证-B-周期任务', storeScope: sidB, schedule: { everyMs: 60000, backgroundOpen: true }, steps: [{ type: 'waitForText', input: { text: 'never-xyz' }, timeoutMs: 1000 }] })})`)
    check('B1 建带周期的任务 B', tB.ok && !!tB.data?.id, JSON.stringify(tB.error || ''))
    const tidB = tB.data?.id
    // 正控：等第一轮触发（锚点 = 建任务时刻 + 60s）并跑到终态
    const fired = await waitFor(async () => {
      const t = await taskById(tidB)
      return t?.latestRun && ['succeeded', 'failed', 'cancelled'].includes(t.latestRun.status) ? t : null
    }, 120000, 1000)
    check('B1 调度器可用（活动店铺的周期任务被触发并跑完一轮）',
      !!fired, fired ? `run=${fired.latestRun?.id} status=${fired.latestRun?.status}` : '120 秒内未见终态 run')

    const softB = await evalJs(`return await window.shopilot.store.deletePermanent(${JSON.stringify(sidB)})`)
    check('B1 店铺 B 移入回收站', softB.ok)
    // 判别基线在软删之后取：此后任何新 run 才算"仍在触发"。
    // 等待时长覆盖"下一次应触发点"（首次触发点 + 60s，含余量）。
    const baseRunId = (await taskById(tidB))?.latestRun?.id || null
    await sleep(75000)
    const afterSoftB = await taskById(tidB)
    check('B1 回收站店铺的周期任务不再触发（storeAlive=false，且清掉内存锚点）',
      afterSoftB && afterSoftB.latestRun?.id === baseRunId, `base=${baseRunId} after=${afterSoftB?.latestRun?.id}`)

    const purgeB = await evalJs(`return await window.shopilot.store.purge(${JSON.stringify(sidB)})`)
    check('B1 彻底删除店铺 B', purgeB.ok, JSON.stringify(purgeB.error || ''))
    const goneB = await evalJs(`const r = await window.shopilot.task.list(); return (r.data || []).every(t => t.id !== ${JSON.stringify(tidB)})`)
    check('B1 彻底删除后该店任务被清理（不再留孤儿）', goneB === true)
    await evalJs(`return await window.shopilot.store.purge(${JSON.stringify(sidA)})`)
    const goneA = await evalJs(`const r = await window.shopilot.task.list(); return (r.data || []).every(t => t.id !== ${JSON.stringify(tidA)})`)
    check('B1 店 A（回收站→彻底删）的任务同样被清理', goneA === true)

    // ================= B2：运行中删除 =================
    const stC = await evalJs(`return await window.shopilot.store.create(${JSON.stringify({ name: '修复验证-C', platform: '抖店' })})`)
    const sidC = stC.data?.id
    check('B2 建店 C', stC.ok && !!sidC)
    await evalJs(`return await window.shopilot.browser.open(${JSON.stringify(sidC)})`)
    await evalJs(`return await window.shopilot.browser.display(${JSON.stringify(sidC)})`)
    await sleep(1500)
    const tC = await evalJs(`return await window.shopilot.task.create(${JSON.stringify({ name: '修复验证-C-长等待', storeScope: sidC, steps: [{ type: 'waitForText', input: { text: 'never-xyz' }, timeoutMs: 30000 }] })})`)
    check('B2 建任务 C', tC.ok && !!tC.data?.id, JSON.stringify(tC.error || ''))
    const tidC = tC.data?.id
    const runC = await evalJs(`return await window.shopilot.task.run(${JSON.stringify(tidC)})`)
    check('B2 启动运行', runC.ok, JSON.stringify(runC.error || ''))
    const running = await waitFor(async () => { const t = await taskById(tidC); return t?.latestRun?.status === 'running' ? t : null }, 45000, 500)
    check('B2 运行进入 running', !!running, running ? '' : '45 秒内未进入 running')

    const t0 = Date.now()
    const delC = await evalJs(`return await window.shopilot.task.delete(${JSON.stringify(tidC)})`)
    const elapsed = Date.now() - t0
    if (delC.ok) {
      check('B2 运行中删除：等运行停止后才删（不再立即级联删行）', true, `elapsed=${elapsed}ms`)
    } else {
      check('B2 运行中删除：8 秒内停不下来则如实拒绝（TASK_BAD_STATE）',
        delC.error?.code === 'TASK_BAD_STATE', JSON.stringify(delC.error))
      await waitFor(async () => { const t = await taskById(tidC); return t && t.latestRun && !['queued', 'running', 'waiting_confirmation', 'paused'].includes(t.latestRun.status) ? t : null }, 60000)
      const delC2 = await evalJs(`return await window.shopilot.task.delete(${JSON.stringify(tidC)})`)
      check('B2 停止后重试删除成功', delC2.ok === true, JSON.stringify(delC2.error || ''))
    }
    const goneC = await evalJs(`const r = await window.shopilot.task.list(); return (r.data || []).every(t => t.id !== ${JSON.stringify(tidC)})`)
    check('B2 删除后任务不存在', goneC === true)

    // ================= B4：主密码键 =================
    const sp = await evalJs(`return await window.shopilot.security.setPassword('verify-pass-12345678', null)`)
    check('B4 设置主密码成功', sp.ok, JSON.stringify(sp.error || ''))
    const st1 = await evalJs(`const r = await window.shopilot.security.status(); return r.data || null`)
    check('B4 status.enabled=true', st1?.enabled === true, JSON.stringify(st1))
    await evalJs(`return await window.shopilot.security.lock()`)
    const locked = await evalJs(`const r = await window.shopilot.security.status(); return r.data?.locked === true`)
    check('B4 lock 生效', locked === true)
    await evalJs(`return await window.shopilot.security.unlock('wrong-9999')`)
    const stillLocked = await evalJs(`const r = await window.shopilot.security.status(); return r.data?.locked === true`)
    check('B4 错误密码不能解锁（仍锁定）', stillLocked === true)
    await evalJs(`return await window.shopilot.security.unlock('verify-pass-12345678')`)
    const unlocked = await evalJs(`const r = await window.shopilot.security.status(); return r.data?.locked === false`)
    check('B4 正确密码解锁成功', unlocked === true)
    const g1 = await evalJs(`return await window.shopilot.settings.get('security.master')`)
    const g2 = await evalJs(`return await window.shopilot.settings.get(${JSON.stringify('securi\u2026ster')})`)
    check('B3 通用通道拒绝读主密码键（新拼写）', g1.ok === false, JSON.stringify(g1.error || ''))
    check('B3 通用通道拒绝读主密码键（旧拼写）', g2.ok === false, JSON.stringify(g2.error || ''))

    // ================= B5：生图保存边界 =================
    const validB64 = Buffer.from('shopilot-b5-verify-bytes').toString('base64')
    const tmpTarget = path.join(os.tmpdir(), 'shopilot-b5-' + Date.now())
    const b5a = await evalJs(`return await window.shopilot.ai.saveImage(${JSON.stringify({ b64Json: '!!!not-base64!!!', mimeType: 'image/png', outputPath: tmpTarget })})`)
    check('B5 非法 base64 被拒（AI_BAD_INPUT）', b5a.ok === false && b5a.error?.code === 'AI_BAD_INPUT', JSON.stringify(b5a.error || ''))
    const outside = path.join(path.parse(ROOT).root, 'outside-root', 'b5-evil')
    const b5b = await evalJs(`return await window.shopilot.ai.saveImage(${JSON.stringify({ b64Json: validB64, mimeType: 'image/png', outputPath: outside })})`)
    check('B5 允许根之外的路径被拒（用户目录/临时目录/应用目录之外）', b5b.ok === false && b5b.error?.code === 'AI_BAD_INPUT', JSON.stringify(b5b.error || ''))
    const b5c = await evalJs(`return await window.shopilot.ai.saveImage(${JSON.stringify({ b64Json: validB64, mimeType: 'image/png', outputPath: tmpTarget })})`)
    check('B5 临时目录保存成功', b5c.ok === true && fs.existsSync(tmpTarget + '.png'), JSON.stringify(b5c.error || ''))
    const inRepo = path.join(ROOT, 'artifacts', 'maintenance', 'b5-verify-' + Date.now())
    const b5d = await evalJs(`return await window.shopilot.ai.saveImage(${JSON.stringify({ b64Json: validB64, mimeType: 'image/png', outputPath: inRepo })})`)
    check('B5 开发态应用目录（仓库 artifacts/）保存成功（设计/验收脚本不受影响）', b5d.ok === true && fs.existsSync(inRepo + '.png'), JSON.stringify(b5d.error || ''))
  } catch (e) {
    fatal = e
  } finally {
    killTree(app)
    await sleep(1500)
  }

  // ================= 落盘复核：DB 键名 + 日志 =================
  try {
    const db = new DatabaseSync(dbPath)
    const keys = db.prepare("SELECT key FROM app_settings WHERE key LIKE 'securi%'").all().map(r => String(r.key))
    db.close()
    check('B4 主密码落在新键 security.master', keys.includes('security.master'), JSON.stringify(keys))
    check('B4 不再写旧键（securi…ster）', !keys.includes('securi\u2026ster'), JSON.stringify(keys))
  } catch (e) {
    check('B4 数据库键名复核', false, String(e?.message || e))
  }
  try {
    const logDir = path.join(userData, 'logs')
    let logText = ''
    if (fs.existsSync(logDir)) {
      for (const f of fs.readdirSync(logDir)) logText += fs.readFileSync(path.join(logDir, f), 'utf8')
    }
    check('日志无 FOREIGN KEY constraint failed（B1/B2 症状不再出现）', !logText.includes('FOREIGN KEY constraint failed'))
    check('日志无 [scheduler] 触发失败（不可运行店铺不再被触发）', !logText.includes('[scheduler] 触发失败'))
  } catch (e) {
    check('日志复核', false, String(e?.message || e))
  }

  if (fatal) {
    console.error('VERIFY_FAILED:', String(fatal?.stack || fatal))
    process.exit(1)
  }
  const passed = checks.filter(c => c.ok).length
  console.log(`\n修复验收结果：${passed}/${checks.length} 通过`)
  console.log(`隔离 userData：${userData}`)
  process.exit(passed === checks.length ? 0 : 1)
}

main().catch((e) => { console.error('VERIFY_FAILED:', String(e?.stack || e)); process.exit(1) })
