/**
 * 缓存清理与软件自检的 IPC（设置中心「数据与维护」）——2026-10-16 新增。
 *
 * 为什么单开一个 family：这三个通道都是「维护动作」，与店铺/浏览器/会话的业务通道不是一回事；
 * 塞进 session-security-handlers 会让那个文件同时承担会话、安全与维护三件事。
 * 校验沿用 familyHandle：只有主窗口渲染层可调用，应用锁定时拒绝（维护动作不应绕过锁屏）。
 *
 * 三个通道都是**幂等只读或幂等清理**：重复点击只会再清一遍，不会产生累积副作用；
 * 清理动作由服务层写审计（maintenance.cache.clear），诊断只读不写审计。
 */
import { randomUUID } from 'crypto'
import { app, shell, type IpcMainInvokeEvent } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { IPC_CHANNELS } from '@shared/contracts/ipc'
import type { IPCResult } from '@shared/contracts/ipc'
import { clearAppCache, clearBrowserCaches } from '../services/cache-cleanup'
import { runSoftwareDiagnostics } from '../services/software-diagnostics'
import { getDatabasePath } from '../db/database'
import { ipcErrFromUnknown, ipcFail as err, ipcOk as ok } from './envelope'
import { familyHandle } from './family-handle'
import { ERROR_CODES } from '@shared/errors/error-codes'

const handle = familyHandle('维护')
const rid = (): string => randomUUID()

function storagePaths(): { dataDir: string; databasePath: string; logsDir: string; backupsDir: string } {
  const dataDir = app.getPath('userData')
  return {
    dataDir,
    databasePath: getDatabasePath(),
    logsDir: join(dataDir, 'logs'),
    backupsDir: join(dataDir, 'backups')
  }
}

export function registerMaintenanceHandlers(): void {
  // 清除软件缓存：只清应用界面自己的缓存（默认会话），不碰店铺分区与数据库
  handle(IPC_CHANNELS.MAINTENANCE_CLEAR_APP_CACHE, async (_event: IpcMainInvokeEvent): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(await clearAppCache(requestId), requestId)
    } catch (error) {
      return ipcErrFromUnknown(error, requestId, { fallback: '清除软件缓存失败' })
    }
  })

  // 清除浏览器缓存：所有店铺分区的网页缓存，Cookie 与站点存储保留
  handle(IPC_CHANNELS.MAINTENANCE_CLEAR_BROWSER_CACHE, async (_event: IpcMainInvokeEvent): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(await clearBrowserCaches(requestId), requestId)
    } catch (error) {
      return ipcErrFromUnknown(error, requestId, { fallback: '清除浏览器缓存失败' })
    }
  })

  // 诊断软件：只读自检，逐项给出事实与下一步
  handle(IPC_CHANNELS.MAINTENANCE_SOFTWARE_DIAGNOSTICS, async (_event: IpcMainInvokeEvent): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(await runSoftwareDiagnostics(), requestId)
    } catch (error) {
      return ipcErrFromUnknown(error, requestId, { fallback: '软件诊断失败' })
    }
  })

  // 存储位置：只返回本机路径，不返回文件内容；数据库路径与主进程实际使用的一致。
  handle(IPC_CHANNELS.MAINTENANCE_PATHS, async (): Promise<IPCResult> => {
    const requestId = rid()
    try {
      return ok(storagePaths(), requestId)
    } catch (error) {
      return ipcErrFromUnknown(error, requestId, { fallback: '读取存储位置失败' })
    }
  })

  // 打开目录：只接受白名单 target；不接受任意路径（避免渲染层拿 IPC 当文件管理器）。
  handle(IPC_CHANNELS.MAINTENANCE_OPEN_DIR, async (_event: IpcMainInvokeEvent, input: { target?: unknown }): Promise<IPCResult> => {
    const requestId = rid()
    const target = input?.target
    if (target !== 'data' && target !== 'logs' && target !== 'backups') {
      return err(ERROR_CODES.INVALID_ARGUMENT.code, '目录类型不合法', requestId)
    }
    try {
      const paths = storagePaths()
      const path = target === 'data' ? paths.dataDir : target === 'logs' ? paths.logsDir : paths.backupsDir
      // 日志/备份目录可能在首次使用前不存在；先建出来再交给系统文件管理器。
      mkdirSync(path, { recursive: true })
      const message = await shell.openPath(path)
      if (message) return err(ERROR_CODES.INTERNAL_ERROR.code, `打开目录失败：${message}`, requestId)
      return ok({ path }, requestId)
    } catch (error) {
      return ipcErrFromUnknown(error, requestId, { fallback: '打开目录失败' })
    }
  })
}
