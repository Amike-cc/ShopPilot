<template>
  <section class="asset-library-page" data-test="asset-library-page">
    <header class="al-head">
      <div class="al-brand">
        <button type="button" class="al-brand-mark" aria-label="返回首页" @click="emit('go-home')"><img :src="brandMark" alt="" /></button>
        <strong>ShopPilot</strong>
        <span class="al-brand-sub">素材库</span>
      </div>
      <div class="al-head-actions">
        <span class="al-count" data-test="asset-library-count">{{ libraryTotal }} 张素材<template v-if="capacityHint"> · 已用 {{ capacityHint }}</template></span>
        <button type="button" class="al-button ghost" data-test="asset-library-refresh" :disabled="loading || importing" @click="load(true)">
          <AppIcon name="refresh" :size="15" />刷新
        </button>
        <button type="button" class="al-button primary" data-test="asset-library-import" :disabled="importing" @click="fileInput?.click()">
          <AppIcon name="upload" :size="15" />{{ importing ? '导入中…' : '导入图片' }}
        </button>
      </div>
    </header>

    <div class="al-body" :class="{ dragging }" @dragenter.prevent="dragging = true" @dragover.prevent="dragging = true" @dragleave.prevent="onDragLeave" @drop.prevent="onDrop">
      <input ref="fileInput" hidden type="file" multiple accept="image/png,image/jpeg,image/webp" data-test="asset-library-file-input" @change="onFileChange" />

      <div class="al-toolbar">
        <label class="al-search">
          <AppIcon name="search" :size="15" />
          <input v-model="query" type="search" placeholder="搜索名称或标签" data-test="asset-library-search" />
        </label>
        <label class="al-select"><span>来源</span>
          <select v-model="sourceFilter" data-test="asset-library-source">
            <option value="all">全部来源</option>
            <option value="upload">本地上传</option>
            <option value="chat-image">AI 生成</option>
          </select>
        </label>
        <div class="al-tag-filter" data-test="asset-library-tags">
          <button type="button" :class="{ active: !tagFilter }" @click="tagFilter = ''">全部标签</button>
          <button v-for="tag in allTags.slice(0, 12)" :key="tag" type="button" :class="{ active: tagFilter === tag }" @click="tagFilter = tagFilter === tag ? '' : tag">{{ tag }}</button>
        </div>
      </div>

      <div v-if="loadError" class="al-notice error" role="alert" data-test="asset-library-error">{{ loadError }}</div>
      <div v-else-if="notice" class="al-notice" :class="{ error: noticeIsError }" role="status" data-test="asset-library-notice">{{ notice }}</div>

      <div v-if="loading && !items.length" class="al-loading" role="status">正在读取素材库…</div>

      <div v-else-if="!libraryTotal" class="al-empty" data-test="asset-library-empty">
        <div class="al-empty-mark" aria-hidden="true"><AppIcon name="image" :size="28" /></div>
        <h1>把常用图片收进一个库</h1>
        <p>导入商品图、场景图或对话生图的结果，按名称和标签检索；详情里可一键作为「对话生图」的下一轮参考图。</p>
        <button type="button" class="al-button primary" data-test="asset-library-empty-import" @click="fileInput?.click()">导入第一张图片</button>
        <span class="al-empty-hint">支持 PNG / JPEG / WebP，单张不超过 20MB</span>
      </div>

      <template v-else>
        <div class="al-result-line">
          <span>{{ total }} 张符合条件<template v-if="items.length < total">（已显示 {{ items.length }}）</template></span>
          <button v-if="query || sourceFilter !== 'all' || tagFilter" type="button" @click="clearFilters">清除筛选</button>
        </div>
        <div v-if="!items.length" class="al-empty compact" data-test="asset-library-no-match">
          <div class="al-empty-mark" aria-hidden="true"><AppIcon name="search" :size="24" /></div>
          <h1>没有匹配的素材</h1>
          <p>换个关键词或清除筛选再试。</p>
        </div>
        <div v-else class="al-grid" data-test="asset-library-grid">
          <article
            v-for="item in items"
            :key="item.id"
            class="al-card"
            :data-test="`asset-library-item-${item.id}`"
            tabindex="0"
            @click="openDetail(item)"
            @keydown.enter="openDetail(item)"
          >
            <div class="al-thumb">
              <img v-if="item.thumbUrl" :src="item.thumbUrl" :alt="item.name" loading="lazy" />
              <span v-else class="al-thumb-fallback"><AppIcon name="image" :size="24" /></span>
              <span class="al-source" :class="item.source">{{ sourceLabel(item.source) }}</span>
            </div>
            <div class="al-card-body">
              <strong :title="item.name">{{ item.name }}</strong>
              <span class="al-meta">{{ item.width }}×{{ item.height }} · {{ formatAssetSize(item.size) }}</span>
              <div v-if="item.tags.length" class="al-card-tags">
                <span v-for="tag in item.tags.slice(0, 3)" :key="tag">{{ tag }}</span>
              </div>
            </div>
          </article>
        </div>

        <div v-if="items.length < total" class="al-more">
          <button type="button" class="al-button" data-test="asset-library-more" :disabled="loadingMore" @click="loadMore">
            {{ loadingMore ? '加载中…' : `加载更多（还有 ${total - items.length} 张）` }}
          </button>
        </div>
      </template>

      <div v-if="dragging" class="al-drop-overlay" aria-hidden="true">
        <AppIcon name="upload" :size="30" />
        <strong>松开导入到素材库</strong>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="detailOpen" class="al-modal" data-test="asset-library-detail" @click.self="closeDetail">
        <section class="al-modal-panel" role="dialog" aria-modal="true" aria-label="素材详情">
          <header class="al-modal-head">
            <div>
              <span class="al-kicker">ASSET DETAIL</span>
              <h2>{{ editName || detail?.item.name || '素材详情' }}</h2>
            </div>
            <button type="button" class="al-close" aria-label="关闭" @click="closeDetail">×</button>
          </header>
          <div class="al-modal-body">
            <div class="al-preview">
              <div v-if="detailLoading" class="al-preview-state">正在读取原图…</div>
              <div v-else-if="detailError" class="al-preview-state error" role="alert">{{ detailError }}</div>
              <img v-else-if="detail?.dataUrl" :src="detail.dataUrl" :alt="detail.item.name" />
            </div>
            <div class="al-detail-form">
              <label class="al-field"><span>名称</span><input v-model="editName" maxlength="120" data-test="asset-detail-name" /></label>
              <label class="al-field"><span>标签（逗号分隔）</span><input v-model="editTags" placeholder="例如：主图、春季、童装" data-test="asset-detail-tags" /></label>
              <div class="al-detail-meta">
                <span>{{ detail?.item.width }}×{{ detail?.item.height }}</span>
                <span>{{ formatAssetSize(detail?.item.size) }}</span>
                <span>{{ detail ? sourceLabel(detail.item.source) : '' }}</span>
                <span>{{ detail ? formatDate(detail.item.createdAt) : '' }}</span>
              </div>
              <div class="al-detail-actions">
                <button type="button" class="al-button primary" data-test="asset-detail-use" :disabled="!detail?.dataUrl" @click="useAsReference">
                  <AppIcon name="sparkles" :size="15" />用于对话生图
                </button>
                <button type="button" class="al-button" data-test="asset-detail-save" :disabled="saving || detailLoading" @click="saveDetail">
                  <AppIcon name="check" :size="15" />{{ saving ? '保存中…' : '保存修改' }}
                </button>
                <button type="button" class="al-button ghost" data-test="asset-detail-reveal" :disabled="detailLoading" @click="revealDetail">
                  <AppIcon name="folder" :size="15" />在文件夹显示
                </button>
                <button type="button" class="al-button danger" data-test="asset-detail-delete" :disabled="deleting || detailLoading" @click="removeDetail">
                  <AppIcon name="trash" :size="15" />{{ deleting ? '删除中…' : '删除素材' }}
                </button>
              </div>
              <p class="al-detail-hint">「用于对话生图」会把这张图设为下一轮参考图，画面里只改你指定部分；素材原图保存在本地素材库目录。</p>
            </div>
          </div>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from '../../components/ui/AppIcon.vue'
