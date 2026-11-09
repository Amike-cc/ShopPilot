<template>
  <div class="ui-page overview-page">
    <div class="ui-page__inner">
      <header class="ui-page-head">
        <div class="ui-page-head__copy">
          <span class="ui-eyebrow">WORKSPACE / OVERVIEW</span>
          <h1 class="ui-page-title">经营总览</h1>
          <p class="ui-page-desc">销售、退款、投放与待办一屏看完。所有数字都取自本机最近一次采集，读不到的指标如实显示「—」，不当成 0。</p>
        </div>
        <div class="ui-page-actions">
          <button
            type="button"
            class="ui-btn ui-btn--secondary"
            data-test="overview-refresh"
            :disabled="collectState.running || dataState === 'loading'"
            @click="refreshData"
          >
            <AppIcon name="refresh" :size="14" />
            {{ refreshLabel }}
          </button>
          <button v-if="aiInstalled" type="button" class="ui-btn ui-btn--primary" @click="emit('open-assistant')">
            <AppIcon name="sparkles" :size="14" />
            问问 AI
          </button>
        </div>
      </header>

      <div v-if="dataState === 'error'" class="ui-notice ui-notice--error" role="alert">
        <AppIcon name="alert" :size="15" />
        <span>{{ dataError || '首页数据暂时无法读取' }}</span>
        <button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" @click="loadDashboardData">重试</button>
      </div>

      <div class="ov-grid">
        <div class="ov-main">
          <!-- 销售概览：标题 + 口径控件 + 6 个核心指标 + 趋势图同属一张卡，
               避免"指标与图各自一张卡、中间被 16px 空白割断"（旧版三张卡的问题） -->
          <section id="sales-trend" class="ui-card ov-summary">
            <div class="ov-summary-head">
              <div class="ui-card__title">
                <h2>销售概览</h2>
                <p>核心经营指标</p>
              </div>
              <div class="ov-summary-tools">
                <div class="ui-seg" role="tablist" aria-label="统计范围">
                  <button
                    v-for="periodOption in periodOptions"
                    :key="periodOption.key"
                    type="button"
                    :class="{ on: period === periodOption.key }"
                    :aria-selected="period === periodOption.key"
                    role="tab"
                    @click="period = periodOption.key"
                  >{{ periodOption.label }}</button>
                </div>
                <select v-model="selectedPlatform" class="ui-select ov-platform" aria-label="平台筛选">
                  <option value="all">全部平台</option>
                  <option v-for="platform in platformOptions" :key="platform" :value="platform">{{ platform }}</option>
                </select>
              </div>
            </div>

            <div class="ov-kpis">
              <div v-for="kpi in kpiRow" :key="kpi.key" class="ov-kpi" :title="kpi.hint">
                <span class="ov-kpi-label">{{ kpi.label }}</span>
                <strong :class="['ov-kpi-value', { placeholder: kpi.value === '—' }]">{{ kpi.value }}</strong>
                <span v-if="kpi.delta !== null" :class="['ov-kpi-delta', deltaClass(kpi)]">
                  <AppIcon :name="kpi.delta >= 0 ? 'trend-up' : 'trend-down'" :size="12" />
                  {{ Math.abs(kpi.delta).toFixed(1) }}%
                </span>
                <span v-else class="ov-kpi-note">{{ kpi.note }}</span>
              </div>
            </div>

            <div class="ov-chart-wrap">
              <div v-if="snapshotState === 'loading' || collectedState === 'loading'" class="ui-loading"><span class="ui-spinner"></span>正在读取趋势数据…</div>
              <div v-else-if="snapshotState === 'error' && collectedState === 'error'" class="ui-empty ui-empty--compact">
                <div class="ui-empty__icon"><AppIcon name="alert" :size="20" /></div>
                <strong class="ui-empty__title">趋势数据读取失败</strong>
                <button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" @click="loadSnapshots(); loadCollectedMetrics()">
                  <AppIcon name="refresh" :size="13" />重试
                </button>
              </div>
              <div v-else-if="!trendPlot.length" class="ui-empty ui-empty--compact">
                <div class="ui-empty__icon"><AppIcon name="chart" :size="20" /></div>
                <strong class="ui-empty__title">暂无可用趋势数据</strong>
                <span class="ui-empty__desc">{{ trendEmptyHint }}</span>
              </div>
              <template v-else>
                <svg class="ov-chart" viewBox="0 0 900 260" role="img" aria-label="销售额和订单数趋势图" @mouseleave="hoveredPoint = null">
                  <defs>
                    <linearGradient id="gmv-fill" x1="0" x2="0" y1="0" y2="1">
                      <stop class="gmv-stop-top" offset="0" stop-opacity=".22" />
                      <stop class="gmv-stop-bottom" offset="1" stop-opacity="0" />
                    </linearGradient>
                  </defs>
                  <g class="chart-grid">
                    <template v-for="tick in chartYAxis" :key="tick.value">
                      <line x1="62" :y1="tick.y" x2="874" :y2="tick.y" />
                      <text class="chart-y-label" x="48" :y="tick.y + 4" text-anchor="end">{{ tick.label }}</text>
                    </template>
                    <line v-for="point in trendPlot" :key="`v-${point.key}`" class="chart-grid-v" :x1="point.x" y1="18" :x2="point.x" y2="216" />
                  </g>
                  <path v-if="gmvAreaPath" :d="gmvAreaPath" class="chart-area" />
                  <path v-if="orderPath" :d="orderPath" class="chart-line order-line" />
                  <path v-if="gmvPath" :d="gmvPath" class="chart-line gmv-line" />
                  <g v-for="point in trendPlot" :key="point.key">
                    <text class="chart-x-label" :x="point.x" y="244" text-anchor="middle">{{ point.label }}</text>
                    <circle v-if="point.gmvY !== null" class="chart-point gmv-point" :cx="point.x" :cy="point.gmvY" r="3" @mouseenter="hoveredPoint = point" />
                    <circle v-if="point.ordersY !== null" class="chart-point order-point" :cx="point.x" :cy="point.ordersY" r="2.6" @mouseenter="hoveredPoint = point" />
                  </g>
                  <line v-if="hoveredPoint" class="chart-guide" :x1="hoveredPoint.x" y1="14" :x2="hoveredPoint.x" y2="216" />
                  <circle v-if="hoveredPoint && hoveredPoint.gmvY !== null" class="chart-hover-dot gmv" :cx="hoveredPoint.x" :cy="hoveredPoint.gmvY" r="4" />
                  <circle v-if="hoveredPoint && hoveredPoint.ordersY !== null" class="chart-hover-dot orders" :cx="hoveredPoint.x" :cy="hoveredPoint.ordersY" r="4" />
                </svg>
                <div v-if="hoveredPoint" class="trend-tooltip" :style="tooltipStyle">
                  <strong>{{ hoveredPoint.fullLabel }}</strong>
                  <span v-if="hoveredPoint.gmv !== null"><i class="legend-dot gmv"></i>销售额 <b>{{ formatNumber(hoveredPoint.gmv) }}</b></span>
                  <span v-if="hoveredPoint.orders !== null"><i class="legend-dot orders"></i>订单数 <b>{{ formatNumber(hoveredPoint.orders) }}</b></span>
                </div>
                <div class="ov-legend">
                  <span><i class="legend-dot gmv"></i>销售额</span>
                  <span><i class="legend-dot orders"></i>订单数</span>
                </div>
              </template>
            </div>
            <p class="ov-caption">{{ trendCaption }}</p>
          </section>

          <section id="quick-start" class="ui-card">
            <div class="ui-card__head">
              <div class="ui-card__title"><h2>快捷操作</h2><p>常用能力一键直达</p></div>
            </div>
            <div class="ui-card__body ov-tiles">
              <article
                v-for="tile in visibleQuickActions"
                :key="tile.key"
                :class="['ov-tile', `tone-${tile.tone}`, { disabled: !tile.available }]"
                :data-test="'quick-action-' + tile.key"
              >
                <span class="ov-tile-icon" aria-hidden="true"><AppIcon :name="tile.icon" :size="18" /></span>
                <div class="ov-tile-copy">
                  <strong>{{ tile.label }}</strong>
                  <small>{{ tile.description }}</small>
                </div>
                <button
                  type="button"
                  class="ui-btn ui-btn--secondary ui-btn--sm"
                  :data-test="'quick-action-btn-' + tile.key"
                  :disabled="!tile.available"
                  @click="handleQuickAction(tile)"
                >
                  {{ tile.available ? tile.actionLabel : '待接入' }}
                  <AppIcon v-if="tile.available" name="arrow-right" :size="13" />
                </button>
              </article>
            </div>
          </section>
        </div>

        <aside class="ov-rail">
          <section id="platform-sync" class="ui-card">
            <div class="ui-card__head">
              <div class="ui-card__title"><h2>平台同步状态</h2></div>
              <span class="ui-chip ui-chip--success">{{ platformOnlineSummary }}</span>
            </div>
            <div class="ui-card__body ov-sync">
              <div v-if="!platformSyncRows.length" class="ui-empty ui-empty--compact">
                <div class="ui-empty__icon"><AppIcon name="store" :size="18" /></div>
                <strong class="ui-empty__title">暂无店铺连接</strong>
              </div>
              <div v-for="row in platformSyncRows" :key="row.name" class="ov-sync-row">
                <PlatformIcon :name="row.name" :size="18" />
                <div class="ov-sync-copy">
                  <strong>{{ row.name }}</strong>
                  <span>{{ row.count }} 家店铺</span>
                </div>
                <div class="ov-sync-meta">
                  <span :class="['ui-dot', row.state]"></span>
                  <strong>{{ row.stateLabel }}</strong>
                  <small>{{ row.lastSync }}</small>
                </div>
              </div>
            </div>
            <div class="ui-card__foot">
              <button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" @click="emit('navigate', 'stores')">
                管理店铺<AppIcon name="arrow-right" :size="13" />
              </button>
            </div>
          </section>

          <section v-if="aiInstalled" id="ai-assistant" class="ui-card ov-ai">
            <div class="ov-ai-icon" aria-hidden="true"><AppIcon name="sparkles" :size="18" /></div>
            <h2>AI 电商助手</h2>
            <p>创作、优化、分析，一站完成。只给建议，不替你动店铺数据。</p>
            <button type="button" class="ui-btn ui-btn--primary ui-btn--block" @click="emit('open-assistant')">
              开始对话<AppIcon name="arrow-right" :size="14" />
            </button>
          </section>

          <section v-if="invoicesInstalled" id="invoice-todo" class="ui-card">
            <div class="ui-card__head">
              <div class="ui-card__title"><h2>待开发票</h2></div>
              <span class="ui-chip ui-chip--soft">{{ pendingInvoices.length }} 家店铺</span>
            </div>
            <div class="ui-card__body">
              <div v-if="invoiceTodoState === 'loading'" class="ui-loading"><span class="ui-spinner"></span>正在读取发票待办…</div>
              <div v-else-if="!pendingInvoices.length" class="ui-empty ui-empty--compact">
                <div class="ui-empty__icon"><AppIcon name="receipt" :size="18" /></div>
                <strong class="ui-empty__title">暂无待开发票</strong>
                <span class="ui-empty__desc">采集发票后，仍有待开票记录的店铺会列在这里。</span>
              </div>
              <ul v-else class="ov-todo">
                <li v-for="item in pendingInvoices" :key="item.id" class="ov-todo-row" role="button" tabindex="0" @click="emit('open-invoices')" @keydown.enter="emit('open-invoices')">
                  <AppIcon name="receipt" :size="14" />
                  <span class="ov-todo-title" :title="item.name">{{ item.name }}</span>
                  <span :class="['ui-chip', item.tone === 'urgent' ? 'ui-chip--danger' : 'ui-chip--warning']">{{ item.badge }}</span>
                </li>
              </ul>
            </div>
            <div class="ui-card__foot">
              <button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" @click="emit('open-invoices')">
                打开发票中心<AppIcon name="arrow-right" :size="13" />
              </button>
            </div>
          </section>
        </aside>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import PlatformIcon from '../../../components/PlatformIcon.vue'
