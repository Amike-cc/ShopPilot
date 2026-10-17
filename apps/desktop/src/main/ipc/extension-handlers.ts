/**
 * 浏览器扩展 IPC（2026-10-17）。
 *
 * 安全约束：
 *   · 导入路径只来自主进程 dialog.showOpenDialog，Renderer 不传路径；
 *   · 所有操作走 familyHandle（可信渲染层 + 应用锁门禁），并写审计；
 *   · 启用/停用/删除/重载后重载已打开的店铺标签页，让扩展立即生效/卸载。
 */
import { BrowserWindow, dialog, shell, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import { IPC_CHANNELS } from '@shared/contracts/ipc'
import type { IPCResult } from '@shared/contracts/ipc'
import type {
  BrowserExtensionImportResult,
  BrowserExtensionListResult,
  BrowserExtensionOpenDirResult
} from '@shared/contracts/extensions'
import {
  browserExtensionIdInputSchema,
  browserExtensionOpenDirSchema,
  browserExtensionSetEnabledSchema,
  browserExtensionSetMasterSchema
} from '@shared/schemas/extension'
import * as ExtensionManager from '../services/extension-manager'
import { writeAudit } from '../services/audit-logger'
import { getOpenStoreIds, getStoreTabs, getTabWebContents } from '../browser/window-manager'
import { ipcErrFromUnknown, ipcFail, ipcOk } from './envelope'
import { familyHandle } from './family-handle'

const handle = familyHandle('浏览器扩展')

const KNOWN_CODES = new Set([
  'EXTENSION_INVALID',
  'EXTENSION_PERMISSION_BLOCKED',
  'EXTENSION_MAIN_WORLD_UNSUPPORTED',
  'EXTENSION_TOO_LARGE',
  'EXTENSION_NOT_FOUND',
  'EXTENSION_REMOVE_FAILED',
  'EXTENSION_LOAD_FAILED'
])

function extensionError(error: unknown, requestId: string): IPCResult<never> {
  const raw = String((error as any)?.message || error || '')
  const match = /^([A-Z_]+):\s*(.+)$/.exec(raw.trim())
  if (match && KNOWN_CODES.has(match[1])) {
    return ipcFail(match[1], match[2], requestId)
  }
  return ipcErrFromUnknown(error, requestId, { fallback: '扩展操作失败' })
}

/** 扩展启用状态变化后，让已打开店铺页重新加载（卸载/加载扩展都必须重载才彻底生效）。 */
function reloadOpenStoreTabs(): void {
  for (const storeId of getOpenStoreIds()) {
    for (const tab of getStoreTabs(storeId)) {
      try {
        const wc = getTabWebContents(storeId, tab.id)
        if (wc && !wc.isDestroyed()) wc.reload()
      } catch { /* 单个标签失败不影响其它标签 */ }
    }
  }
}

export function registerExtensionHandlers(): void {
  handle(IPC_CHANNELS.EXTENSION_LIST, async (): Promise<IPCResult<BrowserExtensionListResult>> => {
    const requestId = randomUUID()
    try {
      return ipcOk(ExtensionManager.listExtensions(), requestId)
    } catch (error) {
      return extensionError(error, requestId)
    }
  })

  handle(IPC_CHANNELS.EXTENSION_IMPORT, async (): Promise<IPCResult<BrowserExtensionImportResult>> => {
    const requestId = randomUUID()
    try {
      // 验收钩子：打包版无法驱动原生目录选择框，允许在显式声明 SHOPILOT_ACCEPTANCE=1 时
      // 用环境变量指定源目录。导入后的复制/校验逻辑与手动选择完全一致，不放宽安全边界。
      const testDir = process.env.SHOPILOT_TEST_EXTENSION_IMPORT_DIR
      let sourceDir = ''
      if (testDir && process.env.SHOPILOT_ACCEPTANCE === '1') {
        sourceDir = testDir
      } else {
        const win = BrowserWindow.getFocusedWindow()
        const options: Electron.OpenDialogOptions = {
          title: '选择扩展文件夹（包含 manifest.json）',
          properties: ['openDirectory']
        }
        const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
        if (picked.canceled || !picked.filePaths[0]) return ipcOk({ canceled: true }, requestId)
        sourceDir = picked.filePaths[0]
      }
      const item = ExtensionManager.importExtensionFromDirectory(sourceDir)
      reloadOpenStoreTabs()
      return ipcOk({ canceled: false, item }, requestId)
    } catch (error) {
      return extensionError(error, requestId)
    }
  })

  handle(IPC_CHANNELS.EXTENSION_SET_ENABLED, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult<BrowserExtensionListResult>> => {
    const requestId = randomUUID()
    const parsed = browserExtensionSetEnabledSchema.safeParse(input)
    if (!parsed.success) return ipcFail('INVALID_ARGUMENT', '扩展参数不合法', requestId)
    try {
      const result = await ExtensionManager.setExtensionEnabled(parsed.data.id, parsed.data.enabled)
      reloadOpenStoreTabs()
      return ipcOk(result, requestId)
    } catch (error) {
      return extensionError(error, requestId)
    }
  })

  handle(IPC_CHANNELS.EXTENSION_SET_MASTER, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult<BrowserExtensionListResult>> => {
    const requestId = randomUUID()
    const parsed = browserExtensionSetMasterSchema.safeParse(input)
    if (!parsed.success) return ipcFail('INVALID_ARGUMENT', '扩展参数不合法', requestId)
    try {
      const result = await ExtensionManager.setExtensionsMaster(parsed.data.enabled)
      reloadOpenStoreTabs()
      return ipcOk(result, requestId)
    } catch (error) {
      return extensionError(error, requestId)
    }
  })

  handle(IPC_CHANNELS.EXTENSION_REMOVE, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult<BrowserExtensionListResult>> => {
    const requestId = randomUUID()
    const parsed = browserExtensionIdInputSchema.safeParse(input)
    if (!parsed.success) return ipcFail('INVALID_ARGUMENT', '扩展参数不合法', requestId)
    try {
      const result = await ExtensionManager.removeExtension(parsed.data.id)
      reloadOpenStoreTabs()
      return ipcOk(result, requestId)
    } catch (error) {
      return extensionError(error, requestId)
    }
  })

  handle(IPC_CHANNELS.EXTENSION_RELOAD, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult<BrowserExtensionListResult>> => {
    const requestId = randomUUID()
    const parsed = browserExtensionIdInputSchema.safeParse(input)
    if (!parsed.success) return ipcFail('INVALID_ARGUMENT', '扩展参数不合法', requestId)
    try {
      const result = await ExtensionManager.reloadExtension(parsed.data.id)
      reloadOpenStoreTabs()
      return ipcOk(result, requestId)
    } catch (error) {
      return extensionError(error, requestId)
    }
  })

  // 自己写插件的工作流：导入后编辑的是应用内副本，改完点「重载」才生效。
  // 这里只把目录交给系统文件管理器，绝对路径不回渲染层。
  handle(IPC_CHANNELS.EXTENSION_OPEN_DIR, async (_event: IpcMainInvokeEvent, input: unknown): Promise<IPCResult<BrowserExtensionOpenDirResult>> => {
    const requestId = randomUUID()
    const parsed = browserExtensionOpenDirSchema.safeParse(input ?? {})
    if (!parsed.success) return ipcFail('INVALID_ARGUMENT', '扩展参数不合法', requestId)
    try {
      const dir = ExtensionManager.resolveExtensionDir(parsed.data.id)
      const failure = await shell.openPath(dir)
      if (failure) {
        return ipcOk({ opened: false, reason: '系统文件管理器没有打开该目录，请稍后重试' }, requestId)
      }
      writeAudit('extension.openDir', 'success', { requestId: parsed.data.id || 'root' })
      return ipcOk({ opened: true }, requestId)
    } catch (error) {
      return extensionError(error, requestId)
    }
  })
}
