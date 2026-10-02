/**
 * Preload Script
 * 在渲染进程加载前运行，暴露白名单 API
 * §10.1 Electron 安全：contextIsolation + sandbox
 */

import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, EVENT_CHANNELS } from '@shared/contracts/ipc'
import type { IPCResult } from '@shared/contracts/ipc'
import { PLATFORM_CATALOG } from '@shared/constants/platforms'
import type {
  AgentPlan,
  AgentSoftwareContext,
  AgentSoftwarePlan,
  AgentUiState
} from '@shared/schemas/agent'
import type { AgentJobCreate, AgentJobFeedback, AgentJobResultReview, AgentMemoryReview, AgentMemoryWrite, AgentTaskDelegate, ModelProfileInput } from '@shared/schemas/agent-domain'
import type { AgentContextUsage } from '@shared/agent-context'

/**
 * 暴露给渲染进程的安全 API
 */
const eventListenerWrappers = new Map<string, Map<(...args: any[]) => void, (...args: any[]) => void>>()

const api = {
  // 店铺管理
  store: {
    list: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.STORE_LIST),
    get: (storeId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.STORE_GET, { storeId }),
    create: (input: any): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.STORE_CREATE, input),
    update: (input: any): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.STORE_UPDATE, input),
    archive: (storeId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.STORE_ARCHIVE, { storeId }),
    restore: (storeId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.STORE_RESTORE, { storeId }),
    deletePermanent: (storeId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.STORE_DELETE_PERMANENT, { storeId }),
    reorder: (orderedStoreIds: string[]): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.STORE_REORDER, { orderedStoreIds }),
    setGroup: (storeId: string, groupName: string | null): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.STORE_SET_GROUP, { storeId, groupName }),
    trashList: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.STORE_TRASH_LIST),
    purge: (storeId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.STORE_PURGE, { storeId })
  },
  
  // 浏览器
  browser: {
    open: (storeId: string, opts?: { display?: boolean }): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_OPEN, { storeId, ...(opts || {}) }),
    close: (storeId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CLOSE, { storeId }),
    display: (storeId: string | null): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_DISPLAY, { storeId }),
    /** 注册标签页对应的 webview 内容，供主进程维护其挂载关系 */
    registerWebview: (storeId: string, tabId: string, webContentsId: number): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_REGISTER_WEBVIEW, { storeId, tabId, webContentsId }),
    /** 上报浏览器内容区域边界，供已注册 webview 同步布局 */
    setViewport: (bounds: { x: number, y: number, width: number, height: number }): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SET_VIEWPORT, bounds),
    /** 弹层打开/关闭：暂时隐藏/恢复已注册 webview */
    setViewsObscured: (obscured: boolean, reason: 'modal' | 'agent' = 'modal'): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SET_VIEWS_OBSCURED, { obscured, reason }),
    
    tab: {
      create: (storeId: string, url?: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_TAB_CREATE, { storeId, url }),
      activate: (storeId: string, tabId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_TAB_ACTIVATE, { storeId, tabId }),
      close: (storeId: string, tabId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_TAB_CLOSE, { storeId, tabId }),
      reorder: (storeId: string, orderedTabIds: string[]): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_TAB_REORDER, { storeId, orderedTabIds }),
      setPinned: (storeId: string, tabId: string, pinned: boolean): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_TAB_SET_PINNED, { storeId, tabId, pinned }),
      list: (storeId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_TAB_LIST, { storeId }),
      control: (storeId: string, tabId: string, action: 'back' | 'forward' | 'reload'): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_TAB_CONTROL, { storeId, tabId, action })
    },
    
    navigate: (storeId: string, tabId: string, url: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_NAVIGATE, { storeId, tabId, url }),
    prepareInviteSquare: (storeId: string, input: any): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_PREPARE_INVITE_SQUARE, { storeId, ...input }),
    clearData: (storeId: string, types: string[], origin?: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CLEAR_DATA, { storeId, types, origin }),
    capture: (storeId: string, tabId: string, format: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CAPTURE, { storeId, tabId, format }),
    /** 编排器「拾取元素」：picker-mode 下在店铺页面上点一下，取回锚点填进参数框 */
    pickElement: (storeId: string, mode: 'selector' | 'text'): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_PICK_ELEMENT, { storeId, mode }),
    openWindow: (storeId: string, tabId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_OPEN_WINDOW, { storeId, tabId }),
    /** 只读：当前显示的店铺与各已打开店铺的标签页（渲染层重载后补齐状态用） */
    state: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_STATE),
    memoryDiagnostics: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_MEMORY_DIAGNOSTICS)
  },
  
  // 书签
  bookmark: {
    list: (storeId?: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BOOKMARK_LIST, { storeId }),
    create: (input: any): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BOOKMARK_CREATE, input),
    delete: (bookmarkId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BOOKMARK_DELETE, { bookmarkId }),
    entryRoutes: (storeId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BOOKMARK_ENTRY_ROUTES, { storeId })
  },

  // 平台目录（国内四家：拼多多/微信小店/快手小店/抖店）—— 只读静态数据，主/渲染同源
  platforms: PLATFORM_CATALOG.map(p => ({
    name: p.name,
    color: p.color,
    adminUrl: p.adminUrl,
    entryRoutes: p.entryRoutes.map(r => ({ title: r.title, url: r.url })),
    // 发票入口（「发票中心」用）：verified=true 表示已真机实测
    invoiceRoutes: p.invoiceRoutes.map(r => ({ title: r.title, url: r.url, verified: r.verified === true }))
  })),
  
  // 下载
  download: {
    list: (storeId: string, limit?: number): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.DOWNLOAD_LIST, { storeId, limit }),
    showInFolder: (downloadId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.DOWNLOAD_SHOW_IN_FOLDER, { downloadId })
  },

  // 环境配置 - §6.6
  profile: {
    get: (storeId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_GET, { storeId }),
    update: (storeId: string, patch: any): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_UPDATE, { storeId, patch }),
    verify: (storeId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_VERIFY, { storeId }),
    lock: (storeId: string, locked: boolean): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_LOCK, { storeId, locked }),
    copyConfig: (sourceStoreId: string, targetStoreIds: string[]): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_COPY_CONFIG, { sourceStoreId, targetStoreIds })
  },

  // 概览/设置/审计 - §6.6 §6.7
  overview: {
    stats: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.OVERVIEW_STATS),
    /** 数据中心：所有店铺的汇总数据（只读） */
    datacenter: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.OVERVIEW_DATACENTER),
    orders: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.OVERVIEW_ORDERS),
    /** 发票中心：各店铺的待开票信息（来自发票页 readTable 快照） */
    invoiceCenter: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.OVERVIEW_INVOICE_CENTER),
    /** 发票中心：把待开票清单导出为 CSV（弹保存框） */
    invoiceExport: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.OVERVIEW_INVOICE_EXPORT),
    /** 店铺主体：把已采到的 entity.* 快照写进店铺营业执照（空则填；不一致不覆盖，如实回报） */
    entityApply: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.OVERVIEW_ENTITY_APPLY),
    /** 手动录入经营指标（平台反抓取导致无法自动读取时，由用户看页面录入） */
    manualMetric: (storeId: string, metric: string, value: number): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.OVERVIEW_MANUAL_METRIC, { storeId, metric, value })
  },
  settings: {
    get: (key: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET, { key }),
    set: (key: string, value: any): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, { key, value })
  },
  audit: {
    query: (filter?: any): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AUDIT_QUERY, { filter }),
    export: (filter?: any, outputPath?: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AUDIT_EXPORT, { filter, outputPath })
  },
  diagnostics: {
    export: (outputPath?: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.DIAGNOSTICS_EXPORT, { outputPath })
  },

  // 代理 - §6.3（渲染层可传明文凭据，Main 立即加密保管，绝不回显）
  proxy: {
    test: (proxyDraft: any, proxyId?: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.PROXY_TEST, { proxyDraft, proxyId }),
    list: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.PROXY_LIST),
    create: (draft: any, username?: string, password?: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.PROXY_CREATE, { draft, username, password }),
    update: (proxyId: string, patch: any): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.PROXY_UPDATE, { proxyId, patch }),
    delete: (proxyId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.PROXY_DELETE, { proxyId }),
    importBatch: (items: any[]): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.PROXY_IMPORT_BATCH, { items }),
    bind: (storeId: string, proxyId: string | null): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.PROXY_BIND, { storeId, proxyId }),
    history: (proxyId: string, limit?: number): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.PROXY_HISTORY, { proxyId, limit })
  },

  // 会话 - §6.3（导出/导入经主进程托管对话框；Cookie 查看器）
  session: {
    status: (storeId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.SESSION_STATUS, { storeId }),
    checkLoginStatus: (storeId: string): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_CHECK_LOGIN_STATUS, { storeId }),
    export: (storeId: string, outputPath?: string, validDays?: number): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_EXPORT, { storeId, outputPath, validDays }),
    import: (storeId: string, filePath?: string, pickFile?: boolean): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_IMPORT, { storeId, filePath, pickFile }),
    cookies: (storeId: string, search?: string): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_COOKIES, { storeId, search }),
    deleteCookie: (storeId: string, name: string, domain: string, path: string, secure?: boolean): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_DELETE_COOKIE, { storeId, name, domain, path, secure }),
    clearCookies: (storeId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.SESSION_CLEAR_COOKIES, { storeId })
  },

  // 统一订单域：只暴露安全采集结果与分页查询，不暴露页面/Session/网络凭据。
  orders: {
    collect: (input: { storeId: string; maxPages?: number; maxOrders?: number; timeoutMs?: number }): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.ORDER_COLLECT, input),
    list: (query: { storeId: string; status?: string; startDate?: number; endDate?: number; page?: number; pageSize?: number }): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.ORDER_LIST, query),
    get: (storeId: string, orderId: string): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.ORDER_GET, { storeId, orderId }),
    observation: {
      start: (input: { storeId: string; timeoutMs?: number; maxResponses?: number }): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.ORDER_OBSERVATION_START, input),
      stop: (storeId: string): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.ORDER_OBSERVATION_STOP, { storeId })
    }
  },

  // 商品管理：只暴露"同步（只读采集）+ 分页查询 + 台账"。
  // **不暴露发布**——发布必须走任务引擎与人工确认门禁（方案 §7.9），不能从这个口子绕过。
  products: {
    sync: (input: { storeId: string; trigger?: 'manual' | 'schedule'; maxPages?: number; maxProducts?: number; timeoutMs?: number }): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_SYNC, input),
    list: (query: { storeId?: string; platform?: string; onlyOrphan?: boolean; keyword?: string; limit?: number; offset?: number }): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_LIST, query),
    syncRuns: (query: { storeId?: string } = {}): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_SYNC_RUNS, query),
    // 本地商品库（M2）：归并由用户触发；图片本地化只下载图片到本机
    library: {
      list: (query: { keyword?: string; limit?: number; offset?: number } = {}): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_LIBRARY_LIST, query),
      get: (productId: string): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_LIBRARY_GET, { productId }),
      save: (input: { productId: string; platform?: string; draft: unknown }): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_LIBRARY_SAVE, input),
      saveAsLocal: (input: { platform: string; storeId: string; platformProductId: string; mergeLink?: boolean }): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_LIBRARY_SAVE_AS, input),
      merge: (input: { linkId: string; productId: string }): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_LIBRARY_MERGE, input),
      unmerge: (input: { linkId: string }): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_LIBRARY_UNMERGE, input),
      remove: (productId: string): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_LIBRARY_REMOVE, { productId }),
      localizeMedia: (productId: string): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_MEDIA_LOCALIZE, { productId }),
      // 图片本地化队列与保留策略：scan 只算、run 逐张下、orphans 只判定、cleanup 用户确认后才删
      queueScan: (input: { maxItems?: number } = {}): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_MEDIA_QUEUE_SCAN, input),
      queueRun: (input: { maxItems?: number } = {}): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_MEDIA_QUEUE_RUN, input),
      orphans: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_MEDIA_ORPHANS, {}),
      cleanupOrphans: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_MEDIA_CLEANUP, {})
    },
    // 详情页采集：只导航到详情页并读 DOM（商品图 + 规格），**不填写不提交**
    detail: {
      collect: (input: { storeId: string; platformProductId: string }): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_DETAIL_COLLECT, input)
    },
    // 发布（M3）：**只到人工确认门禁为止**。这里没有任何"提交"能力 ——
    // preflight 只算不写平台，open 只把页面开到发布页，items 是只读台账。
    publish: {
      preflight: (input: { productId: string; storeIds: string[] }): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_PUBLISH_PREFLIGHT, input),
      open: (input: { itemId: string; fill?: boolean }): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_PUBLISH_OPEN, input),
      items: (query: { limit?: number } = {}): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_PUBLISH_ITEMS, query),
      // 人工确认门禁（走任务引擎的 waitForUserConfirmation）：
      // openGate 只是"开个门禁等人"，confirm 是**"用户说他已在平台上提交了"**（不是让应用去提交），
      // verify 是只读回查。三个都没有替用户点提交的能力。
      openGate: (input: { itemId: string; message?: string }): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_PUBLISH_OPEN_GATE, input),
      confirm: (input: { itemId: string; approved: boolean }): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_PUBLISH_CONFIRM, input),
      verify: (input: { itemId: string }): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_PUBLISH_VERIFY, input),
      // 回读闭环（M4，方案 §7.5）：readback **只读页面**产出建议（不写库）；
      // acceptSuggestion 是**用户逐条确认之后**才落库；checklist 是跨次记住的本地补全清单。
      readback: (input: { itemId: string }): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_PUBLISH_READBACK, input),
      acceptSuggestion: (input: { itemId: string; field: string; kind: 'suggest_default' | 'suggest_writeback' }): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_PUBLISH_ACCEPT, input),
      checklist: (input: { productId: string; storeId: string }): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_PUBLISH_CHECKLIST, input),
      // 批量编排（M5，方案 §7.8）：create 只建台账、progress 只读、skipStore 只改"还没开始"的项。
      // 批量下的提交仍然只能由人在浏览器里点 —— 这里没有提交能力。
      batchCreate: (input: { productIds: string[]; storeIds: string[] }): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_PUBLISH_BATCH_CREATE, input),
      batchProgress: (input: { batchId: string }): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_PUBLISH_BATCH_PROGRESS, input),
      // 「全部暂停」：只退回正在跑的，已经在等人工的保持等待
      batchAbort: (input: { batchId: string }): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_PUBLISH_BATCH_ABORT, input),
      batchSkipStore: (input: { batchId: string; storeId: string }): Promise<IPCResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_PUBLISH_BATCH_SKIP_STORE, input)
    }
  },

  // 经营数据：只暴露安全的聚合结果和有限查询参数，不暴露 Session/请求凭据。
  // 计划管理只接受 storeId / 周期 / 分页 / 状态过滤——主进程用 Zod strict 再把一道关，
  // 多传一个字段直接判非法（不接受 SQL、URL、Session、WebContents 或任意脚本）。
  salesMetrics: {
    collect: (input: { storeId: string; periodType?: string; periodStart?: number; periodEnd?: number; timeoutMs?: number }): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.SALES_METRICS_COLLECT, input),
    latest: (input: { storeId: string; periodType?: string }): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.SALES_METRICS_LATEST, input),
    list: (input: { storeId: string; periodType?: string; periodStart?: number; periodEnd?: number; page?: number; pageSize?: number }): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.SALES_METRICS_LIST, input),
    products: (input: { storeId: string; periodType?: string; periodStart?: number; periodEnd?: number; page?: number; pageSize?: number; sort?: string; limit?: number }): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.SALES_METRICS_PRODUCTS, input),
    topProducts: (input: { storeId: string; periodType?: string; page?: number; pageSize?: number; sort?: string; limit?: number }): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.SALES_METRICS_TOP_PRODUCTS, input),
    plans: (input: { storeId?: string; platform?: string } = {}): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.SALES_METRICS_PLAN_LIST, input),
    planGet: (storeId: string): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.SALES_METRICS_PLAN_GET, { storeId }),
    planUpdate: (input: { storeId: string; enabled?: boolean; intervalMs?: number }): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.SALES_METRICS_PLAN_UPDATE, input),
    planPause: (storeId: string): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.SALES_METRICS_PLAN_PAUSE, { storeId }),
    planResume: (storeId: string): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.SALES_METRICS_PLAN_RESUME, { storeId }),
    /** 立即采集：只入队，结果通过 salesMetrics:runFinished 事件回报（依次能看到 RUNNING→终态）。 */
    planRunNow: (storeId: string, periodType?: string): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.SALES_METRICS_PLAN_RUN_NOW, { storeId, periodType }),
    runs: (input: { storeId?: string; platform?: string; status?: string; page?: number; pageSize?: number } = {}): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.SALES_METRICS_RUNS_LIST, input),
    health: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.SALES_METRICS_HEALTH)
  },

  // 应用锁 - §6.5
  security: {
    status: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.SECURITY_STATUS),
    setPassword: (password?: string, oldPassword?: string): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECURITY_SET_PASSWORD, { password, oldPassword }),
    removePassword: (credential?: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.SECURITY_REMOVE_PASSWORD, { credential }),
    lock: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.SECURITY_LOCK),
    unlock: (credential: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.SECURITY_UNLOCK, { credential })
  },

  // 备份 - §6.5
  backup: {
    create: (label?: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BACKUP_CREATE, { label }),
    list: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BACKUP_LIST),
    restore: (backupId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BACKUP_RESTORE, { backupId })
  },

  // 任务引擎 - §6.4（只能触发白名单动作，任意代码路径不存在）
  task: {
    create: (input: any): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.TASK_CREATE, input),
    list: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.TASK_LIST),
    run: (taskId: string, storeId?: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.TASK_RUN, { taskId, storeId }),
    pause: (runId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.TASK_PAUSE, { runId }),
    resume: (runId: string, mode?: 'continue' | 'retry'): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.TASK_RESUME, { runId, mode }),
    cancel: (runId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.TASK_CANCEL, { runId }),
    confirm: (runId: string, approved: boolean): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.TASK_CONFIRM, { runId, approved }),
    results: (runId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.TASK_RESULTS, { runId }),
    delete: (taskId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.TASK_DELETE, { taskId }),
    update: (input: Record<string, unknown>): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.TASK_UPDATE, JSON.parse(JSON.stringify(input))),
    fireScheduled: (taskId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.TASK_CREATE_FIRE, { taskId })
  },

  // Agent 只暴露受控观察、结构化计划、软件白名单动作和 UI 设置；
  // 不能访问 WebContents、数据库、文件系统、Shell 或源码，任务继续走上方现有 task API。
  agent: {
    uiGet: (): Promise<IPCResult<AgentUiState>> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_UI_GET),
    // Pinia 对象是 Proxy，Electron structured clone 无法直接序列化；只复制 Agent schema 中的 JSON 值。
    uiSet: (state: AgentUiState): Promise<IPCResult<AgentUiState>> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_UI_SET, JSON.parse(JSON.stringify(state))),
    observe: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_PAGE_OBSERVE),
    generatePlan: (goal: string, history?: Array<{ role: 'user' | 'assistant'; text: string }>): Promise<IPCResult<
      | { kind: 'task'; plan: AgentPlan; observation: any; model: string; elapsedMs: number; requiresApproval: boolean }
      | { kind: 'software'; plan: AgentSoftwarePlan; context: AgentSoftwareContext; model: string; elapsedMs: number; pendingGoal?: string; thought?: string; requiresApproval: boolean }
      | { kind: 'chat'; text: string; model: string; elapsedMs: number; thoughts?: string[]; executed?: string[]; jobIds?: string[]; usage?: AgentContextUsage }
    >> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_PLAN_GENERATE, { goal, history: history ? JSON.parse(JSON.stringify(history)) : [] }),
    /** Job 结束后自动续办：把用户目标与 Job 结果交给智能体回合判断下一步。 */
    jobFollowUp: (goal: string, jobIds: string[], history?: Array<{ role: 'user' | 'assistant'; text: string }>): Promise<IPCResult<
      | { kind: 'software'; plan: AgentSoftwarePlan; context: AgentSoftwareContext; model: string; elapsedMs: number; thought?: string; requiresApproval: boolean }
      | { kind: 'chat'; text: string; model: string; elapsedMs: number; thoughts?: string[]; executed?: string[]; jobIds?: string[]; usage?: AgentContextUsage }
    >> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_JOB_FOLLOW_UP, JSON.parse(JSON.stringify({ goal, jobIds, history: history || [] }))),
    validatePlan: (plan: AgentPlan): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_PLAN_VALIDATE, JSON.parse(JSON.stringify(plan))),
    softwareContext: (): Promise<IPCResult<AgentSoftwareContext>> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_SOFTWARE_CONTEXT),
    validateSoftwarePlan: (plan: AgentSoftwarePlan): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SOFTWARE_VALIDATE, JSON.parse(JSON.stringify(plan))),
    executeSoftwarePlan: (plan: AgentSoftwarePlan, confirmed = false): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SOFTWARE_EXECUTE, { plan: JSON.parse(JSON.stringify(plan)), confirmed })
  },

  // Agent 域 API：运行时只有 root-ceo；旧组织/绑定通道仅为兼容保留，
  // 所有写操作仍由 Main 的模型、Job、记忆和技能服务执行。
  agentDomain: {
    orgList: (query: Record<string, unknown> = {}): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_ORG_LIST, JSON.parse(JSON.stringify(query))),
    orgGet: (agentId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_ORG_GET, { agentId }),
    skillList: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_SKILL_LIST),
    skillCreate: (input: Record<string, unknown>): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_SKILL_CREATE, JSON.parse(JSON.stringify(input))),
    skillTools: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_SKILL_TOOLS),
    skillDelete: (skillId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_SKILL_DELETE, { skillId }),
    skillUpdate: (input: Record<string, unknown>): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_SKILL_UPDATE, JSON.parse(JSON.stringify(input))),
    pluginUpdate: (input: Record<string, unknown>): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_PLUGIN_UPDATE, JSON.parse(JSON.stringify(input))),
    pluginDelete: (input: Record<string, unknown>): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_PLUGIN_DELETE, JSON.parse(JSON.stringify(input))),
    packExport: (input: Record<string, unknown> = {}): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_PACK_EXPORT, JSON.parse(JSON.stringify(input))),
    packImport: (json: string, confirmed = false): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_PACK_IMPORT, JSON.parse(JSON.stringify({ json, confirmed }))),
    modelList: (query: Record<string, unknown> = {}): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_MODEL_LIST, JSON.parse(JSON.stringify(query))),
    modelSet: (profile: ModelProfileInput): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_MODEL_SET, { profile: JSON.parse(JSON.stringify(profile)), actorAgentId: 'root-ceo' }),
    modelDelete: (profileId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_MODEL_DELETE, { profileId, actorAgentId: 'root-ceo' }),
    modelTest: (profileId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_MODEL_TEST, { profileId, actorAgentId: 'root-ceo' }),
    jobCreate: (input: AgentJobCreate): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_JOB_CREATE, JSON.parse(JSON.stringify(input))),
    jobDelegate: (input: AgentTaskDelegate): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_JOB_DELEGATE, JSON.parse(JSON.stringify(input))),
    jobList: (query: Record<string, unknown> = {}): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_JOB_LIST, JSON.parse(JSON.stringify(query))),
    jobGet: (jobId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_JOB_GET, { jobId }),
    jobRun: (jobId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_JOB_RUN, { jobId, actorAgentId: 'root-ceo' }),
    jobCancel: (jobId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_JOB_CANCEL, { jobId, actorAgentId: 'root-ceo' }),
    jobApprove: (jobId: string, approved: boolean, confirmationId?: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_JOB_APPROVE, { jobId, approved, confirmationId, actorAgentId: 'root-ceo' }),
    jobResultReview: (input: AgentJobResultReview): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_JOB_RESULT_REVIEW, JSON.parse(JSON.stringify(input))),
    jobFeedback: (input: AgentJobFeedback): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_JOB_FEEDBACK, JSON.parse(JSON.stringify(input))),
    jobResume: (jobId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_JOB_RESUME, { jobId, actorAgentId: 'root-ceo' }),
    memoryList: (query: Record<string, unknown>): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_MEMORY_LIST, JSON.parse(JSON.stringify(query))),
    memorySearch: (query: Record<string, unknown>): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_MEMORY_SEARCH, JSON.parse(JSON.stringify(query))),
    memoryWrite: (input: AgentMemoryWrite): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_MEMORY_WRITE, JSON.parse(JSON.stringify(input))),
    memoryReview: (input: AgentMemoryReview): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_MEMORY_REVIEW, JSON.parse(JSON.stringify(input))),
    memoryRebuild: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_MEMORY_REBUILD),
    memorySnapshot: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_MEMORY_SNAPSHOT),
    memorySnapshotInspect: (path: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_MEMORY_SNAPSHOT_INSPECT, { path }),
    // Restore confirmation is Main-owned. Keep the old `(path, confirmed,
    // expectedSha256)` call shape readable so older renderers/acceptance
    // fixtures still run, but never forward the boolean as authorization.
    memorySnapshotRestore: (path: string, confirmedOrExpectedSha256?: boolean | string, expectedSha256?: string): Promise<IPCResult> => {
      const digest = typeof confirmedOrExpectedSha256 === 'string' ? confirmedOrExpectedSha256 : expectedSha256
      return ipcRenderer.invoke(IPC_CHANNELS.AGENT_MEMORY_SNAPSHOT_RESTORE, { path, actorAgentId: 'root-ceo', ...(digest ? { expectedSha256: digest } : {}) })
    },
    memoryLearningSettings: (input?: { autoLearn: boolean; retentionDays: number }): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_MEMORY_LEARNING_SETTINGS, input == null ? undefined : JSON.parse(JSON.stringify(input))),
    memoryMaintenance: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_MEMORY_MAINTENANCE),
    qualityMetrics: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_QUALITY_METRICS),
    qualityReview: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_QUALITY_REVIEW),
    commerceLedgerList: (query: { storeId?: string; status?: string; limit?: number } = {}): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_COMMERCE_LEDGER_LIST, JSON.parse(JSON.stringify(query)))
  },

  // 店铺指标快照 - §5.11
  snapshot: {
    list: (storeId: string, limit?: number): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_LIST, { storeId, limit })
  },
  
  // 窗口装饰 - §17（顶部融合标题栏：右上角原生窗口按钮 overlay 底色随 UI 状态切换）
  windowChrome: {
    setTitlebarOverlay: (opts: { color?: string, symbolColor?: string }): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SET_TITLEBAR_OVERLAY, opts)
  },

  // 软件更新
  update: {
    status: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_STATUS),
    check: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CHECK),
    download: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_DOWNLOAD),
    install: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_INSTALL)
  },

  // 大模型（AI）配置 - §4.4：Key 只在主进程 safeStorage，IPC 仅回"是否已配置"
  ai: {
    configGet: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AI_CONFIG_GET),
    configSet: (input: { endpoint?: string, model?: string, timeoutMs?: number }): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_CONFIG_SET, input),
    setKey: (key: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AI_KEY_SET, { key }),
    clearKey: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AI_KEY_CLEAR),
    test: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AI_TEST),
    listModels: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AI_MODELS_LIST),
    imageConfigGet: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AI_IMAGE_CONFIG_GET),
    imageConfigSet: (input: { endpoint?: string, model?: string, timeoutMs?: number }): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_IMAGE_CONFIG_SET, input),
    setImageKey: (key: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AI_IMAGE_KEY_SET, { key }),
    clearImageKey: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AI_IMAGE_KEY_CLEAR),
    testImage: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AI_IMAGE_TEST),
    listImageModels: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AI_IMAGE_MODELS_LIST),
    imageTextConfigGet: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AI_IMAGE_TEXT_CONFIG_GET),
    imageTextConfigSet: (input: { endpoint?: string, model?: string, timeoutMs?: number }): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_IMAGE_TEXT_CONFIG_SET, input),
    setImageTextKey: (key: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AI_IMAGE_TEXT_KEY_SET, { key }),
    clearImageTextKey: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AI_IMAGE_TEXT_KEY_CLEAR),
    testImageText: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AI_IMAGE_TEXT_TEST),
    listImageTextModels: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AI_IMAGE_TEXT_MODELS_LIST),
    analyzeImageProduct: (input: { name?: string; tags?: string; price?: string; originalPrice?: string }): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_IMAGE_TEXT_ANALYZE, JSON.parse(JSON.stringify(input))),
    generateImage: (input: { prompt: string; model?: string; size?: string; n?: number; confirmed?: boolean; sourceImages?: Array<{ name: string; mimeType: string; b64Json: string }> }): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_IMAGE_GENERATE, JSON.parse(JSON.stringify(input)))
  },

  // 事件监听
  on: (channel: string, callback: (...args: any[]) => void): void => {
    // 只允许白名单事件
    const allowedChannels: string[] = Object.values(EVENT_CHANNELS)
    if (!allowedChannels.includes(channel) || typeof callback !== 'function') return
    const wrapped = (_event: unknown, ...args: any[]) => callback(...args)
    let byCallback = eventListenerWrappers.get(channel)
    if (!byCallback) { byCallback = new Map(); eventListenerWrappers.set(channel, byCallback) }
    const previous = byCallback.get(callback)
    if (previous) ipcRenderer.removeListener(channel, previous as any)
    byCallback.set(callback, wrapped)
    ipcRenderer.on(channel, wrapped as any)
  },
  
  // 移除事件监听
  off: (channel: string, callback: (...args: any[]) => void): void => {
    const allowedChannels: string[] = Object.values(EVENT_CHANNELS)
    if (!allowedChannels.includes(channel) || typeof callback !== 'function') return
    const byCallback = eventListenerWrappers.get(channel)
    const wrapped = byCallback?.get(callback)
    if (!wrapped) return
    ipcRenderer.removeListener(channel, wrapped as any)
    byCallback?.delete(callback)
    if (byCallback?.size === 0) eventListenerWrappers.delete(channel)
  }
}

// Keep the wrapper created by `on` so `off` can actually detach it.  The
// previous anonymous wrapper was impossible to remove with the caller's
// original callback and accumulated duplicate progress events after view
// remounts.
// 暴露 API 到渲染进程 - §10.1 只通过 preload 暴露白名单 API
contextBridge.exposeInMainWorld('shopilot', api)
