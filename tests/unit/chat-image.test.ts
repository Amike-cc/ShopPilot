import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildChatImagePrompt,
  chatImageRatioLabel,
  chatImageRequestSize,
  chatImageSaveName,
  chatImageSourceFromDataUrl,
  clampChatImageCount
} from '../../apps/desktop/src/renderer/src/features/workbench/chat-image'
import { useChatImage } from '../../apps/desktop/src/renderer/src/features/workbench/use-chat-image'

/**
 * 对话生图（2026-11-14）：纯规则 + 接线守卫。
 * 对话本身不接文本模型：用户消息就是提示词；「基于这张改」把结果作为 sourceImages 续改。
 */
const read = (path: string) => readFileSync(path, 'utf8')
const page = read('apps/desktop/src/renderer/src/features/workbench/UnifiedChatImagePage.vue')
const composable = read('apps/desktop/src/renderer/src/features/workbench/use-chat-image.ts')
const modules = read('apps/desktop/src/renderer/src/features/workbench/use-app-modules.ts')
const dashboard = read('apps/desktop/src/renderer/src/features/workbench/DashboardView.vue')
const appsPage = read('apps/desktop/src/renderer/src/features/workbench/UnifiedAppsPage.vue')

describe('对话生图：规则', () => {
  it('比例映射到接口支持的三种尺寸', () => {
    expect(chatImageRequestSize('1:1')).toBe('1024x1024')
    expect(chatImageRequestSize('3:4')).toBe('1024x1536')
    expect(chatImageRequestSize('4:3')).toBe('1536x1024')
  })

  it('张数收口在 1–4', () => {
    expect(clampChatImageCount(0)).toBe(1)
    expect(clampChatImageCount(2)).toBe(2)
    expect(clampChatImageCount(99)).toBe(4)
  })

  it('有参考图时明确只改指定部分；无参考图时是普通文生图', () => {
    const plain = buildChatImagePrompt('白色背景的运动鞋主图', false)
    expect(plain).toContain('白色背景的运动鞋主图')
    expect(plain).toContain('不要添加水印')
    const edited = buildChatImagePrompt('把背景换成海边日落', true)
    expect(edited).toContain('基于参考图修改')
    expect(edited).toContain('只修改用户指定的部分')
    expect(edited).toContain('保持参考图中未被要求修改的主体')
    expect(buildChatImagePrompt('   ', false)).toBe('')
  })

  it('data URL 解析成 sourceImages；非图片返回 null', () => {
    const source = chatImageSourceFromDataUrl('data:image/png;base64,AAAA', 'a.png')
    expect(source).toEqual({ name: 'a.png', mimeType: 'image/png', b64Json: 'AAAA' })
    expect(chatImageSourceFromDataUrl('https://example.com/a.png')).toBeNull()
    expect(chatImageSaveName(2, 1700000000000)).toBe('chat-image-1700000000000-2.png')
  })

  it('比例标签与下拉框同源：未知 key 原样返回、空值给破折号，不编造', () => {
    expect(chatImageRatioLabel('1:1')).toBe('1 : 1 方图')
    expect(chatImageRatioLabel('4:3')).toBe('4 : 3 横图')
    expect(chatImageRatioLabel('16:9')).toBe('16:9')
    expect(chatImageRatioLabel('')).toBe('—')
    expect(chatImageRatioLabel(undefined)).toBe('—')
  })
})

/**
 * 2026-11-15 用户要求「模型、比例、张数在对话框显示」：
 * 参数记在**助手消息**上（失败也记），这样对话里能直接对上"当时选的什么、出没出来"。
 */
