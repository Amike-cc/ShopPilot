<script lang="ts">
/**
 * 回读结果的模块级缓存。
 *
 * **为什么不能只放在组件里**（2026-10-02 真机实测）：点「回读页面实际值」会**打开店铺页面**
 * 并把应用**切到「店铺工作台」视图**，本组件随之被**卸载** —— 组件局部 ref 必丢，
 * 于是用户回到「商品管理」时组件重新挂载、`readback` 又是 null，**面板永远不出现**。
 * 表现极具迷惑性：回读成功、toast 报了成功、界面上却什么都没有（§7.11 静默失效）。
 * 放在模块作用域即可跨视图存活。
 */
export const readbackCache: { current: null | { itemId: string; suggestions: unknown[]; readFields: string[]; missingFields: string[] } } = { current: null }
</script>

<script setup lang="ts">
/**
 * 商品管理（v4 重设计 · R1：查询与列表重构，2026-10-15）。
 *
 * 信息架构（设计文档 §7.1）：摘要条 + 三 Tab（本地商品 / 平台商品 / 回收站）+ 右侧抽屉
 * （编辑 = ProductEditorDrawer；发布向导的收编在后续期）。相比旧版的两张平表：
 *   · 本地商品成了主视图：筛选 / 排序 / 分页 / 搜索 / 缩略图 / 状态 chip / 挂载列；
 *   · 状态与挂载列分离（'published' 语义由「挂载」列直出，状态只显示推导值）；
 *   · 回收站可见可恢复（软删可逆；不自动重挂平台归并——D2）。
 * 红线不回退：发布人工提交、归并人工确认、抓不到如实说、面板间不堆叠语义变化。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { hasProductProfile } from '@shared/constants/product'
import { productStatusLabel } from '@shared/product-rules'
import { PRODUCT_BATCH_LIMITS } from '@shared/product-batch'
import { storeStatusLabel } from '@shared/enums/store-status'
import type { PlatformProductStatus } from '@shared/contracts/platform-product'
import PlatformIcon from '../../components/PlatformIcon.vue'
import { useWorkspaceStore } from '../../stores/workspace'
import ProductPager from '../products/ProductPager.vue'
import ProductEditorDrawer from '../products/ProductEditorDrawer.vue'
import { canUnmerge, unmergeConfirmText, unmergeErrorText } from './product-link-actions'
import storeManageIcon from '../../assets/generated/ui-icons/app-store-gen.png'
import syncIcon from '../../assets/generated/ui-icons/sync-gen.png'
import productSyncIcon from '../../assets/generated/ui-icons/product-sync-sheet-gen.png'
import publishIcon from '../../assets/generated/ui-icons/publish-gen.png'
import preflightIcon from '../../assets/generated/ui-icons/preflight-gen.png'
import externalIcon from '../../assets/generated/ui-icons/external-gen.png'
import downloadImageIcon from '../../assets/generated/ui-icons/download-image-gen.png'
import cleanupIcon from '../../assets/generated/ui-icons/cleanup-gen.png'
import acceptIcon from '../../assets/generated/ui-icons/accept-gen.png'
import scanQueueIcon from '../../assets/generated/ui-icons/scan-queue-gen.png'
import manualEditIcon from '../../assets/generated/ui-icons/manual-edit-gen.png'
import publishGateIcon from '../../assets/generated/ui-icons/publish-gate-sheet-gen.png'
import publishConfirmIcon from '../../assets/generated/ui-icons/publish-confirm-sheet-gen.png'
import publishAbandonIcon from '../../assets/generated/ui-icons/publish-abandon-sheet-gen.png'
import panelCloseIcon from '../../assets/generated/ui-icons/panel-close-sheet-gen.png'
import batchHandleStoreIcon from '../../assets/generated/ui-icons/batch-handle-store-gen.png'
import batchSkipStoreIcon from '../../assets/generated/ui-icons/batch-skip-store-gen.png'
import batchPauseIcon from '../../assets/generated/ui-icons/batch-pause-gen.png'
import bulkPanelCloseIcon from '../../assets/generated/ui-icons/panel-close-bulk-gen.png'

const emit = defineEmits<{
  navigate: [page: 'stores']
  'open-store': [storeId: string]
}>()
const ws = useWorkspaceStore()

type ProductTab = 'local' | 'platform' | 'trash'
const tab = ref<ProductTab>('local')

/** 四个平台里只要有一家已实测登记，就还值得显示"同步"入口；一个都没有时页面顶部如实说明。 */
const hasAnyMeasuredPlatform = computed(() => ws.stores.some(store => hasProductProfile(store.platform)))

// ---------------------------------------------------------------- 平台商品（链接表）

interface ProductRow {
  linkId: string
  platform: string
  storeId: string
  storeName: string
  platformProductId: string
  platformTitle: string | null
  platformStatus: PlatformProductStatus | null
  platformPriceMinor: number | null
  platformStock: number | null
  collectedAt: number
  platformUpdatedAt: number | null
  productId: string | null
  productTitle: string | null
}
interface RunRow { storeId: string; platform: string; total: number; orphan: number; latestRun: { status: string; reasonCode: string | null; startedAt: number; safeMessage: string | null; hasMore: number; insertedCount: number; updatedCount: number; missingCount: number } | null }

const linkRows = ref<ProductRow[]>([])
const linkTotal = ref(0)
const linkLoading = ref(false)
const orphanTotal = ref(0)
const runRows = ref<RunRow[]>([])
const syncingStoreId = ref('')

const linkQuery = ref({
  storeId: '', platform: '', platformStatus: '', onlyOrphan: false, keyword: '',
  sort: 'collected', order: 'desc' as 'asc' | 'desc', limit: 50, offset: 0
})

async function loadLinks(): Promise<void> {
  linkLoading.value = true
  try {
    const [list, runs] = await Promise.all([
      window.shopilot.products.list({
        storeId: linkQuery.value.storeId || undefined,
        platform: linkQuery.value.platform || undefined,
        platformStatus: linkQuery.value.platformStatus || undefined,
        onlyOrphan: linkQuery.value.onlyOrphan || undefined,
        keyword: linkQuery.value.keyword || undefined,
        sort: linkQuery.value.sort,
        order: linkQuery.value.order,
        limit: linkQuery.value.limit,
        offset: linkQuery.value.offset
      }),
      window.shopilot.products.syncRuns({})
    ])
    if (list.ok) {
      const data = list.data as { rows?: ProductRow[]; total?: number; counts?: Array<{ orphan: number }> } | undefined
      linkRows.value = data?.rows ?? []
      linkTotal.value = data?.total ?? 0
      orphanTotal.value = (data?.counts ?? []).reduce((sum, item) => sum + Number(item.orphan ?? 0), 0)
    } else {
      ws.toast('读取商品失败：' + list.error.message, 'error')
    }
    if (runs.ok) runRows.value = ((runs.data as { rows?: RunRow[] } | undefined)?.rows) ?? []
  } finally {
    linkLoading.value = false
  }
}

// ---------------------------------------------------------------- 本地商品（主列表）

interface LocalRow {
  id: string; title: string; status: string; updatedAt: number; createdAt: number
  variantCount: number; priceMin: number | null; priceMax: number | null; stockTotal: number | null
  coverState: string | null; coverLocalPath: string | null; linkCount: number; platforms: string[]
}

const localRows = ref<LocalRow[]>([])
const localTotal = ref(0)
const localLoading = ref(false)
const localFiltersActive = computed(() => Boolean(localQuery.value.keyword || localQuery.value.status || localQuery.value.linked || localQuery.value.platform))

const localQuery = ref({
  keyword: '', status: '', linked: '', platform: '',
  sort: 'updated', order: 'desc' as 'asc' | 'desc', limit: 50, offset: 0
})

async function loadLocal(): Promise<void> {
  localLoading.value = true
  try {
    const result = await window.shopilot.products.library.list({
      keyword: localQuery.value.keyword || undefined,
      status: localQuery.value.status ? [localQuery.value.status] : undefined,
      linked: (localQuery.value.linked || undefined) as 'linked' | 'unlinked' | undefined,
      platform: localQuery.value.platform || undefined,
      sort: localQuery.value.sort,
      order: localQuery.value.order,
      limit: localQuery.value.limit,
      offset: localQuery.value.offset
    })
    if (!result.ok) { ws.toast('读取本地商品失败：' + result.error.message, 'error'); return }
    const data = result.data as { rows?: LocalRow[]; total?: number } | undefined
    localRows.value = data?.rows ?? []
    localTotal.value = data?.total ?? 0
  } finally {
    localLoading.value = false
  }
}

// ---------------------------------------------------------------- 回收站（v4 §3.4）

interface TrashRow { id: string; title: string; status: string; deletedAt: number; variantCount: number; publishJobCount: number }

const trashRows = ref<TrashRow[]>([])
const trashTotal = ref(0)
const trashLoading = ref(false)
const trashLoaded = ref(false)
const trashQuery = ref({ keyword: '', limit: 50, offset: 0 })

async function loadTrash(): Promise<void> {
  trashLoading.value = true
  try {
    const result = await window.shopilot.products.library.trash({
      keyword: trashQuery.value.keyword || undefined,
      limit: trashQuery.value.limit,
      offset: trashQuery.value.offset
    })
    if (!result.ok) { ws.toast('读取回收站失败：' + result.error.message, 'error'); return }
    const data = result.data as { rows?: TrashRow[]; total?: number } | undefined
    trashRows.value = data?.rows ?? []
    trashTotal.value = data?.total ?? 0
    trashLoaded.value = true
  } finally {
    trashLoading.value = false
  }
}

async function restoreProduct(row: TrashRow): Promise<void> {
  if (!window.confirm(`恢复「${row.title || '（无标题）'}」？\n恢复后不会自动恢复平台归并——原来的平台商品会留在「未归并」，需要时再重新归并。`)) return
  busy.value = true
  try {
    const result = await window.shopilot.products.library.restore([row.id])
    if (!result.ok) { ws.toast('恢复失败：' + result.error.message, 'error'); return }
    const restored = (result.data as { restored?: number } | undefined)?.restored ?? 0
    ws.toast(restored ? '已恢复，回到「本地商品」' : '这条记录已经不在回收站里了', restored ? 'success' : 'error')
    await Promise.all([loadTrash(), loadLocal()])
  } finally {
    busy.value = false
  }
}

// ---------------------------------------------------------------- 查询交互（防抖 / 分页 / 切 Tab）

function switchTab(next: ProductTab): void {
  tab.value = next
  // 回收站**每次进入都重拉**：恢复/删除/彻底删除都可能发生在别处（抽屉、IPC、另一台
  // 会话），缓存一次就会让「彻底删除」按钮对着已经不存在的行（2026-10-16 验收实录）。
  if (next === 'trash') void loadTrash()
  if (next === 'platform') void loadLinks()
}

let localSearchTimer: number | undefined
function onLocalSearchInput(): void {
  window.clearTimeout(localSearchTimer)
  localSearchTimer = window.setTimeout(() => { localQuery.value.offset = 0; void loadLocal() }, 300)
}
let linkSearchTimer: number | undefined
function onLinkSearchInput(): void {
  window.clearTimeout(linkSearchTimer)
  linkSearchTimer = window.setTimeout(() => { linkQuery.value.offset = 0; void loadLinks() }, 300)
}
let trashSearchTimer: number | undefined
function onTrashSearchInput(): void {
  window.clearTimeout(trashSearchTimer)
  trashSearchTimer = window.setTimeout(() => { trashQuery.value.offset = 0; void loadTrash() }, 300)
}

