import type { IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { familyHandle } from './family-handle'
import { IPC_CHANNELS, type IPCResult } from '@shared/contracts/ipc'
import { customerServiceCheckNowSchema, customerServicePrepareSchema, customerServiceStatusListSchema } from '@shared/schemas/customer-service'
import { CUSTOMER_MESSAGE_PLATFORMS, customerMessageMonitor } from '../services/customer-message-monitor'
import { getStore } from '../stores/store-manager'
import { waitForCustomerServiceSessionReady } from '../browser/session-manager'

const handle = familyHandle('电商客服')

function ok<T>(data: T, requestId: string): IPCResult<T> { return { ok: true, data, requestId } }
function fail(code: string, message: string, requestId: string): IPCResult {
  return { ok: false, error: { code, message }, requestId }
}

export function registerCustomerServiceHandlers(): void {
  handle(IPC_CHANNELS.CUSTOMER_SERVICE_PREPARE, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const requestId = randomUUID()
    const parsed = customerServicePrepareSchema.safeParse(raw)
    if (!parsed.success) return fail('INVALID_ARGUMENT', '客服店铺参数不合法', requestId)
    const store = getStore(parsed.data.storeId)
    if (!store) return fail('STORE_NOT_FOUND', '店铺不存在或已删除', requestId)
    const entry = CUSTOMER_MESSAGE_PLATFORMS[store.platform]
    if (!entry) return fail('PLATFORM_UNSUPPORTED', '该店铺平台暂未配置客服页面', requestId)
    try {
      // 先完成该店铺客服独立分区的 UA、权限与代理配置，再由 Renderer 让 webview 导航。
      await waitForCustomerServiceSessionReady(store.id)
      return ok({ storeId: store.id, platform: store.platform, url: entry.url }, requestId)
    } catch (error) {
      if (String((error as Error)?.message || error).includes('STORE_NOT_FOUND')) {
        return fail('STORE_NOT_FOUND', '店铺不存在或已删除', requestId)
      }
      return fail('SESSION_NOT_READY', '客服浏览器会话尚未准备完成，请稍后重试', requestId)
    }
  })

  handle(IPC_CHANNELS.CUSTOMER_SERVICE_STATUS_LIST, (_event: IpcMainInvokeEvent, raw: unknown): IPCResult => {
    const requestId = randomUUID()
    const parsed = customerServiceStatusListSchema.safeParse(raw ?? {})
    if (!parsed.success) return fail('INVALID_ARGUMENT', '客服监控查询参数不合法', requestId)
    try { return ok(customerMessageMonitor.list(parsed.data.storeId, parsed.data.limit), requestId) }
    catch { return fail('INTERNAL_ERROR', '读取客服监控状态失败', requestId) }
  })

  handle(IPC_CHANNELS.CUSTOMER_SERVICE_CHECK_NOW, async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IPCResult> => {
    const requestId = randomUUID()
    const parsed = customerServiceCheckNowSchema.safeParse(raw)
    if (!parsed.success) return fail('INVALID_ARGUMENT', '客服检查店铺参数不合法', requestId)
    try { return ok(await customerMessageMonitor.check(parsed.data.storeId), requestId) }
    catch (error) {
      const code = String((error as Error)?.message || error)
      if (code === 'STORE_NOT_FOUND') return fail('STORE_NOT_FOUND', '店铺不存在或已删除', requestId)
      return fail('INTERNAL_ERROR', '客服消息检查失败', requestId)
    }
  })
}