describe('对话生图：每轮参数记录', () => {
  afterEach(() => { delete (globalThis as { window?: unknown }).window })

  function stubBridge(options: { ok?: boolean; model?: string } = {}) {
    const calls: Array<Record<string, unknown>> = []
    ;(globalThis as { window?: unknown }).window = {
      shopilot: {
        ai: {
          imageConfigGet: async () => ({
            ok: true,
            data: { imageModel: 'cfg-model', hasImageKey: true, imageEndpoint: 'https://e', resolvedImageEndpoint: 'https://r' }
          }),
          generateImage: async (request: Record<string, unknown>) => {
            calls.push(request)
            if (options.ok === false) return { ok: false, error: { message: '接口 500' } }
            return {
              ok: true,
              data: {
                images: [{ b64Json: 'AAAA', mimeType: 'image/png' }],
                model: options.model || 'gpt-image-1',
                elapsedMs: 1500
              }
            }
          },
          saveImage: async () => ({ ok: true, data: {} })
        }
      }
    }
    return calls
  }

  it('成功轮次：助手消息带上接口回报的模型、比例标签与张数，请求本身也一致', async () => {
    const calls = stubBridge()
    const chat = useChatImage()
    chat.draft.value = '白色背景的商品主图'
    chat.ratio.value = '4:3'
    chat.imageCount.value = 4
    await chat.send()

    const assistant = chat.messages.value.find(message => message.role === 'assistant')
    expect(assistant?.params).toEqual({ model: 'gpt-image-1', ratio: '4:3', ratioLabel: '4 : 3 横图', count: 4 })
    // 记录值与真正发出去的请求不能两张皮
    expect(calls[0]?.size).toBe('1536x1024')
    expect(calls[0]?.n).toBe(4)
  })

  it('失败轮次也留参数：能看出"是没出来，还是比例选错了"', async () => {
    stubBridge({ ok: false })
    const chat = useChatImage()
    chat.draft.value = '春季女装街拍'
    chat.ratio.value = '3:4'
    chat.imageCount.value = 2
    await chat.send()

    const assistant = chat.messages.value.find(message => message.role === 'assistant')
    expect(assistant?.error).toContain('接口 500')
    expect(assistant?.params).toEqual({ model: 'cfg-model', ratio: '3:4', ratioLabel: '3 : 4 竖图', count: 2 })
    // 重试要靠它把提示词拿回来
    expect(assistant?.prompt).toBe('春季女装街拍')
  })
})

/**
 * 2026-11-16 重构：`send()` 拆成 `submit(text, options)` + `retry(id)`。
 * 重点在"重试要按当时的参数、且不能把用户那句话再追加一遍"。
 */
describe('对话生图：失败重试', () => {
  afterEach(() => { delete (globalThis as { window?: unknown }).window })

  function stubBridge(plan: Array<'ok' | 'fail'>) {
    const calls: Array<Record<string, unknown>> = []
    ;(globalThis as { window?: unknown }).window = {
      shopilot: {
        ai: {
          imageConfigGet: async () => ({
            ok: true,
            data: { imageModel: 'cfg-model', hasImageKey: true, imageEndpoint: 'https://e', resolvedImageEndpoint: 'https://r' }
          }),
          generateImage: async (request: Record<string, unknown>) => {
            calls.push(request)
            const step = plan.shift() || 'ok'
            if (step === 'fail') return { ok: false, error: { message: '接口 502' } }
            return { ok: true, data: { images: [{ b64Json: 'AAAA', mimeType: 'image/png' }], model: 'gpt-image-1', elapsedMs: 800 } }
          },
          saveImage: async () => ({ ok: true, data: {} })
        }
      }
    }
    return calls
  }

  it('重试替换失败消息、按原比例与张数重发，不重复追加用户消息', async () => {
    const calls = stubBridge(['fail', 'ok'])
    const chat = useChatImage()
    chat.draft.value = '木质桌面上的咖啡杯'
    chat.ratio.value = '4:3'
    chat.imageCount.value = 4
    await chat.send()

    const failed = chat.messages.value.find(message => message.role === 'assistant')
    expect(failed?.error).toContain('接口 502')

    // 用户中途把选择器改掉了：重试不该跟着改，要用这条消息记录的原参数
    chat.ratio.value = '1:1'
    chat.imageCount.value = 1
    await chat.retry(failed!.id)

    expect(chat.messages.value.filter(message => message.role === 'user')).toHaveLength(1)
    expect(chat.messages.value.filter(message => message.role === 'assistant')).toHaveLength(1)
    expect(chat.messages.value.some(message => message.error)).toBe(false)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.size).toBe('1536x1024')
    expect(calls[1]?.n).toBe(4)
    expect(calls[1]?.prompt).toContain('木质桌面上的咖啡杯')
    const reborn = chat.messages.value.find(message => message.role === 'assistant')
    expect(reborn?.params).toEqual({ model: 'gpt-image-1', ratio: '4:3', ratioLabel: '4 : 3 横图', count: 4 })
  })

  it('没有记录提示词的失败消息不给重试（不猜一条去发）', async () => {
    const calls = stubBridge(['ok'])
    const chat = useChatImage()
    // 手工塞一条没有 prompt 的失败消息，模拟历史遗留数据
    chat.messages.value.push({ id: 'legacy-fail', role: 'assistant', text: '', at: Date.now(), error: '旧记录' })
    await chat.retry('legacy-fail')
    expect(calls).toHaveLength(0)
    expect(chat.notice.value).toContain('无法重试')
  })
})

