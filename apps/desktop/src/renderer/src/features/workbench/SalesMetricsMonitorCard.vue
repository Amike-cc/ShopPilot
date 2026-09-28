<template>
  <section class="sales-metrics-card" :data-test="'sales-metrics-monitor'">
    <div class="unified-card-head">
      <div>
        <h2>经营数据自动采集</h2>
        <span>
          每店铺独立计划 · 默认 10 分钟 · 最后计算 {{ health ? formatTime(health.computedAt) : '—' }}
        </span>
      </div>
      <div class="sales-metrics-actions">
        <label class="sales-metrics-toggle">
          <input v-model="autoRefresh" type="checkbox" />实时刷新
        </label>
        <button type="button" class="unified-button ghost" :disabled="loading" @click="load">
          {{ loading ? '读取中…' : '刷新' }}
        </button>
      </div>
    </div>

    <div v-if="errorMessage" class="unified-alert error" role="alert">
      {{ errorMessage }} <button type="button" @click="load">重试</button>
    </div>

    <div v-if="health" class="sales-metrics-counters">
      <span v-for="counter in counters" :key="counter.label" :class="['counter', counter.tone]">
        <b>{{ counter.value }}</b>{{ counter.label }}
      </span>
    </div>

    <div v-if="plans.length" class="unified-table-wrap">
      <table class="unified-table sales-metrics-table">
        <thead>
          <tr>
            <th>店铺</th>
            <th>平台</th>
            <th>状态</th>
            <th>新鲜度</th>
            <th>成交金额</th>
            <th>成交订单</th>
            <th>退款金额</th>
            <th>最后成功</th>
            <th>平台更新时间</th>
            <th>下次采集</th>
            <th>来源 / 版本</th>
            <th>连续失败</th>
            <th>最近失败原因</th>
            <th>最近 24 小时</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="plan in plans" :key="plan.storeId">
            <td>
              <span class="store-name">{{ plan.storeName }}</span>
              <small class="store-id">{{ plan.timezone }} · 周期 {{ formatInterval(plan.intervalMs) }}</small>
            </td>
            <td>{{ plan.platform }}</td>
            <td><span :class="['chip', statusTone(plan)]">{{ statusLabel(plan) }}</span></td>
            <td><span :class="['chip', freshnessTone(plan.freshness)]">{{ freshnessLabel(plan.freshness) }}</span></td>
            <td>{{ money(plan.metrics?.paidSalesAmountMinor ?? plan.metrics?.grossSalesAmountMinor) }}</td>
            <td>{{ count(plan.metrics?.paidOrderCount) }}</td>
            <td>{{ money(plan.metrics?.refundAmountMinor) }}</td>
            <td>{{ plan.lastSuccessAt ? formatTime(plan.lastSuccessAt) : '从未成功' }}</td>
            <td>{{ plan.sourceUpdatedAt ? formatTime(plan.sourceUpdatedAt) : '平台未提供' }}</td>
            <td>{{ plan.enabled ? (plan.nextRunAt ? formatTime(plan.nextRunAt) : '等待用户处理') : '已暂停' }}</td>
            <td>
              <span>{{ sourceLabel(plan.sourceType) }}</span>
              <small class="store-id">{{ plan.adapterVersion || '未执行到 Adapter' }}</small>
            </td>
            <td>{{ plan.consecutiveFailures }}<span v-if="plan.backoffUntil" class="store-id"> · 退避至 {{ formatTime(plan.backoffUntil) }}</span></td>
            <td>
              <span v-if="plan.lastReasonCode" :title="plan.lastSafeMessage || ''">{{ plan.lastReasonCode }}</span>
              <span v-else>—</span>
              <small v-if="plan.lastSafeMessage" class="store-id">{{ plan.lastSafeMessage }}</small>
            </td>
            <td>
              <span v-if="!plan.trend.length" class="store-id">暂无成功点</span>
              <svg v-else class="sparkline" viewBox="0 0 100 24" preserveAspectRatio="none" role="img" :aria-label="trendLabel(plan)">
                <polyline :points="sparkPoints(plan)" />
              </svg>
            </td>
            <td class="row-actions">
              <button type="button" :disabled="busy === plan.storeId" @click="runNow(plan)">立即采集</button>
              <button v-if="plan.enabled" type="button" :disabled="busy === plan.storeId" @click="pause(plan)">暂停</button>
              <button v-else type="button" :disabled="busy === plan.storeId" @click="resume(plan)">恢复</button>
              <button type="button" @click="showRuns(plan)">运行记录</button>
              <button type="button" @click="emit('open-store', plan.storeId)">打开页面</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="unified-empty compact">
      还没有采集计划。新店铺会在 30 秒内自动生成计划；也可以点「刷新」立即同步。
    </div>

    <div v-if="runsOpen" class="sales-metrics-drawer">
      <div class="drawer-head">
        <strong>{{ runsStoreName }} · 运行记录</strong>
        <button type="button" class="unified-button ghost" @click="runsOpen = false">关闭</button>
      </div>
      <div v-if="runsLoading" class="store-id">读取中…</div>
      <div v-else-if="runs.length" class="unified-table-wrap">
        <table class="unified-table">
          <thead>
            <tr><th>计划时间</th><th>开始</th><th>结束</th><th>耗时</th><th>状态</th><th>原因码</th><th>说明</th><th>写入</th><th>Adapter</th></tr>
          </thead>
          <tbody>
            <tr v-for="run in runs" :key="run.runId">
              <td>{{ formatTime(run.plannedAt) }}</td>
              <td>{{ run.startedAt ? formatTime(run.startedAt) : '—' }}</td>
              <td>{{ run.finishedAt ? formatTime(run.finishedAt) : '进行中' }}</td>
              <td>{{ run.durationMs == null ? '—' : `${Math.round(run.durationMs / 1000)}s` }}</td>
              <td>{{ run.status }}</td>
              <td>{{ run.reasonCode || '—' }}</td>
              <td>{{ run.safeMessage || '—' }}</td>
              <td>新增 {{ run.inserted }} / 更新 {{ run.updated }}</td>
              <td>{{ run.adapterVersion || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="store-id">该店铺还没有运行记录。</div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import { useWorkspaceStore } from '../../stores/workspace'
import type {
  SalesMetricsFreshness,
  SalesMetricsHealth,
  SalesMetricsPlanView,
  SalesMetricsRunView,
  SalesMetricsSourceType,
  SalesMetricsTrendPoint
} from '@shared/contracts/sales-metrics'

const emit = defineEmits<{ 'open-store': [storeId: string] }>()
const ws = useWorkspaceStore()

const loading = ref(false)
const busy = ref('')
const errorMessage = ref('')
const plans = ref<SalesMetricsPlanView[]>([])
const health = ref<SalesMetricsHealth | null>(null)
const autoRefresh = ref(true)
const runsOpen = ref(false)
const runsLoading = ref(false)
const runs = ref<SalesMetricsRunView[]>([])
const runsStoreName = ref('')

let refreshTimer: ReturnType<typeof setInterval> | null = null

const counters = computed(() => {
  const value = health.value?.counters
  if (!value) return []
  return [
    { label: '店铺', value: value.total, tone: '' },
    { label: '已启用', value: value.enabled, tone: '' },
    { label: '新鲜', value: value.fresh, tone: value.fresh ? 'ok' : '' },
    { label: '临期', value: value.aging, tone: value.aging ? 'warn' : '' },
    { label: '过期', value: value.stale, tone: value.stale ? 'warn' : '' },
    { label: '从未成功', value: value.unavailable, tone: value.unavailable ? 'warn' : '' },
    { label: '来源未验证', value: value.sourceUnverified, tone: value.sourceUnverified ? 'warn' : '' },
    { label: '需用户处理', value: value.requiresUserAction, tone: value.requiresUserAction ? 'bad' : '' },
    { label: '熔断', value: value.circuitOpen, tone: value.circuitOpen ? 'bad' : '' },
    { label: '24h 成功', value: value.successesLast24h, tone: '' },
    { label: '24h 失败', value: value.failuresLast24h, tone: value.failuresLast24h ? 'warn' : '' }
  ]
})

async function load(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    const result = await window.shopilot.salesMetrics.plans()
    if (!result.ok) { errorMessage.value = result.error.message; return }
    plans.value = result.data.items
    health.value = result.data.health
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

function notify(message: string, tone: 'success' | 'error' | 'info'): void {
  ws.toast(message, tone)
}

async function runNow(plan: SalesMetricsPlanView): Promise<void> {
  busy.value = plan.storeId
  try {
    const result = await window.shopilot.salesMetrics.planRunNow(plan.storeId)
    if (!result.ok) notify(`立即采集失败：${result.error.message}`, 'error')
    else notify(`${plan.storeName} 已加入采集队列（并发上限 2，按序执行）`, 'success')
  } finally {
    busy.value = ''
    await load()
  }
}

async function pause(plan: SalesMetricsPlanView): Promise<void> {
  busy.value = plan.storeId
  try {
    const result = await window.shopilot.salesMetrics.planPause(plan.storeId)
    if (!result.ok) notify(`暂停失败：${result.error.message}`, 'error')
    else notify(`${plan.storeName} 的采集计划已暂停`, 'success')
  } finally {
    busy.value = ''
    await load()
  }
}

async function resume(plan: SalesMetricsPlanView): Promise<void> {
  busy.value = plan.storeId
  try {
    const result = await window.shopilot.salesMetrics.planResume(plan.storeId)
    if (!result.ok) notify(`恢复失败：${result.error.message}`, 'error')
    else notify(`${plan.storeName} 的采集计划已恢复（失败计数与熔断已清零）`, 'success')
  } finally {
    busy.value = ''
    await load()
  }
}

async function showRuns(plan: SalesMetricsPlanView): Promise<void> {
  runsOpen.value = true
  runsStoreName.value = plan.storeName
  runsLoading.value = true
  try {
    const result = await window.shopilot.salesMetrics.runs({ storeId: plan.storeId, pageSize: 50 })
    runs.value = result.ok ? result.data.items : []
  } finally {
    runsLoading.value = false
  }
}

/* ------------------------------------------------------------------ *
 * 展示口径：null 与 0 必须显示成不同的东西
 * ------------------------------------------------------------------ */

/** 金额：null = 没有可靠数据（显示"—"），0 = 平台明确返回的 0（显示 ¥0.00）。 */
function money(value: number | null | undefined): string {
  if (value == null) return '—'
  return `¥${(value / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function count(value: number | null | undefined): string {
  if (value == null) return '—'
  return value.toLocaleString('zh-CN')
}

function formatInterval(ms: number): string {
  if (ms % 3600000 === 0) return `${ms / 3600000} 小时`
  return `${Math.round(ms / 60000)} 分钟`
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function sourceLabel(source: SalesMetricsSourceType): string {
  return {
    NETWORK: '网络响应',
    DOM: '页面字段',
    EXPORT: '平台导出',
    ORDER_AGGREGATION: '订单聚合',
    OCR: '视觉识别',
    MANUAL: '手动录入',
    TEST_FIXTURE: '测试夹具',
    NONE: '无来源'
  }[source] || source
}

const statusText: Record<string, string> = {
  NOT_CONFIGURED: '未配置', NOT_VERIFIED: '尚未验证', READY: '待采集', RUNNING: '采集中',
  SUCCEEDED: '成功', PARTIAL: '部分成功', LOGIN_REQUIRED: '需重新登录', VERIFY_REQUIRED: '需安全验证',
  PERMISSION_DENIED: '权限不足', PAGE_CHANGED: '页面改版', NO_METRICS_FOUND: '页面无数据',
  TIMEOUT: '超时', NETWORK_ERROR: '网络异常', DATA_SOURCE_NOT_VERIFIED: '来源未验证',
  STALE: '数据过期', CIRCUIT_OPEN: '已熔断', DISABLED: '已暂停', ALREADY_RUNNING: '已有采集在跑',
  INTERRUPTED: '被中断', ERROR: '失败'
}

function statusLabel(plan: SalesMetricsPlanView): string {
  if (!plan.enabled) return statusText.DISABLED
  return statusText[plan.lastStatus || 'NOT_CONFIGURED'] || plan.lastStatus || '未知'
}

function statusTone(plan: SalesMetricsPlanView): string {
  if (!plan.enabled) return 'muted'
  const status = plan.lastStatus
  if (status === 'SUCCEEDED') return 'ok'
  if (status === 'PARTIAL' || status === 'RUNNING' || status === 'READY' || status === 'ALREADY_RUNNING') return 'info'
  if (status === 'DATA_SOURCE_NOT_VERIFIED' || status === 'NOT_VERIFIED' || status === 'NO_METRICS_FOUND') return 'muted'
  return 'bad'
}

const freshnessText: Record<SalesMetricsFreshness, string> = {
  FRESH: '新鲜', AGING: '临期', STALE: '过期', UNAVAILABLE: '从未成功', PARTIAL: '部分字段', SOURCE_UNVERIFIED: '来源未验证'
}

function freshnessLabel(freshness: SalesMetricsFreshness): string { return freshnessText[freshness] || freshness }

function freshnessTone(freshness: SalesMetricsFreshness): string {
  if (freshness === 'FRESH') return 'ok'
  if (freshness === 'AGING' || freshness === 'PARTIAL') return 'info'
  if (freshness === 'SOURCE_UNVERIFIED') return 'muted'
  return 'bad'
}

/** 24 小时趋势：只画有值的成功点；没有成功点时不画线（而不是画一条 0 的线）。 */
function sparkPoints(plan: SalesMetricsPlanView): string {
  const points = plan.trend.filter(point => point.paidSalesAmountMinor != null)
  if (points.length < 2) return ''
  const values = points.map(point => Number(point.paidSalesAmountMinor))
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  return points.map((point, index) => {
    const x = (index / (points.length - 1)) * 100
    const y = 22 - ((Number(point.paidSalesAmountMinor) - min) / span) * 20
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
}

function trendLabel(plan: SalesMetricsPlanView): string {
  const points = plan.trend.filter((point: SalesMetricsTrendPoint) => point.paidSalesAmountMinor != null)
  if (points.length < 2) return `${plan.storeName} 最近 24 小时只有 ${points.length} 个成功点，不足以画趋势`
  const first = points[0].paidSalesAmountMinor as number
  const last = points[points.length - 1].paidSalesAmountMinor as number
  return `${plan.storeName} 最近 24 小时成交金额 ${(first / 100).toFixed(2)} → ${(last / 100).toFixed(2)} 元`
}

function onEvent(): void {
  if (autoRefresh.value) void load()
}

watch(autoRefresh, (enabled) => {
  if (enabled) void load()
})

onMounted(() => {
  void load()
  window.shopilot.on(EVENT_CHANNELS.SALES_METRICS_PLAN_UPDATED, onEvent)
  window.shopilot.on(EVENT_CHANNELS.SALES_METRICS_RUN_FINISHED, onEvent)
  window.shopilot.on(EVENT_CHANNELS.SALES_METRICS_HEALTH_CHANGED, onEvent)
  // 兜底轮询：事件通道在窗口重建/视图挂载切换时可能漏一拍，30 秒兜一次。
  refreshTimer = setInterval(() => { if (autoRefresh.value) void load() }, 30_000)
})

onBeforeUnmount(() => {
  window.shopilot.off(EVENT_CHANNELS.SALES_METRICS_PLAN_UPDATED, onEvent)
  window.shopilot.off(EVENT_CHANNELS.SALES_METRICS_RUN_FINISHED, onEvent)
  window.shopilot.off(EVENT_CHANNELS.SALES_METRICS_HEALTH_CHANGED, onEvent)
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
})

defineExpose({ reload: load })
</script>

<style scoped>
.sales-metrics-card{min-width:0;padding:16px;margin-bottom:12px;border:1px solid var(--dash-border);border-radius:13px;background:#ffffff}
.sales-metrics-actions{display:flex;align-items:center;gap:10px}
.sales-metrics-toggle{display:flex;align-items:center;gap:5px;color:var(--dash-text-muted);font-size:11px;cursor:pointer}
.sales-metrics-counters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.sales-metrics-counters .counter{display:flex;align-items:baseline;gap:5px;padding:5px 9px;border:1px solid var(--dash-border);border-radius:8px;color:var(--dash-text-muted);font-size:11px}
.sales-metrics-counters .counter b{color:var(--dash-text-soft);font-size:14px}
.sales-metrics-counters .counter.ok b{color:#027a48}
.sales-metrics-counters .counter.warn b{color:#b54708}
.sales-metrics-counters .counter.bad b{color:#b42318}
.sales-metrics-table td{vertical-align:top;white-space:nowrap}
.sales-metrics-table .store-name{display:block;color:var(--dash-text)}
.sales-metrics-table .store-id{display:block;color:var(--dash-text-muted);font-size:10px;max-width:190px;white-space:normal}
.chip{display:inline-block;padding:2px 7px;border-radius:6px;font-size:10px;border:1px solid transparent}
.chip.ok{border-color:rgba(90,209,154,.4);background:rgba(90,209,154,.14);color:#027a48}
.chip.info{border-color:rgba(151,120,255,.4);background:rgba(113,78,231,.18);color:#5b3df5}
.chip.warn{border-color:rgba(242,165,87,.4);background:rgba(242,165,87,.14);color:#b54708}
.chip.bad{border-color:rgba(239,99,119,.4);background:rgba(117,37,58,.24);color:#b42318}
.chip.muted{border-color:var(--dash-border);background:#ededef;color:var(--dash-text-muted)}
.sparkline{width:100px;height:24px}
.sparkline polyline{fill:none;stroke:#7c5cff;stroke-width:1.4;vector-effect:non-scaling-stroke}
.row-actions{display:flex;gap:5px}
.row-actions button{padding:3px 7px;border:1px solid var(--dash-border);border-radius:6px;background:#ffffff;color:var(--dash-text-soft);font-size:10px;cursor:pointer}
.row-actions button:hover:not(:disabled){border-color:rgba(151,120,255,.7);color:#fff}
.row-actions button:disabled{opacity:.5;cursor:not-allowed}
.sales-metrics-drawer{margin-top:12px;padding:12px;border:1px solid var(--dash-border);border-radius:10px;background:#ebeced}
.drawer-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
</style>
