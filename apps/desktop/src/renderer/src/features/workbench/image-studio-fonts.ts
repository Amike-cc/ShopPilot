/**
 * AI 商品图工作台的字体目录。
 * cssFamily 只用于软件内预览；真实图片文字由供应商模型绘制，
 * 所以生成提示词会同时带上完整字体名与可用字体回退约束。
 */
export interface ImageStudioFontOption {
  key: string
  label: string
  cssFamily: string
  prompt: string
  license: string
}

export const IMAGE_STUDIO_FONT_OPTIONS: ImageStudioFontOption[] = [
  { key: 'auto', label: '推荐字体', cssFamily: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif', prompt: '推荐字体（由模型根据版面自动选择清晰易读的中文字体）', license: '可能存在版权风险，请人工审核' },
  { key: 'source-han-sans', label: '思源黑体', cssFamily: '"Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif', prompt: '思源黑体（Source Han Sans SC）', license: '可商用字体，仍需人工审核' },
  { key: 'source-han-serif', label: '思源宋体', cssFamily: '"Source Han Serif SC", "Noto Serif CJK SC", "SimSun", serif', prompt: '思源宋体（Source Han Serif SC）', license: '可商用字体，仍需人工审核' },
  { key: 'alibaba-puhuiti', label: '阿里巴巴普惠体', cssFamily: '"Alibaba PuHuiTi", "Microsoft YaHei", sans-serif', prompt: '阿里巴巴普惠体（Alibaba PuHuiTi）', license: '可商用字体，仍需人工审核' },
  { key: 'zcool-happy', label: '站酷快乐体', cssFamily: '"ZCOOL KuaiLe", "Microsoft YaHei", sans-serif', prompt: '站酷快乐体（ZCOOL KuaiLe）', license: '可商用字体，仍需人工审核' },
  { key: 'smiley-sans', label: '得意黑', cssFamily: '"Smiley Sans", "Microsoft YaHei", sans-serif', prompt: '得意黑（Smiley Sans）', license: '可商用字体，仍需人工审核' },
  { key: 'lxgw-wenkai', label: '霞鹜文楷', cssFamily: '"LXGW WenKai", "KaiTi", serif', prompt: '霞鹜文楷（LXGW WenKai）', license: '可商用字体，仍需人工审核' }
]

export function getImageStudioFont(key: string): ImageStudioFontOption {
  return IMAGE_STUDIO_FONT_OPTIONS.find(option => option.key === key) || IMAGE_STUDIO_FONT_OPTIONS[0]
}