import AppIcon from '../../../components/ui/AppIcon.vue'
import { computed } from 'vue'
import { useDashboardOverview, type LoadState } from '../use-dashboard-overview'
import { isModuleInstalled } from '../use-app-modules'

/**
 * 「经营总览」页（2026-11 界面重构）。
 *
 * 数据层完全沿用 ../use-dashboard-overview.ts，本文件只重写结构与本页样式：
 * 旧版把「销售概览 / 快捷操作 / 平台同步 / AI 助手 / 待开发票」拆成 5 张同权重卡片，
 * 首屏注意力被平均分配；新版把 6 个 KPI 与趋势图收进同一张主卡（先看结论再看走势），
 * 右栏只放"需要你处理的事"（同步异常、待开发票）与 AI 入口。
 *
 * 契约：data-test="overview-refresh" / quick-action-{image,publish} /
 * quick-action-btn-{image,publish} 必须保留（renderer-entries、image-analysis、
 * dashboard-apps 三套验收都按这些锚点点击）。
 */
defineProps<{
  invoiceTodoState: LoadState
  pendingInvoices: Array<{ id: string; name: string; badge: string; tone: string }>
}>()
const emit = defineEmits<{
  navigate: [page: 'stores' | 'image-studio' | 'products']
  'open-invoices': []
  'open-assistant': []
  notice: [message: string]
  'refresh-invoice-todo': []
}>()

