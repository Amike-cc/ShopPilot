/** 订单采集/查询 IPC 输入；不接受 URL、partition、Session 或任意脚本。 */

import { z } from 'zod'
import { UNIFIED_ORDER_STATUSES } from '../contracts/unified-order'

const storeIdSchema = z.string().trim().min(1).max(128)

export const orderCollectInputSchema = z.object({
  storeId: storeIdSchema,
  maxPages: z.number().int().min(1).max(10).default(1),
  maxOrders: z.number().int().min(1).max(500).default(100),
  timeoutMs: z.number().int().min(1000).max(30000).default(10000)
}).strict()

export const orderListQuerySchema = z.object({
  storeId: storeIdSchema,
  status: z.enum(UNIFIED_ORDER_STATUSES).optional(),
  startDate: z.number().int().min(0).optional(),
  endDate: z.number().int().min(0).optional(),
  page: z.number().int().min(1).max(10000).default(1),
  pageSize: z.number().int().min(1).max(200).default(50)
}).strict().superRefine((value, ctx) => {
  if (value.startDate != null && value.endDate != null && value.startDate > value.endDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: '结束时间不能早于开始时间' })
  }
})

export const orderIdInputSchema = z.object({
  storeId: storeIdSchema,
  orderId: z.string().trim().min(1).max(160)
}).strict()

export const pddOrderObservationStartSchema = z.object({
  storeId: storeIdSchema,
  timeoutMs: z.number().int().min(1000).max(300000).default(120000),
  maxResponses: z.number().int().min(1).max(500).default(200)
}).strict()

export const pddOrderObservationStopSchema = z.object({
  storeId: storeIdSchema
}).strict()

export type OrderCollectInput = z.infer<typeof orderCollectInputSchema>
export type OrderListQueryInput = z.infer<typeof orderListQuerySchema>
export type OrderIdInput = z.infer<typeof orderIdInputSchema>
export type PddOrderObservationStartInput = z.infer<typeof pddOrderObservationStartSchema>
export type PddOrderObservationStopInput = z.infer<typeof pddOrderObservationStopSchema>
