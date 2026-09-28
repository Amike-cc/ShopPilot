<template>
  <section class="image-studio-page" data-test="unified-image-studio-page">
    <header class="studio-page-head">
      <div>
        <span class="dashboard-eyebrow">WORKSPACE / AI IMAGE STUDIO</span>
        <h1>AI 生成商品图</h1>
        <p>选择真实可用的模型，整理商品信息，再确认发送生成请求。</p>
      </div>
      <div class="head-actions">
        <span class="config-pill" :class="configTone"><i></i>{{ configLabel }}</span>
        <button type="button" class="studio-button ghost" @click="emit('open-settings')">配置 AI</button>
        <button type="button" class="studio-button primary" @click="emit('open-assistant')">打开 AI 助手</button>
      </div>
    </header>

    <div v-if="configState === 'loading'" class="studio-alert info" role="status"><span class="loader"></span><span>正在读取 AI 配置…</span></div>
    <div v-else-if="configState === 'error'" class="studio-alert error" role="alert"><strong>AI 配置读取失败</strong><span>{{ configError }}</span><button type="button" class="inline-link" @click="loadAiConfig">重试</button></div>
    <div v-else-if="!configured" class="studio-alert warning" role="status"><strong>尚未配置图片生成条件</strong><span>请在“设置中心 → AI 配置 → 生图 API”单独保存图片端点、模型和 API Key。没有真实配置时不会显示伪造的生成结果。</span><button type="button" class="inline-link" @click="emit('open-settings')">去配置</button></div>
    <div v-else-if="!imageTextConfigured" class="studio-alert warning" role="status"><strong>尚未配置商品分析文本条件</strong><span>“AI 整理卖点”只使用“设置中心 → AI 配置 → 生图文本 API”，不会读取 Agent 文本配置。请单独保存文本端点、模型和 API Key。</span><button type="button" class="inline-link" @click="emit('open-settings')">去配置</button></div>

    <div class="studio-layout">
      <main class="studio-main">
        <section class="studio-card model-card">
          <div class="card-heading">
            <div><span class="card-kicker">STEP 01</span><h2>选择生成 API 模型</h2><p>模型名称以当前 AI 供应商实际返回的列表为准。</p></div>
            <button type="button" class="text-button" :disabled="modelsLoading || !configured" @click="loadModels">{{ modelsLoading ? '读取中…' : modelsLoaded ? '重新读取模型' : '读取可用模型' }}</button>
          </div>
          <div class="model-grid">
            <button v-for="card in modelCards" :key="card.key" type="button" class="model-option" :class="{ selected: selectedModel === card.key }" :aria-pressed="selectedModel === card.key" @click="selectedModel = card.key">
              <span class="model-icon" :class="card.tone">{{ card.icon }}</span>
              <span class="model-option-copy"><strong>{{ card.label }}</strong><small>{{ card.summary }}</small><em>{{ modelAvailability(card) }}</em></span>
              <span v-if="selectedModel === card.key" class="selected-mark" aria-label="已选择">✓</span>
            </button>
          </div>
          <p v-if="modelsLoaded && !availableModels.length" class="model-note warning-text">接口返回了空模型列表，不能确认图片模型是否可用。请检查供应商是否提供图片生成端点。</p>
          <p v-else-if="modelsLoaded" class="model-note">已读取 {{ availableModels.length }} 个真实模型；卡片只提供快捷名称，最终以供应商接受的模型名和响应为准。</p>
          <p v-else class="model-note">未读取模型列表时仍可以提交请求，若供应商不支持图片模型会返回真实错误。</p>
          <p v-if="selectedModelUnavailable" class="model-note warning-text">当前选择的快捷卡片没有匹配真实模型；提交前请改选“自定义 API”，或重新读取供应商模型。</p>
        </section>

        <section class="studio-card conversation-card">
          <div class="card-heading compact"><div><span class="card-kicker">STEP 02</span><h2>对话生图</h2><p>用自然语言描述用途、场景和风格，生成请求只会在你确认后发送。</p></div><span class="safe-badge">人工确认</span></div>
          <div class="feature-chips" aria-label="工作流能力"><template v-for="chip in featureChips" :key="chip"><button v-if="chip === 'AI 整理卖点'" type="button" :disabled="analysisState === 'loading' || !imageTextConfigured || (!productName.trim() && !productTags.trim())" @click="analyzeProduct">✓ {{ analysisState === 'loading' ? '分析中…' : chip }}</button><span v-else>✓ {{ chip }}</span></template></div>
          <div class="conversation-thread">
            <div class="chat-row user-row"><div class="chat-bubble user-bubble">{{ prompt.trim() || '描述商品、场景、构图和电商用途…' }}</div><span class="chat-avatar user-avatar">我</span></div>
            <div class="chat-row assistant-row"><span class="chat-avatar robot-avatar"><i></i><i></i></span><div class="chat-bubble assistant-bubble"><strong>{{ analysisState === 'ready' ? 'AI 商品分析' : '生成准备' }}</strong><p v-if="analysisState === 'loading'">正在向独立的生图文本 API 请求商品分析，页面不会执行发布或店铺操作…</p><p v-else-if="analysisState === 'error'" class="analysis-error">{{ analysisError }}</p><p v-else-if="analysisState === 'ready'" class="analysis-output">{{ analysisText }}</p><div v-if="analysisState === 'ready'" class="analysis-insights"><div><strong>✦ 核心卖点</strong><ul><li v-for="line in analysisLines" :key="`point-${line}`">{{ line }}</li></ul></div><div><strong>⌁ 生成建议</strong><ul><li>视觉方向：{{ selectedStyleLabel }}</li><li>输出用途：{{ actionLabel }}</li><li>{{ productImage ? '已选择商品图，确认后会提交给图片编辑端点。' : '未上传商品图，生成将只使用文字提示。' }}</li></ul></div></div><small v-if="analysisState === 'ready' && analysisModel" class="analysis-meta">模型：{{ analysisModel }}</small><p v-if="analysisState === 'idle' && (productImage || productName || productTags)">已收集你填写的商品信息，可以继续补充提示词并选择生成方向。</p><p v-else-if="analysisState === 'idle'">上传商品图或填写商品信息后，这里会展示本次请求的上下文。当前不会虚构商品分析结果。</p><div class="context-card"><div class="context-preview" :class="{ filled: productImage }"><img v-if="productImage" :src="productImage.dataUrl" alt="已上传的商品图" /><span v-else>商品图</span></div><div class="context-copy"><strong>{{ productName.trim() || '未填写商品名称' }}</strong><span>{{ productTags.trim() || '等待商品卖点或标签' }}</span><small>{{ productImage ? productImage.name : '未上传商品图' }}</small></div></div></div></div>
          </div>
          <div class="product-context">
            <div class="context-heading"><div><strong>商品信息</strong><span>仅用于本次提示词整理，不会自动写入店铺。</span></div><div class="context-actions"><button type="button" class="text-button" :disabled="analysisState === 'loading' || !imageTextConfigured || (!productName.trim() && !productTags.trim())" @click="analyzeProduct">{{ analysisState === 'loading' ? '分析中…' : 'AI 分析卖点' }}</button><button type="button" class="text-button" @click="emit('open-assistant')">在助手中查看</button></div></div>
            <div class="context-fields"><label>商品名称<input v-model="productName" maxlength="120" placeholder="填写你的商品名称" /></label><label>卖点 / 标签<input v-model="productTags" maxlength="240" placeholder="材质、适用场景、核心卖点" /></label><label>售价（可选）<input v-model="productPrice" inputmode="decimal" maxlength="24" placeholder="仅使用你填写的价格" /></label><label>原价（可选）<input v-model="productOriginalPrice" inputmode="decimal" maxlength="24" placeholder="不填写则不展示" /></label></div>
          </div>
        </section>

        <section class="studio-card style-card">
          <div class="card-heading compact"><div><span class="card-kicker">STEP 03</span><h2>推荐生成方向</h2><p>选择一个视觉方向，系统会把它加入提示词。</p></div></div>
          <div class="style-grid">
            <button v-for="style in styleCards" :key="style.key" type="button" class="style-option" :class="{ selected: selectedStyle === style.key }" :aria-pressed="selectedStyle === style.key" @click="selectedStyle = style.key"><span class="style-swatch" :class="style.tone" :style="styleSwatchStyle"><b>{{ style.icon }}</b></span><strong>{{ style.label }}</strong><small>{{ style.description }}</small></button>
          </div>
        </section>

        <section class="studio-card prompt-card">
          <div class="prompt-label"><span>生成描述</span><small>{{ prompt.length }}/500</small></div>
          <textarea v-model="prompt" maxlength="500" rows="4" placeholder="输入你的需求，例如：为商品制作适合电商主图的场景图，描述构图、光线、背景和文字留白…"></textarea>
          <div class="prompt-tools">
            <div class="upload-tools">
              <input ref="productInput" class="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" @change="onProductFile" />
              <input ref="referenceInput" class="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" @change="onReferenceFile" />
              <button type="button" class="tool-button" @click="productInput?.click()">▧ 上传商品图</button>
              <button type="button" class="tool-button" @click="referenceInput?.click()">▧ 参考图片</button>
              <button type="button" class="tool-button" @click="showSettings = !showSettings">☷ 更多设置</button>
            </div>
            <button type="button" class="generate-button" :disabled="generating || !prompt.trim()" @click="requestGeneration('main')"><span>{{ generating ? '生成中…' : '发送生成' }}</span><b>➤</b></button>
          </div>
          <div v-if="productImage || referenceImage" class="asset-strip"><span v-if="productImage">商品图：{{ productImage.name }} <button type="button" aria-label="移除商品图" @click="productImage = null">×</button></span><span v-if="referenceImage">参考图：{{ referenceImage.name }} <button type="button" aria-label="移除参考图" @click="referenceImage = null">×</button></span><small>确认发送后，已选择的图片会通过主进程提交到供应商的图片编辑端点；供应商不支持时会返回真实错误。</small></div>
          <div v-if="showSettings" class="advanced-settings"><label>输出比例<select v-model="selectedSize"><option value="1024x1024">1:1 方图</option><option value="1536x1024">3:2 横图</option><option value="1024x1536">2:3 竖图</option></select></label><label>生成数量<select v-model.number="imageCount"><option :value="1">1 张</option><option :value="2">2 张</option><option :value="4">4 张</option></select></label><span>当前调用使用 {{ selectedModelId || '配置中的模型' }}。</span></div>
        </section>

        <div v-if="generationError" class="studio-alert error generation-alert" role="alert"><strong>生成未完成</strong><span>{{ generationError }}</span><button type="button" class="inline-link" @click="generationError = ''">关闭</button></div>
        <div v-else-if="generationNotice" class="studio-alert info generation-alert" role="status"><strong>已部分返回</strong><span>{{ generationNotice }}</span><button type="button" class="inline-link" @click="generationNotice = ''">关闭</button></div>

        <section class="studio-card action-card">
          <button type="button" class="action-tile blue" :disabled="generating || !prompt.trim()" @click="requestGeneration('main')"><span>▤</span><strong>生成主图</strong><small>适合商品列表页</small></button>
          <button type="button" class="action-tile pink" :disabled="generating || !prompt.trim()" @click="requestGeneration('detail')"><span>▤</span><strong>生成详情页</strong><small>详情页视觉草图</small></button>
          <button type="button" class="action-tile teal" :disabled="generating || !prompt.trim()" @click="requestGeneration('suite')"><span>◆</span><strong>一键套版</strong><small>单张套版草图</small></button>
          <button type="button" class="action-tile purple" @click="emit('open-assistant')"><span>✦</span><strong>AI 推荐</strong><small>在助手中整理建议</small></button>
        </section>
      </main>

      <aside class="studio-side">
        <section class="studio-card phone-card">
          <div class="card-heading compact"><div><span class="card-kicker">LIVE PREVIEW</span><h2>手机预览</h2><p>只展示当前真实生成结果。</p></div><span v-if="generatedImages.length" class="result-count">{{ generatedImages.length }} 张</span></div>
          <div class="phone-frame"><div class="phone-notch"></div><div class="phone-screen"><div v-if="activeImage" class="phone-result"><img :src="activeImage" alt="AI 生成结果" /><span class="phone-result-badge">真实返回</span></div><div v-else-if="generating" class="phone-loading"><span class="empty-orb spinning-orb">✦</span><strong>正在生成…</strong><small>等待供应商返回真实图片，页面不会填充示例结果。</small></div><div v-else-if="generationError" class="phone-error"><span class="empty-orb error-orb">!</span><strong>生成失败</strong><small>{{ generationError }}</small><button type="button" class="inline-link" @click="requestGeneration(pendingAction)">重试</button></div><div v-else-if="hasProductPreview" class="phone-product-preview"><div class="phone-product-image"><img v-if="productImage" :src="productImage.dataUrl" alt="用户上传的商品图" /><span v-else>未上传商品图</span><i>商品信息预览</i></div><div class="phone-product-copy"><strong>{{ productName.trim() || '未填写商品名称' }}</strong><span>{{ productTags.trim() || '未填写卖点或标签' }}</span><div class="phone-price-row"><b v-if="productPrice.trim()">¥ {{ productPrice.trim() }}</b><del v-if="productOriginalPrice.trim()">¥ {{ productOriginalPrice.trim() }}</del></div></div><small class="phone-preview-note">这里仅展示你填写或上传的内容，生成结果返回后会替换预览。</small></div><div v-else class="phone-empty"><span class="empty-orb">✦</span><strong>暂无生成结果</strong><small>配置图片 API 后，确认发送生成请求，结果会显示在这里。</small><button type="button" class="inline-link" @click="emit('open-settings')">检查配置</button></div></div><div class="phone-home-indicator"></div></div>
          <div v-if="generatedImages.length > 1" class="preview-thumbs"><button v-for="(image, index) in generatedImages" :key="`${image}-${index}`" type="button" :class="{ active: activeImageIndex === index }" @click="activeImageIndex = index"><img :src="image" :alt="`生成结果 ${index + 1}`" /></button></div>
          <div v-if="lastGeneration" class="result-meta"><span>模型：{{ lastGeneration.model }}</span><span>耗时：{{ lastGeneration.elapsedMs }}ms</span></div>
        </section>
        <section class="studio-card side-info"><div class="side-info-head"><span class="info-icon">i</span><strong>生成边界</strong></div><ul><li>API Key 只由主进程读取，页面不会回显。</li><li>请求发送前会显示费用和模型确认。</li><li>生成数量以供应商真实响应为准；详情页和套版按钮当前生成对应用途的图片草图。</li><li>上传图片只在确认后提交到图片编辑端点，不支持时返回真实错误。</li><li>没有真实返回时只显示空状态，不填充示例商品数据。</li></ul></section>
      </aside>
    </div>

    <div v-if="confirmOpen" class="confirm-backdrop" role="presentation" @click.self="confirmOpen = false">
      <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div class="confirm-icon">✦</div><h2 id="confirm-title">确认发送图片生成请求？</h2><p>这会使用当前配置的第三方 AI 接口，可能产生费用。请求会发送到已保存的端点，生成结果只在接口返回成功后显示<span v-if="productImage || referenceImage">；你已选择的图片也会一并发送用于图片编辑。</span>。</p><dl><div><dt>模型</dt><dd>{{ selectedModelId || '配置中的模型' }}</dd></div><div><dt>输出</dt><dd>{{ actionLabel }} · {{ selectedSize }} · {{ imageCount }} 张</dd></div><div v-if="productImage || referenceImage"><dt>参考图片</dt><dd>{{ [productImage?.name, referenceImage?.name].filter(Boolean).join('、') }}</dd></div></dl>
        <div class="confirm-actions"><button type="button" class="studio-button ghost" @click="confirmOpen = false">取消</button><button type="button" class="studio-button primary" :disabled="generating" @click="submitGeneration">确认发送</button></div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

