/**
 * 站点本地存储的采集与恢复（会话包 v2）。
 *
 * 为什么不走 CDP：指纹注入器已经占着 `webContents.debugger`，这里再 attach 会让它降级成
 * 「每次导航 executeJavaScript」的兜底路径——为了导一次会话包，把日常指纹注入质量赔进去不值。
 * 所以统一用固定脚本 + `executeJavaScript`，脚本内容不含任何用户输入拼接（值一律 JSON 序列化）。
 *
 * 页面从哪来：`acquireBackgroundPage(storeId, { purpose })` 的**隐藏窗口页**——
 * 同店铺分区、不占用户标签、不进标签栏、不动用户正在看的页面；用完 release。
 * 绝不复用采集专用页（那可能正在被任务引擎用着）。
 *
 * 边界（如实声明）：只处理 localStorage；IndexedDB / CacheStorage / Service Worker 不覆盖。
 * 读不到就记进 failedOrigins，不猜、不补。
 */

import type { WebContents } from 'electron'
import { acquireBackgroundPage, releaseBackgroundPages } from '../browser/background-page'
import { normalizeStorageOrigin, sanitizeStorageEntries, type SessionStorageEntry } from '@shared/session-storage'
import { logMain } from './logger'

const PURPOSE = 'session-storage'
/** 单个站点等待文档就绪的上限（平台后台首页常常带重定向与鉴权跳转） */
const ORIGIN_TIMEOUT_MS = 9_000
/** 整次采集/恢复的总预算：超过就带着已有结果收工，不把导出流程拖成"卡住" */
const TOTAL_BUDGET_MS = 35_000

export interface CollectStorageResult {
  entries: SessionStorageEntry[]
  items: number
  skippedItems: number
  skippedOrigins: number
  failedOrigins: string[]
  /** 没能跑起来的原因；正常完成时为 null */
  reason: 'PAGE_NOT_READY' | 'TIMEOUT' | null
}

export interface RestoreStorageResult {
  origins: number
  items: number
  failedOrigins: string[]
  reason: 'PAGE_NOT_READY' | 'TIMEOUT' | null
}

/** 读当前文档的 localStorage（固定脚本，不做字符串拼接）。 */
async function readLocalStorage(wc: WebContents): Promise<{ origin: string; items: Array<[string, string]> } | null> {
  try {
    const result = await wc.executeJavaScript(`(() => {
      const items = []
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const name = localStorage.key(i)
          if (name == null) continue
          items.push([name, localStorage.getItem(name) == null ? '' : localStorage.getItem(name)])
        }
        return { ok: true, origin: String(location.origin || ''), items }
      } catch (error) {
        return { ok: false, origin: String(location.origin || ''), items: [], error: String((error && error.message) || error) }
      }
    })()`, false)
    if (!result || result.ok !== true) return null
    return { origin: String(result.origin || ''), items: Array.isArray(result.items) ? result.items : [] }
  } catch {
    return null
  }
}

/** 等一次文档就绪；`dom-ready` 比 `did-finish-load` 早，且此时 location/localStorage 已可用。 */
function waitForDocument(wc: WebContents, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { wc.removeListener('dom-ready', onReady) } catch { /* 已销毁 */ }
      try { wc.removeListener('did-fail-load', onFail) } catch { /* 已销毁 */ }
      resolve(ok)
    }
    const onReady = () => finish(true)
    const onFail = (_e: unknown, _code: number, _desc: string, _url: string, isMainFrame: boolean) => {
      if (isMainFrame) finish(false)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    wc.on('dom-ready', onReady)
    wc.on('did-fail-load', onFail)
  })
}

/**
 * 导航到该 origin 的一个文档并确认没被跳到别处。
 * 跳走（登录页/统一鉴权）时 `location.origin` 会变，此时读到的存储属于另一个 origin，
 * 硬塞进包里就是"看起来导出了、恢复时写错站点"，所以按失败计入。
 */
async function loadOrigin(wc: WebContents, origin: string, timeoutMs: number): Promise<boolean> {
  if (wc.isDestroyed()) return false
  const wait = waitForDocument(wc, timeoutMs)
  try {
    await wc.loadURL(`${origin}/`)
  } catch { /* 失败由 waitForDocument 的 did-fail-load 兜住 */ }
  const ok = await wait
  if (!ok) return false
  const current = (() => { try { return normalizeStorageOrigin(wc.getURL()) } catch { return null } })()
  return current === origin
}

/**
 * 采集指定 origin 的 localStorage。
 * `origins` 由调用方按平台档案/店铺地址推导，本函数只做规范化、去重与限额。
 */
