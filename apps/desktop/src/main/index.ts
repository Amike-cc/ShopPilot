/**
 * Main Process Entry Point
 * Electron 主进程入口
 */

import { app, BrowserWindow, dialog, crashReporter } from 'electron'
import { join } from 'path'
import { writeFileSync, existsSync } from 'fs'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import { initDatabase, closeDatabase } from './db/database'
import { registerStoreHandlers } from './ipc/store-handlers'
import { registerBrowserHandlers } from './ipc/browser-handlers'
import { registerBookmarkAndDownloadHandlers } from './ipc/bookmark-download-handlers'
import { registerProfileAndMiscHandlers } from './ipc/profile-misc-handlers'
import { registerProxyAndBackupHandlers } from './ipc/proxy-backup-handlers'
import { registerTaskHandlers } from './ipc/task-handlers'
import { registerSessionAndSecurityHandlers } from './ipc/session-security-handlers'
import { registerUpdateHandlers } from './ipc/update-handlers'
import { registerAiHandlers } from './ipc/ai-handlers'
import { scheduleStartupCheck } from './services/update-manager'
import { installLockGate, startBackgroundServices } from './services/bg-services'
import * as Security from './services/security-manager'
import { setBrowserHostWindow, setBrowserViewsVisible, emitToRenderer } from './browser/window-manager'
import { clearProxyAuthTracking } from './browser/session-manager'
import { verifyStoreFingerprint } from './browser/fingerprint-injector'
import { createStore, deleteStorePermanent, listStores } from './stores/store-manager'
import { updateProfile } from './stores/profile-manager'
import { openStoreBrowser, closeStoreBrowser, getStoreTabs } from './browser/window-manager'
import { startSessionPersistence } from './services/session-persistence'
import { logMain } from './services/logger'

/**
 * 指纹自检（无外部 CDP，避免与外部调试会话互斥）：
 * SHOPILOT_FP_AUTOTEST=1 时建店 → 定制环境 → 开浏览器 → verify → 结果写
 * SHOPILOT_FP_RESULT 指定路径 → 清场退出。供 m2-runner 断言。
 */
async function runFingerprintAutotest(): Promise<void> {
  const resultPath = process.env.SHOPILOT_FP_RESULT || 'shopilot-fp-result.json'
  const report: any = { startedAt: Date.now(), steps: [], items: [], error: null }
  console.log('[fp-autotest] start →', resultPath)
  try {
    const store = createStore({ name: 'FP自检店', platform: 'test' } as any)
    report.storeId = store.id
    console.log('[fp-autotest] store created', store.id)
    updateProfile(store.id, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.207 Safari/537.36',
      language: 'en-GB',
      timezone: 'Asia/Tokyo',
      screenWidth: 1440,
      screenHeight: 900,
      hardwareConcurrency: 8,
      webglVendor: 'Google Inc. (TestVendor)',
      webglRenderer: 'ANGLE (TestRenderer)'
    } as any)
    report.steps.push('profile-updated')
    openStoreBrowser(store.id)
    const tabs = getStoreTabs(store.id)
    report.steps.push('browser-opened tabs=' + tabs.length)
    console.log('[fp-autotest] browser opened, tabs =', tabs.length)
    // 等 dom-ready + 注入 + 时区 CDP 应用
    await new Promise(r => setTimeout(r, 2500))
    report.items = await verifyStoreFingerprint(store.id)
    console.log('[fp-autotest] verified items =', report.items.length)
    closeStoreBrowser(store.id)
    deleteStorePermanent(store.id)
    report.steps.push('cleanup-done')
  } catch (e: any) {
    report.error = String(e?.message || e)
  }
  report.finishedAt = Date.now()
  writeFileSync(resultPath, JSON.stringify(report, null, 2))
  app.exit(0)
}

let mainWindow: BrowserWindow | null = null

/** 主窗口崩溃自动恢复的有界窗口（防崩溃-重载死循环） */
const MAIN_RELOAD_MAX = 3
const MAIN_RELOAD_WINDOW_MS = 5 * 60 * 1000
const MAIN_RELOAD_ABSOLUTE_MAX = 10 // 24小时内绝对上限
const MAIN_RELOAD_ABSOLUTE_WINDOW_MS = 24 * 60 * 60 * 1000
let mainReloadCount = 0
let mainReloadWindowStart = 0
let mainReloadAbsoluteCount = 0
let mainReloadAbsoluteWindowStart = 0