type ModelKey = 'gpt-image' | 'flux-1' | 'sdxl' | 'gemini' | 'custom'
type GenerationKind = 'main' | 'detail' | 'suite'
type ConfigState = 'loading' | 'ready' | 'error'
interface AiConfigView {
  endpoint: string; resolvedEndpoint?: string; model: string; timeoutMs: number; hasKey: boolean
  imageEndpoint: string; resolvedImageEndpoint?: string; imageModel: string; imageTimeoutMs: number; hasImageKey: boolean
  imageTextEndpoint: string; resolvedImageTextEndpoint?: string; imageTextModel: string; imageTextTimeoutMs: number; hasImageTextKey: boolean
}
interface UploadAsset { name: string; size: number; dataUrl: string }
interface ModelCard { key: ModelKey; label: string; summary: string; tone: string; icon: string; modelNames: string[] }
interface StyleCard { key: string; label: string; description: string; tone: string; icon: string }

const emit = defineEmits<{
  'open-settings': []
  'open-assistant': []
}>()

const featureChips = ['上传商品图', 'AI 整理卖点', '智能生成场景', '生成详情页', '一键套版出图']
const modelCards: ModelCard[] = [
  { key: 'gpt-image', label: 'GPT-Image', summary: '理解力强 · 电商场景', tone: 'purple', icon: '◎', modelNames: ['gpt-image', 'gpt-image-1'] },
  { key: 'flux-1', label: 'FLUX.1', summary: '商品细节 · 真实场景', tone: 'blue', icon: '◆', modelNames: ['flux', 'flux.1', 'flux-1'] },
  { key: 'sdxl', label: 'SDXL', summary: '多风格 · 批量生成', tone: 'cyan', icon: '✦', modelNames: ['sdxl', 'stable-diffusion-xl'] },
  { key: 'gemini', label: 'Gemini', summary: '图文理解 · 复杂需求', tone: 'rainbow', icon: '✧', modelNames: ['gemini', 'imagen'] },
  { key: 'custom', label: '自定义 API', summary: '使用当前生图 API 配置', tone: 'slate', icon: '↗', modelNames: [] }
]
const styleCards: StyleCard[] = [
  { key: 'fresh', label: '清新自然', description: '自然光与轻背景', tone: 'fresh', icon: '☼' },
  { key: 'close-up', label: '产品特写', description: '突出材质细节', tone: 'close-up', icon: '◉' },
  { key: 'scene', label: '场景种草', description: '生活方式表达', tone: 'scene', icon: '⌂' },
  { key: 'portrait', label: '人物展示', description: '人物使用场景', tone: 'portrait', icon: '◌' },
  { key: 'premium', label: '简约高级', description: '留白与品牌感', tone: 'premium', icon: '◇' }
]

