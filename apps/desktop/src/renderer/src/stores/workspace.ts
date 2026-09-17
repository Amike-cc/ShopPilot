/**
 * 工作台状态中枢（Pinia）- §4.5 Renderer 状态
 * 店铺列表、当前显示店铺、标签页、下载、书签、Toast、回收站。
 * 主进程是唯一数据源；事件驱动增量更新（§7）。
 */

import { defineStore } from 'pinia'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import type { TabInfo } from '../env'

export interface StoreRow {
  id: string
  name: string
  platform: string
  adminUrl: string
  status: string
  avatarColor: string
  sortOrder: number
  groupName: string | null
  tags: string[]
  owner?: string | null
  region?: string | null
  /** 营业执照主体名称与统一社会信用代码（发票按主体分账用；两字段都可为空 = 未填写） */
  licenseName?: string | null
  licenseNo?: string | null
  lastActiveAt: number | null
}

export interface ToastItem {
  id: number
  kind: 'info' | 'success' | 'error'
  text: string
}

let toastSeq = 1

function parseTags(row: any): string[] {
  try { return JSON.parse(row.tagsJson || '[]') } catch { return [] }
}

/**
 * 店铺搜索的匹配文本：名称 / 平台 / 分组 / 标签 / 营业执照（名称与代码）。
 * 带上营业执照是为了「按主体找店」——同一家公司开了好几家店时，搜公司名就能把它们全捞出来。
 */
function storeMatchesQuery(s: StoreRow, q: string): boolean {
  return [
    s.name, s.platform, s.groupName || '', s.tags.join(' '), s.licenseName || '', s.licenseNo || ''
  ].join(' ').toLowerCase().includes(q)
}

function toRow(row: any): StoreRow {
  return {
    id: row.id, name: row.name, platform: row.platform, adminUrl: row.adminUrl,
    status: row.status, avatarColor: row.avatarColor || '#3B82F6',
    sortOrder: Number(row.sortOrder) || 0,
    groupName: row.groupName ?? null, tags: parseTags(row),
    owner: row.owner ?? null, region: row.region ?? null,
    licenseName: row.licenseName ?? null, licenseNo: row.licenseNo ?? null,
    lastActiveAt: row.lastActiveAt ?? null
  }
}

