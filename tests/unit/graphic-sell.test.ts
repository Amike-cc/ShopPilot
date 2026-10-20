import { describe, expect, it } from 'vitest'
import {
  GRAPHIC_SELL_DEFAULTS,
  GRAPHIC_SELL_EFFECT_OPTIONS,
  GRAPHIC_SELL_IMAGE_COUNT_OPTIONS,
  GRAPHIC_SELL_MODEL_OPTIONS,
  GRAPHIC_SELL_PLATFORM_OPTIONS,
  GRAPHIC_SELL_RATIO_OPTIONS,
  GRAPHIC_SELL_STYLE_OPTIONS,
  MAX_GRAPHIC_SELL_MATERIALS,
  SELL_HISTORY_MAX_SESSIONS,
  buildGraphicSellImagePrompt,
  buildGraphicSellInput,
  describeGraphicSellError,
  getGraphicSellEffect,
  graphicSellEffectDefaults,
  graphicSellFullText,
  graphicSellImageBatchSize,
  graphicSellImageBatches,
  graphicSellRequestSize,
  normalizeSellModel,
  parseGraphicSellHistory,
  parseGraphicSellPresetPrefs,
  parseGraphicSellTags,
  readGeneratedImageUrl,
  readGraphicSellResult,
  resolveGraphicSellReadiness,
  sellModelLabel,
  sellModelPrompt,
  serializeGraphicSellHistory,
  serializeGraphicSellPresetPrefs,
  trimGraphicSellHistory,
  type GraphicSellHistorySession
} from '../../apps/desktop/src/renderer/src/features/workbench/graphic-sell'
import { SELL_COPY_LIMITS } from '@shared/contracts/ai-sell-copy'

/**
 * 图文带货工作台的回归网（2026-10-19 新增功能）。
 *
 * 这批全是纯函数：组参 / 可用性判据 / 模型返回清洗 / 生图提示词 / 历史预算。
 * 页面只负责发请求与渲染，真正的判据都在这里钉死；主进程同源常量取自 shared 契约。
 */

function png(payload = 'QUJD', mime = 'png'): string {
  return `data:image/${mime};base64,${payload}`
}

function material(name = 'a.png', dataUrl = png()) {
  return { name, size: dataUrl.length, dataUrl }
}

const BASE_FORM = {
  productName: '便携折叠露营椅',
  sellingPoints: '轻量铝合金支架，3 秒收纳',
  price: '¥129',
  originalPrice: '¥199',
  audience: '露营新手',
  platform: '小红书',
  style: '种草分享',
  imageCount: 4,
  images: [material()]
}

