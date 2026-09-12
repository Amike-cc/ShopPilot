/**
 * M4 发布工程验收运行器
 *  1) 解包版（release/win-unpacked 的临时副本）跑 m4-cdp-verify.js --phase=packaged
 *  2) NSIS 静默安装到临时目录 → 安装版冒烟（installed）
 *  3) 二次安装（升级）→ 数据保留校验（upgraded）
 *  4) 静默卸载 → 安装目录清理、用户数据保留
 * 用法：node m4-runner.js [--skip-install]
 */
const { spawn, spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const root = __dirname
const RELEASE = path.join(root, 'release')
// 从 package.json 取版本，不要硬编码——本项目每发一版都会改 version，
// 写死文件名会让 m4 在每次版本变更后直接找不到安装包而崩溃（实测 0.1.0 → 0.1.1 即踩到）
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const SETUP = path.join(RELEASE, `ShopPilot-Setup-${VERSION}.exe`)
const UNPACKED = path.join(RELEASE, 'win-unpacked', 'ShopPilot.exe')
const SKIP_INSTALL = process.argv.includes('--skip-install')

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitForFile(p, timeoutMs, label) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(p)) return true
    await sleep(1000)
  }
  console.log(`[等待超时] ${label}: ${p}`)
  return false
}

async function waitForCDP(port, timeoutMs = 40000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return true } catch {}
    await sleep(500)
  }
  return false
}

function launchApp(exe, userData, port, extraEnv = {}) {
  const child = spawn(exe, ['--no-sandbox', `--remote-debugging-port=${port}`, '--user-data-dir=' + userData], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', ...extraEnv }
  })
  let log = ''
  child.stdout.on('data', d => { log += d.toString() })
  child.stderr.on('data', d => { log += d.toString() })
  return { child, getLog: () => log }
}

function runVerify(port, userData, phase, storeName, prevStore) {
  return new Promise(resolve => {
    const v = spawn(process.execPath, [path.join(root, 'm4-cdp-verify.js')], {
      stdio: 'inherit',
      env: {
        ...process.env,
        M4_CDP_PORT: String(port),
        M4_USERDATA: userData,
        M4_PHASE: phase,
        M4_STORE_NAME: storeName || '',
        M4_PREV_STORE: prevStore || ''
      }
    })
    v.on('exit', code => resolve(code === 0))
  })
}

async function stopApp(ctx) {
  try { ctx.child.kill('SIGTERM') } catch {}
  await sleep(1200)
  // 必须整树结束：残留的子进程持有 exe 文件锁，会让后续升级安装的旧卸载器只能登记
  // "挂起删除"，待进程退出后把新装的文件一并删掉（本套件实测到的真实坑）
  killStray('停止应用')
  await waitNoStray(20000)
}

/** 等待应用进程彻底消失（含子进程） */
async function waitNoStray(timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ShopPilot.exe'], { encoding: 'utf8' })
    if (!/ShopPilot\.exe/i.test(String(r.stdout || ''))) return true
    await sleep(500)
  }
  return false
}

/** 目录稳定判定：文件数 + 最新 mtime 连续 3 秒不变视为写入结束（NSIS 常把安装器拷到临时副本继续写） */
async function waitDirStable(dir, timeoutMs = 90000) {
  const t0 = Date.now()
  let sameCount = 0
  let last = ''
  while (Date.now() - t0 < timeoutMs) {
    let sig = 'missing'
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true })
      const newest = items.reduce((m, e) => Math.max(m, fs.statSync(path.join(dir, e.name)).mtimeMs), 0)
      sig = `${items.length}:${newest}`
    } catch {}
    if (sig === last) { sameCount++; if (sameCount >= 6) return true } else { sameCount = 0 }
    last = sig
    await sleep(500)
  }
  return false
}

/** 静默安装/卸载：NSIS 会自行派生，故轮询目标文件而不是等进程；
 *  包文件到位后还要等安装器退出 + 目录写入稳定——否则后续启动应用会与"清理旧版本"竞争，
 *  实测表现为旧卸载器登记挂起删除、进程退出后把新装文件一并删掉。 */
