import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const aiClient = readFileSync('apps/desktop/src/main/services/ai-client.ts', 'utf8')
const aiHandlers = readFileSync('apps/desktop/src/main/ipc/ai-handlers.ts', 'utf8')
const studio = readFileSync('apps/desktop/src/renderer/src/features/workbench/UnifiedImageStudioPage.vue', 'utf8')

describe('生图模型配置来源', () => {
  it('主进程生图请求只使用设置中心的 imageModel', () => {
    expect(aiClient).toContain('const model = cfg.imageModel')
    expect(aiClient).not.toContain('opts.model || cfg.imageModel')
    expect(aiHandlers).toContain('AiClient.generateImage({ prompt, size, n, sourceImages })')
  })

  it('商品图页面不把模型选择器值传给生成 IPC', () => {
    expect(studio).toContain('window.shopilot.ai.generateImage({ prompt: buildPrompt(job.kind), size: job.size')
    expect(studio).not.toContain('generateImage({ prompt: buildPrompt(job.kind), model:')
    expect(studio).toContain('模型来自设置中心，生成时使用此模型')
  })
})
