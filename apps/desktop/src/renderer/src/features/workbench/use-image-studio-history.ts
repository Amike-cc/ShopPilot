import { computed, ref, watch } from 'vue'

import { HISTORY_STORAGE_KEY, HISTORY_MAX_ITEMS, HISTORY_STORAGE_BUDGET, KIND_LABEL, type CreativeModeKey, type GeneratedImage, type ImageStudioGenerationApi } from './use-image-studio-generation'

/**
 * AI 商品图工作台 · 历史/会话域（从 UnifiedImageStudioPage.vue 原样外移，行为不变）。
 *
 * 历史列表、会话分组、localStorage 落盘（防抖 + 预算裁剪）与「保存/定位生成结果」。
 * 生成域状态由 useImageStudioGeneration 提供（同一 setup 内的对象引用，行为与原来一致）。
 */
export function useImageStudioHistory(gen: ImageStudioGenerationApi) {
  const historyImages = gen.historyImages
  const saveNotice = gen.saveNotice
  const saveNoticeError = gen.saveNoticeError
  const savedPath = gen.savedPath
  const generatedImages = gen.generatedImages
  const mode = gen.mode
  const prompt = gen.prompt
  const activeImage = gen.activeImage
  const activeImageIndex = gen.activeImageIndex
  const editPreset = gen.editPreset
  const editPresetOptions = gen.editPresetOptions
  const productName = gen.productName
  const restoringHistorySession = gen.restoringHistorySession
  const modeLabel = gen.modeLabel

const historyFilter = ref('all')
const historyPage = ref(1)
const historyPageSize = ref(10)
const historyTypes = [
  { key: 'all', label: '全部' },
  { key: 'create', label: '商品图创作' },
  { key: 'detail', label: '图文详情' },
  { key: 'edit', label: '自由编辑' },
  { key: 'replicate', label: '商品图复刻' },
  { key: 'quantity', label: '商品数量图' },
  { key: 'model', label: '模特图' },
  { key: 'model-profile', label: '模特形象' },
  { key: 'scene', label: '拍摄场景' }
]
const filteredHistory = computed(() => historyFilter.value === 'all' ? historyImages.value : historyImages.value.filter(item => item.mode === historyFilter.value))
const historySessionRecords = computed(() => {
  const grouped = new Map<string, { id: string; mode: CreativeModeKey; title: string; createdAt: number; items: GeneratedImage[] }>()
  for (const item of filteredHistory.value) {
    const id = item.sessionId || `${item.createdAt || 0}-${item.mode}`
    const current = grouped.get(id)
    if (current) current.items.push(item)
    else grouped.set(id, { id, mode: item.mode, title: item.title || modeLabel(item.mode), createdAt: item.createdAt || 0, items: [item] })
  }
  return [...grouped.values()]
})
const editSessionRecords = computed(() => {
  const grouped = new Map<string, { id: string; mode: CreativeModeKey; title: string; createdAt: number; items: GeneratedImage[] }>()
  for (const item of historyImages.value.filter(image => image.mode === 'edit')) {
    const id = item.sessionId || `${item.createdAt || 0}-${item.mode}`
    const current = grouped.get(id)
    if (current) current.items.push(item)
    else grouped.set(id, { id, mode: item.mode, title: item.title || '自由编辑', createdAt: item.createdAt || 0, items: [item] })
  }
  return [...grouped.values()].slice(0, 20)
})
const activeEditSessionId = computed(() => generatedImages.value[0]?.mode === 'edit' ? generatedImages.value[0].sessionId || '' : '')
const historySessions = computed(() => historySessionRecords.value.slice((historyPage.value - 1) * historyPageSize.value, historyPage.value * historyPageSize.value))
const historyPageCount = computed(() => Math.max(1, Math.ceil(historySessionRecords.value.length / historyPageSize.value)))
const saving = ref(false)
watch(historyImages, schedulePersistHistory, { deep: true })
function loadPersistedHistory() {
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY)
    if (!raw) {
      historyImages.value = []
      generatedImages.value = []
      return
    }
    const parsed = JSON.parse(raw)
    // 兼容两种落盘格式：v1 = 裸数组；v2 = { version, items }（P1-6 起按字节预算裁剪后写入）
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : []
    historyImages.value = list
      .filter((item: any) => item && typeof item.url === 'string' && typeof item.kind === 'string' && typeof item.mode === 'string')
      .slice(0, HISTORY_MAX_ITEMS) as GeneratedImage[]
    // 历史记录独立于当前创作会话；打开软件时不把旧结果误显示为本次生成结果。
    generatedImages.value = []
  } catch {
    // 损坏或不可用的历史数据不应阻塞创作页面。
    historyImages.value = []
    generatedImages.value = []
  }
}

let persistTimer: number | null = null
let storageWarningShown = false

