/**
 * IPC 统一返回值类型 - §6
 */
export interface IPCSuccess<T = any> {
  ok: true
  data: T
  requestId: string
}

export interface IPCError {
  ok: false
  error: {
    code: string
    message: string
    details?: any
  }
  requestId: string
}

export type IPCResult<T = any> = IPCSuccess<T> | IPCError

/**
 * IPC 频道名称 - §6
 */
export const IPC_CHANNELS = {
  // 店铺管理 - §6.1
  STORE_LIST: 'store:list',
  STORE_GET: 'store:get',
  STORE_CREATE: 'store:create',
  STORE_UPDATE: 'store:update',
  STORE_ARCHIVE: 'store:archive',
  STORE_RESTORE: 'store:restore',
  STORE_DELETE_PERMANENT: 'store:deletePermanent',
  STORE_REORDER: 'store:reorder',
  STORE_SET_GROUP: 'store:setGroup',
  STORE_TRASH_LIST: 'store:trashList',
  STORE_PURGE: 'store:purge',

  // 浏览器和标签页 - §6.2
  BROWSER_OPEN: 'browser:open',
  BROWSER_CLOSE: 'browser:close',
  BROWSER_DISPLAY: 'browser:display',
  BROWSER_SET_VIEWPORT: 'browser:setViewport',
  BROWSER_TAB_CREATE: 'browser:tab:create',
  BROWSER_TAB_ACTIVATE: 'browser:tab:activate',
  BROWSER_TAB_CLOSE: 'browser:tab:close',
  BROWSER_TAB_REORDER: 'browser:tab:reorder',
  BROWSER_TAB_SET_PINNED: 'browser:tab:setPinned',
  BROWSER_TAB_LIST: 'browser:tab:list',
  BROWSER_NAVIGATE: 'browser:navigate',
  BROWSER_PREPARE_INVITE_SQUARE: 'browser:prepareInviteSquare',
  BROWSER_TAB_CONTROL: 'browser:tab:control',   // 前进/后退/重载（地址栏）
  BROWSER_CLEAR_DATA: 'browser:clearData',
  BROWSER_CAPTURE: 'browser:capture',
  BROWSER_OPEN_WINDOW: 'browser:openWindow',
  /** 渲染层弹层遮挡时摘除原生视图挂载（WebContentsView 永远画在 HTML 之上） */
  BROWSER_SET_VIEWS_OBSCURED: 'browser:setViewsObscured',

  // 书签 - §6.2
  BOOKMARK_LIST: 'bookmark:list',
  BOOKMARK_CREATE: 'bookmark:create',
  BOOKMARK_DELETE: 'bookmark:delete',
  BOOKMARK_ENTRY_ROUTES: 'bookmark:entryRoutes',

  // 下载 - §6.2
  DOWNLOAD_LIST: 'download:list',
  DOWNLOAD_SHOW_IN_FOLDER: 'download:showInFolder',

  // 代理和网络 - §6.3
  PROXY_TEST: 'proxy:test',
  PROXY_LIST: 'proxy:list',
  PROXY_CREATE: 'proxy:create',
  PROXY_UPDATE: 'proxy:update',
  PROXY_DELETE: 'proxy:delete',
  PROXY_IMPORT_BATCH: 'proxy:importBatch',
  PROXY_BIND: 'proxy:bind',
  PROXY_HISTORY: 'proxy:history',

  // 会话 - §6.3（cookies/deleteCookie/clearCookies 为 Cookie 查看器扩展，向后兼容新增）
  SESSION_STATUS: 'session:status',
  SESSION_EXPORT: 'session:export',
  SESSION_IMPORT: 'session:import',
  SESSION_COOKIES: 'session:cookies',
  SESSION_DELETE_COOKIE: 'session:deleteCookie',
  SESSION_CLEAR_COOKIES: 'session:clearCookies',

  // 环境配置 - §6.6
  PROFILE_GET: 'profile:get',
  PROFILE_UPDATE: 'profile:update',
  PROFILE_VERIFY: 'profile:verify',
  PROFILE_LOCK: 'profile:lock',
  PROFILE_COPY_CONFIG: 'profile:copyConfig',

  // 概览 - §6.6
  OVERVIEW_STATS: 'overview:stats',
  // 数据中心：汇总所有店铺的数据（店铺分布 / 指标快照 / 邀约与任务运行）
  OVERVIEW_DATACENTER: 'overview:datacenter',
  // 发票中心：汇总各店铺的**待开票信息**（来自发票页 readTable 快照）
  OVERVIEW_INVOICE_CENTER: 'overview:invoiceCenter',
  // 发票中心：把当前待开票清单导出为 CSV（弹保存框；只写文件，不上传）
  OVERVIEW_INVOICE_EXPORT: 'overview:invoiceExport',
  // 手动录入经营指标（平台用反抓取字体渲染数字时，由用户看页面自行录入，来源如实标记为"手动"）
  OVERVIEW_MANUAL_METRIC: 'overview:manualMetric',

  // 任务 - §6.4, §6.6
  TASK_CREATE: 'task:create',
  TASK_LIST: 'task:list',
  TASK_RUN: 'task:run',
  TASK_PAUSE: 'task:pause',
  TASK_RESUME: 'task:resume',
  TASK_CANCEL: 'task:cancel',
  TASK_CONFIRM: 'task:confirm',
  TASK_RESULTS: 'task:results',
  TASK_DELETE: 'task:delete',
  SNAPSHOT_LIST: 'snapshot:list',

  // 备份和锁定 - §6.5（setPassword/removePassword/status 为应用锁扩展）
  BACKUP_CREATE: 'backup:create',
  BACKUP_LIST: 'backup:list',
  BACKUP_RESTORE: 'backup:restore',
  SECURITY_LOCK: 'security:lock',
  SECURITY_UNLOCK: 'security:unlock',
  SECURITY_SET_PASSWORD: 'security:setPassword',
  SECURITY_REMOVE_PASSWORD: 'security:removePassword',
  SECURITY_STATUS: 'security:status',

  // 设置、审计与诊断 - §6.7
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  AUDIT_QUERY: 'audit:query',
  AUDIT_EXPORT: 'audit:export',
  DIAGNOSTICS_EXPORT: 'diagnostics:export',

  // 窗口装饰 - §17（titleBarStyle:'hidden' 融合顶栏：右上角原生窗口按钮
  // overlay 颜色需随 UI 状态切换 —— 欢迎页/工作台/应用锁三种底色）
  WINDOW_SET_TITLEBAR_OVERLAY: 'window:setTitlebarOverlay'
  ,
  // 软件更新
  UPDATE_STATUS: 'update:status',
  UPDATE_CHECK: 'update:check',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_INSTALL: 'update:install',

  // 大模型（AI）配置 - §4.4
  // Key 经 safeStorage 加密只存主进程，IPC 一律只回"是否已配置"，绝不回传 Key 本身
  AI_CONFIG_GET: 'ai:config:get',
  AI_CONFIG_SET: 'ai:config:set',
  AI_KEY_SET: 'ai:key:set',
  AI_KEY_CLEAR: 'ai:key:clear',
  AI_TEST: 'ai:test',
  // 拉取可用模型（只读 GET /models，地址由 /chat/completions 推导）
  AI_MODELS_LIST: 'ai:models:list'
} as const

/**
 * 事件频道名称 - §7
 */
export const EVENT_CHANNELS = {
  STORE_STATUS_CHANGED: 'store:statusChanged',
  BROWSER_TAB_UPDATED: 'browser:tabUpdated',
  BROWSER_LOADING_CHANGED: 'browser:loadingChanged',
  BROWSER_DOWNLOAD_CREATED: 'browser:downloadCreated',
  BROWSER_DOWNLOAD_PROGRESS: 'browser:downloadProgress',
  BROWSER_CRASHED: 'browser:crashed',
  PROXY_HEALTH_CHANGED: 'proxy:healthChanged',
  SESSION_EXPIRED: 'session:expired',
  TASK_PROGRESS: 'task:progress',
  TASK_SCHEDULED_FIRED: 'task:scheduledFired',
  TASK_CONFIRMATION_REQUIRED: 'task:confirmationRequired',
  SECURITY_LOCKED: 'security:locked',
  BACKUP_COMPLETED: 'backup:completed',
  UPDATE_STATUS_CHANGED: 'update:statusChanged',
  UPDATE_PROGRESS: 'update:progress'
} as const
