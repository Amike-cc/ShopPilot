/**
 * 软件更新服务 - §21（electron-updater）
 * - 双通道：stable→latest.yml、beta→beta.yml（allowPrerelease），设置键 update.channel。
 * - 默认 feed = electron-builder publish 配置（GitHub Releases：Amike-cc/ShopPilot）；
 *   环境变量 SHOPPILOT_UPDATE_FEED 可覆盖为 generic feed（验收/内部镜像用，日志如实留痕）。
 * - 下载完成后 electron-updater 按 feed 元数据校验 SHA-512 才触发 update-downloaded；
 *   无代码签名证书 → 无签名校验（INTERNAL_BUILD 边界，如实记录）。
 * - check/download/install 写审计（update.check / update.download / update.install）。
 * - update.autoCheck（默认关闭）开启后，打包态启动延迟自动检查一次。
 */
import { app, BrowserWindow } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import { emitToRenderer } from '../browser/window-manager'
import { getDatabase } from '../db/database'
import { writeAudit } from './audit-logger'
import { logMain } from './logger'

export type UpdateState = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
export type UpdateChannel = 'stable' | 'beta'

export interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  channel: UpdateChannel
  feedSource: 'github' | 'env-override' | 'dev'
  version?: string
  releaseDate?: string
  releaseNotes?: string
  percent?: number
  transferred?: number
  total?: number
  error?: string
}

const FEED_OVERRIDE_ENV = 'SHOPPILOT_UPDATE_FEED'

let status: UpdateStatus = { state: 'idle', currentVersion: app.getVersion(), channel: 'stable', feedSource: 'github' }
let configured = false
/** 进行中的阶段（error 事件触发时决定审计记到哪个动作）：check / download / null */
let phase: 'check' | 'download' | null = null

function errorMessage(error: unknown): string {
  return String((error as any)?.message || error || '更新检查失败')
}

function readSetting<T>(key: string, fallback: T): T {
  try {
    const row = getDatabase().prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as any
    return row ? (JSON.parse(row.value_json) as T) : fallback
  } catch {
    return fallback
  }
}

export function getUpdateChannel(): UpdateChannel {
  return readSetting<string>('update.channel', 'stable') === 'beta' ? 'beta' : 'stable'
}

function audit(action: 'update.check' | 'update.download' | 'update.install', result: 'success' | 'failure', detail: Record<string, unknown>): void {
  writeAudit(action, result, { requestId: JSON.stringify(detail) })
}

function currentFeedSource(): UpdateStatus['feedSource'] {
  if (process.env[FEED_OVERRIDE_ENV]) return 'env-override'
  return app.isPackaged ? 'github' : 'dev'
}

function publish(next: Partial<UpdateStatus>): UpdateStatus {
  status = { ...status, ...next, currentVersion: app.getVersion(), channel: getUpdateChannel(), feedSource: currentFeedSource() }
  emitToRenderer(EVENT_CHANNELS.UPDATE_STATUS_CHANGED, status)
  return status
}

/** §21 双通道：stable→latest.yml、beta→beta.yml（含预发布版本）。feed 覆盖时通道要重设。 */
function applyChannel(): void {
  const channel = getUpdateChannel()
  autoUpdater.channel = channel === 'beta' ? 'beta' : 'latest'
  autoUpdater.allowPrerelease = channel === 'beta'
  const override = process.env[FEED_OVERRIDE_ENV]
  if (override) autoUpdater.setFeedURL({ provider: 'generic', url: override, channel: autoUpdater.channel })
}

function configure(): void {
  if (configured) return
  configured = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  applyChannel()
  const override = process.env[FEED_OVERRIDE_ENV]
  if (override) logMain('warn', `update: feed override active → ${override} (channel=${autoUpdater.channel})`)
  autoUpdater.on('checking-for-update', () => publish({ state: 'checking', error: undefined }))
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    phase = null
    publish({
      state: 'available', version: info.version, releaseDate: info.releaseDate,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined, percent: 0
    })
    audit('update.check', 'success', { found: true, version: info.version, channel: getUpdateChannel() })
  })
  autoUpdater.on('update-not-available', () => {
    phase = null
    publish({ state: 'not-available', version: undefined, percent: undefined, error: undefined })
    audit('update.check', 'success', { found: false, channel: getUpdateChannel() })
  })
  autoUpdater.on('download-progress', (progress) => {
    const next = publish({ state: 'downloading', percent: progress.percent, transferred: progress.transferred, total: progress.total })
    emitToRenderer(EVENT_CHANNELS.UPDATE_PROGRESS, next)
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    phase = null
    publish({
      state: 'downloaded', version: info.version, releaseDate: info.releaseDate,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      percent: 100, error: undefined
    })
    audit('update.download', 'success', { version: info.version, channel: getUpdateChannel() })
    logMain('info', `update: downloaded v${info.version}（SHA-512 已由 electron-updater 校验）`)
  })
  autoUpdater.on('error', (error) => {
    const message = errorMessage(error)
    logMain('warn', `update: ${message}`)
    if (phase === 'check') audit('update.check', 'failure', { message, channel: getUpdateChannel() })
    else if (phase === 'download') audit('update.download', 'failure', { message, channel: getUpdateChannel() })
    phase = null
    publish({ state: 'error', error: message })
  })
}

export function getUpdateStatus(): UpdateStatus {
  configure()
  // 查询路径：刷新可观测字段（channel/feedSource/currentVersion 可能在两次事件之间变化），
  // 但不广播事件——调用方是查询而非状态变化。
  status = { ...status, currentVersion: app.getVersion(), channel: getUpdateChannel(), feedSource: currentFeedSource() }
  return status
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  configure()
  if (!app.isPackaged) return publish({ state: 'not-available', error: '开发环境不会执行在线更新检查' })
  try {
    applyChannel()
    phase = 'check'
    await autoUpdater.checkForUpdates()
    return status
  } catch (error) {
    phase = null
    const message = errorMessage(error)
    audit('update.check', 'failure', { message, channel: getUpdateChannel() })
    return publish({ state: 'error', error: message })
  }
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  configure()
  if (!app.isPackaged) return publish({ state: 'error', error: '开发环境不执行更新下载，请使用安装包验证' })
  try {
    phase = 'download'
    publish({ state: 'downloading', percent: 0, error: undefined })
    await autoUpdater.downloadUpdate()
    return status
  } catch (error) {
    phase = null
    const message = errorMessage(error)
    audit('update.download', 'failure', { message, channel: getUpdateChannel() })
    return publish({ state: 'error', error: message })
  }
}

export function installUpdate(): UpdateStatus {
  configure()
  if (status.state !== 'downloaded') return publish({ state: 'error', error: '更新包尚未下载完成' })
  audit('update.install', 'success', { version: status.version, channel: status.channel, note: 'quitAndInstall 已触发；NSIS 安装失败时保留旧版本（§20 回退）' })
  logMain('info', `update: quitAndInstall v${status.version}`)
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
  return status
}

/** update.autoCheck（默认关闭）：打包态启动 8s 后自动检查一次；失败如实落状态与审计，不打扰主流程。 */
export function scheduleStartupCheck(): void {
  if (!app.isPackaged) return
  if (readSetting<boolean>('update.autoCheck', false) !== true) return
  setTimeout(() => { checkForUpdates().catch(() => { /* 错误已如实落状态与审计 */ }) }, 8000)
  logMain('info', 'update: 启动自动检查已排程（8s 后执行）')
}

export function sendCurrentStatus(_window?: BrowserWindow): void {
  publish({})
}
