/**
 * 浏览器扩展 IPC 入参（2026-10-17）。
 * Renderer 只传应用自己的 slug，不传路径；导入路径只能由主进程目录选择框产生。
 */
import { z } from 'zod'

export const browserExtensionIdSchema = z.string().trim().regex(/^ext_[a-z0-9]{8}$/, '扩展 ID 不合法')

export const browserExtensionSetEnabledSchema = z.object({
  id: browserExtensionIdSchema,
  enabled: z.boolean()
}).strict()

export const browserExtensionSetMasterSchema = z.object({
  enabled: z.boolean()
}).strict()

export const browserExtensionIdInputSchema = z.object({
  id: browserExtensionIdSchema
}).strict()

/** 打开扩展目录：不带 id 打开管理根目录（方便开发者放自己的插件），带 id 打开该扩展副本。 */
export const browserExtensionOpenDirSchema = z.object({
  id: browserExtensionIdSchema.optional()
}).strict()

/**
 * 插件中心安装：Renderer 只传目录条目的 key（不是路径、不是 slug）。
 * 目标目录由主进程按 key 确定性推导（`catalogSlug`），装不出第二份。
 */
export const browserExtensionCatalogInstallSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{2,39}$/, '插件条目 ID 不合法')
}).strict()
