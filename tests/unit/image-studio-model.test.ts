/**
 * 「AI 生成商品图」模型解析的回归测试。
 *
 * 这些用例全部来自真实踩到的坑（配置 gpt-image-2.5 却用 gpt-image-2 生成），
 * 不是假想场景：供应商真实返回的就是 ['codex-auto-review','gpt-5.6-luna',…,'gpt-image-2','gpt-image-2.5']。
 */
import { describe, expect, it } from 'vitest'
import { candidateModelsForCard, matchModelForCard, pickDefaultCardKey } from '../../apps/desktop/src/renderer/src/features/workbench/image-studio-model'

const CARDS = [
  { key: 'gpt-image', modelNames: ['gpt-image', 'gpt-image-1'] },
  { key: 'flux-1', modelNames: ['flux', 'flux.1', 'flux-1'] },
  { key: 'sdxl', modelNames: ['sdxl', 'stable-diffusion-xl'] },
  { key: 'gemini', modelNames: ['gemini', 'imagen'] },
  { key: 'custom', modelNames: [] as string[] }
]
/** 本机真实供应商返回的列表（截取相关项） */
const REAL = ['codex-auto-review', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-image-2', 'gpt-image-2.5']

describe('image studio 模型解析', () => {
  it('配置里写的模型优先于列表顺序（不再静默降级到 gpt-image-2）', () => {
    const card = CARDS[0]
    expect(matchModelForCard(card, REAL, 'gpt-image-2.5')).toBe('gpt-image-2.5')
    expect(matchModelForCard(card, REAL, 'gpt-image-2')).toBe('gpt-image-2')
  })

  it('没有配置模型时，取与卡片名最贴近的那个（同前缀取更长/更新的）', () => {
    expect(matchModelForCard(CARDS[0], REAL, '')).toBe('gpt-image-2.5')
  })

  it('配置的模型不在供应商列表里时，退回候选匹配而不是硬用配置值', () => {
    expect(matchModelForCard(CARDS[0], REAL, 'gpt-image-9')).toBe('gpt-image-2.5')
  })

  it('卡片名与候选完全同名时优先精确匹配', () => {
    expect(matchModelForCard(CARDS[1], ['flux-1', 'flux-1.1-pro', 'flux-dev'], '')).toBe('flux-1')
  })

  it('供应商没有这张卡片的模型时返回空串（界面据此提示改选自定义）', () => {
    expect(matchModelForCard(CARDS[2], REAL, 'sdxl')).toBe('')
    expect(matchModelForCard(CARDS[4], REAL, '')).toBe('')
  })

  it('候选匹配与界面「已发现」口径一致', () => {
    expect(candidateModelsForCard(CARDS[0], REAL)).toEqual(['gpt-image-2', 'gpt-image-2.5'])
  })

  it('默认卡片跟着配置的模型走，而不是永远第一张', () => {
    expect(pickDefaultCardKey(CARDS, 'gpt-image-2.5', 'custom')).toBe('gpt-image')
    expect(pickDefaultCardKey(CARDS, 'flux-1.1-pro', 'custom')).toBe('flux-1')
    expect(pickDefaultCardKey(CARDS, 'stable-diffusion-xl', 'custom')).toBe('sdxl')
    expect(pickDefaultCardKey(CARDS, '', 'custom')).toBe('custom')
    expect(pickDefaultCardKey(CARDS, 'some-unknown-model', 'custom')).toBe('custom')
  })
})
