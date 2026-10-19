import { computed, reactive, ref, watch } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import {
  describeCloseResult,
  planBatchClose,
  pruneTabSelection,
  selectTabRange as computeTabRange,
  toggleTabSelection as toggleSelection,
  type BatchCloseDialog,
  type BatchCloseRequest
} from './tabs-batch-close'
import type { TabInfo } from '../../env'
import { computeReorderedIds, nextPinnedState, pinMenuLabel, tabDropSide } from './tab-bar-actions'

/**
 * 浏览器标签栏的状态机（从 DashboardBrowserSurface.vue 原样外移，行为不变）。
 *
 * 覆盖：多选 / 右键菜单 / 批量关闭确认 / 固定与拖拽重排 / 快捷键诊断；
 * 纯判据仍在 ./tabs-batch-close.ts 与 ./tab-bar-actions.ts（可单测），这里只做响应式接线。
 */
export interface BrowserTabsOptions {
  /** 换店铺时同时清掉登录检测结果（结果按店铺算），原 watch 里对三类 ref 的复位。 */
  resetLoginCheckState: () => void
}

export function useBrowserTabs(options: BrowserTabsOptions) {
  const ws = useWorkspaceStore()

const urlDraft = ref('')

// ---------- 标签页批量关闭（多选 / 右键菜单 / 快捷键）----------
// 设计要点：
//   · 多选是"显式选择"，选中项里的固定标签也会关；
//   · 「关闭其他 / 关闭全部」是一键操作，默认跳过固定标签（除非全是固定的，否则会没有可关项）；
//   · 数量与跳过数在**点击时按当前真实标签**算，确认弹窗里把"会保留几个固定标签"写清楚。
const selectedTabIds = ref<string[]>([])
const selectionAnchor = ref<string | null>(null)
const tabMenu = reactive({ open: false, x: 0, y: 0 })
const menuTabId = ref<string | null>(null)

// 确认浮层的内容（标题 / 详情 / 过 IPC 的关闭参数）统一由 planBatchClose 生成
const pendingTabClose = ref<BatchCloseDialog | null>(null)
interface PendingPanelConfirmation {
  title: string
  detail: string
  action: () => Promise<void>
}
const pendingPanelConfirmation = ref<PendingPanelConfirmation | null>(null)

const visibleTabs = computed(() => ws.displayedTabs)
const menuTarget = computed(() => visibleTabs.value.find(tab => tab.id === menuTabId.value) || null)
const menuOtherCount = computed(() => visibleTabs.value.filter(tab => tab.id !== menuTabId.value && !tab.isPinned).length)
const menuAllCount = computed(() => visibleTabs.value.filter(tab => !tab.isPinned).length)
/** 全是固定标签时，一键关闭退化为"含固定"，否则按钮永远点不动 */
const menuAllIncludesPinned = computed(() => menuAllCount.value === 0 && visibleTabs.value.length > 0)
const menuOtherIncludesPinned = computed(() => menuOtherCount.value === 0 && visibleTabs.value.length > 1)
/** 右键菜单里的固定项文案：跟着当前右键的标签走（未固定 → 固定标签页） */
const pinMenuLabelText = computed(() => pinMenuLabel(menuTarget.value || {}))
/** 正在拖拽的标签 id：只用于给被拖项加 dragging 样式 */
const dragTabId = ref<string | null>(null)

function isTabSelected(tabId: string): boolean {
  return selectedTabIds.value.includes(tabId)
}

function clearTabSelection(): void {
  selectedTabIds.value = []
  selectionAnchor.value = null
}

function toggleTabSelection(tabId: string): void {
  selectedTabIds.value = toggleSelection(selectedTabIds.value, tabId)
  selectionAnchor.value = tabId
}

/** Shift 选择：按标签栏当前顺序取区间（与文件管理器一致） */
function selectTabRange(fromId: string, toId: string): void {
  const ids = visibleTabs.value.map(tab => tab.id)
  selectedTabIds.value = computeTabRange(ids, fromId, toId)
  // 锚点或目标已不在标签栏时，退化为以点击项为锚点（与文件管理器一致）
  selectionAnchor.value = ids.includes(fromId) && ids.includes(toId) ? fromId : toId
}

function onTabClick(tab: TabInfo, event: MouseEvent): void {
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault()
    toggleTabSelection(tab.id)
    return
  }
  if (event.shiftKey && selectionAnchor.value) {
    event.preventDefault()
    selectTabRange(selectionAnchor.value, tab.id)
    return
  }
  // 普通点击回到单页模式：先清多选，再切页
  clearTabSelection()
  void ws.activateTab(tab.id)
}

