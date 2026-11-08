/**
 * 批量登录态检测（2026-11-08）。
 *
 * 为什么需要主进程做：`detectStoreLoginStatus` 读的是**店铺当前标签页**，关着的店铺没有页面，
 * 渲染层自己没法把 N 家店逐一拉起来。这里把「后台打开 → 等页面就绪 → 检测 → 关掉自己开的」
 * 收成一条串行链路，渲染层只负责展示结果。
 *
 * 约束（刻意为之）：
 *   · **串行**：并发拉起多家店会让内存瞬间翻倍，也会和任务引擎抢同一个平台会话；
 *   · **只关自己开的**：用户本来就开着的店铺不关（那是他正在看的页面）；
 *   · **拿不到证据就如实报 UNKNOWN/SKIPPED**，不猜"大概没登录"。
 */

import { detectStoreLoginStatus } from '../platform-adapters/platform-login-service'
import { closeStoreBrowser, getOpenStoreIds, openStoreBrowser, waitForStoreWebContents } from '../browser/window-manager'
import * as StoreManager from '../stores/store-manager'
import { logMain } from './logger'

/** 单次批量最多查几家：再多就该分批了，否则一次点击会卡住几分钟 */
export const BATCH_LOGIN_MAX_STORES = 20
/** 为某家店拉起页面并等 guest 就绪的上限 */
export const BATCH_LOGIN_PAGE_TIMEOUT_MS = 12_000

export type BatchLoginStatus = 'ONLINE' | 'LOGIN_REQUIRED' | 'VERIFY_REQUIRED' | 'UNKNOWN' | 'ERROR' | 'SKIPPED'

export interface BatchLoginItem {
  storeId: string
  storeName: string
  platform: string
  status: BatchLoginStatus
  reasonCode: string | null
  safeMessage: string | null
  /** status=SKIPPED 时的具体原因（页面没起来 / 店铺不存在） */
  skippedReason: 'PAGE_NOT_READY' | 'STORE_NOT_FOUND' | null
}

export interface BatchLoginResult {
  items: BatchLoginItem[]
}

/**
 * 逐店检测登录态。
 * @param storeIds 目标店铺；重复项会被去掉，超过 BATCH_LOGIN_MAX_STORES 的部分**不查**（返回值里没有它们）
 */
export async function batchCheckStoreLogin(
  storeIds: string[],
  opts: { pageTimeoutMs?: number } = {}
): Promise<BatchLoginResult> {
  const ids: string[] = []
  for (const raw of Array.isArray(storeIds) ? storeIds : []) {
    const id = String(raw || '').trim()
    if (id && !ids.includes(id)) ids.push(id)
  }
  const targets = ids.slice(0, BATCH_LOGIN_MAX_STORES)
  const pageTimeoutMs = Math.max(1000, Number(opts.pageTimeoutMs) || BATCH_LOGIN_PAGE_TIMEOUT_MS)
  const items: BatchLoginItem[] = []

  for (const storeId of targets) {
    const store = (() => { try { return StoreManager.getStore(storeId) } catch { return null } })()
    if (!store) {
      items.push({
        storeId, storeName: storeId, platform: '', status: 'SKIPPED',
        reasonCode: null, safeMessage: null, skippedReason: 'STORE_NOT_FOUND'
      })
      continue
    }

    const openedByUs = !getOpenStoreIds().includes(storeId)
    try {
      if (openedByUs) openStoreBrowser(storeId, { display: false })
      try {
        await waitForStoreWebContents(storeId, pageTimeoutMs)
      } catch {
        items.push({
          storeId, storeName: store.name, platform: store.platform, status: 'SKIPPED',
          reasonCode: null, safeMessage: null, skippedReason: 'PAGE_NOT_READY'
        })
        continue
      }
      const result = await detectStoreLoginStatus(storeId)
      items.push({
        storeId,
        storeName: store.name,
        platform: store.platform,
        status: result.status as BatchLoginStatus,
        reasonCode: result.reasonCode ?? null,
        safeMessage: result.safeMessage ?? null,
        skippedReason: null
      })
    } catch (error) {
      const message = String((error as Error)?.message || error).slice(0, 160)
      logMain('warn', `[batch-login] 检测失败 store=${storeId}: ${message}`)
      items.push({
        storeId, storeName: store.name, platform: store.platform, status: 'ERROR',
        reasonCode: null, safeMessage: message, skippedReason: null
      })
    } finally {
      // 只关自己开的：用户开着的店铺页面不能因为"批量检测"被收走
      if (openedByUs) {
        try { closeStoreBrowser(storeId) } catch { /* 已关闭 */ }
      }
    }
  }

  logMain('info', `[batch-login] 完成 checked=${items.length}/${limitsText(targets.length, ids.length)}`)
  return { items }
}

function limitsText(checked: number, requested: number): string {
  return requested > checked ? `${checked}（请求 ${requested}，上限 ${BATCH_LOGIN_MAX_STORES}）` : String(checked)
}
