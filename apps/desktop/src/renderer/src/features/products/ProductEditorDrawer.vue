<script setup lang="ts">
/**
 * 本地商品编辑抽屉 · 四分区完整版（v4 重设计 §3.3 R2）。
 *
 * ① 基础：标题* / 副标题 / 品牌 / 本地分类 / 标签（chip，≤30 个 × ≤30 字，schema 同款上限）
 * ② 媒体：主图(1) / 图集 / 详情图——缩略图走 `shopilot-media://local/<相对路径>`；
 *    未本地化的远程图**不假装能显示**（CSP 也不允许外链 img），显示状态占位与失败原因。
 *    操作：设为主图 / 移除引用（只删引用行，文件交孤儿清理判定）/ 添加本地图片 / 下载图片到本地。
 * ③ 规格：变体行增/删/改——规格文本按 v3 §5.6「不猜」规则解析（`颜色:红;尺码:L`），解析不出整串保留。
 * ④ 校验：productDraftIssues 实时分级展示（渲染层直接算，不依赖后端）。
 *
 * 保存 = 全量草稿替换（get-modify-save：只覆盖被编辑的字段，description 等未展示字段原样带回）；
 * 保存后 issues / draft_hash / 状态三者一致（后端 save 单点保证，这里如实回显）。
 * 已归档商品只读：横幅说明 + 全部输入禁用，操作只留「取消归档」与关闭。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { parseSpecText, normalizeCellText } from '@shared/product-rules'
import { productDraftIssues, type LocalProductDraft, type ProductDraftMedia } from '@shared/product-draft'
import bulkPanelCloseIcon from '../../assets/generated/ui-icons/panel-close-bulk-gen.png'
import productSaveCheckIcon from '../../assets/generated/ui-icons/product-save-check-gen.png'

const props = defineProps<{ productId: string; status?: string }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void; (e: 'unarchive'): void }>()

const ws = useWorkspaceStore()

interface DraftIssue { level: 'blocker' | 'warning' | 'info'; field: string; message: string; fixHint?: string }
interface EditorVariant { specText: string; priceYuan: string; stockText: string; skuCode: string; barcodeText: string }
interface EditorMedia extends ProductDraftMedia {}

const loading = ref(true)
const saving = ref(false)
const loadError = ref('')
const title = ref('')
const subtitle = ref('')
const brand = ref('')
const localCategory = ref('')
const tagDraft = ref('')
const tags = ref<string[]>([])
const mediaItems = ref<EditorMedia[]>([])
const variants = ref<EditorVariant[]>([])
const serverIssues = ref<DraftIssue[]>([])
const archived = computed(() => props.status === 'archived')
const mediaBusy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

/** 分 → 元字符串（编辑框里显示的是元，保存时再转回分；绝不用浮点存金额）。 */
function minorToYuan(minor: number | null): string {
  return minor == null ? '' : (minor / 100).toFixed(2)
}
function yuanToMinor(text: string): number | null {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100)
}
/** 规格数组 → 单行文本（与 parseSpecText 互逆的展示形式）。 */
function specToText(spec: Array<{ name: string; value: string }>): string {
  if (!spec.length) return ''
  return spec.map(part => (part.name ? `${part.name}:${part.value}` : part.value)).join(';')
}

/** 编辑器当前草稿（保存与实时校验共用同一份构建，避免两处口径漂移）。 */
function buildDraft(description: string | null): LocalProductDraft {
  return {
    title: title.value,
    subtitle: subtitle.value.trim() ? subtitle.value : null,
    description,
    brand: brand.value.trim() ? brand.value : null,
    localCategory: localCategory.value.trim() ? localCategory.value : null,
    tags: [...tags.value],
    variants: variants.value.map(variant => ({
        spec: parseSpecText(variant.specText),
        priceMinor: yuanToMinor(variant.priceYuan),
        stock: variant.stockText.trim() ? Number(variant.stockText) : null,
        skuCode: variant.skuCode.trim() ? variant.skuCode : null,
        // 条码在编辑器中是可见且可编辑字段；清空后必须真的保存为 null，
        // 不能再从旧的透传值恢复，避免用户无法删除过期条码。
        barcode: variant.barcodeText.trim() ? variant.barcodeText : null,
      })),
    media: mediaItems.value.map(item => ({ ...item }))
  }
}

