import { computed, ref } from 'vue'
import {
  buildChatImagePrompt,
  chatImageRatioLabel,
  chatImageRequestSize,
  clampChatImageCount,
  chatImageSaveName,
  chatImageSourceFromDataUrl,
  type ChatImageRatio
} from './chat-image'

/** 「对话生图」的会话状态：每条用户消息就是一次生图请求，参考图只作用于下一轮。 */
export interface ChatImageAttachment {
  name: string
  dataUrl: string
}

export interface ChatImageResult {
  url: string
  model: string
  elapsedMs: number
}

/**
 * 这一轮生成实际用的参数（2026-11-15 用户要求「模型、比例、张数在对话框显示」）。
 *
 * 存在**助手消息**上而不是用户消息上：参数是这次生成的事实，失败时也要留着，
 * 用户能直接从对话里对上"当时选的什么、为什么只出一张"。
 * `model` 取接口回报的模型（可能和服务配置不同），取不到才退回配置值。
 */
export interface ChatImageRequestParams {
  model: string
  ratio: ChatImageRatio
  /** 比例的中文标签，与下拉框同源（见 chatImageRatioLabel） */
  ratioLabel: string
  /** 本轮请求的张数（已收口到 1–4） */
  count: number
}

export interface ChatImageMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: number
  /** 用户这一轮附带的参考图（用于回显） */
  reference?: ChatImageAttachment | null
  /** 这一轮的生图参数（仅助手消息） */
  params?: ChatImageRequestParams
  /**
   * 产生这条结果（或这次失败）的提示词原文（仅助手消息）。
   *
   * 存在的唯一理由：失败重试要能拿回原文。此前只能靠"往上翻找上一条用户消息"，
   * 一旦中间插了别的轮次就会重试错内容。
   */
  prompt?: string
  images?: ChatImageResult[]
  error?: string
}

/** 一次生成的入参：失败重试时用它把"当时的选择"原样还原，而不是拿当前选择器去覆盖 */
export interface ChatImageSubmitOptions {
  ratio?: ChatImageRatio
  count?: number
  /** 重试时沿用原来的参考图（不再从下一轮引用里取） */
  reference?: ChatImageAttachment | null
  /** 重试：替换这条失败消息，而不是再追一轮 */
  replaceMessageId?: string
}

interface ImageConfigView {
  imageModel?: string
  hasImageKey?: boolean
  imageEndpoint?: string
  resolvedImageEndpoint?: string
}

type GenerateImageResponse = {
  images?: Array<{ b64Json?: string; mimeType?: string; url?: string }>
  model?: string
  elapsedMs?: number
}

