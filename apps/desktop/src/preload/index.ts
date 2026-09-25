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
    open: (storeId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_OPEN, { storeId }),
    close: (storeId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CLOSE, { storeId }),
    display: (storeId: string | null): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_DISPLAY, { storeId }),
    setViewport: (bounds: { x: number, y: number, width: number, height: number }): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SET_VIEWPORT, bounds),
    /** 弹层打开/关闭：让主进程摘除/恢复原生视图挂载（否则弹窗被店铺页面盖住） */
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
    state: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_STATE)
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
      | { kind: 'chat'; text: string; model: string; elapsedMs: number; thoughts?: string[]; executed?: string[]; jobIds?: string[] }
    >> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_PLAN_GENERATE, { goal, history: history ? JSON.parse(JSON.stringify(history)) : [] }),
    /** Job 结束后自动续办：把用户目标与 Job 结果交给智能体回合判断下一步。 */
    jobFollowUp: (goal: string, jobIds: string[], history?: Array<{ role: 'user' | 'assistant'; text: string }>): Promise<IPCResult<
      | { kind: 'software'; plan: AgentSoftwarePlan; context: AgentSoftwareContext; model: string; elapsedMs: number; thought?: string; requiresApproval: boolean }
      | { kind: 'chat'; text: string; model: string; elapsedMs: number; thoughts?: string[]; executed?: string[]; jobIds?: string[] }
    >> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_JOB_FOLLOW_UP, JSON.parse(JSON.stringify({ goal, jobIds, history: history || [] }))),
    validatePlan: (plan: AgentPlan): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_PLAN_VALIDATE, JSON.parse(JSON.stringify(plan))),
    softwareContext: (): Promise<IPCResult<AgentSoftwareContext>> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_SOFTWARE_CONTEXT),
    validateSoftwarePlan: (plan: AgentSoftwarePlan): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SOFTWARE_VALIDATE, JSON.parse(JSON.stringify(plan))),
    executeSoftwarePlan: (plan: AgentSoftwarePlan, confirmed = false): Promise<IPCResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SOFTWARE_EXECUTE, { plan: JSON.parse(JSON.stringify(plan)), confirmed })
  },

  // 多 Agent 管理 API：写操作只通过 Main 的组织、模型、Job、记忆服务。
  agentDomain: {
    orgList: (query: Record<string, unknown> = {}): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_ORG_LIST, JSON.parse(JSON.stringify(query))),
    orgGet: (agentId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_ORG_GET, { agentId }),
    orgCreate: (input: Record<string, unknown>): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_ORG_CREATE, JSON.parse(JSON.stringify(input))),
    orgUpdate: (input: Record<string, unknown>): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_ORG_UPDATE, JSON.parse(JSON.stringify(input))),
    orgActivate: (agentId: string, confirmed = false): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_ORG_ACTIVATE, { agentId, actorAgentId: 'root-ceo', confirmed }),
    orgPause: (agentId: string, confirmed = false): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_ORG_PAUSE, { agentId, actorAgentId: 'root-ceo', confirmed }),
    orgResume: (agentId: string, confirmed = false): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_ORG_RESUME, { agentId, actorAgentId: 'root-ceo', confirmed }),
    orgRetire: (agentId: string, confirmed = false): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_ORG_RETIRE, { agentId, actorAgentId: 'root-ceo', confirmed }),
    skillList: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_SKILL_LIST),
    skillDelete: (skillId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_SKILL_DELETE, { skillId }),
    skillUpdate: (input: Record<string, unknown>): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_SKILL_UPDATE, JSON.parse(JSON.stringify(input))),
    packExport: (input: Record<string, unknown> = {}): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_PACK_EXPORT, JSON.parse(JSON.stringify(input))),
    packImport: (json: string, confirmed = false): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_PACK_IMPORT, JSON.parse(JSON.stringify({ json, confirmed }))),
    hrPreview: (role: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_HR_PREVIEW, { mode: 'hr', role, actorAgentId: 'root-ceo' }),
    modelList: (query: Record<string, unknown> = {}): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_MODEL_LIST, JSON.parse(JSON.stringify(query))),
    modelSet: (profile: ModelProfileInput): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_MODEL_SET, { profile: JSON.parse(JSON.stringify(profile)), actorAgentId: 'root-ceo' }),
    modelDelete: (profileId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_MODEL_DELETE, { profileId, actorAgentId: 'root-ceo' }),
    modelTest: (profileId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_MODEL_TEST, { profileId, actorAgentId: 'root-ceo' }),
    modelBind: (agentId: string, modelProfileId: string | null): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_MODEL_BIND, { agentId, modelProfileId, actorAgentId: 'root-ceo' }),
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
    memorySnapshotRestore: (path: string, confirmed = false): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_MEMORY_SNAPSHOT_RESTORE, { path, confirmed, actorAgentId: 'root-ceo' }),
    qualityMetrics: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_QUALITY_METRICS),
    qualityReview: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_QUALITY_REVIEW)
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
    listModels: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AI_MODELS_LIST)
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
