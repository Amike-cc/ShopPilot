import { BIZ_METRICS } from '@shared/constants/business'
import { isPendingSection } from '@shared/constants/invoice'
import { findPlatform } from '@shared/constants/platforms'
import { NO_LICENSE_KEY, groupStoresByLicense } from '@shared/store-license'
import { invoiceAmountText, parseInvoiceAmount } from '@shared/invoice-amount'
import { computed, reactive, ref } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'

/**
 * 数据中心 · 发票明细域（从 UnifiedDataPage.vue 原样外移，行为不变）。
 *
 * 基础状态（loading/error/dataCenter/invoiceData/taxData/manual…）+ 发票行筛选/排序/合计/覆盖度
 * + 发票页与店铺后台跳转 + CSV 导出范围与确认弹层。涉税与采集域通过本对象接线。
 */
export type DataMode = 'analytics' | 'invoices' | 'tax'

export interface DataPageDeps {
  props: { mode: DataMode }
  emit: (event: 'open-store', storeId: string) => void
}

export function useInvoiceDetail(deps: DataPageDeps) {
  const props = deps.props
  const emit = deps.emit
  const ws = useWorkspaceStore()
const loading = ref(false)
const collecting = ref(false)
const errorMessage = ref('')
const dataCenter = ref<any | null>(null)
const invoiceData = ref<any | null>(null)
/** 涉税信息报送（平台按季度报送给税务机关的经营数据；随数据一起带回平台自己的用途限制） */
const taxData = ref<any | null>(null)
const taxCollecting = ref(false)
/** 「获取主体营业执照」：采集进行中 + 逐店结果（填了哪些、哪不一致、哪些平台取不了，全部照实展示） */
const entityCollecting = ref(false)
/**
 * 采集进度（跑的时候就要显示）。
 *
 * 为什么需要：一次采集要开店铺浏览器 + 建任务 + 跑任务 + 轮询，冷启动实测要 1 分多钟，
 * 而结果面板与 toast 都是**全部跑完才出现**——中途只有按钮文案变成「获取中…」，
 * 看起来就是"点了没反应"。这里把"共几家 / 已完成几家 / 还在等哪几家"实时显示出来。
 */
const entityProgress = ref<{ total: number; done: number; waiting: string[] } | null>(null)
const entityReport = ref<any[]>([])
const manual = reactive({ storeId: '', metric: 'biz.orders', value: null as number | null })
const subtitle = computed(() => props.mode === 'invoices'
  ? '开票与申报资料统一管理。'
  : props.mode === 'tax'
    ? '查看平台按季度报送的涉税经营数据；本应用只读展示，不代替税务申报。'
    : '销售额、订单和经营指标均来自本机快照。')
const bizMetrics = BIZ_METRICS
const totalCards = computed(() => { const t = dataCenter.value?.totals || {}; return [{ label: '店铺', value: t.stores ?? '—', note: `${t.online ?? 0} 家在线` }, { label: '平台', value: t.platforms ?? '—', note: '已配置的平台' }, { label: '指标快照', value: t.snapshots ?? '—', note: '本机采集记录' }, { label: '任务', value: t.tasks ?? '—', note: '任务定义总数' }] })
const snapshotRows = computed<any[]>(() => dataCenter.value?.snapshots || [])
const invoiceRows = computed<any[]>(() => invoiceData.value?.rows || [])
/**
 * 每行补上「无需操作」条数。
 *
 * 各平台把「处理中 / 处理记录」这类**已提交、商家无需再操作**的流水放在同一个发票页，
 * 它们照常展示，但绝不能计入"待开票条数/可开金额"——计入就是虚高（主进程给的 `count`
 * 已经是按 pending 过滤过的；这里再把历史条数单独算出来，好让界面把两个数都说清楚）。
 */
const invoiceAllRows = computed<any[]>(() => invoiceRows.value.map((row: any) => ({
  ...row,
  historyCount: (row.sections || []).reduce((n: number, sec: any) => n + (isPendingSection(sec) ? 0 : (sec.items?.length || 0)), 0)
})))

/** 选中的开票主体（不存在的 key 自动退回"全部"，避免卡在一个空列表里退不出来） */
const invoiceLicense = ref('')
type InvoiceStatusFilter = 'all' | 'pending' | 'processed' | 'error'
const invoiceStatusFilter = ref<InvoiceStatusFilter>('all')
const invoicePlatformFilter = ref('')
const invoiceQuery = ref('')
const invoicePeriodFilter = ref('all')
const licenseEditingId = ref('')
const licenseDraft = reactive({ name: '', no: '' })
const licenseSaving = ref(false)
const licenseEditError = ref('')
/**
 * 视图：按主体分组（**默认**，申报与交代账看它；组下店铺行可点击进入店铺详情）
 * / 按店铺列表（排查视图；每个店铺的「方向明细」点开才渲染）。
 *
 * 2026-10-15 精简：默认从「按店铺」改为「按主体」——打开先看"票压在哪个主体"，店铺列表是二级视角。
 */
const invoiceView = ref<'stores' | 'summary'>('summary')
/**
 * 「按主体」视图里**被收起**的主体组（默认全部展开）。
 *
 * 为什么默认展开：这个视图的第一眼就该回答"谁手下有哪些店"——如果默认收起来，
 * 用户看到的还是一行行主体，跟旧平表没区别，"层级关系"要再点一次才出现。
 * 家数多的组也不怕：最多一家店一行，屏上就那几行。
 */
const collapsedSubjects = ref<Set<string>>(new Set())
function isSubjectCollapsed(key: string): boolean { return collapsedSubjects.value.has(key) }
function toggleSubjectGroup(key: string): void {
  const next = new Set(collapsedSubjects.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedSubjects.value = next
}
/** 「按店铺」视图里展开了「方向明细」的店铺（默认收起——明细点开才渲染，不占首屏） */
const expandedStoreDirs = ref<Set<string>>(new Set())
function isStoreDirsOpen(storeId: string): boolean { return expandedStoreDirs.value.has(storeId) }
function toggleStoreDirs(storeId: string): void {
  const next = new Set(expandedStoreDirs.value)
  if (next.has(storeId)) next.delete(storeId)
  else next.add(storeId)
  expandedStoreDirs.value = next
}
/** 行内排序：默认「按平台顺序」——与主进程给的顺序一致，不擅自重排 */
const invoiceSort = ref<'none' | 'amountDesc' | 'amountAsc'>('none')
/**
 * 工具栏「筛选」面板开合（2026-10-15 精简）：常态只显示搜索与「筛选 · N」，
 * 点开才展开 状态 / 平台 / 采集时间 / 排序 四个下拉；生效中的筛选项数量标在按钮上。
 */
const filtersOpen = ref(false)
const activeFilterCount = computed(() => {
  let count = 0
  if (invoiceStatusFilter.value !== 'all') count++
  if (invoicePlatformFilter.value) count++
  if (invoicePeriodFilter.value !== 'all') count++
  if (invoiceSort.value !== 'none') count++
  return count
})
/** 导出确认浮层：先把"导哪一户、几行、多少钱"写在屏上，再去调主进程（见 openExportConfirm） */
const exporting = ref(false)
const exportConfirm = reactive({ open: false, scopeLabel: '全部主体', pendingRows: 0, amountText: '—', unparsed: 0 })

const licenseGroups = computed(() => groupStoresByLicense(ws.stores.map(store => ({
  id: store.id, licenseName: store.licenseName ?? null, licenseNo: store.licenseNo ?? null
}))))

/**
 * 每个开票主体的待开票条数与金额。
 *
 * 金额用**未按主体筛选**的那一份行来算：胶囊之间要能横向比较，若在筛选后的结果上算，
 * 点开一个主体，别的主体数字全变 0。解析不出的金额**不计入**合计，但条数照数、并标出未解析条数。
 */
const licenseSummary = computed(() => {
  const items = licenseGroups.value.groups.map(group => ({
    ...group, pendingCount: 0, amount: 0, unparsed: 0, stores: 0, amountText: ''
  }))
  const byKey = new Map(items.map(item => [item.key, item]))
  for (const row of invoiceAllRows.value) {
    const hit = byKey.get(licenseGroups.value.keyByStore.get(row.storeId) || '')
    if (!hit) continue
    if ((row.sections || []).some((sec: any) => isPendingSection(sec) && (sec.items?.length || 0) > 0)) hit.stores++
    for (const sec of row.sections || []) {
      if (!isPendingSection(sec)) continue
      for (const item of sec.items || []) {
        hit.pendingCount++
        const amount = parseInvoiceAmount(item.cells?.amount)
        if (amount == null) hit.unparsed++
        else hit.amount += amount
      }
    }
  }
  // P1-2：hasAny 的语义是"**解析出了**金额"（进过 amount 累加），不是"合计 > 0"。
  // 用 `amount > 0` 会把两种真实情况误显示成「—」：退款/冲正把净额抵成负数、或整批都是 0.00。
  const parsedAny = items.some(item => item.pendingCount > item.unparsed)
  const withText = items.map(item => ({ ...item, amountText: invoiceAmountText(item.amount, item.pendingCount > item.unparsed) }))
  return {
    items: withText,
    storeCount: ws.stores.length,
    pendingCount: withText.reduce((sum, item) => sum + item.pendingCount, 0),
    amountText: invoiceAmountText(withText.reduce((sum, item) => sum + item.amount, 0), parsedAny)
  }
})

const activeLicense = computed(() => (
  invoiceLicense.value && licenseSummary.value.items.some(item => item.key === invoiceLicense.value)
    ? invoiceLicense.value
    : ''
))

/** 页面上列出的店铺先按营业执照筛一道（用统一归属表，见 shared/store-license.ts）。 */
const subjectInvoiceRows = computed<any[]>(() => (
  activeLicense.value
    ? invoiceAllRows.value.filter(row => licenseGroups.value.keyByStore.get(row.storeId) === activeLicense.value)
    : invoiceAllRows.value
))

function rowHasPending(row: any): boolean {
  return (row.sections || []).some((section: any) => isPendingSection(section) && (section.items?.length || 0) > 0)
}
function rowHasProcessed(row: any): boolean {
  return Number(row.historyCount || 0) > 0
}
function rowHasIssue(row: any): boolean {
  return !!(row.loginRequired || row.lastFail || row.supported === false || (row.sections || []).some((section: any) => section.emptyNote))
}
function invoiceStatusMatches(row: any): boolean {
  if (invoiceStatusFilter.value === 'all') return true
  if (invoiceStatusFilter.value === 'pending') return rowHasPending(row)
  if (invoiceStatusFilter.value === 'processed') return rowHasProcessed(row)
  return rowHasIssue(row)
}
function invoiceQueryMatches(row: any): boolean {
  const query = invoiceQuery.value.trim().toLowerCase()
  if (!query) return true
  return JSON.stringify(row).toLowerCase().includes(query)
}
function invoicePeriodMatches(row: any): boolean {
  if (invoicePeriodFilter.value === 'all') return true
  const days = Number(invoicePeriodFilter.value)
  const capturedAt = Number(row.capturedAt || 0)
  return capturedAt > 0 && capturedAt >= Date.now() - days * 86400000
}

/** 页面列表同时支持主体、平台、状态、时间和文本筛选；顶部指标仍保持主体口径，避免搜索一行就改变总额。 */
const visibleInvoiceRows = computed<any[]>(() => {
  const rows = subjectInvoiceRows.value.filter(row => {
    const platformOk = !invoicePlatformFilter.value || row.platform === invoicePlatformFilter.value
    return platformOk && invoiceStatusMatches(row) && invoiceQueryMatches(row) && invoicePeriodMatches(row)
  })
  if (invoiceSort.value === 'none') return rows
  return [...rows].sort((a, b) => {
    const keyA = invoiceRowSortKey(a)
    const keyB = invoiceRowSortKey(b)
    if (keyA == null && keyB == null) return 0
    if (keyA == null) return 1
    if (keyB == null) return -1
    return invoiceSort.value === 'amountDesc' ? keyB - keyA : keyA - keyB
  })
})

/** 顶部合计：跟着当前筛选走（"合计"是这一屏的数字；胶囊上的横向比较才是不跟筛选走的那一份） */
const invoiceTotal = computed(() => {
  let count = 0
  let amount = 0
  let unparsed = 0
  let historical = 0
  let stores = 0
  for (const row of subjectInvoiceRows.value) {
    let storePending = 0
    for (const sec of row.sections || []) {
      if (!isPendingSection(sec)) { historical += sec.items?.length || 0; continue }
      for (const item of sec.items || []) {
        count++
        storePending++
        const value = parseInvoiceAmount(item.cells?.amount)
        if (value == null) unparsed++
        else amount += value
      }
    }
    if (storePending > 0) stores++
  }
  // P1-2：hasAny = 至少解析出过一条金额（count - unparsed > 0），而不是"合计 > 0"——
  // 否则"这批票全是 0.00"或"退款把净额抵成负数"都会显示成「—」，把真实数字藏起来。
  return { count, amountText: invoiceAmountText(amount, count - unparsed > 0), stores, historical, unparsed }
})

/**
 * 不受主体筛选影响的全局口径（只用于 KPI 第 1 张卡的交叉印证：
 * 「当前主体 N 条 · 全部主体共 M 条」——否则点了某个公司就再也看不到总数）。
 */
const invoiceGrandTotal = computed(() => {
  let count = 0
  let amount = 0
  let unparsed = 0
  for (const row of invoiceAllRows.value) {
    for (const section of row.sections || []) {
      if (!isPendingSection(section)) continue
      for (const item of section.items || []) {
        count++
        const value = parseInvoiceAmount(item?.cells?.amount)
        if (value == null) unparsed++
        else amount += value
      }
    }
  }
  return { count, amountText: invoiceAmountText(amount, count - unparsed > 0) }
})

/**
 * 采集覆盖情况：这批数字是什么时候的、覆盖了几家、哪几家根本没读到。
 *
 * 为什么单列 `notCollected` 且排除登录态失效：登录失效已经单独一个 chip，
 * 两个数重叠会让「1 家登录态失效」看起来像「1 家登录态失效 + 1 家采不到」= 2 家。
 */
const invoiceCoverage = computed(() => {
  const rows = invoiceAllRows.value
  const captured = rows.filter(row => Number(row.capturedAt || 0) > 0)
  return {
    total: rows.length,
    ok: captured.length,
    loginRequired: rows.filter(row => !!row.loginRequired).length,
    notCollected: rows.filter(row => !row.loginRequired && (!!row.lastFail || row.supported === false)).length,
    lastAt: captured.reduce((max, row) => Math.max(max, Number(row.capturedAt) || 0), 0)
  }
})

/** 还没填营业执照的店铺（状态条上给一条"去补录"的路；不填就申报时按主体分不开） */
const unlicensedPending = computed(() => {
  const item = licenseSummary.value.items.find(entry => entry.key === NO_LICENSE_KEY)
  return { stores: item?.storeCount || 0, pendingCount: item?.pendingCount || 0 }
})

/** 主体胶囊上的占比条：该主体在「待开票条数」里的份额（申报时一眼看出票压在哪个公司名下） */
function licenseShare(count: number): string {
  const total = licenseSummary.value.pendingCount || 0
  if (!total || !count) return '0%'
  return `${Math.max(2, Math.round(count / total * 100))}%`
}

/**
 * 承诺/到期时间 → 逾期或临期。
 *
 * 各平台写法不同（`2026-09-04`、`2026年09月04日`、`逾期 40 天`），**能算就算，算不出就不标**——
 * 宁可少标一个临期，也不猜一个日期出来（猜错会让商家去催一个根本没到期的单子）。
 */
function invoiceDeadlineState(value: unknown): { kind: 'late' | 'soon'; days: number } | null {
  const raw = String(value ?? '').trim()
  if (!raw || raw === '—' || raw === '-' || raw === '--') return null
  /**
   * 「预计」类是**预测**日期，没有承诺含义 → 一律不判逾期。
   *
   * 2026-10-15 审查 BUG：实测快手「阈值生效时间」写成 `2026-06-10(预计)`，曾被映射到 deadline，
   * 于是"过去的日期 = 已逾期"把一批正常账单算成假的已逾期（实测 5 条）。
   * 档案侧的错映射已修（不再映射 deadline），这里再兜一道：任何带"预计"的值都不参与逾期判定。
   */
  if (/预计/.test(raw)) return null
  const matched = /(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})/.exec(raw)
  if (matched) {
    const at = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])).getTime()
    if (Number.isFinite(at)) {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const days = Math.round((at - today.getTime()) / 86400000)
      if (days < 0) return { kind: 'late', days: -days }
      if (days <= 3) return { kind: 'soon', days }
      return null
    }
  }
  // 文字形态的逾期：实测拼多多/抖店混用两种写法——「已逾期 236 天」「已超时 21天36分钟07秒」
  // （只认「逾期」会把抖店那条真超时的漏掉，KPI 反而少报）。
  const late = /(?:逾期|已超时|超时)\s*(\d+)\s*天/.exec(raw)
  return late ? { kind: 'late', days: Number(late[1]) } : null
}

