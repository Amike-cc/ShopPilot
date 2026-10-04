/**
 * 多模态请求体形状的回归测试。
 *
 * 背景（2026-10-03）：用户报"上传商品图后 AI 分析卖点"用不了 —— 分析链路当时是纯文本的，
 * 上传的图片根本没进请求；而且没填名称/卖点时按钮是禁用的。
 * 现在有图就走 content 数组（vision），没图保持纯字符串（老行为一字不改）。
 */
import { describe, expect, it } from 'vitest'
import { buildChatRequestBody, buildVisionUserContent } from '../../apps/desktop/src/main/services/model-request'

const IMAGE = { mimeType: 'image/png', b64Json: 'iVBORw0KGgo=' }

describe('多模态用户内容', () => {
  it('把文本和图片拼成 OpenAI 兼容的 content 数组（text + image_url/data URL）', () => {
    const parts = buildVisionUserContent('商品名称：陶瓷杯', [IMAGE])
    expect(parts).toEqual([
      { type: 'text', text: '商品名称：陶瓷杯' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }
    ])
  })

  it('多张图片按顺序追加', () => {
    const parts = buildVisionUserContent('x', [IMAGE, { mimeType: 'image/jpeg', b64Json: 'AAAA' }])
    expect(parts).toHaveLength(3)
    expect((parts[2] as any).image_url.url).toBe('data:image/jpeg;base64,AAAA')
  })

  it('没有图时请求体的 user content 仍是纯字符串（老行为不变）', () => {
    const body = buildChatRequestBody({ model: 'm', system: 's', user: 'u', maxTokens: 100 })
    expect((body.messages as any[])[1].content).toBe('u')
  })

  it('有图时请求体带 content 数组，且字段名与协议一致', () => {
    const body = buildChatRequestBody({
      model: 'm', system: 's', user: 'u', maxTokens: 100,
      userContent: buildVisionUserContent('u', [IMAGE])
    })
    const messages = body.messages as any[]
    expect(messages[0]).toEqual({ role: 'system', content: 's' })
    expect(Array.isArray(messages[1].content)).toBe(true)
    expect(messages[1].content[1].type).toBe('image_url')
    expect(body.stream).toBe(false)
    expect(body.max_tokens).toBe(100)
  })
})
