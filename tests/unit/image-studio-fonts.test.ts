import { describe, expect, it } from 'vitest'
import { getImageStudioFont, IMAGE_STUDIO_FONT_OPTIONS } from '../../apps/desktop/src/renderer/src/features/workbench/image-studio-fonts'

describe('AI 商品图字体目录', () => {
  it('覆盖网站字体菜单并保留稳定 key', () => {
    expect(IMAGE_STUDIO_FONT_OPTIONS.map(font => font.label)).toEqual([
      '推荐字体', '思源黑体', '思源宋体', '阿里巴巴普惠体', '站酷快乐体', '得意黑', '霞鹜文楷'
    ])
    expect(new Set(IMAGE_STUDIO_FONT_OPTIONS.map(font => font.key)).size).toBe(IMAGE_STUDIO_FONT_OPTIONS.length)
  })

  it('未知值安全回退到推荐字体，且每项都有预览与授权提示', () => {
    expect(getImageStudioFont('missing').key).toBe('auto')
    for (const font of IMAGE_STUDIO_FONT_OPTIONS) {
      expect(font.cssFamily.trim()).toBeTruthy()
      expect(font.prompt).toContain(font.label)
      expect(font.license).toContain('人工审核')
    }
  })
})
