/**
 * 浏览器扩展（本地解包）契约。
 *
 * 只描述 Renderer 可见的安全摘要：完整路径、Electron 运行时 extension id、
 * 清单原文都不出主进程。`id` 是应用自己的 slug（`ext_` + 8 位小写字母数字）。
 */
export type BrowserExtensionStatus = 'loaded' | 'enabled' | 'disabled' | 'invalid' | 'load_failed' | 'missing'

export interface BrowserExtensionItem {
  id: string
  name: string
  version: string
  manifestVersion: 2 | 3
  enabled: boolean
  status: BrowserExtensionStatus
  permissions: string[]
  sizeBytes: number
  updatedAt: number
  /** 加载失败的脱敏原因；成功时为空 */
  loadError?: string
}

export interface BrowserExtensionListResult {
  master: boolean
  items: BrowserExtensionItem[]
}

export interface BrowserExtensionImportResult {
  canceled: boolean
  item?: BrowserExtensionItem
}

/** 打开目录只回“是否已交给系统文件管理器”，不回绝对路径。 */
export interface BrowserExtensionOpenDirResult {
  opened: boolean
  /** 目标不存在时如实说明（例如根目录还没创建） */
  reason?: string
}