function applyLocalFilters(): void { localQuery.value.offset = 0; void loadLocal() }
function applyLinkFilters(): void { linkQuery.value.offset = 0; void loadLinks() }
function clearLocalFilters(): void {
  localQuery.value = { ...localQuery.value, keyword: '', status: '', linked: '', platform: '', offset: 0 }
  void loadLocal()
}
function toggleLocalOrder(): void { localQuery.value.order = localQuery.value.order === 'desc' ? 'asc' : 'desc'; applyLocalFilters() }
function toggleLinkOrder(): void { linkQuery.value.order = linkQuery.value.order === 'desc' ? 'asc' : 'desc'; applyLinkFilters() }
function onLocalPage(offset: number): void { localQuery.value.offset = offset; void loadLocal() }
function onLinkPage(offset: number): void { linkQuery.value.offset = offset; void loadLinks() }
function onTrashPage(offset: number): void { trashQuery.value.offset = offset; void loadTrash() }

// ---------------------------------------------------------------- 展示辅助

const platformOptions = computed(() => [...new Set(ws.stores.map(store => store.platform))])

function statusChipLabel(status: string): string {
  return ({ draft: '草稿', ready: '就绪', archived: '已归档', published: '已发布' } as Record<string, string>)[status] || status
}
function statusChipClass(status: string): string {
  return ['draft', 'ready', 'archived'].includes(status) ? `chip-${status}` : 'chip-other'
}
function mediaStateLabel(state: string | null): string {
  if (!state) return '没有主图'
  return ({ localized: '已本地化', pending: '未本地化', failed: '本地化失败', blocked: '已拒绝', missing: '文件缺失' } as Record<string, string>)[state] || state
}
function mediaUrl(relative: string): string {
  // local_path 形如 `ab/<sha256>.<ext>`（正斜杠，mediaRelativePath 生成）；仅经只读协议暴露
  return `shopilot-media://local/${String(relative).replace(/\\/g, '/')}`
}
const thumbErrors = ref<Set<string>>(new Set())
function onThumbError(id: string): void { thumbErrors.value = new Set(thumbErrors.value).add(id) }

function formatMinor(minor: number | null): string {
  if (minor == null) return '未取到'
  return `￥${(minor / 100).toFixed(2)}`
}
function priceRange(row: LocalRow): string {
  if (row.priceMin == null && row.priceMax == null) return '未填'
  if (row.priceMin != null && row.priceMax != null && row.priceMin !== row.priceMax) {
    return `¥${(row.priceMin / 100).toFixed(2)}–${(row.priceMax / 100).toFixed(2)}`
  }
  return `¥${((row.priceMin ?? row.priceMax ?? 0) / 100).toFixed(2)}`
}
function formatTime(ms: number): string {
  const at = new Date(ms)
  return `${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}
function storeStatusLabelOf(status: string): string { return storeStatusLabel(status) }
function storeStatusClass(status: string): string {
  return status === 'online' ? 'online' : ['needs_login', 'proxy_error'].includes(status) ? 'warning' : 'offline'
}

/** 每家店"上次同步"如实说：状态 + 时间 + 为什么没成功。 */
function storeSyncText(store: { id: string; platform: string }): string {
  const row = runRows.value.find(item => item.storeId === store.id)
  if (!row?.latestRun) return '还没有同步过'
  const run = row.latestRun
  const at = new Date(run.startedAt)
  const time = `${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const statusText: Record<string, string> = {
    SUCCEEDED: `同步成功（新增 ${run.insertedCount} / 更新 ${run.updatedCount}${run.missingCount ? ` / 平台上消失 ${run.missingCount}` : ''}）`,
    PARTIAL: '部分成功',
    LOGIN_REQUIRED: '未登录，没能同步',
    PAGE_CHANGED: '平台页面已改版，已停止且未写入数据',
    FAILED: '同步失败',
    RUNNING: '同步中'
  }
  const head = statusText[run.status] || run.status
  const tail = run.hasMore ? ' · 本次被截断，还有更多' : ''
  return `${head} · ${time}${tail}`
}

// ---------------------------------------------------------------- 同步

async function syncOne(storeId: string): Promise<void> {
  syncingStoreId.value = storeId
  try {
    const result = await window.shopilot.products.sync({ storeId, trigger: 'manual' })
    if (!result.ok) { ws.toast('同步失败：' + result.error.message, 'error'); return }
    const data = result.data as { status: string; safeMessage: string } | undefined
    // 成功/失败都用主进程给的原话，界面不自己编一套（"未登录""平台改版"这些必须原样透出）
    const ok = data?.status === 'SUCCEEDED' || data?.status === 'PARTIAL'
    ws.toast(data?.safeMessage || (ok ? '同步完成' : '同步未完成'), ok ? 'success' : 'error')
  } catch (error) {
    ws.toast('同步失败：' + String((error as Error)?.message || error), 'error')
  } finally {
    syncingStoreId.value = ''
    await loadLinks()
  }
}
async function syncStore(store: { id: string }): Promise<void> { await syncOne(store.id) }
/** 同步全部：**逐店串行**（与方案 §5.4 的"单店串行、跨店 2 并发"一致；界面入口先做串行，稳且可解释）。 */
async function syncAll(): Promise<void> {
  for (const store of ws.stores) {
    await syncOne(store.id)
  }
}

// ---------------------------------------------------------------- 通用 busy + 打开交互

const busy = ref(false)
const editingId = ref<string | null>(null)

function openEditor(row: LocalRow): void { editingId.value = row.id }
async function onEditorSaved(): Promise<void> { await loadLocal() }
/** 抽屉正打开的商品的展示状态（驱动抽屉的归档只读态；保存/取消归档后由列表刷新同步）。 */
const editingStatus = computed(() => localRows.value.find(row => row.id === editingId.value)?.status ?? 'draft')

/** 新建空白商品（v4 §3.1 R2）：创建即进编辑器。 */
async function createBlankProduct(): Promise<void> {
  busy.value = true
  try {
    const result = await window.shopilot.products.library.create({})
    if (!result.ok) { ws.toast('新建失败：' + result.error.message, 'error'); return }
    const payload = result.data as { productId: string }
    await loadLocal()
    editingId.value = payload.productId
    ws.toast('已创建空白商品，请在编辑器里补齐内容', 'success')
  } finally { busy.value = false }
}

/** 复制商品（v4 §3.1 R2）：媒体文件 sha256 复用，不重复下载。 */
async function duplicateProduct(row: LocalRow): Promise<void> {
  busy.value = true
  try {
    const result = await window.shopilot.products.library.duplicate(row.id)
    if (!result.ok) { ws.toast('复制失败：' + result.error.message, 'error'); return }
    await loadLocal()
    ws.toast('已复制为「副本」（图片文件复用，未重新下载）', 'success')
  } finally { busy.value = false }
}

/** 归档 / 取消归档（v4 §3.3 R2）：归档是显式态；取消归档按内容重算回推导值。 */
async function setArchived(row: LocalRow, archived: boolean): Promise<void> {
  busy.value = true
  try {
    const result = await window.shopilot.products.library.setArchived({ productId: row.id, archived })
    if (!result.ok) { ws.toast((archived ? '归档失败：' : '取消归档失败：') + result.error.message, 'error'); return }
    await Promise.all([loadLocal(), loadTrash()])
    ws.toast(archived ? '已归档（可用状态筛选「已归档」查看；归档商品在编辑器里只读）' : '已取消归档', 'success')
  } finally { busy.value = false }
}

/** 抽屉里的「取消归档」：动作落库 + 列表刷新；抽屉的只读态随 status prop 自动解除。 */
async function onEditorUnarchive(): Promise<void> {
  if (!editingId.value) return
  const row = localRows.value.find(candidate => candidate.id === editingId.value)
  if (row) { await setArchived(row, false); return }
  // 列表里找不到（理论上不会）：兜底直接调 IPC 再刷新
  await window.shopilot.products.library.setArchived({ productId: editingId.value, archived: false })
  await Promise.all([loadLocal(), loadTrash()])
}

/** 彻底删除（v4 §3.4 R2）：仅无发布记录；确认弹层写明不可恢复与保留项。 */
async function purgeProduct(row: TrashRow): Promise<void> {
  if (!window.confirm(`彻底删除「${row.title || '（无标题）'}」？\n规格与媒体引用将一并删除且**不可恢复**；发布台账与磁盘图片文件保留。`)) return
  busy.value = true
  try {
    const result = await window.shopilot.products.library.purge(row.id)
    if (!result.ok) { ws.toast('彻底删除失败：' + result.error.message, 'error'); return }
    ws.toast('已彻底删除', 'success')
    await loadTrash()
  } finally { busy.value = false }
}

// ---------------------------------------------------------------- v4 R3：批量操作 + CSV 导入导出

interface BatchSkipped { id: string; title: string; reason: string }
interface BatchPreviewData { operation: string; affected: number; skipped: BatchSkipped[]; sample: Array<{ id: string; title: string; detail: string }> }
interface BatchOutcomeData { succeeded: number; skipped: BatchSkipped[]; failed: Array<{ id: string; title: string; message: string }> }
interface ImportPlanData {
  creates: Array<{ rowNumber: number; title: string }>
  updates: Array<{ rowNumber: number; productId: string; title: string; changes: Array<{ field: string; before: string; after: string }> }>
  conflicts: Array<{ rowNumber: number; title: string; reason: string }>
}

/** 多选（跨页保留，上限 500 = PRODUCT_BATCH_LIMITS.select）。 */
const selectedIds = ref<Set<string>>(new Set())
const allPageSelected = computed(() => localRows.value.length > 0 && localRows.value.every(row => selectedIds.value.has(row.id)))
function toggleSelect(id: string): void {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else {
    if (next.size >= PRODUCT_BATCH_LIMITS.select) { ws.toast(`最多选 ${PRODUCT_BATCH_LIMITS.select} 项`, 'error'); return }
    next.add(id)
  }
  selectedIds.value = next
}
function toggleSelectAll(): void {
  const next = new Set(selectedIds.value)
  if (allPageSelected.value) { for (const row of localRows.value) next.delete(row.id) }
  else { for (const row of localRows.value) next.add(row.id) }
  selectedIds.value = next
}
function clearSelection(): void { selectedIds.value = new Set() }
// 行消失（删除/恢复/翻页数据更替）后同步清理失效选择
watch(localRows, () => {
  const alive = new Set(localRows.value.map(row => row.id))
  const next = new Set([...selectedIds.value].filter(id => alive.has(id)))
  if (next.size !== selectedIds.value.size) selectedIds.value = next
})

type BatchOp = 'price' | 'tags.add' | 'tags.remove' | 'archive' | 'unarchive' | 'delete'
const batchOp = ref<BatchOp | ''>('')
const batchParams = ref({ mode: 'percent' as 'percent' | 'fixed', valueText: '', floorText: '' })
const batchTagsText = ref('')
const batchPreview = ref<BatchPreviewData | null>(null)
const batchOutcome = ref<BatchOutcomeData | null>(null)
const batchOpLabel = computed(() => (({
  price: '批量改价', 'tags.add': '批量加标签', 'tags.remove': '批量删标签',
  archive: '批量归档', unarchive: '批量取消归档', delete: '批量删除（软删，可恢复）'
}) as Record<string, string>)[batchOp.value] || '')
function openBatch(op: BatchOp): void {
  batchOp.value = op
  batchPreview.value = null
  batchOutcome.value = null
}
function closeBatch(): void {
  batchOp.value = ''
  batchPreview.value = null
  batchOutcome.value = null
}
function batchPayload(): { operation: BatchOp; productIds: string[]; params?: Record<string, unknown> } {
  const payload: { operation: BatchOp; productIds: string[]; params?: Record<string, unknown> } = { operation: batchOp.value as BatchOp, productIds: [...selectedIds.value] }
  if (batchOp.value === 'price') {
    const value = Number(batchParams.value.valueText)
    if (!Number.isFinite(value)) throw new Error('请输入改价数值（负数 = 降价）')
    const floorText = batchParams.value.floorText.trim()
    const floorYuan = floorText ? Number(floorText) : 0.01
    payload.params = { mode: batchParams.value.mode, value, floorMinor: Math.max(1, Math.round(floorYuan * 100)) }
  }
  if (batchOp.value === 'tags.add' || batchOp.value === 'tags.remove') {
    const tags = batchTagsText.value.split('|').map(tag => tag.trim()).filter(Boolean)
    if (!tags.length) throw new Error('请输入至少一个标签（竖线 | 分隔）')
    if (tags.length > 10) throw new Error('标签最多 10 个')
    payload.params = { tags }
  }
  return payload
}
async function runBatchPreview(): Promise<void> {
  let payload: ReturnType<typeof batchPayload>
  try { payload = batchPayload() } catch (error) { ws.toast(String((error as Error).message), 'error'); return }
  busy.value = true
  try {
    const result = await window.shopilot.products.library.batchPreview(payload)
    if (!result.ok) { ws.toast('预览失败：' + result.error.message, 'error'); return }
    batchPreview.value = result.data as BatchPreviewData
  } finally { busy.value = false }
}
async function runBatchExecute(): Promise<void> {
  let payload: ReturnType<typeof batchPayload>
  try { payload = batchPayload() } catch (error) { ws.toast(String((error as Error).message), 'error'); return }
  busy.value = true
  try {
    const result = await window.shopilot.products.library.batchExecute(payload)
    if (!result.ok) { ws.toast('执行失败：' + result.error.message, 'error'); return }
    batchOutcome.value = result.data as BatchOutcomeData
    await Promise.all([loadLocal(), loadTrash()])
  } finally { busy.value = false }
}

/** CSV 导出：selected = 勾选项；filtered = 当前筛选全量（主进程保存对话框 + 写盘）。 */
async function exportCsv(mode: 'selected' | 'filtered'): Promise<void> {
  if (mode === 'selected' && !selectedIds.value.size) { ws.toast('先勾选要导出的商品', 'error'); return }
  busy.value = true
  try {
    const result = await window.shopilot.products.library.exportCsv({
      mode,
      productIds: mode === 'selected' ? [...selectedIds.value] : undefined,
      query: mode === 'filtered' ? {
        keyword: localQuery.value.keyword || undefined,
        status: localQuery.value.status ? [localQuery.value.status] : undefined,
        linked: localQuery.value.linked !== 'any' ? localQuery.value.linked : undefined,
        platform: localQuery.value.platform || undefined
      } : undefined
    })
    if (!result.ok) { ws.toast('导出失败：' + result.error.message, 'error'); return }
    const data = result.data as { canceled?: boolean; filePath?: string; count?: number }
    if (data.canceled) return
    ws.toast(`已导出 ${data.count} 条到 ${data.filePath}`, 'success')
  } finally { busy.value = false }
}

const importPlan = ref<ImportPlanData | null>(null)
let importCsvText = ''
/** 下载导入模板（§4.6：模板下载 → 解析 → 预览 diff）。 */
async function downloadImportTemplate(): Promise<void> {
  busy.value = true
  try {
    const result = await window.shopilot.products.library.importTemplate()
    if (!result.ok) { ws.toast('模板下载失败：' + result.error.message, 'error'); return }
    const data = result.data as { canceled?: boolean; filePath?: string }
    if (data.canceled) return
    ws.toast(`模板已保存到 ${data.filePath}`, 'success')
  } finally { busy.value = false }
}

async function onImportFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  importCsvText = await file.text()
  busy.value = true
  try {
    const result = await window.shopilot.products.library.importPreview(importCsvText)
    if (!result.ok) { ws.toast('解析失败：' + result.error.message, 'error'); return }
    importPlan.value = result.data as ImportPlanData
    batchOp.value = ''
  } finally { busy.value = false; input.value = '' }
}
async function runImportExecute(): Promise<void> {
  if (!importCsvText) return
  busy.value = true
  try {
    const result = await window.shopilot.products.library.importExecute(importCsvText)
    if (!result.ok) { ws.toast('导入失败：' + result.error.message, 'error'); return }
    const data = result.data as { created: number; updated: number; conflicts: Array<{ reason: string }> }
    ws.toast(`导入完成：新增 ${data.created}、更新 ${data.updated}${data.conflicts.length ? `、跳过 ${data.conflicts.length}` : ''}`, data.conflicts.length ? 'error' : 'success')
    importPlan.value = null
    importCsvText = ''
    await loadLocal()
  } finally { busy.value = false }
}

