/**
 * 后台服务装配：应用锁 IPC 门禁 / 代理健康巡检 / 空闲自动锁定
 * - 门禁：锁定态拒绝一切业务通道（白名单仅解锁与状态查询），§189
 * - 巡检：只复检并广播 proxy:healthChanged，**绝不自动切换或静默降级**，§8.1/§13
 */

import { ipcMain, powerMonitor } from 'electron'
import { randomUUID } from 'crypto'
import { IPC_CHANNELS, EVENT_CHANNELS } from '@shared/contracts/ipc'
import type { IPCResult } from '@shared/contracts/ipc'
import * as Security from './security-manager'
import * as BackupManager from './backup-manager'
import * as RetentionService from './retention'
import { logMain } from './logger'
import * as ProxyManager from '../browser/proxy-manager'
import { emitToRenderer, onStoreBrowserOpened } from '../browser/window-manager'
import { startSalesMetricsScheduler } from '../sales-metrics/sales-metrics-scheduler'

const SWEEP_INTERVAL_MS = 5 * 60 * 1000
const STALE_MS = 10 * 60 * 1000
/** 维护任务（自动备份 + 数据保留策略）的判定间隔：真正的节流在各自内部（备份 24h 一次） */
const MAINTENANCE_INTERVAL_MS = 6 * 3600 * 1000
/** 启动后多久做第一次维护：避开启动高峰（迁移 + 会话恢复 + 首屏渲染都在抢主线程） */
const MAINTENANCE_FIRST_DELAY_MS = 90 * 1000
let maintenanceTimer: NodeJS.Timeout | null = null

export function installLockGate(): void {
  const ALLOW_WHEN_LOCKED = new Set<string>([
    IPC_CHANNELS.SECURITY_UNLOCK,
    IPC_CHANNELS.SECURITY_STATUS,
    // 锁屏界面本身依赖的通道：解锁/状态查询 + 标题栏锁定底色（窗口装饰不是业务通道）。
    // 设置/移除/锁定主密码此前在 handler 上标了 allowWhenLocked 却被这里拦成 APP_LOCKED
    // （两层白名单不一致 = 锁屏死锁）。锁定态放行它们是安全的：setMasterPassword 在已设
    // 密码时必须先验证旧密码、removeMasterPassword 必须验证主密码、lockApp 幂等 no-op。
    IPC_CHANNELS.SECURITY_SET_PASSWORD,
    IPC_CHANNELS.SECURITY_REMOVE_PASSWORD,
    IPC_CHANNELS.SECURITY_LOCK,
    IPC_CHANNELS.WINDOW_SET_TITLEBAR_OVERLAY
  ])
  const orig = ipcMain.handle.bind(ipcMain)
  // 所有在注册期的通道统一包一层锁定门禁（业务代码零改动）
  ;(ipcMain as any).handle = (channel: string, listener: any) => {
    if (ALLOW_WHEN_LOCKED.has(channel)) { orig(channel, listener); return }
    orig(channel, async (e: any, ...args: any[]): Promise<IPCResult> => {
      if (Security.isAppLocked()) {
        return { ok: false, error: { code: 'APP_LOCKED', message: '应用已锁定，请先解锁' }, requestId: randomUUID() }
      }
      return listener(e, ...args)
    })
  }
}

function healthEmit(payload: unknown): void {
  emitToRenderer(EVENT_CHANNELS.PROXY_HEALTH_CHANGED, payload)
}

