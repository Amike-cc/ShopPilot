/**
 * 软件自检（2026-10-16 新增，设置中心「诊断软件」）。
 *
 * 与已有三项诊断的分工（避免出现"第三个诊断入口各自演化"）：
 *   · 诊断包导出：把事实打包给支持人员，**离线**看；
 *   · 内存快照 / 视图体检：回答"占了多少内存""哪个店铺页面卡住了"；
 *   · 本文件：在本机**当场**回答"这个软件现在有没有问题"——每一项都给事实 + 可执行的下一步。
 *
 * 三条硬约束：
 *   ① 单项失败不能拖垮整份报告（`check()` 把异常变成该项的 error，其余照跑）；
 *   ② 只读：不写数据库、不改设置、不发网络请求（唯一写动作是"可写性探针"建一个临时文件再删）；
 *   ③ 不猜：拿不到的就说拿不到（detail 里写"读取失败：<原因>"），不拿"看起来正常"顶上。
 *
 * 已知代价（2026-10-16 反向审查确认，属可接受）：`PRAGMA quick_check` 与缓存目录的同步
 * 递归遍历都跑在主进程，大库/多店铺时会占用主线程若干秒。诊断是**用户点一下才跑**的动作，
 * 渲染层是独立进程、按钮照常显示"诊断中…"，不会白屏；与既有「读取店铺分区占用」同一量级。
 */