/**
 * 崩溃类日志的限流：同类异常密集重复（如管道断开引发的异常风暴）时只记前若干条 +
 * 一条汇总，避免日志自身把磁盘与 CPU 打满。绝不在这里抛错——处理器抛错会变成新的
 * uncaughtException（2026-09-13 实测过 8 秒 1.1 万条递归）。
 */
const CRASH_LOG_MAX_PER_WINDOW = 20
const CRASH_LOG_WINDOW_MS = 10000
let crashLogCount = 0
let crashLogWindowStart = 0
function logCrash(kind: string, detail: string): void {
  try {
    const now = Date.now()
    if (now - crashLogWindowStart > CRASH_LOG_WINDOW_MS) {
      crashLogWindowStart = now
      crashLogCount = 0
    }
    crashLogCount++
    if (crashLogCount <= CRASH_LOG_MAX_PER_WINDOW) {
      logMain('error', `${kind}: ${detail}`)
    } else if (crashLogCount === CRASH_LOG_MAX_PER_WINDOW + 1) {
      logMain('error', `${kind}: 同类异常在 ${CRASH_LOG_WINDOW_MS / 1000}s 内已超 ${CRASH_LOG_MAX_PER_WINDOW} 次，本窗口内后续同类不再逐条记录（防日志风暴）`)
    }
  } catch { /* 崩溃日志本身绝不能再抛 */ }
}

/**
 * 顶部与 UI 一体化（§17）：
 * - titleBarStyle:'hidden' 去掉原生浅色标题栏，深色 UI 直通窗口顶边；
 * - titleBarOverlay 保留原生最小化/最大化/关闭按钮（WCO），底色随 UI 状态
 *   由渲染层经 window:setTitlebarOverlay 切换（欢迎页/工作台/应用锁）；
 * - overlay 高度与标签栏 .tab-strip（38px）对齐，右上角按钮压在右栏顶行上，
 *   渲染层已为 .panel-tabs / .panel-rail 预留避让空间。
 */
const TITLEBAR_OVERLAY_HEIGHT = 38

/** 应用图标：优先使用 asar 外的 resources/icon.ico，确保 Windows 原生窗口/任务栏可读取。 */
function resolveAppIcon(): string | undefined {
  const candidates = [
    join(process.resourcesPath, 'icon.ico'),
    join(app.getAppPath(), 'build', 'icon.ico'),
    join(app.getAppPath(), 'apps', 'desktop', 'resources', 'icon.ico')
  ]
  return candidates.find(p => { try { return existsSync(p) } catch { return false } })
}

