/**
 * 达人邀约批次（2026-10-19，v2）。
 *
 * 批次是「策略层」对象：记录这一单邀谁、邀多少、用什么话术/商品。真正的执行仍是
 * TaskRunner + 平台档案；本服务只负责把任务与批次关联起来，并把运行状态翻译成
 * 业务状态（完成/额度用尽/候选不足/停止/失败）。
 *
 * 状态不额外写一遍：运行时从 task_runs + loop 步骤的 stopReason 推导，
 * 避免「批次说自己完成了、运行其实失败了」这种双写漂移。
 */
import { randomUUID } from 'node:crypto'
import { getDatabase } from '../db/database'
import * as TaskStore from '../tasks/task-store'
import { logMain } from './logger'
import { inviteCountsByCampaign, listInviteRecords } from './invite-records'
import { deriveStatus } from './invite-status'
import type {
  InviteCampaignDetail,
  InviteCampaignListInput,
  InviteCampaignStatus,
  InviteCampaignView,
  InviteRecordStatus,
  InviteSummary
} from '@shared/invite-campaign'

export interface CreateInviteCampaignInput {
  id: string
  storeId: string
  platform: string
  name: string
  targetCount: number
  filters?: Record<string, unknown> | null
  scriptText?: string | null
  productIds?: string[]
  createdBy?: string
  sendMode?: 'direct' | 'confirm'
  /** 定时启动时间（毫秒）；有值则批次状态为 scheduled，不立即入队 */
  scheduledAt?: number | null
}

export function newInviteCampaignId(): string {
  return `camp_${randomUUID().replace(/-/g, '').slice(0, 20)}`
}

/**
 * 批次筛选快照只留"怎么选人"，不留联系方式。
 * 联系人/手机号/微信号已经在 app_settings 的店铺配置里；再复制一份到批次表
 * 等于把 PII 多存一处、多一个导出/日志泄露面。这里递归剔除敏感键。
 */
const SENSITIVE_FILTER_KEYS = new Set(['contact', 'wechat', 'phone', 'batchContact', 'batchPhone', 'batchWechat'])
function sanitizeCampaignFilters(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeCampaignFilters)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_FILTER_KEYS.has(key)) continue
    out[key] = sanitizeCampaignFilters(item)
  }
  return out
}