import brandMark from '../../assets/generated/shopilot-logo-generated.png'
import {
  ASSET_LIBRARY_LIMITS,
  assetSourceLabel,
  formatAssetSize,
  normalizeAssetTags,
  type AssetLibraryItem,
  type AssetLibraryListResult,
  type AssetLibraryReadResult,
  type AssetLibrarySource
} from '@shared/contracts/asset-library'
import { setPendingAssetReference } from './asset-library-bridge'

const emit = defineEmits<{ 'go-home': []; 'use-as-reference': [] }>()

const items = ref<AssetLibraryItem[]>([])
const allTags = ref<string[]>([])
const loading = ref(false)
const loadingMore = ref(false)
/** 符合当前筛选的总条数（主进程 COUNT 出来的，不是当前页长度） */
const total = ref(0)
/** 库里的总量与占用：容量提示用 */
const libraryTotal = ref(0)
const libraryBytes = ref(0)
const loadError = ref('')
const notice = ref('')
const noticeIsError = ref(false)
const importing = ref(false)
const dragging = ref(false)
const query = ref('')
const sourceFilter = ref<AssetLibrarySource | 'all'>('all')
const tagFilter = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

const detail = ref<AssetLibraryReadResult | null>(null)
const detailOpen = ref(false)
const detailLoading = ref(false)
const detailError = ref('')
const editName = ref('')
const editTags = ref('')
const saving = ref(false)
const deleting = ref(false)

