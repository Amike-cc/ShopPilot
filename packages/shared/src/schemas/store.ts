/**
 * 店铺相关的 Zod Schema
 * §6.1 店铺 IPC 接口
 */

import { z } from 'zod'

const storeIdSchema = z.string().trim().min(1).max(128)
const storeNameSchema = z.string().trim().min(1, '店铺名称不能为空').max(120, '店铺名称不能超过 120 个字符')
const platformSchema = z.string().trim().min(1, '平台不能为空').max(64, '平台名称不能超过 64 个字符')
const adminUrlSchema = z.string().trim().max(2048, '后台地址不能超过 2048 个字符').refine(
  value => value === '' || /^https?:\/\//i.test(value),
  '后台地址必须是 http:// 或 https:// 地址'
)
const tagsSchema = z.array(z.string().trim().min(1).max(64)).max(50).optional()
const optionalText = (max: number) => z.string().trim().max(max).optional()

/**
 * 营业执照主体名称（选填）。发票要按开票主体分账，所以它是店铺自身的属性，
 * 而不是发票行里的"抬头/税号"（那是对方的）。
 */
const licenseNameSchema = z.string().trim().max(120, '营业执照主体名称不能超过 120 个字符').optional()
/**
 * 统一社会信用代码（选填）：18 位（三证合一后）或 15 位（旧税号/注册号）。
 * 允许带空格与连字符（用户是从执照上连格式一起复制过来的），归一化在主进程落库前做。
 */
const licenseNoSchema = z.string().trim().max(64, '统一社会信用代码不能超过 64 个字符')
  .refine(
    v => v === '' || /^(?:[0-9A-Za-z]{18}|[0-9]{15})$/.test(v.replace(/[\s-]/g, '')),
    '统一社会信用代码应为 18 位（旧税号为 15 位）字母或数字'
  )
  .optional()

export const storeCreateSchema = z.object({
  name: storeNameSchema,
  platform: platformSchema,
  adminUrl: adminUrlSchema.default(''),
  tags: tagsSchema,
  notes: optionalText(5000),
  externalCode: optionalText(256),
  owner: optionalText(120),
  region: optionalText(120),
  licenseName: licenseNameSchema,
  licenseNo: licenseNoSchema
}).strict()

export const storeUpdateSchema = z.object({
  storeId: storeIdSchema,
  patch: z.object({
    name: storeNameSchema.optional(),
    platform: platformSchema.optional(),
    adminUrl: adminUrlSchema.optional(),
    tags: tagsSchema,
    notes: optionalText(5000),
    externalCode: optionalText(256),
    owner: optionalText(120),
    region: optionalText(120),
    groupName: z.string().trim().max(120).nullable().optional(),
    licenseName: licenseNameSchema,
    licenseNo: licenseNoSchema
  }).strict()
}).strict()

export const storeReorderSchema = z.object({
  orderedStoreIds: z.array(storeIdSchema).max(1000).superRefine((ids, ctx) => {
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '店铺排序列表不能包含重复 ID' })
  })
}).strict()

export const storeIdInputSchema = z.object({ storeId: storeIdSchema }).strict()
export const storeGroupSchema = z.object({
  storeId: storeIdSchema,
  groupName: z.string().trim().max(120).nullable()
}).strict()

export type StoreCreateInput = z.infer<typeof storeCreateSchema>
export type StoreUpdateInput = z.infer<typeof storeUpdateSchema>
export type StoreReorderInput = z.infer<typeof storeReorderSchema>

export interface Store {
  id: string
  name: string
  platform: string
  adminUrl: string
  status: string
  avatarColor: string
  sortOrder: number
  groupName: string | null
  externalCode: string | null
  owner: string | null
  region: string | null
  /** 营业执照主体名称（发票按主体分账用；老店铺为空 = 未填写） */
  licenseName: string | null
  /** 统一社会信用代码（同一执照下多家店靠它归组） */
  licenseNo: string | null
  tagsJson: string
  notes: string | null
  lastActiveAt: number | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}
