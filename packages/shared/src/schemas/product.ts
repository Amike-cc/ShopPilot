/**
 * 商品管理请求的入参校验（strict：多一个字段就拒）。
 *
 * 与订单/经营指标同一纪律：Renderer 只能传"店铺 ID + 有限分页/预算参数"，
 * 不能传 SQL、不能传平台地址、不能传选择器。
 */

import { z } from 'zod'

/** 店铺 ID：与其它域同一格式约束（非空、长度上限）。 */
const storeIdSchema = z.string().trim().min(1).max(128)

export const productSyncInputSchema = z.object({
  storeId: storeIdSchema,
  trigger: z.enum(['manual', 'schedule']).optional(),
  /** 预算：界面上"立即同步"用默认值；将来定时任务可以给更小的预算 */
  maxPages: z.number().int().min(1).max(200).optional(),
  maxProducts: z.number().int().min(1).max(5000).optional(),
  timeoutMs: z.number().int().min(5000).max(600_000).optional()
}).strict()

export const productListQuerySchema = z.object({
  storeId: storeIdSchema.optional(),
  platform: z.string().trim().min(1).max(32).optional(),
  /** 只看"平台上发现、本地未归并"的商品 */
  onlyOrphan: z.boolean().optional(),
  keyword: z.string().trim().max(64).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).max(100_000).optional()
}).strict()

export type ProductSyncInput = z.infer<typeof productSyncInputSchema>
export type ProductListQuery = z.infer<typeof productListQuerySchema>

// ---------------------------------------------------------------- 本地商品库（M2）

const productIdSchema = z.string().trim().min(1).max(128)
const linkIdSchema = z.string().trim().min(1).max(128)

export const productLibraryListQuerySchema = z.object({
  keyword: z.string().trim().max(64).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).max(100_000).optional()
}).strict()

export const productLibraryIdInputSchema = z.object({ productId: productIdSchema }).strict()

export const productLibrarySaveAsInputSchema = z.object({
  platform: z.string().trim().min(1).max(32),
  storeId: storeIdSchema,
  platformProductId: z.string().trim().min(1).max(64),
  /** 是否顺手归并到新建的本地商品（默认是） */
  mergeLink: z.boolean().optional()
}).strict()

export const productLibraryMergeInputSchema = z.object({
  linkId: linkIdSchema,
  productId: productIdSchema
}).strict()

export const productLibraryUnmergeInputSchema = z.object({ linkId: linkIdSchema }).strict()

/** 保存本地商品：草稿结构做**结构校验**（内容是否合格由 productDraftIssues 判，不在这里拒）。 */
const draftSpecSchema = z.object({ name: z.string().max(40), value: z.string().max(60) })
const draftMediaSchema = z.object({
  role: z.enum(['cover', 'gallery', 'detail', 'sku']),
  state: z.enum(['pending', 'localized', 'failed', 'blocked', 'missing']).optional(),
  remoteUrl: z.string().max(2048).nullable().optional(),
  localPath: z.string().max(512).nullable().optional(),
  sha256: z.string().max(64).nullable().optional(),
  failReason: z.string().max(120).nullable().optional()
})

export const productLibrarySaveInputSchema = z.object({
  productId: productIdSchema,
  platform: z.string().trim().min(1).max(32).optional(),
  draft: z.object({
    title: z.string().max(300),
    subtitle: z.string().max(300).nullable().optional(),
    description: z.string().max(20_000).nullable().optional(),
    brand: z.string().max(80).nullable().optional(),
    localCategory: z.string().max(120).nullable().optional(),
    tags: z.array(z.string().max(30)).max(30).optional(),
    variants: z.array(z.object({
      spec: z.array(draftSpecSchema).max(6),
      priceMinor: z.number().int().min(0).max(100_000_000).nullable(),
      stock: z.number().int().min(0).max(100_000_000).nullable(),
      skuCode: z.string().max(64).nullable().optional()
    })).max(200),
    media: z.array(draftMediaSchema).max(50)
  }).strict()
}).strict()

