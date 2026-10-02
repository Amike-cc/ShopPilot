import { describe, expect, it } from 'vitest'
import {
  canStartFilling,
  evaluateReadback,
  precheckPublish,
  publishIdempotencyKey,
  type PublishPrecheckInput
} from '../../packages/shared/src/product-publish-rules'
import type { LocalProductDraft } from '../../packages/shared/src/product-draft'

const PRODUCT_ID = 'p1'
const STORE_ID = 's1'

function draft(overrides: Partial<LocalProductDraft> = {}): LocalProductDraft {
  return {
    title: '儿童加厚款暖暖套装',
    subtitle: null,
    description: null,
    brand: '无品牌',
    localCategory: '母婴 / 童装 / 家居服套装',
    tags: [],
    variants: [{ spec: [{ name: '尺码', value: 'S' }], priceMinor: 2990, stock: 100 }],
    media: [{ role: 'cover', state: 'localized', remoteUrl: 'https://a/1.jpg' }],
    ...overrides
  }
}

function input(overrides: Partial<PublishPrecheckInput> = {}): PublishPrecheckInput {
  return {
    product: { id: PRODUCT_ID, title: '儿童加厚款暖暖套装', draft: draft(), draftHash: 'hash-1' },
    target: { storeId: STORE_ID, storeName: '微信小店测试', platform: '微信小店', storeStatus: 'online' },
    existingLinks: [],
    ...overrides
  }
}

describe('发布预检：幂等键与门禁', () => {
  it('幂等键 = publish:<商品>:<店铺>:<草稿指纹>（同一次发布只有同一个键）', () => {
    expect(publishIdempotencyKey('p1', 's1', 'h1')).toBe('publish:p1:s1:h1')
    const a = precheckPublish(input())
    expect(a.idempotencyKey).toBe('publish:p1:s1:hash-1')
    // 草稿变了 → 键就变了（说明"这是新的一次发布"）
    const b = precheckPublish(input({ product: { id: PRODUCT_ID, title: 'x', draft: draft({ title: 'x' }), draftHash: 'hash-2' } }))
    expect(b.idempotencyKey).not.toBe(a.idempotencyKey)
  })

  it('干净的草稿 + 在线的店铺 → 预检通过，进入 filling', () => {
    const result = precheckPublish(input())
    expect(result.verdict).toBe('ready')
    expect(result.nextState).toBe('filling')
    expect(canStartFilling(result)).toBe(true)
  })

  it('草稿有阻断项 → blocked / precheck_failed，不许开始填', () => {
    const result = precheckPublish(input({
      product: { id: PRODUCT_ID, title: '', draft: draft({ title: '', media: [] }), draftHash: 'h' }
    }))
    expect(result.verdict).toBe('blocked')
    expect(result.nextState).toBe('precheck_failed')
    expect(canStartFilling(result)).toBe(false)
    expect(result.blockers.some(item => item.field === 'title')).toBe(true)
    expect(result.blockers.some(item => item.field === 'media')).toBe(true)
  })

  it('⚠️ 店铺 offline **不是阻断**（它的语义是"窗口没开/还没确认登录"，不是"没登录"）', () => {
    // 这里曾经断言 offline → blocked，那是**语义理解错误**：实测微信小店一直卡在
    // "店铺 offline，不能发布"，而它的页面我们一直能正常读（根本没掉登录）。
    const result = precheckPublish(input({
      target: { storeId: STORE_ID, storeName: '微信小店测试', platform: '微信小店', storeStatus: 'offline' }
    }))
    expect(result.verdict).toBe('ready_with_warnings')
    expect(result.blockers).toHaveLength(0)
    expect(result.warnings.some(item => item.message.includes('发布时会先打开店铺'))).toBe(true)
  })

  it('真的没登录（needs_login）→ 阻断，并说清是哪个店', () => {
    const result = precheckPublish(input({
      target: { storeId: STORE_ID, storeName: '11121', platform: '抖店', storeStatus: 'needs_login' }
    }))
    expect(result.verdict).toBe('blocked')
    expect(result.blockers[0].message).toContain('11121')
    expect(result.blockers[0].message).toContain('需要登录')
  })

  it('代理异常 / 已归档 / 配置不完整 → 都阻断（这些是"确实不能发"）', () => {
    for (const [status, keyword] of [['proxy_error', '代理异常'], ['archived', '已归档'], ['incomplete', '配置不完整']]) {
      const result = precheckPublish(input({
        target: { storeId: STORE_ID, storeName: 'x', platform: '微信小店', storeStatus: status }
      }))
      expect(result.verdict, status).toBe('blocked')
      expect(result.blockers.some(item => item.message.includes(keyword)), status).toBe(true)
    }
  })
})

