import { z } from 'zod'

const storeId = z.string().trim().min(1).max(128)
const tabId = z.string().trim().min(1).max(160)
const url = z.string().trim().min(1).max(4096)

export const browserOpenSchema = z.object({ storeId, display: z.boolean().optional() }).strict()
export const browserStoreIdSchema = z.object({ storeId }).strict()
export const browserRegisterWebviewSchema = z.object({
  storeId,
  tabId,
  webContentsId: z.number().int().positive()
}).strict()
export const browserTabCreateSchema = z.object({ storeId, url: url.optional() }).strict()
export const browserTabInputSchema = z.object({ storeId, tabId }).strict()
export const browserTabPinnedSchema = z.object({ storeId, tabId, pinned: z.boolean() }).strict()

/**
 * 批量关闭标签页。
 *
 * 三个模式都要在 **Main 侧按真实状态** 计算：
 *   ids    —— 只关显式选中的（多选），固定标签也关（用户是明确点选的）
 *   others —— 关掉除 keepTabId 之外的全部（默认保留固定标签）
 *   all    —— 关掉全部（默认保留固定标签，"关到 0 个"必须显式 includePinned）
 */
export const browserTabsCloseManySchema = z.object({
  storeId,
  mode: z.enum(['ids', 'others', 'all']),
  tabIds: z.array(tabId).min(1).max(200).optional(),
  keepTabId: tabId.optional(),
  /** 默认 false：一键操作跳过固定标签，避免把常驻页一起关掉 */
  includePinned: z.boolean().optional()
}).strict().superRefine((value, ctx) => {
  if (value.mode === 'ids' && !value.tabIds?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '关闭选中时必须提供 tabIds' })
  }
  if (value.mode === 'others' && !value.keepTabId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '关闭其他时必须提供保留的标签页' })
  }
  if (value.tabIds && new Set(value.tabIds).size !== value.tabIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '标签页列表不能包含重复 ID' })
  }
})
export const browserTabReorderSchema = z.object({
  storeId,
  orderedTabIds: z.array(tabId).max(1000).superRefine((ids, ctx) => {
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '标签页排序列表不能包含重复 ID' })
  })
}).strict()
export const browserNavigateSchema = z.object({ storeId, tabId, url }).strict()
/** 读店铺名：tabId 可省，默认取该店铺当前活动标签页 */
export const browserReadStoreNameSchema = z.object({ storeId, tabId: tabId.optional() }).strict()
export const browserInviteSquareSchema = z.object({
  storeId,
  url,
  finderType: z.string().trim().max(120).optional(),
  categories: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  salesTiers: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  otherFilters: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  loadCategoryTree: z.boolean().optional()
}).strict()
export const browserClearDataSchema = z.object({
  storeId,
  types: z.array(z.enum(['cookies', 'cache', 'localStorage', 'downloads'])).min(1).max(4)
    .superRefine((types, ctx) => { if (new Set(types).size !== types.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '清理类型不能重复' }) }),
  origin: url.optional()
}).strict()
export const browserCaptureSchema = z.object({ storeId, tabId, format: z.enum(['png', 'jpeg']) }).strict()
export const browserPickElementSchema = z.object({ storeId, mode: z.enum(['selector', 'text']) }).strict()
export const browserOpenWindowSchema = z.object({ storeId, tabId: tabId.optional() }).strict()
export const browserDisplaySchema = z.object({ storeId: storeId.nullable() }).strict()
export const browserViewportSchema = z.object({
  x: z.number().finite(), y: z.number().finite(),
  width: z.number().finite().min(0).max(16384), height: z.number().finite().min(0).max(16384)
}).strict()
export const browserViewsObscuredSchema = z.object({ obscured: z.boolean(), reason: z.enum(['modal', 'agent']).optional() }).strict()
export const browserTabControlSchema = z.object({ storeId, tabId, action: z.enum(['back', 'forward', 'reload']) }).strict()