// ---------------------------------------------------------------- 详情 / 另存为 / 删除 / 图片本地化

/**
 * 拉取详情：去商品详情页读**真正的商品图与规格**。
 *
 * 为什么需要这一步：列表页每行只有一张缩略图，微信实测是 **SVG**（本地化会如实拒绝）；
 * 详情页才是 WebP 真图。所以"另存为本地商品"之前先拉一次详情，图片本地化才有意义。
 */
async function collectDetail(row: ProductRow): Promise<void> {
  busy.value = true
  try {
    const result = await window.shopilot.products.detail.collect({ storeId: row.storeId, platformProductId: row.platformProductId })
    if (!result.ok) { ws.toast('拉取详情失败：' + result.error.message, 'error'); return }
    const data = result.data as { status: string; safeMessage: string; imageCount: number; specNames: string[] } | undefined
    const ok = data?.status === 'SUCCEEDED'
    ws.toast(data?.safeMessage || (ok ? '已拉取详情' : '没能拉到详情'), ok ? 'success' : 'error')
    await loadLinks()
  } finally {
    busy.value = false
  }
}

/** 另存为本地商品（**用户点了才执行**；服务里没有自动合并的路径）。 */
async function saveAsLocal(row: ProductRow): Promise<void> {
  busy.value = true
  try {
    const result = await window.shopilot.products.library.saveAsLocal({
      platform: row.platform, storeId: row.storeId, platformProductId: row.platformProductId
    })
    if (!result.ok) { ws.toast('另存为失败：' + result.error.message, 'error'); return }
    const issues = (result.data as { issues?: DraftIssue[] } | undefined)?.issues ?? []
    const blockers = issues.filter(issue => issue.level === 'blocker').length
    ws.toast(blockers ? `已建出本地商品，但有 ${blockers} 项待补（如缺主图/规格）` : '已建出本地商品', blockers ? 'error' : 'success')
    await Promise.all([loadLinks(), loadLocal()])
  } finally {
    busy.value = false
  }
}

async function removeLocal(row: LocalRow): Promise<void> {
  if (!window.confirm(`删除「${row.title || '（无标题）'}」？\n商品会移入回收站（可恢复）；发布台账保留。${row.linkCount ? '\n它挂载的平台商品会回到「未归并」。' : ''}`)) return
  busy.value = true
  try {
    const result = await window.shopilot.products.library.remove(row.id)
    if (!result.ok) { ws.toast('删除失败：' + result.error.message, 'error'); return }
    ws.toast('已移入回收站（可恢复，发布台账保留）', 'success')
    await Promise.all([loadLinks(), loadLocal()])
  } finally {
    busy.value = false
  }
}

/** 下载图片到本地：主进程做 SSRF/体积/格式校验与 sha256 去重，这里只显示如实结果。 */
async function localizeMedia(row: LocalRow): Promise<void> {
  busy.value = true
  try {
    const result = await window.shopilot.products.library.localizeMedia(row.id)
    if (!result.ok) { ws.toast('下载图片失败：' + result.error.message, 'error'); return }
    const data = result.data as { total: number; localized: number; deduped: number; failed: number; blocked: number; details?: Array<{ reason: string | null }> } | undefined
    const reasons = [...new Set((data?.details ?? []).map(item => item.reason).filter(Boolean))]
    const summary = `共 ${data?.total ?? 0} 张：本地化 ${data?.localized ?? 0}、重复 ${data?.deduped ?? 0}、失败 ${data?.failed ?? 0}、拒绝 ${data?.blocked ?? 0}`
    ws.toast(reasons.length ? `${summary}（原因：${reasons.join('、')}）` : summary, (data?.failed || data?.blocked) ? 'error' : 'success')
    await loadLocal()
  } finally {
    busy.value = false
  }
}

// ---------------------------------------------------------------- 发布（M3/M4/M5：全部保留，红线不动）

interface DraftIssue { level: 'blocker' | 'warning' | 'info'; field: string; message: string; fixHint?: string }
interface PublishField {
  field: string; label: string; localValue: string | null; platformValue: string | null
  lastValue: string | null; action: string; level: 'info' | 'warning' | 'blocker'; note?: string
}
interface PublishPrecheck {
  verdict: 'ready' | 'ready_with_warnings' | 'blocked'
  tier: string; summary: string; storeId?: string
  blockers: DraftIssue[]; warnings: DraftIssue[]
  fields: PublishField[]; missingRequired: string[]
}
interface PreflightState { productId: string; itemId: string | null; storeName: string; precheck: PublishPrecheck }
interface ReadbackSuggestion {
  field: string; label: string; kind: 'suggest_default' | 'suggest_writeback' | 'same' | 'only_local'
  localValue: string | null; platformValue: string | null; note: string
}
interface ReadbackState { itemId: string; suggestions: ReadbackSuggestion[]; readFields: string[]; missingFields: string[] }
interface BatchProgress {
  total: number; done: number; waitingHuman: number; failed: number; pending: number; running: number; skipped: number
  currentStoreId: string | null; finished: boolean; summary: string
}
interface BatchItem { itemId: string; productId: string; storeId: string; status: string; safeMessage: string | null }
interface BatchState { batchId: string; progress: BatchProgress; items: BatchItem[] }
interface MediaQueueState {
  summary: string
  items: Array<{ role: string; shouldAttempt: boolean; reason: string | null }>
  orphans: { orphans: unknown[]; keepCount: number; orphanBytes: number; summary: string } | null
}

const preflight = ref<PreflightState | null>(null)
// 初值从**模块级缓存**取：回读会切视图导致本组件卸载，回来时靠它把结果带回来（见文件顶部说明）
const readback = ref<ReadbackState | null>(readbackCache.current as ReadbackState | null)
watch(readback, value => { readbackCache.current = value as never })
const batch = ref<BatchState | null>(null)
const mediaQueue = ref<MediaQueueState | null>(null)

/**
 * 发布预检（M3）：算清楚"能不能发、要让人看什么、会不会重复发"。
 *
 * 预检**不写平台、不开页面**，只产出台账与那张字段级 diff 表；
 * 真正打开页面是用户看完清单之后的事（`openPublishPage`），而且**永远不点提交**。
 */
async function runPreflight(row: LocalRow): Promise<void> {
  const online = ws.stores.filter(store => store.status === 'online')
  if (!online.length) { ws.toast('没有在线店铺，先登录要发布的店铺', 'error'); return }
  busy.value = true
  try {
    const result = await window.shopilot.products.publish.preflight({ productId: row.id, storeIds: online.map(store => store.id) })
    if (!result.ok) { ws.toast('发布预检失败：' + result.error.message, 'error'); return }
    const data = result.data as { jobId: string | null; itemId: string | null; precheck: PublishPrecheck | null } | undefined
    if (!data?.precheck) { ws.toast('预检没有返回结果', 'error'); return }
    const store = online.find(item => item.id === data.precheck!.storeId)
    preflight.value = { productId: row.id, itemId: data.itemId, storeName: store?.name ?? '目标店铺', precheck: data.precheck }
    ws.toast(data.precheck.summary, data.precheck.verdict === 'blocked' ? 'error' : 'success')
  } finally {
    busy.value = false
  }
}

/** 打开平台发布页（**只打开，不代填不提交**）：页面交给用户，应用停在人工交接点。 */
async function openPublishPage(fill: boolean): Promise<void> {
  const state = preflight.value
  if (!state?.itemId) { ws.toast('这条发布项还没有台账记录，请重新预检', 'error'); return }
  busy.value = true
  try {
    const result = await window.shopilot.products.publish.open({ itemId: state.itemId, fill })
    if (!result.ok) { ws.toast('打开发布页失败：' + result.error.message, 'error'); return }
    const data = result.data as { state: string; tier: string; safeMessage: string } | undefined
    ws.toast(data?.safeMessage || '已打开发布页', data?.state === 'awaiting_human' ? 'success' : 'error')
  } finally {
    busy.value = false
  }
}

