import { z } from 'zod'
import { SALES_METRICS_COLLECTION_STATUSES, SALES_METRICS_PERIOD_TYPES } from '../contracts/sales-metrics'
import { SALES_METRICS_MAX_INTERVAL_MS, SALES_METRICS_MIN_INTERVAL_MS } from '../sales-metrics-rules'

const storeIdSchema = z.string().trim().min(1).max(128)
const periodTypeSchema = z.enum(SALES_METRICS_PERIOD_TYPES)
const safeDate = z.number().int().min(0).max(4102444800000)

const checkPeriodRange = (value: unknown, ctx: z.RefinementCtx): void => {
  const range = value as { periodStart?: number; periodEnd?: number }
  if (range.periodStart != null && range.periodEnd != null && range.periodStart > range.periodEnd) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['periodEnd'], message: '结束时间不能早于开始时间' })
  }
}

export const salesMetricsCollectionInputSchema = z.object({
  storeId: storeIdSchema,
  periodType: periodTypeSchema.default('TODAY'),
  periodStart: safeDate.optional(),
  periodEnd: safeDate.optional(),
  timeoutMs: z.number().int().min(1000).max(300000).default(30000)
}).strict().superRefine((value, ctx) => {
  if (value.periodType === 'CUSTOM' && (value.periodStart == null || value.periodEnd == null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['periodStart'], message: 'CUSTOM 周期必须提供起止时间' })
  }
  checkPeriodRange(value, ctx)
})

/**
 * 基础查询对象：把 refine 后再 extend 的写法拆开——superRefine 返回 ZodEffects，
 * 上面没有 .extend/.pick（此前在这里是模块加载即抛 TypeError 的运行时炸弹）。
 */
const salesMetricsQueryBase = z.object({
  storeId: storeIdSchema,
  periodType: periodTypeSchema.optional(),
  periodStart: safeDate.optional(),
  periodEnd: safeDate.optional(),
  page: z.number().int().min(1).max(10000).default(1),
  pageSize: z.number().int().min(1).max(200).default(50)
}).strict()

export const salesMetricsQuerySchema = salesMetricsQueryBase.superRefine(checkPeriodRange)

export const salesMetricsLatestQuerySchema = salesMetricsQueryBase
  .pick({ storeId: true, periodType: true })
  .superRefine(checkPeriodRange)

export const salesMetricsProductQuerySchema = salesMetricsQueryBase.extend({
  sort: z.enum(['salesQuantity', 'paidSalesAmountMinor']).default('salesQuantity'),
  limit: z.number().int().min(1).max(100).default(10)
}).strict().superRefine(checkPeriodRange)

export type SalesMetricsCollectionInputSchema = z.infer<typeof salesMetricsCollectionInputSchema>
export type SalesMetricsQuerySchema = z.infer<typeof salesMetricsQuerySchema>
export type SalesMetricsProductQuerySchema = z.infer<typeof salesMetricsProductQuerySchema>

/* ------------------------------------------------------------------ *
 * 采集计划管理（§9）。
 *
 * Renderer 只能传 storeId、周期、分页和有限的 status 过滤：
 * 不允许 SQL、URL、Session、WebContents 或任意脚本——schema 用 .strict()
 * 把"多传一个字段"直接判为非法，而不是静默忽略。
 * ------------------------------------------------------------------ */

const platformFilterSchema = z.string().trim().min(1).max(64)

export const salesMetricsPlanListQuerySchema = z.object({
  storeId: storeIdSchema.optional(),
  platform: platformFilterSchema.optional()
}).strict()

export const salesMetricsPlanGetQuerySchema = z.object({
  storeId: storeIdSchema
}).strict()

export const salesMetricsPlanUpdateSchema = z.object({
  storeId: storeIdSchema,
  enabled: z.boolean().optional(),
  intervalMs: z.number().int().min(SALES_METRICS_MIN_INTERVAL_MS).max(SALES_METRICS_MAX_INTERVAL_MS).optional()
}).strict().superRefine((value, ctx) => {
  if (value.enabled == null && value.intervalMs == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['enabled'], message: '至少要修改一项（启用状态或周期）' })
  }
})

export const salesMetricsPlanPauseSchema = z.object({
  storeId: storeIdSchema
}).strict()

export const salesMetricsPlanResumeSchema = z.object({
  storeId: storeIdSchema
}).strict()

export const salesMetricsPlanRunNowSchema = z.object({
  storeId: storeIdSchema,
  periodType: periodTypeSchema.default('TODAY')
}).strict()

export const salesMetricsRunsQuerySchema = z.object({
  storeId: storeIdSchema.optional(),
  platform: platformFilterSchema.optional(),
  status: z.enum(SALES_METRICS_COLLECTION_STATUSES).optional(),
  page: z.number().int().min(1).max(10000).default(1),
  pageSize: z.number().int().min(1).max(200).default(50)
}).strict()

/** 健康查询不带任何参数：跨店铺的汇总不能让 Renderer 指定 SQL 范围。 */
export const salesMetricsHealthQuerySchema = z.object({}).strict()

export type SalesMetricsPlanListQuerySchema = z.infer<typeof salesMetricsPlanListQuerySchema>
export type SalesMetricsPlanGetQuerySchema = z.infer<typeof salesMetricsPlanGetQuerySchema>
export type SalesMetricsPlanUpdateSchema = z.infer<typeof salesMetricsPlanUpdateSchema>
export type SalesMetricsPlanPauseSchema = z.infer<typeof salesMetricsPlanPauseSchema>
export type SalesMetricsPlanResumeSchema = z.infer<typeof salesMetricsPlanResumeSchema>
export type SalesMetricsPlanRunNowSchema = z.infer<typeof salesMetricsPlanRunNowSchema>
export type SalesMetricsRunsQuerySchema = z.infer<typeof salesMetricsRunsQuerySchema>