describe('对话生图：独立模块接线', () => {
  it('模块键、侧栏入口、页面路由、商城卡都存在', () => {
    expect(modules).toContain("'ai-chat-image'")
    expect(modules).toContain('CHAT_IMAGE_INTRODUCED_KEY')
    expect(modules).toContain('introduceChatImageIfNeeded')
    expect(dashboard).toContain("{ key: 'chat-image', label: '对话生图'")
    expect(dashboard).toContain("'chat-image': 'ai-chat-image'")
    expect(dashboard).toContain("activePage === 'chat-image'")
    expect(appsPage).toContain("testId: 'apps-ai-chat-image'")
    expect(appsPage).toContain("page: 'chat-image'")
  })

  it('页面：输入/发送/消息/结果/参考图/保存的完整钩子', () => {
    for (const hook of [
      'chat-image-page',
      'chat-image-thread',
      'chat-image-input',
      'chat-image-send',
      'chat-image-ratio',
      'chat-image-count',
      'chat-image-reference',
      'chat-image-user-message',
      'chat-image-assistant-message',
      'chat-image-generating',
      'chat-image-material-input',
      'chat-image-new',
      'chat-image-model',
      'chat-image-composer-meta',
      'chat-image-preview',
      'chat-image-preview-close'
    ]) {
      expect(page, `页面缺少 ${hook}`).toContain(`data-test="${hook}"`)
    }
    expect(page).toContain('基于这张改')
    expect(page).toContain('chat-image-save-')
    expect(page).toContain('chat-image-use-reference-')
    expect(page).toContain('chat-image-retry-')
    expect(page).toContain('@keydown.enter.exact.prevent="sendMessage"')
    // 粘贴截图直接当参考图
    expect(page).toContain('@paste="onPaste"')
    expect(page).toContain('applyReferenceFile')
  })

  it('比例/张数搬到输入框上方，顶栏不再重复一份', () => {
    const [beforeComposer, afterComposer] = page.split('data-test="chat-image-composer-meta"')
    expect(beforeComposer).not.toContain('data-test="chat-image-ratio"')
    expect(beforeComposer).not.toContain('data-test="chat-image-count"')
    expect(afterComposer).toContain('data-test="chat-image-ratio"')
    expect(afterComposer).toContain('data-test="chat-image-count"')
  })

  it('滚动只在"还在看最新"时跟随，发自己的消息才强制到底', () => {
    expect(page).toContain('NEAR_BOTTOM_PX')
    expect(page).toContain('function nearBottom()')
    expect(page).toContain('scrollToBottom(true)')
    expect(page).toContain('@load="scrollToBottom(false)"')
  })

  it('生图请求真实、带确认与参考图；保存走主进程另存为', () => {
    expect(composable).toContain('window.shopilot.ai.generateImage({')
    expect(composable).toContain('confirmed: true')
    expect(composable).toContain('sourceImages: [source]')
    expect(composable).toContain('buildChatImagePrompt(text, Boolean(source))')
    expect(composable).toContain('window.shopilot.ai.saveImage({')
    expect(composable).toContain("throw new Error('接口没有返回可预览的图片')")
    // 不接文本模型，不偷偷把对话发给另一个供应商
    expect(composable).not.toContain('chatComplete')
  })

  it('设置只显示生图接口；生成中离开会被拦截', () => {
    expect(page).toContain(':sections="[\'image\']"')
    expect(page).toContain("@closed=\"reloadConfig\"")
    expect(dashboard).toContain('const chatImageBusy = ref(false)')
    expect(dashboard).toContain("activePage.value === 'chat-image' && chatImageBusy.value")
    expect(dashboard).toContain("activeNav.value = '对话生图'")
  })
})
