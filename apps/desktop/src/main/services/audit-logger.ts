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
  | 'task.create' | 'task.update' | 'task.delete' | 'task.run' | 'task.pause' | 'task.resume'
  | 'task.retry' | 'task.cancel' | 'task.confirm'
  | 'agent.observe' | 'agent.plan' | 'agent.plan.validate' | 'agent.ui.update'
  | 'agent.software.context' | 'agent.software.validate' | 'agent.software.execute'
  | 'agent.bootstrap' | 'agent.org.create' | 'agent.org.update' | 'agent.org.activate'
  | 'agent.org.pause' | 'agent.org.resume' | 'agent.org.retire' | 'agent.hr.preview' | 'agent.org.autoprovision'
  | 'agent.model.create' | 'agent.model.update' | 'agent.model.delete' | 'agent.model.bind' | 'agent.model.unbind'
  | 'agent.model.test' | 'agent.model.fallback' | 'agent.job.create' | 'agent.job.delegate' | 'agent.job.transition'
  | 'agent.job.cancel' | 'agent.job.approve' | 'agent.job.resume' | 'agent.job.side_effect_started' | 'agent.job.result.review' | 'agent.memory.write'
  | 'agent.memory.review' | 'agent.memory.rebuild' | 'agent.memory.snapshot' | 'agent.memory.restore' | 'agent.memory.learn' | 'agent.memory.maintenance' | 'agent.feedback.create' | 'agent.quality.review'
  | 'update.check' | 'update.download' | 'update.install'
  | 'ai.keySet' | 'ai.keyClear' | 'ai.test' | 'ai.generate' | 'ai.models' | 'ai.config'
  | 'ai.imageConfig' | 'ai.imageKeySet' | 'ai.imageKeyClear' | 'ai.image.test' | 'ai.image.models'
  | 'ai.imageTextConfig' | 'ai.imageTextKeySet' | 'ai.imageTextKeyClear' | 'ai.imageText.test' | 'ai.imageText.models' | 'ai.imageText.analyze'
  // 技能/插件/分享包属于「定义变更」：会改变后续 Job 能自动执行什么，必须留痕（2026-09-26 审计 P2）。
  | 'agent.skill.create' | 'agent.skill.update' | 'agent.skill.delete' | 'agent.skill.run'
  | 'agent.plugin.create' | 'agent.plugin.update' | 'agent.plugin.delete'
  | 'agent.pack.import' | 'agent.pack.export'
  | 'diagnostics.export' | 'audit.export' | 'invoice.export'
  // 把平台读到的主体写回店铺营业执照（会改 stores 两列 → 留痕）
  | 'store.licenseFromEntity'
  // 保留策略清理（删截图工件/删历史行）：它"删掉了什么"是事后唯一查得到的记录，必须留痕
  | 'retention.prune'

export type AuditResult = 'success' | 'failure'

/**
 * `requestId` 的写法约定（2026-09-26 审计 P2）：**每次调用一个真实 id**（IPC 层用
 * `randomUUID()`），后面可跟 `#说明`——失败时是错误码，成功时可以是最小上下文
 * （例如 `#endpoint,model` 表示改了哪几项、`#click+write` 表示执行了哪些动作类型）。
 * 这样 `queryAudit({ requestId })` 能把"一次用户操作 ↔ 一条审计"对齐。以前这里写的是
 * `'agent.observe'` 这种常量串或错误码本身，同一动作的多次调用在审计里完全无法区分。
 */
export function auditRequestId(requestId: string, detail?: string | null): string {
  const base = String(requestId || '').trim() || randomBytes(8).toString('hex')
  const suffix = String(detail || '').trim().slice(0, 120)
  return suffix ? `${base}#${suffix}` : base
}

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
    // audit_logs.store_id 有外键（stores(id)）：店铺被彻底删除后，仍引用它的旧任务/Job
    // 再来写审计会直接违反外键，整条审计被吞掉（日志里只剩 writeAudit failed）。
    // 审计宁可少一个 store_id 也不能丢记录，所以这里先确认店铺还在，不在就写 NULL。
    let storeId: string | null = opts.storeId ?? null
    if (storeId && !db.prepare('SELECT 1 FROM stores WHERE id=?').get(storeId)) storeId = null
    db.prepare(`
      INSERT INTO audit_logs (id, actor, store_id, action, result, request_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      opts.actor ?? 'user',
      storeId,
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
  /** 精确匹配调用 id；带 `#错误码` 后缀的记录用前缀匹配（见 auditRequestId） */
  requestId?: string | null
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
  if (filter.requestId) {
    // 允许按调用 id 查，命中带 `#错误码` 后缀的失败记录
    where.push('(request_id = ? OR request_id LIKE ? ESCAPE \'\\\')')
    params.push(filter.requestId, `${String(filter.requestId).replace(/[%_\\]/g, '\\$&')}#%`)
  }
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
