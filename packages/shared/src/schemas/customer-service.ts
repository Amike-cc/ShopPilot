import { z } from 'zod'

const storeId = z.string().trim().min(1).max(128)

export const customerServiceStatusListSchema = z.object({
  storeId: storeId.optional(),
  limit: z.number().int().min(1).max(1000).optional()
}).strict()

export const customerServicePrepareSchema = z.object({
  storeId
}).strict()

export const customerServiceCheckNowSchema = z.object({
  storeId
}).strict()

export type CustomerServiceStatusListInput = z.infer<typeof customerServiceStatusListSchema>
export type CustomerServicePrepareInput = z.infer<typeof customerServicePrepareSchema>
export type CustomerServiceCheckNowInput = z.infer<typeof customerServiceCheckNowSchema>
