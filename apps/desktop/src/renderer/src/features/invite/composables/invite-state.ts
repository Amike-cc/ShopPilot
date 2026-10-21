import { computed, reactive, ref, watch, type ComputedRef } from 'vue'
import { useWorkspaceStore, type StoreRow } from '../../../stores/workspace'
import { inviteProfileFor, isBatchProfile, type CategoryNode } from '@shared/constants/invite'
import { inviteTaskIssues } from '@shared/invite-task'

/**
 * 达人邀约的**共享状态**（2026-10-20 P2 拆分的第二半）。
 *
 * 只放状态与纯派生值：表单、选项树、校验结果、快照序列化。
 * 所有 IPC（读写配置 / 额度 / 话术 / 启动 / 停止）都在各自的 composable 里，
 * 这样状态可以被多个 composable 共享，而网络/主进程调用仍然按领域分开。
 *
 * 约定：本文件不 import 任何 composable，避免环。
 */
export interface InviteStateContext {
  /** 店铺行（含平台）；侧栏传当前显示店铺，独立页传页面自己的店铺选择。 */
  store: ComputedRef<StoreRow | null>
  /** 本次配置/运行归属的店铺 id；与 store 必须指向同一家店。 */
  storeId: ComputedRef<string | null>
}

/** 平台入口路由行（bookmark:entryRoutes 返回的 Bookmark 面板子集；只读展示，不写库） */
export interface InviteEntryRoute {
  id: string
  title: string
  url: string
}

