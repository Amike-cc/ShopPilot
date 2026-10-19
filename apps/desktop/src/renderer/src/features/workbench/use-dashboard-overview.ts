import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { SalesMetrics, SalesMetricsPlanView } from '@shared/contracts/sales-metrics'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import { useWorkspaceStore } from '../../stores/workspace'

/**
 * 「经营总览」页的数据层（从 DashboardView.vue 原样外移，行为不变）。
 *
 * 只被 DashboardOverviewPage.vue 实例化——它仅在 `activePage === 'overview'` 时挂载，
 * 所以原先的 `isOnOverview` 门控在这里恒为真（= 页面在，才刷新），语义与拆分前一致：
 * 离开总览页时组件卸载，定时器/事件监听/数据都不再运行（拆分前是守卫挡住的空转）。
 */

export type LoadState = 'loading' | 'ready' | 'empty' | 'error'
export type PeriodKey = 'today' | 'yesterday' | '7d' | '30d' | 'custom'

export interface SnapshotRow {
  id: string
  metric: string
  value: unknown
  sourceRunId?: string | null
  capturedAt: number
  storeId: string
  storeName: string
  platform: string
}

export interface KpiRowItem { key: string; label: string; tone: string; value: string; delta: number | null; note: string; hint: string; inverse?: boolean }

export interface DashboardOverviewOptions {
  /** 顶部提示条（原先 DashboardView 的 showNotice，状态仍留在页面容器里）。 */
  onNotice: (message: string) => void
  /** 刷新数据时顺带刷新「待开发票」卡片（原先 loadDashboardData 里的 await loadInvoiceTodo()）。 */
  refreshInvoiceTodo?: () => Promise<void> | void
}

type CollectedPeriodType = 'TODAY' | 'YESTERDAY' | 'LAST_7_DAYS' | 'LAST_30_DAYS'
interface CollectedStore { storeId: string; storeName: string; platform: string; plan: SalesMetricsPlanView; series: SalesMetrics[] }

/** 等工作区就绪（页面容器初始化 ws.init() 与总览页取数之间的时序靠它兜住；原 DashboardView.waitForWorkspace 原样外移）。 */
export async function waitForWorkspaceReady(ws: ReturnType<typeof useWorkspaceStore>) {
  if (ws.ready) return
  await new Promise<void>(resolve => {
    const stop = watch(() => ws.ready, ready => { if (ready) { stop(); resolve() } })
  })
}

