/// <reference types="vite/client" />

import type { IPCResult } from '@shared/contracts/ipc'
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
} from '@shared/contracts/sales-metrics'
import type {
  AgentPlan,
  AgentPageObservation,
  AgentSoftwareContext,
  AgentSoftwarePlan,
  AgentUiState
} from '@shared/schemas/agent'
import type { AgentJobCreate, AgentJobFeedback, AgentJobResultReview, AgentMemoryReview, AgentMemoryWrite, AgentTaskDelegate, ModelProfileInput } from '@shared/schemas/agent-domain'
import type { AgentContextUsage } from '@shared/agent-context'

export interface TabInfo {
  id: string
  url: string
  title: string
  isPinned: boolean
  orderIndex: number
  loading?: boolean
  guestAttached?: boolean
  /** 采集专用页：不进标签栏、不占活动位，只由浏览器面板挂一个隐藏 webview 给它 */
  internal?: boolean
}

declare global {
  interface Window {
    shopilot: {
      store: {
        list: () => Promise<IPCResult>
        get: (storeId: string) => Promise<IPCResult>
        create: (input: any) => Promise<IPCResult>
        update: (input: any) => Promise<IPCResult>
        archive: (storeId: string) => Promise<IPCResult>
        restore: (storeId: string) => Promise<IPCResult>
        deletePermanent: (storeId: string) => Promise<IPCResult>
        reorder: (orderedStoreIds: string[]) => Promise<IPCResult>
        setGroup: (storeId: string, groupName: string | null) => Promise<IPCResult>
        trashList: () => Promise<IPCResult>
        purge: (storeId: string) => Promise<IPCResult>
      }
      browser: {
        open: (storeId: string, opts?: { display?: boolean }) => Promise<IPCResult>
        close: (storeId: string) => Promise<IPCResult>
        display: (storeId: string | null) => Promise<IPCResult>
        registerWebview: (storeId: string, tabId: string, webContentsId: number) => Promise<IPCResult>
        /** 上报浏览器内容区域边界，供已注册 webview 同步布局 */
        setViewport: (bounds: { x: number; y: number; width: number; height: number }) => Promise<IPCResult>
        tab: {
          create: (storeId: string, url?: string) => Promise<IPCResult>
          activate: (storeId: string, tabId: string) => Promise<IPCResult>
          close: (storeId: string, tabId: string) => Promise<IPCResult>
          reorder: (storeId: string, orderedTabIds: string[]) => Promise<IPCResult>
          setPinned: (storeId: string, tabId: string, pinned: boolean) => Promise<IPCResult>
          list: (storeId: string) => Promise<IPCResult>
          control: (storeId: string, tabId: string, action: 'back' | 'forward' | 'reload') => Promise<IPCResult>
        }
        navigate: (storeId: string, tabId: string, url: string) => Promise<IPCResult>
        prepareInviteSquare: (storeId: string, input: any) => Promise<IPCResult>
        clearData: (storeId: string, types: string[], origin?: string) => Promise<IPCResult>
        capture: (storeId: string, tabId: string, format: string) => Promise<IPCResult>
        /** 编排器「拾取元素」：picker-mode 下在店铺页面上点一下，取回锚点（对话框贴右保留） */
        pickElement: (storeId: string, mode: 'selector' | 'text') => Promise<IPCResult>
        openWindow: (storeId: string, tabId?: string) => Promise<IPCResult>
        /** 弹层打开/关闭：暂时隐藏/恢复已注册 webview */
        setViewsObscured: (obscured: boolean, reason?: 'modal' | 'agent') => Promise<IPCResult>
        /** 只读：当前显示的店铺与各已打开店铺的标签页（渲染层重载后补齐状态用） */
        state: () => Promise<IPCResult<{ displayedStoreId: string | null; stores: Array<{ storeId: string; activeTabId: string | null; tabs: TabInfo[] }> }>>
        memoryDiagnostics: () => Promise<IPCResult>
      }
      bookmark: {
        list: (storeId?: string) => Promise<IPCResult>
        create: (input: any) => Promise<IPCResult>
        delete: (bookmarkId: string) => Promise<IPCResult>
        entryRoutes: (storeId: string) => Promise<IPCResult>
      }
      /** 平台目录（国内四家），只读静态数据 */
      platforms: Array<{
        name: string
        color: string
        adminUrl: string
        entryRoutes: Array<{ title: string; url: string }>
      }>
      download: {
        list: (storeId: string, limit?: number) => Promise<IPCResult>
        showInFolder: (downloadId: string) => Promise<IPCResult>
      }
      profile: {
        get: (storeId: string) => Promise<IPCResult>
        update: (storeId: string, patch: any) => Promise<IPCResult>
        verify: (storeId: string) => Promise<IPCResult>
        lock: (storeId: string, locked: boolean) => Promise<IPCResult>
        copyConfig: (sourceStoreId: string, targetStoreIds: string[]) => Promise<IPCResult>
      }
      overview: {
        stats: () => Promise<IPCResult>
        datacenter: () => Promise<IPCResult>
        orders: () => Promise<IPCResult>
        invoiceCenter: () => Promise<IPCResult>
        invoiceExport: () => Promise<IPCResult>
        /** 店铺主体：把已采到的 entity.* 快照写进店铺营业执照（空则填；不一致不覆盖） */
        entityApply: () => Promise<IPCResult>
        manualMetric: (storeId: string, metric: string, value: number) => Promise<IPCResult>
      }
      settings: {
        get: (key: string) => Promise<IPCResult>
        set: (key: string, value: any) => Promise<IPCResult>
      }
      audit: {
        query: (filter?: any) => Promise<IPCResult>
        export: (filter?: any, outputPath?: string) => Promise<IPCResult>
      }
      diagnostics: { export: (outputPath?: string) => Promise<IPCResult> }
      proxy: {
        test: (proxyDraft: any, proxyId?: string) => Promise<IPCResult>
        list: () => Promise<IPCResult>
        create: (draft: any, username?: string, password?: string) => Promise<IPCResult>
        update: (proxyId: string, patch: any) => Promise<IPCResult>
        delete: (proxyId: string) => Promise<IPCResult>
        importBatch: (items: any[]) => Promise<IPCResult>
        bind: (storeId: string, proxyId: string | null) => Promise<IPCResult>
        history: (proxyId: string, limit?: number) => Promise<IPCResult>
      }
      session: {
        status: (storeId: string) => Promise<IPCResult>
        checkLoginStatus: (storeId: string) => Promise<IPCResult>
        export: (storeId: string, outputPath?: string, validDays?: number) => Promise<IPCResult>
        import: (storeId: string, filePath?: string, pickFile?: boolean) => Promise<IPCResult>
        cookies: (storeId: string, search?: string) => Promise<IPCResult>
        deleteCookie: (storeId: string, name: string, domain: string, path: string, secure?: boolean) => Promise<IPCResult>
        clearCookies: (storeId: string) => Promise<IPCResult>
      }
      orders: {
        collect: (input: { storeId: string; maxPages?: number; maxOrders?: number; timeoutMs?: number }) => Promise<IPCResult>
        list: (query: { storeId: string; status?: string; startDate?: number; endDate?: number; page?: number; pageSize?: number }) => Promise<IPCResult>
        get: (storeId: string, orderId: string) => Promise<IPCResult>
        observation: {
          start: (input: { storeId: string; timeoutMs?: number; maxResponses?: number }) => Promise<IPCResult>
          stop: (storeId: string) => Promise<IPCResult>
        }
      }
      // 商品管理：只有"同步（只读采集）+ 查询 + 台账"，**没有发布**（发布走任务引擎与人工门禁）
      products: {
        sync: (input: { storeId: string; trigger?: 'manual' | 'schedule'; maxPages?: number; maxProducts?: number; timeoutMs?: number }) => Promise<IPCResult>
        list: (query: { storeId?: string; platform?: string; onlyOrphan?: boolean; keyword?: string; limit?: number; offset?: number }) => Promise<IPCResult>
        syncRuns: (query?: { storeId?: string }) => Promise<IPCResult>
        library: {
          list: (query?: { keyword?: string; limit?: number; offset?: number }) => Promise<IPCResult>
          get: (productId: string) => Promise<IPCResult>
          save: (input: { productId: string; platform?: string; draft: unknown }) => Promise<IPCResult>
          saveAsLocal: (input: { platform: string; storeId: string; platformProductId: string; mergeLink?: boolean }) => Promise<IPCResult>
          merge: (input: { linkId: string; productId: string }) => Promise<IPCResult>
          unmerge: (input: { linkId: string }) => Promise<IPCResult>
          remove: (productId: string) => Promise<IPCResult>
          localizeMedia: (productId: string) => Promise<IPCResult>
          queueScan: (input?: { maxItems?: number }) => Promise<IPCResult>
          queueRun: (input?: { maxItems?: number }) => Promise<IPCResult>
          orphans: () => Promise<IPCResult>
          cleanupOrphans: () => Promise<IPCResult>
        }
        detail: {
          collect: (input: { storeId: string; platformProductId: string }) => Promise<IPCResult>
        }
        publish: {
          preflight: (input: { productId: string; storeIds: string[] }) => Promise<IPCResult>
          open: (input: { itemId: string; fill?: boolean }) => Promise<IPCResult>
          items: (query?: { limit?: number }) => Promise<IPCResult>
          openGate: (input: { itemId: string; message?: string }) => Promise<IPCResult>
          confirm: (input: { itemId: string; approved: boolean }) => Promise<IPCResult>
          verify: (input: { itemId: string }) => Promise<IPCResult>
          readback: (input: { itemId: string }) => Promise<IPCResult>
          acceptSuggestion: (input: { itemId: string; field: string; kind: 'suggest_default' | 'suggest_writeback' }) => Promise<IPCResult>
          checklist: (input: { productId: string; storeId: string }) => Promise<IPCResult>
          batchCreate: (input: { productIds: string[]; storeIds: string[] }) => Promise<IPCResult>
          batchProgress: (input: { batchId: string }) => Promise<IPCResult>
          batchAbort: (input: { batchId: string }) => Promise<IPCResult>
          batchSkipStore: (input: { batchId: string; storeId: string }) => Promise<IPCResult>
        }
      }
      salesMetrics: {
        collect: (input: { storeId: string; periodType?: string; periodStart?: number; periodEnd?: number; timeoutMs?: number }) => Promise<IPCResult<SalesMetricsCollectionResult>>
        latest: (input: { storeId: string; periodType?: string }) => Promise<IPCResult<SalesMetrics | null>>
        list: (input: { storeId: string; periodType?: string; periodStart?: number; periodEnd?: number; page?: number; pageSize?: number }) => Promise<IPCResult<SalesMetricsListResult>>
        products: (input: { storeId: string; periodType?: string; periodStart?: number; periodEnd?: number; page?: number; pageSize?: number; sort?: string; limit?: number }) => Promise<IPCResult<ProductSalesMetricsListResult>>
        topProducts: (input: { storeId: string; periodType?: string; page?: number; pageSize?: number; sort?: string; limit?: number }) => Promise<IPCResult<ProductSalesMetrics[]>>
        plans: (input?: { storeId?: string; platform?: string }) => Promise<IPCResult<SalesMetricsPlanListResult>>
        planGet: (storeId: string) => Promise<IPCResult<SalesMetricsPlanView>>
        planUpdate: (input: { storeId: string; enabled?: boolean; intervalMs?: number }) => Promise<IPCResult<SalesMetricsPlanView>>
        planPause: (storeId: string) => Promise<IPCResult<SalesMetricsPlanView>>
        planResume: (storeId: string) => Promise<IPCResult<SalesMetricsPlanView>>
        planRunNow: (storeId: string, periodType?: string) => Promise<IPCResult<{ accepted: boolean; storeId: string; mode: string; reasonCode: string }>>
        runs: (input?: { storeId?: string; platform?: string; status?: string; page?: number; pageSize?: number }) => Promise<IPCResult<SalesMetricsRunListResult>>
        health: () => Promise<IPCResult<SalesMetricsHealth>>
      }
      security: {
        status: () => Promise<IPCResult>
        setPassword: (password?: string, oldPassword?: string) => Promise<IPCResult>
        removePassword: (credential?: string) => Promise<IPCResult>
        lock: () => Promise<IPCResult>
        unlock: (credential: string) => Promise<IPCResult>
      }
      backup: {
        create: (label?: string) => Promise<IPCResult>
        list: () => Promise<IPCResult>
        restore: (backupId: string) => Promise<IPCResult>
      }
      task: {
        create: (input: any) => Promise<IPCResult>
        list: () => Promise<IPCResult>
        run: (taskId: string, storeId?: string) => Promise<IPCResult>
        pause: (runId: string) => Promise<IPCResult>
        resume: (runId: string, mode?: 'continue' | 'retry') => Promise<IPCResult>
        cancel: (runId: string) => Promise<IPCResult>
        confirm: (runId: string, approved: boolean) => Promise<IPCResult>
        results: (runId: string) => Promise<IPCResult>
        delete: (taskId: string) => Promise<IPCResult>
        update: (input: Record<string, unknown>) => Promise<IPCResult>
        fireScheduled: (taskId: string) => Promise<IPCResult>
      }
      snapshot: { list: (storeId: string, limit?: number) => Promise<IPCResult> }
      /** 窗口装饰 - §17：标题栏 overlay（右上角原生窗口按钮）底色随 UI 状态切换 */
      windowChrome: {
        setTitlebarOverlay: (opts: { color?: string; symbolColor?: string }) => Promise<IPCResult>
      }
      update: {
        status: () => Promise<IPCResult>
        check: () => Promise<IPCResult>
        download: () => Promise<IPCResult>
        install: () => Promise<IPCResult>
      }
      /** 大模型（AI）配置 - §4.4：Key 只在主进程，configGet 仅返回 hasKey */
      ai: {
        configGet: () => Promise<IPCResult>
        configSet: (input: { endpoint?: string; model?: string; timeoutMs?: number }) => Promise<IPCResult>
        setKey: (key: string) => Promise<IPCResult>
        clearKey: () => Promise<IPCResult>
        test: () => Promise<IPCResult>
        listModels: () => Promise<IPCResult>
        imageConfigGet: () => Promise<IPCResult>
        imageConfigSet: (input: { endpoint?: string; model?: string; timeoutMs?: number }) => Promise<IPCResult>
        setImageKey: (key: string) => Promise<IPCResult>
        clearImageKey: () => Promise<IPCResult>
        testImage: () => Promise<IPCResult>
        listImageModels: () => Promise<IPCResult>
        imageTextConfigGet: () => Promise<IPCResult>
        imageTextConfigSet: (input: { endpoint?: string; model?: string; timeoutMs?: number }) => Promise<IPCResult>
        setImageTextKey: (key: string) => Promise<IPCResult>
        clearImageTextKey: () => Promise<IPCResult>
        testImageText: () => Promise<IPCResult>
        listImageTextModels: () => Promise<IPCResult>
        analyzeImageProduct: (input: { name?: string; tags?: string; price?: string; originalPrice?: string }) => Promise<IPCResult>
        generateImage: (input: { prompt: string; model?: string; size?: string; n?: number; confirmed?: boolean; sourceImages?: Array<{ name: string; mimeType: string; b64Json: string }> }) => Promise<IPCResult>
      }
      agent: {
        uiGet: () => Promise<IPCResult<AgentUiState>>
        uiSet: (state: AgentUiState) => Promise<IPCResult<AgentUiState>>
        observe: () => Promise<IPCResult<AgentPageObservation>>
        generatePlan: (goal: string, history?: Array<{ role: 'user' | 'assistant'; text: string }>) => Promise<IPCResult<
          | { kind: 'task'; plan: AgentPlan; observation: AgentPageObservation; model: string; elapsedMs: number; requiresApproval: boolean }
          | { kind: 'software'; plan: AgentSoftwarePlan; context: AgentSoftwareContext; model: string; elapsedMs: number; pendingGoal?: string; thought?: string; requiresApproval: boolean }
          | { kind: 'chat'; text: string; model: string; elapsedMs: number; thoughts?: string[]; jobIds?: string[]; executed?: string[]; usage?: AgentContextUsage }
        >>
        /** Job 结束后自动续办：把用户目标与 Job 结果交给智能体回合判断下一步。 */
        jobFollowUp: (goal: string, jobIds: string[], history?: Array<{ role: 'user' | 'assistant'; text: string }>) => Promise<IPCResult<
          | { kind: 'software'; plan: AgentSoftwarePlan; context: AgentSoftwareContext; model: string; elapsedMs: number; thought?: string; requiresApproval: boolean }
          | { kind: 'chat'; text: string; model: string; elapsedMs: number; thoughts?: string[]; jobIds?: string[]; executed?: string[]; usage?: AgentContextUsage }
        >>
        validatePlan: (plan: AgentPlan) => Promise<IPCResult>
        softwareContext: () => Promise<IPCResult<AgentSoftwareContext>>
        validateSoftwarePlan: (plan: AgentSoftwarePlan) => Promise<IPCResult>
        executeSoftwarePlan: (plan: AgentSoftwarePlan, confirmed?: boolean) => Promise<IPCResult>
      }
      agentDomain: {
        orgList: (query?: Record<string, unknown>) => Promise<IPCResult>
        orgGet: (agentId: string) => Promise<IPCResult>
        modelList: (query?: Record<string, unknown>) => Promise<IPCResult>
        modelSet: (profile: ModelProfileInput) => Promise<IPCResult>
        modelDelete: (profileId: string) => Promise<IPCResult>
        modelTest: (profileId: string) => Promise<IPCResult>
        jobCreate: (input: AgentJobCreate) => Promise<IPCResult>
        jobDelegate: (input: AgentTaskDelegate) => Promise<IPCResult>
        jobList: (query?: Record<string, unknown>) => Promise<IPCResult>
        jobGet: (jobId: string) => Promise<IPCResult>
        jobRun: (jobId: string) => Promise<IPCResult>
        jobCancel: (jobId: string) => Promise<IPCResult>
        jobApprove: (jobId: string, approved: boolean, confirmationId?: string) => Promise<IPCResult>
        jobResultReview: (input: AgentJobResultReview) => Promise<IPCResult>
        jobFeedback: (input: AgentJobFeedback) => Promise<IPCResult>
        jobResume: (jobId: string) => Promise<IPCResult>
        memoryList: (query: Record<string, unknown>) => Promise<IPCResult>
        memorySearch: (query: Record<string, unknown>) => Promise<IPCResult>
        memoryWrite: (input: AgentMemoryWrite) => Promise<IPCResult>
        memoryReview: (input: AgentMemoryReview) => Promise<IPCResult>
        memoryRebuild: () => Promise<IPCResult>
        memorySnapshot: () => Promise<IPCResult>
        memorySnapshotInspect: (path: string) => Promise<IPCResult>
        memorySnapshotRestore: (path: string, confirmedOrExpectedSha256?: boolean | string, expectedSha256?: string) => Promise<IPCResult>
        memoryLearningSettings: (input?: { autoLearn: boolean; retentionDays: number }) => Promise<IPCResult>
        memoryMaintenance: () => Promise<IPCResult>
        qualityMetrics: () => Promise<IPCResult>
        qualityReview: () => Promise<IPCResult>
        commerceLedgerList: (query?: { storeId?: string; status?: string; limit?: number }) => Promise<IPCResult>
        /** 技能/插件库：面板直接创建技能时走与模型同一套校验，工具下拉来自 Main 的可用目录。 */
        skillList: () => Promise<IPCResult>
        skillCreate: (input: Record<string, unknown>) => Promise<IPCResult>
        skillTools: () => Promise<IPCResult>
        skillUpdate: (input: Record<string, unknown>) => Promise<IPCResult>
        skillDelete: (skillId: string) => Promise<IPCResult>
        /** 插件的改/删（只改声明式分组；删插件保留成员技能）。 */
        pluginUpdate: (input: Record<string, unknown>) => Promise<IPCResult>
        pluginDelete: (input: Record<string, unknown>) => Promise<IPCResult>
        packExport: (input?: Record<string, unknown>) => Promise<IPCResult>
        packImport: (json: string, confirmed?: boolean) => Promise<IPCResult>
      }
      on: (channel: string, callback: (...args: any[]) => void) => void
      off: (channel: string, callback: (...args: any[]) => void) => void
    }
  }
}

export {}
