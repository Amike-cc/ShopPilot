import { describe, expect, it } from 'vitest'
import {
  PRODUCT_PROFILES,
  PRODUCT_PUBLISH_PROFILES,
  hasProductProfile,
  hasPublishProfile,
  productProfileFor,
  publishTierFor
} from '../../packages/shared/src/constants/product'
import {
  isEmptyRow,
  mapProductRows,
  normalizeCellText,
  parseDateTimeMs,
  parsePriceMinor,
  parseSpecText,
  parseStatus,
  parseStatusTimeCell,
  parseStock,
  parseTitleCell,
  productDraftHash,
  productStatusLabel,
  sortSkusByPrice
} from '../../packages/shared/src/product-rules'

/**
 * 夹具全部来自 2026-09-30 的真机勘察原文（docs/product-profiles.md §1）。
 * 平台文本被截断的地方保留 `…`，断言只针对没被截断的部分 —— 不为了让测试好看而编数据。
 */
const 微信小店行 = [
  '',
  '儿童加厚款暖暖套装秋冬季珊瑚绒保暖宽松休闲套装睡衣外穿家居服 ID: 10001…',
  '￥29.90',
  '60000 待付款库存 0',
  '销量 0 曝光 0 总销量 0 评价 0 信…',
  '销售中 上架时间: 2026-09-17 1…',
  '编辑 免审编辑 内容管理 更多'
]

const 拼多多行 = [
  '',
  '带扣子长袖儿童浴袍洗澡吸水速干不掉毛可穿式浴巾冬款卡通家居服 ID: 837429019978 商品编码: 暂无编码',
  '19.99～29.99 修改价格 设置全站营销可享大促或首页流量',
  '8000 修改库存',
  '0'
]

describe('商品纯规则：标题与商品 ID（实测两种形态）', () => {
  it('微信小店：标题与 ID 同格，ID 后面被截断也要能取到', () => {
    const parsed = parseTitleCell(微信小店行[1])
    expect(parsed.title).toBe('儿童加厚款暖暖套装秋冬季珊瑚绒保暖宽松休闲套装睡衣外穿家居服')
    expect(parsed.platformProductId).toBe('10001')
  })

  it('拼多多：ID 后面还跟着「商品编码」也不能影响取值', () => {
    const parsed = parseTitleCell(拼多多行[1])
    expect(parsed.title).toBe('带扣子长袖儿童浴袍洗澡吸水速干不掉毛可穿式浴巾冬款卡通家居服')
    expect(parsed.platformProductId).toBe('837429019978')
  })

  it('取不到 ID 时保留整串当标题，不编造 ID', () => {
    expect(parseTitleCell('只有标题没有编号')).toEqual({ title: '只有标题没有编号', platformProductId: null })
    expect(parseTitleCell('')).toEqual({ title: '', platformProductId: null })
  })
})

describe('商品纯规则：价格（实测三种形态）', () => {
  it('￥ 前缀 → 分为单位', () => {
    expect(parsePriceMinor(微信小店行[2])).toBe(2990)
  })

  it('区间价取**第一个**（列表展示价），不是取最小', () => {
    expect(parsePriceMinor('19.99～29.99 修改价格')).toBe(1999)
  })

  it('展示价 + 活动价：取展示价 16.9，而不是更低的活动价 15.88', () => {
    // 口径必须与"运营在列表页看到的价格"一致，否则本地/平台价格对比会失去意义
    expect(parsePriceMinor('16.9 活动价：15.88 设置全站营销可享大促或首页流量')).toBe(1690)
  })

  it('浮点尾差被吃掉（16.9 * 100 不该是 1689.9999）', () => {
    expect(parsePriceMinor('16.9')).toBe(1690)
    expect(Number.isInteger(parsePriceMinor('16.9') as number)).toBe(true)
  })

  it('读不到价格返回 null（**不是 0**）', () => {
    expect(parsePriceMinor('')).toBeNull()
    expect(parsePriceMinor('暂无价格')).toBeNull()
  })
})

