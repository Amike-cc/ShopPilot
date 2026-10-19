<script setup lang="ts">
/**
 * 达人邀约 v2（2026-10-19）：独立模块页。
 *
 * 这一版先落地 P1「可查」：
 *   · 工作台 KPI（今日已发/近 7 天/已接受/状态未知）；
 *   · 批次列表 + 批次详情（目标/已发/跳过/失败/停止原因/逐人记录）；
 *   · 逐人记录表（可按店铺/状态筛选）。
 *
 * 配置与真实发送仍沿用店铺浏览器侧栏那套**真机实测流程**（平台档案/选择器/恢复策略都在那里）；
 * 页面右上角「新建邀约」跳到同一配置面板，不在渲染层复制第二套表单。
 * 这样不会为了"看起来完整"而把已经验证过的执行链路拆坏。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import type { InviteCampaignDetail, InviteCampaignView, InviteRecordView, InviteSummary } from '@shared/invite-campaign'

interface CreatorView {
  id: string
  storeId: string
  platform: string
  creatorKey: string
  identityLevel: 'username' | 'nickname'
  nickname: string
  tags: string[]
  note: string | null
  blacklisted: boolean
  blacklistReason: string | null
  lastStatus: string | null
  lastInvitedAt: number | null
  inviteCount: number
}
interface InviteScriptView {
  id: string
  storeId: string
  platform: string
  name: string
  mode: 'manual' | 'ai'
  template: string
  maxLen: number | null
  updatedAt: number
}
interface InviteProductSetView {
  id: string
  storeId: string
  platform: string
  name: string
  productIds: string[]
  updatedAt: number
}

const emit = defineEmits<{
  'open-config': [storeId: string]
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

const storeOptions = computed(() => ws.stores || [])
const currentStoreName = computed(() => storeOptions.value.find(store => store.id === storeId.value)?.name || '全部店铺')
const orphanTasks = computed(() => (ws.tasks || []).filter((task: any) => {
  const invite = task?.kind === 'creator_invite' || String(task?.name || '').startsWith('达人邀约 · ')
  return invite && !task?.campaignId
}))

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
  if (status === 'paused' || status === 'ready') return 'wait'
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

async function load(): Promise<void> {
  loading.value = true
  lastError.value = ''
  try {
    // 手动刷新/从别处新建店铺后，本页要能发现新店铺；否则「新建邀约」会一直按旧列表取店
    await ws.refreshStores()
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
    await ws.refreshTasks()
  } catch (error: any) {
    lastError.value = String(error?.message || error || '读取邀约数据失败')
  } finally {
    loading.value = false
  }
}

async function openDetail(campaign: InviteCampaignView): Promise<void> {
  detailOpen.value = true
  detailLoading.value = true
  detail.value = null
  try {
    const res = await window.shopilot.invite.campaignDetail(campaign.id)
    if (res.ok) detail.value = res.data as InviteCampaignDetail
    else lastError.value = res.error?.message || '读取批次详情失败'
  } finally {
    detailLoading.value = false
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
  emit('open-config', id)
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
  await load()
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
        <button type="button" class="invite-btn" data-test="invite-v2-refresh" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
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

    <div class="invite-tabs" role="tablist">
      <button type="button" :class="{ on: tab === 'tasks' }" data-test="invite-v2-tab-tasks" @click="tab = 'tasks'">邀约任务</button>
      <button type="button" :class="{ on: tab === 'records' }" data-test="invite-v2-tab-records" @click="tab = 'records'">邀约记录</button>
      <button type="button" :class="{ on: tab === 'creators' }" data-test="invite-v2-tab-creators" @click="tab = 'creators'">达人库</button>
      <button type="button" :class="{ on: tab === 'assets' }" data-test="invite-v2-tab-assets" @click="tab = 'assets'">资产</button>
      <button type="button" :class="{ on: tab === 'about' }" data-test="invite-v2-tab-about" @click="tab = 'about'">说明</button>
      <span class="invite-tab-meta">{{ currentStoreName }} · {{ campaigns.length }} 个批次 · {{ summary.total }} 条记录</span>
    </div>

    <template v-if="tab === 'tasks'">
      <div v-if="loading && !campaigns.length" class="invite-state" data-test="invite-v2-loading">正在读取邀约批次…</div>
      <div v-else-if="!campaigns.length && !orphanTasks.length" class="invite-empty" data-test="invite-v2-empty">
        <h2>还没有邀约批次</h2>
        <p>从「新建邀约」进入当前店铺的配置面板，按平台实测流程发起第一批；完成后这里会出现批次与逐人记录。</p>
        <button type="button" class="invite-btn primary" @click="openConfig">去配置并开始</button>
      </div>
      <div v-else class="invite-campaigns" data-test="invite-v2-campaign-list">
        <article
          v-for="campaign in campaigns"
          :key="campaign.id"
          class="invite-campaign"
          data-test="invite-v2-campaign-row"
          @click="openDetail(campaign)"
        >
          <div class="invite-campaign-main">
            <div class="invite-campaign-title">
              <strong>{{ campaign.name }}</strong>
              <span class="invite-chip" :class="campaignStatusTone(campaign.status)">{{ campaignStatusLabel(campaign.status) }}</span>
            </div>
            <div class="invite-campaign-meta">
              <span>{{ campaign.storeName || storeName(campaign.storeId) }}</span>
              <span>{{ campaign.platform }}</span>
              <span>{{ formatTime(campaign.createdAt) }}</span>
              <span v-if="campaign.stopReason">停止原因：{{ stopReasonLabel(campaign.stopReason) }}</span>
            </div>
          </div>
          <div class="invite-campaign-counts">
            <span><b>{{ campaign.targetCount }}</b>计划</span>
            <span><b>{{ campaign.sentCount }}</b>已发</span>
            <span><b>{{ campaign.skippedCount }}</b>跳过</span>
            <span><b>{{ campaign.failedCount }}</b>失败</span>
          </div>
          <div class="invite-campaign-actions">
            <button type="button" class="invite-mini" @click.stop="openDetail(campaign)">查看</button>
            <button v-if="campaign.runId && (campaign.status === 'running' || campaign.status === 'paused')" type="button" class="invite-mini danger" @click.stop="stopCampaign(campaign.runId)">停止</button>
            <button type="button" class="invite-mini" @click.stop="openStore(campaign.storeId)">打开店铺</button>
          </div>
        </article>

        <section v-if="orphanTasks.length" class="invite-orphans">
          <h2>未关联批次的邀约任务</h2>
          <p>这些任务由旧版本或智能体创建，没有批次元数据；记录仍按任务/运行写入。</p>
          <article v-for="task in orphanTasks" :key="task.id" class="invite-orphan-row">
            <div><strong>{{ task.name }}</strong><small>{{ storeName(task.storeScope) }} · {{ formatTime(task.createdAt) }}</small></div>
            <span class="invite-chip muted">{{ campaignStatusLabel(task.latestRun?.status === 'running' ? 'running' : task.latestRun?.status === 'failed' ? 'failed' : task.latestRun?.status === 'succeeded' ? 'completed' : 'ready') }}</span>
            <button type="button" class="invite-mini" @click="openStore(task.storeScope)">打开店铺</button>
          </article>
        </section>
      </div>
    </template>

    <template v-else-if="tab === 'records'">
      <div class="invite-records-toolbar">
        <label class="invite-store-select">
          <span>状态</span>
          <select v-model="statusFilter" data-test="invite-v2-record-status">
            <option value="">全部状态</option>
            <option value="sent">已发送</option>
            <option value="accepted">已接受</option>
            <option value="rejected">已拒绝</option>
            <option value="unknown">状态未知</option>
            <option value="skipped_already_invited">已跳过（7 天内已邀）</option>
          </select>
        </label>
        <span class="invite-tab-meta">共 {{ records.length }} 条（最多显示 100 条）</span>
        <button type="button" class="invite-mini" data-test="invite-v2-export" :disabled="!records.length" @click="exportRecordsCsv">导出 CSV</button>
      </div>
      <div v-if="!records.length" class="invite-empty" data-test="invite-v2-records-empty">
        <h2>还没有逐人记录</h2>
        <p>批次发送成功后，引擎会按实际勾选/点击的达人逐人写入记录；发送失败或无法确认的会显示为未知。</p>
      </div>
      <div v-else class="invite-record-table" data-test="invite-v2-records">
        <div class="invite-record-head">
          <span>达人</span><span>店铺/批次</span><span>状态</span><span>来源</span><span>时间</span><span>动作</span>
        </div>
        <div v-for="record in records" :key="record.id" class="invite-record-row" data-test="invite-v2-record-row">
          <span class="invite-record-name">
            <strong>{{ record.nickname }}</strong>
            <small>{{ record.identityLevel === 'username' ? '用户名匹配' : '仅昵称匹配' }}</small>
          </span>
          <span>{{ record.storeName || storeName(record.storeId) }}<small>{{ record.campaignName || '无批次' }}</small></span>
          <span><em class="invite-chip" :class="recordStatusTone(record.status)">{{ recordStatusLabel(record.status) }}</em></span>
          <span>{{ record.statusSource === 'platform' ? '平台回读' : record.statusSource === 'manual' ? '人工修正' : '本地记录' }}</span>
          <span>{{ formatTime(record.invitedAt || record.createdAt) }}</span>
          <span><button type="button" class="invite-mini" @click="openStore(record.storeId)">打开店铺</button></span>
        </div>
      </div>
    </template>

    <template v-else-if="tab === 'creators'">
      <div class="invite-records-toolbar">
        <label class="invite-store-select">
          <span>搜索</span>
          <input v-model="creatorQuery" type="search" placeholder="昵称 / 平台 / 标签" data-test="invite-v2-creator-search" />
        </label>
        <label class="invite-check"><input v-model="creatorBlacklistedOnly" type="checkbox" data-test="invite-v2-creator-blacklist-only" />只看黑名单</label>
        <span class="invite-tab-meta">{{ visibleCreators.length }} 位达人</span>
        <button type="button" class="invite-mini" @click="loadCreators">刷新</button>
      </div>
      <div v-if="!visibleCreators.length" class="invite-empty" data-test="invite-v2-creators-empty">
        <h2>还没有达人记录</h2>
        <p>引擎每发出一位邀约，就会把昵称、身份、最近状态写进达人库；旧记录会在第一次打开时回填。</p>
      </div>
      <div v-else class="invite-creator-table" data-test="invite-v2-creators">
        <div class="invite-creator-head">
          <span>达人</span><span>平台</span><span>最近状态</span><span>最近邀约</span><span>次数</span><span>标签</span><span>操作</span>
        </div>
        <div v-for="creator in visibleCreators" :key="`${creator.storeId}:${creator.platform}:${creator.creatorKey}`" class="invite-creator-row" data-test="invite-v2-creator-row">
          <span class="invite-record-name">
            <strong>{{ creator.nickname }}</strong>
            <small>{{ creator.identityLevel === 'username' ? '用户名匹配' : '仅昵称匹配' }} · {{ storeName(creator.storeId) }}</small>
          </span>
          <span>{{ creator.platform }}</span>
          <span><em class="invite-chip" :class="recordStatusTone(creator.lastStatus || '')">{{ recordStatusLabel(creator.lastStatus || '') }}</em></span>
          <span>{{ formatTime(creator.lastInvitedAt) }}</span>
          <span>{{ creator.inviteCount }}</span>
          <span class="invite-creator-tags">{{ creator.tags.length ? creator.tags.join('、') : '—' }}</span>
          <span>
            <button type="button" class="invite-mini" :class="{ danger: !creator.blacklisted }" data-test="invite-v2-creator-blacklist" @click="toggleBlacklist(creator)">
              {{ creator.blacklisted ? '移出黑名单' : '加入黑名单' }}
            </button>
          </span>
        </div>
      </div>
    </template>

    <template v-else-if="tab === 'assets'">
      <div class="invite-assets-note">
        资产按店铺保存。当前：<b>{{ assetStore ? assetStore.name : '未选择店铺' }}</b><template v-if="assetPlatform"> · {{ assetPlatform }}</template>
        <span v-if="!storeId && assetStore">（全部店铺视图默认使用第一家）</span>
      </div>
      <div v-if="!assetStore" class="invite-empty">
        <h2>先选择一家店铺</h2>
        <p>话术和商品 ID 都属于具体店铺，不跨店共享。</p>
      </div>
      <div v-else class="invite-asset-grid">
        <section class="invite-asset-card">
          <h2>话术库</h2>
          <input v-model="scriptDraft.name" class="invite-asset-input" maxlength="60" placeholder="话术名称，如：美妆高佣版" data-test="invite-v2-script-name" />
          <textarea v-model="scriptDraft.template" class="invite-asset-textarea" maxlength="2000" rows="4" placeholder="话术内容；支持变量占位（由使用方自行替换）" data-test="invite-v2-script-template"></textarea>
          <div class="invite-asset-actions">
            <select v-model="scriptDraft.mode" class="invite-asset-select" data-test="invite-v2-script-mode">
              <option value="manual">手动话术</option>
              <option value="ai">AI 生成模板</option>
            </select>
            <button type="button" class="invite-mini" data-test="invite-v2-script-save" :disabled="!scriptDraft.name.trim() || !scriptDraft.template.trim()" @click="saveScript">保存话术</button>
          </div>
          <div v-if="!scripts.length" class="invite-asset-empty">还没有话术</div>
          <article v-for="script in scripts" :key="script.id" class="invite-asset-row" data-test="invite-v2-script-row">
            <div><strong>{{ script.name }}</strong><small>{{ script.mode === 'ai' ? 'AI 模板' : '手动话术' }} · {{ script.template.length }} 字</small></div>
            <button type="button" class="invite-mini" @click="removeScript(script)">删除</button>
          </article>
        </section>
        <section class="invite-asset-card">
          <h2>商品集</h2>
          <input v-model="productSetDraft.name" class="invite-asset-input" maxlength="60" placeholder="商品集名称，如：主推 3 款" data-test="invite-v2-product-set-name" />
          <textarea v-model="productSetDraft.productIds" class="invite-asset-textarea" rows="4" placeholder="一行一个商品 ID，或用逗号/空格分隔（最多 30 个）" data-test="invite-v2-product-set-ids"></textarea>
          <div class="invite-asset-actions">
            <span class="invite-tab-meta">{{ parseProductIds(productSetDraft.productIds).length }} 个 ID</span>
            <button type="button" class="invite-mini" data-test="invite-v2-product-set-save" :disabled="!productSetDraft.name.trim() || !parseProductIds(productSetDraft.productIds).length" @click="saveProductSet">保存商品集</button>
          </div>
          <div v-if="!productSets.length" class="invite-asset-empty">还没有商品集</div>
          <article v-for="set in productSets" :key="set.id" class="invite-asset-row" data-test="invite-v2-product-set-row">
            <div><strong>{{ set.name }}</strong><small>{{ set.productIds.length }} 个商品 · {{ set.productIds.slice(0, 2).join(' / ') }}{{ set.productIds.length > 2 ? ' …' : '' }}</small></div>
            <button type="button" class="invite-mini" @click="removeProductSet(set)">删除</button>
          </article>
        </section>
      </div>
    </template>

    <template v-else>
      <div class="invite-about">
        <section>
          <h2>这一版落地了什么</h2>
          <p>独立模块页、批次与逐人记录、停止原因上屏、今日/近 7 天 KPI、日额度台账、邀约事件通知、达人库/黑名单、话术库/商品集、CSV 导出。数据来自引擎真实发送结果；平台没有回读的状态显示为未知。</p>
        </section>
        <section>
          <h2>为什么配置还在店铺侧栏</h2>
          <p>平台筛选、选择器、额度预检、失败恢复全部是真机实测的资产。P1 先把「查得到」做出来，配置入口复用同一套流程，避免复制第二份表单造成漂移。向导迁移在后续阶段进行。</p>
        </section>
        <section>
          <h2>已接入平台</h2>
          <div class="invite-platforms">
            <span>抖店 · 批量勾选</span>
            <span>微信小店 · 逐个邀约</span>
            <span>快手小店 · 批量勾选</span>
          </div>
          <p>未接入平台不显示可发送入口，也不猜测页面选择器。</p>
        </section>
      </div>
    </template>

    <div v-if="detailOpen" class="invite-drawer-mask" data-test="invite-v2-campaign-detail" @click.self="closeDetail">
      <aside class="invite-drawer">
        <header class="invite-drawer-head">
          <div>
            <span class="invite-eyebrow">CAMPAIGN</span>
            <h2>{{ detail?.campaign?.name || '读取中…' }}</h2>
            <p v-if="detail">{{ detail.campaign.storeName || storeName(detail.campaign.storeId) }} · {{ detail.campaign.platform }} · {{ formatTime(detail.campaign.createdAt) }}</p>
          </div>
          <button type="button" class="invite-mini" @click="closeDetail">关闭</button>
        </header>
        <div v-if="detailLoading" class="invite-state">正在读取批次详情…</div>
        <template v-else-if="detail">
          <div class="invite-detail-kpis">
            <span><b>{{ detail.campaign.targetCount }}</b>计划</span>
            <span><b>{{ detail.campaign.sentCount }}</b>已发送</span>
            <span><b>{{ detail.campaign.skippedCount }}</b>跳过</span>
            <span><b>{{ detail.campaign.failedCount }}</b>失败</span>
            <span><b>{{ detail.campaign.unknownCount }}</b>未知</span>
          </div>
          <div class="invite-detail-line">
            <span class="invite-chip" :class="campaignStatusTone(detail.campaign.status)">{{ campaignStatusLabel(detail.campaign.status) }}</span>
            <span>停止原因：{{ stopReasonLabel(detail.campaign.stopReason) }}</span>
            <span v-if="detail.run">运行：{{ detail.run.status }}</span>
            <button v-if="detail.run && (detail.run.status === 'running' || detail.run.status === 'paused')" type="button" class="invite-mini danger" @click="stopCampaign(detail.run.id)">停止运行</button>
          </div>
          <div v-if="!detail.records.length" class="invite-empty small">这个批次还没有逐人记录。批量流会在发送成功后写入实际勾选名单。</div>
          <div v-else class="invite-record-table compact">
            <div class="invite-record-head">
              <span>达人</span><span>状态</span><span>来源</span><span>时间</span><span>修正</span>
            </div>
            <div v-for="record in detail.records" :key="record.id" class="invite-record-row">
              <span class="invite-record-name"><strong>{{ record.nickname }}</strong><small>{{ record.identityLevel === 'username' ? '用户名匹配' : '仅昵称匹配' }}</small></span>
              <span><em class="invite-chip" :class="recordStatusTone(record.status)">{{ recordStatusLabel(record.status) }}</em></span>
              <span>{{ record.statusSource === 'platform' ? '平台回读' : record.statusSource === 'manual' ? '人工修正' : '本地记录' }}</span>
              <span>{{ formatTime(record.invitedAt || record.createdAt) }}</span>
              <span>
                <select class="invite-asset-select" data-test="invite-v2-record-status-select" :value="record.status" @change="setManualStatus(record, ($event.target as HTMLSelectElement).value)">
                  <option value="sent">已发送</option>
                  <option value="inviting">邀请中</option>
                  <option value="accepted">已接受</option>
                  <option value="rejected">已拒绝</option>
                  <option value="expired">已过期</option>
                  <option value="unknown">状态未知</option>
                </select>
              </span>
            </div>
          </div>
        </template>
        <div v-else class="invite-state">批次不存在或读取失败。</div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.invite-page{min-width:0;min-height:0;height:100%;overflow:auto;padding:22px 24px 34px;color:var(--dash-text)}
.invite-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:16px}
.invite-head-copy{min-width:0}
.invite-back{padding:0;border:0;background:transparent;color:var(--dash-text-muted);font:inherit;font-size:11px;cursor:pointer}
.invite-back:hover{color:var(--dash-purple-text)}
.invite-eyebrow{display:block;margin:10px 0 4px;color:var(--dash-text-muted);font-size:9.5px;font-weight:700;letter-spacing:.11em}
.invite-head h1{margin:0 0 6px;font-size:25px;letter-spacing:-.02em}
.invite-head p{max-width:720px;margin:0;color:var(--dash-text-muted);font-size:11.5px;line-height:1.6}
.invite-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.invite-quota-chip{display:inline-flex;align-items:center;min-height:28px;padding:0 9px;border:1px solid rgba(124,92,255,.22);border-radius:8px;background:rgba(124,92,255,.07);color:#4c1d95;font-size:10px;font-weight:600;white-space:nowrap}
.invite-store-select{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 9px;border:1px solid var(--dash-border);border-radius:8px;background:var(--dash-card);color:var(--dash-text-muted);font-size:10px}
.invite-store-select select,.invite-store-select input{max-width:190px;border:0;outline:0;background:transparent;color:var(--dash-text);font:inherit;font-size:11px}
.invite-btn{min-height:32px;padding:0 12px;border:1px solid var(--dash-border);border-radius:8px;background:var(--dash-card);color:var(--dash-text-soft);font:inherit;font-size:11px;cursor:pointer}
.invite-btn:hover{border-color:rgba(124,92,255,.55);color:var(--dash-text)}
.invite-btn.primary{border-color:#5b3df5;background:#6d4aff;color:#fff}
.invite-btn:disabled{opacity:.55;cursor:not-allowed}
.invite-alert{margin-bottom:12px;padding:9px 11px;border:1px solid rgba(240,68,56,.28);border-radius:8px;background:rgba(240,68,56,.07);color:#b42318;font-size:11px}
.invite-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:14px}
.invite-kpi{display:flex;flex-direction:column;gap:5px;padding:13px 14px;border:1px solid var(--dash-border);border-radius:12px;background:var(--dash-card);box-shadow:0 1px 2px rgba(16,24,40,.03)}
.invite-kpi span{color:var(--dash-text-muted);font-size:10.5px}
.invite-kpi strong{font-size:26px;line-height:1;font-variant-numeric:tabular-nums}
.invite-kpi small{color:var(--dash-text-muted);font-size:9.5px;line-height:1.4}
.invite-tabs{display:flex;align-items:center;gap:4px;margin-bottom:12px;border-bottom:1px solid var(--dash-border)}
.invite-tabs button{position:relative;padding:9px 11px;border:0;background:transparent;color:var(--dash-text-muted);font:inherit;font-size:11.5px;font-weight:600;cursor:pointer}
.invite-tabs button.on{color:var(--dash-purple-text)}
.invite-tabs button.on::after{position:absolute;right:8px;bottom:-1px;left:8px;height:2px;border-radius:2px;background:#6d4aff;content:''}
.invite-tab-meta{margin-left:auto;color:var(--dash-text-muted);font-size:10px}
.invite-state,.invite-empty{display:flex;min-height:170px;align-items:center;justify-content:center;flex-direction:column;gap:7px;padding:22px;border:1px dashed var(--dash-border-strong);border-radius:12px;background:#fcfcfe;color:var(--dash-text-muted);text-align:center;font-size:11px}
.invite-empty h2{margin:0;color:var(--dash-text);font-size:14px}
.invite-empty p{max-width:520px;margin:0 0 4px;line-height:1.6}
.invite-empty.small{min-height:100px}
.invite-campaigns{display:flex;flex-direction:column;gap:8px}
.invite-campaign{display:flex;align-items:center;gap:16px;padding:13px 14px;border:1px solid var(--dash-border);border-radius:12px;background:var(--dash-card);cursor:pointer;transition:border-color .15s,box-shadow .15s}
.invite-campaign:hover{border-color:rgba(124,92,255,.5);box-shadow:0 8px 22px -16px rgba(16,24,40,.3)}
.invite-campaign-main{min-width:0;flex:1}
.invite-campaign-title{display:flex;align-items:center;gap:8px;min-width:0}
.invite-campaign-title strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}
.invite-campaign-meta{display:flex;gap:10px;flex-wrap:wrap;margin-top:5px;color:var(--dash-text-muted);font-size:10px}
.invite-campaign-counts{display:flex;gap:12px;flex:0 0 auto;color:var(--dash-text-muted);font-size:9.5px;text-align:center}
.invite-campaign-counts b{display:block;color:var(--dash-text);font-size:15px;font-variant-numeric:tabular-nums}
.invite-campaign-actions{display:flex;gap:5px;flex:0 0 auto}
.invite-mini{min-height:26px;padding:0 8px;border:1px solid var(--dash-border);border-radius:6px;background:var(--dash-card);color:var(--dash-text-soft);font:inherit;font-size:9.5px;cursor:pointer}
.invite-mini:hover{border-color:rgba(124,92,255,.55);color:var(--dash-text)}
.invite-mini.danger{border-color:rgba(240,68,56,.28);color:#b42318}
.invite-chip{display:inline-flex;align-items:center;min-height:19px;padding:0 7px;border-radius:999px;background:#eef1f7;color:var(--dash-text-muted);font-size:9px;font-style:normal;font-weight:700;white-space:nowrap}
.invite-chip.ok{background:rgba(18,183,106,.12);color:#027a48}
.invite-chip.live{background:rgba(76,157,255,.13);color:#175cd3}
.invite-chip.wait{background:rgba(242,165,87,.14);color:#b54708}
.invite-chip.warn{background:rgba(242,165,87,.18);color:#b54708}
.invite-chip.bad{background:rgba(240,68,56,.11);color:#b42318}
.invite-chip.muted{background:#eef1f7;color:var(--dash-text-muted)}
.invite-orphans{margin-top:12px;padding-top:12px;border-top:1px solid var(--dash-border)}
.invite-orphans h2{margin:0 0 4px;font-size:12px}
.invite-orphans p{margin:0 0 8px;color:var(--dash-text-muted);font-size:10px}
.invite-orphan-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px dashed var(--dash-border)}
.invite-orphan-row>div{min-width:0;flex:1}
.invite-orphan-row strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
.invite-orphan-row small{color:var(--dash-text-muted);font-size:9.5px}
.invite-records-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.invite-record-table{border:1px solid var(--dash-border);border-radius:12px;background:var(--dash-card);overflow:hidden}
.invite-record-head,.invite-record-row{display:grid;grid-template-columns:1.15fr 1.35fr 1.1fr .8fr .8fr .65fr;gap:10px;align-items:center;padding:9px 12px}
.invite-record-head{background:#f7f9fd;color:var(--dash-text-muted);font-size:9.5px;font-weight:700}
.invite-record-row{border-top:1px solid #f0f2f8;color:var(--dash-text-soft);font-size:10px}
.invite-record-row small{display:block;margin-top:2px;color:var(--dash-text-muted);font-size:9px}
.invite-record-name strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dash-text);font-size:11px}
.invite-record-table.compact .invite-record-head,.invite-record-table.compact .invite-record-row{grid-template-columns:1.3fr 1.1fr .9fr .8fr .9fr}
.invite-check{display:inline-flex;align-items:center;gap:5px;color:var(--dash-text-muted);font-size:10px;white-space:nowrap}
.invite-creator-table{border:1px solid var(--dash-border);border-radius:12px;background:var(--dash-card);overflow:hidden}
.invite-creator-head,.invite-creator-row{display:grid;grid-template-columns:1.5fr .8fr 1fr .8fr .5fr 1fr .9fr;gap:9px;align-items:center;padding:9px 12px}
.invite-creator-head{background:#f7f9fd;color:var(--dash-text-muted);font-size:9.5px;font-weight:700}
.invite-creator-row{border-top:1px solid #f0f2f8;color:var(--dash-text-soft);font-size:10px}
.invite-creator-tags{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dash-text-muted)}
.invite-assets-note{margin-bottom:10px;color:var(--dash-text-muted);font-size:10.5px}
.invite-assets-note b{color:var(--dash-text)}
.invite-asset-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.invite-asset-card{padding:14px;border:1px solid var(--dash-border);border-radius:12px;background:var(--dash-card)}
.invite-asset-card h2{margin:0 0 8px;font-size:12.5px}
.invite-asset-input,.invite-asset-textarea,.invite-asset-select{box-sizing:border-box;width:100%;padding:6px 8px;border:1px solid var(--dash-border);border-radius:7px;background:#fff;color:var(--dash-text);font:inherit;font-size:10.5px}
.invite-asset-textarea{margin-top:6px;resize:vertical;line-height:1.55}
.invite-asset-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:7px}
.invite-asset-select{width:auto;min-width:110px}
.invite-asset-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px dashed var(--dash-border)}
.invite-asset-row>div{min-width:0;flex:1}
.invite-asset-row strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
.invite-asset-row small{display:block;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dash-text-muted);font-size:9px}
.invite-asset-empty{padding:12px 0;color:var(--dash-text-muted);font-size:10px;text-align:center}
.invite-about{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.invite-about section{padding:15px;border:1px solid var(--dash-border);border-radius:12px;background:var(--dash-card)}
.invite-about h2{margin:0 0 7px;font-size:12.5px}
.invite-about p{margin:0;color:var(--dash-text-muted);font-size:10.5px;line-height:1.65}
.invite-platforms{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}
.invite-platforms span{padding:4px 7px;border:1px solid var(--dash-border);border-radius:7px;background:#f7f9fd;color:var(--dash-text-soft);font-size:9.5px}
.invite-drawer-mask{position:fixed;inset:0;z-index:120;display:flex;justify-content:flex-end;background:rgba(15,23,41,.3);backdrop-filter:blur(2px)}
.invite-drawer{display:flex;width:min(760px,100%);height:100%;flex-direction:column;gap:12px;overflow:auto;padding:20px;border-left:1px solid var(--dash-border-strong);background:#fff;box-shadow:-24px 0 60px rgba(16,24,40,.18)}
.invite-drawer-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.invite-drawer-head h2{margin:0 0 4px;font-size:18px}
.invite-drawer-head p{margin:0;color:var(--dash-text-muted);font-size:10.5px}
.invite-detail-kpis{display:flex;gap:12px;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--dash-border);border-radius:9px;background:#f7f9fd;color:var(--dash-text-muted);font-size:9.5px}
.invite-detail-kpis b{color:var(--dash-text);font-size:14px;font-variant-numeric:tabular-nums}
.invite-detail-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dash-text-muted);font-size:10px}
@media(max-width:1100px){.invite-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.invite-about,.invite-asset-grid{grid-template-columns:1fr}.invite-campaign{flex-wrap:wrap}.invite-campaign-counts{margin-left:auto}.invite-record-head,.invite-record-row{grid-template-columns:1.2fr 1.3fr 1fr .8fr}.invite-record-head span:nth-child(5),.invite-record-row span:nth-child(5){display:none}.invite-creator-head,.invite-creator-row{grid-template-columns:1.4fr .8fr 1fr .8fr .9fr}.invite-creator-head span:nth-child(5),.invite-creator-row span:nth-child(5),.invite-creator-head span:nth-child(6),.invite-creator-row span:nth-child(6){display:none}}
@media(max-width:760px){.invite-page{padding:16px}.invite-head{flex-direction:column}.invite-head-actions{justify-content:flex-start}.invite-kpis{grid-template-columns:1fr}.invite-record-table{overflow:auto}.invite-record-head,.invite-record-row{min-width:640px}.invite-campaign-actions{width:100%;justify-content:flex-end}}
</style>
