<template>
  <div class="overview-page">
    <div v-if="dataState === 'error'" class="dashboard-error" role="alert">
      <img class="state-icon" :src="errorIcon" alt="" />
      <span>{{ dataError || '首页数据暂时无法读取' }}</span>
      <button type="button" @click="loadDashboardData"><img class="inline-action-icon" :src="dashboardRetryIcon" alt="" />重试</button>
    </div>

    <div class="ov-grid">
      <div class="ov-col-main">
        <section id="sales-trend" class="ov-card ov-card-dark">
          <div class="ov-card-head">
            <div class="ov-card-title">
              <div class="ov-title-row">
                <h2>销售概览</h2>
                <button type="button" class="ov-refresh" data-test="overview-refresh" :disabled="collectState.running || dataState === 'loading'" @click="refreshData">
                  <img class="refresh-icon" :src="refreshIcon" alt="" />{{ refreshLabel }}
                </button>
              </div>
              <span>核心经营指标</span>
            </div>
            <div class="ov-card-tools">
              <div class="period-tabs" role="tablist" aria-label="统计范围">
                <button v-for="periodOption in periodOptions" :key="periodOption.key" type="button" :class="{ active: period === periodOption.key }" @click="period = periodOption.key">{{ periodOption.label }}</button>
              </div>
              <select v-model="selectedPlatform" class="platform-select" aria-label="平台筛选">
                <option value="all">全部平台</option>
                <option v-for="platform in platformOptions" :key="platform" :value="platform">{{ platform }}</option>
              </select>
            </div>
          </div>

          <div class="ov-kpis">
            <div v-for="kpi in kpiRow" :key="kpi.key" :class="['ov-kpi', `tone-${kpi.tone}`]" :title="kpi.hint">
              <span class="kpi-label">{{ kpi.label }}</span>
              <strong class="kpi-value" :class="{ placeholder: kpi.value === '—' }">{{ kpi.value }}</strong>
              <span v-if="kpi.delta !== null" :class="['kpi-delta', deltaClass(kpi)]"><img class="delta-icon" :src="kpi.delta >= 0 ? trendUpIcon : trendDownIcon" alt="" /> {{ Math.abs(kpi.delta).toFixed(1) }}%</span>
              <span v-else class="kpi-delta muted">{{ kpi.note }}</span>
            </div>
          </div>

          <div class="trend-chart-wrap">
            <div v-if="snapshotState === 'loading' || collectedState === 'loading'" class="section-state chart-state"><span class="loader"></span> 正在读取趋势数据…</div>
            <div v-else-if="snapshotState === 'error' && collectedState === 'error'" class="section-state chart-state error-state">趋势数据读取失败 <button type="button" @click="loadSnapshots(); loadCollectedMetrics()"><img class="inline-action-icon" :src="dashboardRetryIcon" alt="" />重试</button></div>
            <div v-else-if="!trendPlot.length" class="section-state chart-state"><img class="dashboard-state-art analytics-state-art" :src="emptyAnalyticsArt" alt="暂无趋势数据" /><strong>暂无可用趋势数据</strong><span>{{ trendEmptyHint }}</span></div>
            <template v-else>
              <svg class="trend-chart" viewBox="0 0 900 260" role="img" aria-label="销售额和订单数趋势图" @mouseleave="hoveredPoint = null">
                <defs>
                  <linearGradient id="gmv-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#8b6cff" stop-opacity=".38" /><stop offset="1" stop-color="#8b6cff" stop-opacity="0" /></linearGradient>
                </defs>
                <g class="chart-grid">
                  <template v-for="tick in chartYAxis" :key="tick.value">
                    <line x1="62" :y1="tick.y" x2="874" :y2="tick.y" />
                    <text class="chart-y-label" x="48" :y="tick.y + 4" text-anchor="end">{{ tick.label }}</text>
                  </template>
                  <line v-for="point in trendPlot" :key="`v-${point.key}`" class="chart-grid-v" :x1="point.x" y1="18" :x2="point.x" y2="216" />
                </g>
                <path v-if="gmvAreaPath" :d="gmvAreaPath" class="chart-area gmv-area" />
                <path v-if="orderPath" :d="orderPath" class="chart-line order-line" />
                <path v-if="gmvPath" :d="gmvPath" class="chart-line gmv-line" />
                <g v-for="point in trendPlot" :key="point.key">
                  <text class="chart-x-label" :x="point.x" y="244" text-anchor="middle">{{ point.label }}</text>
                  <circle v-if="point.gmvY !== null" class="chart-point gmv-point" :cx="point.x" :cy="point.gmvY" r="3.5" @mouseenter="hoveredPoint = point" />
                  <circle v-if="point.ordersY !== null" class="chart-point order-point" :cx="point.x" :cy="point.ordersY" r="3" @mouseenter="hoveredPoint = point" />
                </g>
                <line v-if="hoveredPoint" class="chart-guide" :x1="hoveredPoint.x" y1="14" :x2="hoveredPoint.x" y2="216" />
                <circle v-if="hoveredPoint && hoveredPoint.gmvY !== null" class="chart-hover-dot gmv" :cx="hoveredPoint.x" :cy="hoveredPoint.gmvY" r="4.5" />
                <circle v-if="hoveredPoint && hoveredPoint.ordersY !== null" class="chart-hover-dot orders" :cx="hoveredPoint.x" :cy="hoveredPoint.ordersY" r="4.5" />
              </svg>
              <div v-if="hoveredPoint" class="trend-tooltip" :style="tooltipStyle">
                <strong>{{ hoveredPoint.fullLabel }}</strong>
                <span v-if="hoveredPoint.gmv !== null"><i class="tooltip-dot gmv"></i>销售额 <b>{{ formatNumber(hoveredPoint.gmv) }}</b></span>
                <span v-if="hoveredPoint.orders !== null"><i class="tooltip-dot orders"></i>订单数 <b>{{ formatNumber(hoveredPoint.orders) }}</b></span>
              </div>
              <div class="chart-legend">
                <span><i class="legend-dot gmv"></i>销售额</span>
                <span><i class="legend-dot orders"></i>订单数</span>
              </div>
            </template>
          </div>
          <p class="ov-card-caption">{{ trendCaption }}</p>
        </section>

        <section id="quick-start" class="ov-card">
          <div class="ov-card-head"><div class="ov-card-title"><h2>快捷操作</h2><span>常用能力一键直达</span></div></div>
          <div class="shortcut-grid">
            <article v-for="tile in quickActions" :key="tile.key" :class="['shortcut-tile', `tone-${tile.tone}`, { disabled: !tile.available }]" :data-test="'quick-action-' + tile.key">
              <span class="tile-icon" aria-hidden="true"><img :src="tile.icon" alt="" /></span>
              <div class="tile-copy"><strong>{{ tile.label }}</strong><small>{{ tile.description }}</small></div>
              <button type="button" class="tile-action" :data-test="'quick-action-btn-' + tile.key" :disabled="!tile.available" @click="handleQuickAction(tile)"><template v-if="tile.available">{{ tile.actionLabel }} <img class="inline-action-icon" :src="forwardIcon" alt="" /></template><template v-else>待接入</template></button>
            </article>
          </div>
        </section>
      </div>

      <aside class="ov-col-rail">
        <section id="platform-sync" class="ov-card ov-sync">
          <div class="ov-card-head">
            <div class="ov-card-title"><h2>平台同步状态</h2></div>
            <span class="ov-pill success">{{ platformOnlineSummary }}</span>
          </div>
          <div v-if="!platformSyncRows.length" class="ov-empty"><img class="dashboard-state-art compact-state-art" :src="emptyStoreArt" alt="暂无店铺连接" /><span>暂无店铺连接</span></div>
          <div v-for="row in platformSyncRows" :key="row.name" class="sync-row">
            <PlatformIcon :name="row.name" :size="34" />
            <div class="sync-copy"><strong>{{ row.name }}</strong><span>{{ row.count }} 家店铺</span></div>
            <div class="sync-meta"><span :class="['sync-dot', row.state]"></span><strong>{{ row.stateLabel }}</strong><small>{{ row.lastSync }}</small></div>
          </div>
          <button type="button" class="ov-link" @click="emit('navigate', 'stores')">管理店铺 <img class="inline-action-icon" :src="forwardIcon" alt="" /></button>
        </section>

        <section id="ai-assistant" class="ov-card ov-ai">
          <div class="ov-ai-glow" aria-hidden="true"></div>
          <div class="ov-ai-copy">
            <h2><img class="ai-heading-icon" :src="recommendIcon" alt="" /> AI 电商助手</h2>
            <p>创作、优化、分析，一站完成</p>
            <button type="button" class="ov-ai-button" @click="emit('open-assistant')">开始对话 <img class="inline-action-icon" :src="forwardIcon" alt="" /></button>
          </div>
        </section>

        <section id="invoice-todo" class="ov-card ov-todo">
          <div class="ov-card-head">
            <div class="ov-card-title"><h2>待开发票</h2></div>
            <span class="ov-pill info">{{ pendingInvoices.length }} 家店铺</span>
            <button type="button" class="ov-link inline" @click="emit('open-invoices')">发票中心 <img class="inline-action-icon" :src="forwardIcon" alt="" /></button>
          </div>
          <div v-if="invoiceTodoState === 'loading'" class="ov-empty"><span class="loader"></span> 正在读取发票待办…</div>
          <div v-else-if="!pendingInvoices.length" class="ov-empty"><img class="dashboard-state-art compact-state-art" :src="emptyStoreArt" alt="暂无待开发票" /><span>暂无待开发票店铺</span></div>
          <ul v-else class="todo-list">
            <li v-for="item in pendingInvoices" :key="item.id" class="todo-item clickable" role="button" tabindex="0" @click="emit('open-invoices')" @keydown.enter="emit('open-invoices')">
              <span class="todo-check" aria-hidden="true"></span>
              <span class="todo-title" :title="item.name">{{ item.name }}</span>
              <span :class="['todo-chip', item.tone]">{{ item.badge }}</span>
            </li>
          </ul>
        </section>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import PlatformIcon from '../../../components/PlatformIcon.vue'