/** 用得接近上限才提示，平时不占视觉位置 */
const capacityHint = computed(() => {
  const used = libraryBytes.value
  if (!used || used / ASSET_LIBRARY_LIMITS.maxTotalBytes < 0.8) return ''
  return formatAssetSize(used)
})

function sourceLabel(source: AssetLibrarySource): string {
  return assetSourceLabel(source)
}

function say(text: string, isError = false): void {
  notice.value = text
  noticeIsError.value = isError
}

/**
 * 读取列表。reset=true 从第一页重读，false 追加下一页。
 *
 * 分页 + 服务端筛选（2026-11-15 审查）：以前一次拉 1000 条带缩略图，满库 40–80MB 走 IPC，
 * 而且本地筛选在分页后只能搜到当前页。现在每一页由主进程 COUNT + LIMIT 给出。
 *
 * 并发用「请求代次」而不是 loading 开关：筛选变化时常有加载在飞，直接 return 会把最新的
 * 那次搜索丢掉（表现就是搜了没反应）。代次只保留最后一次请求的结果。
 */
let loadSeq = 0
async function load(reset = true): Promise<void> {
  const seq = ++loadSeq
  const offset = reset ? 0 : items.value.length
  loading.value = true
  loadError.value = ''
  try {
    const result = await window.shopilot.assets.list({
      query: query.value,
      source: sourceFilter.value,
      tag: tagFilter.value,
      offset,
      limit: ASSET_LIBRARY_LIMITS.pageSize
    })
    if (seq !== loadSeq) return
    if (!result.ok) throw new Error(result.error.message)
    const data = (result.data || {
      items: [], total: 0, libraryTotal: 0, libraryBytes: 0, tags: []
    }) as AssetLibraryListResult
    const page = Array.isArray(data.items) ? data.items : []
    items.value = reset ? page : [...items.value, ...page]
    total.value = Number(data.total) || 0
    libraryTotal.value = Number(data.libraryTotal) || 0
    libraryBytes.value = Number(data.libraryBytes) || 0
    allTags.value = Array.isArray(data.tags) ? data.tags : []
    if (tagFilter.value && !allTags.value.includes(tagFilter.value)) tagFilter.value = ''
  } catch (error) {
    if (seq === loadSeq) loadError.value = `读取素材库失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

async function loadMore(): Promise<void> {
  // 有整表重读在飞时不追加，避免把旧页拼到新筛选结果后面
  if (loading.value || loadingMore.value || items.value.length >= total.value) return
  loadingMore.value = true
  try {
    await load(false)
  } finally {
    loadingMore.value = false
  }
}

/** 筛选变化 → 防抖重读第一页（搜索框每敲一个字不该打一次 IPC） */
const SEARCH_DEBOUNCE_MS = 120
let reloadTimer: ReturnType<typeof setTimeout> | null = null
function scheduleReload(): void {
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    void load(true)
  }, SEARCH_DEBOUNCE_MS)
}
watch([query, sourceFilter, tagFilter], () => scheduleReload())
onBeforeUnmount(() => {
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = null
})

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

async function importFiles(files: FileList | File[]): Promise<void> {
  if (importing.value) return
  const list = [...files]
  if (!list.length) return
  importing.value = true
  let added = 0
  let duplicated = 0
  let failed = 0
  /** 库满/超容量的原因要原样告诉用户，别混在"无法读取"里 */
  let fullReason = ''
  try {
    for (const file of list) {
      if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
        failed += 1
        continue
      }
      if (file.size > ASSET_LIBRARY_LIMITS.maxBytes) {
        failed += 1
        continue
      }
      try {
        const dataUrl = await readFileAsDataUrl(file)
        const result = await window.shopilot.assets.addDataUrl({
          dataUrl,
          name: file.name.replace(/\.[^.]+$/, '').slice(0, ASSET_LIBRARY_LIMITS.name),
          source: 'upload'
        })
        if (!result.ok) throw new Error(result.error.message)
        if (result.data?.duplicate) duplicated += 1
        else added += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/素材库(最多|总容量)/.test(message)) {
          // 已经满了：后面的文件不用再试，直接停
          fullReason = message
          break
        }
        failed += 1
      }
    }
    await load()
    if (fullReason) {
      say(fullReason + (added ? `（本次已导入 ${added} 张）` : ''), true)
      return
    }
    const parts = [`已导入 ${added} 张`]
    if (duplicated) parts.push(`${duplicated} 张重复已跳过`)
    if (failed) parts.push(`${failed} 张无法读取`)
    say(parts.join('，'), failed > 0)
  } finally {
    importing.value = false
  }
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  if (input.files?.length) await importFiles(input.files)
  input.value = ''
}

function onDragLeave(event: DragEvent): void {
  if (event.currentTarget === event.target) dragging.value = false
}

async function onDrop(event: DragEvent): Promise<void> {
  dragging.value = false
  const files = event.dataTransfer?.files
  if (files?.length) await importFiles(files)
}

function clearFilters(): void {
  query.value = ''
  sourceFilter.value = 'all'
  tagFilter.value = ''
}

async function openDetail(item: AssetLibraryItem): Promise<void> {
  detailOpen.value = true
  detailLoading.value = true
  detailError.value = ''
  detail.value = null
  editName.value = item.name
  editTags.value = item.tags.join('，')
  try {
    const result = await window.shopilot.assets.read(item.id)
    if (!result.ok) throw new Error(result.error.message)
    detail.value = result.data as AssetLibraryReadResult
    editName.value = detail.value.item.name
    editTags.value = detail.value.item.tags.join('，')
  } catch (error) {
    detailError.value = `读取原图失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    detailLoading.value = false
  }
}