export function startBackgroundServices(): void {
  // 经营指标是只读采集，按店铺独立每 10 分钟运行；解析失败只记录状态，
  // 不会进入需要人工确认的通用任务队列。
  startSalesMetricsScheduler()
  // 备份保留策略（§28：最近 7 个）——此前 pruneBackups 从未被调用，backups 目录只增不减；
  // 启动时收口一次（restoreBackup 结束后也会再收口）。
  try { BackupManager.pruneBackups() } catch { /* 清理失败不影响启动 */ }

  // 代理周期巡检（仅当存在绑定代理时产生网络动作）
  const sweep = () => { ProxyManager.sweepBoundProxies(healthEmit).catch(() => { /* 巡检失败不打扰主流程 */ }) }
  setInterval(sweep, SWEEP_INTERVAL_MS)

  // 打开店铺浏览器时：绑定的代理若从未体检/状态异常/结果过期 → 先复检并如实展示
  onStoreBrowserOpened(async (storeId: string) => {
    try {
      const binding = ProxyManager.getStoreProxy(storeId)
      if (binding?.mode !== 'bound' || !binding.proxyId) return
      const rec = ProxyManager.getProxy(binding.proxyId)
      if (!rec) return
      const stale = !rec.lastCheckedAt || Date.now() - rec.lastCheckedAt > STALE_MS || rec.status !== 'ok'
      if (!stale) return
      const r = await ProxyManager.revalidateProxy(binding.proxyId)
      if (r) healthEmit({ proxyId: binding.proxyId, ...r, storeId })
    } catch { /* 复检失败：保持现状，由页面加载错误自行呈现 */ }
  })

  // 空闲自动锁定（§189；主密码启用且 idleMinutes>0 才生效）
  setInterval(() => {
    // 取考勤设置本身要查库：**必须在 try 内**——退出流程里 closeDatabase() 之后定时器
    // 还可能再跑一拍，抛在 try 外会直接进 uncaughtException（2026-09-28 审查确认）。
    try {
      const min = Security.getIdleMinutes()
      if (min <= 0 || Security.isAppLocked()) return
      if (powerMonitor.getSystemIdleTime() >= min * 60) Security.lockApp()
    } catch { /* 无电源监视环境 / 库已关闭：跳过本轮 */ }
  }, 30 * 1000)

  // 维护任务：自动备份 + 数据保留策略（§28）。
  // 放在后台定时器而不是启动路径上：两者都要扫盘/删文件，不能拖慢"双击到可见"。
  // 首次延迟 90s，之后每 6 小时判一次（备份自身有 24h 闸，不会重复拍）。
  startMaintenanceLoop()
}

/**
 * 维护循环：自动备份（24h 闸）+ 保留策略清理。
 * 幂等：重复调用不会叠加定时器（此前 startBackgroundServices 整体没有防重入，这里单独兜住）。
 */
function startMaintenanceLoop(): void {
  if (maintenanceTimer) return
  const tick = async (): Promise<void> => {
    try {
      const backup = await BackupManager.autoBackupIfDue()
      if (backup.created) logMain('info', '[维护] 自动备份完成（24h 一次的定期备份）')
      else if (backup.reason && backup.reason !== 'fresh') logMain('info', `[维护] 自动备份跳过：${backup.reason}`)
    } catch (error: any) {
      logMain('warn', `[维护] 自动备份失败：${String(error?.message || error).slice(0, 200)}`)
    }
    try {
      const r = RetentionService.runRetention()
      const total = r.artifactFiles + r.snapshots + r.runs + r.jobEvents + r.memoryEvents + r.auditLogs + r.usage + r.orphanPartitions
      if (total > 0) logMain('info', `[维护] 保留策略清理：${JSON.stringify(r)}`)
      else if (r.skipped) logMain('info', `[维护] 保留策略跳过：${r.skipped}`)
    } catch (error: any) {
      logMain('warn', `[维护] 保留策略失败：${String(error?.message || error).slice(0, 200)}`)
    }
  }
  setTimeout(() => {
    void tick()
    maintenanceTimer = setInterval(() => { void tick() }, MAINTENANCE_INTERVAL_MS)
    // 常驻定时器不阻止进程退出（退出路径由 will-quit 收敛，见 index.ts）
    if (maintenanceTimer && typeof maintenanceTimer.unref === 'function') maintenanceTimer.unref()
  }, MAINTENANCE_FIRST_DELAY_MS).unref()
}
