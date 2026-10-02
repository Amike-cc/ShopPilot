/**
 * 商品「平台档案」（商品管理方案 §5.2；实测记录 docs/product-profiles.md）
 *
 * 数据从哪来：本应用没有平台官方 API，**只能从各平台后台页面读取**。这份档案就是
 * "在哪一页、按哪条锚点、怎么翻页"的唯一事实来源。
 *
 * 红线（与 BUSINESS_PROFILES 完全一致）：**锚点必须实测，不猜**。
 * 只登记已在真实登录态店铺上跑通一轮的平台；未登记的平台，采集入口会明确说明
 * 「该平台尚未实测到商品列表，暂不能同步」。
 *
 * 与经营指标档案的关键差别（都来自 2026-09-30 的真机勘察）：
 *   · 商品是**列表**，所以除了锚点还要有"怎么翻页"和"怎么对齐列";
 *   · 抖店的 `<tbody>` 前两行是 **0 高度占位行**（实测），必须跳过；
 *   · 拼多多是**两张表**（第一张只有表头、第二张没有 `<th>`），列映射不能只靠表头；
 *   · 微信用的是 ShadowRoot（`micro-app`），要 `deep: true`。
 */

import type { ProductFieldKey } from '../contracts/platform-product'

/** 列在表格里的角色。值取自实测表头文案（见 docs/product-profiles.md §1）。 */
export type ProductColumnKey =
  | 'title'          // 商品信息（通常标题 + 商品 ID 同格）
  | 'subtitle'
  | 'price'          // 价格（可能是区间，如「19.99～29.99」）
  | 'stock'          // 总库存
  | 'sales'          // 销量类（总销量 / 30日销量 / 收藏）
  | 'status'         // 商品状态
  | 'status_time'    // 状态 + 上架/创建时间同格（微信小店实测形态）
  | 'quality'        // 质量分 / 商品体检
  | 'category'
  | 'time'           // 纯时间列
  | 'action'         // 操作列（永远不采集）
  | 'ignore'

export interface ProductColumnMapping {
  /** 实测的表头文案（严格匹配；表头是平台对外的稳定表达，改版时它会变 → 如实报 PAGE_CHANGED） */
  headerText: string
  key: ProductColumnKey
}

export interface ProductProfile {
  platform: string
  /** 商品列表页地址（实测） */
  listUrl: string
  /** navigate 之后的就绪判据（页面标题或正文里稳定出现的文案） */
  urlMarker: string
  /** 页面在 ShadowRoot 内时需要穿透（微信小店实测：整页在 micro-app 的 shadow 里） */
  deep?: boolean
  /**
   * 表格的取法：'header' = 用 `<th>` 文案定位列；
   * 'index' = 没有可用表头，按列序固定映射（拼多多第二张表实测无 `<th>`）。
   */
  columnStrategy: 'header' | 'index'
  columns: ProductColumnMapping[]
  /**
   * 数据行首列是不是 checkbox（无文本）。
   * 微信小店实测：表头 6 列、数据行 7 格（首格是勾选框）→ 不处理会整体错位一列。
   */
  leadingCheckboxColumn?: boolean
  /**
   * 跳过"空壳行"的条件：抖店实测 `<tbody>` 前 2 行是 0 高度占位行，
   * 单元格文本为空且 `td` 带 `height:0px` 内联样式。
   */
  skipEmptyRows?: boolean
  /** 分页方式（实测）：'none' 单页 / 'nextText' 点「下一页」 */
  pagination: 'none' | 'nextText'
  /** 翻页按钮文案（实测原文） */
  nextPageText?: string | null
  /** 列表页"共 N 条/件"的正则片段（用于与本地条数核对，M1 验收要用） */
  totalTextPattern?: string | null
  /**
   * 商品**详情页**地址模板（`{id}` 会被替换成平台商品 ID）。
   *
   * 为什么需要：列表页只有一张缩略图（微信实测是 **SVG**，本地化会如实拒绝），
   * 真正的商品图与 SKU 都在详情页。实测微信小店的详情页就是发布页同一个地址加 `productId`，
   * 所以**可以直接拼**，不必去点列表里的「编辑」（点它会让 CDP 会话失效，实测踩过）。
   */
  detailUrlTemplate?: string | null
  /** 一屏实测到的数据行数（用于判断"是不是只抓了第一屏"） */
  measuredRowCount: number
  /** 实测日期（YYYY-MM-DD）与当时看到的条数——日后改版时可对比 */
  measuredAt: string
  note?: string
}