const liveIssues = computed<DraftIssue[]>(() => {
  if (loading.value || loadError.value) return serverIssues.value
  try {
    return productDraftIssues(buildDraft(passthrough.value.description ?? null)) as DraftIssue[]
  } catch {
    return serverIssues.value
  }
})

/** get-modify-save 的透传区（本编辑器不展示但草稿里有的字段）。 */
const passthrough = ref<{ description: string | null }>({ description: null })

onMounted(async () => {
  await reload()
})

async function reload(): Promise<void> {
  loading.value = true
  const result = await window.shopilot.products.library.get(props.productId)
  if (!result.ok) { loadError.value = result.error.message; loading.value = false; return }
  const data = result.data as {
    draft: LocalProductDraft
    issues?: DraftIssue[]
  }
  title.value = data.draft.title
  subtitle.value = data.draft.subtitle ?? ''
  brand.value = data.draft.brand ?? ''
  localCategory.value = data.draft.localCategory ?? ''
  tags.value = [...(data.draft.tags ?? [])]
  mediaItems.value = (data.draft.media ?? []).map(item => ({ ...item }))
  variants.value = data.draft.variants.map(variant => ({
    specText: specToText(variant.spec ?? []),
    priceYuan: minorToYuan(variant.priceMinor),
    stockText: variant.stock == null ? '' : String(variant.stock),
    skuCode: variant.skuCode ?? '',
    barcodeText: variant.barcode ?? ''
  }))
  passthrough.value = {
    description: data.draft.description ?? null,
  }
  serverIssues.value = data.issues ?? []
  loadError.value = ''
  loading.value = false
}

// 设计文档 §5.2：编辑抽屉用 Esc 关闭（不保存）。挂 window 级监听、卸载时移除，
// 避免输入法组合中的 Esc（选词取消）误关——仅当未在保存时才响应。
function onDrawerKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && !saving.value && !mediaBusy.value) { e.stopPropagation(); emit('close') }
}
window.addEventListener('keydown', onDrawerKeydown, true)
onBeforeUnmount(() => window.removeEventListener('keydown', onDrawerKeydown, true))

// ---- 标签 chip（§3.3：≤30 个，每个 ≤30 字，与 save schema 同上限）----
function addTag(): void {
  const value = normalizeCellText(tagDraft.value)
  if (!value) return
  if (tags.value.length >= 30) { ws.toast('标签最多 30 个', 'error'); return }
  if (value.length > 30) { ws.toast('单个标签最多 30 字', 'error'); return }
  if (tags.value.includes(value)) { tagDraft.value = ''; return }
  tags.value.push(value)
  tagDraft.value = ''
}
function removeTag(index: number): void {
  tags.value.splice(index, 1)
}