export function createInviteState(context: InviteStateContext) {
  const ws = useWorkspaceStore()
  const store = context.store
  const currentStoreId = context.storeId

  const inviteLiveLogEl = ref<HTMLElement | null>(null)
  const squareUrls = ref<Record<string, string>>({})
  const dynamicCategoryTrees = ref<Record<string, CategoryNode[]>>({})
  const entryRoutes = ref<InviteEntryRoute[]>([])
  const displayedPlatformName = computed(() => store.value?.platform || '')
  const inviteProfile = computed(() => inviteProfileFor(store.value?.platform))
  const invite = reactive({
    category: '', subcategory: '', category3: '', levels: [] as string[], count: 5,
    script: '', scriptMode: 'manual' as 'manual' | 'ai', benefits: [] as string[], strengths: [] as string[],
    mainCategory: '', extraFilters: {} as Record<string, string[]>, batchContact: '', batchPhone: '', batchWechat: '', batchProductCount: 1,
    /**
     * productIds 声明为 string | string[]：表单里是"一行一个 ID"的字符串，
     * 但读旧配置后 normalizeInviteTaskConfig 会给回数组（parseInviteProductIds 的产物），
     * use-invite-config 加载后统一归一成字符串——类型如实反映这一中间态。
     */
    contact: '', wechat: '', phone: '', productIds: '' as string | string[], finderType: '全部带货者', finderCategories: [] as string[], finderSalesTiers: [] as string[], finderOtherFilters: [] as string[],
    /**
     * 额度护栏：本次最多邀约几位。
     * 平台页面读不到「今日剩余 N 次邀请机会」（2026-10-02/03 两次真机实测都没有），
     * 所以 `requireQuota` 拿不到数、`TASK_QUOTA_EXCEEDED` 实际不会触发——这个值是我们唯一能保证的上限。
     */
    maxInvites: 10,
    /** 店铺自设的日上限（0 = 不设上限）。只做本地护栏，平台额度仍以引擎 TASK_QUOTA_EXCEEDED 为准。 */
    dailyCap: 0
  })
  const inviteSaving = ref(false)
  /**
   * 「打开达人广场」时从列表读到的候选预览（2026-10-21 真机实测打通）。
   * 用途：发送前让人工核对"将邀请的是这些人"——候选预览/目标名单的第一版数据源。
   * 只在成功打开广场时刷新；打开失败保留上次结果并在 UI 标注时效。
   */
  const squareCandidates = ref<Array<{ nickname: string; summary: string; at: number }>>([])
  const inviteQuota = ref<{ used: number; reserved: number; limit: number | null; remaining: number | null } | null>(null)
  const inviteScripts = ref<Array<{ id: string; name: string; mode: 'manual' | 'ai'; template: string; maxLen: number | null }>>([])
  const inviteScriptId = ref('')
  /** AI 模式门禁：只认主进程 hasKey，不靠渲染层猜 */
  const inviteAiConfigured = ref(false)
  const inviteSubmitting = ref(false)
  /** 近 7 天已邀过的达人数（开跑时查台账得到；用于面板提示"会自动跳过"） */
  const inviteRecentCount = ref(0)
  const inviteBlacklistCount = ref(0)
  const inviteConfigLoaded = ref(false)

  function inviteCategoryTreeFor(profile: { platform: string; categoryTree?: readonly CategoryNode[] }): readonly CategoryNode[] {
    const dynamic = dynamicCategoryTrees.value[profile.platform]
    return Array.isArray(dynamic) && dynamic.length ? dynamic : (profile.categoryTree || [])
  }
  const inviteCategoryOptions = computed(() => inviteProfile.value && isBatchProfile(inviteProfile.value) ? inviteCategoryTreeFor(inviteProfile.value).map(item => item.name) : [])
  const inviteSubcategoryOptions = computed(() => {
    const profile = inviteProfile.value
    if (!profile || !isBatchProfile(profile) || !invite.category) return []
    return inviteCategoryTreeFor(profile).find(item => item.name === invite.category)?.children || []
  })
  const inviteThirdCategoryOptions = computed(() => {
    const profile = inviteProfile.value
    if (!profile || !isBatchProfile(profile) || !invite.category || !invite.subcategory) return []
    return inviteCategoryTreeFor(profile).find(item => item.name === invite.category)?.grandchildren?.find(item => item.name === invite.subcategory)?.children || []
  })
  const inviteMainCategoryPaths = computed(() => {
    const profile = inviteProfile.value
    if (!profile || !isBatchProfile(profile) || !profile.drawerForm?.mainCategory) return []
    return inviteCategoryTreeFor(profile).flatMap(item => [item.name, ...item.children.map(child => `${item.name}/${child}`)])
  })
  const inviteMissingItems = computed(() => {
    const profile = inviteProfile.value
    if (!profile || !currentStoreId.value) return ['请先选择一个店铺']
    const issues = inviteTaskIssues({ profile, config: JSON.parse(JSON.stringify(invite)) })
    if (invite.scriptMode === 'ai' && !inviteAiConfigured.value) {
      issues.push('AI 未配置：请在设置中心配置大模型 Key，或改用手动话术')
    }
    return issues
  })
  /**
   * 广场筛选的界面辅助（仅 assist-form/微信小店用到）：
   * 类目 34 项在侧栏里太长，默认只铺一屏 + 搜索；销售总额档位的「不限」与具体档位互斥
   * （实测平台允许同时勾，但那等于"不限或某档"，语义含糊——面板按互斥处理，避免出现
   * 一个用户自己都读不懂的组合，运行时会如实按所选档位点击）。
   */
  const inviteCatQuery = ref('')
  const inviteCatsExpanded = ref(false)
  const inviteCategoryShown = computed(() => {
    const profile = inviteProfile.value
    if (!profile || isBatchProfile(profile)) return []
    const all = profile.finderCategories as readonly string[]
    const query = inviteCatQuery.value.trim()
    if (query) return all.filter(c => c.includes(query))
    if (inviteCatsExpanded.value) return [...all]
    const chosen = all.filter(c => invite.finderCategories.includes(c))
    const rest = all.filter(c => !invite.finderCategories.includes(c))
    // 已选的排在前面（收起时也要能看到自己选了什么），最多铺 16 个
    return [...chosen, ...rest].slice(0, 16)
  })
  const inviteCategoryHidden = computed(() => {
    const profile = inviteProfile.value
    if (!profile || isBatchProfile(profile)) return 0
    return Math.max(0, profile.finderCategories.length - inviteCategoryShown.value.length)
  })
  /** 「带货销售总额」只在档案声明的那几个类型页签下存在（实测：微信只有「全部带货者」） */
  const inviteSalesTypeWarning = computed(() => {
    const profile = inviteProfile.value
    if (!profile || isBatchProfile(profile)) return ''
    const types = profile.finderSalesTypes || []
    if (!types.length || !types.includes(invite.finderType)) {
      return `这一版广场上「${profile.finderSalesMetric}」只在「${types.join('、')}」下提供；当前类型「${invite.finderType}」没有这一维，选了的档位会点不到（开始邀约前会拦住）。`
    }
    return ''
  })
  function toggleSalesTier(tier: string) {
    if (tier === '不限') {
      invite.finderSalesTiers = invite.finderSalesTiers.includes('不限') ? [] : ['不限']
      return
    }
    const rest = invite.finderSalesTiers.filter(item => item !== '不限')
    invite.finderSalesTiers = rest.includes(tier) ? rest.filter(item => item !== tier) : [...rest, tier]
  }
  const inviteReady = computed(() => Boolean(inviteProfile.value && !inviteMissingItems.value.length && inviteConfigLoaded.value))

  function resetInviteDefaults() {
    const profile = inviteProfile.value
    invite.category = profile && isBatchProfile(profile) ? profile.categoryTree[2]?.name || profile.categoryTree[0]?.name || profile.categories[0] || '' : ''
    invite.subcategory = ''; invite.category3 = ''
    invite.levels = profile && isBatchProfile(profile) ? [...profile.levelsWithQuotaHint] : []
    invite.count = profile && isBatchProfile(profile) ? Math.max(1, Math.min(5, profile.maxBatch)) : 1
    invite.script = ''; invite.scriptMode = 'manual'; invite.benefits = []; invite.strengths = []; invite.mainCategory = ''
    invite.extraFilters = {}; invite.batchContact = ''; invite.batchPhone = ''; invite.batchWechat = ''; invite.batchProductCount = 1
    invite.contact = ''; invite.wechat = ''; invite.phone = ''; invite.productIds = ''; invite.finderType = '全部带货者'; invite.finderCategories = []; invite.finderSalesTiers = []; invite.finderOtherFilters = []; invite.maxInvites = 10; invite.dailyCap = 0
    inviteQuota.value = null
    inviteBlacklistCount.value = 0
    inviteScripts.value = []; inviteScriptId.value = ''
    inviteCatQuery.value = ''; inviteCatsExpanded.value = false
  }

  /** 配置快照：只含表单字段，去掉响应式包装；写设置/建批次都用它。 */
  function inviteSnapshot() {
    return JSON.parse(JSON.stringify({
      category: invite.category, subcategory: invite.subcategory, category3: invite.category3, levels: invite.levels,
      count: invite.count, script: invite.script, scriptMode: invite.scriptMode, benefits: invite.benefits, strengths: invite.strengths,
      mainCategory: invite.mainCategory, extraFilters: invite.extraFilters, batchContact: invite.batchContact, batchPhone: invite.batchPhone,
      batchWechat: invite.batchWechat, batchProductCount: invite.batchProductCount, contact: invite.contact, wechat: invite.wechat,
      phone: invite.phone, productIds: invite.productIds, finderType: invite.finderType, finderCategories: invite.finderCategories,
      finderSalesTiers: invite.finderSalesTiers, finderOtherFilters: invite.finderOtherFilters, maxInvites: invite.maxInvites, dailyCap: invite.dailyCap
    }))
  }

  function inviteSquareUrl() {
    const profile = inviteProfile.value
    return profile ? squareUrls.value[profile.platform] || profile.pageUrl : ''
  }

  watch(() => invite.category, () => {
    if (invite.subcategory && !inviteSubcategoryOptions.value.includes(invite.subcategory)) invite.subcategory = ''
    if (invite.category3 && !inviteThirdCategoryOptions.value.includes(invite.category3)) invite.category3 = ''
  })
  watch(() => invite.subcategory, () => {
    if (invite.category3 && !inviteThirdCategoryOptions.value.includes(invite.category3)) invite.category3 = ''
  })

  function clampInvitePicks(list: string[], max: number | undefined, label: string): string[] | null {
    if (!max || list.length <= max) return null
    ws.toast(`${label}最多选 ${max} 项：${list.slice(max).join('、')} 没选上`, 'info')
    return list.slice(0, max)
  }
  watch(() => invite.benefits, value => {
    const profile = inviteProfile.value
    const clipped = clampInvitePicks(value, profile && isBatchProfile(profile) ? profile.benefitsMax : undefined, '权益')
    if (clipped) invite.benefits = clipped
  }, { deep: true })
  watch(() => invite.strengths, value => {
    const profile = inviteProfile.value
    const clipped = clampInvitePicks(value, profile && isBatchProfile(profile) ? profile.strengths?.maxSelect : undefined, '核心优势')
    if (clipped) invite.strengths = clipped
  }, { deep: true })

  return {
    ws,
    store,
    currentStoreId,
    inviteLiveLogEl,
    squareUrls,
    squareCandidates,
    dynamicCategoryTrees,
    entryRoutes,
    displayedPlatformName,
    inviteProfile,
    invite,
    inviteSaving,
    inviteQuota,
    inviteScripts,
    inviteScriptId,
    inviteAiConfigured,
    inviteSubmitting,
    inviteRecentCount,
    inviteBlacklistCount,
    inviteConfigLoaded,
    inviteCategoryOptions,
    inviteSubcategoryOptions,
    inviteThirdCategoryOptions,
    inviteMainCategoryPaths,
    inviteMissingItems,
    inviteCatQuery,
    inviteCatsExpanded,
    inviteCategoryShown,
    inviteCategoryHidden,
    inviteSalesTypeWarning,
    toggleSalesTier,
    inviteReady,
    resetInviteDefaults,
    inviteSnapshot,
    inviteSquareUrl
  }
}

export type InviteState = ReturnType<typeof createInviteState>
