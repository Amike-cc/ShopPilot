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
import * as ProxyManager from '../browser/proxy-manager'
import { emitToRenderer, onStoreBrowserOpened } from '../browser/window-manager'

const SWEEP_INTERVAL_MS = 5 * 60 * 1000
const STALE_MS = 10 * 60 * 1000

export function installLockGate(): void {
  const ALLOW_WHEN_LOCKED = new Set<string>([
    IPC_CHANNELS.SECURITY_UNLOCK,
    IPC_CHANNELS.SECURITY_STATUS,
    // 窗口装饰不是业务通道：锁定态下渲染层仍需把标题栏 overlay 调成锁定底色
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
    const min = Security.getIdleMinutes()
    if (min <= 0 || Security.isAppLocked()) return
    try {
      if (powerMonitor.getSystemIdleTime() >= min * 60) Security.lockApp()
    } catch { /* 无电源监视环境跳过 */ }
  }, 30 * 1000)
}
