import { computed, ref } from 'vue'
import {
  buildChatImagePrompt,
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

export interface ChatImageMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: number
  /** 用户这一轮附带的参考图（用于回显） */
  reference?: ChatImageAttachment | null
  images?: ChatImageResult[]
  error?: string
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

  async function send(): Promise<void> {
    const text = draft.value.trim()
    if (!text || busy.value) return
    notice.value = ''
    noticeIsError.value = false
    await reloadConfig()
    if (!configured.value) {
      configError.value = '生图接口未配置或凭据不完整，请点右上角「模型设置」补齐后再试。'
      return
    }

    const attachment = reference.value
    const source = attachment ? chatImageSourceFromDataUrl(attachment.dataUrl, attachment.name) : null
    const requested = clampChatImageCount(imageCount.value)
    messages.value.push({
      id: id('user'),
      role: 'user',
      text,
      at: Date.now(),
      reference: attachment
    })
    draft.value = ''
    reference.value = null
    busy.value = true
    phase.value = '正在生成图片…'
    try {
      const result = await window.shopilot.ai.generateImage({
        prompt: buildChatImagePrompt(text, Boolean(source)),
        size: chatImageRequestSize(ratio.value),
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
        images: images.map(url => ({
          url,
          model: String(data.model || model.value || '—'),
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
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      busy.value = false
      phase.value = ''
    }
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
    saveImage
  }
}