/**
 * 已实测登记的商品档案。
 *
 * 四家平台都已在真实登录态店铺上跑通（实测日期 2026-09-30，证据见 docs/product-profiles.md）。
 * 每条档案里的 `columns` 都是从**实测表头原文**抄下来的，`leadingCheckboxColumn` 由
 * "表头列数 vs 数据行格数"决定 —— 这一条最容易错，错了会让整行错位（库存被当成价格写进库）。
 *
 * 列对齐的实测结论（表头 N 列 ↔ 数据行 M 格）：
 *   · 微信小店：表头 **7 列**（首列空表头 = 勾选框）、行 7 格 → 一一对齐，不偏移
 *   · 抖店    ：表头 8 列（首列空表头）、行 8 格 → 不偏移
 *   · 快手小店：表头 10 列（首列空、末列空）、行 9 格 → 不偏移（末列空表头没有对应格）
 *   · 拼多多  ：表头在**另一张表**里（10 列，首列空），数据表 10 格 → 用 index 策略 + 偏移 1
 * 注：`leadingCheckboxColumn` **只对 index 策略生效**；header 策略靠表头文案定位列，不吃这个偏移。
 */
export const PRODUCT_PROFILES: Record<string, ProductProfile> = {
  微信小店: {
    platform: '微信小店',
    listUrl: 'https://store.weixin.qq.com/shop/goods/list',
    urlMarker: '商品列表',
    // 实测：列表页与发布页都在 micro-app 的 ShadowRoot 内（body.innerText 只能拿到极少量文本）
    deep: true,
    columnStrategy: 'header',
    // 实测表头原文：商品 | 价格 | 库存 | 近30天经营概览 | 商品状态/时间 | 操作
    columns: [
      { headerText: '商品', key: 'title' },
      { headerText: '价格', key: 'price' },
      { headerText: '库存', key: 'stock' },
      { headerText: '近30天经营概览', key: 'sales' },
      { headerText: '商品状态/时间', key: 'status_time' },
      { headerText: '操作', key: 'action' }
    ],
    leadingCheckboxColumn: false,
    // 实测（2026-09-30）：详情页与发布页是同一个地址，带 productId 就是编辑既有商品
    detailUrlTemplate: 'https://store.weixin.qq.com/shop/goods/entry?productId={id}',
    // ⚠️ 2026-09-30 修正：微信的**表头行也有 7 个 `<th>`**（首个是空表头，对应勾选框），
    // 与数据行 7 格一一对齐 → 不需要偏移。最初探针把空表头 `.filter(Boolean)` 掉了，
    // 误判成"表头里没有勾选框列"并设成 true；header 策略已不再吃这个偏移（见 product-rules），
    // 这里也按实测改成 false，避免档案与事实不符。
    pagination: 'nextText',
    nextPageText: '下一页',
    totalTextPattern: '共\\s*(\\d+)\\s*条',
    measuredRowCount: 4,
    measuredAt: '2026-09-30',
    note:
      '实测前两行原文：`儿童加厚款暖暖套装… ID: 10001… | ￥29.90 | 60000 待付款库存 0 | 销量 0 曝光 0 … | 销售中 上架时间: 2026-09-17 …`。' +
      '商品 ID 与标题同格（`ID: …`），价格带 ￥ 前缀，库存格带「待付款库存」修饰，状态与上架时间同格。'
  },

  抖店: {
    platform: '抖店',
    listUrl: 'https://fxg.jinritemai.com/ffa/g/list',
    urlMarker: '商品管理',
    columnStrategy: 'header',
    // 实测表头原文（首列是空表头，对应勾选框那一列）
    columns: [
      { headerText: '商品信息', key: 'title' },
      { headerText: '价格', key: 'price' },
      { headerText: '总库存', key: 'stock' },
      { headerText: '总销量', key: 'sales' },
      { headerText: '质量分', key: 'quality' },
      { headerText: '上架时间降序', key: 'status_time' },
      { headerText: '操作', key: 'action' }
    ],
    // 实测：表头 8 列里首列就是空的（勾选框），数据行也是 8 格 → 不额外偏移
    leadingCheckboxColumn: false,
    // 实测：<tbody> 前 2 行是 0 高度占位行（td 内联 height:0px），真数据从第 3 行起
    skipEmptyRows: true,
    pagination: 'nextText',
    nextPageText: '下一页',
    totalTextPattern: '共\\s*(\\d+)\\s*条',
    measuredRowCount: 2,
    measuredAt: '2026-09-30',
    note:
      '实测行原文：`密封胶泥9.8发十包… ID：3819266189016826169 现货模式 预览 复制链接 | ￥9.80 ~ ￥15.80 | 19999877 | ' +
      '112 100%好评… | 优秀 88 | 2026/05/12 01:21:16 售卖中 | 编辑 下架 …`。' +
      '注意两点实测差异：ID 用**全角冒号**、时间用**斜杠** `2026/05/12`、状态文案是**售卖中**。'
  },

  快手小店: {
    platform: '快手小店',
    // ⚠️ 不是 syt 生意通的那个「商品列表」（那是 43 列经营数据页），而是**商家后台**的商品列表
    listUrl: 'https://s.kwaixiaodian.com/zone/goods/v1/list',
    urlMarker: '商品列表',
    columnStrategy: 'header',
    // 实测表头原文（首列空 = 勾选框；末列也是空表头，没有对应的数据格）
    columns: [
      { headerText: '商品信息', key: 'title' },
      { headerText: '诊断结果', key: 'quality' },
      { headerText: '单价', key: 'price' },
      { headerText: '总库存', key: 'stock' },
      { headerText: '销量', key: 'sales' },
      { headerText: '创建时间', key: 'time' },
      { headerText: '商品状态', key: 'status' },
      { headerText: '操作', key: 'action' }
    ],
    leadingCheckboxColumn: false,
    skipEmptyRows: true,
    pagination: 'nextText',
    nextPageText: '下一页',
    totalTextPattern: '共\\s*(\\d+)\\s*条',
    measuredRowCount: 5,
    measuredAt: '2026-09-30',
    note:
      '实测行原文：`预览 新年乔迁高档金箔纸杯… ID: 25812911614326 现货48h 定向分销计划 | 影响商城订单转化 缺少商品视频… | ' +
      '￥9.9 | 39999 | 1 提升销量 | 2025-12-23 22:41:14 | 在售 | 编辑 免审编辑 下架 …`。' +
      '**创建时间与商品状态是两列**（与其他三家"同格"不同）；单价有区间形态 `￥6.8 至 ￥24.99`。' +
      '入口是商家后台的 SPA 按钮「商品列表」（在 /zone/home 上），本档案记的是点击后到达的真实地址。'
  },

  拼多多: {
    platform: '拼多多',
    listUrl: 'https://mms.pinduoduo.com/goods/goods_list',
    urlMarker: '商品列表',
    // 实测：表头在**另一张表**里（第一张表只有表头、0 数据行；第二张表 10 行数据但没有 <th>）→ 只能按列序映射
    columnStrategy: 'index',
    columns: [
      { headerText: '商品信息 批量修改标题', key: 'title' },
      { headerText: '价格(元) 批量修改', key: 'price' },
      { headerText: '总库存 批量修改', key: 'stock' },
      { headerText: '收藏', key: 'ignore' },
      { headerText: '累计销量', key: 'sales' },
      { headerText: '30日销量', key: 'ignore' },
      { headerText: '商品体检', key: 'quality' },
      { headerText: '创建时间', key: 'status_time' },
      { headerText: '操作', key: 'action' }
    ],
    // 实测：数据表每行 10 格，首格是勾选框，而上面的 9 条列映射不含它 → 需要偏移 1
    leadingCheckboxColumn: true,
    skipEmptyRows: true,
    pagination: 'nextText',
    nextPageText: '下一页',
    // 实测：页面上**没有**「共 N 条」文案（总数只在状态页签里：在售中(19) / 已下架(57)）→ 如实留空
    totalTextPattern: null,
    measuredRowCount: 10,
    measuredAt: '2026-09-30',
    note:
      '实测行原文：`带扣子长袖儿童浴袍… ID: 837429019978 商品编码: 暂无编码 | 19.99～29.99 修改价格… | 8000 修改库存 | 0 | ' +
      '0 暂无评价 | 0 设置优惠券… | 健康商品 | 2025-10-15 20:41 销售中 | 编辑 下架 …`。' +
      '价格有区间（`19.99～29.99`）与活动价（`16.9 活动价：15.88`）两种形态；' +
      '**总数没有统一文案**，界面上要如实说明"拼多多的总数只在状态页签里"。'
  }
}

