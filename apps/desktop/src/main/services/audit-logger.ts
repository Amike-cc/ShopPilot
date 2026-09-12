/**
 * 审计日志服务 - §5.7 audit_logs / §4.2
 * 危险操作（数据清理、永久删除、导入导出、锁定）写审计。
 */

import { getDatabase } from '../db/database'
import { randomBytes } from 'crypto'

export type AuditAction =
  | 'store.create' | 'store.archive' | 'store.restore' | 'store.deletePermanent' | 'store.purge'
  | 'browser.clearData' | 'session.export' | 'session.import'
  | 'proxy.create' | 'proxy.delete' | 'proxy.bind'
  | 'profile.update' | 'profile.lock' | 'profile.unlock' | 'profile.copyConfig'
  | 'security.lock' | 'security.unlock' | 'security.setPassword' | 'security.removePassword'
  | 'backup.create' | 'backup.restore'
  | 'task.create' | 'task.delete' | 'task.run' | 'task.pause' | 'task.resume'
  | 'task.retry' | 'task.cancel' | 'task.confirm'
  | 'diagnostics.export' | 'audit.export'

export type AuditResult = 'success' | 'failure'

/**
 * 写入一条审计日志。永不抛异常（审计失败不能阻断主操作）。
 */
export function writeAudit(
  action: AuditAction,
  result: AuditResult,
  opts: { actor?: string; storeId?: string | null; requestId?: string | null } = {}
): void {
  try {
    const db = getDatabase()
    const now = Date.now()
    const id = `audit_${randomBytes(12).toString('hex')}`
    db.prepare(`
      INSERT INTO audit_logs (id, actor, store_id, action, result, request_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      opts.actor ?? 'user',
      opts.storeId ?? null,
      action,
      result,
      opts.requestId ?? null,
      now
    )
  } catch (err) {
    console.error('writeAudit failed:', err)
  }
}

export interface AuditQueryFilter {
  storeId?: string | null
  action?: string | null
  from?: number | null
  to?: number | null
  limit?: number
}

/**
 * 查询审计日志 - §6.7 audit:query
 */
export function queryAudit(filter: AuditQueryFilter = {}): Array<Record<string, unknown>> {
  const db = getDatabase()
  const where: string[] = []
  const params: any[] = []

  if (filter.storeId) { where.push('store_id = ?'); params.push(filter.storeId) }
  if (filter.action) { where.push('action = ?'); params.push(filter.action) }
  if (filter.from) { where.push('created_at >= ?'); params.push(filter.from) }
  if (filter.to) { where.push('created_at <= ?'); params.push(filter.to) }

  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000)
  const sql = `
    SELECT id, actor, store_id, action, result, request_id, created_at
    FROM audit_logs
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY created_at DESC
    LIMIT ?
  `
  params.push(limit)

  return db.prepare(sql).all(...params).map((r: any) => ({
    id: r.id, actor: r.actor, storeId: r.store_id, action: r.action,
    result: r.result, requestId: r.request_id, createdAt: r.created_at
  }))
}
