import { reactive } from 'vue'

export interface StoreCheckResult<T> {
  ok: boolean
  data?: T
  error?: { message?: string }
}

/** Keeps customer-service checks and failures inside the matching store workbench. */
export function createStoreScopedCheckController<T>(
  request: (storeId: string) => Promise<StoreCheckResult<T>>,
  onSuccess: (storeId: string, data: T) => void
) {
  const checkingStoreIds = reactive(new Set<string>())
  const errors = reactive(new Map<string, string>())

  async function check(storeId: string): Promise<void> {
    if (!storeId || checkingStoreIds.has(storeId)) return

    checkingStoreIds.add(storeId)
    errors.delete(storeId)
    try {
      const result = await request(storeId)
      if (!result.ok) {
        errors.set(storeId, result.error?.message || '客服消息状态检查失败')
        return
      }
      if (result.data !== undefined) onSuccess(storeId, result.data)
    } catch {
      errors.set(storeId, '客服消息状态检查失败')
    } finally {
      checkingStoreIds.delete(storeId)
    }
  }

  return { checkingStoreIds, errors, check }
}
