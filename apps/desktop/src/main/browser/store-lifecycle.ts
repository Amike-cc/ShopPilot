/**
 * 店铺浏览器的纯生命周期策略。
 *
 * 这里不接触 Electron、数据库或定时器，只记录店铺最近一次使用时间，
 * 并决定哪一家店可以作为温缓存、哪一家已经满足冷休眠条件。副作用由
 * window-manager 负责，这样切店回收策略可以在没有 Electron 的单测中验证。
 */

export const DEFAULT_STORE_WARM_CACHE_LIMIT = 1
export const DEFAULT_STORE_COLD_SLEEP_AFTER_MS = 60_000

export interface StoreLifecycleRecord {
  storeId: string
  openedAt: number
  lastUsedAt: number
  lastDisplayedAt: number | null
  /** 同一毫秒内也能稳定判定最近使用顺序。 */
  sequence: number
}

export interface StoreLifecycleSnapshot extends StoreLifecycleRecord {
  idleMs: number
  warm: boolean
}

export class StoreLifecycleRegistry {
  private readonly records = new Map<string, StoreLifecycleRecord>()
  private sequence = 0

  opened(storeId: string, now = Date.now()): void {
    if (this.records.has(storeId)) return
    this.records.set(storeId, {
      storeId,
      openedAt: now,
      lastUsedAt: now,
      lastDisplayedAt: null,
      sequence: ++this.sequence
    })
  }

  /**
   * 记录一次使用。
   * `displayed` 会进入温缓存排序；后台使用只刷新冷休眠倒计时，
   * 不会把用户从前台切走的店铺错误地变成温缓存。
   */
  used(storeId: string, kind: 'displayed' | 'background', now = Date.now()): void {
    this.opened(storeId, now)
    const record = this.records.get(storeId)!
    record.lastUsedAt = now
    record.sequence = ++this.sequence
    if (kind === 'displayed') record.lastDisplayedAt = now
  }

  forget(storeId: string): void {
    this.records.delete(storeId)
  }

  get(storeId: string): StoreLifecycleRecord | null {
    const record = this.records.get(storeId)
    return record ? { ...record } : null
  }

  getWarmStoreIds(
    displayedStoreId: string | null,
    limit = DEFAULT_STORE_WARM_CACHE_LIMIT
  ): string[] {
    const max = Math.max(0, Math.floor(Number(limit) || 0))
    if (max === 0) return []
    return Array.from(this.records.values())
      .filter(record => record.storeId !== displayedStoreId && record.lastDisplayedAt !== null)
      .sort((a, b) => {
        const at = a.lastDisplayedAt ?? 0
        const bt = b.lastDisplayedAt ?? 0
        return bt - at || b.sequence - a.sequence
      })
      .slice(0, max)
      .map(record => record.storeId)
  }

  isIdle(storeId: string, now = Date.now(), afterMs = DEFAULT_STORE_COLD_SLEEP_AFTER_MS): boolean {
    const record = this.records.get(storeId)
    if (!record) return false
    const threshold = Math.max(0, Number(afterMs) || 0)
    return now - record.lastUsedAt >= threshold
  }

  getColdCandidates(
    displayedStoreId: string | null,
    now = Date.now(),
    afterMs = DEFAULT_STORE_COLD_SLEEP_AFTER_MS,
    blockedStoreIds: ReadonlySet<string> = new Set(),
    warmLimit = DEFAULT_STORE_WARM_CACHE_LIMIT
  ): string[] {
    const warm = new Set(this.getWarmStoreIds(displayedStoreId, warmLimit))
    return Array.from(this.records.values())
      .filter(record => record.storeId !== displayedStoreId)
      .filter(record => !warm.has(record.storeId))
      .filter(record => !blockedStoreIds.has(record.storeId))
      .filter(record => now - record.lastUsedAt >= Math.max(0, Number(afterMs) || 0))
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.sequence - b.sequence)
      .map(record => record.storeId)
  }

  snapshot(now = Date.now(), displayedStoreId: string | null = null, warmLimit = DEFAULT_STORE_WARM_CACHE_LIMIT): StoreLifecycleSnapshot[] {
    const warm = new Set(this.getWarmStoreIds(displayedStoreId, warmLimit))
    return Array.from(this.records.values()).map(record => ({
      ...record,
      idleMs: Math.max(0, now - record.lastUsedAt),
      warm: warm.has(record.storeId)
    }))
  }

  reset(): void {
    this.records.clear()
    this.sequence = 0
  }
}