export function productProfileFor(platform: string): ProductProfile | null {
  return PRODUCT_PROFILES[platform] ?? null
}

/**
 * 拼出某平台商品的详情页地址；该平台没登记模板（或 ID 不合法）时返回 null。
 *
 * 只用**实测登记**的模板拼，不猜 URL 结构 —— 没登记的平台上，详情页采集会如实说"未实测"。
 */
export function detailUrlFor(platform: string, platformProductId: string): string | null {
  const template = PRODUCT_PROFILES[platform]?.detailUrlTemplate
  const id = String(platformProductId ?? '').trim()
  if (!template || !id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null
  return template.replace('{id}', id)
}

/** 该平台是否已登记商品档案（= 可以同步）。界面用它决定显示"同步"还是"尚未实测"。 */
export function hasProductProfile(platform: string): boolean {
  return !!PRODUCT_PROFILES[platform]
}

/**
 * 发布页档案（半自动发布用）。**目前一个平台都还没登记**——
 * 因为 §17-12/13/14（提交后成功判据、重复提交拦截、发布后状态）必须真实发布一个商品才能实测，
 * 而那需要用户明确授权。按红线：没有实测就不登记，不让"半自动"变成"猜着填"。
 */
export interface ProductPublishFieldAnchor {
  field: ProductFieldKey
  /** 实测的字段锚点（文案）；未实测的字段不进这里 */
  anchorText?: string
  /** 该字段是否已真机验证过（档位推导的唯一依据） */
  verified: boolean
  /**
   * 该字段在**哪个页面**上实测到的：新增商品页、编辑既有商品页，还是两页都有。
   *
   * 为什么必须标：两页**共用一个 URL**（`/shop/goods/entry`，编辑页多带 `productId`），
   * 但渲染出来的字段不一样（实测新增页只有标题）。把"编辑页测到的锚点"当成"新增页也能填"，
   * 就会得到"页面上还没有这个字段" —— 那不是失败，是**锚点的适用范围被说过头了**。
   * 没标时按"未限定"处理（不额外限制），保持向后兼容。
   */
  pageScope?: 'new' | 'edit' | 'new+edit'
  note?: string
}

export interface ProductPublishProfile {
  platform: string
  /** 发布入口：'url' 直接导航；'click' 是页内按钮/弹层（抖店实测：点了弹层，URL 不变） */
  entryKind: 'url' | 'click'
  publishUrl?: string
  entryText?: string
  /** 实测到的类目控件形态（决定"建议 + 人工确认"怎么落） */
  categoryControl?: 'select' | 'search' | 'separatePage' | 'unknown'
  /** 图片上传入口是否可控（实测：微信 3 个、拼多多 1 个 `input[type=file]`） */
  imageUploadReady: boolean
  fields: ProductPublishFieldAnchor[]
  measuredAt?: string
}

export const PRODUCT_PUBLISH_PROFILES: Record<string, ProductPublishProfile> = {
  微信小店: {
    platform: '微信小店',
    entryKind: 'url',
    // 实测：子菜单「新增商品」带 href /shop/goods/entry
    publishUrl: 'https://store.weixin.qq.com/shop/goods/entry',
    categoryControl: 'search',
    // 实测 3 个 input[type=file]（accept 图片格式，multiple），入口可控
    imageUploadReady: true,
    // 只登记**已实测到锚点**的字段，并且**标明锚点是在哪个页面上测到的**。
    //
    // ⚠️ 这个区分很重要（2026-09-30 实测）：`新增商品` 页与 `编辑既有商品` 页**共用一个 URL**
    // （`/shop/goods/entry`，后者带 `productId`），但**渲染出来的字段不一样**：
    //   · 新增商品页：只有 标题（实测可填）；
    //   · 编辑既有商品页：标题、短标题、品牌、类目、价格、库存都在。
    // 把"编辑页测到的锚点"当成"新增页也能填"，就会得到"页面上还没有这个字段"——
    // 那不是失败，是**锚点的适用范围被说过头了**。所以每条都标 `pageScope`。
    fields: [
      { field: 'title', anchorText: '请输入商品名称与关键字', verified: true, pageScope: 'new+edit', note: '实测 placeholder；两页都有；label 显示 0/60 → 标题上限 60 字。**实测代填成功（写入=回读）**' },
      // ⚠️ 2026-09-30 更正：**短标题是支持的**。之前写着"该平台不支持副标题"，那是没实测就下的结论。
      // 实测编辑页有 `请输入商品短标题`；但**新增商品页实测没有这个字段**。
      { field: 'subtitle', anchorText: '请输入商品短标题', verified: true, pageScope: 'edit', note: '实测 placeholder；**只在编辑既有商品页**（新增页实测无此字段）' },
      { field: 'image', anchorText: 'input_upload', verified: true, pageScope: 'edit', note: '实测 3 个 input[type=file]，class=input_upload（编辑页）' },
      { field: 'category', anchorText: '选择商品类目', verified: true, pageScope: 'edit', note: '搜索式类目层（编辑页）；类目输入框无 placeholder，值形如「母婴 / 童装/婴儿装/亲子装 / 家居服 / 家居服套装」' },
      { field: 'brand', anchorText: '请选择品牌', verified: true, pageScope: 'edit', note: '实测 placeholder；无品牌时页面值为「无品牌」（编辑页）' },
      { field: 'price', anchorText: '填写售卖价', verified: true, pageScope: 'edit', note: '实测 placeholder（编辑页）；**新增商品页要先有规格才出现该区块**' },
      { field: 'stock', anchorText: '输入库存', verified: true, pageScope: 'edit', note: '实测 placeholder（编辑页）；同上，新增商品页要先有规格' }
    ],
    measuredAt: '2026-09-30'
  }
}

/**
 * 发布档位推导（方案 §7.2）——**不允许手写"我是 L1"**。
 *
 *   · 全部字段都已验证 → L1（应用可以逐字段填）
 *   · 部分字段已验证   → L2（引导模式：应用给核对清单，不写值）
 *   · 一个都没验证     → L3（接力模式：只打开页面）
 */
export type PublishTier = 'L1' | 'L2' | 'L3'

export function publishTierFor(platform: string): PublishTier {
  const profile = PRODUCT_PUBLISH_PROFILES[platform]
  if (!profile) return 'L3'
  const total = profile.fields.length
  const verified = profile.fields.filter(field => field.verified).length
  if (total === 0 || verified === 0) return 'L3'
  return verified === total ? 'L1' : 'L2'
}

/** 平台是否已实测到发布页（未实测 → 界面如实说明，并以 L3 接力模式打开）。 */
export function hasPublishProfile(platform: string): boolean {
  return !!PRODUCT_PUBLISH_PROFILES[platform]
}