function closeDetail(): void {
  if (saving.value || deleting.value) return
  detailOpen.value = false
  detail.value = null
  detailError.value = ''
}

async function saveDetail(): Promise<void> {
  if (!detail.value || saving.value) return
  saving.value = true
  try {
    const result = await window.shopilot.assets.update({
      id: detail.value.item.id,
      name: editName.value,
      tags: normalizeAssetTags(editTags.value)
    })
    if (!result.ok) throw new Error(result.error.message)
    const updated = result.data as AssetLibraryItem
    detail.value = { ...detail.value, item: updated }
    // 改名/改标签会影响筛选命中与排序，直接重读第一页（不再本地 map 拼一份可能过期的列表）
    await load()
    say('素材信息已保存')
  } catch (error) {
    say(`保存失败：${error instanceof Error ? error.message : String(error)}`, true)
  } finally {
    saving.value = false
  }
}

async function removeDetail(): Promise<void> {
  if (!detail.value || deleting.value) return
  if (!window.confirm(`删除素材「${detail.value.item.name}」？\n原图会从素材库目录移除，无法恢复。`)) return
  deleting.value = true
  try {
    const result = await window.shopilot.assets.remove(detail.value.item.id)
    if (!result.ok) throw new Error(result.error.message)
    closeDetail()
    await load()
    say('素材已删除')
  } catch (error) {
    say(`删除失败：${error instanceof Error ? error.message : String(error)}`, true)
  } finally {
    deleting.value = false
  }
}

async function revealDetail(): Promise<void> {
  if (!detail.value) return
  try {
    const result = await window.shopilot.assets.reveal(detail.value.item.id)
    if (!result.ok) throw new Error(result.error.message)
    say('已在文件夹中定位素材')
  } catch (error) {
    say(`定位失败：${error instanceof Error ? error.message : String(error)}`, true)
  }
}