/** 时间风险（只算**待办**方向：无需操作的历史流水没有承诺期，不该报成逾期） */
const invoiceRisk = computed(() => {
  let late = 0
  let soon = 0
  for (const row of subjectInvoiceRows.value) {
    for (const section of row.sections || []) {
      if (!isPendingSection(section)) continue
      for (const item of section.items || []) {
        const state = invoiceDeadlineState(item?.cells?.deadline)
        if (!state) continue
        if (state.kind === 'late') late++
        else soon++
      }
    }
  }
  return { late, soon }
})

/** 当前口径的名字（工具条上写死"口径：…"，避免用户对着数字猜这是谁家的） */
const invoiceScopeLabel = computed(() => {
  if (!activeLicense.value) return '全部主体'
  if (activeLicense.value === NO_LICENSE_KEY) return '未填写营业执照'
  const item = licenseSummary.value.items.find(entry => entry.key === activeLicense.value)
  return item?.label || item?.no || '当前主体'
})

/** 平台品牌色（用于店铺行前的圆点；取不到就退回中性灰，不猜颜色） */
function platformColor(name: unknown): string {
  return findPlatform(String(name || ''))?.color || '#98a2b3'
}

/** 工具条「平台」下拉的候选：只列当前数据里真实出现过的平台 */
const invoicePlatformOptions = computed<string[]>(() => {
  const names = new Set<string>()
  for (const row of invoiceRows.value) {
    const name = String(row.platform || '').trim()
    if (name) names.add(name)
  }
  return [...names]
})

