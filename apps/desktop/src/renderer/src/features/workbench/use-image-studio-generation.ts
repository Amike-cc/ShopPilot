import { computed, ref, watch } from 'vue'
import { getImageStudioFont, IMAGE_STUDIO_FONT_OPTIONS } from './image-studio-fonts'
import { IMAGE_STUDIO_FREE_EDIT_RATIO_OPTIONS, IMAGE_STUDIO_RATIO_OPTIONS, imageStudioRequestSize } from './image-studio-ratios'
import {
  ANALYSIS_MAX_IMAGES,
  analysisPromptText,
  buildAnalysisInput,
  canAnalyzeProduct,
  describeAnalysisError
} from './image-text-analysis'
import referenceArt from '../../assets/ui/image-studio/reference-site/product.jpg'
import replicaArt from '../../assets/ui/image-studio/reference-site/effect-1.jpg'
import resultArt from '../../assets/ui/image-studio/reference-site/effect-2.jpg'
import effectThreeArt from '../../assets/ui/image-studio/reference-site/effect-3.jpg'
import quantityProductArt from '../../assets/ui/image-studio/reference-site/quantity-product.jpg'
import detailCoverArt from '../../assets/ui/image-studio/reference-site/detail-cover.webp'
import detailCollectionArt from '../../assets/ui/image-studio/reference-site/detail-collection.webp'
import detailStylesArt from '../../assets/ui/image-studio/reference-site/detail-styles.webp'
import detailDetailArt from '../../assets/ui/image-studio/reference-site/detail-detail.webp'
import detailSignatureArt from '../../assets/ui/image-studio/reference-site/detail-signature.webp'
import detailSceneArt from '../../assets/ui/image-studio/reference-site/detail-scene.webp'
import modelProductArt from '../../assets/ui/image-studio/reference-site/model-product.jpg'
import materialExampleOne from '../../assets/ui/image-studio/examples/example-1.png'
import materialExampleTwo from '../../assets/ui/image-studio/examples/example-2.png'
import modelLibraryOne from '../../assets/ui/image-studio/library/models/01.jpg'
import modelLibraryTwo from '../../assets/ui/image-studio/library/models/02.jpg'
import modelLibraryThree from '../../assets/ui/image-studio/library/models/03.jpg'
import modelLibraryFour from '../../assets/ui/image-studio/library/models/04.jpg'
import modelLibraryFive from '../../assets/ui/image-studio/library/models/05.jpg'
import modelLibrarySix from '../../assets/ui/image-studio/library/models/06.jpg'
import modelLibrarySeven from '../../assets/ui/image-studio/library/models/07.jpg'
import modelLibraryEight from '../../assets/ui/image-studio/library/models/08.jpg'
import modelLibraryNine from '../../assets/ui/image-studio/library/models/09.jpg'
import modelLibraryTen from '../../assets/ui/image-studio/library/models/10.jpg'
import modelLibraryEleven from '../../assets/ui/image-studio/library/models/11.jpg'
import modelLibraryTwelve from '../../assets/ui/image-studio/library/models/12.jpg'
import sceneLibraryOne from '../../assets/ui/image-studio/library/scenes/01.jpg'
import sceneLibraryTwo from '../../assets/ui/image-studio/library/scenes/02.jpg'
import sceneLibraryThree from '../../assets/ui/image-studio/library/scenes/03.jpg'
import sceneLibraryFour from '../../assets/ui/image-studio/library/scenes/04.jpg'
import sceneLibraryFive from '../../assets/ui/image-studio/library/scenes/05.jpg'
import sceneLibrarySix from '../../assets/ui/image-studio/library/scenes/06.jpg'
import sceneLibrarySeven from '../../assets/ui/image-studio/library/scenes/07.jpg'
import sceneLibraryEight from '../../assets/ui/image-studio/library/scenes/08.jpg'

export interface AiConfigView {
  endpoint: string; resolvedEndpoint?: string; model: string; timeoutMs: number; hasKey: boolean
  imageEndpoint: string; resolvedImageEndpoint?: string; imageModel: string; imageTimeoutMs: number; hasImageKey: boolean
  imageTextEndpoint: string; resolvedImageTextEndpoint?: string; imageTextModel: string; imageTextTimeoutMs: number; hasImageTextKey: boolean
}
export interface UploadAsset { name: string; size: number; dataUrl: string }
export interface MaterialExample { name: string; label: string; dataUrl: string; size: number }
/** 生成内容的类别：电商主图（1:1）与详情页长图（2:3 竖图）。 */
export type ImageKind = 'main' | 'selling' | 'white' | 'detail'
export interface GeneratedImage {
  kind: ImageKind
  url: string
  model: string
  elapsedMs: number
  mode: CreativeModeKey
  /** 历史记录字段：同一次提交的图片共享 sessionId。旧记录没有这些字段时仍可读取。 */
  sessionId?: string
  createdAt?: number
  title?: string
  prompt?: string
}

export const KIND_LABEL: Record<ImageKind, string> = { main: '主图', selling: '卖点图', white: '白底图', detail: '细节图' }
export const KIND_NOTE: Record<ImageKind, string> = { main: '按平台比例，用于商品列表与首图', selling: '突出核心卖点与使用场景', white: '干净白底，适合平台审核', detail: '展示材质、结构与使用细节' }
/**
 * 类别写进提示词：供应商只会照着描述画，不区分"主图/详情页"的版面语言，
 * 所以这里把用途、构图和留白要求交给它。
 */
export const KIND_PROMPT: Record<ImageKind, string> = {
  main: '输出用途：电商商品主图。要求：商品主体居中且完整、背景干净简洁、光线自然、四周留出文案空间；不要出现水印、平台标识和多余文字。',
  selling: '输出用途：电商商品卖点图。要求：用清晰的场景和构图表达商品核心卖点、材质和使用方式，留出可排版区域；不要出现水印、平台标识和无法确认的参数。',
  white: '输出用途：电商商品白底图。要求：纯白或接近白色背景、商品边缘清晰、完整展示商品本体、柔和自然阴影；不要出现水印、文字和其他物品。',
  detail: '输出用途：电商详情页长图（竖版）。要求：竖版构图，自上而下分层展示商品主体、材质细节与使用场景，版面留出分栏与文字排版空间；不要出现水印、平台标识和多余文字。'
}
/** 单张素材不超过 5MB；主进程允许商品复刻的商品图 + 最多 9 张竞品参考图。 */
export const MAX_MATERIAL_BYTES = 5 * 1024 * 1024

