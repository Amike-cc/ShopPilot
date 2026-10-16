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
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/contracts/ipc'
import type { IPCResult } from '@shared/contracts/ipc'
import { clearAppCache, clearBrowserCaches } from '../services/cache-cleanup'
import { runSoftwareDiagnostics } from '../services/software-diagnostics'
import { ipcErrFromUnknown, ipcOk as ok } from './envelope'
import { familyHandle } from './family-handle'

const handle = familyHandle('维护')
const rid = (): string => randomUUID()

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
}
