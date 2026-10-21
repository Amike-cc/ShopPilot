/**
 * IPC 统一返回值类型 - §6
 *
 * 2026-09-26 审计 P2：`details` 已从 `any` 收紧为 `unknown`（错误明细的消费者必须自己收窄）。
 * 默认泛型参数仍是 `any` —— 这是**故意**的：IPC 信封对渲染层是动态边界，具体形状由各调用点
 * 自行声明（`IPCResult<Store[]>`）；改成 `unknown` 会让 25 处调用点失去可读性收益却只换来报错。
 * 本文件因此是 `packages/shared` 里唯一允许显式 `any` 的位置（见下方 eslint-disable 与项目规则）。
 */
/**
 * 通道级契约（IpcContract，文件末尾）的取材来源 —— 全部是 **type-only** 导入：
 * 契约只借用这些 Schema/接口的「类型」，不把它们拉进运行时依赖（preload 打包体积不受影响）。
 */
import type { z } from 'zod'
import type {
  Store,
  storeCreateSchema,
  storeGroupSchema,
  storeIdInputSchema,
  storeReorderSchema,
  storeUpdateSchema
} from '../schemas/store'
import type { TaskCreateInput, TaskResults, TaskScheduledFiredEvent, TaskView } from '../schemas/task'
import type {
  browserCaptureSchema,
  browserClearDataSchema,
  browserDisplaySchema,
  browserInviteSquareSchema,
  browserNavigateSchema,
  browserOpenSchema,
  browserOpenWindowSchema,
  browserPickElementSchema,
  browserReadStoreNameSchema,
  browserRegisterWebviewSchema,
  browserStoreIdSchema,
  browserTabControlSchema,
  browserTabCreateSchema,
  browserTabInputSchema,
  browserTabPinnedSchema,
  browserTabReorderSchema,
  browserTabsCloseManySchema,
  browserViewportSchema,
  browserViewsObscuredSchema
} from '../schemas/browser'
import type {
  browserExtensionIdInputSchema,
  browserExtensionOpenDirSchema,
  browserExtensionSetEnabledSchema,
  browserExtensionSetMasterSchema
} from '../schemas/extension'
import type {
  salesMetricsCollectionInputSchema,
  salesMetricsLatestQuerySchema,
  salesMetricsPlanGetQuerySchema,
  salesMetricsPlanListQuerySchema,
  salesMetricsPlanPauseSchema,
  salesMetricsPlanResumeSchema,
  salesMetricsPlanRunNowSchema,
  salesMetricsPlanUpdateSchema,
  salesMetricsProductQuerySchema,
  salesMetricsQuerySchema,
  salesMetricsRunsQuerySchema
} from '../schemas/sales-metrics'
import type {
  BrowserExtensionImportResult,
  BrowserExtensionListResult,
  BrowserExtensionOpenDirResult
} from '../contracts/extensions'
import type { CustomerMessageCheck, CustomerMessageStatusList } from '../contracts/customer-service'
import type { ShopSessionStatusSummary } from '../contracts/shop-session'
import type { PlatformLoginResult } from '../contracts/platform-adapter'
import type {
  ProductSalesMetrics,
  ProductSalesMetricsListResult,
  SalesMetrics,
  SalesMetricsCollectionResult,
  SalesMetricsHealth,
  SalesMetricsListResult,
  SalesMetricsPlanListResult,
  SalesMetricsPlanView,
  SalesMetricsRunListResult
} from '../contracts/sales-metrics'
import type { CacheClearResult, SoftwareDiagnosticsReport } from '../software-diagnostics'