/** 单个方向的金额与"解析出过金额没有"（无需操作的方向金额要置灰，因为它不进合计） */
function invoiceRowSortKey(row: any): number | null {
  const { total, parsed } = invoiceRowAmount(row)
  return parsed ? total : null
}

/* ==================== 涉税信息报送（平台按季度报送给税务机关的经营数据） ==================== */

/**
 * 平台自己写的用途限制。**必须与数据同屏显示**。
 * 快手该页原文：数据"不得作为税务申报、财务审计、监管备案等任何用途使用"。
 * 把这份数据摆到发票中心（用户拿它做申报的地方）却不带这句话，等于应用在替平台背书——
 * 而平台恰恰说了不能用。所以它随接口一起回来，界面如实展示。
 */
function invoiceOpenUrl(row: any): string {
  return String(row?.pageUrl || row?.adminUrl || '')
}
function invoiceOpenLabel(row: any): string {
  if (row?.pageUrl) return '打开开票页'
  return row?.adminUrl ? '打开后台' : '无地址'
}
function invoiceOpenTitle(row: any): string {
  const url = invoiceOpenUrl(row)
  if (!url) return '这家店既没有实测的发票页，也没有后台地址——先在店铺页补一个后台地址'
  return row?.pageUrl
    ? `在该店浏览器里打开开票页：${url}`
    : `该平台尚未实测到可读取的发票页，改为打开后台首页：${url}`
}