function openTabMenu(tab: TabInfo, event: MouseEvent): void {
  if (!selectedTabIds.value.includes(tab.id) && selectedTabIds.value.length) selectedTabIds.value = [tab.id]
  menuTabId.value = tab.id
  tabMenu.open = true
  // fixed 定位 + 视口内夹紧，避免靠近右下角时菜单被裁掉
  // （菜单高度按 4 项估：关闭标签页 / 固定 / 关闭其他 / 关闭全部，多一项就要多留一行）
  tabMenu.x = Math.max(8, Math.min(event.clientX, window.innerWidth - 220))
  tabMenu.y = Math.max(8, Math.min(event.clientY, window.innerHeight - 246))
}

function closeTabMenu(): void {
  tabMenu.open = false
  menuTabId.value = null
}

function onTabMenuOutside(event: MouseEvent): void {
  if (!tabMenu.open) return
  const target = event.target as HTMLElement | null
  if (target?.closest('[data-test="tabs-context-menu"]')) return
  closeTabMenu()
}

/**
 * 统一入口：算目标 → 弹确认。真正关闭在 confirmTabClose 里做，
 * 这样快捷键 / 右键菜单 / 多选工具条走的是同一套边界判断。
 * 目标数量、是否含固定标签、确认文案都由 planBatchClose 决定（见 tabs-batch-close.ts）。
 */
function requestCloseTabs(input: BatchCloseRequest): void {
  // 「关闭其他」缺 keepTabId 时保持原实现的静默返回（调用方已经提示过"没有可保留的标签页"）
  if (input.mode === 'others' && !input.keepTabId) return
  const dialog = planBatchClose(visibleTabs.value, input)
  if (!dialog) {
    ws.toast('没有可关闭的标签页', 'info')
    return
  }
  pendingTabClose.value = dialog
}

function requestCloseSelected(): void {
  closeTabMenu()
  requestCloseTabs({ mode: 'ids', tabIds: selectedTabIds.value.slice() })
}

function requestCloseOthers(keepTabId?: string): void {
  const keep = keepTabId || menuTabId.value
  closeTabMenu()
  if (!keep) {
    ws.toast('没有可保留的标签页', 'info')
    return
  }
  requestCloseTabs({ mode: 'others', keepTabId: keep })
}

function requestCloseAll(): void {
  closeTabMenu()
  requestCloseTabs({ mode: 'all' })
}

function closeTabFromMenu(): void {
  const tab = menuTarget.value
  closeTabMenu()
  if (tab) void ws.closeTab(tab.id)
}

/** 右键菜单里的「固定标签页 / 取消固定」：菜单先关，再按当前状态取反提交 */
function togglePinFromMenu(): void {
  const tab = menuTarget.value
  closeTabMenu()
  if (tab) void ws.setTabPinned(tab.id, nextPinnedState(tab))
}

function onTabDragStart(tab: TabInfo, event: DragEvent): void {
  dragTabId.value = tab.id
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    // 写上 id：有些环境（含 CDP 合成事件）不给 dataTransfer 也不影响本地拖拽，
    // 但真实鼠标拖拽必须有 data 才认为这是一次"移动"
    event.dataTransfer.setData('text/plain', tab.id)
  }
}

/** 拖拽落下：按落点在目标的左/右半算出目标位次，交给纯函数算新顺序 */
function onTabDrop(target: TabInfo, event: DragEvent): void {
  const draggedId = dragTabId.value
  dragTabId.value = null
  if (!draggedId) return
  const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect()
  if (!rect) return
  const current = visibleTabs.value.map(tab => tab.id)
  const ids = computeReorderedIds(current, { draggedId, targetId: target.id, position: tabDropSide(rect, event.clientX) })
  // 落回原位就不白跑一趟 IPC（主进程要写库并广播标签集合）
  if (ids.length === current.length && ids.every((id, index) => id === current[index])) return
  void ws.reorderTabs(ids)
}

function onTabDragEnd(): void {
  dragTabId.value = null
}

