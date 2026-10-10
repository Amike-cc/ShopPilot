/**
 * Main Process Entry Point
 * Electron 主进程入口
 */

import { app, BrowserWindow, dialog, crashReporter } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { writeFileSync, existsSync } from 'fs'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import { initDatabase, closeDatabase, getDatabasePath } from './db/database'
import { registerStoreHandlers } from './ipc/store-handlers'
import { registerBrowserHandlers } from './ipc/browser-handlers'
import { registerInviteHandlers } from './ipc/invite-handlers'
import { registerBookmarkAndDownloadHandlers } from './ipc/bookmark-download-handlers'
import { registerProfileAndMiscHandlers } from './ipc/profile-misc-handlers'
import { registerProxyAndBackupHandlers } from './ipc/proxy-backup-handlers'
import { registerPlatformHandlers } from './ipc/platform-handlers'
import { registerOrderHandlers } from './ipc/order-handlers'
import { registerSalesMetricsHandlers } from './ipc/sales-metrics-handlers'
import { registerProductHandlers } from './ipc/product-handlers'
import { stopSalesMetricsScheduler } from './sales-metrics/sales-metrics-scheduler'
import { registerTaskHandlers } from './ipc/task-handlers'
import { registerSessionAndSecurityHandlers } from './ipc/session-security-handlers'
import { registerUpdateHandlers } from './ipc/update-handlers'
import { registerAiHandlers } from './ipc/ai-handlers'
import { registerAgentHandlers } from './ipc/agent-handlers'
import { registerAgentDomainHandlers } from './ipc/agent-domain-handlers'
import { registerCustomerServiceHandlers } from './ipc/customer-service-handlers'
import { scheduleStartupCheck } from './services/update-manager'
import { installLockGate, startBackgroundServices } from './services/bg-services'
import * as Security from './services/security-manager'
import { setBrowserHostWindow, setBrowserViewsVisible, emitToRenderer } from './browser/window-manager'
import { customerMessageMonitor } from './services/customer-message-monitor'
import { clearProxyAuthTracking, applyDefaultSessionPermissions } from './browser/session-manager'
import { verifyStoreFingerprint } from './browser/fingerprint-injector'
import { createStore, deleteStorePermanent, getStore, listStores } from './stores/store-manager'
import { updateProfile } from './stores/profile-manager'
import { assertNavigableUrl } from '@shared/navigation'
import { openStoreBrowser, closeStoreBrowser, getStoreTabs } from './browser/window-manager'
import { startSessionPersistence } from './services/session-persistence'
import { latestBackupFileOnDisk, recoverDatabaseFromLatestBackup } from './services/backup-manager'
import { migrateLegacyAgentMemoryFilesToRoot, migrateLegacyMemoryRoot } from './services/agent-memory'
import * as TaskRunner from './tasks/task-runner'
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

const STORE_PARTITION_PREFIX = 'persist:store_'
/** 客服页面使用独立持久分区，不能复用经营工作台的会话。 */
const CUSTOMER_SERVICE_PARTITION_PREFIX = 'persist:customer-service_'

/** 从 webview partition 中提取店铺 ID；未知格式一律拒绝。 */
function getWebviewStoreId(partition: unknown): string | null {
  if (typeof partition !== 'string' || !partition.startsWith(STORE_PARTITION_PREFIX)) return null
  const storeId = partition.slice(STORE_PARTITION_PREFIX.length)
  return storeId.length > 0 ? storeId : null
}

/** 从客服 webview partition 中提取店铺 ID；未知格式一律拒绝。 */
function getCustomerServiceStoreId(partition: unknown): string | null {
  if (typeof partition !== 'string' || !partition.startsWith(CUSTOMER_SERVICE_PARTITION_PREFIX)) return null
  const storeId = partition.slice(CUSTOMER_SERVICE_PARTITION_PREFIX.length)
  return storeId.length > 0 ? storeId : null
}