/**
 * 打开开票页：确保店铺浏览器已打开并显示 → 切到该店浏览器页 → **新标签页**直达开票地址。
 *
 * 为什么新开标签页而不是覆盖当前页：用户可能正在那家店里做事（刚提交完发票、正在填表），
 * 覆盖掉就把他的上下文弄丢了；新标签页用完随手关即可。
 */
async function openInvoicePage(row: any) {
  const url = invoiceOpenUrl(row)
  if (!url) { ws.toast('这家店没有可跳转的地址（该平台尚未实测到发票页）', 'info'); return }
  // 先自己把店铺开起来（await 得到结果），再让父组件切页——emit 不返回 Promise，不能反过来依赖它
  if (!ws.openStoreIds.includes(row.storeId) || ws.displayedStoreId !== row.storeId) {
    await ws.openStore(row.storeId)
  }
  emit('open-store', row.storeId)
  await ws.newTab(url)
  ws.toast(`已打开「${row.storeName}」的开票页`, 'success')
}

/** 去登录：打开该店的**后台首页**（登录态失效时用户在后台扫码/登录，不是在发票页上） */
async function openStoreAdmin(row: any) {
  const url = String(row?.adminUrl || row?.pageUrl || '')
  if (!url) { ws.toast('这家店没有可打开的后台地址', 'info'); return }
  if (!ws.openStoreIds.includes(row.storeId) || ws.displayedStoreId !== row.storeId) {
    await ws.openStore(row.storeId)
  }
  emit('open-store', row.storeId)
  await ws.newTab(url)
  const pageName = props.mode === 'tax' ? '涉税信息' : '发票中心'
  const collectLabel = props.mode === 'tax' ? '采集涉税报送数据' : '采集发票数据'
  ws.toast(`已打开「${row.storeName}」的后台，登录后回${pageName}点「${collectLabel}」`, 'success')
}

