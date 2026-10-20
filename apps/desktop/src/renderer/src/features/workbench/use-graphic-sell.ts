/**
 * 图文带货工作台 · 状态与生成流程（2026-10-19）
 *
 * 分工：页面只做模板与事件接线；「表单 → 接口入参」「文案 → 逐图提示词」「结果 → 历史落盘」
 * 全在纯模块 graphic-sell.ts 里，本文件只持有响应式状态、发请求、写回界面。
 *
 * 流程：① 填商品信息/选平台风格/传商品图 → ② 主进程「生图文本 API」生成带货文案
 * → ③ 按文案里的逐图画面描述逐张调用生图接口（单次最多 4 张，5–9 张拆多请求）
 * → ④ 结果可编辑、一键复制、保存图片、换一批；会话按字节预算落 localStorage。
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { SELL_COPY_LIMITS, clampSellCopyImageCount, type SellCopyInput, type SellCopyResult } from '@shared/contracts/ai-sell-copy'
import {
  GRAPHIC_SELL_DEFAULTS,
  GRAPHIC_SELL_MODEL_OPTIONS,
  GRAPHIC_SELL_RATIO_OPTIONS,
  MAX_GRAPHIC_SELL_MATERIALS,
  MAX_GRAPHIC_SELL_MATERIAL_BYTES,
  SELL_HISTORY_MAX_SESSIONS,
  SELL_HISTORY_STORAGE_KEY,
  SELL_PRESET_STORAGE_KEY,
  buildGraphicSellImagePrompt,
  buildGraphicSellInput,
  describeGraphicSellError,
  getGraphicSellEffect,
  graphicSellEffectDefaults,
  graphicSellFullText,
  graphicSellImageBatchSize,
  graphicSellImageBatches,
  graphicSellRequestSize,
  normalizeSellModel,
  parseGraphicSellHistory,
  parseGraphicSellPresetPrefs,
  parseGraphicSellTags,
  readGeneratedImageUrl,
  readGraphicSellResult,
  resolveGraphicSellReadiness,
  serializeGraphicSellHistory,
  serializeGraphicSellPresetPrefs,
  trimGraphicSellHistory,
  type GraphicSellConfigView,
  type GraphicSellEffectKey,
  type GraphicSellFormState,
  type GraphicSellHistorySession,
  type GraphicSellMaterial,
  type GraphicSellModelKey
} from './graphic-sell'

export interface GraphicSellOptions {
  /** 把“正在生成”同步给外层：离开页面会丢失返回结果，工作台据此拦截导航。 */
  emit: (event: 'busy-change', busy: boolean) => void
}

interface GeneratedSellImage {
  url: string
  index: number
}

/** 未知异常 → 人能读懂的一句话（catch 变量按 unknown 收，避免 any 扩散） */
function errorText(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message?: unknown }).message || '').trim()
    if (message) return message
  }
  return fallback
}

