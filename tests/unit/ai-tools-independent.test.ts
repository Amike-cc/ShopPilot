import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * AI 工具的独立性守卫（2026-11-13；2026-11-15 删除「AI 生成商品图」与「图文带货」）。
 *
 * 产品口径：每个工具都有自己的侧栏入口、页面、安装键和模型设置。
 * 任何一个工具被卸载时，另一个必须继续可用。
 */
const read = (path: string) => readFileSync(path, 'utf8')
const dashboard = read('apps/desktop/src/renderer/src/features/workbench/DashboardView.vue')
const appsPage = read('apps/desktop/src/renderer/src/features/workbench/UnifiedAppsPage.vue')
const assistantPage = read('apps/desktop/src/renderer/src/features/workbench/UnifiedAssistantPage.vue')
const chatImagePage = read('apps/desktop/src/renderer/src/features/workbench/UnifiedChatImagePage.vue')
const settingsPage = read('apps/desktop/src/renderer/src/features/workbench/UnifiedSettingsPage.vue')
const appModules = read('apps/desktop/src/renderer/src/features/workbench/use-app-modules.ts')
const preload = read('apps/desktop/src/preload/index.ts')
const ipcContract = read('packages/shared/src/contracts/ipc.ts')

describe('AI 工具：各自独立的功能入口', () => {
  it('侧栏是两个独立入口，不再有「AI 创作」壳页', () => {
    expect(dashboard).toContain("{ key: 'assistant', label: 'AI 电商助手'")
    expect(dashboard).toContain("{ key: 'chat-image', label: '对话生图'")
    expect(dashboard).not.toContain("{ key: 'ai', label: 'AI 创作'")
    expect(dashboard).not.toContain("'image-studio'")
    expect(dashboard).toContain("<UnifiedAssistantPage v-else-if=\"activePage === 'assistant'\" />")
  })

  it('卸载键与路由一一对应，互不连带', () => {
    expect(dashboard).toContain("assistant: 'ai-assistant'")
    expect(dashboard).toContain("'chat-image': 'ai-chat-image'")
    expect(dashboard).not.toContain('isAiHubInstalled')
  })

  it('商城两张卡各自指向独立页面，助手不再是抽屉事件', () => {
    expect(appsPage).toContain("page: 'assistant'")
    expect(appsPage).toContain("page: 'chat-image'")
    expect(appsPage).not.toContain("page: 'image-studio'")
    expect(appsPage).not.toContain("emit('open-assistant')")
  })

  it('助手拥有完整页面，而不只是悬浮球', () => {
    expect(assistantPage).toContain('<AgentDrawer embedded title="AI 电商助手" />')
    expect(assistantPage).toContain('agent.initialize()')
  })

  it('「AI 生成商品图」已彻底删除：安装键、页面、分析 IPC 都不再保留', () => {
    expect(appModules).not.toContain("'ai-image'")
    expect(dashboard).not.toContain('UnifiedImageStudioPage')
    expect(appsPage).not.toContain("'ai-image'")
    expect(ipcContract).not.toContain('AI_IMAGE_TEXT_ANALYZE')
    expect(preload).not.toContain('analyzeImageProduct')
  })

  it('「图文带货」已彻底删除：安装键、页面、文案 IPC 与生图文本配置都不再保留', () => {
    expect(appModules).not.toContain("'ai-graphic'")
    expect(dashboard).not.toContain('UnifiedGraphicSellPage')
    expect(dashboard).not.toContain("'graphic-sell'")
    expect(appsPage).not.toContain("'ai-graphic'")
    expect(ipcContract).not.toContain('AI_IMAGE_TEXT_SELL_COPY')
    expect(ipcContract).not.toContain('AI_IMAGE_TEXT_CONFIG_GET')
    expect(preload).not.toContain('generateSellCopy')
    expect(preload).not.toContain('imageTextConfigGet')
    expect(settingsPage).not.toContain("aiSectionVisible('image-text')")
  })
})

describe('AI 工具：设置跟着工具走', () => {
  it('每个工具只打开自己使用的模型配置', () => {
    expect(assistantPage).toContain(':sections="[\'text\']"')
    expect(chatImagePage).toContain(':sections="[\'image\']"')
  })

  it('设置页按 onlyAiSections 过滤卡片与完整度计数', () => {
    expect(settingsPage).toContain('onlyAiSections')
    expect(settingsPage).toContain("aiSectionVisible('text')")
    expect(settingsPage).toContain("aiSectionVisible('image')")
    expect(settingsPage).toContain('当前工具已完成')
  })
})