const selectedModel = ref<ModelKey>('gpt-image')
const selectedStyle = ref('fresh')
const prompt = ref('')
const productName = ref('')
const productTags = ref('')
const productPrice = ref('')
const productOriginalPrice = ref('')
const selectedSize = ref('1024x1024')
const imageCount = ref(1)
const showSettings = ref(false)
const productImage = ref<UploadAsset | null>(null)
const referenceImage = ref<UploadAsset | null>(null)
const productInput = ref<HTMLInputElement | null>(null)
const referenceInput = ref<HTMLInputElement | null>(null)
const configState = ref<ConfigState>('loading')
const configError = ref('')
const config = ref<AiConfigView | null>(null)
const modelsLoading = ref(false)
const modelsLoaded = ref(false)
const availableModels = ref<string[]>([])
const generationError = ref('')
const generationNotice = ref('')
const generating = ref(false)
const confirmOpen = ref(false)
const pendingAction = ref<GenerationKind>('main')
const generatedImages = ref<string[]>([])
const activeImageIndex = ref(0)
const lastGeneration = ref<{ model: string; elapsedMs: number } | null>(null)
type AnalysisState = 'idle' | 'loading' | 'ready' | 'error'
const analysisState = ref<AnalysisState>('idle')
const analysisText = ref('')
const analysisError = ref('')
const analysisModel = ref('')

watch([productName, productTags, productPrice, productOriginalPrice, productImage], () => {
  if (analysisState.value === 'loading') return
  analysisState.value = 'idle'
  analysisText.value = ''
  analysisError.value = ''
  analysisModel.value = ''
})

const configured = computed(() => Boolean(config.value?.hasImageKey && config.value.imageEndpoint && config.value.resolvedImageEndpoint && config.value.imageModel))
const imageTextConfigured = computed(() => Boolean(config.value?.hasImageTextKey && config.value.imageTextEndpoint && config.value.resolvedImageTextEndpoint && config.value.imageTextModel))
const configTone = computed(() => configState.value === 'loading' ? 'loading' : configState.value === 'error' ? 'error' : configured.value && imageTextConfigured.value ? 'ready' : 'warning')
const configLabel = computed(() => configState.value === 'loading' ? '读取配置中' : configState.value === 'error' ? '配置读取失败' : !configured.value ? '需要配置图片 API' : !imageTextConfigured.value ? '需要配置生图文本 API' : '图片与文本 API 已配置')
const selectedModelCard = computed(() => modelCards.find(card => card.key === selectedModel.value) || modelCards[0])
const selectedModelMatch = computed(() => {
  if (selectedModel.value === 'custom' || !modelsLoaded.value) return ''
  return availableModels.value.find(item => selectedModelCard.value.modelNames.some(name => item.toLowerCase().includes(name.toLowerCase()))) || ''
})
const selectedModelId = computed(() => selectedModel.value === 'custom' ? config.value?.imageModel || '' : modelsLoaded.value ? selectedModelMatch.value : selectedModelCard.value.modelNames[0] || config.value?.imageModel || '')
const selectedModelUnavailable = computed(() => modelsLoaded.value && selectedModel.value !== 'custom' && !selectedModelMatch.value)
const activeImage = computed(() => generatedImages.value[activeImageIndex.value] || '')
const actionLabel = computed(() => ({ main: '生成主图', detail: '生成详情页', suite: '一键套版' } as Record<GenerationKind, string>)[pendingAction.value])
const selectedStyleLabel = computed(() => styleCards.find(item => item.key === selectedStyle.value)?.label || '未选择')
const analysisLines = computed(() => analysisText.value.split(/[\r\n；;。]+/).map(item => item.trim()).filter(Boolean).slice(0, 6))
const hasProductPreview = computed(() => Boolean(productImage.value || productName.value.trim() || productTags.value.trim() || productPrice.value.trim() || productOriginalPrice.value.trim()))
const styleSwatchStyle = computed<Record<string, string> | undefined>(() => productImage.value ? {
  backgroundImage: `linear-gradient(135deg, rgba(8, 14, 27, .24), rgba(12, 21, 40, .68)), url(${productImage.value.dataUrl})`,
  backgroundPosition: 'center',
  backgroundSize: 'cover'
} : undefined)

