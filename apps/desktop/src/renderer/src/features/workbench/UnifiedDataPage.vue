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

      <section v-else class="unified-card"><div class="unified-card-head"><div><h2>发票中心</h2><span>只展示平台页面采集到的待办和历史记录</span></div><button type="button" class="unified-button primary" :disabled="collecting" @click="collectInvoices">{{ collecting ? '创建任务中…' : '采集发票数据' }}</button></div><div v-if="invoiceRows.length" class="invoice-list"><article v-for="row in invoiceRows" :key="row.storeId" class="invoice-row"><div class="invoice-row-head"><div><strong>{{ row.storeName }}</strong><span>{{ row.platform }} · {{ row.supported ? '已登记页面档案' : '尚未实测' }}</span></div><span>{{ row.count || 0 }} 条待办</span></div><div v-if="row.sections?.length" class="invoice-sections"><div v-for="section in row.sections" :key="section.name" class="invoice-section"><span>{{ section.name }}</span><b>{{ section.items?.length || 0 }} 条</b><small v-if="section.items?.length">{{ section.items.slice(0, 3).map((item: any) => item.cells?.amount || item.cells?.status || '—').join(' · ') }}</small></div></div><div v-else class="unified-empty compact">{{ row.note || '暂无发票数据' }}</div></article></div><div v-else class="unified-empty">暂无发票记录。采集结果会由本机任务写入数据库。</div></section>

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
async function createCollectionTasks(kind: 'business' | 'orders' | 'invoice') {
  const supported = ws.stores.filter(store => kind === 'business' ? !!businessProfileFor(store.platform) : kind === 'orders' ? !!ordersProfileFor(store.platform) : !!invoiceProfileFor(store.platform))
  if (!supported.length) { ws.toast('当前没有已实测的可采集平台，系统不会猜测页面选择器', 'info'); return }
  collecting.value = true; let created = 0
  try { for (const store of supported) { const profile = kind === 'business' ? businessProfileFor(store.platform) : kind === 'orders' ? ordersProfileFor(store.platform) : invoiceProfileFor(store.platform); if (!profile) continue; if (!ws.openStoreIds.includes(store.id)) await window.shopilot.browser.open(store.id); const steps = kind === 'business' ? buildBusinessCollectSteps(profile) : kind === 'orders' ? buildOrdersCollectSteps(profile) : buildInvoiceCollectSteps(profile); const result = await window.shopilot.task.create({ name: `${kind === 'business' ? '经营指标' : kind === 'orders' ? '订单明细' : '发票'}采集 · ${store.name}`, storeScope: store.id, steps }); if (result.ok) { const run = await window.shopilot.task.run(result.data.id); if (run.ok) created++ } } await ws.refreshTasks(); ws.toast(created ? `已启动 ${created} 个采集任务` : '采集任务未能启动，请查看任务中心', created ? 'success' : 'error'); } finally { collecting.value = false } }
function collectBusiness() { return createCollectionTasks('business') }
function collectOrders() { return createCollectionTasks('orders') }
function collectInvoices() { return createCollectionTasks('invoice') }
async function saveManual() { if (!manualReady.value) return; const result = await window.shopilot.overview.manualMetric(manual.storeId, manual.metric, Number(manual.value)); if (!result.ok) { ws.toast('录入失败：' + result.error.message, 'error'); return } ws.toast('已录入手动指标', 'success'); manual.value = null; await load() }
async function exportInvoices() { const result = await window.shopilot.overview.invoiceExport(); if (!result.ok) ws.toast('导出失败：' + result.error.message, 'error'); else if (!result.data?.canceled) ws.toast(`已导出 ${result.data.rows} 条记录`, 'success') }
function onTaskProgress(event: any) { if (event?.phase === 'finished' || event?.phase === 'failed') void load() }
watch(() => props.mode, () => { void load() })
onMounted(() => { window.shopilot.on(EVENT_CHANNELS.TASK_PROGRESS, onTaskProgress); void load(); void ws.refreshTasks() })
onBeforeUnmount(() => { window.shopilot.off(EVENT_CHANNELS.TASK_PROGRESS, onTaskProgress) })
</script>