function cancelTabClose(): void {
  pendingTabClose.value = null
}

function askPanelConfirmation(input: Omit<PendingPanelConfirmation, 'action'> & { action: () => Promise<void> }): void {
  pendingPanelConfirmation.value = input
}

function cancelPanelConfirmation(): void {
  pendingPanelConfirmation.value = null
}

async function confirmPanelConfirmation(): Promise<void> {
  const pending = pendingPanelConfirmation.value
  if (!pending) return
  pendingPanelConfirmation.value = null
  await pending.action()
}

async function confirmTabClose(): Promise<void> {
  const pending = pendingTabClose.value
  if (!pending) return
  pendingTabClose.value = null
  // 关键：pending 存在 ref 里会被 Vue 深层 reactive 化，tabIds 读出来是 Proxy 数组，
  // 直接传 IPC 会 "An object could not be cloned"（且异常发生在 IPC 层，catch 不到）。
  // 这里展开成纯数组再交给 store。
  const result = await ws.closeTabs({
    mode: pending.mode,
    tabIds: pending.tabIds ? [...pending.tabIds] : undefined,
    keepTabId: pending.keepTabId,
    includePinned: pending.includePinned
  })
  if (!result) return
  closeTabMenu()
  clearTabSelection()
  const outcome = describeCloseResult(result)
  ws.toast(outcome.text, outcome.tone)
}

/** 店铺页面里的 Ctrl+Shift+W / Ctrl+Alt+W 由主进程 before-input-event 转发过来（页面吞不掉） */
type InputDiagnosticWindow = Window & { __SHOPILOT_INPUT_DIAGNOSTICS__?: boolean }

function inputDiagnostic(message: string, data?: unknown): void {
  if (!(window as InputDiagnosticWindow).__SHOPILOT_INPUT_DIAGNOSTICS__) return
  const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`
  console.info(`[input-diagnostic] ${message}${suffix}`)
}

function describeKeyboardEvent(event: KeyboardEvent): Record<string, unknown> {
  return {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    repeat: event.repeat,
    target: (event.target as HTMLElement | null)?.tagName || null
  }
}

function onBrowserKeyup(event: KeyboardEvent): void {
  inputDiagnostic('keyup', describeKeyboardEvent(event))
}

// 切店铺 / 标签集合变化时收敛状态，避免"选中了一个已经不存在的标签"
watch(() => ws.displayedStoreId, () => {
  clearTabSelection()
  closeTabMenu()
  pendingTabClose.value = null
  pendingPanelConfirmation.value = null
  // 登录检测结果是按店铺算的：换店必须清掉，否则会把上一家的结论显示给下一家
  options.resetLoginCheckState()
})
watch(() => visibleTabs.value.map(tab => tab.id).join('|'), () => {
  const aliveIds = visibleTabs.value.map(tab => tab.id)
  selectedTabIds.value = pruneTabSelection(selectedTabIds.value, aliveIds)
  if (menuTabId.value && !aliveIds.includes(menuTabId.value)) closeTabMenu()
})
watch(pendingTabClose, value => {
  inputDiagnostic('close-all-confirmation', {
    visible: Boolean(value),
    title: value?.title || ''
  })
})

  return {
    urlDraft,
    selectedTabIds,
    selectionAnchor,
    tabMenu,
    menuTabId,
    pendingTabClose,
    pendingPanelConfirmation,
    visibleTabs,
    menuTarget,
    menuOtherCount,
    menuAllCount,
    menuAllIncludesPinned,
    menuOtherIncludesPinned,
    pinMenuLabelText,
    dragTabId,
    isTabSelected,
    clearTabSelection,
    toggleTabSelection,
    selectTabRange,
    onTabClick,
    openTabMenu,
    closeTabMenu,
    onTabMenuOutside,
    requestCloseTabs,
    requestCloseSelected,
    requestCloseOthers,
    requestCloseAll,
    closeTabFromMenu,
    togglePinFromMenu,
    onTabDragStart,
    onTabDrop,
    onTabDragEnd,
    cancelTabClose,
    askPanelConfirmation,
    cancelPanelConfirmation,
    confirmPanelConfirmation,
    confirmTabClose,
    inputDiagnostic,
    describeKeyboardEvent,
    onBrowserKeyup,
  }
}
