/**
 * 商品采集的安全返回契约（商品管理方案 §5.1）。
 *
 * 与订单/经营指标同一条纪律：**只返回可以跨 IPC 传递的结构化结果**。
 * Cookie / Token / 页面原文 / 买家信息一律不进这里；页面原文最多进 `rawRow`（落库后参与保留策略）。
 *
 * 能力位纪律：`PlatformAdapterCapabilities.products` 只有在**真机实测跑通一轮**之后才置 true
 * （实测记录见 docs/product-profiles.md）；在此之前界面如实说明"该平台尚未实测到商品列表"，
 * 绝不拿猜的选择器去试。
 */

/** 平台商品状态。判不出一律 `unknown`——不猜（把"审核中"当"在售"会让运营误判）。 */
export const PLATFORM_PRODUCT_STATUSES = [
  'on_sale',
  'off_shelf',
  'auditing',
  'violation',
  'unknown'
] as const

export type PlatformProductStatus = typeof PLATFORM_PRODUCT_STATUSES[number]

export const PLATFORM_PRODUCT_COLLECTION_STATUSES = [
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
  'LOGIN_REQUIRED',
  'PAGE_CHANGED',
  'DATA_SOURCE_NOT_VERIFIED'
] as const

export type PlatformProductCollectionStatus = typeof PLATFORM_PRODUCT_COLLECTION_STATUSES[number]

export interface PlatformProductCollectionOptions {
  /** 翻页上限（触顶 → hasMore=true，界面如实提示"还有更多"） */
  maxPages: number
  /** 商品条数上限（同上） */
  maxProducts: number
  /** 单轮总超时 */
  timeoutMs: number
}

export interface PlatformProductSku {
  platformSkuId: string
  /** 规格组合，如 [{name:'颜色',value:'红'}] */
  spec: Array<{ name: string; value: string }>
  priceMinor: number | null
  stock: number | null
  skuCode: string | null
  imageUrl: string | null
  state: 'active' | 'missing'
}

export interface PlatformProduct {
  platformProductId: string
  title: string
  subtitle: string | null
  status: PlatformProductStatus
  /** 分为单位（与 orders/sales_metrics 一致）；取不到就是 null，**不写 0** */
  priceMinor: number | null
  stock: number | null
  categoryPath: string | null
  imageUrls: string[]
  skus: PlatformProductSku[]
  platformUpdatedAt: number | null
  /**
   * 保底原文（整行单元格文本）。落 `raw_snapshot_json`，
   * 用途只有两个：① 排障比对；② 增量同步时判断"这行到底变没变"。参与保留策略。
   */
  rawRow?: string[]
}

export interface PlatformProductCollectionResult {
  status: PlatformProductCollectionStatus
  products: PlatformProduct[]
  fetchedCount: number
  skippedCount: number
  pageCount: number
  /** 达上限被截断 → 必须在界面如实告诉用户"还有更多" */
  hasMore: boolean
  reasonCode: string
  safeMessage: string
}

/** 商品档案里可被采集/填充的字段键（用于档位推导与字段级 diff）。 */
export const PRODUCT_FIELD_KEYS = [
  'title', 'subtitle', 'description', 'brand',
  'price', 'stock', 'sku', 'image', 'category',
  'shippingTemplate', 'afterSale'
] as const

export type ProductFieldKey = typeof PRODUCT_FIELD_KEYS[number]