/**
 * 开人工确认门禁：**走任务引擎的 waitForUserConfirmation**（方案 §7.4）。
 *
 * 门禁只负责"等人"，超时**不自动提交也不自动放弃**（可过夜）。任务引擎里
 * 只有一个「等确认」步骤，没有任何点击/填写副作用步骤。
 */
async function openGate(): Promise<void> {
  const state = preflight.value
  if (!state?.itemId) { ws.toast('请先做发布预检', 'error'); return }
  busy.value = true
  try {
    const result = await window.shopilot.products.publish.openGate({ itemId: state.itemId })
    if (!result.ok) { ws.toast('开门禁失败：' + result.error.message, 'error'); return }
    const data = result.data as { ok: boolean; safeMessage: string } | undefined
    ws.toast(data?.safeMessage || '已开人工确认门禁', data?.ok ? 'success' : 'error')
  } finally {
    busy.value = false
  }
}

/** 用户在平台上自己点完提交后，回来告诉我们 —— 然后进只读回读（应用不会去点提交）。 */
async function confirmSubmitted(approved: boolean): Promise<void> {
  const state = preflight.value
  if (!state?.itemId) { ws.toast('请先做发布预检', 'error'); return }
  busy.value = true
  try {
    const result = await window.shopilot.products.publish.confirm({ itemId: state.itemId, approved })
    if (!result.ok) { ws.toast('操作失败：' + result.error.message, 'error'); return }
    const data = result.data as { state: string; safeMessage: string } | undefined
    ws.toast(data?.safeMessage || '已记录', 'success')
    if (approved) {
      const verify = await window.shopilot.products.publish.verify({ itemId: state.itemId })
      const v = verify.ok ? verify.data as { state: string; safeMessage: string } : null
      ws.toast(v ? `回读：${v.safeMessage}` : '回读失败', v?.state === 'confirmed' ? 'success' : 'error')
    }
  } finally {
    busy.value = false
  }
}

/**
 * 回读"用户实际填的值"（M4，方案 §7.5）：**只读页面**产出建议，应用不自动改本地。
 *
 * 落库只能逐条点「接受」——这是方案里"不自动改，避免'这次特批'变成默认值"的落点。
 */
async function runReadback(): Promise<void> {
  const state = preflight.value
  if (!state?.itemId) { ws.toast('请先做发布预检', 'error'); return }
  busy.value = true
  try {
    const result = await window.shopilot.products.publish.readback({ itemId: state.itemId })
    if (!result.ok) { ws.toast('回读失败：' + result.error.message, 'error'); return }
    const data = result.data as { ok: boolean; suggestions: ReadbackSuggestion[]; safeMessage: string; readFields: string[]; missingFields: string[] } | undefined
    if (!data?.ok) { ws.toast(data?.safeMessage || '回读没成功', 'error'); return }
    readback.value = { itemId: state.itemId, suggestions: data.suggestions, readFields: data.readFields, missingFields: data.missingFields }
    // ⚠️ **直接写模块级缓存，不能依赖 watch**（2026-10-02 真机实测）：见文件顶部说明
    readbackCache.current = readback.value
    ws.toast(data.safeMessage, 'success')
  } finally {
    busy.value = false
  }
}

/** 接受一条建议 → 落库（默认值 / 回写本地）。用户不点就什么都不会写。 */
async function acceptSuggestion(item: ReadbackSuggestion): Promise<void> {
  const state = readback.value
  if (!state) return
  busy.value = true
  try {
    const result = await window.shopilot.products.publish.acceptSuggestion({
      itemId: state.itemId, field: item.field,
      kind: item.kind === 'suggest_default' ? 'suggest_default' : 'suggest_writeback'
    })
    if (!result.ok) { ws.toast('接受失败：' + result.error.message, 'error'); return }
    ws.toast((result.data as { safeMessage?: string } | undefined)?.safeMessage || '已处理', 'success')
    readback.value = { ...state, suggestions: state.suggestions.filter(row => row.field !== item.field) }
    await loadLocal()
  } finally {
    busy.value = false
  }
}

function suggestionKindLabel(kind: string): string {
  return ({
    suggest_default: '建议存为默认值', suggest_writeback: '与本地不一致', same: '一致', only_local: '平台上是空的'
  } as Record<string, string>)[kind] || kind
}
function fieldActionLabel(action: string): string {
  return ({
    fill: '填入', fill_suggest: '建议填入（待你确认）', keep_platform: '保留平台值',
    reuse_last: '用上次选择', skip_unsupported: '跳过（平台不支持）', leave_empty: '不填（本地也没有）'
  } as Record<string, string>)[action] || action
}

/**
 * 建一次批量发布（M5，方案 §7.8）：**全部本地商品 × 全部在线店铺**（规则层判上限）。
 *
 * 这一步**只建台账**：不预检、不开页面、不填字段、不提交。
 * 之后按"当前店铺"逐店往前走 —— 一次只打开一个店铺。
 */
async function createBatch(): Promise<void> {
  const online = ws.stores.filter(store => store.status === 'online')
  if (!localRows.value.length) { ws.toast('还没有本地商品', 'error'); return }
  if (!online.length) { ws.toast('没有在线店铺，先登录要发布的店铺', 'error'); return }
  busy.value = true
  try {
    const result = await window.shopilot.products.publish.batchCreate({
      productIds: localRows.value.slice(0, 20).map(row => row.id),
      storeIds: online.slice(0, 20).map(store => store.id)
    })
    if (!result.ok) { ws.toast('建批量失败：' + result.error.message, 'error'); return }
    const data = result.data as { ok: boolean; batchId: string | null; errors: string[]; progress: BatchProgress } | undefined
    if (!data?.ok) { ws.toast('批量计划被拒绝：' + (data?.errors || []).join('；'), 'error'); return }
    batch.value = { batchId: data.batchId!, progress: data.progress, items: [] }
    ws.toast('已建批量：' + data.progress.summary, 'success')
    await loadBatch()
  } finally {
    busy.value = false
  }
}

/** 读批量进度（**三个数**：已完成 / 待人工 / 失败）。 */
async function loadBatch(): Promise<void> {
  const state = batch.value
  if (!state?.batchId) return
  const result = await window.shopilot.products.publish.batchProgress({ batchId: state.batchId })
  if (!result.ok) return
  const data = result.data as { progress: BatchProgress; items: BatchItem[] } | undefined
  if (data?.progress) batch.value = { ...state, progress: data.progress, items: data.items ?? [] }
}

/**
 * 「处理这家」：把这家店**当前要处理的项**打开发布页（走已验证的 openForHuman 路径，仍然不提交）。
 */
async function handleStoreNow(storeId: string): Promise<void> {
  const items = batchItemsOfStore(storeId)
  const target = items.find(item => item.status === 'pending') ?? items.find(item => item.status === 'awaiting_human') ?? items[0]
  if (!target) { ws.toast('这家店没有可处理的项', 'error'); return }
  busy.value = true
  try {
    const result = await window.shopilot.products.publish.open({ itemId: target.itemId, fill: true })
    if (!result.ok) { ws.toast('打开发布页失败：' + result.error.message, 'error'); return }
    ws.toast((result.data as { safeMessage?: string } | undefined)?.safeMessage || '已打开发布页', 'success')
  } finally {
    busy.value = false
  }
}

/** 「全部暂停」：只把"正在跑"的退回未开始；**已经在等人工的保持等待**（人工交接点不该被冲掉）。 */
async function pauseBatch(): Promise<void> {
  const batchId = batch.value?.batchId
  if (!batchId) { ws.toast('还没有批次可以暂停', 'error'); return }
  busy.value = true
  try {
    const result = await window.shopilot.products.publish.batchAbort({ batchId })
    if (!result.ok) { ws.toast('暂停失败：' + result.error.message, 'error'); return }
    ws.toast((result.data as { safeMessage?: string } | undefined)?.safeMessage || '已暂停', 'success')
    await loadBatch()
  } finally {
    busy.value = false
  }
}

/** 「跳过这家先做下一家」：只跳过该店**还没开始**的项（已在等人工的不动）。 */
async function skipStore(storeId: string): Promise<void> {
  const state = batch.value
  if (!state?.batchId) return
  busy.value = true
  try {
    const result = await window.shopilot.products.publish.batchSkipStore({ batchId: state.batchId, storeId })
    if (!result.ok) { ws.toast('跳过失败：' + result.error.message, 'error'); return }
    ws.toast((result.data as { safeMessage?: string } | undefined)?.safeMessage || '已跳过', 'success')
    await loadBatch()
  } finally {
    busy.value = false
  }
}

function batchItemsOfStore(storeId: string): BatchItem[] {
  return (batch.value?.items ?? []).filter(row => row.storeId === storeId)
}
function storeNameOf(storeId: string): string {
  return ws.stores.find(store => store.id === storeId)?.name ?? storeId.slice(0, 12)
}
function statusCountsText(items: BatchItem[]): string {
  const counts: Record<string, number> = {}
  for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1
  return Object.entries(counts).map(([state, count]) => `${batchStateLabel(state)} ${count}`).join('、') || '—'
}
function batchStateLabel(state: string): string {
  return ({
    pending: '未开始', running: '进行中', awaiting_human: '待人工', confirmed: '已完成',
    needs_review: '待核对', failed: '失败', skipped: '已跳过', discarded: '已放弃'
  } as Record<string, string>)[state] || state
}

// ---------------------------------------------------------------- 图片队列与保留策略

/**
 * 图片本地化队列与保留策略（方案 §5.9）。
 *
 * `scan` 只算、`run` 才下载；`orphans` **只判定不删**，`cleanup` 是用户点了确认才删。
 */
async function scanMediaQueue(): Promise<void> {
  busy.value = true
  try {
    const result = await window.shopilot.products.library.queueScan({ maxItems: 200 })
    if (!result.ok) { ws.toast('扫描失败：' + result.error.message, 'error'); return }
    const data = result.data as { items: Array<{ role: string; shouldAttempt: boolean; reason: string | null }>; summary: string; candidates: number } | undefined
    mediaQueue.value = { summary: data?.summary ?? '', items: data?.items ?? [], orphans: mediaQueue.value?.orphans ?? null }
    ws.toast(data?.summary || '扫描完成', 'success')
  } finally {
    busy.value = false
  }
}
async function runMediaQueue(): Promise<void> {
  busy.value = true
  try {
    const result = await window.shopilot.products.library.queueRun({ maxItems: 20 })
    if (!result.ok) { ws.toast('跑队列失败：' + result.error.message, 'error'); return }
    ws.toast((result.data as { summary?: string } | undefined)?.summary || '队列跑完', 'success')
    await Promise.all([scanMediaQueue(), loadLocal()])
  } finally {
    busy.value = false
  }
}
/** 查孤儿（只判定）：把"将删除 N 个文件/共多少 MB"摆给用户看，**不删**。 */
async function scanOrphans(): Promise<void> {
  busy.value = true
  try {
    const result = await window.shopilot.products.library.orphans()
    if (!result.ok) { ws.toast('查询失败：' + result.error.message, 'error'); return }
    const data = result.data as { orphans: unknown[]; keepCount: number; orphanBytes: number; summary: string } | undefined
    mediaQueue.value = { summary: mediaQueue.value?.summary ?? '', items: mediaQueue.value?.items ?? [], orphans: data ?? null }
    ws.toast(data?.summary || '查询完成', 'success')
  } finally {
    busy.value = false
  }
}
/** 清理孤儿：**用户点了确认才删**（且只删我们自己的目录里、不在表里的文件）。 */
async function cleanupOrphans(): Promise<void> {
  const pending = mediaQueue.value?.orphans
  if (!pending?.orphans?.length) { ws.toast('没有可清理的孤儿文件', 'error'); return }
  if (!window.confirm(`清理 ${pending.orphans.length} 个孤儿文件？只删应用自己 product-media 目录里、没有任何商品在用的图片。`)) return
  busy.value = true
  try {
    const result = await window.shopilot.products.library.cleanupOrphans()
    if (!result.ok) { ws.toast('清理失败：' + result.error.message, 'error'); return }
    ws.toast((result.data as { summary?: string } | undefined)?.summary || '清理完成', 'success')
    await scanOrphans()
  } finally {
    busy.value = false
  }
}