import { useDashboardOverview, type LoadState } from '../use-dashboard-overview'
import aiIcon from '../../../assets/icons/nav-ai.svg'
import productsIcon from '../../../assets/icons/nav-products.svg'
import refreshIcon from '../../../assets/generated/ui-icons/refresh.png'
import errorIcon from '../../../assets/generated/ui-icons/error.png'
import recommendIcon from '../../../assets/generated/ui-icons/recommend.png'
import trendUpIcon from '../../../assets/generated/ui-icons/trend-up-gen.png'
import trendDownIcon from '../../../assets/generated/ui-icons/trend-down-gen.png'
import dashboardRetryIcon from '../../../assets/generated/ui-icons/dashboard-retry-gen.png'
import forwardIcon from '../../../assets/generated/ui-icons/forward-gen.png'
import emptyStoreArt from '../../../assets/ui/dashboard/empty-store.png'
import emptyAnalyticsArt from '../../../assets/ui/dashboard/empty-analytics.png'

/**
 * 「经营总览」页：从 DashboardView.vue 原样外移的独立区块（模板/样式逐行搬运，DOM 不变）。
 *
 * 数据层在 ../use-dashboard-overview.ts；props 只承接仍留在页面容器里的「待开发票」卡片数据，
 * 导航与提示通过事件交回容器（navigateTo / showNotice 仍在 DashboardView 里）。
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

const quickActions = [
  { key: 'image', label: 'AI 生成商品图', description: '一键生成专业商品图', icon: aiIcon, tone: 'purple', available: true, actionLabel: '立即创作' },
  { key: 'publish', label: '批量发布商品', description: '高效上架多平台商品', icon: productsIcon, tone: 'blue', available: true, actionLabel: '去发布' }
]
function handleQuickAction(action: (typeof quickActions)[number]) {
  if (action.key === 'image') { emit('navigate', 'image-studio'); return }
  // 批量发布已落地（商品管理内的预检/批量编排/人工确认），快捷入口不能再显示「待接入」。
  if (action.key === 'publish') { emit('navigate', 'products'); return }
  if (action.available) emit('notice', `${action.label}：${action.description}`)
}
</script>

<style scoped>
/* ---------------- 经营总览 ---------------- */
.overview-page { min-height: 0; flex: 1 1 auto; overflow-y: auto; padding: 20px 22px 26px; scrollbar-width: thin; scrollbar-color: #d8dfea transparent; }
.dashboard-eyebrow { color: var(--dash-text-muted); font-size: 10.5px; font-weight: 600; letter-spacing: .16em; }
.ov-title-row { display: flex; align-items: center; gap: 12px; }
/* 刷新按钮挂在「销售概览」标题后面，直接挨着它要刷新的那张卡，不再占页面头部一行。 */
.ov-refresh { display: inline-flex; align-items: center; gap: 7px; height: 32px; padding: 0 14px; border: 0; border-radius: 10px; background: var(--brand-gradient); color: #fff; cursor: pointer; font-size: 12px; font-weight: 600; box-shadow: 0 8px 18px rgba(124, 92, 255, .34); }
.ov-refresh:hover:not(:disabled), .ov-refresh:focus-visible { filter: brightness(1.05); outline: none; }
.ov-refresh:disabled { cursor: wait; opacity: .72; }
.dashboard-error { display: flex; align-items: center; gap: 9px; margin-bottom: 14px; padding: 10px 13px; border: 1px solid rgba(240, 68, 56, .28); border-radius: 12px; background: #fef3f2; color: #b42318; font-size: 12px; }
.dashboard-error .state-icon { display: inline-flex; width: 22px; height: 22px; object-fit: contain; }
.refresh-icon { width: 17px; height: 17px; object-fit: contain; }

.dashboard-error button, .error-state button { margin-left: auto; border: 0; background: transparent; color: #b42318; text-decoration: underline; cursor: pointer; }

.ov-grid { display: grid; grid-template-columns: minmax(0, 1fr) 336px; gap: 16px; align-items: start; }
.ov-col-main, .ov-col-rail { display: flex; min-width: 0; flex-direction: column; gap: 16px; }
.ov-card { position: relative; padding: 18px; border: 1px solid var(--dash-border); border-radius: 18px; background: var(--dash-card); box-shadow: var(--dash-shadow); }
.ov-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.ov-card-title { display: flex; flex-direction: column; gap: 3px; }
.ov-card-title h2 { font-size: 15.5px; }
.ov-card-title span { color: var(--dash-text-muted); font-size: 11.5px; }
.ov-card-tools { display: flex; align-items: center; gap: 10px; }
.ov-card-caption { margin: 12px 0 0; color: var(--dash-text-muted); font-size: 11.5px; line-height: 1.5; }
.period-tabs { display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 11px; background: #f2f4f8; }
.period-tabs button { height: 30px; padding: 0 13px; border: 0; border-radius: 9px; background: transparent; color: var(--dash-text-soft); cursor: pointer; font-size: 12px; }
.period-tabs button:hover, .period-tabs button:focus-visible { color: var(--dash-text); outline: none; }
.period-tabs button.active { background: var(--brand-gradient); color: #fff; box-shadow: 0 6px 14px rgba(124, 92, 255, .3); }
.platform-select { height: 36px; padding: 0 12px; border: 1px solid var(--dash-border); border-radius: 11px; outline: none; background: #fff; color: var(--dash-text-soft); font-size: 12px; cursor: pointer; }
.platform-select:focus { border-color: rgba(124, 92, 255, .6); box-shadow: 0 0 0 3px rgba(124, 92, 255, .1); }

.ov-kpis { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; padding-bottom: 6px; }
.ov-kpi { display: flex; min-width: 0; flex-direction: column; gap: 6px; padding: 2px 8px 2px 12px; border-left: 3px solid var(--dash-border-strong); border-radius: 3px; }
.ov-kpi.tone-purple { border-left-color: var(--dash-purple); }
.ov-kpi.tone-blue { border-left-color: var(--dash-blue); }
.ov-kpi.tone-red { border-left-color: var(--dash-red); }
.ov-kpi.tone-amber { border-left-color: #fda29b; }
.ov-kpi.tone-yellow { border-left-color: var(--dash-orange); }
.ov-kpi.tone-green { border-left-color: var(--dash-green); }
.kpi-label { color: var(--dash-text-muted); font-size: 12px; }
.kpi-value { overflow: hidden; color: var(--dash-text); font-size: 25px; font-weight: 750; letter-spacing: -.03em; text-overflow: ellipsis; white-space: nowrap; }
.kpi-value.placeholder { color: var(--dash-text-muted); font-weight: 500; }
.delta-icon { width:13px;height:13px;vertical-align:-2px;object-fit:contain; }.kpi-delta { font-size: 11.5px; font-weight: 600; }
.kpi-delta.up { color: var(--dash-green); }
.kpi-delta.down { color: var(--dash-red-text); }
.kpi-delta.muted { color: var(--dash-text-muted); font-weight: 400; }

.trend-chart-wrap { position: relative; margin-top: 8px; }
.trend-chart { display: block; width: 100%; height: 268px; overflow: visible; }
.chart-grid line { stroke: #eef1f7; stroke-width: 1; }
.chart-y-label, .chart-x-label { fill: var(--dash-text-muted); font-size: 11px; }
.chart-line { fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
.gmv-line { stroke: var(--dash-purple); }
.order-line { stroke: var(--dash-blue); }
.chart-area { opacity: .9; }
.gmv-area { fill: url(#gmv-fill); }
.chart-point { stroke: #fff; stroke-width: 2; cursor: crosshair; }
.gmv-point { fill: var(--dash-purple); }
.order-point { fill: var(--dash-blue); }
.chart-guide { stroke: #cbd5e1; stroke-width: 1; stroke-dasharray: 4 4; }
.chart-hover-dot { stroke: #fff; stroke-width: 2; }
.chart-hover-dot.gmv { fill: var(--dash-purple); }
.chart-hover-dot.orders { fill: var(--dash-blue); }
.chart-legend { display: flex; align-items: center; justify-content: center; gap: 22px; padding: 12px 4px 0; color: var(--dash-text-soft); font-size: 12px; }
.chart-legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend-dot, .tooltip-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
.legend-dot.gmv, .tooltip-dot.gmv { background: var(--dash-purple); }
.legend-dot.orders, .tooltip-dot.orders { background: var(--dash-blue); }
.trend-tooltip { position: absolute; top: 12px; transform: translateX(-50%); min-width: 186px; padding: 12px 14px; border: 1px solid rgba(255, 255, 255, .16); border-radius: 12px; background: #1b2740; box-shadow: 0 18px 40px rgba(6, 11, 22, .5); pointer-events: none; z-index: 3; }
.trend-tooltip strong { display: block; padding-bottom: 8px; border-bottom: 1px solid rgba(255, 255, 255, .1); color: #fff; font-size: 11.5px; }
.trend-tooltip span { display: flex; align-items: center; gap: 8px; padding-top: 6px; color: rgba(232, 237, 247, .78); font-size: 11.5px; }
.trend-tooltip b { margin-left: auto; color: #fff; font-size: 12px; }

/* 销售概览是设计稿里的深色 hero 卡：在浅色页面上单独反色。这里就地覆盖 --dash-* 变量，
   卡片内部的标题、KPI、图表、图例、悬浮卡都跟着翻成浅色字，不需要逐个选择器改色。 */
.ov-card-dark {
  --dash-card: #131d33;
  --dash-text: #ffffff;
  --dash-text-soft: rgba(232, 237, 247, .78);
  --dash-text-muted: rgba(232, 237, 247, .56);
  --dash-border: rgba(255, 255, 255, .1);
  --dash-border-strong: rgba(255, 255, 255, .18);
  --dash-green: #34d399;
  --dash-red: #ff8a80;
  /* 标题颜色是外层（.dashboard-shell / body）算好的「近黑」继承下来的，卡内改 --dash-text
     影响不到已经解析过的继承值，所以这里直接给标题和卡片本体重新指定一次。 */
  --color-text-primary: #ffffff;
  --color-text-secondary: rgba(232, 237, 247, .78);
  --color-text-muted: rgba(232, 237, 247, .56);
  color: var(--dash-text);
  border-color: rgba(255, 255, 255, .07);
  background: linear-gradient(158deg, #16203a 0%, #111a2e 55%, #0e1626 100%);
  box-shadow: 0 22px 48px rgba(11, 17, 32, .26);
}
/* 卡片本体的 color 用了 var(--dash-text)，但标题是从外层继承下来的「近黑」，得单独覆盖一次。 */
.ov-card-dark h1, .ov-card-dark h2, .ov-card-dark h3 { color: var(--dash-text); }
.ov-card-dark .period-tabs { background: rgba(255, 255, 255, .07); }
.ov-card-dark .period-tabs button { color: rgba(232, 237, 247, .72); }
.ov-card-dark .period-tabs button:hover, .ov-card-dark .period-tabs button:focus-visible { color: #fff; }
.ov-card-dark .period-tabs button.active { color: #fff; }
.ov-card-dark .platform-select { border-color: rgba(255, 255, 255, .12); background: rgba(255, 255, 255, .07); color: #e8edf7; }
.ov-card-dark .platform-select option { color: #0f1729; }
.ov-card-dark .chart-grid line { stroke: rgba(255, 255, 255, .07); }
.ov-card-dark .chart-grid-v { stroke: rgba(255, 255, 255, .05); stroke-width: 1; }
.ov-card-dark .chart-point, .ov-card-dark .chart-hover-dot { stroke: #111a2e; }
.ov-card-dark .chart-guide { stroke: rgba(255, 255, 255, .3); }
.ov-card-dark .gmv-line { stroke: #9b7cff; }
.ov-card-dark .order-line { stroke: #4d9bff; }
.ov-card-dark .gmv-point { fill: #9b7cff; }
.ov-card-dark .order-point { fill: #4d9bff; }
.ov-card-dark .chart-hover-dot.gmv { fill: #9b7cff; }
.ov-card-dark .chart-hover-dot.orders { fill: #4d9bff; }
.ov-card-dark .empty-chart-icon { border-color: rgba(255, 255, 255, .16); color: rgba(232, 237, 247, .5); }
.ov-card-dark .section-state { color: rgba(232, 237, 247, .58); }
.ov-card-dark .section-state strong { color: rgba(232, 237, 247, .82); }
.section-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--dash-text-muted); text-align: center; }
.section-state strong { color: var(--dash-text-soft); font-size: 12.5px; font-weight: 600; }
.chart-state { height: 268px; }
.empty-chart-icon { display: inline-flex; width: 36px; height: 36px; align-items: center; justify-content: center; border: 1px solid var(--dash-border); border-radius: 11px; color: var(--dash-text-muted); font-size: 20px; }
.dashboard-state-art { display: block; width: 86px; height: 64px; object-fit: cover; border-radius: 12px; opacity: .88; }
.analytics-state-art { width: 112px; height: 78px; }
.compact-state-art { width: 62px; height: 48px; }
.loader { width: 16px; height: 16px; border: 2px solid #e3e8f1; border-top-color: var(--dash-purple); border-radius: 50%; animation: dashboard-spin .8s linear infinite; }
@keyframes dashboard-spin { to { transform: rotate(360deg); } }

.shortcut-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
/* 设计稿排版：图标在左、标题/副标题在右，按钮在文字下方（不是图标下方） */
.shortcut-tile { display: grid; grid-template-columns: 44px minmax(0, 1fr); grid-template-rows: auto auto; gap: 10px 12px; align-items: start; min-width: 0; padding: 14px; border: 1px solid transparent; border-radius: 16px; background: #f7f9fd; }
.shortcut-tile.tone-purple { background: #f6f3ff; border-color: #ece5ff; }
.shortcut-tile.tone-blue { background: #f2f7ff; border-color: #e3eeff; }
.shortcut-tile.tone-teal { background: #eefaf7; border-color: #dcf3ee; }
.shortcut-tile.tone-rose { background: #fff3f4; border-color: #ffe4e8; }
.shortcut-tile.disabled { opacity: .96; }
.tile-icon img { width: 23px; height: 23px; object-fit: contain; }.tile-icon { grid-row: 1; grid-column: 1; display: inline-flex; width: 44px; height: 44px; align-items: center; justify-content: center; border-radius: 13px; background: var(--brand-gradient); color: #fff; font-size: 19px; }
.shortcut-tile.tone-blue .tile-icon { background: linear-gradient(135deg, #3f9bff, #1f6fea); }
.shortcut-tile.tone-teal .tile-icon { background: linear-gradient(135deg, #21c8a8, #0e9f8c); }
.shortcut-tile.tone-rose .tile-icon { background: linear-gradient(135deg, #ff8a8a, #ef4a5f); }
.tile-copy { grid-row: 1; grid-column: 2; display: flex; min-width: 0; flex-direction: column; gap: 5px; }
.tile-copy strong { overflow: hidden; color: var(--dash-text); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.tile-copy small { overflow: hidden; color: var(--dash-text-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }

.tile-action { grid-row: 2; grid-column: 2; align-self: start; justify-self: start; min-height: 34px; padding: 0 15px; border: 0; border-radius: 10px; background: var(--brand-gradient); color: #fff; cursor: pointer; font-size: 12px; font-weight: 600; }
.tile-action:hover:not(:disabled), .tile-action:focus-visible { filter: brightness(1.05); outline: none; }
.tile-action:disabled { background: #eef1f7; color: var(--dash-text-muted); cursor: not-allowed; font-weight: 500; }

/* ---------------- 右栏：平台同步 / AI 助手 / 待办 ---------------- */
.ov-pill { display: inline-flex; align-items: center; height: 24px; padding: 0 10px; border-radius: 999px; font-size: 11.5px; font-weight: 600; white-space: nowrap; }
.ov-pill.success { background: #ecfdf3; color: #027a48; }
.ov-pill.info { background: #eef2f7; color: #475467; }
.ov-empty { padding: 16px 2px; color: var(--dash-text-muted); font-size: 12px; text-align: center; }
.ov-link img { width:14px;height:14px;object-fit:contain; }.ov-link { display: inline-flex; align-items: center; justify-content: center; gap: 6px; margin-top: 10px; padding-top: 12px; width: 100%; border: 0; border-top: 1px solid #f2f4f8; background: transparent; color: var(--dash-purple-text); cursor: pointer; font-size: 12.5px; font-weight: 600; }
.ov-link.inline { width: auto; margin: 0; padding: 0; border: 0; font-size: 12px; }
.ov-link:hover, .ov-link:focus-visible { color: #5b3df5; outline: none; }
.sync-row { display: flex; align-items: center; gap: 11px; padding: 11px 0; border-bottom: 1px solid #f4f6fa; }
.sync-row:last-of-type { border-bottom: 0; }
.sync-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; }
.sync-copy strong { color: var(--dash-text); font-size: 13px; }
.sync-copy span { color: var(--dash-text-muted); font-size: 11.5px; }
.sync-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.sync-meta strong { display: inline-flex; align-items: center; gap: 5px; color: var(--dash-green); font-size: 12px; }
.sync-meta:has(.sync-dot.offline) strong { color: var(--dash-red-text); }
.sync-meta:has(.sync-dot.login) strong { color: var(--dash-orange); }
.sync-meta small { color: var(--dash-text-muted); font-size: 11px; white-space: nowrap; }
.sync-dot { display: none; }
.ov-ai { overflow: hidden; border: 0; background: linear-gradient(125deg, #2b2170 0%, #3a2a92 42%, #1b1748 100%); color: #fff; }
.ov-ai-glow { position: absolute; top: -46px; right: -30px; width: 190px; height: 190px; border-radius: 50%; background: radial-gradient(circle, rgba(164, 120, 255, .85), rgba(124, 92, 255, .18) 55%, transparent 72%); filter: blur(2px); }
.ov-ai-copy { position: relative; display: flex; flex-direction: column; gap: 8px; }
.ov-ai-copy h2 { display: flex; align-items: center; gap: 8px; color: #fff; font-size: 16px; }
.ov-ai-copy p { color: rgba(255, 255, 255, .76); font-size: 12px; }
.ov-ai-button .inline-action-icon { width:14px;height:14px;object-fit:contain; }.ov-ai-button { display: inline-flex; align-self: flex-start; align-items: center; gap: 8px; margin-top: 4px; height: 36px; padding: 0 16px; border: 0; border-radius: 11px; background: #fff; color: #3a2a92; cursor: pointer; font-size: 12.5px; font-weight: 700; }
.ov-ai-button:hover, .ov-ai-button:focus-visible { background: #f3efff; outline: none; }
.todo-list { display: flex; flex-direction: column; gap: 4px; margin: 2px 0 0; padding: 0; list-style: none; }
.todo-item { display: flex; align-items: center; gap: 10px; padding: 9px 2px; }
.todo-item.clickable { cursor: pointer; border-radius: 7px; }
.todo-item.clickable:hover, .todo-item.clickable:focus-visible { background: var(--dash-card-hover); outline: none; }
.todo-check { width: 18px; height: 18px; flex: 0 0 18px; border: 1.5px solid #cfd8e6; border-radius: 50%; }
.todo-title { min-width: 0; flex: 1; overflow: hidden; color: var(--dash-text); font-size: 12.5px; text-overflow: ellipsis; white-space: nowrap; }
.todo-chip { flex: 0 0 auto; padding: 3px 9px; border-radius: 8px; font-size: 11px; font-weight: 600; }
.todo-chip.urgent { background: #fff4e5; color: #b54708; }
.todo-chip.info { background: #eef4ff; color: #1d4ed8; }
/* 概览卡只展示待开发票状态，点击后进入发票中心核对。 */


/* 以下三条是页面容器 .dashboard-shell 上的兜底规则（scoped 样式不跨组件，就地复制，值不变）：
   button/input/select 字体继承、按钮文字色兜底、标题字重与字距。 */
.overview-page button, .overview-page input, .overview-page select { font: inherit; }
.overview-page :where(button) { color: var(--dash-text-soft); }
.overview-page h1, .overview-page h2, .overview-page h3 { font-weight: 700; letter-spacing: -.01em; }
/* 原 .dashboard-shell 组合行里的 .ai-heading-icon（其余选择器留在页面容器）。 */
.ai-heading-icon { width: 22px; height: 22px; object-fit: contain; vertical-align: -5px; }
/* 原组合行里的 .inline-action-icon（页面容器仍在用，这里就地复制一份）。 */
.inline-action-icon { width:14px;height:14px;object-fit:contain;vertical-align:-2px; }
/* 错误态文字色（页面容器里同一规则服务于「添加店铺」弹窗的提示）。 */
.error-state { color: var(--dash-red-text); }

@media (max-width: 1380px) {
  .ov-grid { grid-template-columns: minmax(0, 1fr) 300px; }
  .kpi-value { font-size: 21px; }
  .shortcut-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 1180px) {
  .ov-grid { grid-template-columns: minmax(0, 1fr); }
  .ov-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); row-gap: 16px; }
}
@media (max-width: 900px) {
  .ov-card-head { flex-direction: column; align-items: flex-start; }
  .shortcut-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 720px) {
  .overview-page { padding: 14px 12px 24px; }
  .ov-card { padding: 14px; border-radius: 14px; }
  .ov-card-head { gap: 10px; }
  .ov-card-tools { width: 100%; min-width: 0; flex-wrap: wrap; }
  .period-tabs { max-width: 100%; overflow-x: auto; scrollbar-width: none; }
  .period-tabs::-webkit-scrollbar { display: none; }
  .period-tabs button { min-width: 58px; padding: 0 9px; }
  .platform-select { flex: 1 1 140px; min-width: 0; }
  .ov-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 13px 9px; }
  .ov-kpi { padding-left: 9px; }
  .kpi-value { font-size: 20px; }
  .dashboard-error { align-items: flex-start; flex-wrap: wrap; }
  .dashboard-error button { margin-left: auto; }
}
@media (max-width: 480px) {
  .ov-kpis { gap: 11px 7px; }
  .kpi-value { font-size: 18px; }
  .ov-title-row { align-items: flex-start; flex-direction: column; gap: 8px; }
  .ov-refresh { width: 100%; justify-content: center; }
  .shortcut-tile { padding: 12px; }
}
</style>
