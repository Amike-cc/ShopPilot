<template>
  <section class="unified-page unified-data-page" :data-test="`unified-${mode}-page`">
    <header class="unified-page-head">
      <div><span class="dashboard-eyebrow">WORKSPACE / DATA</span><h1>{{ title }}</h1><p>{{ subtitle }}</p></div>
      <div class="unified-page-actions"><button type="button" class="unified-button ghost" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新数据' }}</button><button v-if="mode === 'invoices'" type="button" class="unified-button primary" @click="exportInvoices">导出待开票 CSV</button></div>
    </header>
    <div class="unified-route-tabs" role="tablist" aria-label="数据页面"><button v-for="tab in tabs" :key="tab.key" type="button" :class="{ active: mode === tab.key }" @click="emit('change-mode', tab.key)">{{ tab.label }}</button></div>
    <div v-if="errorMessage" class="unified-alert error" role="alert">{{ errorMessage }} <button type="button" @click="load">重试</button></div>
    <div v-if="loading" class="unified-state"><span class="loader"></span>正在读取本机数据…</div>
    <template v-else>
      <div v-if="mode !== 'orders' && mode !== 'invoices'" class="unified-stat-grid">
        <article v-for="card in totalCards" :key="card.label" class="unified-stat-card"><span>{{ card.label }}</span><strong>{{ card.value }}</strong><small>{{ card.note }}</small></article>
      </div>

      <div v-if="mode === 'analytics'" class="unified-data-grid">
        <section class="unified-card data-wide"><div class="unified-card-head"><div><h2>经营指标</h2><span>每店每指标取本机最新快照</span></div><button type="button" class="unified-button ghost" :disabled="collecting" @click="collectBusiness">{{ collecting ? '创建任务中…' : '采集经营数据' }}</button></div><div v-if="metricRows.length" class="unified-table-wrap"><table class="unified-table"><thead><tr><th>店铺</th><th>平台</th><th v-for="metric in bizMetrics" :key="metric.key">{{ metric.label }}</th><th>采集时间</th></tr></thead><tbody><tr v-for="row in metricRows" :key="row.storeId"><td>{{ row.storeName }}</td><td>{{ row.platform }}</td><td v-for="metric in bizMetrics" :key="metric.key">{{ formatValue(row.values[metric.key], metric.key) }}<em v-if="row.manual[metric.key]">手动</em></td><td>{{ row.lastAt ? formatTime(row.lastAt) : '—' }}</td></tr></tbody></table></div><div v-else class="unified-empty compact">暂无经营快照。请在店铺浏览器中采集或运行读取任务。</div></section>
        <section class="unified-card"><div class="unified-card-head"><div><h2>指标快照</h2><span>{{ snapshotRows.length }} 条本机记录</span></div></div><div v-if="snapshotRows.length" class="snapshot-list"><div v-for="snapshot in snapshotRows.slice(0, 12)" :key="snapshot.storeId + snapshot.metric + snapshot.capturedAt" class="snapshot-row"><div><strong>{{ snapshot.metric }}</strong><small>{{ snapshot.storeName || snapshot.storeId }}</small></div><span>{{ displayValue(snapshot.value) }}</span></div></div><div v-else class="unified-empty compact">暂无快照</div></section>
      </div>

      <SalesMetricsMonitorCard v-if="mode === 'analytics'" @open-store="emit('open-store', $event)" />

      <section v-else-if="mode === 'orders'" class="unified-card"><div class="unified-card-head"><div><h2>订单明细</h2><span>来自最近一次订单整表快照，不伪造实时数据</span></div><button type="button" class="unified-button primary" :disabled="collecting" @click="collectOrders">{{ collecting ? '创建任务中…' : '采集订单明细' }}</button></div><div v-if="orderStores.length" class="order-store-list"><article v-for="store in orderStores" :key="store.storeId" class="order-store-block"><div class="order-store-head"><div><strong>{{ store.storeName }}</strong><span>{{ store.platform }} · {{ store.supported ? '已登记页面档案' : '尚未实测' }}</span></div><span>{{ store.rows?.length || 0 }} 行</span></div><div v-if="store.error" class="unified-alert error">最近一次采集失败：{{ store.error.message || store.error.code }}</div><div v-if="store.rows?.length" class="unified-table-wrap"><table class="unified-table"><thead><tr><th v-for="column in store.columns || []" :key="column.key">{{ column.label }}</th></tr></thead><tbody><tr v-for="(row,index) in store.rows.slice(0, 30)" :key="index"><td v-for="column in store.columns || []" :key="column.key">{{ row.cells?.[column.key] || '—' }}</td></tr></tbody></table></div><div v-else class="unified-empty compact">{{ store.supported ? '暂无订单快照' : '该平台订单页面尚未实测，系统不会猜测选择器' }}</div></article></div><div v-else class="unified-empty">暂无订单数据。点击“采集订单明细”后，任务结果会回到这里。</div></section>

      <template v-else>
        <div class="dc-cards" data-test="invoice-totals">
          <div class="dc-card"><div class="dc-num">{{ invoiceTotal.count }}</div><div class="dc-label">待开票条数</div></div>
          <div class="dc-card"><div class="dc-num">{{ invoiceTotal.amountText }}</div><div class="dc-label">可开金额合计</div></div>
          <div class="dc-card"><div class="dc-num">{{ invoiceTotal.stores }}</div><div class="dc-label">有待办的店铺</div></div>
        </div>
        <!-- 自动更新：每 3 小时一次。状态如实显示"哪几家挂着周期、上次什么时候触发"，
             开关直接改任务上的 schedule；挂不上/没有任务时如实说明，不给假状态。 -->
        <div class="inv-schedule" data-test="invoice-schedule">
          <span class="inv-schedule-dot" :class="{ on: invoiceSchedule.enabled > 0 }" aria-hidden="true"></span>
          <span>
            自动更新：<b>每 3 小时一次</b>
            <template v-if="invoiceSchedule.enabled > 0">
              · 已启用 {{ invoiceSchedule.enabled }}/{{ invoiceSchedule.total }} 家<template v-if="invoiceSchedule.lastFiredAt"> · 上次触发 {{ formatTime(invoiceSchedule.lastFiredAt) }}</template>
            </template>
            <template v-else> · 尚未启用（点「采集发票数据」会自动挂上）</template>
          </span>
          <button
            type="button" class="unified-button" data-test="invoice-schedule-toggle"
            :disabled="collecting"
            @click="toggleInvoiceSchedule(invoiceSchedule.enabled === 0)"
          >{{ invoiceSchedule.enabled > 0 ? '关闭自动更新' : '开启每 3 小时自动更新' }}</button>
        </div>
        <!-- 只说清"哪些条数没计入合计"：各平台把「处理中/处理记录」这类已提交流水也放在同一页，
             它们商家这边没有待办，计入合计会让数字虚高。 -->
        <p v-if="invoiceTotal.historical" class="inv-note" data-test="invoice-pending-note">
          另有 <b>{{ invoiceTotal.historical }} 条</b>属「已提交 / 已通过」的方向（各平台的「处理中 / 处理记录」这类）——
          商家在那边没有待办，因此<b>不计入</b>上方待开票条数与金额合计；记录照常列在各店铺下方并标了「无需操作」。
          <template v-if="invoiceTotal.unparsed">另有 {{ invoiceTotal.unparsed }} 条金额无法解析为数字，<b>未计入</b>合计。</template>
        </p>

        <!-- 按营业执照筛选：发票是**按开票主体**开的，不是按平台账号开的。
             同一个执照下常挂好几家店（同公司开了抖店 + 快手 + 微信小店），只看店铺会把一个主体的票拆成几份。
             胶囊上的条数/金额用**未按主体筛选**的那一份算——否则点一个主体，别的全变 0，没法横向比。 -->
        <div class="inv-lic-bar" data-test="invoice-license-bar">
          <span class="inv-lic-title">营业执照</span>
          <button type="button" class="inv-lic-chip" :class="{ on: !activeLicense }" data-test="invoice-license-all" @click="invoiceLicense = ''">
            全部 <i>{{ licenseSummary.storeCount }} 家</i><template v-if="licenseSummary.pendingCount"> · {{ licenseSummary.pendingCount }} 条 · {{ licenseSummary.amountText }}</template>
          </button>
          <button
            v-for="l in licenseSummary.items" :key="l.key" type="button"
            class="inv-lic-chip" :class="{ on: activeLicense === l.key, none: l.key === NO_LICENSE_KEY }"
            :data-test="'invoice-license-' + l.key"
            :title="l.key === NO_LICENSE_KEY ? '这些店铺还没填营业执照——点店铺行上的主体标签手动补' : (l.no ? '统一社会信用代码：' + l.no : '只填了主体名称，没有统一社会信用代码')"
            @click="invoiceLicense = activeLicense === l.key ? '' : l.key"
          >
            {{ l.label || '未填写营业执照' }} <i>{{ l.storeCount }} 家</i><template v-if="l.pendingCount"> · {{ l.pendingCount }} 条 · {{ l.amountText }}</template>
          </button>
        </div>

        <section class="unified-card">
          <div class="unified-card-head">
            <div><h2>发票中心</h2><span>只展示平台页面采集到的待办和历史记录（本应用只读，不代提交）</span></div>
            <button type="button" class="unified-button primary" :disabled="collecting" @click="collectInvoices">{{ collecting ? '创建任务中…' : '采集发票数据' }}</button>
          </div>
          <div v-if="!invoiceRows.length" class="unified-empty">暂无发票记录。采集结果会由本机任务写入数据库。</div>
          <div v-else-if="!visibleInvoiceRows.length" class="unified-empty">没有符合当前筛选的记录。</div>
          <div v-else class="invoice-list">
            <article v-for="row in visibleInvoiceRows" :key="row.storeId" class="invoice-row" data-test="invoice-row">
              <div class="invoice-row-head inv-row-head">
                <b>{{ row.storeName }}</b>
                <span class="inv-row-sub">{{ row.platform }} · {{ row.supported === false ? '尚未实测' : '已登记页面档案' }}<template v-if="row.capturedAt"> · 采集于 {{ formatTime(row.capturedAt) }}</template></span>
                <button
                  type="button" class="inv-lic-tag" :class="{ none: !row.licenseName }"
                  :data-test="'invoice-store-license-' + row.storeId"
                  :title="row.licenseNo ? '统一社会信用代码：' + row.licenseNo + '（点击修改）' : '点这里填营业执照（发票按主体分账）'"
                  @click="openLicenseEditor(row)"
                >
                  {{ row.licenseName || '未填营业执照' }}<em v-if="row.licenseNo"> · {{ row.licenseNo }}</em>
                </button>
                <span class="inv-count">
                  {{ row.count || 0 }} 条待办<template v-if="row.historyCount"> · 无需操作 {{ row.historyCount }} 条</template>
                </span>
              </div>

              <div v-if="licenseEditingId === row.storeId" class="inv-lic-edit" :data-test="'invoice-license-edit-' + row.storeId">
                <input v-model="licenseDraft.name" list="store-license-names" data-test="invoice-license-name" placeholder="营业执照主体名称（如：上海某某贸易有限公司）" />
                <input v-model="licenseDraft.no" data-test="invoice-license-no" placeholder="统一社会信用代码（选填，18 位；旧税号 15 位）" />
                <button type="button" class="unified-button" data-test="invoice-license-save" :disabled="licenseSaving" @click="saveLicense(row)">{{ licenseSaving ? '保存中…' : '保存' }}</button>
                <button type="button" class="unified-button" data-test="invoice-license-cancel" @click="licenseEditingId = ''">取消</button>
                <span v-if="licenseEditError" class="inv-lic-err" data-test="invoice-license-error">{{ licenseEditError }}</span>
              </div>

              <div v-if="row.sections?.length" class="invoice-sections">
                <div v-for="section in row.sections" :key="section.metricKey || section.name" class="invoice-section" data-test="invoice-section">
                  <span>{{ section.name }}<em v-if="section.pending === false" :title="section.notPendingNote || '商家无需再操作，不计入上方待开票合计'"> 无需操作</em></span>
                  <b>{{ section.items?.length || 0 }} 条</b>
                  <small v-if="section.items?.length">{{ section.items.slice(0, 3).map((item: any) => item.cells?.amount || item.cells?.status || '—').join(' · ') }}</small>
                </div>
              </div>
              <div v-else class="unified-empty compact">{{ row.note || '暂无发票数据' }}</div>
            </article>
          </div>
        </section>
      </template>

      <section v-if="mode === 'analytics'" class="unified-card manual-card"><div class="unified-card-head"><div><h2>手动录入指标</h2><span>仅用于平台反抓取导致无法自动读取的数字，来源会标注为手动</span></div></div><div class="manual-form"><select v-model="manual.storeId" aria-label="店铺"><option value="">选择店铺</option><option v-for="store in ws.stores" :key="store.id" :value="store.id">{{ store.name }}</option></select><select v-model="manual.metric" aria-label="指标"><option v-for="metric in bizMetrics" :key="metric.key" :value="metric.key">{{ metric.label }}</option></select><input v-model.number="manual.value" type="number" min="0" placeholder="数值" /><button type="button" class="unified-button ghost" :disabled="!manualReady" @click="saveManual">录入</button></div></section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import { BIZ_METRICS, businessProfileFor } from '@shared/constants/business'