// ---------------------------------------------------------------- 解除归并（平台商品）

/**
 * 待确认的行（null = 没有待确认的解除操作）。
 *
 * 这里**故意不用 `window.confirm`**：它会同步阻塞渲染进程，CDP 验收点不动界面、
 * 自动化也无法接管对话框。页面内的浮层同样有二次确认，但不阻塞。
 */
const unmergeTarget = ref<ProductRow | null>(null)
const unmergeBusy = ref(false)
/** 文案由纯逻辑模块生成（可单测）：如实说明"平台商品回到未归并、本地商品与台账不动" */
const unmergeConfirmMessage = computed(() => unmergeConfirmText(unmergeTarget.value))

/** 只有「已归并且 linkId 合法」的行才渲染入口（未归并的行没有可摘的东西） */
function canUnmergeLink(row: ProductRow): boolean {
  return canUnmerge(row)
}

function askUnmerge(row: ProductRow): void {
  if (!canUnmerge(row)) { ws.toast('这条平台商品当前没有可解除的归并', 'error'); return }
  unmergeTarget.value = row
}

function cancelUnmerge(): void {
  if (unmergeBusy.value) return
  unmergeTarget.value = null
}

async function confirmUnmerge(): Promise<void> {
  const row = unmergeTarget.value
  if (!row) return
  const linkId = (row.linkId || '').trim()
  if (!linkId) {
    unmergeTarget.value = null
    ws.toast('这条记录缺少 linkId，请刷新列表后重试', 'error')
    return
  }
  unmergeBusy.value = true
  try {
    const result = await window.shopilot.products.library.unmerge({ linkId })
    if (!result.ok) {
      // 失败**不重拉列表**：当前筛选与分页原样留着，用户看到的还是刚才那一屏
      ws.toast(unmergeErrorText(result.error), 'error')
      unmergeTarget.value = null
      return
    }
    unmergeTarget.value = null
    ws.toast('已解除归并', 'success')
    // 成功才重拉：复用页面既有的刷新函数，沿用 linkQuery 的筛选与分页
    await loadLinks()
  } catch (error) {
    ws.toast(unmergeErrorText(error), 'error')
    unmergeTarget.value = null
  } finally {
    unmergeBusy.value = false
  }
}

onMounted(() => { void loadLinks(); void loadLocal() })
</script>