function modelAvailability(card: ModelCard): string {
  if (card.key === 'custom') return config.value?.imageModel ? `当前：${config.value.imageModel}` : '等待配置'
  if (!modelsLoaded.value) return configured.value ? '未验证' : '需先配置'
  const matched = availableModels.value.find(item => card.modelNames.some(name => item.toLowerCase().includes(name.toLowerCase())))
  return matched ? `已发现：${matched}` : '接口未返回'
}

async function loadAiConfig() {
  configState.value = 'loading'; configError.value = ''
  try {
    const [imageResult, textResult] = await Promise.all([
      window.shopilot.ai.imageConfigGet(),
      window.shopilot.ai.imageTextConfigGet()
    ])
    if (!imageResult.ok) throw new Error(imageResult.error.message)
    if (!textResult.ok) throw new Error(textResult.error.message)
    config.value = { ...(imageResult.data as AiConfigView), ...(textResult.data as Partial<AiConfigView>) }
    configState.value = 'ready'
  } catch (error: any) {
    configState.value = 'error'; configError.value = error?.message || 'AI 配置暂时无法读取'
  }
}

async function loadModels() {
  if (!configured.value) { generationError.value = '请先在设置中心 → AI 配置 → 生图 API 保存图片 API Key、接口地址和模型。'; return }
  modelsLoading.value = true; generationError.value = ''
  try {
    const result = await window.shopilot.ai.listImageModels()
    if (!result.ok) throw new Error(result.error.message)
    availableModels.value = Array.isArray(result.data?.models) ? result.data.models.map((item: unknown) => String(item)) : []
    modelsLoaded.value = true
  } catch (error: any) {
    generationError.value = `可用模型读取失败：${error?.message || '接口未返回模型列表'}`
  } finally { modelsLoading.value = false }
}

function readImage(file: File | undefined, assign: (asset: UploadAsset) => void) {
  if (!file) return
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type.toLowerCase())) { generationError.value = '只支持 PNG、JPEG 或 WebP 图片。'; return }
  if (file.size > 8 * 1024 * 1024) { generationError.value = '图片不能超过 8MB，请压缩后再上传。'; return }
  const reader = new FileReader()
  reader.onload = () => { if (typeof reader.result === 'string') assign({ name: file.name, size: file.size, dataUrl: reader.result }) }
  reader.onerror = () => { generationError.value = '图片读取失败，请重试。' }
  reader.readAsDataURL(file)
}
function onProductFile(event: Event) { readImage((event.target as HTMLInputElement).files?.[0], asset => { productImage.value = asset }); (event.target as HTMLInputElement).value = '' }
function onReferenceFile(event: Event) { readImage((event.target as HTMLInputElement).files?.[0], asset => { referenceImage.value = asset }); (event.target as HTMLInputElement).value = '' }

function requestGeneration(kind: GenerationKind) {
  generationError.value = ''; generationNotice.value = ''
  if (!configured.value) { generationError.value = '当前没有可用的真实 AI 配置，请先打开设置中心。'; return }
  if (!prompt.value.trim()) { generationError.value = '请先填写生成描述。'; return }
  if (selectedModelUnavailable.value) { generationError.value = `当前接口没有返回“${modelCards.find(card => card.key === selectedModel.value)?.label || selectedModel.value}”对应的真实模型，请改选“自定义 API”或重新读取模型。`; return }
  pendingAction.value = kind; confirmOpen.value = true
}

async function analyzeProduct() {
  if (analysisState.value === 'loading') return
  if (!imageTextConfigured.value) {
    analysisState.value = 'error'
    analysisError.value = '请先在设置中心 → AI 配置 → 生图文本 API 保存独立的文本端点、模型和 API Key。'
    return
  }
  const name = productName.value.trim()
  const tags = productTags.value.trim()
  if (!name && !tags) {
    analysisState.value = 'error'
    analysisError.value = '请先填写商品名称或卖点，再请求 AI 分析。'
    return
  }
  analysisState.value = 'loading'; analysisError.value = ''; analysisText.value = ''; analysisModel.value = ''
  try {
    const result = await window.shopilot.ai.analyzeImageProduct({
      name,
      tags,
      price: productPrice.value.trim(),
      originalPrice: productOriginalPrice.value.trim()
    })
    if (!result.ok) throw new Error(result.error.message)
    const data = result.data as any
    if (!String(data?.text || '').trim()) {
      throw new Error('生图文本 API 返回的不是可展示的分析文本，请检查独立配置。')
    }
    analysisText.value = String(data.text).trim()
    analysisModel.value = String(data.model || '')
    analysisState.value = 'ready'
  } catch (error: any) {
    analysisState.value = 'error'
    analysisError.value = error?.message || 'AI 分析暂时不可用，请检查生图文本 API 配置。'
  }
}

function buildPrompt() {
  const style = styleCards.find(item => item.key === selectedStyle.value)
  return [prompt.value.trim(), productName.value.trim() ? `商品名称：${productName.value.trim()}` : '', productTags.value.trim() ? `商品卖点：${productTags.value.trim()}` : '', productPrice.value.trim() ? `售价：${productPrice.value.trim()}` : '', productOriginalPrice.value.trim() ? `原价：${productOriginalPrice.value.trim()}` : '', style ? `视觉方向：${style.label}（${style.description}）` : '', `输出用途：${actionLabel.value}`].filter(Boolean).join('；')
}

function toImageSource(asset: UploadAsset | null) {
  if (!asset) return null
  const match = /^data:([^;]+);base64,(.+)$/i.exec(asset.dataUrl)
  if (!match) return null
  return { name: asset.name, mimeType: match[1].toLowerCase(), b64Json: match[2] }
}

async function submitGeneration() {
  if (generating.value) return
  generating.value = true; confirmOpen.value = false; generationError.value = ''
  generationNotice.value = ''
  try {
    const sourceImages = [toImageSource(productImage.value), toImageSource(referenceImage.value)].filter((item): item is { name: string; mimeType: string; b64Json: string } => Boolean(item))
    const result = await window.shopilot.ai.generateImage({ prompt: buildPrompt(), model: selectedModelId.value || undefined, size: selectedSize.value, n: imageCount.value, confirmed: true, sourceImages })
    if (!result.ok) throw new Error(result.error.message)
    const images = Array.isArray(result.data?.images) ? result.data.images.map((item: any) => item?.b64Json ? `data:${item?.mimeType || 'image/png'};base64,${item.b64Json}` : String(item?.url || '')).filter(Boolean) : []
    if (!images.length) throw new Error('接口没有返回可预览图片')
    if (images.length < imageCount.value) generationNotice.value = `接口返回了 ${images.length} 张图片，少于请求的 ${imageCount.value} 张；页面只展示真实返回内容。`
    generatedImages.value = images; activeImageIndex.value = 0; lastGeneration.value = { model: String(result.data?.model || selectedModelId.value || '—'), elapsedMs: Number(result.data?.elapsedMs || 0) }
  } catch (error: any) {
    generationError.value = error?.message || '图片生成失败，接口没有返回结果。'
  } finally { generating.value = false }
}

