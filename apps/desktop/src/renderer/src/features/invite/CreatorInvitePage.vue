<script setup lang="ts">
/**
 * 达人邀约 v2（2026-10-19）：独立模块页。
 *
 * 页面壳：头部、KPI、页签导航、页内启动面板与详情抽屉。
 *
 * 2026-10-20 P2 拆分：批次/记录/达人库/资产/说明各自独立组件（`tabs/`），详情抽屉独立；
 * 状态与动作通过 `invite-page-context` 的 provide/inject 共享，页面壳不再承载 240 行模板。
 * 配置与发送仍是同一套真机实测流程；「新建邀约」在页内展开，不跳店铺浏览器。
 */
import { computed, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { useCreatorInvite } from '../workbench/use-creator-invite'
import InvitePanelView from './InvitePanelView.vue'
import InviteCampaignDrawer from './InviteCampaignDrawer.vue'
import InviteCampaignsTab from './tabs/InviteCampaignsTab.vue'
import InviteRecordsTab from './tabs/InviteRecordsTab.vue'
import InviteCreatorsTab from './tabs/InviteCreatorsTab.vue'
import InviteAssetsTab from './tabs/InviteAssetsTab.vue'
import InviteAboutTab from './tabs/InviteAboutTab.vue'
import { INVITE_PAGE_KEY } from './invite-page-context'
import { isCreatorInviteTask } from '@shared/invite-task'
import type { TaskView } from '@shared/schemas/task'
import './invite-page.css'
import type { CreatorView, InviteCampaignDetail, InviteCampaignView, InviteProductSetView, InviteRecordView, InviteScriptView, InviteSummary } from '@shared/invite-campaign'

const emit = defineEmits<{
  'open-store': [storeId: string]
  navigate: [page: string]
}>()

const ws = useWorkspaceStore()
const storeId = ref('')
const tab = ref<'tasks' | 'records' | 'creators' | 'assets' | 'about'>('tasks')
const statusFilter = ref('')
const campaigns = ref<InviteCampaignView[]>([])
const records = ref<InviteRecordView[]>([])
const summary = ref<InviteSummary>({ todaySent: 0, recentSent: 0, accepted: 0, rejected: 0, unknown: 0, total: 0 })
const quota = ref<{ used: number; reserved: number; limit: number | null; remaining: number | null } | null>(null)
const creators = ref<CreatorView[]>([])
const creatorQuery = ref('')
const creatorBlacklistedOnly = ref(false)
const scripts = ref<InviteScriptView[]>([])
const productSets = ref<InviteProductSetView[]>([])
const scriptDraft = reactive({ name: '', template: '', mode: 'manual' as 'manual' | 'ai' })
const productSetDraft = reactive({ name: '', productIds: '' })
const detail = ref<InviteCampaignDetail | null>(null)
const detailOpen = ref(false)
const detailLoading = ref(false)
const loading = ref(false)
const lastError = ref('')

const emptySummary: InviteSummary = { todaySent: 0, recentSent: 0, accepted: 0, rejected: 0, unknown: 0, total: 0 }

/**
 * 独立页的配置/启动：店铺取页面自己的筛选（"全部店铺"时取当前显示或第一家）。
 * 这里显式传 storeId，不再跟随"浏览器当前显示哪家店"——用户可以在任何页面上发起邀约。
 */
const launcherOpen = ref(false)
/** 向导当前步：1 目标 / 2 受众 / 3 话术 / 4 确认。 */
const launcherStep = ref(1)
const inviteStepItems = [
  { n: 1, label: '目标', hint: '店铺 · 类目 · 数量' },
  { n: 2, label: '受众', hint: '等级 · 权益 · 联系方式' },
  { n: 3, label: '话术', hint: '话术库 / AI' },
  { n: 4, label: '确认', hint: '额度 · 定时 · 启动' }
]
function goStep(step: number): void {
  launcherStep.value = Math.max(1, Math.min(4, Math.round(step) || 1))
}
/**
 * launcher 的发起店铺：**独立于页面筛选**（2026-10-21 审查 P2-25）。
 * 以前 launcher 换店直接改页面 storeId，批次/记录/达人库/资产整页跟着切走；
 * 现在只有它自己变，inviteStoreId 优先取它——既保住「按用户明确选的店发起」的防错店意图，
 * 又不把页面列表切走。
 */
const launcherStoreId = ref('')
const inviteStoreId = computed(() => launcherStoreId.value || storeId.value || ws.displayedStoreId || storeOptions.value[0]?.id || '')
const inviteStore = computed(() => storeOptions.value.find(store => store.id === inviteStoreId.value) || null)
const inviteController = useCreatorInvite({
  store: inviteStore,
  storeId: computed(() => inviteStoreId.value || null)
})

const storeOptions = computed(() => ws.stores || [])
const currentStoreName = computed(() => storeOptions.value.find(store => store.id === storeId.value)?.name || '全部店铺')
const orphanTasks = computed(() => (ws.tasks || []).filter((task: TaskView) => isCreatorInviteTask(task) && !task?.campaignId))

function storeName(id: string | null | undefined): string {
  if (!id) return '—'
  return storeOptions.value.find(store => store.id === id)?.name || id
}

/** 资产必须挂在具体店铺上：全部店铺视图下默认用第一家，界面会写明。 */
const assetStore = computed(() => storeOptions.value.find(store => store.id === (storeId.value || storeOptions.value[0]?.id)) || null)
const assetStoreId = computed(() => assetStore.value?.id || '')
const assetPlatform = computed(() => assetStore.value?.platform || '')

const visibleCreators = computed(() => {
  const query = creatorQuery.value.trim().toLowerCase()
  return creators.value.filter(creator => {
    if (creatorBlacklistedOnly.value && !creator.blacklisted) return false
    if (!query) return true
    return `${creator.nickname} ${creator.platform} ${creator.tags.join(' ')}`.toLowerCase().includes(query)
  })
})

async function loadCreators(): Promise<void> {
  const filter: { storeId?: string; platform?: string; limit: number } = { limit: 300 }
  if (storeId.value) filter.storeId = storeId.value
  const res = await window.shopilot.invite.creators.list(filter)
  creators.value = res.ok ? ((res.data || []) as CreatorView[]) : []
}

async function toggleBlacklist(creator: CreatorView): Promise<void> {
  const next = !creator.blacklisted
  const res = await window.shopilot.invite.creators.update({
    storeId: creator.storeId,
    platform: creator.platform,
    creatorKey: creator.creatorKey,
    blacklisted: next,
    blacklistReason: next ? '手动加入黑名单' : null
  })
  if (!res.ok) {
    lastError.value = res.error?.message || '更新黑名单失败'
    return
  }
  await loadCreators()
}

async function loadAssets(): Promise<void> {
  if (!assetStoreId.value || !assetPlatform.value) { scripts.value = []; productSets.value = []; return }
  const [scriptRes, setRes] = await Promise.all([
    window.shopilot.invite.scripts.list({ storeId: assetStoreId.value, platform: assetPlatform.value }),
    window.shopilot.invite.productSets.list({ storeId: assetStoreId.value, platform: assetPlatform.value })
  ])
  scripts.value = scriptRes.ok ? ((scriptRes.data || []) as InviteScriptView[]) : []
  productSets.value = setRes.ok ? ((setRes.data || []) as InviteProductSetView[]) : []
}

async function saveScript(): Promise<void> {
  if (!assetStoreId.value || !scriptDraft.name.trim() || !scriptDraft.template.trim()) return
  const res = await window.shopilot.invite.scripts.save({
    storeId: assetStoreId.value,
    platform: assetPlatform.value,
    name: scriptDraft.name.trim(),
    mode: scriptDraft.mode,
    template: scriptDraft.template.trim()
  })
  if (!res.ok) { lastError.value = res.error?.message || '保存话术失败'; return }
  scriptDraft.name = ''; scriptDraft.template = ''; scriptDraft.mode = 'manual'
  await loadAssets()
}

async function removeScript(script: InviteScriptView): Promise<void> {
  const res = await window.shopilot.invite.scripts.remove({ id: script.id, storeId: script.storeId })
  if (!res.ok) { lastError.value = res.error?.message || '删除话术失败'; return }
  await loadAssets()
}

function parseProductIds(value: string): string[] {
  return [...new Set(String(value || '').split(/[\s,，、]+/).map(item => item.trim()).filter(Boolean))].slice(0, 30)
}

async function saveProductSet(): Promise<void> {
  const ids = parseProductIds(productSetDraft.productIds)
  if (!assetStoreId.value || !productSetDraft.name.trim() || !ids.length) return
  const res = await window.shopilot.invite.productSets.save({
    storeId: assetStoreId.value,
    platform: assetPlatform.value,
    name: productSetDraft.name.trim(),
    productIds: ids
  })
  if (!res.ok) { lastError.value = res.error?.message || '保存商品集失败'; return }
  productSetDraft.name = ''; productSetDraft.productIds = ''
  await loadAssets()
}

async function removeProductSet(set: InviteProductSetView): Promise<void> {
  const res = await window.shopilot.invite.productSets.remove({ id: set.id, storeId: set.storeId })
  if (!res.ok) { lastError.value = res.error?.message || '删除商品集失败'; return }
  await loadAssets()
}

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`
}

function exportRecordsCsv(): void {
  const header = ['达人', '店铺', '批次', '状态', '状态来源', '邀约时间', '身份可信级别']
  const rows = records.value.map(record => [
    record.nickname,
    record.storeName || storeName(record.storeId),
    record.campaignName || '',
    recordStatusLabel(record.status),
    record.statusSource === 'platform' ? '平台回读' : record.statusSource === 'manual' ? '人工修正' : '本地记录',
    formatTime(record.invitedAt || record.createdAt),
    record.identityLevel === 'username' ? '用户名' : '仅昵称'
  ])
  const csv = '\uFEFF' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `达人邀约记录-${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

function formatTime(value: number | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function campaignStatusLabel(status: string): string {
  return ({
    draft: '草稿',
    ready: '待执行',
    scheduled: '已排期',
    running: '执行中',
    paused: '已暂停',
    completed: '已完成',
    exhausted: '额度/候选用尽',
    stopped: '已停止',
    failed: '失败'
  } as Record<string, string>)[status] || status || '未知'
}

function campaignStatusTone(status: string): string {
  if (status === 'completed') return 'ok'
  if (status === 'running') return 'live'
  if (status === 'paused' || status === 'ready' || status === 'scheduled') return 'wait'
  if (status === 'exhausted') return 'warn'
  if (status === 'failed') return 'bad'
  return 'muted'
}

function recordStatusLabel(status: string): string {
  return ({
    queued: '待发送',
    selected: '已选',
    opening: '打开中',
    sending: '发送中',
    sent: '已发送',
    inviting: '邀请中',
    accepted: '已接受',
    rejected: '已拒绝',
    expired: '已过期',
    skipped_already_invited: '已跳过（7 天内已邀）',
    skipped_not_invitable: '已跳过（未达门槛）',
    failed_open: '打开失败',
    failed_send: '发送失败',
    unknown: '状态未知'
  } as Record<string, string>)[status] || status || '未知'
}

function recordStatusTone(status: string): string {
  if (status === 'accepted') return 'ok'
  if (status === 'rejected' || status === 'failed_send' || status === 'failed_open') return 'bad'
  if (status === 'sent' || status === 'inviting') return 'live'
  if (status === 'unknown') return 'warn'
  return 'muted'
}

function stopReasonLabel(reason: string | null | undefined): string {
  if (!reason) return '—'
  return ({
    TASK_QUOTA_EXCEEDED: '平台额度用尽',
    TASK_SELECTION_SHORTFALL: '候选不足',
    TASK_DRAWER_NOT_OPEN: '邀约抽屉未打开',
    target_reached: '达到目标',
    user_stopped: '用户停止'
  } as Record<string, string>)[reason] || reason
}

function selectStore(id: string) {
  storeId.value = id
}

async function load(options: { silent?: boolean } = {}): Promise<void> {
  const silent = options.silent === true
  if (!silent) {
    loading.value = true
    lastError.value = ''
  }
  try {
    // 手动刷新/从别处新建店铺后，本页要能发现新店铺；否则「新建邀约」会一直按旧列表取店。
    // 轮询（silent）不重复拉店铺列表：它不会变，白拉一次只会让页面闪。
    if (!silent) await ws.refreshStores()
    if (!storeId.value && ws.stores.length) storeId.value = ws.displayedStoreId || ws.stores[0].id
    const filter = storeId.value ? { storeId: storeId.value } : {}
    const recordFilter = { ...filter, limit: 100, ...(statusFilter.value ? { status: statusFilter.value } : {}) }
    const [campaignRes, recordRes, summaryRes] = await Promise.all([
      window.shopilot.invite.campaigns({ ...filter, limit: 50 }),
      window.shopilot.invite.records(recordFilter),
      window.shopilot.invite.summary(filter)
    ])
    if (campaignRes.ok) campaigns.value = (campaignRes.data || []) as InviteCampaignView[]
    else lastError.value = campaignRes.error?.message || '读取批次失败'
    if (recordRes.ok) records.value = (recordRes.data || []) as InviteRecordView[]
    if (summaryRes.ok) summary.value = (summaryRes.data || emptySummary) as InviteSummary
    if (storeId.value) {
      const quotaRes = await window.shopilot.invite.quota({ storeId: storeId.value })
      quota.value = quotaRes.ok ? quotaRes.data : null
    } else {
      quota.value = null
    }
    if (!silent) await ws.refreshTasks()
  } catch (error) {
    // 轮询失败不覆盖页面上的真实错误：用户没主动刷新，不该被一次网络抖动打断阅读
    if (!silent) lastError.value = error instanceof Error ? (error.message || '读取邀约数据失败') : String(error || '读取邀约数据失败')
  } finally {
    if (!silent) loading.value = false
  }
}

/**
 * 运行中自动刷新（2026-10-19 完善）：批次页的「已发/跳过/失败」来自数据库计数，
 * 不会随任务事件自动变化。以前跑起来后必须手点刷新才能看到进度——
 * 现在只要还有进行中的邀约（或排队/暂停），就每 5 秒静默重读一次；结束即停。
 */
const liveInviteRunning = computed(() => (ws.tasks || []).some((task: TaskView) => {
  if (!isCreatorInviteTask(task)) return false
  const run = task.latestRun
  const status = run?.id ? (ws.runLive[run.id]?.status || run.status) : run?.status
  return ['queued', 'running', 'waiting_confirmation', 'paused'].includes(status)
}))

let invitePollTimer: ReturnType<typeof setInterval> | null = null
function stopInvitePolling(): void {
  if (!invitePollTimer) return
  clearInterval(invitePollTimer)
  invitePollTimer = null
}
function syncInvitePolling(running: boolean): void {
  if (!running) { stopInvitePolling(); return }
  if (invitePollTimer) return
  invitePollTimer = setInterval(() => {
    void load({ silent: true })
    if (detailOpen.value) void refreshDetail()
  }, 5000)
}
watch(liveInviteRunning, running => syncInvitePolling(running))
onBeforeUnmount(stopInvitePolling)

/** 详情请求串行号：快速连点多个批次时旧请求可能后到并覆盖新详情，serial 不匹配的响应直接丢弃。 */
let detailSerial = 0
async function openDetail(campaign: InviteCampaignView): Promise<void> {
  const serial = ++detailSerial
  detailOpen.value = true
  detailLoading.value = true
  detail.value = null
  try {
    const res = await window.shopilot.invite.campaignDetail(campaign.id)
    if (serial !== detailSerial) return
    if (res.ok) detail.value = res.data as InviteCampaignDetail
    else lastError.value = res.error?.message || '读取批次详情失败'
  } finally {
    // 只有最后一次请求才能关 loading：旧请求后到时不能把新请求的 loading 关掉
    if (serial === detailSerial) detailLoading.value = false
  }
}

async function refreshDetail(): Promise<void> {
  const id = detail.value?.campaign?.id
  if (!id) return
  const res = await window.shopilot.invite.campaignDetail(id)
  if (res.ok) detail.value = res.data as InviteCampaignDetail
}

async function setManualStatus(record: InviteRecordView, status: string): Promise<void> {
  if (!status) return
  const res = await window.shopilot.invite.updateRecordStatus({
    id: record.id,
    storeId: record.storeId,
    status,
    reason: '人工修正（平台状态未回读或已人工核对）'
  })
  if (!res.ok) {
    lastError.value = res.error?.message || '修正状态失败'
    return
  }
  await Promise.all([load(), refreshDetail()])
}

/** 取消排期：只对 scheduled 生效；已启动的批次请用「停止」结束运行。 */
async function cancelSchedule(campaignId: string | null | undefined): Promise<void> {
  if (!campaignId) return
  const res = await window.shopilot.invite.cancelScheduled(campaignId)
  if (!res.ok) { lastError.value = res.error?.message || '取消排期失败'; return }
  await Promise.all([load(), refreshDetail()])
}

async function stopCampaign(runId: string | null | undefined): Promise<void> {
  if (!runId) return
  const res = await window.shopilot.task.cancel(runId)
  if (!res.ok) {
    lastError.value = res.error?.message || '停止失败'
    return
  }
  await Promise.all([load(), refreshDetail()])
}

function openConfig(): void {
  const id = storeId.value || ws.displayedStoreId || ws.openStoreIds[0] || ws.stores[0]?.id || ''
  if (!id) {
    emit('navigate', 'stores')
    return
  }
  // 页面筛选为空时兜底同步（避免页面处于"全部店铺"时启动链路拿不到店）；
  // launcher 自己的发起店在下面单独初始化，不反向改页面筛选。
  if (!storeId.value) storeId.value = id
  launcherStoreId.value = id
  launcherOpen.value = true
  launcherStep.value = 1
  void inviteController.refreshSquareUrls()
  void inviteController.loadInviteCategoryTrees()
  void inviteController.loadInviteConfig()
}

/** 启动成功：收起配置面板、回到批次列表并刷新，让用户立刻看到新批次。 */
async function onInviteStarted(): Promise<void> {
  launcherOpen.value = false
  launcherStoreId.value = ''
  await load()
}

function openStore(id: string): void {
  if (id) emit('open-store', id)
}

function closeDetail(): void {
  detailOpen.value = false
  detail.value = null
}

onMounted(async () => {
  if (!ws.ready) await ws.init()
  if (!storeId.value) storeId.value = ws.displayedStoreId || ws.stores[0]?.id || ''
  // 首次加载交给下方 watch(storeId)（挂载前 storeId 恒为 ''，上面的赋值会触发它），
  // 否则 onMounted 的 load 和 watch 触发的 load 会双跑。
  // 无店铺等场景下值没变、watch 不会触发，这里补一次首载，避免页面空白。
  if (!storeId.value) await load()
  syncInvitePolling(liveInviteRunning.value)
})

watch(inviteStoreId, () => {
  if (launcherOpen.value) void inviteController.loadInviteConfig()
})
watch(storeId, () => {
  void load()
  if (tab.value === 'creators') void loadCreators()
  if (tab.value === 'assets') void loadAssets()
})
watch(statusFilter, () => {
  if (tab.value === 'records') void loadRecordsOnly()
})
watch(tab, (next) => {
  if (next === 'records') void loadRecordsOnly()
  if (next === 'creators') void loadCreators()
  if (next === 'assets') void loadAssets()
})

async function loadRecordsOnly(): Promise<void> {
  const filter: { storeId?: string; status?: string; limit: number } = { limit: 100 }
  if (storeId.value) filter.storeId = storeId.value
  if (statusFilter.value) filter.status = statusFilter.value
  const res = await window.shopilot.invite.records(filter)
  if (res.ok) records.value = (res.data || []) as InviteRecordView[]
}
/**
 * 页签组件通过注入拿到同一份页面状态与动作（不再层层传 props）。
 * 传的是**原始 ref/函数**：子组件顶层解构后，模板仍会自动解包并保持响应性。
 */
provide(INVITE_PAGE_KEY, {
  loading, campaigns, orphanTasks, openConfig, openDetail, campaignStatusTone, campaignStatusLabel,
  storeName, formatTime, stopReasonLabel, stopCampaign, cancelSchedule, openStore,
  statusFilter, records, exportRecordsCsv, recordStatusTone, recordStatusLabel,
  creatorQuery, creatorBlacklistedOnly, visibleCreators, loadCreators, toggleBlacklist,
  assetStore, assetPlatform, storeId, scriptDraft, productSetDraft, scripts, productSets,
  saveScript, removeScript, saveProductSet, removeProductSet, parseProductIds,
  detailOpen, detail, detailLoading, closeDetail, setManualStatus
})

</script>

<template>
  <section class="invite-page" data-test="creator-invite-page">
    <header class="invite-head">
      <div class="invite-head-copy">
        <button type="button" class="invite-back" data-test="invite-v2-back" @click="emit('navigate', 'apps')">← 应用中心</button>
        <span class="invite-eyebrow">WORKSPACE / CREATOR INVITE</span>
        <h1>达人邀约</h1>
        <p>按店铺查看邀约批次、逐人记录与停止原因。真实发送仍走平台实测流程，读不到的状态显示为未知，不猜测。</p>
      </div>
      <div class="invite-head-actions">
        <label class="invite-store-select">
          <span>店铺</span>
          <select :value="storeId" data-test="invite-v2-store-filter" @change="selectStore(($event.target as HTMLSelectElement).value)">
            <option value="">全部店铺</option>
            <option v-for="store in storeOptions" :key="store.id" :value="store.id">{{ store.name }}</option>
          </select>
        </label>
        <span v-if="quota" class="invite-quota-chip" data-test="invite-v2-quota">今日额度 {{ quota.used }}{{ quota.limit ? ` / ${quota.limit}` : ' / 未设上限' }}<template v-if="quota.reserved"> · 预留 {{ quota.reserved }}</template></span>
        <button type="button" class="invite-btn" data-test="invite-v2-refresh" :disabled="loading" @click="load()">{{ loading ? '读取中…' : '刷新' }}</button>
        <button type="button" class="invite-btn primary" data-test="invite-v2-open-config" @click="openConfig">+ 新建邀约</button>
      </div>
    </header>

    <div v-if="lastError" class="invite-alert" data-test="invite-v2-error">{{ lastError }}</div>

    <div class="invite-kpis" data-test="invite-v2-kpi">
      <article class="invite-kpi"><span>今日已发送</span><strong>{{ summary.todaySent }}</strong><small>本地记录，按实际发送时间</small></article>
      <article class="invite-kpi"><span>近 7 天已发送</span><strong>{{ summary.recentSent }}</strong><small>含已发送/邀请中/已接受</small></article>
      <article class="invite-kpi"><span>已接受</span><strong>{{ summary.accepted }}</strong><small>{{ summary.accepted ? '来自平台状态回读' : '平台状态尚未回读' }}</small></article>
      <article class="invite-kpi"><span>状态未知</span><strong>{{ summary.unknown }}</strong><small>无法确认的按未知显示</small></article>
    </div>

    <!--
      新建邀约：直接在独立页里配置并启动。
      以前这里会跳到店铺浏览器侧栏（用户得离开当前页、打开店铺窗口），
      现在发送在主进程隐藏窗口里跑，页面只负责配置与看结果。
    -->
    <section v-if="launcherOpen" class="invite-launcher" data-test="invite-v2-launcher">
      <header class="invite-launcher-head">
        <div class="invite-launcher-copy">
          <strong>新建邀约</strong>
          <label class="invite-launcher-store">
            <span>店铺</span>
            <select
              :value="inviteStoreId"
              data-test="invite-v2-launcher-store"
              :disabled="!storeOptions.length"
              @change="launcherStoreId = ($event.target as HTMLSelectElement).value"
            >
              <option v-if="!storeOptions.length" value="">暂无店铺</option>
              <option v-for="store in storeOptions" :key="store.id" :value="store.id">{{ store.name }} · {{ store.platform }}</option>
            </select>
          </label>
          <span class="invite-launcher-hint">后台运行，不占用你的浏览器</span>
        </div>
        <button type="button" class="invite-btn" data-test="invite-v2-launcher-close" @click="launcherOpen = false">收起</button>
      </header>
      <!--
        四步向导（2026-10-20）：目标 → 受众 → 话术 → 确认。
        只是把同一份配置视图按步分组显示（v-show），不复制第二套表单：
        切步不会丢已填内容，也不会让验收锚点消失。
      -->
      <nav class="invite-steps" data-test="invite-v2-steps">
        <button
          v-for="item in inviteStepItems" :key="item.n" type="button"
          class="invite-step" :class="{ on: launcherStep === item.n, done: launcherStep > item.n }"
          :data-test="`invite-v2-step-${item.n}`" @click="goStep(item.n)"
        >
          <b>{{ item.n }}</b>
          <span>{{ item.label }}<small>{{ item.hint }}</small></span>
        </button>
        <button type="button" class="invite-btn invite-step-next" data-test="invite-v2-step-next" :disabled="launcherStep >= 4" @click="goStep(launcherStep + 1)">下一步 →</button>
      </nav>
      <InvitePanelView v-if="inviteStore" :step="launcherStep" :controller="inviteController" @started="onInviteStarted" />
      <div v-else class="invite-empty"><h2>还没有可用店铺</h2><p>先到「店铺管理」添加一家店铺，再回来发起邀约。</p><button type="button" class="invite-btn" @click="emit('navigate', 'stores')">去店铺管理</button></div>
    </section>

    <template v-else>

    <div class="invite-tabs" role="tablist">
      <button type="button" :class="{ on: tab === 'tasks' }" data-test="invite-v2-tab-tasks" @click="tab = 'tasks'">邀约任务</button>
      <button type="button" :class="{ on: tab === 'records' }" data-test="invite-v2-tab-records" @click="tab = 'records'">邀约记录</button>
      <button type="button" :class="{ on: tab === 'creators' }" data-test="invite-v2-tab-creators" @click="tab = 'creators'">达人库</button>
      <button type="button" :class="{ on: tab === 'assets' }" data-test="invite-v2-tab-assets" @click="tab = 'assets'">资产</button>
      <button type="button" :class="{ on: tab === 'about' }" data-test="invite-v2-tab-about" @click="tab = 'about'">说明</button>
      <span class="invite-tab-meta">{{ currentStoreName }} · {{ campaigns.length }} 个批次 · {{ summary.total }} 条记录</span>
    </div>

    <InviteCampaignsTab v-if="tab === 'tasks'" />

    <InviteRecordsTab v-else-if="tab === 'records'" />

    <InviteCreatorsTab v-else-if="tab === 'creators'" />

    <InviteAssetsTab v-else-if="tab === 'assets'" />

    <InviteAboutTab v-else />

    </template>

    <InviteCampaignDrawer />
  </section>
</template>
