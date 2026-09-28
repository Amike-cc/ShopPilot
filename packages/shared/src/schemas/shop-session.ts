/** 店铺 Session 相关 IPC 输入 Schema。 */

import { z } from 'zod'

const storeIdSchema = z.string().trim().min(1).max(128)

export const shopSessionStatusInputSchema = z.object({
  storeId: storeIdSchema
}).strict()

export type ShopSessionStatusInput = z.infer<typeof shopSessionStatusInputSchema>