import { buildBusinessCollectSteps } from '@shared/business-steps'
import { ordersProfileFor } from '@shared/constants/orders'
import { buildOrdersCollectSteps } from '@shared/orders-steps'
import { invoiceProfileFor } from '@shared/constants/invoice'
import { buildInvoiceCollectSteps } from '@shared/invoice-steps'
import { NO_LICENSE_KEY, groupStoresByLicense } from '@shared/store-license'
import { invoiceAmountText, parseInvoiceAmount } from '@shared/invoice-amount'
import SalesMetricsMonitorCard from './SalesMetricsMonitorCard.vue'

type DataMode = 'analytics' | 'orders' | 'invoices'
const props = defineProps<{ mode: DataMode }>()
const emit = defineEmits<{ 'change-mode': [mode: DataMode]; 'open-store': [storeId: string] }>()
const ws = useWorkspaceStore()
const loading = ref(false)
const collecting = ref(false)
const errorMessage = ref('')
const dataCenter = ref<any | null>(null)
const orderData = ref<any | null>(null)
const invoiceData = ref<any | null>(null)
const manual = reactive({ storeId: '', metric: 'biz.orders', value: null as number | null })
const tabs: Array<{ key: DataMode; label: string }> = [{ key: 'analytics', label: '经营分析' }, { key: 'orders', label: '订单明细' }, { key: 'invoices', label: '发票中心' }]
const title = computed(() => props.mode === 'orders' ? '订单管理' : props.mode === 'invoices' ? '发票中心' : '数据分析')
const subtitle = computed(() => props.mode === 'orders' ? '按店铺查看已采集的订单整表快照。' : props.mode === 'invoices' ? '发票数据只来自真实平台页面采集。' : '销售额、订单和经营指标均来自本机快照。')
const bizMetrics = BIZ_METRICS
const totalCards = computed(() => { const t = dataCenter.value?.totals || {}; return [{ label: '店铺', value: t.stores ?? '—', note: `${t.online ?? 0} 家在线` }, { label: '平台', value: t.platforms ?? '—', note: '已配置的平台' }, { label: '指标快照', value: t.snapshots ?? '—', note: '本机采集记录' }, { label: '任务', value: t.tasks ?? '—', note: '任务定义总数' }] })
const snapshotRows = computed<any[]>(() => dataCenter.value?.snapshots || [])
const orderStores = computed<any[]>(() => orderData.value?.stores || [])
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
  historyCount: (row.sections || []).reduce((n: number, sec: any) => n + (sec.pending === false ? (sec.items?.length || 0) : 0), 0)
})))