// ---- 媒体操作（§3.3：移除只删引用行；设封面把原主图降级为图集）----
function mediaSrc(item: EditorMedia): string | null {
  if (item.localPath) return `shopilot-media://local/${item.localPath}`
  return null // 未本地化的远程图不给 src：CSP 禁外链，显示占位才诚实
}
function setCover(index: number): void {
  const item = mediaItems.value[index]
  if (!item || item.role === 'cover') return
  const currentCover = mediaItems.value.find(candidate => candidate.role === 'cover')
  if (currentCover) currentCover.role = 'gallery'
  item.role = 'cover'
}
function removeMedia(index: number): void {
  mediaItems.value.splice(index, 1)
}
function mediaStateLabel(item: EditorMedia): string {
  return item.state === 'localized' ? '已本地化' : item.state === 'pending' ? '未下载' : item.state === 'failed' ? '下载失败' : item.state === 'blocked' ? '已拒绝' : '未知'
}
async function addLocalImages(): Promise<void> {
  const files = fileInput.value?.files
  if (!files || !files.length) return
  mediaBusy.value = true
  try {
    const paths: string[] = []
    for (const file of Array.from(files)) {
      try { paths.push(window.shopilot.products.library.getPathForFile(file)) } catch { /* 拿不到路径的文件跳过 */ }
    }
    if (!paths.length) { ws.toast('拿不到所选文件的本地路径', 'error'); return }
    // 主图缺失时第一张自动当主图（编辑器便利性；用户仍可再点「设为主图」调整）
    const role: 'cover' | 'gallery' = mediaItems.value.some(item => item.role === 'cover') ? 'gallery' : 'cover'
    const result = await window.shopilot.products.library.importLocalImages({ productId: props.productId, paths, role })
    if (!result.ok) { ws.toast('导入失败：' + result.error.message, 'error'); return }
    const payload = result.data as { imported: EditorMedia[]; skipped: Array<{ path: string; reason: string }> }
    for (const entry of payload.imported ?? []) mediaItems.value.push({ ...entry })
    const skipped = payload.skipped ?? []
    if (skipped.length) {
      const reasons: Record<string, string> = { too_large: '超过 10MB', unsupported_type: '不是支持的图片格式', svg_rejected: 'SVG 会被拒绝（可能内嵌脚本）', write_failed: '写盘失败', not_readable: '读不到文件', bad_path: '路径无效' }
      ws.toast(`${payload.imported.length} 张已添加；${skipped.length} 张跳过（${skipped.map(item => reasons[item.reason] || item.reason).join('、')}）`, 'error')
    } else {
      ws.toast(`已添加 ${payload.imported.length} 张本地图片（保存后生效）`, 'success')
    }
    if (fileInput.value) fileInput.value.value = ''
  } finally {
    mediaBusy.value = false
  }
}
async function localizeAll(): Promise<void> {
  mediaBusy.value = true
  try {
    const result = await window.shopilot.products.library.localizeMedia(props.productId)
    if (!result.ok) { ws.toast('下载失败：' + result.error.message, 'error'); return }
    const outcome = result.data as { localized: number; deduped: number; failed: number; blocked: number }
    ws.toast(`下载完成：本地化 ${outcome.localized}、复用 ${outcome.deduped}、失败 ${outcome.failed}、拒绝 ${outcome.blocked}`, outcome.failed + outcome.blocked ? 'error' : 'success')
    await reload() // 重新读取（localize 会回写草稿的媒体状态）
  } finally {
    mediaBusy.value = false
  }
}

// ---- 规格行 ----
function addVariant(): void {
  if (variants.value.length >= 200) { ws.toast('规格最多 200 行', 'error'); return }
  variants.value.push({ specText: '', priceYuan: '', stockText: '', skuCode: '', barcodeText: '' })
}
function removeVariant(index: number): void {
  variants.value.splice(index, 1)
}