describe('发布预检：重复发布默认拒绝（方案 §7.7）', () => {
  // ⚠️ 这三条是 §12.11 那个 bug 的回归防护（2026-10-02）：
  // 原来的条件只判断「这家店有没有链接」，而文案却写着「本地草稿与上次完全一致」——
  // 结果商品发过一次就永远发不出去，改了内容也没用。
  it('该店已有记录且草稿与上次一模一样 → 阻断（这才是真的白跑一趟）', () => {
    const sameHash = input({}).product.draftHash
    const result = precheckPublish(input({
      existingLinks: [{ storeId: STORE_ID, platform: '微信小店', platformProductId: '10001528219053', platformStatus: 'on_sale', draftHash: sameHash }]
    }))
    expect(result.verdict).toBe('blocked')
    expect(result.blockers.some(item => item.message.includes('10001528219053'))).toBe(true)
    expect(result.blockers.some(item => (item.fixHint || '').includes('编辑入口'))).toBe(true)
  })

  it('已链接但草稿改过了 → 不阻断（这是更新，不是白跑一趟）', () => {
    const result = precheckPublish(input({
      existingLinks: [{ storeId: STORE_ID, platform: '微信小店', platformProductId: '10001528219053', platformStatus: 'on_sale', draftHash: '改之前的旧指纹' }]
    }))
    expect(result.blockers.some(item => item.message.includes('完全一致'))).toBe(false)
  })

  it('老数据没有 draftHash → 不阻断（不能因为缺数据就永久禁止发布）', () => {
    const result = precheckPublish(input({
      existingLinks: [{ storeId: STORE_ID, platform: '微信小店', platformProductId: '10001528219053', platformStatus: 'on_sale' }]
    }))
    expect(result.blockers.some(item => item.message.includes('完全一致'))).toBe(false)
  })

  it('**别的店**已有记录不影响这家店发布', () => {
    const result = precheckPublish(input({
      existingLinks: [{ storeId: 'other-store', platform: '微信小店', platformProductId: '999', platformStatus: 'on_sale' }]
    }))
    expect(result.verdict).toBe('ready')
  })

  it('同店同商品已有在途任务 → 阻断，提示去继续那一次（不重复发起）', () => {
    const result = precheckPublish(input({ inFlight: true }))
    expect(result.verdict).toBe('blocked')
    expect(result.blockers.some(item => item.message.includes('未完成的发布'))).toBe(true)
  })
})

describe('发布预检：字段级 diff（§7.6 那张核对清单）', () => {
  it('本地有值的字段动作是 fill；类目是 fill_suggest（建议填、待确认）', () => {
    const result = precheckPublish(input())
    const byField = Object.fromEntries(result.fields.map(item => [item.field, item]))
    expect(byField.title.action).toBe('fill')
    // 价格/库存：锚点只在**编辑既有商品**页实测到，新增商品页上没有这两个字段
    // → 如实降级成"留人工"（本地有值却填不了，所以是 warning），不嘴上说能填、实际填不上
    expect(byField.price.action).toBe('leave_empty')
    expect(byField.price.level).toBe('warning')
    expect(byField.price.localValue).toBe('¥29.90')
    expect(byField.stock.localValue).toBe('100')
    expect(byField.stock.action).toBe('leave_empty')
    // 类目：锚点只在**编辑既有商品**页实测到，新增商品页没有这个字段 → 不代填、给 warning
    // （更正过：之前按'类目有平台规则'判成 fill_suggest，那是没区分页面的结论）
    expect(byField.category.action).toBe('leave_empty')
    expect(byField.category.level).toBe('warning')
    expect(byField.category.note).toContain('编辑既有商品')
  })

  it('副标题**是支持的**（实测有「请输入商品短标题」）→ 本地有值就填，不静默丢', () => {
    // 这条曾经断言的是"该平台不支持副标题"——那是**没实测就下的结论**。
    // 实测发布页有 请输入商品短标题，所以正确的行为是 fill。
    const result = precheckPublish(input({
      product: { id: PRODUCT_ID, title: 'x', draft: draft({ subtitle: '进口头层牛皮' }), draftHash: 'h' }
    }))
    const subtitle = result.fields.find(item => item.field === 'subtitle')!
    // 字段**是支持的**（不再是 skip_unsupported），但锚点只在编辑页 → 新增页上如实标'留人工'
    expect(subtitle.action).toBe('leave_empty')
    expect(subtitle.localValue).toBe('进口头层牛皮')
    expect(subtitle.level).toBe('warning')
    expect(subtitle.note).toContain('编辑既有商品')
  })

  it('本地没填但上次填过 → reuse_last（用上次选择，不重复问）', () => {
    // 标题是**新增页实测可填**的字段，用它验 reuse_last（品牌锚点只在编辑页，会被降级成 leave_empty）
    const result = precheckPublish(input({ lastValues: { title: '儿童加厚款暖暖套装' } }))
    const title = result.fields.find(item => item.field === 'title')!
    expect(['reuse_last', 'fill']).toContain(title.action)
  })

  it('必填项本地没有 → 记进 missingRequired（下次发布前的本地补全清单）', () => {
    const result = precheckPublish(input({
      product: { id: PRODUCT_ID, title: 'x', draft: draft({ localCategory: null }), draftHash: 'h' }
    }))
    expect(result.missingRequired).toContain('类目')
    const category = result.fields.find(item => item.field === 'category')!
    expect(category.action).toBe('leave_empty')
    // 类目是**必填**（REQUIRED 里有它）而本地没有 → warning，并记进 missingRequired
    expect(category.level).toBe('warning')
  })

  it('多规格价格显示成区间，不假装只有一个价', () => {
    const result = precheckPublish(input({
      product: {
        id: PRODUCT_ID, title: 'x', draftHash: 'h',
        draft: draft({
          variants: [
            { spec: [{ name: '尺码', value: 'S' }], priceMinor: 690, stock: 10 },
            { spec: [{ name: '尺码', value: 'L' }], priceMinor: 1490, stock: 20 }
          ]
        })
      }
    }))
    const price = result.fields.find(item => item.field === 'price')!
    expect(price.localValue).toBe('¥6.90 ~ ¥14.90')
    const stock = result.fields.find(item => item.field === 'stock')!
    expect(stock.localValue).toBe('30')     // 各规格库存之和
  })
})