<style scoped>
.unified-page{min-width:0;min-height:0;height:100%;overflow:auto;padding:22px 24px 32px;color:var(--dash-text)}.unified-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:16px}.unified-page-head h1{margin:5px 0 7px;font-size:25px}.unified-page-head p{margin:0;color:var(--dash-text-muted);font-size:12px}.unified-page-actions{display:flex;gap:8px}.unified-button{min-height:32px;padding:0 13px;border:1px solid var(--dash-border);border-radius:9px;background:#ffffff;color:var(--dash-text-soft);cursor:pointer}.unified-button:hover,.unified-button:focus-visible{border-color:rgba(151,120,255,.7);color:#fff;outline:none}.unified-button.primary{border-color:rgba(130,92,255,.75);background:linear-gradient(135deg,#f3f0fc,#8c5cff);color:#fff}.unified-button:disabled{opacity:.55;cursor:not-allowed}.unified-route-tabs{display:flex;gap:5px;margin-bottom:15px;padding:4px;border:1px solid var(--dash-border);border-radius:10px;background:#ecedee}.unified-route-tabs button{height:30px;padding:0 14px;border:0;border-radius:7px;background:transparent;color:var(--dash-text-muted);cursor:pointer}.unified-route-tabs button.active{background:rgba(113,78,231,.36);color:#fff}.unified-stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:14px}.unified-stat-card{display:flex;flex-direction:column;gap:6px;padding:14px;border:1px solid var(--dash-border);border-radius:12px;background:#ffffff}.unified-stat-card span,.unified-stat-card small{color:var(--dash-text-muted);font-size:11px}.unified-stat-card strong{font-size:25px}.unified-data-grid{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(260px,1fr);gap:12px}.unified-card{min-width:0;padding:16px;border:1px solid var(--dash-border);border-radius:13px;background:#ffffff}.unified-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}.unified-card-head h2{margin:0 0 5px;font-size:16px}.unified-card-head span{color:var(--dash-text-muted);font-size:11px}.unified-table-wrap{overflow:auto}.unified-table{width:100%;border-collapse:collapse;font-size:11px}.unified-table th,.unified-table td{padding:10px 9px;border-bottom:1px solid rgba(111,137,177,.12);text-align:left;white-space:nowrap}.unified-table th{color:var(--dash-text-muted);font-weight:500}.unified-table td{color:var(--dash-text-soft)}.unified-table em{display:inline-block;margin-left:4px;padding:2px 4px;border-radius:4px;background:rgba(242,165,87,.15);color:#b54708;font-size:9px;font-style:normal}.unified-empty,.unified-state{display:flex;min-height:180px;align-items:center;justify-content:center;gap:10px;flex-direction:column;color:var(--dash-text-muted);border:1px dashed var(--dash-border);border-radius:11px}.unified-empty.compact{min-height:90px}.unified-alert{padding:10px 12px;margin-bottom:12px;border-radius:9px;font-size:12px}.unified-alert.error{border:1px solid rgba(239,99,119,.35);background:rgba(117,37,58,.2);color:#b42318}.unified-alert button{margin-left:8px;border:0;background:transparent;color:#fff;text-decoration:underline;cursor:pointer}.snapshot-list{display:flex;flex-direction:column;gap:8px}.snapshot-row{display:flex;justify-content:space-between;gap:10px;padding:10px;border-radius:8px;background:#f7f9fd}.snapshot-row strong,.snapshot-row small{display:block}.snapshot-row small{margin-top:4px;color:var(--dash-text-muted);font-size:10px}.snapshot-row>span{color:#5b3df5;font-size:12px}.order-store-list,.invoice-list{display:flex;flex-direction:column;gap:12px}.order-store-block,.invoice-row{padding:13px;border:1px solid var(--dash-border);border-radius:10px;background:rgba(8,16,31,.45)}.order-store-head,.invoice-row-head{display:flex;justify-content:space-between;gap:10px;margin-bottom:10px}.order-store-head strong,.invoice-row-head strong{display:block}.order-store-head span,.invoice-row-head span{display:block;margin-top:4px;color:var(--dash-text-muted);font-size:10px}.invoice-sections{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.invoice-section{display:flex;flex-direction:column;gap:5px;padding:10px;border-radius:8px;background:#ededef}.invoice-section span,.invoice-section small{color:var(--dash-text-muted);font-size:10px}.manual-card{margin-top:12px}.manual-form{display:flex;flex-wrap:wrap;gap:8px}.manual-form select,.manual-form input{height:34px;min-width:160px;padding:0 9px;border:1px solid var(--dash-border);border-radius:8px;background:#f7f9fd;color:var(--dash-text-soft)}.loader{width:18px;height:18px;border:2px solid rgba(163,143,255,.2);border-top-color:#7c5cff;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:980px){.unified-stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.unified-data-grid{grid-template-columns:1fr}}
</style>
