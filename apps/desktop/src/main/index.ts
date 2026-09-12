/**
 * Main Process Entry Point
 * Electron 主进程入口
 */

import { app, BrowserWindow } from 'electron'
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
import { installLockGate, startBackgroundServices } from './services/bg-services'
import * as Security from './services/security-manager'
import { setBrowserHostWindow, setBrowserViewsVisible, emitToRenderer } from './browser/window-manager'
import { clearProxyAuthTracking } from './browser/session-manager'
import { verifyStoreFingerprint } from './browser/fingerprint-injector'
import { createStore, deleteStorePermanent } from './stores/store-manager'
import { updateProfile } from './stores/profile-manager'
import { openStoreBrowser, closeStoreBrowser, getStoreTabs } from './browser/window-manager'
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

  // §8.2 主窗口作为店铺浏览器的宿主（WebContentsView 内嵌）
  setBrowserHostWindow(mainWindow)

  // §22 renderer 控制台错误进主日志（截断防噪音；脱敏由 logger 统一处理）
  mainWindow.webContents.on('console-message', (_ev, level, message) => {
    if (level >= 2) logMain(level === 3 ? 'error' : 'warn', 'renderer: ' + String(message).slice(0, 400))
  })
  mainWindow.webContents.on('render-process-gone', (_ev, details) => {
    logMain('error', `renderer gone reason=${details.reason} exitCode=${details.exitCode}`)
  })
}

/**
 * 应用初始化
 */
async function initialize(): Promise<void> {
  try {
    // 初始化数据库
    logMain('info', `启动 version=${app.getVersion()} electron=${process.versions.electron} chrome=${process.versions.chrome}`)
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
    console.log('IPC handlers registered')

    // 锁定动作的统一善后（手动锁定与空闲自动锁定同路径）- §189
    Security.setDestroySensitiveHook(() => {
      clearProxyAuthTracking()
      setBrowserViewsVisible(false)
      emitToRenderer(EVENT_CHANNELS.SECURITY_LOCKED, { locked: true })
    })
    startBackgroundServices()
    
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
  // macOS 除外，其他平台关闭所有窗口时退出应用
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 应用退出前清理
app.on('before-quit', () => {
  console.log('Closing database connection...')
  closeDatabase()
})

// 处理未捕获的异常 - §22：崩溃日志落盘（脱敏），诊断包可追溯
process.on('uncaughtException', (error) => {
  logMain('error', 'uncaughtException: ' + (error?.stack || String(error)))
})

process.on('unhandledRejection', (reason) => {
  logMain('error', 'unhandledRejection: ' + String((reason as any)?.stack || reason))
})
