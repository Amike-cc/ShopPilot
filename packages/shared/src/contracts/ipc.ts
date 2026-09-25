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
  /** 编排器「拾取元素」：在店铺页面上点一下取锚点（自定义任务用） */
  BROWSER_PICK_ELEMENT: 'browser:pickElement',
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
  // 店铺主体：把已采到的 entity.* 快照写进店铺营业执照（空则填；与已填不一致**不覆盖**，如实回报）
  OVERVIEW_ENTITY_APPLY: 'overview:entityApply',
  // 手动录入经营指标（平台用反抓取字体渲染数字时，由用户看页面自行录入，来源如实标记为"手动"）
  OVERVIEW_MANUAL_METRIC: 'overview:manualMetric',

  // 任务 - §6.4, §6.6
  TASK_CREATE: 'task:create',
  /** 测试/诊断用：立即触发某任务（与调度器到点触发同一路径） */
  TASK_CREATE_FIRE: 'task:create:fire',
  TASK_LIST: 'task:list',
  TASK_RUN: 'task:run',
  TASK_PAUSE: 'task:pause',
  TASK_RESUME: 'task:resume',
  TASK_CANCEL: 'task:cancel',
  TASK_CONFIRM: 'task:confirm',
  TASK_RESULTS: 'task:results',
  TASK_DELETE: 'task:delete',
  SNAPSHOT_LIST: 'snapshot:list',

  // 内置 Agent（观察/规划在 Main 执行；任务仍通过现有 task:* 通道管理）
  AGENT_UI_GET: 'agent:ui:get',
  AGENT_UI_SET: 'agent:ui:set',
  AGENT_PAGE_OBSERVE: 'agent:page:observe',
  AGENT_PLAN_GENERATE: 'agent:plan:generate',
  AGENT_PLAN_VALIDATE: 'agent:plan:validate',
  /** 软件级 Agent：只访问本应用已有的店铺、标签页和任务摘要/操作。 */
  AGENT_SOFTWARE_CONTEXT: 'agent:software:context',
  AGENT_SOFTWARE_VALIDATE: 'agent:software:validate',
  AGENT_SOFTWARE_EXECUTE: 'agent:software:execute',
  /** 技能/插件库与 JSON 分享包（导入导出只含声明式定义）。 */
  AGENT_SKILL_LIST: 'agent:skill:list',
  AGENT_SKILL_DELETE: 'agent:skill:delete',
  AGENT_PACK_EXPORT: 'agent:pack:export',
  AGENT_PACK_IMPORT: 'agent:pack:import',

  // 多 Agent 组织、模型、Job 和本地记忆（A-M0～A-M4）
  AGENT_ORG_LIST: 'agent:org:list',
  AGENT_ORG_GET: 'agent:org:get',
  AGENT_ORG_CREATE: 'agent:org:create',
  AGENT_ORG_UPDATE: 'agent:org:update',
  AGENT_ORG_ACTIVATE: 'agent:org:activate',
  AGENT_ORG_PAUSE: 'agent:org:pause',
  AGENT_ORG_RESUME: 'agent:org:resume',
  AGENT_ORG_RETIRE: 'agent:org:retire',
  AGENT_HR_PREVIEW: 'agent:hr:preview',
  AGENT_MODEL_LIST: 'agent:model:list',
  AGENT_MODEL_SET: 'agent:model:set',
  AGENT_MODEL_DELETE: 'agent:model:delete',
  AGENT_MODEL_TEST: 'agent:model:test',
  AGENT_MODEL_BIND: 'agent:model:bind',
  AGENT_JOB_CREATE: 'agent:job:create',
  AGENT_JOB_DELEGATE: 'agent:job:delegate',
  AGENT_JOB_LIST: 'agent:job:list',
  AGENT_JOB_GET: 'agent:job:get',
  AGENT_JOB_RUN: 'agent:job:run',
  AGENT_JOB_CANCEL: 'agent:job:cancel',
  AGENT_JOB_APPROVE: 'agent:job:approve',
  AGENT_JOB_RESULT_REVIEW: 'agent:job:result:review',
  AGENT_JOB_FEEDBACK: 'agent:job:feedback',
  AGENT_JOB_RESUME: 'agent:job:resume',
  AGENT_MEMORY_LIST: 'agent:memory:list',
  AGENT_MEMORY_SEARCH: 'agent:memory:search',
  AGENT_MEMORY_WRITE: 'agent:memory:write',
  AGENT_MEMORY_REVIEW: 'agent:memory:review',
  AGENT_MEMORY_REBUILD: 'agent:memory:rebuild',
  AGENT_MEMORY_SNAPSHOT: 'agent:memory:snapshot',
  AGENT_MEMORY_SNAPSHOT_INSPECT: 'agent:memory:snapshot:inspect',
  AGENT_MEMORY_SNAPSHOT_RESTORE: 'agent:memory:snapshot:restore',
  AGENT_QUALITY_METRICS: 'agent:quality:metrics',
  AGENT_QUALITY_REVIEW: 'agent:quality:review',

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
  AGENT_STATUS_CHANGED: 'agent:statusChanged',
  AGENT_PANEL_OPEN: 'agent:panelOpen',
  AGENT_JOB_PROGRESS: 'agent:jobProgress',
  AGENT_JOB_CONFIRMATION_REQUIRED: 'agent:jobConfirmationRequired',
  AGENT_MEMORY_REVIEW_REQUIRED: 'agent:memoryReviewRequired',
  AGENT_USAGE_UPDATED: 'agent:usageUpdated',
  SECURITY_LOCKED: 'security:locked',
  BACKUP_COMPLETED: 'backup:completed',
  UPDATE_STATUS_CHANGED: 'update:statusChanged',
  UPDATE_PROGRESS: 'update:progress'
} as const