/* eslint-disable @typescript-eslint/no-explicit-any -- 见文件头说明：IPC 信封默认泛型故意宽松 */
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
    details?: unknown
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
  BROWSER_REGISTER_WEBVIEW: 'browser:registerWebview',
  /** 渲染层上报浏览器内容区域边界，供已注册 webview 同步布局 */
  BROWSER_SET_VIEWPORT: 'browser:setViewport',
  BROWSER_PARTITION_USAGE: 'browser:partitionUsage',
  BROWSER_PARTITION_CLEAN: 'browser:partitionClean',
  BROWSER_TAB_CREATE: 'browser:tab:create',
  BROWSER_TAB_ACTIVATE: 'browser:tab:activate',
  BROWSER_TAB_CLOSE: 'browser:tab:close',
  /** 批量关闭（多选 / 关闭其他 / 关闭全部）：在 Main 侧按真实标签状态计算，避免渲染层列表过期 */
  BROWSER_TAB_CLOSE_MANY: 'browser:tab:closeMany',
  BROWSER_TAB_REORDER: 'browser:tab:reorder',
  BROWSER_TAB_SET_PINNED: 'browser:tab:setPinned',
  BROWSER_TAB_LIST: 'browser:tab:list',
  BROWSER_NAVIGATE: 'browser:navigate',
  /**
   * 在店铺当前标签页的指定视口坐标注入**受信任**鼠标点击（2026-10-21 抖店邀约真机实测新增）。
   *
   * 为什么必须有：达人广场的「在线沟通」按钮带 isTrusted 校验（合成 dispatchEvent 被平台忽略），
   * 而 CDP 直连 guest 的 Input 注入绕不过 webview 的 embedder 输入路由（mousemove 可达、
   * mouseDown 被丢）——只有主进程 `WebContents.sendInputEvent` 走原生输入管线能真正点中
   *（微信分支 realClick 点筛选项已验证同款路径有效）。
   */
  BROWSER_INVITE_CLICK_AT: 'browser:inviteClickAt',
  BROWSER_PREPARE_INVITE_SQUARE: 'browser:prepareInviteSquare',
  /**
   * 邀约台账：近 N 天已邀过的达人昵称（默认 7 天）。
   * 面板「开始邀约」时取它 → 交给任务，点「详情」时跳过这些行（7 天内不重复邀约）。
   */
  INVITE_RECENT_HISTORY: 'invite:recentHistory',
  /** 达人邀约 v2：批次与逐人记录（渲染层只读/启动，执行仍在 TaskRunner） */
  INVITE_CAMPAIGN_START: 'invite:campaign:start',
  INVITE_CAMPAIGN_LIST: 'invite:campaign:list',
  INVITE_CAMPAIGN_DETAIL: 'invite:campaign:detail',
  /** 取消排期（只对 status=scheduled 生效） */
  INVITE_CAMPAIGN_CANCEL: 'invite:campaign:cancel',
  INVITE_RECORDS_LIST: 'invite:records:list',
  INVITE_RECORDS_SUMMARY: 'invite:records:summary',
  INVITE_RECORDS_UPDATE_STATUS: 'invite:records:updateStatus',
  INVITE_QUOTA_GET: 'invite:quota:get',
  INVITE_CREATORS_LIST: 'invite:creators:list',
  INVITE_CREATORS_UPDATE: 'invite:creators:update',
  INVITE_CREATORS_BLACKLIST: 'invite:creators:blacklist',
  INVITE_SCRIPTS_LIST: 'invite:scripts:list',
  INVITE_SCRIPTS_SAVE: 'invite:scripts:save',
  INVITE_SCRIPTS_DELETE: 'invite:scripts:delete',
  INVITE_PRODUCT_SETS_LIST: 'invite:productSets:list',
  INVITE_PRODUCT_SETS_SAVE: 'invite:productSets:save',
  INVITE_PRODUCT_SETS_DELETE: 'invite:productSets:delete',
  BROWSER_TAB_CONTROL: 'browser:tab:control',   // 前进/后退/重载（地址栏）
  BROWSER_CLEAR_DATA: 'browser:clearData',
  BROWSER_CAPTURE: 'browser:capture',
  BROWSER_OPEN_WINDOW: 'browser:openWindow',
  /** 编排器「拾取元素」：在店铺页面上点一下取锚点（自定义任务用） */
  BROWSER_PICK_ELEMENT: 'browser:pickElement',
  /** 渲染层弹层遮挡时暂时隐藏已注册 webview，恢复后重新显示 */
  BROWSER_SET_VIEWS_OBSCURED: 'browser:setViewsObscured',
  /** 只读浏览器状态：当前显示的店铺 + 各已打开店铺的标签页（渲染层重载后按它补齐，不靠猜） */
  BROWSER_STATE: 'browser:state',
  /** 只读内存/WebContents诊断，供性能采样使用，不改变页面行为 */
  BROWSER_MEMORY_DIAGNOSTICS: 'browser:memoryDiagnostics',
  /** 从店铺页面读出真实店铺名（只读页面；返回的是**建议值**，改名仍走 store:update 由人确认） */
  BROWSER_READ_STORE_NAME: 'browser:readStoreName',

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
  /** 主进程按当前店铺页面执行一次受限平台登录检测；只返回安全摘要。 */
  SESSION_CHECK_LOGIN_STATUS: 'session:checkLoginStatus',
  SESSION_EXPORT: 'session:export',
  SESSION_IMPORT: 'session:import',
  SESSION_COOKIES: 'session:cookies',
  SESSION_DELETE_COOKIE: 'session:deleteCookie',
  SESSION_CLEAR_COOKIES: 'session:clearCookies',


  // 商品管理（商品管理方案 §5）：同步是**只读采集**；列表与台账供只读商品页使用。
  // 发布不在这里——发布必须走任务引擎 + 人工确认门禁（方案 §7.9）。
  PRODUCT_SYNC: 'products:sync',
  PRODUCT_SYNC_FULL: 'products:syncFull',
  /** 请求中断进行中的全量详情采集（2026-10-21 审查 P2-5：此前 5000 条串行无法取消）。 */
  PRODUCT_SYNC_FULL_CANCEL: 'products:syncFullCancel',
  PRODUCT_LIST: 'products:list',
  PRODUCT_SYNC_RUNS: 'products:syncRuns',
  // 本地商品库（M2）：归并**必须由用户触发**（方案 D2：绝不自动合并）；
  // 图片本地化只下载图片到本机，不碰平台任何数据。
  PRODUCT_LIBRARY_LIST: 'products:library:list',
  PRODUCT_LIBRARY_GET: 'products:library:get',
  PRODUCT_LIBRARY_SAVE: 'products:library:save',
  PRODUCT_LIBRARY_SAVE_AS: 'products:library:saveAsLocal',
  PRODUCT_LIBRARY_MERGE: 'products:library:merge',
  PRODUCT_LIBRARY_UNMERGE: 'products:library:unmerge',
  PRODUCT_LIBRARY_REMOVE: 'products:library:remove',
  // v4 重设计（2026-10-15）：回收站列表 / 恢复（软删可逆；恢复不自动重挂平台归并——D2）
  PRODUCT_LIBRARY_TRASH: 'products:library:trash',
  PRODUCT_LIBRARY_RESTORE: 'products:library:restore',
  // v4 R2（2026-10-15）：新建空白商品 / 复制（媒体 sha256 复用）/ 归档流转 / 彻底删除（无发布记录才可）
  PRODUCT_LIBRARY_CREATE: 'products:library:create',
  PRODUCT_LIBRARY_DUPLICATE: 'products:library:duplicate',
  PRODUCT_LIBRARY_SET_ARCHIVED: 'products:library:setArchived',
  PRODUCT_LIBRARY_PURGE: 'products:library:purge',
  PRODUCT_MEDIA_LOCALIZE: 'products:media:localize',
  // v4 R2：编辑器媒体分区「添加本地图片」（主进程校验类型/大小后入 product-media）
  PRODUCT_MEDIA_IMPORT_LOCAL: 'products:media:importLocal',
  // v4 R3：批量（预览 → 确认执行 → 回执）+ CSV 导出/导入
  PRODUCT_LIBRARY_BATCH_PREVIEW: 'products:library:batchPreview',
  PRODUCT_LIBRARY_BATCH_EXECUTE: 'products:library:batchExecute',
  PRODUCT_LIBRARY_EXPORT_CSV: 'products:library:exportCsv',
  PRODUCT_LIBRARY_IMPORT_PREVIEW: 'products:library:importPreview',
  PRODUCT_LIBRARY_IMPORT_EXECUTE: 'products:library:importExecute',
  PRODUCT_LIBRARY_IMPORT_TEMPLATE: 'products:library:importTemplate',
  // 详情页采集（商品图 + 规格）：只导航并读 DOM，不填写不提交
  PRODUCT_DETAIL_COLLECT: 'products:detail:collect',
  // 发布（M3）：**只到人工确认门禁为止** —— 预检与打开发布页，没有任何提交动作
  PRODUCT_PUBLISH_PREFLIGHT: 'products:publish:preflight',
  PRODUCT_PUBLISH_OPEN: 'products:publish:open',
  PRODUCT_PUBLISH_ITEMS: 'products:publish:items',
  // 人工确认门禁（走任务引擎的 waitForUserConfirmation）：只开/放行门禁与只读回读，**不提交**
  PRODUCT_PUBLISH_OPEN_GATE: 'products:publish:openGate',
  PRODUCT_PUBLISH_CONFIRM: 'products:publish:confirm',
  PRODUCT_PUBLISH_VERIFY: 'products:publish:verify',
  // 回读闭环（M4，方案 §7.5）：readback 只读页面产出建议，accept 是**用户逐条确认后**才落库
  PRODUCT_PUBLISH_READBACK: 'products:publish:readback',
  PRODUCT_PUBLISH_ACCEPT: 'products:publish:acceptSuggestion',
  PRODUCT_PUBLISH_CHECKLIST: 'products:publish:checklist',
  // 批量编排（M5，方案 §7.8）：只建台账/看进度/跳过这家，**没有任何提交能力**
  PRODUCT_PUBLISH_BATCH_CREATE: 'products:publish:batch:create',
  PRODUCT_PUBLISH_BATCH_PROGRESS: 'products:publish:batch:progress',
  PRODUCT_PUBLISH_BATCH_SKIP_STORE: 'products:publish:batch:skipStore',
  // 「全部暂停」：只退回"正在跑"的，已经在等人工的保持等待（人工交接点不该被冲掉）
  PRODUCT_PUBLISH_BATCH_ABORT: 'products:publish:batch:abort',
  // 图片本地化队列与保留策略：scan 只算、run 逐张下、orphans 只判定、cleanup 用户确认后才删
  PRODUCT_MEDIA_QUEUE_SCAN: 'products:media:queueScan',
  PRODUCT_MEDIA_QUEUE_RUN: 'products:media:queueRun',
  PRODUCT_MEDIA_ORPHANS: 'products:media:orphans',
  PRODUCT_MEDIA_CLEANUP: 'products:media:cleanup',

  // 经营指标：只传店铺 ID、周期和分页参数；主进程负责 Session/平台校验。
  SALES_METRICS_COLLECT: 'salesMetrics:collect',
  SALES_METRICS_LATEST: 'salesMetrics:latest',
  SALES_METRICS_LIST: 'salesMetrics:list',
  SALES_METRICS_PRODUCTS: 'salesMetrics:products',
  SALES_METRICS_TOP_PRODUCTS: 'salesMetrics:topProducts',
  // 采集计划管理（§9）：计划/运行记录/健康汇总。Renderer 只能传 storeId、周期、分页和状态过滤。
  SALES_METRICS_PLAN_LIST: 'salesMetrics:plan:list',
  SALES_METRICS_PLAN_GET: 'salesMetrics:plan:get',
  SALES_METRICS_PLAN_UPDATE: 'salesMetrics:plan:update',
  SALES_METRICS_PLAN_PAUSE: 'salesMetrics:plan:pause',
  SALES_METRICS_PLAN_RESUME: 'salesMetrics:plan:resume',
  SALES_METRICS_PLAN_RUN_NOW: 'salesMetrics:plan:runNow',
  SALES_METRICS_RUNS_LIST: 'salesMetrics:runs:list',
  SALES_METRICS_HEALTH: 'salesMetrics:health',

  // 电商客服消息监控：只返回安全摘要；工作区独立，店铺登录 Session 共享。
  CUSTOMER_SERVICE_PREPARE: 'customerService:prepare',
  CUSTOMER_SERVICE_STATUS_LIST: 'customerService:status:list',
  CUSTOMER_SERVICE_CHECK_NOW: 'customerService:checkNow',

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
  // 涉税信息报送：汇总各店铺平台侧报送的经营数据（来自涉税报送页 readTable 快照）；
  // 随数据一起返回平台自己的用途限制（该数据不得作为税务申报依据）
  OVERVIEW_TAX_REPORT: 'overview:taxReport',
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
  /** 修改任务定义（名称/店铺范围/步骤/计划）。没有运行中记录时才允许改步骤。 */
  TASK_UPDATE: 'task:update',
  SNAPSHOT_LIST: 'snapshot:list',

  // 内置 Agent：普通文本对话与抽屉 UI 状态；不提供页面/软件操作能力。
  AGENT_UI_GET: 'agent:ui:get',
  AGENT_UI_SET: 'agent:ui:set',
  AGENT_CHAT: 'agent:chat',
  /** 旧版 Agent 操作通道保留用于返回明确的禁用错误，不再执行任何操作。 */
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
  AGENT_SKILL_UPDATE: 'agent:skill:update',
  /** 用户在面板里直接创建技能（与模型 createSkill 同一套校验），以及表单可选的工具目录。 */
  AGENT_SKILL_CREATE: 'agent:skill:create',
  AGENT_SKILL_TOOLS: 'agent:skill:tools',
  /** 面板改/删插件（插件是技能分组，改成员技能名即改分组）。 */
  AGENT_PLUGIN_UPDATE: 'agent:plugin:update',
  AGENT_PLUGIN_DELETE: 'agent:plugin:delete',
  AGENT_PACK_EXPORT: 'agent:pack:export',
  AGENT_PACK_IMPORT: 'agent:pack:import',
  /** Job 结束后自动续办（把结果交给智能体回合判断下一步）。 */
  AGENT_JOB_FOLLOW_UP: 'agent:job:followUp',

  // Agent 域（当前运行时仅 root-ceo；旧组织/HR 通道保留兼容）
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
  AGENT_MEMORY_LEARNING_SETTINGS: 'agent:memory:learning-settings',
  AGENT_MEMORY_MAINTENANCE: 'agent:memory:maintenance',
  AGENT_QUALITY_METRICS: 'agent:quality:metrics',
  AGENT_QUALITY_REVIEW: 'agent:quality:review',
  AGENT_COMMERCE_LEDGER_LIST: 'agent:commerce:ledger:list',

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

  // 缓存清理与软件自检（设置中心「数据与维护」）——2026-10-16 新增
  MAINTENANCE_CLEAR_APP_CACHE: 'maintenance:clearAppCache',
  MAINTENANCE_CLEAR_BROWSER_CACHE: 'maintenance:clearBrowserCache',
  MAINTENANCE_SOFTWARE_DIAGNOSTICS: 'maintenance:softwareDiagnostics',

  // 浏览器扩展（本地解包，实验性；2026-10-17）
  EXTENSION_LIST: 'extensions:list',
  EXTENSION_IMPORT: 'extensions:import',
  EXTENSION_SET_ENABLED: 'extensions:setEnabled',
  EXTENSION_SET_MASTER: 'extensions:setMaster',
  EXTENSION_REMOVE: 'extensions:remove',
  EXTENSION_RELOAD: 'extensions:reload',
  EXTENSION_OPEN_DIR: 'extensions:openDir',

  // 窗口装饰 - §17（titleBarStyle:'hidden' 融合顶栏：右上角原生窗口按钮
  // overlay 颜色需随 UI 状态切换 —— 欢迎页/工作台/应用锁三种底色）
  WINDOW_SET_TITLEBAR_OVERLAY: 'window:setTitlebarOverlay',
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
  AI_MODELS_LIST: 'ai:models:list',
  // 生图 API 独立配置与凭据；不会读取或覆盖文本 AI 配置
  AI_IMAGE_CONFIG_GET: 'ai:image:config:get',
  AI_IMAGE_CONFIG_SET: 'ai:image:config:set',
  AI_IMAGE_KEY_SET: 'ai:image:key:set',
  AI_IMAGE_KEY_CLEAR: 'ai:image:key:clear',
  AI_IMAGE_TEST: 'ai:image:test',
  AI_IMAGE_MODELS_LIST: 'ai:image:models:list',
  // AI 生成商品图片页面的商品分析文本 API；与 Agent 文本配置完全分离
  AI_IMAGE_TEXT_CONFIG_GET: 'ai:image-text:config:get',
  AI_IMAGE_TEXT_CONFIG_SET: 'ai:image-text:config:set',
  AI_IMAGE_TEXT_KEY_SET: 'ai:image-text:key:set',
  AI_IMAGE_TEXT_KEY_CLEAR: 'ai:image-text:key:clear',
  AI_IMAGE_TEXT_TEST: 'ai:image-text:test',
  AI_IMAGE_TEXT_MODELS_LIST: 'ai:image-text:models:list',
  AI_IMAGE_TEXT_ANALYZE: 'ai:image-text:analyze',
  // 图文带货文案生成：渲染层只提交受限结构化字段，提示词组装与 JSON 解析都在主进程（防注入）
  AI_IMAGE_TEXT_SELL_COPY: 'ai:image-text:sell-copy',
  // 生成图片（主进程持有 API Key，渲染层只提交受限提示词）
  AI_IMAGE_GENERATE: 'ai:image:generate',
  // 保存生成结果到本地磁盘（另存为对话框；带 outputPath 时直接写该路径，供验收脚本使用）
  AI_IMAGE_SAVE: 'ai:image:save',
  // 在文件管理器里定位刚保存的图片
  AI_IMAGE_REVEAL: 'ai:image:reveal'
} as const