/** 选中的开票主体（不存在的 key 自动退回"全部"，避免卡在一个空列表里退不出来） */
const invoiceLicense = ref('')
const licenseEditingId = ref('')
const licenseDraft = reactive({ name: '', no: '' })
const licenseSaving = ref(false)
const licenseEditError = ref('')

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
    if ((row.sections || []).some((sec: any) => sec.pending !== false && (sec.items?.length || 0) > 0)) hit.stores++
    for (const sec of row.sections || []) {
      if (sec.pending === false) continue
      for (const item of sec.items || []) {
        hit.pendingCount++
        const amount = parseInvoiceAmount(item.cells?.amount)
        if (amount == null) hit.unparsed++
        else hit.amount += amount
      }
    }
  }
  const withText = items.map(item => ({ ...item, amountText: invoiceAmountText(item.amount, item.amount > 0) }))
  return {
    items: withText,
    storeCount: ws.stores.length,
    pendingCount: withText.reduce((sum, item) => sum + item.pendingCount, 0),
    amountText: invoiceAmountText(withText.reduce((sum, item) => sum + item.amount, 0), withText.some(item => item.amount > 0))
  }
})

const activeLicense = computed(() => (
  invoiceLicense.value && licenseSummary.value.items.some(item => item.key === invoiceLicense.value)
    ? invoiceLicense.value
    : ''
))

