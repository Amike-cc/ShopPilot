/**
 * 审计日志查询的 Zod Schema - §6.7 audit:query
 *
 * 2026-09-26 审计 P2：`audit:query` 之前把渲染层传来的 filter **原样**丢给 SQL 构造
 * （`input?.filter || {}`，类型是 any）：多传的键被静默忽略、`limit` 传字符串会让
 * `Math.min(Math.max('abc',1),1000)` 变成 NaN、`requestId` 也查不了。
 * 现在按 §"所有输入必须在 Main 使用 strict Zod schema 校验"收敛成严格 schema。
 */

import { z } from 'zod'

/** 与 audit_logger.queryAudit 的 AuditQueryFilter 一一对应；多余键直接拒绝（strict）。 */
export const auditQueryFilterSchema = z.object({
  storeId: z.string().trim().min(1).max(128).nullish(),
  action: z.string().trim().min(1).max(64).nullish(),
  /** 调用 id（可带 `#说明` 后缀，按前缀匹配） */
  requestId: z.string().trim().min(1).max(200).nullish(),
  from: z.number().int().nonnegative().nullish(),
  to: z.number().int().nonnegative().nullish(),
  limit: z.number().int().min(1).max(1000).optional()
}).strict()

export type AuditQueryFilterInput = z.infer<typeof auditQueryFilterSchema>