/**
 * 事件频道名称 - §7
 */
export const EVENT_CHANNELS = {
  STORE_STATUS_CHANGED: 'store:statusChanged',
  BROWSER_TAB_UPDATED: 'browser:tabUpdated',
  /**
   * 当前显示的是哪家店（或 null = 收起）。
   *
   * 为什么必须有：主进程会**单方面**显示店铺——`openStoreBrowser` 内部就 displayStore，
   * 而采集任务（UnifiedDataPage 批量开店铺）与 Agent（逐店动作）都会走它。此前没有任何
   * 事件把"现在显示的是谁"告诉渲染层，于是原生店铺视图会盖在当前 UI（数据分析/设置…）之上，
   * 而左栏高亮、标签栏、地址栏都还停在旧状态，用户无法用界面纠正（2026-09-28 审查确认）。
   */
  BROWSER_DISPLAY_CHANGED: 'browser:displayChanged',
  BROWSER_LOADING_CHANGED: 'browser:loadingChanged',
  BROWSER_DOWNLOAD_CREATED: 'browser:downloadCreated',
  BROWSER_DOWNLOAD_PROGRESS: 'browser:downloadProgress',
  BROWSER_CRASHED: 'browser:crashed',
  /**
   * 店铺页面内的批量关闭快捷键（Ctrl+Shift+W 全部 / Ctrl+Alt+W 其他）。
   *
   * 为什么走事件而不是主进程直接关：批量关闭必须先弹二次确认，确认 UI 在渲染层；
   * 而 `before-input-event` 是主进程在页面拿到按键之前唯一可靠的拦截点
   *（页面脚本可以吞掉 keydown，但吞不掉它）。
   */
  BROWSER_TAB_CLOSE_REQUESTED: 'browser:tab:closeRequested',
  PROXY_HEALTH_CHANGED: 'proxy:healthChanged',
  SESSION_EXPIRED: 'session:expired',
  /**
   * 全量商品同步「详情阶段」的实时进度（2026-10-21 审查 P2-5）。
   * payload：{ storeId, total, done, succeeded, failed, skipped, incomplete, canceled? }——
   * 只有计数与店铺 id，不携带商品正文；done===total 时为最后一帧（canceled 标记是否被用户中断）。
   */
  PRODUCT_SYNC_FULL_PROGRESS: 'products:syncFullProgress',
  TASK_PROGRESS: 'task:progress',
  TASK_SCHEDULED_FIRED: 'task:scheduledFired',
  TASK_CONFIRMATION_REQUIRED: 'task:confirmationRequired',
  /**
   * 经营数据自动采集的实时事件（§10）。
   *
   * 四个事件只允许携带 storeId / platform / runId / status / reasonCode / collectedAt /
   * nextRunAt / consecutiveFailures / freshness——不携带 Cookie、Session、WebContents、
   * 页面正文或完整网络响应。前端据此刷新状态卡，不允许把这些值当业务数据直接写库。
   */
  SALES_METRICS_PLAN_UPDATED: 'salesMetrics:planUpdated',
  SALES_METRICS_RUN_STARTED: 'salesMetrics:runStarted',
  SALES_METRICS_RUN_FINISHED: 'salesMetrics:runFinished',
  SALES_METRICS_HEALTH_CHANGED: 'salesMetrics:healthChanged',
  CUSTOMER_SERVICE_STATUS_CHANGED: 'customerService:statusChanged',
  /** 客服有新消息（未读从少变多）：界面据此挂红点并响提示音；桌面通知由主进程直接弹 */
  CUSTOMER_SERVICE_NEW_MESSAGE: 'customerService:newMessage',
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

/* ==========================================================================================
 * 通道级 IPC 契约（IpcContract）—— 2026-10-19
 *
 * 为什么要有这一层：信封 `IPCResult` 只表达「成功/失败」，成功体的形状此前只能由每个调用点
 * 手写泛型（`IPCResult<Store[]>`）——写错了没有任何东西会拦。这里把「通道 → { req, res }」
 * 收敛成**一处声明**，preload 的类型化 invoke 直接由它推导，主进程/渲染层也能各自引用。
 *
 * 收录规则（刻意只覆盖核心域，不做 280+ 通道的一次性硬编码，其余留扩展位）：
 *   · req —— 优先取**主进程真正用于校验的 shared Zod schema**：`z.input<typeof …>` 是
 *             「渲染层实际传过来的那一侧」，带 `.default()` 的字段因此是可选的；
 *             没有 schema 的通道按 handler 声明的入参形状写，handler 里可省的字段这里也可省。
 *   · res —— 只在能确证时写：handler 返回的字面量、shared 里已有的契约接口，或主进程里
 *             强类型函数的返回类型。**确证不了的一律写 `IpcUnresolved`（unknown）**，
 *             不许编造；调用点必须自己收窄。
 *   · 本层不 import electron（shared 是主/渲共用纯规则层）：`createIpcInvoker` 只做类型收窄，
 *     真正的 `ipcRenderer.invoke` 由 preload 注入。
 *
 * 已覆盖 12 个域 / 106 个通道：store · browser(+tab) · invite · task · snapshot · security ·
 * session · settings · customerService · salesMetrics · extensions · maintenance。
 * 仍是扩展位（preload 继续走原来的 `ipcRenderer.invoke(...)`，行为不变，可按同一规则逐域接入）：
 * products / ai / proxy / bookmark / download / profile / overview / audit / diagnostics /
 * backup / windowChrome / update / agent，以及 IPC_CHANNELS 里本就没有 preload 方法的通道。
 * ========================================================================================== */

/**
 * 「扩展位」标记：主进程 handler 侧没有强类型（返回 `IPCResult` 默认 any），
 * 响应形状尚未收敛 —— 如实标注为 unknown，而不是编一个看起来很像的形状。
 */
export type IpcUnresolved = unknown

/** `browser:tab:list` 的标签摘要（形状与 window-manager.getStoreTabs 的映射一致）。 */
export interface IpcBrowserTabSummary {
  id: string
  url: string
  title: string
  isPinned: boolean
  orderIndex: number
  guestAttached: boolean
}

/** `browser:state` 的标签摘要：比 tab:list 多一个「采集专用页」标记（不进标签栏）。 */
export interface IpcBrowserTabState extends IpcBrowserTabSummary {
  internal: boolean
}

/** `browser:state` 里每家已打开店铺的摘要。 */
export interface IpcBrowserStoreState {
  storeId: string
  activeTabId: string | null
  tabs: IpcBrowserTabState[]
}

/** 应用锁状态：与 main/services/security-manager.ts 的 `LockStatus` 同形（该类型不在 shared）。 */
export interface IpcLockStatus {
  /** 是否设置了主密码 */
  enabled: boolean
  locked: boolean
  idleMinutes: number
}

/** Cookie 查看器的一行：只回「存在性掩码」，不回 Cookie 原文。 */
export interface IpcCookieSummary {
  name: string
  domain: string
  path: string
  /** 有值即 `••••••`，没有值就是空串；不携带前缀或长度信息 */
  valuePreview: string
  secure: boolean
  httpOnly: boolean
  session: boolean
  /** 已是本地化文案（`会话结束` 或 zh-CN 时间串） */
  expires: string
}

/** `snapshot:list` 的巡检快照行（task-store.listSnapshots 的返回形状）。 */
export interface IpcSnapshotRow {
  id: string
  metric: string
  value: unknown
  sourceRunId: string | null
  capturedAt: number
}

/**
 * 通道 → { req, res } 映射。
 *
 * 约束：键必须是 `IPC_CHANNELS` 里真实存在的通道取值（见文件末尾的编译期守卫），
 * 但**不要求**覆盖全部通道 —— 没列出的通道继续走旧的 `IPCResult<any>` 宽松路径。
 */
export interface IpcContract {
  // ------------------------------ 店铺管理 §6.1 ------------------------------
  'store:list': { req: void; res: Store[] }
  'store:get': { req: z.input<typeof storeIdInputSchema>; res: Store }
  'store:create': { req: z.input<typeof storeCreateSchema>; res: Store }
  'store:update': { req: z.input<typeof storeUpdateSchema>; res: Store }
  'store:archive': { req: z.input<typeof storeIdInputSchema>; res: { success: true } }
  'store:restore': { req: z.input<typeof storeIdInputSchema>; res: { success: true } }
  'store:deletePermanent': { req: z.input<typeof storeIdInputSchema>; res: { success: true } }
  'store:reorder': { req: z.input<typeof storeReorderSchema>; res: { success: true } }
  'store:setGroup': { req: z.input<typeof storeGroupSchema>; res: { success: true } }
  'store:trashList': { req: void; res: Store[] }
  'store:purge': { req: z.input<typeof storeIdInputSchema>; res: { success: true } }

  // ------------------------------ 浏览器与标签页 §6.2 ------------------------------
  'browser:open': { req: z.input<typeof browserOpenSchema>; res: { success: true } }
  'browser:close': { req: z.input<typeof browserStoreIdSchema>; res: { success: true } }
  'browser:display': {
    req: z.input<typeof browserDisplaySchema>
    res: { success: true; displayedStoreId: string | null }
  }
  'browser:registerWebview': { req: z.input<typeof browserRegisterWebviewSchema>; res: IpcUnresolved }
  'browser:setViewport': { req: z.input<typeof browserViewportSchema>; res: { success: true } }
  'browser:partitionUsage': { req: void; res: IpcUnresolved }
  /** 只清该店铺分区：返回被清掉的目录名清单 */
  'browser:partitionClean': { req: { storeId: string }; res: { cleared: string[] } }
  'browser:setViewsObscured': {
    req: z.input<typeof browserViewsObscuredSchema>
    /** reason 已被主进程归一化：不传即 'modal' */
    res: { obscured: boolean; reason: 'modal' | 'agent' }
  }
  'browser:tab:create': { req: z.input<typeof browserTabCreateSchema>; res: { tabId: string } }
  'browser:tab:activate': { req: z.input<typeof browserTabInputSchema>; res: { success: true } }
  'browser:tab:close': { req: z.input<typeof browserTabInputSchema>; res: { success: true } }
  'browser:tab:closeMany': { req: z.input<typeof browserTabsCloseManySchema>; res: IpcUnresolved }
  'browser:tab:reorder': { req: z.input<typeof browserTabReorderSchema>; res: { success: true } }
  'browser:tab:setPinned': { req: z.input<typeof browserTabPinnedSchema>; res: { success: true } }
  'browser:tab:list': { req: z.input<typeof browserStoreIdSchema>; res: { tabs: IpcBrowserTabSummary[] } }
  'browser:tab:control': { req: z.input<typeof browserTabControlSchema>; res: { success: true } }
  'browser:navigate': { req: z.input<typeof browserNavigateSchema>; res: { success: true } }
  /** 邀约专用受信任点击（坐标为店铺当前标签页的视口坐标） */
  'browser:inviteClickAt': { req: { storeId: string; x: number; y: number }; res: { success: true; clicked: { x: number; y: number } } }
  'browser:prepareInviteSquare': { req: z.input<typeof browserInviteSquareSchema>; res: IpcUnresolved }
  'browser:clearData': { req: z.input<typeof browserClearDataSchema>; res: { success: true } }
  'browser:capture': {
    req: z.input<typeof browserCaptureSchema>
    /** data 是 dataURL；savedPath 是「已保存」的唯一凭据 */
    res: { format: 'png' | 'jpeg'; data: string; savedPath: string; bytes: number }
  }
  'browser:pickElement': { req: z.input<typeof browserPickElementSchema>; res: IpcUnresolved }
  'browser:openWindow': { req: z.input<typeof browserOpenWindowSchema>; res: { success: true } }
  'browser:state': {
    req: void
    res: { displayedStoreId: string | null; stores: IpcBrowserStoreState[] }
  }
  'browser:memoryDiagnostics': { req: void; res: IpcUnresolved }
  'browser:readStoreName': { req: z.input<typeof browserReadStoreNameSchema>; res: IpcUnresolved }

  // ------------------------------ 达人邀约 v2 ------------------------------
  /** 邀约台账：近 N 天已邀过的达人昵称（默认 7 天） */
  'invite:recentHistory': { req: { storeId: string; days?: number; limit?: number }; res: IpcUnresolved }
  /** 批次启动：入参形状在主进程侧（InviteCampaignStartInput 不在 shared），只约定是 JSON 对象 */
  'invite:campaign:start': { req: Record<string, unknown>; res: IpcUnresolved }
  'invite:campaign:list': { req: { storeId?: string; limit?: number }; res: IpcUnresolved }
  'invite:campaign:detail': { req: { campaignId: string }; res: IpcUnresolved }
  'invite:campaign:cancel': { req: { campaignId: string }; res: IpcUnresolved }
  'invite:records:list': {
    req: { storeId?: string; campaignId?: string; status?: string; limit?: number; offset?: number }
    res: IpcUnresolved
  }
  'invite:records:summary': { req: { storeId?: string }; res: IpcUnresolved }
  'invite:records:updateStatus': {
    req: { id: string; storeId: string; status: string; reason?: string }
    res: { updated: true }
  }
  'invite:quota:get': { req: { storeId: string }; res: IpcUnresolved }
  'invite:creators:list': {
    req: { storeId?: string; platform?: string; query?: string; blacklisted?: boolean; limit?: number }
    res: IpcUnresolved
  }
  'invite:creators:update': { req: Record<string, unknown>; res: IpcUnresolved }
  'invite:creators:blacklist': { req: { storeId: string; platform: string }; res: { nicknames: string[] } }
  'invite:scripts:list': { req: { storeId?: string; platform?: string }; res: IpcUnresolved }
  'invite:scripts:save': { req: Record<string, unknown>; res: IpcUnresolved }
  'invite:scripts:delete': { req: { id: string; storeId: string }; res: IpcUnresolved }
  'invite:productSets:list': { req: { storeId?: string; platform?: string }; res: IpcUnresolved }
  'invite:productSets:save': { req: Record<string, unknown>; res: IpcUnresolved }
  'invite:productSets:delete': { req: { id: string; storeId: string }; res: IpcUnresolved }

  // ------------------------------ 任务引擎 §6.4 §6.6 ------------------------------
  'task:create': { req: TaskCreateInput; res: TaskView }
  'task:list': { req: void; res: TaskView[] }
  /** 手动触发：返回入队结果 + 「店铺浏览器没开，先等店铺」提示位 */
  'task:run': {
    req: { taskId: string; storeId?: string }
    res: { runId: string; storeId: string; waitingForStore: boolean }
  }
  'task:pause': { req: { runId: string }; res: { success: true } }
  'task:resume': { req: { runId: string; mode?: 'continue' | 'retry' }; res: { success: true } }
  'task:cancel': { req: { runId: string }; res: { success: true } }
  'task:confirm': { req: { runId: string; approved: boolean }; res: { success: true } }
  'task:results': { req: { runId: string }; res: TaskResults }
  'task:delete': { req: { taskId: string }; res: { success: true } }
  /** 与 task-store.TaskUpdateInput 同形：未传的字段保留原值 */
  'task:update': {
    req: { taskId: string; name?: string; storeScope?: string | null; steps?: TaskCreateInput['steps']; schedule?: unknown }
    res: TaskView
  }
  /** 诊断/验收用：立即触发定时任务，返回与到点触发同一个事件体 */
  'task:create:fire': { req: { taskId: string }; res: TaskScheduledFiredEvent }
  'snapshot:list': { req: { storeId: string; limit?: number }; res: IpcSnapshotRow[] }

  // ------------------------------ 会话 §6.3 ------------------------------
  /** 只回 Session 安全摘要 + 代理绑定摘要（proxyId/mode），不回 partition/Cookie/凭据 */
  'session:status': {
    req: { storeId: string }
    res: ShopSessionStatusSummary & { binding: { mode: string; proxyId: string | null } | null }
  }
  /** 主动检测平台登录态：安全摘要 + platformLogin（第一阶段只含安全结果字段） */
  'session:checkLoginStatus': {
    req: { storeId: string }
    res: ShopSessionStatusSummary & { platformLogin: PlatformLoginResult }
  }
  'session:export': {
    req: { storeId: string; outputPath?: string; validDays?: number }
    res: IpcUnresolved
  }
  'session:import': {
    req: { storeId: string; filePath?: string; pickFile?: boolean }
    res: IpcUnresolved
  }
  'session:cookies': {
    req: { storeId: string; search?: string }
    /** total 是过滤前的总数，items 最多 300 条（界面据此提示"只显示前 300 条"） */
    res: { total: number; items: IpcCookieSummary[] }
  }
  'session:deleteCookie': {
    req: { storeId: string; name: string; domain: string; path: string; secure?: boolean }
    res: { removed: true }
  }
  'session:clearCookies': { req: { storeId: string }; res: { cleared: true } }

  // ------------------------------ 设置 / 审计 §6.7 ------------------------------
  'settings:get': { req: { key: string }; res: { key: string; value: unknown } }
  'settings:set': { req: { key: string; value: unknown }; res: { success: true } }

  // ------------------------------ 电商客服 ------------------------------
  'customerService:prepare': {
    req: { storeId: string }
    res: { storeId: string; platform: string; url: string }
  }
  'customerService:status:list': {
    req: { storeId?: string; limit?: number }
    res: CustomerMessageStatusList
  }
  'customerService:checkNow': { req: { storeId: string }; res: CustomerMessageCheck }

  // ------------------------------ 经营指标 §9 ------------------------------
  'salesMetrics:collect': {
    req: z.input<typeof salesMetricsCollectionInputSchema>
    res: SalesMetricsCollectionResult
  }
  'salesMetrics:latest': {
    req: z.input<typeof salesMetricsLatestQuerySchema>
    res: SalesMetrics | null
  }
  'salesMetrics:list': { req: z.input<typeof salesMetricsQuerySchema>; res: SalesMetricsListResult }
  'salesMetrics:products': {
    req: z.input<typeof salesMetricsProductQuerySchema>
    res: ProductSalesMetricsListResult
  }
  'salesMetrics:topProducts': {
    req: z.input<typeof salesMetricsProductQuerySchema>
    res: ProductSalesMetrics[]
  }
  'salesMetrics:plan:list': {
    req: z.input<typeof salesMetricsPlanListQuerySchema>
    res: SalesMetricsPlanListResult
  }
  'salesMetrics:plan:get': {
    req: z.input<typeof salesMetricsPlanGetQuerySchema>
    res: SalesMetricsPlanView
  }
  'salesMetrics:plan:update': {
    req: z.input<typeof salesMetricsPlanUpdateSchema>
    res: SalesMetricsPlanView
  }
  'salesMetrics:plan:pause': {
    req: z.input<typeof salesMetricsPlanPauseSchema>
    res: SalesMetricsPlanView
  }
  'salesMetrics:plan:resume': {
    req: z.input<typeof salesMetricsPlanResumeSchema>
    res: SalesMetricsPlanView
  }
  /** 立即采集：只入队，结果由 salesMetrics:runFinished 事件回报 */
  'salesMetrics:plan:runNow': {
    req: z.input<typeof salesMetricsPlanRunNowSchema>
    res: { accepted: true; storeId: string; mode: 'SCHEDULED_IMMEDIATE'; reasonCode: string }
  }
  'salesMetrics:runs:list': {
    req: z.input<typeof salesMetricsRunsQuerySchema>
    res: SalesMetricsRunListResult
  }
  'salesMetrics:health': { req: void; res: SalesMetricsHealth }

  // ------------------------------ 浏览器扩展（本地解包，实验性） ------------------------------
  'extensions:list': { req: void; res: BrowserExtensionListResult }
  'extensions:import': { req: void; res: BrowserExtensionImportResult }
  'extensions:setEnabled': {
    req: z.input<typeof browserExtensionSetEnabledSchema>
    res: BrowserExtensionListResult
  }
  'extensions:setMaster': {
    req: z.input<typeof browserExtensionSetMasterSchema>
    res: BrowserExtensionListResult
  }
  'extensions:remove': {
    req: z.input<typeof browserExtensionIdInputSchema>
    res: BrowserExtensionListResult
  }
  'extensions:reload': {
    req: z.input<typeof browserExtensionIdInputSchema>
    res: BrowserExtensionListResult
  }
  'extensions:openDir': {
    req: z.input<typeof browserExtensionOpenDirSchema>
    res: BrowserExtensionOpenDirResult
  }

  // ------------------------------ 缓存清理与软件自检 ------------------------------
  'maintenance:clearAppCache': { req: void; res: CacheClearResult }
  'maintenance:clearBrowserCache': { req: void; res: CacheClearResult }
  'maintenance:softwareDiagnostics': { req: void; res: SoftwareDiagnosticsReport }

  // ------------------------------ 应用锁 §6.5 ------------------------------
  'security:status': { req: void; res: IpcLockStatus }
  'security:setPassword': {
    req: { password?: string; oldPassword?: string }
    res: { ok: boolean }
  }
  'security:removePassword': { req: { credential?: string }; res: { ok: boolean } }
  'security:lock': { req: void; res: { locked: true } }
  'security:unlock': { req: { credential: string }; res: { locked: false } }
}

/** IPC_CHANNELS 里所有通道取值的联合（含尚未接入契约的扩展位）。 */
export type IpcChannelValue = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

/** 已接入契约的通道取值（可作 `IpcRequest` / `IpcResponse` 的类型参数）。 */
export type IpcChannel = keyof IpcContract

/** 某个通道的请求体类型（无请求体的通道是 `void`）。 */
export type IpcRequest<K extends IpcChannel> = IpcContract[K]['req']

/**
 * 某个通道的成功响应体类型（不含信封）。
 * 完整返回值是 `IPCResult<IpcResponse<K>>` —— 失败分支仍是统一的 `IPCError`。
 */
export type IpcResponse<K extends IpcChannel> = IpcContract[K]['res']

/** 类型化 invoke 的实参表：`req` 为 `void` 的通道允许（并要求）不传第二个参数。 */
export type IpcArgs<K extends IpcChannel> = [IpcRequest<K>] extends [void] ? [] : [req: IpcRequest<K>]

/**
 * 类型化 invoke 的签名。
 *
 * 与 `ipcRenderer.invoke` 的唯一区别是：通道必须是契约里的键，入参按通道校验，
 * 返回值自动带上 `IPCResult<IpcResponse<K>>` —— 调用点不用再手写泛型。
 */
export interface IpcInvoker {
  <K extends IpcChannel>(channel: K, ...args: IpcArgs<K>): Promise<IPCResult<IpcResponse<K>>>
}

/**
 * 把宿主提供的 invoke（preload 里就是 `ipcRenderer.invoke`）收窄成 `IpcInvoker`。
 *
 * 放在 shared 是因为它**不依赖 electron**：只是把裸函数转成带通道约束的同形函数，
 * 主进程侧的脚本/测试也能用同一份签名做假实现。
 */
export function createIpcInvoker(invoke: (channel: string, ...args: any[]) => Promise<any>): IpcInvoker {
  return ((channel: IpcChannel, ...args: unknown[]) => invoke(channel, ...args)) as IpcInvoker
}

/**
 * 编译期守卫：契约里的键必须都是 `IPC_CHANNELS` 里真实存在的通道取值
 * （键名写错 → 默认类型参数不满足约束 → tsc 报错；不参与运行时，也不会被调用）。
 */
export type IpcContractKeysAreRealChannels<T extends IpcChannelValue = IpcChannel> = T
