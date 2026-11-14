import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 四个 AI 工具的独立性守卫（2026-11-13，2026-11-14 新增对话生图）。
 *
 * 产品口径：AI 创作里的功能不再共用一个壳页——每个工具都有自己的侧栏入口、页面、
 * 安装键和模型设置。任何一个工具被卸载时，另外两个必须继续可用。
 */
const read = (path: string) => readFileSync(path, 'utf8')
const dashboard = read('apps/desktop/src/renderer/src/features/workbench/DashboardView.vue')
const appsPage = read('apps/desktop/src/renderer/src/features/workbench/UnifiedAppsPage.vue')
const assistantPage = read('apps/desktop/src/renderer/src/features/workbench/UnifiedAssistantPage.vue')
const imagePage = read('apps/desktop/src/renderer/src/features/workbench/UnifiedImageStudioPage.vue')
const chatImagePage = read('apps/desktop/src/renderer/src/features/workbench/UnifiedChatImagePage.vue')
const graphicPage = read('apps/desktop/src/renderer/src/features/workbench/UnifiedGraphicSellPage.vue')
const settingsPage = read('apps/desktop/src/renderer/src/features/workbench/UnifiedSettingsPage.vue')

describe('AI 工具：各自独立的功能入口', () => {
  it('侧栏是四个独立入口，不再有「AI 创作」壳页', () => {
    expect(dashboard).toContain("{ key: 'assistant', label: 'AI 电商助手'")
    expect(dashboard).toContain("{ key: 'image-studio', label: 'AI 生成商品图'")
    expect(dashboard).toContain("{ key: 'chat-image', label: '对话生图'")
    expect(dashboard).toContain("{ key: 'graphic-sell', label: '图文带货'")
    expect(dashboard).not.toContain("{ key: 'ai', label: 'AI 创作'")
    expect(dashboard).toContain("<UnifiedAssistantPage v-else-if=\"activePage === 'assistant'\" />")
  })

  it('卸载键与路由一一对应，互不连带', () => {
    expect(dashboard).toContain("assistant: 'ai-assistant'")
    expect(dashboard).toContain("'image-studio': 'ai-image'")
    expect(dashboard).toContain("'chat-image': 'ai-chat-image'")
    expect(dashboard).toContain("'graphic-sell': 'ai-graphic'")
    expect(dashboard).not.toContain('isAiHubInstalled')
  })

  it('商城四张卡各自指向独立页面，助手不再是抽屉事件', () => {
    expect(appsPage).toContain("page: 'assistant'")
    expect(appsPage).toContain("page: 'image-studio'")
    expect(appsPage).toContain("page: 'chat-image'")
    expect(appsPage).toContain("page: 'graphic-sell'")
    expect(appsPage).not.toContain("emit('open-assistant')")
  })

  it('助手拥有完整页面，而不只是悬浮球', () => {
    expect(assistantPage).toContain('<AgentDrawer embedded title="AI 电商助手" />')
    expect(assistantPage).toContain('agent.initialize()')
  })
})

describe('AI 工具：设置跟着工具走', () => {
  it('每个工具只打开自己使用的模型配置', () => {
    expect(assistantPage).toContain(':sections="[\'text\']"')
    expect(imagePage).toContain(':sections="[\'image\', \'image-text\']"')
    expect(chatImagePage).toContain(':sections="[\'image\']"')
    expect(graphicPage).toContain(':sections="[\'image\', \'image-text\']"')
  })

  it('设置页按 onlyAiSections 过滤卡片与完整度计数', () => {
    expect(settingsPage).toContain('onlyAiSections')
    expect(settingsPage).toContain("aiSectionVisible('text')")
    expect(settingsPage).toContain("aiSectionVisible('image')")
    expect(settingsPage).toContain("aiSectionVisible('image-text')")
    expect(settingsPage).toContain('当前工具已完成')
  })
})