export function createInviteCampaign(input: CreateInviteCampaignInput): void {
  const db = getDatabase()
  const filtersJson = input.filters ? JSON.stringify(sanitizeCampaignFilters(input.filters)).slice(0, 20000) : null
  const productsJson = input.productIds?.length ? JSON.stringify(input.productIds.slice(0, 30)) : null
  db.prepare(`
    INSERT INTO invite_campaigns (
      id, store_id, platform, name, status, filters_json, script_snapshot, product_ids_json,
      target_count, daily_cap, send_mode, created_by, task_id, run_id, created_at, started_at, finished_at, stats_json,
      scheduled_at, status_reason
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    input.id, input.storeId, input.platform, input.name.slice(0, 120), input.scheduledAt ? 'scheduled' : 'ready',
    filtersJson,
    input.scriptText ? String(input.scriptText).slice(0, 2000) : null,
    productsJson,
    Math.max(0, Math.min(500, Math.round(Number(input.targetCount) || 0))),
    null,
    input.sendMode === 'confirm' ? 'confirm' : 'direct',
    String(input.createdBy || 'panel').slice(0, 40),
    null, null, Date.now(), null, null, null,
    input.scheduledAt ?? null, null
  )
}

export function attachInviteCampaignRun(campaignId: string, taskId: string, runId: string): void {
  try {
    getDatabase().prepare(`
      UPDATE invite_campaigns SET task_id = ?, run_id = ?, status = 'running', started_at = ? WHERE id = ?
    `).run(taskId, runId, Date.now(), campaignId)
  } catch (error) {
    logMain('error', `[invite] 关联批次运行失败 campaign=${campaignId}: ${String((error as Error)?.message || error)}`)
  }
}

export function markInviteCampaignFailed(campaignId: string, reason?: string): void {
  try {
    getDatabase().prepare(`
      UPDATE invite_campaigns SET status = 'failed', status_reason = ?, finished_at = ? WHERE id = ?
    `).run(reason ? String(reason).slice(0, 300) : null, Date.now(), campaignId)
  } catch { /* 批次状态写失败不掩盖原始错误 */ }
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(String(raw))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch { return null }
}

function parseProducts(raw: unknown): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(String(raw))
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean).slice(0, 30) : []
  } catch { return [] }
}

/** 从 loop 步骤结果里读停止码；读不到就是 null，不猜。 */
function readStopReason(taskId: string | null, runId: string | null): string | null {
  if (!taskId || !runId) return null
  try {
    const row = getDatabase().prepare(`
      SELECT r.payload_json
      FROM task_step_results r
      JOIN task_steps s ON s.task_id = ? AND s.step_index = r.step_index
      WHERE r.run_id = ? AND s.type = 'loop'
      ORDER BY r.created_at DESC LIMIT 1
    `).get(taskId, runId) as { payload_json?: string } | undefined
    if (!row?.payload_json) return null
    const payload = JSON.parse(row.payload_json)
    const reason = String(payload?.stopReason || '').trim()
    return reason || null
  } catch { return null }
}

/** 运行统计（轮末由引擎写入 stats_json）：跳过人数不落逐人记录，只做批次级计数。 */
export interface InviteRunStats {
  skipped?: number
  sent?: number
  completedRounds?: number
  at?: number
}

function parseStats(raw: unknown): InviteRunStats {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(String(raw))
    return parsed && typeof parsed === 'object' ? parsed as InviteRunStats : {}
  } catch { return {} }
}

/**
 * 批次状态推导（2026-10-25 重构）：实现与口径说明都在 `invite-status.ts`（纯函数，可单测）。
 */

function mapCampaign(row: any, task: any, run: any, counts: { sent: number; skipped: number; failed: number; unknown: number }): InviteCampaignView {
  const stopReason = readStopReason(task?.id ?? row.task_id ?? null, run?.id ?? row.run_id ?? null)
  const stats = parseStats(row.stats_json)
  const targetCount = Number(row.target_count) || 0
  const mergedCounts = {
    sent: counts.sent,
    // 跳过只存在于引擎统计里（不落逐人记录）；两者都有时取大值，避免重复累计
    skipped: Math.max(counts.skipped, Number(stats.skipped) || 0),
    failed: Math.max(counts.failed, 0),
    unknown: counts.unknown
  }
  // 僵尸批次：任务被删/run 不存在，但行里还写着 running → 如实降级为 stopped 并说明原因，
  // 否则界面永远显示「执行中」且没有可停止对象。
  const zombie = !run && !task && String(row.status || '') === 'running'
  const hasInviteLoop = Array.isArray(task?.steps) && task.steps.some((step: any) => step?.type === 'loop')
  const status = zombie
    ? 'stopped'
    : deriveStatus(String(row.status || 'ready'), run?.status ?? null, stopReason, mergedCounts, targetCount, Boolean(hasInviteLoop))
  return {
    id: row.id,
    storeId: row.store_id,
    storeName: row.store_name ?? null,
    platform: row.platform,
    name: row.name,
    status,
    targetCount,
    sentCount: mergedCounts.sent,
    skippedCount: mergedCounts.skipped,
    failedCount: mergedCounts.failed,
    unknownCount: mergedCounts.unknown,
    taskId: task?.id ?? row.task_id ?? null,
    runId: run?.id ?? row.run_id ?? null,
    createdAt: Number(row.created_at) || Date.now(),
    startedAt: run?.startedAt ?? row.started_at ?? null,
    finishedAt: run?.finishedAt ?? row.finished_at ?? null,
    stopReason,
    scheduledAt: Number.isFinite(Number(row.scheduled_at)) && Number(row.scheduled_at) > 0 ? Number(row.scheduled_at) : null,
    statusReason: zombie ? '任务已删除，批次已收尾' : (row.status_reason ? String(row.status_reason) : null),
    filters: parseJsonObject(row.filters_json),
    scriptText: row.script_snapshot ?? null,
    productIds: parseProducts(row.product_ids_json),
    createdBy: String(row.created_by || 'panel')
  }
}

export function listInviteCampaigns(input: InviteCampaignListInput = {}): InviteCampaignView[] {
  const db = getDatabase()
  const limit = Math.max(1, Math.min(100, Math.round(Number(input.limit) || 50)))
  const where = input.storeId ? 'WHERE c.store_id = ?' : ''
  const params = input.storeId ? [String(input.storeId)] : []
  try {
    const rows = db.prepare(`
      SELECT c.*, s.name AS store_name
      FROM invite_campaigns c
      LEFT JOIN stores s ON s.id = c.store_id
      ${where}
      ORDER BY c.created_at DESC
      LIMIT ?
    `).all(...params, limit) as any[]
    return rows.map(row => {
      const task = row.task_id ? TaskStore.getTask(row.task_id) : null
      // 优先任务的当前运行：批次结束前用户可能手动重跑，旧 run_id 会把状态钉在过去。
      const run = task?.latestRun ?? (row.run_id ? TaskStore.getRun(row.run_id) : null)
      return mapCampaign(row, task, run, inviteCountsByCampaign(row.id))
    })
  } catch (error) {
    logMain('error', `[invite] 读取批次列表失败: ${String((error as Error)?.message || error)}`)
    return []
  }
}

function summaryFromRecords(records: ReturnType<typeof listInviteRecords>): InviteSummary {
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const recent = Date.now() - 7 * 24 * 60 * 60 * 1000
  const sentStatuses = new Set<InviteRecordStatus>(['sent', 'inviting', 'accepted', 'rejected', 'expired'])
  let todaySent = 0
  let recentSent = 0
  let accepted = 0
  let rejected = 0
  let unknown = 0
  for (const record of records) {
    const at = record.invitedAt ?? record.createdAt
    if (sentStatuses.has(record.status)) {
      if (at >= dayStart.getTime()) todaySent++
      if (at >= recent) recentSent++
    }
    if (record.status === 'accepted') accepted++
    else if (record.status === 'rejected') rejected++
    else if (record.status === 'unknown') unknown++
  }
  return { todaySent, recentSent, accepted, rejected, unknown, total: records.length }
}

export function getInviteCampaignDetail(campaignId: string): InviteCampaignDetail | null {
  const db = getDatabase()
  try {
    const row = db.prepare(`
      SELECT c.*, s.name AS store_name
      FROM invite_campaigns c
      LEFT JOIN stores s ON s.id = c.store_id
      WHERE c.id = ?
    `).get(campaignId) as any
    if (!row) return null
    const task = row.task_id ? TaskStore.getTask(row.task_id) : null
    const run = task?.latestRun ?? (row.run_id ? TaskStore.getRun(row.run_id) : null)
    const records = listInviteRecords({ campaignId, limit: 500 })
    return {
      campaign: mapCampaign(row, task, run, inviteCountsByCampaign(campaignId)),
      task,
      run,
      records,
      summary: summaryFromRecords(records)
    }
  } catch (error) {
    logMain('error', `[invite] 读取批次详情失败 campaign=${campaignId}: ${String((error as Error)?.message || error)}`)
    return null
  }
}

/** 批次层状态写入（排期取消、到点额度不足等）；失败不抛，避免掩盖主流程。 */
export function setInviteCampaignStatus(campaignId: string, status: InviteCampaignStatus, reason?: string | null): void {
  try {
    getDatabase().prepare(`
      UPDATE invite_campaigns SET status = ?, status_reason = ?, finished_at = ? WHERE id = ?
    `).run(status, reason ? String(reason).slice(0, 300) : null,
      ['completed', 'exhausted', 'stopped', 'failed'].includes(status) ? Date.now() : null,
      campaignId)
  } catch (error) {
    logMain('error', `[invite] 写入批次状态失败 campaign=${campaignId}: ${String((error as Error)?.message || error)}`)
  }
}

/** 把排期批次关联到(尚未存在的)任务；run 在真正到时才产生。 */
export function attachInviteCampaignTask(campaignId: string, taskId: string): void {
  try {
    getDatabase().prepare('UPDATE invite_campaigns SET task_id = ? WHERE id = ?').run(taskId, campaignId)
  } catch { /* 关联失败由调用方按任务不存在处理 */ }
}

export interface DueInviteCampaign {
  id: string
  storeId: string
  platform: string
  name: string
  taskId: string | null
  targetCount: number
  scheduledAt: number
}

/**
 * 到点该起的批次。只读 status='scheduled' 的行：
 * 取消/已跑的批次改了状态就自然不会再被选中，不需要额外的内存计时器。
 */
export function listDueInviteCampaigns(now: number, limit = 10): DueInviteCampaign[] {
  try {
    const rows = getDatabase().prepare(`
      SELECT id, store_id, platform, name, task_id, target_count, scheduled_at
      FROM invite_campaigns
      WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?
      ORDER BY scheduled_at ASC
      LIMIT ?
    `).all(now, limit) as any[]
    return rows.map(row => ({
      id: String(row.id),
      storeId: String(row.store_id),
      platform: String(row.platform),
      name: String(row.name || ''),
      taskId: row.task_id ? String(row.task_id) : null,
      targetCount: Number(row.target_count) || 1,
      scheduledAt: Number(row.scheduled_at) || 0
    }))
  } catch (error) {
    logMain('error', `[invite] 读取到点批次失败: ${String((error as Error)?.message || error)}`)
    return []
  }
}

/**
 * 写入批次级运行统计（跳过人数据此展示）。
 * 逐人记录只写"真实勾选/发送"的人，跳过的人没有逐人记录——所以计数必须单独存，
 * 不能靠 `inviteCountsByCampaign` 从状态前缀里统计（那些状态永远不会有写入方）。
 */
export function updateInviteCampaignStats(campaignId: string | null | undefined, patch: InviteRunStats): void {
  if (!campaignId) return
  try {
    const db = getDatabase()
    const row = db.prepare('SELECT stats_json FROM invite_campaigns WHERE id = ?').get(campaignId) as { stats_json?: string } | undefined
    if (!row) return
    const next = { ...parseStats(row.stats_json), ...patch, at: Date.now() }
    db.prepare('UPDATE invite_campaigns SET stats_json = ? WHERE id = ?')
      .run(JSON.stringify(next).slice(0, 4000), campaignId)
  } catch (error) {
    logMain('warn', `[invite] 写入批次统计失败 campaign=${campaignId}: ${String((error as Error)?.message || error)}`)
  }
}

/**
 * 任务被删除：把它名下的批次收尾。
 * 不这么做会留下"批次=running、run 已级联删除"的僵尸行——界面永远执行中，且没有可停止的对象。
 */
export function closeInviteCampaignsForTask(taskId: string, reason = '任务已被删除'): number {
  if (!taskId) return 0
  try {
    const result = getDatabase().prepare(`
      UPDATE invite_campaigns
      SET status = 'stopped', status_reason = ?, finished_at = COALESCE(finished_at, ?)
      WHERE task_id = ? AND status IN ('ready','scheduled','running','waiting','paused')
    `).run(String(reason).slice(0, 300), Date.now(), taskId)
    return Number(result.changes) || 0
  } catch (error) {
    logMain('warn', `[invite] 删除任务时收尾批次失败 task=${taskId}: ${String((error as Error)?.message || error)}`)
    return 0
  }
}

/** 取消排期：只对 scheduled 生效，已经跑起来的不在这里处理（走任务取消）。 */
export function cancelScheduledInviteCampaign(campaignId: string, reason = '用户取消排期'): boolean {
  const db = getDatabase()
  try {
    const row = db.prepare("SELECT id, status FROM invite_campaigns WHERE id = ?").get(campaignId) as { id: string; status: string } | undefined
    if (!row || row.status !== 'scheduled') return false
    setInviteCampaignStatus(campaignId, 'stopped', reason)
    return true
  } catch {
    return false
  }
}
