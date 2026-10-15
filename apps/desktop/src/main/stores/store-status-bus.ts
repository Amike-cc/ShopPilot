/**
 * 店铺状态变化的进程内事件总线（2026-10-15 修复）
 *
 * 为什么单独成模块：此前"监听集合 + 注册函数"定义在 store-manager.ts，而
 * window-manager.ts 在**模块顶层**注册监听，同时 store-manager 又 import window-manager——
 * 两个模块互相 import 成环。在 vitest 5 / vite 7 的模块求值顺序下，window-manager 顶层调用
 * 注册函数时会走到尚未初始化的 `storeStatusListeners`，抛
 * "Cannot access 'storeStatusListeners' before initialization"（9 个测试套件加载失败）。
 *
 * 把这段无依赖的"总线"挪到叶子模块后：import 环在求值顺序上不再有歧义，
 * 注册与广播都改经这里。保持与旧 API 同名（onStoreStatusChanged），调用方零改动。
 */

import type { StoreStatus } from '@shared/enums/store-status'

export type StoreStatusListener = (storeId: string, status: StoreStatus) => void

const storeStatusListeners = new Set<StoreStatusListener>()

/** 供主窗口把 Main 的状态变化安全地推送给 Renderer。返回取消订阅函数。 */
export function onStoreStatusChanged(listener: StoreStatusListener): () => void {
  storeStatusListeners.add(listener)
  return () => storeStatusListeners.delete(listener)
}

/** 广播店铺状态变化（由 store-manager 在状态落库成功后调用）。单个订阅者异常不影响其它订阅者。 */
export function emitStoreStatusChanged(storeId: string, status: StoreStatus): void {
  storeStatusListeners.forEach((listener) => {
    try {
      listener(storeId, status)
    } catch {
      /* 单个订阅者失败不能影响状态落库 */
    }
  })
}