async function silentRun(exe, args, waitFor, timeoutMs, label) {
  console.log(`[${label}] ${path.basename(exe)} ${args.join(' ')}`)
  const exeName = path.basename(exe)
  const re = new RegExp(exeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  spawn(exe, args, { detached: true, stdio: 'ignore' }).unref()
  const ok = await waitForFile(waitFor, timeoutMs, label)
  if (!ok) return false
  const t0 = Date.now()
  while (Date.now() - t0 < 90000) {
    const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${exeName}`], { encoding: 'utf8' })
    if (!re.test(String(r.stdout || ''))) break
    await sleep(500)
  }
  await waitDirStable(path.dirname(waitFor))
  await sleep(1500)
  return true
}

/** 逐行解析注册表输出：跟踪当前键，收集该键下的 DisplayName/InstallLocation/UninstallString */
function regEntries() {
  const r = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s'], { encoding: 'utf8' })
  const lines = String(r.stdout || '').split(/\r?\n/)
  const out = []
  let cur = null
  for (const line of lines) {
    if (/^HKEY_/i.test(line.trim())) { cur = { key: line.trim(), values: {} }; out.push(cur); continue }
    const m = /^\s{2,}(\S+)\s+REG_\w+\s+(.*)$/.exec(line)
    if (m && cur) cur.values[m[1].toLowerCase()] = m[2].trim()
  }
  return out.filter(e => /shopilot/i.test(e.values.displayname || '') || /shopilot/i.test(e.key))
}

/** 安装前清理历史安装：避免静默安装按注册表走"升级"而写到旧目录 */
function cleanupDeadEntry() {
  for (const e of regEntries()) {
    const loc = (e.values.installlocation || '').replace(/^"|"$/g, '')
    const un = (e.values.uninstallstring || '').replace(/^"|"$/g, '')
    const exeThere = loc ? fs.existsSync(path.join(loc, 'ShopPilot.exe')) : false
    const unThere = un ? fs.existsSync(un) : false
    if (!exeThere && !unThere) {
      console.log('[清理] 删除死链卸载注册项: ' + e.key)
      spawnSync('reg', ['delete', e.key, '/f'], { encoding: 'utf8' })
    }
  }
}

async function uninstallExisting() {
  cleanupDeadEntry()
  const live = regEntries().find(e => {
    const un = (e.values.uninstallstring || '').replace(/^"|"$/g, '')
    return un && fs.existsSync(un)
  })
  if (!live) return null
  const uninstaller = live.values.uninstallstring.replace(/^"|"$/g, '')
  const loc = (live.values.installlocation || '').replace(/^"|"$/g, '')
  console.log('[清理] 发现历史安装，先静默卸载: ' + uninstaller)
  spawn(uninstaller, ['/S'], { detached: true, stdio: 'ignore' }).unref()
  if (loc) await waitForFileMissing(path.join(loc, 'ShopPilot.exe'), 90000)
  else await sleep(8000)
  return regEntries()
}

/** 清理游离实例：NSIS 静默安装会按 runAfterFinish 自动拉起应用（含子进程，必须整树结束）。
 *  注意：绝不杀 Un_A.exe / Au_.exe —— 它们是 NSIS 安装/卸载流程自身的临时副本，中断会导致卸载器未写回。 */
function killStray(reason) {
  const r = spawnSync('taskkill', ['/IM', 'ShopPilot.exe', '/T', '/F'], { encoding: 'utf8' })
  const killed = r.status === 0 ? 1 : 0
  if (killed) console.log(`[清理] ${reason}：已结束应用进程树`)
  return killed
}

/** 定位卸载器：注册表优先（QuietUninstallString 已含 /S），再退回安装目录 */
function findUninstaller(realDir) {
  for (const e of regEntries()) {
    const q = (e.values.quietuninstallstring || '').replace(/^"([^"]+)".*$/, '$1')
    const u = (e.values.uninstallstring || '').replace(/^"([^"]+)".*$/, '$1')
    if (q && fs.existsSync(q)) return { path: q, args: [] }
    if (u && fs.existsSync(u)) return { path: u, args: ['/S'] }
  }
  if (realDir && fs.existsSync(realDir)) {
    const f = fs.readdirSync(realDir).find(x => /^Uninstall.*\.exe$/i.test(x))
    if (f) return { path: path.join(realDir, f), args: ['/S'] }
  }
  return null
}

async function main() {
  // 前置：清掉可能残留的应用进程（避免安装器认为应用正在运行而静默放弃）
  killStray('启动前')
  await sleep(1000)
  const summary = []
  const record = (name, ok, extra = '') => {
    summary.push({ name, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
  }

  // ---------- 阶段 1：解包版 ----------
  if (!fs.existsSync(UNPACKED)) {
    console.error('缺少 release/win-unpacked/ShopPilot.exe，请先 pnpm dist')
    process.exit(1)
  }
  const tmpRoot = path.join(os.tmpdir(), 'shopilot-m4-' + Date.now())
  fs.mkdirSync(tmpRoot, { recursive: true })
  const appCopyDir = path.join(tmpRoot, 'app')
  console.log('[准备] 复制解包版到临时目录（避免与构建产物相互干扰）')
  fs.cpSync(path.join(RELEASE, 'win-unpacked'), appCopyDir, { recursive: true })
  const copyExe = path.join(appCopyDir, 'ShopPilot.exe')

  let ud = path.join(tmpRoot, 'userdata-packaged')
  let ctx = launchApp(copyExe, ud, 9227)
  if (!(await waitForCDP(9227))) {
    console.error('解包版未就绪，日志尾部：\n' + ctx.getLog().slice(-2000))
    process.exit(1)
  }
  const okPkg = await runVerify(9227, ud, 'packaged', '')
  record('阶段1 解包版（功能 + 主进程对话 + 诊断包/审计导出 + 日志）', okPkg)
  await stopApp(ctx)

  // 单实例互斥（两实例同写一个 SQLite 库的结构性风险）：第二个实例应立刻退出并聚焦首个
  const secondLog = path.join(tmpRoot, 'second-instance.log')
  ctx = launchApp(copyExe, ud, 9227)
  if (await waitForCDP(9227)) {
    const out = fs.openSync(secondLog, 'w')
    const second = spawn(copyExe, ['--no-sandbox', '--user-data-dir=' + ud], { stdio: ['ignore', out, out] })
    const gone = await new Promise(resolve => {
      const t = setTimeout(() => resolve(false), 15000)
      second.on('exit', () => { clearTimeout(t); resolve(true) })
    })
    fs.closeSync(out)
    try { second.kill('SIGKILL') } catch {}
    const secondText = fs.existsSync(secondLog) ? fs.readFileSync(secondLog, 'utf8') : ''
    // 主实例把"重复启动"写进 userData 日志（stdout 不带），故以日志文件为证据
    let mainLogText = ''
    const ld = path.join(ud, 'logs')
    if (fs.existsSync(ld)) {
      const f = fs.readdirSync(ld).filter(x => /^app-.*\.log$/.test(x)).sort().pop()
      if (f) mainLogText = fs.readFileSync(path.join(ld, f), 'utf8')
    }
    let firstAlive = false
    try { firstAlive = (await fetch('http://127.0.0.1:9227/json/version')).ok } catch {}
    record('阶段1 单实例互斥（重复启动退出且不影响运行中实例）', gone && firstAlive && /重复启动/.test(mainLogText),
      `${gone ? '第二实例已退出' : '第二实例仍在运行'}；${firstAlive ? '首实例存活' : '首实例异常'}；主实例日志含重复启动标记=${/重复启动/.test(mainLogText)}`)
    await stopApp(ctx)
  } else {
    record('阶段1 单实例互斥（重复启动退出且不影响运行中实例）', false, '首实例未就绪，无法验证')
  }

  // 日志保留（§22 14 天）：塞入过期日志文件，重启后应被清理
  const logsDir = path.join(ud, 'logs')
  if (fs.existsSync(logsDir)) {
    const stale = path.join(logsDir, 'app-2000-01-01.log')
    fs.writeFileSync(stale, 'stale-line\n')
    ctx = launchApp(copyExe, ud, 9227)
    await waitForCDP(9227, 25000)
    await sleep(1500)
    await stopApp(ctx)
    record('阶段1 过期日志（>14 天）在启动时被清理', !fs.existsSync(stale))
  }

  if (SKIP_INSTALL) {
    console.log('\n[跳过] 安装/升级/卸载阶段（--skip-install）')
    return finish(summary)
  }

  if (!(await waitForFile(SETUP, 1000, '安装包'))) {
    record('阶段2 安装包存在', false, SETUP)
    return finish(summary)
  }

  // ---------- 阶段 2：安装 + 安装版冒烟 ----------
  const installDir = path.join(tmpRoot, 'ShopPilotInstalled')
  let installedExe = path.join(installDir, 'ShopPilot.exe')
  await uninstallExisting()
  const installed = await silentRun(SETUP, ['/S', '/D=' + installDir], installedExe, 150000, '安装')
  if (!installed) {
    // 回退：读取注册表实际安装位置（不静默放过，如实记录差异）
    const loc = regEntries().map(e => (e.values.installlocation || '').replace(/^"|"$/g, '')).find(l => l && fs.existsSync(path.join(l, 'ShopPilot.exe')))
    if (loc) {
      installedExe = path.join(loc, 'ShopPilot.exe')
      record('阶段2 静默安装完成（NSIS /S 写入自定义目录）', false, `实际安装到 ${loc}（/D 未生效）`)
      record('阶段2 安装版可运行（按注册表实际位置继续）', true, installedExe)
    } else {
      record('阶段2 静默安装完成（NSIS /S 写入自定义目录）', false, `未落在 ${installDir}，注册表也无可用安装`)
      return finish(summary)
    }
  } else {
    record('阶段2 静默安装完成（NSIS /S 写入自定义目录）', true, installDir)
  }
  // NSIS runAfterFinish 会在静默安装后自动拉起应用：清理后再跑我们的受控实例
  const strayAfterInstall = killStray('安装后')
  record('阶段2 安装器自动启动的实例已清理（不影响受控验收）', true, strayAfterInstall ? `清理 ${strayAfterInstall} 个映像` : '本次未自动启动')
  await sleep(1200)

  const udInstalled = path.join(tmpRoot, 'userdata-installed')
  ctx = launchApp(installedExe, udInstalled, 9228)
  if (!(await waitForCDP(9228))) {
    console.error('安装版未就绪，日志尾部：\n' + ctx.getLog().slice(-2000))
    record('阶段2 安装版可启动', false)
    return finish(summary)
  }
  const storeForUpgrade = 'M4升级保留店铺'
  const okInstalled = await runVerify(9228, udInstalled, 'installed', storeForUpgrade)
  record('阶段2 安装版冒烟（建店/列表/浏览器/会话）', okInstalled)
  await stopApp(ctx)
  record('阶段2 安装版用户数据已生成', fs.existsSync(path.join(udInstalled, 'shopilot.db')))

  // ---------- 阶段 3：升级安装 → 数据保留 ----------
  killStray('升级安装前')
  await waitNoStray(20000)
  const upgraded = await silentRun(SETUP, ['/S', '/D=' + installDir], installedExe, 120000, '升级安装')
  record('阶段3 覆盖安装（升级）完成', upgraded)
  killStray('升级安装后')
  await sleep(1200)
  // 升级完整性：等一段时间再复核，捕捉"挂起删除"把新装文件清空的场景
  const asarPath = path.join(installDir, 'resources', 'app.asar')
  const intactNow = fs.existsSync(installedExe) && fs.existsSync(asarPath)
  await sleep(10000)
  const intactLater = fs.existsSync(installedExe) && fs.existsSync(asarPath)
  record('阶段3 升级后安装目录完整（无挂起删除）', intactNow && intactLater, intactNow === intactLater ? 'exe+app.asar 均在' : '安装后被清空')
  ctx = launchApp(installedExe, udInstalled, 9228)
  if (!(await waitForCDP(9228))) {
    record('阶段3 升级后可启动', false)
    await stopApp(ctx)
    return finish(summary)
  }
  const okUpgraded = await runVerify(9228, udInstalled, 'upgraded', 'M4升级后新店铺', storeForUpgrade)
  record('阶段3 升级后数据保留（既有店铺 + 审计表可读）', okUpgraded)
  await stopApp(ctx)

  // ---------- 阶段 4：卸载 ----------
  killStray('卸载前')
  await sleep(1000)
  const realDir = path.dirname(installedExe)
  const listing = fs.existsSync(realDir) ? fs.readdirSync(realDir) : []
  console.log('[阶段4] 安装目录内容: ' + listing.join(', '))
  const uni = findUninstaller(realDir)
  record('阶段4 定位卸载程序（注册表或安装目录）', !!uni, (uni?.path || '未找到').replace(tmpRoot, '<tmp>'))
  if (uni) {
    // NSIS 静默卸载：QuietUninstallString 已含 /S；否则补 /S（卸载器会先自拷贝到临时目录再执行）
    spawn(uni.path, uni.args, { detached: true, stdio: 'ignore' }).unref()
    const gone = await waitForFileMissing(installedExe, 180000)
    record('阶段4 静默卸载清理安装目录', gone)
    record('阶段4 卸载不动用户数据（deleteAppDataOnUninstall=false）', fs.existsSync(udInstalled), udInstalled)
  }

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  return finish(summary)
}

async function waitForFileMissing(p, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!fs.existsSync(p)) return true
    await sleep(1000)
  }
  return false
}

function finish(summary) {
  const passed = summary.filter(r => r.ok).length
  console.log(`\nM4 运行器：通过 ${passed}/${summary.length}`)
  if (passed < summary.length) {
    console.log('失败项: ' + summary.filter(r => !r.ok).map(r => r.name).join('; '))
    process.exit(1)
  }
  console.log('M4_RUNNER_PASSED')
  process.exit(0)
}

main().catch(err => { console.error('RUNNER_ERROR', err); process.exit(1) })
void spawnSync