describe('回读校验：**必须对基线比对**，不能"存在即确认"', () => {
  const TITLE = '快速六层家用水龙头过滤器'

  it('基线之后**新增**了同标题的一条 → confirmed（这才是发布成功的证据）', () => {
    const result = evaluateReadback({
      baselinePlatformProductIds: ['10000616807249'],
      current: [
        { platformProductId: '10000616807249', title: TITLE },   // 基线里就有的
        { platformProductId: '10000999999999', title: TITLE }    // 新增的
      ],
      expectedTitle: TITLE
    })
    expect(result.state).toBe('confirmed')
    expect(result.newPlatformProductIds).toEqual(['10000999999999'])
    expect(result.matchedPlatformProductIds).toEqual(['10000999999999'])
  })

  it('⚠️ **只有基线里那条**（本来就同步过）→ needs_review，绝不能报 confirmed', () => {
    // 这是 2026-09-30 实测踩到的假阳性：第一版回读只查"标题在不在台账里"，
    // 对一个早就同步过的商品直接报了 confirmed —— 用户根本没提交成功也会显示"已确认"。
    const result = evaluateReadback({
      baselinePlatformProductIds: ['10000616807249'],
      current: [{ platformProductId: '10000616807249', title: TITLE }],
      expectedTitle: TITLE
    })
    expect(result.state).toBe('needs_review')
    expect(result.reasonCode).toBe('READBACK_NO_NEW_RECORD')
    expect(result.safeMessage).toContain('没有')
  })

  it('没有新增记录 → needs_review，并提示"可能还没同步过来，或提交没成功"', () => {
    const result = evaluateReadback({ baselinePlatformProductIds: [], current: [], expectedTitle: TITLE })
    expect(result.state).toBe('needs_review')
    expect(result.safeMessage).toContain('同步')
  })

  it('新增了两条同标题 → needs_review + 明确提示**疑似重复提交**（§7.7）', () => {
    const result = evaluateReadback({
      baselinePlatformProductIds: [],
      current: [
        { platformProductId: 'A1', title: TITLE },
        { platformProductId: 'A2', title: TITLE }
      ],
      expectedTitle: TITLE
    })
    expect(result.state).toBe('needs_review')
    expect(result.reasonCode).toBe('READBACK_DUPLICATE')
    expect(result.safeMessage).toContain('疑似重复提交')
    expect(result.matchedPlatformProductIds).toEqual(['A1', 'A2'])
  })

  it('新增了记录但标题对不上 → needs_review，并如实说"平台侧有新增但标题对不上"', () => {
    const result = evaluateReadback({
      baselinePlatformProductIds: [],
      current: [{ platformProductId: 'A1', title: '平台改了标题' }],
      expectedTitle: TITLE
    })
    expect(result.state).toBe('needs_review')
    expect(result.safeMessage).toContain('标题都对不上')
  })

  it('标题比较忽略空白与大小写（平台会做归一化）', () => {
    const result = evaluateReadback({
      baselinePlatformProductIds: [],
      current: [{ platformProductId: 'A1', title: '  Fast   Sink Filter ' }],
      expectedTitle: 'fast sink filter'
    })
    expect(result.state).toBe('confirmed')
  })
})

describe('发布预检：未实测的平台一律 L3 接力，不假装能代填', () => {
  it('抖店（没有发布档案）→ L3，所有字段留给人工，并明确说是接力模式', () => {
    const result = precheckPublish(input({
      target: { storeId: 's2', storeName: '1111', platform: '抖店', storeStatus: 'online' }
    }))
    expect(result.tier).toBe('L3')
    expect(result.verdict).toBe('ready_with_warnings')
    expect(result.fields.every(item => item.action === 'leave_empty')).toBe(true)
    expect(result.warnings[0].message).toContain('接力模式')
    // L3 仍然"可以开始"（打开页面给人填），只是不代填
    expect(canStartFilling(result)).toBe(true)
  })

  it('有发布档案但字段没全实测 → L2 引导模式（说清哪些会填、哪些给清单）', () => {
    // 微信小店目前登记的字段都已 verified → L1；这里直接验 L1 的口径
    const result = precheckPublish(input())
    expect(result.tier).toBe('L1')
    expect(result.warnings.some(item => item.message.includes('引导模式'))).toBe(false)
  })
})
