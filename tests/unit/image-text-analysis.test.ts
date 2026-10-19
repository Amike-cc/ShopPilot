import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ANALYSIS_MAX_IMAGES,
  ANALYSIS_MAX_IMAGE_BYTES,
  ANALYSIS_MAX_TEXT_LENGTH,
  analysisPromptText,
  buildAnalysisInput,
  canAnalyzeProduct,
  dataUrlToAnalysisImage,
  describeAnalysisError
} from '../../apps/desktop/src/renderer/src/features/workbench/image-text-analysis'

/**
 * 生图文本 API 商品分析的回归网（2026-10-18「配置项空转」接线）。
 *
 * 这批是纯函数：data URL 收口、组参裁剪、可用性判据、模型返回清洗、错误话术。
 * 页面只负责取状态/发请求/写回输入框，真正的判据都在这里钉死。
 */

const SOURCE = readFileSync(
  resolve('apps/desktop/src/renderer/src/features/workbench/image-text-analysis.ts'),
  'utf8'
)

/** 造一张合法的 data URL：payload 长度可控，便于测边界 */
function png(payload = 'AAAA', mime = 'png'): string {
  return `data:image/${mime};base64,${payload}`
}

describe('dataUrlToAnalysisImage：只收白名单 data URL', () => {
  it('png / jpeg / webp 都能解析出 mimeType 与 b64Json', () => {
    expect(dataUrlToAnalysisImage({ dataUrl: png('QUJD', 'png') })).toEqual({ mimeType: 'image/png', b64Json: 'QUJD' })
    expect(dataUrlToAnalysisImage({ dataUrl: png('QUJD', 'jpeg') })).toEqual({ mimeType: 'image/jpeg', b64Json: 'QUJD' })
    expect(dataUrlToAnalysisImage({ dataUrl: png('QUJD', 'webp') })).toEqual({ mimeType: 'image/webp', b64Json: 'QUJD' })
  })

  it('大小写与首尾空白不影响解析，mimeType 统一小写', () => {
    expect(dataUrlToAnalysisImage({ dataUrl: `  DATA:IMAGE/PNG;BASE64,QUJD  ` })).toEqual({ mimeType: 'image/png', b64Json: 'QUJD' })
    expect(dataUrlToAnalysisImage({ dataUrl: png('QUJD', 'JPEG') })).toEqual({ mimeType: 'image/jpeg', b64Json: 'QUJD' })
  })

  it('base64 的 + / = 是合法字符，不做二次解码', () => {
    expect(dataUrlToAnalysisImage({ dataUrl: png('a+b/c==') })).toEqual({ mimeType: 'image/png', b64Json: 'a+b/c==' })
  })

  it('非白名单类型 / 非 base64 / 不是 data URL 一律 null', () => {
    const bad = [
      'data:image/gif;base64,QUJD',
      'data:image/jpg;base64,QUJD',
      'data:image/svg+xml;base64,QUJD',
      'data:application/octet-stream;base64,QUJD',
      'data:image/png,QUJD',
      'data:image/png;base64',
      'data:image/png;base64,',
      'data:image/png;base64,QU JD',
      'data:image/png;base64,QU-JD',
      'https://example.com/a.png',
      'QUJD',
      'data:image/png;base64,%%%'
    ]
    for (const dataUrl of bad) {
      expect(dataUrlToAnalysisImage({ dataUrl }), `应当拒绝：${dataUrl}`).toBeNull()
    }
  })

  it('缺字段 / 空对象 / undefined 都安全返回 null', () => {
    expect(dataUrlToAnalysisImage({})).toBeNull()
    expect(dataUrlToAnalysisImage({ name: 'a.png' })).toBeNull()
    expect(dataUrlToAnalysisImage({ dataUrl: undefined })).toBeNull()
    expect(dataUrlToAnalysisImage({ dataUrl: '' })).toBeNull()
    expect(dataUrlToAnalysisImage({ dataUrl: '   ' })).toBeNull()
    expect(dataUrlToAnalysisImage(null as never)).toBeNull()
    expect(dataUrlToAnalysisImage(undefined as never)).toBeNull()
    // mimeType 字段单独存在不算数：判据是 dataUrl 前缀
    expect(dataUrlToAnalysisImage({ mimeType: 'image/png' })).toBeNull()
  })

  it('超过 8MB 的图返回 null，刚好 8MB 仍可用', () => {
    // ceil(len * 3 / 4) 与主进程 ai-handlers 的估算方式一致
    const atLimit = 'A'.repeat(Math.floor(ANALYSIS_MAX_IMAGE_BYTES * 4 / 3))
    expect(dataUrlToAnalysisImage({ dataUrl: png(atLimit) })).not.toBeNull()
    const overLimit = 'A'.repeat(Math.floor(ANALYSIS_MAX_IMAGE_BYTES * 4 / 3) + 1)
    expect(dataUrlToAnalysisImage({ dataUrl: png(overLimit) })).toBeNull()
  })
})