import { app, safeStorage, BrowserWindow } from 'electron'
import { existsSync, statSync, statfsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import {
  formatBytesShort,
  type SoftwareCheckItem,
  type SoftwareCheckStatus,
  type SoftwareDiagnosticsReport
} from '@shared/software-diagnostics'
import { getDatabase, getDatabasePath } from '../db/database'
import { listStores } from '../stores/store-manager'
import { listProxies } from '../browser/proxy-manager'
import { getOpenStoreIds, getStoreTabs } from '../browser/window-manager'
import { lastBackupAt, listBackups } from './backup-manager'
import { logFile } from './logger'
import { measureAppCacheBytes, measureBrowserCacheBytes } from './cache-cleanup'

const GB = 1024 * 1024 * 1024
/** 磁盘剩余空间阈值：低于 warn 提示清理，低于 error 直接判异常（写库会失败）。 */
const DISK_WARN_BYTES = 2 * GB
const DISK_ERROR_BYTES = 0.5 * GB
/** 备份超过这个天数没做就提示（不是错误：用户可能刚清理过）。 */
const BACKUP_STALE_DAYS = 14

interface CheckOutcome {
  status?: SoftwareCheckStatus
  detail: string
  hint?: string
}

/** 跑一项检查：抛异常 = 该项 error（detail 带真实原因），其余检查继续。 */
async function check(
  key: string,
  label: string,
  run: () => CheckOutcome | Promise<CheckOutcome>
): Promise<SoftwareCheckItem> {
  try {
    const outcome = await run()
    return {
      key,
      label,
      status: outcome.status ?? 'ok',
      detail: outcome.detail,
      ...(outcome.hint ? { hint: outcome.hint } : {})
    }
  } catch (error) {
    const reason = String((error as Error)?.message || error || '').trim()
    return { key, label, status: 'error', detail: `检查未完成：${reason ? reason.slice(0, 160) : '未知原因'}` }
  }
}

/**
 * 写一个探针文件再删掉：验证"这个目录现在真的能写"（只读判断权限位并不可靠）。
 * 删除放在 finally：写成功但删失败时不能把 `.write-probe-*` 留在用户数据目录里。
 */
function assertWritable(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const probe = join(dir, `.write-probe-${Date.now()}`)
  try {
    writeFileSync(probe, 'ok')
  } finally {
    try { unlinkSync(probe) } catch { /* 文件可能因写入失败而不存在，忽略 */ }
  }
}

export async function runSoftwareDiagnostics(): Promise<SoftwareDiagnosticsReport> {
  const items: SoftwareCheckItem[] = []

  items.push(await check('runtime', '版本与运行时', () => ({
    detail: `ShopPilot ${app.getVersion()} · Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node} · ${process.platform}/${process.arch}`
  })))

  items.push(await check('database', '数据库', () => {
    const db = getDatabase()
    const quick = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
    const verdict = String(Object.values(quick || {})[0] ?? 'unknown')
    const schemaVersion = (db.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v?: number } | undefined)?.v ?? 0
    const size = existsSync(getDatabasePath()) ? statSync(getDatabasePath()).size : 0
    const healthy = verdict.toLowerCase() === 'ok'
    return {
      status: healthy ? 'ok' : 'error',
      detail: `完整性 ${verdict} · 迁移版本 v${schemaVersion} · ${formatBytesShort(size)}`,
      hint: healthy ? undefined : '数据库损坏时请用「备份与恢复」里的最近备份恢复，并导出诊断包反馈'
    }
  }))

  items.push(await check('dataDir', '数据目录可写', () => {
    assertWritable(app.getPath('userData'))
    return { detail: '可写' }
  }))

  items.push(await check('disk', '磁盘剩余空间', () => {
    const stats = statfsSync(app.getPath('userData'))
    const freeBytes = Number(stats.bsize) * Number(stats.bavail)
    const status: SoftwareCheckStatus = freeBytes < DISK_ERROR_BYTES ? 'error' : freeBytes < DISK_WARN_BYTES ? 'warn' : 'ok'
    return {
      status,
      detail: `剩余 ${formatBytesShort(freeBytes)}`,
      hint: status === 'ok' ? undefined : '清理浏览器缓存或挪走旧的诊断包/导出文件后再试'
    }
  }))

  items.push(await check('logs', '日志目录', () => {
    // logFile() 会顺带确保日志目录存在（logger.logDir 的 mkdirSync）并做一次 14 天保留清理——
    // 后者每进程只跑一次、应用启动写日志时就已完成，不是本检查引入的写动作
    const file = logFile()
    const dir = dirname(file)
    assertWritable(dir)
    const size = existsSync(file) ? statSync(file).size : 0
    return { detail: `可写 · 今日日志 ${formatBytesShort(size)}` }
  }))

  items.push(await check('cache', '缓存占用', () => {
    const appBytes = measureAppCacheBytes()
    const browser = measureBrowserCacheBytes()
    const unreadable = browser.skipped > 0 ? `，${browser.skipped} 项不可读` : ''
    return {
      detail: `可清理缓存：软件 ${formatBytesShort(appBytes)} · 浏览器 ${formatBytesShort(browser.bytes)}（${browser.partitions} 个店铺分区${unreadable}）`,
      hint: '缓存过大时可在上方「缓存清理」里分别清理（都不影响登录态）'
    }
  }))

  items.push(await check('encryption', '系统加密', () => {
    const available = safeStorage.isEncryptionAvailable()
    return {
      status: available ? 'ok' : 'warn',
      detail: available ? '可用（AI Key 与代理凭据可加密存储）' : '不可用',
      hint: available ? undefined : '系统加密不可用时，AI Key 与代理凭据无法安全落盘；请检查系统凭据服务后重启应用'
    }
  }))

  items.push(await check('proxies', '代理配置', () => {
    const proxies = listProxies()
    const failed = proxies.filter(proxy => String(proxy.status) === 'error')
    return {
      status: failed.length > 0 ? 'warn' : 'ok',
      detail: proxies.length === 0 ? '未配置代理' : `${proxies.length} 条，其中 ${failed.length} 条最近检测失败`,
      hint: failed.length > 0 ? `在店铺浏览器的「环境」面板里复测：${failed.slice(0, 3).map(p => p.label || `${p.host}:${p.port}`).join('、')}` : undefined
    }
  }))

  items.push(await check('stores', '店铺与视图', () => {
    const stores = listStores()
    const open = getOpenStoreIds()
    let attached = 0
    for (const storeId of open) {
      attached += getStoreTabs(storeId).filter(tab => tab.guestAttached === true).length
    }
    return {
      detail: `${stores.length} 家店铺 · 已打开 ${open.length} 家 · 已挂载视图 ${attached} 个`,
      hint: open.length > 6 ? '同时打开的店铺越多内存占用越高，可用「视图体检」看每个页面是否卡住' : undefined
    }
  }))

  items.push(await check('backups', '数据库备份', () => {
    const latest = lastBackupAt()
    const total = listBackups().length
    if (!latest) {
      return { status: 'warn', detail: '还没有任何备份', hint: '用上方「立即备份数据库」建一个；数据库损坏时这是唯一的退路' }
    }
    const days = Math.floor((Date.now() - latest) / (24 * 60 * 60 * 1000))
    const stale = days >= BACKUP_STALE_DAYS
    return {
      status: stale ? 'warn' : 'ok',
      detail: `共 ${total} 份，最近 ${days === 0 ? '今天' : `${days} 天前`}`,
      hint: stale ? `最近一次备份已超过 ${BACKUP_STALE_DAYS} 天` : undefined
    }
  }))

  items.push(await check('window', '应用窗口', () => {
    const windows = BrowserWindow.getAllWindows().filter(win => !win.isDestroyed())
    return {
      status: windows.length > 0 ? 'ok' : 'error',
      detail: `${windows.length} 个窗口（含独立店铺窗口）`,
      hint: windows.length > 0 ? undefined : '没有可用窗口说明界面进程已退出，请重启应用'
    }
  }))

  return { capturedAt: Date.now(), appVersion: app.getVersion(), items }
}
