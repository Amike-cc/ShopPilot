/// <reference types="vite/client" />

import type { IPCResult } from '@shared/contracts/ipc'
import type {
  AgentPlan,
  AgentPageObservation,
  AgentSoftwareContext,
  AgentSoftwarePlan,
  AgentUiState
} from '@shared/schemas/agent'
import type { AgentJobCreate, AgentJobFeedback, AgentJobResultReview, AgentMemoryReview, AgentMemoryWrite, AgentTaskDelegate, ModelProfileInput } from '@shared/schemas/agent-domain'

export interface TabInfo {
  id: string
  url: string
  title: string
  isPinned: boolean
  orderIndex: number
  loading?: boolean
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
        open: (storeId: string) => Promise<IPCResult>
        close: (storeId: string) => Promise<IPCResult>
        display: (storeId: string | null) => Promise<IPCResult>
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
        /** 弹层打开/关闭：让主进程摘除/恢复原生视图挂载 */
        setViewsObscured: (obscured: boolean, reason?: 'modal' | 'agent') => Promise<IPCResult>
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
        export: (storeId: string, outputPath?: string, validDays?: number) => Promise<IPCResult>
        import: (storeId: string, filePath?: string, pickFile?: boolean) => Promise<IPCResult>
        cookies: (storeId: string, search?: string) => Promise<IPCResult>
        deleteCookie: (storeId: string, name: string, domain: string, path: string, secure?: boolean) => Promise<IPCResult>
        clearCookies: (storeId: string) => Promise<IPCResult>
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
      }
      agent: {
        uiGet: () => Promise<IPCResult<AgentUiState>>
        uiSet: (state: AgentUiState) => Promise<IPCResult<AgentUiState>>
        observe: () => Promise<IPCResult<AgentPageObservation>>
        generatePlan: (goal: string, history?: Array<{ role: 'user' | 'assistant'; text: string }>) => Promise<IPCResult<
          | { kind: 'task'; plan: AgentPlan; observation: AgentPageObservation; model: string; elapsedMs: number; requiresApproval: boolean }
          | { kind: 'software'; plan: AgentSoftwarePlan; context: AgentSoftwareContext; model: string; elapsedMs: number; pendingGoal?: string; thought?: string; requiresApproval: boolean }
          | { kind: 'chat'; text: string; model: string; elapsedMs: number; thoughts?: string[]; jobIds?: string[]; executed?: string[] }
        >>
        validatePlan: (plan: AgentPlan) => Promise<IPCResult>
        softwareContext: () => Promise<IPCResult<AgentSoftwareContext>>
        validateSoftwarePlan: (plan: AgentSoftwarePlan) => Promise<IPCResult>
        executeSoftwarePlan: (plan: AgentSoftwarePlan, confirmed?: boolean) => Promise<IPCResult>
      }
      agentDomain: {
        orgList: (query?: Record<string, unknown>) => Promise<IPCResult>
        orgGet: (agentId: string) => Promise<IPCResult>
        orgCreate: (input: Record<string, unknown>) => Promise<IPCResult>
        orgUpdate: (input: Record<string, unknown>) => Promise<IPCResult>
        orgActivate: (agentId: string, confirmed?: boolean) => Promise<IPCResult>
        orgPause: (agentId: string, confirmed?: boolean) => Promise<IPCResult>
        orgResume: (agentId: string, confirmed?: boolean) => Promise<IPCResult>
        orgRetire: (agentId: string, confirmed?: boolean) => Promise<IPCResult>
        hrPreview: (role: string) => Promise<IPCResult>
        modelList: (query?: Record<string, unknown>) => Promise<IPCResult>
        modelSet: (profile: ModelProfileInput) => Promise<IPCResult>
        modelDelete: (profileId: string) => Promise<IPCResult>
        modelTest: (profileId: string) => Promise<IPCResult>
        modelBind: (agentId: string, modelProfileId: string | null) => Promise<IPCResult>
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
        memorySnapshotRestore: (path: string, confirmed?: boolean) => Promise<IPCResult>
        qualityMetrics: () => Promise<IPCResult>
        qualityReview: () => Promise<IPCResult>
      }
      on: (channel: string, callback: (...args: any[]) => void) => void
      off: (channel: string, callback: (...args: any[]) => void) => void
    }
  }
}

export {}