describe('buildAnalysisInput：trim + 丢弃非法项', () => {
  it('文本字段 trim 后为空就不传', () => {
    expect(buildAnalysisInput({})).toEqual({ images: [] })
    expect(buildAnalysisInput({ productName: '   ', prompt: '\n\t' })).toEqual({ images: [] })
    expect(buildAnalysisInput({ productName: '  折叠椅 ', prompt: ' 户外露营 ' })).toEqual({
      name: '折叠椅',
      tags: '户外露营',
      images: []
    })
  })

  it('价格字段同样 trim 后为空不传', () => {
    expect(buildAnalysisInput({ price: ' 199 ', originalPrice: ' 299 ' })).toEqual({
      price: '199',
      originalPrice: '299',
      images: []
    })
    expect(buildAnalysisInput({ price: '   ', originalPrice: '' })).toEqual({ images: [] })
  })

  it('图片最多 3 张，且只留合法项', () => {
    const input = buildAnalysisInput({
      images: [
        { name: 'a.png', dataUrl: png('QUJD') },
        { name: 'broken.png', dataUrl: 'data:image/gif;base64,QUJD' },
        { name: 'b.jpg', dataUrl: png('REVG', 'jpeg') },
        { name: 'c.webp', dataUrl: png('R0hJ', 'webp') },
        { name: 'd.png', dataUrl: png('SktM') }
      ]
    })
    expect(input.images).toEqual([
      { mimeType: 'image/png', b64Json: 'QUJD' },
      { mimeType: 'image/jpeg', b64Json: 'REVG' },
      { mimeType: 'image/webp', b64Json: 'R0hJ' }
    ])
    expect(input.images).toHaveLength(ANALYSIS_MAX_IMAGES)
  })

  it('非法图被跳过但不影响后面的合法图（凑满 3 张为止）', () => {
    const input = buildAnalysisInput({
      images: [
        { dataUrl: 'data:image/gif;base64,QUJD' },
        { dataUrl: 'nope' },
        { dataUrl: 'data:image/png;base64,' },
        { dataUrl: png('TEFURVI') }
      ]
    })
    expect(input.images).toEqual([{ mimeType: 'image/png', b64Json: 'TEFURVI' }])
  })

  it('没有图 / 空数组都不抛异常', () => {
    expect(buildAnalysisInput({ images: [] }).images).toEqual([])
    expect(buildAnalysisInput({ images: undefined }).images).toEqual([])
    expect(buildAnalysisInput({ images: [null as never, undefined as never] }).images).toEqual([])
  })

  it('不改入参', () => {
    const images = Object.freeze([Object.freeze({ name: 'a.png', dataUrl: png('QUJD') })])
    const before = JSON.stringify(images)
    buildAnalysisInput({ productName: ' 椅子 ', images })
    expect(JSON.stringify(images)).toBe(before)
  })
})