/**
 * 创建主窗口
 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    title: 'ShopPilot',
    icon: resolveAppIcon(),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1a1a1a',       // 启动默认=欢迎页底色；渲染层挂载后按状态同步
      symbolColor: '#d4d4d4',
      height: TITLEBAR_OVERLAY_HEIGHT
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    backgroundColor: '#1a1a1a',
    show: false
  })

  // 开发环境加载 Vite dev server
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    // 生产环境加载打包后的文件
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 显示链路加固：titleBarStyle:'hidden' + titleBarOverlay 下 ready-to-show 在
  // Windows 上存在不触发的情况（进程活着但窗口永不出）——保留 ready-to-show
  // 作为快路径，另以 did-finish-load + 短延时兜底，并落日志便于诊断。
  let windowShown = false
  const showWindow = (why: string): void => {
    if (windowShown || !mainWindow || mainWindow.isDestroyed()) return
    windowShown = true
    mainWindow.show()
    mainWindow.focus()
    logMain('info', `win: shown via ${why} visible=${mainWindow.isVisible()}`)
  }
  mainWindow.once('ready-to-show', () => showWindow('ready-to-show'))
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => showWindow('did-finish-load fallback'), 1500)
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  // 窗口被关闭是"应用静默退出"最常见的原因（Windows 上 window-all-closed 即退出）：
  // 记下是谁关的、是否在退出流程中，事后可判
  mainWindow.on('close', () => {
    logMain('warn', 'main window: close 事件（窗口即将关闭）')
  })

  // §8.2 主窗口作为店铺浏览器的宿主（WebContentsView 内嵌）
  setBrowserHostWindow(mainWindow)

  // §22 renderer 控制台错误进主日志（截断防噪音；脱敏由 logger 统一处理）
  mainWindow.webContents.on('console-message', (_ev, level, message) => {
    if (level >= 2) logMain(level === 3 ? 'error' : 'warn', 'renderer: ' + String(message).slice(0, 400))
  })

  // 主窗口渲染进程崩溃：白屏=用户眼里的"闪退"。有界自动恢复（5 分钟内最多 3 次），
  // 超过则明确弹窗告知，不做无限重载（避免崩溃-重载死循环把 CPU 打满）
  // 新增绝对上限：24小时内最多10次，防止在时间窗口边界反复重置计数器
  mainWindow.webContents.on('render-process-gone', (_ev, details) => {
    logMain('error', `renderer gone reason=${details.reason} exitCode=${details.exitCode}`)
    if (details.reason === 'clean-exit') return
    const now = Date.now()
    
    // 更新滑动窗口计数
    if (now - mainReloadWindowStart > MAIN_RELOAD_WINDOW_MS) {
      mainReloadWindowStart = now
      mainReloadCount = 0
    }
    
    // 更新绝对窗口计数
    if (now - mainReloadAbsoluteWindowStart > MAIN_RELOAD_ABSOLUTE_WINDOW_MS) {
      mainReloadAbsoluteWindowStart = now
      mainReloadAbsoluteCount = 0
    }
    
    mainReloadCount++
    mainReloadAbsoluteCount++
    
    // 检查绝对上限（优先级更高）
    if (mainReloadAbsoluteCount > MAIN_RELOAD_ABSOLUTE_MAX) {
      logMain('error', `主窗口渲染进程在 ${MAIN_RELOAD_ABSOLUTE_WINDOW_MS / 3600000}h 内崩溃 ${mainReloadAbsoluteCount} 次（已超绝对上限 ${MAIN_RELOAD_ABSOLUTE_MAX}），停止自动重载`)
      try {
        dialog.showErrorBox('ShopPilot 界面异常',
          `界面进程在 24 小时内崩溃 ${mainReloadAbsoluteCount} 次（已超上限），已停止自动恢复。\n这可能表明存在严重问题，请到「设置 → 关于软件」导出诊断并联系技术支持。`)
      } catch { /* ignore */ }
      return
    }
    
    // 检查滑动窗口限制
    if (mainReloadCount <= MAIN_RELOAD_MAX) {
      logMain('warn', `主窗口渲染进程异常，自动重载（窗口内 ${mainReloadCount}/${MAIN_RELOAD_MAX}，绝对计数 ${mainReloadAbsoluteCount}/${MAIN_RELOAD_ABSOLUTE_MAX}）`)
      try { mainWindow?.webContents.reload() } catch { /* ignore */ }
      return
    }
    
    logMain('error', `主窗口渲染进程连续异常 ${mainReloadCount} 次（窗口 ${MAIN_RELOAD_WINDOW_MS / 1000}s 内），停止自动重载`)
    try {
      dialog.showErrorBox('ShopPilot 界面异常',
        `界面进程在短时间内反复崩溃（${mainReloadCount} 次），已停止自动恢复。\n请关闭并重新打开 ShopPilot；若反复出现，请到「设置 → 关于软件」导出诊断。`)
    } catch { /* ignore */ }
  })

  // 无响应（"卡死"）留痕：这类问题事后只能靠日志定位，主进程必须记录下来
  mainWindow.webContents.on('unresponsive', () => {
    logMain('error', 'main window unresponsive（界面无响应）')
  })
  mainWindow.webContents.on('responsive', () => {
    logMain('info', 'main window responsive（界面恢复响应）')
  })
}

/**
 * 应用初始化
 */