/* —— 顶部创作导航 ——
 * 七个页签共用同一套生图引擎（同一个供应商、同一个人工确认、同一份预览与保存），
 * 区别只在"预设"：出什么类别、什么尺寸、往提示词里补哪段版面要求、需不需要先上传素材图。
 * 这样每个页签点下去都真的能出图，不会出现点了没反应的装饰性入口。 */
export type CreativeModeKey = 'create' | 'detail' | 'model' | 'replicate' | 'edit' | 'quantity' | 'history'
export interface CreativeMode {
  key: CreativeModeKey
  label: string
  hint: string
  wantMain: boolean
  wantSelling?: boolean
  wantWhite?: boolean
  wantDetail: boolean
  size: string
  needsSource: boolean
  framing: string
  placeholder: string
}
export const HISTORY_STORAGE_KEY = 'shopilot.image-studio.history.v1'
/** 内存历史条数上限（不变） */
export const HISTORY_MAX_ITEMS = 500
/**
 * P1-6（2026-10-15 审查）：localStorage 落盘预算。条目是 base64 data URL（数 MB/张），
 * 浏览器配额约 5MB——不做预算裁剪时几乎必然超限，且旧实现把失败静默吞掉。
 */
export const HISTORY_STORAGE_BUDGET = 4 * 1024 * 1024

export interface ImageStudioGenerationOptions {
  /** 组件的 defineEmits：仅用于把生成中状态同步给外层（busy-change）。 */
  emit: (event: 'busy-change', busy: boolean) => void
}