export function useChatImage() {
  const messages = ref<ChatImageMessage[]>([])
  const draft = ref('')
  const ratio = ref<ChatImageRatio>('1:1')
  const imageCount = ref(1)
  /** 下一轮要用的参考图；发送后自动清空，避免无意识地连续改同一张 */
  const reference = ref<ChatImageAttachment | null>(null)
  const busy = ref(false)
  const phase = ref('')
  const notice = ref('')
  const noticeIsError = ref(false)
  const config = ref<ImageConfigView | null>(null)
  const configLoading = ref(false)
  const configError = ref('')
  let seq = 0

  const model = computed(() => config.value?.imageModel || '')
  const configured = computed(() => Boolean(
    config.value?.hasImageKey && config.value?.imageEndpoint && config.value?.resolvedImageEndpoint && config.value?.imageModel
  ))

  function id(prefix: string): string {
    seq += 1
    return `${prefix}-${Date.now()}-${seq}`
  }
  function say(text: string, isError = false): void {
    notice.value = text
    noticeIsError.value = isError
  }

  async function reloadConfig(): Promise<void> {
    configLoading.value = true
    configError.value = ''
    try {
      const result = await window.shopilot.ai.imageConfigGet()
      if (!result.ok) throw new Error(result.error.message)
      config.value = (result.data || null) as ImageConfigView | null
    } catch (error) {
      config.value = null
      configError.value = `读取生图配置失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      configLoading.value = false
    }
  }

  function setReference(attachment: ChatImageAttachment | null): void {
    reference.value = attachment
    if (attachment) say(`已引用「${attachment.name}」，下一条消息会基于它修改`)
  }

  function clearReference(): void {
    reference.value = null
  }

  function reset(): void {
    if (busy.value) return
    messages.value = []
    draft.value = ''
    reference.value = null
    notice.value = ''
    noticeIsError.value = false
  }

  /**
   * 一次生成（重构 2026-11-16）。
   *
   * 之前 `send()` 把"读输入框 / 读选择器 / 清引用 / 发请求"全揉在一起，导致两件事做不到：
   *   · 失败重试——拿不回"当时用的提示词和参数"，只能让用户重敲；
   *   · 参数回放——重试必须按**原来的**比例/张数，而不是当前选择器。
   * 现在文本与参数都从入参来，`send()` 只是它的一个薄包装。
   */
  async function submit(rawText: string, options: ChatImageSubmitOptions = {}): Promise<void> {
    const text = String(rawText || '').trim()
    if (!text || busy.value) return
    notice.value = ''
    noticeIsError.value = false
    await reloadConfig()
    if (!configured.value) {
      configError.value = '生图接口未配置或凭据不完整，请点右上角「模型设置」补齐后再试。'
      return
    }

    const requestedRatio = options.ratio || ratio.value
    const attachment = options.reference !== undefined ? options.reference : reference.value
    const source = attachment ? chatImageSourceFromDataUrl(attachment.dataUrl, attachment.name) : null
    const requested = clampChatImageCount(options.count ?? imageCount.value)
    const requestedModel = model.value
    const retrying = Boolean(options.replaceMessageId)

    if (retrying) {
      // 重试：把失败的那条原位替换掉，不重复追加用户消息（否则对话里会出现两遍同样的话）
      messages.value = messages.value.filter(message => message.id !== options.replaceMessageId)
    } else {
      messages.value.push({
        id: id('user'),
        role: 'user',
        text,
        at: Date.now(),
        reference: attachment
      })
      draft.value = ''
      reference.value = null
    }

    busy.value = true
    phase.value = retrying ? '正在重试…' : '正在生成图片…'
    try {
      const result = await window.shopilot.ai.generateImage({
        prompt: buildChatImagePrompt(text, Boolean(source)),
        size: chatImageRequestSize(requestedRatio),
        n: requested,
        confirmed: true,
        ...(source ? { sourceImages: [source] } : {})
      })
      if (!result.ok) throw new Error(result.error.message)
      const data = (result.data || {}) as GenerateImageResponse
      const images = (Array.isArray(data.images) ? data.images : [])
        .map(item => item?.b64Json ? `data:${item.mimeType || 'image/png'};base64,${item.b64Json}` : String(item?.url || ''))
        .filter(Boolean)
      if (!images.length) throw new Error('接口没有返回可预览的图片')
      messages.value.push({
        id: id('assistant'),
        role: 'assistant',
        text: '',
        at: Date.now(),
        prompt: text,
        reference: attachment,
        params: {
          model: String(data.model || requestedModel || '—'),
          ratio: requestedRatio,
          ratioLabel: chatImageRatioLabel(requestedRatio),
          count: requested
        },
        images: images.map(url => ({
          url,
          model: String(data.model || requestedModel || '—'),
          elapsedMs: Number(data.elapsedMs || 0)
        }))
      })
      if (images.length < requested) say(`请求 ${requested} 张，接口实际返回 ${images.length} 张`)
    } catch (error) {
      messages.value.push({
        id: id('assistant'),
        role: 'assistant',
        text: '',
        at: Date.now(),
        prompt: text,
        reference: attachment,
        // 失败时也留下参数：用户能看出"是 2 张都没出来，还是比例选错了"，也是重试的依据
        params: {
          model: String(requestedModel || '—'),
          ratio: requestedRatio,
          ratioLabel: chatImageRatioLabel(requestedRatio),
          count: requested
        },
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      busy.value = false
      phase.value = ''
    }
  }

  /** 发送输入框里的内容（读取当前选择器） */
  async function send(): Promise<void> {
    await submit(draft.value)
  }

  /**
   * 失败重试：按那条消息记录的提示词与参数重发。
   * 没有记录提示词（理论上不会有）时如实提示，不猜一条去发。
   */
  async function retry(messageId: string): Promise<void> {
    const failed = messages.value.find(message => message.id === messageId)
    if (!failed || busy.value) return
    const text = String(failed.prompt || '').trim()
    if (!text) {
      say('这条消息没有记录提示词，无法重试；请重新描述一次', true)
      return
    }
    await submit(text, {
      ratio: failed.params?.ratio,
      count: failed.params?.count,
      reference: failed.reference ?? null,
      replaceMessageId: messageId
    })
  }

  async function saveImage(url: string, index: number): Promise<void> {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(url)
    if (!match) { say('这张图没有可保存的 base64 数据', true); return }
    try {
      const result = await window.shopilot.ai.saveImage({
        b64Json: match[2],
        mimeType: match[1].toLowerCase(),
        suggestedName: chatImageSaveName(index)
      })
      if (!result.ok) throw new Error(result.error.message)
      if (result.data?.canceled) { say('已取消保存'); return }
      say(`已保存：${String(result.data?.path || '')}`)
    } catch (error) {
      say(`保存失败：${error instanceof Error ? error.message : String(error)}`, true)
    }
  }

  return {
    messages,
    draft,
    ratio,
    imageCount,
    reference,
    busy,
    phase,
    notice,
    noticeIsError,
    config,
    configLoading,
    configError,
    model,
    configured,
    reloadConfig,
    setReference,
    clearReference,
    reset,
    send,
    submit,
    retry,
    say,
    saveImage
  }
}