describe('商品纯规则：库存（实测带修饰文案）', () => {
  it('微信小店：取第一个整数，并如实提示还有「待付款库存」这个第二口径', () => {
    const parsed = parseStock(微信小店行[3])
    expect(parsed.stock).toBe(60000)
    expect(parsed.extraNote).toContain('待付款库存')
  })

  it('拼多多：`8000 修改库存` / `3 修改库存 低库存` 都能取到前导数字', () => {
    expect(parseStock('8000 修改库存').stock).toBe(8000)
    expect(parseStock('3 修改库存 低库存').stock).toBe(3)
    expect(parseStock('10968 修改库存').stock).toBe(10968)
  })

  it('读不到库存返回 null —— 绝不写 0（0 会让运营以为真没货去补货）', () => {
    expect(parseStock('充足').stock).toBeNull()
    expect(parseStock('').stock).toBeNull()
    expect(parseStock('充足').extraNote).toBeNull()
  })
})

describe('商品纯规则：状态只映射实测过的文案', () => {
  it('实测过的四种在售文案：销售中 / 在售中 / 在售 / 售卖中', () => {
    expect(parseStatus('销售中 上架时间: 2026-09-17 10:30')).toBe('on_sale')   // 微信小店
    expect(parseStatus('在售中(19)')).toBe('on_sale')                        // 拼多多状态页签
    expect(parseStatus('在售')).toBe('on_sale')                              // 快手商家后台
    expect(parseStatus('2026/05/12 01:21:16 售卖中')).toBe('on_sale')         // 抖店
    expect(parseStatus('已下架(57)')).toBe('off_shelf')                      // 拼多多状态页签
  })

  it('没实测过的（审核中）故意不映射 → unknown', () => {
    // 把"审核中"当"在售"是事故：运营会以为已经能卖了
    expect(parseStatus('审核中')).toBe('unknown')
    expect(parseStatus('')).toBe('unknown')
  })

  it('状态/时间格能同时取出状态与时间文本', () => {
    const parsed = parseStatusTimeCell(微信小店行[5])
    expect(parsed.status).toBe('on_sale')
    expect(parsed.timeText).toBe('2026-09-17')
  })

  it('状态文案有单一来源的中文标签', () => {
    expect(productStatusLabel('on_sale')).toBe('在售')
    expect(productStatusLabel('unknown')).toBe('状态未取到')
  })
})

describe('商品纯规则：空壳行与时间解析', () => {
  it('抖店实测：<tbody> 前两行是 0 高度占位行，必须识别为空行', () => {
    expect(isEmptyRow(['', '', '', '', '', '', '', ''])).toBe(true)
    expect(isEmptyRow(['', '带扣子长袖儿童浴袍…', '19.99', '', '', '', '', ''])).toBe(false)
    expect(isEmptyRow([])).toBe(true)
  })

  it('时间：完整串转毫秒；只有日期按当天 00:00；格式不认识返回 null（不猜年份）', () => {
    expect(parseDateTimeMs('2026-09-17 10:30:00')).toBe(new Date(2026, 8, 17, 10, 30, 0).getTime())
    expect(parseDateTimeMs('2026-09-17')).toBe(new Date(2026, 8, 17, 0, 0, 0).getTime())
    // 抖店实测用**斜杠**：`2026/05/12 01:21:16`
    expect(parseDateTimeMs('2026/05/12 01:21:16')).toBe(new Date(2026, 4, 12, 1, 21, 16).getTime())
    expect(parseDateTimeMs('09-17')).toBeNull()
    expect(parseDateTimeMs('')).toBeNull()
  })

  it('规格文本：能拆 name:value 就拆，拆不了整串当一个值（列表页本来就不含 SKU，不臆造）', () => {
    expect(parseSpecText('颜色:红;尺码:L')).toEqual([{ name: '颜色', value: '红' }, { name: '尺码', value: 'L' }])
    expect(parseSpecText('红色')).toEqual([{ name: '', value: '红色' }])
    expect(parseSpecText('')).toEqual([])
  })

  it('单元格清洗会去掉零宽字符与多余空白', () => {
    expect(normalizeCellText('  儿童\u200b浴袍\u200b  ')).toBe('儿童浴袍')
  })
})