export function useImageStudioGeneration(options: ImageStudioGenerationOptions) {
  const emit = options.emit

const creativeModes: CreativeMode[] = [
  {
    key: 'create',
    label: 'AI商品创作',
    hint: '上传商品素材图 + 写清要求，勾选要生成的内容（主图 / 详情页），AI 自动出专业电商套图。',
    wantMain: true,
    wantSelling: true,
    wantWhite: false,
    wantDetail: true,
    size: '1024x1024',
    needsSource: false,
    framing: '',
    placeholder: '例如：便携折叠露营椅，轻量铝合金支架，适合户外露营/钓鱼，重点突出稳固、轻便、收纳方便…'
  },
  {
    key: 'detail',
    label: '图文详情',
    hint: '按详情页长图排版生成：竖版分层展示主体、材质细节与使用场景。',
    wantMain: false,
    wantSelling: false,
    wantWhite: false,
    wantDetail: true,
    size: '1024x1024',
    needsSource: false,
    framing: '本次只出详情页长图：自上而下分成 3~4 个版面区块，依次呈现商品主体、材质细节特写、使用场景，块与块之间留出分隔与文字排版空间。',
    placeholder: '描述详情页要讲的内容，例如：第一屏产品全貌、第二屏釉面细节、第三屏早餐使用场景…'
  },
  {
    key: 'model',
    label: '模特图',
    hint: '生成"商品 + 真人使用场景"的照片；必须先上传商品素材图，让模型照着这个商品画。',
    wantMain: true,
    wantSelling: false,
    wantWhite: false,
    wantDetail: false,
    size: '1024x1536',
    needsSource: true,
    framing: '本次生成模特/真人使用场景图：画面中要有人物自然使用该商品，人物穿着与场景风格贴合商品调性，商品本身保持与参考图一致的外观。',
    placeholder: '描述模特与场景，例如：年轻女性清晨在厨房手持马克杯，暖调居家风，半身构图…'
  },
  {
    key: 'replicate',
    label: '商品复刻',
    hint: '保持商品本体不变，换背景/换场景重新出图（走图片编辑端点，需先上传商品素材图）。',
    wantMain: true,
    wantSelling: false,
    wantWhite: false,
    wantDetail: false,
    size: '1024x1024',
    needsSource: true,
    framing: '本次做商品复刻：严格保持参考图里商品的外形、材质、颜色与比例不变，只替换背景与拍摄环境，光影自然一致。',
    placeholder: '描述要换成什么环境，例如：换成原木色桌面 + 浅灰背景，柔和顶光…'
  },
  {
    key: 'edit',
    label: '自由编辑',
    hint: '按你的描述直接改图（走图片编辑端点，需先上传一张参考图）。',
    wantMain: true,
    wantSelling: false,
    wantWhite: false,
    wantDetail: false,
    size: '1024x1024',
    needsSource: false,
    framing: '本次是按描述自由编辑参考图：保留商品主体可辨认，按描述调整画面内容；不要添加水印与平台标识。',
    placeholder: '描述要怎么改，例如：把杯子里的咖啡换成茶，背景加一株绿植，整体调亮…'
  },
  {
    key: 'quantity',
    label: '商品数量图',
    hint: '生成说明数量/规格/套装组成的电商图，版面留出标注空间。',
    wantMain: true,
    wantSelling: false,
    wantWhite: false,
    wantDetail: false,
    size: '1024x1024',
    needsSource: true,
    framing: '本次生成商品数量/规格说明图：在画面中清楚呈现商品的数量、规格或套装组成（例如同时出现多件商品或列出规格），并留出可标注文字的空间；不要凭空编造具体数字。',
    placeholder: '描述数量与规格，例如：一套 4 只同款马克杯并排陈列，标注容量与件数…'
  },
  {
    key: 'history',
    label: '创作历史',
    hint: '查看本次会话生成过的图片，点一张在右侧预览并保存。',
    wantMain: true,
    wantSelling: true,
    wantWhite: false,
    wantDetail: true,
    size: '1024x1024',
    needsSource: false,
    framing: '',
    placeholder: ''
  }
]
function modeLabel(key: CreativeModeKey): string {
  return creativeModes.find(item => item.key === key)?.label || key
}

const prompt = ref('')
const productName = ref('')
const mainSize = ref('1024x1024')
/** 选择生成内容：主图 / 详情页各自勾选与张数 */
const wantMain = ref(true)
const wantSelling = ref(true)
const wantWhite = ref(false)
const wantDetail = ref(true)
const mainCount = ref(1)
const sellingCount = ref(2)
const whiteCount = ref(1)
const detailCount = ref(2)
const generationStyleOptions = ['爆款风格', '简约风格', '高级质感', '场景种草']
const platformOptions = ['通用', '抖店', '淘系', '小红书', '微信', '拼多多', '1688', '快手', '有赞', '微盟', '快团团']
const generationStyle = ref('爆款风格')
const unifiedStyle = ref(false)
const platform = ref('通用')
/** 当前创作导航页签；切换时套用该页签的预设 */
const mode = ref<CreativeModeKey>('create')
const modeConfig = computed(() => creativeModes.find(item => item.key === mode.value) || creativeModes[0])
const materialLimit = computed(() => mode.value === 'quantity' ? 5 : mode.value === 'model' ? 2 : mode.value === 'replicate' ? 1 : 3)
const promptMaxLength = computed(() => mode.value === 'edit' ? 2000 : mode.value === 'detail' ? 300 : 500)
// 图文详情工作区的真实配置；这些字段会参与预览和生成提示词。
const detailNoteStyle = ref('种草分享')
const detailCardCount = ref(6)
const detailRatio = ref('3:4')
const detailPreviewAspectRatio = computed(() => {
  const [width, height] = detailRatio.value.split(':').map(Number)
  return width > 0 && height > 0 ? `${width} / ${height}` : '3 / 4'
})
const fontOptions = IMAGE_STUDIO_FONT_OPTIONS
const detailFont = ref('auto')
const detailCasePlaying = ref(true)
const detailCasePhase = ref(0)
const detailCaseArts = [detailCoverArt, detailCollectionArt, detailStylesArt, detailDetailArt, detailSignatureArt, detailSceneArt]
const detailCaseLabels = ['穿搭封面', '款式合集', '风格搭配', '面料细节', '标志元素', '场景灵感']
const detailPreviewArt = computed(() => materials.value[0]?.dataUrl || detailCaseArts[detailCasePhase.value] || detailCoverArt)
const editCasePlaying = ref(true)
const editCaseProgress = ref(0)
let caseTimer: ReturnType<typeof setInterval> | undefined
/** 商品素材图：1~3 张，生成时作为图片编辑端点的原图、分析时交给文本模型读图 */
const materials = ref<UploadAsset[]>([])
const showMaterialExamples = ref(false)
const materialExamples: MaterialExample[] = [
  { name: 'example-1.png', label: '示例1', dataUrl: materialExampleOne, size: 0 },
  { name: 'example-2.png', label: '示例2', dataUrl: materialExampleTwo, size: 0 }
]
const materialInput = ref<HTMLInputElement | null>(null)
const referenceInput = ref<HTMLInputElement | null>(null)
const competitorInput = ref<HTMLInputElement | null>(null)
const modelLibraryInput = ref<HTMLInputElement | null>(null)
const sceneLibraryInput = ref<HTMLInputElement | null>(null)
const sceneReferenceInput = ref<HTMLInputElement | null>(null)
const referenceMaterial = ref<UploadAsset | null>(null)
const competitorReferences = ref<UploadAsset[]>([])
const referenceUploadError = ref('')
const variantCounts = ref<number[]>([])
const quantityCopy = ref('')
const modelGender = ref('女')
const modelAge = ref('青年')
const modelEthnicity = ref('中国人')
const modelBody = ref('标准')
const modelAppearance = ref('')
const modelLibraryUploads = ref<UploadAsset[]>([])
const modelLibraryUploadError = ref('')
const modelScene = ref('智能推荐')
const sceneLibraryUploads = ref<UploadAsset[]>([])
const sceneLibraryUploadError = ref('')
const sceneReference = ref<UploadAsset | null>(null)
const sceneGenerating = ref(false)
const sceneGenerationError = ref('')
// 与参考站一致：首次打开“模特图”默认进入系统模特库，其他来源由用户主动切换。
const modelSource = ref<'library' | 'ai' | 'mine'>('library')
const modelCount = ref(1)
const sceneSource = ref<'library' | 'ai' | 'mine'>('library')
const modelSourceOptions = [{ key: 'library' as const, label: '模特库' }, { key: 'ai' as const, label: 'AI生成' }, { key: 'mine' as const, label: '我的模特库' }]
const sceneSourceOptions = [{ key: 'library' as const, label: '场景库' }, { key: 'ai' as const, label: 'AI生成' }, { key: 'mine' as const, label: '我的场景库' }]
const modelLibraryArt = [modelLibraryOne, modelLibraryTwo, modelLibraryThree, modelLibraryFour, modelLibraryFive, modelLibrarySix, modelLibrarySeven, modelLibraryEight, modelLibraryNine, modelLibraryTen, modelLibraryEleven, modelLibraryTwelve]
const modelLibraryOptions = Array.from({ length: 12 }, (_item, index) => ({ key: `model-${index + 1}`, label: `模特 ${index + 1}`, dataUrl: modelLibraryArt[index] }))
const sceneLibraryOptions = [
  { key: 'indoor', label: '室内生活方式', dataUrl: sceneLibraryOne },
  { key: 'cafe', label: '咖啡馆氛围', dataUrl: sceneLibraryTwo },
  { key: 'outdoor', label: '户外自然光', dataUrl: sceneLibraryThree },
  { key: 'beach', label: '海边度假', dataUrl: sceneLibraryFour },
  { key: 'studio', label: '棚拍纯色背景', dataUrl: sceneLibraryFive },
  { key: 'street', label: '城市街拍', dataUrl: sceneLibrarySix },
  { key: 'garden', label: '花园草地', dataUrl: sceneLibrarySeven },
  { key: 'desk', label: '桌面静物', dataUrl: sceneLibraryEight }
]
const editPreset = ref('translate')
const editCaseArt = computed(() => {
  const preset = editPresetOptions.find(item => item.key === editPreset.value)
  return { before: preset?.before || referenceArt, after: preset?.after || resultArt }
})
const editPresetOptions = [
  { key: 'translate', label: '图片翻译', thumb: referenceArt, before: referenceArt, after: replicaArt, prompt: '将图片中的文字翻译成简体中文，保持原有排版与商品主体不变。' },
  { key: 'expand', label: '智能扩图', thumb: replicaArt, before: referenceArt, after: effectThreeArt, prompt: '智能扩展画布边缘，补全自然背景，保持商品主体比例和清晰度不变。' },
  { key: 'enhance', label: '高清修复', thumb: effectThreeArt, before: resultArt, after: replicaArt, prompt: '提升图片清晰度与细节，修复轻微噪点和模糊，不改变商品外观。' },
  { key: 'background', label: '背景替换', thumb: modelProductArt, before: referenceArt, after: effectThreeArt, prompt: '替换为干净且符合商品调性的背景，保留商品主体、边缘和自然阴影。' },
  { key: 'recolor', label: '商品改色', thumb: quantityProductArt, before: referenceArt, after: quantityProductArt, prompt: '只改变商品指定颜色，保持材质纹理、结构、光影和视角一致。' },
  { key: 'remove', label: '杂物消除', thumb: detailCoverArt, before: resultArt, after: referenceArt, prompt: '移除画面中与商品无关的杂物，并自然补全被遮挡的背景。' }
]
function resetEditSession() {
  prompt.value = ''
  referenceMaterial.value = null
  referenceUploadError.value = ''
  generatedImages.value = []
  generationError.value = ''
  generationNotice.value = ''
  activeImageIndex.value = 0
}
const selectedRatio = ref('1:1')
const ratioOptions = IMAGE_STUDIO_RATIO_OPTIONS
const freeEditRatioOptions = IMAGE_STUDIO_FREE_EDIT_RATIO_OPTIONS
const selectedFont = ref('auto')
const uploadError = ref('')
/** 需要"商品本体"的页签（模特图 / 商品复刻 / 自由编辑）：没有图就不该让用户按下生成，浪费一次调用 */
const modeNeedsSource = computed(() => modeConfig.value.needsSource && (mode.value === 'edit' ? !referenceMaterial.value : !materials.value.length))
const modeNeedsReference = computed(() => mode.value === 'replicate' ? !competitorReferences.value.length : mode.value === 'edit' && !referenceMaterial.value)
// “我的”库必须和界面上的 active 卡片保持一致；不能在用户没有选择时
// 静默回退到第一张图片，否则确认框和实际发给模型的参考图会对不上。
const selectedModelLibraryAsset = computed(() => modelLibraryUploads.value.find(item => item.name === modelAppearance.value) || null)
const selectedSceneLibraryAsset = computed(() => sceneLibraryUploads.value.find(item => item.name === modelScene.value) || null)
const libraryAssetRequirement = computed(() => {
  if (mode.value !== 'model') return ''
  const missing: string[] = []
  if (modelSource.value === 'library' && !selectedSystemModelAsset.value) missing.push('请先从模特库选择一个模特形象')
  if (modelSource.value === 'mine' && !selectedModelLibraryAsset.value) missing.push('请先上传并选择我的模特库图片')
  if (sceneSource.value === 'mine' && !selectedSceneLibraryAsset.value) missing.push('请先上传并选择我的场景库图片')
  return missing.join('；')
})
const modeNeedsLibraryAsset = computed(() => Boolean(libraryAssetRequirement.value))
const selectedSystemModelAsset = computed<UploadAsset | null>(() => {
  if (modelSource.value !== 'library') return null
  const item = modelLibraryOptions.find(option => option.label === modelAppearance.value)
  return item ? { name: `${item.key}.jpg`, size: 0, dataUrl: item.dataUrl } : null
})
const selectedSystemSceneAsset = computed<UploadAsset | null>(() => {
  if (sceneSource.value !== 'library' || modelScene.value === '智能推荐') return null
  const item = sceneLibraryOptions.find(option => option.label === modelScene.value)
  return item ? { name: `${item.key}.jpg`, size: 0, dataUrl: item.dataUrl } : null
})
const needsPrompt = computed(() => {
  if (['detail', 'quantity', 'model', 'replicate'].includes(mode.value)) return false
  if (mode.value === 'create') return !prompt.value.trim() && !materials.value.length
  return !prompt.value.trim()
})
const generateButtonLabel = computed(() => mode.value === 'create' ? (!materials.value.length ? '请上传商品素材图' : '立即生成') : mode.value === 'detail' ? '生成图文详情' : mode.value === 'model' ? 'AI生成模特' : mode.value === 'replicate' ? '开始复刻' : mode.value === 'edit' ? '发送生成请求' : mode.value === 'quantity' ? '生成数量图' : '立即生成')
const config = ref<AiConfigView | null>(null)
const generationError = ref('')
const generationNotice = ref('')
const generating = ref(false)
const confirmOpen = ref(false)
const sceneConfirmOpen = ref(false)
const generatedImages = ref<GeneratedImage[]>([])
/** 历史页点击“查看会话”时，允许这一次模式切换带着已恢复的结果进入创作页。 */
const restoringHistorySession = ref(false)
const activeImageIndex = ref(0)
const historyImages = ref<GeneratedImage[]>([])
const savedPath = ref('')
const saveNotice = ref('')
const saveNoticeError = ref(false)
const generationBusy = computed(() => generating.value || sceneGenerating.value)
watch(generationBusy, busy => emit('busy-change', busy), { immediate: true })

/** 切换创作页签 = 套用预设：不覆盖用户已经写好的描述（那是他的输入），只改生成参数 */
watch(mode, (next) => {
  // 离开当前创作模式时清掉上一模式的预览，避免旧图片被误认为新模式的结果。
  // 只有历史页明确点击“查看会话”时才保留恢复的那组图片；普通导航仍从空状态开始。
  if (!restoringHistorySession.value) {
    generatedImages.value = []
    activeImageIndex.value = 0
    savedPath.value = ''
    saveNotice.value = ''
    saveNoticeError.value = false
  } else restoringHistorySession.value = false
  const preset = creativeModes.find(item => item.key === next)
  if (!preset || next === 'history') return
  wantMain.value = preset.wantMain
  wantSelling.value = Boolean(preset.wantSelling)
  wantWhite.value = Boolean(preset.wantWhite)
  wantDetail.value = preset.wantDetail
  mainSize.value = preset.size
  selectedRatio.value = next === 'model' ? '2:3' : next === 'detail' ? detailRatio.value : '1:1'
  generationError.value = ''
  generationNotice.value = ''
  // Each mode owns its upload controls. Do not carry a validation message
  // from the previous mode into the newly selected page (for example, the
  // model page's material-limit warning appearing on 商品复刻).
  uploadError.value = ''
  referenceUploadError.value = ''
  modelLibraryUploadError.value = ''
  sceneLibraryUploadError.value = ''
  sceneGenerationError.value = ''
})
watch(detailRatio, (next) => {
  // 图文详情使用独立的“发布比例”控件；生成请求仍走统一 selectedRatio，
  // 因此在详情页内修改比例时要立即同步，避免预览与实际请求尺寸不一致。
  if (mode.value === 'detail') selectedRatio.value = next
})
watch(sceneSource, (next) => {
  if (next === 'library' && !modelScene.value) modelScene.value = '智能推荐'
  if (next === 'ai' && modelScene.value === '智能推荐') modelScene.value = ''
})
watch(materials, (next) => {
  variantCounts.value = next.map((_item, index) => Math.max(1, Number(variantCounts.value[index]) || 1))
}, { deep: true })
const configured = computed(() => Boolean(config.value?.hasImageKey && config.value.imageEndpoint && config.value.resolvedImageEndpoint && config.value.imageModel))
/** 单独的"生图文本 API"（可选，配了就优先用它） */
/** 页面不再选模型：直接用设置里配置的那个（确认框与结果都显示它）。 */
const usedModel = computed(() => config.value?.imageModel || '')
const selectedFontOption = computed(() => getImageStudioFont(selectedFont.value))
const detailFontOption = computed(() => getImageStudioFont(detailFont.value))
const effectiveFontOption = computed(() => mode.value === 'detail' ? detailFontOption.value : selectedFontOption.value)
const fontLicenseHint = '可能存在版权风险，需要人工审核'
function restartDetailCase() {
  detailCasePhase.value = 0
  detailCasePlaying.value = true
}
const analyzing = ref(false)
const analyzeError = ref('')
const analyzeNote = ref('')
const analyzeConfirmOpen = ref(false)
const analyzeImages = computed(() => materials.value.slice(0, ANALYSIS_MAX_IMAGES).map(item => ({ name: item.name, dataUrl: item.dataUrl })))
const canAnalyze = computed(() => canAnalyzeProduct({ productName: productName.value, prompt: prompt.value, images: analyzeImages.value }))
const analyzeTitle = computed(() => canAnalyze.value
  ? '把商品名称、描述和最多 3 张素材图交给生图文本 API，整理成可直接使用的图片描述'
  : '请先上传商品素材图，或填写商品名称/描述')

function requestAnalyzeProduct() {
  if (analyzing.value) return
  analyzeError.value = ''
  analyzeNote.value = ''
  if (!canAnalyze.value) { analyzeError.value = describeAnalysisError({ code: 'AI_EMPTY_SOURCE' }); return }
  if (prompt.value.trim()) { analyzeConfirmOpen.value = true; return }
  void runAnalyzeProduct()
}

async function runAnalyzeProduct() {
  analyzeConfirmOpen.value = false
  if (!window.shopilot) { analyzeError.value = '当前预览环境没有可用的生图文本 API。'; return }
  // 组参与清洗都在纯模块里（features/workbench/image-text-analysis.ts），这里只负责发请求与写回
  const input = buildAnalysisInput({ productName: productName.value, prompt: prompt.value, images: analyzeImages.value })
  analyzing.value = true
  try {
    const res = await window.shopilot.ai.analyzeImageProduct(input)
    if (!res.ok) { analyzeError.value = describeAnalysisError(res.error); return }
    const data = res.data as { text?: string; source?: string; imageCount?: number } | undefined
    // 主进程的图片生成只接受 ≤4000 字符的 prompt；这里再按当前页签的输入长度收一次，避免计数条爆表
    const text = analysisPromptText(String(data?.text || '')).slice(0, promptMaxLength.value)
    if (!text) { analyzeError.value = 'AI 没有返回可用的描述，请补充商品名称或卖点后重试。'; return }
    prompt.value = text
    const source = data?.source === 'main-text' ? '主文本 API 回退' : '生图文本模型'
    const imageCount = Number(data?.imageCount || 0)
    analyzeNote.value = `已用${source}整理描述${imageCount ? `（读了 ${imageCount} 张素材图）` : '（本次未读图）'}，已写入上方输入框`
  } catch (error) {
    analyzeError.value = describeAnalysisError(error)
  } finally {
    analyzing.value = false
  }
}
function adjustContentCount(kind: 'main' | 'selling' | 'white' | 'detail', delta: number) {
  const limits = { main: 4, selling: 4, white: 4, detail: 2 }
  const refs = { main: mainCount, selling: sellingCount, white: whiteCount, detail: detailCount }
  refs[kind].value = Math.min(limits[kind], Math.max(1, Number(refs[kind].value) + delta))
}
function normalizeContentCount(kind: 'main' | 'selling' | 'white' | 'detail' | 'detailShort') {
  const refs = { main: mainCount, selling: sellingCount, white: whiteCount, detail: detailCardCount, detailShort: detailCount }
  const limits = { main: 4, selling: 4, white: 4, detail: 9, detailShort: 2 }
  const ref = refs[kind]
  const value = Number(ref.value)
  ref.value = Number.isFinite(value) ? Math.min(limits[kind], Math.max(1, Math.round(value))) : 1
}
const activeImage = computed(() => generatedImages.value[activeImageIndex.value] || null)
const activeKindLabel = computed(() => activeImage.value ? KIND_LABEL[activeImage.value.kind] : '')
/**
 * 本次要发几次请求：主图用你选的比例，详情页固定 2:3 竖图。
 * 拆成两次请求而不是一次画两张——"主图"和"详情页"是不同的版面语言，
 * 一次请求里让模型同时画两种，它会画成同一张的两种尺寸（这不是用户要的）。
 */
const plannedJobs = computed(() => {
  const jobs: Array<{ kind: ImageKind; label: string; size: string; count: number }> = []
  const ratioToSize = imageStudioRequestSize
  const ratioSize = ratioToSize(selectedRatio.value)
  const addBatched = (kind: ImageKind, label: string, size: string, total: number) => {
    for (let remaining = Math.max(1, Math.round(total)); remaining > 0; remaining -= 4) jobs.push({ kind, label, size, count: Math.min(4, remaining) })
  }
  const singleImageMode = ['model', 'replicate', 'edit', 'quantity'].includes(mode.value)
  if (singleImageMode || wantMain.value) addBatched('main', mode.value === 'model' ? '模特图' : KIND_LABEL.main, ratioSize || mainSize.value, mode.value === 'model' ? Math.min(5, Math.max(1, Number(modelCount.value) || 1)) : Math.min(4, Math.max(1, Number(mainCount.value) || 1)))
  if (!singleImageMode && wantSelling.value) addBatched('selling', KIND_LABEL.selling, ratioSize || mainSize.value, Math.min(4, Math.max(1, Number(sellingCount.value) || 1)))
  if (!singleImageMode && wantWhite.value) addBatched('white', KIND_LABEL.white, '1024x1024', Math.min(4, Math.max(1, Number(whiteCount.value) || 1)))
  if (!singleImageMode && wantDetail.value) {
    const detailTotal = mode.value === 'detail' ? Math.min(9, Math.max(1, Number(detailCardCount.value) || 1)) : Math.min(2, Math.max(1, Number(detailCount.value) || 1))
    const detailSize = mode.value === 'detail' ? ratioToSize(detailRatio.value) : '1024x1536'
    // 图片接口单次最多 4 张；图文详情的 5–9 张拆成多个真实请求，避免页脚承诺数量却只提交 1 张。
    addBatched('detail', KIND_LABEL.detail, detailSize, detailTotal)
  }
  return jobs
})
const planSummary = computed(() => {
  const grouped = new Map<string, { label: string; count: number; size: string }>()
  for (const job of plannedJobs.value) {
    const previous = grouped.get(job.kind)
    if (previous) previous.count += job.count
    else grouped.set(job.kind, { label: job.label, count: job.count, size: job.size })
  }
  return [...grouped.values()].map(job => `${job.label} ${job.count} 张（${job.size}）`).join(' + ') || '未选择生成内容'
})
const plannedOutputCount = computed(() => plannedJobs.value.reduce((total, job) => total + job.count, 0))
/** 结果按类别分组展示（主图一组、详情页一组），顺序与请求顺序一致。 */
const generatedGroups = computed(() => (['main', 'selling', 'white', 'detail'] as ImageKind[]).map(kind => ({
  kind,
  label: KIND_LABEL[kind],
  note: KIND_NOTE[kind],
  items: generatedImages.value.map((image, index) => ({ image, index })).filter(item => item.image.kind === kind)
})).filter(group => group.items.length))
async function loadAiConfig() {
  // Vite preview has no Electron preload bridge. Keep the page usable for
  // visual review while the packaged desktop build still reads real settings.
  if (!window.shopilot) {
    config.value = null
    return
  }
  try {
    const imageResult = await window.shopilot.ai.imageConfigGet()
    if (!imageResult.ok) throw new Error(imageResult.error.message)
    config.value = imageResult.data as AiConfigView
  } catch (error: any) {
    config.value = null
  }
}

function readImage(file: File, onDone: (asset: UploadAsset) => void, onError?: (message: string) => void) {
  const fail = (message: string) => { if (onError) onError(message); else uploadError.value = message }
  if (!['image/png', 'image/jpeg'].includes(file.type.toLowerCase())) { fail(`${file.name}：只支持 PNG 或 JPEG。`); return }
  if (file.size > MAX_MATERIAL_BYTES) { fail(`${file.name}：超过 5MB，请压缩后再上传。`); return }
  const reader = new FileReader()
  reader.onload = () => {
    if (typeof reader.result !== 'string') { fail(`${file.name}：图片读取失败，请重试。`); return }
    // MIME/扩展名可以被伪造；在写入状态前确认浏览器确实能解码出图片。
    const image = new Image()
    image.onload = () => image.naturalWidth > 0 && image.naturalHeight > 0
      ? onDone({ name: file.name, size: file.size, dataUrl: reader.result as string })
      : fail(`${file.name}：图片内容无效，请选择可正常打开的 PNG 或 JPEG。`)
    image.onerror = () => fail(`${file.name}：图片内容无效，请选择可正常打开的 PNG 或 JPEG。`)
    image.src = reader.result
  }
  reader.onerror = () => fail(`${file.name}：图片读取失败，请重试。`)
  reader.readAsDataURL(file)
}

/** 把一批文件收进素材列表：过滤格式/大小、去重、上限 5 张 */
function addMaterials(files: FileList | File[] | null | undefined) {
  uploadError.value = ''
  const list = Array.from(files || [])
  if (!list.length) return
  const room = materialLimit.value - materials.value.length
  if (room <= 0) { uploadError.value = `最多上传 ${materialLimit.value} 张素材图，先删掉一张再传。`; return }
  if (list.length > room) uploadError.value = `只剩 ${room} 个位置，本次只收前 ${room} 张。`
  for (const file of list.slice(0, room)) {
    if (materials.value.some(item => item.name === file.name && item.size === file.size)) continue
    readImage(file, asset => { if (materials.value.length < materialLimit.value) materials.value.push(asset) })
  }
}
async function addExampleMaterial(example: MaterialExample) {
  uploadError.value = ''
  if (materials.value.length >= materialLimit.value) {
    uploadError.value = `最多上传 ${materialLimit.value} 张素材图，先删掉一张再传。`
    return
  }
  if (materials.value.some(item => item.name === example.name)) return
  try {
    const response = await fetch(example.dataUrl)
    const blob = await response.blob()
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string' && materials.value.length < materialLimit.value) {
        materials.value.push({ name: example.name, size: blob.size, dataUrl: reader.result })
      }
    }
    reader.readAsDataURL(blob)
  } catch {
    // 构建产物的本地资源始终可读；这里保留 URL 作为离线预览兜底。
    materials.value.push({ name: example.name, size: example.size, dataUrl: example.dataUrl })
  }
}
function onMaterialFiles(event: Event) {
  const input = event.target as HTMLInputElement
  addMaterials(input.files)
  input.value = ''
}
function onMaterialDrop(event: DragEvent) { addMaterials(event.dataTransfer?.files) }
function removeMaterial(index: number) { materials.value.splice(index, 1) }
function normalizeVariantCount(index: number) {
  const value = Number(variantCounts.value[index])
  variantCounts.value[index] = Number.isFinite(value) ? Math.min(99, Math.max(1, Math.round(value))) : 1
}
function updateQuantityCopy(event: Event) {
  const input = event.target as HTMLInputElement
  const value = input.value.slice(0, 20)
  if (input.value !== value) input.value = value
  quantityCopy.value = value
}
function addLibraryAssets(files: FileList | File[] | null | undefined, target: { value: UploadAsset[] }, max = 12, onAdded?: (asset: UploadAsset) => void, onError?: (message: string) => void) {
  const list = Array.from(files || [])
  if (list.length > Math.max(0, max - target.value.length)) onError?.(`最多保存 ${max} 张图片，本次只收前 ${Math.max(0, max - target.value.length)} 张。`)
  for (const file of list.slice(0, Math.max(0, max - target.value.length))) {
    if (target.value.some(item => item.name === file.name && item.size === file.size)) continue
    readImage(file, asset => { if (target.value.length < max) { target.value.push(asset); onAdded?.(asset) } }, onError)
  }
}
function onModelLibraryFiles(event: Event) {
  modelLibraryUploadError.value = ''
  addLibraryAssets((event.target as HTMLInputElement).files, modelLibraryUploads, 12, asset => {
    if (!modelLibraryUploads.value.some(item => item.name === modelAppearance.value)) modelAppearance.value = asset.name
  }, message => { modelLibraryUploadError.value = message })
  ;(event.target as HTMLInputElement).value = ''
}
function onSceneLibraryFiles(event: Event) {
  sceneLibraryUploadError.value = ''
  addLibraryAssets((event.target as HTMLInputElement).files, sceneLibraryUploads, 12, asset => {
    if (!sceneLibraryUploads.value.some(item => item.name === modelScene.value)) modelScene.value = asset.name
  }, message => { sceneLibraryUploadError.value = message })
  ;(event.target as HTMLInputElement).value = ''
}
function onReferenceFile(event: Event) {
  referenceUploadError.value = ''
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (!['image/png', 'image/jpeg'].includes(file.type.toLowerCase())) { referenceUploadError.value = '参考图只支持 PNG 或 JPEG。'; input.value = ''; return }
  if (file.size > MAX_MATERIAL_BYTES) { referenceUploadError.value = '参考图不能超过 5MB。'; input.value = ''; return }
  readImage(file, asset => { referenceMaterial.value = asset }, message => { referenceUploadError.value = message })
  input.value = ''
}
function onSceneReferenceFile(event: Event) {
  sceneGenerationError.value = ''
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (!['image/png', 'image/jpeg'].includes(file.type.toLowerCase())) { sceneGenerationError.value = '场景参考图只支持 PNG 或 JPEG。'; input.value = ''; return }
  if (file.size > MAX_MATERIAL_BYTES) { sceneGenerationError.value = '场景参考图不能超过 5MB。'; input.value = ''; return }
  // 与商品素材走同一套真实图片解码校验，避免 MIME 正确但内容损坏的文件进入生成请求。
  readImage(file, asset => { sceneReference.value = asset }, message => { sceneGenerationError.value = message })
  input.value = ''
}
function addCompetitorReferences(files: FileList | File[] | null | undefined) {
  referenceUploadError.value = ''
  const list = Array.from(files || [])
  if (!list.length) return
  const room = 9 - competitorReferences.value.length
  if (room <= 0) { referenceUploadError.value = '最多上传 9 张竞品参考图，请先删掉一张再传。'; return }
  if (list.length > room) referenceUploadError.value = `只剩 ${room} 个位置，本次只收前 ${room} 张。`
  for (const file of list.slice(0, room)) {
    if (!['image/png', 'image/jpeg'].includes(file.type.toLowerCase())) { referenceUploadError.value = `${file.name}：参考图只支持 PNG 或 JPEG。`; continue }
    if (file.size > MAX_MATERIAL_BYTES) { referenceUploadError.value = `${file.name}：参考图不能超过 5MB。`; continue }
    if (competitorReferences.value.some(item => item.name === file.name && item.size === file.size)) continue
    readImage(file, asset => { if (competitorReferences.value.length < 9) competitorReferences.value.push(asset) }, message => { referenceUploadError.value = message })
  }
}
function onCompetitorFiles(event: Event) {
  const input = event.target as HTMLInputElement
  addCompetitorReferences(input.files)
  input.value = ''
}
function onCompetitorDrop(event: DragEvent) { addCompetitorReferences(event.dataTransfer?.files) }
function removeCompetitorReference(index: number) { competitorReferences.value.splice(index, 1) }

