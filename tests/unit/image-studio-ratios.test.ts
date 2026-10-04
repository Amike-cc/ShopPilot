import { describe, expect, it } from 'vitest'
import { IMAGE_STUDIO_FREE_EDIT_RATIO_OPTIONS, IMAGE_STUDIO_RATIO_OPTIONS, imageStudioRequestSize } from '../../apps/desktop/src/renderer/src/features/workbench/image-studio-ratios'

describe('AI 商品图比例菜单', () => {
  it('与参考站五个创作入口的十项比例一致', () => {
    expect(IMAGE_STUDIO_RATIO_OPTIONS.map(option => option.key)).toEqual([
      '1:1', '1:2', '1:3', '2:1', '2:3', '3:2', '3:4', '4:3', '9:16', '9:21'
    ])
    expect(IMAGE_STUDIO_RATIO_OPTIONS.map(option => option.label)).toContain('9:16 手机竖屏')
  })

  it('自由编辑保留参考站额外的宽屏比例并映射到可用请求尺寸', () => {
    expect(IMAGE_STUDIO_FREE_EDIT_RATIO_OPTIONS.map(option => option.key).slice(-2)).toEqual(['16:9', '21:9'])
    expect(imageStudioRequestSize('1:1')).toBe('1024x1024')
    expect(imageStudioRequestSize('2:1')).toBe('1536x1024')
    expect(imageStudioRequestSize('9:21')).toBe('1024x1536')
    expect(imageStudioRequestSize('unknown')).toBe('1024x1024')
  })
})
