import { isBatchProfile, type CategoryNode } from '@shared/constants/invite'
import type { InviteState } from './invite-state'

/**
 * 平台侧导航：达人广场地址、三级类目缓存、平台入口，以及「打开达人广场」（会真的应用筛选并回读）。
 *
 * 这里不做任何发送；打开页面只是为了让人工核对筛选是否生效。
 */
export interface InviteNavigationPorts {
  /** 类目树更新后重载配置（面板下拉需要新选项） */
  reloadConfig(): void | Promise<void>
}

const INVITE_CATEGORY_TREES_SETTING = 'invite.categoryTrees'

export function useInviteNavigation(state: InviteState, ports: InviteNavigationPorts) {
  const { ws, currentStoreId, inviteProfile, invite, squareUrls, dynamicCategoryTrees, entryRoutes } = state

  async function refreshSquareUrls() {
    const result = await window.shopilot.settings.get('invite.squareUrls')
    if (result.ok && result.data?.value && typeof result.data.value === 'object') squareUrls.value = result.data.value
  }

  async function loadInviteCategoryTrees() {
    const result = await window.shopilot.settings.get(INVITE_CATEGORY_TREES_SETTING)
    const value = result.ok ? result.data?.value : null
    dynamicCategoryTrees.value = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, CategoryNode[]>
      : {}
  }

  async function saveInviteCategoryTree(platform: string, tree: CategoryNode[]) {
    const next = { ...dynamicCategoryTrees.value, [platform]: tree }
    const result = await window.shopilot.settings.set(INVITE_CATEGORY_TREES_SETTING, next)
    if (result.ok) dynamicCategoryTrees.value = next
  }

  async function refreshEntryRoutes() {
    const storeId = currentStoreId.value
    if (!storeId) { entryRoutes.value = []; return }
    const result = await window.shopilot.bookmark.entryRoutes(storeId)
    if (currentStoreId.value !== storeId) return
    entryRoutes.value = result.ok ? (result.data.routes || []) : []
  }

  async function openInvitePage() {
    const url = state.inviteSquareUrl()
    const profile = inviteProfile.value
    if (!url || !profile) return
    if (profile.platform === '抖店' && isBatchProfile(profile) && profile.categoryDepth === 3 && currentStoreId.value) {
      try {
        const result = await window.shopilot.browser.prepareInviteSquare(currentStoreId.value, { url, loadCategoryTree: true })
        if (!result.ok) {
          ws.toast(`打开达人广场/读取三级类目失败：${result.error.message}`, 'error')
          return
        }
        const tree = (result.data as { categoryTree?: CategoryNode[] })?.categoryTree
        if (tree?.length) {
          await saveInviteCategoryTree(profile.platform, tree)
          await ports.reloadConfig()
          ws.toast(`达人广场已打开，已读取 ${tree.length} 个一级类目的完整三级结构`, 'success')
        } else {
          ws.toast('达人广场已打开，但平台未返回三级类目', 'info')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ws.toast(`打开达人广场/读取三级类目失败：${message}`, 'error')
      }
      return
    }
    /**
     * 微信小店（assist-form）：把面板上的广场筛选**真的应用上**再让用户看列表。
     * 以前这里只是导航过去，用户得自己在页面上点一遍筛选；现在与任务引擎同一套选项
     * （同样来自实测档案），逐项应用并**回读勾选态**，没生效的项如实报出来。
     */
    if (!isBatchProfile(profile)) {
      const storeId = currentStoreId.value
      if (!storeId) { ws.toast('请先打开一个店铺', 'info'); return }
      const filters = {
        finderType: invite.finderType,
        categories: JSON.parse(JSON.stringify(invite.finderCategories)) as string[],
        salesTiers: JSON.parse(JSON.stringify(invite.finderSalesTiers)) as string[],
        otherFilters: JSON.parse(JSON.stringify(invite.finderOtherFilters)) as string[]
      }
      const total = filters.categories.length + filters.salesTiers.length + filters.otherFilters.length
      try {
        const result = await window.shopilot.browser.prepareInviteSquare(storeId, {
          url, finderType: filters.finderType, categories: filters.categories, salesTiers: filters.salesTiers, otherFilters: filters.otherFilters
        })
        if (!result.ok) { ws.toast(`打开达人广场失败：${result.error.message}`, 'error'); return }
        const data = result.data as { applied?: boolean, detailLinks?: number, finderType?: { ok: boolean, name: string, reason?: string }, categories?: Array<{ ok: boolean, name: string, reason?: string }>, salesTiers?: Array<{ ok: boolean, name: string, reason?: string }>, otherFilters?: Array<{ ok: boolean, name: string, reason?: string }> } | undefined
        const bad = [
          ...(data?.finderType && data.finderType.ok === false ? [`类型「${data.finderType.name}」${data.finderType.reason ? `（${data.finderType.reason}）` : ''}`] : []),
          ...(data?.categories || []).filter(item => !item.ok).map(item => `类目「${item.name}」${item.reason ? `（${item.reason}）` : ''}`),
          ...(data?.salesTiers || []).filter(item => !item.ok).map(item => `销售额「${item.name}」${item.reason ? `（${item.reason}）` : ''}`),
          ...(data?.otherFilters || []).filter(item => !item.ok).map(item => `其他「${item.name}」${item.reason ? `（${item.reason}）` : ''}`)
        ]
        // 跑前自检：列表里一条可见「详情」都没有 → 微应用没挂载/平台改版/登录刚过期，
        // 这时候点「开始邀约」会在第 1 轮才失败，不如现在就明说。
        if (!bad.length && data?.detailLinks === 0) {
          ws.toast('达人广场已打开，但列表里没有可见的「详情」入口——平台可能改版或页面还没就绪，建议先别开始邀约', 'error', 9000)
          return
        }
        if (bad.length) ws.toast(`达人广场已打开，但有 ${bad.length} 项筛选没生效：${bad.join('、')}`, 'error', 8000)
        else ws.toast(total ? `达人广场已打开，${total} 项筛选已生效（列表 ${data?.detailLinks ?? '?'} 位可点详情）` : `达人广场已打开（列表 ${data?.detailLinks ?? '?'} 位可点详情）`, 'success')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ws.toast(`打开达人广场失败：${message}`, 'error')
      }
      return
    }
    // 快手（batch、无三级类目流程）：没有 prepareInviteSquare 的显式传店路径，只能跟随
    // 浏览器当前显示的店导航。但独立页的选店契约是「显式传 storeId，不跟随浏览器显示店」，
    // 静默跟随会在"页面选 A 店、浏览器显示 B 店"时把广场开到错店。这里显式校验不一致时
    // 提示并放弃，绝不导航错店（2026-10-21 审查 P1-7）。
    const manualStoreId = currentStoreId.value
    if (!manualStoreId) { ws.toast('请先选择店铺', 'info'); return }
    const displayed = ws.displayedStoreId
    if (!displayed) { ws.toast('请先在浏览器里打开该店铺，再打开达人广场', 'info'); return }
    if (displayed !== manualStoreId) {
      ws.toast('浏览器当前显示的不是页面选中的店铺——请先在浏览器里切换到该店铺，再打开达人广场', 'error', 8000)
      return
    }
    void ws.navigate(url)
  }

  return { refreshSquareUrls, loadInviteCategoryTrees, saveInviteCategoryTree, refreshEntryRoutes, openInvitePage }
}