function requestGeneration() {
  generationError.value = ''; generationNotice.value = ''
  if (!configured.value) { generationError.value = '当前没有可用的真实 AI 配置，请先打开设置中心。'; return }
  if (modeNeedsSource.value) { generationError.value = `「${modeConfig.value.label}」需要先上传商品素材图作为原图。`; return }
  if (modeNeedsReference.value) { generationError.value = mode.value === 'edit' ? '自由编辑请先上传参考图，再描述要修改的内容。' : '商品复刻请先上传竞品参考图，便于借鉴构图和风格。'; return }
  if (modeNeedsLibraryAsset.value) { generationError.value = libraryAssetRequirement.value; return }
  if (!plannedJobs.value.length) { generationError.value = '请至少勾选一项要生成的内容（主图 / 详情页）。'; return }
  if (needsPrompt.value) { generationError.value = '请先填写生成描述，或上传商品素材图让模型读取商品。'; return }
  confirmOpen.value = true
}

function buildPrompt(kind: ImageKind, modeKey: CreativeModeKey = mode.value) {
  const requestMode = creativeModes.find(item => item.key === modeKey) || modeConfig.value
  return [
    prompt.value.trim(),
    productName.value.trim() ? `商品名称：${productName.value.trim()}` : '',
    `生图设置：模型 ${usedModel.value || '设置中心未配置'}，比例 ${selectedRatio.value}，字体 ${effectiveFontOption.value.prompt}`,
    modeKey === 'create' ? `生成风格：${generationStyle.value}${unifiedStyle.value ? '（统一风格）' : ''}；平台：${platform.value}` : '',
    modeKey === 'quantity' && materials.value.length ? `商品数量图：${materials.value.map((item, index) => `${item.name} ${Math.min(99, Math.max(1, Math.round(Number(variantCounts.value[index]) || 1)))} 件`).join('、')}` : '',
    modeKey === 'quantity' ? `指定文案：${quantityCopy.value.trim() || '不强制渲染文字，只清晰呈现商品数量'}` : '',
    modeKey === 'model' ? `模特来源：${modelSourceOptions.find(item => item.key === modelSource.value)?.label || 'AI生成'}；模特参数：${modelGender.value}，${modelAge.value}，${modelEthnicity.value}，${modelBody.value}${modelAppearance.value.trim() ? `；外貌细节：${modelAppearance.value.trim()}` : ''}${modelSource.value === 'mine' && selectedModelLibraryAsset.value ? `；使用我的模特库参考图：${selectedModelLibraryAsset.value.name}` : ''}；场景来源：${sceneSourceOptions.find(item => item.key === sceneSource.value)?.label || '场景库'}；场景偏好：${modelScene.value}${sceneSource.value === 'mine' && selectedSceneLibraryAsset.value ? `；使用我的场景库参考图：${selectedSceneLibraryAsset.value.name}` : ''}；生成数量：${modelCount.value} 张` : '',
    modeKey === 'replicate' && competitorReferences.value.length ? `竞品参考图：${competitorReferences.value.length} 张；借鉴参考图的构图、光影与风格，但保持商品主体来自商品素材图` : '',
    modeKey === 'edit' && referenceMaterial.value ? '编辑参考图：按编辑要求修改这张原图，保持商品主体可辨认' : '',
    modeKey === 'detail' ? `图文详情配置：${detailNoteStyle.value}，${detailCardCount.value} 张卡片，${detailRatio.value} 比例，字体 ${detailFontOption.value.prompt}；请输出完整的图文详情长图，文字区域保持清晰可读，不要生成虚假品牌标识` : '',
    requestMode.framing,
    KIND_PROMPT[kind]
  ].filter(Boolean).join('；')
}