onMounted(() => { void loadAiConfig() })
</script>

<style scoped>
.image-studio-page{height:100%;min-width:0;overflow:auto;padding:22px 24px 34px;color:var(--dash-text);background:radial-gradient(circle at 80% 4%,rgba(112,79,238,.12),transparent 28%),linear-gradient(145deg,#ebeced,#ebeced)}.studio-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:16px}.studio-page-head h1{margin:5px 0 7px;font-size:25px;letter-spacing:-.04em}.studio-page-head p{margin:0;color:var(--dash-text-muted);font-size:12px}.head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}.studio-button,.text-button,.tool-button{border:1px solid var(--dash-border);background:#ededef;color:var(--dash-text-soft);cursor:pointer}.studio-button{min-height:34px;padding:0 13px;border-radius:9px}.studio-button:hover,.studio-button:focus-visible,.text-button:hover,.text-button:focus-visible,.tool-button:hover,.tool-button:focus-visible{border-color:rgba(151,120,255,.75);color:#fff;outline:2px solid rgba(151,120,255,.26);outline-offset:1px}.studio-button.primary{border-color:rgba(130,92,255,.75);background:linear-gradient(135deg,#f3f0fc,#8c5cff);color:#fff}.studio-button.ghost{background:#ecedee}.studio-button:disabled,.text-button:disabled,.tool-button:disabled{cursor:not-allowed;opacity:.55}.config-pill{display:inline-flex;align-items:center;gap:6px;padding:7px 9px;border:1px solid var(--dash-border);border-radius:8px;color:var(--dash-text-muted);font-size:10px}.config-pill i{width:7px;height:7px;border-radius:50%;background:#98a2b3}.config-pill.ready{border-color:rgba(32,209,154,.28);color:#027a48}.config-pill.ready i{background:#12b76a}.config-pill.warning{border-color:rgba(242,171,87,.25);color:#b54708}.config-pill.warning i{background:#f2ad5b}.config-pill.error{border-color:rgba(241,104,126,.3);color:#f04438}.config-pill.error i{background:#ee607b}.config-pill.loading i{animation:pulse 1s infinite;background:#8e79ef}@keyframes pulse{50%{opacity:.35}}.studio-alert{display:flex;align-items:center;gap:10px;margin:0 0 14px;padding:11px 13px;border:1px solid var(--dash-border);border-radius:10px;background:#ecedef;color:var(--dash-text-muted);font-size:11px;line-height:1.55}.studio-alert strong{color:var(--dash-text-soft)}.studio-alert .inline-link{margin-left:auto}.studio-alert.info{border-color:rgba(69,151,245,.25)}.studio-alert.warning{border-color:rgba(236,171,94,.26);background:rgba(91,61,23,.12)}.studio-alert.error{border-color:rgba(240,99,123,.3);background:rgba(100,31,49,.16);color:#b42318}.inline-link{border:0;background:transparent;color:#7c5cff;cursor:pointer;text-decoration:none}.inline-link:hover,.inline-link:focus-visible{color:#fff;text-decoration:underline;outline:none}.loader{width:15px;height:15px;border:2px solid rgba(163,143,255,.2);border-top-color:#7c5cff;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.studio-layout{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(285px,.72fr);gap:14px;align-items:start}.studio-main,.studio-side{display:flex;min-width:0;flex-direction:column;gap:14px}.studio-card{border:1px solid var(--dash-border);border-radius:14px;background:linear-gradient(145deg,#ecedef,#ececed);box-shadow:0 10px 28px rgba(0,0,0,.16)}.model-card,.conversation-card,.style-card,.prompt-card{padding:16px}.card-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}.card-heading.compact{margin-bottom:11px}.card-kicker{display:block;color:#8073c3;font-size:9px;letter-spacing:.16em}.card-heading h2{margin:5px 0 4px;font-size:16px;letter-spacing:-.02em}.card-heading p{margin:0;color:var(--dash-text-muted);font-size:10px}.text-button{min-height:29px;padding:0 9px;border-radius:7px;background:#edeef0;font-size:10px}.model-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}.model-option{position:relative;display:flex;min-width:0;min-height:116px;flex-direction:column;align-items:flex-start;gap:8px;padding:10px;border:1px solid var(--dash-border);border-radius:11px;background:#f7f9fd;color:var(--dash-text-soft);text-align:left;cursor:pointer;transition:border-color .16s,transform .16s,background .16s}.model-option:hover,.model-option:focus-visible{border-color:rgba(139,116,247,.66);background:#edeef0;outline:2px solid rgba(139,116,247,.2);outline-offset:1px}.model-option.selected{border-color:#836cff;background:linear-gradient(145deg,rgba(102,75,211,.3),#ededef);box-shadow:0 0 0 1px rgba(139,116,247,.25),0 9px 18px rgba(61,39,151,.2)}.model-icon{display:grid;width:29px;height:29px;place-items:center;border-radius:8px;background:rgba(141,91,245,.25);color:#5b3df5;font-size:17px}.model-icon.blue{background:rgba(47,139,255,.2);color:#1d4ed8}.model-icon.cyan{background:rgba(45,205,218,.18);color:#1d4ed8}.model-icon.rainbow{background:linear-gradient(145deg,rgba(93,125,255,.3),rgba(233,81,180,.24));color:#fff}.model-icon.slate{background:rgba(136,153,190,.17);color:#1d4ed8}.model-option-copy{display:flex;min-width:0;flex-direction:column;gap:4px}.model-option strong{font-size:11px}.model-option small{min-height:25px;color:var(--dash-text-muted);font-size:9px;line-height:1.4}.model-option em{overflow:hidden;color:#71819f;font-size:8px;font-style:normal;text-overflow:ellipsis;white-space:nowrap;max-width:100%}.model-option.selected em{color:#5b3df5}.selected-mark{position:absolute;right:7px;top:7px;display:grid;width:18px;height:18px;place-items:center;border-radius:50%;background:#7f67f4;color:#fff;font-size:11px}.model-note{margin:11px 0 0;color:#7887a3;font-size:9px;line-height:1.5}.warning-text{color:#b54708}.safe-badge{padding:4px 7px;border:1px solid rgba(34,211,164,.26);border-radius:6px;color:#027a48;font-size:9px}.feature-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}.feature-chips span{padding:5px 7px;border-radius:7px;background:rgba(58,78,119,.26);color:#1d4ed8;font-size:9px}.feature-chips span:first-letter{color:#1d4ed8}.conversation-thread{display:flex;flex-direction:column;gap:10px;padding:5px 0 12px}.chat-row{display:flex;align-items:flex-start;gap:8px}.user-row{justify-content:flex-end}.chat-avatar{display:grid;width:26px;height:26px;flex:0 0 26px;place-items:center;border-radius:50%;font-size:9px}.user-avatar{order:2;background:linear-gradient(145deg,#5d7ff3,#8e64e8);color:#fff}.robot-avatar{position:relative;background:radial-gradient(circle at 50% 37%,#6d85c6,#edeef1);box-shadow:0 0 15px rgba(92,120,241,.28)}.robot-avatar:before{content:'';width:15px;height:10px;border-radius:50%;background:#ebeced;box-shadow:0 0 0 2px rgba(97,198,255,.12)}.robot-avatar i{position:absolute;z-index:1;width:3px;height:3px;border-radius:50%;background:#52c6ff}.robot-avatar i:first-of-type{transform:translateX(-4px)}.robot-avatar i:last-of-type{transform:translateX(4px)}.chat-bubble{max-width:82%;padding:9px 11px;border:1px solid var(--dash-border);border-radius:11px;color:#4a5568;font-size:10px;line-height:1.55}.user-bubble{border-color:rgba(91,139,244,.28);background:rgba(40,87,166,.2);color:#0e7490}.assistant-bubble{flex:1;background:#ecedef}.assistant-bubble strong{color:#4a5568;font-size:11px}.assistant-bubble p{margin:4px 0 8px;color:#8e9fbd}.context-card{display:flex;align-items:center;gap:8px;padding:8px;border:1px solid #e9edf5;border-radius:8px;background:rgba(7,15,28,.4)}.context-preview{display:grid;width:39px;height:39px;flex:0 0 39px;place-items:center;overflow:hidden;border-radius:7px;background:linear-gradient(145deg,#eef0f2,#eceef0);color:#8092b1;font-size:8px}.context-preview img{width:100%;height:100%;object-fit:cover}.context-copy{display:flex;min-width:0;flex-direction:column;gap:3px}.context-copy strong,.context-copy span,.context-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.context-copy strong{color:#0f1729;font-size:10px}.context-copy span{color:#1d4ed8;font-size:9px}.context-copy small{color:#61718f;font-size:8px}.product-context{padding-top:11px;border-top:1px solid rgba(111,137,177,.13)}.context-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px}.context-heading div{display:flex;flex-direction:column;gap:3px}.context-heading strong{font-size:11px}.context-heading span{color:#667085;font-size:9px}.context-fields{display:grid;grid-template-columns:1fr 1fr;gap:9px}.context-fields label,.advanced-settings label{display:flex;flex-direction:column;gap:5px;color:#1d4ed8;font-size:9px}.context-fields input,.advanced-settings select{height:31px;padding:0 9px;border:1px solid var(--dash-border);border-radius:7px;background:#ebeced;color:#4a5568;outline:none;font-size:10px}.context-fields input:focus,.advanced-settings select:focus{border-color:rgba(145,113,255,.8);box-shadow:0 0 0 2px rgba(145,113,255,.14)}.style-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}.style-option{display:flex;min-width:0;flex-direction:column;align-items:stretch;gap:4px;padding:7px;border:1px solid var(--dash-border);border-radius:9px;background:#f7f9fd;color:var(--dash-text-soft);text-align:left;cursor:pointer}.style-option:hover,.style-option:focus-visible{border-color:rgba(139,116,247,.65);outline:2px solid rgba(139,116,247,.18);outline-offset:1px}.style-option.selected{border-color:#6e80ff;background:rgba(65,65,132,.28);box-shadow:0 0 0 1px rgba(104,111,243,.23)}.style-swatch{display:grid;height:42px;place-items:center;border-radius:7px;background:linear-gradient(135deg,#699bc1,#b7d5de);color:rgba(255,255,255,.86);font-size:20px}.style-swatch.close-up{background:linear-gradient(135deg,#e7b759,#ab633f)}.style-swatch.scene{background:linear-gradient(135deg,#4e8fae,#89c8b4)}.style-swatch.portrait{background:linear-gradient(135deg,#856d61,#d0a47d)}.style-swatch.premium{background:linear-gradient(135deg,#667187,#c5cbd9)}.style-option strong{font-size:10px}.style-option small{color:#73829d;font-size:8px}.prompt-card{padding-bottom:11px}.prompt-label{display:flex;justify-content:space-between;margin-bottom:7px;color:#4a5568;font-size:11px}.prompt-label small{color:#75839e;font-size:9px}.prompt-card textarea{display:block;width:100%;min-height:84px;resize:vertical;padding:10px;border:1px solid rgba(106,130,190,.32);border-radius:9px;background:#ebeced;color:#4a5568;outline:none;font:inherit;font-size:11px;line-height:1.55}.prompt-card textarea::placeholder{color:#657590}.prompt-card textarea:focus{border-color:#8c75ff;box-shadow:0 0 0 2px rgba(140,117,255,.15)}.prompt-tools{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:9px}.upload-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.tool-button{min-height:29px;padding:0 9px;border-radius:7px;font-size:9px}.generate-button{display:inline-flex;min-height:37px;align-items:center;gap:13px;padding:0 13px;border:1px solid rgba(157,116,255,.8);border-radius:9px;background:linear-gradient(135deg,#f3f1fd,#ac4ff0);box-shadow:0 7px 18px rgba(104,68,223,.28);color:#fff;cursor:pointer;font-size:11px}.generate-button b{font-size:16px}.generate-button:hover:not(:disabled),.generate-button:focus-visible{filter:brightness(1.12);outline:2px solid rgba(183,157,255,.45);outline-offset:2px}.generate-button:disabled{cursor:not-allowed;opacity:.5}.asset-strip{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:9px;color:#4a5568;font-size:9px}.asset-strip span{padding:4px 6px;border-radius:6px;background:rgba(56,82,125,.25)}.asset-strip small{width:100%;color:#6d7c98}.advanced-settings{display:flex;align-items:end;gap:10px;margin-top:10px;padding:10px;border:1px solid rgba(109,130,179,.17);border-radius:8px;background:#ecedef}.advanced-settings label{min-width:130px}.advanced-settings select{height:29px}.advanced-settings>span{padding-bottom:7px;color:#76849e;font-size:9px}.generation-alert{margin:0}.action-card{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:10px}.action-tile{display:flex;min-height:67px;flex-direction:column;align-items:flex-start;justify-content:center;gap:3px;padding:10px;border:1px solid var(--dash-border);border-radius:9px;color:#4a5568;text-align:left;cursor:pointer;transition:transform .15s,border-color .15s}.action-tile:hover:not(:disabled),.action-tile:focus-visible:not(:disabled){transform:translateY(-2px);border-color:rgba(167,145,255,.7);outline:2px solid rgba(151,120,255,.22);outline-offset:1px}.action-tile:disabled{cursor:not-allowed;opacity:.45}.action-tile span{font-size:16px}.action-tile strong{font-size:10px}.action-tile small{color:#8794ad;font-size:8px}.action-tile.blue{background:linear-gradient(145deg,rgba(39,112,216,.35),rgba(20,48,90,.44))}.action-tile.pink{background:linear-gradient(145deg,rgba(221,59,141,.34),rgba(89,24,80,.44))}.action-tile.teal{background:linear-gradient(145deg,rgba(11,171,151,.34),rgba(15,76,75,.44))}.action-tile.purple{background:linear-gradient(145deg,rgba(117,77,224,.34),rgba(51,35,109,.44))}.phone-card{padding:16px}.phone-card .card-heading{margin-bottom:9px}.result-count{padding:4px 6px;border-radius:6px;background:rgba(36,202,164,.13);color:#027a48;font-size:9px}.phone-frame{position:relative;width:min(100%,280px);min-height:478px;margin:5px auto 0;padding:10px;border:3px solid #e9edf5;border-radius:31px;background:#ebebec;box-shadow:0 0 0 2px #0b1120,0 13px 30px rgba(0,0,0,.32)}.phone-notch{position:absolute;z-index:2;top:10px;left:50%;width:88px;height:20px;transform:translateX(-50%);border-radius:12px;background:#ebebeb}.phone-screen{display:flex;min-height:452px;align-items:center;justify-content:center;overflow:hidden;border-radius:23px;background:radial-gradient(circle at 50% 15%,rgba(96,122,182,.25),transparent 34%),linear-gradient(145deg,#ecedef,#ebeced 68%)}.phone-result{position:relative;width:100%;height:100%;min-height:452px}.phone-result img{display:block;width:100%;height:100%;min-height:452px;object-fit:cover}.phone-result-badge{position:absolute;right:9px;top:10px;padding:4px 6px;border-radius:6px;background:#ebeced;color:#027a48;font-size:8px}.phone-empty{display:flex;max-width:190px;align-items:center;flex-direction:column;gap:8px;padding:20px;text-align:center}.empty-orb{display:grid;width:44px;height:44px;place-items:center;border:1px solid rgba(156,133,255,.56);border-radius:50%;background:rgba(111,79,228,.22);box-shadow:0 0 28px rgba(128,92,241,.32);color:#5b3df5;font-size:21px}.phone-empty strong{color:#0f1729;font-size:12px}.phone-empty small{color:#667085;font-size:9px;line-height:1.6}.phone-home-indicator{position:absolute;bottom:7px;left:50%;width:74px;height:3px;transform:translateX(-50%);border-radius:4px;background:#c8ceda}.preview-thumbs{display:flex;gap:6px;overflow:auto;margin:11px 0 0}.preview-thumbs button{width:39px;height:39px;padding:2px;border:1px solid var(--dash-border);border-radius:6px;background:#ebecec;cursor:pointer}.preview-thumbs button.active{border-color:#a18aff;box-shadow:0 0 0 1px rgba(161,138,255,.28)}.preview-thumbs img{width:100%;height:100%;object-fit:cover;border-radius:4px}.result-meta{display:flex;justify-content:space-between;gap:7px;margin-top:10px;color:#75849f;font-size:8px}.side-info{padding:13px 14px}.side-info-head{display:flex;align-items:center;gap:7px;color:#4a5568;font-size:11px}.info-icon{display:grid;width:18px;height:18px;place-items:center;border-radius:50%;background:rgba(121,94,230,.28);color:#5b3df5;font-weight:700}.side-info ul{display:flex;flex-direction:column;gap:7px;margin:10px 0 0;padding-left:16px;color:#7e8ca6;font-size:9px;line-height:1.5}.confirm-backdrop{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;padding:20px;background:#ebebec;backdrop-filter:blur(4px)}.confirm-dialog{width:min(420px,100%);padding:22px;border:1px solid rgba(151,128,255,.5);border-radius:15px;background:#ecedef;box-shadow:0 25px 70px rgba(0,0,0,.5)}.confirm-icon{display:grid;width:38px;height:38px;place-items:center;border-radius:11px;background:rgba(133,94,244,.25);color:#5b3df5;font-size:20px}.confirm-dialog h2{margin:13px 0 8px;font-size:17px}.confirm-dialog p{margin:0;color:#1d4ed8;font-size:11px;line-height:1.6}.confirm-dialog dl{display:grid;gap:8px;margin:16px 0;padding:10px;border-radius:9px;background:rgba(6,13,25,.47)}.confirm-dialog dl div{display:flex;justify-content:space-between;gap:10px}.confirm-dialog dt{color:#71809d;font-size:9px}.confirm-dialog dd{max-width:250px;margin:0;overflow:hidden;color:#4a5568;text-overflow:ellipsis;white-space:nowrap;font-size:9px}.confirm-actions{display:flex;justify-content:flex-end;gap:8px}.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;clip-path:inset(50%)}
.context-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap}.analysis-output{white-space:pre-wrap;color:#4a5568!important}.analysis-insights{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0;padding:8px;border:1px solid #e9edf5;border-radius:8px;background:rgba(7,15,28,.26)}.analysis-insights>div{min-width:0}.analysis-insights strong{display:block;margin-bottom:5px;color:#0f1729;font-size:9px}.analysis-insights ul{display:flex;flex-direction:column;gap:4px;margin:0;padding-left:13px;color:#4a5568;font-size:8px;line-height:1.45}.analysis-insights li{overflow-wrap:anywhere}.analysis-meta{display:block;margin:-2px 0 8px;color:#667085;font-size:8px}.analysis-error{color:#f04438!important}.phone-loading,.phone-error{display:flex;max-width:200px;align-items:center;flex-direction:column;gap:8px;padding:20px;text-align:center}.phone-loading strong,.phone-error strong{color:#0f1729;font-size:12px}.phone-loading small,.phone-error small{color:#667085;font-size:9px;line-height:1.6}.spinning-orb{animation:spin 1.2s linear infinite}.error-orb{border-color:rgba(243,103,133,.6);background:rgba(220,57,97,.2);color:#b42318}.phone-product-preview{display:flex;width:100%;min-height:452px;flex-direction:column;justify-content:flex-start;background:#f7f9ff;color:#12213e}.phone-product-image{position:relative;display:grid;min-height:230px;place-items:center;overflow:hidden;background:linear-gradient(145deg,#dbe8ff,#8ba9d6);color:#607294;font-size:11px}.phone-product-image img{width:100%;height:230px;object-fit:cover}.phone-product-image i{position:absolute;left:9px;top:11px;padding:4px 6px;border-radius:5px;background:#ecedef;color:#fff;font-size:8px;font-style:normal}.phone-product-copy{display:flex;flex-direction:column;gap:7px;padding:12px}.phone-product-copy strong{font-size:13px;line-height:1.35}.phone-product-copy>span{color:#667795;font-size:9px;line-height:1.45}.phone-price-row{display:flex;align-items:baseline;gap:7px}.phone-price-row b{color:#e83453;font-size:17px}.phone-price-row del{color:#667085;font-size:10px}.phone-preview-note{margin:auto 12px 18px;padding-top:9px;border-top:1px solid #e1e7f2;color:#73819a;font-size:8px;line-height:1.45}.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;clip-path:inset(50%)}
@media(max-width:1240px){.model-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.style-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.studio-layout{grid-template-columns:minmax(0,1fr) 300px}}
@media(max-width:980px){.studio-layout{grid-template-columns:1fr}.studio-side{display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,.7fr);align-items:start}.phone-frame{min-height:400px}.phone-screen,.phone-result,.phone-result img{min-height:374px}}
@media(max-width:700px){.image-studio-page{padding:16px}.studio-page-head{flex-direction:column}.head-actions{justify-content:flex-start}.model-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.style-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.context-fields,.action-card,.analysis-insights{grid-template-columns:1fr}.prompt-tools{align-items:stretch;flex-direction:column}.generate-button{justify-content:center}.studio-side{display:flex}.advanced-settings{align-items:stretch;flex-direction:column}.advanced-settings label{min-width:0}}

/* AI 生图参考稿是浅色工作区；外层工作台导航继续使用统一的深色壳。 */
.image-studio-page{--studio-ink:#16275e;--studio-muted:#6f7fa7;--studio-border:rgba(103,143,207,.2);color:var(--studio-ink);background:radial-gradient(circle at 8% 0%,rgba(116,206,255,.28),transparent 30%),radial-gradient(circle at 92% 8%,rgba(187,137,255,.2),transparent 34%),linear-gradient(145deg,#eaf7ff 0%,#f4f1ff 48%,#edf6ff 100%)}
.image-studio-page .studio-page-head p,.image-studio-page .card-heading p{color:var(--studio-muted)}
.image-studio-page .studio-card{border-color:var(--studio-border);background:rgba(255,255,255,.82);box-shadow:0 15px 38px rgba(91,125,180,.13)}
.image-studio-page .studio-alert{border-color:rgba(92,137,214,.2);background:rgba(255,255,255,.72);color:#63749d}.image-studio-page .studio-alert strong{color:var(--studio-ink)}
.image-studio-page .studio-alert.warning{border-color:rgba(224,161,72,.34);background:rgba(255,247,224,.72)}.image-studio-page .studio-alert.error{background:rgba(255,237,243,.84);color:#c13f61}.image-studio-page .studio-alert.info{background:rgba(234,247,255,.8)}
.image-studio-page .config-pill,.image-studio-page .studio-button.ghost,.image-studio-page .text-button,.image-studio-page .tool-button{border-color:var(--studio-border);background:rgba(255,255,255,.68);color:#38528d}.image-studio-page .studio-button.primary{color:#fff;background:linear-gradient(135deg,#6379f6,#f7f1fe);border-color:rgba(115,94,231,.6)}
.image-studio-page .card-kicker{color:#7f72d0}.image-studio-page .card-heading h2,.image-studio-page .model-option strong,.image-studio-page .style-option strong,.image-studio-page .prompt-label{color:var(--studio-ink)}
.image-studio-page .model-option,.image-studio-page .style-option{border-color:var(--studio-border);background:rgba(248,251,255,.8);color:var(--studio-ink)}.image-studio-page .model-option:hover,.image-studio-page .model-option:focus-visible,.image-studio-page .style-option:hover,.image-studio-page .style-option:focus-visible{background:#fff;border-color:#7a91f4}.image-studio-page .model-option.selected,.image-studio-page .style-option.selected{border-color:#6b75ff;background:linear-gradient(145deg,rgba(239,235,255,.98),rgba(237,247,255,.96));box-shadow:0 0 0 2px rgba(105,120,244,.12),0 10px 23px rgba(116,103,227,.16)}
.image-studio-page .model-option small,.image-studio-page .style-option small,.image-studio-page .model-note{color:#7181a8}.image-studio-page .model-option em{color:#8392b0}.image-studio-page .model-option.selected em{color:#665ce0}.image-studio-page .warning-text{color:#b56e23}.image-studio-page .feature-chips span,.image-studio-page .feature-chips button{background:rgba(236,243,255,.9);color:#4564a1}.image-studio-page .feature-chips button{padding:5px 7px;border:0;border-radius:7px;cursor:pointer;font:inherit;font-size:9px}.image-studio-page .feature-chips button:hover:not(:disabled),.image-studio-page .feature-chips button:focus-visible{background:#e1eaff;outline:2px solid rgba(100,126,236,.28);outline-offset:1px}.image-studio-page .feature-chips button:disabled{cursor:not-allowed;opacity:.55}.image-studio-page .safe-badge{border-color:rgba(24,178,142,.32);color:#119f7c;background:rgba(229,253,245,.7)}
.image-studio-page .chat-bubble{border-color:#e9edf5;color:#304574}.image-studio-page .user-bubble{border-color:rgba(91,125,228,.24);background:linear-gradient(135deg,#edf5ff,#e9e8ff);color:#3d5595}.image-studio-page .assistant-bubble{background:rgba(245,249,255,.9)}.image-studio-page .assistant-bubble strong{color:var(--studio-ink)}.image-studio-page .assistant-bubble p{color:#687a9f}.image-studio-page .context-card{border-color:rgba(113,147,205,.16);background:rgba(235,243,255,.62)}.image-studio-page .context-copy strong{color:#2c427e}.image-studio-page .context-copy span{color:#6c7da3}.image-studio-page .context-copy small{color:#8795b1}.image-studio-page .robot-avatar{box-shadow:0 0 18px rgba(89,139,244,.26)}
.image-studio-page .product-context{border-top-color:rgba(100,139,202,.16)}.image-studio-page .context-heading strong{color:var(--studio-ink)}.image-studio-page .context-heading span{color:#7787aa}.image-studio-page .context-fields label,.image-studio-page .advanced-settings label{color:#61749f}.image-studio-page .context-fields input,.image-studio-page .advanced-settings select,.image-studio-page .prompt-card textarea{border-color:rgba(103,143,207,.28);background:rgba(255,255,255,.85);color:#22386e}.image-studio-page .prompt-card textarea::placeholder{color:#8795b2}.image-studio-page .prompt-card textarea:focus,.image-studio-page .context-fields input:focus{border-color:#7188f7;box-shadow:0 0 0 3px rgba(113,136,247,.14)}
.image-studio-page .asset-strip{color:#526b9f}.image-studio-page .asset-strip span{background:rgba(225,237,255,.82)}.image-studio-page .asset-strip small{color:#7a8bad}.image-studio-page .advanced-settings{border-color:rgba(105,142,207,.18);background:rgba(239,246,255,.72)}.image-studio-page .advanced-settings>span{color:#7183a6}
.image-studio-page .asset-strip button{margin-left:4px;padding:0;border:0;background:transparent;color:#6b7fa9;cursor:pointer;font-size:12px;line-height:1}.image-studio-page .asset-strip button:hover,.image-studio-page .asset-strip button:focus-visible{color:#e14f70;outline:2px solid rgba(225,79,112,.22);outline-offset:1px}
.image-studio-page .action-tile{border-color:rgba(102,143,211,.2);color:#1d3475;box-shadow:0 7px 15px rgba(94,132,203,.1)}.image-studio-page .action-tile small{color:#6e7fa4}.image-studio-page .action-tile.blue{background:linear-gradient(135deg,#eaf5ff,#cfe5ff)}.image-studio-page .action-tile.pink{background:linear-gradient(135deg,#fff0fa,#ffd7ec)}.image-studio-page .action-tile.teal{background:linear-gradient(135deg,#e8fff8,#c8f5e9)}.image-studio-page .action-tile.purple{background:linear-gradient(135deg,#f0eaff,#ddd3ff)}
.image-studio-page .phone-card{background:rgba(255,255,255,.84)}.image-studio-page .phone-card .card-heading h2{color:var(--studio-ink)}.image-studio-page .phone-frame{border-color:#e9edf5;background:#ecedee;box-shadow:0 0 0 2px rgba(86,112,163,.28),0 16px 34px rgba(57,91,145,.22)}.image-studio-page .phone-screen{background:linear-gradient(145deg,#f6fbff,#e6efff)}.image-studio-page .phone-empty strong{color:#20366e}.image-studio-page .phone-empty small{color:#667085}.image-studio-page .side-info{background:rgba(255,255,255,.78)}.image-studio-page .side-info-head{color:#20366e}.image-studio-page .side-info ul{color:#667085}.image-studio-page .result-meta{color:#667085}.image-studio-page .confirm-dialog{background:#fff;color:var(--studio-ink);border-color:rgba(118,101,229,.42)}.image-studio-page .confirm-dialog p{color:#65769b}.image-studio-page .confirm-dialog dl{background:#f1f5ff}.image-studio-page .confirm-dialog dt{color:#7181a4}.image-studio-page .confirm-dialog dd{color:#2c427e}.image-studio-page .analysis-meta{color:#7b8cab}
.image-studio-page .phone-loading strong,.image-studio-page .phone-error strong{color:#20366e}.image-studio-page .phone-loading small,.image-studio-page .phone-error small{color:#667085}
.image-studio-page .analysis-insights{border-color:#e9edf5;background:rgba(232,241,255,.62)}.image-studio-page .analysis-insights strong{color:#31508d}.image-studio-page .analysis-insights ul{color:#657aa4}
</style>