/** webview 只允许空白页，或由共享导航 helper 放行的 http(s) 地址。 */
function isAllowedWebviewSource(source: unknown): boolean {
  if (source === 'about:blank') return true
  if (typeof source !== 'string') return false
  try {
    const safeUrl = assertNavigableUrl(source)
    return ['http:', 'https:'].includes(new URL(safeUrl).protocol)
  } catch {
    return false
  }
}

/** 只记录形状/协议，不把店铺 ID、主机名、路径或查询值写入日志。 */
function describeWebviewValue(value: unknown, kind: 'partition' | 'src'): string {
  if (typeof value !== 'string') return '<missing>'
  if (kind === 'partition') {
    if (value.startsWith(STORE_PARTITION_PREFIX)) return 'persist:store_<redacted>'
    if (value.startsWith(CUSTOMER_SERVICE_PARTITION_PREFIX)) return 'persist:customer-service_<redacted>'
    return '<invalid>'
  }
  if (value === 'about:blank') return 'about:blank'
  try {
    return `protocol=${new URL(value).protocol}`
  } catch {
    return '<invalid>'
  }
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
      sandbox: true,
      webviewTag: true
    },
    backgroundColor: '#1a1a1a',
    show: false
  })

  // webview 的初始参数来自 Renderer，必须在主窗口开始加载前收口，避免不受信任的
  // preload、partition 或初始 URL 被 Electron 接受。仅允许真实店铺自己的持久分区。
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    // 无论校验是否通过，都移除 Renderer 提供的 preload，并固定 guest 的安全选项。
    delete params.preload
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webviewTag = false
    const storeId = getWebviewStoreId(params.partition)
    const customerServiceStoreId = getCustomerServiceStoreId(params.partition)
    // 经营页面默认允许 Chromium 对隐藏页面节流；客服页面需要保持实时接待状态，
    // 即使切回经营工作台也不暂停消息页面的定时器与连接。
    // 店铺页面默认允许后台节流；客服页面随后显式关闭节流，保证切回经营工作台后仍接收平台消息。
    webPreferences.backgroundThrottling = true
    if (customerServiceStoreId) webPreferences.backgroundThrottling = false
    let validPartition = false
    if (storeId && params.partition === `${STORE_PARTITION_PREFIX}${storeId}`) {
      try {
        validPartition = !!getStore(storeId)
      } catch {
        validPartition = false
      }
    }
    if (customerServiceStoreId && params.partition === `${CUSTOMER_SERVICE_PARTITION_PREFIX}${customerServiceStoreId}`) {
      try {
        validPartition = !!getStore(customerServiceStoreId)
      } catch {
        validPartition = false
      }
    }
    const validSource = isAllowedWebviewSource(params.src)

    if (!validPartition || !validSource) {
      event.preventDefault()
      const reason = !validPartition ? 'invalid-partition' : 'invalid-src'
      logMain(
        'warn',
        `main window: blocked webview attach reason=${reason} partition=${describeWebviewValue(params.partition, 'partition')} src=${describeWebviewValue(params.src, 'src')}`
      )
    }
  })

  // 客服页面不是经营标签，不能依赖 window-manager 的 guest 注册钩子。
  // 它仍然是远程页面，必须在 guest 自己的导航/弹窗边界上收口；否则页面脚本
  // 可以把客服 webview 导向 file/data/javascript 等非业务协议，或绕过应用内页面
  // 直接创建未受控的原生窗口。http(s) 的平台内跳转继续允许，弹窗改为当前客服页
  // 内导航，保留扫码/OAuth 等人工登录流程而不创建额外 BrowserWindow。
  ;(mainWindow.webContents as any).on('did-attach-webview', (_event: Electron.Event, guestWebContents: Electron.WebContents) => {
    // Electron 的 did-attach-webview 只传 (event, guestWebContents)。此前把
    // will-attach 的 webPreferences/params 误当成这里的后续参数，导致 partition
    // 永远读不到，客服 guest 的导航与弹窗边界实际上没有安装。
    const partition = String((guestWebContents as any)?.session?.partition || '')
    const customerServiceStoreId = getCustomerServiceStoreId(partition)
    if (!customerServiceStoreId) return
    const destroyGuest = (): void => {
      try {
        const candidate = guestWebContents as any
        if (typeof candidate.destroy === 'function') candidate.destroy()
        else if (typeof candidate.close === 'function') candidate.close()
      } catch { /* 页面已销毁 */ }
    }
    try {
      if (!getStore(customerServiceStoreId)) {
        destroyGuest()
        return
      }
      if (partition !== `${CUSTOMER_SERVICE_PARTITION_PREFIX}${customerServiceStoreId}`) {
        logMain('warn', 'customer-service guest: blocked unexpected session partition')
        destroyGuest()
        return
      }
      guestWebContents.setWindowOpenHandler(({ url }: { url: string }) => {
        if (!isAllowedWebviewSource(url)) {
          logMain('warn', 'customer-service guest: blocked popup with unsafe URL')
          return { action: 'deny' }
        }
        try { guestWebContents.loadURL(url).catch(() => { /* 页面自行呈现失败 */ }) } catch { /* 页面已销毁 */ }
        return { action: 'deny' }
      })
      const allowCustomerNavigation = (event: Electron.Event, url: string): void => {
        if (isAllowedWebviewSource(url)) return
        event.preventDefault()
        logMain('warn', 'customer-service guest: blocked unsafe navigation')
      }
      guestWebContents.on('will-navigate', allowCustomerNavigation)
      guestWebContents.on('will-redirect', allowCustomerNavigation)
    } catch (error) {
      logMain('warn', `customer-service guest security setup failed: ${String((error as Error)?.message || error).slice(0, 160)}`)
      destroyGuest()
    }
  })

  // 开发环境加载 Vite dev server
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    // 生产环境加载打包后的文件
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Electron 安全清单：主窗口的页面导航与 window.open 收口。主窗口渲染层持有完整业务
  // bridge（店铺/任务/AI Key），一旦被注入脚本，这两道护栏阻止它把宿主窗口导航到任意
  // 远程页面——新开窗口默认继承 preload，等于把 bridge 送到远程内容手里。
  const allowedUiFileHref = pathToFileURL(join(__dirname, '../renderer/index.html')).href
  const allowedDevOrigin = process.env.VITE_DEV_SERVER_URL
    ? (() => { try { return new URL(process.env.VITE_DEV_SERVER_URL as string).origin } catch { return null } })()
    : null
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let allowed = false
    try {
      const u = new URL(url)
      if (u.protocol === 'file:') {
        // 打包态只放行本地 UI 页本身（含 hash/查询变化；SPA 路由就是 hash）
        allowed = u.href === allowedUiFileHref
          || u.href.startsWith(allowedUiFileHref + '#')
          || u.href.startsWith(allowedUiFileHref + '?')
      } else if (allowedDevOrigin) {
        // 开发态只放行 Vite dev server 同源
        allowed = u.origin === allowedDevOrigin
      }
    } catch { allowed = false }
    if (!allowed) {
      event.preventDefault()
      logMain('warn', `main window: blocked navigation to ${url}`)
    }
  })
  mainWindow.webContents.setWindowOpenHandler((details) => {
    logMain('warn', `main window: blocked window.open url=${details.url}`)
    return { action: 'deny' }
  })

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
    // 客服后台使用隐藏 BrowserWindow；它们不会触发 window-all-closed，
    // 否则用户关闭主窗口后应用可能仍驻留后台。先停监控并销毁隐藏窗口，
    // 再让普通的 window-all-closed/退出流程接管。
    try { customerMessageMonitor.stop() } catch { /* 关闭时幂等 */ }
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

    // 权限收口要在**任何窗口创建之前**挂到默认 session 上（主窗口/密码对话框都用它）；
    // 店铺 session 的收口在各自 configureSession 里，已由 session-manager 覆盖 request+check 两条路径。
    applyDefaultSessionPermissions()

    // 注册 IPC 处理器
    console.log('Registering IPC handlers...')
    registerStoreHandlers()
    registerBrowserHandlers()
    registerInviteHandlers()
    registerBookmarkAndDownloadHandlers()
    registerProfileAndMiscHandlers()
    registerProxyAndBackupHandlers()
    registerPlatformHandlers()
    registerOrderHandlers()
    registerSalesMetricsHandlers()
  registerProductHandlers()
    registerTaskHandlers()
    registerSessionAndSecurityHandlers()
    registerUpdateHandlers()
    registerAiHandlers()
    registerAgentHandlers()
    registerAgentDomainHandlers()
    registerCustomerServiceHandlers()
    console.log('IPC handlers registered')

    // 锁定动作的统一善后（手动锁定与空闲自动锁定同路径）- §189
    Security.setDestroySensitiveHook(() => {
      clearProxyAuthTracking()
      customerMessageMonitor.pauseForAppLock()
      setBrowserViewsVisible(false)
      emitToRenderer(EVENT_CHANNELS.SECURITY_LOCKED, { locked: true })
    })
    startBackgroundServices()
    customerMessageMonitor.start()

    // 历史遗留的 Agent 记忆目录（%APPDATA%\ShopPilot\agent-memory）搬到 userData 之下：
    // 否则它会落在备份/诊断包/卸载清理的边界之外（2026-09-28 审查实测两个目录同时存在）。
    try {
      const migrated = migrateLegacyMemoryRoot()
      if (migrated.moved) logMain('info', `Agent 记忆目录已迁移：${migrated.from} → ${migrated.to}`)
    } catch (e: any) {
      logMain('warn', 'Agent 记忆目录迁移失败（不影响其他功能）: ' + String(e?.message || e))
    }
    // 数据库归属迁移后，旧 Agent 的文件目录、Markdown front matter、manifest
    // 和 SQLite file_path/content_hash 也必须收敛到 root-ceo；失败项留在原处，
    // 下一次启动会幂等重试，不阻断主窗口启动。
    try {
      const migrated = migrateLegacyAgentMemoryFilesToRoot()
      if (migrated.scanned || migrated.errors.length) {
        logMain('info', `Agent 记忆文件归属迁移：扫描 ${migrated.scanned}，迁移 ${migrated.migrated}，冲突 ${migrated.conflicts}，失败 ${migrated.failed}`)
      }
    } catch (e: any) {
      logMain('warn', 'Agent 记忆文件归属迁移失败（不影响其他功能）: ' + String(e?.message || e))
    }

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
    await handleStartupFailure(error)
  }
}