/**
 * P1-6（2026-10-15 审查）：旧实现每次历史变化都同步 `JSON.stringify(全部历史)`——
 * 条目是 base64 data URL（数 MB/张），最多 500 张 = 数百 MB 序列化跑在主线程（卡顿）；
 * 且 localStorage 配额（约 5MB）几乎必然被击穿，失败又被空 catch 吞掉，
 * 表现为"历史看似在保存、重启后大面积消失"。现在：
 *   · 变更先防抖 800ms 再落盘（一批生成只写一次）；
 *   · 按字节预算（4MB）从新到旧收集"装得下的"条目，写 v2 信封格式；
 *   · 配额/写入失败不再静默：用页面已有的 saveNotice 明确提示（只提示一次）。
 */
function schedulePersistHistory(): void {
  if (typeof window === 'undefined') return
  if (persistTimer != null) window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    persistTimer = null
    persistHistory()
  }, 800)
}

function persistHistory(): void {
  try {
    const items: GeneratedImage[] = []
    let bytes = 0
    for (const item of historyImages.value) {
      const approxBytes = item?.url ? item.url.length + 160 : 160
      if (bytes + approxBytes > HISTORY_STORAGE_BUDGET) break
      items.push(item)
      bytes += approxBytes
    }
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({ version: 2, items }))
    storageWarningShown = false
  } catch {
    // 写入仍失败（配额满/隐私模式）：本次会话内保留结果，并明确告知用户
    if (!storageWarningShown) {
      storageWarningShown = true
      saveNotice.value = '本地历史存储空间不足：新的生成结果将只在本次会话内可见，请手动下载需要保留的图片'
      saveNoticeError.value = true
    }
  }
}
function formatHistoryDate(value: number) {
  if (!value) return '时间未知'
  return new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}
function openHistorySession(session: { mode: CreativeModeKey; items: GeneratedImage[] }) {
  if (!session.items.length) return
  const modeChanged = mode.value !== session.mode
  generatedImages.value = session.items
  activeImageIndex.value = 0
  if (session.mode === 'edit') prompt.value = session.items[0].prompt || ''
  restoringHistorySession.value = modeChanged
  mode.value = session.mode
  if (!modeChanged) restoringHistorySession.value = false
}
function applyEditPreset(key: string) {
  editPreset.value = key
  const preset = editPresetOptions.find(item => item.key === key)
  if (preset) prompt.value = preset.prompt
}
async function saveActiveImage() {
  const image = activeImage.value
  if (!image) return
  const match = /^data:([^;]+);base64,(.+)$/i.exec(image.url)
  if (!match) { saveNoticeError.value = true; saveNotice.value = '当前结果不是可保存的图片数据（供应商返回的是外部地址）'; return }
  saving.value = true; saveNotice.value = ''; saveNoticeError.value = false
  try {
    // 文件名带上类别：主图和详情页会存到同一个目录，不区分就分不清哪个是哪个
    const suggestedName = [productName.value.trim() || '商品图', KIND_LABEL[image.kind], image.model].filter(Boolean).join('-')
    const result = await window.shopilot.ai.saveImage({ b64Json: match[2], mimeType: match[1].toLowerCase(), suggestedName })
    if (!result.ok) throw new Error(result.error.message)
    if (result.data?.canceled) { saveNotice.value = '已取消保存'; return }
    savedPath.value = String(result.data?.path || '')
    saveNotice.value = `已保存：${savedPath.value}（${Math.round(Number(result.data?.bytes || 0) / 1024)} KB）`
  } catch (error: any) {
    saveNoticeError.value = true
    saveNotice.value = `保存失败：${error?.message || '未知错误'}`
  } finally { saving.value = false }
}

async function revealSavedImage() {
  if (!savedPath.value) return
  const result = await window.shopilot.ai.revealImage(savedPath.value)
  if (!result.ok) { saveNoticeError.value = true; saveNotice.value = `打开所在文件夹失败：${result.error.message}` }
}


  /** 卸载前把防抖中的历史立即落盘（原组件 onBeforeUnmount 的 persist 清理段）。 */
  function flushPendingPersist(): void {
    if (persistTimer != null) {
      window.clearTimeout(persistTimer)
      persistTimer = null
      persistHistory()
    }
  }

  return {
    historyFilter,
    historyPage,
    historyPageSize,
    historyTypes,
    filteredHistory,
    historySessionRecords,
    editSessionRecords,
    activeEditSessionId,
    historySessions,
    historyPageCount,
    saving,
    loadPersistedHistory,
    persistTimer,
    storageWarningShown,
    schedulePersistHistory,
    persistHistory,
    formatHistoryDate,
    openHistorySession,
    applyEditPreset,
    saveActiveImage,
    revealSavedImage,
    flushPendingPersist
  }
}

export type ImageStudioHistoryApi = ReturnType<typeof useImageStudioHistory>