/**
 * 点击「按主体」分组里的店铺行 → 进入该店的**店铺详情**（工作台里的该店浏览器视图）。
 *
 * 与「打开开票页 / 去登录」同一套纪律：先自己把店铺开起来（await 得到结果），再 emit 让父组件
 * 切页——emit 不返回 Promise，不能反过来依赖它。已打开且正在显示的店不重复打开（openStore 幂等）。
 */
async function openStoreDetail(row: any) {
  if (!ws.openStoreIds.includes(row.storeId) || ws.displayedStoreId !== row.storeId) {
    await ws.openStore(row.storeId)
  }
  emit('open-store', row.storeId)
}

/**
 * A1：明细表的列与取值。
 *
 * 为什么列要**按方向动态裁**：payload 的统一列有 8 列（INVOICE_COLUMNS + 其他信息），
 * 但每个平台只填其中几列（抖店 4 列、拼多多 15 列），全摊出来是一大片"—"。
 * 这里只保留"这个方向至少有一条非空值"的列，外加有值时的「其他信息」（未映射列）。
 */
const openSections = ref<Record<string, boolean>>({})
function sectionKey(section: any): string { return String(section?.metricKey || section?.name || '') }
function isSectionOpen(section: any): boolean { return !!openSections.value[sectionKey(section)] }
function toggleSection(section: any) {
  const key = sectionKey(section)
  openSections.value = { ...openSections.value, [key]: !openSections.value[key] }
}
/** 该店当前展开的方向（用于渲染明细区块） */
function openDetailSections(row: any): any[] {
  return (row?.sections || []).filter((section: any) => (section.items?.length || 0) > 0 && isSectionOpen(section))
}
function sectionColumns(section: any): Array<{ key: string; label: string }> {
  const columns = (invoiceData.value?.columns || []) as Array<{ key: string; label: string }>
  const items = (section?.items || []) as any[]
  const used = columns.filter(col => items.some(item => String(item?.cells?.[col.key] ?? '').trim() !== ''))
  const hasExtras = items.some(item => (item?.extras || []).length > 0)
  const out = used.map(col => ({ key: col.key, label: col.label }))
  if (hasExtras) out.push({ key: '__extras', label: '其他信息' })
  return out
}
function detailCell(item: any, key: string): string {
  if (key === '__extras') return (item?.extras || []).map((x: any) => `${x.label}：${x.value}`).join('；')
  return String(item?.cells?.[key] ?? '')
}
function invoiceRowAmount(row: any): { total: number; parsed: number; text: string } {
  let total = 0
  let parsed = 0
  for (const section of row?.sections || []) {
    if (!isPendingSection(section)) continue
    for (const item of section.items || []) {
      const amount = parseInvoiceAmount(item.cells?.amount)
      if (amount == null) continue
      total += amount
      parsed++
    }
  }
  return { total, parsed, text: invoiceAmountText(total, parsed > 0) }
}
function invoiceRowAmountText(row: any): string {
  return invoiceRowAmount(row).text
}
const metricRows = computed(() => {
  const rows = new Map<string, any>()
  for (const store of ws.stores) rows.set(store.id, { storeId: store.id, storeName: store.name, platform: store.platform, values: {}, manual: {}, lastAt: 0 })
  for (const snapshot of snapshotRows.value) { const row = rows.get(snapshot.storeId); if (!row || !String(snapshot.metric).startsWith('biz.')) continue; row.values[snapshot.metric] = snapshot.value; row.manual[snapshot.metric] = !!snapshot.manual; row.lastAt = Math.max(row.lastAt, Number(snapshot.capturedAt) || 0) }
  return [...rows.values()]
})
const manualReady = computed(() => !!manual.storeId && manual.value != null && Number.isFinite(Number(manual.value)) && Number(manual.value) >= 0)
function displayValue(value: unknown) { return value == null || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value) }
function formatTime(value: number) { return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
function formatValue(value: unknown, key: string) { const number = typeof value === 'number' ? value : Number(value); if (!Number.isFinite(number)) return '—'; return key.includes('gmv') || key.includes('Amount') ? `¥ ${number.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}` : number.toLocaleString('zh-CN') }
const exportScope = computed(() => {
  const key = activeLicense.value
  if (!key) return null
  const item = licenseSummary.value.items.find(entry => entry.key === key)
  return { key, label: item?.label || (key === NO_LICENSE_KEY ? '未填写营业执照' : '') }
})
const exportScopeLabel = computed(() => (exportScope.value ? '导出该主体 CSV' : '导出待开票 CSV'))
const exportScopeTitle = computed(() => (exportScope.value
  ? `只导出当前选中的主体「${exportScope.value.label || '未填写营业执照'}」的待开票记录；点「全部」可导出所有主体`
  : '导出全部主体的待开票记录；先在「营业执照」里点一个主体，可只导出该主体'))
/**
 * 打开导出确认浮层：把「导哪一户、几行、多少钱」写在屏上再落盘。
 *
 * 为什么加这一步：导出是**分主体**做的（申报就是按主体报）。用户在屏上点了某家公司，
 * 拿到的不该是别家的单号与税号——范围写在按钮上还不够，落盘前再确认一次。
 */
function openExportConfirm() {
  const scope = exportScope.value
  const item = scope ? licenseSummary.value.items.find(entry => entry.key === scope.key) : null
  exportConfirm.scopeLabel = scope ? (scope.label || '未填写营业执照') : '全部主体'
  exportConfirm.pendingRows = item ? item.pendingCount : licenseSummary.value.pendingCount
  exportConfirm.amountText = item ? item.amountText : licenseSummary.value.amountText
  exportConfirm.unparsed = item ? item.unparsed : licenseSummary.value.items.reduce((sum, entry) => sum + entry.unparsed, 0)
  exportConfirm.open = true
}

/** 汇总表里点「导出该主体」：先切到那个主体，再走同一套确认流程 */

  return {
    loading,

    collecting,

    errorMessage,

    dataCenter,

    invoiceData,

    taxData,

    taxCollecting,

    entityCollecting,

    entityProgress,

    entityReport,

    manual,

    subtitle,

    bizMetrics,

    totalCards,

    snapshotRows,

    invoiceRows,

    invoiceAllRows,

    invoiceLicense,

    invoiceStatusFilter,

    invoicePlatformFilter,

    invoiceQuery,

    invoicePeriodFilter,

    licenseEditingId,

    licenseDraft,

    licenseSaving,

    licenseEditError,

    invoiceView,

    collapsedSubjects,

    isSubjectCollapsed,

    toggleSubjectGroup,

    expandedStoreDirs,

    isStoreDirsOpen,

    toggleStoreDirs,

    invoiceSort,

    filtersOpen,

    activeFilterCount,

    exporting,

    exportConfirm,

    licenseGroups,

    licenseSummary,

    activeLicense,

    subjectInvoiceRows,

    rowHasPending,

    rowHasProcessed,

    rowHasIssue,

    invoiceStatusMatches,

    invoiceQueryMatches,

    invoicePeriodMatches,

    visibleInvoiceRows,

    invoiceTotal,

    invoiceGrandTotal,

    invoiceCoverage,

    unlicensedPending,

    licenseShare,

    invoiceDeadlineState,

    invoiceRisk,

    invoiceScopeLabel,

    platformColor,

    invoicePlatformOptions,

    invoiceRowSortKey,

    invoiceOpenUrl,

    invoiceOpenLabel,

    invoiceOpenTitle,

    openInvoicePage,

    openStoreAdmin,

    openStoreDetail,

    openSections,

    sectionKey,

    isSectionOpen,

    toggleSection,

    openDetailSections,

    sectionColumns,

    detailCell,

    invoiceRowAmount,

    invoiceRowAmountText,

    metricRows,

    manualReady,

    displayValue,

    formatTime,

    formatValue,

    exportScope,

    exportScopeLabel,

    exportScopeTitle,

    openExportConfirm,

  }
}

export type InvoiceDetailApi = ReturnType<typeof useInvoiceDetail>
