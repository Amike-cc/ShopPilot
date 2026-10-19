import { computed, onBeforeUnmount, reactive, ref, watch, type ComputedRef } from 'vue'
import { useWorkspaceStore, type StoreRow } from '../../stores/workspace'
import { inviteProfileFor, isBatchProfile, type CategoryNode } from '@shared/constants/invite'
import { inviteTaskIssues, normalizeInviteTaskConfig, parseInviteProductIds } from '@shared/invite-task'
import { inviteConfigKey, legacyInviteConfigKey } from '@shared/invite-config'

/**
 * 「达人邀约」面板的域逻辑（从 DashboardBrowserSurface.vue 原样外移，行为不变）。
 *
 * 面板模板仍留在浏览器组件里（模板里有验收锚点 data-test 与文案回归钉），
 * 这里只承载状态、IPC 读写、校验与任务进度映射；调用方传入当前店铺的 computed。
 */
export interface CreatorInviteOptions {
  /** 当前显示的店铺（null = 没打开店铺）。 */
  store: ComputedRef<StoreRow | null>
}

export function useCreatorInvite(options: CreatorInviteOptions) {
  const store = options.store
  const ws = useWorkspaceStore()

const inviteLiveLogEl = ref<HTMLElement | null>(null)
const squareUrls = ref<Record<string, string>>({})
const dynamicCategoryTrees = ref<Record<string, CategoryNode[]>>({})
const entryRoutes = ref<any[]>([])
const displayedPlatformName = computed(() => store.value?.platform || '')
const inviteProfile = computed(() => inviteProfileFor(store.value?.platform))
const INVITE_CATEGORY_TREES_SETTING = 'invite.categoryTrees'
const invite = reactive({
  category: '', subcategory: '', category3: '', levels: [] as string[], count: 5,
  script: '', scriptMode: 'manual' as 'manual' | 'ai', benefits: [] as string[], strengths: [] as string[],
  mainCategory: '', extraFilters: {} as Record<string, string[]>, batchContact: '', batchPhone: '', batchWechat: '', batchProductCount: 1,
  contact: '', wechat: '', phone: '', productIds: '', finderType: '全部带货者', finderCategories: [] as string[], finderSalesTiers: [] as string[], finderOtherFilters: [] as string[],
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
let inviteConfigLoadSerial = 0
let inviteConfigLoadedStoreId = ''
let inviteSaveTimer: ReturnType<typeof setTimeout> | null = null
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
  if (!profile || !ws.displayedStoreId) return ['请先打开一个店铺']
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
const inviteTasks = computed(() => ws.tasks.filter((task: any) => (task.kind === 'creator_invite' || String(task.name || '').startsWith('达人邀约 · ')) && (!task.storeScope || task.storeScope === ws.displayedStoreId)))
const inviteLatest = computed(() => {
  const rows = [...inviteTasks.value]
  const active = rows.filter(task => inviteActive(task)).sort((a, b) => Number(b.latestRun?.startedAt || b.updatedAt || b.createdAt || 0) - Number(a.latestRun?.startedAt || a.updatedAt || a.createdAt || 0))
  if (active[0]) return active[0]
  return rows.sort((a, b) => Number(b.latestRun?.finishedAt || b.updatedAt || b.createdAt || 0) - Number(a.latestRun?.finishedAt || a.updatedAt || a.createdAt || 0))[0] || null
})

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
  const storeId = ws.displayedStoreId
  if (!storeId) { entryRoutes.value = []; return }
  const result = await window.shopilot.bookmark.entryRoutes(storeId)
  if (ws.displayedStoreId !== storeId) return
  entryRoutes.value = result.ok ? (result.data.routes || []) : []
}

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

async function readInviteSetting(key: string) {
  const result = await window.shopilot.settings.get(key)
  const value = result.ok ? result.data?.value : null
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

async function loadInviteQuota(storeId: string) {
  if (!storeId) { inviteQuota.value = null; return }
  try {
    const result = await window.shopilot.invite.quota({ storeId })
    inviteQuota.value = result.ok ? (result.data as typeof inviteQuota.value) : null
  } catch {
    inviteQuota.value = null
  }
}

async function loadInviteAiStatus() {
  try {
    const result = await window.shopilot.ai.configGet()
    inviteAiConfigured.value = !!(result.ok && (result.data as { hasKey?: boolean })?.hasKey)
  } catch {
    inviteAiConfigured.value = false
  }
}

async function loadInviteScripts(storeId: string, platform: string) {
  if (!storeId || !platform) { inviteScripts.value = []; return }
  try {
    const result = await window.shopilot.invite.scripts.list({ storeId, platform })
    inviteScripts.value = result.ok ? ((result.data || []) as typeof inviteScripts.value) : []
  } catch {
    inviteScripts.value = []
  }
}

function applyInviteScript(id: string) {
  const script = inviteScripts.value.find(item => item.id === id)
  if (!script) return
  invite.script = script.template
  invite.scriptMode = script.mode
}

async function loadInviteConfig() {
  const serial = ++inviteConfigLoadSerial
  const profile = inviteProfile.value
  const storeId = ws.displayedStoreId
  inviteConfigLoaded.value = false
  inviteConfigLoadedStoreId = ''
  resetInviteDefaults()
  if (!profile || !storeId) return
  void loadInviteQuota(storeId)
  void loadInviteScripts(storeId, profile.platform)
  void loadInviteAiStatus()
  void window.shopilot.invite.creators.blacklisted({ storeId, platform: profile.platform })
    .then(result => { inviteBlacklistCount.value = result.ok ? ((result.data as { nicknames?: string[] })?.nicknames || []).length : 0 })
    .catch(() => { inviteBlacklistCount.value = 0 })
  let saved = await readInviteSetting(inviteConfigKey(storeId))
  if (serial !== inviteConfigLoadSerial || ws.displayedStoreId !== storeId) return
  let fromLegacy = false
  if (!saved) {
    saved = await readInviteSetting(legacyInviteConfigKey(profile.platform))
    fromLegacy = !!saved
  }
  if (serial !== inviteConfigLoadSerial || ws.displayedStoreId !== storeId) return
  if (saved) Object.assign(invite, normalizeInviteTaskConfig(profile.flow, saved))
  /**
   * 商品ID 统一成"一行一个"的字符串再放进多行框：
   * `normalizeInviteTaskConfig` 给的是数组（`['a','b']`），直接绑到 textarea 会被拼成 `a,b`——
   * 能跑但不好核对（用户是按"一列 ID"粘贴进来的，理应一行一个显示）。状态类型也统一为 string。
   */
  invite.productIds = parseInviteProductIds(invite.productIds as any).join('\n')
  // 档案实测清单之外的值（旧配置 / 平台改名后的遗留，如「汽车电动」→「汽摩电动」）不进界面：
  // 面板只能提供实测过的选项，否则勾选列表里点不亮，运行到页面又必然找不到。
  // （智能体/其它调用方塞进来的清单外值不受此影响：inviteTaskIssues 会把它们逐条报成缺项。）
  if (!isBatchProfile(profile)) {
    invite.finderCategories = invite.finderCategories.filter(c => profile.finderCategories.includes(c))
    invite.finderSalesTiers = invite.finderSalesTiers.filter(t => (profile.finderSalesTiers || []).includes(t))
    invite.finderOtherFilters = invite.finderOtherFilters.filter(f => profile.finderOtherFilters.includes(f))
    if (!profile.finderTypes.includes(invite.finderType)) invite.finderType = profile.finderTypes[0] || '全部带货者'
  }
  if (serial !== inviteConfigLoadSerial || ws.displayedStoreId !== storeId) return
  inviteConfigLoaded.value = true
  inviteConfigLoadedStoreId = storeId
  if (fromLegacy) {
    // 旧版按平台配置只作为首次打开的初始值，随后固化为本店铺键，避免同平台店铺互相覆盖。
    await window.shopilot.settings.set(inviteConfigKey(storeId), inviteSnapshot())
  }
}

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

async function saveInviteConfig() {
  const storeId = ws.displayedStoreId
  if (!storeId || !inviteProfile.value) return
  inviteSaving.value = true
  const result = await window.shopilot.settings.set(inviteConfigKey(storeId), inviteSnapshot())
  inviteSaving.value = false
  if (result.ok) ws.toast('达人邀约配置已保存到当前店铺', 'success')
  else ws.toast(`保存邀约配置失败：${result.error.message}`, 'error')
}

watch(() => invite.scriptMode, (mode) => {
  if (mode === 'ai') void loadInviteAiStatus()
})
watch(invite, () => {
  const storeId = ws.displayedStoreId
  if (!storeId || !inviteConfigLoaded.value || inviteConfigLoadedStoreId !== storeId) return
  if (inviteSaveTimer) clearTimeout(inviteSaveTimer)
  inviteSaveTimer = setTimeout(() => {
    if (ws.displayedStoreId !== storeId || !inviteConfigLoaded.value || inviteConfigLoadedStoreId !== storeId) return
    void window.shopilot.settings.set(inviteConfigKey(storeId), inviteSnapshot())
  }, 500)
}, { deep: true })

function inviteSquareUrl() {
  const profile = inviteProfile.value
  return profile ? squareUrls.value[profile.platform] || profile.pageUrl : ''
}

async function openInvitePage() {
  const url = inviteSquareUrl()
  const profile = inviteProfile.value
  if (!url || !profile) return
  if (profile.platform === '抖店' && isBatchProfile(profile) && profile.categoryDepth === 3 && ws.displayedStoreId) {
    try {
      const result = await window.shopilot.browser.prepareInviteSquare(ws.displayedStoreId, { url, loadCategoryTree: true })
      if (!result.ok) {
        ws.toast(`打开达人广场/读取三级类目失败：${result.error.message}`, 'error')
        return
      }
      const tree = (result.data as { categoryTree?: CategoryNode[] })?.categoryTree
      if (tree?.length) {
        await saveInviteCategoryTree(profile.platform, tree)
        await loadInviteConfig()
        ws.toast(`达人广场已打开，已读取 ${tree.length} 个一级类目的完整三级结构`, 'success')
      } else {
        ws.toast('达人广场已打开，但平台未返回三级类目', 'info')
      }
    } catch (error: any) {
      ws.toast(`打开达人广场/读取三级类目失败：${String(error?.message || error)}`, 'error')
    }
    return
  }
  /**
   * 微信小店（assist-form）：把面板上的广场筛选**真的应用上**再让用户看列表。
   * 以前这里只是导航过去，用户得自己在页面上点一遍筛选；现在与任务引擎同一套选项
   * （同样来自实测档案），逐项应用并**回读勾选态**，没生效的项如实报出来。
   */
  if (!isBatchProfile(profile)) {
    const storeId = ws.displayedStoreId
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
  void ws.navigate(url)
}

function inviteRun(task: any) { return task?.latestRun }
function inviteRunId(task: any) { return inviteRun(task)?.id || '' }
function inviteStatus(task: any) {
  const status = inviteRunId(task) ? ws.runLive[inviteRunId(task)]?.status || inviteRun(task)?.status : inviteRun(task)?.status
  return ({ running: '正在运行', queued: '排队中', waiting_confirmation: '等待确认', paused: '已暂停', succeeded: '已完成', failed: '执行失败', cancelled: '已取消' } as Record<string, string>)[status || ''] || '尚未运行'
}
function inviteActive(task: any) {
  const run = inviteRun(task)
  const status = run?.id ? ws.runLive[run.id]?.status || run.status : run?.status
  return ['queued', 'running', 'waiting_confirmation', 'paused'].includes(status)
}
function inviteStepIndex(task: any) {
  const run = inviteRun(task)
  return run?.id ? (ws.runLive[run.id]?.stepIndex ?? run.currentStep ?? null) : (run?.currentStep ?? null)
}
function inviteStuckText(task: any) {
  const steps = task?.steps || []
  const index = inviteStepIndex(task)
  if (!inviteActive(task)) return `${inviteStatus(task)} · 共 ${steps.length} 步`
  if (index == null) return `正在准备邀约 · 共 ${steps.length} 步`
  const safeIndex = Math.min(Math.max(index, 0), Math.max(steps.length - 1, 0))
  const message = inviteLiveMessage(task)
  return `卡在第 ${safeIndex + 1}/${steps.length} 步${message ? `：${message}` : ''}`
}
function inviteStepIcon(task: any, index: number) {
  const status = inviteRunId(task) ? ws.runLive[inviteRunId(task)]?.status || inviteRun(task)?.status : inviteRun(task)?.status
  const current = inviteStepIndex(task)
  if (status === 'succeeded') return '✅'
  if (status === 'failed' && current === index) return '❌'
  if (current != null && index < current) return '✅'
  if (current == null && index === 0 && inviteActive(task)) return '⏳'
  if (current === index && inviteActive(task)) return '⏳'
  return '○'
}
function toStepIndex(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0
}
function inviteStepLabel(step: any) { return ({ waitMs: '等待页面状态', navigate: '打开平台页面', click: '点击页面元素', input: '填写页面内容', screenshot: '保存页面截图', readText: '读取页面信息' } as Record<string, string>)[step?.type] || step?.type || '任务步骤' }
function inviteStepInput(step: any) {
  const value = step?.input
  if (!value) return '等待真实运行结果'
  try { const text = JSON.stringify(value); return text.length > 90 ? `${text.slice(0, 87)}…` : text } catch { return '等待真实运行结果' }
}
function inviteLiveMessage(task: any) { const runId = inviteRunId(task); return runId ? String(ws.runLive[runId]?.message || '') : '' }
function inviteLogs(task: any) { const runId = inviteRunId(task); return runId ? (ws.taskLogs[runId] || []) : [] }
function inviteLogText(log: any) { return `[${new Date(log.at || Date.now()).toLocaleTimeString()}] ${log.message || log.phase || log.status || '任务状态已更新'}` }
async function stopInvite(task: any) { const runId = inviteRunId(task); if (!runId) return; const result = await window.shopilot.task.cancel(runId); if (!result.ok) ws.toast(`停止邀约失败：${result.error.message}`, 'error'); await ws.refreshTasks() }
watch(() => invite.category, () => { if (invite.subcategory && !inviteSubcategoryOptions.value.includes(invite.subcategory)) invite.subcategory = ''; if (invite.category3 && !inviteThirdCategoryOptions.value.includes(invite.category3)) invite.category3 = '' })
watch(() => invite.subcategory, () => { if (invite.category3 && !inviteThirdCategoryOptions.value.includes(invite.category3)) invite.category3 = '' })
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


  // 防抖保存的计时器归本模块所有：组件卸载时一并清掉（原组件 onBeforeUnmount 的两行搬到这里）。
  onBeforeUnmount(() => {
    if (inviteSaveTimer) clearTimeout(inviteSaveTimer)
    inviteSaveTimer = null
  })

  return {
    inviteLiveLogEl,
    squareUrls,
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
    inviteTasks,
    inviteLatest,
    refreshSquareUrls,
    loadInviteCategoryTrees,
    saveInviteCategoryTree,
    refreshEntryRoutes,
    resetInviteDefaults,
    loadInviteQuota,
    loadInviteAiStatus,
    loadInviteScripts,
    applyInviteScript,
    loadInviteConfig,
    inviteSnapshot,
    saveInviteConfig,
    inviteSquareUrl,
    openInvitePage,
    inviteRun,
    inviteRunId,
    inviteStatus,
    inviteActive,
    inviteStepIndex,
    inviteStuckText,
    inviteStepIcon,
    inviteStepLabel,
    toStepIndex,
    inviteStepInput,
    inviteLiveMessage,
    inviteLogs,
    inviteLogText,
    stopInvite,
  }
}