export type ProductLibraryListQuery = z.infer<typeof productLibraryListQuerySchema>
export type ProductLibrarySaveInput = z.infer<typeof productLibrarySaveInputSchema>
export type ProductLibrarySaveAsInput = z.infer<typeof productLibrarySaveAsInputSchema>

/** 详情页采集入参：店铺 + 平台商品 ID（URL 由实测模板拼，Renderer 传不了地址）。 */
export const productDetailCollectInputSchema = z.object({
  storeId: storeIdSchema,
  platformProductId: z.string().trim().min(1).max(64)
}).strict()
// ---------------------------------------------------------------- 发布（M3）

/** 发布预检入参：一个本地商品 + 目标店铺列表。**没有"提交"这类入参**（方案 §7.9）。 */
export const productPublishPreflightInputSchema = z.object({
  productId: productIdSchema,
  storeIds: z.array(storeIdSchema).min(1).max(20)
}).strict()

/**
 * 打开发布页入参。`fill=true` 才做 L1 代填（只填实测过锚点的字段、写后回读）。
 *
 * **没有任何"提交"相关入参** —— 这是方案 §7.9 那条不可配置的人工边界在 IPC 层的落点：
 * 即使渲染层被攻破，也没有一个参数能让主进程替你点提交。
 */
export const productPublishOpenInputSchema = z.object({
  itemId: z.string().trim().min(1).max(128),
  fill: z.boolean().optional()
}).strict()

export const productPublishItemsQuerySchema = z.object({ limit: z.number().int().min(1).max(200).optional() }).strict()
/**
 * 人工确认门禁（方案 §7.4）。**approved 是"用户说他已在平台上提交了"**，
 * 不是"让应用去提交" —— 应用永远不会替用户点提交。
 */
export const productPublishGateInputSchema = z.object({
  itemId: z.string().trim().min(1).max(128),
  message: z.string().trim().min(1).max(500).optional()
}).strict()

export const productPublishConfirmInputSchema = z.object({
  itemId: z.string().trim().min(1).max(128),
  approved: z.boolean()
}).strict()
/** 只带 itemId 的发布入参（回读校验用）。 */
export const productPublishIdInputSchema = z.object({ itemId: z.string().trim().min(1).max(128) }).strict()

/** 回读建议的确认（方案 §7.5）：**用户点了才落库**，kind 必须是规则层给出的那三种之一。 */
export const productPublishAcceptInputSchema = z.object({
  itemId: z.string().trim().min(1).max(128),
  field: z.string().trim().min(1).max(40),
  kind: z.enum(['suggest_default', 'suggest_writeback'])
}).strict()

/** 本地补全清单查询（跨次记住的平台必填项 + 本地还没有）。 */
export const productPublishChecklistInputSchema = z.object({
  productId: productIdSchema,
  storeId: storeIdSchema
}).strict()
/**
 * 批量发布（M5，方案 §7.8）。
 *
 * 上限（20 店 × 20 商品 = 400 项）由**规则层**判 —— 它能逐条说清"是哪个上限、当前选了多少"。
 * 所以这里的 Zod 上限**故意放宽**（200）：只挡"明显离谱/恶意"的入参，
 * 把"该拒就拒 + 说清原因"留给规则层。实测踩到过：Zod 的 `max(20)` 先拦下时，
 * 用户只看到一句通用的"请求参数不合法"，完全不知道是哪个上限超了。
 * 同样**没有任何"提交"入参**。
 */
export const productPublishBatchCreateInputSchema = z.object({
  productIds: z.array(productIdSchema).min(1).max(200),
  storeIds: z.array(storeIdSchema).min(1).max(200)
}).strict()

export const productPublishBatchProgressInputSchema = z.object({
  batchId: z.string().trim().min(1).max(128)
}).strict()

export const productPublishBatchSkipStoreInputSchema = z.object({
  batchId: z.string().trim().min(1).max(128),
  storeId: storeIdSchema
}).strict()
/** 图片本地化队列入参（只带一个可选的批大小上限）。 */
export const productMediaQueueInputSchema = z.object({
  maxItems: z.number().int().min(1).max(500).optional()
}).strict()