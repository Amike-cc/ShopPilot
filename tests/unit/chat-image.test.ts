import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildChatImagePrompt,
  chatImageRequestSize,
  chatImageSaveName,
  chatImageSourceFromDataUrl,
  clampChatImageCount
} from '../../apps/desktop/src/renderer/src/features/workbench/chat-image'

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
      'chat-image-model'
    ]) {
      expect(page, `页面缺少 ${hook}`).toContain(`data-test="${hook}"`)
    }
    expect(page).toContain('基于这张改')
    expect(page).toContain('chat-image-save-')
    expect(page).toContain('chat-image-use-reference-')
    expect(page).toContain('@keydown.enter.exact.prevent="sendMessage"')
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