describe('canAnalyzeProduct：至少一个可用来源', () => {
  const image = { dataUrl: png('QUJD') }

  it('商品名或描述非空即可分析', () => {
    expect(canAnalyzeProduct({ productName: '折叠椅' })).toBe(true)
    expect(canAnalyzeProduct({ prompt: '户外露营' })).toBe(true)
    expect(canAnalyzeProduct({ productName: '  ', prompt: ' 卖点 ' })).toBe(true)
  })

  it('普通图片也算来源，非法图不算', () => {
    expect(canAnalyzeProduct({ images: [image] })).toBe(true)
    expect(canAnalyzeProduct({ images: [{ dataUrl: 'data:image/gif;base64,QUJD' }] })).toBe(false)
    expect(canAnalyzeProduct({ images: [] })).toBe(false)
  })

  it('全是空白文本且没有合法图 → 不能分析', () => {
    expect(canAnalyzeProduct({})).toBe(false)
    expect(canAnalyzeProduct({ productName: '', prompt: '   ', images: [] })).toBe(false)
    expect(canAnalyzeProduct({ productName: '\n', prompt: '\t', images: [{ dataUrl: '' }] })).toBe(false)
  })

  it('判据与实际发出的入参同源：说能分析就一定带得动东西', () => {
    const samples = [
      {},
      { productName: ' 椅子 ' },
      { prompt: '卖点' },
      { images: [{ dataUrl: png('QUJD') }] },
      { images: [{ dataUrl: 'bad' }] },
      { productName: ' ', images: [{ dataUrl: 'bad' }] },
      { productName: '椅子', images: [{ dataUrl: 'bad' }] }
    ]
    for (const sample of samples) {
      const input = buildAnalysisInput(sample)
      const usable = Boolean(input.name || input.tags || input.images.length)
      expect(canAnalyzeProduct(sample), JSON.stringify(sample)).toBe(usable)
    }
  })
})

describe('analysisPromptText：清洗模型返回', () => {
  it('trim 首尾空白', () => {
    expect(analysisPromptText('  \n 商品描述 \n ')).toBe('商品描述')
  })

  it('去掉包裹的代码块围栏（含语言标记 / 只写一半）', () => {
    expect(analysisPromptText('```\n商品描述\n```')).toBe('商品描述')
    expect(analysisPromptText('```markdown\n商品描述\n```')).toBe('商品描述')
    expect(analysisPromptText('```json\n商品描述')).toBe('商品描述')
    expect(analysisPromptText('商品描述\n```')).toBe('商品描述')
    expect(analysisPromptText('```')).toBe('')
  })

  it('围栏只在行首/行尾才算，正文里的反引号保留', () => {
    expect(analysisPromptText('描述里提到 ``` 这种符号')).toBe('描述里提到 ``` 这种符号')
  })

  it('折叠 3 个以上连续空行为 1 个空行', () => {
    expect(analysisPromptText('第一段\n\n\n\n第二段')).toBe('第一段\n\n第二段')
    expect(analysisPromptText('第一段\n\n第二段')).toBe('第一段\n\n第二段')
    // 只有空格的行在用户看来也是空行
    expect(analysisPromptText('A\n \n \n \nB')).toBe('A\n\nB')
    expect(analysisPromptText('A\r\n\r\n\r\n\r\nB')).toBe('A\n\nB')
    expect(analysisPromptText('A   \nB\t')).toBe('A\nB')
  })

  it('超长按 4000 截断', () => {
    const long = '字'.repeat(ANALYSIS_MAX_TEXT_LENGTH + 500)
    expect(analysisPromptText(long)).toHaveLength(ANALYSIS_MAX_TEXT_LENGTH)
    expect(analysisPromptText('A'.repeat(10))).toHaveLength(10)
  })

  it('空 / 纯空白 / 非字符串 → 空串', () => {
    expect(analysisPromptText('')).toBe('')
    expect(analysisPromptText('   \n\t ')).toBe('')
    expect(analysisPromptText(null as never)).toBe('')
    expect(analysisPromptText(undefined as never)).toBe('')
    expect(analysisPromptText(123 as never)).toBe('')
  })
})