async function initialize(): Promise<void> {
  try {
    // 初始化数据库
    logMain('info', `启动 version=${app.getVersion()} electron=${process.versions.electron} chrome=${process.versions.chrome}`)
    // 本地崩溃转储（不上传）：主进程/子进程原生崩溃时落 .dmp，供事后定位。
    // §21.5 的口径是"崩溃报告上传默认关闭"，本项只写本机、不做任何上传。
    try {
      crashReporter.start({ uploadToServer: false, compress: false })
      logMain('info', `crashReporter started（本地转储目录 ${app.getPath('crashDumps')}）`)
    } catch (e: any) {
      logMain('warn', 'crashReporter 启动失败: ' + String(e?.message || e))
    }
    console.log('Initializing database...')
    initDatabase()
    console.log('Database initialized successfully')

    // 应用锁门禁必须在所有业务通道注册之前挂上（统一包装 ipcMain.handle）
    installLockGate()

    // 注册 IPC 处理器
    console.log('Registering IPC handlers...')
    registerStoreHandlers()
    registerBrowserHandlers()
    registerBookmarkAndDownloadHandlers()
    registerProfileAndMiscHandlers()
    registerProxyAndBackupHandlers()
    registerTaskHandlers()
    registerSessionAndSecurityHandlers()
    registerUpdateHandlers()
    registerAiHandlers()
    console.log('IPC handlers registered')

    // 锁定动作的统一善后（手动锁定与空闲自动锁定同路径）- §189
    Security.setDestroySensitiveHook(() => {
      clearProxyAuthTracking()
      setBrowserViewsVisible(false)
      emitToRenderer(EVENT_CHANNELS.SECURITY_LOCKED, { locked: true })
    })
    startBackgroundServices()

    // 自动更新（§21）：update.autoCheck 开启时启动后延迟自动检查一次
    scheduleStartupCheck()

    // 会话级 Cookie 持久化：微信小店的登录 Cookie 全是会话级，Chromium 默认不落盘，
    // 导致"重启应用就要重新扫码"。启动时把上回的快照灌回各店铺分区（失败不阻塞启动）。
    try {
      const ids = listStores().map(s => s.id)
      const { restored } = await startSessionPersistence(ids)
      logMain('info', `会话持久化已启动：店铺 ${ids.length} 个，本次恢复 ${restored} 条 Cookie`)
    } catch (e: any) {
      logMain('warn', '会话持久化启动失败（不影响其他功能）: ' + String(e?.message || e))
    }
  } catch (error: any) {
    console.error('Failed to initialize application:', error)
    try {
      writeFileSync(join(app.getPath('userData'), 'startup-error.log'),
        (error && error.stack) || String(error))
    } catch { /* ignore */ }
    app.quit()
  }
}

/**
 * 应用生命周期
 */

// 单实例：两个实例同写一个 SQLite 库会互相干扰（M4 验收发现的结构性风险），
// 第二次启动直接把已有窗口带到前台后退出。
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const wins = BrowserWindow.getAllWindows()
    const main = wins.find((w: Electron.BrowserWindow) => !w.isDestroyed())
    if (main) {
      if (main.isMinimized()) main.restore()
      main.show()
      main.focus()
    }
    logMain('info', '检测到重复启动：已聚焦现有窗口')
  })
}

// 当 Electron 完成初始化时
app.whenReady().then(async () => {
  if (!gotTheLock) return
  await initialize()
  createWindow()

  if (process.env.SHOPILOT_FP_AUTOTEST === '1') {
    runFingerprintAutotest().catch(e => { console.error('FP_AUTOTEST_CRASH', e); app.exit(2) })
  }

  app.on('activate', () => {
    // macOS 特定：点击 dock 图标时重新创建窗口
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

// 所有窗口关闭时
app.on('window-all-closed', () => {
  logMain('warn', 'app lifecycle: window-all-closed（全部窗口已关闭，将退出应用）')
  // macOS 除外，其他窗口关闭所有窗口时退出应用
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 退出路径留痕（2026-09-13 实测过一次"进程无声消失"：无错误日志、无事件日志、无转储，
// 事后无法判断是窗口被关、主动退出还是被外部结束——这三条日志就是为这种场景加的）
app.on('before-quit', () => {
  logMain('warn', 'app lifecycle: before-quit（准备退出）')
  console.log('Closing database connection...')
  closeDatabase()
})
app.on('will-quit', () => {
  try { logMain('warn', 'app lifecycle: will-quit（即将退出）') } catch { /* 退出路径不抛错 */ }
})
app.on('quit', (_e, exitCode) => {
  try { logMain('warn', `app lifecycle: quit exitCode=${exitCode}`) } catch { /* ignore */ }
})
// 被外部强制结束（任务管理器 / Stop-Process 等）时，Node 仍会走 exit：
// 同步写一行日志，便于区分"被外部杀"与"自然退出"
process.on('exit', (code) => {
  try { logMain('warn', `process exit code=${code}（进程结束）`) } catch { /* ignore */ }
})

// 处理未捕获的异常 - §22：崩溃日志落盘（脱敏），诊断包可追溯。
// 注意：这两个处理器内部绝不能再抛（历史上 logMain 的 console 写入在管道断开时抛 EPIPE，
// 导致"处理器记错误 → 又抛新错误 → 再进处理器"的递归风暴，实测 8 秒 1.1 万条异常、CPU 打满）。
process.on('uncaughtException', (error) => {
  logCrash('uncaughtException', String(error?.stack || error))
})

process.on('unhandledRejection', (reason) => {
  logCrash('unhandledRejection', String((reason as any)?.stack || reason))
})