export async function collectStoreLocalStorage(storeId: string, origins: string[]): Promise<CollectStorageResult> {
  const candidates: string[] = []
  for (const raw of origins) {
    const origin = normalizeStorageOrigin(raw)
    if (origin && !candidates.includes(origin)) candidates.push(origin)
  }
  if (!candidates.length) {
    return { entries: [], items: 0, skippedItems: 0, skippedOrigins: 0, failedOrigins: [], reason: null }
  }

  let handle: ReturnType<typeof acquireBackgroundPage>
  try {
    handle = acquireBackgroundPage(storeId, { purpose: PURPOSE })
  } catch (error) {
    logMain('warn', `[session-storage] 后台页创建失败 store=${storeId}: ${String((error as Error)?.message || error).slice(0, 160)}`)
    return { entries: [], items: 0, skippedItems: 0, skippedOrigins: 0, failedOrigins: candidates, reason: 'PAGE_NOT_READY' }
  }

  const collected: SessionStorageEntry[] = []
  const failedOrigins: string[] = []
  const deadline = Date.now() + TOTAL_BUDGET_MS
  let reason: CollectStorageResult['reason'] = null

  try {
    const wc = handle.webContents
    if (!wc || wc.isDestroyed()) {
      return { entries: [], items: 0, skippedItems: 0, skippedOrigins: 0, failedOrigins: candidates, reason: 'PAGE_NOT_READY' }
    }
    for (const origin of candidates) {
      if (Date.now() >= deadline) { reason = 'TIMEOUT'; break }
      const loaded = await loadOrigin(wc, origin, Math.min(ORIGIN_TIMEOUT_MS, Math.max(1000, deadline - Date.now())))
      if (!loaded) { failedOrigins.push(origin); continue }
      const snapshot = await readLocalStorage(wc)
      if (!snapshot || snapshot.origin !== origin) { failedOrigins.push(origin); continue }
      collected.push({ origin, items: snapshot.items.map(([name, value]) => ({ name, value })) })
    }
  } finally {
    try { releaseBackgroundPages(storeId, PURPOSE) } catch { /* 已销毁 */ }
  }

  const clean = sanitizeStorageEntries(collected)
  logMain('info', `[session-storage] 采集完成 store=${storeId} origins=${clean.entries.length}/${candidates.length} items=${clean.items} skipped=${clean.skippedItems} failed=${failedOrigins.length}`)
  return {
    entries: clean.entries,
    items: clean.items,
    skippedItems: clean.skippedItems,
    skippedOrigins: clean.skippedOrigins,
    failedOrigins,
    reason
  }
}

/** 把值安全地嵌进固定脚本：JSON 序列化 + 转义 JS 字符串里非法/易错的 Unicode 行分隔符。 */
function toScriptLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * 恢复本地存储：逐 origin 导航后按 key 覆盖写入。
 *
 * 语义是**合并覆盖**，不是清空重建：只写包里有的键，站点自身的其它键保持不动
 * （清空会把平台写入的临时标记一起删掉，反而更容易触发风控）。
 */
export async function restoreStoreLocalStorage(storeId: string, entries: SessionStorageEntry[]): Promise<RestoreStorageResult> {
  const clean = sanitizeStorageEntries(entries)
  if (!clean.entries.length) return { origins: 0, items: 0, failedOrigins: [], reason: null }

  let handle: ReturnType<typeof acquireBackgroundPage>
  try {
    handle = acquireBackgroundPage(storeId, { purpose: PURPOSE })
  } catch (error) {
    logMain('warn', `[session-storage] 恢复用后台页创建失败 store=${storeId}: ${String((error as Error)?.message || error).slice(0, 160)}`)
    return { origins: 0, items: 0, failedOrigins: clean.entries.map(entry => entry.origin), reason: 'PAGE_NOT_READY' }
  }

  let origins = 0
  let items = 0
  const failedOrigins: string[] = []
  const deadline = Date.now() + TOTAL_BUDGET_MS
  let reason: RestoreStorageResult['reason'] = null

  try {
    const wc = handle.webContents
    if (!wc || wc.isDestroyed()) {
      return { origins: 0, items: 0, failedOrigins: clean.entries.map(entry => entry.origin), reason: 'PAGE_NOT_READY' }
    }
    for (const entry of clean.entries) {
      if (Date.now() >= deadline) { reason = 'TIMEOUT'; break }
      const loaded = await loadOrigin(wc, entry.origin, Math.min(ORIGIN_TIMEOUT_MS, Math.max(1000, deadline - Date.now())))
      if (!loaded) { failedOrigins.push(entry.origin); continue }
      const pairs = entry.items.map(item => [item.name, item.value] as [string, string])
      try {
        const written = await wc.executeJavaScript(`(() => {
          const items = ${toScriptLiteral(pairs)}
          let written = 0
          for (let i = 0; i < items.length; i++) {
            try { localStorage.setItem(items[i][0], items[i][1]); written++ } catch (error) { /* 配额/被禁：按实际写入数计 */ }
          }
          return { origin: String(location.origin || ''), written }
        })()`, false)
        if (!written || written.origin !== entry.origin) { failedOrigins.push(entry.origin); continue }
        origins++
        items += Number(written.written) || 0
      } catch {
        failedOrigins.push(entry.origin)
      }
    }
  } finally {
    try { releaseBackgroundPages(storeId, PURPOSE) } catch { /* 已销毁 */ }
  }

  logMain('info', `[session-storage] 恢复完成 store=${storeId} origins=${origins}/${clean.entries.length} items=${items} failed=${failedOrigins.length}`)
  return { origins, items, failedOrigins, reason }
}