function useAsReference(): void {
  if (!detail.value) return
  const base64 = detail.value.dataUrl.split(',')[1] || ''
  const bytes = Math.ceil(base64.length * 3 / 4)
  // 素材库允许 20MB 原图，但「对话生图」参考图接口只接受 5MB；这里提前拦住，避免大请求发出去才失败。
  if (bytes > 5 * 1024 * 1024) {
    say('这张素材超过 5MB，对话生图参考图上限是 5MB；请先压缩后再使用', true)
    return
  }
  setPendingAssetReference({ name: detail.value.item.name, dataUrl: detail.value.dataUrl })
  detailOpen.value = false
  emit('use-as-reference')
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

onMounted(() => { void load() })
</script>

<style scoped>
.asset-library-page{display:flex;min-width:0;min-height:0;flex:1;flex-direction:column;overflow:hidden;color:var(--dash-text);background:var(--ui-canvas)}
.al-head{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:58px;flex:0 0 58px;padding:0 24px;border-bottom:1px solid var(--ui-border);background:rgba(255,255,255,.96);backdrop-filter:blur(10px);z-index:5}
.al-brand{display:flex;align-items:center;gap:9px;min-width:0}
.al-brand-mark{display:inline-flex;width:30px;height:30px;padding:0;border:0;background:transparent;cursor:pointer}
.al-brand-mark img{width:100%;height:100%;object-fit:contain}
.al-brand strong{font-size:15px;letter-spacing:-.02em}
.al-brand-sub{padding-left:9px;border-left:1px solid var(--ui-border);color:var(--dash-text-muted);font-size:12px}
.al-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.al-count{padding:4px 9px;border:1px solid var(--ui-border);border-radius:999px;color:var(--dash-text-muted);font-size:11px;white-space:nowrap}
.al-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:0 12px;border:1px solid var(--ui-border);border-radius:8px;background:var(--ui-surface);color:var(--dash-text);font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}
.al-button:hover:not(:disabled){border-color:var(--brand-border);color:var(--brand-text)}
.al-button:disabled{opacity:.55;cursor:not-allowed}
.al-button.primary{border-color:#6d4df2;background:#6d4df2;color:#fff;box-shadow:0 6px 16px rgba(109,77,242,.22)}
.al-button.primary:hover:not(:disabled){background:#5b3ee0;color:#fff}
.al-button.ghost{background:transparent}
.al-button.danger{border-color:#f3c6c6;background:#fff5f5;color:#b42318}
.al-button.danger:hover:not(:disabled){border-color:#e9a2a2;color:#912018}
.al-body{position:relative;min-height:0;flex:1;overflow:auto;padding:20px 24px 40px}
.al-body.dragging{outline:2px dashed #8b6cf6;outline-offset:-10px}
.al-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.al-search{display:flex;align-items:center;gap:7px;min-width:240px;flex:1 1 280px;max-width:420px;padding:0 10px;border:1px solid var(--ui-border);border-radius:9px;background:#fff;color:var(--dash-text-muted)}
.al-search input{width:100%;height:36px;border:0;background:transparent;color:var(--dash-text);font-size:12px;outline:none}
.al-select{display:inline-flex;align-items:center;gap:8px;color:var(--dash-text-muted);font-size:11px;white-space:nowrap}
.al-select select{height:36px;padding:0 9px;border:1px solid var(--ui-border);border-radius:8px;background:#fff;color:var(--dash-text);font-size:12px}
.al-tag-filter{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.al-tag-filter button{min-height:28px;padding:0 9px;border:1px solid var(--ui-border);border-radius:999px;background:#fff;color:var(--dash-text-muted);font-size:11px;cursor:pointer}
.al-tag-filter button.active{border-color:#8b6cf6;background:#f2eeff;color:#5b3ee0;font-weight:600}
.al-notice{margin-bottom:12px;padding:9px 11px;border:1px solid #d9e7d5;border-radius:9px;background:#f5fbf3;color:#3f6b3a;font-size:12px}
.al-notice.error{border-color:#f3c6c6;background:#fff5f5;color:#b42318}
.al-loading{padding:60px 0;text-align:center;color:var(--dash-text-muted);font-size:12px}
.al-empty{display:flex;align-items:center;flex-direction:column;justify-content:center;min-height:420px;padding:30px;text-align:center}
.al-empty.compact{min-height:240px}
.al-empty-mark{display:inline-flex;align-items:center;justify-content:center;width:58px;height:58px;margin-bottom:14px;border:1px solid #e6e0ff;border-radius:18px;background:#f4f0ff;color:#6d4df2}
.al-empty h1{margin:0 0 8px;font-size:20px;letter-spacing:-.02em}
.al-empty p{max-width:520px;margin:0 0 18px;color:var(--dash-text-muted);font-size:12px;line-height:1.7}
.al-empty-hint{margin-top:10px;color:var(--dash-text-muted);font-size:10px}
.al-result-line{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;color:var(--dash-text-muted);font-size:11px}
.al-more{display:flex;justify-content:center;padding:16px 0 4px}
.al-result-line button{padding:0;border:0;background:transparent;color:#6d4df2;font-size:11px;cursor:pointer}
.al-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(205px,1fr));gap:14px}
.al-card{min-width:0;overflow:hidden;border:1px solid var(--ui-border);border-radius:12px;background:#fff;box-shadow:0 4px 14px rgba(30,38,60,.05);cursor:pointer;transition:transform .16s,border-color .16s,box-shadow .16s}
.al-card:hover,.al-card:focus-visible{transform:translateY(-2px);border-color:#c9bdf5;box-shadow:0 12px 24px rgba(58,45,110,.12);outline:none}
.al-thumb{position:relative;display:flex;align-items:center;justify-content:center;aspect-ratio:4/3;overflow:hidden;background:linear-gradient(135deg,#f6f7fb,#eceff7)}
.al-thumb img{width:100%;height:100%;object-fit:cover}
.al-thumb-fallback{color:#aab2c5}
.al-source{position:absolute;top:8px;left:8px;padding:3px 7px;border-radius:999px;background:rgba(23,31,49,.72);color:#fff;font-size:9px;letter-spacing:.02em}
.al-source.chat-image{background:rgba(92,63,214,.8)}
.al-card-body{padding:10px 11px 11px}
.al-card-body strong{display:block;overflow:hidden;font-size:12px;line-height:1.4;text-overflow:ellipsis;white-space:nowrap}
.al-meta{display:block;margin-top:4px;color:var(--dash-text-muted);font-size:10px}
.al-card-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:7px}
.al-card-tags span{padding:2px 6px;border-radius:999px;background:#f2f4f9;color:#667085;font-size:9px}
.al-drop-overlay{position:absolute;inset:10px;z-index:8;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;border:2px dashed #8b6cf6;border-radius:16px;background:rgba(244,240,255,.9);color:#5b3ee0;font-size:13px;pointer-events:none}
.al-modal{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:28px;background:rgba(16,22,38,.48);backdrop-filter:blur(4px)}
.al-modal-panel{display:flex;flex-direction:column;width:min(980px,96vw);max-height:90vh;overflow:hidden;border:1px solid rgba(255,255,255,.6);border-radius:16px;background:#fff;box-shadow:0 30px 80px rgba(15,23,42,.28)}
.al-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:15px 18px;border-bottom:1px solid var(--ui-border)}
.al-kicker{color:#9b83ef;font-size:9px;letter-spacing:.14em}
.al-modal-head h2{margin:4px 0 0;font-size:16px;letter-spacing:-.02em}
.al-close{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid var(--ui-border);border-radius:8px;background:#fff;color:var(--dash-text-muted);font-size:19px;line-height:1;cursor:pointer}
.al-close:hover{color:var(--dash-text);border-color:var(--brand-border)}
.al-modal-body{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(300px,.85fr);min-height:0;overflow:auto}
.al-preview{display:flex;align-items:center;justify-content:center;min-height:360px;padding:18px;background:linear-gradient(135deg,#f6f7fb,#e9edf6)}
.al-preview img{max-width:100%;max-height:62vh;border-radius:10px;box-shadow:0 14px 32px rgba(20,28,48,.16);object-fit:contain}
.al-preview-state{color:var(--dash-text-muted);font-size:12px}
.al-preview-state.error{color:#b42318}
.al-detail-form{padding:18px;border-left:1px solid var(--ui-border)}
.al-field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;color:var(--dash-text-muted);font-size:11px}
.al-field input{height:36px;padding:0 10px;border:1px solid var(--ui-border);border-radius:8px;background:#fff;color:var(--dash-text);font-size:12px;outline:none}
.al-field input:focus{border-color:#a38df4;box-shadow:0 0 0 3px rgba(125,94,240,.12)}
.al-detail-meta{display:flex;gap:6px;flex-wrap:wrap;margin:2px 0 14px;color:var(--dash-text-muted);font-size:10px}
.al-detail-meta span{padding:3px 7px;border:1px solid var(--ui-border);border-radius:999px;background:#fafbfe}
.al-detail-actions{display:flex;gap:8px;flex-wrap:wrap}
.al-detail-hint{margin:14px 0 0;color:var(--dash-text-muted);font-size:10px;line-height:1.6}
@media(max-width:820px){
  .al-head{align-items:flex-start;flex-direction:column;height:auto;min-height:58px;padding:10px 16px;gap:8px}
  .al-head-actions{justify-content:flex-start}
  .al-body{padding:16px}
  .al-modal{padding:12px}
  .al-modal-body{grid-template-columns:1fr}
  .al-detail-form{border-left:0;border-top:1px solid var(--ui-border)}
}
</style>