<template>
  <section class="unified-page" data-test="unified-products-page">
    <header class="unified-page-head">
      <div>
        <span class="dashboard-eyebrow">WORKSPACE / PRODUCTS</span>
        <h1>商品管理</h1>
        <p>本地商品是主数据：可编辑并发布到指定店铺（半自动，提交由你在浏览器里确认）。平台商品用于观测与归并。</p>
      </div>
      <div class="product-head-actions">
        <button type="button" class="unified-button primary" data-test="local-create" :disabled="busy" @click="createBlankProduct">
          <img class="button-icon" :src="manualEditIcon" alt="" />新建商品</button>
        <button v-if="ws.ready && ws.stores.length" type="button" class="unified-button" :disabled="!!syncingStoreId" data-test="product-sync-all" @click="syncAll">
          <img class="button-icon" :src="syncIcon" alt="" />{{ syncingStoreId ? '同步中…' : '同步全部店铺' }}</button>
        <button type="button" class="unified-button" @click="emit('navigate', 'stores')"><img class="button-icon" :src="storeManageIcon" alt="" />管理店铺</button>
      </div>
    </header>

    <div class="unified-alert info" v-if="!hasAnyMeasuredPlatform">
      <strong>暂无已实测的商品数据源</strong>
      <span>四个平台里还没有实测到商品列表的档案，因此暂不能同步。这不是"没有商品"，是"这个平台还没实测"。</span>
    </div>

    <div v-if="!ws.ready" class="unified-state"><span class="loader"></span>正在读取店铺…</div>
    <div v-else-if="!ws.stores.length" class="unified-empty">暂无店铺<button type="button" class="inline-link" @click="emit('navigate', 'stores')">添加店铺</button></div>

    <template v-else>
      <div class="product-summary-bar" data-test="product-summary">
        <button type="button" class="summary-chip" :class="{ active: tab === 'local' }" @click="switchTab('local')">本地商品 <b>{{ localTotal }}</b></button>
        <button type="button" class="summary-chip" :class="{ active: tab === 'platform' }" @click="switchTab('platform')">平台商品 <b>{{ linkTotal }}</b></button>
        <button type="button" class="summary-chip" :class="{ warn: orphanTotal > 0 }" data-test="summary-orphans" @click="switchTab('platform'); linkQuery.onlyOrphan = true; applyLinkFilters()">待归并 <b>{{ orphanTotal }}</b></button>
      </div>

      <nav class="product-tabs" role="tablist" aria-label="商品视图">
        <button type="button" role="tab" data-test="product-tab-local" :class="{ active: tab === 'local' }" @click="switchTab('local')">本地商品</button>
        <button type="button" role="tab" data-test="product-tab-platform" :class="{ active: tab === 'platform' }" @click="switchTab('platform')">平台商品</button>
        <button type="button" role="tab" data-test="product-tab-trash" :class="{ active: tab === 'trash' }" @click="switchTab('trash')">回收站</button>
      </nav>

      <!-- ============================================================ 本地商品 -->
      <template v-if="tab === 'local'">
        <div class="product-toolbar">
          <input class="product-search" type="search" v-model="localQuery.keyword" data-test="product-search"
                 placeholder="搜索 标题 / SKU 码 / 条码…" @input="onLocalSearchInput" />
          <select class="product-select" v-model="localQuery.status" data-test="product-filter-status" @change="applyLocalFilters">
            <option value="">全部状态</option>
            <option value="ready">就绪</option>
            <option value="draft">草稿</option>
            <option value="archived">已归档</option>
          </select>
          <select class="product-select" v-model="localQuery.linked" data-test="product-filter-linked" @change="applyLocalFilters">
            <option value="">全部挂载</option>
            <option value="linked">已挂载</option>
            <option value="unlinked">未挂载</option>
          </select>
          <select class="product-select" v-model="localQuery.platform" data-test="product-filter-platform" @change="applyLocalFilters">
            <option value="">全部平台</option>
            <option v-for="platform in platformOptions" :key="platform" :value="platform">{{ platform }}</option>
          </select>
          <select class="product-select" v-model="localQuery.sort" data-test="product-sort" @change="applyLocalFilters">
            <option value="updated">按更新时间</option>
            <option value="created">按创建时间</option>
            <option value="title">按标题</option>
            <option value="priceMin">按价格</option>
            <option value="stockTotal">按库存</option>
          </select>
          <button type="button" class="unified-button ghost" data-test="product-sort-order" @click="toggleLocalOrder">{{ localQuery.order === 'desc' ? '降序 ↓' : '升序 ↑' }}</button>
          <button type="button" class="unified-button ghost" data-test="batch-export-filtered" :disabled="busy || !localTotal" @click="exportCsv('filtered')">导出 CSV（当前筛选）</button>
          <label class="unified-button ghost import-label" :class="{ disabled: busy }">
            <input type="file" accept=".csv,text/csv" data-test="import-csv" :disabled="busy" @change="onImportFile" />导入 CSV</label>
          <button type="button" class="unified-button ghost" data-test="import-template" :disabled="busy" @click="downloadImportTemplate">导入模板</button>
          <button type="button" class="unified-button ghost" data-test="local-refresh" @click="loadLocal"><img class="button-icon" :src="syncIcon" alt="" />刷新</button>
          <span class="product-toolbar-hint" data-test="local-count">共 {{ localTotal }} 条</span>
        </div>

        <div v-if="localLoading" class="unified-state"><span class="loader"></span>正在读取本地商品…</div>
        <div v-else-if="!localRows.length" class="unified-empty" data-test="local-empty">
          <template v-if="localFiltersActive">
            <span>当前筛选没有匹配的商品。</span>
            <button type="button" class="inline-link" data-test="local-clear-filters" @click="clearLocalFilters">清除筛选</button>
          </template>
          <template v-else>
            <span>还没有本地商品。</span>
            <span class="product-empty-hint">到「平台商品」里同步后，点某行的「另存为本地商品」就会建出第一条。</span>
          </template>
        </div>
        <div v-else class="product-table-wrap">
          <table class="product-table">
            <thead><tr><th class="th-check"><input type="checkbox" data-test="batch-check-all" :disabled="busy" :checked="allPageSelected" @change="toggleSelectAll" /></th><th class="th-thumb">图</th><th>标题</th><th>状态</th><th>挂载</th><th>规格</th><th>价格</th><th>库存</th><th>更新时间</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="row in localRows" :key="row.id" :data-test="'local-product-' + row.id">
                <td class="th-check"><input type="checkbox" :data-test="'batch-check-' + row.id" :disabled="busy" :checked="selectedIds.has(row.id)" @change="toggleSelect(row.id)" /></td>
                <td class="th-thumb">
                  <div class="product-thumb">
                    <img v-if="row.coverLocalPath && !thumbErrors.has(row.id)" :src="mediaUrl(row.coverLocalPath)" alt="" loading="lazy" @error="onThumbError(row.id)" />
                    <span v-else class="thumb-state" :title="mediaStateLabel(row.coverState)">{{ row.coverLocalPath && thumbErrors.has(row.id) ? '文件缺失' : mediaStateLabel(row.coverState) }}</span>
                  </div>
                </td>
                <td>
                  <span class="product-title">{{ row.title || '（无标题）' }}</span>
                  <small>ID {{ row.id.slice(0, 18) }}</small>
                </td>
                <td><span class="status-chip" :class="statusChipClass(row.status)" :data-test="'local-status-' + row.id">{{ statusChipLabel(row.status) }}</span></td>
                <td>
                  <span v-if="row.platforms.length">{{ row.platforms.join('、') }}</span>
                  <span v-else class="product-orphan">未挂载</span>
                </td>
                <td>{{ row.variantCount }} 个</td>
                <td>{{ priceRange(row) }}</td>
                <td>{{ row.stockTotal == null ? '—' : row.stockTotal }}</td>
                <td>{{ formatTime(row.updatedAt) }}</td>
                <td class="product-actions">
                  <button type="button" class="unified-button ghost" :data-test="'local-edit-' + row.id" :disabled="busy" @click="openEditor(row)">
                  <img class="button-icon" :src="manualEditIcon" alt="" />编辑</button>
                  <button type="button" class="unified-button ghost" :data-test="'local-copy-' + row.id" :disabled="busy" @click="duplicateProduct(row)">
                  <img class="button-icon" :src="batchHandleStoreIcon" alt="" />复制</button>
                  <button type="button" class="unified-button ghost" :data-test="'local-localize-' + row.id" :disabled="busy" @click="localizeMedia(row)">
                  <img class="button-icon" :src="downloadImageIcon" alt="" />下载图片到本地</button>
                  <button type="button" class="unified-button ghost" :data-test="'local-preflight-' + row.id" :disabled="busy" @click="runPreflight(row)">
                  <img class="button-icon" :src="preflightIcon" alt="" />发布预检</button>
                  <button v-if="row.status === 'archived'" type="button" class="unified-button ghost" :data-test="'local-unarchive-' + row.id" :disabled="busy" @click="setArchived(row, false)">
                  <img class="button-icon" :src="acceptIcon" alt="" />取消归档</button>
                  <button v-else type="button" class="unified-button ghost" :data-test="'local-archive-' + row.id" :disabled="busy" @click="setArchived(row, true)">
                  <img class="button-icon" :src="publishAbandonIcon" alt="" />归档</button>
                  <button type="button" class="unified-button ghost" :disabled="busy" @click="removeLocal(row)">
                  <img class="button-icon" :src="cleanupIcon" alt="" />删除</button>
                </td>
              </tr>
            </tbody>
          </table>
          <ProductPager :total="localTotal" :limit="localQuery.limit" :offset="localQuery.offset" @page="onLocalPage" />

          <!-- 批量条（v4 §3.5：多选 → 操作 → 预览 → 确认 → 回执） -->
          <div v-if="selectedIds.size" class="batch-bar" data-test="batch-bar">
            <span class="batch-count">已选 {{ selectedIds.size }} 项</span>
            <button type="button" class="unified-button ghost" data-test="batch-op-price" :disabled="busy" @click="openBatch('price')">批量改价</button>
            <button type="button" class="unified-button ghost" data-test="batch-op-tags-add" :disabled="busy" @click="openBatch('tags.add')">加标签</button>
            <button type="button" class="unified-button ghost" data-test="batch-op-archive" :disabled="busy" @click="openBatch('archive')">归档</button>
            <button type="button" class="unified-button ghost" data-test="batch-op-unarchive" :disabled="busy" @click="openBatch('unarchive')">取消归档</button>
            <button type="button" class="unified-button ghost" data-test="batch-op-export" :disabled="busy" @click="exportCsv('selected')">导出选中</button>
            <button type="button" class="unified-button ghost danger" data-test="batch-op-delete" :disabled="busy" @click="openBatch('delete')">删除</button>
            <button type="button" class="inline-link" data-test="batch-clear" @click="clearSelection">清除选择</button>
          </div>

          <!-- 批量操作面板：参数 → 预览 diff → 确认执行 → 回执 -->
          <div v-if="batchOp" class="batch-panel" data-test="batch-panel">
            <div class="batch-panel-head">
              <strong>{{ batchOpLabel }}</strong>
              <button type="button" class="inline-link" data-test="batch-panel-close" @click="closeBatch">关闭</button>
            </div>
            <div v-if="batchOp === 'price'" class="batch-params">
              <label class="product-field"><span>模式</span>
                <select v-model="batchParams.mode" data-test="batch-price-mode" class="product-select">
                  <option value="percent">按百分比 ±%</option>
                  <option value="fixed">按固定金额 ±元</option>
                </select>
              </label>
              <label class="product-field"><span>数值（负数 = 降价）</span>
                <input v-model="batchParams.valueText" type="text" data-test="batch-price-value" placeholder="-10" />
              </label>
              <label class="product-field"><span>最低价保护（元，默认 0.01）</span>
                <input v-model="batchParams.floorText" type="text" data-test="batch-price-floor" placeholder="0.01" />
              </label>
            </div>
            <div v-if="batchOp === 'tags.add' || batchOp === 'tags.remove'" class="batch-params">
              <label class="product-field"><span>标签（竖线 | 分隔，≤10 个）</span>
                <input v-model="batchTagsText" type="text" data-test="batch-tags-input" placeholder="清仓|下架" />
              </label>
            </div>
            <div v-if="batchOp === 'delete'" class="product-empty-hint">删除是软删（进回收站可恢复），单次 ≤100 个。</div>
            <div class="batch-actions">
              <button type="button" class="unified-button" data-test="batch-preview" :disabled="busy" @click="runBatchPreview">{{ busy ? '计算中…' : '预览影响面' }}</button>
              <button v-if="batchPreview" type="button" class="unified-button primary" data-test="batch-execute" :disabled="busy || !batchPreview.affected" @click="runBatchExecute">确认执行（{{ batchPreview.affected }} 项）</button>
            </div>
            <div v-if="batchPreview" class="batch-preview" data-test="batch-preview-result">
              <div>影响 <b>{{ batchPreview.affected }}</b> 项；跳过 <b>{{ batchPreview.skipped.length }}</b> 项。</div>
              <div v-for="item in batchPreview.sample" :key="item.id" class="batch-sample" :data-test="'batch-sample-' + item.id">
                <span class="product-title">{{ item.title }}</span><span>{{ item.detail }}</span>
              </div>
              <div v-for="item in batchPreview.skipped" :key="'skip-' + item.id" class="batch-skip">
                <span class="product-title">{{ item.title }}</span><span>跳过：{{ item.reason }}</span>
              </div>
            </div>
            <div v-if="batchOutcome" class="batch-preview" data-test="batch-result">
              <div>回执：成功 <b>{{ batchOutcome.succeeded }}</b> / 跳过 <b>{{ batchOutcome.skipped.length }}</b> / 失败 <b>{{ batchOutcome.failed.length }}</b>。改价/标签不提供撤销——可反向再调一次。</div>
              <div v-for="item in batchOutcome.failed" :key="'fail-' + item.id" class="batch-skip">
                <span class="product-title">{{ item.title }}</span><span>失败：{{ item.message }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 导入预览/回执（放在表格外：空列表也要能导入建品） -->
        <div v-if="importPlan" class="batch-panel" data-test="import-panel">
          <div class="batch-panel-head">
            <strong>CSV 导入预览</strong>
            <button type="button" class="inline-link" data-test="import-close" @click="importPlan = null">关闭</button>
          </div>
          <div class="batch-preview" data-test="import-preview">
            <div>新增 <b>{{ importPlan.creates.length }}</b> / 更新 <b>{{ importPlan.updates.length }}</b> / 冲突 <b>{{ importPlan.conflicts.length }}</b>。更新为字段级（只写有值的列）；新增按行建品（不带图片）。</div>
            <div v-for="item in importPlan.updates.slice(0, 20)" :key="item.productId" class="batch-sample" :data-test="'import-update-' + item.rowNumber">
              <span class="product-title">{{ item.title }}</span><span>{{ item.changes.map(change => `${change.field}: ${change.before || '—'} → ${change.after}`).join('；') }}</span>
            </div>
            <div v-for="item in importPlan.creates.slice(0, 20)" :key="'c' + item.rowNumber" class="batch-sample">
              <span class="product-title">{{ item.title }}</span><span>将新建</span>
            </div>
            <div v-for="item in importPlan.conflicts" :key="'x' + item.rowNumber" class="batch-skip" :data-test="'import-conflict-' + item.rowNumber">
              <span class="product-title">第 {{ item.rowNumber }} 行 {{ item.title }}</span><span>{{ item.reason }}</span>
            </div>
          </div>
          <div class="batch-actions">
            <button type="button" class="unified-button primary" data-test="import-execute-inner"
                    :disabled="busy || (!importPlan.creates.length && !importPlan.updates.length)"
                    @click="runImportExecute">确认导入（{{ importPlan.creates.length + importPlan.updates.length }} 项）</button>
          </div>
        </div>

        <div v-if="localRows.length" class="product-toolbar" style="margin-top:10px">
          <button type="button" class="unified-button ghost" :data-test="'batch-create'" :disabled="busy" @click="createBatch">
          <img class="button-icon" :src="publishIcon" alt="" />批量发布（全部 × 在线店铺）</button>
          <button type="button" class="unified-button ghost" :data-test="'media-queue-scan'" :disabled="busy" @click="scanMediaQueue">
          <img class="button-icon" :src="scanQueueIcon" alt="" />扫图片队列</button>
          <button type="button" class="unified-button ghost" :data-test="'media-queue-run'" :disabled="busy" @click="runMediaQueue">
          <img class="button-icon" :src="downloadImageIcon" alt="" />跑队列（20 张）</button>
          <button type="button" class="unified-button ghost" :data-test="'media-orphans'" :disabled="busy" @click="scanOrphans">
          <img class="button-icon" :src="cleanupIcon" alt="" />查孤儿文件</button>
        </div>
      </template>

      <!-- ============================================================ 平台商品 -->
      <template v-else-if="tab === 'platform'">
        <div class="sync-strip">
          <article v-for="store in ws.stores" :key="store.id" class="sync-store">
            <PlatformIcon :name="store.platform" :size="30" />
            <div class="sync-store-copy">
              <strong>{{ store.name }}</strong>
              <span>{{ store.platform }} · {{ storeSyncText(store) }}</span>
            </div>
            <span class="unified-status" :class="storeStatusClass(store.status)"><i></i>{{ storeStatusLabelOf(store.status) }}</span>
            <button type="button" class="unified-button ghost" :data-test="'product-sync-' + store.id" :disabled="!!syncingStoreId" @click="syncStore(store)">
              <img class="button-icon" :src="productSyncIcon" alt="" />{{ syncingStoreId === store.id ? '同步中…' : '同步商品' }}
            </button>
            <button type="button" class="unified-button ghost" @click="emit('open-store', store.id)">
              <img class="button-icon" :src="externalIcon" alt="" />打开店铺后台</button>
          </article>
        </div>

        <div class="product-toolbar">
          <input class="product-search" type="search" v-model="linkQuery.keyword" data-test="platform-search"
                 placeholder="搜索 标题 / 平台商品 ID / 本地归属…" @input="onLinkSearchInput" />
          <select class="product-select" v-model="linkQuery.storeId" data-test="platform-filter-store" @change="applyLinkFilters">
            <option value="">全部店铺</option>
            <option v-for="store in ws.stores" :key="store.id" :value="store.id">{{ store.name }}</option>
          </select>
          <select class="product-select" v-model="linkQuery.platform" data-test="platform-filter-platform" @change="applyLinkFilters">
            <option value="">全部平台</option>
            <option v-for="platform in platformOptions" :key="platform" :value="platform">{{ platform }}</option>
          </select>
          <select class="product-select" v-model="linkQuery.platformStatus" data-test="platform-filter-status" @change="applyLinkFilters">
            <option value="">全部平台状态</option>
            <option value="on_sale">在售</option>
            <option value="off_shelf">已下架</option>
            <option value="auditing">审核中</option>
            <option value="violation">违规</option>
            <option value="missing">平台上已消失</option>
            <option value="unknown">未知</option>
          </select>
          <label class="product-check"><input type="checkbox" v-model="linkQuery.onlyOrphan" data-test="platform-only-orphan" @change="applyLinkFilters" />只看未归并</label>
          <select class="product-select" v-model="linkQuery.sort" data-test="platform-sort" @change="applyLinkFilters">
            <option value="collected">按采集时间</option>
            <option value="platformUpdated">按平台更新时间</option>
            <option value="title">按标题</option>
            <option value="price">按价格</option>
          </select>
          <button type="button" class="unified-button ghost" data-test="platform-sort-order" @click="toggleLinkOrder">{{ linkQuery.order === 'desc' ? '降序 ↓' : '升序 ↑' }}</button>
          <span class="product-toolbar-hint" data-test="platform-count">共 {{ linkTotal }} 条<template v-if="orphanTotal"> · 其中 {{ orphanTotal }} 条未归并</template></span>
        </div>

        <div v-if="linkLoading" class="unified-state"><span class="loader"></span>正在读取商品…</div>
        <div v-else-if="!linkRows.length" class="unified-empty">
          <span>还没有同步到平台商品。</span>
          <span class="product-empty-hint">点上面的「同步商品」从平台拉取；未实测的平台会明确说明原因，不会假装有数据。</span>
        </div>
        <div v-else class="product-table-wrap">
          <table class="product-table">
            <thead><tr><th>平台 / 店铺</th><th>商品</th><th>价格</th><th>库存</th><th>平台状态</th><th>本地归属</th><th>采集时间</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="row in linkRows" :key="row.linkId" :data-test="'product-row-' + row.platformProductId">
                <td><span class="product-platform">{{ row.platform }}</span><small>{{ row.storeName }}</small></td>
                <td><span class="product-title">{{ row.platformTitle || '标题未取到' }}</span><small>ID: {{ row.platformProductId }}</small></td>
                <td>{{ formatMinor(row.platformPriceMinor) }}</td>
                <td>{{ row.platformStock == null ? '未取到' : row.platformStock }}</td>
                <td>{{ productStatusLabel(row.platformStatus || 'unknown') }}</td>
                <td>
                  <template v-if="row.productTitle">{{ row.productTitle }}</template>
                  <template v-else>
                    <span class="product-orphan">未归并</span>
                    <!-- 归并**必须由用户点**（方案 D2：绝不自动合并） -->
                    <button type="button" class="unified-button ghost" :data-test="'product-detail-' + row.platformProductId"
                            :disabled="busy" @click="collectDetail(row)">
                    <img class="button-icon" :src="scanQueueIcon" alt="" />拉取详情</button>
                    <button type="button" class="unified-button ghost" :data-test="'product-save-as-' + row.platformProductId"
                            :disabled="busy" @click="saveAsLocal(row)">
                    <img class="button-icon" :src="downloadImageIcon" alt="" />另存为本地商品</button>
                  </template>
                </td>
                <td>{{ formatTime(row.collectedAt) }}</td>
                <td class="product-actions">
                  <button type="button" class="unified-button ghost" v-if="row.productId" :disabled="busy" @click="switchTab('local')">在本地商品里管理</button>
                  <!-- 解除归并：`products.list` 每行本就带 linkId/productId，此前渲染层没有入口（只能挂不能摘）。
                       未归并或缺 linkId 的行不渲染（`canUnmerge` 判定），避免"点了没反应"的假按钮。 -->
                  <button v-if="canUnmergeLink(row)" type="button" class="unified-button ghost"
                          data-test="platform-unmerge" :disabled="busy || unmergeBusy" @click="askUnmerge(row)">解除归并</button>
                </td>
              </tr>
            </tbody>
          </table>
          <ProductPager :total="linkTotal" :limit="linkQuery.limit" :offset="linkQuery.offset" @page="onLinkPage" />
        </div>
      </template>

      <!-- ============================================================ 回收站 -->
      <template v-else>
        <div class="product-toolbar">
          <input class="product-search" type="search" v-model="trashQuery.keyword" data-test="trash-search"
                 placeholder="搜索已删除商品的标题…" @input="onTrashSearchInput" />
          <button type="button" class="unified-button ghost" @click="loadTrash"><img class="button-icon" :src="syncIcon" alt="" />刷新</button>
          <span class="product-toolbar-hint" data-test="trash-count">共 {{ trashTotal }} 条</span>
        </div>
        <div class="product-toolbar-hint" style="margin:-4px 0 10px">
          删除是软删（发布台账保留）。恢复后**不会自动恢复平台归并**——原来的平台商品留在「未归并」，需要时重新归并。
        </div>
        <div v-if="trashLoading" class="unified-state"><span class="loader"></span>正在读取回收站…</div>
        <div v-else-if="!trashRows.length" class="unified-empty" data-test="trash-empty"><span>回收站是空的。</span></div>
        <div v-else class="product-table-wrap">
          <table class="product-table">
            <thead><tr><th>标题</th><th>删除前状态</th><th>规格</th><th>发布记录</th><th>删除时间</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="row in trashRows" :key="row.id" :data-test="'trash-row-' + row.id">
                <td><span class="product-title">{{ row.title || '（无标题）' }}</span></td>
                <td>{{ statusChipLabel(row.status) }}</td>
                <td>{{ row.variantCount }} 个</td>
                <td>{{ row.publishJobCount ? `${row.publishJobCount} 条（保留）` : '无' }}</td>
                <td>{{ formatTime(row.deletedAt) }}</td>
                <td class="product-actions">
                  <button type="button" class="unified-button ghost" :data-test="'trash-restore-' + row.id" :disabled="busy" @click="restoreProduct(row)">
                  <img class="button-icon" :src="acceptIcon" alt="" />恢复</button>
                  <button type="button" class="unified-button ghost" :data-test="'trash-purge-' + row.id"
                          :disabled="busy || !!row.publishJobCount"
                          :title="row.publishJobCount ? `有 ${row.publishJobCount} 条发布记录（审计材料），不能彻底删除` : '彻底删除（不可恢复；磁盘文件交孤儿清理）'"
                          @click="purgeProduct(row)">
                  <img class="button-icon" :src="cleanupIcon" alt="" />彻底删除</button>
                </td>
              </tr>
            </tbody>
          </table>
          <ProductPager :total="trashTotal" :limit="trashQuery.limit" :offset="trashQuery.offset" @page="onTrashPage" />
        </div>
      </template>
    </template>

    <!-- ============================================================ 发布预检（M3） -->
    <div v-if="preflight" class="product-table-wrap" :data-test="'publish-preflight'">
      <div class="product-table-head">
        <h2>发布预检 · {{ preflight.storeName }}</h2>
        <span :class="'verdict-' + preflight.precheck.verdict">{{ preflight.precheck.summary }}</span>
      </div>
      <table class="product-table">
        <thead><tr><th>字段</th><th>本地值</th><th>平台当前值</th><th>上次发布值</th><th>本次动作</th></tr></thead>
        <tbody>
          <tr v-for="field in preflight.precheck.fields" :key="field.field" :data-test="'preflight-field-' + field.field">
            <td>{{ field.label }}</td>
            <td>{{ field.localValue ?? '—' }}</td>
            <td>{{ field.platformValue ?? '（还没读页面）' }}</td>
            <td>{{ field.lastValue ?? '—' }}</td>
            <td :class="'issue-' + field.level">
              {{ fieldActionLabel(field.action) }}
              <small v-if="field.note">{{ field.note }}</small>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="preflight.precheck.blockers.length" class="product-issues">
        <div v-for="(issue, index) in preflight.precheck.blockers" :key="index" class="issue-blocker">
          <b>阻断</b><span>{{ issue.message }}</span><small v-if="issue.fixHint">{{ issue.fixHint }}</small>
        </div>
      </div>
      <div v-if="preflight.precheck.warnings.length" class="product-issues">
        <div v-for="(issue, index) in preflight.precheck.warnings" :key="index" class="issue-warning">
          <b>提醒</b><span>{{ issue.message }}</span><small v-if="issue.fixHint">{{ issue.fixHint }}</small>
        </div>
      </div>
      <p v-if="preflight.precheck.missingRequired.length" class="product-more">
        本地还缺这些必填项：{{ preflight.precheck.missingRequired.join('、') }}（下次发布前补全会更省事）
      </p>
      <div class="product-drawer-actions" style="padding:12px 16px">
        <button type="button" class="unified-button primary" :data-test="'publish-open-page'"
                :disabled="busy || preflight.precheck.verdict === 'blocked'" @click="openPublishPage(false)">
                <img class="button-icon" :src="externalIcon" alt="" />打开平台发布页</button>
        <button type="button" class="unified-button ghost" :data-test="'publish-open-fill'"
                :disabled="busy || preflight.precheck.verdict === 'blocked'" @click="openPublishPage(true)">
                <img class="button-icon" :src="publishIcon" alt="" />打开并预填（L1）</button>
            <button type="button" class="unified-button ghost" :data-test="'publish-open-gate'" :disabled="busy" @click="openGate"><img class="button-icon" :src="publishGateIcon" alt="" />开人工确认门禁</button>
        <button type="button" class="unified-button ghost" :data-test="'publish-confirm'" :disabled="busy" @click="confirmSubmitted(true)"><img class="button-icon" :src="publishConfirmIcon" alt="" />我已提交</button>
        <button type="button" class="unified-button ghost" :data-test="'publish-readback'" :disabled="busy" @click="runReadback">
        <img class="button-icon" :src="scanQueueIcon" alt="" />回读页面实际值</button>
        <button type="button" class="unified-button ghost" :disabled="busy" @click="confirmSubmitted(false)"><img class="button-icon" :src="publishAbandonIcon" alt="" />放弃这次发布</button>
        <button type="button" class="unified-button ghost" @click="preflight = null"><img class="button-icon" :src="panelCloseIcon" alt="" />关闭</button>
        <span class="product-empty-hint">应用**不会**替你点提交：页面填完后由你自己提交。</span>
      </div>
    </div>

    <!-- ============================================================ 图片队列与孤儿清理 -->
    <div v-if="mediaQueue" class="product-table-wrap" :data-test="'media-queue-panel'">
      <div class="product-table-head">
        <h2>图片本地化队列 / 保留策略</h2>
        <span :data-test="'media-queue-summary'">{{ mediaQueue.summary }}</span>
      </div>
      <p v-if="mediaQueue.items.length" class="product-more">
        队列 {{ mediaQueue.items.length }} 项，其中会真的下载 {{ mediaQueue.items.filter(i => i.shouldAttempt).length }} 项
        <template v-if="mediaQueue.items.some(i => !i.shouldAttempt)">
          ；不重试的：{{ mediaQueue.items.filter(i => !i.shouldAttempt).slice(0, 2).map(i => i.reason).join('；') }}
        </template>
      </p>
      <div v-if="mediaQueue.orphans" class="product-issues">
        <div :class="mediaQueue.orphans.orphans.length ? 'issue-warning' : 'issue-info'">
          <b>孤儿文件</b><span :data-test="'media-orphan-summary'">{{ mediaQueue.orphans.summary }}</span>
          <small>判定：不在商品媒体表里、且超过 24 小时宽限期。清理只删应用自己的 product-media 目录里的文件。</small>
        </div>
        <div class="product-drawer-actions">
          <button type="button" class="unified-button ghost" :data-test="'media-cleanup'" :disabled="busy || !mediaQueue.orphans.orphans.length"
                  @click="cleanupOrphans">
                  <img class="button-icon" :src="cleanupIcon" alt="" />确认清理（{{ mediaQueue.orphans.orphans.length }} 个）</button>
        </div>
      </div>
      <div class="product-drawer-actions" style="padding:12px 16px">
        <button type="button" class="unified-button ghost" @click="mediaQueue = null">关闭</button>
        <span class="product-empty-hint">清理**只会删**应用自己目录里、且没有任何商品在用的文件。</span>
      </div>
    </div>

    <!-- ============================================================ 批量进度（M5） -->
    <div v-if="batch" class="product-table-wrap" :data-test="'publish-batch-panel'">
      <div class="product-table-head">
        <h2>批量发布进度</h2>
        <span :data-test="'batch-summary'">{{ batch.progress.summary }}</span>
      </div>
      <div class="product-issues" style="flex-direction:row;gap:18px">
        <div><b>已完成</b><span :data-test="'batch-done'">{{ batch.progress.done }}</span></div>
        <div><b>待人工</b><span :data-test="'batch-waiting'">{{ batch.progress.waitingHuman }}</span></div>
        <div><b>失败</b><span :data-test="'batch-failed'">{{ batch.progress.failed }}</span></div>
        <div><b>未开始</b><span>{{ batch.progress.pending }}</span></div>
        <div><b>已跳过</b><span>{{ batch.progress.skipped }}</span></div>
      </div>
      <p class="product-more">
        当前该处理的店铺：<b>{{ batch.progress.currentStoreId ? storeNameOf(batch.progress.currentStoreId) : '（没有待处理的店铺）' }}</b>
        —— 一次只打开一个店铺；应用**不会**替你点提交。
      </p>
      <table class="product-table">
        <thead><tr><th>店铺</th><th>项数</th><th>状态分布</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="store in ws.stores.filter(s => batchItemsOfStore(s.id).length)" :key="store.id" :data-test="'batch-store-' + store.id">
            <td>{{ store.name }}<small>{{ store.platform }}</small></td>
            <td>{{ batchItemsOfStore(store.id).length }}</td>
            <td>{{ statusCountsText(batchItemsOfStore(store.id)) }}</td>
            <td class="product-actions">
              <button type="button" class="unified-button ghost" :data-test="`batch-store-now-${store.id}`" :disabled="busy" @click="handleStoreNow(store.id)"><img class="button-icon" :src="batchHandleStoreIcon" alt="" />处理这家</button>
              <button type="button" class="unified-button ghost" :disabled="busy" @click="skipStore(store.id)"><img class="button-icon" :src="batchSkipStoreIcon" alt="" />跳过这家</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="product-drawer-actions" style="padding:12px 16px">
        <button type="button" class="unified-button ghost" :data-test="'batch-abort'" :disabled="busy" @click="pauseBatch"><img class="button-icon" :src="batchPauseIcon" alt="" />全部暂停</button>
        <button type="button" class="unified-button ghost" :disabled="busy" @click="loadBatch">
        <img class="button-icon" :src="syncIcon" alt="" />刷新进度</button>
        <button type="button" class="unified-button ghost" @click="batch = null"><img class="button-icon" :src="bulkPanelCloseIcon" alt="" />关闭</button>
      </div>
    </div>

    <!-- ============================================================ 回读建议（M4） -->
    <div v-if="readback" class="product-table-wrap" :data-test="'publish-readback-panel'">
      <div class="product-table-head">
        <h2>回读建议（页面上实际填的值 vs 本地）</h2>
        <span>读到的字段：{{ readback.readFields.join('、') || '无' }}<template v-if="readback.missingFields.length">；页面上没有：{{ readback.missingFields.join('、') }}</template></span>
      </div>
      <div v-if="!readback.suggestions.length" class="unified-empty"><span>没有可显示的建议。</span></div>
      <table v-else class="product-table">
        <thead><tr><th>字段</th><th>本地值</th><th>页面上的值</th><th>判断</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="item in readback.suggestions" :key="item.field" :data-test="'readback-' + item.field">
            <td>{{ item.label }}</td>
            <td>{{ item.localValue ?? '—' }}</td>
            <td>{{ item.platformValue ?? '—' }}</td>
            <td><span class="product-orphan">{{ suggestionKindLabel(item.kind) }}</span><small>{{ item.note }}</small></td>
            <td class="product-actions">
              <button v-if="item.kind === 'suggest_default' || item.kind === 'suggest_writeback'" type="button"
                      class="unified-button ghost" :data-test="'readback-accept-' + item.field" :disabled="busy"
                      @click="acceptSuggestion(item)">
                      <img class="button-icon" :src="acceptIcon" alt="" />接受</button>
              <span v-else class="product-empty-hint">无需处理</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="product-drawer-actions" style="padding:12px 16px">
        <button type="button" class="unified-button ghost" @click="readback = null"><img class="button-icon" :src="bulkPanelCloseIcon" alt="" />关闭</button>
        <span class="product-empty-hint">应用**不会**自动改本地：只有你点了「接受」的条目才会落库。</span>
      </div>
    </div>

    <!-- 解除归并二次确认（页面内浮层，不用 window.confirm：会阻塞渲染进程、卡 CDP 验收） -->
    <div v-if="unmergeTarget" class="product-confirm-mask" data-test="unmerge-confirm-mask" @click.self="cancelUnmerge">
      <section class="product-confirm" role="dialog" aria-modal="true" aria-label="解除归并" data-test="unmerge-confirm">
        <h3>解除归并</h3>
        <p class="product-confirm-text" data-test="unmerge-confirm-text">{{ unmergeConfirmMessage }}</p>
        <div class="product-confirm-actions">
          <button type="button" class="unified-button ghost" data-test="unmerge-cancel" :disabled="unmergeBusy" @click="cancelUnmerge">取消</button>
          <button type="button" class="unified-button primary" data-test="unmerge-ok" :disabled="unmergeBusy" @click="confirmUnmerge">{{ unmergeBusy ? '解除中…' : '确认解除' }}</button>
        </div>
      </section>
    </div>

    <!-- 编辑抽屉（自加载；保存后刷新列表；归档态由列表行状态驱动只读） -->
    <ProductEditorDrawer v-if="editingId" :product-id="editingId" :status="editingStatus" @close="editingId = null" @saved="onEditorSaved" @unarchive="onEditorUnarchive" />
  </section>
</template>

<style scoped>
.unified-page{min-width:0;min-height:0;height:100%;overflow:auto;padding:22px 24px 32px;color:var(--dash-text)}
.unified-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:14px}
.unified-page-head h1{margin:5px 0 7px;font-size:25px}
.unified-page-head p{margin:0;color:var(--dash-text-muted);font-size:12px}
.product-head-actions{display:flex;gap:8px;flex-shrink:0}
.unified-button{display:inline-flex;align-items:center;min-height:34px;padding:0 13px;border:1px solid var(--dash-border);border-radius:9px;background:#ffffff;color:var(--dash-text-soft);cursor:pointer;font-size:13px}
.unified-button:hover,.unified-button:focus-visible{border-color:rgba(151,120,255,.7);color:var(--dash-text);outline:2px solid rgba(151,120,255,.35);outline-offset:1px}
.unified-button.primary{border-color:#5b3df5;background:#6d4aff;color:#ffffff}
.unified-button.ghost{min-height:26px;padding:0 9px;font-size:11px}
.unified-button:disabled{opacity:.55;cursor:default}
.button-icon{width:15px;height:15px;object-fit:contain;vertical-align:-3px;margin-right:5px}
.unified-alert{display:flex;flex-direction:column;gap:5px;padding:14px 16px;margin-bottom:14px;border:1px solid rgba(76,157,255,.23);border-radius:11px;background:rgba(33,91,158,.12);color:var(--dash-text-soft);font-size:12px}
.unified-alert strong{color:#1d4ed8}
.unified-state,.unified-empty{display:flex;min-height:150px;align-items:center;justify-content:center;gap:12px;flex-direction:column;border:1px dashed var(--dash-border);border-radius:12px;color:var(--dash-text-muted);font-size:12px}
.loader{width:14px;height:14px;border:2px solid var(--dash-border);border-top-color:#7c5cff;border-radius:50%;animation:product-spin .8s linear infinite;display:inline-block}
@keyframes product-spin{to{transform:rotate(360deg)}}
.inline-link{border:0;background:transparent;color:#7c5cff;cursor:pointer}
.product-summary-bar{display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.summary-chip{display:inline-flex;align-items:center;gap:8px;min-height:34px;padding:0 14px;border:1px solid var(--dash-border);border-radius:10px;background:#fff;color:var(--dash-text-soft);font-size:12px;cursor:pointer}
.summary-chip b{font-size:15px}
.summary-chip.active{border-color:rgba(109,74,255,.55);box-shadow:0 0 0 2px rgba(109,74,255,.12)}
.summary-chip.warn b{color:#b54708}
.product-tabs{display:flex;gap:6px;margin-bottom:12px;border-bottom:1px solid var(--dash-border)}
.product-tabs button{min-height:32px;padding:0 14px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dash-text-muted);font-size:13px;cursor:pointer}
.product-tabs button.active{border-bottom-color:#6d4aff;color:var(--dash-text)}
.product-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.product-toolbar-hint{color:var(--dash-text-muted);font-size:11px}
.product-search{min-height:32px;width:280px;padding:0 10px;border:1px solid var(--dash-border);border-radius:8px;font-size:12px;color:var(--dash-text)}
.product-select{min-height:32px;padding:0 8px;border:1px solid var(--dash-border);border-radius:8px;font-size:12px;color:var(--dash-text);background:#fff}
.product-check{display:inline-flex;align-items:center;gap:5px;color:var(--dash-text-soft);font-size:12px;cursor:pointer}
.product-table-wrap{margin-top:6px;margin-bottom:16px;border:1px solid var(--dash-border);border-radius:12px;background:#fff;overflow:hidden}
.product-table-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--dash-border)}
.product-table-head h2{margin:0;font-size:14px}
.product-table-head span{color:var(--dash-text-muted);font-size:11px}
.product-empty-hint{color:var(--dash-text-muted);font-size:11px}
.product-table{width:100%;border-collapse:collapse;font-size:12px}
.product-table th{padding:9px 12px;border-bottom:1px solid var(--dash-border);color:var(--dash-text-muted);font-size:11px;font-weight:500;text-align:left;white-space:nowrap}
.product-table td{padding:10px 12px;border-bottom:1px solid rgba(0,0,0,.05);vertical-align:top}
.product-table tr:last-child td{border-bottom:0}
.product-table small{display:block;margin-top:3px;color:var(--dash-text-muted);font-size:10px}
.th-thumb{width:52px}
.product-thumb{width:40px;height:40px;border:1px solid var(--dash-border);border-radius:8px;background:#f7f8fa;display:flex;align-items:center;justify-content:center;overflow:hidden}
.product-thumb img{width:100%;height:100%;object-fit:cover}
.thumb-state{color:var(--dash-text-muted);font-size:9px;line-height:1.2;text-align:center;padding:0 2px}
.status-chip{display:inline-flex;align-items:center;min-height:20px;padding:0 8px;border-radius:999px;font-size:11px;border:1px solid var(--dash-border);background:#f9fafb;color:var(--dash-text-soft)}
.status-chip.chip-draft{background:#fef3f2;border-color:#fecdca;color:#b42318}
.status-chip.chip-ready{background:#ecfdf3;border-color:#abefc6;color:#027a48}
.status-chip.chip-archived{background:#f2f4f7;border-color:#e4e7ec;color:#475467}
.product-platform{font-weight:500}
.product-title{display:block;max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.product-more{margin:0;padding:10px 16px;color:var(--dash-text-muted);font-size:11px}
.product-orphan{color:var(--dash-text-muted)}
.product-actions{display:flex;gap:6px;flex-wrap:wrap;max-width:340px}
.sync-strip{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}
.sync-store{display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px solid var(--dash-border);border-radius:11px;background:#fff}
.sync-store-copy{display:flex;min-width:0;flex:1;flex-direction:column;gap:3px}
.sync-store-copy span{overflow:hidden;color:var(--dash-text-muted);font-size:11px;text-overflow:ellipsis;white-space:nowrap}
.unified-status{display:flex;align-items:center;gap:5px;color:var(--dash-text-muted);font-size:10px}
.unified-status i{width:7px;height:7px;border-radius:50%;background:#98a2b3}
.unified-status.online{color:#027a48}
.unified-status.online i{background:#12b76a}
.unified-status.warning{color:#b54708}
.unified-status.warning i{background:#f79009}
.product-issues{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--dash-border);border-radius:10px;background:#fbfcfe;font-size:11px}
.product-issues b{margin-right:6px}
.product-issues small{display:block;margin-top:2px;color:var(--dash-text-muted)}
.issue-blocker b{color:#b42318}.issue-warning b{color:#b54708}.issue-info b{color:#175cd3}
.verdict-ready{color:#027a48}.verdict-ready_with_warnings{color:#b54708}.verdict-blocked{color:#b42318}
.product-drawer-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}

/* ---- R3 批量条 / 面板 / 多选列 ---- */
.th-check{width:34px;text-align:center}
.th-check input{cursor:pointer}
.batch-bar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:10px;padding:10px 12px;border:1px solid #cabfff;border-radius:10px;background:#f5f2ff}
.batch-count{font-size:12px;font-weight:600;color:#4c3ad0;margin-right:4px}
.batch-panel{margin-top:10px;padding:14px;border:1px solid var(--dash-border);border-radius:12px;background:#fbfcfe;display:flex;flex-direction:column;gap:10px}
.batch-panel-head{display:flex;align-items:center;justify-content:space-between}
.batch-params{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}
.batch-actions{display:flex;gap:8px}
.batch-preview{display:flex;flex-direction:column;gap:4px;padding:10px;border:1px solid var(--dash-border);border-radius:10px;background:#fff;font-size:11px;color:var(--dash-text)}
.batch-preview b{color:#4c3ad0}
.batch-sample,.batch-skip{display:flex;gap:8px;align-items:baseline;justify-content:space-between;border-top:1px dashed var(--dash-border);padding-top:4px}
.batch-skip{color:#b42318}
.unified-button.danger{color:#b42318}
.import-label{position:relative;overflow:hidden}
.import-label input[type=file]{position:absolute;inset:0;opacity:0;cursor:pointer}
.import-label.disabled{opacity:.5}

/* ---- 解除归并二次确认（页面内浮层，风格与本页其它卡片一致） ---- */
.product-confirm-mask{position:fixed;inset:0;z-index:240;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(15,23,41,.38)}
.product-confirm{width:min(520px,calc(100vw - 48px));max-height:min(560px,calc(100vh - 48px));overflow:auto;padding:20px;border:1px solid var(--dash-border);border-radius:18px;background:#fff;box-shadow:var(--shadow-pop)}
.product-confirm h3{margin:0 0 10px;font-size:17px;color:var(--dash-text)}
.product-confirm-text{margin:0;color:var(--dash-text);font-size:13px;line-height:1.7;white-space:pre-line}
.product-confirm-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}
</style>