describe('buildGraphicSellInput：表单 → 主进程入参', () => {
  it('商品名称必填：空/纯空白直接给出可执行提示，不发请求', () => {
    for (const productName of ['', '   ', undefined, null]) {
      const result = buildGraphicSellInput({ ...BASE_FORM, productName: productName as never })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toContain('商品名称')
    }
  })

  it('合法表单带上平台/风格/张数与图片，选填空串不传', () => {
    const result = buildGraphicSellInput({ ...BASE_FORM, audience: '  ' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input).toMatchObject({
      productName: '便携折叠露营椅',
      sellingPoints: '轻量铝合金支架，3 秒收纳',
      price: '¥129',
      originalPrice: '¥199',
      platform: '小红书',
      style: '种草分享',
      imageCount: 4
    })
    expect(result.input.audience).toBeUndefined()
    expect(result.input.images).toHaveLength(1)
    expect(result.input.images?.[0]).toEqual({ mimeType: 'image/png', b64Json: 'QUJD' })
  })

  it('未知平台/风格回落到默认值，配图张数夹到 1–9', () => {
    const result = buildGraphicSellInput({ ...BASE_FORM, platform: '某平台', style: '未知风格', imageCount: 99 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input.platform).toBe('通用')
    expect(result.input.style).toBe('种草分享')
    expect(result.input.imageCount).toBe(9)
    const low = buildGraphicSellInput({ ...BASE_FORM, imageCount: -3 })
    if (low.ok) expect(low.input.imageCount).toBe(1)
  })

  it('超长文本按 shared 上限截断，不把超长请求发给主进程', () => {
    const result = buildGraphicSellInput({
      ...BASE_FORM,
      productName: '名'.repeat(SELL_COPY_LIMITS.productName + 30),
      sellingPoints: '卖'.repeat(SELL_COPY_LIMITS.sellingPoints + 30),
      price: '9'.repeat(SELL_COPY_LIMITS.price + 10),
      audience: '人'.repeat(SELL_COPY_LIMITS.audience + 10)
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input.productName).toHaveLength(SELL_COPY_LIMITS.productName)
    expect(result.input.sellingPoints).toHaveLength(SELL_COPY_LIMITS.sellingPoints)
    expect(result.input.price).toHaveLength(SELL_COPY_LIMITS.price)
    expect(result.input.audience).toHaveLength(SELL_COPY_LIMITS.audience)
  })

  it('图片最多 3 张，非 png/jpeg/webp 或非法 data URL 被丢弃', () => {
    const many = Array.from({ length: MAX_GRAPHIC_SELL_MATERIALS + 2 }, (_item, index) => material(`img-${index}.png`, png(`QUJD${index}`)))
    const result = buildGraphicSellInput({ ...BASE_FORM, images: many })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input.images).toHaveLength(MAX_GRAPHIC_SELL_MATERIALS)

    const mixed = buildGraphicSellInput({ ...BASE_FORM, images: [material('a.png', 'data:image/gif;base64,QUJD'), material('b.png')] })
    expect(mixed.ok).toBe(true)
    if (mixed.ok) expect(mixed.input.images).toHaveLength(1)
  })

  it('上传了但一张都不合法：明确报错，不静默当没传', () => {
    const result = buildGraphicSellInput({ ...BASE_FORM, images: [material('bad.png', 'not-a-data-url'), material('bad.jpg', 'data:image/gif;base64,QUJD')] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('PNG')
  })

  it('不上传商品图也能纯文字生成', () => {
    const result = buildGraphicSellInput({ ...BASE_FORM, images: [] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.input.images).toEqual([])
  })
})

describe('resolveGraphicSellReadiness：文案与生图到底能不能用', () => {
  const base = { endpoint: 'https://api.example.com', resolvedEndpoint: 'https://api.example.com/v1/chat/completions', model: 'text-model', hasKey: true }
  const imageText = { imageTextEndpoint: 'https://text.example.com', resolvedImageTextEndpoint: 'https://text.example.com/v1/chat/completions', imageTextModel: 'vision-model', hasImageTextKey: true }
  const image = { imageEndpoint: 'https://img.example.com', resolvedImageEndpoint: 'https://img.example.com/v1/images/generations', imageModel: 'gpt-image-2', hasImageKey: true }

  it('优先用生图文本 API；它没配好才回退主文本 API', () => {
    expect(resolveGraphicSellReadiness({ ...base, ...imageText, ...image }).copyChannel).toBe('image-text')
    expect(resolveGraphicSellReadiness({ ...base, ...image }).copyChannel).toBe('main-text')
    expect(resolveGraphicSellReadiness({ ...image }).copyChannel).toBe('none')
    expect(resolveGraphicSellReadiness(null).copyReady).toBe(false)
  })

  it('缺 Key / 缺地址 / 缺模型任何一项都不算配置好', () => {
    expect(resolveGraphicSellReadiness({ ...base, ...imageText, hasImageTextKey: false, ...image }).copyChannel).toBe('main-text')
    expect(resolveGraphicSellReadiness({ ...base, ...image, hasKey: false }).copyReady).toBe(false)
    expect(resolveGraphicSellReadiness({ ...base, ...image, resolvedEndpoint: '' }).copyReady).toBe(false)
    expect(resolveGraphicSellReadiness({ ...base, ...image, model: '' }).copyReady).toBe(false)
  })

  it('生图可用性与文案可用性分开判断', () => {
    const ready = resolveGraphicSellReadiness({ ...base, ...imageText })
    expect(ready.copyReady).toBe(true)
    expect(ready.imageReady).toBe(false)
    expect(resolveGraphicSellReadiness({ ...base, ...imageText, ...image }).imageReady).toBe(true)
  })
})

describe('readGraphicSellResult：主进程返回体的渲染层收口', () => {
  it('收下标题/正文/标签/封面/逐图描述，并补默认值', () => {
    const result = readGraphicSellResult({
      title: '  露营椅界的六边形战士  ',
      body: '折叠只要 3 秒，收进后备箱不占地。',
      tags: ['#露营', ' #收纳', '露营', ''],
      coverText: '3 秒收纳',
      imagePrompts: ['山野露营场景', '后备箱收纳特写'],
      model: 'vision-model',
      elapsedMs: 1234.4,
      source: 'main-text',
      imageCount: 2
    })
    expect(result).toEqual({
      title: '露营椅界的六边形战士',
      body: '折叠只要 3 秒，收进后备箱不占地。',
      tags: ['露营', '收纳'],
      coverText: '3 秒收纳',
      imagePrompts: ['山野露营场景', '后备箱收纳特写'],
      model: 'vision-model',
      elapsedMs: 1234,
      source: 'main-text',
      imageCount: 2
    })
  })

  it('标题和正文都空 → null（界面显示“返回内容不完整”，不渲染空笔记）', () => {
    expect(readGraphicSellResult(null)).toBeNull()
    expect(readGraphicSellResult('text')).toBeNull()
    expect(readGraphicSellResult({ title: '   ', body: '' })).toBeNull()
  })

  it('source 只有 main-text 才标回退，其余按生图文本 API', () => {
    expect(readGraphicSellResult({ title: 't', source: 'unknown' })?.source).toBe('image-text')
    expect(readGraphicSellResult({ title: 't' })?.source).toBe('image-text')
    expect(readGraphicSellResult({ title: 't', source: 'main-text' })?.source).toBe('main-text')
  })

  it('逐图描述最多收 9 条，超长单条被截断', () => {
    const prompts = Array.from({ length: 12 }, (_item, index) => `场景${index}描述`.repeat(40))
    const result = readGraphicSellResult({ title: 't', imagePrompts: prompts })
    expect(result?.imagePrompts).toHaveLength(9)
    expect(result?.imagePrompts.every(item => item.length <= SELL_COPY_LIMITS.imagePrompt)).toBe(true)
  })
})

describe('describeGraphicSellError：说人话且不套娃', () => {
  it('主进程已经本地化的中文原样透传', () => {
    const message = '生图文本请求超过 120000ms 未返回（当前文本模型较慢）'
    expect(describeGraphicSellError({ code: 'AI_TIMEOUT', message })).toBe(message)
  })

  it('未配置 → 指明设置中心路径；空来源 → 指明补商品名或图', () => {
    expect(describeGraphicSellError({ code: 'AI_IMAGE_TEXT_NOT_CONFIGURED', message: 'AI_IMAGE_TEXT_NOT_CONFIGURED' })).toContain('设置中心')
    expect(describeGraphicSellError({ code: 'AI_EMPTY_SOURCE', message: 'AI_EMPTY_SOURCE' })).toContain('商品名称')
  })

  it('英文裸串兜底带上“文案生成失败”，空错误也能给一句话', () => {
    expect(describeGraphicSellError({ code: 'AI_REQUEST_FAILED', message: 'fetch failed' })).toContain('fetch failed')
    expect(describeGraphicSellError('fetch failed')).toContain('文案生成失败')
    expect(describeGraphicSellError(undefined)).toContain('重试')
  })
})

describe('buildGraphicSellImagePrompt：逐图提示词', () => {
  const input = {
    productName: '折叠露营椅',
    sellingPoints: '轻量铝合金',
    platform: '小红书',
    style: '种草分享',
    imageCount: 3
  }
  const result = {
    title: '标题',
    body: '正文',
    tags: ['露营'],
    coverText: '3 秒收纳',
    imagePrompts: ['山野露营场景', '后备箱收纳特写', '椅面材质细节'],
    model: 'm',
    elapsedMs: 0,
    source: 'image-text' as const,
    imageCount: 3
  }

  it('带序号、平台风格、商品与比例；留白与禁文字要求每张都有', () => {
    const prompt = buildGraphicSellImagePrompt(input, result, 1, '3:4 竖版（笔记常用）')
    expect(prompt).toContain('第 2/3 张')
    expect(prompt).toContain('折叠露营椅')
    expect(prompt).toContain('小红书 / 种草分享')
    expect(prompt).toContain('后备箱收纳特写')
    expect(prompt).toContain('不要生成任何文字')
    expect(prompt).toContain('3:4')
  })

  it('只有首图带封面大字排版要求，避免每张都留大字空间', () => {
    expect(buildGraphicSellImagePrompt(input, result, 0)).toContain('3 秒收纳')
    expect(buildGraphicSellImagePrompt(input, result, 1)).not.toContain('为标题大字')
  })

  it('模型没给某张的画面描述时用商品兜底，不发出空提示词', () => {
    const prompt = buildGraphicSellImagePrompt(input, { ...result, imagePrompts: [] }, 2)
    expect(prompt).toContain('折叠露营椅')
    expect(prompt.trim().length).toBeGreaterThan(20)
  })
})

describe('效果模板：躺床俯拍（用户提供的参考效果）', () => {
  const input = {
    productName: '儿童加厚珊瑚绒家居服',
    sellingPoints: '加厚双面绒，柔软亲肤',
    platform: '小红书',
    style: '种草分享',
    imageCount: 4
  }
  const result = {
    title: '标题',
    body: '正文',
    tags: ['家居服'],
    coverText: '3 秒穿好',
    imagePrompts: ['山野露营场景', '后备箱收纳特写', '椅面材质细节', '折叠结构示意'],
    model: 'm',
    elapsedMs: 0,
    source: 'image-text' as const,
    imageCount: 0
  }
  const bedLying = { effect: 'bed-lying' as const, model: 'child' as const }

  it('模板清单与默认值自洽：躺床俯拍 = 9:16 + 儿童模特 + 需要商品图', () => {
    const effect = getGraphicSellEffect('bed-lying')
    expect(effect.label).toBe('躺床俯拍')
    expect(effect.recommendedRatio).toBe('9:16')
    expect(effect.recommendedModel).toBe('child')
    expect(effect.requiresProductImage).toBe(true)
    expect(graphicSellEffectDefaults('bed-lying')).toEqual({ model: 'child', ratio: '9:16' })
    // 默认就是参考效果模板（用户上传商品图后直接出这种效果）
    expect(GRAPHIC_SELL_DEFAULTS.effect).toBe('bed-lying')
    expect(GRAPHIC_SELL_DEFAULTS.ratio).toBe('9:16')
    expect(GRAPHIC_SELL_DEFAULTS.model).toBe('child')
  })

  it('平铺净景强制无人；AI 自由设计不要求商品图', () => {
    expect(getGraphicSellEffect('flatlay').forcedModel).toBe('none')
    expect(graphicSellEffectDefaults('flatlay').model).toBe('none')
    expect(getGraphicSellEffect('auto').requiresProductImage).toBe(false)
    expect(GRAPHIC_SELL_EFFECT_OPTIONS.map(item => item.key)).toEqual(['bed-lying', 'flatlay', 'auto'])
  })

  it('躺床俯拍提示词：90° 俯拍 + 闭眼安睡 + 单一主体 + 商品一致性与禁止编造，不再混入文案场景', () => {
    const first = buildGraphicSellImagePrompt(input, result, 0, '9:16 手机竖屏（参考效果同款）', bedLying)
    expect(first).toContain('效果模板：躺床俯拍')
    expect(first).toContain('正上方 90° 垂直俯拍')
    expect(first).toContain('只有一位儿童模特')
    expect(first).toContain('全身俯拍主图')
    expect(first).toContain('眼睛轻闭')
    expect(first).toContain('不看镜头')
    expect(first).toContain('商品一致性')
    expect(first).toContain('参考图没有文字时')
    expect(first).toContain('儿童加厚珊瑚绒家居服')
    expect(first).toContain('9:16')
    // 模板模式下不再使用文案模型给的画面描述（否则每张图风格会被带跑）
    expect(first).not.toContain('山野露营场景')

    const second = buildGraphicSellImagePrompt(input, result, 1, '9:16', bedLying)
    expect(second).toContain('上半身俯拍')
    expect(second).not.toContain('全身俯拍主图')

    const third = buildGraphicSellImagePrompt(input, result, 2, '9:16', bedLying)
    // 实测旧版第 3 张被画成人像特写；现在明确要求面料/工艺特写
    expect(third).toContain('面料与工艺特写')
    expect(third).toContain('严禁人脸大特写')

    const fourth = buildGraphicSellImagePrompt(input, result, 3, '9:16', bedLying)
    expect(fourth).toContain('毛绒玩偶或一只白色小猫')
    // 实测旧版第 4 张凭空多出第二个孩子与另一套商品；每张都带单主体/禁止编造约束
    for (const prompt of [first, second, third, fourth]) {
      expect(prompt).toContain('只出现一位人物与一套商品')
      expect(prompt).toContain('不要出现任何字母')
      expect(prompt).toContain('不要摆拍式微笑')
    }
  })

  it('无人出镜时改用平铺构图，不写"模特"', () => {
    const prompt = buildGraphicSellImagePrompt(input, result, 0, '3:4', { effect: 'bed-lying', model: 'none' })
    expect(prompt).toContain('不出现真人模特')
    expect(prompt).toContain('俯拍平铺')
    expect(prompt).not.toContain('儿童模特（约 4–6 岁')
  })

  it('模特描述与归一：未知值回落自动，强制无人的模板不受传入模特影响', () => {
    expect(normalizeSellModel('儿童')).toBe('auto')
    expect(normalizeSellModel('adult-female')).toBe('adult-female')
    expect(sellModelLabel('child')).toBe('儿童模特')
    expect(sellModelPrompt('child')).toContain('4–6 岁')
    expect(sellModelPrompt('none')).toContain('不出现真人模特')
    expect(sellModelPrompt('auto')).toContain('由模型按商品类型决定')
    expect(GRAPHIC_SELL_MODEL_OPTIONS.map(item => item.key)).toEqual(['child', 'adult-female', 'auto', 'none'])
  })
})

describe('效果预设记忆（localStorage）', () => {
  it('往返保留模板/模特/比例/张数', () => {
    const raw = serializeGraphicSellPresetPrefs({ effect: 'flatlay', model: 'child', ratio: '1:1', imageCount: 6 })
    const parsed = parseGraphicSellPresetPrefs(raw)
    // 平铺净景强制无人：即便存的是 child，读出来也必须是没有模特
    expect(parsed).toEqual({ effect: 'flatlay', model: 'none', ratio: '1:1', imageCount: 6 })
  })

  it('损坏 / 空 / 未知值一律回落参考效果模板，不让坏数据卡住页面', () => {
    const fallback = { effect: 'bed-lying', model: 'child', ratio: '9:16', imageCount: 4 }
    expect(parseGraphicSellPresetPrefs(null)).toEqual(fallback)
    expect(parseGraphicSellPresetPrefs('{not json')).toEqual(fallback)
    expect(parseGraphicSellPresetPrefs(JSON.stringify({ effect: '不存在', model: '不存在', ratio: '不存在', imageCount: 99 })))
      .toEqual({ effect: 'bed-lying', model: 'child', ratio: '9:16', imageCount: 9 })
  })
})

describe('文案编辑与复制', () => {
  it('parseGraphicSellTags：支持空格/逗号/顿号/#，去重、去空、最多 8 个', () => {
    expect(parseGraphicSellTags('#露营 收纳，好物、露营 #  ')).toEqual(['露营', '收纳', '好物'])
    expect(parseGraphicSellTags(Array.from({ length: 12 }, (_item, index) => `t${index}`).join(' '))).toHaveLength(SELL_COPY_LIMITS.tags)
    expect(parseGraphicSellTags(undefined as never)).toEqual([])
  })

  it('graphicSellFullText：标题 + 正文 + #话题；空段自动省略', () => {
    expect(graphicSellFullText('标题', '正文', ['露营', '收纳'])).toBe('标题\n\n正文\n\n#露营 #收纳')
    expect(graphicSellFullText('', '正文', [])).toBe('正文')
    expect(graphicSellFullText('标题', '', [])).toBe('标题')
    expect(graphicSellFullText('', '', [])).toBe('')
  })
})

describe('生图返回体收口', () => {
  it('b64Json + mimeType 转 data URL；外部 url 原样返回；脏值返回空串', () => {
    expect(readGeneratedImageUrl({ b64Json: 'QUJD', mimeType: 'image/jpeg' })).toBe('data:image/jpeg;base64,QUJD')
    expect(readGeneratedImageUrl({ b64Json: 'QUJD' })).toBe('data:image/png;base64,QUJD')
    expect(readGeneratedImageUrl({ url: 'https://cdn.example.com/a.png' })).toBe('https://cdn.example.com/a.png')
    expect(readGeneratedImageUrl(null)).toBe('')
    expect(readGeneratedImageUrl('x')).toBe('')
    expect(readGeneratedImageUrl({})).toBe('')
    // 两种都缺时宁可空串（页面会按"没有返回可预览图片"失败），也不拼出坏 URL
    expect(readGeneratedImageUrl({ b64Json: '', url: 42 })).toBe('')
  })
})

describe('配图张数、比例与请求拆分', () => {
  it('单次最多 4 张，5–9 张拆成多次真实请求（不少发）；效果模板一张一请求', () => {
    expect(graphicSellImageBatchSize('auto')).toBe(4)
    expect(graphicSellImageBatchSize('bed-lying')).toBe(1)
    expect(graphicSellImageBatchSize('flatlay')).toBe(1)
    expect(graphicSellImageBatchSize('未知')).toBe(1)
    expect(graphicSellImageBatches(3)).toEqual([3])
    expect(graphicSellImageBatches(4)).toEqual([4])
    expect(graphicSellImageBatches(5)).toEqual([4, 1])
    expect(graphicSellImageBatches(6)).toEqual([4, 2])
    expect(graphicSellImageBatches(9)).toEqual([4, 4, 1])
    expect(graphicSellImageBatches(0)).toEqual([1])
    expect(graphicSellImageBatches(Number.NaN)).toEqual([4])
    // 效果模板：每张图的构图不同，必须一张一请求
    expect(graphicSellImageBatches(4, 1)).toEqual([1, 1, 1, 1])
    expect(graphicSellImageBatches(6, graphicSellImageBatchSize('bed-lying'))).toEqual([1, 1, 1, 1, 1, 1])
  })

  it('比例映射到生图接口接受的三档尺寸（参考效果 9:16 用竖版尺寸）', () => {
    expect(graphicSellRequestSize('9:16')).toBe('1024x1536')
    expect(graphicSellRequestSize('3:4')).toBe('1024x1536')
    expect(graphicSellRequestSize('1:1')).toBe('1024x1024')
    expect(graphicSellRequestSize('4:3')).toBe('1536x1024')
    expect(graphicSellRequestSize('未知')).toBe('1024x1536')
  })

  it('默认值与选项自洽：张数有默认档、平台/风格/比例都有对应选项', () => {
    expect(GRAPHIC_SELL_IMAGE_COUNT_OPTIONS).toContain(GRAPHIC_SELL_DEFAULTS.imageCount)
    expect(GRAPHIC_SELL_PLATFORM_OPTIONS.map(item => item.key)).toContain(GRAPHIC_SELL_DEFAULTS.platform)
    expect(GRAPHIC_SELL_STYLE_OPTIONS.map(item => item.key)).toContain(GRAPHIC_SELL_DEFAULTS.style)
    expect(GRAPHIC_SELL_RATIO_OPTIONS.map(item => item.key)).toContain(GRAPHIC_SELL_DEFAULTS.ratio)
  })
})

describe('历史会话：落盘、预算裁剪与恢复', () => {
  function session(overrides: Partial<GraphicSellHistorySession> = {}): GraphicSellHistorySession {
    return {
      id: 'sell-1',
      createdAt: 1,
      productName: '露营椅',
      platform: '小红书',
      style: '种草分享',
      ratio: '3:4',
      title: '标题',
      body: '正文',
      tags: ['露营'],
      coverText: '封面',
      imagePrompts: ['场景'],
      images: [{ url: png('QUJD'), index: 0 }],
      model: 'm',
      ...overrides
    }
  }

  it('serialize → parse 往返保留文案与配图', () => {
    const raw = serializeGraphicSellHistory([session()])
    expect(JSON.parse(raw).version).toBe(1)
    const parsed = parseGraphicSellHistory(raw)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].title).toBe('标题')
    expect(parsed[0].images[0].url).toBe(png('QUJD'))
  })

  it('会话记录保留效果模板与模特；旧记录回落到参考效果模板', () => {
    const parsed = parseGraphicSellHistory(serializeGraphicSellHistory([session({ effect: 'flatlay', sellModel: 'none' })]))
    expect(parsed[0].effect).toBe('flatlay')
    expect(parsed[0].sellModel).toBe('none')
    const legacy = parseGraphicSellHistory(JSON.stringify({ version: 1, sessions: [{ id: 'old', createdAt: 1, title: 't', body: 'b' }] }))
    expect(legacy[0].effect).toBe('bed-lying')
    expect(legacy[0].sellModel).toBe('child')
  })

  it('旧格式（裸数组）也能读；损坏 JSON 安全回落为空', () => {
    expect(parseGraphicSellHistory(JSON.stringify([session()]))).toHaveLength(1)
    expect(parseGraphicSellHistory('{not json')).toEqual([])
    expect(parseGraphicSellHistory('')).toEqual([])
    expect(parseGraphicSellHistory(null)).toEqual([])
  })

  it('标题和正文都空的坏条目被丢弃，不阻塞整页', () => {
    const raw = JSON.stringify({ version: 1, sessions: [session(), { title: '', body: '', id: 'bad' }, null] })
    expect(parseGraphicSellHistory(raw)).toHaveLength(1)
  })

  it('超预算时保留文案、丢掉配图，而不是把整条历史扔了', () => {
    const big = session({ id: 'big', images: [{ url: 'x'.repeat(4 * 1024 * 1024), index: 0 }] })
    const small = session({ id: 'small', images: [] })
    const trimmed = trimGraphicSellHistory([big, small], 1024)
    expect(trimmed[0].id).toBe('big')
    expect(trimmed[0].images).toEqual([])
    expect(trimmed[0].title).toBe('标题')
  })

  it('会话条数有上限，序列化时按上限裁剪', () => {
    const many = Array.from({ length: SELL_HISTORY_MAX_SESSIONS + 5 }, (_item, index) => session({ id: `s${index}`, images: [] }))
    const trimmed = trimGraphicSellHistory(many)
    expect(trimmed).toHaveLength(SELL_HISTORY_MAX_SESSIONS)
    expect(parseGraphicSellHistory(serializeGraphicSellHistory(many))).toHaveLength(SELL_HISTORY_MAX_SESSIONS)
  })
})