/** 页面上列出的店铺 = 全部再按营业执照筛一道（用统一归属表，见 shared/store-license.ts） */
const visibleInvoiceRows = computed<any[]>(() => (
  activeLicense.value
    ? invoiceAllRows.value.filter(row => licenseGroups.value.keyByStore.get(row.storeId) === activeLicense.value)
    : invoiceAllRows.value
))

/** 顶部合计：跟着当前筛选走（"合计"是这一屏的数字；胶囊上的横向比较才是不跟筛选走的那一份） */
const invoiceTotal = computed(() => {
  let count = 0
  let amount = 0
  let unparsed = 0
  let historical = 0
  let stores = 0
  for (const row of visibleInvoiceRows.value) {
    let storePending = 0
    for (const sec of row.sections || []) {
      if (sec.pending === false) { historical += sec.items?.length || 0; continue }
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
  return { count, amountText: invoiceAmountText(amount, amount > 0), stores, historical, unparsed }
})

function openLicenseEditor(row: any) {
  licenseEditingId.value = row.storeId
  licenseDraft.name = row.licenseName || ''
  licenseDraft.no = row.licenseNo || ''
  licenseEditError.value = ''
}

async function saveLicense(row: any) {
  licenseSaving.value = true
  licenseEditError.value = ''
  const result = await ws.setStoreLicense(row.storeId, licenseDraft.name.trim(), licenseDraft.no.trim())
  licenseSaving.value = false
  if (!result.ok) { licenseEditError.value = result.message || '保存失败'; return }
  licenseEditingId.value = ''
  ws.toast('营业执照已保存', 'success')
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
async function load() { loading.value = true; errorMessage.value = ''; try { const responses = await Promise.all([window.shopilot.overview.datacenter(), window.shopilot.overview.orders(), window.shopilot.overview.invoiceCenter()]); if (!responses[0].ok) throw new Error(responses[0].error.message); dataCenter.value = responses[0].data; orderData.value = responses[1].ok ? responses[1].data : { stores: [] }; invoiceData.value = responses[2].ok ? responses[2].data : { rows: [] } } catch (error) { errorMessage.value = error instanceof Error ? error.message : String(error) } finally { loading.value = false } }
/** 发票自动采集周期：3 小时（用户要求「发票中心三个小时更新一次」） */
const INVOICE_SCHEDULE_MS = 3 * 60 * 60 * 1000
const INVOICE_TASK_PREFIX = '发票采集 ·'

/** 采集任务名（发票的带前缀，便于复用时按前缀认领同一个任务） */
function collectTaskName(kind: 'business' | 'orders' | 'invoice', storeName: string) {
  return kind === 'business' ? `经营指标采集 · ${storeName}` : kind === 'orders' ? `订单明细采集 · ${storeName}` : `${INVOICE_TASK_PREFIX}${storeName}`
}

/**
 * 复用已有任务，而不是每点一次就新建一个。
 *
 * 原实现每次点「采集」都 task.create 一个新任务——实测点两轮就留下
 * 「发票采集 · 抖店」「发票采集 · 抖店 · 2026/9/15」一串同名任务：任务中心越堆越多，
 * 而定时更新只能挂在其中一个上（挂错就等于没挂）。这里按"店铺 + 名称前缀"认领一个，
 * 把步骤与周期一起更新到它身上。
 */
async function ensureCollectTask(kind: 'business' | 'orders' | 'invoice', store: any, steps: any[], schedule: unknown): Promise<string> {
  const name = collectTaskName(kind, store.name)
  const listed = await window.shopilot.task.list()
  const existing = (listed.ok ? (listed.data as any[]) : [])
    .filter(task => task.storeScope === store.id && String(task.name || '').startsWith(collectTaskName(kind, '')))
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0]
  if (existing) {
    // 步骤不可改（该任务正有未结束的运行）时不新建重复任务，仍用它跑一次
    await window.shopilot.task.update({ taskId: existing.id, name, steps, schedule })
    return String(existing.id)
  }
  const created = await window.shopilot.task.create({ name, storeScope: store.id, steps, schedule })
  return created.ok ? String((created.data as any).id) : ''
}

async function createCollectionTasks(kind: 'business' | 'orders' | 'invoice') {
  const supported = ws.stores.filter(store => kind === 'business' ? !!businessProfileFor(store.platform) : kind === 'orders' ? !!ordersProfileFor(store.platform) : !!invoiceProfileFor(store.platform))
  if (!supported.length) { ws.toast('当前没有已实测的可采集平台，系统不会猜测页面选择器', 'info'); return }
  collecting.value = true
  let created = 0
  try {
    for (const store of supported) {
      const profile = kind === 'business' ? businessProfileFor(store.platform) : kind === 'orders' ? ordersProfileFor(store.platform) : invoiceProfileFor(store.platform)
      if (!profile) continue
      if (!ws.openStoreIds.includes(store.id)) await window.shopilot.browser.open(store.id)
      const steps = kind === 'business' ? buildBusinessCollectSteps(profile) : kind === 'orders' ? buildOrdersCollectSteps(profile) : buildInvoiceCollectSteps(profile)
      // 只有发票采集挂周期（每 3 小时）：经营指标已有自己的 10 分钟调度器，给任务再挂一次会变成两套调度各跑一遍
      const schedule = kind === 'invoice' ? { everyMs: INVOICE_SCHEDULE_MS, backgroundOpen: true } : undefined
      const taskId = await ensureCollectTask(kind, store, steps as any[], schedule)
      if (!taskId) continue
      const run = await window.shopilot.task.run(taskId)
      if (run.ok) created++
    }
    await ws.refreshTasks()
    const suffix = kind === 'invoice' ? '；发票每 3 小时自动更新一次' : ''
    ws.toast(created ? `已启动 ${created} 个采集任务${suffix}` : '采集任务未能启动，请查看任务中心', created ? 'success' : 'error')
  } finally { collecting.value = false }
}
function collectBusiness() { return createCollectionTasks('business') }
function collectOrders() { return createCollectionTasks('orders') }
function collectInvoices() { return createCollectionTasks('invoice') }

/** 发票自动更新现状（逐店一条：哪几家挂着周期、上次什么时候触发） */
const invoiceSchedule = computed(() => {
  const supported = ws.stores.filter(store => !!invoiceProfileFor(store.platform))
  const tasks = supported.map(store => ws.tasks.find(task => task.storeScope === store.id && String(task.name || '').startsWith(INVOICE_TASK_PREFIX)))
  const scheduled = tasks.filter(task => Number((task?.schedule as any)?.everyMs || 0) === INVOICE_SCHEDULE_MS)
  const fired = scheduled.map(task => Number((task as any)?.lastFiredAt || 0)).filter(value => value > 0)
  return { total: supported.length, enabled: scheduled.length, lastFiredAt: fired.length ? Math.max(...fired) : 0 }
})

/** 一键开关自动更新：给每家的发票任务挂上/摘掉 3 小时周期 */
async function toggleInvoiceSchedule(enabled: boolean) {
  collecting.value = true
  try {
    let changed = 0
    for (const store of ws.stores.filter(item => !!invoiceProfileFor(item.platform))) {
      const task = ws.tasks.find(item => item.storeScope === store.id && String(item.name || '').startsWith(INVOICE_TASK_PREFIX))
      if (!task) continue
      const result = await window.shopilot.task.update({ taskId: task.id, schedule: enabled ? { everyMs: INVOICE_SCHEDULE_MS, backgroundOpen: true } : null })
      if (result.ok) changed++
    }
    await ws.refreshTasks()
    ws.toast(changed
      ? (enabled ? `已开启每 3 小时自动更新（${changed} 家）` : `已关闭自动更新（${changed} 家）`)
      : '还没有发票采集任务——先点一次「采集发票数据」', changed ? 'success' : 'info')
  } finally { collecting.value = false }
}
async function saveManual() { if (!manualReady.value) return; const result = await window.shopilot.overview.manualMetric(manual.storeId, manual.metric, Number(manual.value)); if (!result.ok) { ws.toast('录入失败：' + result.error.message, 'error'); return } ws.toast('已录入手动指标', 'success'); manual.value = null; await load() }
async function exportInvoices() { const result = await window.shopilot.overview.invoiceExport(); if (!result.ok) ws.toast('导出失败：' + result.error.message, 'error'); else if (!result.data?.canceled) ws.toast(`已导出 ${result.data.rows} 条记录`, 'success') }
function onTaskProgress(event: any) { if (event?.phase === 'finished' || event?.phase === 'failed') void load() }
watch(() => props.mode, () => { void load() })
onMounted(() => { window.shopilot.on(EVENT_CHANNELS.TASK_PROGRESS, onTaskProgress); void load(); void ws.refreshTasks() })
onBeforeUnmount(() => { window.shopilot.off(EVENT_CHANNELS.TASK_PROGRESS, onTaskProgress) })
</script>

<style scoped>
.unified-page{min-width:0;min-height:0;height:100%;overflow:auto;padding:22px 24px 32px;color:var(--dash-text)}.unified-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:16px}.unified-page-head h1{margin:5px 0 7px;font-size:25px}.unified-page-head p{margin:0;color:var(--dash-text-muted);font-size:12px}.unified-page-actions{display:flex;gap:8px}.unified-button{min-height:32px;padding:0 13px;border:1px solid var(--dash-border);border-radius:9px;background:#ffffff;color:var(--dash-text-soft);cursor:pointer}.unified-button:hover,.unified-button:focus-visible{border-color:rgba(151,120,255,.7);color:#fff;outline:none}.unified-button.primary{border-color:rgba(130,92,255,.75);background:linear-gradient(135deg,#f3f0fc,#8c5cff);color:#fff}.unified-button:disabled{opacity:.55;cursor:not-allowed}.unified-route-tabs{display:flex;gap:5px;margin-bottom:15px;padding:4px;border:1px solid var(--dash-border);border-radius:10px;background:#ecedee}.unified-route-tabs button{height:30px;padding:0 14px;border:0;border-radius:7px;background:transparent;color:var(--dash-text-muted);cursor:pointer}.unified-route-tabs button.active{background:rgba(113,78,231,.36);color:#fff}.unified-stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:14px}.unified-stat-card{display:flex;flex-direction:column;gap:6px;padding:14px;border:1px solid var(--dash-border);border-radius:12px;background:#ffffff}.unified-stat-card span,.unified-stat-card small{color:var(--dash-text-muted);font-size:11px}.unified-stat-card strong{font-size:25px}.unified-data-grid{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(260px,1fr);gap:12px}.unified-card{min-width:0;padding:16px;border:1px solid var(--dash-border);border-radius:13px;background:#ffffff}.unified-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}.unified-card-head h2{margin:0 0 5px;font-size:16px}.unified-card-head span{color:var(--dash-text-muted);font-size:11px}.unified-table-wrap{overflow:auto}.unified-table{width:100%;border-collapse:collapse;font-size:11px}.unified-table th,.unified-table td{padding:10px 9px;border-bottom:1px solid rgba(111,137,177,.12);text-align:left;white-space:nowrap}.unified-table th{color:var(--dash-text-muted);font-weight:500}.unified-table td{color:var(--dash-text-soft)}.unified-table em{display:inline-block;margin-left:4px;padding:2px 4px;border-radius:4px;background:rgba(242,165,87,.15);color:#b54708;font-size:9px;font-style:normal}.unified-empty,.unified-state{display:flex;min-height:180px;align-items:center;justify-content:center;gap:10px;flex-direction:column;color:var(--dash-text-muted);border:1px dashed var(--dash-border);border-radius:11px}.unified-empty.compact{min-height:90px}.unified-alert{padding:10px 12px;margin-bottom:12px;border-radius:9px;font-size:12px}.unified-alert.error{border:1px solid rgba(239,99,119,.35);background:rgba(117,37,58,.2);color:#b42318}.unified-alert button{margin-left:8px;border:0;background:transparent;color:#fff;text-decoration:underline;cursor:pointer}.snapshot-list{display:flex;flex-direction:column;gap:8px}.snapshot-row{display:flex;justify-content:space-between;gap:10px;padding:10px;border-radius:8px;background:#f7f9fd}.snapshot-row strong,.snapshot-row small{display:block}.snapshot-row small{margin-top:4px;color:var(--dash-text-muted);font-size:10px}.snapshot-row>span{color:#5b3df5;font-size:12px}.dc-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:12px}.dc-card{padding:13px 14px;border:1px solid var(--dash-border);border-radius:12px;background:#ffffff}.dc-num{color:var(--dash-text);font-size:24px;font-weight:700;letter-spacing:-.02em}.dc-label{margin-top:4px;color:var(--dash-text-muted);font-size:11px}.inv-note{margin:0 0 12px;padding:9px 11px;border:1px solid var(--dash-border);border-radius:10px;background:#f7f9fd;color:var(--dash-text-soft);font-size:11.5px;line-height:1.6}.inv-lic-bar{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-bottom:12px}.inv-lic-title{color:var(--dash-text-muted);font-size:11.5px}.inv-lic-chip{display:inline-flex;align-items:center;gap:5px;min-height:30px;padding:0 11px;border:1px solid var(--dash-border);border-radius:999px;background:#ffffff;color:var(--dash-text-soft);cursor:pointer;font-size:11.5px}.inv-lic-chip i{color:var(--dash-text-muted);font-style:normal}.inv-lic-chip.on{border-color:rgba(124,92,255,.6);background:rgba(124,92,255,.12);color:#5b3df5}.inv-lic-chip.on i{color:#5b3df5}.inv-lic-chip.none{border-style:dashed}.inv-row-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.inv-row-head b{color:var(--dash-text);font-size:13px}.inv-row-sub{color:var(--dash-text-muted);font-size:10.5px}.inv-count{margin-left:auto;color:var(--dash-text-soft);font-size:11.5px}.inv-lic-tag{display:inline-flex;align-items:center;gap:4px;min-height:24px;padding:0 9px;border:1px solid rgba(124,92,255,.35);border-radius:999px;background:rgba(124,92,255,.1);color:#5b3df5;cursor:pointer;font-size:10.5px}.inv-lic-tag em{color:var(--dash-text-muted);font-style:normal}.inv-lic-tag.none{border-style:dashed;border-color:var(--dash-border);background:transparent;color:var(--dash-text-muted)}.inv-lic-edit{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-top:9px;padding:9px;border:1px dashed var(--dash-border);border-radius:10px}.inv-lic-edit input{height:32px;min-width:200px;flex:1 1 220px;padding:0 9px;border:1px solid var(--dash-border);border-radius:8px;background:#f7f9fd;color:var(--dash-text-soft)}.inv-lic-err{color:#b42318;font-size:11px}.inv-schedule{display:flex;flex-wrap:wrap;align-items:center;gap:9px;margin:0 0 12px;padding:9px 11px;border:1px solid var(--dash-border);border-radius:10px;background:#f7f9fd;color:var(--dash-text-soft);font-size:11.5px}.inv-schedule b{color:var(--dash-text)}.inv-schedule-dot{width:7px;height:7px;border-radius:50%;background:#98a2b3}.inv-schedule-dot.on{background:#12b76a}.inv-schedule .unified-button{margin-left:auto}.invoice-section em{margin-left:4px;padding:1px 5px;border-radius:6px;background:#fff4e5;color:#b54708;font-size:9.5px;font-style:normal}.order-store-list,.invoice-list{display:flex;flex-direction:column;gap:12px}.order-store-block,.invoice-row{padding:13px;border:1px solid var(--dash-border);border-radius:10px;background:rgba(8,16,31,.45)}.order-store-head,.invoice-row-head{display:flex;justify-content:space-between;gap:10px;margin-bottom:10px}.order-store-head strong,.invoice-row-head strong{display:block}.order-store-head span,.invoice-row-head span{display:block;margin-top:4px;color:var(--dash-text-muted);font-size:10px}.invoice-sections{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.invoice-section{display:flex;flex-direction:column;gap:5px;padding:10px;border-radius:8px;background:#ededef}.invoice-section span,.invoice-section small{color:var(--dash-text-muted);font-size:10px}.manual-card{margin-top:12px}.manual-form{display:flex;flex-wrap:wrap;gap:8px}.manual-form select,.manual-form input{height:34px;min-width:160px;padding:0 9px;border:1px solid var(--dash-border);border-radius:8px;background:#f7f9fd;color:var(--dash-text-soft)}.loader{width:18px;height:18px;border:2px solid rgba(163,143,255,.2);border-top-color:#7c5cff;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:980px){.unified-stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.unified-data-grid{grid-template-columns:1fr}}
</style>
