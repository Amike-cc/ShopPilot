/**
 * 缓存清理（2026-10-16 新增）：设置中心的「清除软件缓存」与「清除浏览器缓存」。
 *
 * 两个动作的边界必须划清楚，否则用户分不清该点哪个（也和已有的「店铺分区存储 → 清理」重叠）：
 *
 *   · 清除软件缓存：只清**应用自己**（默认会话）的界面缓存——HTTP 缓存、代码缓存、
 *     着色器缓存。不碰任何店铺数据、不碰数据库/登录态/备份/日志。
 *   · 清除浏览器缓存：清**所有店铺分区**的网页缓存（同为上面三类），
 *     **不动 Cookie、不动 localStorage/IndexedDB**——比「店铺分区存储」里的整店清理更轻，
 *     不需要重新登录、也不会丢平台的本地草稿。
 *
 * 为什么用官方 API 而不是删目录：session 活着时缓存文件被 Chromium 持有锁，
 * 手删会让内存里的元数据与磁盘脱同步（partition-usage.ts 顶部已写明同一条理由）。
 *
 * 为什么自己数磁盘差值：`session.getCacheSize()` 只覆盖 HTTP 缓存，代码缓存/着色器缓存
 * 不在其中；只报它就等于把"清了但没算"的部分吞掉。这里按缓存目录清理前后的真实差值统计，
 * 差值可能小于清理前占用（Chromium 保留内存映射文件），这是事实，不做修饰。
 */
import { app, session, type Session } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import {
  formatBytesShort,
  type CacheClearResult
} from '@shared/software-diagnostics'
import { partitionDirName, sumDirectorySize } from '../browser/partition-usage'
import { getStorePartition } from '../browser/session-manager'
import { getOpenStoreIds } from '../browser/window-manager'
import { listStores } from '../stores/store-manager'
import { auditRequestId, writeAudit } from './audit-logger'
import { logMain } from './logger'

/** Chromium 在 userData（或分区目录）下使用、且**我们能通过 Electron API 清掉**的缓存目录。
 *
 * 只统计这三类（measured == cleared）：Chromium 还会写 DawnGraphiteCache / DawnWebGPUCache /
 * Shared Dictionary，但 Electron 没有对应的清理入口；把它们算进"缓存占用"就会出现
 * "诊断显示占用 300 MB、清完却说没有可释放的缓存"这种自相矛盾（2026-10-16 反向审查指出）。 */
const CLEARABLE_CACHE_DIRS = ['Cache', 'Code Cache', 'GPUCache']

/** 缓存目录合计字节（不存在的目录直接跳过，不制造"跳过"噪音）。 */
function sumCacheDirs(root: string): { bytes: number; skipped: number } {
  let bytes = 0
  let skipped = 0
  for (const name of CLEARABLE_CACHE_DIRS) {
    const dir = join(root, name)
    if (!existsSync(dir)) continue
    const measured = sumDirectorySize(dir)
    bytes += measured.bytes
    skipped += measured.skipped
  }
  return { bytes, skipped }
}

function describeError(error: unknown): string {
  return String((error as Error)?.message || error || '未知原因').slice(0, 120)
}

/** 跑一步清理：成功记进 items，失败记进 failures（**吞掉失败等于骗用户**）。 */
async function runStep(
  items: string[],
  failures: string[],
  label: string,
  action: () => Promise<unknown>
): Promise<boolean> {
  try {
    await action()
    items.push(label)
    return true
  } catch (error) {
    failures.push(`${label}：${describeError(error)}`)
    return false
  }
}

/** 三类缓存的清理动作（默认会话与店铺分区共用同一套）。 */
async function clearSessionCaches(ses: Session, items: string[], failures: string[]): Promise<void> {
  await runStep(items, failures, 'HTTP 缓存', () => ses.clearCache())
  // 代码缓存/着色器缓存：老版本 Electron 没有 clearCodeCaches，失败不当作"没清"但如实记
  await runStep(items, failures, '代码缓存（JS/WASM）', () => ses.clearCodeCaches({}))
  await runStep(items, failures, '着色器缓存', () => ses.clearStorageData({ storages: ['shadercache'] }))
}

/** 应用界面缓存占用（软件缓存；默认会话）。 */
export function measureAppCacheBytes(): number {
  return sumCacheDirs(app.getPath('userData')).bytes
}