const {
  period, periodOptions, selectedPlatform, platformOptions,
  dataState, dataError, snapshotState, collectedState, hoveredPoint,
  kpiRow, deltaClass, formatNumber,
  trendPlot, chartYAxis, gmvAreaPath, orderPath, gmvPath, tooltipStyle,
  trendCaption, trendEmptyHint,
  platformSyncRows, platformOnlineSummary,
  collectState, refreshLabel, refreshData, loadDashboardData, loadSnapshots, loadCollectedMetrics
} = useDashboardOverview({
  onNotice: message => emit('notice', message),
  refreshInvoiceTodo: () => emit('refresh-invoice-todo')
})

/** 图标改为 AppIcon 名字：旧版两个 44px PNG 与侧栏图标风格不一致 */
const quickActions = [
  { key: 'image', label: 'AI 生成商品图', description: '白底图、场景图，选模型直接出图', icon: 'image', tone: 'purple', available: true, actionLabel: '立即创作' },
  { key: 'publish', label: '批量发布商品', description: '多平台批量发布，先预检再执行', icon: 'box', tone: 'blue', available: true, actionLabel: '去发布' }
]
/**
 * 模块卸载后总览不能再露出对应入口（2026-11-09 审查）。
 * 侧栏与路由已有守卫，但总览的 AI 按钮/卡片、商品快捷入口和待开发票卡是独立渲染的，
 * 守卫只在点击后跳商城——用户仍会看到一个"装了但点不开"的入口，语义不一致。
 */
