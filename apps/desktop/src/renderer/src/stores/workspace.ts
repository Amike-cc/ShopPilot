/**
 * 工作台状态中枢（Pinia）- §4.5 Renderer 状态
 * 店铺列表、当前显示店铺、标签页、下载、书签、Toast、回收站。
 * 主进程是唯一数据源；事件驱动增量更新（§7）。
 */

import { defineStore } from 'pinia'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import { PLATFORM_CATALOG } from '@shared/constants/platforms'
import type { TabInfo } from '../env'

/**
 * 「其他」平台筛选项的哨兵值：内置平台目录之外的自定义平台聚合成一个 chip
 * （同名值必须与 WorkbenchView 的 availablePlatforms 一致，否则筛选条件永远匹配不到店铺）。
 */
export const OTHER_PLATFORM_FILTER = '__other__'

const BUILTIN_PLATFORM_NAMES = new Set(PLATFORM_CATALOG.map(p => p.name))

/** 事件监听只挂一次：热重载/重复 init 时重复挂会让每个事件被处理多遍（重复 toast、重复刷新） */
let eventsSubscribed = false

const MAX_LIVE_RUNS = 128
const MAX_TASK_LOG_RUNS = 96

function pruneRunRecordMap(map: Record<string, any>, max: number): Record<string, any> {
  const entries = Object.entries(map)
  if (entries.length <= max) return map
  const ranked = entries.slice().map((entry, index) => ({ entry, index }))
    .sort((a, b) => (Number(b.entry[1]?.updatedAt || 0) || b.index) - (Number(a.entry[1]?.updatedAt || 0) || a.index))
  const keep = new Set(ranked.slice(0, max).map(({ entry: [id] }) => id))
  const next: Record<string, any> = {}
  for (const [id, value] of entries) if (keep.has(id)) next[id] = value
  return next
}

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
    /**
     * 最近一次显示切换的来源：'main' = 主进程单方面显示（Agent/开店自动显示）→ 界面应跟随切页；
     * 'renderer' = 界面自己请求的（它已在正确页面上，跟随反而会打乱自己的导航）。
     */
    displaySource: 'renderer' as 'renderer' | 'main',
    /** 已打开浏览器的店铺集合 */
    openStoreIds: [] as string[],
    /** 各店铺标签页（事件驱动） */
    tabsByStore: {} as Record<string, TabInfo[]>,
    activeTabIdByStore: {} as Record<string, string | null>,
    /** 各店铺正在加载的标签页（`storeId:tabId`）：loadingTab 必须按店铺区分，
     *  否则 A 店的加载结束会把 B 店的转圈清掉 */
    loadingTabs: [] as string[],
    /** 右栏 */
    rightPanel: 'bookmarks' as 'bookmarks' | 'downloads' | 'env' | 'tasks',
    bookmarks: [] as any[],
    bookmarksStoreId: null as string | null,
    downloads: [] as any[],
    downloadsStoreId: null as string | null,
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
      // 「其他」比较的是**平台是否属于内置目录**，不能拿哨兵值与 s.platform 直接比相等
      if (state.filterPlatform === OTHER_PLATFORM_FILTER) {
        rows = rows.filter(s => !BUILTIN_PLATFORM_NAMES.has(s.platform))
      } else if (state.filterPlatform) {
        rows = rows.filter(s => s.platform === state.filterPlatform)
      }
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
      const tabs = state.displayedStoreId ? (state.tabsByStore[state.displayedStoreId] || []) : []
      // 采集专用页是主进程的内部页面：不进用户的标签栏（用户没开过它，就不该看见它出现/消失）
      return tabs.filter(tab => tab.internal !== true)
    },
    activeTab(state): TabInfo | null {
      if (!state.displayedStoreId) return null
      const activeId = state.activeTabIdByStore[state.displayedStoreId]
      const tabs = (state.tabsByStore[state.displayedStoreId] || []).filter(tab => tab.internal !== true)
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
      if (eventsSubscribed) return
      eventsSubscribed = true
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
      // 主进程单方面切换了"当前显示哪家店"（采集任务批量开店铺、Agent 逐店动作都会走
      // openStoreBrowser → displayStore）：渲染层必须跟上，否则原生店铺视图会盖在当前 UI 上，
      // 而左栏高亮/标签栏/地址栏都停在旧状态。DashboardView 会据 displayedStoreId 切到浏览器页。
      window.shopilot.on(EVENT_CHANNELS.BROWSER_DISPLAY_CHANGED, (payload: any) => {
        const storeId = payload?.storeId ?? null
        // 来源决定界面要不要"跟随切页"：只有主进程单方面显示（Agent 动作/开店后自动显示）
        // 才需要切页；渲染层自己请求的显示，界面本来就在正确的页上（跟随会打乱它自己的导航时序）
        this.displaySource = payload?.source === 'main' ? 'main' : 'renderer'
        if (storeId) {
          if (!this.openStoreIds.includes(storeId)) this.openStoreIds = [...this.openStoreIds, storeId]
          this.selectedStoreId = storeId
        } else if (this.selectedStoreId && !this.openStoreIds.includes(this.selectedStoreId)) {
          this.selectedStoreId = null
        }
        this.displayedStoreId = storeId
        void Promise.all([this.refreshBookmarks(), this.refreshDownloads()])
      })
      window.shopilot.on(EVENT_CHANNELS.BROWSER_LOADING_CHANGED, (payload: any) => {
        const key = `${payload?.storeId || ''}:${payload?.tabId || ''}`
        if (payload.isLoading) {
          if (!this.loadingTabs.includes(key)) this.loadingTabs = [...this.loadingTabs, key]
        } else {
          this.loadingTabs = this.loadingTabs.filter(k => k !== key)
        }
      })
      window.shopilot.on(EVENT_CHANNELS.BROWSER_CRASHED, (payload: any) => {
        this.toast(`页面异常已恢复（${payload.reason}）`, 'error')
      })
      window.shopilot.on(EVENT_CHANNELS.STORE_STATUS_CHANGED, (payload: any) => {
        const storeId = String(payload?.storeId || '')
        const status = String(payload?.status || '')
        if (!storeId || !status) return
        const index = this.stores.findIndex(store => store.id === storeId)
        if (index < 0) return
        this.stores[index] = { ...this.stores[index], status }
      })
      // 下载：创建与进度都由主进程推送（2026-09-28 前主进程从不发送，面板只能手动刷新）。
      // 新下载 → 若正看着那家店的下载列表就刷新，并给一条轻提示；失败终态 → 明确告知。
      window.shopilot.on(EVENT_CHANNELS.BROWSER_DOWNLOAD_CREATED, (payload: any) => {
        if (!payload?.storeId) return
        if (this.displayedStoreId === payload.storeId) void this.refreshDownloads()
      })
      window.shopilot.on(EVENT_CHANNELS.BROWSER_DOWNLOAD_PROGRESS, (payload: any) => {
        if (!payload?.id) return
        const known = this.downloads.some(d => d.id === payload.id)
        if (this.displayedStoreId === payload.storeId && (known || payload.state !== 'progressing')) {
          void this.refreshDownloads()
        }
        // 终态且不是完成 → 失败必须让用户看见（此前 done 只写库，界面上什么都没有）
        if (payload.state === 'interrupted' || payload.state === 'cancelled') {
          const name = (this.downloads.find(d => d.id === payload.id) as any)?.fileName || '文件'
          this.toast(`下载${payload.state === 'cancelled' ? '已取消' : '中断'}：${name}`, 'error')
        }
      })
      // ---- 任务事件 - §6.6 ----
      window.shopilot.on(EVENT_CHANNELS.TASK_PROGRESS, (ev: any) => {
        const prev = this.runLive[ev.runId] || {}
        this.runLive = pruneRunRecordMap({
          ...this.runLive,
          [ev.runId]: { ...prev, status: ev.status, phase: ev.phase, stepIndex: ev.stepIndex ?? prev.stepIndex ?? null, message: ev.message || prev.message || '', updatedAt: Date.now() }
        }, MAX_LIVE_RUNS)
        const log = (this.taskLogs[ev.runId] || []).concat([{ ...ev, at: Date.now() }])
        this.taskLogs = pruneRunRecordMap({ ...this.taskLogs, [ev.runId]: log.slice(-80) }, MAX_TASK_LOG_RUNS)
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
      // 渲染层重载/崩溃恢复后主进程仍持有已打开的店铺视图，但事件是"发过就没了"，
      // 必须主动补齐一次，否则左栏会显示"未打开"、点店铺只回欢迎页（页面却还在上面盖着）。
      await this.hydrateBrowserState()
      this.ready = true
    },

    /**
     * 与主进程对齐"哪些店铺已打开、标签页与活动页、当前显示的是哪一家"。
     *
     * 渲染层重载/崩溃恢复后事件不会补发，只能主动问一次。用主进程的**权威状态**而不是
     * 在渲染层猜：猜 display 会把用户刻意停留的欢迎页换成某家店铺的页面，猜活动标签页
     * 会让截图/关闭落到另一个标签上。
     */
    async hydrateBrowserState() {
      const res = await window.shopilot.browser.state()
      if (!res.ok) return
      const data = res.data as { displayedStoreId: string | null; stores: Array<{ storeId: string; activeTabId: string | null; tabs: TabInfo[] }> }
      for (const item of data?.stores || []) {
        if (!item?.storeId || !(item.tabs || []).length) continue
        this.tabsByStore[item.storeId] = item.tabs
        if (item.activeTabId) this.activeTabIdByStore[item.storeId] = item.activeTabId
        if (!this.openStoreIds.includes(item.storeId)) this.openStoreIds.push(item.storeId)
      }
      const displayed = data?.displayedStoreId || null
      // 主进程没在显示任何店铺（用户停在欢迎页）→ 保持欢迎页，不要替他打开
      if (displayed && this.stores.some(s => s.id === displayed)) {
        this.displayedStoreId = displayed
        this.selectedStoreId = displayed
        await Promise.all([this.refreshBookmarks(), this.refreshDownloads()])
      }
    },

    async refreshStores() {
      const res = await window.shopilot.store.list()
      if (res.ok) this.stores = (res.data || []).map(toRow)
      else this.toast('加载店铺失败: ' + res.error.message, 'error')
      // 彻底删除 / 备份恢复后店铺可能已经不在了：留下旧的 selected/displayed 会让界面
      // 显示一个不存在的店铺（右栏、首页地址、显示中的原生视图都对不上）
      const alive = new Set(this.stores.map(s => s.id))
      if (this.selectedStoreId && !alive.has(this.selectedStoreId)) this.selectedStoreId = null
      if (this.displayedStoreId && !alive.has(this.displayedStoreId)) {
        this.displayedStoreId = null
        this.openStoreIds = this.openStoreIds.filter(id => alive.has(id))
        this.downloads = []
        this.downloadsStoreId = null
        void window.shopilot.browser.display(null)
      }
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
      const sid = this.displayedStoreId || null
      const res = await window.shopilot.bookmark.list(sid || undefined)
      // 请求期间可能已经切到别的店铺：迟到的应答不能覆盖当前店铺的收藏
      if (this.displayedStoreId !== sid) return
      if (res.ok) { this.bookmarks = res.data || []; this.bookmarksStoreId = sid }
    },

    async refreshDownloads() {
      const sid = this.displayedStoreId
      if (!sid) { this.downloads = []; this.downloadsStoreId = null; return }
      const res = await window.shopilot.download.list(sid, 50)
      if (this.displayedStoreId !== sid) return
      if (res.ok) { this.downloads = res.data || []; this.downloadsStoreId = sid }
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
          if (next) {
            // showStore 只管显示，不管选中态：按下标选中的左栏高亮必须一起改，
            // 否则关闭后高亮留在已关闭的店铺上、显示的却是另一家
            this.selectedStoreId = next
            await this.showStore(next)
          } else {
            this.displayedStoreId = null
            this.selectedStoreId = null
            this.downloads = []
            this.downloadsStoreId = null
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
        // 主进程侧已关闭该店铺的浏览器与会话，这边要把本地状态一起收干净：
        // 只清 displayedStoreId 会留下已打开的标签页缓存，且若它正是显示中的店铺，
        // 原生视图仍挂在窗口上盖住欢迎页（display(null) 才是摘除动作）。
        this.openStoreIds = this.openStoreIds.filter(id => id !== storeId)
        delete this.tabsByStore[storeId]
        delete this.activeTabIdByStore[storeId]
        if (this.displayedStoreId === storeId) {
          this.displayedStoreId = null
          this.selectedStoreId = null
          this.downloads = []
          this.downloadsStoreId = null
          this.bookmarks = []
          this.bookmarksStoreId = null
          void window.shopilot.browser.display(null)
        }
        // 必须同时刷新回收站列表：徽标计数来自 trashStores，只刷店铺列表会让刚移入的店铺不计数
        await Promise.all([this.refreshStores(), this.refreshTrash()])
        this.toast('已移入回收站', 'success')
      } else this.toast('移入回收站失败: ' + res.error.message, 'error')
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