/** 所有已存在店铺分区的网页缓存占用（只统计磁盘上已经有的分区，不为了统计去创建它）。 */
export function measureBrowserCacheBytes(): { bytes: number; skipped: number; partitions: number } {
  const root = join(app.getPath('userData'), 'Partitions')
  if (!existsSync(root)) return { bytes: 0, skipped: 0, partitions: 0 }
  let bytes = 0
  let skipped = 0
  let partitions = 0
  for (const store of listStores()) {
    const dirName = partitionDirName(getStorePartition(store.id))
    if (!dirName) continue
    const dir = join(root, dirName)
    if (!existsSync(dir)) continue
    partitions += 1
    const measured = sumCacheDirs(dir)
    bytes += measured.bytes
    skipped += measured.skipped
  }
  return { bytes, skipped, partitions }
}

/**
 * 清除软件缓存（默认会话的界面缓存）。
 * 红线：不碰数据库、Cookie、凭据、店铺分区、备份、日志。
 * `requestId` 由 IPC 层传入，用于把"这一次点击"与审计记录对齐（audit-logger 的调用约定）。
 */
export async function clearAppCache(requestId = ''): Promise<CacheClearResult> {
  const before = measureAppCacheBytes()
  const items: string[] = []
  const failures: string[] = []
  await clearSessionCaches(session.defaultSession, items, failures)
  const after = measureAppCacheBytes()
  const freedBytes = Math.max(0, before - after)
  // 有失败项就写 failure：审计里报成功、页面上报失败，是最难查的一类自相矛盾
  writeAudit('maintenance.cache.clear', failures.length > 0 ? 'failure' : 'success', {
    requestId: auditRequestId(requestId, `scope=app,freed=${freedBytes},failures=${failures.length}`)
  })
  logMain('info', `[cache] 软件缓存清理完成 freed=${formatBytesShort(freedBytes)} items=${items.length} failures=${failures.length}`)
  return { scope: 'app', freedBytes, items, failures, stores: [], skippedStores: 0 }
}

/**
 * 清除浏览器缓存（所有店铺分区的网页缓存，**Cookie 与站点存储保留**）。
 *
 * 用 `session.fromPartition(partition, { cache: true })` 而不是 `getStoreSession`：
 * 后者会为每个店铺建立运行时 session（挂代理配置、进 activeSessions），
 * 仅仅为了清缓存去唤醒所有店铺的运行时，代价与副作用都不对。
 */
export async function clearBrowserCaches(requestId = ''): Promise<CacheClearResult> {
  const items: string[] = []
  const failures: string[] = []
  const stores: CacheClearResult['stores'] = []
  const partitionRoot = join(app.getPath('userData'), 'Partitions')
  const openStoreIds = new Set(getOpenStoreIds())
  let skippedStores = 0
  let freedBytes = 0

  for (const store of listStores()) {
    const partition = getStorePartition(store.id)
    const dirName = partitionDirName(partition)
    const dir = dirName ? join(partitionRoot, dirName) : ''
    const hasData = !!dir && existsSync(dir)
    // 从未打开过的店铺没有分区数据：跳过（不为了清缓存去创建分区目录）
    if (!hasData && !openStoreIds.has(store.id)) {
      skippedStores += 1
      continue
    }
    const before = hasData ? sumCacheDirs(dir).bytes : 0
    const ses = session.fromPartition(partition, { cache: true })
    const storeItems: string[] = []
    const storeFailures: string[] = []
    await clearSessionCaches(ses, storeItems, storeFailures)
    for (const item of storeItems) if (!items.includes(item)) items.push(item)
    for (const failure of storeFailures) failures.push(`${store.name}：${failure}`)
    const after = hasData ? sumCacheDirs(dir).bytes : 0
    const storeFreed = Math.max(0, before - after)
    freedBytes += storeFreed
    stores.push({ storeId: store.id, storeName: store.name, freedBytes: storeFreed })
  }

  writeAudit('maintenance.cache.clear', failures.length > 0 ? 'failure' : 'success', {
    requestId: auditRequestId(requestId, `scope=browser,stores=${stores.length},freed=${freedBytes},failures=${failures.length}`)
  })
  logMain('info', `[cache] 浏览器缓存清理完成 stores=${stores.length} skipped=${skippedStores} freed=${formatBytesShort(freedBytes)} failures=${failures.length}`)
  return { scope: 'browser', freedBytes, items, failures, stores, skippedStores }
}