/**
 * 启动失败处理：留日志 → 尝试用最新备份自愈 → 起不来就**明确告诉用户**。
 *
 * 为什么要改：原先这里只写 `startup-error.log` 然后 `app.quit()`，用户看到的是
 * "双击图标毫无反应"——没有窗口、没有弹窗、没有托盘。更糟的是"从备份恢复"这个功能
 * 本身要求应用能起来（它走 IPC + 库），于是**唯一的自救路径依赖应用能启动**，
 * 备份文件就在磁盘上却永远用不上（2026-09-28 审查确认的死锁）。
 * 这里把"扫盘找最新备份 → 原子换回来 → 重启"做成不依赖库的能力。
 */
async function handleStartupFailure(error: any): Promise<void> {
  const detail = (error && error.stack) || String(error)
  console.error('Failed to initialize application:', error)
  try {
    writeFileSync(join(app.getPath('userData'), 'startup-error.log'), detail)
  } catch { /* 日志写不了也要继续走下面的提示 */ }

  const latest = latestBackupFileOnDisk()
  if (latest) {
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: 'ShopPilot 启动失败',
      message: '数据库无法打开，应用无法启动。',
      detail:
        `原因：${String(error?.message || error).slice(0, 300)}\n\n` +
        `检测到一份备份：\n${latest}\n\n` +
        `选择「用备份恢复并重启」会用这份备份替换当前数据库（当前库会留在原处，不会被删除），然后自动重启。`,
      buttons: ['用备份恢复并重启', '退出'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    if (choice === 0) {
      try {
        closeDatabase()
        const { restoredFrom } = recoverDatabaseFromLatestBackup(getDatabasePath())
        logMain('warn', `启动自愈：已用备份恢复数据库 ${restoredFrom}`)
        app.relaunch()
        app.exit(0)
        return
      } catch (recoverError: any) {
        logMain('error', `启动自愈失败：${String(recoverError?.message || recoverError).slice(0, 200)}`)
      }
    }
  }

  dialog.showErrorBox(
    'ShopPilot 启动失败',
    `数据库无法打开，应用无法启动。\n\n` +
      `原因：${String(error?.message || error).slice(0, 300)}\n\n` +
      `${latest ? '用备份自动恢复也失败了。' : '本机还没有任何可用备份。'}\n` +
      `错误详情已写入：\n${join(app.getPath('userData'), 'startup-error.log')}\n\n` +
      `请把该文件发给技术支持。`
  )
  app.exit(1)
}

/**
 * 应用生命周期
 */

/**
 * Windows 上的「原生窗口遮挡检测」会让 Chromium 认为窗口不可见 → **不产出帧**。
 * 自动化跑任务时用户往往把应用切到后台/最小化，于是：
 *   · `webContents.capturePage()` 直接挂住（真机实测 2026-10-03 11:08 连发：第 1 轮邀约已真实
 *     发出，末尾的留档截图挂到 20s 超时，把整单判成失败）；
 *   · 页面里的可见性判据/渲染时序也会变得不稳（间歇性"元素在但不可见"）。
 * 关掉这个特性后，后台窗口照常渲染。必须在 app ready **之前**设置才生效。
 */
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
}

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
//
// 退出次序（2026-09-28 审查修正）：
//   · 这里**不再关库**。session-persistence 的 before-quit 监听器会 preventDefault 并异步
//     把会话快照写完（最长 3 秒）才退出，而它的监听器注册得比这里晚——原实现等于"库先关了，
//     进程还活着几秒"，期间 1s/1.5s/30s/60s 四个定时器仍在跑，写库全失败且多数被空 catch 吞掉。
//   · 改为：先请所有在跑的 run 收尾（协作式取消），库留到最后一步（will-quit）再关。
app.on('before-quit', () => {
  logMain('warn', 'app lifecycle: before-quit（准备退出）')
  // 经营采集是长驻定时器 + 可能的在跑采集：先停调度并把它标记为 INTERRUPTED，
  // 否则库里会留下永不结束的 RUNNING，"是否还在采集"永远为真（§7.11）。
  // 放在关库之前（will-quit 才关库），这样这次状态写入能成功。
  try { stopSalesMetricsScheduler() } catch (e: any) {
    try { logMain('warn', '退出前停止经营采集调度失败: ' + String(e?.message || e)) } catch { /* ignore */ }
  }
  try { customerMessageMonitor.stop() } catch { /* ignore */ }
  try {
    const active = TaskRunner.listLiveRuns()
    if (active.length) {
      logMain('warn', `退出前收尾：${active.length} 个未结束的运行将被取消 ${JSON.stringify(active.map(r => ({ runId: r.runId, status: r.status })))}`)
      for (const run of active) {
        try { TaskRunner.cancelRun(run.runId, '应用退出') } catch { /* 已结束/状态不允许都无妨 */ }
      }
    }
  } catch (e: any) {
    logMain('warn', '退出前取消运行失败: ' + String(e?.message || e))
  }
})
app.on('will-quit', () => {
  // 最后一刻才关库：此时会话快照（preventDefault 那段异步写）已经结束
  try {
    console.log('Closing database connection...')
    closeDatabase()
  } catch { /* 幂等，重复关不抛 */ }
  try { logMain('warn', 'app lifecycle: will-quit（即将退出）') } catch { /* 退出路径不抛错 */ }
})
// 子进程崩溃（GPU/utility/network）：白屏与卡死的常见根因，此前完全没有留痕
app.on('child-process-gone', (_e, details) => {
  try {
    logMain('error', `child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode} name=${details.name || ''}`)
  } catch { /* 不能因日志失败而抛 */ }
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