export function useGraphicSellGeneration(options: GraphicSellOptions) {
  const emit = options.emit

  /* ------------------------------ 表单 ------------------------------ */
  const productName = ref('')
  /** 卖点/使用场景（选填，会进文案提示词与生图提示词） */
  const sellingPoints = ref('')
  const price = ref('')
  const originalPrice = ref('')
  /** 目标人群（选填） */
  const audience = ref('')
  const platform = ref<string>(GRAPHIC_SELL_DEFAULTS.platform)
  const style = ref<string>(GRAPHIC_SELL_DEFAULTS.style)
  /** 效果模板：默认套用参考效果（俯拍躺床 9:16）；选择会被记住 */
  const effect = ref<GraphicSellEffectKey>(GRAPHIC_SELL_DEFAULTS.effect)
  const model = ref<GraphicSellModelKey>(GRAPHIC_SELL_DEFAULTS.model)
  const imageCount = ref<number>(GRAPHIC_SELL_DEFAULTS.imageCount)
  const ratio = ref<string>(GRAPHIC_SELL_DEFAULTS.ratio)
  const materials = ref<GraphicSellMaterial[]>([])
  const materialInput = ref<HTMLInputElement | null>(null)
  const uploadError = ref('')

  /* ------------------------------ 配置 ------------------------------ */
  const config = ref<GraphicSellConfigView | null>(null)
  const configError = ref('')
  const readiness = computed(() => resolveGraphicSellReadiness(config.value))

  /* ------------------------------ 生成状态 ------------------------------ */
  const generating = ref(false)
  /** 生成阶段文案（“正在生成带货文案…” / “正在生成配图 2/4…”），如实显示在按钮与结果区 */
  const phase = ref('')
  const generationError = ref('')
  const generationNotice = ref('')
  const confirmOpen = ref(false)
  const copy = ref<SellCopyResult | null>(null)
  const images = ref<GeneratedSellImage[]>([])
  const activeImageIndex = ref(0)
  /** 单张重绘：-1 = 空闲；>=0 = 正在重绘该序号的配图（只重发这一张，不动文案与其它图） */
  const regeneratingIndex = ref(-1)
  /** 本次成功生成的请求快照：单张重绘要复用同一份文案、效果模板、模特与商品图 */
  const lastRequest = ref<null | {
    sessionId: string
    createdAt: number
    form: GraphicSellFormState
    ratio: string
    effect: GraphicSellEffectKey
    model: GraphicSellModelKey
    input: SellCopyInput
    result: SellCopyResult
    sourceImages: Array<{ name: string; mimeType: string; b64Json: string }>
  }>(null)
  /** 结果区可编辑文案（生成后允许用户微调，再一键复制） */
  const editableTitle = ref('')
  const editableBody = ref('')
  const editableTagsText = ref('')
  const editableCoverText = ref('')
  const busy = computed(() => generating.value || regeneratingIndex.value >= 0)
  watch(busy, value => emit('busy-change', value), { immediate: true })

  /* ------------------------------ 保存/复制反馈 ------------------------------ */
  const saving = ref(false)
  const savedPath = ref('')
  const saveNotice = ref('')
  const saveNoticeError = ref(false)
  const actionNotice = ref('')
  const actionNoticeError = ref(false)
  let actionTimer: number | undefined
  function notify(message: string, isError = false): void {
    actionNotice.value = message
    actionNoticeError.value = isError
    if (actionTimer) window.clearTimeout(actionTimer)
    actionTimer = window.setTimeout(() => { actionNotice.value = '' }, 3200)
  }

  /* ------------------------------ 历史 ------------------------------ */
  const historySessions = ref<GraphicSellHistorySession[]>([])
  const historyOpen = ref(false)
  let persistTimer: number | null = null
  let storageWarningShown = false

  /** 当前效果模板：决定场景、模特、构图与是否需要商品图 */
  const effectOption = computed(() => getGraphicSellEffect(effect.value))
  const modelOptions = computed(() => GRAPHIC_SELL_MODEL_OPTIONS)
  const requiresProductImage = computed(() => effectOption.value.requiresProductImage)
  const canGenerate = computed(() => Boolean(productName.value.trim())
    && readiness.value.copyReady
    && readiness.value.imageReady
    // 效果模板靠"上传的商品图"保住商品本体；没图就别让用户花钱生成一件"长得像"的商品
    && (!requiresProductImage.value || materials.value.length > 0))
  const activeImage = computed(() => images.value[activeImageIndex.value] || null)
  const editableTags = computed(() => parseGraphicSellTags(editableTagsText.value))
  const fullText = computed(() => graphicSellFullText(editableTitle.value, editableBody.value, editableTags.value))
  /** 确认框里如实写清本次要发几次请求：1 次文案 + 配图分批（效果模板一张一请求） */
  const plannedRequestCount = computed(() => 1 + graphicSellImageBatches(imageCount.value, graphicSellImageBatchSize(effect.value)).length)
  const ratioLabel = computed(() => GRAPHIC_SELL_RATIO_OPTIONS.find(option => option.key === ratio.value)?.label || ratio.value)

  function normalizeImageCount(): void {
    imageCount.value = clampSellCopyImageCount(imageCount.value)
  }

  /* ------------------------------ 配置读取 ------------------------------ */
  async function loadAiConfig(): Promise<void> {
    if (!window.shopilot) {
      config.value = null
      configError.value = '当前预览环境没有 Electron 桥，无法读取 AI 配置。'
      return
    }
    configError.value = ''
    try {
      const result = await window.shopilot.ai.imageConfigGet()
      if (!result.ok) throw new Error(result.error.message)
      config.value = result.data as GraphicSellConfigView
    } catch (error: unknown) {
      config.value = null
      configError.value = `读取 AI 配置失败：${errorText(error, '未知错误')}`
    }
  }

  /* ------------------------------ 效果模板 / 预设记忆 ------------------------------ */
  /**
   * 选中效果模板 = 套用该模板的推荐参数（模特 + 比例），用户之后仍可手动改。
   * 选择写进 localStorage：下次打开页面直接是上次的效果，不用每次重新选。
   */
  function selectEffect(key: GraphicSellEffectKey): void {
    const next = getGraphicSellEffect(key)
    effect.value = next.key
    const defaults = graphicSellEffectDefaults(next.key)
    model.value = defaults.model
    ratio.value = defaults.ratio
    generationError.value = ''
    uploadError.value = ''
    persistPreset()
  }

  function selectModel(key: GraphicSellModelKey): void {
    model.value = normalizeSellModel(key)
    persistPreset()
  }

  function persistPreset(): void {
    try {
      window.localStorage.setItem(SELL_PRESET_STORAGE_KEY, serializeGraphicSellPresetPrefs({
        effect: effect.value,
        model: model.value,
        ratio: ratio.value,
        imageCount: imageCount.value
      }))
    } catch {
      // 预设记忆只是便利项：写不进去不影响生成（配额/隐私模式）
    }
  }

  function loadPreset(): void {
    try {
      const prefs = parseGraphicSellPresetPrefs(window.localStorage.getItem(SELL_PRESET_STORAGE_KEY))
      effect.value = prefs.effect
      model.value = prefs.model
      ratio.value = prefs.ratio
      imageCount.value = prefs.imageCount
    } catch {
      // 损坏的本地预设不阻塞页面：保持默认（参考效果模板）
    }
  }

  /* ------------------------------ 商品素材（1–3 张） ------------------------------ */
  function readImage(file: File, onDone: (asset: GraphicSellMaterial) => void, onError: (message: string) => void): void {
    if (!['image/png', 'image/jpeg'].includes(file.type.toLowerCase())) { onError(`${file.name}：只支持 PNG 或 JPEG。`); return }
    if (file.size > MAX_GRAPHIC_SELL_MATERIAL_BYTES) { onError(`${file.name}：超过 5MB，请压缩后再上传。`); return }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') { onError(`${file.name}：图片读取失败，请重试。`); return }
      // MIME/扩展名可以伪造：写入状态前确认浏览器真的能解码出图片
      const image = new Image()
      image.onload = () => image.naturalWidth > 0 && image.naturalHeight > 0
        ? onDone({ name: file.name, size: file.size, dataUrl: reader.result as string })
        : onError(`${file.name}：图片内容无效，请选择可正常打开的 PNG 或 JPEG。`)
      image.onerror = () => onError(`${file.name}：图片内容无效，请选择可正常打开的 PNG 或 JPEG。`)
      image.src = reader.result
    }
    reader.onerror = () => onError(`${file.name}：图片读取失败，请重试。`)
    reader.readAsDataURL(file)
  }

  function addMaterials(files: FileList | File[] | null | undefined): void {
    uploadError.value = ''
    const list = Array.from(files || [])
    if (!list.length) return
    const room = MAX_GRAPHIC_SELL_MATERIALS - materials.value.length
    if (room <= 0) { uploadError.value = `最多上传 ${MAX_GRAPHIC_SELL_MATERIALS} 张商品图，先删掉一张再传。`; return }
    if (list.length > room) uploadError.value = `只剩 ${room} 个位置，本次只收前 ${room} 张。`
    for (const file of list.slice(0, room)) {
      if (materials.value.some(item => item.name === file.name && item.size === file.size)) continue
      readImage(file, asset => {
        if (materials.value.length < MAX_GRAPHIC_SELL_MATERIALS) materials.value.push(asset)
      }, message => { uploadError.value = message })
    }
  }

  function onMaterialFiles(event: Event): void {
    const input = event.target as HTMLInputElement
    addMaterials(input.files)
    input.value = ''
  }
  function onMaterialDrop(event: DragEvent): void {
    addMaterials(event.dataTransfer?.files)
  }
  function removeMaterial(index: number): void {
    materials.value.splice(index, 1)
  }

  function toImageSource(asset: GraphicSellMaterial): { name: string; mimeType: string; b64Json: string } | null {
    const match = /^data:([^;]+);base64,(.+)$/i.exec(asset.dataUrl)
    if (!match) return null
    return { name: asset.name, mimeType: match[1].toLowerCase(), b64Json: match[2] }
  }

  /* ------------------------------ 生成 ------------------------------ */
  function clearResults(): void {
    copy.value = null
    images.value = []
    activeImageIndex.value = 0
    lastRequest.value = null
    editableTitle.value = ''
    editableBody.value = ''
    editableTagsText.value = ''
    editableCoverText.value = ''
    savedPath.value = ''
    saveNotice.value = ''
    saveNoticeError.value = false
    generationNotice.value = ''
  }

  function applyResult(result: SellCopyResult): void {
    copy.value = result
    editableTitle.value = result.title
    editableBody.value = result.body
    editableTagsText.value = result.tags.join(' ')
    editableCoverText.value = result.coverText
  }

  /** 生成前的可执行校验：每条失败都直接说清下一步，不弹一个含糊的"参数错误"。 */
  function requestGeneration(): void {
    generationError.value = ''
    generationNotice.value = ''
    if (generating.value) return
    if (!readiness.value.copyReady) {
      generationError.value = '文案接口未配置：请到「设置中心 → AI 配置」填写「生图文本 API」（或主文本 API）的地址、模型和 Key。'
      return
    }
    if (!readiness.value.imageReady) {
      generationError.value = '生图接口未配置：请到「设置中心 → AI 配置」填写生图接口的地址、模型和 Key，否则没有配图。'
      return
    }
    if (requiresProductImage.value && !materials.value.length) {
      generationError.value = `「${effectOption.value.label}」效果需要先上传商品图：只有拿着你的商品图做参考，才能保住颜色、面料、图案与文字一致。`
      return
    }
    const validation = buildGraphicSellInput({
      productName: productName.value,
      sellingPoints: sellingPoints.value,
      price: price.value,
      originalPrice: originalPrice.value,
      audience: audience.value,
      platform: platform.value,
      style: style.value,
      imageCount: imageCount.value,
      images: materials.value
    })
    if (!validation.ok) { generationError.value = validation.message; return }
    confirmOpen.value = true
  }

  async function submitGeneration(): Promise<void> {
    if (generating.value) return
    confirmOpen.value = false
    generationError.value = ''
    generationNotice.value = ''
    // 在任何 FileReader / 网络请求开始前固定本次参数：请求期间用户改控件也不能让结果与确认框不一致
    const requestForm = {
      productName: productName.value,
      sellingPoints: sellingPoints.value,
      price: price.value,
      originalPrice: originalPrice.value,
      audience: audience.value,
      platform: platform.value,
      style: style.value,
      imageCount: clampSellCopyImageCount(imageCount.value),
      images: [...materials.value]
    }
    const requestRatio = ratio.value
    const requestRatioLabel = GRAPHIC_SELL_RATIO_OPTIONS.find(option => option.key === requestRatio)?.label || requestRatio
    // 效果模板与模特在请求期间固定：用户中途改模板也不能让同一套图混两种场景
    const requestEffect = effect.value
    const requestModel = model.value
    // 模板模式一张一请求：每张构图（正面/侧身/近景/氛围）才会按参考效果轮换
    const requestBatchSize = graphicSellImageBatchSize(requestEffect)
    const validation = buildGraphicSellInput(requestForm)
    if (!validation.ok) { generationError.value = validation.message; return }
    const input: SellCopyInput = { ...validation.input, imageCount: requestForm.imageCount }
    if (!window.shopilot) { generationError.value = '当前预览环境没有 Electron 桥，无法生成。'; return }

    const sourceImages = requestForm.images
      .slice(0, SELL_COPY_LIMITS.maxImages)
      .map(toImageSource)
      .filter((item): item is { name: string; mimeType: string; b64Json: string } => Boolean(item))
    if (sourceImages.length !== requestForm.images.slice(0, SELL_COPY_LIMITS.maxImages).length) {
      generationError.value = '部分商品图读取失败，请重新上传后再试。'
      return
    }

    generating.value = true
    // 不在这里 clearResults：「换一批」失败时上一次的结果要原样保留（2026-10-21 审查 P2-28），
    // 清空动作挪到下面文案请求成功、结果校验通过之后；首次生成没有旧结果，语义不变
    const sessionId = `sell-${Date.now()}`
    const createdAt = Date.now()
    try {
      /* ① 文案（主进程组装提示词并解析 JSON；未单独配置生图文本 API 时自动回退主文本 API） */
      phase.value = readiness.value.copyChannel === 'main-text' ? '正在用主文本 API 生成带货文案…' : '正在生成带货文案…'
      const response = await window.shopilot.ai.generateSellCopy(input)
      if (!response.ok) {
        generationError.value = describeGraphicSellError(response.error)
        return
      }
      const result = readGraphicSellResult(response.data)
      if (!result) {
        generationError.value = '文案接口返回的内容不完整（缺少标题和正文），请重试或换一个文本模型。'
        return
      }
      // 新文案已到手才清旧结果：放在 applyResult 之前，避免把刚写进界面的新结果又清掉
      clearResults()
      applyResult(result)
      lastRequest.value = { sessionId, createdAt, form: requestForm, ratio: requestRatio, effect: requestEffect, model: requestModel, input, result, sourceImages }
      upsertHistory(sessionId, createdAt, requestForm, requestRatio, result, requestEffect, requestModel)

      /* ② 配图：按效果模板的逐张构图请求，单次最多 4 张；少于目标张数时继续补发 */
      let remaining = requestForm.imageCount
      let attempts = 0
      const failures: string[] = []
      while (remaining > 0 && attempts < requestForm.imageCount + 2) {
        attempts += 1
        const requestCount = Math.min(requestBatchSize, remaining)
        const startIndex = requestForm.imageCount - remaining
        phase.value = `正在生成配图 ${startIndex + 1}/${requestForm.imageCount}…`
        try {
          const imageResponse = await window.shopilot.ai.generateImage({
            prompt: buildGraphicSellImagePrompt(input, result, startIndex, requestRatioLabel, { effect: requestEffect, model: requestModel }),
            size: graphicSellRequestSize(requestRatio),
            n: requestCount,
            confirmed: true,
            sourceImages
          })
          if (!imageResponse.ok) throw new Error(imageResponse.error.message)
          const urls = Array.isArray(imageResponse.data?.images)
            ? (imageResponse.data.images as unknown[]).map(readGeneratedImageUrl).filter((url): url is string => Boolean(url))
            : []
          if (!urls.length) throw new Error('接口没有返回可预览的图片')
          const batch = urls.slice(0, requestCount).map((url: string, offset: number) => ({ url, index: startIndex + offset }))
          images.value = [...images.value, ...batch]
          remaining -= batch.length
          upsertHistory(sessionId, createdAt, requestForm, requestRatio, result, requestEffect, requestModel)
        } catch (error: unknown) {
          failures.push(errorText(error, '配图生成失败'))
          break
        }
      }
      if (remaining > 0) {
        generationNotice.value = `配图还差 ${remaining} 张：${failures.join('；') || '接口未返回足够图片'}`
      }
      phase.value = ''
    } catch (error: unknown) {
      generationError.value = describeGraphicSellError(error)
    } finally {
      generating.value = false
      phase.value = ''
    }
  }

  /**
   * 单张重绘：只重新请求第 index 张配图（同样的文案/效果模板/模特/商品图），
   * 不动其它三张——实测一套图里常有一两张姿势或表情跑偏，全量"换一批"既慢又贵。
   */
  async function regenerateImage(index: number): Promise<void> {
    const request = lastRequest.value
    if (!request || !copy.value || generating.value || regeneratingIndex.value >= 0) return
    if (!window.shopilot) { generationError.value = '当前预览环境没有 Electron 桥，无法重绘。'; return }
    const targetIndex = Math.max(0, Math.min(clampSellCopyImageCount(request.form.imageCount) - 1, Math.round(index)))
    regeneratingIndex.value = targetIndex
    generationError.value = ''
    try {
      const ratioLabelText = GRAPHIC_SELL_RATIO_OPTIONS.find(option => option.key === request.ratio)?.label || request.ratio
      const response = await window.shopilot.ai.generateImage({
        prompt: buildGraphicSellImagePrompt(request.input, request.result, targetIndex, ratioLabelText, { effect: request.effect, model: request.model }),
        size: graphicSellRequestSize(request.ratio),
        n: 1,
        confirmed: true,
        sourceImages: request.sourceImages
      })
      if (!response.ok) throw new Error(response.error.message)
      const imagesData = Array.isArray(response.data?.images) ? response.data.images as unknown[] : []
      const url = readGeneratedImageUrl(imagesData[0])
      if (!url) throw new Error('接口没有返回可预览的图片')
      const next = images.value.filter(image => image.index !== targetIndex)
      next.push({ url, index: targetIndex })
      images.value = next.sort((left, right) => left.index - right.index)
      notify(`已重绘第 ${targetIndex + 1} 张配图`)
      upsertHistory(request.sessionId, request.createdAt, request.form, request.ratio, request.result, request.effect, request.model)
    } catch (error: unknown) {
      generationError.value = describeGraphicSellError(error)
    } finally {
      regeneratingIndex.value = -1
    }
  }

  /* ------------------------------ 历史落盘 ------------------------------ */
  function upsertHistory(
    sessionId: string,
    createdAt: number,
    form: GraphicSellFormState,
    requestRatio: string,
    result: SellCopyResult,
    requestEffect: GraphicSellEffectKey,
    requestModel: GraphicSellModelKey
  ): void {
    const session: GraphicSellHistorySession = {
      id: sessionId,
      createdAt,
      productName: String(form.productName || '').trim(),
      platform: String(form.platform || GRAPHIC_SELL_DEFAULTS.platform),
      style: String(form.style || GRAPHIC_SELL_DEFAULTS.style),
      ratio: requestRatio,
      effect: requestEffect,
      sellModel: getGraphicSellEffect(requestEffect).forcedModel || normalizeSellModel(requestModel),
      title: editableTitle.value || result.title,
      body: editableBody.value || result.body,
      tags: editableTags.value.length ? editableTags.value : result.tags,
      coverText: editableCoverText.value || result.coverText,
      imagePrompts: result.imagePrompts,
      images: images.value.map(image => ({ url: image.url, index: image.index })),
      model: result.model,
      source: result.source
    }
    historySessions.value = [session, ...historySessions.value.filter(item => item.id !== sessionId)].slice(0, SELL_HISTORY_MAX_SESSIONS)
    schedulePersistHistory()
  }

  function schedulePersistHistory(): void {
    if (typeof window === 'undefined') return
    if (persistTimer != null) window.clearTimeout(persistTimer)
    persistTimer = window.setTimeout(() => { persistTimer = null; persistHistory() }, 800)
  }

  function persistHistory(): void {
    try {
      const payload = serializeGraphicSellHistory(historySessions.value)
      window.localStorage.setItem(SELL_HISTORY_STORAGE_KEY, payload)
      storageWarningShown = false
    } catch {
      // 配额满/隐私模式：本次会话内保留，明确告知用户（不静默丢历史）
      if (!storageWarningShown) {
        storageWarningShown = true
        notify('本地历史存储空间不足：新结果只在本次会话内可见，请及时复制文案与保存图片', true)
      }
    }
  }

  function loadPersistedHistory(): void {
    try {
      const raw = window.localStorage.getItem(SELL_HISTORY_STORAGE_KEY)
      historySessions.value = trimGraphicSellHistory(parseGraphicSellHistory(raw))
    } catch {
      historySessions.value = []
    }
  }

  function restoreSession(session: GraphicSellHistorySession): void {
    // 生成进行中不允许恢复：submitGeneration 的批次循环会继续往 images 追加、并 upsertHistory
    // 把在途会话插回历史首位——整体覆盖后两个会话的数据会互相污染（与「清空」按钮同口径，2026-10-21 审查 P1-8）
    if (generating.value || regeneratingIndex.value >= 0) {
      notify('正在生成中，请等本轮结束（或停止）后再恢复历史会话', true)
      return
    }
    productName.value = session.productName
    platform.value = session.platform
    style.value = session.style
    const sessionEffect = getGraphicSellEffect(session.effect)
    effect.value = sessionEffect.key
    model.value = sessionEffect.forcedModel || normalizeSellModel(session.sellModel)
    ratio.value = GRAPHIC_SELL_RATIO_OPTIONS.some(option => option.key === session.ratio) ? session.ratio : graphicSellEffectDefaults(sessionEffect.key).ratio
    imageCount.value = clampSellCopyImageCount(session.imagePrompts.length || session.images.length || GRAPHIC_SELL_DEFAULTS.imageCount)
    materials.value = []
    copy.value = {
      title: session.title,
      body: session.body,
      tags: session.tags,
      coverText: session.coverText,
      imagePrompts: session.imagePrompts,
      model: session.model,
      elapsedMs: 0,
      // 旧历史记录没有 source 字段时缺省 image-text（P2-30：恢复历史不能把主文本 API 回退误标成生图文本 API）
      source: session.source ?? 'image-text',
      imageCount: session.imagePrompts.length
    }
    editableTitle.value = session.title
    editableBody.value = session.body
    editableTagsText.value = session.tags.join(' ')
    editableCoverText.value = session.coverText
    images.value = session.images.map(image => ({ url: image.url, index: image.index }))
    activeImageIndex.value = 0
    generationError.value = ''
    generationNotice.value = session.images.length ? '' : '该历史会话只保存了文案（配图超出本地存储预算），可重新生成配图。'
    historyOpen.value = false
  }

  function removeHistorySession(sessionId: string): void {
    // 生成进行中不允许删除：在途批次返回后 upsertHistory 会把刚删掉的会话复活
    if (generating.value || regeneratingIndex.value >= 0) {
      notify('正在生成中，历史记录暂不能删除', true)
      return
    }
    historySessions.value = historySessions.value.filter(item => item.id !== sessionId)
    persistHistory()
  }

  /* ------------------------------ 保存图片 / 复制文案 ------------------------------ */
  async function saveActiveImage(): Promise<void> {
    const image = activeImage.value
    if (!image) return
    const match = /^data:([^;]+);base64,(.+)$/i.exec(image.url)
    if (!match) { saveNoticeError.value = true; saveNotice.value = '当前结果不是可保存的图片数据（供应商返回的是外部地址）'; return }
    saving.value = true
    saveNotice.value = ''
    saveNoticeError.value = false
    try {
      const suggestedName = [productName.value.trim() || '图文带货', `配图${image.index + 1}`, editableTitle.value.trim().slice(0, 16)].filter(Boolean).join('-')
      const result = await window.shopilot.ai.saveImage({ b64Json: match[2], mimeType: match[1].toLowerCase(), suggestedName })
      if (!result.ok) throw new Error(result.error.message)
      if (result.data?.canceled) { saveNotice.value = '已取消保存'; return }
      savedPath.value = String(result.data?.path || '')
      saveNotice.value = `已保存：${savedPath.value}（${Math.round(Number(result.data?.bytes || 0) / 1024)} KB）`
    } catch (error: unknown) {
      saveNoticeError.value = true
      saveNotice.value = `保存失败：${errorText(error, '未知错误')}`
    } finally {
      saving.value = false
    }
  }

  async function revealSavedImage(): Promise<void> {
    if (!savedPath.value) return
    // 与 saveActiveImage 同口径兜底：桥缺失（preload 未就绪）或 invoke 被拒时不能裸抛
    // unhandled rejection（2026-10-21 审查 P2）
    try {
      const result = await window.shopilot.ai.revealImage(savedPath.value)
      if (!result.ok) { saveNoticeError.value = true; saveNotice.value = `打开所在文件夹失败：${result.error.message}` }
    } catch (error: unknown) {
      saveNoticeError.value = true
      saveNotice.value = `打开所在文件夹失败：${errorText(error, '未知错误')}`
    }
  }

  /** Electron 渲染层在部分环境下拿不到 navigator.clipboard（非安全上下文），保留 execCommand 兜底 */
  async function writeClipboard(text: string): Promise<boolean> {
    if (!text.trim()) return false
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true }
    } catch { /* 走下面的兜底 */ }
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(area)
      return ok
    } catch {
      return false
    }
  }

  async function copySellText(kind: 'title' | 'body' | 'tags' | 'full'): Promise<void> {
    const text = kind === 'title'
      ? editableTitle.value
      : kind === 'body'
        ? editableBody.value
        : kind === 'tags'
          ? editableTags.value.map(tag => `#${tag}`).join(' ')
          : fullText.value
    const label = kind === 'title' ? '标题' : kind === 'body' ? '正文' : kind === 'tags' ? '话题标签' : '完整文案'
    if (!text.trim()) { notify(`还没有可复制的${label}`, true); return }
    const ok = await writeClipboard(text)
    notify(ok ? `已复制${label}` : '复制失败：请手动选中文本复制', !ok)
  }

  function resetAll(): void {
    productName.value = ''
    sellingPoints.value = ''
    price.value = ''
    originalPrice.value = ''
    audience.value = ''
    materials.value = []
    uploadError.value = ''
    clearResults()
    generationError.value = ''
    generationNotice.value = ''
    // 效果模板/模特是"使用偏好"，清空表单时不重置；只回到该模板的推荐参数
    const defaults = graphicSellEffectDefaults(effect.value)
    model.value = defaults.model
    imageCount.value = GRAPHIC_SELL_DEFAULTS.imageCount
    ratio.value = defaults.ratio
    platform.value = GRAPHIC_SELL_DEFAULTS.platform
    style.value = GRAPHIC_SELL_DEFAULTS.style
  }

  function flushPendingPersist(): void {
    if (persistTimer != null) {
      window.clearTimeout(persistTimer)
      persistTimer = null
      persistHistory()
    }
  }

  onMounted(() => {
    // 先恢复上次的效果模板/模特/比例，再读历史（历史只读不改当前表单）
    loadPreset()
    loadPersistedHistory()
    void loadAiConfig()
  })
  // 比例 / 张数 / 模特的后续调整也要记住（效果模板在 selectEffect 里已写一次）
  watch([ratio, imageCount, model], () => persistPreset())
  onBeforeUnmount(() => {
    flushPendingPersist()
    // 页面被卸载后父级收不到 busy=false 会一直拦截导航，这里显式复位
    if (generating.value) emit('busy-change', false)
    if (actionTimer) window.clearTimeout(actionTimer)
  })

  return {
    // 表单
    productName,
    sellingPoints,
    price,
    originalPrice,
    audience,
    platform,
    style,
    effect,
    model,
    effectOption,
    modelOptions,
    requiresProductImage,
    selectEffect,
    selectModel,
    imageCount,
    ratio,
    materials,
    materialInput,
    uploadError,
    normalizeImageCount,
    addMaterials,
    onMaterialFiles,
    onMaterialDrop,
    removeMaterial,
    // 配置
    config,
    configError,
    readiness,
    loadAiConfig,
    // 生成
    generating,
    regeneratingIndex,
    phase,
    generationError,
    generationNotice,
    confirmOpen,
    copy,
    images,
    activeImageIndex,
    activeImage,
    regenerateImage,
    editableTitle,
    editableBody,
    editableTagsText,
    editableCoverText,
    editableTags,
    fullText,
    canGenerate,
    plannedRequestCount,
    ratioLabel,
    requestGeneration,
    submitGeneration,
    resetAll,
    // 保存/复制
    saving,
    savedPath,
    saveNotice,
    saveNoticeError,
    actionNotice,
    actionNoticeError,
    saveActiveImage,
    revealSavedImage,
    copySellText,
    // 历史
    historySessions,
    historyOpen,
    restoreSession,
    removeHistorySession
  }
}

export type GraphicSellApi = ReturnType<typeof useGraphicSellGeneration>