describe('describeAnalysisError：中文可执行提示（分层：主进程已本地化的中文原样透传）', () => {
  it('主进程已给中文文案 → 原样显示，不再加前缀/不再二次映射（复验 F2：三层套娃）', () => {
    const mainText = '连不上 AI 接口：请到设置中心核对接口地址与网络（原始错误：fetch failed）'
    expect(describeAnalysisError({ code: 'AI_REQUEST_FAILED', message: mainText })).toBe(mainText)
    expect(describeAnalysisError({ code: 'AI_IMAGE_TEXT_NOT_CONFIGURED', message: '既没有单独的"生图文本 API"，也没有可用的文本 API；请在「设置中心 → AI 配置」里配置其中一套' }))
      .toBe('既没有单独的"生图文本 API"，也没有可用的文本 API；请在「设置中心 → AI 配置」里配置其中一套')
    expect(describeAnalysisError({ code: 'AI_EMPTY_SOURCE', message: '请先上传商品图，或填写商品名称/卖点，再请求 AI 分析' }))
      .toBe('请先上传商品图，或填写商品名称/卖点，再请求 AI 分析')
    expect(describeAnalysisError({ code: 'AI_REQUEST_FAILED', message: 'AI_REQUEST_FAILED: 连接被拒绝' })).toBe('连接被拒绝')
  })

  it('只给码 / 英文裸串时才走本地映射与兜底', () => {
    const expected = '生图文本 API 未配置，请到设置中心 → AI 配置页填写'
    expect(describeAnalysisError({ code: 'AI_NOT_CONFIGURED', message: 'x' })).toBe(expected)
    expect(describeAnalysisError({ code: 'AI_NOT_CONFIGURED' })).toBe(expected)
    expect(describeAnalysisError('AI_NOT_CONFIGURED')).toBe(expected)
    expect(describeAnalysisError({ message: 'AI not configured' })).toBe(expected)
    expect(describeAnalysisError({ code: 'AI_EMPTY_SOURCE', message: 'x' })).toBe('请先上传商品图或填写商品名称/卖点')
    expect(describeAnalysisError(new Error('network down'))).toBe('AI 商品分析失败：network down')
    expect(describeAnalysisError('boom')).toBe('AI 商品分析失败：boom')
  })

  it('拿不到信息时给通用兜底，不抛异常', () => {
    for (const error of [null, undefined, {}, { code: '' }, { message: '   ' }, 42, []]) {
      const text = describeAnalysisError(error)
      expect(typeof text).toBe('string')
      expect(text.length).toBeGreaterThan(0)
      expect(text).toMatch(/AI 商品分析失败|未配置|请先上传商品图/)
    }
  })
})

describe('模块边界与常量', () => {
  it('是纯模块：不依赖 vue / electron / DOM / node', () => {
    expect(SOURCE).not.toMatch(/from\s+['"]vue['"]/)
    expect(SOURCE).not.toMatch(/from\s+['"]electron['"]/)
    expect(SOURCE).not.toMatch(/from\s+['"]node:/)
    expect(SOURCE).not.toMatch(/require\(/)
    expect(SOURCE).not.toMatch(/\bdocument\./)
    expect(SOURCE).not.toMatch(/\bwindow\./)
  })

  it('常量与主进程 ai-handlers 的口径一致', () => {
    expect(ANALYSIS_MAX_IMAGES).toBe(3)
    expect(ANALYSIS_MAX_IMAGE_BYTES).toBe(8 * 1024 * 1024)
    expect(ANALYSIS_MAX_TEXT_LENGTH).toBe(4000)
  })
})
