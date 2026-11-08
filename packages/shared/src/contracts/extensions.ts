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

/**
 * 插件中心条目（2026-11-08）。
 *
 * 目录随安装包一起发：`assets/browser-extensions/catalog.json` 声明可安装的插件，
 * 扩展本体在子目录里，安装时走与本地导入完全相同的校验/复制/审计通道。
 * `id` 是安装目录 slug（`ext_` + 8 hex，由条目 key 确定性推导）；未安装时也给出，
 * 方便界面判断"装没装"而不需要路径。
 */
export interface BrowserExtensionCatalogItem {
  /** 安装目录 slug：ext_ + 8 位十六进制（由 key 推导，重复安装覆盖同一目录） */
  id: string
  /** 目录条目 key（安装时回传给主进程） */
  key: string
  /** 清单里的真实名称（读不到清单时退回目录声明名） */
  name: string
  version: string
  manifestVersion: 2 | 3
  summary: string
  description?: string
  tags: string[]
  permissions: string[]
  sizeBytes: number
  installed: boolean
  enabled: boolean
  /** 已安装时的运行状态；未安装为 'missing' */
  status: BrowserExtensionStatus
  /** 目录里这份插件不合法（清单被拒 / 目录缺失）时的原因；此时不可安装 */
  invalidReason?: string
}

export interface BrowserExtensionCatalogResult {
  master: boolean
  entries: BrowserExtensionCatalogItem[]
  /** 整个目录读不到时的原因（例如打包漏了 resources） */
  sourceError?: string
}

export interface BrowserExtensionCatalogInstallResult {
  /** 装完之后的已安装列表（界面直接替换，不用再拉一次） */
  list: BrowserExtensionListResult
  /** 装了哪个（slug） */
  id: string
  /** 总开关关着：装好了但还不生效，界面要提示 */
  masterOff: boolean
}