export const useWorkspaceStore = defineStore('workspace', {
  state: () => ({
    stores: [] as StoreRow[],
    search: '',
    filterPlatform: '',
    selectedStoreId: null as string | null,
    /** 当前内嵌显示的店铺（null = 欢迎页） */
    displayedStoreId: null as string | null,
    /** 已打开浏览器的店铺集合 */
    openStoreIds: [] as string[],
    /** 各店铺标签页（事件驱动） */
    tabsByStore: {} as Record<string, TabInfo[]>,
    activeTabIdByStore: {} as Record<string, string | null>,
    loadingTab: null as string | null,
    /** 右栏 */
    rightPanel: 'bookmarks' as 'bookmarks' | 'downloads' | 'env' | 'tasks',
    bookmarks: [] as any[],
    downloads: [] as any[],
    /** 任务引擎 - §6.4/§6.6（事件驱动实时态） */
    tasks: [] as any[],
    runLive: {} as Record<string, any>,
    taskLogs: {} as Record<string, any[]>,
    confirmations: {} as Record<string, any>,
    /** 应用锁 - §6.5 */
    appLocked: false,
    securityEnabled: false,
    idleMinutes: 0,
    /** 代理健康事件计数（环境面板据此刷新） */
    proxyEpoch: 0,
    /** 回收站 */
    trashOpen: false,
    trashStores: [] as StoreRow[],
    /** 新建店铺对话框 */
    createDialogOpen: false,
    toasts: [] as ToastItem[],
    ready: false
  }),

  getters: {
    filteredStores(state): StoreRow[] {
      let rows = state.stores
      if (state.filterPlatform) rows = rows.filter(s => s.platform === state.filterPlatform)
      const q = state.search.trim().toLowerCase()
      if (q) rows = rows.filter(s => storeMatchesQuery(s, q))
      return rows
    },
    platformCounts(): Record<string, number> {
      // 在应用平台筛选之前，按搜索后的结果统计各平台店铺数
      let rows = this.stores
      const q = this.search.trim().toLowerCase()
      if (q) rows = rows.filter(s => storeMatchesQuery(s, q))
      const counts: Record<string, number> = {}
      for (const s of rows) {
        counts[s.platform] = (counts[s.platform] || 0) + 1
      }
      return counts
    },
    groupedStores(): Array<{ group: string; items: StoreRow[] }> {
      const map = new Map<string, StoreRow[]>()
      for (const s of this.filteredStores) {
        const g = s.groupName || '未分组'
        if (!map.has(g)) map.set(g, [])
        map.get(g)!.push(s)
      }
      return Array.from(map.entries())
        .map(([group, items]) => ({ group, items }))
        .sort((a, b) => (a.group === '未分组' ? 1 : b.group === '未分组' ? -1 : a.group.localeCompare(b.group)))
    },
    displayedTabs(state): TabInfo[] {
      return state.displayedStoreId ? (state.tabsByStore[state.displayedStoreId] || []) : []
    },
    activeTab(state): TabInfo | null {
      if (!state.displayedStoreId) return null
      const activeId = state.activeTabIdByStore[state.displayedStoreId]
      const tabs = state.tabsByStore[state.displayedStoreId] || []
      return tabs.find(t => t.id === activeId) || tabs[0] || null
    },
    selectedStore(state): StoreRow | null {
      return state.stores.find(s => s.id === state.selectedStoreId) || null
    }
  },

  actions: {
    toast(text: string, kind: ToastItem['kind'] = 'info', ms = 3500) {
      const id = toastSeq++
      this.toasts.push({ id, kind, text })
      setTimeout(() => { this.toasts = this.toasts.filter(t => t.id !== id) }, ms)
    },

    subscribeEvents() {
      window.shopilot.on(EVENT_CHANNELS.BROWSER_TAB_UPDATED, (payload: any) => {
        if (!payload || !payload.storeId) return
        this.tabsByStore[payload.storeId] = payload.tabs || []
        this.activeTabIdByStore[payload.storeId] = payload.activeTabId ?? null
        if (!this.openStoreIds.includes(payload.storeId) && (payload.tabs || []).length > 0) {
          this.openStoreIds.push(payload.storeId)
        }
        if ((payload.tabs || []).length === 0) {
          this.openStoreIds = this.openStoreIds.filter(id => id !== payload.storeId)
        }
      })
      window.shopilot.on(EVENT_CHANNELS.BROWSER_LOADING_CHANGED, (payload: any) => {
        this.loadingTab = payload.isLoading ? payload.tabId : null
      })
      window.shopilot.on(EVENT_CHANNELS.BROWSER_CRASHED, (payload: any) => {
        this.toast(`页面异常已恢复（${payload.reason}）`, 'error')
      })
      window.shopilot.on(EVENT_CHANNELS.BROWSER_DOWNLOAD_PROGRESS, (payload: any) => {
        if (this.downloads.some(d => d.id === payload.id)) this.refreshDownloads()
      })
      // ---- 任务事件 - §6.6 ----
      window.shopilot.on(EVENT_CHANNELS.TASK_PROGRESS, (ev: any) => {
        const prev = this.runLive[ev.runId] || {}
        this.runLive = {
          ...this.runLive,
          [ev.runId]: { ...prev, status: ev.status, phase: ev.phase, stepIndex: ev.stepIndex ?? prev.stepIndex ?? null, message: ev.message || prev.message || '', updatedAt: Date.now() }
        }
        const log = (this.taskLogs[ev.runId] || []).concat([{ ...ev, at: Date.now() }])
        this.taskLogs = { ...this.taskLogs, [ev.runId]: log.slice(-80) }
        if (['succeeded', 'failed', 'cancelled'].includes(ev.status)) this.clearConfirmation(ev.runId)
        if (ev.phase === 'finished' || ev.phase === 'failed') { this.refreshTasks() }
      })
      window.shopilot.on(EVENT_CHANNELS.TASK_CONFIRMATION_REQUIRED, (ev: any) => {
        this.confirmations = { ...this.confirmations, [ev.runId]: ev }
        this.toast(`任务「${ev.message}」等待人工确认`, 'info')
      })
      window.shopilot.on(EVENT_CHANNELS.TASK_SCHEDULED_FIRED, (ev: any) => {
        this.toast(ev.message, 'info')
        this.refreshTasks()
      })
      // ---- 安全/健康事件 ----
      window.shopilot.on(EVENT_CHANNELS.SECURITY_LOCKED, (ev: any) => {
        this.appLocked = !!ev?.locked
        if (this.appLocked) this.toast('应用已锁定', 'info')
      })
      window.shopilot.on(EVENT_CHANNELS.PROXY_HEALTH_CHANGED, (ev: any) => {
        this.proxyEpoch++
        if (ev?.status === 'error') {
          this.toast(`代理体检失败${ev.errorCode ? '（' + ev.errorCode + '）' : ''}：出口异常。按规范不会自动切换或降级，请在环境面板检查。`, 'error')
        }
      })
    },

    async refreshSecurity() {
      const res = await window.shopilot.security.status()
      if (res.ok) {
        this.appLocked = !!res.data.locked
        this.securityEnabled = !!res.data.enabled
        this.idleMinutes = res.data.idleMinutes ?? 0
      }
    },

    async unlockApp(credential: string): Promise<boolean> {
      const res = await window.shopilot.security.unlock(credential)
      if (!res.ok) return false
      this.appLocked = false
      await Promise.all([this.refreshStores(), this.refreshTasks()])
      return true
    },

    async refreshTasks() {
      const res = await window.shopilot.task.list()
      if (res.ok) this.tasks = res.data || []
    },

    clearConfirmation(runId: string) {
      const next = { ...this.confirmations }
      delete next[runId]
      this.confirmations = next
    },

    async init() {
      this.subscribeEvents()
      await this.refreshSecurity()
      await this.refreshStores()
      // 回收站徽标（左栏底栏 / 收起后的窄轨角标）依赖 trashStores，必须启动就加载，
      // 否则库里已有回收站店铺时徽标仍是空的（原先只在点开抽屉时才拉）。
      await this.refreshTrash()
      this.ready = true
    },

    async refreshStores() {
      const res = await window.shopilot.store.list()
      if (res.ok) this.stores = (res.data || []).map(toRow)
      else this.toast('加载店铺失败: ' + res.error.message, 'error')
    },

    async reorderStores(orderedStoreIds: string[]): Promise<boolean> {
      const previous = this.stores
      const byId = new Map(previous.map(store => [store.id, store]))
      const optimistic = orderedStoreIds
        .map((id, index) => {
          const store = byId.get(id)
          return store ? { ...store, sortOrder: index } : null
        })
        .filter((store): store is StoreRow => store !== null)

      if (optimistic.length !== previous.length) {
        this.toast('保存排序失败: 店铺列表已变化，请重试', 'error')
        return false
      }

      this.stores = optimistic
      const res = await window.shopilot.store.reorder(orderedStoreIds)
      if (!res.ok) {
        this.stores = previous
        this.toast('保存排序失败: ' + res.error.message, 'error')
        return false
      }

      await this.refreshStores()
      return true
    },

    async refreshBookmarks() {
      const res = await window.shopilot.bookmark.list(this.displayedStoreId || undefined)
      if (res.ok) this.bookmarks = res.data || []
    },

    async refreshDownloads() {
      if (!this.displayedStoreId) { this.downloads = []; return }
      const res = await window.shopilot.download.list(this.displayedStoreId, 50)
      if (res.ok) this.downloads = res.data || []
    },

    async refreshTrash() {
      const res = await window.shopilot.store.trashList()
      if (res.ok) this.trashStores = (res.data || []).map(toRow)
    },

    async selectStore(storeId: string) {
      this.selectedStoreId = storeId
      if (this.openStoreIds.includes(storeId)) {
        await this.showStore(storeId)
      } else {
        // 选中但未打开 → 回欢迎页
        this.displayedStoreId = null
        await window.shopilot.browser.display(null)
      }
    },

    async showStore(storeId: string) {
      this.displayedStoreId = storeId
      const res = await window.shopilot.browser.display(storeId)
      if (!res.ok) this.toast('切换店铺失败: ' + res.error.message, 'error')
      await Promise.all([this.refreshBookmarks(), this.refreshDownloads()])
    },

    async openStore(storeId: string) {
      const res = await window.shopilot.browser.open(storeId)
      if (res.ok) {
        this.selectedStoreId = storeId
        this.displayedStoreId = storeId
        if (!this.openStoreIds.includes(storeId)) this.openStoreIds.push(storeId)
        await Promise.all([this.refreshBookmarks(), this.refreshDownloads()])
      } else {
        this.toast('打开店铺浏览器失败: ' + res.error.message, 'error')
      }
    },

    async closeStore(storeId: string) {
      const res = await window.shopilot.browser.close(storeId)
      if (res.ok) {
        this.openStoreIds = this.openStoreIds.filter(id => id !== storeId)
        delete this.tabsByStore[storeId]
        if (this.displayedStoreId === storeId) {
          const next = this.openStoreIds[0] || null
          if (next) await this.showStore(next)
          else {
            this.displayedStoreId = null
            this.downloads = []
          }
        }
        await this.refreshStores()
      }
    },

    async newTab(url?: string) {
      if (!this.displayedStoreId) return
      const res = await window.shopilot.browser.tab.create(this.displayedStoreId, url || 'about:blank')
      if (!res.ok) this.toast('新建标签页失败: ' + res.error.message, 'error')
    },

    async activateTab(tabId: string) {
      if (!this.displayedStoreId) return
      await window.shopilot.browser.tab.activate(this.displayedStoreId, tabId)
    },

    async closeTab(tabId: string) {
      if (!this.displayedStoreId) return
      await window.shopilot.browser.tab.close(this.displayedStoreId, tabId)
    },

    async navigate(url: string) {
      if (!this.displayedStoreId) return
      const tab = this.activeTab
      if (!tab) { await this.newTab(url); return }
      const res = await window.shopilot.browser.navigate(this.displayedStoreId, tab.id, url)
      if (!res.ok) this.toast('导航被拒绝: ' + res.error.message, 'error')
    },

    async tabControl(action: 'back' | 'forward' | 'reload') {
      if (!this.displayedStoreId || !this.activeTab) return
      await window.shopilot.browser.tab.control(this.displayedStoreId, this.activeTab.id, action)
    },

    async createStore(input: any) {
      const res = await window.shopilot.store.create(input)
      if (res.ok) {
        this.createDialogOpen = false
        await this.refreshStores()
        this.toast('店铺已创建', 'success')
      } else {
        this.toast('创建失败: ' + res.error.message, 'error')
      }
      return res
    },

    /**
     * 设置店铺的营业执照（发票中心 / 新建店铺共用）。
     * 把主进程的**字段级**校验消息带回来（如信用代码位数不对），界面才能说清是哪儿填错了；
     * 失败时**不**改本地列表：主体归属错一个公司就是开错票，宁可让人重试。
     */
    async setStoreLicense(storeId: string, licenseName: string, licenseNo: string): Promise<{ ok: boolean; message?: string }> {
      const res = await window.shopilot.store.update({ storeId, patch: { licenseName, licenseNo } })
      if (!res.ok) {
        const detail = Array.isArray(res.error?.details) ? res.error.details[0]?.message : ''
        return { ok: false, message: detail || res.error?.message || '保存失败' }
      }
      await this.refreshStores()
      return { ok: true }
    },

    async archiveStore(storeId: string) {
      const res = await window.shopilot.store.archive(storeId)
      if (res.ok) { await this.refreshStores(); this.toast('已归档', 'success') }
      else this.toast('归档失败: ' + res.error.message, 'error')
    },

    async moveToTrash(storeId: string) {
      const res = await window.shopilot.store.deletePermanent(storeId)
      if (res.ok) {
        // 必须同时刷新回收站列表：徽标计数来自 trashStores，只刷店铺列表会让刚移入的店铺不计数
        await Promise.all([this.refreshStores(), this.refreshTrash()])
        this.toast('已移入回收站', 'success')
        if (this.displayedStoreId === storeId) { this.displayedStoreId = null }
      } else this.toast('移入回收站失败', 'error')
    },

    async restoreStore(storeId: string) {
      const res = await window.shopilot.store.restore(storeId)
      if (res.ok) { await Promise.all([this.refreshStores(), this.refreshTrash()]); this.toast('已恢复', 'success') }
      else this.toast('恢复失败: ' + res.error.message, 'error')
    },

    async purgeStore(storeId: string) {
      const res = await window.shopilot.store.purge(storeId)
      if (res.ok) { await this.refreshTrash(); this.toast('已彻底删除', 'success') }
      else this.toast('彻底删除失败: ' + res.error.message, 'error')
    }
  }
})