async function save(): Promise<void> {
  saving.value = true
  try {
    // 读回完整草稿再改（只提交被编辑的字段，避免把没显示的字段清空）
    const current = await window.shopilot.products.library.get(props.productId)
    if (!current.ok) { ws.toast('保存失败：' + current.error.message, 'error'); return }
    const fetched = (current.data as { draft: Record<string, unknown> }).draft
    const draft = buildDraft((fetched.description as string | null) ?? null)
    const result = await window.shopilot.products.library.save({
      productId: props.productId, draft
    })
    if (!result.ok) { ws.toast('保存失败：' + result.error.message, 'error'); return }
    const payload = result.data as { issues?: DraftIssue[]; status?: string; draftHash?: string } | undefined
    serverIssues.value = payload?.issues ?? []
    const hasBlocker = serverIssues.value.some(issue => issue.level === 'blocker')
    ws.toast(`已保存（状态：${payload?.status === 'ready' ? '就绪' : payload?.status === 'archived' ? '已归档' : '草稿'}${hasBlocker ? '，仍有待补项' : ''}）`, hasBlocker ? 'error' : 'success')
    emit('saved')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="product-drawer" data-test="product-editor">
    <div class="product-drawer-head">
      <strong>编辑本地商品</strong>
      <button type="button" class="inline-link" data-test="editor-close" @click="emit('close')"><img class="button-icon" :src="bulkPanelCloseIcon" alt="" />关闭</button>
    </div>
    <div v-if="loading" class="unified-state" style="min-height:80px"><span class="loader"></span>正在读取…</div>
    <div v-else-if="loadError" class="product-issues"><div class="issue-blocker"><b>读取失败</b><span>{{ loadError }}</span></div></div>
    <template v-else>
      <div v-if="archived" class="editor-archived-banner" data-test="editor-archived-banner">
        已归档商品只读。先「取消归档」才能继续编辑；当前可做的操作：取消归档 / 导出 / 删除。
        <button type="button" class="inline-link" data-test="editor-unarchive" @click="emit('unarchive')">取消归档</button>
      </div>

      <!-- ① 基础 -->
      <div class="editor-section" data-test="editor-section-basic">
        <div class="editor-section-title">基础</div>
        <label class="product-field"><span>标题 *</span>
          <input v-model="title" type="text" data-test="editor-title" :disabled="archived" />
        </label>
        <label class="product-field"><span>副标题</span>
          <input v-model="subtitle" type="text" data-test="editor-subtitle" :disabled="archived" />
        </label>
        <div class="product-field-row two">
          <label class="product-field"><span>品牌</span>
            <input v-model="brand" type="text" data-test="editor-brand" :disabled="archived" />
          </label>
          <label class="product-field"><span>本地分类</span>
            <input v-model="localCategory" type="text" data-test="editor-category" :disabled="archived" />
          </label>
        </div>
        <div class="product-field"><span>标签（回车添加，≤30 个）</span>
          <div class="tag-chips" data-test="editor-tags">
            <span v-for="(tag, index) in tags" :key="tag + index" class="tag-chip">
              {{ tag }}
              <button type="button" class="tag-del" :data-test="'editor-tag-del-' + index" :disabled="archived" @click="removeTag(index)">×</button>
            </span>
            <input v-model="tagDraft" type="text" class="tag-input" data-test="editor-tags-input" :disabled="archived || tags.length >= 30"
                   placeholder="+ 输入后回车" @keydown.enter.prevent="addTag" />
          </div>
        </div>
      </div>

      <!-- ② 媒体 -->
      <div class="editor-section" data-test="editor-media">
        <div class="editor-section-title">媒体
          <button type="button" class="inline-link" data-test="editor-media-localize" :disabled="archived || mediaBusy" @click="localizeAll">
            {{ mediaBusy ? '处理中…' : '下载图片到本地' }}</button>
        </div>
        <div v-if="!mediaItems.length" class="editor-media-empty">还没有图片。从平台另存的商品点「下载图片到本地」；或直接添加本机图片。</div>
        <div class="media-grid">
          <div v-for="(item, index) in mediaItems" :key="(item.sha256 || item.remoteUrl || 'm') + index" class="media-cell" :data-test="'editor-thumb-' + index">
            <img v-if="mediaSrc(item)" :src="mediaSrc(item) || ''" alt="" class="media-img" />
            <div v-else class="media-placeholder">
              <span>{{ mediaStateLabel(item) }}</span>
              <small v-if="item.failReason">{{ item.failReason }}</small>
            </div>
            <div class="media-ops">
              <span class="media-role">{{ item.role === 'cover' ? '主图' : item.role === 'gallery' ? '图集' : item.role === 'detail' ? '详情' : 'SKU' }}</span>
              <button v-if="item.role !== 'cover'" type="button" class="media-btn" :data-test="'editor-cover-' + index" :disabled="archived" @click="setCover(index)">设为主图</button>
              <button type="button" class="media-btn danger" :data-test="'editor-media-del-' + index" :disabled="archived" @click="removeMedia(index)">移除</button>
            </div>
          </div>
        </div>
        <label class="media-add" :class="{ disabled: archived || mediaBusy }">
          <input ref="fileInput" type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple data-test="editor-media-add" :disabled="archived || mediaBusy" @change="addLocalImages" />
          ＋ 添加本地图片（jpg / png / webp / gif，≤10MB）
        </label>
        <small class="media-note">移除只删引用，文件由「孤儿清理」按保留策略处理。</small>
      </div>

      <!-- ③ 规格 -->
      <div class="editor-section" data-test="editor-variants">
        <div class="editor-section-title">规格
          <button type="button" class="inline-link" data-test="editor-variant-add" :disabled="archived" @click="addVariant">＋ 加一行</button>
        </div>
        <div v-if="!variants.length" class="editor-media-empty">还没有规格。填「颜色:红;尺码:L」这样的文本，解析不出就整串保留（不猜）。</div>
        <div v-for="(variant, index) in variants" :key="index" class="variant-block">
          <div class="variant-row">
            <label class="product-field grow"><span>规格 {{ index + 1 }}（名称:值;…）</span>
              <input v-model="variant.specText" type="text" :data-test="'editor-spec-' + index" :disabled="archived" placeholder="颜色:红;尺码:L" />
            </label>
            <button type="button" class="media-btn danger" :data-test="'editor-variant-del-' + index" :disabled="archived" @click="removeVariant(index)">删行</button>
          </div>
          <div class="product-field-row three">
            <label class="product-field"><span>价格（元）</span>
              <input v-model="variant.priceYuan" type="text" :data-test="'editor-price-' + index" :disabled="archived" />
            </label>
            <label class="product-field"><span>库存</span>
              <input v-model="variant.stockText" type="text" :data-test="'editor-stock-' + index" :disabled="archived" />
            </label>
            <label class="product-field"><span>SKU 码</span>
              <input v-model="variant.skuCode" type="text" :data-test="'editor-sku-' + index" :disabled="archived" />
            </label>
            <label class="product-field"><span>条码</span>
              <input v-model="variant.barcodeText" type="text" :data-test="'editor-barcode-' + index" :disabled="archived" />
            </label>
          </div>
        </div>
      </div>

      <!-- ④ 校验（实时） -->
      <div class="editor-section" data-test="editor-issues">
        <div class="editor-section-title">校验（实时）</div>
        <div v-if="!liveIssues.length" class="editor-media-empty">当前没有待补项。</div>
        <div v-else class="product-issues">
          <div v-for="(issue, index) in liveIssues" :key="index" :class="'issue-' + issue.level" :data-test="'editor-issue-' + issue.level">
            <b>{{ issue.level === 'blocker' ? '阻断' : issue.level === 'warning' ? '注意' : '提示' }}</b>
            <span>{{ issue.message }}</span>
            <small v-if="issue.fixHint">{{ issue.fixHint }}</small>
          </div>
        </div>
      </div>

      <div class="product-drawer-actions">
        <button type="button" class="unified-button primary" data-test="editor-save" :disabled="saving || archived" @click="save">
          <img class="button-icon" :src="productSaveCheckIcon" alt="" />{{ saving ? '保存中…' : '保存' }}</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.product-drawer{position:fixed;top:0;right:0;z-index:40;display:flex;flex-direction:column;gap:12px;width:460px;height:100%;padding:18px;overflow:auto;border-left:1px solid var(--dash-border);background:#fff;box-shadow:-12px 0 32px rgba(16,24,40,.12)}
.product-drawer-head{display:flex;align-items:center;justify-content:space-between}
.inline-link{display:inline-flex;align-items:center;border:0;background:transparent;color:#7c5cff;cursor:pointer;font-size:12px}
.inline-link:disabled{opacity:.5;cursor:default}
.editor-archived-banner{padding:10px 12px;border:1px solid #f4c7c3;border-radius:10px;background:#fdf3f2;color:#8a1f16;font-size:12px;line-height:1.6}
.editor-section{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dash-border);border-radius:12px;background:#fbfcfe}
.editor-section-title{display:flex;align-items:center;justify-content:space-between;font-weight:600;font-size:12px;color:var(--dash-text)}
.product-field{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dash-text-muted)}
.product-field input{min-height:30px;padding:0 9px;border:1px solid var(--dash-border);border-radius:8px;font-size:12px;color:var(--dash-text)}
.product-field input:disabled{background:#f7f8fa;color:var(--dash-text-muted)}
.product-field-row{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:8px}
.product-field-row.two{grid-template-columns:1fr 1fr}
.product-field-row.three{grid-template-columns:1fr 1fr 1fr 1fr}
.product-field-row .grow{flex:1}
.variant-block{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px dashed var(--dash-border);border-radius:10px}
.variant-row{display:flex;align-items:flex-end;gap:8px}
.tag-chips{display:flex;flex-wrap:wrap;gap:6px;min-height:32px;padding:6px;border:1px solid var(--dash-border);border-radius:8px;background:#fff}
.tag-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;background:#f0ecff;color:#4c3ad0;font-size:11px}
.tag-del{border:0;background:transparent;color:#7c5cff;cursor:pointer;font-size:13px;line-height:1;padding:0}
.tag-del:disabled{opacity:.4;cursor:default}
.tag-input{flex:1;min-width:120px;min-height:22px;border:0;outline:none;font-size:12px}
.media-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.media-cell{display:flex;flex-direction:column;gap:4px;padding:6px;border:1px solid var(--dash-border);border-radius:10px;background:#fff}
.media-img{width:100%;height:72px;object-fit:cover;border-radius:6px;background:#f4f5f7}
.media-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;height:72px;border-radius:6px;background:#f4f5f7;color:var(--dash-text-muted);font-size:11px;gap:2px;text-align:center;padding:4px}
.media-ops{display:flex;align-items:center;flex-wrap:wrap;gap:4px}
.media-role{font-size:10px;color:var(--dash-text-muted);margin-right:auto}
.media-btn{border:1px solid var(--dash-border);border-radius:6px;background:#fff;color:var(--dash-text-soft);cursor:pointer;font-size:10px;padding:1px 6px}
.media-btn.danger{color:#b42318}
.media-btn:disabled{opacity:.45;cursor:default}
.media-add{position:relative;display:flex;align-items:center;justify-content:center;min-height:34px;padding:0 10px;border:1px dashed #b9a8ff;border-radius:9px;color:#7c5cff;font-size:12px;cursor:pointer;overflow:hidden}
.media-add input[type=file]{position:absolute;inset:0;opacity:0;cursor:pointer}
.media-add.disabled{opacity:.5;cursor:default}
.media-note{font-size:10px;color:var(--dash-text-muted)}
.editor-media-empty{padding:10px;border:1px dashed var(--dash-border);border-radius:8px;color:var(--dash-text-muted);font-size:11px;line-height:1.6}
.product-issues{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--dash-border);border-radius:10px;background:#fff;font-size:11px}
.product-issues b{margin-right:6px}
.product-issues small{display:block;margin-top:2px;color:var(--dash-text-muted)}
.issue-blocker b{color:#b42318}.issue-warning b{color:#b54708}.issue-info b{color:#175cd3}
.product-drawer-actions{display:flex;gap:8px}
.unified-button{display:inline-flex;align-items:center;min-height:34px;padding:0 13px;border:1px solid var(--dash-border);border-radius:9px;background:#ffffff;color:var(--dash-text-soft);cursor:pointer;font-size:13px}
.unified-button:hover,.unified-button:focus-visible{border-color:rgba(151,120,255,.7);color:var(--dash-text);outline:2px solid rgba(151,120,255,.35);outline-offset:1px}
.unified-button.primary{border-color:#5b3df5;background:#6d4aff;color:#ffffff}
.unified-button:disabled{opacity:.55;cursor:default}
.button-icon{width:15px;height:15px;object-fit:contain;vertical-align:-3px;margin-right:5px}
.unified-state{display:flex;min-height:80px;align-items:center;justify-content:center;gap:8px;color:var(--dash-text-muted);font-size:12px}
.loader{width:14px;height:14px;border:2px solid var(--dash-border);border-top-color:#7c5cff;border-radius:50%;animation:drawer-spin .8s linear infinite;display:inline-block}
@keyframes drawer-spin{to{transform:rotate(360deg)}}
</style>