describe('商品纯规则：草稿指纹（发布幂等键的组成部分）', () => {
  it('同内容必然同指纹，且与键顺序无关', () => {
    const a = productDraftHash({ title: 'A', price: 1299, stock: 20 })
    const b = productDraftHash({ stock: 20, price: 1299, title: 'A' })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  it('任一字段变了指纹必须变（否则"改过了也不让重发"会被误判）', () => {
    const base = { title: 'A', price: 1299, stock: 20 }
    expect(productDraftHash(base)).not.toBe(productDraftHash({ ...base, price: 1300 }))
    expect(productDraftHash(base)).not.toBe(productDraftHash({ ...base, stock: 21 }))
  })

  it('undefined 不参与指纹（表单里"没填"和"填了空串"要能区分，但未定义键不该改变结果）', () => {
    expect(productDraftHash({ title: 'A', subtitle: undefined })).toBe(productDraftHash({ title: 'A' }))
    expect(productDraftHash({ title: 'A', subtitle: '' })).not.toBe(productDraftHash({ title: 'A' }))
  })
})

describe('商品平台档案：只登记真机实测过的平台', () => {
  it('微信小店已登记，且地址/条数为实测值', () => {
    const profile = productProfileFor('微信小店')
    expect(profile).not.toBeNull()
    expect(profile!.listUrl).toBe('https://store.weixin.qq.com/shop/goods/list')
    expect(profile!.measuredAt).toBe('2026-09-30')
    // 实测：共4条（与库里该店 4 个商品一致）
    expect(profile!.measuredRowCount).toBe(4)
    expect(profile!.deep).toBe(true)                 // 实测整页在 micro-app 的 shadow 里
    // 实测修正：表头行也有空表头那一列（7 个 th ↔ 7 格），所以不偏移
    expect(profile!.leadingCheckboxColumn).toBe(false)
  })

  it('四家平台都已真机实测登记；没实测过的平台**一个都不能有**档案', () => {
    for (const platform of ['微信小店', '抖店', '拼多多', '快手小店']) {
      expect(hasProductProfile(platform), platform).toBe(true)
      expect(productProfileFor(platform)!.measuredAt, platform).toBe('2026-09-30')
    }
    // 界面据此如实显示"该平台尚未实测到商品列表"，而不是拿猜的选择器去试
    for (const platform of ['淘宝', '视频号小店', '不存在的平台', '']) {
      expect(hasProductProfile(platform), platform).toBe(false)
      expect(productProfileFor(platform)).toBeNull()
    }
  })

  it('列对齐是实测结论：表头列数与数据行格数的差，决定了要不要偏移一列', () => {
    // 微信实测（修正后）：表头 7 个 <th>（首个空表头 = 勾选框）、数据行 7 格 → 一一对齐
    expect(productProfileFor('微信小店')!.leadingCheckboxColumn).toBe(false)
    // 抖店实测：表头 8 列（首列是空表头）、数据行 8 格 → 不偏移
    expect(productProfileFor('抖店')!.leadingCheckboxColumn).toBe(false)
    // 快手实测：表头 10 列（首列空、末列空）、数据行 9 格 → 不偏移
    expect(productProfileFor('快手小店')!.leadingCheckboxColumn).toBe(false)
    // 拼多多实测：表头在另一张表里且首列空，数据表 10 格 → index 策略 + 偏移
    expect(productProfileFor('拼多多')!.columnStrategy).toBe('index')
    expect(productProfileFor('拼多多')!.leadingCheckboxColumn).toBe(true)
    // 抖店实测有 2 行 0 高度占位行 → 必须跳过空行
    expect(productProfileFor('抖店')!.skipEmptyRows).toBe(true)
  })

  it('勾选框偏移**只对 index 策略生效**：header 策略按表头文案定位列，不吃偏移', () => {
    // 回归（2026-09-30 真机踩到）：微信档案曾误设 leadingCheckboxColumn=true，
    // 若 header 策略也吃这个偏移，title 会取到价格列 → 4 个商品全被解析成"没有 ID"。
    const profile = productProfileFor('微信小店')!
    // 表头与数据行都是 7 格（首个空表头对应勾选框）
    const headers = ['', '商品', '价格', '库存', '近30天经营概览', '商品状态/时间', '操作']
    const row = ['', '儿童加厚款暖暖套装 ID: 10001', '￥29.90', '60000', '销量 0', '销售中 上架时间: 2026-09-17', '编辑']
    const parsed = mapProductRows({ ...profile, leadingCheckboxColumn: true }, headers, [row]).rows[0]
    // 即使档案误写成 true，header 策略也必须取到标题（而不是把价格当标题）
    expect(parsed.title).toBe('儿童加厚款暖暖套装')
    expect(parsed.platformProductId).toBe('10001')
    expect(parsed.priceMinor).toBe(2990)
  })

  it('已登记档案的字段是自洽的：https、列映射非空、列名不重复、有实测日期', () => {
    for (const [platform, profile] of Object.entries(PRODUCT_PROFILES)) {
      expect(profile.platform, platform).toBe(platform)
      expect(profile.listUrl.startsWith('https://'), platform).toBe(true)
      expect(profile.columns.length, platform).toBeGreaterThan(0)
      expect(profile.measuredAt, platform).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      const headers = profile.columns.map(column => column.headerText)
      expect(new Set(headers).size, platform).toBe(headers.length)
    }
  })
})

describe('发布档位：由实测字段推导，不允许手写', () => {
  it('微信小店三个已实测字段全部 verified → L1', () => {
    expect(publishTierFor('微信小店')).toBe('L1')
    expect(PRODUCT_PUBLISH_PROFILES['微信小店'].imageUploadReady).toBe(true)
  })

  it('没有发布档案的平台 → L3 接力模式（不猜着填）', () => {
    expect(hasPublishProfile('抖店')).toBe(false)
    expect(publishTierFor('抖店')).toBe('L3')
    expect(publishTierFor('一个不存在的平台')).toBe('L3')
  })

  it('部分 verified → L2（引导模式）', () => {
    // 用一份临时档案验证推导规则本身：3 个字段里只验了 1 个
    const partial = { platform: 'X', entryKind: 'url' as const, imageUploadReady: false,
      fields: [{ field: 'title' as const, verified: true }, { field: 'price' as const, verified: false }, { field: 'stock' as const, verified: false }] }
    const verifiedCount = partial.fields.filter(f => f.verified).length
    const tier = verifiedCount === partial.fields.length ? 'L1' : verifiedCount > 0 ? 'L2' : 'L3'
    expect(tier).toBe('L2')
  })
})

describe('SKU 排序', () => {
  it('按价格升序，价格未取到的排最后（不是排最前）', () => {
    const sorted = sortSkusByPrice([
      { platformSkuId: 'c', spec: [], priceMinor: null, stock: null, skuCode: null, imageUrl: null, state: 'active' },
      { platformSkuId: 'a', spec: [], priceMinor: 2990, stock: null, skuCode: null, imageUrl: null, state: 'active' },
      { platformSkuId: 'b', spec: [], priceMinor: 990, stock: null, skuCode: null, imageUrl: null, state: 'active' }
    ])
    expect(sorted.map(s => s.platformSkuId)).toEqual(['b', 'a', 'c'])
  })
})

describe('整表映射：表头 → 数据行 → 统一商品（用实测表头与实测行）', () => {
  // ⚠️ 实测修正（2026-09-30）：微信的表头行是 **7 个 `<th>`**，首个是空表头（对应勾选框那一列），
  // 与数据行 7 格一一对齐。最初探针把空表头过滤掉了，夹具因此少了一列 —— 这里按实测改正。
  const 微信表头 = ['', '商品', '价格', '库存', '近30天经营概览', '商品状态/时间', '操作']
  const profile = productProfileFor('微信小店')!

  it('实测行能被完整映射：标题/ID、价格、库存、状态、上架时间', () => {
    const result = mapProductRows(profile, 微信表头, [微信小店行])
    expect(result.headerMismatch).toBe(false)
    expect(result.missingHeaders).toEqual([])
    expect(result.rows).toHaveLength(1)
    const row = result.rows[0]
    expect(row.title).toContain('儿童加厚款暖暖套装')
    expect(row.platformProductId).toBe('10001')
    expect(row.priceMinor).toBe(2990)
    expect(row.stock).toBe(60000)
    expect(row.status).toBe('on_sale')
    expect(row.platformUpdatedAt).toBe(new Date(2026, 8, 17).getTime())
    // 「待付款库存」不是总库存，必须如实提示出来（不能吞掉）
    expect(row.notes.join(' ')).toContain('待付款库存')
    // 原始行保留，便于事后比对
    expect(row.rawRow[1]).toContain('儿童加厚款')
  })

  it('表头整体对不上 → 报 headerMismatch（上层必须 PAGE_CHANGED 且不写数据），绝不硬套', () => {
    const result = mapProductRows(profile, ['宝贝', '售价', '数量'], [微信小店行])
    expect(result.headerMismatch).toBe(true)
    expect(result.missingHeaders).toContain('商品')
    expect(result.missingHeaders).toContain('价格')
  })

  it('只有部分表头缺失时不当作改版，但缺的字段保持 null（不猜）', () => {
    const result = mapProductRows(profile, ['', '商品', '价格', '库存'], [微信小店行])
    expect(result.headerMismatch).toBe(false)
    expect(result.missingHeaders).toEqual(expect.arrayContaining(['商品状态/时间']))
    expect(result.rows[0].status).toBe('unknown')   // 状态列缺失 → unknown，不是 on_sale
    expect(result.rows[0].priceMinor).toBe(2990)    // 价格列还在，照常解析
  })

  it('空表头与数据行的勾选框格一一对应（表头 7 列 ↔ 数据行 7 格，不偏移）', () => {
    const result = mapProductRows(profile, 微信表头, [微信小店行])
    expect(result.rows[0].title).toContain('儿童加厚款暖暖套装')
    expect(result.rows[0].priceMinor).toBe(2990)
    expect(result.rows[0].stock).toBe(60000)
    // 若把空表头那一列也算成偏移，价格会取到库存列 —— 这条断言就是防它的
    expect(result.rows[0].priceMinor).not.toBe(result.rows[0].stock)
  })

  it('空壳行被跳过（抖店实测 <tbody> 前两行是 0 高度占位行）', () => {
    const result = mapProductRows(profile, 微信表头, [['', '', '', '', '', '', ''], 微信小店行])
    expect(result.rows).toHaveLength(1)
  })

  it('没有平台商品 ID 的行会明说"本条不会被落库"，而不是悄悄丢掉', () => {
    const row = [...微信小店行]
    row[1] = '没有编号的标题'
    const result = mapProductRows(profile, 微信表头, [row])
    expect(result.rows[0].platformProductId).toBeNull()
    expect(result.rows[0].notes.join(' ')).toContain('不会被落库')
  })

  it('index 策略：没有 <th> 的表也能按档案列序映射（拼多多第二张表实测形态）', () => {
    const indexProfile = {
      ...profile,
      columnStrategy: 'index' as const,
      leadingCheckboxColumn: true,
      columns: [
        { headerText: '商品信息', key: 'title' as const },
        { headerText: '价格(元)', key: 'price' as const },
        { headerText: '总库存', key: 'stock' as const },
        { headerText: '收藏', key: 'sales' as const },
        { headerText: '累计销量', key: 'ignore' as const },
        { headerText: '30日销量', key: 'ignore' as const },
        { headerText: '商品体检', key: 'quality' as const },
        { headerText: '创建时间', key: 'time' as const },
        { headerText: '操作', key: 'action' as const }
      ]
    }
    const result = mapProductRows(indexProfile, [], [拼多多行])
    expect(result.headerMismatch).toBe(false)
    expect(result.rows[0].platformProductId).toBe('837429019978')
    expect(result.rows[0].priceMinor).toBe(1999)
    expect(result.rows[0].stock).toBe(8000)
  })
})

describe('整表映射：另外三家平台也用**实测表头与实测行**验一遍', () => {
  it('抖店：空表头占一列（不偏移）、全角 ID 冒号、斜杠时间、状态「售卖中」', () => {
    const profile = productProfileFor('抖店')!
    const headers = ['', '商品信息', '价格', '总库存', '总销量', '质量分', '上架时间降序', '操作']
    const row = [
      '',
      '密封胶泥9.8发十包升级款家用白色堵洞口/空调孔/下水道/防虫填充 ID：3819266189016826169 现货模式 预览 复制链接',
      '￥9.80 ~ ￥15.80',
      '19999877',
      '112 100%好评 AI智能成片快速测款 一键生成',
      '优秀 88',
      '2026/05/12 01:21:16 售卖中',
      '编辑 下架 新建渠道品 发布相似品'
    ]
    const result = mapProductRows(profile, headers, [row])
    expect(result.headerMismatch).toBe(false)
    expect(result.missingHeaders).toEqual([])
    const parsed = result.rows[0]
    expect(parsed.platformProductId).toBe('3819266189016826169')
    expect(parsed.title).toBe('密封胶泥9.8发十包升级款家用白色堵洞口/空调孔/下水道/防虫填充')
    expect(parsed.priceMinor).toBe(980)          // 区间价取展示价 9.80
    expect(parsed.stock).toBe(19999877)
    expect(parsed.status).toBe('on_sale')
    expect(parsed.platformUpdatedAt).toBe(new Date(2026, 4, 12, 1, 21, 16).getTime())
  })

  it('拼多多：表头在另一张表里、数据表 10 格（偏移 1）', () => {
    const profile = productProfileFor('拼多多')!
    const row = [
      '',
      '带扣子长袖儿童浴袍洗澡吸水速干不掉毛可穿式浴巾冬款卡通家居服 ID: 837429019978 商品编码: 暂无编码',
      '19.99～29.99 修改价格 设置全站营销可享大促或首页流量',
      '8000 修改库存',
      '0',
      '0 暂无评价',
      '0 设置优惠券 营销促活 以￥19.19~28.79报名国庆大促',
      '健康商品',
      '2025-10-15 20:41 销售中',
      '编辑 下架 商品数据 预览二维码/链接 发布相似品'
    ]
    const result = mapProductRows(profile, [], [row])
    expect(result.headerMismatch).toBe(false)
    const parsed = result.rows[0]
    expect(parsed.platformProductId).toBe('837429019978')
    expect(parsed.priceMinor).toBe(1999)
    expect(parsed.stock).toBe(8000)
    expect(parsed.status).toBe('on_sale')
    expect(parsed.platformUpdatedAt).toBe(new Date(2025, 9, 15, 20, 41, 0).getTime())
  })

  it('快手商家后台：创建时间与商品状态是**两列**（与其他三家"同格"不同）', () => {
    const profile = productProfileFor('快手小店')!
    const headers = ['', '商品信息', '诊断结果', '单价', '总库存', '销量', '创建时间', '商品状态', '操作', '']
    const row = [
      '',
      '预览 新年乔迁高档金箔纸杯加厚红色一次性喜庆水杯喜迁新居搬家喜杯子 ID: 25812911614326 现货48h 定向分销计划',
      '影响商城订单转化 缺少商品视频等3个问题需优化 主子链接使用建议 如需为达人设置专属链接，建议使用主子链接功能',
      '￥9.9',
      '39999',
      '1 提升销量',
      '2025-12-23 22:41:14',
      '在售',
      '编辑 免审编辑 下架 创建渠道品 发布相似品'
    ]
    const result = mapProductRows(profile, headers, [row])
    expect(result.headerMismatch).toBe(false)
    expect(result.missingHeaders).toEqual([])
    const parsed = result.rows[0]
    expect(parsed.platformProductId).toBe('25812911614326')
    expect(parsed.priceMinor).toBe(990)
    expect(parsed.stock).toBe(39999)
    expect(parsed.status).toBe('on_sale')
    // 时间取自独立的「创建时间」列（不是状态列）
    expect(parsed.platformUpdatedAt).toBe(new Date(2025, 11, 23, 22, 41, 14).getTime())
  })

  it('快手单价区间形态 `￥6.8 至 ￥24.99` 取展示价', () => {
    const profile = productProfileFor('快手小店')!
    const headers = ['', '商品信息', '诊断结果', '单价', '总库存', '销量', '创建时间', '商品状态', '操作', '']
    const row = ['', '装饰植绒小灯笼挂饰 ID: 25722117941326', '暂无待优化问题', '￥6.8 至 ￥24.99', '13924', '8560 提升销量', '2025-12-08 00:04:51', '在售', '编辑 下架']
    const parsed = mapProductRows(profile, headers, [row]).rows[0]
    expect(parsed.priceMinor).toBe(680)
    expect(parsed.stock).toBe(13924)
  })
})