function toImageSource(asset: UploadAsset | null) {
  if (!asset) return null
  const match = /^data:([^;]+);base64,(.+)$/i.exec(asset.dataUrl)
  if (!match) return null
  return { name: asset.name, mimeType: match[1].toLowerCase(), b64Json: match[2] }
}
async function toImageSourceAsync(asset: UploadAsset | null) {
  const direct = toImageSource(asset)
  if (direct || !asset) return direct
  try {
    const response = await fetch(asset.dataUrl)
    if (!response.ok) return null
    const blob = await response.blob()
    const dataUrl = await new Promise<string | null>(resolve => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
    return toImageSource(dataUrl ? { ...asset, dataUrl } : null)
  } catch {
    return null
  }
}

async function requestSceneGeneration() {
  if (sceneGenerating.value) return
  sceneGenerationError.value = ''
  if (!configured.value) { sceneGenerationError.value = '请先在设置中心配置生图模型。'; return }
  if (!window.shopilot) { sceneGenerationError.value = '当前预览环境没有可用的图片生成接口。'; return }
  if (!materials.value.length && !sceneReference.value) { sceneGenerationError.value = '请先上传商品素材图或场景参考图。'; return }
  sceneConfirmOpen.value = true
}

async function submitSceneGeneration() {
  if (sceneGenerating.value) return
  sceneGenerating.value = true
  sceneConfirmOpen.value = false
  try {
    // 在任何异步读取开始前固定本次请求的素材、描述和尺寸，避免用户切换来源时
    // 确认框所见与实际发出的请求不一致。
    const requestScene = modelScene.value.trim() || '自然、干净、适合商品展示的生活方式场景'
    const requestSize = imageStudioRequestSize(selectedRatio.value)
    const assets = [...materials.value, ...(sceneReference.value ? [sceneReference.value] : [])]
    const directSources = assets.map(toImageSource)
    const sourceImages = (await Promise.all(assets.map((asset, index) => directSources[index] || toImageSourceAsync(asset))))
      .filter((item): item is { name: string; mimeType: string; b64Json: string } => Boolean(item))
    if (sourceImages.length !== assets.length) throw new Error('部分素材读取失败，请重新上传后再试。')
    const result = await window.shopilot.ai.generateImage({
      prompt: `生成一张商品模特图使用的场景参考图。场景描述：${requestScene}。保留商品素材的色彩和光线关系，不要人物、水印、品牌标识或额外文字。`,
      size: requestSize,
      n: 1,
      confirmed: true,
      sourceImages
    })
    if (!result.ok) throw new Error(result.error.message)
    const item = Array.isArray(result.data?.images) ? result.data.images[0] : null
    const url = item?.b64Json ? `data:${item.mimeType || 'image/png'};base64,${item.b64Json}` : String(item?.url || '')
    if (!url) throw new Error('接口没有返回场景图片')
    const asset = { name: `ai-scene-${Date.now()}.png`, size: 0, dataUrl: url }
    sceneLibraryUploads.value = [asset, ...sceneLibraryUploads.value].slice(0, 12)
    modelScene.value = asset.name
    sceneSource.value = 'mine'
  } catch (error: any) {
    sceneGenerationError.value = error?.message || '场景生成失败，请重试。'
  } finally {
    sceneGenerating.value = false
  }
}


  /** 详情页示例轮播计时器（原组件 onMounted 里 setup，onBeforeUnmount 里清理）。 */
  function startCaseTimer(): void {
    caseTimer = setInterval(() => {
      if (detailCasePlaying.value && !materials.value.length) detailCasePhase.value = (detailCasePhase.value + 1) % detailCaseArts.length
      if (editCasePlaying.value) editCaseProgress.value = editCaseProgress.value >= 92 ? 8 : editCaseProgress.value + 8
    }, 1200)
  }
  function stopCaseTimer(): void {
    if (caseTimer) clearInterval(caseTimer)
  }

  return {
    creativeModes,
    modeLabel,
    prompt,
    productName,
    mainSize,
    wantMain,
    wantSelling,
    wantWhite,
    wantDetail,
    mainCount,
    sellingCount,
    whiteCount,
    detailCount,
    generationStyleOptions,
    platformOptions,
    generationStyle,
    unifiedStyle,
    platform,
    mode,
    modeConfig,
    materialLimit,
    promptMaxLength,
    detailNoteStyle,
    detailCardCount,
    detailRatio,
    detailPreviewAspectRatio,
    fontOptions,
    detailFont,
    detailCasePlaying,
    detailCasePhase,
    detailCaseArts,
    detailCaseLabels,
    detailPreviewArt,
    editCasePlaying,
    editCaseProgress,
    caseTimer,
    materials,
    showMaterialExamples,
    materialExamples,
    materialInput,
    referenceInput,
    competitorInput,
    modelLibraryInput,
    sceneLibraryInput,
    sceneReferenceInput,
    referenceMaterial,
    competitorReferences,
    referenceUploadError,
    variantCounts,
    quantityCopy,
    modelGender,
    modelAge,
    modelEthnicity,
    modelBody,
    modelAppearance,
    modelLibraryUploads,
    modelLibraryUploadError,
    modelScene,
    sceneLibraryUploads,
    sceneLibraryUploadError,
    sceneReference,
    sceneGenerating,
    sceneGenerationError,
    modelSource,
    modelCount,
    sceneSource,
    modelSourceOptions,
    sceneSourceOptions,
    modelLibraryArt,
    modelLibraryOptions,
    sceneLibraryOptions,
    editPreset,
    editCaseArt,
    editPresetOptions,
    resetEditSession,
    selectedRatio,
    ratioOptions,
    freeEditRatioOptions,
    selectedFont,
    uploadError,
    modeNeedsSource,
    modeNeedsReference,
    selectedModelLibraryAsset,
    selectedSceneLibraryAsset,
    libraryAssetRequirement,
    modeNeedsLibraryAsset,
    selectedSystemModelAsset,
    selectedSystemSceneAsset,
    needsPrompt,
    generateButtonLabel,
    config,
    generationError,
    generationNotice,
    generating,
    confirmOpen,
    sceneConfirmOpen,
    generatedImages,
    restoringHistorySession,
    activeImageIndex,
    historyImages,
    savedPath,
    saveNotice,
    saveNoticeError,
    generationBusy,
    configured,
    usedModel,
    selectedFontOption,
    detailFontOption,
    effectiveFontOption,
    fontLicenseHint,
    restartDetailCase,
    analyzing,
    analyzeError,
    analyzeNote,
    analyzeConfirmOpen,
    analyzeImages,
    canAnalyze,
    analyzeTitle,
    requestAnalyzeProduct,
    runAnalyzeProduct,
    adjustContentCount,
    normalizeContentCount,
    activeImage,
    activeKindLabel,
    plannedJobs,
    planSummary,
    plannedOutputCount,
    generatedGroups,
    loadAiConfig,
    readImage,
    addMaterials,
    addExampleMaterial,
    onMaterialFiles,
    onMaterialDrop,
    removeMaterial,
    normalizeVariantCount,
    updateQuantityCopy,
    addLibraryAssets,
    onModelLibraryFiles,
    onSceneLibraryFiles,
    onReferenceFile,
    onSceneReferenceFile,
    addCompetitorReferences,
    onCompetitorFiles,
    onCompetitorDrop,
    removeCompetitorReference,
    requestGeneration,
    buildPrompt,
    toImageSource,
    toImageSourceAsync,
    requestSceneGeneration,
    submitSceneGeneration,
    startCaseTimer,
    stopCaseTimer
  }
}

export type ImageStudioGenerationApi = ReturnType<typeof useImageStudioGeneration>