export function useDashboardOverview(options: DashboardOverviewOptions) {
  const ws = useWorkspaceStore()

  const numeric = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Number(value.replace(/[￥¥,\s]/g, ''))
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  }
  const formatNumber = (value: number | null) => value === null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value)
  const formatTime = (value: number | null | undefined) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '尚未同步'
  const formatMoneyCompact = (value: number | null) => value === null ? '—' : `¥ ${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value)}`

  // 默认口径 = 今日（用户要求，2026-10-02）。这里**不持久化**：每次打开都回到今日，
  // 用户手动切到别的口径只影响当次会话（与左栏收起状态不同，那是持久化的）。
  const period = ref<PeriodKey>('today')
  const selectedPlatform = ref('all')
  const dataState = ref<LoadState>('loading')
  const dataError = ref('')
  const snapshotState = ref<LoadState>('loading')
  const snapshotPartial = ref(false)
  const snapshots = ref<SnapshotRow[]>([])
  const hoveredPoint = ref<any | null>(null)
  let loadingSnapshots = false
  let stopStoreWatch: (() => void) | null = null

  // 周期页签顺序：今日(默认) / 昨日 / 近 7 天 / 近 30 天 / 自定义日期
  // （设计稿里默认是"近 7 天"，2026-10-02 用户要求改成"今日"）
  const periodOptions: Array<{ key: PeriodKey; label: string }> = [
    { key: 'today', label: '今日' }, { key: 'yesterday', label: '昨日' }, { key: '7d', label: '近 7 天' },
    { key: '30d', label: '近 30 天' }, { key: 'custom', label: '自定义日期' }
  ]

  const platformOptions = computed(() => [...new Set(snapshots.value.map(item => item.platform))].sort((a, b) => a.localeCompare(b, 'zh-CN')))

  /** 任务快照（store_snapshots）里的指标合计：自动采集缺该字段时的兜底来源 */
  function metricAggregate(metric: string, platform = 'all') {
    const rows = snapshots.value.filter(row => row.metric === metric && (platform === 'all' || row.platform === platform))
    const latest = rows.reduce((sum, row) => sum + (numeric(row.value) || 0), 0)
    return rows.length && rows.some(row => numeric(row.value) !== null) ? latest : null
  }

  // ---------- 自动采集的经营指标（每 10 分钟一次，落 sales_metrics） ----------
  // 经营总览过去只读 store_snapshots，而那张表只由「带 metric 的任务步骤」和手动录入写入：
  // 自动采集跑得再勤，页面上的数字也不动（2026-09-28 用户实报"数据还是没有正常更新到软件"，
  // 实测卡片显示的是 9/13 的旧快照值）。现在卡片与趋势优先用采集数据，规则如下：
  //   · 只在**同一口径**（periodType）内相加：今日累计 / 近 7 天滚动 / 近 30 天滚动不能混加；
  //   · 采集数据缺失时才回落到任务快照，并在卡片上标明来源（数字必须能说清"从哪来、什么时候"）；
  //   · 订单数取 paidOrderCount（平台页面上的"成交订单"），无值时如实显示"该口径未提供"。
  const PERIOD_TO_TYPE: Record<PeriodKey, CollectedPeriodType> = { today: 'TODAY', yesterday: 'YESTERDAY', '7d': 'LAST_7_DAYS', '30d': 'LAST_30_DAYS', custom: 'LAST_30_DAYS' }
  const PERIOD_CAPTION: Record<PeriodKey, string> = { today: '今日累计', yesterday: '昨日', '7d': '近 7 天滚动', '30d': '近 30 天滚动', custom: '近 30 天滚动' }

  const collectedStores = ref<CollectedStore[]>([])
  const collectedState = ref<LoadState>('loading')
  const collectedFetchedAt = ref<number | null>(null)

  /** 相对时间：让"数据有多新"一眼可见（采集是最多 10 分钟一轮） */
  function relativeTime(ts: number | null | undefined): string {
    if (!ts) return '尚未采集'
    const diff = Date.now() - ts
    if (diff < 60_000) return '刚刚'
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
    return `${Math.floor(diff / 86400_000)} 天前`
  }

  async function loadCollectedMetrics() {
    collectedState.value = 'loading'
    try {
      await waitForWorkspace()
      const periodType = PERIOD_TO_TYPE[period.value]
      // 计划列表带每店的采集状态/原因（拼多多=来源未验证就是从这里来的），一次调用即可
      const plansRes = await window.shopilot.salesMetrics.plans()
      const plans = (plansRes.ok ? (plansRes.data?.items || []) : []) as SalesMetricsPlanView[]
      const settled = await Promise.allSettled(plans.map(async plan => {
        const listRes = await window.shopilot.salesMetrics.list({ storeId: plan.storeId, periodType, pageSize: 120 })
        const series = (listRes.ok ? (listRes.data?.items || []) : []) as SalesMetrics[]
        return { storeId: plan.storeId, storeName: plan.storeName, platform: plan.platform, plan, series } as CollectedStore
      }))
      collectedStores.value = settled.filter((r): r is PromiseFulfilledResult<CollectedStore> => r.status === 'fulfilled').map(r => r.value)
      collectedFetchedAt.value = Date.now()
      collectedState.value = collectedStores.value.some(row => row.series.length) ? 'ready' : 'empty'
    } catch {
      collectedState.value = 'error'
    }
  }

  const collectedRows = computed(() => collectedStores.value.filter(row => selectedPlatform.value === 'all' || row.platform === selectedPlatform.value))
  /** 每店在该口径下的最新一条（列表按 period_end/collected_at 倒序） */
  const collectedLatest = computed(() => collectedRows.value
    .map(row => ({ row, metric: row.series[0] as SalesMetrics | undefined }))
    .filter((item): item is { row: CollectedStore; metric: SalesMetrics } => !!item.metric))

  function collectedSum(pick: (metric: SalesMetrics) => number | null, scale = 1): { value: number | null; covered: number; total: number; partial: boolean } {
    const rows = collectedLatest.value
    let sum = 0
    let covered = 0
    let partial = false
    for (const item of rows) {
      const raw = pick(item.metric)
      if (raw === null || raw === undefined) { partial = true; continue }
      sum += raw * scale
      covered++
    }
    return { value: covered ? sum : null, covered, total: collectedRows.value.length, partial }
  }
  /**
   * 与"上一个采集日"比：采集是按天原地更新，同一天多次采集之间比没有意义（差值为 0 会被误读成"没变化"）。
   * 因此每店只找**日历日不同**的上一条；没有跨天数据就返回 null，卡片改显示采集覆盖度说明。
   */
  function collectedDelta(pick: (metric: SalesMetrics) => number | null, scale = 1): number | null {
    const dayKeyOf = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` }
    let current = 0
    let previous = 0
    let hasCurrent = false
    let hasPrevious = false
    for (const row of collectedRows.value) {
      const newest = row.series[0]
      if (!newest) continue
      const newestDay = dayKeyOf(newest.collectedAt)
      const older = row.series.find(metric => dayKeyOf(metric.collectedAt) !== newestDay)
      const cur = pick(newest)
      const prev = older ? pick(older) : null
      if (cur !== null) { current += cur * scale; hasCurrent = true }
      if (prev !== null) { previous += prev * scale; hasPrevious = true }
    }
    if (!hasCurrent || !hasPrevious || previous === 0) return null
    return ((current - previous) / Math.abs(previous)) * 100
  }
  function collectedNote(stat: { covered: number; total: number; partial: boolean }): string {
    if (!stat.total) return '尚无采集计划'
    if (!stat.covered) return `${PERIOD_CAPTION[period.value]}未采集到该字段`
    return `${stat.covered}/${stat.total} 家 · ${relativeTime(collectedFreshestAt.value)}${stat.partial ? ' · 部分字段' : ''}`
  }
  const collectedFreshestAt = computed(() => {
    const times = collectedLatest.value.map(item => item.metric.collectedAt).filter((ts): ts is number => Number.isFinite(ts))
    return times.length ? Math.max(...times) : null
  })
  const collectedMoney = computed(() => collectedSum(m => m.grossSalesAmountMinor, 0.01))
  const collectedOrders = computed(() => collectedSum(m => m.paidOrderCount))

  const legacyOrders = computed(() => metricAggregate('biz.orders'))
  const legacyGmv = computed(() => metricAggregate('biz.gmv'))

  /**
   * 销售概览 KPI 行（设计稿的六项）。
   *
   * 数据规则与页面其余部分一致：**优先自动采集**，采集缺该字段时回落到任务快照并标注来源。
   * 「投放花费」只有抖店（「投放消耗」）与拼多多（「推广花费」）有可读来源，其余平台留空并如实标注；
   * 「投产比 ROI」只拿**同一批既报了成交额又报了投放花费的店铺**相除——不把没有花费来源的店铺的
   * 成交额算进分子，否则 ROI 会凭空变好（分母缺项而分子齐全，是这类指标最常见的造假方式）。
   */
  const collectedRefundAmount = computed(() => collectedSum(m => m.refundAmountMinor, 0.01))
  const collectedRefundOrders = computed(() => collectedSum(m => m.refundOrderCount))
  const collectedAdSpend = computed(() => collectedSum(m => m.adSpendMinor, 0.01))
  /** 投产比只用"有花费也有成交额"的店铺，分子分母同源 */
  const collectedRoi = computed(() => {
    let gross = 0
    let spend = 0
    let covered = 0
    for (const item of collectedLatest.value) {
      const gmv = item.metric.grossSalesAmountMinor
      const adSpend = item.metric.adSpendMinor
      if (gmv == null || adSpend == null) continue
      gross += gmv
      spend += adSpend
      covered++
    }
    return { value: covered && spend > 0 ? gross / spend : null, covered, total: collectedRows.value.length }
  })
  const legacyRefundAmount = computed(() => metricAggregate('biz.refundAmount'))
  const legacyRefundOrders = computed(() => metricAggregate('biz.refundOrders'))

  const kpiRow = computed<KpiRowItem[]>(() => {
    const build = (
      key: string, label: string, tone: string,
      stat: { value: number | null; covered: number; total: number; partial: boolean },
      legacy: number | null, formatter: (value: number | null) => string,
      delta: number | null, hint: string, inverse = false
    ): KpiRowItem => {
      const fromCollected = stat.value !== null
      return {
        key, label, tone,
        value: formatter(fromCollected ? stat.value : legacy),
        delta: fromCollected ? delta : null,
        note: fromCollected ? collectedNote(stat) : (legacy !== null ? '任务快照' : '未采集'),
        hint: `${hint}｜${fromCollected ? `自动采集 ${stat.covered}/${stat.total} 家店铺有值` : '自动采集暂无数据'}`,
        inverse
      }
    }
    return [
      build('gmv', '销售金额', 'purple', collectedMoney.value, legacyGmv.value, formatMoneyCompact,
        collectedDelta(m => m.grossSalesAmountMinor, 0.01), `销售额（${PERIOD_CAPTION[period.value]}，成交金额）`),
      build('orders', '订单数', 'blue', collectedOrders.value, legacyOrders.value, formatNumber,
        collectedDelta(m => m.paidOrderCount), `成交订单数（${PERIOD_CAPTION[period.value]}）`),
      build('refundAmount', '退款金额', 'red', collectedRefundAmount.value, legacyRefundAmount.value, formatMoneyCompact,
        collectedDelta(m => m.refundAmountMinor, 0.01), '退款金额（退款日口径）', true),
      build('refundOrders', '退款订单', 'amber', collectedRefundOrders.value, legacyRefundOrders.value, formatNumber,
        collectedDelta(m => m.refundOrderCount), '成交退款订单数', true),
      // 投放花费与 ROI 都不做跨日涨跌配色：花费涨不等于好、跌也不等于坏，给数字配上红绿
      // 等于替用户下判断。这里只报数值与覆盖度。
      build('adSpend', '投放花费', 'yellow', collectedAdSpend.value, null, formatMoneyCompact,
        null, '投放花费（平台口径：抖店「投放消耗」、拼多多「推广花费」；快手/微信没有可读来源）'),
      buildRoi()
    ]
  })
  function buildRoi(): KpiRowItem {
    const roi = collectedRoi.value
    const value = roi.covered > 0 ? roi.value : null
    return {
      key: 'roi',
      label: '投产比 ROI',
      tone: 'green',
      value: value === null ? '—' : value.toFixed(2),
      delta: null,
      note: value === null
        ? (roi.total ? `${PERIOD_CAPTION[period.value]}缺投放花费` : '尚无采集计划')
        : `${roi.covered}/${roi.total} 家（有花费也有成交额）`,
      hint: '投产比 ROI = 成交金额 ÷ 投放花费，只用**同时**报了这两个字段的店铺计算（分子分母同源，不拿没有花费来源的店铺的成交额充分子）'
    }
  }
  function deltaClass(kpi: KpiRowItem): string {
    if (kpi.delta === null) return 'muted'
    const good = kpi.inverse ? kpi.delta < 0 : kpi.delta >= 0
    return good ? 'up' : 'down'
  }

  /**
   * 趋势图的时间窗。
   *
   * 口径=今日时**放宽到 7 天**（2026-10-02 默认口径改成今日后暴露的问题）：采集每天只落一条
   * （原地更新、跨天才连成线），1 天窗口永远只画得出一个点，趋势图等于没有。
   * 口径本身不变——只画"今日累计"这一种行，所以这条线表示的是**每天的当日总额**，趋势成立。
   * 其余口径维持原窗口（昨日 1 天 / 近 7 天 7 天 / 近 30 天与自定义 30 天）。
   */
  const trendWindowStart = computed(() => {
    const days = period.value === 'yesterday' ? 1 : period.value === '30d' || period.value === 'custom' ? 30 : 7
    return Date.now() - days * 86400000
  })
  /**
   * 自动采集的按天曲线：每店每天取"当天最后一条"（采集是原地更新，一天一条，跨天才连成线）。
   * 只取选中口径的行——今日累计与近 7 天滚动不能画在同一根线上。
   */
  const collectedTrendPoints = computed(() => {
    const groups = new Map<string, { key: string; timestamp: number; label: string; fullLabel: string; gmv: number | null; orders: number | null }>()
    const windowStart = trendWindowStart.value
    for (const row of collectedRows.value) {
      const lastOfDay = new Map<string, SalesMetrics>()
      for (const metric of row.series) {
        if (metric.collectedAt < windowStart) continue
        const when = new Date(metric.collectedAt)
        const dayKey = `${when.getFullYear()}-${when.getMonth() + 1}-${when.getDate()}`
        const kept = lastOfDay.get(dayKey)
        if (!kept || metric.collectedAt > kept.collectedAt) lastOfDay.set(dayKey, metric)
      }
      for (const metric of lastOfDay.values()) {
        const when = new Date(metric.collectedAt)
        const key = `${when.getFullYear()}-${when.getMonth() + 1}-${when.getDate()}`
        const item = groups.get(key) || { key, timestamp: new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime(), label: `${when.getMonth() + 1}/${when.getDate()}`, fullLabel: when.toLocaleDateString('zh-CN'), gmv: null, orders: null }
        if (metric.grossSalesAmountMinor !== null) item.gmv = (item.gmv || 0) + metric.grossSalesAmountMinor / 100
        if (metric.paidOrderCount !== null) item.orders = (item.orders || 0) + metric.paidOrderCount
        groups.set(key, item)
      }
    }
    return [...groups.values()].sort((a, b) => a.timestamp - b.timestamp)
  })
  const snapshotTrendPoints = computed(() => {
    const groups = new Map<string, { key: string; timestamp: number; label: string; fullLabel: string; gmv: number | null; orders: number | null }>()
    const relevant = snapshots.value.filter(row => row.capturedAt >= trendWindowStart.value && (selectedPlatform.value === 'all' || row.platform === selectedPlatform.value))
    for (const row of relevant) {
      if (row.metric !== 'biz.gmv' && row.metric !== 'biz.orders') continue
      const date = new Date(row.capturedAt)
      const key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
      const item = groups.get(key) || { key, timestamp: new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(), label: `${date.getMonth() + 1}/${date.getDate()}`, fullLabel: date.toLocaleDateString('zh-CN'), gmv: null, orders: null }
      const value = numeric(row.value)
      if (value !== null) item[row.metric === 'biz.gmv' ? 'gmv' : 'orders'] = (item[row.metric === 'biz.gmv' ? 'gmv' : 'orders'] || 0) + value
      groups.set(key, item)
    }
    return [...groups.values()].sort((a, b) => a.timestamp - b.timestamp)
  })
  /** 采集数据优先；没有该口径的采集点时才回落到任务指标快照（并如实标注来源） */
  const trendSource = computed<'collected' | 'snapshot' | 'none'>(() => collectedTrendPoints.value.length ? 'collected' : (snapshotTrendPoints.value.length ? 'snapshot' : 'none'))
  const trendPoints = computed(() => trendSource.value === 'collected' ? collectedTrendPoints.value : snapshotTrendPoints.value)
  const collectedUnverifiedPlatforms = computed(() => [...new Set(collectedRows.value
    // 从未采到过任何数据 + 最近一次明确报"来源未验证" → 才是真的未验证；
    // 采到过数据的平台不在这里出现（否则会拿历史状态盖住已经到手的数据）
    .filter(row => row.plan.lastSuccessAt == null
      && (row.plan.lastReasonCode === 'DATA_SOURCE_NOT_VERIFIED' || row.plan.lastStatus === 'DATA_SOURCE_NOT_VERIFIED'))
    .map(row => row.platform))])
  const trendCaption = computed(() => {
    if (trendSource.value === 'collected') {
      const covered = collectedRows.value.filter(row => row.series.length).length
      const unverified = collectedUnverifiedPlatforms.value
      return `${PERIOD_CAPTION[period.value]} · 自动采集 ${covered}/${collectedRows.value.length} 家 · ${relativeTime(collectedFreshestAt.value)}${unverified.length ? ` · ${unverified.join('、')}数据源未验证` : ''}`
    }
    if (trendSource.value === 'snapshot') return `${snapshotPartial.value ? '部分店铺读取失败 · ' : ''}来自任务指标快照（自动采集在该口径下暂无数据）`
    return snapshotPartial.value ? '部分店铺读取失败，其余快照仍展示' : '仅展示已采集的经营快照'
  })
  const trendEmptyHint = computed(() => {
    const unverified = collectedUnverifiedPlatforms.value
    const base = `自动采集每 10 分钟一次，可在「数据分析」查看采集状态；当前口径（${PERIOD_CAPTION[period.value]}）还没有采到数据`
    return unverified.length ? `${base}。${unverified.join('、')}：数据源未验证` : base
  })
  // 图表几何：viewBox 900×260（左侧留 y 轴刻度，底部留日期标签）
  const CHART = { left: 62, right: 874, top: 18, bottom: 216 }
  /**
   * 以 0 为基线做纵向映射（0 → 画布底部，最大值 → 顶部）。
   *
   * 为什么不用 min-max 拉伸：只有两天数据时，min-max 会把「118.70 → 108.90」这种小幅回落
   * 拉成贯穿整个画布的断崖，看上去像数据崩了（实测踩过）。金额与件数都是非负量，从 0 起画
   * 既符合直觉（设计稿的 0/10万/20万… 也是从 0 起），也让差异如实呈现。
   */
  const toY = (value: number | null, values: number[]) => {
    if (value === null || !values.length) return null
    const max = Math.max(...values, 0) || 1
    return CHART.bottom - (value / max) * (CHART.bottom - CHART.top)
  }
  const trendPlot = computed(() => {
    const points = trendPoints.value
    const gmvValues = points.map(point => point.gmv).filter((value): value is number => value !== null)
    const orderValues = points.map(point => point.orders).filter((value): value is number => value !== null)
    const span = CHART.right - CHART.left
    return points.map((point, index) => ({
      ...point,
      x: points.length <= 1 ? (CHART.left + CHART.right) / 2 : CHART.left + (index / (points.length - 1)) * span,
      gmvY: toY(point.gmv, gmvValues),
      ordersY: toY(point.orders, orderValues)
    }))
  })
  const pathFor = (key: 'gmvY' | 'ordersY') => trendPlot.value.filter(point => point[key] !== null).map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point[key]}`).join(' ')
  const gmvPath = computed(() => pathFor('gmvY'))
  const orderPath = computed(() => pathFor('ordersY'))
  const areaFor = (path: string) => path ? `${path} L ${CHART.right} ${CHART.bottom} L ${CHART.left} ${CHART.bottom} Z` : ''
  const gmvAreaPath = computed(() => areaFor(gmvPath.value))
  const tooltipStyle = computed(() => hoveredPoint.value ? { left: `${Math.min(80, Math.max(8, (hoveredPoint.value.x / 900) * 100))}%` } : {})
  /** Y 轴刻度按销售额取整成 4 档（1/2/2.5/5×10ⁿ），与设计稿的「0/10万/20万…」同一读法 */
  function niceStep(raw: number): number {
    const base = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))))
    const n = Math.max(raw / base, 1)
    const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10
    return mult * base
  }
  function formatAxisMoney(value: number): string {
    if (!value) return '0'
    if (value >= 10000) return `${(value / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}万`
    return value.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
  }
  const chartYAxis = computed(() => {
    const values = trendPlot.value.map(point => point.gmv).filter((value): value is number => value !== null)
    const step = niceStep((values.length ? Math.max(...values) : 1) / 4)
    return Array.from({ length: 5 }, (_, index) => ({
      value: step * index,
      // index 0 → 画布底部（值 0），index 4 → 顶部（值 4×step）：与 toY 的方向一致
      y: CHART.bottom - (index / 4) * (CHART.bottom - CHART.top),
      label: formatAxisMoney(step * index)
    }))
  })

  /** 平台在线汇总（设计稿右上角的「N / M 在线」胶囊） */
  const platformOnlineSummary = computed(() => {
    const rows = platformSyncRows.value
    return `${rows.filter(row => row.state === 'online').length} / ${rows.length} 在线`
  })

  const platformSyncRows = computed(() => {
    // The renderer can also be opened by Vite for visual review without Electron's
    // preload bridge. Keep the dashboard mounted in that mode; the desktop path
    // still receives the configured platform list from preload as before.
    const configuredPlatforms = ((window as Window & { shopilot?: Window['shopilot'] }).shopilot?.platforms || []) as Array<{ name: string }>
    const names = [...new Set([...configuredPlatforms.map(platform => platform.name), ...ws.stores.map(store => store.platform)])]
    return names.map(name => {
      const stores = ws.stores.filter(store => store.platform === name)
      // "最近同步"优先取**自动采集**的时间：那才是这个平台真正的同步动作。
      // 用 plan.lastSuccessAt（最近一次成功采集，**不限口径**）—— 否则抖店只采"今日"、
      // 用户选了"近 7 天"时就查不到采集数据，界面会退回显示 9 月的旧任务快照，看起来像"没在同步"。
      const collectedTimes = collectedStores.value
        .filter(row => row.platform === name)
        .map(row => row.plan.lastSuccessAt ?? row.series[0]?.collectedAt ?? null)
        .filter((ts): ts is number => Number.isFinite(ts as number))
      const latestSnapshot = snapshots.value.filter(snapshot => snapshot.platform === name).sort((a, b) => b.capturedAt - a.capturedAt)[0]
      const hasLoginIssue = stores.some(store => store.status === 'needs_login')
      const hasOffline = stores.some(store => ['offline', 'proxy_error', 'incomplete'].includes(store.status))
      const state = hasLoginIssue ? 'login' : hasOffline ? 'offline' : stores.length ? 'online' : 'empty'
      // 来源未验证的平台：**只在这家平台一份数据都没有时**才这么说。
      // 一旦采到过（lastSuccessAt 有值），"最近同步"就该显示真实时间——不能拿一个历史状态
      // 盖住已经到手的数据（拼多多就是这么从"未验证"变成"有数据"的）。
      const unverified = !collectedTimes.length && collectedStores.value.some(row => row.platform === name
        && (row.plan.lastReasonCode === 'DATA_SOURCE_NOT_VERIFIED' || row.plan.lastStatus === 'DATA_SOURCE_NOT_VERIFIED'))
      const lastSync = unverified
        ? '数据源未验证'
        : (collectedTimes.length
          ? `自动采集 ${relativeTime(Math.max(...collectedTimes))}`
          : (latestSnapshot ? `任务快照 ${formatTime(latestSnapshot.capturedAt)}` : '尚未同步'))
      return { name, count: stores.length, state, stateLabel: state === 'login' ? '登录失效' : state === 'offline' ? '部分离线' : state === 'online' ? '正常运行' : '未连接', lastSync }
    }).filter(row => row.count > 0 || ws.stores.length === 0)
  })

  async function waitForWorkspace() {
    await waitForWorkspaceReady(ws)
  }

  async function loadSnapshots() {
    if (loadingSnapshots) return
    loadingSnapshots = true; snapshotState.value = 'loading'
    try {
      await waitForWorkspace()
      const settled = await Promise.allSettled(ws.stores.map(async store => {
        const response = await window.shopilot.snapshot.list(store.id, 60)
        if (!response.ok) throw new Error(response.error.message)
        return (response.data || []).map((item: any) => ({ ...item, storeId: store.id, storeName: store.name, platform: store.platform })) as SnapshotRow[]
      }))
      const succeeded = settled.filter((item): item is PromiseFulfilledResult<SnapshotRow[]> => item.status === 'fulfilled')
      const failed = settled.filter(item => item.status === 'rejected')
      snapshots.value = succeeded.flatMap(item => item.value)
      snapshotPartial.value = succeeded.length > 0 && failed.length > 0
      snapshotState.value = failed.length === settled.length && settled.length > 0 ? 'error' : snapshots.value.length ? 'ready' : 'empty'
    } catch { snapshotState.value = 'error' } finally { loadingSnapshots = false }
  }

  async function loadDashboardData() {
    dataState.value = 'loading'; dataError.value = ''
    await options.refreshInvoiceTodo?.()
    try {
      await waitForWorkspace()
      await Promise.all([loadSnapshots(), loadCollectedMetrics()])
      dataState.value = ws.stores.length || snapshots.value.length || collectedStores.value.length ? 'ready' : 'empty'
    } catch (error: any) {
      dataState.value = 'error'; dataError.value = error?.message || '概览数据读取失败'
    }
  }

  /**
   * 「刷新数据」= **真的去采一轮**，不是重读本地库。
   *
   * 为什么必须去采：卡片上的数字来自每 10 分钟一次的自动采集，重读本地库只会把同一份旧数据
   * 再画一遍——用户按了按钮看到数字没变，会以为"采集坏了"。所以这里对**当前筛选范围内**的店铺
   * 逐个入队「立即采集」（走调度器：有运行记录、有并发上限、失败退避都在），等它们跑完再读库。
   *
   * 等待期间按钮显示进度（采集中 2/4），完成后弹一条汇总：成功的多少家、失败的分别是什么原因
   * （原因码直接来自运行记录，不编中文猜测）。
   */
  const collectState = reactive({ running: false, done: 0, total: 0 })
  const refreshLabel = computed(() => {
    if (collectState.running) return `采集中 ${collectState.done}/${collectState.total}`
    return dataState.value === 'loading' ? '读取中…' : '刷新数据'
  })
  const COLLECT_REASON_TEXT: Record<string, string> = {
    QUEUED: '已入队',
    ALREADY_RUNNING: '已在采集中',
    PLAN_NOT_FOUND: '没有采集计划',
    PLATFORM_PROFILE_NOT_MEASURED: '该平台未实测采集档案',
    STORE_NOT_FOUND: '店铺不存在',
    PAGE_NOT_READY: '店铺页面打不开',
    PAGE_NOT_RENDERED: '页面没渲染出来',
    PERIOD_NOT_APPLIED: '统计周期没切换成功',
    PERIOD_CONTROL_NOT_FOUND: '找不到周期控件',
    LOGIN_REQUIRED: '登录态已失效',
    NETWORK_ERROR: '网络/加载失败',
    SALES_METRICS_PARTIAL: '只采到部分指标',
    NO_METRICS_FOUND: '页面当前没有数值',
    COLLECTION_TIMEOUT: '超时',
    CIRCUIT_OPEN: '连续失败已停机'
  }
  async function refreshData() {
    if (!(window as Window & { shopilot?: Window['shopilot'] }).shopilot) {
      options.onNotice('桌面桥接未就绪，当前预览页不能执行数据采集')
      return
    }
    if (collectState.running) return
    await waitForWorkspace()
    const targets = ws.stores.filter(store => selectedPlatform.value === 'all' || store.platform === selectedPlatform.value)
    if (!targets.length) { await loadDashboardData(); return }

    collectState.running = true
    collectState.total = targets.length
    collectState.done = 0
    const pending = new Map(targets.map(store => [store.id, store.name]))
    const failed: string[] = []
    const finished = (payload: any) => {
      const storeId = payload?.storeId
      if (!pending.has(storeId)) return
      const storeName = pending.get(storeId) || storeId
      pending.delete(storeId)
      collectState.done = collectState.total - pending.size
      if (payload.status !== 'SUCCEEDED' && payload.status !== 'PARTIAL') {
        failed.push(`${storeName}：${COLLECT_REASON_TEXT[payload.reasonCode] || payload.reasonCode || payload.status}`)
      }
    }
    window.shopilot.on(EVENT_CHANNELS.SALES_METRICS_RUN_FINISHED, finished)
    try {
      for (const store of targets) {
        const response = await window.shopilot.salesMetrics.planRunNow(store.id)
        if (!response.ok || !(response.data as any)?.accepted) {
          pending.delete(store.id)
          collectState.done = collectState.total - pending.size
          const reason = response.ok ? (response.data as any)?.reasonCode : response.error?.message
          failed.push(`${store.name}：${COLLECT_REASON_TEXT[String(reason)] || reason || '未能入队'}`)
        }
      }
      // 等入队的跑完：并发上限内四家店约一分钟；给 6 分钟上限以免页面卡住时按钮永远转圈。
      const deadline = Date.now() + 6 * 60 * 1000
      while (pending.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 700))
      if (pending.size) for (const name of pending.values()) failed.push(`${name}：等待超时`)
    } finally {
      window.shopilot.off(EVENT_CHANNELS.SALES_METRICS_RUN_FINISHED, finished)
      collectState.running = false
    }

    await loadDashboardData()
    const okCount = targets.length - failed.length
    options.onNotice(failed.length
      ? `已采集 ${okCount}/${targets.length} 家；${failed.join('；')}`
      : `已按当前口径采集 ${okCount} 家店铺的最新数据`)
  }

  // 口径（今日/近 7 天/近 30 天）与平台筛选变了就重新取采集数据：
  // 不同口径的采集行不能混用（近 7 天滚动值当日增量相加会虚高），必须回主进程重查。
  watch([period, selectedPlatform], () => { void loadCollectedMetrics() })
  // 采集每 10 分钟一轮：停在总览页时定时刷新一次，用户不用手动点"刷新数据"
  let collectedTimer: number | undefined
  function scheduleCollectedRefresh() {
    if (collectedTimer) window.clearInterval(collectedTimer)
    collectedTimer = window.setInterval(() => { if (!document.hidden) void loadCollectedMetrics() }, 5 * 60 * 1000)
  }
  /**
   * 采集完成事件 → 立刻刷新总览。
   * 光靠定时器会滞后（采集 20:19 完成、界面可能 20:24 才更新），而这正是"数据没更新到软件"的观感来源。
   */
  function onCollectedRunFinished() {
    void loadCollectedMetrics()
  }

  onMounted(async () => {
    await loadDashboardData()
    scheduleCollectedRefresh()
    // Vite 预览页没有 Electron preload，事件订阅会抛错（与拆分前一致：预览模式下不订阅）。
    if (!window.shopilot) return
    window.shopilot.on(EVENT_CHANNELS.SALES_METRICS_RUN_FINISHED, onCollectedRunFinished)
    stopStoreWatch = watch(() => ws.stores.map(store => `${store.id}:${store.status}`).join('|'), () => { void loadSnapshots(); void loadCollectedMetrics() })
  })
  onBeforeUnmount(() => {
    if (window.shopilot) window.shopilot.off(EVENT_CHANNELS.SALES_METRICS_RUN_FINISHED, onCollectedRunFinished)
    stopStoreWatch?.()
    if (collectedTimer) window.clearInterval(collectedTimer)
  })

  return {
    period, periodOptions, selectedPlatform, platformOptions,
    dataState, dataError,
    snapshotState, snapshots, hoveredPoint,
    kpiRow, deltaClass, formatNumber,
    trendPlot, chartYAxis, gmvAreaPath, orderPath, gmvPath, tooltipStyle,
    trendCaption, trendEmptyHint,
    platformSyncRows, platformOnlineSummary,
    collectState, refreshLabel, refreshData, loadDashboardData,
    loadSnapshots, loadCollectedMetrics,
    collectedState
  }
}