const aiInstalled = computed(() => isModuleInstalled('ai'))
const productsInstalled = computed(() => isModuleInstalled('products'))
const invoicesInstalled = computed(() => isModuleInstalled('invoices'))
const visibleQuickActions = computed(() => quickActions.filter(action => {
  if (action.key === 'image') return aiInstalled.value
  if (action.key === 'publish') return productsInstalled.value
  return true
}))
function handleQuickAction(action: (typeof quickActions)[number]) {
  if (action.key === 'image') { emit('navigate', 'image-studio'); return }
  // 批量发布已落地（商品管理内的预检/批量编排/人工确认），快捷入口不能再显示「待接入」。
  if (action.key === 'publish') { emit('navigate', 'products'); return }
  if (action.available) emit('notice', `${action.label}：${action.description}`)
}
</script>

<style scoped>
/* ---------------- 经营总览 ----------------
   只用 tokens.css 的令牌；本页不再出现硬编码色值与彩色阴影。 */
.overview-page {
  padding-top: var(--sp-5);
}

/* 主栅格：左内容 / 右待办。1380 以下右栏降到 300px，1180 以下单列。 */
.ov-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: var(--sp-4);
  align-items: start;
}
.ov-main,
.ov-rail {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--sp-4);
}

/* ---- 销售概览 ---- */
.ov-summary {
  padding: var(--sp-4) var(--sp-5) var(--sp-5);
}
.ov-summary-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-3);
  flex-wrap: wrap;
  margin-bottom: var(--sp-4);
}
.ov-summary-tools {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.ov-platform {
  width: 128px;
  height: 30px;
  font-size: var(--text-12);
}

/* KPI：一条横向指标带，用 1px 分隔而不是 6 个各自带彩色左边框的小块 */
.ov-kpis {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  padding: var(--sp-1) 0 var(--sp-4);
}
.ov-kpi {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
  padding: 0 var(--sp-3);
  border-left: 1px solid var(--ui-border);
}
.ov-kpi:first-child {
  padding-left: 0;
  border-left: 0;
}
.ov-kpi-label {
  overflow: hidden;
  color: var(--ui-text-muted);
  font-size: var(--text-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ov-kpi-value {
  overflow: hidden;
  color: var(--ui-text);
  font-family: var(--font-num);
  font-size: var(--text-24);
  font-weight: var(--weight-semibold);
  letter-spacing: -0.03em;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ov-kpi-value.placeholder {
  color: var(--ui-text-disabled);
  font-weight: var(--weight-regular);
}
.ov-kpi-delta {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--ui-text-muted);
  font-size: var(--text-11);
  font-weight: var(--weight-medium);
}
.ov-kpi-delta.up {
  color: var(--delta-up);
}
.ov-kpi-delta.down {
  color: var(--delta-down);
}
.ov-kpi-note {
  display: block;
  overflow: hidden;
  color: var(--ui-text-muted);
  font-size: var(--text-11);
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 趋势图 ---- */
.ov-chart-wrap {
  position: relative;
  min-height: 200px;
}
.ov-chart {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}
.chart-grid line,
.chart-grid-v {
  stroke: var(--ui-border);
  stroke-width: 1;
}
.chart-grid-v {
  stroke: #f1f3f7;
}
.chart-y-label,
.chart-x-label {
  fill: var(--ui-text-muted);
  font-size: 10.5px;
  font-family: var(--font-num);
}
.gmv-stop-top {
  stop-color: var(--brand-500);
}
.gmv-stop-bottom {
  stop-color: var(--brand-500);
}
.chart-area {
  fill: url(#gmv-fill);
}
.chart-line {
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.gmv-line {
  stroke: var(--brand);
}
.order-line {
  stroke: #14b8a6;
  stroke-dasharray: 4 3;
  stroke-width: 1.6;
}
.chart-point {
  cursor: pointer;
  transition: r var(--dur-fast) var(--ease);
}
.gmv-point {
  fill: var(--ui-surface);
  stroke: var(--brand);
  stroke-width: 2;
}
.order-point {
  fill: var(--ui-surface);
  stroke: #14b8a6;
  stroke-width: 1.8;
}
.chart-point:hover {
  r: 5;
}
.chart-guide {
  stroke: var(--ui-border-strong);
  stroke-dasharray: 3 3;
}
.chart-hover-dot.gmv {
  fill: var(--brand);
  stroke: var(--ui-surface);
  stroke-width: 2;
}
.chart-hover-dot.orders {
  fill: #14b8a6;
  stroke: var(--ui-surface);
  stroke-width: 2;
}
.trend-tooltip {
  position: absolute;
  top: 8px;
  display: flex;
  min-width: 168px;
  flex-direction: column;
  gap: 4px;
  padding: 9px 11px;
  border: 1px solid var(--ui-border);
  border-radius: var(--r-md);
  background: var(--ui-surface);
  box-shadow: var(--e2);
  transform: translateX(-50%);
  pointer-events: none;
}
.trend-tooltip strong {
  color: var(--ui-text);
  font-size: var(--text-12);
  font-weight: var(--weight-semibold);
}
.trend-tooltip span {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--ui-text-muted);
  font-size: var(--text-11);
}
.trend-tooltip b {
  margin-left: auto;
  color: var(--ui-text);
  font-variant-numeric: tabular-nums;
}
.ov-legend {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  margin-top: var(--sp-2);
  color: var(--ui-text-muted);
  font-size: var(--text-11);
}
.ov-legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.legend-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.legend-dot.gmv {
  background: var(--brand);
}
.legend-dot.orders {
  background: #14b8a6;
}
.ov-caption {
  margin-top: var(--sp-3);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--ui-border);
  color: var(--ui-text-muted);
  font-size: var(--text-11);
  line-height: var(--leading-snug);
}

/* ---- 快捷操作 ---- */
.ov-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: var(--sp-3);
}
.ov-tile {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3);
  border: 1px solid var(--ui-border);
  border-radius: var(--r-md);
  background: var(--ui-surface-subtle);
  transition:
    border-color var(--dur-base) var(--ease),
    background var(--dur-base) var(--ease);
}
.ov-tile:hover {
  border-color: var(--brand-border);
  background: var(--ui-surface);
}
.ov-tile.disabled {
  opacity: 0.6;
}
.ov-tile-icon {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  place-items: center;
  border-radius: var(--r-sm);
  background: var(--brand-soft);
  color: var(--brand);
}
.ov-tile.tone-blue .ov-tile-icon {
  background: var(--info-soft);
  color: var(--info-text);
}
.ov-tile-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}
.ov-tile-copy strong {
  color: var(--ui-text);
  font-size: var(--text-13);
  font-weight: var(--weight-semibold);
}
.ov-tile-copy small {
  color: var(--ui-text-muted);
  font-size: var(--text-11);
  line-height: var(--leading-snug);
}

/* ---- 右栏 ---- */
.ov-sync {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ov-sync-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 7px 0;
  border-bottom: 1px solid var(--ui-border);
}
.ov-sync-row:last-child {
  border-bottom: 0;
  padding-bottom: 0;
}
.ov-sync-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  line-height: 1.35;
}
.ov-sync-copy strong {
  color: var(--ui-text);
  font-size: var(--text-12);
  font-weight: var(--weight-medium);
}
.ov-sync-copy span {
  color: var(--ui-text-muted);
  font-size: var(--text-11);
}
.ov-sync-meta {
  display: grid;
  grid-template-columns: auto auto;
  align-items: center;
  gap: 2px 5px;
  justify-items: end;
}
.ov-sync-meta strong {
  color: var(--ui-text-secondary);
  font-size: var(--text-11);
  font-weight: var(--weight-medium);
}
.ov-sync-meta small {
  grid-column: 1 / -1;
  color: var(--ui-text-muted);
  font-size: 10.5px;
}
.ui-dot.online {
  background: var(--success);
}
.ui-dot.warning {
  background: var(--warning);
}
.ui-dot.offline {
  background: var(--danger);
}

/* AI 入口：品牌浅底 + 单色图标，不用渐变块（渐变是"AI 味"最重的元素） */
.ov-ai {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-4);
  border-color: var(--brand-border);
  background: var(--brand-50);
}
.ov-ai-icon {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: var(--r-sm);
  background: var(--ui-surface);
  color: var(--brand);
  box-shadow: var(--e1);
}
.ov-ai h2 {
  font-size: var(--text-14);
  font-weight: var(--weight-semibold);
}
.ov-ai p {
  color: var(--ui-text-secondary);
  font-size: var(--text-12);
  line-height: var(--leading-snug);
}
.ov-ai .ui-btn {
  margin-top: var(--sp-1);
}

/* 待开发票 */
.ov-todo {
  display: flex;
  flex-direction: column;
  gap: 1px;
  list-style: none;
}
.ov-todo-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 4px;
  border-radius: var(--r-xs);
  color: var(--ui-text-muted);
  cursor: pointer;
}
.ov-todo-row:hover {
  background: var(--ui-surface-sunken);
}
.ov-todo-title {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--ui-text);
  font-size: var(--text-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 响应式 ---- */
@media (max-width: 1380px) {
  .ov-grid {
    grid-template-columns: minmax(0, 1fr) 300px;
  }
  .ov-kpis {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--sp-3) 0;
  }
  .ov-kpi:nth-child(4) {
    padding-left: 0;
    border-left: 0;
  }
}
@media (max-width: 1120px) {
  .ov-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .ov-rail {
    flex-direction: row;
    flex-wrap: wrap;
  }
  .ov-rail > .ui-card {
    min-width: 260px;
    flex: 1 1 300px;
  }
}
</style>
